// Workflow control: verdict ownership, human step gates, capped re-issues and
// the manual-advance escape hatch (2026-10 workflow-loop fixes).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createState, parkForUnreadableVerdict } from "../orchestrator/state.ts";
import { getWorkflow, getWorkflowIds } from "../orchestrator/workflows.ts";
import { initOrchestrator } from "../orchestrator/index.ts";
import { handleSprintPanel, manualAdvancePanel } from "../orchestrator/command.ts";
import { buildRecordContract, interpolateStepTask } from "../orchestrator/templates.ts";
import { reportCliPath, verdictKeysFor, writeStepRecord, readStepRecord } from "../orchestrator/records.ts";
import { invalidateRuntime, releasePhaseInFlight } from "../orchestrator/executor.ts";

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
    fs.writeFileSync(path.join(h.ctx.cwd, "understand.md"), "# direction\n");
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

describe("loop breakers", () => {
  test("a main step missing its signal re-issues at most twice, then parks for a human", async () => {
    const state = { ...createState("develop", "g"), phaseIndex: indexOf("develop", "plan"), stepIndex: 0, reissues: 2 };
    const h = harness(state);
    const res = await h.advance("no understand.md written");
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
    assert.ok(!offered.includes("Return phase with context"), "verify has no loopBackTo");
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
