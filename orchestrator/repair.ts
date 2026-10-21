/**
 * Verdict-record REPAIR — the automatic fix for an untrustworthy step record.
 *
 * A verdict-bearing step's record is the ONLY channel that may produce a
 * phase verdict (INV-9). When that record cannot be trusted — a security
 * rejection without a severity, a value off the phase's expectation map, a
 * record that never landed — the run parks and the human is asked to decide.
 *
 * The repair closes the loop WITHOUT redoing the work: the SAME agent that
 * produced the step is re-invoked with a short task that fixes the RECORD
 * only ("do not redo the review — re-run the record command"). The old
 * record is the repair's INPUT and is never deleted.
 *
 * A repair is accepted only when the record file really changed (its mtime
 * moved): a repair that did not touch the record left the STALE record in
 * place, and the stale record must never be mistaken for a repaired one.
 */

import * as fs from "node:fs";
import type { VerdictParkCause, WorkflowPhase, WorkflowStep } from "./types.ts";
import { expectationsFor } from "./verdicts.ts";
import { readStepRecord, recordPathFor, reportCliPath, projectRootFor, verdictKeysFor, type StepRecord } from "./records.ts";
import { buildRecordContract } from "./templates.ts";
import { acceptedVerdictValues } from "./verdict-values.ts";
import { phaseArtifactPaths } from "./artifacts.ts";
import { runSubagent, type SpawnRequest } from "./spawn.ts";

/** The state key of one step's repair attempt: `${phaseId}.${stepId}`. */
export function repairKey(phaseId: string, stepId: string): string {
  return `${phaseId}.${stepId}`;
}

/** Verdict of the "can this record be trusted?" check. */
export interface RecordTrust {
  /** The record can be trusted for routing. */
  ok: boolean;
  /** The park cause the defect maps to. */
  cause?: VerdictParkCause;
  /** Human-readable description of what is wrong with the record. */
  defect?: string;
  /** A record rewrite can fix it (a broken expectation map cannot). */
  repairable: boolean;
}

const TRUSTY: RecordTrust = { ok: true, repairable: false };

/**
 * Can this step's record be trusted for routing?
 *
 * The check is the record-channel mirror of routeVerdict's fail-closed
 * rules, scoped to ONE step:
 * - no expectation map for (workflow, phase) ⇒ misconfigured gate — a
 *   record rewrite cannot fix it (never defaulted, ADR-7);
 * - no record, or a record without the step's declared verdict ⇒ the
 *   completion signal was never observed (repairable: the agent writes it);
 * - a verdict value that is neither an expected positive, a routing
 *   negative, nor a declared park/loop value ⇒ unroutable (repairable);
 * - a security rejection without a severity ⇒ the D3 ambiguity: not a
 *   verdict, a park (repairable: the agent adds the severity it reported).
 */
export function evaluateStepRecordTrust(
  workflowId: string,
  phase: WorkflowPhase,
  step: WorkflowStep,
  record: StepRecord | null,
): RecordTrust {
  if (step.signal?.kind !== "verdict") return TRUSTY;
  const expectations = expectationsFor(workflowId, phase.id);
  if (!expectations) {
    return {
      ok: false,
      cause: "no-expectation",
      repairable: false,
      defect: `no expectation map for ${workflowId}.${phase.id} — the gate is misconfigured`,
    };
  }
  const want = step.signal.value;
  if (!record) {
    return { ok: false, cause: "no-verdict", repairable: true, defect: `no step record for ${phase.id}.${step.id}` };
  }
  const owned = new Set(verdictKeysFor(workflowId, phase, step));
  for (const [key, value] of Object.entries(record.verdicts)) {
    // A verdict the step does NOT own is dropped by the merge too — it
    // never routes and never parks.
    if (!owned.has(key)) continue;
    const rawKey = expectations[key] !== undefined ? key : expectations[`${key}?`] !== undefined ? `${key}?` : undefined;
    if (rawKey === undefined) {
      return {
        ok: false,
        cause: "foreign-verdict",
        repairable: false,
        defect: `'${key}' is not on the ${phase.id} expectation map`,
      };
    }
    // TASK_12 (ADR-34, ADR-52): the record channel accepts a value IFF the
    // CLI accepts it — the SAME list. The old rule (the global
    // NEGATIVE_VALUES set) accepted values the write-time channel had
    // already refused, so a step could be told "rejected is not accepted"
    // and still have its record trusted.
    const routable = acceptedVerdictValues(workflowId, phase, key, step.signal?.value).includes(value);
    if (!routable) {
      return {
        ok: false,
        cause: "unroutable",
        repairable: true,
        defect: `'${key}==${value}' is not routable (accepted: ${acceptedVerdictValues(workflowId, phase, key, step.signal?.value).join(" | ")})`,
      };
    }
  }
  if (record.verdicts[want] === undefined) {
    return {
      ok: false,
      cause: "no-verdict",
      repairable: true,
      defect: `the record carries no '${want}' verdict`,
    };
  }
  // D3 ambiguity: a security rejection without a severity is not a verdict —
  // the phase cannot route it (fail-closed park).
  if (owned.has("security-review") && record.verdicts["security-review"] === "rejected" && record.verdicts["severity"] === undefined) {
    return {
      ok: false,
      cause: "no-verdict",
      repairable: true,
      defect: "the security rejection carries no 'severity' verdict",
    };
  }
  return TRUSTY;
}

