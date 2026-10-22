import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowState, PhaseResult, WorkflowPhase, WorkflowStep, ParsedVerdict, VerdictParkCause } from "./types.ts";
import { sprintMaxAttempts, sprintArchMaxAttempts, loopbacksEnabled, verdictsEnabled } from "./config.ts";
import { buildRetryFeedback, EXPECTATIONS, NEGATIVE_VALUES, isVerdictBearing } from "./verdicts.ts";
import { mergePhaseVerdicts, phaseRecordFeedback } from "./records.ts";
import { securityReviewArtifactRel, SPRINT_PLACEHOLDER, ephemeralArtifactsFor } from "./artifacts.ts";

const ENTRY_TYPE = "kstack-wf-state";

export function saveState(pi: ExtensionAPI, state: WorkflowState): void {
  pi.appendEntry(ENTRY_TYPE, state);
}

export function loadActiveState(ctx: ExtensionContext): WorkflowState | null {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as any;
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
      const state = entry.data as WorkflowState;
      if (
        state &&
        (state.status === "active" || state.status === "paused" || state.status === "awaiting_approval")
      ) {
        // Session-entry normalization (S3 review): the entry channel carries
        // no schema guarantee — a corrupt/hand-edited state must not smuggle
        // unknown gate values or a non-string runId downstream (runId feeds
        // the ledger filename).
        const normalized: WorkflowState = { ...state };
        if (normalized.gateMode !== "selection-gate" && normalized.gateMode !== "human-gate") {
          delete normalized.gateMode;
          delete normalized.gateOverrides;
        } else {
          const ov = normalized.gateOverrides;
          normalized.gateOverrides =
            ov && typeof ov === "object"
              ? (Object.fromEntries(
                  Object.entries(ov).filter(([, v]) => v === "auto" || v === "human" || v === "skip"),
                ) as WorkflowState["gateOverrides"])
              : {};
        }
        if (typeof normalized.runId !== "string") delete normalized.runId;
        // S4: routing vars ride the same untrusted entry channel — a
        // hand-edited state must not smuggle non-string values into
        // skipWhen/var resolution downstream.
        {
          const vv = normalized.vars;
          normalized.vars =
            vv && typeof vv === "object"
              ? Object.fromEntries(
                  Object.entries(vv).filter(
                    ([k, v]) => typeof k === "string" && typeof v === "string",
                  ),
                )
              : {};
        }
        // stepIndex is routing state too: a negative/NaN forged value flips
        // insidePhase at the executor and skips skipWhen/optional/⚠ entry
        // gates on a stepped phase (S3 security review, EoP class). Over-high
        // positives are already clamped at delivery, so only drop non-integer
        // or negative values here.
        if (!Number.isInteger(normalized.stepIndex) || (normalized.stepIndex as number) < 0) {
          delete normalized.stepIndex;
        }
        // S4: lastVerdicts / lanes / capabilities / ephemeralArtifacts ride
        // the same untrusted channel — normalize to string-keyed maps of the
        // declared shape or drop (never smuggle junk into routing reads).
        {
          const lv = normalized.lastVerdicts;
          const clean: Record<string, Record<string, string>> = {};
          if (lv && typeof lv === "object") {
            for (const [k, v] of Object.entries(lv)) {
              if (!v || typeof v !== "object") continue;
              const inner: Record<string, string> = {};
              for (const [vk, vv] of Object.entries(v as Record<string, unknown>)) {
                if (typeof vv === "string") inner[vk] = vv;
              }
              clean[k] = inner;
            }
          }
          normalized.lastVerdicts = clean;
        }
        {
          const lanes = normalized.lanes;
          normalized.lanes =
            lanes && typeof lanes === "object"
              ? (Object.fromEntries(
                  Object.entries(lanes)
                    .map(([k, v]) => [k, (v as { stepIndex?: unknown })?.stepIndex])
                    .filter(([, si]) => Number.isInteger(si) && (si as number) >= 0),
                ) as WorkflowState["lanes"])
              : {};
        }
        {
          const caps = normalized.capabilities;
          normalized.capabilities =
            caps && typeof caps === "object"
              ? (Object.fromEntries(Object.entries(caps).filter(([, v]) => typeof v === "boolean")) as WorkflowState["capabilities"])
              : {};
        }
        {
          const ea = normalized.ephemeralArtifacts;
          normalized.ephemeralArtifacts = Array.isArray(ea)
            ? ea.filter((p): p is string => typeof p === "string" && !p.includes("..") && !path.isAbsolute(p))
            : [];
        }
        if (typeof normalized.resumeMode !== "boolean") delete normalized.resumeMode;
        // S5a/TASK_10: the budget-raise env name rides the untrusted entry
        // channel too — only a plain string may name an env var (it is
        // printed back to the human, never executed).
        if (typeof normalized.budgetRaiseEnv !== "string") delete normalized.budgetRaiseEnv;
        // S5a hotfix / ADR-64: the pulse's diagnosis rides the untrusted
        // entry channel too — only a plain string may be shown to the human.
        if (typeof normalized.pulseDiagnosis !== "string") delete normalized.pulseDiagnosis;
        // S5a/TASK_16: the provenance park list rides the same untrusted
        // entry channel — only plain strings may name a file and a line.
        if (Array.isArray(normalized.provenanceFindings)) {
          normalized.provenanceFindings = normalized.provenanceFindings.filter(
            (f): f is string => typeof f === "string",
          );
        } else {
          delete normalized.provenanceFindings;
        }
        if (typeof normalized.baseHead !== "string") delete normalized.baseHead;
        if (typeof normalized.stepGates !== "boolean") delete normalized.stepGates;
        if (typeof normalized.stepGate !== "boolean") delete normalized.stepGate;
        if (!Number.isInteger(normalized.reissues) || (normalized.reissues as number) < 0) delete normalized.reissues;
        // verdictRepairTried rides the same untrusted channel: only a plain
        // string may name the step whose repair was already attempted.
        if (typeof normalized.verdictRepairTried !== "string") delete normalized.verdictRepairTried;
        return normalized;
      }
      return null;
    }
  }
  return null;
}

