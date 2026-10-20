/**
 * S3 / D28 — stuck detector + per-step budgets.
 *
 * `StepRun` is a TRANSIENT per-step accumulator — never persisted, discarded
 * when the step completes. `feedStepEvent` accepts both main-session pi events
 * (`tool_execution_start`/`tool_execution_end`/`message_end`) and spawned-child
 * JSON stream events (same shapes plus `auto_retry_start`/`tool_result_end`).
 * Events that don't arrive (legacy sessions, older pi) simply leave counters
 * at zero — the detector is inert, never falsely tripping.
 *
 * Five rules (OpenHands):
 *   identical-action   — same action+observation ≥4 consecutive times
 *   action-errors      — ≥3 consecutive tool errors
 *   monologue          — ≥3 consecutive assistant messages without a tool call
 *   alternating        — action keys alternating A,B,A,B,A,B (≥6)
 *   context-errors     — ≥3 context-window/provider context errors
 *
 * Budgets are multi-dimensional (turns/tokens/context/usd/ms/usdPerMin): a dim
 * at ≥80% soft-warns ONCE; at ≥100% it trips. A trip means PARK, never a
 * silent kill — the caller persists `paused` + `pausedReason`.
 *
 * Two token dims, deliberately disjoint:
 *   tokens  — SPEND: sum over turns of (input + output). pi's Usage fields are
 *             disjoint (input EXCLUDES cache), and every turn re-reports the
 *             whole prompt as cacheRead/cacheWrite — counting those here would
 *             grow the counter quadratically and trip the cap after 3-4 turns.
 *   context — PEAK single-turn prompt: max over turns of
 *             (input + cacheRead + cacheWrite) — the real context pressure.
 */

import { numberEnv, timeoutClassFor, type TimeoutClass } from "./config.ts";

export type StuckRule =
  | "identical-action"
  | "action-errors"
  | "monologue"
  | "alternating"
  | "context-errors";

export interface StepRun {
  startedAtMs: number;
  turns: number;
  toolCalls: number;
  /** SPEND — sum over turns of (input + output). Cache tokens are NOT counted. */
  tokens: number;
  /** PEAK single-turn prompt size — max over turns of (input + cacheRead + cacheWrite). */
  contextTokens: number;
  /** Cache-hit and cache-write tokens — the D28 byte-stable-prefix measure. */
  cacheRead: number;
  cacheWrite: number;
  /** Fed only when an event carries cost data — no feed ⇒ the dim stays inert. */
  costUsd: number;
  /** Digest of the last action+observation pair. */
  lastPairKey: string | null;
  samePairStreak: number;
  /** Action key of the in-flight tool call, awaiting its observation. */
  pendingActionKey: string | null;
  consecutiveErrors: number;
  monologueStreak: number;
  /** Recent action keys, capped — alternating-pair detection. */
  actionWindow: string[];
  contextErrors: number;
  /** Budget dims already soft-warned (warn fires once per dim per step-run). */
  warnedDims: Set<string>;
}

export function newStepRun(startedAtMs = Date.now()): StepRun {
  return {
    startedAtMs,
    turns: 0,
    toolCalls: 0,
    tokens: 0,
    contextTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    lastPairKey: null,
    samePairStreak: 0,
    pendingActionKey: null,
    consecutiveErrors: 0,
    monologueStreak: 0,
    actionWindow: [],
    contextErrors: 0,
    warnedDims: new Set(),
  };
}

// --- event digestion ---------------------------------------------------------

function stableKey(value: unknown): string {
  try {
    const s = JSON.stringify(value ?? null);
    return s.length > 400 ? s.slice(0, 400) : s;
  } catch {
    return "[unserializable]";
  }
}

function observationKey(event: any): string {
  const content = event?.result?.content ?? event?.content ?? event?.result ?? "";
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content.map((c: any) => (typeof c === "string" ? c : (c?.text ?? ""))).join(" ");
  } else text = stableKey(content);
  return `${event?.isError === true ? "E" : "ok"}:${text.slice(0, 400)}`;
}

const CONTEXT_ERROR_RE = /context.{0,24}(length|window|limit|tokens|overflow)|maximum context|context.{0,12}exceed|too (long|large|many tokens)|prompt is too long/i;

function isContextErrorText(text: string): boolean {
  return CONTEXT_ERROR_RE.test(text);
}

