/**
 * S3 / D28 — append-only ledger.
 *
 * One JSONL file per workflow run at `.kstack/ledger/<workflowId>-<runId>.jsonl`
 * in the target repo cwd. Invariants:
 * - INV-L1: append-only — there is NO update/delete path in this module.
 * - INV-L2: summaries/verdicts land verbatim — never summarized, never capped.
 * - INV-L3: writes are synchronous appends; a failure degrades to a notify via
 *   the optional onError callback and NEVER blocks the state machine.
 * - Write-only for routing: the state machine never reads the ledger.
 *   `readLedger` exists for tests and human inspection only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowState } from "./types.ts";
import { safeAppendDetailed } from "./safe-append.ts";

/**
 * `.kstack/ledger/` and `.kstack/runs/` hold verbatim model-influenced
 * summaries and verdicts — operational data that must never reach repo
 * history via a routine `git add -A`. Bootstraps the two ignore lines into
 * the target repo's `.gitignore` (creating it when absent). `plans/`,
 * `sprints/` and `qa-*` under `.kstack/` stay committable — they are the
 * intentional artifacts. Best-effort: a failure here never blocks a write.
 */
export function ensureOperationalDirsIgnored(cwd: string): void {
  try {
    const gi = path.join(cwd, ".gitignore");
    const existing = fs.existsSync(gi) ? fs.readFileSync(gi, "utf-8") : "";
    const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    // .taste-skill/ = the design skill's working files when run outside a kstack step.
    const missing = [".kstack/ledger/", ".kstack/runs/", ".taste-skill/"].filter((l) => !have.has(l));
    if (!missing.length) return;
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(gi, `${prefix}# kstack operational dirs (session data — never commit)\n${missing.join("\n")}\n`, "utf-8");
  } catch {
    /* best-effort — the sinks still work without it */
  }
}