export function createState(workflowId: string, goal: string): WorkflowState {
  return {
    workflowId,
    phaseIndex: 0,
    status: "active",
    goal,
    results: {},
    // v5 (S4): gate fields + routing vars exist from creation (INV-06);
    // stepIndex stays absent until a stepped phase is entered (INV-01).
    version: 5,
    attempts: {},
    gateMode: "human-gate",
    gateOverrides: {},
    vars: {},
    lastVerdicts: {},
    lanes: {},
    capabilities: {},
    // S4/§10.5: THINK docs consumed within the run — registered at creation,
    // deleted at terminal status (TASK_07).
    ephemeralArtifacts: ephemeralArtifactsFor(workflowId),
    // S3 ledger run id — a restart/resume appends to the same JSONL file.
    // Filesystem-safe from birth: agents paste $KSTACK_RUN_ID into paths, and a
    // raw ':' on Windows becomes a different (private-use) character than the
    // sanitized record dir — screenshots and records then split into two dirs.
    runId: `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`,
  };
}

// --- Sprint loop engine (plan B3 / D1–D4) ------------------------------------

export interface AdvanceOptions {
  /** Full phase list of the workflow — required for verdict routing. */
  phases?: WorkflowPhase[];
  /** Working directory — reads review/QA artifacts for retry feedback. */
  cwd?: string;
}

/**
 * Ceiling for reruns of a loop target phase. The phase may declare its own
 * maxAttempts; otherwise the env-driven defaults apply (implement → 4,
 * system-design → 5).
 */
function ceilingFor(targetPhaseId: string, declared?: number): number {
  if (typeof declared === "number") return declared;
  return targetPhaseId === "system-design" ? sprintArchMaxAttempts() : sprintMaxAttempts();
}

/**
 * Attempt-counter key for one gate→target edge. Every GATE owns its own
 * budget of reruns of its target, so the counter is keyed by the PAIR
 * (`${gateId}->${targetId}`): qa-browsing's rejections keep their count even
 * when the target (implement) completes and approves in between. Keying by
 * the target alone let implement's approval wipe the counter the QA gate
 * had charged — the ceiling never fired and the loop could run forever.
 */
export function attemptKey(gateId: string, targetId: string): string {
  return `${gateId}->${targetId}`;
}

/**
 * Drop every counter charged by one gate (its own approval resets its
 * budget). `keep` holds keys that must survive — the gate's own onComplete
 * edge, whose back-edge fires in the very transition that clears the budget.
 */
function clearGateAttempts(attempts: Record<string, number>, gateId: string | undefined, keep?: string[]): void {
  if (!gateId) return;
  const prefix = `${gateId}->`;
  for (const key of Object.keys(attempts)) {
    if (key.startsWith(prefix) && !keep?.includes(key)) delete attempts[key];
  }
}

/** Every phase a gate's routing can charge attempts to: loopBackTo, loopBackOn targets, onComplete. */
export function loopEdges(phase: WorkflowPhase | undefined): string[] {
  if (!phase) return [];
  const edges = [phase.loopBackTo, ...Object.values(phase.loopBackOn ?? {}), phase.onComplete];
  return [...new Set(edges.filter((e): e is string => !!e))];
}

/**
 * Loop-back target for a human "return" decision: the loopBackOn edge of the
 * first emitted negative value, else loopBackTo, else the first loopBackOn
 * edge (investigate.verify declares only loopBackOn).
 */
export function returnTargetFor(phase: WorkflowPhase | undefined, parsed?: ParsedVerdict | null): string | undefined {
  if (!phase) return undefined;
  for (const value of Object.values(parsed?.verdicts ?? {})) {
    const target = phase.loopBackOn?.[value];
    if (target) return target;
  }
  return phase.loopBackTo ?? Object.values(phase.loopBackOn ?? {})[0];
}

/** Gate feedback for a looped-back phase: the gate's records first (S4), legacy artifacts as fallback. */
function loopFeedback(state: WorkflowState, phase: WorkflowPhase, parsed: ParsedVerdict | null | undefined, cwd: string): string {
  return (
    phaseRecordFeedback(phase, cwd, state.workflowId, state.runId, state.results) ||
    (parsed ? buildRetryFeedback(parsed, phase.feedbackFrom ?? phase.id, cwd, state.sprintNumber) : "")
  );
}

export interface RouteAction {
  kind: "advance" | "loop-back" | "freeze" | "park";
  /** Resolved loop-back target phase id (loopBackOn map or loopBackTo). */
  target?: string;
  /** Park cause for the verdict-unreadable channel. */
  cause?: VerdictParkCause;
  /** Designed parks (parkOn, feedback-spec) carry a free-form pausedReason. */
  parkReason?: string;
}

