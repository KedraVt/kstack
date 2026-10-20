/**
 * Per-run operational cleanup — the run's own files die with the run.
 *
 * The ledger file (`.kstack/ledger/<workflowId>-<runId>.jsonl`) and the
 * step records (`.kstack/runs/<runId>/`) are per-RUN operational data: they
 * exist only while the run is live and are deleted when the run reaches a
 * terminal status (completed via finalizeRun, aborted via abortWorkflow) —
 * exactly like the ephemeral artifacts.
 *
 * A PARKED run (paused / awaiting approval) KEEPS both: a resume needs its
 * records, and the ledger is the audit trail of the run so far.
 *
 * The durable record of a run is the run report
 * (`.kstack/runs/<timestamp>-<workflowId>.json`) — it is written BEFORE
 * this cleanup and does not depend on the deleted files.
 *
 * Safety: the same realpath-containment rule as appendLedger /
 * clearPhaseRecords — a symlink is never followed out of <cwd>/.kstack.
 * Never throws: a failure is notified (like the ephemeral cleanup) and the
 * run still ends.
 */

import { removeRunLedger } from "./ledger.ts";
import { removeRunRecords } from "./records.ts";
import type { WorkflowState } from "./types.ts";

/** What the cleanup managed to delete (false = nothing there / refused). */
export interface RunCleanupResult {
  ledger: boolean;
  records: boolean;
}

/**
 * Delete the run's ledger file and step-record dir. Never throws: every
 * failure is notified through onWarn and the run ends anyway.
 */
export function cleanupRunArtifacts(
  cwd: string,
  state: Pick<WorkflowState, "workflowId" | "runId">,
  onWarn?: (message: string) => void,
): RunCleanupResult {
  const warn = (m: string) => {
    try {
      onWarn?.(m);
    } catch {
      /* even the notify path is best-effort */
    }
  };
  const ledger = removeRunLedger(cwd, state, warn);
  // A state without a runId has no records dir (and shares the legacy
  // "adhoc" ledger lane) — nothing per-run to delete.
  const records = state.runId === undefined ? false : removeRunRecords(cwd, state.runId, warn);
  return { ledger, records };
}
