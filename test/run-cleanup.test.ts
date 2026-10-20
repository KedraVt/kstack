import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createState } from "../orchestrator/state.ts";
import { appendLedger, ledgerPathFor } from "../orchestrator/ledger.ts";
import { recordPathFor } from "../orchestrator/records.ts";
import { cleanupRunArtifacts } from "../orchestrator/runcleanup.ts";
import { executeCurrentPhase, finalizeRun } from "../orchestrator/executor.ts";
import { handleSprintPanel } from "../orchestrator/command.ts";
import { beginRun, resetTelemetry } from "../orchestrator/telemetry.ts";
import { getAllWorkflows } from "../orchestrator/workflows.ts";
import type { Workflow } from "../orchestrator/types.ts";

/**
 * Per-run operational files are ephemeral: the ledger file and the step
 * records live only while the run is live and are deleted when the run
 * ENDS (completed or aborted). The run report under .kstack/runs/ is the
 * durable record and must survive.
 */

const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));
const rm = (p: string) => rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

/** The dir holding ONE run's step records (.kstack/runs/<runId>/). */
const recordsDir = (cwd: string, runId: string) => path.join(cwd, ".kstack", "runs", runId);

/** The run report files (.kstack/runs/<timestamp>-<workflowId>.json). */
const reportFiles = (cwd: string) =>
  existsSync(path.join(cwd, ".kstack", "runs"))
    ? readdirSync(path.join(cwd, ".kstack", "runs")).filter((f) => f.endsWith(".json"))
    : [];

/** Minimal pi/ctx pair — the orchestrator only needs appendEntry + ui. */
function harness(cwd: string) {
  const entries: any[] = [];
  const notes: string[] = [];
  const pi: any = { appendEntry: (_t: string, d: any) => entries.push(d) };
  const ctx: any = {
    cwd,
    ui: {
      notify: (m: string) => notes.push(m),
      setStatus: () => {},
      select: async () => "Abort workflow",
      confirm: async () => true,
      input: async () => "",
    },
    sessionManager: { getEntries: () => entries },
  };
  return { pi, ctx, entries, notes };
}

/** Write one step record exactly where the reader looks for it. */
function writeRecord(cwd: string, runId: string, phaseId: string, stepId: string): string {
  const file = recordPathFor(cwd, runId, phaseId, stepId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      workflow: "develop",
      runId,
      phase: phaseId,
      step: stepId,
      summary: "step summary",
      verdicts: {},
      vars: {},
      evidence: [],
      deliverables: [],
      markers: [],
    }),
  );
  return file;
}

