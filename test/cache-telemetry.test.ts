/**
 * TASK_06 / TASK_07 / TASK_08 — cache telemetry (ADR-30, ADR-47, ADR-56, ADR-62).
 *
 * The prompt-cache reuse of every phase must be MEASURABLE, per scope:
 *   - the MAIN scope (the masked session) counts the fresh prompt part
 *     (`tokensIn`) — pi's `usage.input` EXCLUDES the cached prefix, so the
 *     two scopes are comparable;
 *   - the DELEGATED scope (the children) counts the child's own
 *     `usage.input`.
 *
 * The two scopes are NEVER averaged: the mask changes the main session's
 * prompt prefix only, so mixing the rows would hide exactly the effect the
 * mask is supposed to show.
 *
 * The cache-retention flag is the operator's opt-in: `KSTACK_PI_CACHE_LONG`
 * adds `PI_CACHE_RETENTION=long` to the child env; with the flag off the key
 * is DELETED, because the child inherits the whole parent env.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  newStepRun,
  feedStepEvent,
  beginStepWatch,
  endStepWatch,
  feedWatchEvent,
  stepWatchStats,
} from "../orchestrator/stuck.ts";
import { appendLedger, mainStepPayload } from "../orchestrator/ledger.ts";
import { beginRun, recordDelegatedStep, writeRunReport, resetTelemetry } from "../orchestrator/telemetry.ts";
import { cacheLong } from "../orchestrator/config.ts";
import { childEnv } from "../orchestrator/spawn.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kstack-cache-"));
let seq = 0;

/** A fresh session cwd — every case gets its own tree. */
function session(): string {
  return fs.mkdtempSync(path.join(tmpRoot, `c${seq++}-`));
}

/** The run report the last `writeRunReport` wrote. */
function readReport(cwd: string): any {
  const dir = path.join(cwd, ".kstack", "runs");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1, `expected exactly one run report, found ${files.join(", ")}`);
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf-8"));
}

// --- TASK_06: the input-only counter -----------------------------------------

describe("TASK_06 — the input-only counter", () => {
  test("a fresh run has no input tokens", () => {
    assert.equal(newStepRun().tokensIn, 0);
  });

  test("the fresh input is counted apart from the spend", () => {
    const run = newStepRun();
    feedStepEvent(run, {
      type: "message_end",
      message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 500, cacheWrite: 50 } },
    } as any);
    assert.equal(run.tokensIn, 100, "the fresh prompt part is the input count");
    assert.equal(run.tokens, 120, "the spend stays input + output");
    assert.equal(run.cacheRead, 500);
    assert.equal(run.cacheWrite, 50);
  });

  test("the input counter accumulates over the turns", () => {
    const run = newStepRun();
    for (const input of [10, 20, 30]) {
      feedStepEvent(run, { type: "message_end", message: { role: "assistant", usage: { input, output: 1 } } } as any);
    }
    assert.equal(run.tokensIn, 60);
  });

  test("a usage event without an input counts zero", () => {
    const run = newStepRun();
    feedStepEvent(run, { type: "message_end", message: { role: "assistant", usage: { output: 20 } } } as any);
    assert.equal(run.tokensIn, 0);
  });

  test("a non-finite input counts zero", () => {
    const run = newStepRun();
    feedStepEvent(run, { type: "message_end", message: { role: "assistant", usage: { input: Number.NaN, output: 1 } } } as any);
    assert.equal(run.tokensIn, 0);
  });

  test("the watch exposes the input counter in the §5 shape", () => {
    beginStepWatch("plan", "interrogate");
    try {
      feedWatchEvent({ type: "message_end", message: { role: "assistant", usage: { input: 5000, output: 2000 } } } as any);
      const stats = stepWatchStats();
      assert.ok(stats, "the watch must expose its stats");
      assert.deepEqual(
        Object.keys(stats).sort(),
        ["cacheCreation", "cacheRead", "tokens", "tokensIn", "turns"],
        "the watch's shape must match the contract exactly",
      );
      assert.equal(stats.tokensIn, 5000);
      assert.equal(stats.tokens, 7000);
    } finally {
      endStepWatch();
    }
  });

  test("the main-step ledger payload carries the input counter", () => {
    const payload = mainStepPayload("the summary", {
      turns: 3,
      tokens: 7000,
      tokensIn: 5000,
      cacheRead: 100,
      cacheCreation: 20,
    });
    assert.equal(payload.summary, "the summary");
    assert.equal(payload.tokens, 7000);
    assert.equal(payload.tokensIn, 5000, "the main-step row must carry the fresh-prompt count");
    assert.equal(payload.cacheRead, 100);
    assert.equal(payload.cacheCreation, 20);
  });

  test("a payload without a watch carries no counters", () => {
    const payload = mainStepPayload("the summary", null);
    assert.deepEqual(payload, { summary: "the summary" });
  });
});

// --- TASK_07: the run report rows ---------------------------------------------

