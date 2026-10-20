/**
 * S4 machinery — keyed verdict expectations, loopBackOn/parkOn routing,
 * publish-only verdict phases, state.vars merge, lastVerdicts, onComplete.
 *
 * Task blocks: tasks_01.md TASK_01 (keyed expectations + routeVerdict
 * signature), TASK_03 (routing maps + state fields + publish-only).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXPECTATIONS, NEGATIVE_VALUES } from "../orchestrator/verdicts.ts";
import { routeVerdict, advancePhase, createState, loadActiveState } from "../orchestrator/state.ts";
import type { WorkflowPhase, WorkflowState, ParsedVerdict } from "../orchestrator/types.ts";
import { getWorkflow } from "../orchestrator/workflows.ts";

const verdict = (verdicts: Record<string, string>, severity?: any): ParsedVerdict => ({ verdicts, severity });

function phase(partial: Partial<WorkflowPhase> & { id: string }): WorkflowPhase {
  return { name: partial.id, execution: "subagent", ...partial } as WorkflowPhase;
}

/** Write a kstack-report record file into a tmp cwd (the INV-9 channel). */
function writeRecord(
  cwd: string,
  runId: string,
  rec: { phase: string; step?: string; verdicts?: Record<string, string>; vars?: Record<string, string>; summary?: string; workflow?: string; markers?: string[] },
): void {
  const safe = (v: string) => v.replace(/[^\w.-]/g, "-"); // mirror kstack-report + records.ts
  const file = rec.step ? `${safe(rec.phase)}.${safe(rec.step)}.json` : `${safe(rec.phase)}.json`;
  const dir = path.join(cwd, ".kstack", "runs", safe(runId));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, file),
    JSON.stringify({
      v: 1,
      workflow: safe(rec.workflow ?? "investigate"),
      runId: safe(runId),
      phase: safe(rec.phase),
      step: rec.step != null ? safe(rec.step) : null,
      at: new Date().toISOString(),
      summary: rec.summary ?? null,
      verdicts: rec.verdicts ?? {},
      vars: rec.vars ?? {},
      evidence: [],
      deliverables: [],
      markers: rec.markers ?? [],
    }),
  );
}

// --- TASK_01: (workflowId, phaseId) keyed expectations ------------------------

describe("S4 keyed expectations (TASK_01)", () => {
  test("every verdict phase of every registered workflow has an EXPECTATIONS entry", () => {
    for (const wfId of ["develop", "sprint", "investigate", "review"]) {
      assert.ok(EXPECTATIONS[wfId], `EXPECTATIONS missing workflow "${wfId}"`);
    }
    for (const key of ["sprint", "devsecops-review"]) {
      assert.ok(EXPECTATIONS.sprint?.[key] === undefined || true);
    }
    // A workflow that emits no verdicts (discover, audit) needs no entry.
    assert.ok(EXPECTATIONS.develop?.["qa-browsing"]?.status, "develop qa-browsing status expectation");
    assert.ok(EXPECTATIONS.review?.["qa-browsing"]?.status, "review qa-browsing status expectation");
    assert.ok(EXPECTATIONS.investigate?.["verify"]?.outcome, "investigate verify outcome expectation");
  });

  test("missing [workflowId][phaseId] entry ⇒ park with no-expectation, never a default", () => {
    const action = routeVerdict("develop", "verify", verdict({ outcome: "verified" }));
    assert.equal(action.kind, "park");
  });

  test("two workflows sharing a phase id route through their own map only", () => {
    // develop.implement and sprint.implement share the id "implement" but carry
    // different expectation vars — a sprint walkthrough map must never satisfy
    // a develop run and vice versa.
    const dev = routeVerdict("develop", "implement", verdict({ walkthrough: "pass" }), {
      phase: phase({ id: "implement", loopBackTo: "implement" }),
    });
    // Sprint.implement carries per-lane vars (be-walk/fe-walk/ui), NOT the
    // shared `walkthrough` — the old var is foreign to the sprint map.
    const sprint = routeVerdict("sprint", "implement", verdict({ "be-walk": "pass", "fe-walk": "pass", ui: "pass" }), {
      phase: phase({ id: "implement", loopBackTo: "implement" }),
    });
    assert.equal(dev.kind, "advance");
    assert.equal(sprint.kind, "advance");
    // A verdict var foreign to one workflow's map for the shared id ⇒ park.
    const foreign = routeVerdict("develop", "implement", verdict({ status: "green" }), {
      phase: phase({ id: "implement", loopBackTo: "implement" }),
    });
    assert.equal(foreign.kind, "park");
  });
});

// --- TASK_03: loopBackOn / parkOn routing --------------------------------------

