/**
 * Structured run-report telemetry (STEP 0 of the efficiency plan).
 *
 * At workflow end we persist `.kstack/runs/<ISO-timestamp>-<workflowId>.json`
 * with one entry per delegated step: durations, tool calls, turns and token
 * usage. All data already exists on SpawnResult — this module only accumulates
 * and persists it so baseline runs can be compared against post-fix runs
 * (minutes AND tokens, not wall-clock alone).
 *
 * Best-effort by design: a telemetry failure must never fail a workflow.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureOperationalDirsIgnored, ledgerPathFor, type LedgerEntry } from "./ledger.ts";

export interface RunReportStep {
  phaseId: string;
  /** Workflow-step id when this entry is a delegated WorkflowStep — phaseId stays the real phase. */
  stepId?: string;
  stepIndex: number;
  agent: string;
  durationMs: number;
  toolCalls?: number;
  turns?: number;
  tokensIn?: number;
  tokensCacheRead?: number;
  /** Tokens written to the prompt cache (the delegated side's cache creation). */
  tokensCacheCreation?: number;
  /**
   * The 1h-TTL part of the cache write. PROVIDER-CONDITIONAL: only some
   * providers report the split — the field is OMITTED when the child did not
   * report it, so an absent value is never read as "no 1h writes".
   */
  tokensCacheWrite1h?: number;
  tokensOut?: number;
  /** Populated from STEP 2 onward (extractHandoff level). */
  handoffLevel?: string;
  /** True when the step ended without a complete output (timeout/abort/error). */
  incomplete?: boolean;
  timedOut?: boolean;
  /** Timeout class resolved for the phase (STEP 5); "default" until then. */
  timeoutClass?: string;
  /** The pulse's verdict on the step (ADR-64) — the calibration evidence. */
  pulse?: PulseSummary;
}

/**
 * The pulse's verdict on one delegated step (ADR-64): how often the child
 * was checked, how long it went without making progress, and — when it
 * stopped — which signal fired. This is what the retro calibrates the
 * thresholds on, instead of the guesswork the quota needed.
 */
export interface PulseSummary {
  /** The number of pulse evaluations. */
  pulses: number;
  /** The longest gap without progress, in seconds. */
  maxGapSec: number;
  /** The turns the child made. */
  turns?: number;
  /** The signal that stopped the child (absent when it was fine). */
  trip?: string;
  /** The last actions of the child. */
  lastActions?: string[];
}

/**
 * One row per (phaseId, scope) of the run report. The two scopes are NEVER
 * mixed: the tool mask changes the MAIN session's prompt prefix only, so
 * averaging the scopes would hide exactly the effect the mask shows.
 */
export interface RunReportPhase {
  phaseId: string;
  scope: "main" | "delegated";
  tokensIn: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  /** cacheRead / (input + cacheRead + cacheWrite) — 0 when the denominator is 0. */
  cacheHitRate: number;
}

/** Why the main-scope rows are (not) in the report. */
export type MainScopeStatus = "ok" | "no-run-id" | "no-ledger";

export interface LivenessObservation {
  agent: string;
  gapSec: number;
  lastEvent: string;
  lastTool?: string;
}

export interface RunReport {
  workflowId: string;
  startedAt: string;
  writtenAt: string;
  steps: RunReportStep[];
  livenessObservations: LivenessObservation[];
  /** One row per (phaseId, scope) — the cache-hit-rate evidence (ADR-47). */
  phases?: RunReportPhase[];
  /** Why the main-scope rows are absent (or "ok" when they are there). */
  mainScopeStatus?: MainScopeStatus;
}

interface Accumulator {
  workflowId: string;
  startedAt: string;
  steps: RunReportStep[];
  liveness: LivenessObservation[];
  /** The pulse's verdict per step key ("<phaseId>.<stepId>") — ADR-64. */
  pulses: Map<string, PulseSummary>;
}

let current: Accumulator | null = null;

