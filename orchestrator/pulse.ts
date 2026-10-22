/**
 * S5a hotfix / ADR-64 — the PULSE: the orchestrator's periodic sanity check
 * on a delegated subagent.
 *
 * WHY THIS EXISTS: the step budgets (ADR-31) were a QUOTA — they counted the
 * work and cut the step off when the count crossed a line. The line was
 * drawn on ONE run's calibration, and it punished exactly the work that
 * mattered (a real implementation needs more turns than a line drawn on a
 * scout's reading run). Worse, the cycle it produced never converged: a trip
 * parked the run, the resume re-dispatched the SAME step from zero, and the
 * fresh attempt burned the same quota again — the human repeated the
 * implementation phase ~20 times before the work landed.
 *
 * The pulse replaces the quota with a LIVENESS question: is the child still
 * working the task, or has it stopped / veered off? Three signals, all read
 * from the child's OWN event stream — NOTHING inspects what the child
 * produced (that is the child's business; the orchestrator watches the
 * trajectory, not the artefacts):
 *
 *   stalled       — no PROGRESS for the configured window. A progress tick is
 *                   a tool call whose (tool, args) key is new, or an assistant
 *                   message whose text differs from the previous one. Working
 *                   for three hours is legitimate; standing still for fifteen
 *                   minutes is not.
 *   lexical-drift — the child's recent words stopped sharing the brief's
 *                   words WHILE the previous window still did. The COLLAPSE
 *                   is the signal: an absolute absence would punish a terse
 *                   child that is doing its job.
 *   scope-drift   — the child wrote a file OUTSIDE the repository it was
 *                   given. Off-task by construction. The OS temp dir is
 *                   allowed (test fixtures live there).
 *
 * The loop rules of stuck.ts (identical action, alternating, error streak,
 * monologue, context errors) stay as they are: they are the "is it going
 * crazy" check. The pulse adds the "is it still on the task" check.
 */

import * as os from "node:os";
import * as path from "node:path";
import { tokens } from "./taint.ts";
import type { StepWatchEvent } from "./stuck.ts";

export type PulseSignal = "stalled" | "lexical-drift" | "scope-drift";

export interface PulseLimits {
  /** No progress for this long → the child is stalled. */
  noProgressMs: number;
  /** The assistant messages per drift window. */
  driftWindow: number;
  /** The shared-term count that must collapse to ZERO. */
  driftTerms: number;
  /** The minimum words in the current window before the drift measure counts. */
  driftMinWords: number;
  /** The drift measure runs every N events, not on every event. */
  driftEveryEvents: number;
}

export interface PulseTrip {
  signal: PulseSignal;
  /** The human-readable diagnosis — one line, no jargon. */
  reason: string;
  /** The corrective instruction handed to the next attempt. */
  recovery: string;
  /** The last actions of the child, for the diagnosis. */
  lastActions: string[];
}

export interface PulseState {
  startedAtMs: number;
  /** The last time the child did something NEW. */
  lastProgressAtMs: number;
  lastEventAtMs: number;
  events: number;
  turns: number;
  /** The number of pulse evaluations — the run report's "how often was the
   * child actually checked" number. */
  pulses: number;
  /** The longest gap between two progress ticks. */
  maxGapMs: number;
  /** The brief's content words — the drift yardstick. */
  briefTerms: string[];
  /** The rolling window: one word-set per assistant message. */
  windows: string[][];
  lastMessage: string | null;
  /** The recent (tool, args) keys — the progress detector's memory. */
  seenKeys: string[];
  /** The last N actions, for the diagnosis. */
  lastActions: string[];
  /** The repository the child may write in. */
  repoRoot: string;
  /** The roots a write may touch besides the repository. */
  extraRoots: string[];
  /** The trip, once one fires. */
  trip?: PulseTrip;
}

/**
 * The English stop words — the brief's *distinctive* words are what the
 * drift measure looks at. Short and generic words carry no signal.
 */
