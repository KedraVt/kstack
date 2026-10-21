/**
 * Feature flags for the skill-ingestion / deterministic-execution upgrade.
 * All default ON; each can be disabled independently to fall back to the
 * pre-upgrade behavior (advisory subagent hints, generic phase instructions,
 * model-discretionary advancement).
 */

function parse(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return v === "1" || v.toLowerCase() === "on" || v.toLowerCase() === "true";
}

/** Inject distilled skill methodology into phase instructions / subagent tasks. */
export function skillsEnabled(): boolean {
  return parse(process.env.KSTACK_PI_SKILLS) ?? true;
}

/** Spawn subagents directly from the executor instead of asking the model to. */
export function deterministicSubagents(): boolean {
  return parse(process.env.KSTACK_PI_DETERMINISTIC) ?? true;
}

/** Pause for user approval after decision phases (plan, root-cause). */
export function manualGates(): boolean {
  return parse(process.env.KSTACK_PI_MANUAL_GATES) ?? true;
}

export type OptionalPhasesMode = "ask" | "auto" | "skip";

/**
 * Optional-phase handling (STEP 2g). Default "ask" preserves the interactive
 * confirm prompt; "auto"/"skip" avoid the prompt entirely — required in
 * fire-and-forget background runs where a stale context would otherwise
 * abandon the chain.
 */
export function optionalPhases(): OptionalPhasesMode {
  const v = process.env.KSTACK_PI_OPTIONAL_PHASES;
  if (v === "auto" || v === "skip") return v;
  return "ask";
}

/**
 * STEP 4e (COR-17): opt-in conditional gate. When ON and a validate-only
 * root-cause step reports `VALIDATED:` as its first line, the workflow
 * auto-advances past root-cause's manual approval gate. On REFUTED the gate
 * always applies. Default OFF: the manual gate remains the only human control
 * before code changes.
 */
export function autoGateValidated(): boolean {
  return parse(process.env.KSTACK_PI_AUTO_GATE_VALIDATED) ?? false;
}

/**
 * WP2 §4.2: opt-in strict scanning of page-content tool output. When ON, every
 * command in PAGE_CONTENT_COMMANDS has its stdout heuristically scanned and
 * enveloped between our ASCII sentinels. Default OFF: the daemon-side envelope
 * plus the SECURITY system-prompt section are always on; this flag adds the
 * extension-side heuristic layer for users who want defense-in-depth.
 */
export function strictContent(): boolean {
  return parse(process.env.KSTACK_PI_STRICT_CONTENT) ?? false;
}

// --- Sprint workflow kill-switches (MERGE-PLAN §12 / BUG-6) ------------------

/** Register the sprint workflow at all. Off ⇒ hidden from menu/router entirely. */
export function sprintEnabled(): boolean {
  return parse(process.env.KSTACK_PI_SPRINT) ?? true;
}

/** Loop-back engine. Off ⇒ a negative gate verdict pauses instead of retrying. */
export function loopbacksEnabled(): boolean {
  return parse(process.env.KSTACK_PI_LOOPBACKS) ?? true;
}

/**
 * Deterministic verdict routing. Off ⇒ verdict-bearing phases PAUSE for the
 * human after completing — no auto-routing in either direction (never a
 * silent advance past a possible rejection). Guards the RECORD channel: the
 * step records are the only channel that may produce a phase verdict.
 */
export function verdictsEnabled(): boolean {
  return parse(process.env.KSTACK_PI_VERDICTS) ?? true;
}

// --- Numeric configuration (STEP 5a / COR-06, COR-10) -------------------------

const warnedOnce = new Set<string>();

/**
 * Parse a numeric env variable. Unset/empty → defaultValue. The literal
 * "off" sentinel is only accepted when opts.allowOff is set. Invalid values
 * fall back to defaultValue with a single warning per variable name.
 */
export function numberEnv(
  name: string,
  defaultValue: number,
  opts?: { min?: number; allowOff?: boolean },
): number | "off" {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  if (opts?.allowOff && raw.trim().toLowerCase() === "off") return "off";
  const n = Number(raw);
  const min = opts?.min;
  if (!Number.isFinite(n) || n <= 0 || (min !== undefined && n < min)) {
    if (!warnedOnce.has(name)) {
      warnedOnce.add(name);
      console.warn(`[kstack] invalid ${name}="${raw}" - falling back to default (${defaultValue})`);
    }
    return defaultValue;
  }
  return n;
}

export type TimeoutClass = "EXPLORE" | "WORK" | "VERIFY";

/**
 * Exhaustive phase-id → timeout-class map (STEP 5a). Every phase id of every
 * registered workflow MUST appear here — a missing id silently falls back to
 * the generic limit, which the cross-cutting test treats as a failure.
 *
 * Defaults (seconds, historical values NOT raised):
 *   EXPLORE=900, WORK=1500, VERIFY=900; fallback KSTACK_PI_SUBAGENT_TIMEOUT=1200.
 */
const TIMEOUT_CLASS_MAP: Record<string, TimeoutClass> = {
  // shared ids (multiple workflows)
  "understand": "EXPLORE",
  "explore": "EXPLORE",
  "plan": "VERIFY",
  "implement": "WORK",
  "review": "VERIFY",
  "ship": "VERIFY",
  "document": "VERIFY",
  "qa-browsing": "WORK",
  "retro": "EXPLORE",
  // investigate
  "reproduce": "WORK",
  "root-cause": "WORK",
  "fix": "WORK",
  "verify": "VERIFY",
  "regression-qa": "WORK",
  // review
  "diff": "VERIFY",
  "findings": "VERIFY",
  "comment": "VERIFY",
  // discover / audit
  "session": "EXPLORE",
  "walk": "EXPLORE",
  // sprint (main phases never spawn subagents, but the 1:1 map invariant covers every id)
  "user-story": "EXPLORE",
  "capability": "EXPLORE",
  "system-design": "VERIFY",
  "architect-gate": "VERIFY",
  "backlog": "EXPLORE",
  "devsecops-review": "VERIFY",
  "docker-review": "VERIFY",
  "pipeline-review": "VERIFY",
  "archive": "VERIFY",
};

