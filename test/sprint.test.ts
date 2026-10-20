// Sprint workflow tests (feat/sprint-workflow): verdict parsing, dual-channel
// verification, deterministic routing, loop engine, D4 parks, sprint numbering,
// conditional digests + glossary injection, model tiers.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createState, advancePhase, routeVerdict, parkForUnreadableVerdict, forceApproveParked, returnParkedWithContext, isSecurityFrozen, unfreeze, forceContinuePastGate, reissueGate, resumeState } from "../orchestrator/state.ts";
import { launchPhase } from "../orchestrator/executor.ts";
import { decisionBlockedByInFlightChain, handleSprintPanel } from "../orchestrator/command.ts";
import { getAllWorkflows, getWorkflow } from "../orchestrator/workflows.ts";
import { parseHandoffVerdicts, verifyArtifactVerdicts, extractBlockers, buildRetryFeedback, mergeParseOutcomes, KNOWN_VARIABLES } from "../orchestrator/verdicts.ts";
import { computeNextSprintNumber, pad2, sprintArchiveDir, archivedSprintDirs } from "../orchestrator/sprint.ts";
import { buildPhaseInstructions, buildDeterministicPlan, retryContextBlock, conditionalSkillIds, glossaryTable, MASTER_DOD } from "../orchestrator/templates.ts";
import { modelTierFor, sprintMaxAttempts, sprintArchMaxAttempts, timeoutClassFor } from "../orchestrator/config.ts";
import { retryTimeoutMs, shouldReopenFullChain, advanceBlockReason, buildResumeContext, activeConstraintLines } from "../orchestrator/executor.ts";
import { createInputRouter } from "../orchestrator/router.ts";
import { recordPathFor } from "../orchestrator/records.ts";

const SPRINT = getWorkflow("sprint")!;

