/**
 * The verdict VALUE leaf (TASK_12 / ADR-34, ADR-52).
 *
 * Two channels validate a verdict value and they must agree:
 *
 *  1. the WRITE-time channel — `kstack-report` refuses a value that is not
 *     in the `KSTACK_VERDICT_VALUES` list the orchestrator published
 *     (`stepSpawnEnv`, `repair.ts`);
 *  2. the READ-time channel — `evaluateStepRecordTrust` decides whether a
 *     written record may route.
 *
 * Before this module the two computed their lists separately: the CLI's
 * list came from `verdictValuesFor` (+ the phase's park/loop values) while
 * the repair used the GLOBAL `NEGATIVE_VALUES` set. A step that was told
 * "rejected is not accepted" could still write it and have it accepted.
 *
 * This module is the SINGLE source of both lists. It is a LEAF: it imports
 * only from `verdicts.ts` (the expectation map) and `types.ts`, so the
 * module graph stays acyclic — `templates.ts` and `repair.ts` import it,
 * it imports neither of them.
 *
 * The router (`state.ts`) keeps its own `NEGATIVE_VALUES`: it ROUTES a
 * verdict, it does not ACCEPT one. Acceptance is this module's business.
 */

import { expectationsFor, NEGATIVE_VALUES } from "./verdicts.ts";
import type { WorkflowPhase } from "./types.ts";

/**
 * The positive values each routing negative answers. A negative is
 * routable for a key only when it answers one of that key's expected
 * positives: `approved`→`rejected`, `green`→`red|orange`, `pass`→`fail`,
 * `success`→`failed`, `verified`→`persists|refuted`.
 */
const NEGATIVE_FOR: Record<string, string[]> = {
  rejected: ["approved"],
  failed: ["success"],
  red: ["green"],
  orange: ["green"],
  fail: ["pass"],
  persists: ["verified"],
  refuted: ["verified"],
};

/** The phase fields the accepted-value map reads. */
export type VerdictValuePhase = Pick<WorkflowPhase, "id" | "parkOn" | "loopBackOn">;

/**
 * Routable values for ONE verdict key: the phase's expected positives plus
 * the routing negatives that answer them.
 *
 * The optional expectation form (`severity?`) resolves to the same list as
 * its bare form — the `?` marks the var OPTIONAL (a legitimately skipped
 * step emits nothing), it does not widen the vocabulary.
 */
export function verdictValuesFor(workflowId: string, phaseId: string, key: string): string[] {
  const exp = expectationsFor(workflowId, phaseId) ?? {};
  const allowed = exp[key] ?? exp[`${key}?`] ?? [];
  const negs = [...NEGATIVE_VALUES].filter((n) => NEGATIVE_FOR[n]?.some((pos) => allowed.includes(pos)));
  return [...allowed, ...negs];
}

/**
 * The values a verdict key may carry in this phase.
 *
 * The phase's declared park/loop values (e.g. the severities that freeze
 * the sprint) belong to the MODIFIER keys (`severity`), never to the step's
 * own signal — so they are added only for the keys the step does NOT own
 * as its declared signal.
 */
export function acceptedVerdictValues(
  workflowId: string,
  phase: VerdictValuePhase,
  key: string,
  signalKey?: string,
): string[] {
  const allowed = [...new Set(verdictValuesFor(workflowId, phase.id, key))];
  if (key === signalKey) return allowed;
  for (const v of Object.keys(phase.parkOn ?? {})) if (!allowed.includes(v)) allowed.push(v);
  for (const v of Object.keys(phase.loopBackOn ?? {})) if (!allowed.includes(v)) allowed.push(v);
  return allowed;
}
