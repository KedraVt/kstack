/**
 * TASK_09 / TASK_10 — the step budgets (ADR-31, ADR-62, INV-11, INV-12).
 *
 * S5a hotfix / ADR-64 SUPERSEDES the quota: the caps are OFF by default and
 * the pulse (pulse.ts) guards the child instead — "is it still working?",
 * not "how much has it done?". The caps stay available as an explicit
 * operator choice: set the env and they bite again.
 *
 * A budget TRIP is still a human decision, not a kill: the step parks, NO
 * attempt is burned, and the park names the env var that raises the dim — a
 * name that is PERSISTED, so it survives a restart (INV-12).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BUDGET_ENV,
  stepBudgetDefaults,
  beginStepWatch,
  endStepWatch,
  feedWatchEvent,
} from "../orchestrator/stuck.ts";
import { executeCurrentPhase } from "../orchestrator/executor.ts";
import { beginRun } from "../orchestrator/telemetry.ts";
import type { SpawnRequest, SpawnResult } from "../orchestrator/spawn.ts";

const TMP_CWD = mkdtempSync(path.join(os.tmpdir(), "kstack-budget-"));
after(() => {
  rmSync(TMP_CWD, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Run a body with an env var set, restoring the previous value afterwards. */
function withEnv(name: string, value: string | undefined, body: () => void): void {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    body();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

// --- TASK_09: the per-class turn budgets --------------------------------------

describe("TASK_09 — the per-class turn budgets", () => {
  test("ADR-64: there is NO quota by default — every dim is unlimited", () => {
    withEnv("KSTACK_PI_STEP_MAX_TURNS", undefined, () => {
      withEnv("KSTACK_PI_STEP_MAX_TOKENS", undefined, () => {
        withEnv("KSTACK_PI_STEP_MAX_CONTEXT", undefined, () => {
          withEnv("KSTACK_PI_STEP_MAX_MS", undefined, () => {
            const limits = stepBudgetDefaults("implement");
            assert.equal(limits.turns, Number.POSITIVE_INFINITY);
            assert.equal(limits.tokens, Number.POSITIVE_INFINITY);
            assert.equal(limits.context, Number.POSITIVE_INFINITY);
            assert.equal(limits.ms, Number.POSITIVE_INFINITY);
          });
        });
      });
    });
  });

  test("the phase id no longer selects a limit", () => {
    withEnv("KSTACK_PI_STEP_MAX_TURNS", undefined, () => {
      assert.equal(stepBudgetDefaults("explore").turns, stepBudgetDefaults("implement").turns);
      assert.equal(stepBudgetDefaults("not-a-registered-phase").turns, Number.POSITIVE_INFINITY);
    });
  });

  test("an explicit env still enables the cap (the operator's choice)", () => {
    withEnv("KSTACK_PI_STEP_MAX_TURNS", "42", () => {
      assert.equal(stepBudgetDefaults("explore").turns, 42);
      assert.equal(stepBudgetDefaults("implement").turns, 42);
    });
  });

  test("the env override `off` means unlimited", () => {
    withEnv("KSTACK_PI_STEP_MAX_TURNS", "off", () => {
      assert.equal(stepBudgetDefaults("implement").turns, Number.POSITIVE_INFINITY);
    });
  });

  test("an invalid env value falls back to unlimited", () => {
    withEnv("KSTACK_PI_STEP_MAX_TURNS", "not-a-number", () => {
      assert.equal(stepBudgetDefaults("implement").turns, Number.POSITIVE_INFINITY);
    });
  });

  test("the other budget dims are unlimited too", () => {
    withEnv("KSTACK_PI_STEP_MAX_TOKENS", undefined, () => {
      withEnv("KSTACK_PI_STEP_MAX_CONTEXT", undefined, () => {
        withEnv("KSTACK_PI_STEP_MAX_MS", undefined, () => {
          assert.equal(stepBudgetDefaults("explore").tokens, Number.POSITIVE_INFINITY);
          assert.equal(stepBudgetDefaults("implement").tokens, Number.POSITIVE_INFINITY);
          assert.equal(stepBudgetDefaults("plan").tokens, Number.POSITIVE_INFINITY);
          assert.equal(stepBudgetDefaults("implement").context, Number.POSITIVE_INFINITY);
          assert.equal(stepBudgetDefaults("implement").ms, Number.POSITIVE_INFINITY);
        });
      });
    });
  });

  test("the env names of every budget dim are exported", () => {
    assert.deepEqual(BUDGET_ENV, {
      turns: "KSTACK_PI_STEP_MAX_TURNS",
      tokens: "KSTACK_PI_STEP_MAX_TOKENS",
      context: "KSTACK_PI_STEP_MAX_CONTEXT",
      usd: "KSTACK_PI_STEP_MAX_USD",
      ms: "KSTACK_PI_STEP_MAX_MS",
      usdPerMin: "KSTACK_PI_STEP_MAX_USD_PER_MIN",
    });
  });

  test("a main-session watch is budget-free — 250 turns never trip it (INV-19)", () => {
    beginStepWatch("plan", "interrogate");
    try {
      let trip: string | undefined;
      for (let i = 0; i < 250; i++) {
        // A tool call per turn keeps the stuck RULES quiet (no monologue).
        feedWatchEvent({ type: "tool_execution_start", toolName: "t", args: { i } } as any);
        feedWatchEvent({ type: "tool_execution_end", toolName: "t", result: { content: `obs ${i}` } } as any);
        const verdict = feedWatchEvent({
          type: "message_end",
          message: { role: "assistant", usage: { input: 1000, output: 500 } },
        } as any);
        if (verdict?.trip) {
          trip = verdict.trip;
          break;
        }
      }
      assert.equal(trip, undefined, "a main-session watch must never trip a budget");
    } finally {
      endStepWatch();
    }
  });
});

// --- TASK_10: the budget trip report -------------------------------------------

/** A host whose session entries carry the workflow state (the persisted state). */
function budgetHost(cwd: string, state: unknown) {
  const entries: any[] = [{ type: "custom", customType: "kstack-wf-state", data: state }];
  const notifications: Array<{ msg: string; level: string }> = [];
  const statuses: Array<string | undefined> = [];
  const ctx: any = {
    cwd,
    ui: {
      notify: (msg: string, level: string) => notifications.push({ msg, level }),
      setStatus: (_k: string, value?: string) => statuses.push(value),
    },
    sessionManager: { getEntries: () => entries },
  };
  const pi: any = {
    appendEntry: (type: string, data: any) => entries.push({ type: "custom", customType: type, data }),
    sendUserMessage: () => {},
    exec: async () => ({ stdout: "", stderr: "" }),
  };
  return { ctx, pi, entries, notifications, statuses };
}

describe("TASK_10 — the budget trip report", () => {
  test("a tripped budget parks, names the env var and burns no attempt", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "kstack-budget-park-"));
    try {
      const state = {
        workflowId: "sprint",
        phaseIndex: 9, // devsecops-review — a stepped phase with delegated steps
        stepIndex: 0,
        status: "active" as const,
        goal: "ship the cart",
        results: {},
        runId: "budget-run-1",
        sprintNumber: 7,
        version: 5 as const,
      };
      const host = budgetHost(cwd, state);
      const execGit = async (_cmd: string, args: string[]) => ({
        code: 0,
        stdout: args.includes("--show-current") ? "task/cart\n" : "",
        stderr: "",
      });
      // A tiny token budget: the step's own usage trips it.
      process.env.KSTACK_PI_STEP_MAX_TOKENS = "1000";
      try {
        beginRun("sprint");
        await executeCurrentPhase(host.pi, host.ctx, state as any, {
          execGit,
          spawnFn: async (req: SpawnRequest): Promise<SpawnResult> => {
            // The child's own event stream: 10k tokens of spend.
            req.onEvent?.({
              type: "message_end",
              message: { role: "assistant", usage: { input: 5000, output: 5000 } },
            } as any);
            return {
              ok: true,
              output: "the step did a lot of work",
              rawOutput: "the step did a lot of work",
              exitCode: 0,
              durationMs: 5,
              toolCalls: 1,
              turns: 1,
            };
          },
        });
      } finally {
        delete process.env.KSTACK_PI_STEP_MAX_TOKENS;
      }

      // The run is PARKED on the budget trip.
      const parked = host.entries.filter((e) => e.data?.status === "paused").at(-1);
      assert.ok(parked, "the run must park on the budget trip");
      assert.match(parked.data.pausedReason ?? "", /^budget-exceeded:tokens:/);
      // The env var that raises the dim is PERSISTED (it survives a restart).
      assert.equal(parked.data.budgetRaiseEnv, "KSTACK_PI_STEP_MAX_TOKENS");
      // No attempt is burned by a trip.
      assert.equal(parked.data.attempts, undefined, "a budget trip burns no attempt");

      // The park message names the env var.
      assert.ok(
        host.notifications.some((n) => n.msg.includes("KSTACK_PI_STEP_MAX_TOKENS")),
        "the park message must name the env var that raises the budget",
      );

      // The ledger records the trip as run-interrupted (never quota-parked) and
      // carries the env var.
      const ledger = readFileSync(path.join(cwd, ".kstack", "ledger", "sprint-budget-run-1.jsonl"), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const trip = ledger.find((e) => String(e.pausedReason ?? e.payload?.summary ?? "").includes("budget-exceeded"));
      const interrupted = ledger.find((e) => e.kind === "run-interrupted");
      assert.ok(interrupted, "the trip must be ledgered as run-interrupted");
      assert.equal(interrupted.payload.raiseWith, "KSTACK_PI_STEP_MAX_TOKENS");
      assert.ok(
        !ledger.some((e) => e.kind === "quota-parked"),
        "a budget trip is not a quota park",
      );
      assert.ok(trip !== undefined || interrupted.payload.summary.includes("budget-exceeded"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