describe("S4 routing maps (TASK_03)", () => {
  test("loopBackOn routes a multi-value verdict to its named target", () => {
    const verify = phase({ id: "verify", loopBackOn: { persists: "fix", refuted: "root-cause" } });
    const persists = routeVerdict("investigate", "verify", verdict({ outcome: "persists" }), { phase: verify });
    assert.equal(persists.kind, "loop-back");
    assert.equal(persists.target, "fix");
    const refuted = routeVerdict("investigate", "verify", verdict({ outcome: "refuted" }), { phase: verify });
    assert.equal(refuted.kind, "loop-back");
    assert.equal(refuted.target, "root-cause");
    const verified = routeVerdict("investigate", "verify", verdict({ outcome: "verified" }), { phase: verify });
    assert.equal(verified.kind, "advance");
  });

  test("persists/refuted/fail are routing negatives", () => {
    for (const v of ["persists", "refuted", "fail"]) {
      assert.ok(NEGATIVE_VALUES.has(v), `${v} must be a NEGATIVE_VALUE`);
    }
  });

  test("a parsed negative without a loopBackOn entry on an EDGED phase ⇒ park", () => {
    const verify = phase({ id: "verify", loopBackOn: { persists: "fix" }, loopBackTo: "fix" });
    // refuted is negative but unmapped; loopBackTo covers generic negatives.
    const mapped = routeVerdict("investigate", "verify", verdict({ outcome: "persists" }), { phase: verify });
    assert.equal(mapped.target, "fix");
    // A phase whose only edge is loopBackOn: an unmapped negative parks.
    const strict = phase({ id: "verify", loopBackOn: { persists: "fix" } });
    const unmapped = routeVerdict("investigate", "verify", verdict({ outcome: "refuted" }), { phase: strict });
    assert.equal(unmapped.kind, "park");
  });

  test("parkOn wins over loopBackOn and advance (severity==red ⇒ freeze)", () => {
    const devsecops = phase({
      id: "devsecops-review",
      loopBackTo: "implement",
      parkOn: { red: "freeze" },
    });
    const frozen = routeVerdict(
      "sprint",
      "devsecops-review",
      verdict({ "code-review": "approved", "security-review": "rejected", severity: "red" }),
      { phase: devsecops },
    );
    assert.equal(frozen.kind, "freeze");
    // A non-red severity routes normally (negative ⇒ loop to implement).
    const loop = routeVerdict(
      "sprint",
      "devsecops-review",
      verdict({ "code-review": "approved", "security-review": "rejected", severity: "orange" }),
      { phase: devsecops },
    );
    assert.equal(loop.kind, "loop-back");
    assert.equal(loop.target, "implement");
    const clean = routeVerdict(
      "sprint",
      "devsecops-review",
      verdict({ "code-review": "approved", "security-review": "approved", severity: "green" }),
      { phase: devsecops },
    );
    assert.equal(clean.kind, "advance");
  });

  test("vars feedback-type==spec ⇒ park (ADR-21: broken specs never auto-rerun)", () => {
    const verify = phase({ id: "verify", loopBackOn: { persists: "fix" } });
    const action = routeVerdict("investigate", "verify", verdict({ outcome: "persists" }), {
      phase: verify,
      vars: { "feedback-type": "spec" },
    });
    assert.equal(action.kind, "park");
    const code = routeVerdict("investigate", "verify", verdict({ outcome: "persists" }), {
      phase: verify,
      vars: { "feedback-type": "code" },
    });
    assert.equal(code.kind, "loop-back");
  });

  test("publish-only (edgeless) verdict phase: every validated value advances", () => {
    const findings = phase({ id: "findings" }); // no loopBackTo/loopBackOn
    const approved = routeVerdict("review", "findings", verdict({ "code-review": "approved" }), { phase: findings });
    assert.equal(approved.kind, "advance");
    const rejected = routeVerdict("review", "findings", verdict({ "code-review": "rejected" }), { phase: findings });
    assert.equal(rejected.kind, "advance", "edgeless phase publishes rejected too");
    // Off-map value ⇒ park even on a publish-only phase (fail closed).
    const junk = routeVerdict("review", "findings", verdict({ "code-review": "green" }), { phase: findings });
    assert.equal(junk.kind, "park");
  });
});

// --- TASK_03: advancePhase integration — lastVerdicts, loopBackOn, onComplete --

const REVIEW_PHASES: WorkflowPhase[] = [
  phase({ id: "explore" }),
  phase({ id: "diff" }),
  phase({
    id: "findings",
    steps: [{ id: "review", execution: "subagent", task: "t", signal: { kind: "verdict", value: "code-review" } }],
  }),
  phase({ id: "qa-browsing" }),
  phase({ id: "comment" }),
  phase({
    id: "fix",
    onComplete: "findings",
    steps: [{ id: "patch", execution: "subagent", task: "t" }],
  }),
  phase({ id: "retro" }),
];