/**
 * Deterministic routing table (D1–D3, S4 machinery). FAIL-CLOSED by
 * expectation map keyed [workflowId][phaseId] (ADR-7): each emitted verdict
 * variable must land on an explicitly expected positive value or a routing
 * negative. A missing map entry parks with no-expectation — never defaults.
 *
 * Evaluation order (system-design_01 §4): parkOn values first (a declared
 * freeze/park beats every edge), then feedback-type==spec park, then
 * negatives through loopBackOn[値] → loopBackTo, then required-var
 * completeness, then advance. Publish-only phases (no edges) advance on
 * every VALIDATED value and write lastVerdicts downstream (ADR-24).
 */
export function routeVerdict(
  workflowId: string,
  phaseId: string,
  parsed: ParsedVerdict,
  opts?: { phase?: WorkflowPhase; vars?: Record<string, string> },
): RouteAction {
  const v = parsed.verdicts;
  const expectations = EXPECTATIONS[workflowId]?.[phaseId];
  if (!expectations) return { kind: "park", cause: "no-expectation" };

  const phase = opts?.phase;
  const parkOn = phase?.parkOn ?? {};
  const loopBackOn = phase?.loopBackOn ?? {};
  const hasEdges = !!(phase?.loopBackTo || Object.keys(loopBackOn).length > 0);

  // parkOn scan — severity-as-verdict (record channel) AND the standalone
  // parsed.severity field are both covered.
  const emittedValues = [...Object.entries(v).map(([k, val]) => `${k}==${val}`), ...(parsed.severity ? [`severity==${parsed.severity}`] : [])];
  for (const emitted of emittedValues) {
    const value = emitted.split("==")[1];
    const mode = parkOn[value];
    if (mode === "freeze") return { kind: "freeze" };
    if (mode === "park") return { kind: "park", parkReason: `park-on:${phaseId}:${emitted}` };
  }

  // spec feedback never auto-reruns — the human decides whether the backlog
  // reopens (ADR-21).
  if (opts?.vars?.["feedback-type"] === "spec") {
    return { kind: "park", parkReason: `feedback-spec:${phaseId}` };
  }

  // Per-emitted-var validation: every emitted var must have an expectation
  // entry and a legit value (allowed OR routing negative OR declared map key).
  for (const [variable, value] of Object.entries(v)) {
    const key = expectations[variable] !== undefined ? variable : expectations[`${variable}?`] !== undefined ? `${variable}?` : undefined;
    if (key === undefined) return { kind: "park", cause: "foreign-verdict" };
    const allowed = expectations[key];
    const legit =
      allowed.includes(value) ||
      NEGATIVE_VALUES.has(value) ||
      parkOn[value] !== undefined ||
      loopBackOn[value] !== undefined;
    if (!legit) return { kind: "park", cause: "unroutable" };
  }

  // D3 fail-closed (record channel): a security rejection emitted without a
  // severity verdict is ambiguity, not a loop — the same contract the retired
  // HANDOFF parser enforced.
  if (
    expectations["security-review"] !== undefined &&
    v["security-review"] === "rejected" &&
    v["severity"] === undefined &&
    parsed.severity === undefined
  ) {
    return { kind: "park", cause: "no-verdict" };
  }

  // Negatives: first declared negative routes. Edgeless (publish-only)
  // phases have no routing edge — a validated negative still advances.
  if (hasEdges) {
    for (const value of Object.values(v)) {
      if (!NEGATIVE_VALUES.has(value)) continue;
      const target = loopBackOn[value] ?? phase!.loopBackTo;
      if (!target) return { kind: "park", cause: "unroutable" }; // unmapped negative
      return { kind: "loop-back", target };
    }
  }

  // Advance ONLY when every REQUIRED variable for this phase is present and
  // positive. A gate that skipped its main verdict parks instead of
  // advancing. `?`-marked vars are legitimately absent.
  for (const [rawKey, allowed] of Object.entries(expectations)) {
    const variable = rawKey.replace(/\?$/, "");
    const optional = rawKey.endsWith("?");
    const value = v[variable];
    if (value === undefined) {
      if (optional) continue;
      return { kind: "park", cause: "no-verdict" };
    }
    if (!allowed.includes(value) && !NEGATIVE_VALUES.has(value)) {
      return { kind: "park", cause: "unroutable" };
    }
  }
  return { kind: "advance" };
}

/** True when the state is parked behind a D3 security freeze. */
export function isSecurityFrozen(state: WorkflowState): boolean {
  return state.frozenUntilHuman === true || state.freezeInfo !== undefined;
}

