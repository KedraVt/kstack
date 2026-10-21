/**
 * TASK_01 / TASK_02 — the tool mask (ADR-25, ADR-41, ADR-45, ADR-50, ADR-60).
 *
 * The mask narrows the MAIN session's tool set to a phase's profile:
 *   - `full`  — every browser tool stays;
 *   - `read`  — the READ_TOOLS allowlist (non-mutating inspection + navigation);
 *   - `none`  — no browser tool at all.
 * The control tools (`kstack_advance`, `kstack_phase`) are NEVER masked.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTROL_TOOLS,
  BROWSER_TOOLS,
  READ_TOOLS,
  PHASE_TOOL_PROFILE,
  profileFor,
  maskedFor,
  reconcileToolMask,
  restoreAllTools,
  maskLedger,
  resetToolMaskLedger,
  type ToolMaskHost,
} from "../orchestrator/toolmask.ts";
import { getStaticWorkflows, getWorkflow } from "../orchestrator/workflows.ts";
import { TOOLS } from "../tools.generated.ts";
import { applyPhaseToolMask } from "../orchestrator/executor.ts";
import { reassertToolMask } from "../orchestrator/index.ts";
import { abortWorkflow } from "../orchestrator/command.ts";
import { createState } from "../orchestrator/state.ts";

/** A fake pi that mirrors pi's own rules: unknown names are DROPPED. */
function fakePi(names: string[], opts?: { dropUnknown?: boolean; failOnSet?: boolean }) {
  const all = names.map((n) => ({ name: n }));
  let active = [...names];
  const calls: string[][] = [];
  const pi: ToolMaskHost = {
    getActiveTools: () => [...active],
    getAllTools: () => all as any,
    setActiveTools: (n: string[]) => {
      if (opts?.failOnSet) throw new Error("setActiveTools unavailable");
      calls.push([...n]);
      active = opts?.dropUnknown ? n.filter((x) => names.includes(x)) : [...n];
    },
  };
  return { pi, calls, active: () => active };
}

const ALL = [...BROWSER_TOOLS, ...CONTROL_TOOLS];

beforeEach(() => {
  resetToolMaskLedger();
});

describe("the profile table — one key per registered (workflow, phase) pair", () => {
  test("every static (workflow, phase) pair has an explicit key (INV-3)", () => {
    const missing: string[] = [];
    let pairs = 0;
    for (const wf of getStaticWorkflows()) {
      for (const ph of wf.phases) {
        pairs++;
        const key = `${wf.id}:${ph.id}`;
        if (!(key in PHASE_TOOL_PROFILE)) missing.push(key);
      }
    }
    assert.deepEqual(missing, [], `phases without a profile key: ${missing.join(", ")}`);
    assert.equal(pairs, 38, "the registry has 38 (workflow, phase) pairs");
    assert.equal(Object.keys(PHASE_TOOL_PROFILE).length, 38, "the table has exactly one key per pair");
  });

  test("the sprint workflow is in the static list even when its kill-switch hides it", () => {
    assert.ok(getStaticWorkflows().some((w) => w.id === "sprint"), "sprint must be enumerated statically");
  });

  test("every declared profile is one of full|read|none", () => {
    for (const [key, profile] of Object.entries(PHASE_TOOL_PROFILE)) {
      assert.ok(["full", "read", "none"].includes(profile), `${key} → ${profile}`);
    }
  });

  test("an undeclared pair resolves `full` at runtime (availability)", () => {
    const phase = { id: "not-registered", name: "x", execution: "main" } as any;
    assert.equal(profileFor("develop", phase), "full");
  });

  test("a declared pair resolves its declared profile", () => {
    const sprint = getStaticWorkflows().find((w) => w.id === "sprint")!;
    const plan = sprint.phases.find((p) => p.id === "implement")!;
    assert.equal(profileFor("sprint", plan), "none");
    const qa = sprint.phases.find((p) => p.id === "qa-browsing")!;
    assert.equal(profileFor("sprint", qa), "full");
  });
});