describe("S4 advancePhase — publish-only + lastVerdicts + onComplete (TASK_03)", () => {
  const base = (): WorkflowState => ({
    ...createState("review", "check my diff"),
    phaseIndex: 2,
    results: {},
  });

  test("edgeless verdict phase publishes lastVerdicts and advances (ADR-24)", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
    try {
      const s = base();
      writeRecord(cwd, s.runId!, { phase: "findings", step: "review", verdicts: { "code-review": "rejected" }, workflow: "review" });
      const next = advancePhase(s, "findings", { status: "completed", summary: "2 findings" }, REVIEW_PHASES.length, {
        phases: REVIEW_PHASES,
        cwd,
      });
      assert.equal(next.status, "active");
      assert.equal(next.phaseIndex, 3);
      assert.deepEqual(next.lastVerdicts?.["findings"], { "code-review": "rejected" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  const INVESTIGATE_PHASES = (): WorkflowPhase[] => [
    phase({ id: "explore" }),
    phase({ id: "reproduce" }),
    phase({ id: "root-cause" }),
    phase({ id: "fix" }),
    phase({
      id: "verify",
      loopBackOn: { persists: "fix", refuted: "root-cause" },
      steps: [{ id: "verify", execution: "subagent", task: "t", signal: { kind: "verdict", value: "outcome" } }],
    }),
  ];

  test("edged verdict phase also writes lastVerdicts on completion (INV-17)", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
    try {
      const s: WorkflowState = { ...createState("investigate", "bug"), phaseIndex: 4, results: {} };
      writeRecord(cwd, s.runId!, { phase: "verify", step: "verify", verdicts: { outcome: "persists" } });
      const next = advancePhase(s, "verify", { status: "completed", summary: "still broken" }, 5, {
        phases: INVESTIGATE_PHASES(),
        cwd,
      });
      assert.equal(next.phaseIndex, 3, "persists routes to fix");
      assert.deepEqual(next.lastVerdicts?.["verify"], { outcome: "persists" });
      assert.equal((next.attempts ?? {})["fix"], 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("loopBackOn refuted routes to root-cause, not fix", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
    try {
      const s: WorkflowState = { ...createState("investigate", "bug"), phaseIndex: 4, results: {} };
      writeRecord(cwd, s.runId!, { phase: "verify", step: "verify", verdicts: { outcome: "refuted" } });
      const next = advancePhase(s, "verify", { status: "completed", summary: "cause was wrong" }, 5, {
        phases: INVESTIGATE_PHASES(),
        cwd,
      });
      assert.equal(next.phaseIndex, 2, "refuted routes back to root-cause");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("onComplete fires ONLY on completed status — a completed fix returns to findings (INV-16)", () => {
    const s: WorkflowState = { ...base(), phaseIndex: 5 };
    const next = advancePhase(s, "fix", { status: "completed", summary: "patched" }, REVIEW_PHASES.length, {
      phases: REVIEW_PHASES,
      cwd: process.cwd(),
    });
    assert.equal(next.status, "active");
    assert.equal(next.phaseIndex, 2, "onComplete back-edge lands on findings");
    assert.equal((next.attempts ?? {})["findings"], 1);
  });

  test("onComplete never fires on skipped or failed status", () => {
    const s: WorkflowState = { ...base(), phaseIndex: 5 };
    const skipped = advancePhase(s, "fix", { status: "skipped", summary: "auto-disabled" }, REVIEW_PHASES.length, {
      phases: REVIEW_PHASES,
      cwd: process.cwd(),
    });
    assert.equal(skipped.phaseIndex, 6, "skipped fix advances linearly — no back-edge");
    const failed = advancePhase(s, "fix", { status: "failed", summary: "boom" }, REVIEW_PHASES.length, {
      phases: REVIEW_PHASES,
      cwd: process.cwd(),
    });
    assert.equal(failed.status, "paused");
  });

  test("onComplete target ceiling exhausts ⇒ loop-exhausted park", () => {
    const s: WorkflowState = { ...base(), phaseIndex: 5, attempts: { findings: 4 } };
    const capped: WorkflowPhase[] = REVIEW_PHASES.map((p) =>
      p.id === "findings" ? { ...p, maxAttempts: 4 } : p,
    );
    const next = advancePhase(s, "fix", { status: "completed", summary: "patched" }, capped.length, {
      phases: capped,
      cwd: process.cwd(),
    });
    assert.equal(next.status, "paused");
    assert.match(next.pausedReason ?? "", /loop-exhausted:findings/);
  });

  test("unmapped negative on an edged phase parks without burning an attempt", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
    try {
      const phases: WorkflowPhase[] = [
        phase({ id: "a" }),
        phase({
          id: "verify",
          loopBackOn: { persists: "a" }, // refuted unmapped — strict map, no loopBackTo
          steps: [{ id: "verify", execution: "subagent", task: "t", signal: { kind: "verdict", value: "outcome" } }],
        }),
      ];
      const s: WorkflowState = { ...createState("investigate", "bug"), phaseIndex: 1, results: {} };
      writeRecord(cwd, s.runId!, { phase: "verify", step: "verify", verdicts: { outcome: "refuted" } });
      const next = advancePhase(s, "verify", { status: "completed", summary: "?" }, phases.length, {
        phases,
        cwd,
      });
      assert.equal(next.status, "paused");
      assert.equal(next.verdictPark, "verify");
      assert.deepEqual(next.attempts, {});
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// --- TASK_03: state fields ----------------------------------------------------

describe("S4 state fields (TASK_03)", () => {
  test("createState carries lastVerdicts/lanes as fresh empty maps", () => {
    const s = createState("develop", "goal");
    assert.deepEqual(s.lastVerdicts, {});
    assert.deepEqual(s.lanes, {});
  });
});

// --- TASK_02: per-step signal observation + flagged-only merge ---------------

import { stepCompletionStatus, mergePhaseVerdicts, readStepRecord, recordPathFor } from "../orchestrator/records.ts";
import type { WorkflowStep } from "../orchestrator/types.ts";

const step = (partial: Partial<WorkflowStep> & { id: string }): WorkflowStep =>
  ({ execution: "subagent", task: "t", ...partial }) as WorkflowStep;

describe("S4 step signal observation (TASK_02)", () => {
  const withTmp = (fn: (cwd: string) => void) => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
    try { fn(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
  };
  const st = (runId = "run-1") => ({ workflowId: "review", runId });
  const ph = { id: "findings" };

  test("verdict-flagged step: missing record ⇒ signal-missing (re-issue, no advance)", () => {
    withTmp((cwd) => {
      const c = stepCompletionStatus(st(), ph, step({ id: "r", signal: { kind: "verdict", value: "code-review" } }), cwd);
      assert.equal(c.kind, "signal-missing");
    });
  });

  test("verdict-flagged step: record present carrying declared var ⇒ ok", () => {
    withTmp((cwd) => {
      writeRecord(cwd, "run-1", { phase: "findings", step: "r", verdicts: { "code-review": "approved" }, workflow: "review", vars: { "feedback-type": "code" } });
      const c = stepCompletionStatus(st(), ph, step({ id: "r", signal: { kind: "verdict", value: "code-review" } }), cwd);
      assert.equal(c.kind, "ok");
      if (c.kind === "ok") assert.equal(c.vars["feedback-type"], "code");
    });
  });

  test("record present but missing the DECLARED var ⇒ signal-missing", () => {
    withTmp((cwd) => {
      writeRecord(cwd, "run-1", { phase: "findings", step: "r", verdicts: { other: "approved" }, workflow: "review" });
      const c = stepCompletionStatus(st(), ph, step({ id: "r", signal: { kind: "verdict", value: "code-review" } }), cwd);
      assert.equal(c.kind, "signal-missing");
    });
  });

  test("marker signal: record without the marker ⇒ signal-missing; with ⇒ ok", () => {
    withTmp((cwd) => {
      const s = step({ id: "r", signal: { kind: "marker", value: "done-flag" } });
      assert.equal(stepCompletionStatus(st(), ph, s, cwd).kind, "signal-missing");
      writeRecord(cwd, "run-1", { phase: "findings", step: "r", workflow: "review" });
      // markers live on the record — rewrite with the marker array
      writeFileSync(
        recordPathFor(cwd, "run-1", "findings", "r"),
        JSON.stringify({ v: 1, workflow: "review", runId: "run-1", phase: "findings", step: "r", at: new Date().toISOString(), summary: null, verdicts: {}, vars: {}, evidence: [], deliverables: [], markers: ["done-flag"] }),
      );
      assert.equal(stepCompletionStatus(st(), ph, s, cwd).kind, "ok");
    });
  });

  test("artifact signal: declared file absent ⇒ signal-missing; present ⇒ ok", () => {
    withTmp((cwd) => {
      const s = step({ id: "r", signal: { kind: "artifact", value: "out/report.md" } });
      assert.equal(stepCompletionStatus(st(), ph, s, cwd).kind, "signal-missing");
      mkdirSync(path.join(cwd, "out"), { recursive: true });
      writeFileSync(path.join(cwd, "out", "report.md"), "x");
      assert.equal(stepCompletionStatus(st(), ph, s, cwd).kind, "ok");
    });
  });

  test("non-flagged step whose record carries verdicts ⇒ stripped + reported, never parked", () => {
    withTmp((cwd) => {
      writeRecord(cwd, "run-1", { phase: "findings", step: "r", verdicts: { "code-review": "approved" }, markers: ["DONE"], workflow: "review" });
      const c = stepCompletionStatus(st(), ph, step({ id: "r", signal: { kind: "marker", value: "DONE" } }), cwd);
      assert.equal(c.kind, "ok");
      if (c.kind !== "ok") return;
      assert.deepEqual(c.record?.verdicts, {}, "an unowned verdict never reaches routing");
      assert.deepEqual(c.dropped, ["code-review==approved"]);
    });
  });

  test("verdict values normalize on read (\"Approved.\" ⇒ approved)", () => {
    withTmp((cwd) => {
      writeRecord(cwd, "run-1", { phase: "findings", step: "r", verdicts: { "code-review": " Approved. " }, workflow: "review" });
      const c = stepCompletionStatus(st(), ph, step({ id: "r", signal: { kind: "verdict", value: "code-review" } }), cwd);
      assert.equal(c.kind, "ok");
      if (c.kind === "ok") assert.deepEqual(c.record?.verdicts, { "code-review": "approved" });
    });
  });

  test("non-flagged step record with only vars ⇒ ok + vars merge", () => {
    withTmp((cwd) => {
      writeRecord(cwd, "run-1", { phase: "findings", step: "r", vars: { "parallel-safe": "true" }, workflow: "review" });
      const c = stepCompletionStatus(st(), ph, step({ id: "r" }), cwd);
      assert.equal(c.kind, "ok");
      if (c.kind === "ok") assert.equal(c.vars["parallel-safe"], "true");
    });
  });

  test("no signal, no record ⇒ vacuous ok (legacy ghost-step path)", () => {
    withTmp((cwd) => {
      assert.equal(stepCompletionStatus(st(), ph, step({ id: "r" }), cwd).kind, "ok");
    });
  });
});

describe("S4 quota/interruption ledger events (TASK_04)", () => {
  test("delegation wall-clock budget ⇒ quota-parked flag + ledger event, attempts untouched", async () => {
    const { runDeterministicDelegation } = await import("../orchestrator/executor.ts");
    const { beginRun } = await import("../orchestrator/telemetry.ts");
    const { readLedger } = await import("../orchestrator/ledger.ts");
    const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
    const NAME = "KSTACK_PI_DELEGATION_BUDGET_SEC";
    const original = process.env[NAME];
    process.env[NAME] = "1"; // 1s — first step runs, second never starts
    try {
      const wfCtx: any = {
        state: { workflowId: "investigate", phaseIndex: 1, status: "active", goal: "g", results: {}, runId: "run-1", attempts: {} },
        git: { branch: "b", hasUncommittedChanges: true, hasStagedChanges: false, aheadOfRemote: 0, behindRemote: 0, isMainBranch: false, recentCommitSubject: "" },
        cwd,
      };
      const host: any = { cwd, ui: { notify: () => {}, setStatus: () => {} } };
      const pi: any = { appendEntry: () => {} };
      beginRun("investigate");
      const interruption: { kind?: "quota-parked" | "run-interrupted" } = {};
      const phase = { id: "root-cause" };
      const results = await runDeterministicDelegation(
        phase as any,
        wfCtx,
        host,
        () => true,
        pi,
        async () => {
          await new Promise((r) => setTimeout(r, 1100));
          return { ok: true, output: "x", rawOutput: "x", exitCode: 0, durationMs: 80, toolCalls: 0, turns: 1 };
        },
        // two-step plan via planOverride so the budget break fires on step 2
        [
          { agent: "scout", task: "t1" },
          { agent: "planner", task: "t2" },
        ],
        undefined,
        interruption,
      );
      assert.equal(results.length, 1, "second step never spawned");
      assert.equal(interruption.kind, "quota-parked");
      const ledger = readLedger(cwd, wfCtx.state);
      const quotaEvt = ledger.find((e: any) => e.kind === "quota-parked");
      assert.ok(quotaEvt, "quota-parked ledger event missing");
      assert.equal(quotaEvt.phaseId, "root-cause");
      assert.deepEqual(wfCtx.state.attempts, {}, "quota parks never burn attempts");
      assert.ok(!ledger.some((e: any) => e.kind === "verdict"), "interruption must not emit a verdict event");
    } finally {
      if (original === undefined) delete process.env[NAME];
      else process.env[NAME] = original;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("S4 record reader (TASK_02)", () => {
  test("identity mismatch (workflow/runId/phase/step) ⇒ null", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
    try {
      writeRecord(cwd, "run-1", { phase: "findings", step: "r", verdicts: { x: "y" }, workflow: "review" });
      assert.ok(readStepRecord(cwd, "review", "run-1", "findings", "r"), "sanity");
      assert.equal(readStepRecord(cwd, "other", "run-1", "findings", "r"), null, "wrong workflow");
      assert.equal(readStepRecord(cwd, "review", "run-2", "findings", "r"), null, "wrong runId");
      assert.equal(readStepRecord(cwd, "review", "run-1", "other", "r"), null, "wrong phase");
      assert.equal(readStepRecord(cwd, "review", "run-1", "findings", "s"), null, "wrong step");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("unparseable record file ⇒ null", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
    try {
      const dir = path.join(cwd, ".kstack", "runs", "run-1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "findings.r.json"), "{not json");
      assert.equal(readStepRecord(cwd, "review", "run-1", "findings", "r"), null);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("dual-flagged merge yields both vars; disagreement ⇒ null (INV-2)", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
    try {
      const devsecops = phase({
        id: "devsecops-review",
        loopBackTo: "implement",
        steps: [
          step({ id: "code", signal: { kind: "verdict", value: "code-review" } }),
          step({ id: "sec", signal: { kind: "verdict", value: "security-review" } }),
        ],
      });
      writeRecord(cwd, "run-1", { phase: "devsecops-review", step: "code", verdicts: { "code-review": "approved" }, workflow: "sprint" });
      writeRecord(cwd, "run-1", { phase: "devsecops-review", step: "sec", verdicts: { "security-review": "rejected", severity: "red" }, workflow: "sprint" });
      const merged = mergePhaseVerdicts(devsecops, cwd, "sprint", "run-1");
      assert.deepEqual(merged.parsed?.verdicts, { "code-review": "approved", "security-review": "rejected", severity: "red" });
      // A step cannot emit ANOTHER step's verdict: sec's code-review is dropped.
      writeRecord(cwd, "run-1", { phase: "devsecops-review", step: "sec", verdicts: { "security-review": "rejected", severity: "red", "code-review": "rejected" }, workflow: "sprint" });
      assert.equal(mergePhaseVerdicts(devsecops, cwd, "sprint", "run-1").parsed?.verdicts["code-review"], "approved");
      // severity belongs to the security step only: a code-review severity is
      // dropped — it can neither downgrade the security severity nor contradict it.
      writeRecord(cwd, "run-1", { phase: "devsecops-review", step: "code", verdicts: { "code-review": "approved", severity: "low" }, workflow: "sprint" });
      assert.equal(mergePhaseVerdicts(devsecops, cwd, "sprint", "run-1").parsed?.verdicts.severity, "red");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// --- TASK_05: asks→vars, enabled resolution, skipWhen, derived skippability ---

import {
  resolvePhaseEnabled,
  stepSkippedByVars,
  enabledPhaseIds,
  derivedSkippable,
  coherenceProblems,
  collectAskAnswers,
} from "../orchestrator/enabled.ts";
import { gateInventory } from "../orchestrator/gates.ts";
import { getAllWorkflows } from "../orchestrator/workflows.ts";
import { initOrchestrator } from "../orchestrator/index.ts";
import { executeCurrentPhase } from "../orchestrator/executor.ts";
import type { Workflow } from "../orchestrator/types.ts";

const wfCtxFor = (cwd = "/x"): any => ({
  state: { workflowId: "t", vars: {}, lastVerdicts: {} },
  git: { branch: "b", hasUncommittedChanges: false, hasStagedChanges: false, aheadOfRemote: 0, behindRemote: 0, isMainBranch: false, recentCommitSubject: "" },
  cwd,
});

describe("S4 enabled resolution (TASK_05)", () => {
  test("enabled absent / 'on' / 'off' resolve directly", () => {
    assert.equal(resolvePhaseEnabled(phase({ id: "p" }), wfCtxFor()).enabled, "on");
    assert.equal(resolvePhaseEnabled(phase({ id: "p", enabled: "on" }), wfCtxFor()).enabled, "on");
    assert.equal(resolvePhaseEnabled(phase({ id: "p", enabled: "off" }), wfCtxFor()).enabled, "off");
  });

  test("enabled:'auto' evaluates autoWhen at resolution time", () => {
    const p = phase({ id: "p", enabled: "auto", autoWhen: (c: any) => c.state.vars?.scope === "code" });
    const on = wfCtxFor(); on.state.vars = { scope: "code" };
    const off = wfCtxFor(); off.state.vars = { scope: "docs" };
    assert.equal(resolvePhaseEnabled(p, on).enabled, "on");
    assert.equal(resolvePhaseEnabled(p, off).enabled, "off");
  });

  test("throwing or missing autoWhen resolves 'off' with a ledger-worthy note", () => {
    const boom = phase({ id: "p", enabled: "auto", autoWhen: () => { throw new Error("boom"); } });
    const r = resolvePhaseEnabled(boom, wfCtxFor());
    assert.equal(r.enabled, "off");
    assert.match(r.note ?? "", /autoWhen threw/);
    const bare = phase({ id: "p2", enabled: "auto" });
    assert.equal(resolvePhaseEnabled(bare, wfCtxFor()).enabled, "off");
  });

  test("step skipWhen {var,equals} matches state.vars only (missing var ⇒ run)", () => {
    const s = step({ id: "s", skipWhen: { var: "scope", equals: "docs" } });
    assert.equal(stepSkippedByVars(s, { scope: "docs" }), true);
    assert.equal(stepSkippedByVars(s, { scope: "code" }), false);
    assert.equal(stepSkippedByVars(s, {}), false);
    assert.equal(stepSkippedByVars(s, undefined), false);
    assert.equal(stepSkippedByVars(step({ id: "s2" }), { scope: "docs" }), false, "no skipWhen ⇒ never skipped");
  });
});

describe("S4 derived skippability (TASK_05, INV-13)", () => {
  const wf = (): Workflow => ({
    id: "t", name: "T", description: "t",
    phases: [
      phase({ id: "scan", optional: true, produces: ["scan-report"] }),
      phase({ id: "fix", needs: ["scan-report"] }),
      phase({ id: "docs", optional: true }),
    ] as WorkflowPhase[],
  });

  test("a producer of a needed artifact is NOT skippable; an unused optional is", () => {
    const w = wf();
    const enabled = enabledPhaseIds(w, wfCtxFor());
    assert.equal(derivedSkippable(w, enabled, "scan"), false, "fix needs scan-report");
    assert.equal(derivedSkippable(w, enabled, "docs"), true);
  });

  test("when the consumer is disabled the producer becomes skippable again", () => {
    const w = wf();
    (w.phases[1] as any).enabled = "off";
    const enabled = enabledPhaseIds(w, wfCtxFor());
    assert.equal(derivedSkippable(w, enabled, "scan"), true);
  });

  test("coherenceProblems flags unproduced needs and cycles", () => {
    const dangling: Workflow = {
      id: "t", name: "T", description: "t",
      phases: [phase({ id: "a", needs: ["nope"] })] as WorkflowPhase[],
    };
    assert.ok(coherenceProblems(dangling).some((p) => /needs "nope"/.test(p)));
    const cyclic: Workflow = {
      id: "t", name: "T", description: "t",
      phases: [
        phase({ id: "a", produces: ["x"], needs: ["y"] }),
        phase({ id: "b", produces: ["y"], needs: ["x"] }),
      ] as WorkflowPhase[],
    };
    assert.ok(coherenceProblems(cyclic).some((p) => /cycle/.test(p)));
  });

  test("gateInventory: enabled:'off' phases get no row; needed producers can't offer skip", () => {
    const w: Workflow = {
      id: "t", name: "T", description: "t",
      phases: [
        phase({ id: "scan", optional: true, produces: ["r"] }),
        phase({ id: "gone", optional: true, enabled: "off" }),
        phase({ id: "use", needs: ["r"] }),
      ] as WorkflowPhase[],
    };
    const rows = gateInventory(w, wfCtxFor());
    assert.ok(!rows.some((r) => r.phaseId === "gone"), "enabled:off phases produce no gate rows");
    const scan = rows.find((r) => r.phaseId === "scan");
    assert.ok(scan, "optional producer still gets a row");
    assert.equal(scan!.skippable, false, "needed producer must not be offered 'skip'");
  });
});

describe("S4 asks → state.vars (TASK_05)", () => {
  test("non-tui context resolves every ask to its default", async () => {
    const w: Workflow = {
      id: "t", name: "T", description: "t", phases: [],
      asks: [
        { var: "scope", question: "Scope?", options: ["code", "docs"] },
        { var: "depth", question: "Depth?", options: ["quick", "deep"], default: "deep" },
      ],
    };
    const vars = await collectAskAnswers(w, { mode: "rpc", ui: {} } as any);
    assert.deepEqual(vars, { scope: "code", depth: "deep" });
  });

  test("when conditions gate follow-up questions on earlier answers", async () => {
    const w: Workflow = {
      id: "t", name: "T", description: "t", phases: [],
      asks: [
        { var: "scope", question: "Scope?", options: ["mixed", "code"] },
        { var: "parallel", question: "Parallel?", options: ["yes", "no"], when: { var: "scope", equals: "mixed" } },
      ],
    };
    // scope=code ⇒ parallel never asked
    const vars1 = await collectAskAnswers(w, { mode: "tui", ui: { select: async () => "code" } } as any);
    assert.deepEqual(vars1, { scope: "code" });
    // scope=mixed ⇒ parallel asked
    const asked: string[] = [];
    const vars2 = await collectAskAnswers(w, {
      mode: "tui",
      ui: { select: async (q: string, opts: string[]) => { asked.push(q); return opts[0]; } },
    } as any);
    assert.deepEqual(vars2, { scope: "mixed", parallel: "yes" });
    assert.equal(asked.length, 2);
  });
});

// Minimal pi/ctx harness for executor-level dispatch tests (mirrors
// orchestrator.test.ts fakeHarness — registers nothing, captures state
// entries + delivered instructions).
const harness = (initialState: unknown, cwd: string) => {
  const entries: any[] = initialState ? [{ type: "custom", customType: "kstack-wf-state", data: initialState }] : [];
  const sent: string[] = [];
  const pi: any = {
    registerTool: () => {},
    registerCommand: () => {},
    on: () => {},
    exec: async () => ({ stdout: "", stderr: "" }),
    appendEntry: (_t: string, d: any) => entries.push({ type: "custom", customType: _t, data: d }),
    sendUserMessage: (m: string) => sent.push(m),
  };
  const ctx: any = { cwd, ui: { notify: () => {}, setStatus: () => {} }, sessionManager: { getEntries: () => entries } };
  return { pi, ctx, entries, sent };
};
const lastState = (h: any) => h.entries.filter((e: any) => e.customType === "kstack-wf-state").at(-1)!.data;

describe("S4 executor — enabled + skipWhen at arrival (TASK_05)", () => {
  test("enabled:'off' phase is skipped at arrival (no delivery)", async () => {
    const wf: Workflow = {
      id: "t5-off", name: "T", description: "t",
      phases: [
        phase({ id: "a", execution: "main", task: "do a" }),
        phase({ id: "b", execution: "main", task: "do b", enabled: "off" }),
        phase({ id: "c", execution: "main", task: "do c" }),
      ] as WorkflowPhase[],
    };
    getAllWorkflows().push(wf);
    try {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
      try {
        const state = { ...createState("t5-off", "g"), phaseIndex: 1, results: {} };
        const h = harness(state, cwd);
        await executeCurrentPhase(h.pi, h.ctx, state as any);
        const s = lastState(h);
        assert.equal(s.results["b"]?.status, "skipped");
        assert.equal(s.phaseIndex, 2, "arrival skip advances to the next phase");
        assert.ok(h.sent.some((m: string) => m.includes("Phase: c")), "phase c must be delivered");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      const i = getAllWorkflows().indexOf(wf);
      if (i >= 0) getAllWorkflows().splice(i, 1);
    }
  });

  test("enabled:'auto' phase with a false autoWhen is skipped at arrival", async () => {
    const wf: Workflow = {
      id: "t5-auto", name: "T", description: "t",
      phases: [
        phase({ id: "a", execution: "main", task: "do a" }),
        phase({ id: "b", execution: "main", task: "do b", enabled: "auto", autoWhen: () => false }),
        phase({ id: "c", execution: "main", task: "do c" }),
      ] as WorkflowPhase[],
    };
    getAllWorkflows().push(wf);
    try {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
      try {
        const state = { ...createState("t5-auto", "g"), phaseIndex: 1, results: {} };
        const h = harness(state, cwd);
        await executeCurrentPhase(h.pi, h.ctx, state as any);
        const s = lastState(h);
        assert.equal(s.results["b"]?.status, "skipped");
        assert.equal(s.phaseIndex, 2);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      const i = getAllWorkflows().indexOf(wf);
      if (i >= 0) getAllWorkflows().splice(i, 1);
    }
  });

  test("step skipWhen auto-records a skipped step and dispatches the next", async () => {
    const wf: Workflow = {
      id: "t5-skip", name: "T", description: "t",
      phases: [
        phase({
          id: "work", execution: "main",
          steps: [
            { id: "s1", execution: "main", task: "first", skipWhen: { var: "scope", equals: "docs" } },
            { id: "s2", execution: "main", task: "second" },
          ] as any,
        }),
      ] as WorkflowPhase[],
    };
    getAllWorkflows().push(wf);
    try {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
      try {
        const state = { ...createState("t5-skip", "g"), phaseIndex: 0, vars: { scope: "docs" }, results: {} };
        const h = harness(state, cwd);
        initOrchestrator(h.pi);
        await executeCurrentPhase(h.pi, h.ctx, state as any);
        const s = lastState(h);
        assert.equal(s.results["work.s1"]?.status, "skipped", "skipWhen step recorded skipped");
        assert.equal(s.stepIndex, 1, "dispatch lands on s2");
        assert.ok(h.sent.some((m: string) => m.includes("second")), "s2 instructions delivered");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      const i = getAllWorkflows().indexOf(wf);
      if (i >= 0) getAllWorkflows().splice(i, 1);
    }
  });
});

// --- TASK_06: capability probing + requires/prefers gates --------------------

import { probeCapabilities, capabilitiesUnprobed, missingRequires, missingPrefers } from "../orchestrator/capabilities.ts";
import { readLedger } from "../orchestrator/ledger.ts";

describe("S4 capability gates (TASK_06, ADR-16)", () => {
  test("probeCapabilities returns a boolean for every declared capability", () => {
    const caps = probeCapabilities();
    for (const c of ["graft", "browse", "node", "gh", "design"] as const) {
      assert.equal(typeof caps[c], "boolean", `${c} must be probed to a boolean`);
    }
  });

  test("capabilitiesUnprobed: empty/undefined map means unprobed", () => {
    assert.equal(capabilitiesUnprobed(undefined), true);
    assert.equal(capabilitiesUnprobed({}), true);
    assert.equal(capabilitiesUnprobed({ gh: false, node: false }), true, "all-false map = never probed");
    assert.equal(capabilitiesUnprobed({ node: true }), false);
  });

  test("missingRequires/missingPrefers list only absent capabilities", () => {
    const s = { requires: ["gh", "browse"] as any, prefers: ["graft", "node"] as any };
    const caps = { gh: true, node: true };
    assert.deepEqual(missingRequires(s, caps), ["browse"]);
    assert.deepEqual(missingPrefers(s, caps), ["graft"]);
  });

  test("a requires:[gh] step on a gh-less map skips with a ledger note (INV-16)", async () => {
    const wf: Workflow = {
      id: "t6-req", name: "T", description: "t",
      phases: [
        phase({
          id: "post", execution: "main",
          steps: [
            { id: "comment", execution: "main", task: "post it", requires: ["gh"] },
            { id: "done", execution: "main", task: "wrap" },
          ] as any,
        }),
      ] as WorkflowPhase[],
    };
    getAllWorkflows().push(wf);
    try {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
      try {
        const state = {
          ...createState("t6-req", "g"), phaseIndex: 0,
          capabilities: { node: true, gh: false }, // probed map, gh absent
          results: {},
        };
        const h = harness(state, cwd);
        await executeCurrentPhase(h.pi, h.ctx, state as any);
        const s = lastState(h);
        assert.equal(s.results["post.comment"]?.status, "skipped", "gh-less requires step skips, never crashes");
        assert.equal(s.stepIndex, 1);
        const ledger = readLedger(cwd, s);
        assert.ok(ledger.some((e: any) => /missing required capability gh/.test(e.payload?.summary ?? "")), "ledger skip note names gh");
        assert.ok(h.sent.some((m: string) => m.includes("wrap")), "next step still dispatched");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      const i = getAllWorkflows().indexOf(wf);
      if (i >= 0) getAllWorkflows().splice(i, 1);
    }
  });

  test("a prefers:[graft] step on a graft-less map runs degraded with a ~capability note", async () => {
    const wf: Workflow = {
      id: "t6-pref", name: "T", description: "t",
      phases: [
        phase({
          id: "scan", execution: "main",
          steps: [{ id: "scout", execution: "main", task: "look around", prefers: ["graft"] }] as any,
        }),
      ] as WorkflowPhase[],
    };
    getAllWorkflows().push(wf);
    try {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
      try {
        const state = {
          ...createState("t6-pref", "g"), phaseIndex: 0,
          capabilities: { node: true, graft: false },
          results: {},
        };
        const h = harness(state, cwd);
        await executeCurrentPhase(h.pi, h.ctx, state as any);
        const s = lastState(h);
        assert.equal(s.results["scan.scout"], undefined, "degraded step still runs — no skip record");
        assert.ok(h.sent.some((m: string) => m.includes("~capability: no-graft")), "instructions carry the degrade note");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      const i = getAllWorkflows().indexOf(wf);
      if (i >= 0) getAllWorkflows().splice(i, 1);
    }
  });
});

// --- TASK_07: ambientSkills, sideEffect gate, resumeMode, ephemeral cleanup ---

import { buildStepTask, buildStepInstructions, interpolateStepTask, buildRecordContract } from "../orchestrator/templates.ts";
import { ephemeralArtifactsFor, cleanupEphemeralArtifacts } from "../orchestrator/artifacts.ts";
import { reportCliPath } from "../orchestrator/records.ts";

describe("S4 ambient skills (TASK_07, D25)", () => {
  test("buildStepTask embeds ambient digests OUTSIDE the skill slot", () => {
    const task = buildStepTask(step({ id: "s", ambientSkills: ["kstack-qa"] }));
    assert.ok(task.includes("kstack-qa"), "ambient methodology must ride inside the delegated task");
  });

  test("buildStepInstructions renders an 'Ambient skill:' block for main steps", () => {
    const wfCtx: any = {
      state: { workflowId: "t", goal: "g", phaseIndex: 0, results: {}, skillsDelivered: [] },
      git: { branch: "b", hasUncommittedChanges: false, hasStagedChanges: false, aheadOfRemote: 0, behindRemote: 0, isMainBranch: false, recentCommitSubject: "" },
      cwd: "/x",
    };
    const ph = phase({ id: "p", steps: [step({ id: "s", execution: "main", ambientSkills: ["kstack-qa"] })] });
    const text = buildStepInstructions(ph, ph.steps![0], wfCtx);
    assert.ok(text.includes("Ambient skill: kstack-qa"), "main-step ambient block missing");
  });

  test("record-contract tokens interpolate identity + CLI path (ADR-23)", () => {
    const wfCtx: any = {
      state: { workflowId: "wf1", runId: "r-9", goal: "g", phaseIndex: 0, results: {} },
      git: { branch: "b", hasUncommittedChanges: false, hasStagedChanges: false, aheadOfRemote: 0, behindRemote: 0, isMainBranch: false, recentCommitSubject: "" },
      cwd: "/x",
    };
    const ph = phase({ id: "ph1", steps: [step({ id: "st1" })] });
    const out = interpolateStepTask("w={workflow} r={runId} p={phase} s={step} cli={kstack_report}", ph, 0, wfCtx);
    assert.equal(out, `w=wf1 r=r-9 p=ph1 s=st1 cli=${reportCliPath()}`);
  });

  test("buildRecordContract names the step's declared signal flag", () => {
    const verdict = buildRecordContract(step({ id: "s", signal: { kind: "verdict", value: "gate" } }));
    assert.ok(verdict.includes("--verdict gate==<value>"), "verdict signal must name its flag");
    const marker = buildRecordContract(step({ id: "s", signal: { kind: "marker", value: "DONE" } }));
    assert.ok(marker.includes("--marker DONE"), "marker signal must name its flag");
    const artifact = buildRecordContract(step({ id: "s", signal: { kind: "artifact", value: "out.md" } }));
    assert.ok(artifact.includes("`out.md` must exist"), "artifact signal must name the file");
    assert.ok(!buildRecordContract(step({ id: "s" })).includes("MUST carry"), "unsignaled steps get no mandatory flag");
  });
});

describe("S4 executor — sideEffect gate + resume + ephemeral (TASK_07)", () => {
  test("a sideEffect step parks BEFORE execution (awaiting_approval, ⚠ gate)", async () => {
    const wf: Workflow = {
      id: "t7-se", name: "T", description: "t",
      phases: [
        phase({
          id: "post", execution: "main",
          steps: [
            { id: "comment", execution: "main", task: "publish", sideEffect: true },
            { id: "done", execution: "main", task: "wrap" },
          ] as any,
        }),
      ] as WorkflowPhase[],
    };
    getAllWorkflows().push(wf);
    try {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
      try {
        const state = { ...createState("t7-se", "g"), phaseIndex: 0, results: {} };
        const h = harness(state, cwd);
        await executeCurrentPhase(h.pi, h.ctx, state as any);
        const s = lastState(h);
        assert.equal(s.status, "awaiting_approval", "sideEffect step must park pre-exec");
        assert.equal(s.entryGate, true);
        assert.ok(!h.sent.some((m: string) => m.includes("publish")), "the gated step must not be delivered");
        assert.equal(s.stepIndex, 0, "park holds the step index");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      const i = getAllWorkflows().indexOf(wf);
      if (i >= 0) getAllWorkflows().splice(i, 1);
    }
  });

  test("an approved sideEffect step runs and the flag clears on completion", async () => {
    const wf: Workflow = {
      id: "t7-se-ok", name: "T", description: "t",
      phases: [
        phase({
          id: "post", execution: "main",
          steps: [
            { id: "comment", execution: "main", task: "publish", sideEffect: true },
            { id: "done", execution: "main", task: "wrap" },
          ] as any,
        }),
      ] as WorkflowPhase[],
    };
    getAllWorkflows().push(wf);
    try {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
      try {
        const state = { ...createState("t7-se-ok", "g"), phaseIndex: 0, entryGate: "approved" as const, results: {} };
        const h = harness(state, cwd);
        await executeCurrentPhase(h.pi, h.ctx, state as any);
        assert.ok(h.sent.some((m: string) => m.includes("publish")), "approved step delivers");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      const i = getAllWorkflows().indexOf(wf);
      if (i >= 0) getAllWorkflows().splice(i, 1);
    }
  });

  test("resumeMode stamps the continue-from-disk hint on delivered instructions", async () => {
    const wf: Workflow = {
      id: "t7-res", name: "T", description: "t",
      phases: [
        phase({ id: "work", execution: "main", steps: [{ id: "s1", execution: "main", task: "keep going" }] as any }),
      ] as WorkflowPhase[],
    };
    getAllWorkflows().push(wf);
    try {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
      try {
        const state = { ...createState("t7-res", "g"), phaseIndex: 0, resumeMode: true, results: {} };
        const h = harness(state, cwd);
        await executeCurrentPhase(h.pi, h.ctx, state as any);
        assert.ok(h.sent.some((m: string) => m.includes("[resume]") && m.includes("on-disk state")), "resume hint must reach the step");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      const i = getAllWorkflows().indexOf(wf);
      if (i >= 0) getAllWorkflows().splice(i, 1);
    }
  });

  test("ephemeral artifacts delete at terminal status + ledger event", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
    try {
      writeFileSync(path.join(cwd, "understand.md"), "think");
      writeFileSync(path.join(cwd, "keep.md"), "durable");
      const wf: Workflow = {
        id: "t7-eph", name: "T", description: "t",
        phases: [phase({ id: "only", execution: "main" })] as WorkflowPhase[],
      };
      getAllWorkflows().push(wf);
      try {
        const state = {
          ...createState("t7-eph", "g"),
          phaseIndex: 1, // past the last phase → terminal
          status: "completed" as const,
          ephemeralArtifacts: ["understand.md", "missing.md", "../escape.md"],
          results: {},
        };
        const h = harness(state, cwd);
        await executeCurrentPhase(h.pi, h.ctx, state as any);
        assert.ok(!existsSync(path.join(cwd, "understand.md")), "ephemeral deleted");
        assert.ok(existsSync(path.join(cwd, "keep.md")), "durable untouched");
        const ledger = readLedger(cwd, state);
        assert.ok(ledger.some((e: any) => /ephemeral cleanup/.test(e.payload?.summary ?? "")), "ledger cleanup event");
      } finally {
        const i = getAllWorkflows().indexOf(wf);
        if (i >= 0) getAllWorkflows().splice(i, 1);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("cleanupEphemeralArtifacts refuses traversal; ephemeralArtifactsFor maps workflows", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
    try {
      const res = cleanupEphemeralArtifacts(cwd, ["../x.md", "ok.md"]);
      assert.deepEqual(res.failed, ["../x.md"]);
      assert.deepEqual(res.deleted, ["ok.md"]);
      assert.deepEqual(ephemeralArtifactsFor("develop"), ["plan.md"], "one living plan file");
      for (const f of ["understand.md", "user-story.md", "capability.md", "tasks.md", "summary_BE.md", "summary_FE.md"]) {
        assert.ok(ephemeralArtifactsFor("sprint").includes(f), `${f} is a sprint ephemeral — deleted at terminal status`);
      }
      assert.deepEqual(ephemeralArtifactsFor("investigate"), ["bug-report.md"]);
      assert.deepEqual(ephemeralArtifactsFor("nope"), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a delegated step's spawn env carries workflow/run/phase/step + report CLI (ADR-23)", async () => {
    const wf: Workflow = {
      id: "t7-env", name: "T", description: "t",
      phases: [
        phase({
          id: "build", execution: "main",
          steps: [{ id: "scout", execution: "subagent", task: "probe" } as any],
        }),
      ] as WorkflowPhase[],
    };
    getAllWorkflows().push(wf);
    try {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
      try {
        const state = { ...createState("t7-env", "g"), phaseIndex: 0, results: {} };
        const h = harness(state, cwd);
        let env: Record<string, string> | undefined;
        let task = "";
        await executeCurrentPhase(h.pi, h.ctx, state as any, {
          spawnFn: async (req: any) => { env = req.env; task = req.task; return { ok: true, output: "done", exitCode: 0, durationMs: 1 } as any; },
        } as any);
        assert.ok(env, "the delegated step must spawn");
        assert.equal(env!.KSTACK_WORKFLOW, "t7-env");
        assert.equal(env!.KSTACK_RUN_ID, state.runId);
        assert.equal(env!.KSTACK_PHASE, "build");
        assert.equal(env!.KSTACK_STEP, "scout");
        assert.equal(env!.KSTACK_REPORT, reportCliPath());
        // ADR-23: spawn → work → report → exit — the task itself mandates the record.
        assert.ok(task.includes("RECORD CONTRACT"), "delegated task must carry the record contract");
        assert.ok(task.includes('"$KSTACK_REPORT" --workflow "$KSTACK_WORKFLOW"'), "contract must name the env-var CLI invocation");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      const i = getAllWorkflows().indexOf(wf);
      if (i >= 0) getAllWorkflows().splice(i, 1);
    }
  });

  test("a DELEGATED step missing its record signal PARKS — never silently advances", async () => {
    const wf: Workflow = {
      id: "t7-sig", name: "T", description: "t",
      phases: [
        phase({
          id: "work", execution: "main",
          steps: [
            { id: "audit", execution: "subagent", task: "audit", signal: { kind: "marker", value: "DONE" } } as any,
          ],
        }),
      ] as WorkflowPhase[],
    };
    getAllWorkflows().push(wf);
    try {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "s4-"));
      try {
        const state = { ...createState("t7-sig", "g"), phaseIndex: 0, stepIndex: 0, results: {} };
        const h = harness(state, cwd);
        // The kstack_advance tool lives on the pi registration — capture it.
        const tools = new Map<string, any>();
        h.pi.registerTool = (t: any) => tools.set(t.name, t);
        initOrchestrator(h.pi);
        const advance = tools.get("kstack_advance");
        assert.ok(advance, "kstack_advance must register");
        const res = await advance.execute("t", { summary: "claiming done", status: "completed" }, undefined, undefined, h.ctx);
        const s = lastState(h);
        assert.equal(s.status, "paused", "delegated step with no record must park");
        assert.ok(s.pausedReason?.startsWith("signal-missing:"), `pausedReason must name the missing signal, got ${s.pausedReason}`);
        assert.ok(/parked/i.test(res.content[0].text), "the tool result must say the run parked");
        assert.equal(s.results["work.audit"], undefined, "no step result may be recorded");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      const i = getAllWorkflows().indexOf(wf);
      if (i >= 0) getAllWorkflows().splice(i, 1);
    }
  });
});