describe("TASK_07 — the run report rows", () => {
  beforeEach(() => {
    resetTelemetry();
  });

  test("known counters give the exact expected hit-rate for both scopes", () => {
    const cwd = session();
    const runId = "run-07";
    // Two main-step rows in phase "plan" and one in phase "implement".
    appendLedger(cwd, { workflowId: "sprint", runId }, {
      kind: "step",
      phaseId: "plan",
      stepId: "s1",
      payload: { summary: "a", tokens: 300, tokensIn: 200, cacheRead: 800, cacheCreation: 100 },
    });
    appendLedger(cwd, { workflowId: "sprint", runId }, {
      kind: "step",
      phaseId: "implement",
      stepId: "backend",
      payload: { summary: "b", tokens: 60, tokensIn: 40, cacheRead: 160, cacheCreation: 20 },
    });
    beginRun("sprint");
    recordDelegatedStep({
      phaseId: "implement",
      stepId: "backend",
      stepIndex: 0,
      agent: "backend-developer",
      durationMs: 1000,
      tokensIn: 1000,
      tokensCacheRead: 3000,
      tokensCacheCreation: 500,
      tokensOut: 200,
    });
    writeRunReport(cwd, "sprint", runId);
    const report = readReport(cwd);

    const main = report.phases.find((p: any) => p.scope === "main" && p.phaseId === "plan");
    assert.ok(main, "the main scope must have a row for the plan phase");
    assert.equal(main.tokensIn, 200);
    assert.equal(main.tokensCacheRead, 800);
    assert.equal(main.tokensCacheCreation, 100);
    assert.equal(main.cacheHitRate, 800 / (200 + 800 + 100));

    const delegated = report.phases.find((p: any) => p.scope === "delegated" && p.phaseId === "implement");
    assert.ok(delegated, "the delegated scope must have a row for the implement phase");
    assert.equal(delegated.tokensIn, 1000);
    assert.equal(delegated.tokensCacheRead, 3000);
    assert.equal(delegated.tokensCacheCreation, 500);
    assert.equal(delegated.cacheHitRate, 3000 / (1000 + 3000 + 500));
  });

  test("the main scope is never mixed with the delegated one", () => {
    const cwd = session();
    const runId = "run-07b";
    appendLedger(cwd, { workflowId: "sprint", runId }, {
      kind: "step",
      phaseId: "implement",
      stepId: "backend",
      payload: { summary: "a", tokens: 30, tokensIn: 20, cacheRead: 80, cacheCreation: 10 },
    });
    beginRun("sprint");
    recordDelegatedStep({
      phaseId: "implement",
      stepId: "backend",
      stepIndex: 0,
      agent: "backend-developer",
      durationMs: 1000,
      tokensIn: 1000,
      tokensCacheRead: 3000,
      tokensCacheCreation: 500,
    });
    writeRunReport(cwd, "sprint", runId);
    const report = readReport(cwd);
    const rows = report.phases.filter((p: any) => p.phaseId === "implement");
    assert.equal(rows.length, 2, "one row per (phase, scope)");
    const main = rows.find((p: any) => p.scope === "main");
    const delegated = rows.find((p: any) => p.scope === "delegated");
    assert.equal(main.tokensIn, 20, "the main row carries only the main numbers");
    assert.equal(main.tokensCacheRead, 80);
    assert.equal(main.cacheHitRate, 80 / (20 + 80 + 10));
    assert.equal(delegated.tokensIn, 1000);
    assert.equal(delegated.tokensCacheRead, 3000);
    assert.equal(delegated.cacheHitRate, 3000 / (1000 + 3000 + 500));
    assert.notEqual(main.cacheHitRate, delegated.cacheHitRate, "the two scopes must not be averaged");
  });

  test("a run without a run id yields no main rows and the report says so", () => {
    const cwd = session();
    beginRun("sprint");
    recordDelegatedStep({
      phaseId: "implement",
      stepId: "backend",
      stepIndex: 0,
      agent: "backend-developer",
      durationMs: 1000,
      tokensIn: 1000,
      tokensCacheRead: 3000,
      tokensCacheCreation: 500,
    });
    writeRunReport(cwd, "sprint");
    const report = readReport(cwd);
    assert.equal(report.phases.filter((p: any) => p.scope === "main").length, 0, "no main rows without a run id");
    assert.ok(report.mainScopeStatus, "the report must say why the main rows are missing");
    assert.equal(report.mainScopeStatus, "no-run-id");
    assert.equal(report.phases.filter((p: any) => p.scope === "delegated").length, 1);
  });

  test("a missing ledger yields no main rows and the report says so", () => {
    const cwd = session();
    beginRun("sprint");
    writeRunReport(cwd, "sprint", "run-that-never-wrote");
    const report = readReport(cwd);
    assert.equal(report.phases.filter((p: any) => p.scope === "main").length, 0);
    assert.equal(report.mainScopeStatus, "no-ledger");
  });

  test("the hit-rate is zero when the denominator is zero", () => {
    const cwd = session();
    const runId = "run-07c";
    beginRun("sprint");
    recordDelegatedStep({
      phaseId: "implement",
      stepId: "backend",
      stepIndex: 0,
      agent: "backend-developer",
      durationMs: 1000,
      tokensIn: 0,
      tokensCacheRead: 0,
      tokensCacheCreation: 0,
    });
    writeRunReport(cwd, "sprint", runId);
    const report = readReport(cwd);
    const delegated = report.phases.find((p: any) => p.scope === "delegated");
    assert.equal(delegated.cacheHitRate, 0);
  });

  test("the 1h cache-write split is omitted when the provider did not report it", () => {
    const cwd = session();
    beginRun("sprint");
    recordDelegatedStep({
      phaseId: "implement",
      stepId: "backend",
      stepIndex: 0,
      agent: "backend-developer",
      durationMs: 1000,
      tokensIn: 10,
      tokensCacheRead: 20,
      tokensCacheCreation: 30,
    });
    writeRunReport(cwd, "sprint", "run-07d");
    const report = readReport(cwd);
    assert.equal(report.steps[0].tokensCacheWrite1h, undefined, "an absent 1h split is never written as 0");
    assert.equal(report.steps[0].tokensCacheCreation, 30);
  });

  test("the 1h cache-write split is carried when the provider reported it", () => {
    const cwd = session();
    beginRun("sprint");
    recordDelegatedStep({
      phaseId: "implement",
      stepId: "backend",
      stepIndex: 0,
      agent: "backend-developer",
      durationMs: 1000,
      tokensIn: 10,
      tokensCacheRead: 20,
      tokensCacheCreation: 30,
      tokensCacheWrite1h: 7,
    });
    writeRunReport(cwd, "sprint", "run-07e");
    const report = readReport(cwd);
    assert.equal(report.steps[0].tokensCacheWrite1h, 7);
  });

  test("the report is written before the run's ledger dies", () => {
    // The ledger is deleted at the end of a run — the report must already
    // carry the main-scope numbers when that happens.
    const cwd = session();
    const runId = "run-07f";
    appendLedger(cwd, { workflowId: "sprint", runId }, {
      kind: "step",
      phaseId: "plan",
      stepId: "s1",
      payload: { summary: "a", tokens: 30, tokensIn: 20, cacheRead: 80, cacheCreation: 10 },
    });
    beginRun("sprint");
    writeRunReport(cwd, "sprint", runId);
    const report = readReport(cwd);
    const main = report.phases.find((p: any) => p.scope === "main");
    assert.ok(main, "the main row must be in the report");
    assert.equal(main.tokensCacheRead, 80);
  });
});

