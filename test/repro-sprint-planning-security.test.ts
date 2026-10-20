// Reproduction tests for sprint workflow planning superficiality and DevSecOps freeze loop issues
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createState, returnParkedWithContext, forceContinuePastGate, isSecurityFrozen } from "../orchestrator/state.ts";
import { getWorkflow } from "../orchestrator/workflows.ts";
import { carryOverOpenQuestions } from "../orchestrator/templates.ts";
import { advanceBlockReason } from "../orchestrator/executor.ts";

const SPRINT = getWorkflow("sprint")!;

describe("Reproduction: DevSecOps Security Freeze & Planning Issues", () => {
  test("repro 1: returnParkedWithContext should handle security freeze (freezeInfo) and loop back to implement", () => {
    // A security freeze parks the workflow with freezeInfo, but verdictPark is undefined
    const baseState = createState("sprint", "test security freeze loop");
    const devsecopsIndex = SPRINT.phases.findIndex((p) => p.id === "devsecops-review");
    assert.ok(devsecopsIndex >= 0, "devsecops-review phase must exist in sprint workflow");

    const frozenState = {
      ...baseState,
      status: "paused" as const,
      phaseIndex: devsecopsIndex,
      frozenUntilHuman: true,
      freezeInfo: {
        phaseId: "devsecops-review",
        severity: "critical",
        artifactPath: "sprints/sprint_01/devsecops/security-review-artifact_01.md",
      },
      // Note: verdictPark is undefined in security freeze!
      verdictPark: undefined,
    };

    const next = returnParkedWithContext(frozenState, SPRINT.phases, "Sanitize input parameters");

    // CURRENT BUG: returnParkedWithContext returns null because state.verdictPark is undefined.
    // EXPECTED: It should resolve the phase from freezeInfo, loop back to "implement",
    // clear frozenUntilHuman and freezeInfo, and return active state with retryContext.
    assert.notEqual(
      next,
      null,
      "returnParkedWithContext must not return null when frozen under security freeze (freezeInfo)"
    );
    assert.equal(next?.status, "active", "Workflow should be active after returning with remediation");
    assert.equal(SPRINT.phases[next!.phaseIndex].id, "implement", "Should loop back to implement phase");
    assert.equal(isSecurityFrozen(next!), false, "Security freeze should be cleared after returning with remediation");
  });

  test("repro 2: forceContinuePastGate should clear security freeze flags so subsequent phases are not blocked", () => {
    // Defense in depth: the freeze panel no longer offers "accept risk", but
    // forceContinuePastGate (kill-switch / loop-exhaustion panels) must still
    // clear the freeze markers it inherits.
    const baseState = createState("sprint", "test accept risk past security freeze");
    const devsecopsIndex = SPRINT.phases.findIndex((p) => p.id === "devsecops-review");

    const frozenState = {
      ...baseState,
      status: "paused" as const,
      phaseIndex: devsecopsIndex,
      frozenUntilHuman: true,
      freezeInfo: {
        phaseId: "devsecops-review",
        severity: "critical",
        artifactPath: "sprints/sprint_01/devsecops/security-review-artifact_01.md",
      },
    };

    const next = forceContinuePastGate(frozenState, SPRINT.phases);

    // CURRENT BUG: forceContinuePastGate leaves frozenUntilHuman: true and freezeInfo intact.
    // Consequently, isSecurityFrozen(next) is true, and advanceBlockReason blocks next phases (e.g. docker-review, pipeline-review).
    assert.equal(
      isSecurityFrozen(next),
      false,
      "forceContinuePastGate must clear security freeze so the workflow can actually proceed"
    );

    const blockReason = advanceBlockReason(next);
    assert.equal(
      blockReason,
      null,
      "advanceBlockReason should not block next phase due to lingering security freeze markers"
    );
  });

  test("repro 3: carryOverOpenQuestions should find open questions in understand.evolve step results", () => {
    const state = createState("sprint", "test carry over open questions");
    // During understand step 'interrogate', only results['understand.evolve'] exists, not results['understand']
    state.results["understand.evolve"] = {
      status: "completed",
      summary: "Completed evolve.\nOPEN QUESTIONS:\n- How should we structure the DB schema?\n- What authentication provider to use?",
    };

    const carried = carryOverOpenQuestions({ state });

    // CURRENT BUG: carryOverOpenQuestions checks state.results['understand'], which is undefined during step interrogation.
    // EXPECTED: It should inspect understand.evolve (or any understand.* step) when results['understand'] is not set.
    assert.match(
      carried,
      /How should we structure the DB schema\?/,
      "carryOverOpenQuestions must extract open questions from understand.evolve step summary"
    );
  });
});
