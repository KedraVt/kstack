import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sprintGateEphemerals, ephemeralArtifactsFor } from "../orchestrator/artifacts.ts";

/**
 * TASK_20 — a finished sprint must leave NOTHING in the project root, or
 * the next run's numbering sees a "live" sprint that was archived long ago
 * (the false positive that paused a run: the same number in the root and in
 * the archive).
 *
 * The current chain uses FLAT names (`user-story.md`), but a sprint started
 * before the flat-name rename left `_NN`-suffixed documents behind. The
 * cleanup must know those names too.
 */
describe("the sprint end-of-run cleanup", () => {
  test("the flat sprint ephemerals are registered", () => {
    const list = ephemeralArtifactsFor("sprint");
    for (const name of ["understand.md", "user-story.md", "capability.md", "tasks.md", "summary_BE.md", "summary_FE.md"]) {
      assert.ok(list.includes(name), `${name} must be cleaned at the end of a sprint run`);
    }
  });

  test("the legacy _NN names of the sprint are registered as well", () => {
    const list = ephemeralArtifactsFor("sprint", 2);
    // The legacy chain's documents, for the sprint number 2.
    for (const name of ["user-story_02.md", "tasks_02.md", "product-capability_02.md", "explore-notes_02.md"]) {
      assert.ok(list.includes(name), `${name} (the legacy name) must be cleaned at the end of a sprint run`);
    }
  });

  test("the gate reports of the sprint are registered", () => {
    const list = sprintGateEphemerals(2);
    assert.ok(list.includes("qa-artifact_02.md"));
    assert.ok(list.includes("devsecops/code-review-artifact_02.md"));
    assert.ok(list.includes("devsecops/security-review-artifact_02.md"));
  });
});