export function advancePhase(state: WorkflowState, phaseId: string, result: PhaseResult, totalPhases: number, opts?: AdvanceOptions): WorkflowState {
  const phase = opts?.phases?.find((p) => p.id === phaseId);
  const next: WorkflowState = {
    ...state,
    // S3/INV-01: leaving a phase always clears stepIndex — the next (or
    // looped-back) phase establishes its own at entry. Implicit phases never
    // carry it anyway, so this is a no-op for legacy runs.
    stepIndex: undefined,
    attempts: { ...(state.attempts ?? {}) },
    // Phase-level summaries re-inject into every later phase's "Completed
    // phases" block — the cap applies to STEPPED phases only: implicit phases
    // stored verbatim summaries pre-S3 and keep byte-identity (C2/C17).
    results: { ...state.results, [phaseId]: { ...result, summary: phase?.steps?.length ? capResultSummary(result.summary) : result.summary } },
    pendingVerdict: undefined,
    verdictPark: undefined,
    pausedReason: undefined,
    entryGate: undefined,
    // Leaving the phase clears the repair marker — the next visit of the
    // phase gets a fresh repair budget (one attempt per step per park).
    verdictRepairTried: undefined,
  };

  if (result.status === "failed") {
    next.status = "paused";
    return next;
  }

  // Clear the retry marker when its target phase completes again.
  if (next.retryContext && next.retryContext.targetPhaseId === phaseId) {
    next.retryContext = undefined;
  }

  const cwd = opts?.cwd ?? process.cwd();
  // Verdict resolution only on a COMPLETED result: a skipped/auto-disabled
  // verdict phase ran nothing, so requiring its records would park every
  // legitimately-skipped gate (INV-16).
  const verdictPhase = result.status === "completed" && isVerdictBearing(phase);

  // B6 fix: with deterministic verdict parsing disabled, verdict-bearing
  // phases must NOT auto-advance. The kill-switch's documented contract is
  // "gates rely on human reading; no auto-routing" — meaning no routing in
  // EITHER direction: the completed gate pauses for the human instead of
  // silently advancing past a possible rejection.
  if (verdictPhase && !verdictsEnabled()) {
    next.status = "paused";
    next.pausedReason = `verdicts-disabled:${phase!.id}`;
    return next;
  }

  // Resolve the phase verdict (INV-9). Flagged-steps phases merge their
  // kstack-report records from .kstack/runs/<runId>/ — the ONLY channel
  // allowed to produce a phase verdict under the step model. The retired
  // non-flagged `pendingVerdict` fallback is GONE (ADR-33, AC-19): a
  // verdict-bearing phase without a flagged step has NO record channel, so it
  // never routes from the stash. Two shapes remain, and both fail closed:
  //  - a STEPPED phase that declares no verdict-flagged step is a REGISTRY
  //    MISTAKE (ADR-51 / INV-15): the CI registry validation fails the build
  //    and the runtime parks it as a CONFIG error;
  //  - a phase that declares NO steps at all (the pre-S3 implicit shape) has
  //    no record channel and no step contract: its verdict is simply
  //    unreadable (no-verdict). No registry phase has this shape —
  //    verdictGateProblems proves it.
  let parsed: ParsedVerdict | null = null;
  let parkCause: VerdictParkCause = "no-verdict";
  let pvStash = state.pendingVerdict;
  if (verdictPhase) {
    const steps = phase!.steps ?? [];
    const flagged = steps.some((s) => s.signal?.kind === "verdict");
    if (flagged) {
      const merged = mergePhaseVerdicts(phase!, cwd, state.workflowId, state.runId, state.results);
      parsed = merged.parsed;
      parkCause = merged.cause ?? "no-verdict";
      pvStash = { phaseId: phase!.id, parsed: merged.parsed, excerpt: merged.excerpt };
      if (!parsed && state.pendingVerdict && state.pendingVerdict.phaseId === phase!.id) {
        parsed = state.pendingVerdict.parsed;
        pvStash = state.pendingVerdict;
      }
      // Record-carried routing vars land in state.vars BEFORE routing —
      // feedback-type==spec parks are evaluated against them (ADR-21).
      if (Object.keys(merged.vars).length > 0) {
        next.vars = { ...(state.vars ?? {}), ...merged.vars };
      }
    } else if (steps.length > 0) {
      // ADR-51 / INV-15: a MISCONFIGURED gate. The retired fallback (the
      // pendingVerdict stash) could route a verdict the registry never
      // declared — the stash is gone and the phase parks instead.
      return parkForVerdictConfig(state, phase!.id);
    } else {
      // A phase with NO steps has no record channel at all: the verdict is
      // unreadable and the phase parks fail-closed (no-verdict).
      parsed = null;
      parkCause = "no-verdict";
    }
    if (!parsed) {
      return parkForUnreadableVerdict({ ...state, pendingVerdict: pvStash }, phase!.id, parkCause);
    }
    const action = routeVerdict(state.workflowId, phase!.id, parsed, { phase, vars: next.vars });

    if (action.kind === "park") {
      // Designed parks (parkOn "park", feedback-spec) name their own reason;
      // the D4 panel resolves both shapes — a verdictPark is ALWAYS a human
      // decision point, never attempt-burning.
      if (action.parkReason) {
        return {
          ...state,
          status: "paused",
          verdictPark: phase!.id,
          pausedReason: action.parkReason,
          pendingVerdict: pvStash,
        };
      }
      // BUG-1 fail-closed: whitelisted-but-unroutable verdict ⇒ D4 panel,
      // WITHOUT recording completion or burning an attempt.
      return parkForUnreadableVerdict({ ...state, pendingVerdict: pvStash }, phase!.id, action.cause ?? "unroutable");
    }

    if (action.kind === "freeze") {
      // D3: park WITHOUT advancing or burning attempts; only an explicit
      // human re-issue (unfreeze panel) resumes.
      next.status = "paused";
      next.pausedReason = `security-freeze:${phase!.id}`;
      next.frozenUntilHuman = true;
      next.freezeInfo = {
        phaseId: phase!.id,
        severity: parsed.severity ?? parsed.verdicts["severity"] ?? "red",
        // Sprint number may be unknown if the freeze happens off the normal
        // path — surface the template placeholder instead of a bogus "00".
        artifactPath: securityReviewArtifactRel(next.sprintNumber ?? SPRINT_PLACEHOLDER),
      };
      return next; // phaseIndex held at the review phase
    }

    // The validated map publishes to lastVerdicts on every non-park outcome
    // (INV-17): edged loop-backs AND publish-only advances alike.
    next.lastVerdicts = { ...(state.lastVerdicts ?? {}), [phase!.id]: { ...parsed.verdicts } };

    if (action.kind === "loop-back") {
      const targetIndex = opts!.phases!.findIndex((p) => p.id === action.target);
      // A loop-back target that names no real phase is a workflow-definition
      // bug — without this check the loop-back fell through to the "Approved"
      // branch and a REJECTED verdict advanced linearly.
      if (targetIndex < 0) {
        return parkForUnreadableVerdict({ ...state, pendingVerdict: pvStash }, phase!.id, "unroutable");
      }
      if (!loopbacksEnabled()) {
        // KSTACK_PI_LOOPBACKS=off: negative verdicts pause instead of retrying
        // (pre-loop behavior; the human decides what happens next).
        next.status = "paused";
        next.pausedReason = `loopback-disabled:${phase!.id}`;
        return next;
      }
      // The purge covers EVERY phase that re-executes: the loop target plus
      // all phases between it and this gate (phases[targetIndex..phaseIndex]).
      purgeStepResults(next.results, opts!.phases!, targetIndex, state.phaseIndex);
      const target = opts!.phases![targetIndex];
      const ceiling = ceilingFor(action.target!, phase!.maxAttempts ?? target.maxAttempts);
      // Per-GATE budget: the counter is keyed by the gate→target PAIR, so
      // this gate's reruns are counted apart from every other gate's.
      const key = attemptKey(phase!.id, action.target!);
      const runsDone = (next.attempts[key] ?? 0) + 1;
      next.attempts[key] = runsDone;
      if (runsDone >= ceiling) {
        // Exhaustion ⇒ paused + user notified; phaseIndex stays AT the gate
        // phase — forceContinuePastGate() performs the +1 when the human
        // accepts, or the panel re-runs the gate for another verified attempt.
        next.status = "paused";
        next.pausedReason = `loop-exhausted:${action.target} after ${runsDone} runs`;
        return next;
      }
      next.phaseIndex = targetIndex;
      next.status = "active";
      next.retryContext = {
        targetPhaseId: action.target!,
        attempt: runsDone + 1,
        maxAttempts: ceiling,
        feedback: loopFeedback(state, phase!, parsed, cwd),
      };
      return next;
    }

    // Approved / publish-only advance: the gate's OWN budget is reset — only
    // the counters this phase charged (its own edges) are dropped. Another
    // gate's budget for the same target (qa-browsing→implement) survives.
    // The phase's own onComplete edge keeps its budget: that back-edge fires
    // in this very transition and must keep counting.
    clearGateAttempts(next.attempts, phase!.id, phase!.onComplete ? [attemptKey(phase!.id, phase!.onComplete)] : undefined);
    next.retryContext = undefined;
  }

  // S4 onComplete (INV-16): unconditional bounded back-edge on a NON-verdict
  // phase — fires ONLY on "completed", never on skipped/auto-disabled, and
  // never carries retryContext (the re-entered phase re-reads fresh state).
  if (result.status === "completed" && phase?.onComplete) {
    const targetIndex = opts?.phases?.findIndex((p) => p.id === phase.onComplete) ?? -1;
    if (targetIndex < 0 || targetIndex >= state.phaseIndex) {
      next.status = "paused";
      next.pausedReason = `misconfig:onComplete:${phase.id}`;
      return next;
    }
    purgeStepResults(next.results, opts!.phases!, targetIndex, state.phaseIndex);
    const target = opts!.phases![targetIndex];
    // Same ceiling rule as verdict loop-backs (and reissueGate): the gate's
    // declared maxAttempts wins over the target's.
    const ceiling = ceilingFor(phase.onComplete, phase.maxAttempts ?? target.maxAttempts);
    // The gate carrying the onComplete edge owns the budget for its target.
    const key = attemptKey(phase.id, phase.onComplete);
    const runsDone = (next.attempts[key] ?? 0) + 1;
    next.attempts[key] = runsDone;
    if (runsDone >= ceiling) {
      next.status = "paused";
      next.pausedReason = `loop-exhausted:${phase.onComplete} after ${runsDone} runs`;
      return next;
    }
    next.phaseIndex = targetIndex;
    next.status = "active";
    return next;
  }

  const nextIndex = state.phaseIndex + 1;
  if (nextIndex >= totalPhases) {
    next.status = "completed";
  } else {
    next.phaseIndex = nextIndex;
    // Caller decides whether the next phase starts immediately ("active") or
    // waits for user approval ("awaiting_approval") — see gateForApproval().
  }

  return next;
}