const STOPWORDS = new Set([
  "about", "above", "after", "again", "against", "also", "and", "any", "are",
  "because", "been", "before", "being", "below", "between", "both", "but",
  "can", "could", "does", "doing", "done", "down", "during", "each", "even",
  "every", "from", "further", "have", "having", "here", "into", "itself",
  "just", "like", "made", "make", "many", "more", "most", "much", "must",
  "need", "needs", "only", "other", "our", "out", "over", "same", "shall",
  "should", "some", "such", "than", "that", "their", "them", "then", "there",
  "these", "they", "this", "those", "through", "under", "until", "very",
  "was", "were", "what", "when", "where", "which", "while", "will", "with",
  "would", "your", "yours", "does", "done", "each", "here", "just", "like",
  "step", "steps", "task", "tasks", "file", "files", "code", "test", "tests",
  "work", "works", "must", "also", "into", "use", "using", "used",
]);

/** The tools that WRITE — the scope check looks only at these. */
const WRITE_TOOLS = new Set([
  "write", "edit", "multi_edit", "multiedit", "apply_patch", "str_replace",
  "notebookedit", "create_file", "write_file",
]);

/** The content words of a text: tokens, minus the stop words and the short ones. */
function contentWords(text: string): string[] {
  return tokens(text).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

function stableKey(value: unknown): string {
  try {
    const s = JSON.stringify(value ?? null);
    return s.length > 300 ? s.slice(0, 300) : s;
  } catch {
    return "[unserializable]";
  }
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === "string" ? c : (c?.text ?? ""))).join(" ");
  }
  return "";
}