describe("per-run operational files die with the run", () => {
  test("a completed run's ledger file and step records are deleted; the run report survives", () => {
    const cwd = tmp("kstack-runcleanup-");
    try {
      const state: any = { ...createState("develop", "g") };
      appendLedger(cwd, state, { kind: "step", phaseId: "plan", stepId: "evolve", payload: { summary: "frontier settled" } });
      writeRecord(cwd, state.runId, "plan", "evolve");
      assert.ok(existsSync(ledgerPathFor(cwd, state)), "the live run has a ledger file");
      beginRun("develop"); // the report is the durable record of the run
      const h = harness(cwd);
      finalizeRun(h.pi, h.ctx, state);
      assert.equal(existsSync(ledgerPathFor(cwd, state)), false, "the run's ledger file dies with the run");
      assert.equal(existsSync(recordsDir(cwd, state.runId)), false, "the run's step records die with the run");
      assert.equal(reportFiles(cwd).length, 1, "the run report is the durable record — it must survive");
    } finally {
      resetTelemetry();
      rm(cwd);
    }
  });

  test("an aborted run's ledger file and step records are deleted too", async () => {
    const cwd = tmp("kstack-runcleanup-");
    try {
      const state: any = {
        ...createState("sprint", "g"),
        status: "paused",
        verdictPark: "qa-verdict",
        pausedReason: "verdict-unreadable:qa-verdict:artifact-mismatch",
      };
      appendLedger(cwd, state, { kind: "step", phaseId: "qa-verdict", stepId: "browse", payload: { summary: "looked" } });
      writeRecord(cwd, state.runId, "qa-verdict", "browse");
      const h = harness(cwd);
      // The park panel's "Abort workflow" — the shared abortWorkflow funnel.
      assert.equal(await handleSprintPanel(state, h.ctx, h.pi), true);
      assert.equal(existsSync(ledgerPathFor(cwd, state)), false, "the aborted run's ledger file dies with the run");
      assert.equal(existsSync(recordsDir(cwd, state.runId)), false, "the aborted run's step records die with the run");
    } finally {
      rm(cwd);
    }
  });

  test("a parked run keeps its ledger file and step records (a resume needs them)", async () => {
    const cwd = tmp("kstack-runcleanup-");
    const wf: Workflow = {
      id: "kstack-park-keep-test", name: "ParkKeep", description: "t",
      phases: [
        { id: "maybe", name: "Maybe", execution: "main", optional: true },
        { id: "tail", name: "Tail", execution: "main", optional: false },
      ],
    };
    getAllWorkflows().push(wf);
    try {
      const state: any = { ...createState("kstack-park-keep-test", "g"), phaseIndex: 0 };
      appendLedger(cwd, state, { kind: "step", phaseId: "maybe", stepId: "probe", payload: { summary: "x" } });
      writeRecord(cwd, state.runId, "maybe", "probe");
      const h = harness(cwd);
      await executeCurrentPhase(h.pi, h.ctx, state);
      const parked = h.entries.at(-1);
      assert.equal(parked?.status, "awaiting_approval", "the run is parked, not finished");
      assert.ok(existsSync(ledgerPathFor(cwd, state)), "a parked run keeps its ledger file");
      assert.ok(existsSync(recordsDir(cwd, state.runId)), "a parked run keeps its step records");
    } finally {
      const i = getAllWorkflows().indexOf(wf);
      if (i >= 0) getAllWorkflows().splice(i, 1);
      rm(cwd);
    }
  });

  test("the shared legacy 'adhoc' ledger lane is never deleted", () => {
    const cwd = tmp("kstack-runcleanup-");
    try {
      const state: any = { ...createState("develop", "g") };
      delete state.runId; // v≤3 / hand-built states share the "adhoc" lane
      appendLedger(cwd, state, { kind: "step", phaseId: "plan", stepId: "s1", payload: { summary: "x" } });
      cleanupRunArtifacts(cwd, state);
      assert.ok(existsSync(ledgerPathFor(cwd, state)), "the shared lane survives every run");
    } finally {
      rm(cwd);
    }
  });

  test("a symlinked .kstack/runs/<runId> pointing outside is never followed", () => {
    const cwd = tmp("kstack-runcleanup-");
    const outside = tmp("kstack-runcleanup-outside-");
    try {
      fs.mkdirSync(path.join(cwd, ".kstack", "runs"), { recursive: true });
      const link = path.join(cwd, ".kstack", "runs", "run-x");
      let linked = false;
      try {
        if (process.platform === "win32") symlinkSync(outside, link, "junction");
        else symlinkSync(outside, link, "dir");
        linked = true;
      } catch {
        /* Windows without symlink privileges refuses the probe — skip it */
      }
      if (!linked) return;
      writeFileSync(path.join(outside, "keep.txt"), "outside");
      const state: any = { ...createState("develop", "g"), runId: "run-x" };
      cleanupRunArtifacts(cwd, state);
      assert.ok(existsSync(path.join(outside, "keep.txt")), "nothing may be deleted through the symlink");
    } finally {
      rm(cwd);
      rm(outside);
    }
  });

  test("a symlinked ledger file is never unlinked (nor written through)", () => {
    const cwd = tmp("kstack-runcleanup-");
    const outside = tmp("kstack-runcleanup-outside-");
    try {
      const state: any = { ...createState("develop", "g") };
      const file = ledgerPathFor(cwd, state);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const target = path.join(outside, "keep.jsonl");
      writeFileSync(target, "outside");
      let linked = false;
      try {
        symlinkSync(target, file, "file");
        linked = true;
      } catch {
        /* Windows without symlink privileges refuses the probe — skip it */
      }
      if (!linked) return;
      cleanupRunArtifacts(cwd, state);
      assert.ok(existsSync(target), "the symlink target must survive");
    } finally {
      rm(cwd);
      rm(outside);
    }
  });
});