// --- TASK_08: child cache retention --------------------------------------------

describe("TASK_08 — child cache retention", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.LONG = process.env.KSTACK_PI_CACHE_LONG;
    saved.RETENTION = process.env.PI_CACHE_RETENTION;
  });

  test("the flag is off by default", () => {
    delete process.env.KSTACK_PI_CACHE_LONG;
    assert.equal(cacheLong(), false);
  });

  test("the flag reads the operator's env", () => {
    process.env.KSTACK_PI_CACHE_LONG = "1";
    assert.equal(cacheLong(), true);
    process.env.KSTACK_PI_CACHE_LONG = "off";
    assert.equal(cacheLong(), false);
  });

  test("with the flag on the child env carries PI_CACHE_RETENTION=long", () => {
    process.env.KSTACK_PI_CACHE_LONG = "1";
    const env = childEnv({});
    assert.equal(env.PI_CACHE_RETENTION, "long");
  });

  test("with the flag off the child env does not carry the key", () => {
    delete process.env.KSTACK_PI_CACHE_LONG;
    process.env.PI_CACHE_RETENTION = "long";
    try {
      const env = childEnv({});
      assert.equal(
        Object.prototype.hasOwnProperty.call(env, "PI_CACHE_RETENTION"),
        false,
        "an operator-exported retention must not leak into the child",
      );
    } finally {
      if (saved.RETENTION === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = saved.RETENTION;
    }
  });

  test("the child env keeps every other inherited variable", () => {
    process.env.KSTACK_PI_CACHE_LONG = "1";
    process.env.KSTACK_TEST_INHERITED = "kept";
    try {
      const env = childEnv({ KSTACK_STEP: "backend" });
      assert.equal(env.KSTACK_TEST_INHERITED, "kept");
      assert.equal(env.KSTACK_STEP, "backend");
    } finally {
      delete process.env.KSTACK_TEST_INHERITED;
    }
  });

  test("the flag's own env is never inherited as the retention key", () => {
    process.env.KSTACK_PI_CACHE_LONG = "1";
    const env = childEnv({});
    assert.equal(env.KSTACK_PI_CACHE_LONG, "1");
    assert.equal(env.PI_CACHE_RETENTION, "long");
  });
});
