// Workflow control: verdict ownership, human step gates, capped re-issues and
// the manual-advance escape hatch (2026-10 workflow-loop fixes).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createState, parkForUnreadableVerdict, routeVerdict, advancePhase, reissueGate, forceContinuePastGate, returnParkedWithContext } from "../orchestrator/state.ts";
import { computeNextSprintNumber } from "../orchestrator/sprint.ts";
import { ledgerPathFor } from "../orchestrator/ledger.ts";
import { syncAgents } from "../orchestrator/init.ts";
import { resolvePhaseEnabled, coherenceProblems } from "../orchestrator/enabled.ts";
import { gateInventory, configureGates } from "../orchestrator/gates.ts";
import { carryOverOpenQuestions } from "../orchestrator/templates.ts";
import { beginStepWatch, endStepWatch, feedWatchEvent } from "../orchestrator/stuck.ts";
import { parseHandoffVerdicts } from "../orchestrator/verdicts.ts";
import { getWorkflow, getWorkflowIds } from "../orchestrator/workflows.ts";
import { initOrchestrator } from "../orchestrator/index.ts";
import { handleSprintPanel, manualAdvancePanel } from "../orchestrator/command.ts";
import { buildRecordContract, interpolateStepTask, buildStepTask } from "../orchestrator/templates.ts";
import { reportCliPath, verdictKeysFor, writeStepRecord, readStepRecord, stepCompletionStatus } from "../orchestrator/records.ts";
import { invalidateRuntime, releasePhaseInFlight, executeCurrentPhase } from "../orchestrator/executor.ts";
import { sprintGateEphemerals, cleanupEphemeralArtifacts, runStartMs } from "../orchestrator/artifacts.ts";