describe("READ_TOOLS — the read profile's allowlist (INV-4)", () => {
  const FORBIDDEN = [
    "kstack_click", "kstack_fill", "kstack_select", "kstack_hover", "kstack_type",
    "kstack_press", "kstack_upload", "kstack_cookie", "kstack_cookie_import",
    "kstack_cookie_import_browser", "kstack_header", "kstack_useragent",
    "kstack_style", "kstack_cleanup", "kstack_dialog_accept",
    "kstack_dialog_dismiss", "kstack_download", "kstack_scrape",
    "kstack_daemon_restart", "kstack_state", "kstack_skill", "kstack_handoff",
    "kstack_resume", "kstack_chain", "kstack_js", "kstack_eval",
    "kstack_storage", "kstack_cookies", "kstack_pdf", "kstack_archive",
    "kstack_prettyscreenshot", "kstack_responsive", "kstack_viewport",
  ];

  test("the allowlist is disjoint from the forbidden list", () => {
    for (const name of FORBIDDEN) {
      assert.equal(READ_TOOLS.has(name), false, `${name} must not be in the read set`);
    }
  });

  test("every read tool exists in the tool registry", () => {
    const known = new Set(TOOLS.map((t) => t.name));
    for (const name of READ_TOOLS) {
      assert.ok(known.has(name), `${name} is not a registered tool`);
    }
    assert.equal(READ_TOOLS.size, 32, "the read set holds 32 tools");
  });

  test("the read set only holds browser tools", () => {
    for (const name of READ_TOOLS) {
      assert.ok(BROWSER_TOOLS.has(name), `${name} is not a browser tool`);
    }
  });
});

describe("maskedFor — what a profile removes", () => {
  test("full removes nothing", () => {
    assert.equal(maskedFor("full").size, 0);
  });

  test("none removes every browser tool but no control tool", () => {
    const masked = maskedFor("none");
    assert.equal(masked.size, BROWSER_TOOLS.size);
    for (const c of CONTROL_TOOLS) assert.equal(masked.has(c), false);
  });

  test("read removes exactly the browser tools outside the read set", () => {
    const masked = maskedFor("read");
    for (const name of READ_TOOLS) assert.equal(masked.has(name), false);
    for (const name of BROWSER_TOOLS) {
      if (!READ_TOOLS.has(name)) assert.equal(masked.has(name), true, `${name} must be masked in read`);
    }
  });
});

describe("reconcileToolMask — the reconcile algebra (INV-2)", () => {
  test("the mask adds no name and removes exactly the masked ones", () => {
    const { pi, active } = fakePi(ALL);
    reconcileToolMask(pi, "none", { runId: "r1" });
    const next = new Set(active());
    for (const name of ALL) {
      if (BROWSER_TOOLS.has(name)) assert.equal(next.has(name), false, `${name} must be masked`);
      else assert.equal(next.has(name), true, `${name} must survive`);
    }
  });

  test("the control tools are never masked (INV-1)", () => {
    const { pi, active } = fakePi(ALL);
    for (const profile of ["full", "read", "none"] as const) {
      reconcileToolMask(pi, profile, { runId: "r1" });
      for (const c of CONTROL_TOOLS) assert.ok(active().includes(c), `${c} must stay active under ${profile}`);
    }
  });

  test("applying the same profile twice is a no-op (no setActiveTools churn)", () => {
    const { pi, calls } = fakePi(ALL);
    reconcileToolMask(pi, "none", { runId: "r1" });
    assert.equal(calls.length, 1);
    reconcileToolMask(pi, "none", { runId: "r1" });
    assert.equal(calls.length, 1, "an unchanged profile must not call setActiveTools again");
  });

  test("full after none restores exactly the removed set (reversible)", () => {
    const { pi, active } = fakePi(ALL);
    reconcileToolMask(pi, "none", { runId: "r1" });
    const removed = new Set(maskLedger().removedByMask);
    assert.ok(removed.size > 0, "the mask must record what it removed");
    reconcileToolMask(pi, "full", { runId: "r1" });
    for (const name of removed) assert.ok(active().includes(name), `${name} must be restored`);
    assert.deepEqual([...active()].sort(), [...ALL].sort());
  });

  test("a tool the user deactivated stays off after a restore", () => {
    const names = ALL.filter((n) => n !== "kstack_screenshot");
    const { pi, active } = fakePi(names);
    reconcileToolMask(pi, "none", { runId: "r1" });
    reconcileToolMask(pi, "full", { runId: "r1" });
    assert.equal(active().includes("kstack_screenshot"), false, "a user-deactivated tool must stay off");
  });

  test("a name pi does not know is dropped by pi, not by the mask", () => {
    const { pi, calls } = fakePi(ALL, { dropUnknown: true });
    reconcileToolMask(pi, "none", { runId: "r1" });
    // The mask never adds a name: the call it made carries only known names.
    for (const name of calls[0]) assert.ok(ALL.includes(name), "the mask must not add names");
  });

  test("the result is ordered by the getAllTools() index", () => {
    const order = ["kstack_phase", "kstack_advance", ...ALL.filter((n) => !CONTROL_TOOLS.has(n))];
    const { pi, active } = fakePi(order);
    reconcileToolMask(pi, "read", { runId: "r1" });
    const got = active();
    const idx = got.map((n) => order.indexOf(n));
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b), "the tool order must follow getAllTools()");
  });

  test("an owner switch restores the previous owner's removals, then re-masks", () => {
    const { pi, active } = fakePi(ALL);
    reconcileToolMask(pi, "none", { runId: "r1" });
    assert.equal(active().includes("kstack_goto"), false);
    // A different run takes over with the `read` profile: the previous
    // owner's removals are restored and the new profile is applied.
    reconcileToolMask(pi, "read", { runId: "r2" });
    assert.ok(active().includes("kstack_goto"), "a read profile keeps the navigation family");
    assert.equal(active().includes("kstack_click"), false, "read masks the interaction tools");
    assert.equal(maskLedger().ownerRunId, "r2");
  });

  test("a setActiveTools failure is caught — the mask is an optimisation, not a boundary", () => {
    const { pi, calls } = fakePi(ALL, { failOnSet: true });
    reconcileToolMask(pi, "none", { runId: "r1" });
    assert.equal(calls.length, 0, "the failure happens inside pi");
    assert.ok(true, "no throw escaped the reconcile");
  });

  test("the change is reported so the caller can ledger it", () => {
    const { pi } = fakePi(ALL);
    const seen: string[] = [];
    reconcileToolMask(pi, "none", { runId: "r1", onChange: (i) => seen.push(`${i.profile}:-${i.removed}/+${i.added}`) });
    assert.equal(seen.length, 1);
    assert.ok(seen[0].startsWith("none:-"), seen[0]);
  });
});

