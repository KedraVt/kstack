/**
 * S5a hotfix / ADR-64 — the PULSE: the orchestrator's periodic sanity check
 * on a delegated subagent.
 *
 * The step budgets (ADR-31) were a QUOTA: they counted the work and cut the
 * step off when the count crossed a line. The cycle that produced (trip →
 * park → re-dispatch the same step from zero → trip again) never converged,
 * and the human repeated the implementation phase ~20 times.
 *
 * The pulse replaces the quota with a LIVENESS question: is the child still
 * working the task, or has it stopped / veered off? Three signals, all read
 * from the child's OWN event stream — nothing inspects what it produced:
 *
 *   stalled       — no PROGRESS for the configured window
 *   lexical-drift — the child's words stopped sharing the brief's words
 *   scope-drift   — the child wrote outside the repository it was given
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import {
  newPulse,
  feedPulseEvent,
  evaluatePulse,
  pulseDue,
  pulsePausedReason,
  pulseRecoveryBrief,
  pulseDiagnosis,
  type PulseLimits,
} from "../orchestrator/pulse.ts";

const LIMITS: PulseLimits = {
  noProgressMs: 900_000,
  driftWindow: 4,
  driftTerms: 2,
  driftMinWords: 20,
  driftEveryEvents: 5,
};

const T0 = 1_700_000_000_000;

function assistant(text: string) {
  return { type: "message_end", message: { role: "assistant", content: text } } as any;
}

function tool(name: string, args: any = {}) {
  return { type: "tool_execution_start", toolName: name, args } as any;
}

describe("ADR-64 — the pulse: is the child still working?", () => {
  test("a new tool call with a new argument is a progress tick", () => {
    const p = newPulse("read tasks.md and implement the toolmask", { repoRoot: process.cwd(), now: T0 });
    feedPulseEvent(p, tool("read", { path: "tasks.md" }), T0 + 1000);
    assert.equal(p.lastProgressAtMs, T0 + 1000, "a new action is progress");
  });

  test("the SAME tool call repeated is not progress", () => {
    const p = newPulse("read tasks.md", { repoRoot: process.cwd(), now: T0 });
    feedPulseEvent(p, tool("read", { path: "tasks.md" }), T0 + 1000);
    const after = p.lastProgressAtMs;
    feedPulseEvent(p, tool("read", { path: "tasks.md" }), T0 + 2000);
    assert.equal(p.lastProgressAtMs, after, "a repeated action is not progress");
  });

  test("a step that makes no progress for the window is STALLED", () => {
    const p = newPulse("implement the thing", { repoRoot: process.cwd(), now: T0 });
    feedPulseEvent(p, tool("read", { path: "a.ts" }), T0 + 1000);
    assert.equal(evaluatePulse(p, LIMITS, T0 + 1000), null, "not stalled yet");
    const trip = evaluatePulse(p, LIMITS, T0 + 1000 + LIMITS.noProgressMs + 1);
    assert.ok(trip, "the stall must trip");
    assert.equal(trip!.signal, "stalled");
    assert.match(trip!.reason, /no progress/i);
  });

  test("a child that keeps making progress is NEVER stalled", () => {
    const p = newPulse("implement the thing", { repoRoot: process.cwd(), now: T0 });
    for (let i = 0; i < 40; i++) {
      const now = T0 + i * 60_000;
      feedPulseEvent(p, tool("read", { path: `f${i}.ts` }), now);
      assert.equal(evaluatePulse(p, LIMITS, now), null, `still working at minute ${i}`);
    }
    assert.ok(p.maxGapMs <= 60_000);
  });

  test("a drifting child trips ONLY when the shared terms collapse", () => {
    const p = newPulse("refactor the provenance guard and the taint store", { repoRoot: process.cwd(), now: T0 });
    // Two windows ON topic: the brief's terms are repeated.
    for (let i = 0; i < 2 * LIMITS.driftWindow; i++) {
      feedPulseEvent(
        p,
        assistant(
          `I am working on the provenance guard and the taint store now, step ${i} of the refactor in the repository.`,
        ),
        T0 + i * 1000,
      );
    }
    // The current window says nothing about the task — the PREVIOUS one did.
    for (let i = 0; i < LIMITS.driftWindow; i++) {
      feedPulseEvent(
        p,
        assistant(
          `Let me look at the weather forecast and browse some unrelated cooking websites for a while, this is quite relaxing indeed and takes many words to fill.`,
        ),
        T0 + 10_000 + i * 1000,
      );
    }
    const trip = evaluatePulse(p, LIMITS, T0 + 20_000);
    assert.ok(trip, "the collapse must trip");
    assert.equal(trip!.signal, "lexical-drift");
  });

  test("a child that NEVER mentioned the brief does not trip the drift", () => {
    const p = newPulse("refactor the provenance guard and the taint store", { repoRoot: process.cwd(), now: T0 });
    for (let i = 0; i < 2 * LIMITS.driftWindow; i++) {
      feedPulseEvent(
        p,
        assistant(
          `Let me look at the weather forecast and browse some unrelated cooking websites for a while, this is quite relaxing indeed and takes many words to fill.`,
        ),
        T0 + i * 1000,
      );
    }
    // No COLLAPSE (there was never an overlap) → no trip. An absolute
    // absence would punish a child that is doing its job.
    assert.equal(evaluatePulse(p, LIMITS, T0 + 20_000), null);
  });

  test("a write OUTSIDE the repository is a scope drift", () => {
    const root = path.join(os.tmpdir(), "kstack-pulse-root");
    const p = newPulse("implement in the repository", { repoRoot: root, now: T0 });
    // The home directory is neither the repository nor the OS temp dir.
    feedPulseEvent(p, tool("write", { path: path.join(os.homedir(), "outside-the-repo.ts") }), T0 + 1000);
    const trip = evaluatePulse(p, LIMITS, T0 + 2000);
    assert.ok(trip, "the out-of-scope write must trip");
    assert.equal(trip!.signal, "scope-drift");
  });

  test("a write INSIDE the repository is fine", () => {
    const root = path.join(os.tmpdir(), "kstack-pulse-root");
    const p = newPulse("implement in the repository", { repoRoot: root, now: T0 });
    feedPulseEvent(p, tool("write", { path: path.join(root, "src", "x.ts") }), T0 + 1000);
    assert.equal(evaluatePulse(p, LIMITS, T0 + 2000), null);
  });

  test("a write in the OS temp dir is NOT a scope drift (test fixtures live there)", () => {
    const root = path.join(os.tmpdir(), "kstack-pulse-root");
    const p = newPulse("implement in the repository", { repoRoot: root, now: T0 });
    feedPulseEvent(p, tool("write", { path: path.join(os.tmpdir(), "fixture.ts") }), T0 + 1000);
    assert.equal(evaluatePulse(p, LIMITS, T0 + 2000), null);
  });

  test("the drift measure runs every N events, not on every event", () => {
    const p = newPulse("the brief", { repoRoot: process.cwd(), now: T0 });
    for (let i = 1; i <= 4; i++) {
      feedPulseEvent(p, tool("read", { path: `f${i}.ts` }), T0 + i * 1000);
      assert.equal(pulseDue(p, LIMITS), false, `event ${i} is not a pulse point`);
    }
    feedPulseEvent(p, tool("read", { path: "f5.ts" }), T0 + 5000);
    assert.equal(pulseDue(p, LIMITS), true, "event 5 is a pulse point");
  });

  test("the park names the signal and the recovery brief forbids a restart", () => {
    const p = newPulse("implement the thing", { repoRoot: process.cwd(), now: T0 });
    feedPulseEvent(p, tool("read", { path: "a.ts" }), T0 + 1000);
    const trip = evaluatePulse(p, LIMITS, T0 + 1000 + LIMITS.noProgressMs + 1)!;
    assert.equal(pulsePausedReason(trip, "implement", "backend"), "pulse:stalled:implement.backend");
    assert.match(pulseDiagnosis(trip), /stalled/);
    const brief = pulseRecoveryBrief(trip, "implement", "backend");
    assert.match(brief, /RECOVERY/);
    assert.match(brief, /Do NOT start the work over/);
    assert.match(brief, /read/);
  });
});