/** Start accumulating a new run report for a workflow. */
export function beginRun(workflowId: string): void {
  current = {
    workflowId,
    startedAt: new Date().toISOString(),
    steps: [],
    liveness: [],
    pulses: new Map(),
  };
  tokensUsedTotal = 0;
}

/** Start accumulating a new run report unless one is already active for this workflow. */
export function ensureRun(workflowId: string): void {
  if (!current || current.workflowId !== workflowId) beginRun(workflowId);
}

/** Record one delegated subagent step. No-op outside an active run. */
export function recordDelegatedStep(step: RunReportStep): void {
  if (!current) return;
  // Normalize so every persisted report carries the full stable key set.
  current.steps.push({
    phaseId: step.phaseId,
    stepId: step.stepId,
    stepIndex: step.stepIndex,
    agent: step.agent,
    durationMs: step.durationMs,
    toolCalls: step.toolCalls,
    turns: step.turns,
    tokensIn: step.tokensIn,
    tokensCacheRead: step.tokensCacheRead,
    tokensCacheCreation: step.tokensCacheCreation,
    tokensCacheWrite1h: step.tokensCacheWrite1h,
    tokensOut: step.tokensOut,
    handoffLevel: step.handoffLevel,
    incomplete: step.incomplete ?? false,
    timedOut: step.timedOut ?? false,
    timeoutClass: step.timeoutClass ?? "default",
    pulse: current.pulses.get(`${step.phaseId}.${step.stepId ?? ""}`),
  });
}

/**
 * Record the pulse's verdict on a step (ADR-64). The key is
 * "<phaseId>.<stepId>" — the row is merged into the step's report entry.
 */
export function recordPulseSummary(key: string, summary: PulseSummary): void {
  if (!current) return;
  current.pulses.set(key, summary);
}

/** Record an observe-only liveness event (STEP 5 wiring). */
export function recordLiveness(observation: LivenessObservation): void {
  if (!current) return;
  current.liveness.push(observation);
}

/** Build the report object for the active run (or a synthetic one in tests). */
export function buildRunReport(workflowId: string): RunReport {
  const acc = current && current.workflowId === workflowId
    ? current
    : { workflowId, startedAt: new Date().toISOString(), steps: [], liveness: [], pulses: new Map<string, PulseSummary>() };
  return {
    workflowId: acc.workflowId,
    startedAt: acc.startedAt,
    writtenAt: new Date().toISOString(),
    steps: [...acc.steps],
    livenessObservations: [...acc.liveness],
  };
}

/** Filesystem-safe timestamp: colons are illegal in Windows file names. */
export function runReportFileName(startedAt: string, workflowId: string): string {
  // Same allowlist as ledgerPathFor — workflowId reaches here via persisted
  // state (defense-in-depth; the workflow registry currently gates it).
  const safe = (v: string) => v.replace(/[^\w-]/g, "-");
  return `${startedAt.replace(/:/g, "-")}-${safe(workflowId)}.json`;
}

/** A counter that is never negative and never NaN. */
function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The cache hit-rate: `cacheRead / (input + cacheRead + cacheWrite)`, 0 when
 * the denominator is 0. The INPUT term is the input-only count on both
 * scopes (the main step's `tokensIn`, the child's `usage.input`).
 */
function hitRate(input: number, read: number, write: number): number {
  const denom = input + read + write;
  return denom === 0 ? 0 : read / denom;
}

