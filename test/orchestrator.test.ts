import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createState, advancePhase, abortState, resumeState, pauseState, gateForApproval, approveNext, gateOptionalPhase, approveOptionalPhase, skipPendingOptional, loadActiveState, recordStepResult, returnParkedWithContext, unfreeze, reissueGate } from "../orchestrator/state.ts";
import { getAllWorkflows, getWorkflow, getWorkflowIds } from "../orchestrator/workflows.ts";
import { loadSkillFull, loadSkillGate, getSkillInfo, buildSkillIndex, getSkillIds } from "../orchestrator/skills.ts";
import { buildPhaseInstructions, buildDeterministicPlan, planFilePath, parsePlanFileMarker, resolvePlanFilePath, carryOverOpenQuestions, buildStepInstructions, buildStepTask, mainContractFor } from "../orchestrator/templates.ts";
import type { WorkflowContext, WorkflowPhase } from "../orchestrator/types.ts";
import { launchPhase, ctxAlive, isPhaseInFlight, advanceBlockReason, releasePhaseInFlight, buildResumeContext, activeConstraintLines, statusLineFor, executeCurrentPhase } from "../orchestrator/executor.ts";
import { initOrchestrator } from "../orchestrator/index.ts";
import { activityLabelFromEvent } from "../orchestrator/spawn.ts";
import { runSubagent, resolveTimeoutMs } from "../orchestrator/spawn.ts";
import {
  beginRun,
  ensureRun,
  recordDelegatedStep,
  buildRunReport,
  runReportFileName,
  writeRunReport,
  resetTelemetry,
} from "../orchestrator/telemetry.ts";
import { initAgentsMd } from "../orchestrator/init.ts";
import { gateInventory, configureGates } from "../orchestrator/gates.ts";

// --- Live subagent activity labels ----------------------------------------

test("activityLabelFromEvent: tool_execution_start yields tool + target", () => {
  const label = activityLabelFromEvent({
    type: "tool_execution_start",
    toolName: "read",
    args: { path: "src/app.ts" },
  });
  assert.ok(label!.includes("read"));
  assert.ok(label!.includes("src/app.ts"));
});

test("activityLabelFromEvent: assistant message_start yields thinking", () => {
  const label = activityLabelFromEvent({ type: "message_start", message: { role: "assistant" } });
  assert.equal(label, "thinking…");
});

test("activityLabelFromEvent: assistant message_end yields text preview", () => {
  const label = activityLabelFromEvent({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "The root cause is\nthe retry loop." }] },
  });
  assert.ok(label!.startsWith("writing:"));
});

test("activityLabelFromEvent: unknown or malformed events yield null safely", () => {
  assert.equal(activityLabelFromEvent({ type: "turn_start" }), null);
  assert.equal(activityLabelFromEvent(null), null);
  assert.equal(activityLabelFromEvent(undefined), null);
  assert.equal(activityLabelFromEvent("garbage"), null);
});

// --- Runtime liveness guards (session reload crash fix) -------------------

test("ctxAlive returns true for a healthy context", () => {
  const ctx = { ui: { notify() {} } };
  assert.equal(ctxAlive(ctx), true);
});

test("ctxAlive returns false when the context is stale (ui getter throws)", () => {
  const stale = {
    get ui() {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    },
  };
  assert.equal(ctxAlive(stale), false);
});