/** Turn SPEND — pi's `input` EXCLUDES the cached prompt part. */
function usageSpend(u: any): number {
  if (!u) return 0;
  const n = (v: any) => Number(v ?? 0) || 0;
  return n(u.input ?? u.inputTokens) + n(u.output ?? u.outputTokens);
}

/** Single-turn PROMPT size — the fresh input plus the cached prompt prefix. */
function usageContext(u: any): number {
  if (!u) return 0;
  const n = (v: any) => Number(v ?? 0) || 0;
  return (
    n(u.input ?? u.inputTokens) +
    n(u.cacheRead ?? u.cacheReadTokens) +
    n(u.cacheWrite ?? u.cacheWriteTokens)
  );
}

function usageCost(u: any): number {
  if (!u) return 0;
  // pi's Usage.cost is an object ({ input, output, cacheRead, cacheWrite,
  // total }) — Number({...}) is NaN, which silently zeroed the usd/usdPerMin
  // dims (S3 pass-5 review). Read .total; keep scalar fallbacks for other
  // event shapes (child JSONL re-serializations).
  if (typeof u.cost === "number") return u.cost;
  return Number(u.cost?.total ?? u.costUSD ?? u.costUsd ?? 0) || 0;
}

/**
 * The subset of fields feedStepEvent reads across the two streams it taps
 * (pi session events + child JSONL). `type` selects the counter path; every
 * other field is read defensively per branch. pi's typed ToolExecution* /
 * MessageEndEvent objects satisfy this shape structurally.
 */
export interface StepWatchEvent {
  type?: string;
  toolName?: string;
  name?: string;
  args?: unknown;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
  error?: unknown;
  errorMessage?: string;
  message?: { role?: string; content?: unknown; usage?: any; stopReason?: string };
}

/**
 * Feed one event into the step-run counters. Tolerant by construction: any
 * event shape it doesn't recognize is ignored, so wiring it to heterogeneous
 * streams (main session vs child JSON) is safe.
 */
export function feedStepEvent(run: StepRun, event: StepWatchEvent): void {
  if (!event || typeof event.type !== "string") return;
  switch (event.type) {
    case "tool_execution_start": {
      run.toolCalls++;
      run.monologueStreak = 0;
      const key = `${event.toolName ?? event.name ?? "tool"}:${stableKey(event.args ?? event.input)}`;
      run.pendingActionKey = key;
      run.actionWindow.push(key);
      if (run.actionWindow.length > 8) run.actionWindow.shift();
      return;
    }
    case "tool_execution_end":
    case "tool_result_end": {
      const obs = observationKey(event);
      const pair = `${run.pendingActionKey ?? "?"}=>${obs}`;
      run.samePairStreak = pair === run.lastPairKey ? run.samePairStreak + 1 : 1;
      run.lastPairKey = pair;
      run.pendingActionKey = null;
      if (event.isError === true || event.error != null) {
        run.consecutiveErrors++;
        // Context-error phrases count only on error-flagged results — a step
        // reading docs that merely discuss context windows (this repo's own
        // docs do) must not impersonate a provider context failure.
        if (isContextErrorText(obs)) run.contextErrors++;
      } else {
        run.consecutiveErrors = 0;
      }
      return;
    }
    case "auto_retry_start": {
      if (typeof event.errorMessage === "string" && isContextErrorText(event.errorMessage)) {
        run.contextErrors++;
      }
      return;
    }
    case "message_end": {
      const msg = event.message;
      // Non-assistant message_end (user reply, tool result) IS environment
      // feedback — it breaks a monologue streak. Counting only assistant
      // turns while ignoring user replies false-fires the rule on exactly
      // the pattern interactive steps are built for (Q&A interview rounds).
      // Delegated step streams carry no user messages — unaffected.
      if (msg?.role !== "assistant") {
        run.monologueStreak = 0;
        return;
      }
      run.turns++;
      run.monologueStreak++;
      // SPEND counts the fresh input+output only; the cached prompt prefix is
      // re-reported every turn and would inflate the total quadratically.
      run.tokens += usageSpend(msg.usage);
      const promptSize = usageContext(msg.usage);
      if (promptSize > run.contextTokens) run.contextTokens = promptSize;
      run.cacheRead += Number(msg.usage?.cacheRead ?? msg.usage?.cacheReadTokens ?? 0) || 0;
      run.cacheWrite += Number(msg.usage?.cacheWrite ?? msg.usage?.cacheWriteTokens ?? 0) || 0;
      run.costUsd += usageCost(msg.usage);
      if (msg.stopReason === "error" && isContextErrorText(stableKey(msg.content))) {
        run.contextErrors++;
      }
      return;
    }
  }
}