// --- TASK_02 — the mask wired into the orchestrator ------------------------

/** A fake pi that owns a tool loadout, like the real host. */
function hostPi(names: string[]) {
  const all = names.map((n) => ({ name: n }));
  let active = [...names];
  const pi: any = {
    getActiveTools: () => [...active],
    getAllTools: () => all,
    setActiveTools: (n: string[]) => {
      active = [...n];
    },
    registerTool: () => {},
    registerCommand: () => {},
    on: () => {},
    exec: async () => ({ stdout: "", stderr: "" }),
    appendEntry: () => {},
  };
  return { pi, active: () => active };
}

/**
 * The temp roots the fixtures below work in. The orchestrator's terminal
 * paths (the abort, the run finalisation) DELETE the run's ephemeral
 * artifacts under `ctx.cwd` — a fixture rooted at the repo would delete the
 * sprint's own planning artifacts (tasks.md, capability.md, …) every time
 * the suite runs. Every fixture therefore gets its own temp root.
 */
const tmpRoots: string[] = [];
function tmpCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kstack-toolmask-"));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpRoots.length) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

/** A fake session context carrying one persisted workflow state. */
function hostCtx(state: unknown, cwd: string) {
  const entries = state ? [{ type: "custom", customType: "kstack-wf-state", data: state }] : [];
  const notes: Array<{ msg: string; level: string }> = [];
  const ctx: any = {
    cwd,
    ui: { notify: (msg: string, level: string) => notes.push({ msg, level }), setStatus: () => {} },
    sessionManager: { getEntries: () => entries },
  };
  return { ctx, notes };
}

