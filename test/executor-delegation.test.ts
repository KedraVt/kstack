/**
 * Fake-spawn integration harness for runDeterministicDelegation.
 *
 * The pure-function suite covers retryDecision / shouldReopenFullChain /
 * extractHandoff in isolation — but the WIRING bugs (B1/B2/B3) lived between
 * those functions: which text reaches `{previous}`, whether the retry's
 * raised timeout reaches the request, whether the budget / token breaker /
 * REFUTED reopen actually fire inside the loop. These tests run the real
 * delegation engine end-to-end with an injected `spawnFn` (the trailing
 * parameter on runDeterministicDelegation) instead of child processes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDeterministicDelegation } from "../orchestrator/executor.ts";
import { getWorkflow } from "../orchestrator/workflows.ts";
import { beginRun, resetTelemetry } from "../orchestrator/telemetry.ts";
import { resolveTimeoutMs } from "../orchestrator/spawn.ts";
import type { SpawnRequest, SpawnResult } from "../orchestrator/spawn.ts";
import type { WorkflowContext, WorkflowPhase } from "../orchestrator/types.ts";

const INVESTIGATE = getWorkflow("investigate")!;
const DEVELOP = getWorkflow("develop")!;

function findPhase(wf: { phases: WorkflowPhase[] }, phaseId: string): WorkflowPhase {
  const phase = wf.phases.find((p) => p.id === phaseId);
  assert.ok(phase, `phase ${phaseId} not found`);
  return phase;
}

function makeCtx(workflowId: string, phaseIndex = 0, cwd = process.cwd()): WorkflowContext {
  return {
    state: { workflowId, phaseIndex, status: "active", goal: "fix the flaky logout bug", results: {} },
    git: {
      branch: "feature/test",
      hasUncommittedChanges: true,
      hasStagedChanges: false,
      aheadOfRemote: 0,
      behindRemote: 0,
      isMainBranch: false,
      recentCommitSubject: "test",
    },
    cwd,
  };
}

/** Minimal ExtensionContext/ExtensionAPI fakes: notify/setStatus recorded, delegation events captured. */
function fakeHost(cwd: string) {
  const notifications: Array<{ msg: string; level: string }> = [];
  const events: Array<Record<string, any>> = [];
  const statuses: Array<string | undefined> = [];
  const ctx: any = {
    cwd,
    ui: {
      notify: (msg: string, level: string) => notifications.push({ msg, level }),
      setStatus: (_key: string, value?: string) => statuses.push(value),
    },
  };
  const pi: any = {
    appendEntry: (_type: string, data: Record<string, any>) => events.push(data),
  };
  return { ctx, pi, notifications, events, statuses };
}

function ok(output: string, extra: Partial<SpawnResult> = {}): SpawnResult {
  return { ok: true, output, rawOutput: output, exitCode: 0, durationMs: 5, toolCalls: 2, turns: 1, ...extra };
}

/** Run the real delegation loop with an injected spawn; returns results + captured side channels. */
async function delegate(
  phase: WorkflowPhase,
  wfCtx: WorkflowContext,
  spawnFn: (req: SpawnRequest) => Promise<SpawnResult>,
  opts: { alive?: () => boolean } = {},
) {
  const host = fakeHost(wfCtx.cwd);
  // Fresh accumulator per run: beginRun also zeroes the token-breaker counter
  // (resetTelemetry alone does not), keeping these tests order-independent.
  beginRun(wfCtx.state.workflowId);
  const results = await runDeterministicDelegation(
    phase,
    wfCtx,
    host.ctx,
    opts.alive ?? (() => true),
    host.pi,
    spawnFn,
  );
  return { results, ...host };
}

