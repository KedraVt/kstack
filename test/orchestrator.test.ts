import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createState, advancePhase, abortState, resumeState, pauseState, gateForApproval, approveNext, gateOptionalPhase, approveOptionalPhase, skipPendingOptional } from "../orchestrator/state.ts";
import { getAllWorkflows, getWorkflow, getWorkflowIds } from "../orchestrator/workflows.ts";
import { loadSkillDigest, getSkillInfo, buildSkillIndex, getSkillIds } from "../orchestrator/skills.ts";
import { buildPhaseInstructions, buildDeterministicPlan, planFilePath, parsePlanFileMarker, resolvePlanFilePath, carryOverOpenQuestions } from "../orchestrator/templates.ts";
import type { WorkflowContext, WorkflowPhase } from "../orchestrator/types.ts";
import { launchPhase, ctxAlive, isPhaseInFlight, advanceBlockReason, releasePhaseInFlight, buildResumeContext, activeConstraintLines, statusLineFor } from "../orchestrator/executor.ts";
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
  // via /gstack → Resume while the first dialog was pending — ran the QA
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
  // Second gstack_advance in the same turn after a decision phase: the parked
  // state points at the NEXT phase (a subagent phase with no chain in flight),
  // so without this block the advance would record a phase that never ran as
  // completed — mechanically bypassing develop.plan / investigate.root-cause.
  const state = { workflowId: "develop", phaseIndex: 3, status: "awaiting_approval" } as any;
  assert.match(advanceBlockReason(state) ?? "", /PARKED awaiting user approval/);
});