describe("TASK_02 — the mask wired into the orchestrator", () => {
  const sprint = getWorkflow("sprint")!;
  const nonePhase = sprint.phases.find((p) => p.id === "implement")!;
  const fullPhase = sprint.phases.find((p) => p.id === "qa-browsing")!;

  /** The main session never carries KSTACK_STEP (only delegated children do). */
  function asMainSession(fn: () => void): void {
    const prev = process.env.KSTACK_STEP;
    delete process.env.KSTACK_STEP;
    try {
      fn();
    } finally {
      if (prev !== undefined) process.env.KSTACK_STEP = prev;
    }
  }

  test("a masked phase leaves the control tools active", () => {
    asMainSession(() => {
      const { pi, active } = hostPi(ALL);
      const { ctx } = hostCtx(null, tmpCwd());
      const state = { ...createState("sprint", "g"), runId: "r1" };
      applyPhaseToolMask(pi, ctx, state, nonePhase);
      assert.equal(active().includes("kstack_goto"), false, "the browser tools must be masked");
      for (const c of CONTROL_TOOLS) assert.ok(active().includes(c), `${c} must stay active`);
    });
  });

  test("the per-turn re-assert resolves the profile from the persisted state", () => {
    asMainSession(() => {
      const { pi, active } = hostPi(ALL);
      const state = { ...createState("sprint", "g"), runId: "r1", phaseIndex: sprint.phases.findIndex((p) => p.id === "implement") };
      const { ctx } = hostCtx(state, tmpCwd());
      reassertToolMask(pi, ctx);
      assert.equal(active().includes("kstack_goto"), false, "the `none` phase masks the browser tools");
    });
  });

  test("no active run resolves the `full` profile and restores the tools", () => {
    asMainSession(() => {
      const { pi, active } = hostPi(ALL);
      const { ctx } = hostCtx(null, tmpCwd());
      // A masked loadout whose run ended without a terminal restore.
      reconcileToolMask(pi, "none", { runId: "r1" });
      assert.equal(active().includes("kstack_goto"), false);
      reassertToolMask(pi, ctx);
      assert.ok(active().includes("kstack_goto"), "a `full` profile restores the browser tools");
    });
  });

  test("a delegated child (env KSTACK_STEP) keeps its own tool set", () => {
    const { pi, active } = hostPi(ALL);
    const state = { ...createState("sprint", "g"), runId: "r1", phaseIndex: sprint.phases.findIndex((p) => p.id === "implement") };
    const { ctx } = hostCtx(state, tmpCwd());
    const before = [...active()];
    const prev = process.env.KSTACK_STEP;
    process.env.KSTACK_STEP = "backend";
    try {
      reassertToolMask(pi, ctx);
    } finally {
      if (prev === undefined) delete process.env.KSTACK_STEP;
      else process.env.KSTACK_STEP = prev;
    }
    assert.deepEqual(active(), before, "the child keeps its own tool set");
  });

  test("abort during a masked phase restores the browser tools", () => {
    asMainSession(() => {
      const { pi, active } = hostPi(ALL);
      const cwd = tmpCwd();
      // The abort is a TERMINAL status: the run's ephemerals die with it —
      // inside the run's OWN root, never in the repo the suite runs in.
      writeFileSync(path.join(cwd, "understand.md"), "ephemeral");
      const { ctx } = hostCtx(null, cwd);
      const state = { ...createState("sprint", "g"), runId: "r1" };
      applyPhaseToolMask(pi, ctx, state, nonePhase);
      assert.equal(active().includes("kstack_goto"), false);
      abortWorkflow(pi, ctx as any, state as any, "Workflow aborted.");
      assert.ok(active().includes("kstack_goto"), "the abort must restore the browser tools");
      assert.equal(existsSync(path.join(cwd, "understand.md")), false, "the abort deletes the run's ephemerals");
      // A later `full` phase in the same session has them back.
      applyPhaseToolMask(pi, ctx, state, fullPhase);
      assert.ok(active().includes("kstack_goto"), "a later `full` phase keeps the browser tools");
    });
  });
});

describe("the mask ledger (INV-28)", () => {
  test("the ledger records the owner and the removed names", () => {
    const { pi } = fakePi(ALL);
    reconcileToolMask(pi, "none", { runId: "r1" });
    assert.equal(maskLedger().ownerRunId, "r1");
    assert.ok(maskLedger().removedByMask.has("kstack_goto"));
  });

  test("a terminal restore clears the ledger only after setActiveTools succeeded", () => {
    const { pi } = fakePi(ALL);
    reconcileToolMask(pi, "none", { runId: "r1" });
    assert.ok(maskLedger().removedByMask.size > 0);
    const ok = restoreAllTools(pi);
    assert.equal(ok, true);
    assert.equal(maskLedger().removedByMask.size, 0, "a successful restore clears the ledger");
    assert.equal(maskLedger().ownerRunId, null);
  });

  test("a failed restore keeps the ledger — a restore is still owed", () => {
    const { pi } = fakePi(ALL);
    reconcileToolMask(pi, "none", { runId: "r1" });
    const failing: ToolMaskHost = {
      getActiveTools: () => pi.getActiveTools(),
      getAllTools: () => pi.getAllTools(),
      setActiveTools: () => {
        throw new Error("no");
      },
    };
    const ok = restoreAllTools(failing);
    assert.equal(ok, false);
    assert.ok(maskLedger().removedByMask.size > 0, "the ledger survives a failed restore");
  });
});