/**
 * D4: a verdict-bearing phase completed but no trustworthy verdict could be
 * routed. Park WITHOUT recording completion or incrementing any attempt —
 * only the interactive panel in command.ts resolves this. `cause` rides in
 * pausedReason ("verdict-unreadable:<phaseId>:<cause>") so the panel can
 * name why the park fired (agent emitted nothing vs artifact disagreement
 * vs whitelisted-but-unexpected value).
 */
export function parkForUnreadableVerdict(state: WorkflowState, phaseId: string, cause: VerdictParkCause): WorkflowState {
  if (state.verdictPark) return state; // idempotent
  return { ...state, status: "paused", verdictPark: phaseId, pausedReason: `verdict-unreadable:${phaseId}:${cause}` };
}

/**
 * The runtime shape of a MISCONFIGURED gate (ADR-51, INV-15): a
 * verdict-bearing phase that declares no verdict-flagged step, so it has no
 * record channel at all.
 *
 * It is a NON-verdict park: no verdict was read, nothing is routed, no
 * attempt is burned and the D4 panel does not claim it. The reason
 * `verdict-config:<phaseId>` names the phase, and the human can only abort
 * it — re-running a step cannot fix a registry mistake, and a Resume that
 * re-parked would be a click-loop.
 */
export function parkForVerdictConfig(state: WorkflowState, phaseId: string): WorkflowState {
  return {
    ...state,
    status: "paused",
    verdictPark: undefined,
    pendingVerdict: undefined,
    pausedReason: `verdict-config:${phaseId}`,
  };
}

