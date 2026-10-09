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
    const missing = [".kstack/ledger/", ".kstack/runs/"].filter((l) => !have.has(l));
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
  kind: "step" | "phase" | "verdict" | "gate";
  workflowId: string;
  phaseId: string;
  stepId?: string;
  attempt?: number;
  payload: {
    /** Step/phase summary — verbatim. */
    summary?: string;
    /** Parsed verdict variables — verbatim. */
    verdicts?: Record<string, string>;
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
    const file = ledgerPathFor(cwd, state);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    ensureOperationalDirsIgnored(cwd);
    // Symlink-plant containment (S3 security review): a repo shipping
    // .kstack/ledger as a symlink must not turn appends into file creation
    // in an attacker-chosen directory. Fail-soft via onError — INV-L3 holds.
    const rel = path.relative(fs.realpathSync(cwd), fs.realpathSync(dir));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("ledger dir resolves outside the repo cwd");
    }
    // File-level containment too: realpath covers the DIRECTORY only — a
    // planted `<wf>-adhoc.jsonl` symlink (predictable name on v≤3/hand-built
    // state resumes) would redirect the append outside the repo. lstatSync
    // (not existsSync — it follows links) also catches dangling links.
    let lst: fs.Stats | null = null;
    try {
      lst = fs.lstatSync(file);
    } catch {
      /* ENOENT — new file, fine */
    }
    if (lst?.isSymbolicLink()) throw new Error("ledger path is a symlink");
    const full: LedgerEntry = { at: new Date().toISOString(), workflowId: state.workflowId, ...entry };
    fs.appendFileSync(file, JSON.stringify(full) + "\n", "utf-8");
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