export interface LedgerEntry {
  /** ISO-8601 write timestamp. */
  at: string;
  /**
   * S4: "report" = a kstack-report step record (the delegation completion
   * protocol — canonical source for verdicts and routing vars).
   */
  kind: "step" | "phase" | "verdict" | "gate" | "report" | "run-interrupted" | "quota-parked";
  workflowId: string;
  phaseId: string;
  stepId?: string;
  attempt?: number;
  payload: {
    /** Step/phase summary — verbatim. */
    summary?: string;
    /** Parsed verdict variables — verbatim. */
    verdicts?: Record<string, string>;
    /** S4 routing vars emitted via `kstack-report --var`. */
    vars?: Record<string, string>;
    /** S4: relative path of the full step record under .kstack/runs/. */
    record?: string;
    gateId?: string;
    decision?: "auto" | "human" | "skip" | "run" | "abort" | "return";
    /** Phase artifact paths relative to the repo cwd. */
    artifacts?: string[];
    /** Watched-step usage accumulated while the step ran (D28). */
    tokens?: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
}

type LedgerState = Pick<WorkflowState, "workflowId" | "runId" | "attempts">;

/**
 * `.kstack/ledger/<workflowId>-<runId>.jsonl`. runId is persisted on the
 * state at creation so restarts/resumes append to the SAME file; v≤3 states
 * (and hand-built test states) fall back to the "adhoc" lane — still
 * append-only, just shared per workflow.
 */
export function ledgerPathFor(cwd: string, state: LedgerState): string {
  // Allowlist-sanitize BOTH filename segments: word chars + hyphen only.
  // workflowId/runId can arrive through unvalidated session state — a `/`,
  // `\` or `..` surviving here is a path-traversal sink outside
  // .kstack/ledger/ (security review, S3 pass-2).
  const safe = (v: string) => v.replace(/[^\w-]/g, "-");
  const runId = safe(state.runId ?? "adhoc");
  return path.join(cwd, ".kstack", "ledger", `${safe(state.workflowId)}-${runId}.jsonl`);
}

/** The ledger's file name — the leaf `safeAppend` writes into. */
function ledgerFileName(state: LedgerState): string {
  return path.basename(ledgerPathFor("", state));
}

/**
 * Synchronously append one entry. `.kstack/ledger/` is created on first
 * write. Returns true on success; on ANY failure calls onError once and
 * returns false — the caller's control flow continues unchanged (INV-L3).
 */
export function appendLedger(
  cwd: string,
  state: LedgerState,
  entry: Omit<LedgerEntry, "at" | "workflowId"> & { attempt?: number },
  onError?: (message: string) => void,
): boolean {
  try {
    ensureOperationalDirsIgnored(cwd);
    const full: LedgerEntry = { at: new Date().toISOString(), workflowId: state.workflowId, ...entry };
    // TASK_13 (ADR-38): the containment (realpath inside the repo + symlink
    // refusal) now lives in the shared `safeAppend` helper — the same
    // helper the taint store uses, so a new writer cannot be less careful
    // than the ledger. Behaviour is unchanged: false on any failure, the
    // caller continues, and the error surfaces once through onError.
    const res = safeAppendDetailed(cwd, path.join(".kstack", "ledger"), ledgerFileName(state), JSON.stringify(full) + "\n");
    if (!res.ok) throw new Error(`ledger append refused: ${res.reason ?? "containment or write failure"}`);
    return true;
  } catch (err: any) {
    try {
      onError?.(`kstack: ledger append failed (${err?.code ?? err?.message ?? "unknown"}) — continuing without it`);
    } catch {
      /* even the notify path is best-effort */
    }
    return false;
  }
}

/**
 * Delete THIS run's ledger file at a terminal run status. The ledger is
 * per-RUN operational data: it lives only while the run is live and dies
 * with it (the durable record of a run is the run report under
 * `.kstack/runs/`). INV-L1 governs the WRITE side — while the run lives the
 * file is still append-only.
 *
 * The shared legacy "adhoc" lane (a state without a runId) is NEVER
 * deleted: it is shared by every legacy run.
 *
 * Containment mirrors appendLedger: a ledger dir that resolves outside
 * <cwd> is refused, and a symlink at the file is never followed (nor
 * unlinked — it is not our file). Never throws: a failure is reported
 * through onWarn and the run still ends.
 */
export function removeRunLedger(
  cwd: string,
  state: LedgerState,
  onWarn?: (message: string) => void,
): boolean {
  try {
    const file = ledgerPathFor(cwd, state);
    // The shared legacy lane (no runId → "<workflow>-adhoc.jsonl") is not
    // this run's file — it must survive every run.
    if (file === ledgerPathFor(cwd, { ...state, runId: undefined })) return false;
    let lst: fs.Stats | null = null;
    try {
      lst = fs.lstatSync(file);
    } catch {
      return false; // ENOENT — nothing to delete
    }
    if (lst.isSymbolicLink()) {
      onWarn?.(`kstack: refusing to delete the symlinked ledger file "${path.basename(file)}"`);
      return false;
    }
    if (!lst.isFile()) return false;
    const dir = path.dirname(file);
    const rel = path.relative(fs.realpathSync(cwd), fs.realpathSync(dir));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      onWarn?.(`kstack: refusing to delete the ledger file outside the repo cwd`);
      return false;
    }
    fs.unlinkSync(file);
    return true;
  } catch (err: any) {
    try {
      onWarn?.(`kstack: ledger cleanup failed (${err?.code ?? err?.message ?? "unknown"}) — continuing`);
    } catch {
      /* even the notify path is best-effort */
    }
    return false;
  }
}

/** Inspection/test reader — never consulted by the state machine. */
export function readLedger(cwd: string, state: LedgerState): LedgerEntry[] {
  try {
    const file = ledgerPathFor(cwd, state);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as LedgerEntry);
  } catch {
    return [];
  }
}