/**
 * D4 panel choice 1 / manual "advance to next phase": treat the current
 * (parked or running) phase as approved and continue linearly. Clears every
 * park marker — a human decision must never leave a stale block behind.
 */
export function forceApproveParked(state: WorkflowState, phases?: WorkflowPhase[]): WorkflowState {
  const phaseId = state.verdictPark ?? phases?.[state.phaseIndex]?.id ?? `phase-${state.phaseIndex}`;
  // Reset the gate's OWN attempt counters — same contract as
  // forceContinuePastGate: the human approved moving on, so this gate's next
  // visit gets a fresh ceiling rather than inheriting a burned one. Other
  // gates' budgets (their own pair keys) are untouched.
  const gate = phases?.[state.phaseIndex];
  const attempts = { ...(state.attempts ?? {}) };
  clearGateAttempts(attempts, gate?.id);
  return {
    ...state,
    status: "active",
    phaseIndex: state.phaseIndex + 1,
    // INV-01: moving phaseIndex must clear stepIndex — a stale value would
    // flip insidePhase on the next phase, silently skipping its entry gates
    // and all steps before the clamped last one (S3 review).
    stepIndex: undefined,
    verdictPark: undefined,
    pendingVerdict: undefined,
    pausedReason: undefined,
    // ADR-64: the park is over — its diagnosis must not haunt the next park.
    pulseDiagnosis: undefined,
    frozenUntilHuman: false,
    freezeInfo: undefined,
    resumeMode: undefined,
    reissues: undefined,
    stepGate: undefined,
    entryGate: undefined,
    // The park is over — the next visit of the phase gets a fresh repair
    // budget (one repair attempt per step per park).
    verdictRepairTried: undefined,
    attempts,
    results: { ...state.results, [phaseId]: { status: "completed", summary: state.verdictPark ? "Continued as approved by explicit user decision (verdict was unreadable)." : "Advanced manually by explicit user decision." } },
  };
}

/**
 * D4 panel choice 2: send the looped phase back to work with context, without
 * burning an attempt. `extraFeedback` carries the typed answer of the
 * "Other…" escape when provided.
 */
export function returnParkedWithContext(state: WorkflowState, phases: WorkflowPhase[], extraFeedback?: string, cwd: string = process.cwd()): WorkflowState | null {
  const phaseId = state.verdictPark ?? state.freezeInfo?.phaseId;
  if (!phaseId) return null;
  const phase = phases.find((p) => p.id === phaseId);
  const prior = state.pendingVerdict?.parsed;
  const loopTarget = returnTargetFor(phase, prior);
  if (!phase || !loopTarget) return null;
  const targetIndex = phases.findIndex((p) => p.id === loopTarget);
  if (targetIndex < 0) return null;
  const next: WorkflowState = {
    ...state,
    status: "active",
    phaseIndex: targetIndex,
    // INV-01: same stale-stepIndex clear as every phaseIndex-moving
    // transition — the loop target starts at its first step, not wherever
    // the gate phase happened to leave the cursor.
    stepIndex: undefined,
    results: { ...state.results },
    verdictPark: undefined,
    frozenUntilHuman: false,
    freezeInfo: undefined,
    pausedReason: undefined,
    // ADR-64: the park is over — its diagnosis must not haunt the next park.
    pulseDiagnosis: undefined,
    // The park is over — the re-run gets a fresh repair budget.
    verdictRepairTried: undefined,
    retryContext: {
      targetPhaseId: loopTarget,
      attempt: (state.attempts?.[attemptKey(phase.id, loopTarget)] ?? 0) + 1,
      maxAttempts: ceilingFor(loopTarget, phase.maxAttempts),
      feedback:
        [loopFeedback(state, phase, prior, cwd), extraFeedback]
          .filter(Boolean)
          .join("\n\n") || "(no structured blockers extracted — see the phase report above)",
    },
  };
  // INV-04: the whole re-run span (loop target through the gate) re-executes —
  // same purge as advancePhase's verdict loop-back; the rejected attempt's
  // step summaries must not render as completed work.
  purgeStepResults(next.results, phases, targetIndex, state.phaseIndex);
  return next;
}

/** D3 unfreeze: clear the freeze; caller then advances manually. */
export function unfreeze(state: WorkflowState, phases?: WorkflowPhase[]): WorkflowState {
  // Unfreeze re-RUNS the parked phase (launchPhase → executeCurrentPhase) — a
  // stale stepIndex would skip its entry gates and resume mid-step instead of
  // restarting clean. Same class as the four phaseIndex-moving transitions.
  const next: WorkflowState = { ...state, frozenUntilHuman: false, freezeInfo: undefined, pausedReason: undefined, status: "active", stepIndex: undefined, results: { ...state.results }, verdictRepairTried: undefined };
  // INV-04: the parked phase re-runs — its step keys are attempt-local.
  if (phases) purgeStepResults(next.results, phases, state.phaseIndex, state.phaseIndex);
  return next;
}

