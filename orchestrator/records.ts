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
import { expectationsFor, NEGATIVE_VALUES } from "./verdicts.ts";
import { artifactSignalFiles, runStartMs } from "./artifacts.ts";

/**
 * Absolute path of the kstack-report CLI this extension ships — carried into
 * delegated-step spawn env (KSTACK_REPORT) and interpolated into step tasks
 * as {kstack_report} (ADR-23: spawn→work→report→exit).
 */
export function reportCliPath(): string {
  const base = fileURLToPath(new URL("../runtime/bin/kstack-report", import.meta.url));
  // Forward slashes: agents paste this path into bash, which eats backslashes
  // ("C:Users...: command not found" ⇒ no record ⇒ signal-missing loop).
  const cli = process.platform === "win32" && fs.existsSync(`${base}.cmd`) ? `${base}.cmd` : base;
  return cli.replace(/\\/g, "/");
}

/**
 * Gate verdict keys a step OWNS (KSTACK_VERDICT_KEYS / record contract):
 * a non-flagged step owns none; a flagged step owns its declared signal
 * plus phase expectation vars no other flagged step declares (e.g.
 * `severity` beside security-review). Everything else is dropped.
 */
/** Shared keys bound to one signal: severity qualifies a security rejection, never a code review. */
const SHARED_KEY_OWNER: Record<string, string> = { severity: "security-review" };

export function verdictKeysFor(workflowId: string, phase: Pick<WorkflowPhase, "id" | "steps">, step: WorkflowStep): string[] {
  if (step.signal?.kind !== "verdict") return [];
  const otherSignals = new Set(
    (phase.steps ?? []).filter((s) => s.id !== step.id && s.signal?.kind === "verdict").map((s) => s.signal!.value),
  );
  const shared = Object.keys(expectationsFor(workflowId, phase.id) ?? {})
    .map((k) => k.replace(/\?$/, ""))
    .filter((k) => k !== step.signal!.value && !otherSignals.has(k))
    .filter((k) => !SHARED_KEY_OWNER[k] || SHARED_KEY_OWNER[k] === step.signal!.value);
  return [step.signal.value, ...shared];
}

/** "Approved." / " PASS " ⇒ "approved" / "pass" — same rule as kstack-report. */
const normVerdict = (v: string): string => v.trim().toLowerCase().replace(/[\s.,;:!]+$/, "");

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
    verdicts: Object.fromEntries(Object.entries(strMap(r.verdicts)).map(([k, v]) => [k, normVerdict(v)])),
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
 * Verdicts a step does not own (verdictKeysFor) never park: they are
 * stripped from the returned record and named in `dropped` so the caller
 * can ledger-note them — a step is never blocked for doing its work.
 */
export type StepCompletionStatus =
  | { kind: "ok"; record: StepRecord | null; vars: Record<string, string>; dropped: string[] }
  | { kind: "signal-missing"; want: string };

/**
 * Check the CURRENT step at kstack_advance time. The completion contract
 * (types.ts `signal`):
 * - verdict → a readable record carries `verdicts[signal.value]`;
 * - marker → a readable record carries marker `signal.value`;
 * - artifact → the file at `signal.value` (repo-relative) exists;
 * - absent → vacuously satisfied (legacy ghost-step path).
 * ANY record written by this step is read for routing vars; verdict keys the
 * step does not own are stripped (never routed, never parked).
 */
export function stepCompletionStatus(
  state: Pick<WorkflowState, "workflowId" | "runId">,
  phase: Pick<WorkflowPhase, "id" | "steps">,
  step: WorkflowStep,
  cwd: string,
): StepCompletionStatus {
  let record = state.runId !== undefined
    ? readStepRecord(cwd, state.workflowId, state.runId, phase.id, step.id)
    : null;
  const dropped: string[] = [];
  if (record) {
    const owned = new Set(verdictKeysFor(state.workflowId, phase, step));
    const kept: Record<string, string> = {};
    for (const [k, v] of Object.entries(record.verdicts)) {
      if (owned.has(k)) kept[k] = v;
      else dropped.push(`${k}==${v}`);
    }
    record = { ...record, verdicts: kept };
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
        if (artifactSignalFiles(cwd, want, runStartMs(state.runId)).length === 0) return { kind: "signal-missing", want };
        break;
    }
  }
  return { kind: "ok", record, vars: record?.vars ?? {}, dropped };
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
    const owned = new Set(verdictKeysFor(workflowId, phase, step));
    for (const [k, v] of Object.entries(rec.verdicts)) {
      if (!owned.has(k)) continue; // not this step's verdict — never routes
      if (verdicts[k] !== undefined && verdicts[k] !== v) {
        return { parsed: null, cause: "no-verdict", excerpt: `contradiction on '${k}'`, vars };
      }
      verdicts[k] = v;
    }
    Object.assign(vars, rec.vars);
  }
  return { parsed: { verdicts }, excerpt: excerpts.join("\n").slice(0, 2000), vars };
}

