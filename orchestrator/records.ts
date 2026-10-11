/**
 * S4 / ADR-1 — canonical step records.
 *
 * `runtime/bin/kstack-report` writes `.kstack/runs/<runId>/<phase>[.<step>].json`
 * and appends a matching `report` ledger event. This module is the READER:
 * the ONLY code path allowed to turn a record into a phase verdict (INV-9).
 *
 * SECURITY: records are UNTRUSTED INPUT — a repo or subagent can plant a
 * file anywhere under .kstack/runs/. Guards (mirror ledger.ts / verdicts.ts):
 *  1. filename segments are allowlist-sanitized exactly like the writer
 *     (word chars + dot + hyphen) — `..` can never escape the runs dir;
 *  2. the record's identity fields (v, workflow, runId, phase, step) must
 *     match the step being read — a mislabeled file is not a record;
 *  3. verdict/var VALUES must be strings — non-strings are dropped;
 *  4. a phase merges ONLY records of its verdict-FLAGGED steps — records of
 *     non-flagged steps are never even opened, so gate variables can never
 *     smuggle in through an unflagged step;
 *  5. any missing/unparseable/mismatched/contradictory input ⇒ null ⇒ the
 *     caller parks WITHOUT burning an attempt.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedVerdict, VerdictParkCause, WorkflowPhase, WorkflowState, WorkflowStep } from "./types.ts";

/**
 * Absolute path of the kstack-report CLI this extension ships — carried into
 * delegated-step spawn env (KSTACK_REPORT) and interpolated into step tasks
 * as {kstack_report} (ADR-23: spawn→work→report→exit).
 */
export function reportCliPath(): string {
  return fileURLToPath(new URL("../runtime/bin/kstack-report", import.meta.url));
}

/** Same allowlist as the kstack-report writer and ledgerPathFor (+ dot). */
const safe = (v: string): string => v.replace(/[^\w.-]/g, "-");

/** `.kstack/runs/<runId>/<phase>[.<step>].json` — never trusts raw segments. */
export function recordPathFor(cwd: string, runId: string, phaseId: string, stepId?: string): string {
  const file = stepId ? `${safe(phaseId)}.${safe(stepId)}.json` : `${safe(phaseId)}.json`;
  return path.join(cwd, ".kstack", "runs", safe(runId), file);
}

/** One kstack-report record file — the canonical delegated-step completion proof. */
export interface StepRecord {
  workflow: string;
  runId: string;
  phase: string;
  step: string | null;
  summary: string | null;
  verdicts: Record<string, string>;
  vars: Record<string, string>;
  evidence: string[];
  deliverables: string[];
  markers: string[];
}

const strMap = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
};

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Load and validate the record file for one step. Returns null when absent,
 * unparseable, or identity-mismatched — callers treat null as "no record",
 * never "empty record".
 */