/**
 * The values a verdict key may carry in this phase: the expectation
 * positives plus the routing negatives that answer them. The phase's
 * declared park/loop values (e.g. the severities that freeze the sprint)
 * belong to the MODIFIER keys (severity), never to the step's own signal —
 * they are added for those keys only.
 *
 * TASK_12: the function moved to the `verdict-values.ts` leaf; it is
 * re-exported here so the historical import path keeps working.
 */
export { acceptedVerdictValues } from "./verdict-values.ts";

/** The artifacts a step may have written (its declared artifact signal + the phase's artifacts). */
export function stepArtifactPaths(phase: WorkflowPhase, step: WorkflowStep, cwd: string, sprintNumber?: number): string[] {
  const out = new Set<string>();
  if (step.signal?.kind === "artifact") out.add(step.signal.value);
  for (const p of phaseArtifactPaths(phase.id, cwd, sprintNumber)) out.add(p);
  return [...out];
}

/** The spawn env of a step's delegated child — the repair runs with the SAME env. */
export function stepSpawnEnv(
  workflowId: string,
  runId: string | undefined,
  phase: WorkflowPhase,
  step: WorkflowStep,
  cwd: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const owned = verdictKeysFor(workflowId, phase, step);
  return {
    KSTACK_WORKFLOW: workflowId,
    KSTACK_RUN_ID: runId ?? "",
    KSTACK_PHASE: phase.id,
    KSTACK_STEP: step.id,
    KSTACK_REPORT: reportCliPath(),
    // The project that owns .kstack/ — the record must land where the
    // orchestrator reads it, whatever cwd the child ends up in.
    KSTACK_PROJECT_ROOT: projectRootFor(cwd),
    KSTACK_VERDICT_KEYS: owned.join(" "),
    // The accepted values of every key this step OWNS ("key=v1,v2 …"):
    // kstack-report validates a verdict against this map at WRITE time, so
    // an off-map value fails the step now instead of parking the phase later.
    KSTACK_VERDICT_VALUES: owned
      .map((key) => `${key}=${acceptedVerdictValues(workflowId, phase, key, step.signal?.value).join(",")}`)
      .join(" "),
    // The step's declared signal verdict — a record without it is
    // signal-missing and the phase re-issues the step.
    KSTACK_VERDICT_REQUIRED: step.signal?.kind === "verdict" ? step.signal.value : "",
    ...(extra ?? {}),
  };
}

/** Everything the repair needs to know about the step whose record is broken. */
export interface RepairSpec {
  workflowId: string;
  runId?: string;
  phase: WorkflowPhase;
  step: WorkflowStep;
  cwd: string;
  /** The step's own agent — the repair runs as the SAME agent/model. */
  agent: string;
  /** The step's spawn env (run/phase/step ids, report CLI, project root, verdict keys). */
  env: Record<string, string>;
  timeoutMs?: number;
  modelOverride?: string;
  /** Why the record is untrustworthy. */
  cause: VerdictParkCause;
  /** What exactly is wrong with the record. */
  defect: string;
  /** Verdict lines / report excerpt shown to the repairing agent. */
  excerpt?: string;
  /**
   * The step's OWN report (its HANDOFF) — the work it already did. A
   * repair agent is a fresh process: without the report it would have to
   * redo the review (or guess a verdict). Bounded excerpt.
   */
  report?: string;
  /** Artifacts the step produced. */
  artifactPaths?: string[];
  /** Abort signal (the session was reloaded). */
  shouldAbort?: () => boolean;
}

/** mtime of a record file — undefined when it does not exist. */
function recordMtime(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** The record's raw content (bounded) — the repair agent's input. */
function recordContent(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8").slice(0, 4000);
  } catch {
    return "(no record file)";
  }
}

