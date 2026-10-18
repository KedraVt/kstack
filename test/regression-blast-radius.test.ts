// Regression pass around the blast radius of sprint planning and DevSecOps freeze fixes
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createState,
  returnParkedWithContext,
  forceContinuePastGate,
  forceApproveParked,
  isSecurityFrozen,
  unfreeze,
} from "../orchestrator/state.ts";
import { getWorkflow } from "../orchestrator/workflows.ts";
import { carryOverOpenQuestions } from "../orchestrator/templates.ts";
import { advanceBlockReason } from "../orchestrator/executor.ts";
import { handleSprintPanel } from "../orchestrator/command.ts";
import { createInputRouter } from "../orchestrator/router.ts";
import {
  sprintArchiveDir,
  archivedSprintDirs,
  computeNextSprintNumber,
} from "../orchestrator/sprint.ts";
import { reportCliPath } from "../orchestrator/records.ts";
import { EXPECTATIONS } from "../orchestrator/verdicts.ts";
import { invalidateRuntime, releasePhaseInFlight } from "../orchestrator/executor.ts";
import { getWorkflowIds } from "../orchestrator/workflows.ts";

// Panel choices relaunch real phase chains in the background — stop them and
// free the in-flight registry so later test files are not polluted.
after(() => {
  invalidateRuntime();
  for (const id of getWorkflowIds()) for (let i = 0; i < 32; i++) releasePhaseInFlight(id, i);
});


const SPRINT = getWorkflow("sprint")!;

describe("Regression Blast Radius: DevSecOps Security Freeze & Resolution", () => {
  const devsecopsIndex = SPRINT.phases.findIndex((p) => p.id === "devsecops-review");
  const dockerIndex = SPRINT.phases.findIndex((p) => p.id === "docker-review");
  const implementIndex = SPRINT.phases.findIndex((p) => p.id === "implement");

  test("1. returnParkedWithContext handles security freeze with custom remediation and loops back to implement", () => {
    const base = createState("sprint", "test custom remediation");
    const frozenState = {
      ...base,
      status: "paused" as const,
      phaseIndex: devsecopsIndex,
      frozenUntilHuman: true,
      freezeInfo: {
        phaseId: "devsecops-review",
        severity: "critical",
        artifactPath: "devsecops/security-review-artifact_01.md",
      },
    };

    const next = returnParkedWithContext(frozenState, SPRINT.phases, "Ensure SQL query uses parameterized statements");
    assert.ok(next, "Must return new state");
    assert.equal(next.status, "active");
    assert.equal(next.phaseIndex, implementIndex, "Must loop back to implement phase");
    assert.equal(next.frozenUntilHuman, false, "Must unfreeze frozenUntilHuman");
    assert.equal(next.freezeInfo, undefined, "Must clear freezeInfo");
    assert.equal(isSecurityFrozen(next), false, "Must not be considered security-frozen");
    assert.equal(next.retryContext?.targetPhaseId, "implement");
    assert.match(next.retryContext?.feedback ?? "", /parameterized statements/);
  });

  test("2. returnParkedWithContext handles security freeze without custom remediation (default feedback)", () => {
    const base = createState("sprint", "test return with default guidance");
    const frozenState = {
      ...base,
      status: "paused" as const,
      phaseIndex: devsecopsIndex,
      frozenUntilHuman: true,
      freezeInfo: {
        phaseId: "devsecops-review",
        severity: "high",
        artifactPath: "devsecops/security-review-artifact_01.md",
      },
    };

    const next = returnParkedWithContext(frozenState, SPRINT.phases);
    assert.ok(next);
    assert.equal(next.status, "active");
    assert.equal(next.phaseIndex, implementIndex);
    assert.equal(isSecurityFrozen(next), false);
  });

  test("3. returnParkedWithContext handles standard verdict park (non-freeze)", () => {
    const qaIndex = SPRINT.phases.findIndex((p) => p.id === "qa-browsing");
    const base = createState("sprint", "test qa loopback");
    const parkedState = {
      ...base,
      status: "paused" as const,
      phaseIndex: qaIndex,
      verdictPark: "qa-browsing",
      pausedReason: "verdict-negative:qa-browsing",
    };

    const next = returnParkedWithContext(parkedState, SPRINT.phases, "Fix broken form validation");
    assert.ok(next);
    assert.equal(next.phaseIndex, implementIndex);
    assert.equal(next.verdictPark, undefined);
    assert.match(next.retryContext?.feedback ?? "", /broken form validation/);
  });

  test("4. forceContinuePastGate clears security freeze and allows subsequent review gates to proceed", () => {
    const base = createState("sprint", "test accept risk");
    const frozenState = {
      ...base,
      status: "paused" as const,
      phaseIndex: devsecopsIndex,
      frozenUntilHuman: true,
      freezeInfo: {
        phaseId: "devsecops-review",
        severity: "critical",
        artifactPath: "devsecops/security-review-artifact_01.md",
      },
      attempts: { implement: 3 },
    };

    const next = forceContinuePastGate(frozenState, SPRINT.phases);
    assert.equal(next.status, "active");
    assert.equal(next.phaseIndex, dockerIndex, "Should advance to next phase (docker-review)");
    assert.equal(next.frozenUntilHuman, false, "Must clear frozenUntilHuman");
    assert.equal(next.freezeInfo, undefined, "Must clear freezeInfo");
    assert.equal(isSecurityFrozen(next), false);
    // Crucial: advanceBlockReason must NOT block docker-review
    const blockReason = advanceBlockReason(next);
    assert.equal(blockReason, null, "Next phase must not be blocked by residual freeze");
  });

  test("5. isSecurityFrozen evaluates both frozenUntilHuman and freezeInfo correctly", () => {
    const base = createState("sprint", "test isSecurityFrozen conditions");
    assert.equal(isSecurityFrozen(base), false);
    assert.equal(isSecurityFrozen({ ...base, frozenUntilHuman: true }), true);
    assert.equal(isSecurityFrozen({ ...base, freezeInfo: { phaseId: "devsecops-review" } as any }), true);
    assert.equal(isSecurityFrozen({ ...base, frozenUntilHuman: false, freezeInfo: undefined }), false);
  });
});