/**
 * Retry feedback from a gate phase's own records — under the S4 verifier rule
 * findings ride `--evidence`, never repo files, so the legacy artifact scan
 * (buildRetryFeedback) comes back empty. Only flagged steps that emitted a
 * NEGATIVE verdict contribute: a passing lane's evidence is not a blocker.
 */
export function phaseRecordFeedback(
  phase: Pick<WorkflowPhase, "id" | "steps">,
  cwd: string,
  workflowId: string,
  runId: string | undefined,
  results?: WorkflowState["results"],
): string {
  if (runId === undefined) return "";
  const parts: string[] = [];
  for (const step of phase.steps ?? []) {
    if (step.signal?.kind !== "verdict" || results?.[`${phase.id}.${step.id}`]?.status === "skipped") continue;
    const rec = readStepRecord(cwd, workflowId, runId, phase.id, step.id);
    const negatives = Object.entries(rec?.verdicts ?? {}).filter(([, v]) => NEGATIVE_VALUES.has(v));
    if (!rec || negatives.length === 0) continue;
    parts.push(
      [
        `From ${phase.id}.${step.id} (${negatives.map(([k, v]) => `${k}==${v}`).join(", ")}):`,
        ...(rec.summary ? [rec.summary] : []),
        ...rec.evidence.map((e) => `- ${e}`),
      ].join("\n"),
    );
  }
  const joined = parts.join("\n\n");
  return joined.length > 4000 ? `${joined.slice(0, 4000)}…(truncated)` : joined;
}

/**
 * Delete a phase's step records before the phase re-runs from its first step
 * (loop-back, unfreeze, gate re-issue). A stale record would otherwise
 * satisfy the re-run's signal check and re-route the previous attempt's
 * verdict. The ledger keeps the history (append-only). Symlinked run dirs are
 * refused — same containment rule as the ledger.
 */
export function clearPhaseRecords(cwd: string, runId: string, phaseId: string): void {
  try {
    const dir = path.join(cwd, ".kstack", "runs", safe(runId));
    if (!fs.existsSync(dir)) return;
    const rel = path.relative(fs.realpathSync(cwd), fs.realpathSync(dir));
    if (rel.startsWith("..") || path.isAbsolute(rel)) return;
    const prefix = `${safe(phaseId)}.`;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(prefix) && f.endsWith(".json")) fs.unlinkSync(path.join(dir, f));
    }
  } catch {
    /* best-effort — a surviving record degrades to the pre-fix behavior */
  }
}

/**
 * Write a canonical step record file (.kstack/runs/<runId>/<phase>[.<step>].json).
 */
export function writeStepRecord(
  cwd: string,
  record: {
    workflow: string;
    runId: string;
    phase: string;
    step?: string | null;
    summary: string;
    markers?: string[];
    verdicts?: Record<string, string>;
    vars?: Record<string, string>;
    evidence?: string[];
    deliverables?: string[];
  },
): string {
  const dir = path.join(cwd, ".kstack", "runs", safe(record.runId));
  fs.mkdirSync(dir, { recursive: true });
  const file = record.step ? `${safe(record.phase)}.${safe(record.step)}.json` : `${safe(record.phase)}.json`;
  const target = path.join(dir, file);
  const data = {
    v: 1,
    workflow: safe(record.workflow),
    runId: safe(record.runId),
    phase: safe(record.phase),
    step: record.step ? safe(record.step) : null,
    at: new Date().toISOString(),
    summary: record.summary,
    verdicts: record.verdicts ?? {},
    vars: record.vars ?? {},
    evidence: record.evidence ?? [],
    deliverables: record.deliverables ?? [],
    markers: record.markers ?? [],
  };
  fs.writeFileSync(target, JSON.stringify(data, null, 2), "utf-8");
  return target;
}