/** Evaluate the five rules. Returns the first tripped rule, or null. */
export function detectStuck(run: StepRun): StuckRule | null {
  if (run.samePairStreak >= 4) return "identical-action";
  if (run.consecutiveErrors >= 3) return "action-errors";
  if (run.monologueStreak >= 3) return "monologue";
  const w = run.actionWindow;
  if (w.length >= 6) {
    const t = w.slice(-6);
    if (t[0] === t[2] && t[2] === t[4] && t[1] === t[3] && t[3] === t[5] && t[0] !== t[1]) {
      return "alternating";
    }
  }
  if (run.contextErrors >= 3) return "context-errors";
  return null;
}

// --- budgets -----------------------------------------------------------------

export interface StepBudgets {
  turns: number;
  /** SPEND cap (input + output across the step's turns). */
  tokens: number;
  /** PEAK single-turn prompt cap (input + cacheRead + cacheWrite). */
  context: number;
  usd: number;
  ms: number;
  usdPerMin: number;
}

function limit(v: number | "off"): number {
  return v === "off" ? Number.POSITIVE_INFINITY : v;
}

/**
 * Per-timeout-class SPEND caps. A class's steps do more work than a generic
 * one (WORK implements, VERIFY reviews), so the generic 250k cap tripped
 * healthy steps. An unmapped phase id falls back to the generic default.
 */
const CLASS_TOKEN_LIMITS: Record<TimeoutClass, number> = {
  EXPLORE: 400_000,
  WORK: 600_000,
  VERIFY: 300_000,
};

const DEFAULT_TOKEN_LIMIT = 250_000;
/** Peak-prompt cap — the same for every class (context pressure is uniform). */
const DEFAULT_CONTEXT_LIMIT = 180_000;

/**
 * Env-resolved per-step budget limits. Unset envs → conservative defaults
 * ("off" disables a dim). The SPEND cap defaults to the phase's timeout
 * class (timeoutClassFor); an explicit KSTACK_PI_STEP_MAX_TOKENS /
 * KSTACK_PI_STEP_MAX_CONTEXT always wins over the class default.
 */
export function stepBudgetDefaults(phaseId?: string): StepBudgets {
  const cls = phaseId ? timeoutClassFor(phaseId) : null;
  const tokenDefault = cls ? CLASS_TOKEN_LIMITS[cls] : DEFAULT_TOKEN_LIMIT;
  return {
    turns: limit(numberEnv("KSTACK_PI_STEP_MAX_TURNS", 60, { allowOff: true })),
    tokens: limit(numberEnv("KSTACK_PI_STEP_MAX_TOKENS", tokenDefault, { allowOff: true })),
    context: limit(numberEnv("KSTACK_PI_STEP_MAX_CONTEXT", DEFAULT_CONTEXT_LIMIT, { allowOff: true })),
    // No pricing feed exists in-repo — the USD dims default to off (Infinity,
    // same convention as maxRunTokens). They trip only when an env cap is set.
    usd: limit(numberEnv("KSTACK_PI_STEP_MAX_USD", Number.POSITIVE_INFINITY, { allowOff: true })),
    ms: limit(numberEnv("KSTACK_PI_STEP_MAX_MS", 30 * 60 * 1000, { allowOff: true })),
    usdPerMin: limit(numberEnv("KSTACK_PI_STEP_MAX_USD_PER_MIN", Number.POSITIVE_INFINITY, { allowOff: true })),
  };
}

const BUDGET_DIMS = ["turns", "tokens", "context", "usd", "ms", "usdPerMin"] as const;
type BudgetDim = (typeof BUDGET_DIMS)[number];

function usageFor(run: StepRun, dim: BudgetDim, now: number): number {
  switch (dim) {
    case "turns": return run.turns;
    case "tokens": return run.tokens;
    case "context": return run.contextTokens;
    case "usd": return run.costUsd;
    case "ms":
      // Evaluated per-event only — a silently-hung child emits no events, so
      // this dim can never trip during a stall; the spawn wall-clock timeout
      // (KSTACK_PI_STEP_MAX_SEC check-in cap) covers that case by design.
      return Math.max(0, now - run.startedAtMs);
    case "usdPerMin": {
      const elapsedMin = (now - run.startedAtMs) / 60_000;
      // Warmup floor: a first cost event at ~1ms elapsed would otherwise
      // divide by ~0 and instant-trip an explicitly-set cap.
      return elapsedMin >= 0.1 ? run.costUsd / elapsedMin : 0;
    }
  }
}