/**
 * The repair task: what is wrong, the record as it stands, the artifact the
 * step produced and the EXACT record command to re-run. It never asks for
 * the work to be redone.
 */
export function buildRepairTask(spec: RepairSpec): string {
  // Forward slashes: the repairing agent reads the path with bash, which
  // eats backslashes ("C:Users..." ⇒ no such file).
  const file = spec.runId
    ? recordPathFor(spec.cwd, spec.runId, spec.phase.id, spec.step.id).replace(/\\/g, "/")
    : "(no run id)";
  const owned = verdictKeysFor(spec.workflowId, spec.phase, spec.step);
  const values = owned.map((k) => `- ${k}: ${acceptedVerdictValues(spec.workflowId, spec.phase, k, spec.step.signal?.value).join(" | ")}`);
  const artifacts = spec.artifactPaths?.length ? spec.artifactPaths : ["(no artifact file — your --evidence lines are the source of truth)"];
  return `## RECORD REPAIR (your step record cannot be trusted)
The workflow cannot route this phase because the step record you wrote is untrustworthy.

- Park cause: ${spec.cause}
- What is wrong: ${spec.defect}
${spec.excerpt ? `- Verdict lines found: ${spec.excerpt.slice(0, 500)}\n` : ""}
## YOUR CURRENT RECORD (do NOT delete it — it is the repair's input)
Path: ${file}
\`\`\`json
${recordContent(file)}
\`\`\`

## THE ARTIFACT YOU WROTE
${artifacts.map((a) => `- ${a}`).join("\n")}
${spec.report ? `\n## YOUR STEP REPORT (the work you already did — do NOT redo it)\n${spec.report.slice(0, 4000)}\n` : ""}
## ACCEPTED VERDICT VALUES
${values.join("\n")}

## WHAT TO DO
Fix ONLY your step record so it matches your artifact; do not redo the review.
Re-run the record command below — it OVERWRITES the record in place (do not
delete the record first: the orchestrator needs the old one as the repair's
input, and a record that was not rewritten counts as a FAILED repair).

${buildRecordContract(spec.step, { workflowId: spec.workflowId, phase: spec.phase, cwd: spec.cwd })}`;
}

/** Outcome of one repair attempt. */
export interface RepairOutcome {
  /** The record was really rewritten (and is therefore readable again). */
  ok: boolean;
  /** Why the repair failed. */
  reason?: string;
  /** The repairing agent's output (diagnostics only). */
  output?: string;
}

/**
 * Run the repair: the step's own agent rewrites its record, then the record
 * file is checked for a real change. A repair that left the record untouched
 * FAILED — the stale record is never accepted as a repaired one.
 */
export async function runRecordRepair(
  spec: RepairSpec,
  spawnFn: typeof runSubagent = runSubagent,
): Promise<RepairOutcome> {
  if (!spec.runId) {
    return { ok: false, reason: "this run has no runId — there is no record file to repair" };
  }
  const file = recordPathFor(spec.cwd, spec.runId, spec.phase.id, spec.step.id);
  const before = recordMtime(file);
  const beforeContent = before === undefined ? undefined : recordContent(file);
  const req: SpawnRequest = {
    agent: spec.agent,
    task: buildRepairTask(spec),
    cwd: spec.cwd,
    env: spec.env,
    phaseId: spec.phase.id,
    ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.modelOverride ? { modelOverride: spec.modelOverride } : {}),
    ...(spec.shouldAbort ? { shouldAbort: spec.shouldAbort } : {}),
  };
  const result = await spawnFn(req);
  if (!result.ok) {
    return { ok: false, reason: `the repairing agent failed: ${result.error ?? "unknown error"}`, output: result.output };
  }
  const after = recordMtime(file);
  if (after === undefined) {
    return { ok: false, reason: "the repairing agent left no record behind", output: result.output };
  }
  if (before === undefined) return { ok: true, output: result.output };
  if (after > before) return { ok: true, output: result.output };
  // Coarse filesystem timestamps can hide a rewrite that did happen — the
  // CONTENT is the second witness. An untouched record has both.
  if (beforeContent !== undefined && recordContent(file) !== beforeContent) {
    return { ok: true, output: result.output };
  }
  return { ok: false, reason: "the record was not rewritten (timestamp unchanged) — the stale record is not accepted", output: result.output };
}

/** Read the step's record (null when the run has no record channel). */
export function stepRecordFor(
  cwd: string,
  workflowId: string,
  runId: string | undefined,
  phase: WorkflowPhase,
  step: WorkflowStep,
): StepRecord | null {
  if (!runId) return null;
  return readStepRecord(cwd, workflowId, runId, phase.id, step.id);
}