/** The path an edit/write tool targets, when it names one. */
function argPath(args: any): string | null {
  if (!args || typeof args !== "object") return null;
  for (const key of ["path", "file_path", "filePath", "file", "target"]) {
    const v = (args as any)[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/** Is the path inside one of the allowed roots? */
function insideRoots(target: string, roots: string[]): boolean {
  const resolved = path.resolve(target);
  return roots.some((root) => {
    if (!root) return false;
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  });
}

/**
 * A new pulse for one delegated step. The `brief` is the step's task text —
 * the yardstick the drift measure compares the child's words against.
 */
export function newPulse(
  brief: string,
  opts?: { repoRoot?: string; now?: number },
): PulseState {
  const now = opts?.now ?? Date.now();
  return {
    startedAtMs: now,
    lastProgressAtMs: now,
    lastEventAtMs: now,
    events: 0,
    turns: 0,
    pulses: 0,
    maxGapMs: 0,
    briefTerms: [...new Set(contentWords(brief ?? ""))],
    windows: [],
    lastMessage: null,
    seenKeys: [],
    lastActions: [],
    repoRoot: opts?.repoRoot ? path.resolve(opts.repoRoot) : "",
    extraRoots: [os.tmpdir()],
  };
}

/** A progress tick: the child did something NEW. */
function tick(pulse: PulseState, now: number): void {
  pulse.maxGapMs = Math.max(pulse.maxGapMs, now - pulse.lastProgressAtMs);
  pulse.lastProgressAtMs = now;
}

/**
 * Feed one child event into the pulse. Cheap: it only updates counters. The
 * SCOPE drift is detected here (the write's path is known only here); the
 * stall and the lexical drift are evaluated by `evaluatePulse`.
 */
export function feedPulseEvent(pulse: PulseState, event: StepWatchEvent, now = Date.now()): void {
  if (!event || typeof event.type !== "string") return;
  pulse.events++;
  pulse.lastEventAtMs = now;
  if (event.type === "tool_execution_start") {
    const tool = String(event.toolName ?? event.name ?? "tool");
    const key = `${tool}:${stableKey(event.args ?? event.input)}`;
    if (!pulse.seenKeys.includes(key)) {
      pulse.seenKeys.push(key);
      if (pulse.seenKeys.length > 64) pulse.seenKeys.shift();
      tick(pulse, now);
    }
    pulse.lastActions.push(tool);
    if (pulse.lastActions.length > 8) pulse.lastActions.shift();
    if (!pulse.trip && WRITE_TOOLS.has(tool) && pulse.repoRoot) {
      const target = argPath(event.args ?? event.input);
      if (target && !insideRoots(target, [pulse.repoRoot, ...pulse.extraRoots])) {
        pulse.trip = {
          signal: "scope-drift",
          reason: `the child wrote outside the repository it was given (${target})`,
          recovery: "work only inside the repository; do not write outside it",
          lastActions: [...pulse.lastActions],
        };
      }
    }
    return;
  }
  if (event.type === "message_end") {
    const message = (event as any).message;
    if (message?.role !== "assistant") return;
    pulse.turns++;
    const text = messageText(message);
    if (text !== pulse.lastMessage) {
      pulse.lastMessage = text;
      tick(pulse, now);
    }
    pulse.windows.push(contentWords(text));
    if (pulse.windows.length > 32) pulse.windows.shift();
  }
}

/** Is this event a pulse point? The drift measure runs every N events. */
export function pulseDue(pulse: PulseState, limits: PulseLimits): boolean {
  return pulse.events > 0 && pulse.events % Math.max(1, limits.driftEveryEvents) === 0;
}

/** The brief terms that appear in the given words. */
function overlap(briefTerms: string[], words: string[]): number {
  const set = new Set(words);
  let n = 0;
  for (const term of briefTerms) if (set.has(term)) n++;
  return n;
}

/**
 * Evaluate the pulse. Returns the trip, or null when the child is fine.
 * The evaluation is idempotent: once a trip fired, it is returned as is.
 */
export function evaluatePulse(
  pulse: PulseState,
  limits: PulseLimits,
  now = Date.now(),
): PulseTrip | null {
  pulse.pulses++;
  if (pulse.trip) return pulse.trip;
  // 1. STALLED — no progress for the window.
  const gap = now - pulse.lastProgressAtMs;
  if (gap > limits.noProgressMs) {
    const last = pulse.lastActions.at(-1);
    const trip: PulseTrip = {
      signal: "stalled",
      reason: `no progress for ${Math.round(gap / 1000)}s${last ? ` (last action: ${last})` : ""}`,
      recovery: "state what is left to do and do the next concrete step",
      lastActions: [...pulse.lastActions],
    };
    pulse.trip = trip;
    return trip;
  }
  // 2. LEXICAL DRIFT — the shared terms COLLAPSED.
  const w = Math.max(1, limits.driftWindow);
  if (pulse.windows.length >= 2 * w) {
    const current = pulse.windows.slice(-w).flat();
    const previous = pulse.windows.slice(-2 * w, -w).flat();
    if (current.length >= limits.driftMinWords) {
      const now0 = overlap(pulse.briefTerms, current);
      const before = overlap(pulse.briefTerms, previous);
      if (now0 === 0 && before >= limits.driftTerms) {
        const trip: PulseTrip = {
          signal: "lexical-drift",
          reason: `the child's last ${w} messages share none of the task's terms (they shared ${before} before)`,
          recovery: "come back to the task: restate the next concrete step of the brief",
          lastActions: [...pulse.lastActions],
        };
        pulse.trip = trip;
        return trip;
      }
    }
  }
  return null;
}

/** The `pausedReason` fragment of a pulse trip. */
export function pulsePausedReason(trip: PulseTrip, phaseId: string, stepId: string): string {
  return `pulse:${trip.signal}:${phaseId}.${stepId}`;
}

/** The one-line diagnosis the human reads. */
export function pulseDiagnosis(trip: PulseTrip): string {
  return `${trip.signal} — ${trip.reason}`;
}

/**
 * The corrective brief handed to the NEXT attempt of the step. Its whole
 * point: the child must NOT restart the work — the repository already holds
 * what the previous attempt completed.
 */
export function pulseRecoveryBrief(trip: PulseTrip, phaseId: string, stepId: string): string {
  const actions = trip.lastActions.length ? trip.lastActions.join(" → ") : "none recorded";
  return [
    `## RECOVERY (${phaseId}.${stepId}) — the orchestrator stopped the previous attempt`,
    `The previous attempt was interrupted by the orchestrator's pulse: ${trip.signal} — ${trip.reason}.`,
    "",
    "Do NOT start the work over: the repository already holds whatever the previous attempt completed.",
    "Read the current state of the repository first, then continue with the next concrete action of the task.",
    `Last actions of the previous attempt: ${actions}.`,
    `What to do next: ${trip.recovery}.`,
  ].join("\n");
}