test("advanceBlockReason blocks gstack_advance while a delegation chain is in flight", async () => {
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
  test("all registered skill digests exist and are small enough to inject", () => {
    for (const id of getSkillIds()) {
      const digest = loadSkillDigest(id);
      assert.ok(digest, `missing digest for ${id}`);
      assert.ok(digest.length < 16 * 1024, `digest ${id} too large: ${digest.length} chars`);
      assert.ok(digest.includes("# Skill:"), `digest ${id} missing header`);
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

  test("loadSkillDigest returns null for unknown skills; grilling is vendored", () => {
    assert.equal(loadSkillDigest("nonexistent-skill"), null);
    const grilling = getSkillInfo("grilling")!;
    assert.equal(grilling.fullPath, null);
    assert.ok(existsSync(grilling.distilledPath));
  });

  test("getSkillInfo resolves full SKILL.md paths that exist on disk", () => {
    for (const id of ["gstack-review", "gstack-office-hours", "gstack-document-generate"]) {
      const info = getSkillInfo(id)!;
      assert.ok(info.fullPath, `${id} should have an upstream SKILL.md`);
      assert.ok(existsSync(info.fullPath), `${info.fullPath} not found`);
    }
  });

  test("every registered skill exposes a DoD + best-practices gate", () => {
    for (const id of getSkillIds()) {
      const info = getSkillInfo(id)!;
      assert.ok(info.dod.includes("DoD:"), `${id} gate missing DoD`);
      assert.ok(/BP:/.test(info.dod), `${id} gate missing best practices`);
    }
  });
});

describe("skill tiering in orchestrator instructions", () => {
  test("MAIN phases embed full methodology (sprint-beta unified source by default)", () => {
    const plan = findPhase("develop", "plan");
    assert.equal(plan.execution, "main");
    const instructions = buildPhaseInstructions(plan, makeCtx("develop", 2));
    // Full-injection default: the unified sprint-beta SKILL.md (frontmatter
    // `name: <id>`) is embedded instead of the distilled digest (`# Skill: <id>`
    // provenance header). Either marker proves the FULL methodology shipped —
    // not just the compact gate.
    assert.ok(
      instructions.includes("name: grilling") || instructions.includes("# Skill: grilling"),
      "grilling protocol missing",
    );
    assert.ok(instructions.includes("frontier"), "interview protocol content missing");
    assert.ok(
      instructions.includes("name: gstack-plan-eng-review") || instructions.includes("# Skill: gstack-plan-eng-review"),
      "eng rigor missing",
    );
  });

  test("SUBAGENT phases carry DoD gates only â€” full digests stay out of orchestrator context", () => {
    const review = findPhase("ship", "review");
    assert.equal(review.execution, "subagent");
    const instructions = buildPhaseInstructions(review, makeCtx("ship"));
    assert.ok(instructions.includes("Skill gate: gstack-review"));
    assert.ok(instructions.includes("DoD: Scope Check line"));
    assert.ok(!instructions.includes("# Skill: gstack-review"), "full digest leaked into orchestrator instructions");
  });

  test("repeat delivery degrades to the DoD gate even on main phases", () => {
    const ctx = makeCtx("investigate", 3, ["gstack-investigate"]);
    const verify = findPhase("investigate", "verify");
    const instructions = buildPhaseInstructions(verify, ctx);
    assert.ok(instructions.includes("Skill gate: gstack-investigate"));
    assert.ok(!instructions.includes("# Skill: gstack-investigate"), "full digest re-delivered");
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
    assert.ok(instructions.includes(".gstack/plans/"));
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
    assert.ok(plan[0].task.includes(".gstack/plans/add-dark-mode-toggle.md"), "plan file reference missing");
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
    assert.deepEqual(doc.skills, ["gstack-document-release", "gstack-document-generate"]);
  });

  test("ship carries an update-docs phase with both doc skills", () => {
    const doc = findPhase("ship", "update-docs");
    assert.equal(doc.optional, true);
    assert.deepEqual(doc.skills, ["gstack-document-release", "gstack-document-generate"]);
  });

  test("document task chains generate pass and requires DOC REPORT + atomic docs commit", () => {
    const doc = findPhase("develop", "document");
    const plan = buildDeterministicPlan(doc, makeCtx("develop", 7));
    assert.ok(plan[0].task.includes("Diataxis coverage map"));
    assert.ok(plan[0].task.includes("DOC REPORT"));
    assert.ok(plan[0].task.includes("docs: prefix"));
  });

  test("ship digest mandates TODOS.md management and git best practices", () => {
    const digest = loadSkillDigest("gstack-ship")!;
    assert.ok(digest.includes("TODOS.md management (mandatory)"));
    assert.ok(digest.includes("Git best practices throughout"));
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
    assert.ok(plan[0].task.includes("Skill methodology: gstack-qa"), "skill digest not embedded in task");
  });

  test("chain steps also receive embedded skill methodology", () => {
    const rootCause = findPhase("investigate", "root-cause");
    assert.equal(rootCause.advance, "manual");
    const plan = buildDeterministicPlan(rootCause, makeCtx("investigate", 1));
    assert.deepEqual(plan.map((s) => s.agent), ["scout", "planner"]);
    assert.ok(plan[0].task.includes("Skill methodology: gstack-investigate"), "digest not embedded in chain step");
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

  test("writeRunReport persists a JSON report under .gstack/runs after a simulated run", () => {
    resetTelemetry();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-telemetry-"));
    try {
      beginRun("investigate");
      recordDelegatedStep({ phaseId: "reproduce", stepIndex: 0, agent: "worker", durationMs: 1000, timeoutClass: "default" });
      const filePath = writeRunReport(tmp, "investigate");
      assert.ok(filePath, "expected a written report");
      assert.ok(existsSync(filePath));
      assert.ok(filePath.includes(path.join(".gstack", "runs")));
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
      const digest = loadSkillDigest(id);
      if (digest) out.push(digest);
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
    assert.ok(qaPlan[0].task.includes("Skill methodology: gstack-qa (format-critical)"), "qa should be format-critical");
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
    assert.ok(shipPlan[0].task.includes("Skill methodology: gstack-ship (support)"), "ship should be support-class");
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
  test("GSTACK_PI_OPTIONAL_PHASES resolves ask/auto/skip with ask default", () => {
    const original = process.env.GSTACK_PI_OPTIONAL_PHASES;
    try {
      delete process.env.GSTACK_PI_OPTIONAL_PHASES;
      assert.equal(optionalPhases(), "ask");
      process.env.GSTACK_PI_OPTIONAL_PHASES = "auto";
      assert.equal(optionalPhases(), "auto");
      process.env.GSTACK_PI_OPTIONAL_PHASES = "skip";
      assert.equal(optionalPhases(), "skip");
      process.env.GSTACK_PI_OPTIONAL_PHASES = "garbage";
      assert.equal(optionalPhases(), "ask");
    } finally {
      if (original === undefined) delete process.env.GSTACK_PI_OPTIONAL_PHASES;
      else process.env.GSTACK_PI_OPTIONAL_PHASES = original;
    }
  });
});

// --- STEP 2g v2: optional-phase decision gate ---------------------------------
// The old flow prompted `ctx.ui.confirm` from the fire-and-forget background
// chain: the dialog fired mid-stream, stole editor focus, and defaulted to
// "Yes" on Enter — a user typing "no, skip QA" + Enter LAUNCHED the QA phase
// they were refusing. The fix parks the workflow at the optional phase and
// hands the Run/Skip/Abort decision to the foreground /gstack panel.

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
    assert.ok(plan[0].task.includes("Skill methodology: gstack-investigate"), "scout lost the full methodology");
    assert.ok(plan[1].task.includes("Skill methodology: gstack-fix-strategy"), "planner missing the fix-strategy digest");
    assert.ok(!plan[1].task.includes("gstack-investigate"), "planner must NOT receive the full investigation digest [E1]");
  });

  test("gstack-fix-strategy is a vendored registry skill with a small digest", () => {
    const info = getSkillInfo("gstack-fix-strategy");
    assert.ok(info);
    assert.equal(info.fullPath, null, "must be vendored (no upstream SKILL.md)");
    const digest = loadSkillDigest("gstack-fix-strategy");
    assert.ok(digest);
    assert.ok(digest.length < 800, `digest too large: ${digest.length} chars`);
    assert.ok(digest.includes("# Skill:"));
    assert.ok(info.dod.includes("DoD:") && /BP:/.test(info.dod));
  });

  test("chain steps without an override inherit the phase skills", () => {
    // The document phase has no per-step override: its steps keep gstack-document-*.
    const doc = findPhase("develop", "document");
    const plan = buildDeterministicPlan(doc, makeCtx("develop", 7));
    for (const step of plan) {
      assert.ok(
        step.task.includes("Skill methodology: gstack-document-release") || step.task.includes("Skill methodology: gstack-document-generate"),
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
    const tmp = mkdtempSync(path.join(os.tmpdir(), "gstack-skip-"));
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

  test("marker outside HANDOFF yields null + warning", () => {
    const warnings: string[] = [];
    const text = "symptoms described here\n" + VALID_MARKER + "\n(no handoff section)" + "\n(no handoff section)";
    assert.equal(parseRootCauseMarker(text, process.cwd(), (m) => warnings.push(m)), null);
    assert.ok(warnings.some((w) => w.includes("[skip] root-cause marker outside HANDOFF ignored")));
  });

  test("nonexistent cited files yield null", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "gstack-skip2-"));
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
    const tmp = mkdtempSync(path.join(os.tmpdir(), "gstack-collapse-"));
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
  test("GSTACK_PI_AUTO_GATE_VALIDATED defaults OFF and parses correctly", () => {
    const original = process.env.GSTACK_PI_AUTO_GATE_VALIDATED;
    try {
      delete process.env.GSTACK_PI_AUTO_GATE_VALIDATED;
      assert.equal(autoGateValidated(), false);
      process.env.GSTACK_PI_AUTO_GATE_VALIDATED = "1";
      assert.equal(autoGateValidated(), true);
      process.env.GSTACK_PI_AUTO_GATE_VALIDATED = "off";
      assert.equal(autoGateValidated(), false);
    } finally {
      if (original === undefined) delete process.env.GSTACK_PI_AUTO_GATE_VALIDATED;
      else process.env.GSTACK_PI_AUTO_GATE_VALIDATED = original;
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
    const keys = ["GSTACK_PI_TIMEOUT_EXPLORE", "GSTACK_PI_TIMEOUT_WORK", "GSTACK_PI_TIMEOUT_VERIFY", "GSTACK_PI_SUBAGENT_TIMEOUT"];
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    try {
      assert.equal(subagentTimeoutFor("explore"), 900 * 1000);
      assert.equal(subagentTimeoutFor("implement"), 1500 * 1000);
      assert.equal(subagentTimeoutFor("review"), 900 * 1000);
      assert.equal(subagentTimeoutFor("totally-unknown-phase"), 1200 * 1000);
      process.env.GSTACK_PI_TIMEOUT_WORK = "60";
      assert.equal(subagentTimeoutFor("implement"), 60 * 1000);
      process.env.GSTACK_PI_TIMEOUT_WORK = "garbage";
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
    const NAME = "GSTACK_PI_TEST_NUMBER";
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
    const NAME = "GSTACK_PI_LIVENESS_SEC";
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
    const NAME = "GSTACK_PI_MAX_RUN_TOKENS";
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
  // requested via GSTACK_PI_E2E_SPAWN=1. The crash-class regressions
  // (missing import, nested-scope ReferenceError) are fully covered by the
  // typecheck gate + the pure unit tests in this suite; this test guards
  // the RUNTIME path additionally.
  if (process.env.GSTACK_PI_E2E_SPAWN === "1") {
    test("spawns a real child, parses output, resolves without ReferenceErrors",
      { timeout: 300_000 },
      async () => {
        const cliPath = resolveCliPath();
        assert.ok(cliPath, "pi CLI not found in expected npm global locations");
        const tmpCwd = mkdtempSync(path.join(os.tmpdir(), "gstack-e2e-"));
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
    assert.match(text, /do NOT call gstack_advance/);
    assert.match(text, /only \/gstack next/);
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
    assert.equal(planFilePath("Add dark mode to the settings page"), ".gstack/plans/add-dark-mode-to-the-settings-page.md");
    assert.equal(planFilePath("???"), ".gstack/plans/plan.md");
  });

  test("parsePlanFileMarker accepts a valid path and strips punctuation", () => {
    assert.equal(parsePlanFileMarker("Did the plan. PLAN FILE: .gstack/plans/dark-mode-toggle.md"), ".gstack/plans/dark-mode-toggle.md");
    assert.equal(parsePlanFileMarker("PLAN FILE: `.gstack/plans/quoted.md`."), ".gstack/plans/quoted.md");
  });

  test("parsePlanFileMarker skips an echoed template fragment and takes the first VALID match (mindrun F3)", () => {
    // A model echoing the prompt's own "PLAN FILE: <path>" fragment before the
    // real marker must not shadow it: iterate all occurrences, first valid wins.
    const echoed = "As instructed I end with PLAN FILE: <path> — PLAN FILE: .gstack/plans/real-essence.md";
    assert.equal(parsePlanFileMarker(echoed), ".gstack/plans/real-essence.md");
    // Still null when every occurrence is invalid.
    assert.equal(parsePlanFileMarker("PLAN FILE: <path> and PLAN FILE: /etc/passwd"), null);
  });

  test("parsePlanFileMarker refuses traversal, wrong dir, and garbage", () => {
    assert.equal(parsePlanFileMarker("PLAN FILE: .gstack/plans/../secrets.md"), null);
    assert.equal(parsePlanFileMarker("PLAN FILE: /etc/passwd"), null);
    assert.equal(parsePlanFileMarker("PLAN FILE: .gstack/plans/UPPER_CASE.md"), null);
    assert.equal(parsePlanFileMarker("no marker at all"), null);
  });

  test("resolvePlanFilePath prefers the captured planFile over the legacy slug", () => {
    const ctx = makeCtx("develop", 3);
    ctx.state.planFile = ".gstack/plans/llm-chosen-name.md";
    assert.equal(resolvePlanFilePath(ctx), ".gstack/plans/llm-chosen-name.md");
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
    assert.ok(instructions.includes(".gstack/plans/"));
    assert.ok(!instructions.includes("PLAN FILE: .gstack/plans/add-dark-mode-toggle.md"), "instructions must not pin the legacy slug as THE path");
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
    assert.ok(prefix.includes("gstack_phase"), "tier-2 pointer missing");
  });

  test("active subagent phase: no contract (delegation results self-heal), pointer still present", () => {
    const prefix = buildResumeContext(makeCtx("investigate", 1).state); // root-cause = subagent
    assert.ok(!prefix.includes("## DELIVERABLE"), "subagent phases must not carry the main contract");
    assert.ok(prefix.includes("gstack_phase"));
  });

  test("parked gate: neither contract nor pointer", () => {
    const state = { ...makeCtx("investigate", 2).state, status: "awaiting_approval" as const };
    const prefix = buildResumeContext(state);
    assert.ok(prefix.includes("PARKED"));
    assert.ok(!prefix.includes("## DELIVERABLE"));
    assert.ok(!prefix.includes("gstack_phase"));
  });

  test("paused state: PAUSED, never the contradictory continue-working tail (mindrun F1)", () => {
    const state = { ...makeCtx("sprint", 7).state, status: "paused" as const, pausedReason: "branch-violation:devsecops-review on main" };
    const prefix = buildResumeContext(state);
    assert.ok(prefix.includes("PAUSED (branch-violation:devsecops-review on main)"));
    assert.ok(prefix.includes("PAUSED"), "paused posture must be stated");
    assert.ok(!prefix.includes("Continue working"), "paused prefix must not invite continued work");
    assert.ok(!prefix.includes("## DELIVERABLE"));
    assert.ok(!prefix.includes("gstack_phase"));
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
    assert.match(statusLineFor(state, sprint)!, /PARKED for approval.*\/gstack next/);
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
});