describe("runDeterministicDelegation — fake-spawn integration", () => {
  test("chain ordering: the next step's {previous} receives the extracted HANDOFF, not the raw report", async () => {
    const phase = findPhase(INVESTIGATE, "root-cause"); // chain: scout → planner
    const wfCtx = makeCtx("investigate", 1);
    const filler = `FILLER-LINE ${"x".repeat(8000)}`;
    const scoutOutput =
      `## REPORT\n${filler}\n\n## HANDOFF\nVERIFIED FACTS:\n` +
      `- culprit pinned @ src/auth.ts:9\nDECISIONS: none\nOPEN QUESTIONS: none\nDO NOT REDO: reproduction`;
    const calls: SpawnRequest[] = [];
    const { results, events } = await delegate(phase, wfCtx, async (req) => {
      calls.push(req);
      return calls.length === 1 ? ok(scoutOutput) : ok("planner: root cause + minimal fix strategy");
    });

    assert.deepEqual(calls.map((c) => c.agent), ["scout", "planner"]);
    assert.equal(calls[0].phaseId, "root-cause");
    assert.equal(calls[0].cwd, wfCtx.cwd);
    assert.equal(typeof calls[0].shouldAbort, "function");
    assert.equal(typeof calls[0].onLiveness, "function");

    // The planner template carries "{previous}" — it must have been replaced
    // by the HANDOFF section only (B-wiring: never the whole 8KB report).
    assert.ok(!calls[1].task.includes("{previous}"), "unreplaced {previous} token in downstream task");
    assert.ok(calls[1].task.includes("## HANDOFF"));
    assert.ok(calls[1].task.includes("culprit pinned @ src/auth.ts:9"));
    assert.ok(!calls[1].task.includes("FILLER-LINE"), "raw upstream report leaked into {previous}");

    assert.equal(results.length, 2);
    assert.equal(events.filter((e) => e.event === "started").length, 2);
    assert.equal(events.filter((e) => e.event === "completed").length, 2);
  });

  test("a transient failure is retried once; the retry request carries the raised timeout", { timeout: 30_000 }, async () => {
    const phase = findPhase(DEVELOP, "explore"); // single scout step
    const calls: SpawnRequest[] = [];
    const { results, events } = await delegate(phase, makeCtx("develop", 1), async (req) => {
      calls.push(req);
      if (calls.length === 1) {
        // exit != 0 with no output = transient → one retry after FAST_RETRY_DELAY_MS.
        // (delay() is a real setTimeout: this test pays the 5s cooldown once.)
        return { ok: false, output: "", error: "provider blip", exitCode: 3, durationMs: 4 };
      }
      return ok("exploration done");
    });

    assert.equal(calls.length, 2, "exactly one retry for a transient failure");
    assert.equal(calls[0].timeoutMs, undefined, "first attempt carries no explicit timeoutMs");
    assert.equal(
      calls[1].timeoutMs,
      Math.round(resolveTimeoutMs(calls[0]) * 1.5),
      "retry must use the request's resolved limit ×1.5 (B2)",
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].agent, "scout");
    assert.equal(results[0].result.ok, true);
    assert.ok(events.some((e) => e.event === "retrying"), "retrying event missing");
    assert.ok(events.some((e) => e.event === "completed"), "completed event missing");
  });

  test("a hard (config) failure is never retried", async () => {
    const phase = findPhase(DEVELOP, "explore");
    const calls: SpawnRequest[] = [];
    const { results, events } = await delegate(phase, makeCtx("develop", 1), async (req) => {
      calls.push(req);
      return { ok: false, output: "", error: 'Unknown agent "nope".', exitCode: 1, durationMs: 0, configError: true };
    });

    assert.equal(calls.length, 1, "configError must not burn the retry");
    assert.equal(results.length, 1);
    assert.equal(results[0].result.ok, false);
    assert.ok(!events.some((e) => e.event === "retrying"), "hard failure must not emit a retrying event");
    assert.ok(events.some((e) => e.event === "failed"), "failed event missing");
  });

  test("the wall-clock budget stops the chain before later steps and reports budget-exceeded", async () => {
    const NAME = "GSTACK_PI_DELEGATION_BUDGET_SEC";
    const original = process.env[NAME];
    process.env[NAME] = "0.05"; // 50ms: the first step runs, the second never starts
    try {
      const phase = findPhase(INVESTIGATE, "root-cause");
      const calls: SpawnRequest[] = [];
      const { results, events, notifications } = await delegate(phase, makeCtx("investigate", 1), async (req) => {
        calls.push(req);
        await new Promise((r) => setTimeout(r, 80)); // every step burns past the budget
        return ok("scout report");
      });

      assert.equal(calls.length, 1, "the second step must not spawn once the budget is gone");
      assert.equal(results.length, 1);
      const evt = events.find((e) => e.event === "budget-exceeded");
      assert.ok(evt, "budget-exceeded delegation event missing");
      assert.equal(evt.agent, "planner", "the event names the step that was NOT run");
      assert.ok(
        notifications.some((n) => n.level === "warning" && n.msg.includes("wall-clock budget")),
        "user-facing budget warning missing",
      );
    } finally {
      if (original === undefined) delete process.env[NAME];
      else process.env[NAME] = original;
    }
  });

  test("token usage past GSTACK_PI_MAX_RUN_TOKENS stops the chain after that step", async () => {
    const NAME = "GSTACK_PI_MAX_RUN_TOKENS";
    const original = process.env[NAME];
    process.env[NAME] = "100";
    try {
      const phase = findPhase(INVESTIGATE, "root-cause");
      const calls: SpawnRequest[] = [];
      const { results, notifications } = await delegate(phase, makeCtx("investigate", 1), async (req) => {
        calls.push(req);
        // input + output = 110 > 100 → circuit-breaker trips after step 1.
        return ok("scout report", { usage: { input: 60, output: 50, cacheRead: 0, cacheWrite: 0 } });
      });

      assert.equal(calls.length, 1, "the breaker must stop the chain after the over-budget step");
      assert.equal(results.length, 1);
      assert.ok(
        notifications.some((n) => n.level === "warning" && n.msg.includes("MAX_RUN_TOKENS exceeded")),
        "token-breaker warning missing",
      );
    } finally {
      if (original === undefined) delete process.env[NAME];
      else process.env[NAME] = original;
      resetTelemetry();
    }
  });

  test("a REFUTED collapsed validate re-runs the FULL scout→planner chain with the do-not-revisit note", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "gstack-deleg-"));
    try {
      // A CONFIRMED ROOT CAUSE marker inside the reproduce HANDOFF + cited
      // files on disk collapses the plan to one validate-only planner step.
      mkdirSync(path.join(tmp, "src"), { recursive: true });
      writeFileSync(path.join(tmp, "src", "app.ts"), "x");
      writeFileSync(path.join(tmp, "src", "cache.ts"), "x");
      const wfCtx = makeCtx("investigate", 1, tmp);
      wfCtx.state.results["reproduce"] = {
        status: "completed",
        summary:
          "Reproduced reliably.\n## HANDOFF\nVERIFIED FACTS:\n- crash reproduced @ src/app.ts:42\n" +
          "CONFIRMED ROOT CAUSE: retry loop resets cache state | files: src/app.ts, src/cache.ts",
      };

      const calls: SpawnRequest[] = [];
      const { results, notifications } = await delegate(
        findPhase(INVESTIGATE, "root-cause"),
        wfCtx,
        async (req) => {
          calls.push(req);
          if (calls.length === 1) return ok("REFUTED: cache files already handle the reset correctly");
          if (calls.length === 2) {
            return ok(
              `## REPORT\n${"y".repeat(7000)}\n\n## HANDOFF\nVERIFIED FACTS:\n` +
              "- real cause: missing await @ src/app.ts:88\nDECISIONS: none\nOPEN QUESTIONS: none\nDO NOT REDO: cache audit",
            );
          }
          return ok("planner: fresh root cause + strategy");
        },
      );

      assert.deepEqual(calls.map((c) => c.agent), ["planner", "scout", "planner"]);
      assert.ok(
        calls[0].task.includes('CONFIRMED this cause: "retry loop resets cache state"'),
        "first step must be the collapsed validate-only task",
      );
      assert.ok(
        calls[1].task.includes(
          "NOTE: the hypothesis 'retry loop resets cache state' was REFUTED because: " +
            "cache files already handle the reset correctly. Do not revisit it.",
        ),
        "the rebuilt scout step must carry the do-not-revisit note",
      );
      assert.ok(!calls[1].task.includes("CONFIRMED this cause"), "validate task leaked into the reopened chain");
      // The reopened chain still threads handoffs through {previous}.
      assert.ok(calls[2].task.includes("missing await @ src/app.ts:88"), "scout handoff missing from reopened planner task");
      assert.equal(results.length, 3);
      assert.ok(results[0].result.output.startsWith("REFUTED:"));
      assert.ok(
        notifications.some((n) => n.level === "warning" && n.msg.includes("rebuilding the full investigation chain")),
        "reopen warning missing",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a REFUTED line in a NON-collapsed chain does NOT reopen (wasCollapsed guard)", async () => {
    const phase = findPhase(INVESTIGATE, "root-cause");
    const calls: SpawnRequest[] = [];
    const { results } = await delegate(phase, makeCtx("investigate", 1), async (req) => {
      calls.push(req);
      // Full chain (no reproduce marker): the planner's REFUTED text must not
      // trigger the reopen path — that guard only applies to the collapsed
      // validate-only plan.
      return calls.length === 1 ? ok("scout findings") : ok("REFUTED: nothing confirmed upstream");
    });

    assert.equal(calls.length, 2, "no reopen without a collapsed validate step");
    assert.equal(results.length, 2);
  });

  test("alive() gate: a dead context spawns nothing", async () => {
    const phase = findPhase(INVESTIGATE, "root-cause");
    const calls: SpawnRequest[] = [];
    const { results } = await delegate(
      phase,
      makeCtx("investigate", 1),
      async (req) => {
        calls.push(req);
        return ok("unreachable");
      },
      { alive: () => false },
    );

    assert.equal(calls.length, 0, "a stale context must not spawn any work");
    assert.equal(results.length, 0);
  });

  test("alive() gate: a context dying mid-chain stops spawning after the current step", async () => {
    const phase = findPhase(INVESTIGATE, "root-cause");
    let isAlive = true;
    const calls: SpawnRequest[] = [];
    const { results, events } = await delegate(
      phase,
      makeCtx("investigate", 1),
      async (req) => {
        calls.push(req);
        isAlive = false; // session reload lands while the first step runs
        return ok("scout report");
      },
      { alive: () => isAlive },
    );

    assert.equal(calls.length, 1, "the planner step must not spawn on a dead context");
    assert.equal(results.length, 1, "the completed step's result is still recorded");
    assert.equal(events.filter((e) => e.event === "started").length, 1);
  });
});