/** Resolve the timeout class of a phase id (null = unmapped). */
export function timeoutClassFor(phaseId: string): TimeoutClass | null {
  return TIMEOUT_CLASS_MAP[phaseId] ?? null;
}

/** Per-phase subagent timeout in milliseconds, resolved from the class envs. */
export function subagentTimeoutFor(phaseId: string): number {
  const cls = TIMEOUT_CLASS_MAP[phaseId];
  let sec: number;
  if (cls === "EXPLORE") sec = numberEnv("KSTACK_PI_TIMEOUT_EXPLORE", 900) as number;
  else if (cls === "WORK") sec = numberEnv("KSTACK_PI_TIMEOUT_WORK", 1500) as number;
  else if (cls === "VERIFY") sec = numberEnv("KSTACK_PI_TIMEOUT_VERIFY", 900) as number;
  else sec = numberEnv("KSTACK_PI_SUBAGENT_TIMEOUT", 1200) as number;
  return sec * 1000;
}

/**
 * Sprint loop ceilings (plan B5). KSTACK_PI_SPRINT_MAX_ATTEMPTS bounds
 * CONSECUTIVE implement reruns per review gate: the counter resets when a gate
 * approves (state.ts), so devsecops and QA each get a fresh ceiling within the
 * same sprint — worst case ≈ 2× the ceiling total implement runs.
 * KSTACK_PI_SPRINT_ARCH_MAX_ATTEMPTS bounds system-design reruns after
 * architect rejections.
 */
export function sprintMaxAttempts(): number {
  return numberEnv("KSTACK_PI_SPRINT_MAX_ATTEMPTS", 4) as number;
}

export function sprintArchMaxAttempts(): number {
  return numberEnv("KSTACK_PI_SPRINT_ARCH_MAX_ATTEMPTS", 5) as number;
}

// --- Model tiers (E4 / D10): inert unless both env vars are meaningful ------

/**
 * Judgment-heavy phases route to KSTACK_PI_MODEL_STRONG when set; everything
 * else to KSTACK_PI_MODEL_FAST. UNSET envs mean "keep the agent definition's
 * own model" — the feature is fully inert by default.
 */
const STRONG_PHASES = new Set(["implement", "architect-gate", "devsecops-review", "qa-browsing"]);

export function modelTierFor(phaseId: string): string | undefined {
  const strong = process.env.KSTACK_PI_MODEL_STRONG;
  const fast = process.env.KSTACK_PI_MODEL_FAST;
  if (strong === undefined && fast === undefined) return undefined;
  return STRONG_PHASES.has(phaseId)
    ? (strong || undefined)
    : (fast || undefined);
}

/**
 * Observe-only liveness threshold in ms (STEP 5b). Default 240s; "off"
 * disables the observation entirely.
 */
export function livenessThresholdMs(): number | "off" {
  const sec = numberEnv("KSTACK_PI_LIVENESS_SEC", 240, { allowOff: true });
  return sec === "off" ? "off" : sec * 1000;
}

/**
 * Inactivity / liveness timeout in ms (kills unresponsive subagent).
 * When a subagent produces no signals/events/output for this duration,
 * it is deemed hung and terminated. Default OFF (opt-in): one long tool call
 * (a 5-minute test suite) emits no events and would be killed as hung.
 * Enable via KSTACK_PI_INACTIVITY_TIMEOUT_SEC or KSTACK_PI_LIVENESS_KILL_SEC.
 */
export function inactivityTimeoutMs(): number | "off" {
  const custom = process.env.KSTACK_PI_INACTIVITY_TIMEOUT_SEC ?? process.env.KSTACK_PI_LIVENESS_KILL_SEC;
  if (custom !== undefined) {
    const varName = process.env.KSTACK_PI_INACTIVITY_TIMEOUT_SEC !== undefined
      ? "KSTACK_PI_INACTIVITY_TIMEOUT_SEC"
      : "KSTACK_PI_LIVENESS_KILL_SEC";
    const sec = numberEnv(varName, 240, { allowOff: true });
    return sec === "off" ? "off" : sec * 1000;
  }
  return "off";
}

/**
 * Token circuit-breaker (STEP 5c / COR-22). No default = disabled. When set,
 * an orderly chain stop triggers once the cumulative token usage of the run
 * exceeds it.
 */
export function maxRunTokens(): number {
  return numberEnv("KSTACK_PI_MAX_RUN_TOKENS", Number.POSITIVE_INFINITY) as number;
}

/**
 * Wall-clock budget for ONE phase's whole deterministic delegation (all steps
 * + retries). Guards against pathological hangs: past the budget the chain
 * stops orderly with an explicit outcome instead of hanging forever. Default
 * 45 min; "off" disables.
 */
export function delegationBudgetMs(): number | "off" {
  // min: 1 — a sub-second budget is below the spawn floor and trips the
  // budget before the first step could ever run.
  const sec = numberEnv("KSTACK_PI_DELEGATION_BUDGET_SEC", 2700, { allowOff: true, min: 1 });
  return sec === "off" ? "off" : sec * 1000;
}
