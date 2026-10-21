import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { budgetPanelHint } from "../orchestrator/command.ts";
import type { WorkflowState } from "../orchestrator/types.ts";

/**
 * S5a/ADR-62 — the panel must name the env var that raises a tripped budget
 * dimension, EVEN AFTER A RESTART. The park notify is gone by then; the
 * persisted `pausedReason` and `budgetRaiseEnv` are not.
 */
describe("the budget park panel hint", () => {
  const base = { workflowId: "sprint", status: "paused" } as unknown as WorkflowState;

  test("a budget park names the env var that raises the dim", () => {
    const hint = budgetPanelHint({
      ...base,
      pausedReason: "budget-exceeded:turns:implement.backend",
    } as WorkflowState);
    assert.ok(hint, "a budget park must produce a hint");
    assert.match(hint, /KSTACK_PI_STEP_MAX_TURNS/);
    assert.match(hint, /or off/);
  });

  test("the persisted env var is the fallback when the reason does not parse", () => {
    const hint = budgetPanelHint({
      ...base,
      pausedReason: "budget-exceeded:",
      budgetRaiseEnv: "KSTACK_PI_STEP_MAX_CONTEXT",
    } as WorkflowState);
    assert.ok(hint);
    assert.match(hint, /KSTACK_PI_STEP_MAX_CONTEXT/);
  });

  test("a non-budget park has no hint", () => {
    assert.equal(
      budgetPanelHint({ ...base, pausedReason: "verdict-unreadable:qa-verdict:no-verdict" } as WorkflowState),
      null,
    );
    assert.equal(budgetPanelHint(base), null);
  });
});