/**
 * Human accepted the outcome of an exhausted loop (or resolved a numbering
 * anomaly): clear the pause and continue. For loop exhaustion the gate phase's
 * result is already recorded, so the index moves PAST it — linear continuation
 * without re-running the gate.
 *
 * The attempt counters of the ACCEPTED GATE are reset: the ceiling is
 * documented as CONSECUTIVE reruns per review gate (config.ts), and the next
 * gate (e.g. qa-verdict after an accepted devsecops-review) must get a fresh
 * budget instead of parking on its first rejection with zero rework. Each
 * gate owns its own budget (pair key), so accepting one gate never grants
 * budget to — nor burns — another's.
 */
export function forceContinuePastGate(state: WorkflowState, phases?: WorkflowPhase[]): WorkflowState {
  const gate = phases?.[state.phaseIndex];
  const attempts = { ...(state.attempts ?? {}) };
  clearGateAttempts(attempts, gate?.id);
  // INV-01: moving phaseIndex clears stepIndex (stale cursor → skipped gates).
  return {
    ...state,
    status: "active",
    phaseIndex: state.phaseIndex + 1,
    stepIndex: undefined,
    pendingVerdict: undefined,
    pausedReason: undefined,
    frozenUntilHuman: false,
    freezeInfo: undefined,
    verdictRepairTried: undefined,
    attempts,
  };
}

/**
 * When the just-completed phase is a manual-gate phase, park the workflow in
 * awaiting_approval. The phaseIndex already points at the next phase so
 * approval (/kstack next) simply resumes execution.
 */
export function gateForApproval(state: WorkflowState): WorkflowState {
  if (state.status !== "active") return state;
  return { ...state, status: "awaiting_approval" };
}

/** Approve a gated workflow: resume normal execution at the pending phase. */
export function approveNext(state: WorkflowState): WorkflowState {
  if (state.status !== "awaiting_approval") return state;
  return { ...state, status: "active", stepGate: undefined };
}

// --- Optional-phase decision gate (STEP 2g v2) --------------------------------
//
// The old flow prompted `ctx.ui.confirm("Run the optional phase?")` from the
// fire-and-forget background chain. That dialog fires mid-stream (the model is
// still generating after kstack_advance returned), steals editor focus, and
// defaults to "Yes" on Enter — so a user typing "no, skip QA" literally
// LAUNCHED the QA phase they were refusing. Prompting from a background chain
// cannot be a real decision point, so the decision now lives where every other
// human decision lives: the foreground /kstack panel (Run / Skip / Abort),
// exactly like the manual decision gates. The model cannot bypass it: while
// parked, kstack_advance refuses and the executor never enters the phase.

/**
 * Park the workflow at the current (optional) phase for an explicit human
 * Run/Skip/Abort decision. phaseIndex stays AT the optional phase.
 */
export function gateOptionalPhase(state: WorkflowState): WorkflowState {
  return { ...state, status: "awaiting_approval", pendingOptional: true };
}

/** The user chose "Run": clear the marker and resume execution at the phase. */
export function approveOptionalPhase(state: WorkflowState): WorkflowState {
  return { ...state, status: "active", pendingOptional: undefined };
}

/**
 * The user chose "Skip": record the phase as skipped (never silently — the
 * decision came from the interactive panel) and advance linearly. When the
 * optional phase is last, the workflow completes.
 */
export function skipPendingOptional(state: WorkflowState, phases: WorkflowPhase[], totalPhases: number): WorkflowState {
  const phase = phases[state.phaseIndex];
  const cleared: WorkflowState = { ...state, status: "active", pendingOptional: undefined };
  if (!phase) return cleared;
  return advancePhase(
    cleared,
    phase.id,
    { status: "skipped", summary: "Skipped by user (optional-phase decision panel)" },
    totalPhases,
  );
}

/**
 * Summaries re-inject into every later prompt ({previous}, Completed-steps
 * tails, resume context) — an unbounded report is an unbounded prompt
 * amplification. ~4000 chars keeps the signal and bounds the surface; the
 * verbatim summary still lands in the ledger (INV-L2 caps nothing there).
 */
function capResultSummary(summary: string): string {
  return summary.length > 4000 ? `${summary.slice(0, 4000)}\n…[truncated]` : summary;
}

/**
 * S3/INV-04: `results["<phase>.<step>"]` keys are attempt-local, not
 * run-level truth — a rejected/interrupted attempt's step summaries must not
 * re-inject into the re-run's `{previous}`, `{x.y_summary}` or the
 * Completed-steps tail. Purges those keys for every stepped phase in
 * `phases[fromIndex..toIndex]` inclusive. Used by every transition that
 * re-runs phases: verdict loop-back (advancePhase), human-initiated return
 * (returnParkedWithContext), gate re-issue (reissueGate) and unfreeze.
 */
function purgeStepResults(results: WorkflowState["results"], phases: WorkflowPhase[], fromIndex: number, toIndex: number): void {
  for (const p of phases.slice(fromIndex, toIndex + 1)) {
    if (!p.steps?.length) continue;
    for (const k of Object.keys(results)) {
      if (k.startsWith(p.id + ".")) delete results[k];
    }
  }
}

