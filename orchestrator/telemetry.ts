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

export interface RunReportStep {
  phaseId: string;
  stepIndex: number;
  agent: string;
  durationMs: number;
  toolCalls?: number;
  turns?: number;
  tokensIn?: number;
  tokensCacheRead?: number;
  tokensOut?: number;
  /** Populated from STEP 2 onward (extractHandoff level). */
  handoffLevel?: string;
  /** True when the step ended without a complete output (timeout/abort/error). */
  incomplete?: boolean;
  timedOut?: boolean;
  /** Timeout class resolved for the phase (STEP 5); "default" until then. */
  timeoutClass?: string;
}

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
}

interface Accumulator {
  workflowId: string;
  startedAt: string;
  steps: RunReportStep[];
  liveness: LivenessObservation[];
}

let current: Accumulator | null = null;

/** Start accumulating a new run report for a workflow. */
export function beginRun(workflowId: string): void {
  current = {
    workflowId,
    startedAt: new Date().toISOString(),
    steps: [],
    liveness: [],
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
    stepIndex: step.stepIndex,
    agent: step.agent,
    durationMs: step.durationMs,
    toolCalls: step.toolCalls,
    turns: step.turns,
    tokensIn: step.tokensIn,
    tokensCacheRead: step.tokensCacheRead,
    tokensOut: step.tokensOut,
    handoffLevel: step.handoffLevel,
    incomplete: step.incomplete ?? false,
    timedOut: step.timedOut ?? false,
    timeoutClass: step.timeoutClass ?? "default",
  });
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
    : { workflowId, startedAt: new Date().toISOString(), steps: [], liveness: [] };
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
  return `${startedAt.replace(/:/g, "-")}-${workflowId}.json`;
}

/**
 * Persist the accumulated report under <cwd>/.kstack/runs/. Never throws:
 * returns the written path on success, null on any failure.
 */
export function writeRunReport(cwd: string, workflowId: string): string | null {
  try {
    if (!current || current.workflowId !== workflowId) return null;
    const report = buildRunReport(workflowId);
    const dir = path.join(cwd, ".kstack", "runs");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, runReportFileName(report.startedAt, workflowId));
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