export function readStepRecord(
  cwd: string,
  workflowId: string,
  runId: string,
  phaseId: string,
  stepId?: string,
): StepRecord | null {
  let raw: unknown;
  try {
    const file = recordPathFor(cwd, runId, phaseId, stepId);
    if (!fs.existsSync(file)) return null;
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
  const r = raw as Record<string, unknown> | null;
  // Identity fields are compared against the SANITIZED forms — the writer
  // stores $SAFE_RUN / $SAFE_PHASE / $SAFE_STEP in both filename and body,
  // so the raw state values (e.g. ISO runIds containing ':') never match.
  if (
    !r ||
    r.v !== 1 ||
    r.workflow !== safe(workflowId) ||
    r.runId !== safe(runId) ||
    r.phase !== safe(phaseId) ||
    (r.step ?? null) !== (stepId !== undefined ? safe(stepId) : null)
  ) {
    return null;
  }
  return {
    workflow: r.workflow as string,
    runId: r.runId as string,
    phase: r.phase as string,
    step: (r.step ?? null) as string | null,
    summary: typeof r.summary === "string" ? r.summary : null,
    verdicts: strMap(r.verdicts),
    vars: strMap(r.vars),
    evidence: strArr(r.evidence),
    deliverables: strArr(r.deliverables),
    markers: strArr(r.markers),
  };
}

// --- Per-step completion checks (TASK_02) -------------------------------------

/**
 * Outcome of checking a completing step's declared signal + record:
 * - `ok` (optionally carrying the step's record + its routing vars),
 * - `signal-missing` — the declared signal was never observed ⇒ the caller
 *   re-issues the step in resumeMode, no advance (TASK_02 unhappy path),
 * - `foreign-verdict` — a NON verdict-flagged step's record carried gate
 *   variables ⇒ park, only flagged records may carry them.
 */
export type StepCompletionStatus =
  | { kind: "ok"; record: StepRecord | null; vars: Record<string, string> }
  | { kind: "signal-missing"; want: string }
  | { kind: "foreign-verdict" };

/**
 * Check the CURRENT step at kstack_advance time. The completion contract
 * (types.ts `signal`):
 * - verdict → a readable record carries `verdicts[signal.value]`;
 * - marker → a readable record carries marker `signal.value`;
 * - artifact → the file at `signal.value` (repo-relative) exists;
 * - absent → vacuously satisfied (legacy ghost-step path).
 * ANY record written by this step is read for routing vars; a record on a
 * non-flagged step carrying verdicts is a foreign-verdict violation.
 */
export function stepCompletionStatus(
  state: Pick<WorkflowState, "workflowId" | "runId">,
  phase: Pick<WorkflowPhase, "id">,
  step: WorkflowStep,
  cwd: string,
): StepCompletionStatus {
  const record = state.runId !== undefined
    ? readStepRecord(cwd, state.workflowId, state.runId, phase.id, step.id)
    : null;
  const flagged = step.signal?.kind === "verdict";
  if (record && !flagged && Object.keys(record.verdicts).length > 0) {
    return { kind: "foreign-verdict" };
  }
  if (step.signal) {
    const want = step.signal.value;
    switch (step.signal.kind) {
      case "verdict":
        if (!record || record.verdicts[want] === undefined) return { kind: "signal-missing", want };
        break;
      case "marker":
        if (!record || !record.markers.includes(want)) return { kind: "signal-missing", want };
        break;
      case "artifact":
        if (!fs.existsSync(path.join(cwd, want))) return { kind: "signal-missing", want };
        break;
    }
  }
  return { kind: "ok", record, vars: record?.vars ?? {} };
}

/** Result of merging a phase's verdict-flagged step records (INV-9). */
export interface PhaseVerdictMerge {
  /** Merged expectation-validated-later verdict map; null ⇒ park. */
  parsed: ParsedVerdict | null;
  /** Cause for the D4 park when parsed is null. */
  cause?: VerdictParkCause;
  /** Record summaries for the D4 panel excerpt. */
  excerpt: string;
  /** Routing vars carried by the flagged records — land in state.vars. */
  vars: Record<string, string>;
}

/**
 * Merge the verdict-flagged step records of a phase into the phase verdict
 * (INV-9: the ONLY channel that may produce one under the step model).
 *
 * - Every flagged step must carry a readable record containing its declared
 *   `signal.value` var — a missing record or a missing declared var ⇒ null
 *   (the completion signal was never observed).
 * - Two flagged records disagreeing on the same var ⇒ null (cross-step
 *   contradiction mirrors mergeParseOutcomes semantics).
 * - `severity` stays an ordinary verdict var in the record channel —
 *   routeVerdict's parkOn declares the freeze outcome for it.
 * - Foreign verdicts cannot smuggle: only flagged-step records are read.
 */
export function mergePhaseVerdicts(
  phase: WorkflowPhase,
  cwd: string,
  workflowId: string,
  runId: string | undefined,
  results?: WorkflowState["results"],
): PhaseVerdictMerge {
  // Legitimately-skipped flagged steps (skipWhen / requires) own no record —
  // requiring one would park every run that took a declared skip branch.
  const flagged = (phase.steps ?? []).filter(
    (s) => s.signal?.kind === "verdict" && results?.[`${phase.id}.${s.id}`]?.status !== "skipped",
  );
  if (flagged.length === 0 || runId === undefined) {
    return { parsed: null, cause: "no-verdict", excerpt: "", vars: {} };
  }
  const verdicts: Record<string, string> = {};
  const vars: Record<string, string> = {};
  const excerpts: string[] = [];

  for (const step of flagged) {
    const rec = readStepRecord(cwd, workflowId, runId, phase.id, step.id);
    if (!rec) {
      return { parsed: null, cause: "no-verdict", excerpt: `no record for ${phase.id}.${step.id}`, vars };
    }
    if (rec.summary) excerpts.push(`[${step.id}] ${rec.summary}`);
    const want = step.signal!.value;
    if (rec.verdicts[want] === undefined) {
      return { parsed: null, cause: "no-verdict", excerpt: `${phase.id}.${step.id} record missing '${want}'`, vars };
    }
    for (const [k, v] of Object.entries(rec.verdicts)) {
      if (verdicts[k] !== undefined && verdicts[k] !== v) {
        return { parsed: null, cause: "no-verdict", excerpt: `contradiction on '${k}'`, vars };
      }
      verdicts[k] = v;
    }
    Object.assign(vars, rec.vars);
  }
  return { parsed: { verdicts }, excerpt: excerpts.join("\n").slice(0, 2000), vars };
}