/**
 * Budget check: a dim at ≥80% warns ONCE (tracked on the run); a dim at ≥100%
 * reports `exceeded`. Evaluation order is the fixed BUDGET_DIMS order so the
 * first exceeded dim is deterministic.
 */
export function checkStepBudgets(
  run: StepRun,
  limits: StepBudgets,
  now = Date.now(),
): { warn: BudgetDim[]; exceeded: BudgetDim | null } {
  for (const dim of BUDGET_DIMS) {
    const lim = limits[dim];
    if (!Number.isFinite(lim)) continue;
    if (usageFor(run, dim, now) >= lim) return { warn: [], exceeded: dim };
  }
  const warn: BudgetDim[] = [];
  for (const dim of BUDGET_DIMS) {
    const lim = limits[dim];
    if (!Number.isFinite(lim) || run.warnedDims.has(dim)) continue;
    if (usageFor(run, dim, now) >= lim * 0.8) {
      run.warnedDims.add(dim);
      warn.push(dim);
    }
  }
  return { warn, exceeded: null };
}

// --- live step watch (main-session events) -----------------------------------

/**
 * The step watch binds the transient StepRun to the CURRENTLY delivered main
 * step. It is module state on purpose — `WorkflowState` stays serializable
 * and the counters die with the step. begin/end are idempotent; a stale watch
 * is dropped the moment a non-stepped phase delivers instructions.
 */
interface StepWatch {
  run: StepRun;
  phaseId: string;
  stepId: string;
  budgets: StepBudgets;
}

let watch: StepWatch | null = null;

export function beginStepWatch(phaseId: string, stepId: string): void {
  // Budgets are OFF for main-session watches: a main step is a conversation
  // with the user (planning continues until the user is satisfied), so turns,
  // spend, context and wall clock measure the discussion, not a stall. Only the
  // stuck RULES (repeated/alternating actions, error streaks) still guard it.
  // The delegated-step path keeps its budgets — a subagent has no human on the wire.
  const off = Number.POSITIVE_INFINITY;
  watch = { run: newStepRun(), phaseId, stepId, budgets: { turns: off, tokens: off, context: off, usd: off, ms: off, usdPerMin: off } };
}

export function endStepWatch(): void {
  watch = null;
}

export function activeStepWatch(): { phaseId: string; stepId: string } | null {
  return watch ? { phaseId: watch.phaseId, stepId: watch.stepId } : null;
}

/**
 * Accumulated usage of the CURRENTLY watched step — the D28 cache-telemetry
 * hook. The byte-stable prefix can't be measured at delivery time (the model
 * hasn't run yet); it is measured here, across the step's message_end events,
 * and the caller ledgers it when the step completes. Null when no watch runs.
 */
export function stepWatchStats(): { turns: number; tokens: number; cacheRead: number; cacheCreation: number } | null {
  if (!watch) return null;
  const { turns, tokens, cacheRead, cacheWrite } = watch.run;
  return { turns, tokens, cacheRead, cacheCreation: cacheWrite };
}

export interface WatchVerdict {
  /** Detector rule or budget dim that tripped — the caller parks. */
  trip?: string;
  /** Budget dims that crossed 80% since the last event — the caller notifies. */
  warnings?: string[];
  /** The watched step — the caller validates it against fresh state before parking. */
  phaseId: string;
  stepId: string;
}

/**
 * Feed a main-session event into the active watch. Returns null when no watch
 * is active (implicit phases never start one — detector inert) or when nothing
 * trips. A `trip` string is the pausedReason fragment: "stuck:<rule>" or
 * "budget-exceeded:<dim>".
 */
export function feedWatchEvent(event: StepWatchEvent): WatchVerdict | null {
  if (!watch) return null;
  const { phaseId, stepId } = watch;
  feedStepEvent(watch.run, event);
  const rule = detectStuck(watch.run);
  if (rule) {
    watch = null;
    return { trip: `stuck:${rule}:${phaseId}.${stepId}`, phaseId, stepId };
  }
  const budgets = checkStepBudgets(watch.run, watch.budgets);
  const warnings = budgets.warn.length > 0 ? budgets.warn.slice() : undefined;
  if (budgets.exceeded) {
    watch = null;
    return { trip: `budget-exceeded:${budgets.exceeded}:${phaseId}.${stepId}`, warnings, phaseId, stepId };
  }
  return warnings ? { warnings, phaseId, stepId } : null;
}