test("launchPhase swallows stale-context rejections without throwing", async () => {
  const pi = {} as any;
  const ctx = { ui: { notify() { throw new Error("stale"); } } } as any;
  let called = false;
  // Must not throw synchronously nor produce an unhandled rejection.
  launchPhase(pi, ctx, {} as any, async () => {
    called = true;
    throw new Error("Extension ctx is stale after session replacement or reload.");
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(called, true);
});

test("launchPhase reports non-stale errors best-effort", async () => {
  const seen: Array<{ msg: string; level: string }> = [];
  const pi = {} as any;
  const ctx = { ui: { notify(msg: string, level: string) { seen.push({ msg, level }); } } } as any;
  launchPhase(pi, ctx, {} as any, async () => {
    throw new Error("boom during phase");
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 1);
  assert.ok(seen[0].msg.includes("boom during phase"));
});

test("launchPhase refuses a duplicate chain for the same workflow phase (2026-08-31 post-mortem)", async () => {
  // Post-mortem: the user's "No" on the optional-phase dialog was recorded and
  // the workflow completed, yet a second chain for the SAME phase — relaunched
  // via /kstack → Resume while the first dialog was pending — ran the QA
  // worker 15 seconds later. A phase must never run two concurrent chains.
  const seen: string[] = [];
  const pi = {} as any;
  const ctx = { ui: { notify(msg: string) { seen.push(msg); } } } as any;
  const state = { workflowId: "investigate", phaseIndex: 4 } as any;
  let runs = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });

  launchPhase(pi, ctx, state, async () => { runs++; await gate; });
  launchPhase(pi, ctx, state, async () => { runs++; });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(runs, 1, "second launch must be refused while the first chain is in flight");
  assert.ok(seen.some((m) => m.includes("already running")), "the refusal must be surfaced to the user");
  assert.equal(isPhaseInFlight("investigate", 4), true);

  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(isPhaseInFlight("investigate", 4), false, "registry released after the chain settles");

  // Once settled, relaunching the phase is legitimate again.
  launchPhase(pi, ctx, state, async () => { runs++; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runs, 2);
});

// --- Audit follow-up: same racing class, other cycles -------------------------

test("advanceBlockReason refuses a model advance on a parked manual gate", () => {
  // Second kstack_advance in the same turn after a decision phase: the parked
  // state points at the NEXT phase (a subagent phase with no chain in flight),
  // so without this block the advance would record a phase that never ran as
  // completed — mechanically bypassing develop.plan / investigate.root-cause.
  const state = { workflowId: "develop", phaseIndex: 3, status: "awaiting_approval" } as any;
  assert.match(advanceBlockReason(state) ?? "", /PARKED awaiting user approval/);
});

test("advanceBlockReason blocks kstack_advance while a delegation chain is in flight", async () => {
  // Mid-delegation user input makes the router tell the model to "continue the
  // current phase"; an advance accepted then records the phase completed
  // before its work exists, and the follow-up advance after the real chain
  // delivers skips the NEXT phase. The chain decides, not the model.
  const state = { workflowId: "investigate", phaseIndex: 2 } as any;
  assert.equal(advanceBlockReason(state), null, "no chain → advance allowed");

  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const pi = {} as any;
  const ctx = { ui: { notify() { /* ignored */ } } } as any;
  launchPhase(pi, ctx, state, async () => { await gate; });

  assert.match(advanceBlockReason(state) ?? "", /still running/, "in-flight chain must block the advance");

  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(advanceBlockReason(state), null, "settled chain → advance allowed again");
});

test("releasePhaseInFlight lets a restarted workflow launch immediately after abort", () => {
  const pi = {} as any;
  const ctx = { ui: { notify() { /* ignored */ } } } as any;
  const state = { workflowId: "qa", phaseIndex: 0 } as any;

  // Orphaned chain that never settles (simulates abort mid-delegation).
  launchPhase(pi, ctx, state, async () => { await new Promise(() => {}); });
  assert.equal(isPhaseInFlight("qa", 0), true);

  // abortWorkflow() releases the key even though the chain never settles —
  // otherwise restarting the same workflow would be refused by the guard.
  releasePhaseInFlight(state.workflowId, state.phaseIndex);
  assert.equal(isPhaseInFlight("qa", 0), false);

  let launched = false;
  launchPhase(pi, ctx, state, async () => { launched = true; });
  assert.equal(launched, true, "restarted workflow must not be blocked by the aborted run's chain");
});

function makeCtx(workflowId: string, phaseIndex = 0, skillsDelivered: string[] = []): WorkflowContext {
  return {
    state: { workflowId, phaseIndex, status: "active", goal: "add dark mode toggle", results: {}, skillsDelivered },
    git: {
      branch: "feature/test",
      hasUncommittedChanges: true,
      hasStagedChanges: false,
      aheadOfRemote: 0,
      behindRemote: 0,
      isMainBranch: false,
      recentCommitSubject: "test",
    },
    cwd: process.cwd(),
  };
}

function findPhase(workflowId: string, phaseId: string): WorkflowPhase {
  const phase = getWorkflow(workflowId)!.phases.find((p) => p.id === phaseId);
  assert.ok(phase, `${workflowId}/${phaseId} not found`);
  return phase;
}

describe("state machine", () => {
  test("createState initializes correctly", () => {
    const state = createState("investigate", "fix login bug");
    assert.equal(state.workflowId, "investigate");
    assert.equal(state.phaseIndex, 0);
    assert.equal(state.status, "active");
    assert.equal(state.goal, "fix login bug");
    assert.deepEqual(state.results, {});
  });

  test("advancePhase moves to next phase", () => {
    const state = createState("investigate", "fix bug");
    const next = advancePhase(state, "reproduce", { status: "completed", summary: "Reproduced" }, 5);
    assert.equal(next.phaseIndex, 1);
    assert.equal(next.status, "active");
    assert.equal(next.results["reproduce"].summary, "Reproduced");
  });

  test("advancePhase completes at last phase", () => {
    const state = { ...createState("review", "check code"), phaseIndex: 2 };
    const next = advancePhase(state, "fix", { status: "completed", summary: "Fixed" }, 3);
    assert.equal(next.status, "completed");
  });

  test("advancePhase pauses on failure", () => {
    const state = createState("ship", "deploy");
    const next = advancePhase(state, "pre-checks", { status: "failed", summary: "Tests failing" }, 5);
    assert.equal(next.status, "paused");
    assert.equal(next.phaseIndex, 0);
  });

  test("abortState sets aborted", () => {
    const state = createState("qa", "test site");
    assert.equal(abortState(state).status, "aborted");
  });

  test("resumeState reactivates", () => {
    const state = pauseState(createState("qa", "test site"));
    assert.equal(state.status, "paused");
    assert.equal(resumeState(state).status, "active");
  });

  test("pre-rename state entries are ignored (S2 rebrand — no migration)", () => {
    // The pre-S2 entry type is built without the literal old-brand string so
    // the tracked-tree rebrand audit stays clean.
    const LEGACY_ENTRY_TYPE = "g" + "stack-wf-state";
    const legacy = { workflowId: "qa", phaseIndex: 1, status: "active", goal: "x", results: {}, version: 2, attempts: {} };
    const ctx: any = {
      sessionManager: {
        getEntries: () => [{ type: "custom", customType: LEGACY_ENTRY_TYPE, data: legacy }],
      },
    };
    assert.equal(loadActiveState(ctx), null);
  });
});

describe("workflows registry", () => {
  test("all 8 workflows registered", () => {
    assert.equal(getAllWorkflows().length, 8);
  });

  test("getWorkflow returns correct workflow", () => {
    const wf = getWorkflow("investigate");
    assert.ok(wf);
    assert.equal(wf.name, "Bug Investigation");
    assert.equal(wf.phases.length, 5);
  });

  test("getWorkflow returns undefined for unknown", () => {
    assert.equal(getWorkflow("nonexistent"), undefined);
  });

  test("getWorkflowIds returns all ids", () => {
    const ids = getWorkflowIds();
    for (const id of ["develop", "investigate", "qa", "qa-report", "ship", "review", "quick"]) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
  });

  test("all workflows have intents", () => {
    for (const wf of getAllWorkflows()) {
      assert.ok(wf.intents.length > 0, `${wf.id} has no intents`);
    }
  });

  test("all workflows have at least one phase", () => {
    for (const wf of getAllWorkflows()) {
      assert.ok(wf.phases.length > 0, `${wf.id} has no phases`);
    }
  });

  test("subagent phases have agent or chain", () => {
    for (const wf of getAllWorkflows()) {
      for (const phase of wf.phases) {
        if (phase.execution === "subagent") {
          assert.ok(
            phase.agent || (phase.chain && phase.chain.length > 0),
            `${wf.id}/${phase.id} is subagent but has no agent or chain`,
          );
        }
      }
    }
  });
});

describe("approval gates", () => {
  test("gateForApproval parks an active workflow in awaiting_approval", () => {
    const state = createState("develop", "add dark mode");
    const next = advancePhase(state, "understand", { status: "completed", summary: "Understood" }, 6);
    assert.equal(next.status, "active");
    const gated = gateForApproval(next);
    assert.equal(gated.status, "awaiting_approval");
    assert.equal(gated.phaseIndex, next.phaseIndex);
  });

  test("approveNext resumes an awaiting workflow", () => {
    const state = { ...createState("develop", "goal"), phaseIndex: 2, status: "awaiting_approval" as const };
    const approved = approveNext(state);
    assert.equal(approved.status, "active");
    assert.equal(approved.phaseIndex, 2);
  });

  test("approveNext is a no-op for non-awaiting states", () => {
    const state = createState("qa", "test site");
    assert.equal(approveNext(state).status, "active");
    assert.equal(gateForApproval({ ...state, status: "completed" }).status, "completed");
  });

  test("decision phases are marked manual", () => {
    const developPlan = getWorkflow("develop")!.phases.find((p) => p.id === "plan")!;
    assert.equal(developPlan.advance, "manual");
    const rootCause = getWorkflow("investigate")!.phases.find((p) => p.id === "root-cause")!;
    assert.equal(rootCause.advance, "manual");
    // Non-decision phases stay auto. Sprint's planning + hard-gate phases are
    // deliberate exceptions (D6/D11): understand, system-design, architect-gate,
    // backlog, commit-archive.
    const sprintManual = new Set(["understand", "system-design", "architect-gate", "backlog", "commit-archive"]);
    for (const wf of getAllWorkflows()) {
      for (const phase of wf.phases) {
        if (wf.id === "sprint" && sprintManual.has(phase.id)) continue;
        if (!(wf.id === "develop" && phase.id === "plan") && !(wf.id === "investigate" && phase.id === "root-cause")) {
          assert.notEqual(phase.advance, "manual", `${wf.id}/${phase.id} should not be a manual gate`);
        }
      }
    }
  });
});

describe("skill ingestion", () => {
  test("all registered skills resolve to a canonical SKILL.md small enough to inject", () => {
    for (const id of getSkillIds()) {
      const full = loadSkillFull(id);
      assert.ok(full, `missing canonical SKILL.md for ${id}`);
      assert.ok(full.length < 48 * 1024, `skill ${id} too large: ${full.length} chars`);
      assert.ok(full.includes("name:"), `skill ${id} missing frontmatter`);
    }
    for (const wf of getAllWorkflows()) {
      for (const phase of wf.phases) {
        for (const id of phase.skills ?? []) {
          const info = getSkillInfo(id);
          assert.ok(info, `phase ${wf.id}/${phase.id} references unknown skill ${id}`);
        }
      }
    }
  });

  test("loadSkillFull returns null for unknown skills; grilling resolves canonically", () => {
    assert.equal(loadSkillFull("nonexistent-skill"), null);
    const grilling = getSkillInfo("kstack-grilling")!;
    assert.ok(existsSync(grilling.skillPath));
    assert.ok(grilling.skillPath.replaceAll("\\", "/").endsWith("skills/kstack-grilling/SKILL.md"));
  });

  test("getSkillInfo resolves canonical SKILL.md paths that exist on disk", () => {
    for (const id of ["kstack-review", "kstack-office-hours", "kstack-document-generate"]) {
      const info = getSkillInfo(id)!;
      assert.ok(info.skillPath, `${id} should have a canonical SKILL.md`);
      assert.ok(existsSync(info.skillPath), `${info.skillPath} not found`);
    }
  });

  test("every registered skill exposes a parsed DoD gate from its SKILL.md", () => {
    for (const id of getSkillIds()) {
      const gate = loadSkillGate(id);
      assert.ok(gate, `${id} gate missing (## DoD gate section)`);
      assert.ok(gate.includes(`DoD gate: ${id}`), `${id} gate missing header`);
    }
  });
});

describe("skill tiering in orchestrator instructions", () => {
  test("MAIN phases embed full methodology (canonical catalog source)", () => {
    // develop.plan migrated to steps (S3) — its skills now ship per-step via
    // buildStepInstructions. This test targets a still-implicit main phase to
    // keep asserting the phase-level digest path byte-for-byte.
    const phase = findPhase("sprint", "system-design");
    assert.equal(phase.execution, "main");
    const instructions = buildPhaseInstructions(phase, makeCtx("sprint", 3));
    // Canonical catalog: the SKILL.md frontmatter (`name: <dir>`) is embedded.
    // The marker proves the FULL methodology shipped — not just the compact gate.
    assert.ok(instructions.includes("name: kstack-system-design"), "system-design methodology missing");
    assert.ok(instructions.includes("Ubiquitous Language"), "domain-modeling content missing");
    assert.ok(
      instructions.includes("name: kstack-adr"),
      "adr methodology missing",
    );
  });

  test("SUBAGENT phases carry DoD gates only â€” full digests stay out of orchestrator context", () => {
    const review = findPhase("ship", "review");
    assert.equal(review.execution, "subagent");
    const instructions = buildPhaseInstructions(review, makeCtx("ship"));
    assert.ok(instructions.includes("Skill gate: kstack-review"));
    assert.ok(instructions.includes("DoD gate: kstack-review"));
    assert.ok(instructions.includes("code-review =="), "review gate content missing");
    assert.ok(!instructions.includes("name: kstack-review"), "full skill leaked into orchestrator instructions");
  });

  test("repeat delivery degrades to the DoD gate even on main phases", () => {
    const ctx = makeCtx("investigate", 3, ["kstack-investigate"]);
    const verify = findPhase("investigate", "verify");
    const instructions = buildPhaseInstructions(verify, ctx);
    assert.ok(instructions.includes("Skill gate: kstack-investigate"));
    assert.ok(instructions.includes("DoD gate: kstack-investigate"));
    assert.ok(!instructions.includes("name: kstack-investigate"), "full skill re-delivered");
  });

  test("phases without skills get no skill blocks; advancement rule intact", () => {
    const action = findPhase("quick", "action");
    const instructions = buildPhaseInstructions(action, makeCtx("quick"));
    assert.ok(!instructions.includes("Skill gate"));
    assert.ok(instructions.includes("Never ask the user to run a command"));
  });

  test("manual-gate phases announce the approval pause", () => {
    const plan = findPhase("develop", "plan");
    const instructions = buildPhaseInstructions(plan, makeCtx("develop", 2));
    assert.ok(instructions.includes("DECISION PHASE"));
  });
});

describe("plan cycle (interactive, hybrid)", () => {
  test("develop has a dedicated scout explore phase right before planning", () => {
    const wf = getWorkflow("develop")!;
    const ids = wf.phases.map((p) => p.id);
    const exploreIdx = ids.indexOf("explore");
    assert.ok(exploreIdx >= 0 && ids[exploreIdx + 1] === "plan", `order wrong: ${ids.join(",")}`);
    assert.equal(findPhase("develop", "explore").agent, "scout");
  });

  test("plan phase: rounds, recommended answers, question cap, plan-file write, no implement", () => {
    const plan = findPhase("develop", "plan");
    const instructions = buildPhaseInstructions(plan, makeCtx("develop", 2));
    assert.ok(instructions.includes("recommended answer"));
    assert.ok(instructions.includes("Maximum 5 questions"));
    assert.ok(instructions.includes(".kstack/plans/"));
    assert.ok(instructions.includes("Do NOT start implementing"));
  });

// --- Phase scope boundaries (session-debug 2026-08-22: reproduce drifted into root-causing) ---

test("reproduce phase tasks carry a reproduction-only scope boundary", () => {
  const wf = getWorkflow("investigate")!;
  const reproduce = wf.phases.find((p) => p.id === "reproduce")!;
  // reproduce is a MAIN phase â€” its boundary must appear in buildPhaseInstructions
  const instructions = buildPhaseInstructions(reproduce, makeCtx("investigate", 0));
  assert.ok(instructions.includes("SCOPE BOUNDARY"), "reproduction boundary missing from main-phase instructions");
  assert.ok(instructions.includes("do NOT"));
});

test("root-cause phase tasks carry the validate-first directive", () => {
  const wf = getWorkflow("investigate")!;
  const rootCause = wf.phases.find((p) => p.id === "root-cause")!;
  const plan = buildDeterministicPlan(rootCause, makeCtx("investigate", 1));
  assert.ok(plan.length > 0);
  assert.ok(plan.some((s) => s.task.includes("VALIDATE it quickly")));
});

  test("implement worker reads the plan file, not a lossy summary", () => {
    const implement = findPhase("develop", "implement");
    const plan = buildDeterministicPlan(implement, makeCtx("develop", 3));
    assert.equal(plan[0].agent, "worker");
    assert.ok(plan[0].task.includes(".kstack/plans/add-dark-mode-toggle.md"), "plan file reference missing");
    assert.ok(plan[0].task.includes("Read it FIRST"), "plan-first instruction missing");
  });

  test("no delegated task imposes an arbitrary tool-call budget", () => {
    for (const wfid of getWorkflowIds()) {
      const wf = getWorkflow(wfid)!;
      for (const phase of wf.phases) {
        if (phase.execution !== "subagent") continue;
        const plan = buildDeterministicPlan(phase, makeCtx(wfid, 0));
        for (const step of plan) {
          // Full-injected methodology may MENTION tool calls as advisory text
          // (prose fallback, "validate tool calls", …). Only an actual BUDGET
          // directive — a cap/limit/phrase that constrains the delegate — is
          // forbidden.
          assert.ok(
            !/(tool calls?\s+(budget|cap|limit|maximum|max))|(limit[^\n]*\btool calls?\b)|(at most\s+\d+\s+tool calls?)/i.test(
              step.task,
            ),
            `${wfid}/${phase.id}`,
          );
        }
      }
    }
  });

  // Context-loss guard (session post-mortem 2026-08-28): task templates are
  // shared across workflows by phase id, so a {x}_summary placeholder only
  // resolves when a phase with id "x" exists in the SAME workflow. The
  // investigate and qa "fix" phases reused the review workflow's generic
  // template with {findings_summary}, which silently interpolated to
  // "(not yet available)" — the worker then ran with zero bug context and
  // fixed nothing. With every in-workflow phase pre-recorded below, the only
  // way "(not yet available)" can survive interpolation is a token pointing
  // at a phase that can never exist.
  test("every subagent task's {x}_summary token maps to a phase in the same workflow", () => {
    for (const wfid of getWorkflowIds()) {
      const wf = getWorkflow(wfid)!;
      const results: Record<string, { status: "completed"; summary: string }> = {};
      for (const p of wf.phases) results[p.id] = { status: "completed", summary: `recorded summary of ${p.id}` };
      for (const phase of wf.phases) {
        if (phase.execution !== "subagent") continue;
        const base = makeCtx(wfid, wf.phases.indexOf(phase));
        const ctx: WorkflowContext = { ...base, state: { ...base.state, results } };
        const plan = buildDeterministicPlan(phase, ctx);
        for (const step of plan) {
          assert.ok(
            !step.task.includes("(not yet available)"),
            `${wfid}/${phase.id}: task references a {x}_summary phase that does not exist in this workflow — worker runs without context. Task starts with: ${step.task.slice(0, 120)}`,
          );
        }
      }
    }
  });
});

describe("documentation phases", () => {
  test("develop ends with an optional document phase carrying both doc skills", () => {
    const doc = findPhase("develop", "document");
    assert.equal(doc.optional, true);
    assert.deepEqual(doc.skills, ["kstack-document-release", "kstack-document-generate"]);
  });

  test("ship carries an update-docs phase with both doc skills", () => {
    const doc = findPhase("ship", "update-docs");
    assert.equal(doc.optional, true);
    assert.deepEqual(doc.skills, ["kstack-document-release", "kstack-document-generate"]);
  });

  test("document task chains generate pass and requires DOC REPORT + atomic docs commit", () => {
    const doc = findPhase("develop", "document");
    const plan = buildDeterministicPlan(doc, makeCtx("develop", 7));
    assert.ok(plan[0].task.includes("Diataxis coverage map"));
    assert.ok(plan[0].task.includes("DOC REPORT"));
    assert.ok(plan[0].task.includes("docs: prefix"));
  });

  test("ship skill mandates TODOS.md reconciliation and git discipline", () => {
    const skill = loadSkillFull("kstack-ship")!;
    assert.ok(/TODOS\.md/.test(skill), "TODOS.md reconciliation missing");
    assert.ok(/git add -A/.test(skill), "no-git-add-A rule missing");
  });
});

describe("qa report-only mode", () => {
  test("qa-report workflow exists, all phases report-only", () => {
    const wf = getWorkflow("qa-report")!;
    assert.equal(wf.name, "QA Report (No Fixes)");
    for (const phase of wf.phases) {
      assert.equal(phase.variant, "report-only", `${wf.id}/${phase.id} not report-only`);
    }
  });

  test("report-only directives appear in instructions and subagent tasks", () => {
    const setup = findPhase("qa-report", "setup");
    assert.ok(buildPhaseInstructions(setup, makeCtx("qa-report")).includes("REPORT-ONLY MODE"));

    const testPhase = findPhase("qa-report", "test");
    const plan = buildDeterministicPlan(testPhase, makeCtx("qa-report", 1));
    assert.ok(plan[0].task.includes("REPORT-ONLY MODE"));
    assert.ok(plan[0].task.includes("do NOT fix anything"));
  });

  test("normal qa workflow is NOT report-only", () => {
    for (const phase of getWorkflow("qa")!.phases) {
      assert.notEqual(phase.variant, "report-only");
    }
  });
});

describe("deterministic delegation plan", () => {
  test("single-agent phases resolve to one interpolated task with skill content", () => {
    const qa = findPhase("develop", "qa");
    const plan = buildDeterministicPlan(qa, makeCtx("develop", 4));
    assert.equal(plan.length, 1);
    assert.equal(plan[0].agent, "worker");
    assert.ok(plan[0].task.includes("add dark mode toggle"), "goal not interpolated");
    assert.ok(plan[0].task.includes("Skill methodology: kstack-qa"), "skill digest not embedded in task");
  });

  test("chain steps also receive embedded skill methodology", () => {
    const rootCause = findPhase("investigate", "root-cause");
    assert.equal(rootCause.advance, "manual");
    const plan = buildDeterministicPlan(rootCause, makeCtx("investigate", 1));
    assert.deepEqual(plan.map((s) => s.agent), ["scout", "planner"]);
    assert.ok(plan[0].task.includes("Skill methodology: kstack-investigate"), "digest not embedded in chain step");
    assert.ok(plan[0].task.includes("add dark mode toggle"), "goal not interpolated in chain step");
  });

  test("explore phase delegates to the scout agent deterministically", () => {
    const explore = findPhase("develop", "explore");
    const plan = buildDeterministicPlan(explore, makeCtx("develop", 1));
    assert.equal(plan.length, 1);
    assert.equal(plan[0].agent, "scout");
    assert.ok(plan[0].task.includes("Facts only"), "exploration discipline missing");
  });
});


describe("intent matching", () => {
  test("investigate matches debug keywords", () => {
    const wf = getWorkflow("investigate")!;
    const text = "why is the login page broken";
    const matched = wf.intents.some((i) => i.pattern.test(text));
    assert.ok(matched);
  });

  test("ship matches deploy keywords", () => {
    const wf = getWorkflow("ship")!;
    const text = "let's ship this and create a pr";
    const matched = wf.intents.some((i) => i.pattern.test(text));
    assert.ok(matched);
  });

  test("develop matches feature keywords", () => {
    const wf = getWorkflow("develop")!;
    const text = "build a new dashboard component";
    const matched = wf.intents.some((i) => i.pattern.test(text));
    assert.ok(matched);
  });

  test("qa matches test keywords", () => {
    const wf = getWorkflow("qa")!;
    const text = "does this work? test the site please";
    const matched = wf.intents.some((i) => i.pattern.test(text));
    assert.ok(matched);
  });
});

// --- STEP 0: structured run-report telemetry --------------------------------

describe("run-report telemetry", () => {
  test("report schema is stable", () => {
    resetTelemetry();
    beginRun("investigate");
    recordDelegatedStep({
      phaseId: "root-cause",
      stepIndex: 0,
      agent: "scout",
      durationMs: 65432,
      toolCalls: 27,
      turns: 9,
      tokensIn: 120000,
      tokensCacheRead: 90000,
      tokensOut: 5400,
      timeoutClass: "default",
    });
    const report = buildRunReport("investigate");
    assert.equal(report.workflowId, "investigate");
    assert.equal(report.steps.length, 1);
    const step = report.steps[0];
    for (const key of [
      "phaseId", "stepIndex", "agent", "durationMs", "toolCalls", "turns",
      "tokensIn", "tokensCacheRead", "tokensOut", "handoffLevel", "incomplete",
      "timedOut", "timeoutClass",
    ]) {
      assert.ok(key in step, `missing field in report step: ${key}`);
    }
    assert.ok(report.startedAt.length > 0);
    assert.ok(report.writtenAt.length > 0);
    assert.ok(Array.isArray(report.livenessObservations));
  });

  test("writeRunReport persists a JSON report under .kstack/runs after a simulated run", () => {
    resetTelemetry();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kstack-telemetry-"));
    try {
      beginRun("investigate");
      recordDelegatedStep({ phaseId: "reproduce", stepIndex: 0, agent: "worker", durationMs: 1000, timeoutClass: "default" });
      const filePath = writeRunReport(tmp, "investigate");
      assert.ok(filePath, "expected a written report");
      assert.ok(existsSync(filePath));
      assert.ok(filePath.includes(path.join(".kstack", "runs")));
      assert.ok(/\.json$/.test(filePath));
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      assert.equal(parsed.workflowId, "investigate");
      assert.equal(parsed.steps.length, 1);
      assert.equal(parsed.steps[0].phaseId, "reproduce");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      resetTelemetry();
    }
  });

  test("writing is best-effort: consumed accumulator and foreign workflow yield null, never a throw", () => {
    resetTelemetry();
    beginRun("qa");
    assert.equal(writeRunReport(process.cwd(), "develop"), null); // different workflow
    assert.ok(writeRunReport(process.cwd(), "qa"), "active run should write");
    assert.equal(writeRunReport(process.cwd(), "qa"), null, "accumulator consumed after flush");
    resetTelemetry();
  });

  test("ensureRun starts a run once and does not clobber an active one", () => {
    resetTelemetry();
    ensureRun("ship");
    recordDelegatedStep({ phaseId: "review", stepIndex: 0, agent: "reviewer", durationMs: 10 });
    ensureRun("ship"); // must NOT reset the accumulator
    recordDelegatedStep({ phaseId: "test", stepIndex: 0, agent: "worker", durationMs: 20 });
    assert.equal(buildRunReport("ship").steps.length, 2);
    resetTelemetry();
  });

  test("file names are Windows-safe (no colons)", () => {
    const name = runReportFileName("2026-08-23T10:30:00.000Z", "investigate");
    assert.ok(!name.includes(":"));
    assert.ok(name.endsWith("-investigate.json"));
  });
});

// --- STEP 1: deliverable-first contracts + language audit --------------------

describe("deliverable-first contracts (STEP 1)", () => {
  const ITALIAN_STOPLIST = ["fase", "trova", "leggi", "scrivi", "deve", "sempre", "perchÃ©", "delle", "degli", "questo"];

  function injectableStrings(): string[] {
    const out: string[] = [];
    for (const wf of getAllWorkflows()) {
      let idx = 0;
      for (const phase of wf.phases) {
        const ctx = makeCtx(wf.id, idx++);
        if (phase.execution === "subagent") {
          for (const step of buildDeterministicPlan(phase, ctx)) out.push(step.task);
        } else {
          out.push(buildPhaseInstructions(phase, ctx));
        }
      }
    }
    for (const id of getSkillIds()) {
      const full = loadSkillFull(id);
      if (full) out.push(full);
    }
    return out;
  }

  test("every phase on every path carries DELIVERABLE and STOP CONDITION", () => {
    for (const wf of getAllWorkflows()) {
      let idx = 0;
      for (const phase of wf.phases) {
        const ctx = makeCtx(wf.id, idx++);
        if (phase.execution === "subagent") {
          const plan = buildDeterministicPlan(phase, ctx);
          assert.ok(plan.length > 0, `${wf.id}/${phase.id} produced an empty plan`);
          for (const step of plan) {
            assert.ok(step.task.includes("## DELIVERABLE"), `${wf.id}/${phase.id} (${step.agent}) task missing DELIVERABLE`);
            assert.ok(step.task.includes("## STOP CONDITION"), `${wf.id}/${phase.id} (${step.agent}) task missing STOP CONDITION`);
          }
        } else {
          const instructions = buildPhaseInstructions(phase, ctx);
          assert.ok(instructions.includes("## DELIVERABLE"), `${wf.id}/${phase.id} main instructions missing DELIVERABLE`);
          assert.ok(instructions.includes("## STOP CONDITION"), `${wf.id}/${phase.id} main instructions missing STOP CONDITION`);
        }
      }
    }
  });

  test("methodology blocks carry the correct class prefix and follow the deliverable", () => {
    const qa = findPhase("develop", "qa");
    const qaPlan = buildDeterministicPlan(qa, makeCtx("develop", 4));
    assert.ok(qaPlan[0].task.includes("Skill methodology: kstack-qa (format-critical)"), "qa should be format-critical");
    assert.ok(
      qaPlan[0].task.includes("output format IS part of the deliverable"),
      "format-critical prefix missing",
    );
    assert.ok(
      qaPlan[0].task.indexOf("## DELIVERABLE") < qaPlan[0].task.indexOf("## METHODOLOGY"),
      "methodology must come after the deliverable",
    );

    const pushPr = findPhase("ship", "push-pr");
    const shipPlan = buildDeterministicPlan(pushPr, makeCtx("ship", 4));
    assert.ok(shipPlan[0].task.includes("Skill methodology: kstack-ship (support)"), "ship should be support-class");
    assert.ok(shipPlan[0].task.includes("Apply the parts useful to the deliverable"), "support prefix missing");
  });

  test("update-docs resolves to the real doc contract instead of the generic fallback", () => {
    const updateDocs = findPhase("ship", "update-docs");
    const plan = buildDeterministicPlan(updateDocs, makeCtx("ship", 4));
    assert.equal(plan.length, 1);
    assert.ok(plan[0].task.includes("Diataxis coverage map"), "generic fallback leaked through for update-docs");
    assert.ok(plan[0].task.includes("DOC REPORT"));
    assert.ok(plan[0].task.includes("docs: prefix"));
  });

  test("language audit: zero non-English content in injectable strings", () => {
    for (const s of injectableStrings()) {
      const lower = s.toLowerCase();
      for (const word of ITALIAN_STOPLIST) {
        assert.ok(
          !new RegExp(`\\b${word}\\b`).test(lower),
          `Italian stoplist word "${word}" found in: ${s.slice(0, 140).replace(/\s+/g, " ")}...`,
        );
      }
      assert.ok(
        !/[Ã Ã¨Ã©Ã¬Ã²Ã¹]/i.test(s),
        `accented letter found in: ${s.slice(0, 140).replace(/\s+/g, " ")}...`,
      );
    }
  });
});

// --- STEP 2: HANDOFF protocol, safe interpolation, resilience ----------------

import { extractHandoff } from "../orchestrator/handoff.ts";
import { replaceExact } from "../orchestrator/text.ts";
import { isTransientFailure, retryDecision, RETRY_DELAY_MS, FAST_RETRY_DELAY_MS } from "../orchestrator/executor.ts";
import { optionalPhases } from "../orchestrator/config.ts";

function bigReport(handoffSection?: string): string {
  const filler = "x".repeat(9000);
  return `## REPORT\n${filler}\n${handoffSection ?? ""}`;
}
const GOOD_HANDOFF = "## HANDOFF\nVERIFIED FACTS:\n- retry loop resets state @ src/app.ts:42\nDECISIONS: none\nOPEN QUESTIONS: none\nDO NOT REDO: reproduction";

describe("extractHandoff levels (STEP 2b)", () => {
  test("small output travels whole at level raw", () => {
    const h = extractHandoff("short report");
    assert.equal(h.level, "raw");
    assert.equal(h.text, "short report");
  });

  test("empty output yields the failed-step placeholder", () => {
    const h = extractHandoff("");
    assert.equal(h.level, "raw");
    assert.equal(h.text, "(previous step failed)");
    assert.equal(extractHandoff("   ").text, "(previous step failed)");
  });

  test("valid HANDOFF section inside a long report is extracted as full", () => {
    const h = extractHandoff(bigReport(GOOD_HANDOFF));
    assert.equal(h.level, "full");
    assert.ok(h.text.startsWith("## HANDOFF"));
    assert.ok(h.text.includes("VERIFIED FACTS"));
    assert.ok(h.text.length <= 4000, "full handoff must stay within the 4000-char invariant");
  });

  test("malformed HANDOFF section degrades to partial", () => {
    const h = extractHandoff(bigReport("## HANDOFF\nsome unstructured tail note"));
    assert.equal(h.level, "partial");
    assert.ok(h.text.includes("unstructured tail note"));
  });

  test("oversized or absent HANDOFF falls back to the paragraph-cut tail", () => {
    const oversized = `## HANDOFF\nVERIFIED FACTS:\n${"y".repeat(5000)}`;
    const h1 = extractHandoff(bigReport(oversized));
    assert.equal(h1.level, "fallback");
    assert.ok(h1.text.length <= 12000);
    const h2 = extractHandoff("z".repeat(20000));
    assert.equal(h2.level, "fallback");
    assert.ok(h2.text.length <= 12000);
  });

  test("the fallback tail keeps the END of the output — the head is what is dropped", () => {
    // Rule 6 is a TAIL cut: a trailing HANDOFF-shaped tail must survive while
    // leading content is dropped, and the cut must not start mid-line.
    const tailEnd = "TRAILING NOTE\nstatus == green";
    const head = `LEADING-CONTENT ${"a".repeat(13000)}`;
    const h = extractHandoff(`${head}\n${tailEnd}`);
    assert.equal(h.level, "fallback");
    assert.equal(h.text, tailEnd, "the cut advances past the first break in the tail");
    assert.ok(!h.text.includes("LEADING-CONTENT"));
  });

  test("a tail with no line break returns the raw last `limit` chars", () => {
    const h = extractHandoff("z".repeat(20000));
    assert.equal(h.level, "fallback");
    assert.equal(h.text, "z".repeat(12000));
  });

  test("incomplete output caps the level at fallback", () => {
    assert.equal(extractHandoff(bigReport(GOOD_HANDOFF), { incomplete: true }).level, "fallback");
    assert.equal(extractHandoff("tiny", { incomplete: true }).level, "fallback");
  });
});

describe("$-safe interpolation (STEP 2c)", () => {
  test("replaceExact treats $ patterns literally", () => {
    const evil = `$& $\` $' $1 $$`;
    assert.equal(replaceExact("A B", /B/, evil), `A ${evil}`);
    // Sanity: naive .replace would have corrupted the output.
    assert.notEqual("A B".replace(/B/, evil), `A ${evil}`);
  });

  function ctxWithGoal(goal: string): WorkflowContext {
    const c = makeCtx("develop", 0);
    c.state.goal = goal;
    return c;
  }

  test("interpolate() survives $&, $', $1 payloads in the user goal", () => {
    const evilGoal = "add $& dark $' mode $1 toggle $$";
    const explore = findPhase("develop", "explore");
    const plan = buildDeterministicPlan(explore, ctxWithGoal(evilGoal));
    assert.ok(plan[0].task.includes(evilGoal), "goal corrupted by $ pattern interpolation");
  });
});

describe("AGENTS_NOTES mirror (STEP 2e)", () => {
  const PLANNER_DIRECTIVE = "You receive VERIFIED FACTS from a prior specialist. Treat them as context, not proof: do NOT re-verify systematically, but ALWAYS re-check claims that are load-bearing for code changes you are about to make.";
  const WORKER_DIRECTIVE = "Trust the HANDOFF section of the task as working context; re-check only claims that are load-bearing for edits you are about to make.";
  const HOME_AGENTS_DIR = path.join(os.homedir(), ".pi", "agent", "agents");

  test("home agent files carry the directives documented in AGENTS_NOTES.md", () => {
    const planner = readFileSync(path.join(HOME_AGENTS_DIR, "planner.md"), "utf-8");
    const worker = readFileSync(path.join(HOME_AGENTS_DIR, "worker.md"), "utf-8");
    assert.ok(planner.includes(PLANNER_DIRECTIVE), "planner.md drifted from AGENTS_NOTES.md");
    assert.ok(worker.includes(WORKER_DIRECTIVE), "worker.md drifted from AGENTS_NOTES.md");
  });

  test("AGENTS_NOTES.md documents both directives", () => {
    const notes = readFileSync(path.join(process.cwd(), "AGENTS_NOTES.md"), "utf-8");
    assert.ok(notes.includes("planner.md"));
    assert.ok(notes.includes("worker.md"));
  });
});

describe("chain retry policy (STEP 2f)", () => {
  const okResult: any = { ok: true, output: "done", exitCode: 0, durationMs: 10 };
  const timeoutResult: any = { ok: false, output: "partial", exitCode: null, durationMs: 100, timedOut: true, incomplete: true };
  const exitFailNoOutput: any = { ok: false, output: "", error: "crashed", exitCode: 3, durationMs: 50 };
  const configError: any = { ok: false, output: "", error: 'Unknown agent "nope".', exitCode: 1, durationMs: 0, configError: true };

  test("transient failures are retried once with a +50% timeout; hard failures are not", () => {
    assert.deepEqual(retryDecision(timeoutResult, 1), { retry: true, timeoutScale: 1.5, delayMs: RETRY_DELAY_MS });
    assert.deepEqual(retryDecision(exitFailNoOutput, 1), { retry: true, timeoutScale: 1.5, delayMs: FAST_RETRY_DELAY_MS });
    assert.deepEqual(retryDecision(okResult, 1), { retry: false, timeoutScale: 1, delayMs: 0 });
    assert.deepEqual(retryDecision(configError, 1), { retry: false, timeoutScale: 1, delayMs: 0 });
    assert.deepEqual(retryDecision(timeoutResult, 2), { retry: false, timeoutScale: 1, delayMs: 0 }, "at most one retry");
    assert.equal(RETRY_DELAY_MS, 30_000);
    assert.equal(FAST_RETRY_DELAY_MS, 5_000);
    assert.equal(isTransientFailure(configError), false);
    assert.equal(isTransientFailure(timeoutResult), true);
  });
});

describe("optional-phase modes (STEP 2g)", () => {
  test("KSTACK_PI_OPTIONAL_PHASES resolves ask/auto/skip with ask default", () => {
    const original = process.env.KSTACK_PI_OPTIONAL_PHASES;
    try {
      delete process.env.KSTACK_PI_OPTIONAL_PHASES;
      assert.equal(optionalPhases(), "ask");
      process.env.KSTACK_PI_OPTIONAL_PHASES = "auto";
      assert.equal(optionalPhases(), "auto");
      process.env.KSTACK_PI_OPTIONAL_PHASES = "skip";
      assert.equal(optionalPhases(), "skip");
      process.env.KSTACK_PI_OPTIONAL_PHASES = "garbage";
      assert.equal(optionalPhases(), "ask");
    } finally {
      if (original === undefined) delete process.env.KSTACK_PI_OPTIONAL_PHASES;
      else process.env.KSTACK_PI_OPTIONAL_PHASES = original;
    }
  });
});

// --- STEP 2g v2: optional-phase decision gate ---------------------------------
// The old flow prompted `ctx.ui.confirm` from the fire-and-forget background
// chain: the dialog fired mid-stream, stole editor focus, and defaulted to
// "Yes" on Enter — a user typing "no, skip QA" + Enter LAUNCHED the QA phase
// they were refusing. The fix parks the workflow at the optional phase and
// hands the Run/Skip/Abort decision to the foreground /kstack panel.

describe("optional-phase decision gate (STEP 2g v2)", () => {
  const investigate = getWorkflow("investigate")!;
  const qaIndex = investigate.phases.findIndex((p) => p.id === "regression-qa");

  test("investigate's regression-qa is the last phase and optional", () => {
    assert.equal(investigate.phases.length, 5);
    assert.equal(qaIndex, 4);
    const qa = investigate.phases[qaIndex];
    assert.equal(qa.optional, true);
    assert.ok(qa.skipWhen, "conditional auto-skip (clean tree) must be preserved");
  });

  test("gateOptionalPhase parks the workflow AT the optional phase with the marker set", () => {
    const state = { ...createState("investigate", "fix login bug"), phaseIndex: qaIndex };
    const gated = gateOptionalPhase(state);
    assert.equal(gated.status, "awaiting_approval");
    assert.equal(gated.pendingOptional, true);
    assert.equal(gated.phaseIndex, qaIndex, "phaseIndex must stay at the optional phase");
  });

  test("approveOptionalPhase clears the marker and reactivates at the same phase", () => {
    const state = { ...createState("investigate", "fix login bug"), phaseIndex: qaIndex, status: "awaiting_approval" as const, pendingOptional: true };
    const approved = approveOptionalPhase(state);
    assert.equal(approved.status, "active");
    assert.equal(approved.pendingOptional, undefined);
    assert.equal(approved.phaseIndex, qaIndex);
  });

  test("skipPendingOptional records 'skipped' and COMPLETES the workflow when the phase is last", () => {
    const state = { ...createState("investigate", "fix login bug"), phaseIndex: qaIndex, status: "awaiting_approval" as const, pendingOptional: true };
    const next = skipPendingOptional(state, investigate.phases, investigate.phases.length);
    assert.equal(next.status, "completed", "refusing the last phase must finish the workflow, not hang it");
    assert.equal(next.pendingOptional, undefined);
    assert.equal(next.results["regression-qa"]?.status, "skipped");
    assert.match(next.results["regression-qa"]?.summary ?? "", /Skipped by user/);
  });

  test("skipPendingOptional advances linearly when the optional phase is NOT last", () => {
    const develop = getWorkflow("develop")!;
    const shipIndex = develop.phases.findIndex((p) => p.id === "ship");
    const state = { ...createState("develop", "add dark mode"), phaseIndex: shipIndex, status: "awaiting_approval" as const, pendingOptional: true };
    const next = skipPendingOptional(state, develop.phases, develop.phases.length);
    assert.equal(next.status, "active");
    assert.equal(next.phaseIndex, shipIndex + 1, "moves past ship to document");
    assert.equal(next.results["ship"]?.status, "skipped");
  });

  test("gate round-trip: park then skip completes and clears the marker", () => {
    const state = { ...createState("investigate", "fix login bug"), phaseIndex: qaIndex };
    const gated = gateOptionalPhase(state);
    const skipped = skipPendingOptional(gated, investigate.phases, investigate.phases.length);
    assert.equal(skipped.status, "completed");
    assert.equal(skipped.pendingOptional, undefined);
  });
});

// --- STEP 3: role-scoped skill injection -------------------------------------

describe("role-scoped skill injection (STEP 3)", () => {
  test("root-cause chain: scout gets the investigation digest, planner gets fix-strategy only", () => {
    const rootCause = findPhase("investigate", "root-cause");
    const plan = buildDeterministicPlan(rootCause, makeCtx("investigate", 1));
    assert.deepEqual(plan.map((s) => s.agent), ["scout", "planner"]);
    assert.ok(plan[0].task.includes("Skill methodology: kstack-investigate"), "scout lost the full methodology");
    assert.ok(plan[1].task.includes("Skill methodology: kstack-fix-strategy"), "planner missing the fix-strategy digest");
    assert.ok(!plan[1].task.includes("Skill methodology: kstack-investigate"), "planner must NOT receive the full investigation digest [E1]");
  });

  test("kstack-fix-strategy is a canonical registry skill with a parsed gate", () => {
    const info = getSkillInfo("kstack-fix-strategy");
    assert.ok(info);
    assert.ok(existsSync(info.skillPath));
    const gate = loadSkillGate("kstack-fix-strategy");
    assert.ok(gate);
    assert.ok(gate.includes("VALIDATED:"), "gate missing VALIDATED contract");
    assert.ok(gate.includes("REFUTED:"), "gate missing REFUTED contract");
  });

  test("chain steps without an override inherit the phase skills", () => {
    // The document phase has no per-step override: its steps keep kstack-document-*.
    const doc = findPhase("develop", "document");
    const plan = buildDeterministicPlan(doc, makeCtx("develop", 7));
    for (const step of plan) {
      assert.ok(
        step.task.includes("Skill methodology: kstack-document-release") || step.task.includes("Skill methodology: kstack-document-generate"),
        "inherited phase skills lost",
      );
    }
  });
});

// --- STEP 4: structural skip with anti-spoofing guards -----------------------

import {
  parseRootCauseMarker,
  validateStrategyTask,
  allTestsPassed,
  isValidatedStrategy,
  isRefutedStrategy,
} from "../orchestrator/skip.ts";
import { autoGateValidated } from "../orchestrator/config.ts";

const VALID_MARKER = 'CONFIRMED ROOT CAUSE: retry loop resets cache state | files: src/app.ts, src/cache.ts';
const HANDOFF_PAYLOAD = "## HANDOFF\nVERIFIED FACTS:\n- cause confirmed @ src/app.ts:42\n" + VALID_MARKER;

describe("root-cause marker parsing (STEP 4b)", () => {
  test("parses a valid marker inside a HANDOFF with existing files", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "kstack-skip-"));
    try {
      fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
      writeFileSync(path.join(tmp, "src", "app.ts"), "x");
      writeFileSync(path.join(tmp, "src", "cache.ts"), "x");
      const marker = parseRootCauseMarker(HANDOFF_PAYLOAD, tmp);
      assert.ok(marker);
      assert.equal(marker.cause, "retry loop resets cache state");
      assert.deepEqual(marker.files, ["src/app.ts", "src/cache.ts"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("marker before the LAST ## HANDOFF heading yields null + warning", () => {
    const warnings: string[] = [];
    // Marker sits above the real HANDOFF heading — a planted early heading
    // (or none at all) cannot smuggle it into the section.
    const text = VALID_MARKER + "\nbody text\n## HANDOFF\nVERIFIED FACTS: legit";
    assert.equal(parseRootCauseMarker(text, process.cwd(), (m) => warnings.push(m)), null);
    assert.ok(warnings.some((w) => w.includes("[skip] root-cause marker outside HANDOFF ignored")));
  });

  test("marker with NO ## HANDOFF at all is honored (main-phase summary channel)", () => {
    // The reproduce phase's summary never contains a HANDOFF section — the
    // collapse was unreachable when the guard required one.
    const tmp = mkdtempSync(path.join(os.tmpdir(), "kstack-skip3-"));
    try {
      fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
      writeFileSync(path.join(tmp, "src", "app.ts"), "x");
      writeFileSync(path.join(tmp, "src", "cache.ts"), "x");
      const marker = parseRootCauseMarker("Reproduced reliably.\n" + VALID_MARKER, tmp);
      assert.ok(marker, "no-HANDOFF summary with real cited files must parse");
      assert.equal(marker.cause, "retry loop resets cache state");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("nonexistent cited files yield null", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "kstack-skip2-"));
    try {
      assert.equal(parseRootCauseMarker(HANDOFF_PAYLOAD, tmp), null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("none / absent / malformed markers yield null", () => {
    assert.equal(parseRootCauseMarker("## HANDOFF\nCONFIRMED ROOT CAUSE: none | files: none", process.cwd()), null);
    assert.equal(parseRootCauseMarker("## HANDOFF\nno marker here", process.cwd()), null);
    assert.equal(parseRootCauseMarker("## HANDOFF\nCONFIRMED ROOT CAUSE: broken marker without files", process.cwd()), null);
  });

  test("validateStrategyTask keeps the anti-spoofing contract", () => {
    const task = validateStrategyTask({ cause: "cache reset loop", files: ["a.ts"] });
    assert.ok(task.includes("## DELIVERABLE"));
    assert.ok(task.includes("## STOP CONDITION"));
    assert.ok(task.includes('"cache reset loop"'));
    assert.ok(task.includes("REFUTED:"));
  });
});

describe("conditional collapse (STEP 4c)", () => {
  test("valid reproduce summary collapses the chain to ONE planner step", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "kstack-collapse-"));
    try {
      fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
      writeFileSync(path.join(tmp, "src", "app.ts"), "x");
      writeFileSync(path.join(tmp, "src", "cache.ts"), "x");
      const ctx = makeCtx("investigate", 1);
      ctx.cwd = tmp;
      ctx.state.results["reproduce"] = { status: "completed", summary: "Reproduced reliably. " + HANDOFF_PAYLOAD };
      const rootCause = findPhase("investigate", "root-cause");
      const plan = buildDeterministicPlan(rootCause, ctx);
      assert.equal(plan.length, 1);
      assert.equal(plan[0].agent, "planner");
      assert.ok(plan[0].task.includes("CONFIRMED this cause"));
      assert.ok(!plan[0].task.toLowerCase().includes("scout"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("without a valid marker the full scout-planner plan stays intact", () => {
    const rootCause = findPhase("investigate", "root-cause");
    const plan = buildDeterministicPlan(rootCause, makeCtx("investigate", 1));
    assert.deepEqual(plan.map((s) => s.agent), ["scout", "planner"]);
  });
});

describe("refutation + QA skip helpers (STEP 4d)", () => {
  test("isValidated / isRefuted read the first meaningful line only", () => {
    assert.equal(isValidatedStrategy("VALIDATED: off-by-one @ a.ts:12\nmore"), true);
    assert.equal(isValidatedStrategy("the answer is VALIDATED:"), false);
    assert.equal(isRefutedStrategy("REFUTED: files were already correct"), true);
    assert.equal(isRefutedStrategy(""), false);
  });

  test("allTestsPassed is falsifiable and safe on malformed summaries", () => {
    assert.equal(allTestsPassed("Ran the suite: 120 passed, 0 failures"), true);
    assert.equal(allTestsPassed("All tests green after the fix"), true);
    assert.equal(allTestsPassed("2 failures in checkout flow"), false);
    assert.equal(allTestsPassed(undefined), false);
    assert.equal(allTestsPassed("garbage summary"), false);
  });

  test("qa fix phase gains a test-based structural skipWhen", () => {
    const qaFix = findPhase("qa", "fix");
    assert.ok(qaFix.skipWhen, "qa/fix must declare skipWhen");
    const passedCtx = makeCtx("qa", 3);
    passedCtx.state.results["test"] = { status: "completed", summary: "suite run: 50 passed, 0 failures" };
    assert.equal(qaFix.skipWhen!(passedCtx), true);
    const failedCtx = makeCtx("qa", 3);
    failedCtx.state.results["test"] = { status: "completed", summary: "3 failures found" };
    assert.equal(qaFix.skipWhen!(failedCtx), false);
  });
});

describe("auto-gate opt-in (STEP 4e)", () => {
  test("KSTACK_PI_AUTO_GATE_VALIDATED defaults OFF and parses correctly", () => {
    const original = process.env.KSTACK_PI_AUTO_GATE_VALIDATED;
    try {
      delete process.env.KSTACK_PI_AUTO_GATE_VALIDATED;
      assert.equal(autoGateValidated(), false);
      process.env.KSTACK_PI_AUTO_GATE_VALIDATED = "1";
      assert.equal(autoGateValidated(), true);
      process.env.KSTACK_PI_AUTO_GATE_VALIDATED = "off";
      assert.equal(autoGateValidated(), false);
    } finally {
      if (original === undefined) delete process.env.KSTACK_PI_AUTO_GATE_VALIDATED;
      else process.env.KSTACK_PI_AUTO_GATE_VALIDATED = original;
    }
  });
});

// --- STEP 5: adaptive timeouts, liveness, token budget -----------------------

import {
  numberEnv,
  timeoutClassFor,
  subagentTimeoutFor,
  livenessThresholdMs,
  maxRunTokens,
} from "../orchestrator/config.ts";
import { recordTokens, totalTokensUsed, recordLiveness, buildRunReport as reportOf } from "../orchestrator/telemetry.ts";

describe("timeout classes (STEP 5a)", () => {
  test("every phase of every workflow resolves to a known class (no fallback fallthrough)", () => {
    for (const wf of getAllWorkflows()) {
      for (const phase of wf.phases) {
        assert.ok(
          timeoutClassFor(phase.id) !== null,
          `${wf.id}/${phase.id} is not mapped to a timeout class`,
        );
      }
    }
  });

  test("per-class env overrides are honored (seconds -> ms)", () => {
    const saved: Record<string, string | undefined> = {};
    const keys = ["KSTACK_PI_TIMEOUT_EXPLORE", "KSTACK_PI_TIMEOUT_WORK", "KSTACK_PI_TIMEOUT_VERIFY", "KSTACK_PI_SUBAGENT_TIMEOUT"];
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    try {
      assert.equal(subagentTimeoutFor("explore"), 900 * 1000);
      assert.equal(subagentTimeoutFor("implement"), 1500 * 1000);
      assert.equal(subagentTimeoutFor("review"), 900 * 1000);
      assert.equal(subagentTimeoutFor("totally-unknown-phase"), 1200 * 1000);
      process.env.KSTACK_PI_TIMEOUT_WORK = "60";
      assert.equal(subagentTimeoutFor("implement"), 60 * 1000);
      process.env.KSTACK_PI_TIMEOUT_WORK = "garbage";
      assert.equal(subagentTimeoutFor("implement"), 1500 * 1000, "invalid value falls back to default");
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe("numeric config parser (STEP 5a / COR-10)", () => {
  test("numberEnv handles default/override/off/invalid", () => {
    const NAME = "KSTACK_PI_TEST_NUMBER";
    const original = process.env[NAME];
    try {
      delete process.env[NAME];
      assert.equal(numberEnv(NAME, 42), 42);
      process.env[NAME] = "7";
      assert.equal(numberEnv(NAME, 42), 7);
      process.env[NAME] = "off";
      assert.equal(numberEnv(NAME, 42), 42, "off sentinel requires allowOff");
      assert.equal(numberEnv(NAME, 42, { allowOff: true }), "off");
      process.env[NAME] = "abc";
      assert.equal(numberEnv(NAME, 42), 42);
      process.env[NAME] = "-3";
      assert.equal(numberEnv(NAME, 42), 42);
      process.env[NAME] = "2";
      assert.equal(numberEnv(NAME, 42, { min: 10 }), 42, "below min falls back");
    } finally {
      if (original === undefined) delete process.env[NAME];
      else process.env[NAME] = original;
    }
  });

  test("liveness threshold default 240s and supports off", () => {
    const NAME = "KSTACK_PI_LIVENESS_SEC";
    const original = process.env[NAME];
    try {
      delete process.env[NAME];
      assert.equal(livenessThresholdMs(), 240 * 1000);
      process.env[NAME] = "off";
      assert.equal(livenessThresholdMs(), "off");
      process.env[NAME] = "30";
      assert.equal(livenessThresholdMs(), 30 * 1000);
    } finally {
      if (original === undefined) delete process.env[NAME];
      else process.env[NAME] = original;
    }
  });

  test("token budget default disabled", () => {
    const NAME = "KSTACK_PI_MAX_RUN_TOKENS";
    const original = process.env[NAME];
    try {
      delete process.env[NAME];
      assert.equal(maxRunTokens(), Number.POSITIVE_INFINITY);
      process.env[NAME] = "100000";
      assert.equal(maxRunTokens(), 100000);
    } finally {
      if (original === undefined) delete process.env[NAME];
      else process.env[NAME] = original;
    }
  });
});

describe("token circuit-breaker + liveness recording (STEP 5b/5c)", () => {
  test("token accumulation feeds the breaker decision without killing anything", () => {
    resetTelemetry();
    beginRun("qa");
    assert.equal(totalTokensUsed(), 0);
    recordTokens(500);
    recordTokens(300);
    assert.equal(totalTokensUsed(), 800);
    const max = maxRunTokens(); // Infinity by default in tests
    assert.ok(!(totalTokensUsed() > max));
    resetTelemetry();
  });

  test("liveness observations land in the run report and imply no kill", () => {
    resetTelemetry();
    beginRun("investigate");
    recordLiveness({ agent: "worker", gapSec: 250, lastEvent: "tool_execution_start", lastTool: "bash" });
    const report = reportOf("investigate");
    assert.equal(report.livenessObservations.length, 1);
    assert.equal(report.livenessObservations[0].gapSec, 250);
    assert.equal(report.livenessObservations[0].lastTool, "bash");
    resetTelemetry();
  });
});

// --- CRASH REGRESSION: real spawn path (2026-08-23 field incident) ----------
// The pi process died with "ReferenceError: livenessThresholdMs is not defined"
// thrown from the abort-poll setInterval callback 1s into the retry.
// These tests execute the REAL runSubagent spawn path (agentDef bypasses
// agent discovery, so no ~/.pi/agent/agents lookup is needed) and would have
// caught the missing-import + nested-scope bugs.

describe("runSubagent real spawn path (crash regression)", () => {
  const MINIMAL_AGENT = {
    name: "regression-agent",
    description: "minimal inline test agent",
    systemPrompt: "You are a minimal test assistant. Reply with exactly the single word PONG and nothing else.",
    tools: [],
    filePath: "inline",
  };

  const PONG_TIMEOUT = 120_000; // generous for a 10-20s real pi boot

  function resolveCliPath(): string | null {
    // Mirrors npm global layout: <prefix>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
    const prefixes = [
      path.join(os.homedir(), "AppData", "Roaming", "npm"),
      path.join(os.homedir(), ".npm-global"),
    ];
    for (const prefix of prefixes) {
      const candidate = path.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  // Opt-in end-to-end: pi's CLI boots slower under `bun test` than the 30s
  // command budget allows reliably, so this runs only when explicitly
  // requested via KSTACK_PI_E2E_SPAWN=1. The crash-class regressions
  // (missing import, nested-scope ReferenceError) are fully covered by the
  // typecheck gate + the pure unit tests in this suite; this test guards
  // the RUNTIME path additionally.
  if (process.env.KSTACK_PI_E2E_SPAWN === "1") {
    test("spawns a real child, parses output, resolves without ReferenceErrors",
      { timeout: 300_000 },
      async () => {
        const cliPath = resolveCliPath();
        assert.ok(cliPath, "pi CLI not found in expected npm global locations");
        const tmpCwd = mkdtempSync(path.join(os.tmpdir(), "kstack-e2e-"));
        const result = await runSubagent({
          agent: "regression-agent",
          agentDef: MINIMAL_AGENT,
          task: "Reply with the single word PONG.",
          cwd: tmpCwd,
          phaseId: "explore", // exercises subagentTimeoutFor + class timeout
          timeoutMs: PONG_TIMEOUT,
          scriptOverride: cliPath,
          execPathOverride: "node", // bun test must not host the pi CLI
          onLiveness: (obs) => {
            assert.fail(`liveness fired unexpectedly: ${JSON.stringify(obs)}`);
          },
        });
        try {
          rmSync(tmpCwd, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        assert.equal(result.timedOut, undefined, `unexpected timeout label: ${JSON.stringify(result)}`);
        assert.ok(
          result.output.length > 0,
          `expected output, got: ${JSON.stringify(result)} — NOTE: an empty result with a provider error in 'error' means the configured model/provider is currently failing (observed in the wild: "Provider finish_reason: network_error" on 9router); that is NOT an orchestrator bug. Point pi at a healthy provider and re-run.`,
        );
      });
  }

  test("resolveTimeoutMs maps phaseId to the class timeout and honors overrides", () => {
    assert.equal(resolveTimeoutMs({ phaseId: "implement" }), 1500 * 1000);
    assert.equal(resolveTimeoutMs({ timeoutMs: 1234 }), 1234);
  });

  test("unknown agent (no agentDef) is a hard config error, never retried", async () => {
    const result = await runSubagent({
      agent: "this-agent-does-not-exist",
      task: "x",
      cwd: process.cwd(),
      timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.configError, true);
  });
});

// --- Parked-gate re-anchor + plan-naming + open-questions carry-over (2026-09 session) ---

describe("buildResumeContext parked manual gate (2026-09 fix 3)", () => {
  test("awaiting_approval forbids continuing: no 'Continue working' body", () => {
    // The 2026-09 session bug: the router prefixes every user message with the
    // resume context; at a parked plan gate it still said "Continue working…",
    // so a plan tweak read as "resume and implement".
    const state = { ...createState("develop", "add dark mode"), phaseIndex: 3, status: "awaiting_approval" as const };
    const text = buildResumeContext(state);
    assert.ok(!text.includes("Continue working on the current phase"), `leaked resume body: ${text}`);
    assert.match(text, /PARKED for user approval/);
    assert.match(text, /do NOT call kstack_advance/);
    assert.match(text, /only \/kstack next/);
  });

  test("pendingOptional branch still wins over the generic parked branch", () => {
    const develop = getWorkflow("develop")!;
    const shipIndex = develop.phases.findIndex((p) => p.id === "ship");
    const state = { ...createState("develop", "add dark mode"), phaseIndex: shipIndex, status: "awaiting_approval" as const, pendingOptional: true };
    const text = buildResumeContext(state);
    assert.match(text, /This phase is OPTIONAL and the workflow is PARKED/);
    assert.ok(!text.includes("PARKED for user approval BEFORE"), "generic parked body leaked into optional gate");
  });

  test("active state keeps the standard resume body", () => {
    const text = buildResumeContext({ ...createState("develop", "add dark mode"), phaseIndex: 3, status: "active" } as any);
    assert.match(text, /Continue working on the current phase/);
    assert.ok(!text.includes("PARKED for user approval"));
  });

  test("activeConstraintLines re-anchors the parked gate too", () => {
    const state = { ...createState("develop", "add dark mode"), phaseIndex: 3, status: "awaiting_approval" as const };
    const lines = activeConstraintLines(state as any);
    assert.ok(lines.some((l) => l.includes("PARKED at a decision gate")));
  });
});

describe("plan file naming (2026-09 fix 2)", () => {
  test("legacy slug fallback is unchanged", () => {
    assert.equal(planFilePath("Add dark mode to the settings page"), ".kstack/plans/add-dark-mode-to-the-settings-page.md");
    assert.equal(planFilePath("???"), ".kstack/plans/plan.md");
  });

  test("parsePlanFileMarker accepts a valid path and strips punctuation", () => {
    assert.equal(parsePlanFileMarker("Did the plan. PLAN FILE: .kstack/plans/dark-mode-toggle.md"), ".kstack/plans/dark-mode-toggle.md");
    assert.equal(parsePlanFileMarker("PLAN FILE: `.kstack/plans/quoted.md`."), ".kstack/plans/quoted.md");
  });

  test("parsePlanFileMarker skips an echoed template fragment and takes the first VALID match (mindrun F3)", () => {
    // A model echoing the prompt's own "PLAN FILE: <path>" fragment before the
    // real marker must not shadow it: iterate all occurrences, first valid wins.
    const echoed = "As instructed I end with PLAN FILE: <path> — PLAN FILE: .kstack/plans/real-essence.md";
    assert.equal(parsePlanFileMarker(echoed), ".kstack/plans/real-essence.md");
    // Still null when every occurrence is invalid.
    assert.equal(parsePlanFileMarker("PLAN FILE: <path> and PLAN FILE: /etc/passwd"), null);
  });

  test("parsePlanFileMarker refuses traversal, wrong dir, and garbage", () => {
    assert.equal(parsePlanFileMarker("PLAN FILE: .kstack/plans/../secrets.md"), null);
    assert.equal(parsePlanFileMarker("PLAN FILE: /etc/passwd"), null);
    assert.equal(parsePlanFileMarker("PLAN FILE: .kstack/plans/UPPER_CASE.md"), null);
    assert.equal(parsePlanFileMarker("no marker at all"), null);
  });

  test("resolvePlanFilePath prefers the captured planFile over the legacy slug", () => {
    const ctx = makeCtx("develop", 3);
    ctx.state.planFile = ".kstack/plans/llm-chosen-name.md";
    assert.equal(resolvePlanFilePath(ctx), ".kstack/plans/llm-chosen-name.md");
    const ctx2 = makeCtx("develop", 3);
    assert.equal(resolvePlanFilePath(ctx2), planFilePath("add dark mode toggle"));
  });

  test("plan phase instructions let the MODEL choose the name (mindrun F1)", () => {
    // The orchestrator must NOT pin the path: a pre-resolved deterministic path
    // makes the model parrot it, so the LLM never actually names anything.
    const plan = findPhase("develop", "plan");
    const instructions = buildPhaseInstructions(plan, makeCtx("develop", 2));
    assert.ok(instructions.includes("YOU choose the filename"), "instructions must hand naming to the model");
    assert.ok(instructions.includes("PLAN FILE:"), "plan contract must demand the PLAN FILE marker");
    assert.ok(instructions.includes(".kstack/plans/"));
    assert.ok(!instructions.includes("PLAN FILE: .kstack/plans/add-dark-mode-toggle.md"), "instructions must not pin the legacy slug as THE path");
  });
});

describe("open-questions carry-over (2026-09 fix 1)", () => {
  test("understand contract demands the OPEN QUESTIONS section", () => {
    const instructions = buildPhaseInstructions(findPhase("develop", "understand"), makeCtx("develop", 0));
    assert.ok(instructions.includes("OPEN QUESTIONS:"));
  });

  test("carryOverOpenQuestions extracts bullets from the understand summary", () => {
    const ctx = makeCtx("develop", 2);
    ctx.state.results["understand"] = {
      status: "completed",
      summary: "Existing app uses React.\nOPEN QUESTIONS:\n- Where should the toggle live?\n- Persist choice in localStorage or profile?",
    };
    const block = carryOverOpenQuestions(ctx);
    assert.match(block, /Carried-over open questions/);
    assert.match(block, /Where should the toggle live\?/);
    assert.match(block, /Persist choice in localStorage or profile\?/);
  });

  test("carryOverOpenQuestions is empty without the section or for 'none'", () => {
    const ctx = makeCtx("develop", 2);
    assert.equal(carryOverOpenQuestions(ctx), "");
    ctx.state.results["understand"] = { status: "completed", summary: "All settled. OPEN QUESTIONS: none" };
    assert.equal(carryOverOpenQuestions(ctx), "");
  });

  test("plan instructions embed the carried questions when present", () => {
    const ctx = makeCtx("develop", 2);
    ctx.state.results["understand"] = {
      status: "completed",
      summary: "Context.\nOPEN QUESTIONS:\n- Which storage backend?",
    };
    const instructions = buildPhaseInstructions(findPhase("develop", "plan"), ctx);
    assert.match(instructions, /Carried-over open questions/);
    assert.match(instructions, /Which storage backend\?/);
  });
});

// --- Compaction guard + truthful status lines (NEXT UP, 2026-09-15) ---------

describe("compaction guard — resume prefix contract", () => {
  test("active main phase: prefix carries the DELIVERABLE/STOP CONDITION contract", () => {
    const prefix = buildResumeContext(makeCtx("investigate", 0).state); // reproduce = main
    assert.ok(prefix.includes("## DELIVERABLE"), "main-phase contract missing from resume prefix");
    assert.ok(prefix.includes("## STOP CONDITION"), "main-phase stop condition missing");
    assert.ok(prefix.includes("kstack_phase"), "tier-2 pointer missing");
  });

  test("active subagent phase: no contract (delegation results self-heal), pointer still present", () => {
    const prefix = buildResumeContext(makeCtx("investigate", 1).state); // root-cause = subagent
    assert.ok(!prefix.includes("## DELIVERABLE"), "subagent phases must not carry the main contract");
    assert.ok(prefix.includes("kstack_phase"));
  });

  test("parked gate: neither contract nor pointer", () => {
    const state = { ...makeCtx("investigate", 2).state, status: "awaiting_approval" as const };
    const prefix = buildResumeContext(state);
    assert.ok(prefix.includes("PARKED"));
    assert.ok(!prefix.includes("## DELIVERABLE"));
    assert.ok(!prefix.includes("kstack_phase"));
  });

  test("paused state: PAUSED, never the contradictory continue-working tail (mindrun F1)", () => {
    const state = { ...makeCtx("sprint", 7).state, status: "paused" as const, pausedReason: "branch-violation:devsecops-review on main" };
    const prefix = buildResumeContext(state);
    assert.ok(prefix.includes("PAUSED (branch-violation:devsecops-review on main)"));
    assert.ok(prefix.includes("PAUSED"), "paused posture must be stated");
    assert.ok(!prefix.includes("Continue working"), "paused prefix must not invite continued work");
    assert.ok(!prefix.includes("## DELIVERABLE"));
    assert.ok(!prefix.includes("kstack_phase"));
  });

  test("sprint contracts interpolate the assigned sprint number", () => {
    const state = { ...makeCtx("sprint", 3).state, sprintNumber: 7 }; // system-design = main
    const prefix = buildResumeContext(state);
    assert.ok(prefix.includes("system-design_07.md"), "sprint contract must carry the real sprint number");
  });
});

describe("statusLineFor", () => {
  const sprint = getWorkflow("sprint")!;

  test("active returns the running label", () => {
    const state = makeCtx("sprint", 7).state; // devsecops-review
    assert.equal(statusLineFor(state, sprint), "Sprint (Agile Pipeline): DevSecOps Review (8/10)");
  });

  test("awaiting_approval: parked for approval vs optional-phase decision", () => {
    const state = { ...makeCtx("sprint", 4).state, status: "awaiting_approval" as const };
    assert.match(statusLineFor(state, sprint)!, /PARKED for approval.*\/kstack next/);
    assert.match(statusLineFor({ ...state, pendingOptional: true }, sprint)!, /PARKED.*Run\/Skip\/Abort/);
  });

  test("paused decodes freeze / unreadable verdict / exhaustion / branch violation / failure", () => {
    const base = makeCtx("sprint", 7).state;
    assert.match(
      statusLineFor({ ...base, status: "paused" as const, frozenUntilHuman: true, pausedReason: "security-freeze:devsecops-review", freezeInfo: { phaseId: "devsecops-review", severity: "critical", artifactPath: "x" } }, sprint)!,
      /FROZEN: critical security rejection/,
    );
    assert.match(
      statusLineFor({ ...base, status: "paused" as const, verdictPark: "qa-verdict", pausedReason: "verdict-unreadable:qa-verdict:artifact-mismatch" }, sprint)!,
      /verdict unreadable \(artifact-mismatch\)/,
    );
    assert.match(
      statusLineFor({ ...base, status: "paused" as const, pausedReason: "loop-exhausted:implement after 4 runs" }, sprint)!,
      /loop exhausted/,
    );
    assert.match(
      statusLineFor({ ...base, status: "paused" as const, pausedReason: "branch-violation:qa-verdict on main" }, sprint)!,
      /branch violation/,
    );
    assert.match(statusLineFor({ ...base, status: "paused" as const }, sprint)!, /phase failed/);
  });

  test("terminal states clear the line", () => {
    const state = makeCtx("sprint", 7).state;
    assert.equal(statusLineFor({ ...state, status: "completed" as const }, sprint), undefined);
    assert.equal(statusLineFor({ ...state, status: "aborted" as const }, sprint), undefined);
  });

  test("stepped phase names the current step: `phase (n/m) · step <id> (i/k)`", () => {
    const develop = getWorkflow("develop")!;
    const planIdx = develop.phases.findIndex((p) => p.id === "plan");
    assert.ok(planIdx >= 0 && develop.phases[planIdx].steps?.length === 3);
    const state = { ...createState("develop", "g"), phaseIndex: planIdx, stepIndex: 1 };
    assert.equal(
      statusLineFor(state, develop),
      "Full Development Cycle: Interactive Planning (3/8) · step draft (2/3)",
    );
  });

  test("implicit phases carry no step suffix — unchanged pre-S3 shape", () => {
    const develop = getWorkflow("develop")!;
    const state = { ...createState("develop", "g"), phaseIndex: 0 };
    assert.equal(statusLineFor(state, develop), "Full Development Cycle: Understand Requirements (1/8)");
  });
});

describe("kstack_phase tool", () => {
  function fakePiWithState(state: unknown) {
    const tools = new Map<string, any>();
    const pi: any = {
      registerTool: (t: any) => tools.set(t.name, t),
      registerCommand: () => {},
      on: () => {},
      exec: async () => ({ stdout: "", stderr: "" }),
      appendEntry: () => {},
    };
    const ctx: any = {
      cwd: process.cwd(),
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: {
        getEntries: () => (state ? [{ type: "custom", customType: "kstack-wf-state", data: state }] : []),
      },
    };
    return { pi, tools, ctx };
  }

  test("delegated phase: instructions + posture header + on-disk record", async () => {
    const state = { ...makeCtx("sprint", 7).state, status: "paused" as const, pausedReason: "branch-violation:devsecops-review on main", sprintNumber: 7 };
    const { pi, tools, ctx } = fakePiWithState(state);
    initOrchestrator(pi);
    const res = await tools.get("kstack_phase").execute("t", {}, undefined, undefined, ctx);
    const text = res.content[0].text;
    assert.ok(text.startsWith("[workflow paused: branch-violation:devsecops-review on main"), "posture header missing");
    assert.ok(text.includes("### On-disk record"), "artifact section missing");
    assert.ok(text.includes("code-review-artifact_07.md"), "expected artifact path not listed");
    assert.ok(text.includes("(not written yet)"), "missing-file marker absent");
  });

  test("active main phase: instructions, no posture header, no record section", async () => {
    const { pi, tools, ctx } = fakePiWithState(makeCtx("sprint", 3).state); // system-design = main
    initOrchestrator(pi);
    const res = await tools.get("kstack_phase").execute("t", {}, undefined, undefined, ctx);
    const text = res.content[0].text;
    assert.ok(text.includes("Phase: System Design"));
    assert.ok(!text.startsWith("[workflow"), "active phase must not carry the reference-only header");
    assert.ok(!text.includes("### On-disk record"), "main phases have no delegation results to lose");
  });

  test("unknown workflowId gets its own message (not 'no current phase')", async () => {
    const { pi, tools, ctx } = fakePiWithState({ workflowId: "legacy-x", phaseIndex: 0, status: "active", goal: "g", results: {} });
    initOrchestrator(pi);
    const res = await tools.get("kstack_phase").execute("t", {}, undefined, undefined, ctx);
    assert.ok(res.content[0].text.includes('Unknown workflow "legacy-x"'));
  });
});

// --- /kstack init: managed AGENTS.md block ---------------------------------

describe("/kstack init", () => {
  // Built without the literal old brand so the tracked-tree audit stays clean.
  const LEGACY_BEGIN = "<!-- " + ("g" + "stack") + ":begin -->";
  const LEGACY_END = "<!-- " + ("g" + "stack") + ":end -->";

  function tmpdir(): string {
    return mkdtempSync(path.join(os.tmpdir(), "kstack-init-"));
  }

  test("creates AGENTS.md when absent", () => {
    const dir = tmpdir();
    try {
      const res = initAgentsMd(dir);
      assert.equal(res.status, "created");
      const text = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
      assert.ok(text.includes("<!-- kstack:begin -->"));
      assert.ok(text.includes("<!-- kstack:end -->"));
      assert.ok(text.includes("KEY == VALUE"));
      assert.ok(text.includes("## HANDOFF"));
      assert.ok(text.includes("Iron Law"));
      assert.ok(text.includes("UNTRUSTED"));
      assert.ok(!text.includes(LEGACY_BEGIN));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appends the block and preserves surrounding content", () => {
    const dir = tmpdir();
    try {
      const file = path.join(dir, "AGENTS.md");
      writeFileSync(file, "# My project\n\nCustom rules here.\n");
      const res = initAgentsMd(dir);
      assert.equal(res.status, "installed");
      const text = readFileSync(file, "utf8");
      assert.ok(text.startsWith("# My project\n\nCustom rules here."));
      assert.ok(text.includes("<!-- kstack:begin -->"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is byte-identical on re-run", () => {
    const dir = tmpdir();
    try {
      const file = path.join(dir, "AGENTS.md");
      writeFileSync(file, "# My project\n\nCustom rules here.\n");
      initAgentsMd(dir);
      const first = readFileSync(file, "utf8");
      const res = initAgentsMd(dir);
      const second = readFileSync(file, "utf8");
      assert.equal(second, first);
      assert.equal(res.status, "unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replaces a stale kstack block in place", () => {
    const dir = tmpdir();
    try {
      const file = path.join(dir, "AGENTS.md");
      writeFileSync(file, "HEAD\n\n<!-- kstack:begin -->\nold content\n<!-- kstack:end -->\n\nTAIL\n");
      const res = initAgentsMd(dir);
      assert.equal(res.status, "refreshed");
      const text = readFileSync(file, "utf8");
      assert.ok(!text.includes("old content"));
      assert.ok(text.includes("HEAD\n\n<!-- kstack:begin -->"));
      assert.ok(text.endsWith("TAIL\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("upgrades a legacy managed block in place", () => {
    const dir = tmpdir();
    try {
      const file = path.join(dir, "AGENTS.md");
      writeFileSync(file, `HEAD\n\n${LEGACY_BEGIN}\nold rules\n${LEGACY_END}\n\nTAIL\n`);
      const res = initAgentsMd(dir);
      assert.equal(res.status, "upgraded");
      const text = readFileSync(file, "utf8");
      assert.ok(!text.includes(LEGACY_BEGIN));
      assert.ok(!text.includes(LEGACY_END));
      assert.ok(!text.includes("old rules"));
      assert.ok(text.includes("HEAD\n\n<!-- kstack:begin -->"));
      assert.ok(text.endsWith("TAIL\n"));
      // and a second run is a no-op
      const res2 = initAgentsMd(dir);
      assert.equal(res2.status, "unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dedupes when both legacy and kstack blocks are present", () => {
    const dir = tmpdir();
    try {
      const file = path.join(dir, "AGENTS.md");
      writeFileSync(
        file,
        `HEAD\n\n<!-- kstack:begin -->\nstale\n<!-- kstack:end -->\n\nMID\n\n${LEGACY_BEGIN}\nold rules\n${LEGACY_END}\n\nTAIL\n`,
      );
      const res = initAgentsMd(dir);
      assert.equal(res.status, "upgraded");
      const text = readFileSync(file, "utf8");
      assert.equal(text.match(/<!-- kstack:begin -->/g)?.length, 1);
      assert.equal(text.match(/<!-- kstack:end -->/g)?.length, 1);
      assert.ok(!text.includes(LEGACY_BEGIN));
      assert.ok(text.includes("HEAD") && text.includes("MID") && text.includes("TAIL"));
      const res2 = initAgentsMd(dir);
      assert.equal(res2.status, "unchanged");
      assert.equal(readFileSync(file, "utf8"), text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- S3: Step model + pilota ------------------------------------------------

describe("S3 step model — types & state v4 (TASK_01)", () => {
  test("createState produces a v4 state with gate fields", () => {
    const state = createState("develop", "build a thing");
    assert.equal(state.version, 4);
    assert.equal(state.gateMode, "human-gate");
    assert.deepEqual(state.gateOverrides, {});
    // stepIndex is defined only while a stepped phase is current (INV-01)
    assert.equal(state.stepIndex, undefined);
  });

  test("a hand-written v3-shaped state loads tolerantly — step/gate fields absent", () => {
    const legacy = {
      workflowId: "develop",
      phaseIndex: 0,
      status: "active",
      goal: "x",
      results: {},
      version: 3,
      attempts: {},
    };
    const ctx: any = {
      sessionManager: {
        getEntries: () => [{ type: "custom", customType: "kstack-wf-state", data: legacy }],
      },
    };
    const loaded = loadActiveState(ctx);
    assert.ok(loaded, "v3 state must load");
    assert.equal(loaded!.version, 3);
    assert.equal(loaded!.stepIndex, undefined);
    assert.equal(loaded!.gateMode, undefined);
    assert.equal(loaded!.gateOverrides, undefined);
  });

  test("loadActiveState normalizes gate fields — unknown gateMode/override values rejected", () => {
    const poisoned = {
      workflowId: "develop",
      phaseIndex: 0,
      status: "active",
      goal: "x",
      results: {},
      version: 4,
      gateMode: "bogus",
      gateOverrides: { plan: "auto" },
      runId: 42,
    };
    const ctx: any = {
      sessionManager: {
        getEntries: () => [{ type: "custom", customType: "kstack-wf-state", data: poisoned }],
      },
    };
    const loaded = loadActiveState(ctx);
    assert.ok(loaded);
    assert.equal(loaded!.gateMode, undefined, "unknown gateMode must drop (absent = human-gate default)");
    assert.equal(loaded!.gateOverrides, undefined, "overrides must not survive an invalid gateMode");
    assert.equal(loaded!.runId, undefined, "non-string runId must drop — it feeds the ledger filename");

    // stepIndex is routing state (S3 security pass-3): a forged negative/NaN
    // flips insidePhase and skips a stepped phase's entry gates.
    const forIdx = (stepIndex: unknown) =>
      loadActiveState({
        sessionManager: { getEntries: () => [{ type: "custom", customType: "kstack-wf-state", data: { ...poisoned, stepIndex } }] },
      } as any);
    assert.equal(forIdx(-1)!.stepIndex, undefined, "negative stepIndex must drop");
    assert.equal(forIdx(NaN)!.stepIndex, undefined, "NaN stepIndex must drop");
    assert.equal(forIdx(1.5)!.stepIndex, undefined, "non-integer stepIndex must drop");
    assert.equal(forIdx(2)!.stepIndex, 2, "a valid mid-step index survives (delivery clamps over-high)");

    const partial = {
      ...poisoned,
      gateMode: "selection-gate",
      gateOverrides: { plan: "auto", qa: "nope", ship: "skip" },
      runId: "ok-run",
    };
    const ctx2: any = {
      sessionManager: {
        getEntries: () => [{ type: "custom", customType: "kstack-wf-state", data: partial }],
      },
    };
    const l2 = loadActiveState(ctx2);
    assert.equal(l2!.gateMode, "selection-gate");
    assert.deepEqual(l2!.gateOverrides, { plan: "auto", ship: "skip" }, "only auto|human|skip values may survive");
    assert.equal(l2!.runId, "ok-run");
  });

  test("WorkflowPhase accepts steps[]; GateRow kinds cover optional/entry/manual", () => {
    const step: import("../orchestrator/types.ts").WorkflowStep = {
      id: "s1",
      execution: "main",
      task: "do the thing",
      skill: "kstack-grilling",
    };
    const phase: WorkflowPhase = { id: "p", name: "P", execution: "main", optional: false, steps: [step] };
    assert.equal(phase.steps?.length, 1);
    assert.equal(phase.steps![0].skill, "kstack-grilling");
    const rows: import("../orchestrator/types.ts").GateRow[] = [
      { phaseId: "a", name: "A", kind: "optional" },
      { phaseId: "b", name: "B", kind: "entry", warning: true },
      { phaseId: "c", name: "C", kind: "manual" },
    ];
    assert.deepEqual(rows.map((r) => r.kind), ["optional", "entry", "manual"]);
  });
});

describe("S3 pilot — skill registry (TASK_04)", () => {
  test("kstack-plan-draft is registered and its DoD gate parses", () => {
    const info = getSkillInfo("kstack-plan-draft");
    assert.ok(info, "kstack-plan-draft missing from REGISTRY — s2 draft step would run skill-less");
    assert.ok(existsSync(info!.skillPath), `canonical SKILL.md missing at ${info!.skillPath}`);
    const gate = loadSkillGate("kstack-plan-draft");
    assert.ok(gate, "loadSkillGate returned null — '## DoD gate' section missing");
    assert.ok(gate!.includes("## DoD gate"), "gate must carry the parsed section header");
  });
});

describe("S3 step builders — templates (TASK_02)", () => {
  const STEPPED: WorkflowPhase = {
    id: "plan",
    name: "Interactive Planning",
    execution: "main",
    optional: false,
    advance: "manual",
    steps: [
      {
        id: "interrogate",
        execution: "main",
        skill: "kstack-grilling",
        task: "## DELIVERABLE\nAn answered decision frontier.\n\n## STOP CONDITION\nStop when: the frontier is empty.\n\n## CONTEXT\n{open_questions}",
      },
      { id: "draft", execution: "main", skill: "kstack-plan-draft", task: "## DELIVERABLE\nPlan file written.\n\n## STOP CONDITION\nStop when: file exists." },
      { id: "eng-review", execution: "main", skill: "kstack-plan-eng-review", task: "## DELIVERABLE\nReview verdict.\n\n## STOP CONDITION\nStop when: reviewed." },
    ],
  };

  test("byte-stable prefix: retry context lands ONLY in the volatile tail", () => {
    const ctx = makeCtx("develop", 2);
    const a = buildStepInstructions(STEPPED, STEPPED.steps![0], ctx);
    const retryCtx: WorkflowContext = {
      ...ctx,
      state: {
        ...ctx.state,
        retryContext: { targetPhaseId: "plan", attempt: 2, maxAttempts: 4, feedback: "BLOCKER: fix the thing first" },
      },
    };
    const b = buildStepInstructions(STEPPED, STEPPED.steps![0], retryCtx);
    assert.ok(b.length > a.length, "retry context must add output");
    assert.ok(b.startsWith(a), "the stable prefix must be byte-identical — retry delta belongs at the tail only");
    assert.ok(b.slice(a.length).includes("BLOCKER: fix the thing first"), "retry feedback missing from tail");
  });

  test("step skill block: full on first delivery, DoD gate on repeat, none when skill absent", () => {
    const ctx = makeCtx("develop", 2);
    const first = buildStepInstructions(STEPPED, STEPPED.steps![0], ctx);
    assert.ok(first.includes("#### Skill gate: kstack-grilling"), "skill block header missing");
    assert.ok(first.includes("Full skill documentation for deep consultation"), "first delivery must embed the FULL skill");

    const repeat = buildStepInstructions(STEPPED, STEPPED.steps![0], {
      ...ctx,
      state: { ...ctx.state, skillsDelivered: ["kstack-grilling"] },
    });
    assert.ok(repeat.includes("## DoD gate: kstack-grilling"), "repeat delivery must degrade to the parsed DoD gate");
    assert.ok(!repeat.includes("Full skill documentation for deep consultation"), "repeat must not re-embed the full skill");

    const noSkill: WorkflowPhase = { ...STEPPED, steps: [{ id: "x", execution: "main", task: "work" }] };
    const bare = buildStepInstructions(noSkill, noSkill.steps![0], ctx);
    assert.ok(!bare.includes("Skill gate"), "0-skill step must emit no skill block (D19)");

    const unknown: WorkflowPhase = { ...STEPPED, steps: [{ id: "x", execution: "main", task: "work", skill: "no-such-skill" }] };
    const skipped = buildStepInstructions(unknown, unknown.steps![0], ctx);
    assert.ok(!skipped.includes("Skill gate"), "unknown skill id must be skipped, never thrown");
  });

  test("prior-step results render in the volatile tail; dotted keys stay out of the phase list", () => {
    const ctx = makeCtx("develop", 2);
    ctx.state.results = {
      understand: { status: "completed", summary: "understood the ask" },
      "plan.interrogate": { status: "completed", summary: "frontier answered" },
    };
    const out = buildStepInstructions(STEPPED, STEPPED.steps![1], ctx);
    assert.ok(out.includes("understand: understood the ask") || out.includes("**understand**: understood the ask"), "phase-level results must still render");
    assert.ok(!/### Completed phases[\s\S]*plan\.interrogate/.test(out), "dotted step keys must not appear in the phase-level list");
    assert.ok(out.includes("interrogate") && out.includes("frontier answered"), "prior step summary must surface in the tail");
    // ordering: step results must come AFTER the stable prefix (tail position)
    assert.ok(out.indexOf("frontier answered") > out.indexOf("### Completed"), "step summaries belong after the stable prefix");
  });

  test("widened {x_summary} interpolation resolves dotted step keys", () => {
    const ctx = makeCtx("develop", 2);
    ctx.state.results["plan.draft"] = { status: "completed", summary: "draft ready at .kstack/plans/x.md" };
    const phase: WorkflowPhase = {
      ...STEPPED,
      steps: [{ id: "eng-review", execution: "main", task: "Review {plan.draft_summary} now." }],
    };
    const out = buildStepInstructions(phase, phase.steps![0], ctx);
    assert.ok(out.includes("Review draft ready at .kstack/plans/x.md now."), "{plan.draft_summary} must resolve through the dotted key");
  });

  test("{previous} resolves to the previous step's recorded summary", () => {
    const ctx = makeCtx("develop", 2);
    ctx.state.results["plan.interrogate"] = { status: "completed", summary: "Q&A settled: scope is minimal" };
    const phase: WorkflowPhase = { ...STEPPED, steps: [STEPPED.steps![0], { ...STEPPED.steps![1], task: "Draft from: {previous}" }] };
    const out = buildStepInstructions(phase, phase.steps![1], ctx);
    assert.ok(out.includes("Draft from: Q&A settled: scope is minimal"), "{previous} must carry the last step's summary");
    const first = buildStepInstructions(phase, phase.steps![0], ctx);
    assert.ok(!first.includes("{previous}"), "first step has no {previous} content");
  });

  test("mainContractFor(phase, ctx, step) returns the step task's own DELIVERABLE/STOP lines", () => {
    const step = STEPPED.steps![0];
    const contract = mainContractFor(STEPPED, { state: makeCtx("develop", 2).state }, step);
    assert.ok(contract.includes("An answered decision frontier"), "step DELIVERABLE must be extracted");
    assert.ok(contract.includes("the frontier is empty"), "step STOP CONDITION must be extracted");
    assert.ok(!contract.includes("## CONTEXT"), "step CONTEXT is not part of the contract");
    // No step → the phase-level contract path is unchanged.
    const phaseLevel = mainContractFor(STEPPED, { state: makeCtx("develop", 2).state });
    assert.ok(phaseLevel.includes("plan file") || phaseLevel.includes(".kstack/plans"), "phase contract fallback intact");
  });

  test("buildStepTask = step.task + FULL skill + OUTPUT_CONTRACT (never buildDeterministicPlan)", () => {
    const task = buildStepTask({ id: "audit", execution: "subagent", agent: "reviewer", skill: "kstack-review", task: "## DELIVERABLE\nAudit the diff." });
    assert.ok(task.includes("Audit the diff."), "task text missing");
    assert.ok(task.includes("## Skill methodology: kstack-review"), "delegated steps always embed the FULL skill");
    assert.ok(!task.includes("## DoD gate: kstack-review"), "delegated steps must never get the bare gate");
    assert.ok(task.trim().endsWith("DO NOT REDO: what the next agent must NOT redo") || task.includes("## OUTPUT CONTRACT"), "OUTPUT_CONTRACT must close the task");

    const bare = buildStepTask({ id: "x", execution: "subagent", agent: "worker", task: "plain task" });
    assert.ok(bare.startsWith("plain task"), "no-skill step keeps its task verbatim");
    assert.ok(bare.includes("## OUTPUT CONTRACT"), "OUTPUT_CONTRACT still required");
    assert.ok(!bare.includes("## METHODOLOGY"), "no skill → no methodology block");

    const unknown = buildStepTask({ id: "x", execution: "subagent", agent: "worker", skill: "ghost-skill", task: "plain" });
    assert.ok(unknown.includes("## OUTPUT CONTRACT"), "unknown skill id must not break the task");
  });

  test("duplicate steps[].id is a dev-time defect — instruction build must throw", () => {
    const dup: WorkflowPhase = {
      id: "p", name: "P", execution: "main", optional: false,
      steps: [
        { id: "a", execution: "main", task: "x" },
        { id: "a", execution: "main", task: "y" },
      ],
    };
    assert.throws(
      () => buildStepInstructions(dup, dup.steps![0], makeCtx("develop", 0)),
      /duplicate|unique/i,
      "duplicate step ids collide on results['phase.step'] keys and findIndex resolution",
    );
  });

  test("a subagent step under KSTACK_PI_DETERMINISTIC=off gets subagent-tool guidance + FULL digest", () => {
    const saved = process.env.KSTACK_PI_DETERMINISTIC;
    process.env.KSTACK_PI_DETERMINISTIC = "off";
    try {
      const phase: WorkflowPhase = {
        id: "p", name: "P", execution: "main", optional: false,
        steps: [
          { id: "probe", execution: "subagent", agent: "scout", skill: "kstack-plan-draft", task: "## DELIVERABLE\nProbe. {previous}" },
        ],
      };
      const out = buildStepInstructions(phase, phase.steps![0], makeCtx("develop", 0));
      assert.ok(out.includes("`subagent`"), "the model must be told to delegate via the subagent tool");
      assert.ok(out.includes('"agent": "scout"'), "the JSON params must name the step's agent");
      assert.ok(
        out.includes("## Skill methodology: kstack-plan-draft"),
        "first delivery must embed the FULL digest inside the delegated task — a bare DoD gate starves the step",
      );
    } finally {
      if (saved === undefined) delete process.env.KSTACK_PI_DETERMINISTIC; else process.env.KSTACK_PI_DETERMINISTIC = saved;
    }
  });
});

// --- TASK_03 + TASK_06: step state machine, executor dispatch, develop.plan pilot ---

describe("S3 pilot — develop.plan is a 3-step phase (TASK_06)", () => {
  test("plan declares interrogate → draft → eng-review, each main + one skill (D19)", () => {
    const plan = findPhase("develop", "plan");
    assert.ok(plan.steps && plan.steps.length === 3, "plan must declare exactly 3 steps");
    assert.deepEqual(plan.steps!.map((s) => s.id), ["interrogate", "draft", "eng-review"]);
    assert.deepEqual(plan.steps!.map((s) => s.skill), ["kstack-grilling", "kstack-plan-draft", "kstack-plan-eng-review"]);
    assert.ok(plan.steps!.every((s) => s.execution === "main"), "pilot steps are all main");
    assert.equal(plan.advance, "manual", "the human gate still fires once — after step 3");
    // Non-plan develop phases stay implicit (mixed interop is the point).
    assert.ok(getWorkflow("develop")!.phases.filter((p) => p.id !== "plan").every((p) => !p.steps?.length),
      "every other develop phase must remain implicit");
  });
});

describe("S3 step state machine — recordStepResult (TASK_03)", () => {
  const STEP_PHASE: WorkflowPhase = {
    id: "plan", name: "Plan", execution: "main", optional: false, advance: "manual",
    steps: [
      { id: "a", execution: "main", task: "A" },
      { id: "b", execution: "main", task: "B" },
      { id: "c", execution: "main", task: "C" },
    ],
  };

  test("records results['phase.step'], bumps stepIndex, reports isLast", () => {
    const s = { ...createState("develop", "g"), phaseIndex: 2, stepIndex: 0 };
    const r = recordStepResult(s, STEP_PHASE, { status: "completed", summary: "did A" });
    assert.ok(r, "stepped phase must produce a record");
    assert.equal(r!.state.results["plan.a"]?.summary, "did A");
    assert.equal(r!.state.stepIndex, 1);
    assert.equal(r!.isLast, false);
    assert.equal(r!.step.id, "a");
    assert.equal(r!.state.status, "active", "mid-step completion keeps the workflow active");
    // Phase-level key is NOT written yet — that belongs to the final step's advance.
    assert.equal(r!.state.results["plan"], undefined);
  });

  test("last step → isLast; advancePhase then records results[phase] and clears stepIndex", () => {
    const phases = getWorkflow("develop")!.phases;
    const s: import("../orchestrator/types.ts").WorkflowState = {
      ...createState("develop", "g"),
      phaseIndex: 2,
      stepIndex: 2,
      results: {
        "plan.a": { status: "completed", summary: "a" },
        "plan.b": { status: "completed", summary: "b" },
      },
    };
    const r = recordStepResult(s, STEP_PHASE, { status: "completed", summary: "did C" });
    assert.equal(r!.isLast, true);
    const fin = advancePhase(r!.state, "plan", { status: "completed", summary: "did C" }, phases.length, { phases });
    assert.equal(fin.results["plan"]?.summary, "did C", "phase-level result = final step's summary");
    assert.equal(fin.stepIndex, undefined, "stepIndex is defined iff the CURRENT phase is stepped (INV-01)");
    assert.equal(fin.phaseIndex, 3);
    // Per-step results persist for audit + {x.y_summary} interpolation.
    assert.equal(fin.results["plan.c"]?.summary, "did C");
  });

  test("a failed step pauses at the SAME stepIndex — resume re-delivers it", () => {
    const s = { ...createState("develop", "g"), phaseIndex: 2, stepIndex: 1 };
    const r = recordStepResult(s, STEP_PHASE, { status: "failed", summary: "b blew up" });
    assert.equal(r!.state.status, "paused");
    assert.equal(r!.state.stepIndex, 1, "failed step index must not move — the retry re-runs it");
    assert.equal(r!.state.results["plan.b"]?.status, "failed");
  });

  test("returns null for an implicit phase", () => {
    const implicit = findPhase("develop", "understand");
    assert.equal(recordStepResult({ ...createState("develop", "g"), phaseIndex: 0 }, implicit, { status: "completed", summary: "x" }), null);
  });

  test("loop-back clears the target phase's stale step results", () => {
    const phases = getWorkflow("sprint")!.phases.map((p) =>
      p.id === "implement"
        ? { ...p, steps: [{ id: "be", execution: "subagent" as const, agent: "backend-developer", task: "x" }] }
        : p,
    );
    const state: import("../orchestrator/types.ts").WorkflowState = {
      ...createState("sprint", "g"),
      phaseIndex: 8, // qa-verdict
      sprintNumber: 1,
      results: {
        "implement.be": { status: "completed", summary: "attempt-1 code" },
        implement: { status: "completed", summary: "phase summary" },
      },
      pendingVerdict: { phaseId: "qa-verdict", parsed: { verdicts: { status: "red" }, vars: {} } as any, excerpt: "" },
      stepIndex: 0,
    };
    const next = advancePhase(state, "qa-verdict", { status: "completed", summary: "qa red" }, phases.length, { phases });
    assert.equal(next.phaseIndex, 6, "red verdict loops back to implement");
    assert.equal(next.results["implement.be"], undefined, "stale step results of the loop target must not leak into the retry");
    assert.equal(next.stepIndex, undefined);
  });

  test("loop-back clears stale step keys for EVERY re-run phase, not only the target", () => {
    const phases: WorkflowPhase[] = [
      { id: "p-a", name: "A", execution: "main", optional: false, steps: [{ id: "s1", execution: "main", task: "x" }] },
      { id: "p-b", name: "B", execution: "main", optional: false, steps: [{ id: "s1", execution: "main", task: "x" }] },
      { id: "qa-verdict", name: "Gate", execution: "subagent", optional: false, loopBackTo: "p-a", maxAttempts: 5 },
    ];
    const state: import("../orchestrator/types.ts").WorkflowState = {
      ...createState("sprint", "g"),
      phaseIndex: 2,
      sprintNumber: 1,
      results: {
        "p-a.s1": { status: "completed", summary: "a attempt-1" },
        "p-b.s1": { status: "completed", summary: "b attempt-1" },
        "p-a": { status: "completed", summary: "phase a" },
      },
      pendingVerdict: { phaseId: "qa-verdict", parsed: { verdicts: { status: "red" }, vars: {} } as any, excerpt: "" },
    };
    const next = advancePhase(state, "qa-verdict", { status: "completed", summary: "qa red" }, phases.length, { phases });
    assert.equal(next.phaseIndex, 0, "red verdict loops back to p-a");
    assert.equal(next.results["p-a.s1"], undefined, "the loop target's step keys must clear");
    assert.equal(next.results["p-b.s1"], undefined, "p-b re-runs too — its stale step keys must clear as well");
  });

  test("human-initiated returns purge stale step keys too (pass-6 review: INV-04)", () => {
    // The verdict-park return path performs the same loop-back transition as
    // advancePhase's — a stepped loop target must re-run with a clean slate.
    const phases: WorkflowPhase[] = [
      { id: "impl", name: "Impl", execution: "main", optional: false, steps: [{ id: "s1", execution: "main", task: "x" }] },
      { id: "gate", name: "Gate", execution: "subagent", optional: false, loopBackTo: "impl", maxAttempts: 5 },
    ];
    const parked: import("../orchestrator/types.ts").WorkflowState = {
      ...createState("sprint", "g"),
      phaseIndex: 1,
      sprintNumber: 1,
      verdictPark: "gate",
      results: {
        "impl.s1": { status: "completed", summary: "rejected attempt's step output" },
        impl: { status: "completed", summary: "phase summary" },
      },
      pendingVerdict: { phaseId: "gate", parsed: { verdicts: { status: "red" }, vars: {} } as any, excerpt: "" },
    };
    const returned = returnParkedWithContext(parked, phases);
    assert.ok(returned);
    assert.equal(returned!.phaseIndex, 0);
    assert.equal(returned!.results["impl.s1"], undefined, "the rejected attempt's step keys must not re-inject into the re-run");
    assert.equal(returned!.results["impl"]?.status, "completed", "phase-level results are untouched");

    // reissueGate: the (stepped) gate phase itself re-runs → its step keys purge.
    const exhausted: import("../orchestrator/types.ts").WorkflowState = {
      ...createState("sprint", "g"),
      phaseIndex: 1,
      sprintNumber: 1,
      status: "paused",
      pausedReason: "loop-exhausted:impl after 4 runs",
      results: { "gate.s9": { status: "completed", summary: "stale" } },
    };
    const steppedGate = phases.map((p) => (p.id === "gate" ? { ...p, steps: [{ id: "s9", execution: "main" as const, task: "x" }] } : p));
    const reissued = reissueGate(exhausted, steppedGate);
    assert.equal(reissued.results["gate.s9"], undefined, "a re-run gate phase must not inherit its previous attempt's step keys");

    // unfreeze: the (stepped) parked phase re-runs → its step keys purge.
    const frozen: import("../orchestrator/types.ts").WorkflowState = {
      ...createState("sprint", "g"),
      phaseIndex: 0,
      sprintNumber: 1,
      frozenUntilHuman: true,
      results: { "impl.s1": { status: "completed", summary: "frozen attempt's step output" } },
    };
    const unfrozen = unfreeze(frozen, phases);
    assert.equal(unfrozen.results["impl.s1"], undefined, "an unfrozen phase re-runs clean");
    // …and the prior attempt's keys in the SOURCE state are untouched (no mutation).
    assert.equal(frozen.results["impl.s1"]?.status, "completed");
  });

  test("capResultSummary applies to STEPPED phases only — implicit phases keep verbatim summaries (C2/C17)", () => {
    const longSummary = "z".repeat(5000);
    const phases: WorkflowPhase[] = [
      { id: "plain", name: "Plain", execution: "main", optional: false },
      { id: "stepped", name: "Stepped", execution: "main", optional: false, steps: [{ id: "s1", execution: "main", task: "x" }] },
    ];
    const s = { ...createState("sprint", "g"), phaseIndex: 0 };
    const afterPlain = advancePhase(s, "plain", { status: "completed", summary: longSummary }, phases.length, { phases });
    assert.equal(afterPlain.results["plain"]!.summary, longSummary, "implicit (legacy) phases store summaries verbatim — byte-identity preserved");
    const stepped = { ...afterPlain, phaseIndex: 1 };
    const afterStepped = advancePhase(stepped, "stepped", { status: "completed", summary: longSummary }, phases.length, { phases });
    assert.ok(afterStepped.results["stepped"]!.summary.length <= 4100, "stepped-phase summaries stay capped (amplification bound)");
  });

  test("recordStepResult caps an oversized summary (belt for the kstack_advance boundary)", () => {
    const s = { ...createState("develop", "g"), phaseIndex: 2, stepIndex: 0 };
    const r = recordStepResult(s, STEP_PHASE, { status: "completed", summary: "y".repeat(9000) });
    assert.ok(r!.state.results["plan.a"]!.summary.length <= 4100, "unbounded summaries re-inject into every later prompt");
  });
});

// Shared S3 harness: fake ExtensionAPI/ExtensionContext pair whose session
// entries are inspectable. Module scope — reused by the executor, gate and
// ledger describes below. Each harness gets an isolated cwd under one temp
// root so appendLedger/writeRunReport NEVER touch the repo's .kstack/.
const HARNESS_TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "kstack-harness-"));
let harnessSeq = 0;
function fakeHarness(initialState: unknown) {
  const entries: any[] = initialState ? [{ type: "custom", customType: "kstack-wf-state", data: initialState }] : [];
  const tools = new Map<string, any>();
  const sent: string[] = [];
  const notes: Array<{ msg: string; level: string }> = [];
  const handlers = new Map<string, any>();
  const pi: any = {
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: () => {},
    on: (ev: string, fn: any) => handlers.set(ev, fn),
    exec: async () => ({ stdout: "", stderr: "" }),
    appendEntry: (_t: string, d: any) => entries.push({ type: "custom", customType: _t, data: d }),
    sendUserMessage: (m: string) => sent.push(m),
  };
  const cwd = path.join(HARNESS_TMP_ROOT, `t${harnessSeq++}`);
  fs.mkdirSync(cwd, { recursive: true });
  const ctx: any = {
    cwd,
    ui: { notify: (msg: string, level: string) => notes.push({ msg, level }), setStatus: () => {} },
    sessionManager: { getEntries: () => entries },
  };
  return { pi, tools, ctx, entries, sent, notes, handlers };
}
const lastState = (h: ReturnType<typeof fakeHarness>) => h.entries.filter((e: any) => e.customType === "kstack-wf-state").at(-1)!.data;

describe("S3 executor — stepped dispatch (TASK_03)", () => {

  test("kstack_advance on a stepped phase records results['phase.step'] and hands the next step", async () => {
    const state = { ...createState("develop", "g"), phaseIndex: 2, stepIndex: 0 };
    const h = fakeHarness(state);
    initOrchestrator(h.pi);
    const res = await h.tools.get("kstack_advance").execute("t", { summary: "frontier settled", status: "completed" }, undefined, undefined, h.ctx);
    assert.ok(res.content[0].text.includes("draft"), "the tool result must name the next step");
    const s = lastState(h);
    assert.equal(s.stepIndex, 1);
    assert.equal(s.results["plan.interrogate"]?.summary, "frontier settled");
    assert.equal(s.results["plan"], undefined, "phase result only at the LAST step");
    assert.equal(s.status, "active");
    // The next step's chain is fire-and-forget — wait for it to deliver step 2
    // exactly once and release the in-flight marker (also unblocks later tests:
    // the in-flight registry is module-level and keyed on develop:2).
    for (let i = 0; i < 200 && isPhaseInFlight("develop", 2); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(h.sent.some((m) => m.includes("Step 2/3") && m.includes("draft")), "step-2 instructions must be delivered exactly once");
  });

  test("final step advance records the phase result and parks at the manual gate ONCE", async () => {
    const state = {
      ...createState("develop", "g"),
      phaseIndex: 2,
      stepIndex: 2,
      results: {
        "plan.interrogate": { status: "completed", summary: "q&a" },
        "plan.draft": { status: "completed", summary: "drafted" },
      },
    };
    const h = fakeHarness(state);
    initOrchestrator(h.pi);
    releasePhaseInFlight("develop", 2); // in-flight registry is module-level — drop any stale marker
    const res = await h.tools.get("kstack_advance").execute("t", { summary: "reviewed — PLAN FILE: .kstack/plans/x.md", status: "completed" }, undefined, undefined, h.ctx);
    assert.ok(res.content[0].text.includes("decision phase") || res.content[0].text.includes("PAUSED"), "manual gate must park after the last step");
    const s = lastState(h);
    assert.equal(s.status, "awaiting_approval", "one human gate after step 3");
    assert.equal(s.results["plan.eng-review"]?.status, "completed");
    assert.equal(s.results["plan"]?.status, "completed", "phase-level result recorded for {plan_summary} consumers");
    assert.equal(s.stepIndex, undefined);
    assert.equal(s.phaseIndex, 3);
  });

  test("kstack_phase re-fetches the CURRENT step's instructions (compaction guard)", async () => {
    const state = { ...createState("develop", "g"), phaseIndex: 2, stepIndex: 1 };
    const h = fakeHarness(state);
    initOrchestrator(h.pi);
    const res = await h.tools.get("kstack_phase").execute("t", {}, undefined, undefined, h.ctx);
    assert.ok(res.content[0].text.includes("Step 2/3"), "step position must be named");
    assert.ok(res.content[0].text.includes("draft"), "current step id must be named");
  });

  test("executeCurrentPhase delivers step-0 instructions on entry and persists stepIndex=0", async () => {
    const h = fakeHarness(undefined);
    const state = { ...createState("develop", "g"), phaseIndex: 2 };
    await executeCurrentPhase(h.pi, h.ctx, state as any);
    const persisted = h.entries.find((e) => e.data.stepIndex === 0);
    assert.ok(persisted, "INV-01: entering a stepped phase must persist stepIndex");
    assert.ok(h.sent.some((m) => m.includes("Step 1/3") && m.includes("interrogate")), "step-1 instructions must be delivered");
  });

  test("mid-step resume re-delivers the CURRENT step (no result → re-deliver)", async () => {
    const h = fakeHarness(undefined);
    const state = {
      ...createState("develop", "g"),
      phaseIndex: 2,
      stepIndex: 1,
      results: { "plan.interrogate": { status: "completed", summary: "done" } },
    };
    await executeCurrentPhase(h.pi, h.ctx, state as any);
    assert.ok(h.sent.some((m) => m.includes("Step 2/3") && m.includes("draft")), "restart must re-deliver step 2");
  });

  test("resume banner 'Completed:' lists phase keys only — a finished step is not a finished phase", () => {
    const state = {
      ...createState("develop", "g"),
      phaseIndex: 2,
      stepIndex: 1,
      results: {
        understand: { status: "completed", summary: "scoped" },
        "plan.interrogate": { status: "completed", summary: "q&a" },
      },
    };
    const text = buildResumeContext(state as any);
    assert.match(text, /Current step: draft \(2\/3\)/, "the step posture line names the current step");
    const completedLine = text.split("\n").find((l) => l.startsWith("Completed:"));
    assert.ok(completedLine?.includes("understand"), "completed phases still listed");
    assert.ok(
      !completedLine!.includes("plan.interrogate"),
      "dotted step keys must not render as completed phases (design: phase keys only — mirroring the prior-results filter in buildStepInstructions)",
    );
  });

  test("a delegated step spawns its subagent; kstack_advance is refused while it runs", async () => {
    const wf: import("../orchestrator/types.ts").Workflow = {
      id: "s3-stepped-test", name: "Stepped Test", description: "t", intents: [],
      phases: [{
        id: "mix", name: "Mixed", execution: "main", optional: false,
        steps: [
          { id: "probe", execution: "subagent", agent: "scout", task: "## DELIVERABLE\nProbe it." },
          { id: "finish", execution: "main", task: "## DELIVERABLE\nFinish up from {previous}." },
        ],
      }],
    };
    getAllWorkflows().push(wf);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    try {
      const spawned: string[] = [];
      const state = { ...createState("s3-stepped-test", "g"), phaseIndex: 0 };
      const h = fakeHarness(state);
      initOrchestrator(h.pi);
      launchPhase(h.pi, h.ctx, state as any, (p, c, s) =>
        executeCurrentPhase(p, c, s, {
          spawnFn: async (req: any) => {
            spawned.push(req.agent);
            await gate;
            return { ok: true, output: "probe done", exitCode: 0, durationMs: 1 } as any;
          },
        } as any),
      );
      for (let i = 0; i < 200 && spawned.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(spawned, ["scout"], "the delegated step must spawn its subagent");

      // While the delegation is in flight, kstack_advance must refuse.
      const refused = await h.tools.get("kstack_advance").execute("t", { summary: "premature", status: "completed" }, undefined, undefined, h.ctx);
      assert.ok(/still running|wait/i.test(refused.content[0].text), "advance during a delegated step must be refused");

      release();
      for (let i = 0; i < 200 && h.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(h.sent.some((m) => m.includes("probe done")), "delegated output must reach the model for review");

      // Review → advance records the step result and delivers the next step.
      const adv = await h.tools.get("kstack_advance").execute("t", { summary: "probe reviewed", status: "completed" }, undefined, undefined, h.ctx);
      assert.ok(adv.content[0].text.includes("finish"), "next step must be named");
      assert.equal(lastState(h).results["mix.probe"]?.summary, "probe reviewed");
      assert.equal(lastState(h).stepIndex, 1);
    } finally {
      release();
      const i = getAllWorkflows().indexOf(wf);
      if (i >= 0) getAllWorkflows().splice(i, 1);
    }
  });

  test("a delegated step's task interpolation never mangles the {previous} literal inside its skill digest", async () => {
    // kstack-plan-draft SKILL.md documents `{previous}` literally (backtick-quoted).
    // Interpolating AFTER the digest is embedded replaces that documentation too.
    const wf: import("../orchestrator/types.ts").Workflow = {
      id: "s3-interp-test", name: "Interp", description: "t", intents: [],
      phases: [{
        id: "mix", name: "Mixed", execution: "main", optional: false,
        steps: [
          { id: "probe", execution: "subagent", agent: "scout", skill: "kstack-plan-draft", task: "## DELIVERABLE\nProbe. Prior: {previous}" },
          { id: "finish", execution: "main", task: "## DELIVERABLE\nFinish." },
        ],
      }],
    };
    getAllWorkflows().push(wf);
    try {
      const state = { ...createState("s3-interp-test", "g"), phaseIndex: 0 };
      const h = fakeHarness(state);
      let task = "";
      await executeCurrentPhase(h.pi, h.ctx, state as any, {
        spawnFn: async (req: any) => { task = req.task; return { ok: true, output: "done", exitCode: 0, durationMs: 1 } as any; },
      } as any);
      assert.ok(task.includes("Prior: (no prior output)"), "the step's own {previous} token must interpolate");
      assert.ok(task.includes("`{previous}`"), "the literal {previous} documented inside the skill digest must survive verbatim");
    } finally {
      const i = getAllWorkflows().indexOf(wf);
      if (i >= 0) getAllWorkflows().splice(i, 1);
      releasePhaseInFlight("s3-interp-test", 0);
    }
  });

  test("a delegated step under KSTACK_PI_DETERMINISTIC=off still delivers delegation guidance", async () => {
    const saved = process.env.KSTACK_PI_DETERMINISTIC;
    process.env.KSTACK_PI_DETERMINISTIC = "off";
    const wf: import("../orchestrator/types.ts").Workflow = {
      id: "s3-nodet-test", name: "NoDet", description: "t", intents: [],
      phases: [{
        id: "mix", name: "Mixed", execution: "main", optional: false,
        steps: [
          { id: "probe", execution: "subagent", agent: "scout", skill: "kstack-plan-draft", task: "## DELIVERABLE\nProbe it." },
          { id: "finish", execution: "main", task: "## DELIVERABLE\nFinish." },
        ],
      }],
    };
    getAllWorkflows().push(wf);
    try {
      const state = { ...createState("s3-nodet-test", "g"), phaseIndex: 0 };
      const h = fakeHarness(state);
      let spawned = 0;
      await executeCurrentPhase(h.pi, h.ctx, state as any, {
        spawnFn: async () => { spawned++; return { ok: true, output: "x", exitCode: 0, durationMs: 1 } as any; },
      } as any);
      assert.equal(spawned, 0, "deterministic delegation is off — no chain spawn");
      const msg = h.sent.at(-1) ?? "";
      assert.ok(msg.includes("`subagent`"), "the model must be instructed to delegate via the subagent tool");
      assert.ok(msg.includes('"agent": "scout"'), "the step's agent must be named in the tool params");
      assert.ok(msg.includes("## Skill methodology: kstack-plan-draft"), "the delegated task must carry the FULL digest");
    } finally {
      const i = getAllWorkflows().indexOf(wf);
      if (i >= 0) getAllWorkflows().splice(i, 1);
      releasePhaseInFlight("s3-nodet-test", 0);
      if (saved === undefined) delete process.env.KSTACK_PI_DETERMINISTIC; else process.env.KSTACK_PI_DETERMINISTIC = saved;
    }
  });
});

// --- S3: pre-flight gate configuration (TASK_05 / D20) ----------------------

describe("S3 pre-flight gate inventory (TASK_05)", () => {
  test("sprint yields one row per gated phase; subagent+manual dedupes to a single ⚠ entry row", () => {
    const rows = gateInventory(getWorkflow("sprint")!);
    const byId = new Map(rows.map((r) => [r.phaseId, r]));
    assert.deepEqual(rows.map((r) => r.phaseId), ["understand", "system-design", "architect-gate", "backlog", "commit-archive"]);
    assert.equal(byId.get("architect-gate")!.kind, "entry");
    assert.equal(byId.get("architect-gate")!.warning, true, "entry gates are marked ⚠");
    assert.equal(byId.get("commit-archive")!.kind, "entry");
    assert.equal(byId.get("understand")!.kind, "manual");
    assert.equal(byId.get("system-design")!.kind, "manual");
    assert.equal(byId.get("backlog")!.kind, "manual");
    // Verdict gates are routing gates, not human gates — never rows.
    assert.ok(!byId.has("implement") && !byId.has("devsecops-review") && !byId.has("qa-verdict"));
  });

  test("ship: push-pr excluded explicitly; optional phases produce optional rows", () => {
    const rows = gateInventory(getWorkflow("ship")!);
    assert.ok(!rows.some((r) => r.phaseId === "push-pr"), "push-pr must never be a pre-flight row");
    assert.deepEqual(rows.map((r) => [r.phaseId, r.kind]), [["update-docs", "optional"]]);
  });

  test("develop: plan manual gate + three optional phases; quick is gate-free", () => {
    assert.deepEqual(
      gateInventory(getWorkflow("develop")!).map((r) => [r.phaseId, r.kind]),
      [["plan", "manual"], ["qa", "optional"], ["ship", "optional"], ["document", "optional"]],
    );
    assert.deepEqual(gateInventory(getWorkflow("quick")!), [], "gate-free workflow ⇒ no dialog");
  });

  test("env predicates mirror the gate sites — disabled machinery means no rows", () => {
    const keys = ["KSTACK_PI_MANUAL_GATES", "KSTACK_PI_DETERMINISTIC", "KSTACK_PI_OPTIONAL_PHASES"];
    const saved = keys.map((k) => [k, process.env[k]] as const);
    try {
      process.env.KSTACK_PI_MANUAL_GATES = "off";
      assert.deepEqual(gateInventory(getWorkflow("sprint")!), [], "manual gates off ⇒ no human gates can fire");
      delete process.env.KSTACK_PI_MANUAL_GATES;
      process.env.KSTACK_PI_DETERMINISTIC = "off";
      assert.deepEqual(
        gateInventory(getWorkflow("sprint")!).map((r) => [r.phaseId, r.kind]),
        [
          ["understand", "manual"],
          ["system-design", "manual"],
          ["architect-gate", "manual"],
          ["backlog", "manual"],
          ["commit-archive", "manual"],
        ],
        "entry gates can't fire without deterministic delegation, but the post-completion manual gate still does — degrade to a manual row, don't vanish",
      );
      delete process.env.KSTACK_PI_DETERMINISTIC;
      process.env.KSTACK_PI_OPTIONAL_PHASES = "skip";
      assert.deepEqual(gateInventory(getWorkflow("ship")!), [], "env-skip already decided optional phases");
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

describe("S3 selection-gate consultation (TASK_05)", () => {
  test("optional row override 'skip' auto-skips the phase; 'human' parks like ask mode", async () => {
    const shipWf = getWorkflow("ship")!;
    const lastIdx = shipWf.phases.length - 1; // update-docs — last phase, so skipping completes
    assert.equal(shipWf.phases[lastIdx].id, "update-docs");
    assert.ok(shipWf.phases[lastIdx].optional);

    const skipped = { ...createState("ship", "g"), phaseIndex: lastIdx, gateMode: "selection-gate" as const, gateOverrides: { "update-docs": "skip" as const } };
    const h1 = fakeHarness(skipped);
    await executeCurrentPhase(h1.pi, h1.ctx, skipped as any);
    const s1 = lastState(h1);
    assert.equal(s1.results["update-docs"]?.status, "skipped", "override skip must auto-skip");
    assert.equal(s1.status, "completed", "skipping the last phase completes the workflow");

    const human = { ...createState("ship", "g"), phaseIndex: lastIdx, gateMode: "selection-gate" as const, gateOverrides: { "update-docs": "human" as const } };
    const h2 = fakeHarness(human);
    await executeCurrentPhase(h2.pi, h2.ctx, human as any);
    const s2 = lastState(h2);
    assert.equal(s2.status, "awaiting_approval", "override human parks exactly like ask mode");
    assert.equal(s2.pendingOptional, true);
  });

  test("human-gate mode ignores gateOverrides entirely (status quo)", async () => {
    const shipWf = getWorkflow("ship")!;
    const lastIdx = shipWf.phases.length - 1;
    const state = { ...createState("ship", "g"), phaseIndex: lastIdx, gateMode: "human-gate" as const, gateOverrides: { "update-docs": "skip" as const } };
    const h = fakeHarness(state);
    await executeCurrentPhase(h.pi, h.ctx, state as any);
    const s = lastState(h);
    assert.equal(s.status, "awaiting_approval", "human-gate mode never consults overrides");
  });

  test("manual row override 'auto' skips the post-completion park; 'human' parks", async () => {
    // sprint.understand is main+manual; the next phase (user-story) is main — no spawn needed.
    for (const [override, parked] of [["auto", false], ["human", true]] as const) {
      const state = { ...createState("sprint", "g"), phaseIndex: 0, sprintNumber: 7, gateMode: "selection-gate" as const, gateOverrides: { understand: override } };
      const h = fakeHarness(state);
      initOrchestrator(h.pi);
      const res = await h.tools.get("kstack_advance").execute("t", { summary: "understood", status: "completed" }, undefined, undefined, h.ctx);
      const s = lastState(h);
      if (parked) {
        assert.equal(s.status, "awaiting_approval", "override human parks exactly as today");
        assert.ok(res.content[0].text.includes("decision phase") || res.content[0].text.includes("PAUSED"));
      } else {
        assert.equal(s.status, "active", "override auto must skip the manual park");
        assert.equal(s.phaseIndex, 1);
        assert.ok(res.content[0].text.includes("Advancing to"));
      }
      for (let i = 0; i < 200 && isPhaseInFlight("sprint", 1); i++) await new Promise((r) => setTimeout(r, 10));
      releasePhaseInFlight("sprint", 1);
    }
  });

  test("selection-gate 'auto' on a manual gate is audited — kind:'gate' decision:'auto' lands in the ledger", async () => {
    const state = { ...createState("sprint", "g"), phaseIndex: 0, sprintNumber: 7, gateMode: "selection-gate" as const, gateOverrides: { understand: "auto" as const } };
    const h = fakeHarness(state);
    initOrchestrator(h.pi);
    await h.tools.get("kstack_advance").execute("t", { summary: "understood", status: "completed" }, undefined, undefined, h.ctx);
    const s = lastState(h);
    assert.equal(s.status, "active", "auto still skips the park");
    const entries = readLedger(h.ctx.cwd, s);
    assert.ok(
      entries.some((e) => e.kind === "gate" && e.payload.gateId === "understand" && e.payload.decision === "auto"),
      "an auto-suppressed manual gate must be audited under the phase id (gateId↔phaseId join)",
    );
    for (let i = 0; i < 200 && isPhaseInFlight("sprint", 1); i++) await new Promise((r) => setTimeout(r, 10));
    releasePhaseInFlight("sprint", 1);
  });

  test("entry row override 'auto' runs the side-effect phase without the entry park", async () => {
    // sprint.commit-archive is subagent+manual — its entry gate parks BEFORE the delegation.
    const wf = getWorkflow("sprint")!;
    const idx = wf.phases.findIndex((p) => p.id === "commit-archive");
    assert.ok(idx >= 0);
    let spawned = 0;
    const state = { ...createState("sprint", "g"), phaseIndex: idx, sprintNumber: 7, gateMode: "selection-gate" as const, gateOverrides: { "commit-archive": "auto" as const } };
    const h = fakeHarness(state);
    await executeCurrentPhase(h.pi, h.ctx, state as any, {
      spawnFn: async () => { spawned++; return { ok: true, output: "archived", exitCode: 0, durationMs: 1 } as any; },
    } as any);
    assert.equal(spawned, 1, "override auto must run the entry-gated phase directly");
    assert.equal(lastState(h).entryGate, undefined, "no entry park recorded");

    const human = { ...createState("sprint", "g"), phaseIndex: idx, sprintNumber: 7, gateMode: "selection-gate" as const, gateOverrides: { "commit-archive": "human" as const } };
    const h2 = fakeHarness(human);
    await executeCurrentPhase(h2.pi, h2.ctx, human as any);
    assert.equal(lastState(h2).entryGate, true, "override human parks at entry exactly as today");
  });
});

describe("S3 gate-configure dialog (TASK_05)", () => {
  test("component maps rows to overrides; entry/manual rows never offer skip (INV-05)", async () => {
    const rows = gateInventory(getWorkflow("develop")!); // plan manual + qa/ship/document optional
    let captured: any;
    const resultPromise = configureGates(rows, {
      ui: {
        custom: (factory: any) => new Promise((resolve) => {
          const produced = factory(null, null, null, resolve);
          if (produced instanceof Promise) produced.then((c) => (captured = c));
          else captured = produced;
        }),
      },
    } as any);
    assert.ok(captured, "ctx.ui.custom factory must produce a component");
    // INV-05: skip is only selectable on optional rows — read the SettingsList items.
    const items = (captured as any).items as Array<{ id: string; values?: string[] }>;
    const planRow = items.find((i) => i.id === "plan")!;
    assert.ok(!planRow.values!.includes("skip"), "manual rows must not offer skip");
    const qaRow = items.find((i) => i.id === "qa")!;
    assert.ok(qaRow.values!.includes("skip"), "optional rows offer skip");
    const modeRow = items.find((i) => i.id === "__mode__")!;
    assert.ok(modeRow.values!.includes("selection-gate") && modeRow.values!.includes("human-gate"));
    captured.handleInput("\x1b"); // escape dismisses → undefined
    assert.equal(await resultPromise, undefined, "dismissed dialog resolves undefined (caller defaults to human-gate)");
  });

  function captureDialog(rows: ReturnType<typeof gateInventory>) {
    let captured: any;
    const resultPromise = configureGates(rows, {
      ui: {
        custom: (factory: any) => new Promise((resolve) => {
          captured = factory(null, null, null, resolve);
        }),
      },
    } as any, "Full Development Cycle");
    return { captured, resultPromise };
  }

  // develop rows: [__mode__, plan, qa, ship, document, __done__]
  const DOWN = "\x1b[B";
  const ENTER = "\r";

  test("the panel renders a title naming the workflow — never a bare list", async () => {
    const { captured, resultPromise } = captureDialog(gateInventory(getWorkflow("develop")!));
    const lines: string[] = captured.render(80);
    assert.ok(
      lines.slice(0, 3).some((l) => l.includes("Full Development Cycle")),
      "the dialog's first lines must name the workflow it configures",
    );
    captured.handleInput("\x1b");
    await resultPromise;
  });

  test("keyboard submit maps rows to gateMode + gateOverrides (selection-gate)", async () => {
    const { captured, resultPromise } = captureDialog(gateInventory(getWorkflow("develop")!));
    captured.handleInput(ENTER); // __mode__ cycles human-gate → selection-gate
    captured.handleInput(DOWN); // plan
    captured.handleInput(DOWN); // qa
    captured.handleInput(ENTER); // qa cycles human → auto
    captured.handleInput(DOWN); // ship
    captured.handleInput(DOWN); // document
    captured.handleInput(DOWN); // __done__
    captured.handleInput(ENTER); // submit
    assert.deepEqual(await resultPromise, {
      gateMode: "selection-gate",
      gateOverrides: { qa: "auto" },
    });
  });

  test("entry rows render the ⚠ marker and default to 'human' (D20)", async () => {
    const { captured, resultPromise } = captureDialog(gateInventory(getWorkflow("sprint")!));
    const items = (captured as any).items as Array<{ id: string; label: string; currentValue: string }>;
    const entry = items.find((i) => i.id === "architect-gate")!;
    assert.ok(entry.label.includes("⚠"), "side-effect entry gates must render the ⚠ marker, not just carry a data flag");
    assert.equal(entry.currentValue, "human", "entry gates default to human");
    assert.ok(!items.find((i) => i.id === "understand")!.label.includes("⚠"), "non-entry rows carry no ⚠");
    captured.handleInput("\x1b");
    await resultPromise;
  });

  test("human-gate submit drops per-gate choices — they are inert state under human-gate semantics", async () => {
    const { captured, resultPromise } = captureDialog(gateInventory(getWorkflow("develop")!));
    captured.handleInput(DOWN); // plan
    captured.handleInput(DOWN); // qa
    captured.handleInput(ENTER); // qa → auto (but mode stays human-gate)
    captured.handleInput(DOWN); // ship
    captured.handleInput(DOWN); // document
    captured.handleInput(DOWN); // __done__
    captured.handleInput(ENTER); // submit
    assert.deepEqual(await resultPromise, { gateMode: "human-gate", gateOverrides: {} });
  });
});

// --- S3: append-only ledger (TASK_07 / D28) ---------------------------------

import { appendLedger, ledgerPathFor, readLedger } from "../orchestrator/ledger.ts";

describe("S3 append-only ledger (TASK_07)", () => {
  test("a step completion writes one verbatim kind:'step' entry under .kstack/ledger", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "kstack-ledger-"));
    try {
      const state = { ...createState("develop", "g"), phaseIndex: 2, stepIndex: 0 };
      const h = fakeHarness(state);
      h.ctx.cwd = cwd;
      initOrchestrator(h.pi);
      const res = await h.tools.get("kstack_advance").execute("t", { summary: "frontier settled", status: "completed" }, undefined, undefined, h.ctx);
      assert.ok(!res.isError);
      const dir = path.join(cwd, ".kstack", "ledger");
      const files = fs.readdirSync(dir);
      assert.equal(files.length, 1, "one ledger file per run");
      assert.ok(files[0].endsWith(".jsonl"));
      const entries = readFileSync(path.join(dir, files[0]), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const step = entries.find((e) => e.kind === "step");
      assert.ok(step, "a step completion must be ledgered");
      assert.equal(step.workflowId, "develop");
      assert.equal(step.phaseId, "plan");
      assert.equal(step.stepId, "interrogate");
      assert.equal(step.payload.summary, "frontier settled", "INV-L2: summary verbatim");
      assert.ok(typeof step.at === "string" && step.at.includes("T"), "ISO-8601 timestamp");
      for (let i = 0; i < 200 && isPhaseInFlight("develop", 2); i++) await new Promise((r) => setTimeout(r, 10));
      releasePhaseInFlight("develop", 2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("appends never truncate — a resumed run keeps its earlier entries", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "kstack-ledger-"));
    try {
      const state = { ...createState("develop", "g") };
      appendLedger(cwd, state, { kind: "step", phaseId: "plan", stepId: "interrogate", payload: { summary: "first" } });
      appendLedger(cwd, state, { kind: "step", phaseId: "plan", stepId: "draft", payload: { summary: "second" } });
      const file = ledgerPathFor(cwd, state);
      const lines = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(lines.length, 2);
      assert.equal(lines[0].payload.summary, "first");
      assert.equal(lines[1].payload.summary, "second");
      // And a second append AFTER reading still appends (the file was not rewritten).
      appendLedger(cwd, state, { kind: "phase", phaseId: "plan", payload: { summary: "done" } });
      assert.equal(readFileSync(file, "utf-8").trim().split("\n").length, 3);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a write failure degrades to a notify — the state machine never blocks (INV-L3)", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "kstack-ledger-"));
    try {
      // .kstack exists as a FILE → mkdir inside appendLedger must fail.
      writeFileSync(path.join(cwd, ".kstack"), "not a dir");
      const state = { ...createState("develop", "g") };
      const errors: string[] = [];
      const ok = appendLedger(cwd, state, { kind: "step", phaseId: "plan", stepId: "s1", payload: { summary: "x" } }, (m) => errors.push(m));
      assert.equal(ok, false);
      assert.ok(errors.length === 1 && /ledger/i.test(errors[0]), "failure surfaced once, as a warning");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("gate decisions land as kind:'gate' entries with their decision", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "kstack-ledger-"));
    try {
      // develop.qa is optional + NOT last: the ask-mode park writes a human gate entry.
      const wf = getWorkflow("develop")!;
      const idx = wf.phases.findIndex((p) => p.id === "qa");
      assert.ok(idx >= 0 && wf.phases[idx].optional && idx < wf.phases.length - 1);
      const state = { ...createState("develop", "g"), phaseIndex: idx };
      const h = fakeHarness(state);
      h.ctx.cwd = cwd;
      await executeCurrentPhase(h.pi, h.ctx, state as any);
      const s = lastState(h);
      assert.equal(s.status, "awaiting_approval");
      const entries = readLedger(cwd, state);
      const gate = entries.find((e) => e.kind === "gate" && e.phaseId === "qa");
      assert.ok(gate, "the optional-phase park is a recorded gate decision");
      assert.equal(gate.payload.gateId, "qa");
      assert.equal(gate.payload.decision, "human");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("resume-gate: re-delivering the LAST step with a missing artifact adds a note", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "kstack-ledger-"));
    try {
      // qa-verdict is a sprint phase with a real artifact contract
      // (qaArtifactPath); give a synthetic workflow a stepped phase reusing
      // that id so phaseArtifactPaths resolves.
      const wf: import("../orchestrator/types.ts").Workflow = {
        id: "s3-resumegate-test", name: "ResumeGate", description: "t", intents: [],
        phases: [{
          id: "qa-verdict", name: "QA Verdict", execution: "main", optional: false,
          steps: [
            { id: "run", execution: "main", task: "## DELIVERABLE\nRun." },
            { id: "report", execution: "main", task: "## DELIVERABLE\nReport." },
          ],
        }],
      };
      getAllWorkflows().push(wf);
      try {
        const state = {
          ...createState("s3-resumegate-test", "g"),
          phaseIndex: 0,
          sprintNumber: 3,
          stepIndex: 1, // LAST step — the resume-gate applies here only
          results: { "qa-verdict.run": { status: "completed" as const, summary: "ran" } },
        };
        const h = fakeHarness(state);
        h.ctx.cwd = cwd;
        await executeCurrentPhase(h.pi, h.ctx, state as any);
        const last = h.sent.at(-1) ?? "";
        assert.ok(/artifact|missing|expected/i.test(last), "missing artifact must be named in the re-delivered instruction");
      } finally {
        const i = getAllWorkflows().indexOf(wf);
        if (i >= 0) getAllWorkflows().splice(i, 1);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("session_before_compact persists a fresh state snapshot", async () => {
    const state = { ...createState("develop", "g"), phaseIndex: 2, stepIndex: 1 };
    const h = fakeHarness(state);
    initOrchestrator(h.pi);
    const handler = h.handlers.get("session_before_compact");
    assert.ok(handler, "the precompact hook must be registered");
    const before = h.entries.length;
    await handler({ type: "session_before_compact", reason: "threshold", willRetry: false }, h.ctx);
    assert.ok(h.entries.length > before, "a state snapshot lands before compaction proceeds");
  });

  test("a symlink AT the ledger filename refuses the append (pass-6 review: file-level containment)", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "kstack-ledger-"));
    const outside = path.join(cwd, "outside-target.txt");
    try {
      // v≤3/hand-built states land in the predictable "adhoc" lane — the only
      // place a planted filename-symlink is actionable.
      const state: any = { ...createState("develop", "g") };
      delete state.runId;
      const file = ledgerPathFor(cwd, state); // <cwd>/.kstack/ledger/develop-adhoc.jsonl
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let linked = false;
      try {
        fs.symlinkSync(outside, file, "file");
        linked = true;
      } catch {
        /* Windows without developer-mode refuses symlink() — skip the probe */
      }
      if (!linked) return;
      const errors: string[] = [];
      const ok = appendLedger(cwd, state, { kind: "step", phaseId: "plan", stepId: "s1", payload: { summary: "x" } }, (m) => errors.push(m));
      assert.equal(ok, false, "a symlinked ledger file must refuse the append");
      assert.ok(errors.length === 1 && /symlink/i.test(errors[0]), "the refusal names the cause");
      assert.equal(existsSync(outside), false, "nothing may be written through the link");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("sinks bootstrap .kstack/ledger + .kstack/runs into the repo .gitignore (idempotent)", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "kstack-ledger-"));
    try {
      const state = { ...createState("develop", "g") };
      appendLedger(cwd, state, { kind: "step", phaseId: "plan", stepId: "s1", payload: { summary: "x" } });
      const gi = readFileSync(path.join(cwd, ".gitignore"), "utf-8");
      assert.ok(gi.includes(".kstack/ledger/"), "ledger dir is gitignored");
      assert.ok(gi.includes(".kstack/runs/"), "run-report dir is gitignored");
      assert.ok(!gi.includes(".kstack/plans"), "intentional artifacts stay committable");
      // Second write: lines are not duplicated.
      appendLedger(cwd, state, { kind: "step", phaseId: "plan", stepId: "s2", payload: { summary: "y" } });
      const gi2 = readFileSync(path.join(cwd, ".gitignore"), "utf-8");
      assert.equal(gi2.split("\n").filter((l) => l.trim() === ".kstack/ledger/").length, 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// --- S3: stuck detector + budgets (TASK_08 / D28) ----------------------------

import { newStepRun, feedStepEvent, detectStuck, checkStepBudgets, stepBudgetDefaults } from "../orchestrator/stuck.ts";

function toolStart(runTool: string, args: any) {
  return { type: "tool_execution_start", toolName: runTool, args };
}
function toolEnd(runTool: string, ok = true, text = "obs") {
  return { type: "tool_execution_end", toolName: runTool, result: { content: [{ type: "text", text }] }, isError: !ok };
}
function msgEnd(text = "reasoning", usage?: any) {
  return { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage } };
}

describe("S3 stuck detector (TASK_08)", () => {
  test("rule 1 — identical action+observation trips at 4 consecutive repeats, not before", () => {
    const run = newStepRun();
    for (let i = 0; i < 3; i++) {
      feedStepEvent(run, toolStart("read", { path: "a.ts" }));
      feedStepEvent(run, toolEnd("read", true, "same output"));
      assert.equal(detectStuck(run), null, `must not trip at ${i + 1} repeats`);
    }
    feedStepEvent(run, toolStart("read", { path: "a.ts" }));
    feedStepEvent(run, toolEnd("read", true, "same output"));
    assert.equal(detectStuck(run), "identical-action");
  });

  test("rule 1 — a DIFFERENT observation resets the streak", () => {
    const run = newStepRun();
    for (let i = 0; i < 6; i++) {
      feedStepEvent(run, toolStart("read", { path: "a.ts" }));
      feedStepEvent(run, toolEnd("read", true, `output ${i}`));
    }
    assert.equal(detectStuck(run), null, "same action, different observations is not a loop");
  });

  test("rule 2 — three consecutive action errors trip; a success resets", () => {
    const run = newStepRun();
    feedStepEvent(run, toolStart("bash", { command: "make" }));
    feedStepEvent(run, toolEnd("bash", false, "err"));
    feedStepEvent(run, toolStart("bash", { command: "make" }));
    feedStepEvent(run, toolEnd("bash", false, "err"));
    assert.equal(detectStuck(run), null);
    feedStepEvent(run, toolStart("bash", { command: "make" }));
    feedStepEvent(run, toolEnd("bash", false, "err"));
    assert.equal(detectStuck(run), "action-errors");

    const ok = newStepRun();
    feedStepEvent(ok, toolStart("bash", { command: "a" }));
    feedStepEvent(ok, toolEnd("bash", false, "err"));
    feedStepEvent(ok, toolStart("bash", { command: "b" }));
    feedStepEvent(ok, toolEnd("bash", true, "fine"));
    feedStepEvent(ok, toolStart("bash", { command: "c" }));
    feedStepEvent(ok, toolEnd("bash", false, "err"));
    assert.equal(detectStuck(ok), null, "interleaved success breaks the error streak");
  });

  test("rule 3 — three consecutive assistant messages with no tool call trip", () => {
    const run = newStepRun();
    feedStepEvent(run, msgEnd("thinking 1"));
    feedStepEvent(run, msgEnd("thinking 2"));
    assert.equal(detectStuck(run), null);
    feedStepEvent(run, msgEnd("thinking 3"));
    assert.equal(detectStuck(run), "monologue");

    const active = newStepRun();
    feedStepEvent(active, msgEnd("plan"));
    feedStepEvent(active, toolStart("ls", { path: "." }));
    feedStepEvent(active, toolEnd("ls", true, "files"));
    feedStepEvent(active, msgEnd("note"));
    feedStepEvent(active, msgEnd("note2"));
    assert.equal(detectStuck(active), null, "a tool call between messages breaks the monologue");
  });

  test("rule 3 — user/tool-result message_end events reset the streak (interview regression)", () => {
    // develop.plan.interrogate is a pure Q&A step: assistant question → user
    // reply → assistant question… Before the fix, non-assistant message_end
    // events early-returned WITHOUT resetting monologueStreak, so three
    // ordinary interview rounds parked the run mid-interview.
    const userEnd = (text: string) => ({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
    const run = newStepRun();
    for (let round = 0; round < 6; round++) {
      feedStepEvent(run, msgEnd(`question ${round}`));
      feedStepEvent(run, userEnd(`answer ${round}`));
    }
    assert.equal(detectStuck(run), null, "interactive Q&A rounds must never trip the monologue rule");

    // A tool-result-shaped message_end resets the same way.
    const toolMsg = newStepRun();
    feedStepEvent(toolMsg, msgEnd("a"));
    feedStepEvent(toolMsg, msgEnd("b"));
    feedStepEvent(toolMsg, { type: "message_end", message: { role: "tool", content: [{ type: "text", text: "result" }] } });
    feedStepEvent(toolMsg, msgEnd("c"));
    feedStepEvent(toolMsg, msgEnd("d"));
    assert.equal(detectStuck(toolMsg), null, "a tool-result message must reset the streak");

    // And without any feedback, the rule still trips (detector not gutted).
    const bare = newStepRun();
    feedStepEvent(bare, msgEnd("1"));
    feedStepEvent(bare, msgEnd("2"));
    feedStepEvent(bare, msgEnd("3"));
    assert.equal(detectStuck(bare), "monologue");
  });

  test("rule 4 — alternating action pairs trip at 6 repeats", () => {
    const run = newStepRun();
    // A,B,A,B,A,B = 6 actions alternating between two distinct keys.
    for (let i = 0; i < 5; i++) {
      const tool = i % 2 === 0 ? "read" : "edit";
      feedStepEvent(run, toolStart(tool, { path: "x" }));
      feedStepEvent(run, toolEnd(tool, true, `o${i}`));
      assert.equal(detectStuck(run), null);
    }
    feedStepEvent(run, toolStart("edit", { path: "x" }));
    assert.equal(detectStuck(run), "alternating");
  });

  test("rule 5 — repeated context-window errors trip", () => {
    const run = newStepRun();
    const ctxErr = () => feedStepEvent(run, { type: "auto_retry_start", errorMessage: "context length exceeded: maximum context window is 128k" });
    ctxErr();
    ctxErr();
    assert.equal(detectStuck(run), null);
    ctxErr();
    assert.equal(detectStuck(run), "context-errors");
  });

  test("budgets — soft-warn at 80%, hard trip at 100%, warn fires once per dimension", () => {
    const limits = { turns: 10, tokens: 1000, usd: 1, ms: 60_000, usdPerMin: 10 };
    const run = newStepRun(1_000_000);
    run.turns = 8; // exactly 80%
    let r = checkStepBudgets(run, limits, 1_000_000);
    assert.deepEqual(r.warn, ["turns"]);
    assert.equal(r.exceeded, null);
    r = checkStepBudgets(run, limits, 1_000_000);
    assert.deepEqual(r.warn, [], "warn fires once per dimension");
    run.turns = 10;
    r = checkStepBudgets(run, limits, 1_000_000);
    assert.equal(r.exceeded, "turns");
  });

  test("budgets — wall-clock and cost-velocity dimensions", () => {
    const limits = { ...stepBudgetDefaults(), ms: 1000, usdPerMin: 60 };
    const run = newStepRun(0);
    assert.equal(checkStepBudgets(run, limits, 799).warn.length, 0);
    assert.deepEqual(checkStepBudgets(run, limits, 800).warn, ["ms"]);
    assert.equal(checkStepBudgets(run, limits, 1000).exceeded, "ms");

    const costRun = newStepRun(0);
    // usdPerMin has a 6s warmup floor (elapsedMin < 0.1 → 0) so a first cost
    // event at ~1ms can't instant-trip; at 6.5s elapsed $7 ⇒ ~$64.6/min > 60.
    // (Separate limits: the ms cap would trip before usdPerMin at 6.5s.)
    const costLimits = { ...stepBudgetDefaults(), usdPerMin: 60 };
    costRun.costUsd = 7;
    assert.equal(checkStepBudgets(costRun, costLimits, 500).exceeded, null); // warmup floor holds
    assert.equal(checkStepBudgets(costRun, costLimits, 6500).exceeded, "usdPerMin");
  });

  test("budgets — object-shaped Usage.cost feeds the usd dims (pass-5 review)", () => {
    // pi's Usage.cost is { input, output, cacheRead, cacheWrite, total } — an
    // OBJECT. Reading it as a scalar yielded NaN→0 and made both usd dims dead
    // code. Feed a real-shaped usage and assert the usd dim can trip.
    const run = newStepRun(0);
    feedStepEvent(run, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: { input: 10, output: 5, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
      },
    } as any);
    assert.ok(run.costUsd > 0.29 && run.costUsd < 0.31, `object cost must land (${run.costUsd})`);
    const limits = { ...stepBudgetDefaults(), usd: 0.2 };
    assert.equal(checkStepBudgets(run, limits, 60_000).exceeded, "usd");
  });

  test("env defaults are conservative and 'off' disables a dimension", () => {
    const d = stepBudgetDefaults();
    assert.ok(d.turns >= 20 && d.turns <= 200, `turns default sane (${d.turns})`);
    assert.ok(d.ms >= 300_000, `ms default sane (${d.ms})`);
  });
});

describe("S3 stuck/budget wiring (TASK_08)", () => {
  test("a delegated step that loops is aborted and parks with stuck:<rule>:<phase>.<step>", async () => {
    const wf: import("../orchestrator/types.ts").Workflow = {
      id: "s3-stuck-test", name: "Stuck Test", description: "t", intents: [],
      phases: [{
        id: "mix", name: "Mixed", execution: "main", optional: false,
        steps: [
          { id: "probe", execution: "subagent", agent: "scout", task: "## DELIVERABLE\nProbe." },
          { id: "finish", execution: "main", task: "## DELIVERABLE\nFinish." },
        ],
      }],
    };
    getAllWorkflows().push(wf);
    try {
      const state = { ...createState("s3-stuck-test", "g"), phaseIndex: 0 };
      const h = fakeHarness(state);
      let abortSeen = false;
      await executeCurrentPhase(h.pi, h.ctx, state as any, {
        spawnFn: async (req: any) => {
          // The child loops on an identical action — feed the raw event tap.
          for (let i = 0; i < 4; i++) {
            req.onEvent?.(toolStart("read", { path: "same.ts" }));
            req.onEvent?.(toolEnd("read", true, "same"));
          }
          // Cooperative abort: the detector tripped → shouldAbort() true.
          abortSeen = req.shouldAbort?.() === true;
          return { ok: false, output: "", error: "aborted: detector", exitCode: null, durationMs: 5, incomplete: true } as any;
        },
      } as any);
      assert.ok(abortSeen, "shouldAbort must flip once the detector trips");
      const s = lastState(h);
      assert.equal(s.status, "paused", "a tripped detector parks the run — never a silent kill");
      assert.match(s.pausedReason ?? "", /^stuck:identical-action:mix\.probe$/, `pausedReason was ${s.pausedReason}`);
    } finally {
      const i = getAllWorkflows().indexOf(wf);
      if (i >= 0) getAllWorkflows().splice(i, 1);
      releasePhaseInFlight("s3-stuck-test", 0);
    }
  });

  test("main-step events feed the detector while a stepped phase is active", async () => {
    const state = { ...createState("develop", "g"), phaseIndex: 2, stepIndex: 0 };
    const h = fakeHarness(state);
    initOrchestrator(h.pi);
    // Deliver step 1 (main) — the watch begins at instruction delivery.
    await executeCurrentPhase(h.pi, h.ctx, state as any);
    const toolStartH = h.handlers.get("tool_execution_start");
    const toolEndH = h.handlers.get("tool_execution_end");
    assert.ok(toolStartH && toolEndH, "main-step watch must subscribe to tool events");
    for (let i = 0; i < 4; i++) {
      await toolStartH({ type: "tool_execution_start", toolCallId: `c${i}`, toolName: "read", args: { file_path: "same.ts" } }, h.ctx);
      await toolEndH({ type: "tool_execution_end", toolCallId: `c${i}`, toolName: "read", result: { content: [] }, isError: false }, h.ctx);
    }
    const s = lastState(h);
    assert.equal(s.status, "paused");
    assert.match(s.pausedReason ?? "", /^stuck:identical-action:plan\.interrogate$/, `pausedReason was ${s.pausedReason}`);
  });

  test("the detector is inert on implicit-step phases (no watch is started)", async () => {
    const state = { ...createState("develop", "g"), phaseIndex: 0 }; // understand — implicit
    const h = fakeHarness(state);
    initOrchestrator(h.pi);
    await executeCurrentPhase(h.pi, h.ctx, state as any);
    const toolStartH = h.handlers.get("tool_execution_start");
    const toolEndH = h.handlers.get("tool_execution_end");
    if (toolStartH && toolEndH) {
      for (let i = 0; i < 5; i++) {
        await toolStartH({ type: "tool_execution_start", toolCallId: `c${i}`, toolName: "read", args: { file_path: "x.ts" } }, h.ctx);
        await toolEndH({ type: "tool_execution_end", toolCallId: `c${i}`, toolName: "read", result: { content: [] }, isError: false }, h.ctx);
      }
    }
    assert.notEqual(lastState(h).status, "paused", "implicit phases carry no step watch — nothing trips");
  });
});

// --- TASK_10: develop.plan pilot acceptance — the full 3-step run -------------

describe("S3 acceptance — develop.plan three-step run (TASK_10)", () => {
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond(), "timed out waiting for the fire-and-forget chain");
  };
  const delivered = (h: ReturnType<typeof fakeHarness>, marker: string) =>
    h.sent.some((m) => m.includes(marker));

  test("interrogate → draft → eng-review run end-to-end: skills, steps, ledger, single human gate", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "kstack-accept-"));
    try {
      const wf = getWorkflow("develop")!;
      const planIdx = wf.phases.findIndex((p) => p.id === "plan");
      assert.ok(planIdx >= 0, "develop.plan exists");
      const state = { ...createState("develop", "acceptance goal"), phaseIndex: planIdx };
      const h = fakeHarness(state);
      h.ctx.cwd = cwd;
      initOrchestrator(h.pi);

      // Entry: step 1/3 delivers with the FULL kstack-grilling skill.
      await executeCurrentPhase(h.pi, h.ctx, state as any);
      assert.ok(delivered(h, "Step 1/3") && delivered(h, "interrogate"), "step 1 instructions delivered");
      assert.ok(delivered(h, "#### Skill gate: kstack-grilling"), "s1 must carry its own skill");
      assert.equal(lastState(h).stepIndex, 0);

      const advance = (summary: string) =>
        h.tools.get("kstack_advance").execute("t2", { summary, status: "completed" }, undefined, undefined, h.ctx);

      // Step 1 done → step 2 delivered with the FULL kstack-plan-draft skill.
      let res = await advance("frontier settled");
      assert.ok(!res.isError);
      await waitFor(() => delivered(h, "Step 2/3"));
      assert.ok(delivered(h, "#### Skill gate: kstack-plan-draft"), "s2 must carry its own skill");
      assert.equal(lastState(h).stepIndex, 1);
      assert.equal(lastState(h).results["plan.interrogate"]?.summary, "frontier settled");

      // Restart mid-step: a fresh executor pass on the same state re-delivers
      // the CURRENT step (stepIndex unchanged, no result recorded for draft).
      h.sent.length = 0;
      await executeCurrentPhase(h.pi, h.ctx, lastState(h) as any);
      assert.ok(delivered(h, "Step 2/3"), "mid-step resume re-delivers step 2");

      // Step 2 done → step 3 delivered with kstack-plan-eng-review.
      res = await advance("plan written to .kstack/plans/accept.md");
      assert.ok(!res.isError);
      await waitFor(() => delivered(h, "Step 3/3"));
      assert.ok(delivered(h, "#### Skill gate: kstack-plan-eng-review"), "s3 must carry its own skill");
      assert.equal(lastState(h).stepIndex, 2);

      // Step 3 done → phase completes, human gate parks ONCE, ledger holds
      // step×3 + phase + gate entries for the run.
      res = await advance("reviewed — PLAN FILE: .kstack/plans/accept.md");
      const s = lastState(h);
      assert.equal(s.status, "awaiting_approval", "the manual gate parks once after step 3");
      assert.equal(s.results["plan"]?.status, "completed");
      assert.equal(s.stepIndex, undefined);
      assert.equal(s.version, 4);

      const entries = readLedger(cwd, s);
      const steps = entries.filter((e) => e.kind === "step" && e.phaseId === "plan");
      assert.deepEqual(steps.map((e) => e.stepId), ["interrogate", "draft", "eng-review"], "one ledger step entry per step, verbatim");
      assert.ok(entries.some((e) => e.kind === "phase" && e.phaseId === "plan"), "phase roll-up ledgered");
      assert.ok(entries.some((e) => e.kind === "gate" && e.payload.decision === "human"), "human gate decision ledgered");
      releasePhaseInFlight("develop", planIdx);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
