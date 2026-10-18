// Reproduction tests for reported sprint run issues on Windows:
// 1. Foreign verdict park on standard skill walkthrough
// 2. Windows kstack-report launcher presence
// 3. Security freeze panel UX (structured choices via select vs exact phrase input)
// 4. Prompt bloat: router injecting 35+ lines into user messages

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createState, routeVerdict } from "../orchestrator/state.ts";
import { handleSprintPanel } from "../orchestrator/command.ts";
import { verdictKeysFor } from "../orchestrator/records.ts";
import { getWorkflow } from "../orchestrator/workflows.ts";
import { createInputRouter } from "../orchestrator/router.ts";
import { invalidateRuntime, releasePhaseInFlight } from "../orchestrator/executor.ts";
import { getWorkflowIds } from "../orchestrator/workflows.ts";

// Panel choices relaunch real phase chains in the background — stop them and
// free the in-flight registry so later test files are not polluted.
after(() => {
  invalidateRuntime();
  for (const id of getWorkflowIds()) for (let i = 0; i < 32; i++) releasePhaseInFlight(id, i);
});


const SPRINT = getWorkflow("sprint")!;

describe("reproduction tests for reported sprint issues", () => {
  test("repro 1: a walker's stray `walkthrough` verdict is stripped, never parks the phase", () => {
    // Subagent running kstack-lite-mindrun emits walkthrough==pass beside its lane key.
    const implement = SPRINT.phases.find((p) => p.id === "implement")!;
    const beWalk = implement.steps!.find((s) => s.id === "be-walk")!;
    const backend = implement.steps!.find((s) => s.id === "backend")!;
    assert.deepEqual(verdictKeysFor("sprint", implement, beWalk), ["be-walk"]);
    assert.deepEqual(verdictKeysFor("sprint", implement, backend), [], "a build step owns no gate verdict");
    const outcome = routeVerdict("sprint", "implement", { verdicts: { "be-walk": "pass" } }, { phase: implement });
    assert.notEqual(outcome.kind, "park");
  });

  test("repro 2: Windows launcher kstack-report.cmd must exist next to runtime/bin/kstack-report", () => {
    const launcherPath = path.resolve("runtime/bin/kstack-report.cmd");
    // CURRENT BUG: launcher does not exist, triggering Windows 'Open With' dialog
    // EXPECTED: kstack-report.cmd must exist
    assert.equal(
      fs.existsSync(launcherPath),
      true,
      "runtime/bin/kstack-report.cmd must exist for Windows process execution"
    );
  });

  test("repro 3: security freeze resolution should provide structured choices via ui.select, not raw input phrase", async () => {
    const frozenState = {
      ...createState("sprint", "test security freeze"),
      status: "paused" as const,
      phaseIndex: 9,
      freezeInfo: {
        phaseId: "devsecops-review",
        severity: "critical",
        artifactPath: "sprints/sprint_01/devsecops/security-review-artifact_01.md",
      },
    };

    let selectCalled = false;
    let inputCalled = false;
    const mockCtx: any = {
      ui: {
        select: async () => {
          selectCalled = true;
          return "Re-run review gate";
        },
        input: async () => {
          inputCalled = true;
          return "";
        },
        notify: () => {},
        confirm: async () => false,
      },
      hasUI: true,
    };
    const mockPi: any = { appendEntry: () => {} };

    await handleSprintPanel(frozenState, mockCtx, mockPi);

    // CURRENT BUG: calls ctx.ui.input demanding FREEZE_RESUME_PHRASE ("security remediation approved")
    // EXPECTED: calls ctx.ui.select with structured resolution options
    assert.equal(selectCalled, true, "handleSprintPanel must invoke ctx.ui.select for security freeze");
    assert.equal(inputCalled, false, "handleSprintPanel must not require typing exact phrase via ctx.ui.input");
  });

  test("repro 4: input router must not prepend active workflow instructions to user abort messages", () => {
    const activeState = {
      ...createState("sprint", "test active"),
      status: "active" as const,
      phaseIndex: 11, // pipeline-review
    };

    const mockCtx: any = {
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "kstack-wf-state",
            data: activeState,
          },
        ],
      },
    };

    const router = createInputRouter({} as any);
    const result = router({ source: "interactive", text: "abort" } as any, mockCtx);

    // CURRENT BUG: transforms "abort" by prepending [kstack workflow active: ...]
    // EXPECTED: abort should not be prepended with workflow instructions
    assert.equal(
      result.action === "transform" && result.text.includes("[kstack workflow active:"),
      false,
      "Input router must not prepend active workflow instructions to abort commands"
    );
  });
});