/**
 * S3 step machine (INV-01/INV-02): record one step's result under
 * `results["<phase>.<step>"]` and advance stepIndex to the NEXT step. The
 * phase-level `results[phase.id]` is deliberately untouched — it is written
 * by advancePhase when the LAST step completes (phase verdict = final step's
 * output). A failed step parks at the SAME stepIndex so a resume re-delivers
 * it (its recorded status is "failed", not "completed").
 */
export function recordStepResult(
  state: WorkflowState,
  phase: WorkflowPhase,
  result: PhaseResult,
): { state: WorkflowState; step: WorkflowStep; isLast: boolean } | null {
  const steps = phase.steps;
  if (!steps?.length) return null;
  // Same clamp as the delivery path (executor): a corrupt over-high stepIndex
  // delivers the LAST step's instructions — record its result consistently
  // instead of erroring on an index the operator never saw.
  const si = Math.min(state.stepIndex ?? 0, steps.length - 1);
  const step = steps[si];
  if (!step) return null;
  result = { ...result, summary: capResultSummary(result.summary) };
  const key = `${phase.id}.${step.id}`;
  if (result.status === "failed") {
    return {
      state: {
        ...state,
        status: "paused",
        pausedReason: `step-failed:${key}`,
        results: { ...state.results, [key]: result },
      },
      step,
      isLast: si === steps.length - 1,
    };
  }
  return {
    // A completed step clears resumeMode — the re-issue marker only survives
    // while the step stays open (failed/interrupted paths keep it). It also
    // clears entryGate: the ⚠ approval is scoped to THIS step — a later
    // sideEffect step must re-gate (TASK_07).
    state: { ...state, results: { ...state.results, [key]: result }, stepIndex: si + 1, resumeMode: undefined, reissues: undefined, entryGate: undefined },
    step,
    isLast: si + 1 >= steps.length,
  };
}

export function pauseState(state: WorkflowState): WorkflowState {
  return { ...state, status: "paused" };
}

export function abortState(state: WorkflowState): WorkflowState {
  return { ...state, status: "aborted" };
}

export function resumeState(state: WorkflowState): WorkflowState {
  // A resume RE-RUNS the parked phase — any stashed verdict from its previous
  // attempt must not survive to misroute the rerun. The repair marker dies
  // with the park it belonged to: the re-run gets a fresh repair attempt.
  return { ...state, status: "active", pausedReason: undefined, verdictPark: undefined, pendingVerdict: undefined, reissues: undefined, verdictRepairTried: undefined };
}

/**
 * Entry gate for side-effect phases (commit-archive): park BEFORE the phase
 * runs — its own delegation is the side effect, so the post-completion
 * manual gate (advance:"manual") can never catch it. phaseIndex stays AT the
 * gated phase; approving flips entryGate to "approved" which bypasses the
 * gate exactly once (advancePhase clears the marker on completion).
 */
export function gateEntry(state: WorkflowState): WorkflowState {
  return { ...state, status: "awaiting_approval", entryGate: true };
}

/** The user approved a gated phase's execution: resume at the phase. */
export function approveEntryGate(state: WorkflowState): WorkflowState {
  return { ...state, status: "active", entryGate: "approved" };
}

/**
 * B9: the human chose "Re-run the gated phase" after loop exhaustion. A bare
 * resume re-parks immediately on the next rejection — the attempt counter is
 * already AT the ceiling, so runsDone = ceiling + 1 fails the loop-back check
 * and the loop target never gets another run. Re-issuing restores exactly ONE
 * verified run of the loop target: the counter is set to ceiling - 2 so the
 * next rejection still loop-backs (runsDone = attempts + 1 < ceiling) before
 * the loop re-exhausts and returns to the human.
 */
export function reissueGate(state: WorkflowState, phases: WorkflowPhase[]): WorkflowState {
  const reason = state.pausedReason ?? "";
  if (!reason.startsWith("loop-exhausted:")) return resumeState(state);
  const gatePhase = phases[state.phaseIndex];
  const attempts = { ...(state.attempts ?? {}) };
  // The exhausted edge is named in the reason ("loop-exhausted:<target> after N
  // runs") — loopBackOn/onComplete gates have no loopBackTo to fall back on.
  const target = reason.slice("loop-exhausted:".length).split(" ")[0];
  const targetPhase = phases.find((p) => p.id === target);
  if (targetPhase && gatePhase) {
    const ceiling = ceilingFor(target, gatePhase.maxAttempts ?? targetPhase.maxAttempts);
    // ceiling - 2, deliberately unclamped: a ceiling of 1 or 2 must still
    // grant the promised ONE verified run (negative counters make the next
    // rejection's runsDone = attempts + 1 < ceiling). The counter lives under
    // the gate→target PAIR key — only THIS gate's budget is restored.
    attempts[attemptKey(gatePhase.id, target)] = ceiling - 2;
  }
  // Re-running the gate phase restarts it — INV-01: a stale step cursor must
  // not carry into the re-run (harmless today: no stepped phase is a gate).
  const next: WorkflowState = { ...state, status: "active", stepIndex: undefined, pausedReason: undefined, attempts, results: { ...state.results } };
  // INV-04: the gate phase re-runs — purge its attempt-local step keys.
  purgeStepResults(next.results, phases, state.phaseIndex, state.phaseIndex);
  return next;
}