/** The main-scope rows: the watched main steps of the run's ledger. */
function mainScopeRows(
  cwd: string,
  workflowId: string,
  runId: string | undefined,
): { rows: RunReportPhase[]; status: MainScopeStatus } {
  if (!runId) return { rows: [], status: "no-run-id" };
  const file = ledgerPathFor(cwd, { workflowId, runId });
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return { rows: [], status: "no-ledger" };
  }
  const acc = new Map<string, { tokensIn: number; read: number; write: number }>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: LedgerEntry;
    try {
      entry = JSON.parse(line) as LedgerEntry;
    } catch {
      continue;
    }
    if (entry.kind !== "step") continue;
    const payload = entry.payload ?? {};
    // A row without usage counters is not a watched step — it carries no
    // cache evidence and must not create an empty phase row.
    if (payload.tokensIn === undefined && payload.cacheRead === undefined && payload.cacheCreation === undefined) continue;
    const cur = acc.get(entry.phaseId) ?? { tokensIn: 0, read: 0, write: 0 };
    cur.tokensIn += num(payload.tokensIn);
    cur.read += num(payload.cacheRead);
    cur.write += num(payload.cacheCreation);
    acc.set(entry.phaseId, cur);
  }
  return {
    status: "ok",
    rows: [...acc.entries()].map(([phaseId, v]) => ({
      phaseId,
      scope: "main" as const,
      tokensIn: v.tokensIn,
      tokensCacheRead: v.read,
      tokensCacheCreation: v.write,
      cacheHitRate: hitRate(v.tokensIn, v.read, v.write),
    })),
  };
}

/** The delegated-scope rows: the children of the run. */
function delegatedScopeRows(steps: RunReportStep[]): RunReportPhase[] {
  const acc = new Map<string, { tokensIn: number; read: number; write: number }>();
  for (const step of steps) {
    const cur = acc.get(step.phaseId) ?? { tokensIn: 0, read: 0, write: 0 };
    cur.tokensIn += num(step.tokensIn);
    cur.read += num(step.tokensCacheRead);
    cur.write += num(step.tokensCacheCreation);
    acc.set(step.phaseId, cur);
  }
  return [...acc.entries()].map(([phaseId, v]) => ({
    phaseId,
    scope: "delegated" as const,
    tokensIn: v.tokensIn,
    tokensCacheRead: v.read,
    tokensCacheCreation: v.write,
    cacheHitRate: hitRate(v.tokensIn, v.read, v.write),
  }));
}

/**
 * Persist the accumulated report under <cwd>/.kstack/runs/. Never throws:
 * returns the written path on success, null on any failure.
 *
 * `runId` makes the MAIN-scope rows computable: they are read from the run's
 * ledger file, which dies with the run — so the report must be written
 * BEFORE the run's ephemerals are cleaned up (both call sites do).
 */
export function writeRunReport(cwd: string, workflowId: string, runId?: string): string | null {
  try {
    if (!current || current.workflowId !== workflowId) return null;
    const report = buildRunReport(workflowId);
    const main = mainScopeRows(cwd, workflowId, runId);
    report.phases = [...main.rows, ...delegatedScopeRows(report.steps)];
    report.mainScopeStatus = main.status;
    const dir = path.join(cwd, ".kstack", "runs");
    fs.mkdirSync(dir, { recursive: true });
    ensureOperationalDirsIgnored(cwd);
    // Same symlink-plant containment as appendLedger: a hostile .kstack/runs
    // symlink must not turn the write into file creation outside the repo.
    const rel = path.relative(fs.realpathSync(cwd), fs.realpathSync(dir));
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const filePath = path.join(dir, runReportFileName(report.startedAt, workflowId));
    // File-level containment: the dir realpath does not cover a symlink at
    // the filename itself (lstat catches dangling links too).
    let lst: fs.Stats | null = null;
    try {
      lst = fs.lstatSync(filePath);
    } catch {
      /* ENOENT — new file, fine */
    }
    if (lst?.isSymbolicLink()) return null;
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8");
    current = null;
    tokensUsedTotal = 0;
    return filePath;
  } catch {
    return null;
  }
}

/** Test helper: drop any in-flight accumulator. */
export function resetTelemetry(): void {
  current = null;
}

// --- Token budget circuit-breaker (STEP 5c) ----------------------------------

let tokensUsedTotal = 0;

/** Accumulate token usage (input + cacheRead + output) for the active run. */
export function recordTokens(n: number): void {
  tokensUsedTotal += n;
}

/** Cumulative tokens used since the last beginRun/flush. */
export function totalTokensUsed(): number {
  return tokensUsedTotal;
}