describe("Regression Blast Radius: handleSprintPanel Modal Decisions", () => {
  const devsecopsIndex = SPRINT.phases.findIndex((p) => p.id === "devsecops-review");

  test("1. handleSprintPanel provides structured choices and handles 'Accept risk'", async () => {
    const base = createState("sprint", "test panel accept risk");
    const frozenState = {
      ...base,
      status: "paused" as const,
      phaseIndex: devsecopsIndex,
      frozenUntilHuman: true,
      freezeInfo: {
        phaseId: "devsecops-review",
        severity: "critical",
        artifactPath: "devsecops/security-review-artifact_01.md",
      },
    };

    let selectedChoice = "";
    let savedState: any = null;
    let launched = false;

    const mockPi: any = {
      registerCommand: () => {},
      appendEntry: (_type: string, st: any) => { savedState = st; },
      on: () => {},
    };

    const mockCtx: any = {
      ui: {
        select: async (prompt: string, options: string[]) => {
          assert.ok(prompt.includes("SECURITY FREEZE"));
          assert.deepEqual(options, [
            "Re-run review gate",
            "Accept risk — continue past the gate",
            "Return phase with guidance",
            "Custom remediation…",
            "Abort workflow",
          ]);
          selectedChoice = "Accept risk — continue past the gate";
          return selectedChoice;
        },
        notify: () => {},
      },
      cwd: process.cwd(),
      sessionManager: {
        appendCustomEntry: () => {},
        getEntries: () => [],
      },
    };

    const handled = await handleSprintPanel(frozenState, mockCtx, mockPi);
    assert.equal(handled, true);
  });

  test("2. handleSprintPanel handles 'Custom remediation…' by requesting input and looping back", async () => {
    const base = createState("sprint", "test panel custom remediation");
    const frozenState = {
      ...base,
      status: "paused" as const,
      phaseIndex: devsecopsIndex,
      frozenUntilHuman: true,
      freezeInfo: {
        phaseId: "devsecops-review",
        severity: "critical",
        artifactPath: "devsecops/security-review-artifact_01.md",
      },
    };

    let inputPrompted = false;
    const mockPi: any = {
      registerCommand: () => {},
      appendEntry: () => {},
      on: () => {},
    };

    const mockCtx: any = {
      ui: {
        select: async () => "Custom remediation…",
        input: async (title: string, msg: string) => {
          inputPrompted = true;
          assert.equal(title, "Custom security remediation");
          return "Escape HTML tags in output";
        },
        notify: () => {},
      },
      cwd: process.cwd(),
      sessionManager: {
        appendCustomEntry: () => {},
        getEntries: () => [],
      },
    };

    const handled = await handleSprintPanel(frozenState, mockCtx, mockPi);
    assert.equal(handled, true);
    assert.equal(inputPrompted, true);
  });
});