// Fire-and-forget launches must never outlive this file (in-flight registry is module-level).
const prevDeterministic = process.env.KSTACK_PI_DETERMINISTIC;
process.env.KSTACK_PI_DETERMINISTIC = "off"; // no real subagent spawns from launched steps
after(() => {
  invalidateRuntime();
  for (const id of getWorkflowIds()) for (let i = 0; i < 32; i++) releasePhaseInFlight(id, i);
  if (prevDeterministic === undefined) delete process.env.KSTACK_PI_DETERMINISTIC;
  else process.env.KSTACK_PI_DETERMINISTIC = prevDeterministic;
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kstack-control-"));
let seq = 0;
function harness(initialState: unknown, ui: Record<string, any> = {}) {
  const entries: any[] = [{ type: "custom", customType: "kstack-wf-state", data: initialState }];
  const tools = new Map<string, any>();
  const sent: string[] = [];
  const notes: string[] = [];
  const pi: any = {
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: () => {},
    on: () => {},
    exec: async () => ({ stdout: "", stderr: "" }),
    appendEntry: (t: string, d: any) => entries.push({ type: "custom", customType: t, data: d }),
    sendUserMessage: (m: string) => sent.push(m),
  };
  const cwd = path.join(TMP, `t${seq++}`);
  fs.mkdirSync(cwd, { recursive: true });
  const ctx: any = {
    cwd,
    ui: { notify: (m: string) => notes.push(m), setStatus: () => {}, ...ui },
    sessionManager: { getEntries: () => entries },
  };
  initOrchestrator(pi);
  const advance = (summary = "done") =>
    tools.get("kstack_advance").execute("t", { summary, status: "completed" }, undefined, undefined, ctx);
  const last = () => entries.filter((e) => e.customType === "kstack-wf-state").at(-1)!.data;
  return { pi, ctx, sent, notes, advance, last };
}

const phaseOf = (wf: string, id: string) => getWorkflow(wf)!.phases.find((p) => p.id === id)!;
const indexOf = (wf: string, id: string) => getWorkflow(wf)!.phases.findIndex((p) => p.id === id);

describe("verdict ownership", () => {
  test("a build step owns no verdict; a walker owns only its lane key", () => {
    const implement = phaseOf("sprint", "implement");
    const step = (id: string) => implement.steps!.find((s) => s.id === id)!;
    assert.deepEqual(verdictKeysFor("sprint", implement, step("backend")), []);
    assert.deepEqual(verdictKeysFor("sprint", implement, step("be-walk")), ["be-walk"]);
    const devsecops = phaseOf("sprint", "devsecops-review");
    assert.deepEqual(verdictKeysFor("sprint", devsecops, devsecops.steps![1]), ["security-review", "severity"]);
  });

  test("record contracts advertise --verdict only to the steps that own one", () => {
    const implement = phaseOf("sprint", "implement");
    const scope = { workflowId: "sprint", phase: implement };
    const build = buildRecordContract(implement.steps!.find((s) => s.id === "backend")!, scope);
    assert.doesNotMatch(build, /--verdict [a-z]/, "no --verdict flag offered to a marker step");
    assert.match(build, /owns NO gate verdict/);
    const walk = buildRecordContract(implement.steps!.find((s) => s.id === "be-walk")!, scope);
    assert.match(walk, /--verdict be-walk==<pass\|fail>/);
    assert.ok(!walk.includes("fe-walk"), "a walker is never offered the other lane's key");
  });

  test("main-step record command pastes a quoted forward-slash CLI path", () => {
    const understand = phaseOf("sprint", "understand");
    const state = createState("sprint", "g");
    const task = interpolateStepTask(understand.steps![1].task, understand, 1, { state, git: { branch: "x" } as any, cwd: "." });
    const cli = reportCliPath();
    assert.ok(!cli.includes("\\"), "bash eats backslashes");
    assert.ok(task.includes(`"${cli}" --workflow "sprint"`), task);
  });

  test("kstack-report drops verdict keys outside KSTACK_VERDICT_KEYS and normalizes values", () => {
    const bash = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf-8" });
    if (bash.status !== 0) return; // no bash on this host
    const cwd = fs.mkdtempSync(path.join(TMP, "cli-"));
    const script = new URL("../runtime/bin/kstack-report", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const run = spawnSync(
      "bash",
      [script, "--workflow", "sprint", "--run-id", "r1", "--phase", "implement", "--step", "backend",
        "--marker", "BACKEND-DONE", "--verdict", "be-walk==pass", "--verdict", "ui==Pass."],
      { cwd, encoding: "utf-8", env: { ...process.env, KSTACK_VERDICT_KEYS: "ui" } },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /ignoring --verdict 'be-walk'/);
    const rec = readStepRecord(cwd, "sprint", "r1", "implement", "backend");
    assert.deepEqual(rec?.verdicts, { ui: "pass" });
    assert.deepEqual(rec?.markers, ["BACKEND-DONE"]);
  });

  test("a stray verdict on a non-verdict step is ledgered, never parks", async () => {
    const idx = indexOf("develop", "implement");
    const state = { ...createState("develop", "g"), phaseIndex: idx, stepIndex: 0, stepGates: true };
    const h = harness(state);
    writeStepRecord(h.ctx.cwd, { workflow: "develop", runId: state.runId!, phase: "implement", step: "build", summary: "built", markers: ["BUILD-DONE"], verdicts: { walkthrough: "pass" } });
    await h.advance("built");
    const s = h.last();
    assert.notEqual(s.status, "paused", "never parked for doing its work");
    assert.equal(s.verdictPark, undefined);
    assert.equal(s.stepIndex, 1);
    const ledger = fs.readdirSync(path.join(h.ctx.cwd, ".kstack", "ledger")).map((f) => fs.readFileSync(path.join(h.ctx.cwd, ".kstack", "ledger", f), "utf-8")).join("");
    assert.match(ledger, /ignored unowned verdict\(s\): walkthrough==pass/);
  });
});

describe("human step gates", () => {
  test("mid-phase: a completed step parks awaiting approval; a repeat advance is refused", async () => {
    const state = { ...createState("develop", "g"), phaseIndex: indexOf("develop", "plan"), stepIndex: 0, stepGates: true };
    const h = harness(state);
    fs.writeFileSync(path.join(h.ctx.cwd, "plan.md"), "# direction\n");
    const res = await h.advance("direction written");
    assert.match(res.content[0].text, /HUMAN-GATED/);
    const s = h.last();
    assert.equal(s.status, "awaiting_approval");
    assert.equal(s.stepGate, true);
    assert.equal(s.stepIndex, 1, "cursor already on the next step");
    assert.equal(h.sent.length, 0, "the next step is NOT delivered until the human approves");
    const again = await h.advance("sneaky");
    assert.match(again.content[0].text, /PARKED awaiting user approval/);
  });

  test("last step: the phase closes and still parks for approval", async () => {
    const state = { ...createState("investigate", "g"), phaseIndex: indexOf("investigate", "reproduce"), stepIndex: 1, stepGates: true };
    const h = harness(state);
    writeStepRecord(h.ctx.cwd, { workflow: "investigate", runId: state.runId!, phase: "reproduce", step: "repro", summary: "repro", markers: ["REPRO-DONE"] });
    await h.advance("reproduced");
    const s = h.last();
    assert.equal(s.phaseIndex, indexOf("investigate", "root-cause"));
    assert.equal(s.status, "awaiting_approval");
    assert.equal(s.stepGate, true);
  });

  test("without stepGates the same step advances straight through", async () => {
    const state = { ...createState("investigate", "g"), phaseIndex: indexOf("investigate", "reproduce"), stepIndex: 1 };
    const h = harness(state);
    writeStepRecord(h.ctx.cwd, { workflow: "investigate", runId: state.runId!, phase: "reproduce", step: "repro", summary: "repro", markers: ["REPRO-DONE"] });
    await h.advance("reproduced");
    assert.equal(h.last().status, "active");
  });
});

describe("workflow entry + artifact lifetime", () => {
  test("no programmatic start tool: workflows start only through /kstack", () => {
    const names: string[] = [];
    initOrchestrator({ registerTool: (t: any) => names.push(t.name), registerCommand: () => {}, on: () => {} } as any);
    assert.ok(!names.includes("kstack_start"), names.join(","));
    assert.ok(names.includes("kstack_advance"));
  });

  test("QA + devsecops reports become ephemerals once the sprint number is assigned", async () => {
    const idx = indexOf("sprint", "user-story");
    const state = { ...createState("sprint", "g"), phaseIndex: idx };
    const h = harness(state);
    await executeCurrentPhase(h.pi, h.ctx, state, { execGit: async () => ({ stdout: "", stderr: "", code: 1 }) as any });
    const s = h.last();
    assert.equal(s.sprintNumber, 1);
    for (const f of sprintGateEphemerals(1)) assert.ok(s.ephemeralArtifacts.includes(f), `${f} must be deleted at terminal status`);
    assert.ok(s.ephemeralArtifacts.includes("qa-artifact_01.md"));
    assert.ok(s.ephemeralArtifacts.includes("devsecops/security-review-artifact_01.md"));
    assert.ok(s.ephemeralArtifacts.includes("tasks.md"), "the base sprint ephemerals stay registered");
  });
});

describe("skill runtime paths", () => {
  const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const skills = fs.readdirSync(path.join(root, "skills")).map((d) => path.join(root, "skills", d, "SKILL.md")).filter((f) => fs.existsSync(f));

  test("the extension exports KSTACK_EXTENSION_DIR (forward slashes) for skills", () => {
    initOrchestrator({ registerTool() {}, registerCommand() {}, on() {} } as any);
    const dir = process.env.KSTACK_EXTENSION_DIR!;
    assert.ok(dir && !dir.includes("\\"), dir);
    assert.ok(fs.existsSync(path.join(dir, "runtime", "bin")));
  });

  test("every $KSTACK_EXTENSION_DIR/runtime path a skill names exists; no per-user absolute paths", () => {
    for (const f of skills) {
      const text = fs.readFileSync(f, "utf-8");
      assert.doesNotMatch(text, /[A-Za-z]:\/Users\//, `${f} hard-codes a per-user absolute path`);
      for (const m of text.matchAll(/\$KSTACK_EXTENSION_DIR\/((?:runtime|skills)\/[\w./-]+)/g)) {
        const p = path.join(root, m[1].replace(/[.\/]+$/, ""));
        assert.ok(fs.existsSync(p) || fs.existsSync(`${p}.exe`), `${path.basename(path.dirname(f))}: ${m[1]} does not exist`);
      }
    }
  });

  test("skill folder convention: only references/ scripts/ assets/; run paths via $KSTACK_EXTENSION_DIR", () => {
    for (const f of skills) {
      const dir = path.dirname(f);
      const id = path.basename(dir);
      const subdirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      assert.deepEqual(subdirs.filter((d) => !["references", "scripts", "assets"].includes(d)), [], `${id}: unexpected subfolder`);
      const docs = [f, ...(subdirs.includes("references") ? fs.readdirSync(path.join(dir, "references"), { recursive: true }).map(String).filter((x) => x.endsWith(".md")).map((x) => path.join(dir, "references", x)) : [])];
      for (const doc of docs) {
        const text = fs.readFileSync(doc, "utf-8");
        assert.doesNotMatch(text, /<skill>|<skill-base-dir>/, `${id}: placeholder path in ${path.basename(doc)} — write $KSTACK_EXTENSION_DIR/skills/${id}/...`);
        // A bare `bash scripts/x` / `node scripts/x` resolves inside the user's project, not the skill.
        assert.doesNotMatch(text, /(?:bash|node|sh)\s+["']?scripts\//, `${id}: bare scripts/ path in ${path.basename(doc)}`);
      }
      assert.doesNotMatch(fs.readFileSync(f, "utf-8"), /\.pi\/skills\//, `${id}: .pi/skills/ path in SKILL.md`);
    }
  });
});

describe("architect review cleanup", () => {
  test("every review round of THIS sprint's architect artifact is deleted, nothing else", () => {
    const cwd = fs.mkdtempSync(path.join(TMP, "arch-"));
    for (const f of ["software-architect-artifact_01_1.md", "software-architect-artifact_01_12.md", "software-architect-artifact_02_1.md", "system-design_01.md"]) {
      fs.writeFileSync(path.join(cwd, f), "x");
    }
    const res = cleanupEphemeralArtifacts(cwd, sprintGateEphemerals(1));
    assert.deepEqual(res.failed, []);
    assert.deepEqual(fs.readdirSync(cwd).sort(), ["software-architect-artifact_02_1.md", "system-design_01.md"]);
    assert.ok(res.deleted.includes("software-architect-artifact_01_12.md"));
  });
});

describe("planning interactivity", () => {
  test("open questions carry over from develop's plan.evolve (not only sprint's understand)", () => {
    const state = { ...createState("develop", "g"), results: { "plan.evolve": { status: "completed" as const, summary: "done\nOPEN QUESTIONS:\n- auth provider?\n- offline mode?" } } };
    const out = carryOverOpenQuestions({ state });
    assert.match(out, /- auth provider\?/);
    assert.match(out, /- offline mode\?/);
  });

  test("a main-step watch never trips on long conversations (no turn/token cap)", () => {
    beginStepWatch("plan", "interrogate");
    try {
      for (let i = 0; i < 200; i++) {
        const v = feedWatchEvent({ type: "message_end", message: { role: "assistant", usage: { input: 5000, output: 2000 } } } as any);
        assert.equal(v?.trip, undefined, `tripped at turn ${i}`);
        feedWatchEvent({ type: "message_end", message: { role: "user" } } as any);
      }
    } finally {
      endStepWatch();
    }
  });
});

describe("verdict routing consistency", () => {
  test("investigate.verify routes persists→fix, refuted→root-cause, verified→advance", () => {
    const verify = phaseOf("investigate", "verify");
    assert.deepEqual(routeVerdict("investigate", "verify", { verdicts: { outcome: "persists" } }, { phase: verify }), { kind: "loop-back", target: "fix" });
    assert.deepEqual(routeVerdict("investigate", "verify", { verdicts: { outcome: "refuted" } }, { phase: verify }), { kind: "loop-back", target: "root-cause" });
    assert.equal(routeVerdict("investigate", "verify", { verdicts: { outcome: "verified" } }, { phase: verify }).kind, "advance");
  });

  test("the legacy HANDOFF parser knows the sprint lane keys", () => {
    const out = parseHandoffVerdicts("## HANDOFF\nbe-walk == pass\nfe-walk == fail\n");
    assert.deepEqual(out.parsed?.verdicts, { "be-walk": "pass", "fe-walk": "fail" });
  });
});

describe("loop breakers", () => {
  test("a main step missing its signal re-issues at most twice, then parks for a human", async () => {
    const state = { ...createState("develop", "g"), phaseIndex: indexOf("develop", "plan"), stepIndex: 0, reissues: 2 };
    const h = harness(state);
    const res = await h.advance("no plan.md written");
    const s = h.last();
    assert.equal(s.status, "paused");
    assert.match(s.pausedReason, /^signal-missing:plan\.evolve/);
    assert.match(res.content[0].text, /parked/);
  });

  test("verdict-park panel serves non-sprint workflows with step-level choices", async () => {
    let offered: string[] = [];
    const idx = indexOf("investigate", "verify");
    const parked = parkForUnreadableVerdict({ ...createState("investigate", "g"), phaseIndex: idx }, "verify", "no-verdict");
    const h = harness(parked, { select: async (_t: string, opts: string[]) => { offered = opts; return undefined; } });
    const handled = await handleSprintPanel(parked, h.ctx, h.pi);
    assert.equal(handled, true, "never falls through to the generic Resume");
    assert.ok(offered.includes("Set verdict manually…"));
    assert.ok(offered.includes("Re-run the step"));
    assert.ok(offered.includes("Return phase with context"), "verify returns through its loopBackOn edges");
  });

  test("manual advance completes the current step on the human's word (verdict chosen by the user)", async () => {
    const idx = indexOf("investigate", "verify");
    const state = { ...createState("investigate", "g"), phaseIndex: idx, stepIndex: 0, status: "paused" as const, pausedReason: "signal-missing:verify.verify:outcome" };
    const picks = ['Complete step "verify" (Fix Verification) as done', "verified"];
    const h = harness(state, {
      select: async (_t: string, opts: string[]) => {
        const want = picks.shift()!;
        return opts.find((o) => o.startsWith(want.slice(0, 20))) ?? want;
      },
    });
    await manualAdvancePanel(state, h.ctx, h.pi);
    const s = h.last();
    assert.equal(s.status, "active");
    assert.equal(s.phaseIndex, idx + 1, "verified routes forward");
    assert.equal(readStepRecord(h.ctx.cwd, "investigate", state.runId!, "verify", "verify")?.verdicts.outcome, "verified");
  });

  test("manual advance can skip to the next phase from any state", async () => {
    const idx = indexOf("develop", "plan");
    const state = { ...createState("develop", "g"), phaseIndex: idx, stepIndex: 2 };
    const h = harness(state, {
      select: async (_t: string, opts: string[]) => opts.find((o) => o.startsWith("Advance to the next phase")),
      confirm: async () => true,
    });
    await manualAdvancePanel(state, h.ctx, h.pi);
    const s = h.last();
    assert.equal(s.phaseIndex, idx + 1);
    assert.equal(s.stepIndex, undefined);
    assert.equal(s.results.plan.status, "completed");
  });
});

describe("2026-10 workflow audit fixes", () => {
  test("a loop-back carries the gate's record evidence as RETRY CONTEXT feedback", () => {
    const wf = getWorkflow("develop")!;
    const idx = indexOf("develop", "implement");
    const cwd = fs.mkdtempSync(path.join(TMP, "fb-"));
    const done = { status: "completed" as const, summary: "s" };
    const state = { ...createState("develop", "g"), phaseIndex: idx, stepIndex: 3, results: { "implement.build": done, "implement.walkthrough": done, "implement.ui-check": done } };
    writeStepRecord(cwd, { workflow: "develop", runId: state.runId!, phase: "implement", step: "walkthrough", summary: "Done-when #2 unmet", verdicts: { walkthrough: "fail" }, evidence: ["src/a.ts:12 — null not handled — guard it"] });
    writeStepRecord(cwd, { workflow: "develop", runId: state.runId!, phase: "implement", step: "ui-check", summary: "ui fine", verdicts: { ui: "pass" }, evidence: ["looks fine"] });
    const next = advancePhase(state, "implement", { status: "completed", summary: "x" }, wf.phases.length, { phases: wf.phases, cwd });
    assert.equal(next.phaseIndex, idx, "walkthrough==fail self-loops implement");
    assert.match(next.retryContext!.feedback, /src\/a\.ts:12 — null not handled/);
    assert.doesNotMatch(next.retryContext!.feedback, /looks fine/, "a passing lane's evidence is not a blocker");
    assert.match(buildRecordContract(phaseOf("develop", "implement").steps![1], { workflowId: "develop", phase: phaseOf("develop", "implement") }), /--evidence/);
  });

  test("a re-run phase clears its stale records and hands RETRY CONTEXT to the delegated worker", async () => {
    process.env.KSTACK_PI_DETERMINISTIC = "on";
    try {
      const idx = indexOf("develop", "implement");
      const state = { ...createState("develop", "g"), phaseIndex: idx, retryContext: { targetPhaseId: "implement", attempt: 2, maxAttempts: 4, feedback: "FIX-ME-BLOCKER" } };
      const h = harness(state);
      writeStepRecord(h.ctx.cwd, { workflow: "develop", runId: state.runId!, phase: "implement", step: "walkthrough", summary: "old", verdicts: { walkthrough: "fail" } });
      const tasks: string[] = [];
      await executeCurrentPhase(h.pi, h.ctx, state as any, {
        execGit: async () => ({ code: 1, stdout: "", stderr: "" }),
        spawnFn: async (req) => {
          tasks.push(req.task);
          return { ok: true, output: "done", rawOutput: "done", exitCode: 0, durationMs: 1 } as any;
        },
      });
      assert.equal(readStepRecord(h.ctx.cwd, "develop", state.runId!, "implement", "walkthrough"), null, "the rejected attempt's record must not satisfy the re-run");
      assert.match(tasks[0] ?? "", /## RETRY CONTEXT \(attempt 2\/4\)[\s\S]*FIX-ME-BLOCKER/);
    } finally {
      process.env.KSTACK_PI_DETERMINISTIC = "off";
    }
  });

  test("sprint implement on main is not a branch violation (its self-loop is not a diff audit)", async () => {
    const idx = indexOf("sprint", "implement");
    const state = { ...createState("sprint", "g"), phaseIndex: idx, sprintNumber: 1, vars: { scope: "mixed" } };
    const h = harness(state);
    await executeCurrentPhase(h.pi, h.ctx, state as any, {
      execGit: async (_c, args) => ({ code: 0, stdout: args[0] === "branch" ? "main\n" : "", stderr: "" }),
    });
    assert.doesNotMatch(h.last().pausedReason ?? "", /^branch-violation:/);
    assert.equal(h.sent.length, 1, "the backend step was delivered");
  });

  test("investigate.verify (loopBackOn only): re-issue, accept and return follow its real edges", () => {
    const phases = getWorkflow("investigate")!.phases;
    const ceiling = phaseOf("investigate", "verify").maxAttempts!;
    const exhausted = { ...createState("investigate", "g"), phaseIndex: indexOf("investigate", "verify"), status: "paused" as const, pausedReason: `loop-exhausted:fix after ${ceiling} runs`, attempts: { "verify->fix": ceiling, "verify->root-cause": 1 } };
    assert.equal(reissueGate(exhausted, phases).attempts!["verify->fix"], ceiling - 2, "+1 verified attempt restores the fix edge");
    assert.deepEqual(forceContinuePastGate(exhausted, phases).attempts, {}, "regression-qa → fix gets a fresh budget");
    const parked = { ...exhausted, verdictPark: "verify", pausedReason: "verdict-unreadable:verify:unroutable", pendingVerdict: { phaseId: "verify", parsed: { verdicts: { outcome: "refuted" } }, excerpt: "" } };
    assert.equal(returnParkedWithContext(parked, phases, "look again", TMP)?.phaseIndex, indexOf("investigate", "root-cause"));
  });

  test("finishing the last phase through kstack_advance deletes the run's ephemerals", async () => {
    const last = getWorkflow("investigate")!.phases.length - 1;
    const state = { ...createState("investigate", "g"), phaseIndex: last, stepIndex: 0 };
    const h = harness(state);
    fs.writeFileSync(path.join(h.ctx.cwd, "bug-report.md"), "x");
    writeStepRecord(h.ctx.cwd, { workflow: "investigate", runId: state.runId!, phase: "retro", step: "retro", summary: "r", markers: ["RETRO-DONE"] });
    await h.advance("retro done");
    assert.equal(h.last().status, "completed");
    assert.equal(fs.existsSync(path.join(h.ctx.cwd, "bug-report.md")), false);
  });

  test("sprint numbering counts S4 durables and archive slots (user-story is ephemeral)", () => {
    const cwd = fs.mkdtempSync(path.join(TMP, "num-"));
    const slot = path.join(cwd, ".kstack", "workflows", "sprint", "sprint_01");
    fs.mkdirSync(slot, { recursive: true });
    fs.writeFileSync(path.join(slot, "system-design_01.md"), "x");
    fs.writeFileSync(path.join(slot, "ADR-log_01.md"), "x");
    assert.deepEqual(computeNextSprintNumber(cwd), { next: 2, anomaly: null });
    fs.mkdirSync(path.join(cwd, ".kstack", "workflows", "sprint", "sprint_04"));
    assert.equal(computeNextSprintNumber(cwd).next, 5, "an emptied slot still reserves its number");
  });

  test("kstack-report appends to the orchestrator's ledger file (ISO runId with a dot)", () => {
    if (spawnSync("bash", ["-c", "echo ok"], { encoding: "utf-8" }).status !== 0) return; // no bash on this host
    const cwd = fs.mkdtempSync(path.join(TMP, "cli-"));
    const runId = "2026-10-19T00:00:00.123Z-abcd";
    const script = new URL("../runtime/bin/kstack-report", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const run = spawnSync("bash", [script, "--workflow", "develop", "--run-id", runId, "--phase", "implement", "--step", "build", "--marker", "BUILD-DONE"], { cwd, encoding: "utf-8" });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(readStepRecord(cwd, "develop", runId, "implement", "build"), "record still readable");
    assert.deepEqual(fs.readdirSync(path.join(cwd, ".kstack", "ledger")), [path.basename(ledgerPathFor(cwd, { workflowId: "develop", runId }))]);
  });


});

describe("2026-10 workflow batch 2", () => {
  test("failFast: a failed walkthrough skips ui-check and loops implement at once", async () => {
    const idx = indexOf("develop", "implement");
    const state = { ...createState("develop", "g"), phaseIndex: idx, stepIndex: 2, results: { "implement.build": { status: "completed" as const, summary: "b" }, "implement.design": { status: "completed" as const, summary: "d" } } };
    const h = harness(state);
    writeStepRecord(h.ctx.cwd, { workflow: "develop", runId: state.runId!, phase: "implement", step: "walkthrough", summary: "Done-when #1 unmet", verdicts: { walkthrough: "fail" }, evidence: ["a.ts:3 — missing guard"] });
    releasePhaseInFlight("develop", idx); // an earlier test's fire-and-forget launch of this phase
    await h.advance("walked: fail");
    const s = h.last();
    assert.equal(s.phaseIndex, idx, "looped back to implement");
    assert.equal(s.retryContext?.targetPhaseId, "implement");
    assert.match(s.retryContext!.feedback, /a\.ts:3 — missing guard/);
  });

  test("severity is owned by the security step only", () => {
    const devsecops = phaseOf("sprint", "devsecops-review");
    assert.deepEqual(verdictKeysFor("sprint", devsecops, devsecops.steps![0]), ["code-review"]);
    assert.deepEqual(verdictKeysFor("sprint", devsecops, devsecops.steps![1]), ["security-review", "severity"]);
  });

  test("taste runs as its own design step after the frontend build — never as a build digest", () => {
    for (const [wf, after, walker] of [["develop", "build", "walkthrough"], ["sprint", "frontend", "fe-walk"]]) {
      const ids = phaseOf(wf, "implement").steps!.map((s) => s.id);
      assert.equal(ids.indexOf("design"), ids.indexOf(after) + 1, `${wf}: design follows ${after}`);
      assert.equal(ids.indexOf(walker), ids.indexOf("design") + 1, `${wf}: ${walker} judges the designed surface`);
      const design = phaseOf(wf, "implement").steps!.find((s) => s.id === "design")!;
      assert.equal(design.skill, "kstack-design-taste-frontend");
      assert.deepEqual(design.skipWhen, { var: "scope", equals: "backend" });
      assert.ok(!phaseOf(wf, "implement").steps!.some((s) => s.ambientSkills?.includes("kstack-design-taste-frontend")));
    }
  });

  test("delegated skill digests name their folder so relative scripts/references resolve", () => {
    const design = phaseOf("develop", "implement").steps!.find((s) => s.id === "design")!;
    assert.match(buildStepTask(design), /Skill folder — .*skills\/kstack-design-taste-frontend/);
  });

  test("regression QA runs when the fix was committed during the run", () => {
    const phase = phaseOf("investigate", "regression-qa");
    const git = { branch: "b", hasUncommittedChanges: false, hasStagedChanges: false, aheadOfRemote: 0, behindRemote: 0, isMainBranch: false, recentCommitSubject: "", head: "bbbbbbb" };
    const at = (baseHead: string) => resolvePhaseEnabled(phase, { state: { ...createState("investigate", "g"), baseHead }, git, cwd: TMP }).enabled;
    assert.equal(at("aaaaaaa"), "on", "HEAD moved since run start");
    assert.equal(at("bbbbbbb"), "off", "clean tree, no new commits");
  });

  test("QA steps run as qa-engineer with a named output mode; no parallel question", () => {
    for (const [wf, ph, mode] of [["develop", "qa-browsing", "record"], ["review", "qa-browsing", "record"], ["sprint", "qa-browsing", "record"], ["investigate", "regression-qa", "case-file"]]) {
      const step = phaseOf(wf, ph).steps![0];
      assert.equal(step.agent, "qa-engineer", `${wf}.${ph}`);
      assert.match(step.task, new RegExp(`Output mode: ${mode}`), `${wf}.${ph}`);
    }
    assert.ok(!getWorkflow("sprint")!.asks!.some((a) => a.var === "parallel"));
  });

  test("syncAgents adds missing profiles, backs up and replaces outdated ones, ignores CRLF-only drift", () => {
    const src = fs.mkdtempSync(path.join(TMP, "agents-src-"));
    const dst = fs.mkdtempSync(path.join(TMP, "agents-dst-"));
    fs.writeFileSync(path.join(src, "a.md"), "A2\n");
    fs.writeFileSync(path.join(src, "b.md"), "B\n");
    fs.writeFileSync(path.join(src, "c.md"), "C\n");
    fs.writeFileSync(path.join(dst, "a.md"), "A1 hand-tuned\n");
    fs.writeFileSync(path.join(dst, "c.md"), "C\r\n");
    const res = syncAgents(src, dst);
    assert.deepEqual(res.added, ["b.md"]);
    assert.deepEqual(res.updated, ["a.md"]);
    assert.equal(fs.readFileSync(path.join(dst, "a.md"), "utf8"), "A2\n");
    assert.equal(fs.readFileSync(res.backups[0], "utf8"), "A1 hand-tuned\n", "the replaced copy survives");
    assert.ok(!res.backups[0].endsWith(".md"), "a backup is never discovered as an agent");
    assert.deepEqual(syncAgents(src, dst), { added: [], updated: [], backups: [] }, "idempotent");
  });
});

describe("per-run cross-run artifacts (discover / audit)", () => {
  test("a previous run's direction file never completes this run's step; a new one does", () => {
    const cwd = fs.mkdtempSync(path.join(TMP, "disc-"));
    const dir = path.join(cwd, ".kstack", "discover");
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, "direction-old-idea.md");
    fs.writeFileSync(old, "x");
    const past = new Date(Date.now() - 3600_000);
    fs.utimesSync(old, past, past);
    const state = createState("discover", "g");
    const phase = phaseOf("discover", "session");
    assert.equal(stepCompletionStatus(state, phase, phase.steps![0], cwd).kind, "signal-missing");
    fs.writeFileSync(path.join(dir, "direction-offline-first-sync.md"), "y");
    assert.equal(stepCompletionStatus(state, phase, phase.steps![0], cwd).kind, "ok");
  });
});

describe("QA baseline findings (2026-10-19 live runs)", () => {
  test("runIds are filesystem-safe and still carry their start time", () => {
    const { runId } = createState("develop", "g");
    assert.match(runId!, /^[\w-]+$/, "no ':' or '.' — agents paste it into paths");
    assert.ok(Math.abs(runStartMs(runId)! - Date.now()) < 5000);
    assert.equal(runStartMs("2026-10-19T01:28:10.524Z-mcwd"), Date.parse("2026-10-19T01:28:10.524Z"), "legacy ids still parse");
  });

  test("record contracts single-quote values (double quotes let the shell eat $amounts)", () => {
    const step = phaseOf("develop", "qa-browsing").steps![0];
    const contract = buildRecordContract(step, { workflowId: "develop", phase: phaseOf("develop", "qa-browsing") });
    assert.match(contract, /--summary '<2-3 sentence outcome>'/);
    assert.match(contract, /SINGLE quotes/);
  });
});

describe("needs-a-person rule", () => {
  test("every workflow is coherent: no interviewing step is delegated to a headless subagent", () => {
    for (const id of getWorkflowIds()) assert.deepEqual(coherenceProblems(getWorkflow(id)!).filter((p) => /needs the user/.test(p)), [], id);
    const bad = { id: "x", name: "x", description: "x", phases: [{ id: "p", name: "p", execution: "main" as const, steps: [{ id: "ask", execution: "subagent" as const, needsUser: true as const, task: "t" }] }] };
    assert.match(coherenceProblems(bad).join("\n"), /"p\.ask" needs the user but is delegated/);
  });

  test("interactive phases are never offered auto; detect rows replace the misleading 'human'", () => {
    const rows = gateInventory(getWorkflow("develop")!);
    const plan = rows.find((r) => r.phaseId === "plan")!;
    const qa = rows.find((r) => r.phaseId === "qa-browsing")!;
    const ship = rows.find((r) => r.phaseId === "ship")!;
    assert.equal(plan.interactive, true);
    assert.equal(qa.detect, true);
    assert.equal(ship.warning, true, "ship's push is flagged on its detect row");
    let captured: any;
    void configureGates(rows, { ui: { custom: (f: any) => new Promise((r) => { captured = f(null, null, null, r); }) } } as any);
    const items = captured.items as Array<{ id: string; values: string[]; currentValue: string }>;
    assert.deepEqual(items.find((i) => i.id === "plan")!.values, ["human"]);
    assert.deepEqual(items.find((i) => i.id === "qa-browsing")!.values, ["detect", "run", "skip"]);
    assert.equal(items.find((i) => i.id === "qa-browsing")!.currentValue, "detect");
    captured.handleInput("\x1b");
  });
});

describe("design step timeout", () => {
  test("the delegated design step spawns with its own 60-min limit; the env var overrides it", async () => {
    process.env.KSTACK_PI_DETERMINISTIC = "on";
    try {
      const idx = indexOf("develop", "implement");
      const run = async () => {
        const state = { ...createState("develop", "g"), phaseIndex: idx, stepIndex: 1, vars: { scope: "frontend" } };
        const h = harness(state);
        releasePhaseInFlight("develop", idx);
        let timeoutMs: number | undefined;
        await executeCurrentPhase(h.pi, h.ctx, state as any, {
          execGit: async () => ({ code: 1, stdout: "", stderr: "" }),
          spawnFn: async (req) => { timeoutMs = req.timeoutMs; assert.equal(req.env?.TASTE_SKILL_WORKDIR, `.kstack/runs/${state.runId}/design`); return { ok: true, output: "d", rawOutput: "d", exitCode: 0, durationMs: 1 } as any; },
        });
        return timeoutMs;
      };
      assert.equal(await run(), 3600_000);
      process.env.KSTACK_PI_TIMEOUT_STEP_DESIGN = "120";
      assert.equal(await run(), 120_000);
    } finally {
      delete process.env.KSTACK_PI_TIMEOUT_STEP_DESIGN;
      process.env.KSTACK_PI_DETERMINISTIC = "off";
    }
  });
});