// S4 record channel: verdict-flagged steps prove completion via a kstack-report
// record at .kstack/runs/<runId>/<phase>.<step>.json — never pendingVerdict.
// Tests write the record the delegated step would have produced.
function writeRec(
  cwd: string,
  state: { workflowId: string; runId?: string },
  phaseId: string,
  stepId: string,
  verdicts: Record<string, string>,
  over: Record<string, unknown> = {},
) {
  const file = recordPathFor(cwd, state.runId!, phaseId, stepId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const safe = (v: string) => v.replace(/[^\w.-]/g, "-");
  writeFileSync(file, JSON.stringify({
    v: 1,
    workflow: safe(state.workflowId),
    runId: safe(state.runId!),
    phase: safe(phaseId),
    step: safe(stepId),
    summary: "x",
    verdicts,
    vars: {},
    evidence: [],
    deliverables: [],
    markers: [],
    ...over,
  }));
}

function makeCtx(phaseIndex = 0): any {
  return {
    state: { workflowId: "sprint", phaseIndex, status: "active", goal: "sprint goal", results: {}, version: 3, attempts: {} },
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

function sprintState(phaseIndex: number, extra: Record<string, unknown> = {}): any {
  return { ...createState("sprint", "sprint goal"), phaseIndex, ...extra };
}

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- Registration ------------------------------------------------------------

describe("sprint workflow registration", () => {
  test("phase order matches the approved graph (D6)", () => {
    assert.deepEqual(
      SPRINT.phases.map((p) => p.id),
      ["explore", "understand", "user-story", "capability", "system-design", "architect-gate", "backlog", "implement", "qa-browsing", "devsecops-review", "docker-review", "pipeline-review", "archive", "retro"],
    );
  });

  test("verdict-bearing phases declare loop targets and ceilings", () => {
    const gate = SPRINT.phases.find((p) => p.id === "architect-gate")!;
    assert.equal(gate.loopBackTo, "system-design");
    assert.equal(typeof gate.maxAttempts, "number");
    for (const id of ["devsecops-review", "qa-browsing", "docker-review", "pipeline-review"]) {
      assert.equal(SPRINT.phases.find((p) => p.id === id)!.loopBackTo, "implement", `${id} loops to implement`);
    }
    // implement's walkthrough/ui verdicts self-loop (purge + re-run from step 0).
    const impl = SPRINT.phases.find((p) => p.id === "implement")!;
    assert.equal(impl.loopBackTo, "implement");
  });

  test("implement is a strict BE→FE step sequence (D5)", () => {
    const impl = SPRINT.phases.find((p) => p.id === "implement")!;
    const steps = impl.steps!;
    // BE steps first, then FE steps — every implementation step is delegated.
    assert.deepEqual(steps.map((s) => s.id), ["backend", "be-walk", "frontend", "design", "fe-walk", "ui-check"]);
    assert.deepEqual(steps.slice(0, 2).map((s) => s.agent), ["backend-developer", "backend-developer"]);
    assert.deepEqual(steps.slice(2).map((s) => s.agent), ["frontend-developer", "frontend-developer", "frontend-developer", "frontend-developer"]);
    assert.ok(steps.every((s) => s.execution === "subagent"), "implementation steps are delegated");
  });

  test("archive is a mechanical main step — no verdict, no side effects", () => {
    const archive = SPRINT.phases.find((p) => p.id === "archive")!;
    assert.equal(archive.execution, "main");
    assert.equal(archive.steps!.length, 1);
    assert.equal(archive.steps![0].execution, "main");
    assert.equal(archive.steps![0].signal?.kind, "marker");
    assert.ok(!archive.loopBackTo, "archive is not verdict-bearing");
    // No push side effects anywhere in sprint (this run forbids remote push).
    assert.ok(!SPRINT.phases.some((p) => p.steps?.some((s) => s.sideEffect)), "sprint declares no sideEffect steps");
  });

});

// --- Verdict parsing (D1/D4 fail-closed) --------------------------------------

describe("verdict parsing (D1/D4 fail-closed)", () => {
  const GREEN_QA = [
    "## REPORT",
    "Executed acceptance criteria against branch feature/x.",
    "",
    "## HANDOFF",
    "VERIFIED FACTS:",
    "- suite green @ qa-artifact_01.md",
    "status == green",
    "DECISIONS: none",
    "OPEN QUESTIONS: none",
    "DO NOT REDO: implementation",
  ].join("\n");

  test("parses whitelisted values inside a HANDOFF", () => {
    const out = parseHandoffVerdicts(GREEN_QA);
    assert.ok(out.parsed);
    assert.equal(out.parsed.verdicts["status"], "green");
    assert.deepEqual(out.lines, ["status == green"]);
  });

  test("case-normalizes values and variable names", () => {
    const out = parseHandoffVerdicts(GREEN_QA.replace("status == green", "STATUS == GREEN"));
    assert.ok(out.parsed);
    assert.equal(out.parsed.verdicts["status"], "green");
  });

  test("verdict line OUTSIDE ## HANDOFF is rejected even in short reports (guard 1)", () => {
    // Short output (<6KB): extractHandoff returns the whole text — containment
    // must still hold. This is the planted-line attack surface.
    assert.equal(parseHandoffVerdicts("All good!\nstatus == green\n(no handoff section)").parsed, null);
  });

  test("missing HANDOFF marker or empty output ⇒ null", () => {
    assert.equal(parseHandoffVerdicts("plain report with status == red").parsed, null);
    assert.equal(parseHandoffVerdicts("").parsed, null);
    assert.equal(parseHandoffVerdicts(undefined as any).parsed, null);
  });

  test("out-of-whitelist value on a known variable fails the WHOLE parse", () => {
    const out = parseHandoffVerdicts(GREEN_QA.replace("status == green", "status == mostly-green"));
    assert.equal(out.parsed, null);
    assert.ok(out.lines.length > 0, "failing lines kept for the D4 panel");
  });

  test("trailing prose after the value fails closed (ambiguity ⇒ null)", () => {
    assert.equal(parseHandoffVerdicts(GREEN_QA.replace("status == green", "status == green — all pass")).parsed, null);
  });

  test("hedged severity fails closed; clean severity parses (D3)", () => {
    const base = "## HANDOFF\nsecurity-review == rejected\nseverity == critical";
    assert.ok(parseHandoffVerdicts(base).parsed?.severity === "critical");
    assert.ok(parseHandoffVerdicts(base.replace("critical", "low")).parsed?.severity === "low");
    assert.equal(parseHandoffVerdicts(base.replace("critical", "critical?")).parsed, null);
    assert.equal(parseHandoffVerdicts(base.replace("critical", "medium-high")).parsed, null);
    // MISSING severity on a security rejection ⇒ whole parse null ⇒ D4 panel.
    // Never auto-route: it could be a critical hole looping silently.
    assert.equal(parseHandoffVerdicts(base.replace("severity == critical", "")).parsed, null, "missing severity fails closed — human decides via D4 panel");
  });

  test("contradictory duplicate verdict lines ⇒ null, last-wins is never trusted (BUG-4)", () => {
    const base = "## HANDOFF\ncode-review == approved";
    assert.ok(parseHandoffVerdicts(`${base}\ncode-review == approved`).parsed, "identical repeat is redundant, not conflicting");
    assert.equal(parseHandoffVerdicts(`${base}\ncode-review == rejected`).parsed, null);
    assert.equal(parseHandoffVerdicts("## HANDOFF\nseverity == high\nseverity == low").parsed, null);
  });

  test("unknown x == y lines are ignored as prose", () => {
    const out = parseHandoffVerdicts("## HANDOFF\ncode-review == approved\ncoverage == high");
    assert.ok(out.parsed);
    assert.deepEqual(Object.keys(out.parsed.verdicts), ["code-review"]);
  });

  test("chain steps parse INDEPENDENTLY then merge (review W1)", () => {
    // Realistic sizes: each step >6KB, so joined-output parsing would keep only
    // the LAST HANDOFF and lose earlier chain steps' verdicts.
    const big = "x".repeat(7 * 1024);
    const stepA = `${big}\n## HANDOFF\nVERIFIED FACTS:\naudited diff\ncode-review == approved`;
    const stepB = `${big}\n## HANDOFF\nVERIFIED FACTS:\nno findings\nsecurity-review == approved\nseverity == low`;
    const merged = mergeParseOutcomes([parseHandoffVerdicts(stepA), parseHandoffVerdicts(stepB)]);
    assert.ok(merged.parsed, "both chain steps' verdicts survive the merge");
    assert.equal(merged.parsed?.verdicts["code-review"], "approved");
    assert.equal(merged.parsed?.verdicts["security-review"], "approved");

    const conflict = mergeParseOutcomes([
      parseHandoffVerdicts("## HANDOFF\ncode-review == approved"),
      parseHandoffVerdicts("## HANDOFF\ncode-review == rejected"),
    ]);
    assert.equal(conflict.parsed, null, "cross-step contradiction fails closed");

    const partial = mergeParseOutcomes([
      parseHandoffVerdicts("## HANDOFF\ncode-review == approved"),
      parseHandoffVerdicts("## HANDOFF\nno verdict lines here"),
    ]);
    assert.equal(partial.parsed, null, "a step without a trustworthy verdict nulls the whole gate");
  });

  test("HANDOFF with no known variables ⇒ null", () => {
    assert.equal(parseHandoffVerdicts("## HANDOFF\ncoverage == high").parsed, null);
  });

  test("KNOWN_VARIABLES covers every routing variable the templates instruct agents to emit", () => {
    for (const v of ["status", "code-review", "security-review", "severity", "docker-build", "docker-security", "software-architect-review"]) {
      assert.ok(KNOWN_VARIABLES.includes(v as any), `missing known variable ${v}`);
    }
  });
});

// --- Dual-channel artifact verification (guard 3) ------------------------------

describe("dual-channel artifact verification (guard 3)", () => {
  function setup(files: Record<string, string>): string {
    const tmp = tmpDir("kstack-verdict-");
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
      writeFileSync(path.join(tmp, file), content);
    }
    return tmp;
  }

  test("artifact exists + contains the same line ⇒ confirmed", () => {
    const cwd = setup({ "qa-artifact_01.md": "# QA report\n...\nstatus == green\n" });
    try {
      assert.equal(verifyArtifactVerdicts({ verdicts: { status: "green" } }, cwd, 1), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("artifact missing / disagreeing value ⇒ fail-closed", () => {
    const cwd = setup({});
    try {
      assert.equal(verifyArtifactVerdicts({ verdicts: { status: "green" } }, cwd, 1), false);
      writeFileSync(path.join(cwd, "qa-artifact_01.md"), "status == red\n");
      assert.equal(verifyArtifactVerdicts({ verdicts: { status: "green" } }, cwd, 1), false, "disk says red, handoff said green");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("devsecops artifacts resolve under devsecops/, sprint-stamped (BUG-2)", () => {
    const cwd = setup({ "devsecops/security-review-artifact_01.md": "severity == high\nsecurity-review == rejected\n" });
    try {
      assert.equal(verifyArtifactVerdicts({ verdicts: { "security-review": "rejected" } }, cwd, 1), true, "stamped artifact confirms");
      // BUG-2 regression: an UNSTAMPED leftover from a prior sprint must NOT satisfy this sprint's disk channel
      const stale = setup({ "devsecops/security-review-artifact.md": "severity == high\nsecurity-review == rejected\n" });
      try {
        assert.equal(verifyArtifactVerdicts({ verdicts: { "security-review": "rejected" } }, stale, 1), false, "unstamped stale artifact fails");
      } finally {
        rmSync(stale, { recursive: true, force: true });
      }
      assert.equal(verifyArtifactVerdicts({ verdicts: { "code-review": "approved" } }, cwd, 1), false, "missing artifact fails");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("software-architect-review resolves to the NEWEST sprint-stamped artifact (W5)", () => {
    const cwd = setup({
      "software-architect-artifact_03_1.md": "old\nsoftware-architect-review == rejected\n",
      "software-architect-artifact_03_2.md": "newer\nsoftware-architect-review == approved\n",
      "software-architect-artifact_03_10.md": "newest\nsoftware-architect-review == rejected\n",
      "software-architect-artifact_02_9.md": "other sprint\nsoftware-architect-review == approved\n",
    });
    try {
      // numeric tail sort: _03_10 is newer than _03_2; other sprints ignored
      assert.equal(verifyArtifactVerdicts({ verdicts: { "software-architect-review": "rejected" } }, cwd, 3), true);
      assert.equal(verifyArtifactVerdicts({ verdicts: { "software-architect-review": "approved" } }, cwd, 3), false,
        "newest is _03_10 (rejected) — not _03_2, not another sprint's _02_9");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("only the artifact TAIL window matters (64KB)", () => {
    const cwd = setup({});
    try {
      const padding = "x".repeat(70 * 1024);
      writeFileSync(path.join(cwd, "qa-artifact_02.md"), `status == green\n${padding}`);
      assert.equal(verifyArtifactVerdicts({ verdicts: { status: "green" } }, cwd, 2), false, "line outside the tail window does not count");
      writeFileSync(path.join(cwd, "qa-artifact_03.md"), `${padding}\nstatus == orange`);
      assert.equal(verifyArtifactVerdicts({ verdicts: { status: "orange" } }, cwd, 3), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("template prose cannot confirm a verdict — line-anchored needle (BUG-3)", () => {
    const cwd = setup({
      // Unresolved instruction text left in the artifact by a lazy reviewer:
      "devsecops/code-review-artifact_04.md": "Write devsecops/code-review-artifact.md containing the line 'code-review == approved|rejected'.",
    });
    try {
      assert.equal(verifyArtifactVerdicts({ verdicts: { "code-review": "approved" } }, cwd, 4), false, "'approved|rejected' template line is not an approval");
      // A real verdict line on its own line DOES confirm:
      writeFileSync(path.join(cwd, "devsecops/code-review-artifact_04.md"), "findings: none\ncode-review == approved\n");
      assert.equal(verifyArtifactVerdicts({ verdicts: { "code-review": "approved" } }, cwd, 4), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// --- Feedback extraction -------------------------------------------------------

describe("feedback extraction (loop fuel)", () => {
  test("review rejects yield finding lines only", () => {
    const artifact = [
      "# Code Review",
      "Intro prose without keywords.",
      "- CRITICAL SQL injection @ src/db.ts:12",
      "* Missing rate limiting risk on /api/login",
      "Plain sentence mentioning nothing relevant.",
    ].join("\n");
    const fb = extractBlockers(artifact, "review");
    assert.ok(fb.includes("SQL injection"));
    assert.ok(fb.includes("rate limiting"));
    assert.ok(!fb.includes("Intro prose"));
    assert.ok(!fb.toLowerCase().includes("plain sentence"));
  });

  test("ORANGE extracts the Testability Blockers section", () => {
    const artifact = [
      "# QA Report",
      "## STATUS == ORANGE",
      "### Testability Blockers",
      "- [data-testid=checkout] missing",
      "- #login-form has no stable id",
      "",
      "## Other Section",
      "unrelated",
    ].join("\n");
    const fb = extractBlockers(artifact, "qa-orange");
    assert.ok(fb.includes("data-testid=checkout"));
    assert.ok(!fb.includes("unrelated"));
  });

  test("RED extracts failure reports + rationale; feedback is capped", () => {
    const artifact = [
      "# QA Report",
      "## STATUS == RED",
      "### Failure 1: login broken",
      "Repro: open /login, submit bad creds — 500 returned.",
      "### Final Status Rationale",
      "Two failures block release.",
    ].join("\n");
    const fb = extractBlockers(artifact, "qa-red");
    assert.ok(fb.includes("Repro:"));
    assert.ok(fb.includes("block release"));

    const huge = `- CRITICAL ${"x".repeat(5000)}\n`.repeat(3);
    assert.ok(extractBlockers(huge, "review").length <= 2100, "capped at ~2000 chars");
  });

  test("empty content yields empty feedback", () => {
    assert.equal(extractBlockers("", "review"), "");
    assert.equal(extractBlockers("# nothing structured", "qa-orange"), "");
  });

  test("buildRetryFeedback degrades gracefully when artifacts are unreadable", () => {
    const empty = tmpDir("kstack-fb-");
    try {
      assert.equal(buildRetryFeedback({ verdicts: { status: "red" } }, "qa-verdict", empty, 9), "");
      const parsed = parseHandoffVerdicts("## HANDOFF\nsecurity-review == rejected\nseverity == medium");
      assert.ok(parsed.parsed);
      const fb = buildRetryFeedback(parsed.parsed!, "devsecops-review", empty, undefined);
      assert.equal(fb, ""); // no artifacts on disk → empty payload, never throws
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("buildRetryFeedback reads QA blockers from the sprint-numbered artifact", () => {
    const cwd = tmpDir("kstack-fb2-");
    try {
      writeFileSync(
        path.join(cwd, "qa-artifact_04.md"),
        "## STATUS == RED\n### Failure: cart totals wrong\nRepro: add two items, total off by one.\n",
      );
      const fb = buildRetryFeedback({ verdicts: { status: "red" } }, "qa-verdict", cwd, 4);
      assert.ok(fb.includes("total off by one"), `got: ${fb.slice(0, 120)}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// --- Deterministic routing table -----------------------------------------------

describe("deterministic routing table (routeVerdict)", () => {
  // S4: routeVerdict is keyed by (workflowId, phaseId) and resolves edges
  // from the REAL workflow phase — the stub phases below are the live sprint
  // definitions so the test validates the actual loopBackTo/parkOn config.
  const rv = (phaseId: string, parsed: Parameters<typeof routeVerdict>[2]) =>
    routeVerdict("sprint", phaseId, parsed, { phase: sprintPhases().find((p) => p.id === phaseId) });
  const sprintPhases = () => getWorkflow("sprint")!.phases;

  test("approved/green advance linearly (D1)", () => {
    assert.equal(rv("architect-gate", { verdicts: { "software-architect-review": "approved" } }).kind, "advance");
    assert.equal(rv("qa-browsing", { verdicts: { status: "green" } }).kind, "advance");
    assert.equal(rv("devsecops-review", { verdicts: { "code-review": "approved", "security-review": "approved" } }).kind, "advance");
    assert.equal(rv("docker-review", { verdicts: { "docker-build": "success", "docker-security": "approved" } }).kind, "advance");
    assert.equal(rv("pipeline-review", { verdicts: { pipeline: "approved" } }).kind, "advance");
    assert.equal(rv("devsecops-review", { verdicts: { "docker-security": "approved" } }).kind, "park", "BUG-1: gate missing its main verdicts parks, never default-advances");
  });

  test("whitelisted-but-off-map values park instead of advancing (BUG-1)", () => {
    // `status == failed` at the QA gate used to default-advance (fail-open);
    // now it routes as the unambiguous negative it is.
    assert.equal(rv("qa-browsing", { verdicts: { status: "failed" } }).kind, "loop-back");
    // `software-architect-review == success` is neither expected-positive nor a
    // routing negative ⇒ ambiguous intent ⇒ human decides via panel.
    assert.equal(rv("architect-gate", { verdicts: { "software-architect-review": "success" } }).kind, "park");
  });

  test("non-security rejections loop back (D2)", () => {
    assert.deepEqual(rv("architect-gate", { verdicts: { "software-architect-review": "rejected" } }), { kind: "loop-back", target: "system-design" });
    assert.deepEqual(rv("qa-browsing", { verdicts: { status: "red" } }), { kind: "loop-back", target: "implement" });
    assert.deepEqual(rv("qa-browsing", { verdicts: { status: "orange" } }), { kind: "loop-back", target: "implement" });
    assert.deepEqual(rv("devsecops-review", { verdicts: { "code-review": "rejected", "security-review": "approved" } }), { kind: "loop-back", target: "implement" });
    assert.equal(
      rv("devsecops-review", { verdicts: { "security-review": "rejected" }, severity: "medium" }).kind,
      "loop-back",
      "medium security rejection loops back",
    );
    assert.deepEqual(rv("devsecops-review", { verdicts: { "security-review": "rejected" }, severity: "low" }), { kind: "loop-back", target: "implement" });
    // Docker/pipeline verdicts live on their OWN phases (S4) — devsecops no
    // longer merges them.
    assert.deepEqual(rv("docker-review", { verdicts: { "docker-build": "failed" } }), { kind: "loop-back", target: "implement" });
    assert.deepEqual(rv("docker-review", { verdicts: { "docker-build": "success", "docker-security": "rejected" } }), { kind: "loop-back", target: "implement" });
    assert.deepEqual(rv("pipeline-review", { verdicts: { pipeline: "rejected" } }), { kind: "loop-back", target: "implement" });
    // implement's per-lane walker verdicts self-loop the phase.
    assert.deepEqual(rv("implement", { verdicts: { "be-walk": "fail" } }), { kind: "loop-back", target: "implement" });
  });

  test("critical/high security rejection freezes (D3) — never unconditional", () => {
    assert.equal(rv("devsecops-review", { verdicts: { "security-review": "rejected" }, severity: "critical" }).kind, "freeze");
    assert.equal(rv("devsecops-review", { verdicts: { "security-review": "rejected" }, severity: "high" }).kind, "freeze");
  });
});

// --- Loop engine ----------------------------------------------------------------

describe("loop engine in advancePhase (B3)", () => {
  const total = SPRINT.phases.length;
  // S4: verdict-bearing phases read kstack-report records from .kstack/runs/
  // — never pendingVerdict. Indices: implement=7, qa-browsing=8,
  // devsecops-review=9, architect-gate=5, system-design=4.
  function devsecopsRecords(cwd: string, state: { workflowId: string; runId?: string }, verdicts: Record<string, string>) {
    writeRec(cwd, state, "devsecops-review", "code-review", { "code-review": verdicts["code-review"] ?? "approved" });
    writeRec(cwd, state, "devsecops-review", "security", {
      "security-review": verdicts["security-review"] ?? "approved",
      ...(verdicts.severity ? { severity: verdicts.severity } : {}),
    });
  }

  test("approved architect verdict advances linearly and resets counters", () => {
    const cwd = tmpDir("kstack-le-");
    try {
      const state = sprintState(5, { attempts: { "architect-gate->system-design": 2 } });
      writeRec(cwd, state, "architect-gate", "review", { "software-architect-review": "approved" });
      const next = advancePhase(state, "architect-gate", { status: "completed", summary: "ok" }, total, { phases: SPRINT.phases, cwd });
      assert.equal(next.phaseIndex, 6);
      assert.equal(next.status, "active");
      assert.equal(next.attempts["architect-gate->system-design"], undefined, "counter reset after approval");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("rejected verdict loops back with attempt increment + retry context", () => {
    const cwd = tmpDir("kstack-le-");
    try {
      const state = sprintState(5);
      writeRec(cwd, state, "architect-gate", "review", { "software-architect-review": "rejected" });
      const next = advancePhase(state, "architect-gate", { status: "completed", summary: "found issues" }, total, { phases: SPRINT.phases, cwd });
      assert.equal(next.phaseIndex, 4, "back to system-design");
      assert.equal(next.attempts["architect-gate->system-design"], 1);
      assert.ok(next.retryContext);
      assert.equal(next.retryContext.targetPhaseId, "system-design");
      assert.equal(next.retryContext.attempt, 2, "upcoming run number");
      assert.equal(next.retryContext.maxAttempts, sprintArchMaxAttempts());
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("attempt ceiling parks the workflow with an exhaustion reason", () => {
    const cwd = tmpDir("kstack-le-");
    try {
      const ceiling = sprintMaxAttempts();
      const state = sprintState(9, { attempts: { "devsecops-review->implement": ceiling - 1 } });
      devsecopsRecords(cwd, state, { "code-review": "rejected" });
      const next = advancePhase(state, "devsecops-review", { status: "completed", summary: "still failing" }, total, { phases: SPRINT.phases, cwd });
      assert.equal(next.status, "paused");
      assert.match(next.pausedReason!, /^loop-exhausted:implement/);
      assert.equal(next.attempts["devsecops-review->implement"], ceiling);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("security critical/high freeze parks WITHOUT advancing or burning attempts (D3)", () => {
    const cwd = tmpDir("kstack-le-");
    try {
      const state = sprintState(9, { sprintNumber: 7, attempts: { "devsecops-review->implement": 1 } });
      devsecopsRecords(cwd, state, { "security-review": "rejected", severity: "critical" });
      const next = advancePhase(state, "devsecops-review", { status: "completed", summary: "severe finding" }, total, { phases: SPRINT.phases, cwd });
      assert.ok(isSecurityFrozen(next));
      assert.equal(next.status, "paused");
      assert.equal(next.phaseIndex, 9, "held at the review phase");
      assert.equal(next.attempts["devsecops-review->implement"], 1, "no attempt burned");
      assert.match(next.freezeInfo.artifactPath, /security-review-artifact_07\.md$/);
      assert.equal(next.results["devsecops-review"].summary, "severe finding", "gate result still recorded");

      const resumed = unfreeze(next);
      assert.equal(isSecurityFrozen(resumed), false);
      assert.equal(resumed.status, "active");
      assert.equal(resumed.phaseIndex, 9, "resume re-runs the review gate");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("medium severity security rejection loops back instead of freezing (D3)", () => {
    const cwd = tmpDir("kstack-le-");
    try {
      const state = sprintState(9);
      devsecopsRecords(cwd, state, { "security-review": "rejected", severity: "medium" });
      const next = advancePhase(state, "devsecops-review", { status: "completed", summary: "minor finding" }, total, { phases: SPRINT.phases, cwd });
      assert.equal(next.phaseIndex, 7, "back to implement");
      assert.equal(isSecurityFrozen(next), false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("failed phase pauses without routing on the verdict", () => {
    const state = sprintState(8, {
      pendingVerdict: { phaseId: "qa-browsing", parsed: { verdicts: { status: "red" } }, excerpt: "" },
    });
    const next = advancePhase(state, "qa-browsing", { status: "failed", summary: "crashed" }, total, { phases: SPRINT.phases, cwd: process.cwd() });
    assert.equal(next.status, "paused");
    assert.equal(next.phaseIndex, 8);
    assert.equal(next.pendingVerdict, undefined, "verdict consumed/cleared on failure");
  });

  test("retryContext clears when its target completes again", () => {
    const cwd = tmpDir("kstack-le-");
    try {
      const state = sprintState(9, {
        retryContext: { targetPhaseId: "implement", attempt: 2, maxAttempts: 4, feedback: "fix X" },
      });
      devsecopsRecords(cwd, state, {});
      const next = advancePhase(state, "devsecops-review", { status: "completed", summary: "clean" }, total, { phases: SPRINT.phases, cwd });
      assert.equal(next.phaseIndex, 10);
      assert.equal(next.retryContext, undefined);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("phases without loopBackTo advance linearly even with a stale pendingVerdict", () => {
    const state = sprintState(0, {
      pendingVerdict: { phaseId: "explore", parsed: { verdicts: { status: "red" } }, excerpt: "" },
    });
    const next = advancePhase(state, "explore", { status: "completed", summary: "ok" }, total, { phases: SPRINT.phases, cwd: process.cwd() });
    assert.equal(next.phaseIndex, 1);
    assert.equal(next.status, "active");
  });
});

// --- Per-gate loop budget (attempts keyed by gate->target) --------------------

describe("per-gate loop budget (attempts keyed by gate->target)", () => {
  const total = SPRINT.phases.length;
  const IMPL = SPRINT.phases.findIndex((p) => p.id === "implement");
  const QA = SPRINT.phases.findIndex((p) => p.id === "qa-browsing");
  const DEVSECOPS = SPRINT.phases.findIndex((p) => p.id === "devsecops-review");

  /** Drive the qa-browsing gate: a RED verdict loops back to implement. */
  function qaRejects(cwd: string, state: any) {
    writeRec(cwd, state, "qa-browsing", "test", { status: "red" });
    return advancePhase(state, "qa-browsing", { status: "completed", summary: "qa found issues" }, total, { phases: SPRINT.phases, cwd });
  }

  /** Drive implement to an APPROVED verdict (the target phase runs again). */
  function implementApproves(cwd: string, state: any) {
    const approved = { ...state, phaseIndex: IMPL, pendingVerdict: { phaseId: "implement", parsed: { verdicts: { "be-walk": "pass" } }, excerpt: "" } };
    return advancePhase(approved, "implement", { status: "completed", summary: "shipped" }, total, { phases: SPRINT.phases, cwd });
  }

  test("implement's approval must not reset the QA gate's budget — the ceiling fires after N rejections", () => {
    const cwd = tmpDir("kstack-budget-");
    try {
      const ceiling = sprintMaxAttempts();
      let state: any = sprintState(QA);
      for (let i = 1; i < ceiling; i++) {
        const rejected = qaRejects(cwd, state);
        assert.equal(rejected.status, "active", `rejection ${i} must loop back, not park`);
        assert.equal(rejected.phaseIndex, IMPL, "loops back to implement");
        assert.equal(rejected.attempts["qa-browsing->implement"], i, "the QA gate charged its own budget");

        state = implementApproves(cwd, rejected);
        assert.equal(state.phaseIndex, QA, "implement approved → back at the QA gate");
        assert.equal(state.attempts["qa-browsing->implement"], i, "implement's approval must NOT reset the QA budget");
        assert.equal(state.attempts["implement->implement"], undefined, "implement's own self-loop budget is separate");
      }
      // The Nth rejection exhausts the QA gate's budget → park for the human.
      const exhausted = qaRejects(cwd, state);
      assert.equal(exhausted.status, "paused");
      assert.match(exhausted.pausedReason!, new RegExp(`^loop-exhausted:implement after ${ceiling} runs$`));
      assert.equal(exhausted.attempts["qa-browsing->implement"], ceiling);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("each gate owns its budget — devsecops-review's counter is independent of qa-browsing's", () => {
    const cwd = tmpDir("kstack-budget-");
    try {
      // qa-browsing rejects twice (its own budget burns twice).
      let state: any = sprintState(QA);
      state = qaRejects(cwd, state);
      state = implementApproves(cwd, state);
      state = qaRejects(cwd, state);
      assert.equal(state.attempts["qa-browsing->implement"], 2);

      // devsecops-review rejects once — its own counter starts at 1.
      writeRec(cwd, state, "devsecops-review", "code-review", { "code-review": "rejected" });
      writeRec(cwd, state, "devsecops-review", "security", { "security-review": "approved" });
      const devRejected = advancePhase(
        { ...state, phaseIndex: DEVSECOPS },
        "devsecops-review",
        { status: "completed", summary: "code review rejected" },
        total,
        { phases: SPRINT.phases, cwd },
      );
      assert.equal(devRejected.phaseIndex, IMPL, "devsecops-review loops back to implement");
      assert.equal(devRejected.attempts["devsecops-review->implement"], 1, "the devsecops gate has its own budget");
      assert.equal(devRejected.attempts["qa-browsing->implement"], 2, "the QA budget is untouched by the other gate");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

// --- D4 park helpers -------------------------------------------------------------

describe("D4 park helpers", () => {
  test("park is idempotent and burns no attempts", () => {
    const state = sprintState(7, { attempts: { "implement->implement": 2 } });
    const parked = parkForUnreadableVerdict(state, "devsecops-review", "no-verdict");
    assert.equal(parked.status, "paused");
    assert.equal(parked.verdictPark, "devsecops-review");
    assert.equal(parked.pausedReason, "verdict-unreadable:devsecops-review:no-verdict");
    const reparked = parkForUnreadableVerdict(parked, "devsecops-review", "artifact-mismatch");
    assert.equal(reparked, parked, "idempotent — a second park keeps the original cause");
  });

  test("forceApproveParked advances past the gate and records the decision", () => {
    const parked = parkForUnreadableVerdict(sprintState(8), "qa-browsing", "no-verdict");
    const next = forceApproveParked(parked);
    assert.equal(next.phaseIndex, 9);
    assert.equal(next.status, "active");
    assert.match(next.results["qa-browsing"].summary, /unreadable/i);
    assert.equal(next.verdictPark, undefined);
    assert.equal(next.pendingVerdict, undefined);
  });

  test("returnParkedWithContext loops back without incrementing attempts", () => {
    const parked = parkForUnreadableVerdict(sprintState(8, { attempts: { "qa-browsing->implement": 1 } }), "qa-browsing", "no-verdict");
    const next = returnParkedWithContext(parked, SPRINT.phases, "custom guidance");
    assert.ok(next);
    assert.equal(next!.phaseIndex, 7, "back to implement");
    assert.equal(next!.attempts["qa-browsing->implement"], 1, "no burn");
    assert.ok(next!.retryContext.feedback.includes("custom guidance"));
  });

  test("returnParkedWithContext refuses non-looping phases (null)", () => {
    // Parked at a phase with no routing edge in the workflow definition —
    // develop's `document` carries no loopBackTo.
    const parked = parkForUnreadableVerdict(sprintState(8), "document", "no-verdict");
    assert.equal(returnParkedWithContext(parked, getWorkflow("develop")!.phases), null);
  });

  test("forceContinuePastGate skips one gate forward and clears pause markers", () => {
    const state = sprintState(9, { pausedReason: "loop-exhausted:implement after 4 runs", pendingVerdict: { phaseId: "devsecops-review", parsed: null, excerpt: "" } });
    const next = forceContinuePastGate(state);
    assert.equal(next.phaseIndex, 10);
    assert.equal(next.status, "active");
    assert.equal(next.pendingVerdict, undefined);
    assert.equal(next.pausedReason, undefined);
  });

  test("phaseIndex-moving park transitions clear a stale stepIndex (S3 review: gate-bypass class)", () => {
    // A stepIndex surviving a phaseIndex move flips insidePhase on the new
    // phase — entry gates skipped, only the last step delivered. Latent today
    // (no stepped phase neighbors a gate) but the invariant must hold.
    const withCursor = { stepIndex: 2 };

    const approved = forceApproveParked(parkForUnreadableVerdict(sprintState(8, withCursor), "qa-browsing", "no-verdict"));
    assert.equal(approved.stepIndex, undefined, "forceApproveParked");

    const returned = returnParkedWithContext(parkForUnreadableVerdict(sprintState(8, withCursor), "qa-browsing", "no-verdict"), SPRINT.phases);
    assert.ok(returned);
    assert.equal(returned!.stepIndex, undefined, "returnParkedWithContext");

    const continued = forceContinuePastGate(sprintState(9, { ...withCursor, pausedReason: "loop-exhausted:implement", pendingVerdict: { phaseId: "devsecops-review", parsed: null, excerpt: "" } }));
    assert.equal(continued.stepIndex, undefined, "forceContinuePastGate");

    const reissued = reissueGate(sprintState(9, { ...withCursor, pausedReason: "loop-exhausted:implement" }), SPRINT.phases);
    assert.equal(reissued.stepIndex, undefined, "reissueGate (non-resume path)");

    // And the resume paths still KEEP the cursor — same-phase mid-step resume
    // is the legitimate carrier.
    const kept = resumeState(sprintState(2, { ...withCursor, pausedReason: "step-failed:plan.draft" }));
    assert.equal(kept.stepIndex, 2, "resumeState keeps stepIndex (same-phase mid-step)");
  });
});

describe("D4 park cause distinction", () => {
  test("the three causes encode distinctly in pausedReason", () => {
    for (const cause of ["no-verdict", "artifact-mismatch", "unroutable"] as const) {
      const parked = parkForUnreadableVerdict(sprintState(8), "qa-browsing", cause);
      assert.equal(parked.pausedReason, `verdict-unreadable:qa-browsing:${cause}`);
    }
  });

  test("a whitelisted-but-off-map verdict parks with the unroutable cause", () => {
    // `software-architect-review == success` is whitelisted but neither
    // expected-positive nor a routing negative at architect-gate (BUG-1).
    const cwd = tmpDir("kstack-cause-");
    try {
      const state = sprintState(5);
      writeRec(cwd, state, "architect-gate", "review", { "software-architect-review": "success" });
      const next = advancePhase(state, "architect-gate", { status: "completed", summary: "ambiguous" }, SPRINT.phases.length, {
        phases: SPRINT.phases,
        cwd,
      });
      assert.equal(next.status, "paused");
      assert.equal(next.phaseIndex, 5, "held at the gate — no completion recorded");
      assert.equal(next.verdictPark, "architect-gate");
      assert.equal(next.pausedReason, "verdict-unreadable:architect-gate:unroutable");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("the D4 panel prompt names the cause for triage", async () => {
    const prompts: string[] = [];
    const ui = {
      notify: () => {},
      setStatus: () => {},
      input: async () => undefined,
      select: async (prompt: string) => {
        prompts.push(prompt);
        return undefined; // dismissed — no mutating branch runs
      },
      confirm: async () => false,
    };
    const cmdCtx: any = { ui };
    const pi: any = { appendEntry: () => {} };

    for (const [cause, pattern] of [
      ["no-verdict", /no trustworthy verdict/i],
      ["artifact-mismatch", /on-disk artifact/i],
      ["unroutable", /expectation map/i],
    ] as const) {
      prompts.length = 0;
      const parked = parkForUnreadableVerdict(sprintState(8), "qa-browsing", cause);
      assert.equal(await handleSprintPanel(parked, cmdCtx, pi), true);
      assert.match(prompts[0] ?? "", pattern, `panel prompt must name the "${cause}" cause`);
    }
  });
});

// --- State migration ---------------------------------------------------------------

describe("state migration (v2 fields default on old states)", () => {
  test("createState stamps version 5 + fresh attempt counters", () => {
    const s = createState("sprint", "goal");
    assert.equal(s.version, 5); // v5: S4 vars/capabilities/ephemeral/resumeMode
    assert.deepEqual(s.attempts, {});
  });

  test("advancePhase tolerates states missing attempts entirely (pre-sprint sessions)", () => {
    const old = { ...createState("investigate", "goal"), version: undefined, attempts: undefined };
    const next = advancePhase(old as any, "reproduce", { status: "completed", summary: "ok" }, 5);
    assert.deepEqual(next.attempts, {});
    assert.equal(next.phaseIndex, 1);
  });
});

// --- Sprint numbering (E5) -----------------------------------------------------------

describe("sprint numbering discovery (E5)", () => {
  test("pad2 zero-pads", () => {
    assert.equal(pad2(7), "07");
    assert.equal(pad2(12), "12");
  });

  test("empty project ⇒ next is 01", () => {
    const tmp = tmpDir("kstack-num-");
    try {
      assert.deepEqual(computeNextSprintNumber(tmp), { next: 1, anomaly: null });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("gaps are fine: root 01 + archive 03 ⇒ 04", () => {
    const tmp = tmpDir("kstack-num-");
    try {
      writeFileSync(path.join(tmp, "user-story_01.md"), "x");
      const arch = path.join(tmp, ".kstack", "sprints", "sprint_03");
      fs.mkdirSync(arch, { recursive: true });
      writeFileSync(path.join(arch, "user-story_03.md"), "x");
      assert.deepEqual(computeNextSprintNumber(tmp), { next: 4, anomaly: null });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("archive-only history counts toward the max", () => {
    const tmp = tmpDir("kstack-num-");
    try {
      const arch = path.join(tmp, ".kstack", "sprints", "sprint_05");
      fs.mkdirSync(arch, { recursive: true });
      writeFileSync(path.join(arch, "user-story_05.md"), "x");
      assert.equal(computeNextSprintNumber(tmp).next, 6);
      assert.deepEqual(archivedSprintDirs(tmp).map((d) => path.basename(d)), ["sprint_05"]);
      assert.equal(sprintArchiveDir(tmp, 6), path.join(tmp, ".kstack", "workflows", "sprint", "sprint_06"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("root/archive collision ⇒ hijack-guard anomaly (never guess)", () => {
    const tmp = tmpDir("kstack-num-");
    try {
      writeFileSync(path.join(tmp, "user-story_02.md"), "live?");
      const arch = path.join(tmp, ".kstack", "sprints", "sprint_02");
      fs.mkdirSync(arch, { recursive: true });
      writeFileSync(path.join(arch, "user-story_02.md"), "archived?");
      const d = computeNextSprintNumber(tmp);
      assert.ok(Number.isNaN(d.next));
      assert.match(d.anomaly!, /both in project root/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test(">1 live sprint in root ⇒ anomaly", () => {
    const tmp = tmpDir("kstack-num-");
    try {
      writeFileSync(path.join(tmp, "user-story_02.md"), "a");
      writeFileSync(path.join(tmp, "user-story_09.md"), "b");
      const d = computeNextSprintNumber(tmp);
      assert.ok(Number.isNaN(d.next));
      assert.match(d.anomaly!, /un-archived sprints/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("non user-story files are ignored by the scan", () => {
    const tmp = tmpDir("kstack-num-");
    try {
      writeFileSync(path.join(tmp, "README.md"), "x");
      writeFileSync(path.join(tmp, "tasks_99.md"), "x");
      writeFileSync(path.join(tmp, "user-story_notanumber.md"), "x");
      assert.deepEqual(computeNextSprintNumber(tmp), { next: 1, anomaly: null });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// --- Conditional digests (D14) + glossary (E6) -----------------------------------------

describe("conditional digests (D14) + glossary injection (E6)", () => {
  test("docker/pipeline digests dropped when their trigger is absent", () => {
    const tmp = tmpDir("kstack-cond-");
    try {
      assert.deepEqual(conditionalSkillIds(["kstack-review", "kstack-docker-manager", "kstack-pipeline-sre"], tmp), ["kstack-review"]);
      writeFileSync(path.join(tmp, "Dockerfile"), "FROM node");
      fs.mkdirSync(path.join(tmp, ".github", "workflows"), { recursive: true });
      writeFileSync(path.join(tmp, ".github", "workflows", "ci.yml"), "on: push");
      assert.deepEqual(
        conditionalSkillIds(["kstack-review", "kstack-docker-manager", "kstack-pipeline-sre"], tmp),
        ["kstack-review", "kstack-docker-manager", "kstack-pipeline-sre"],
      );
      assert.equal(conditionalSkillIds(undefined, tmp), undefined);
      assert.deepEqual(conditionalSkillIds(["kstack-review"], undefined), ["kstack-review"], "no cwd ⇒ passthrough");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("glossaryTable scrapes the BINDING table from system-design_XX.md", () => {
    const tmp = tmpDir("kstack-glos-");
    try {
      writeFileSync(
        path.join(tmp, `system-design_${pad2(3)}.md`),
        "# Design\n\n## Ubiquitous Language\n\n| Term | Definition | Forbidden synonym |\n|---|---|---|\n| Cart | basket | trolley |\n\n## Next\nother",
      );
      const g = glossaryTable(tmp, 3);
      assert.match(g, /BINDING/);
      assert.match(g, /trolley/);
      assert.ok(!g.includes("other"), "stops at the next ## heading");
      assert.match(glossaryTable(tmp, 99), /not yet available/, "missing file degrades to placeholder");
      assert.match(glossaryTable(process.cwd(), undefined), /not yet available/, "no sprint number yet ⇒ placeholder");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("retryContextBlock leads looped-back instructions with blockers", () => {
    const ctx = makeCtx(6);
    ctx.state.retryContext = { targetPhaseId: "implement", attempt: 3, maxAttempts: 4, feedback: "- CRITICAL bug @ a.ts:1" };
    assert.match(retryContextBlock(ctx, "implement"), /RETRY CONTEXT \(attempt 3\/4\)/);
    assert.ok(retryContextBlock(ctx, "implement").includes("CRITICAL bug"));
    assert.equal(retryContextBlock(ctx, "qa-browsing"), "", "non-target phase gets nothing");
    ctx.state.retryContext = { targetPhaseId: "implement", attempt: 2, maxAttempts: 4, feedback: "" };
    assert.match(retryContextBlock(ctx, "implement"), /re-read the prior review/);
  });
});

// --- Sprint instruction assembly ----------------------------------------------------------

describe("sprint instruction assembly", () => {
  function sprintCtx(phaseIndex: number): any {
    const ctx = makeCtx(phaseIndex);
    ctx.state.sprintNumber = 7;
    return ctx;
  }

  test("{sprint} interpolates zero-padded into contracts", () => {
    const instructions = buildPhaseInstructions(findPhaseSafe("user-story"), sprintCtx(2));
    assert.match(instructions, /user-story_07\.md/);
    const plan = buildDeterministicPlan(findPhaseSafe("architect-gate"), sprintCtx(5));
    assert.match(plan[0].task, /Sprint 07/);
    assert.ok(!plan[0].task.includes("{sprint}"), "token fully replaced");
  });

  test("master DoD lands ONLY on sprint execution phases (P07–P10)", () => {
    // Step model (S4): the DoD contract attaches to the phase's last plan
    // entry in the single-plan fallback AND per delegated step at dispatch.
    for (const id of ["implement", "devsecops-review", "qa-browsing", "docker-review", "pipeline-review", "archive"]) {
      const plan = buildDeterministicPlan(findPhaseSafe(id), sprintCtx(7));
      assert.ok(plan[plan.length - 1].task.includes(MASTER_DOD), `${id} carries MASTER_DOD`);
    }
    const storyInstructions = buildPhaseInstructions(findPhaseSafe("user-story"), sprintCtx(2));
    assert.equal(storyInstructions.includes(MASTER_DOD), false, "planning phases carry no DoD");
    const backlogPlan = buildDeterministicPlan(findPhaseSafe("backlog"), sprintCtx(6));
    assert.equal(backlogPlan[backlogPlan.length - 1].task.includes(MASTER_DOD), false, "backlog is not an execution phase");
  });

  test("verdict dual-channel duty is instructed in gate step tasks", () => {
    // S4: verdict instructions live in the delegated step's task contract —
    // `--verdict <var>==<value>` inside a kstack-report record, not HANDOFF
    // lines in a chain tail.
    const qaTask = findPhaseSafe("qa-browsing").steps![0].task;
    assert.match(qaTask, /--verdict status==green/);
    assert.match(qaTask, /==orange/);
    assert.match(qaTask, /==red/);
    const archTask = findPhaseSafe("architect-gate").steps![0].task;
    assert.match(archTask, /--verdict software-architect-review==approved/);
    assert.match(archTask, /==rejected/);
    const revSteps = findPhaseSafe("devsecops-review").steps!;
    assert.match(revSteps[0].task, /--verdict code-review==approved/);
    assert.match(revSteps[0].task, /==rejected/);
    assert.match(revSteps[1].task, /--verdict security-review==approved/);
    assert.match(revSteps[1].task, /==rejected/);
    assert.match(revSteps[1].task, /--verdict severity==/);
  });

  test("B8: no copiable placeholder verdict line remains in any gate step task", () => {
    // A literal-minded agent copying the instruction verbatim would write a
    // value that fails the closed whitelist and park the whole gate. Every
    // instructed verdict line must be a concrete whitelist value (or an
    // explicitly bracketed <choice> that cannot parse).
    for (const phaseId of ["architect-gate", "devsecops-review", "qa-browsing", "docker-review", "pipeline-review", "implement"]) {
      for (const step of findPhaseSafe(phaseId).steps ?? []) {
        assert.doesNotMatch(
          step.task,
          /==\s*(approved\|rejected|green\|red\|orange|success\|failed|critical\|high\|medium\|low)/,
          `${phaseId}.${step.id} task still contains a copiable placeholder verdict line`,
        );
      }
    }
  });

  test("timeout classes cover all sprint phases 1:1", () => {
    for (const p of SPRINT.phases) {
      assert.notEqual(timeoutClassFor(p.id), null, `${p.id} unmapped`);
    }
  });
});

function findPhaseSafe(phaseId: string) {
  const phase = SPRINT.phases.find((p) => p.id === phaseId);
  if (!phase) throw new Error(`phase not found: ${phaseId}`);
  return phase;
}

// --- Model tiers (E4/D10, inert by default) -------------------------------------------------

describe("model tiers (E4/D10, inert by default)", () => {
  const KEYS = ["KSTACK_PI_MODEL_STRONG", "KSTACK_PI_MODEL_FAST"];
  let saved: Record<string, string | undefined>;

  function setup() {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  function restore() {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }

  test("unset envs ⇒ undefined override everywhere (inert)", () => {
    setup();
    try {
      assert.equal(modelTierFor("implement"), undefined);
      assert.equal(modelTierFor("explore"), undefined);
    } finally {
      restore();
    }
  });

  test("STRONG routes judgment phases; FAST everything else; unset side keeps agent default", () => {
    setup();
    try {
      process.env.KSTACK_PI_MODEL_STRONG = "strong/model";
      assert.equal(modelTierFor("implement"), "strong/model");
      assert.equal(modelTierFor("qa-browsing"), "strong/model");
      assert.equal(modelTierFor("explore"), undefined, "FAST unset ⇒ keep agent default");

      process.env.KSTACK_PI_MODEL_FAST = "fast/model";
      assert.equal(modelTierFor("explore"), "fast/model");

      process.env.KSTACK_PI_MODEL_STRONG = "";
      assert.equal(modelTierFor("implement"), undefined, "empty env falls back to agent default");
    } finally {
      restore();
    }
  });
});

// --- Code-review pass-1 fixes (B1 / B2 / B3) ---------------------------------

describe("code-review pass-1 fixes", () => {
  test("B1: verdicts must be parsed from the UNCAPPED rawOutput, not the 50KB-capped output", () => {
    // Mirrors spawn.ts: output = capOutput(rawOutput) — truncated at 50KB with
    // a truncation marker appended. The ## HANDOFF trails the report, so the
    // capped channel amputates exactly the lines the parser needs.
    const handoff = [
      "## HANDOFF",
      "VERIFIED FACTS: implementation complete @ src/app.ts:1",
      "DECISIONS: none",
      "status == green",
    ].join("\n");
    const rawOutput = `${"x".repeat(60_000)}\n\n## REPORT\nfull report body\n\n${handoff}\n`;
    const output = `${rawOutput.slice(0, 50 * 1024)}\n…(truncated)`;

    assert.ok(rawOutput.length > 50 * 1024, "precondition: raw output exceeds the cap");
    assert.ok(!output.includes("## HANDOFF"), "precondition: capped channel lost the HANDOFF");

    assert.equal(parseHandoffVerdicts(rawOutput).parsed?.verdicts["status"], "green");
    assert.equal(parseHandoffVerdicts(output).parsed, null, "the capped channel must NOT parse — the executor must feed rawOutput");
  });

  test("B2: retryTimeoutMs scales the per-phase class timeout, not the global default", () => {
    const saved = process.env.KSTACK_PI_SUBAGENT_TIMEOUT;
    try {
      process.env.KSTACK_PI_SUBAGENT_TIMEOUT = "300";
      // "verify" class = 900s per TIMEOUT_CLASS_MAP — the retry must scale
      // 900s, not the 300s global default (which would LOWER the limit).
      assert.equal(retryTimeoutMs({ phaseId: "verify" }, 1.5), 900 * 1000 * 1.5);
      // Explicit per-request override still wins.
      assert.equal(retryTimeoutMs({ timeoutMs: 1000 }, 1.5), 1500);
      // No phaseId, no override → global default (here 300s via the env set
      // above; unset it would be the 20-min DEFAULT_TIMEOUT_MS) scaled.
      assert.equal(retryTimeoutMs({}, 1.5), 300 * 1000 * 1.5);
      delete process.env.KSTACK_PI_SUBAGENT_TIMEOUT;
      assert.equal(retryTimeoutMs({}, 1.5), 20 * 60 * 1000 * 1.5, "unset env → built-in 20-min default, scaled");
    } finally {
      if (saved === undefined) delete process.env.KSTACK_PI_SUBAGENT_TIMEOUT;
      else process.env.KSTACK_PI_SUBAGENT_TIMEOUT = saved;
    }
  });

  test("B3: buildRetryFeedback finds SPRINT-STAMPED review artifacts", () => {
    const parsed = { verdicts: { "code-review": "rejected" } };
    const dir = tmpDir("kstack-b3-");
    try {
      fs.mkdirSync(path.join(dir, "devsecops"), { recursive: true });
      writeFileSync(
        path.join(dir, "devsecops", "code-review-artifact_03.md"),
        "# Code Review\n\n- CRITICAL: SQL injection @ app/db.ts:42\n- WARNING: missing input validation @ app/api.ts:10\n",
      );
      const feedback = buildRetryFeedback(parsed as any, "devsecops-review", dir, 3);
      assert.match(feedback, /SQL injection/, "stamped artifact must supply the retry blockers");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Negative pin: the UNSTAMPED artifact name satisfies nothing — this is
    // the exact bug (the old code scanned unstamped names and got silence).
    const unstampedDir = tmpDir("kstack-b3u-");
    try {
      fs.mkdirSync(path.join(unstampedDir, "devsecops"), { recursive: true });
      writeFileSync(path.join(unstampedDir, "devsecops", "code-review-artifact.md"), "- CRITICAL: old finding\n");
      assert.equal(buildRetryFeedback(parsed as any, "devsecops-review", unstampedDir, 3), "");
    } finally {
      rmSync(unstampedDir, { recursive: true, force: true });
    }
  });

  test("B4: shouldReopenFullChain — a REFUTED validate step mandates the reopen", () => {
    assert.equal(shouldReopenFullChain(true, "REFUTED: the null check was already present"), true);
    assert.equal(shouldReopenFullChain(true, "VALIDATED: mechanism confirmed @ app/db.ts:42"), false);
    assert.equal(shouldReopenFullChain(false, "REFUTED: x"), false, "only a collapsed chain reopens");
    assert.equal(shouldReopenFullChain(true, undefined), false);
    assert.equal(shouldReopenFullChain(true, ""), false);
  });

  test("B5: severity is disk-verified (freeze/loop-back routing cannot rest on the HANDOFF alone)", () => {
    const dir = tmpDir("kstack-b5-");
    try {
      fs.mkdirSync(path.join(dir, "devsecops"), { recursive: true });
      writeFileSync(
        path.join(dir, "devsecops", "security-review-artifact_03.md"),
        "# Security Review\n\nsecurity-review == rejected\n\nseverity == high\n",
      );
      const rejected: any = { verdicts: { "security-review": "rejected" } };

      // HANDOFF and disk agree on high ⇒ verified.
      assert.equal(verifyArtifactVerdicts({ ...rejected, severity: "high" } as any, dir, 3), true);
      // Severity missing on disk (only in the HANDOFF) ⇒ fail closed.
      assert.equal(verifyArtifactVerdicts({ ...rejected, severity: "low" } as any, dir, 3), false, "downgrade without disk confirmation must fail");
      // No severity claimed ⇒ severity check simply doesn't apply.
      assert.equal(verifyArtifactVerdicts(rejected, dir, 3), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("B6: KSTACK_PI_VERDICTS=off parks verdict-bearing phases instead of silently advancing", () => {
    const saved = process.env.KSTACK_PI_VERDICTS;
    try {
      process.env.KSTACK_PI_VERDICTS = "off";
      const state = sprintState(7); // devsecops-review (verdict-bearing)
      const next = advancePhase(state, "devsecops-review", { status: "completed", summary: "gate ran" }, SPRINT.phases.length, { phases: SPRINT.phases });
      assert.equal(next.status, "paused");
      assert.equal(next.pausedReason, "verdicts-disabled:devsecops-review");
      assert.equal(next.results["devsecops-review"]?.status, "completed", "the gate did run — it is recorded, then parked");
      assert.equal(next.phaseIndex, 7, "phaseIndex must not advance past the gate");
    } finally {
      if (saved === undefined) delete process.env.KSTACK_PI_VERDICTS;
      else process.env.KSTACK_PI_VERDICTS = saved;
    }
  });

  test("B9: reissueGate restores exactly one verified loop-target run after exhaustion", () => {
    const ceiling = sprintMaxAttempts(); // 4 by default
    const devsecopsIndex = SPRINT.phases.findIndex((p) => p.id === "devsecops-review");
    const exhausted = sprintState(devsecopsIndex, {
      status: "paused" as const,
      pausedReason: `loop-exhausted:implement after ${ceiling} runs`,
      attempts: { "devsecops-review->implement": ceiling },
    });

    const reissued = reissueGate(exhausted, SPRINT.phases);
    assert.equal(reissued.status, "active");
    assert.equal(reissued.pausedReason, undefined);
    assert.equal(reissued.attempts!["devsecops-review->implement"], Math.max(0, ceiling - 2));
    // Non-exhaustion pauses pass through as a plain resume.
    assert.equal(reissueGate({ ...exhausted, pausedReason: "anomaly:dup" }, SPRINT.phases).status, "active");

    // The gate re-runs and REJECTS again: it must loop back to implement
    // (not re-park) — the human re-issue granted one verified target run.
    const rejectedVerdict = { phaseId: "devsecops-review", parsed: { verdicts: { "code-review": "rejected" } }, excerpt: "" };
    const after = advancePhase({ ...reissued, pendingVerdict: rejectedVerdict }, "devsecops-review", { status: "completed", summary: "gate re-ran, rejected" }, SPRINT.phases.length, { phases: SPRINT.phases });
    assert.equal(after.phaseIndex, SPRINT.phases.findIndex((p) => p.id === "implement"));
    assert.equal(after.status, "active");
    assert.equal(after.attempts!["devsecops-review->implement"], ceiling - 1);

    // A SECOND consecutive rejection re-exhausts and returns to the human.
    const after2 = advancePhase({ ...after, phaseIndex: devsecopsIndex, pendingVerdict: rejectedVerdict }, "devsecops-review", { status: "completed", summary: "gate re-ran, rejected again" }, SPRINT.phases.length, { phases: SPRINT.phases });
    assert.equal(after2.status, "paused");
    assert.match(after2.pausedReason ?? "", /loop-exhausted:implement/);
  });

// --- mindrun fix guards (F1 / F3) ----------------------------------------------

describe("advanceBlockReason (F1): every parked state is code-enforced", () => {
  test("an active state is not blocked", () => {
    assert.equal(advanceBlockReason(sprintState(7, { status: "active" })), null);
  });

  test("awaiting_approval (manual decision gate) is blocked", () => {
    const blocked = advanceBlockReason(sprintState(4, { status: "awaiting_approval" }));
    assert.ok(blocked, "manual gate must refuse kstack_advance");
  });

  test("security freeze is blocked — a repeat kstack_advance cannot bypass it (F1 core)", () => {
    const frozen = sprintState(7, {
      status: "paused",
      frozenUntilHuman: true,
      pausedReason: "security-freeze:devsecops-review",
    });
    const blocked = advanceBlockReason(frozen);
    assert.ok(blocked, "the second advance on a frozen sprint must be refused");
    assert.match(blocked!, /FROZEN/i);
  });

  test("pausedReason-only freeze (no flag) is also blocked", () => {
    const frozen = sprintState(7, { status: "paused", pausedReason: "security-freeze:devsecops-review" });
    assert.match(advanceBlockReason(frozen)!, /FROZEN/i);
  });

  test("unreadable-verdict park is blocked", () => {
    const parked = parkForUnreadableVerdict(sprintState(8, { status: "paused" }), "qa-verdict", "no-verdict");
    const blocked = advanceBlockReason(parked);
    assert.ok(blocked, "D4 park must refuse kstack_advance");
    assert.match(blocked!, /unreadable/i);
  });

  test("loop exhaustion, anomaly and kill-switch parks are all blocked", () => {
    const reasons = [
      "loop-exhausted:implement after 4 runs",
      "anomaly:sprint number 02 exists both in root and archive",
      "verdicts-disabled:qa-verdict",
      "loopback-disabled:devsecops-review",
    ];
    for (const reason of reasons) {
      const blocked = advanceBlockReason(sprintState(7, { status: "paused", pausedReason: reason }));
      assert.ok(blocked, `expected a block reason for "${reason}"`);
    }
  });

  test("failed-phase pause (no reason string) is blocked too", () => {
    const blocked = advanceBlockReason(sprintState(8, { status: "paused" }));
    assert.ok(blocked, "a failed phase must not be re-advanced to completed by the model");
  });

  test("F1 end-to-end: freeze consumes the verdict, second advance is refused", () => {
    // 1st advance: critical security rejection ⇒ freeze parks (routing runs).
    const state = sprintState(7, {
      sprintNumber: 7,
      pendingVerdict: {
        phaseId: "devsecops-review",
        parsed: { verdicts: { "security-review": "rejected" }, severity: "critical" },
        excerpt: "",
      },
    });
    const frozen = advancePhase(state, "devsecops-review", { status: "completed", summary: "severe finding" }, SPRINT.phases.length, {
      phases: SPRINT.phases,
      cwd: process.cwd(),
    });
    assert.ok(isSecurityFrozen(frozen), "first advance freezes");
    assert.equal(frozen.phaseIndex, 7, "phaseIndex held at the gate");
    assert.equal(frozen.pendingVerdict, undefined, "verdict consumed — routing can never re-trigger");

    // 2nd advance: the tool-level guard must refuse BEFORE advancePhase runs
    // (with pendingVerdict gone, advancePhase routing would silently skip).
    const blocked = advanceBlockReason(frozen);
    assert.ok(blocked, "second kstack_advance on the frozen state must be blocked");
    assert.match(blocked!, /FROZEN/i);
  });
});

describe("forceContinuePastGate (F3): the next gate gets a fresh loop budget", () => {
  test("accepting an exhausted gate resets the target counter", () => {
    const ceiling = sprintMaxAttempts();
    const devsecopsIndex = SPRINT.phases.findIndex((p) => p.id === "devsecops-review");
    const state = sprintState(devsecopsIndex, {
      attempts: { "devsecops-review->implement": ceiling },
      pausedReason: `loop-exhausted:implement after ${ceiling} runs`,
    });
    const next = forceContinuePastGate(state, SPRINT.phases);
    assert.equal(next.phaseIndex, devsecopsIndex + 1, "moves past the accepted gate");
    assert.equal(next.status, "active");
    assert.equal(next.attempts["devsecops-review->implement"], undefined, "loop budget reset");
    assert.equal(next.pausedReason, undefined);
  });

  test("after acceptance, qa-browsing's FIRST rejection loops back instead of parking (F3 regression)", () => {
    const ceiling = sprintMaxAttempts();
    const next = forceContinuePastGate(
      sprintState(8, { attempts: { "qa-browsing->implement": ceiling }, pausedReason: `loop-exhausted:implement after ${ceiling} runs` }),
      SPRINT.phases,
    );
    const rejected = advancePhase(
      { ...next, phaseIndex: 8, pendingVerdict: { phaseId: "qa-browsing", parsed: { verdicts: { status: "red" } }, excerpt: "" } },
      "qa-browsing",
      { status: "completed", summary: "red" },
      SPRINT.phases.length,
      { phases: SPRINT.phases, cwd: process.cwd() },
    );
    assert.equal(rejected.phaseIndex, 7, "loops back to implement with zero prior reruns");
    assert.equal(rejected.status, "active", "must NOT park on the first QA rejection");
    assert.equal(rejected.attempts["qa-browsing->implement"], 1, "budget starts fresh: this is rerun 1");
    assert.equal(rejected.retryContext?.targetPhaseId, "implement");
  });

  test("single-arg call stays compatible and leaves attempts untouched", () => {
    const state = sprintState(7, { attempts: { "devsecops-review->implement": 4 }, pausedReason: "loop-exhausted:implement after 4 runs" });
    const next = forceContinuePastGate(state);
    assert.equal(next.attempts["devsecops-review->implement"], 4);
    assert.equal(next.phaseIndex, 8);
  });
});

// --- mindrun fix guards (Q4): resume context re-anchors binding rules ---------

describe("buildResumeContext / activeConstraintLines (Q4)", () => {
  test("plain active state: no constraint lines, standard resume body", () => {
    const text = buildResumeContext(sprintState(7, { status: "active" }));
    assert.match(text, /\[kstack workflow active:/);
    assert.match(text, /\(8\/14\)/);
    assert.ok(!text.includes("CONSTRAINT:"), "a plain review phase carries no extra constraints");
  });

  test("frozen state re-anchors the freeze constraint", () => {
    const text = buildResumeContext(
      sprintState(7, { status: "paused", frozenUntilHuman: true, pausedReason: "security-freeze:devsecops-review" }),
    );
    assert.match(text, /CONSTRAINT: a review gate is FROZEN/);
  });

  test("unreadable-verdict park re-anchors the park constraint", () => {
    const parked = parkForUnreadableVerdict(sprintState(8, { status: "paused" }), "qa-browsing", "no-verdict");
    assert.match(buildResumeContext(parked), /CONSTRAINT: the phase's verdict was UNREADABLE/);
  });

  test("generic pause and failed-phase pause re-anchor constraints", () => {
    const paused = buildResumeContext(sprintState(7, { status: "paused", pausedReason: "loop-exhausted:implement after 4 runs" }));
    assert.match(paused, /CONSTRAINT: the workflow is PAUSED \(loop-exhausted:/);
    const failed = buildResumeContext(sprintState(8, { status: "paused" }));
    assert.match(failed, /CONSTRAINT: the previous phase FAILED/);
  });

  test("report-only and manual-decision phases re-anchor their posture", () => {
    const reportPhase: any = { id: "report", name: "Report", execution: "subagent", variant: "report-only" };
    assert.ok(activeConstraintLines(sprintState(8, { status: "active" }), reportPhase).some((l) => l.includes("REPORT-ONLY")));
    const arch = SPRINT.phases.find((p) => p.id === "architect-gate")!;
    assert.ok(activeConstraintLines(sprintState(5, { status: "active" }), arch).some((l) => l.includes("DECISION phase")));
    assert.deepEqual(activeConstraintLines(sprintState(7, { status: "active" }), SPRINT.phases[7]), []);
  });
});

describe("input router (Q4): short inputs still re-anchor during an active workflow", () => {
  function fakeRouterCtx(state: any): any {
    const entries = state ? [{ type: "custom", customType: "kstack-wf-state", data: state }] : [];
    return { sessionManager: { getEntries: () => entries } };
  }

  test('"ok" gets the resume prefix while a workflow is active (threshold bypassed)', () => {
    const handler = createInputRouter({} as any);
    const out = handler({ text: "ok", source: "interactive" }, fakeRouterCtx(sprintState(7, { status: "active" }))) as any;
    assert.equal(out.action, "transform");
    assert.ok(out.text.startsWith("[kstack workflow active:"));
    assert.ok(out.text.endsWith("ok"));
  });

  test("parked/frozen workflows also re-anchor short inputs (constraints included)", () => {
    const handler = createInputRouter({} as any);
    const out = handler(
      { text: "ok", source: "interactive" },
      fakeRouterCtx(sprintState(7, { status: "paused", frozenUntilHuman: true, pausedReason: "security-freeze:devsecops-review" })),
    ) as any;
    assert.equal(out.action, "transform");
    assert.match(out.text, /CONSTRAINT: a review gate is FROZEN/);
  });

  test("non-interactive and slash inputs are never transformed", () => {
    const handler = createInputRouter({} as any);
    assert.equal(handler({ text: "ok", source: "rpc" }, fakeRouterCtx(sprintState(7, { status: "active" }))).action, "continue");
    assert.equal(handler({ text: "/kstack", source: "interactive" }, fakeRouterCtx(sprintState(7, { status: "active" }))).action, "continue");
  });

  test("without an active workflow, short inputs still skip intent matching (unchanged threshold)", () => {
    const handler = createInputRouter({} as any);
    assert.equal(handler({ text: "ok", source: "interactive" }, fakeRouterCtx(null)).action, "continue");
  });

  test("parked manual gate re-anchors as PARKED, never as 'Continue working' (2026-09 fix 3)", () => {
    // The 2026-09 session bug: a plan tweak typed at the phase-3 decision gate
    // was prefixed with "Continue working on the current phase…", so the model
    // resumed and implemented the plan instead of staying parked.
    const handler = createInputRouter({} as any);
    const out = handler(
      { text: "make the nav more compact", source: "interactive" },
      fakeRouterCtx(sprintState(2, { status: "awaiting_approval" })),
    ) as any;
    assert.equal(out.action, "transform");
    assert.match(out.text, /PARKED for user approval/);
    assert.ok(!out.text.includes("Continue working on the current phase"));
    assert.ok(out.text.endsWith("make the nav more compact"));
  });

  test("without a workflow, input passes through untouched (no workflow suggestions)", () => {
    const handler = createInputRouter({} as any);
    const out = handler({ text: "investigate the failing login request", source: "interactive" }, fakeRouterCtx(null)) as any;
    assert.equal(out.action, "continue");
  });
});

describe("in-flight decision guards (2026-09 fix 4)", () => {
  function fakeCmdCtx(): any {
    const notified: string[] = [];
    return {
      ctx: {
        ui: { notify: (msg: string) => notified.push(msg) },
      },
      notified,
    };
  }

  test("decisionBlockedByInFlightChain refuses decisions while a chain runs", async () => {
    const { ctx } = fakeCmdCtx();
    const state = { ...createState("develop", "goal"), phaseIndex: 4, status: "awaiting_approval" as const, pendingOptional: true };

    assert.equal(decisionBlockedByInFlightChain(ctx, state), false, "no chain → decision allowed");

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    launchPhase({} as any, ctx, state, async () => { await gate; });

    assert.equal(decisionBlockedByInFlightChain(ctx, state), true, "in-flight chain → decision refused");
    release();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(decisionBlockedByInFlightChain(ctx, state), false, "settled chain → decision allowed again");
  });

  test("the guard is wired into the decision paths that mutate state", () => {
    // Static wiring check: all three decision mutations (optional Run, optional
    // Skip, manual-gate Approve via /kstack next) must consult the guard before
    // touching state — the 2026-09 race (skip ignored, phase advanced twice)
    // lived exactly in these paths.
    const source = readFileSync(new URL("../orchestrator/command.ts", import.meta.url), "utf-8");
    const optionalRun = source.indexOf("choice?.startsWith(\"Run\")");
    assert.ok(optionalRun > -1);
    const afterRun = source.slice(optionalRun, optionalRun + 300);
    assert.match(afterRun, /decisionBlockedByInFlightChain/);
    const nextPath = source.slice(source.indexOf("argId === \"next\""), source.indexOf("const git = await detectGitContext"));
    const guardCount = (nextPath.match(/decisionBlockedByInFlightChain/g) ?? []).length;
    assert.equal(guardCount, 2, "/kstack next must guard both the optional-park and awaiting_approval paths");
  });

  test("every mutating sprint-panel branch is guarded (F4)", () => {
    // Static wiring check: the 8 mutating/launching choices of handleSprintPanel
    // (freeze unfreeze; D4 continue + return; gate accept + re-run; kill-switch
    // accept + re-run; pause resume/re-issue) must consult panelGuard before
    // touching state. A refused decision still returns true — the user stays
    // parked, never falling through to the generic resume path.
    const source = readFileSync(new URL("../orchestrator/command.ts", import.meta.url), "utf-8");
    const guardCount = (source.match(/if \(panelGuard\(ctx, state\)\) return true;/g) ?? []).length;
    assert.equal(guardCount, 10, "all 10 mutating park-panel branches must be guarded");
  });

  test("sprint panel refuses a mutating decision while the chain runs, allows it after (F4)", async () => {
    const parked = parkForUnreadableVerdict(sprintState(8), "qa-verdict", "artifact-mismatch");

    const notified: string[] = [];
    const saved: unknown[] = [];
    const ui = {
      notify: (msg: string) => notified.push(msg),
      setStatus: () => {},
      input: async () => undefined,
      select: async () => "Continue as approved",
      confirm: async () => false,
    };
    const cmdCtx: any = { ui };
    const pi: any = { appendEntry: (type: string, state: unknown) => saved.push({ type, state }) };

    // Race window: a delegation chain for sprint phase 9 (index 8) is in flight.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    launchPhase(pi, cmdCtx, sprintState(8), async () => { await gate; });

    const refused = await handleSprintPanel(parked, cmdCtx, pi);
    assert.equal(refused, true, "panel still handles the park (never falls through)");
    assert.match(notified.join("\n"), /still running/, "decision refused with a warning");
    assert.equal(saved.length, 0, "no state mutation while the chain runs");

    release();
    await new Promise((r) => setTimeout(r, 10));

    // After the chain settles the same panel is reachable again — verified via
    // the non-mutating escape (Abort offered, declined).
    notified.length = 0;
    const settled = await handleSprintPanel(parked, { ui: { ...ui, select: async () => "Abort workflow" } } as any, pi);
    assert.equal(settled, true);
    assert.equal(notified.filter((m) => /still running/.test(m)).length, 0, "guard released after the chain settles");
    assert.equal(saved.length, 0, "abort declined → still no mutation");
  });

  test("buildResumeContext re-anchors the park-precedence rule (F2 rider)", async () => {
    const quiet = buildResumeContext(sprintState(0));
    assert.match(quiet, /Continue working on the current phase/);
    assert.match(quiet, /re-parked meanwhile/, "settled state still gets the park-precedence rider");

    // Race window: a chain for sprint phase 1 (index 0) is in flight.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const ctx: any = { ui: { notify: () => {} } };
    launchPhase({} as any, ctx, sprintState(0), async () => { await gate; });

    const inFlight = buildResumeContext(sprintState(0));
    assert.match(inFlight, /STILL RUNNING/, "in-flight chain flips the rider to the mid-turn warning");
    assert.match(inFlight, /do NOT call kstack_advance/);

    release();
    await new Promise((r) => setTimeout(r, 10));
    assert.match(buildResumeContext(sprintState(0)), /re-parked meanwhile/, "rider reverts after the chain settles");
  });

  test("human gate resolutions land in the ledger (S3 review: repudiation hole)", async () => {
    const { readLedger } = await import("../orchestrator/ledger.ts");
    const cwd = tmpDir("kstack-panel-ledger-");
    try {
      const mkPanel = (select: string, confirm = false) => ({
        cmdCtx: {
          cwd,
          ui: {
            notify: () => {},
            setStatus: () => {},
            input: async () => "fix it",
            select: async () => select,
            confirm: async () => confirm,
          },
        } as any,
        pi: { appendEntry: () => {} } as any,
      });

      // "Return phase with context" — a verdict-park resolution writes
      // kind:"gate" decision:"return" addressed at the PARKED phase.
      const parked = parkForUnreadableVerdict(sprintState(8), "devsecops-review", "artifact-mismatch");
      const p1 = mkPanel("Return phase with context");
      assert.equal(await handleSprintPanel(parked, p1.cmdCtx, p1.pi), true);
      let entries = readLedger(cwd, parked);
      let gate = entries.find((e) => e.kind === "gate" && e.payload.decision === "return");
      assert.ok(gate, "the human 'Return' click must be ledgered");
      assert.equal(gate!.payload.gateId, "devsecops-review", "gateId names the parked phase, not the loop target");

      // "Abort workflow" — the shared abortWorkflow funnel writes
      // decision:"abort" (covers all 8 abort call sites). The audit lands in
      // the SHARED legacy lane: a per-run ledger file dies with the run (see
      // test/run-cleanup.test.ts), the shared lane is the one that survives.
      const parked2 = { ...parkForUnreadableVerdict(sprintState(8), "qa-verdict", "artifact-mismatch"), runId: undefined };
      const p2 = mkPanel("Abort workflow", true);
      assert.equal(await handleSprintPanel(parked2, p2.cmdCtx, p2.pi), true);
      entries = readLedger(cwd, parked2);
      gate = entries.find((e) => e.kind === "gate" && e.payload.decision === "abort");
      assert.ok(gate, "the human 'Abort' click must be ledgered");
      assert.equal(gate!.payload.gateId, "qa-verdict");

      // Loop-exhaustion park: pausedReason encodes the LOOP TARGET
      // ("implement after 4 runs"), but the release must attribute the GATE
      // phase the workflow is parked at (devsecops-review) — pass-5 review.
      const exhausted = sprintState(9, { status: "paused" as const, pausedReason: "loop-exhausted:implement after 4 runs" });
      const p3 = mkPanel("Accept result — continue past the gate");
      // "Accept" launches a real delegation whose spawned child would hold the
      // tmp dir — flip ctx.ui stale right after the select resolves so the
      // chain's ctxAlive() probe kills it before the spawn.
      const liveUi = p3.cmdCtx.ui;
      let uiLive = true;
      Object.defineProperty(p3.cmdCtx, "ui", {
        get: () => { if (!uiLive) throw new Error("stale ctx"); return liveUi; },
      });
      liveUi.select = async () => { uiLive = false; return "Accept result — continue past the gate"; };
      assert.equal(await handleSprintPanel(exhausted, p3.cmdCtx, p3.pi), true);
      entries = readLedger(cwd, exhausted);
      gate = entries.find((e) => e.kind === "gate" && e.payload.decision === "run");
      assert.ok(gate, "the human 'Accept' click must be ledgered");
      assert.equal(gate!.payload.gateId, "devsecops-review", "gateId names the parked gate phase, not the loop target");
    } finally {
      // The "return"/"accept" resolutions launch fire-and-forget chains that
      // may still be settling (a spawned child holds the tmp dir on Windows) —
      // retry the removal long enough to outlive the chain's fast failure.
      await new Promise((r) => setTimeout(r, 500));
      rmSync(cwd, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
    }
  });
});

// close the outer "buildResumeContext / activeConstraintLines (Q4)" describe
// (the input-router describe above is nested inside it, matching the original layout)
});