describe("Regression Blast Radius: Sprint Planning Open Questions Extraction", () => {
  test("1. carryOverOpenQuestions extracts open questions from understand.evolve step result", () => {
    const state = createState("sprint", "test carry over evolve questions");
    state.results["understand.evolve"] = {
      status: "completed",
      summary: "Completed evolve.\n\nOPEN QUESTIONS:\n- How should authorization roles be structured?\n- Do we need multi-tenancy?\n* Should audit logs be synchronous?",
    };

    const carried = carryOverOpenQuestions({ state });
    assert.match(carried, /How should authorization roles be structured\?/);
    assert.match(carried, /Do we need multi-tenancy\?/);
    assert.match(carried, /Should audit logs be synchronous\?/);
  });

  test("2. carryOverOpenQuestions extracts open questions from understand phase result if present", () => {
    const state = createState("sprint", "test carry over phase questions");
    state.results["understand"] = {
      status: "completed",
      summary: "Understood requirements.\n\nOPEN QUESTIONS:\n- What database engine to use?",
    };

    const carried = carryOverOpenQuestions({ state });
    assert.match(carried, /What database engine to use\?/);
  });

  test("3. carryOverOpenQuestions returns empty string when no open questions exist", () => {
    const state = createState("sprint", "test no open questions");
    state.results["understand.evolve"] = {
      status: "completed",
      summary: "Everything is clear and unambiguous.",
    };

    const carried = carryOverOpenQuestions({ state });
    assert.equal(carried, "");
  });
});

describe("Regression Blast Radius: Input Router Abort Bypass", () => {
  test("1. input router bypasses prompt prefixing for cancellation / abort commands", () => {
    const mockPi: any = {};
    const router = createInputRouter(mockPi);
    const mockCtx: any = {
      sessionManager: {
        getEntries: () => [],
      },
    };

    const abortKeywords = ["abort", "cancel", "stop", "terminate", "quit", "exit", "annulla", "termina", "esci", "fermati"];
    for (const kw of abortKeywords) {
      const res = router({ source: "interactive", text: kw } as any, mockCtx);
      assert.deepEqual(res, { action: "continue" }, `Keyword "${kw}" should pass through with action: continue`);
    }
  });
});

describe("Regression Blast Radius: Archival Directory Paths & Discovery", () => {
  test("1. sprintArchiveDir points to .kstack/workflows/sprint/sprint_XX", () => {
    const dir = sprintArchiveDir("C:/test-repo", 1);
    assert.equal(dir, path.join("C:/test-repo", ".kstack", "workflows", "sprint", "sprint_01"));
  });

  test("2. archivedSprintDirs discovers across both canonical and legacy archival roots", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kstack-archive-test-"));
    try {
      const canonicalDir = path.join(tmp, ".kstack", "workflows", "sprint", "sprint_02");
      const legacyDir = path.join(tmp, ".kstack", "sprints", "sprint_01");
      fs.mkdirSync(canonicalDir, { recursive: true });
      fs.mkdirSync(legacyDir, { recursive: true });

      const found = archivedSprintDirs(tmp);
      assert.equal(found.length, 2);
      assert.ok(found.some((p) => p.endsWith("sprint_02")));
      assert.ok(found.some((p) => p.endsWith("sprint_01")));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("3. computeNextSprintNumber detects next sprint correctly with archived sprints", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kstack-calc-test-"));
    try {
      const canonicalDir = path.join(tmp, ".kstack", "workflows", "sprint", "sprint_03");
      fs.mkdirSync(canonicalDir, { recursive: true });
      fs.writeFileSync(path.join(canonicalDir, "user-story_03.md"), "test user story");

      const disc = computeNextSprintNumber(tmp);
      assert.equal(disc.anomaly, null);
      assert.equal(disc.next, 4);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Regression Blast Radius: Verdict & Host Environment Blast Radius", () => {
  test("1. implement phase expects only per-lane walker keys (no shared walkthrough)", () => {
    const sprintExpected = EXPECTATIONS["sprint"]?.["implement"];
    assert.ok(sprintExpected);
    assert.ok(!("walkthrough?" in sprintExpected), "a shared walkthrough key would let two walkers contradict");
    assert.ok("be-walk?" in sprintExpected);
    assert.ok("fe-walk?" in sprintExpected);
    assert.ok("ui?" in sprintExpected);
  });

  test("2. reportCliPath resolves .cmd on win32 if present", () => {
    const cliPath = reportCliPath();
    if (process.platform === "win32") {
      assert.ok(cliPath.endsWith(".cmd"), `On Windows reportCliPath should end with .cmd: ${cliPath}`);
      assert.ok(!cliPath.includes("\\"), "forward slashes only — bash eats backslashes in a pasted path");
      assert.ok(fs.existsSync(cliPath), `CLI launcher must exist at ${cliPath}`);
    }
  });
});
