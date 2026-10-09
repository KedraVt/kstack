import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowState, PhaseResult, WorkflowPhase, WorkflowStep, ParsedVerdict, VerdictParkCause } from "./types.ts";
import { sprintMaxAttempts, sprintArchMaxAttempts, loopbacksEnabled, verdictsEnabled } from "./config.ts";
import { buildRetryFeedback, PHASE_EXPECTATIONS, NEGATIVE_VALUES } from "./verdicts.ts";
import { securityReviewArtifactRel, SPRINT_PLACEHOLDER } from "./artifacts.ts";

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
        // stepIndex is routing state too: a negative/NaN forged value flips
        // insidePhase at the executor and skips skipWhen/optional/⚠ entry
        // gates on a stepped phase (S3 security review, EoP class). Over-high
        // positives are already clamped at delivery, so only drop non-integer
        // or negative values here.
        if (!Number.isInteger(normalized.stepIndex) || (normalized.stepIndex as number) < 0) {
          delete normalized.stepIndex;
        }
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
    // v4 (S3): gate fields exist from creation (INV-06); stepIndex stays
    // absent until a stepped phase is entered (INV-01).
    version: 4,
    attempts: {},
    gateMode: "human-gate",
    gateOverrides: {},
    // S3 ledger run id — a restart/resume appends to the same JSONL file.
    runId: `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 6)}`,
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

interface RouteAction {
  kind: "advance" | "loop-back" | "freeze" | "park";
}

/**
 * Deterministic routing table (D1–D3, BUG-1 fix). FAIL-CLOSED by expectation
 * map: each known verdict variable must land on an explicitly expected positive
 * value or a routing negative. Whitelisted-but-off-map values (e.g.
 * `status == success` at the QA gate) PARK for human decision instead of
 * silently advancing. Missing expected variables also park.
 */
export function routeVerdict(phaseId: string, parsed: ParsedVerdict): RouteAction {
  const v = parsed.verdicts;
  const expectations = PHASE_EXPECTATIONS[phaseId];
  // routeVerdict is only reached for phases declaring loopBackTo. One of
  // those without an expectations entry is a misconfigured gate — fail closed
  // (park) rather than silently advancing past it.
  if (!expectations) return { kind: "park" };

  let sawNegative = false;
  for (const [variable, allowed] of Object.entries(expectations)) {
    const value = v[variable];
    if (value === undefined) continue; // optional variable for this phase
    // NOTE: routing negatives (red/orange/rejected/failed) are checked BEFORE
    // the allowed-list on purpose — e.g. `status == red` at the QA gate is
    // not in allowed ["green"], but it is the designed fix-loop trigger, not
    // ambiguity. Only whitelisted NON-negative values that are off-map here
    // (e.g. `status == approved` at QA) are ambiguous ⇒ park.
    if (NEGATIVE_VALUES.has(value)) {
      sawNegative = true;
      continue;
    }
    if (!allowed.includes(value)) {
      return { kind: "park" };
    }
  }

  if (phaseId === "devsecops-review") {
    const securityRejected = v["security-review"] === "rejected";
    // Parser guarantees severity exists on security rejections (D3).
    if (securityRejected && (parsed.severity === "critical" || parsed.severity === "high")) {
      return { kind: "freeze" };
    }
    if (securityRejected) return { kind: "loop-back" };
    // Docker verdicts are only meaningful when the reviewer emitted them.
    if (v["docker-build"] === "failed" || v["docker-security"] === "rejected") {
      return { kind: "loop-back" };
    }
  }

  if (sawNegative) return { kind: "loop-back" };

  // Advance ONLY when every REQUIRED variable for this phase is present and
  // positive. A gate that skipped its main verdict (e.g. devsecops chain
  // emitting docker-build but no code-review) parks instead of advancing.
  for (const [variable, allowed] of Object.entries(expectations)) {
    if (phaseId === "devsecops-review" && variable.startsWith("docker-")) continue; // conditional
    if (!allowed.includes(v[variable] ?? "")) return { kind: "park" };
  }
  return { kind: "advance" };
}

/** True when the state is parked behind a D3 security freeze. */
export function isSecurityFrozen(state: WorkflowState): boolean {
  return state.frozenUntilHuman === true;
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
  };

  if (result.status === "failed") {
    next.status = "paused";
    return next;
  }

  // Clear the retry marker when its target phase completes again.
  if (next.retryContext && next.retryContext.targetPhaseId === phaseId) {
    next.retryContext = undefined;
  }

  // B6 fix: with deterministic verdict parsing disabled, verdict-bearing
  // phases must NOT auto-advance. The kill-switch's documented contract is
  // "gates rely on human reading; no auto-routing" — meaning no routing in
  // EITHER direction: the completed gate pauses for the human instead of
  // silently advancing past a possible rejection.
  if (phase?.loopBackTo && !verdictsEnabled()) {
    next.status = "paused";
    next.pausedReason = `verdicts-disabled:${phase.id}`;
    return next;
  }
  // Fail closed on a gate whose verdict never arrived (or arrived under a
  // different phaseId — a stale stash from an earlier gate): silently
  // advancing past a rejection-shaped blank is exactly what the verdict
  // channel exists to prevent.
  const pending = state.pendingVerdict;
  const parsed = pending && pending.phaseId === phase.id ? pending.parsed : null;
  if (phase?.loopBackTo && !parsed) {
    return parkForUnreadableVerdict({ ...state, pendingVerdict: state.pendingVerdict }, phase.id, "no-verdict");
  }
  if (phase?.loopBackTo && parsed) {
    const action = routeVerdict(phase.id, parsed);

    if (action.kind === "park") {
      // BUG-1 fail-closed: whitelisted-but-unroutable verdict ⇒ D4 panel,
      // WITHOUT recording completion or burning an attempt.
      return parkForUnreadableVerdict({ ...state, pendingVerdict: state.pendingVerdict }, phase.id, "unroutable");
    }

    const targetIndex = opts!.phases!.findIndex((p) => p.id === phase.loopBackTo);
    // A loop-back target that names no real phase is a workflow-definition
    // bug — without this check the loop-back fell through to the "Approved"
    // branch and a REJECTED verdict advanced linearly.
    if (action.kind === "loop-back" && targetIndex < 0) {
      return parkForUnreadableVerdict({ ...state, pendingVerdict: state.pendingVerdict }, phase.id, "unroutable");
    }
    const cwd = opts?.cwd ?? process.cwd();
    const sprintNumber = next.sprintNumber;

    if (action.kind === "freeze") {
      // D3: park WITHOUT advancing or burning attempts; only an explicit
      // human re-issue (unfreeze panel) resumes.
      next.status = "paused";
      next.pausedReason = `security-freeze:${phase.id}`;
      next.frozenUntilHuman = true;
      next.freezeInfo = {
        phaseId: phase.id,
        severity: parsed.severity!,
        // Sprint number may be unknown if the freeze happens off the normal
        // path — surface the template placeholder instead of a bogus "00".
        artifactPath: securityReviewArtifactRel(next.sprintNumber ?? SPRINT_PLACEHOLDER),
      };
      return next; // phaseIndex held at the review phase
    }

    if (action.kind === "loop-back" && targetIndex >= 0 && !loopbacksEnabled()) {
      // KSTACK_PI_LOOPBACKS=off: negative verdicts pause instead of retrying
      // (pre-loop behavior; the human decides what happens next).
      next.status = "paused";
      next.pausedReason = `loopback-disabled:${phase.id}`;
      return next;
    }

    if (action.kind === "loop-back" && targetIndex >= 0) {
      // The purge covers EVERY phase that re-executes: the loop target plus
      // all phases between it and this gate (phases[targetIndex..phaseIndex]).
      purgeStepResults(next.results, opts!.phases!, targetIndex, state.phaseIndex);
      const ceiling = ceilingFor(phase.loopBackTo, phase.maxAttempts);
      const runsDone = (next.attempts[phase.loopBackTo] ?? 0) + 1;
      next.attempts[phase.loopBackTo] = runsDone;
      if (runsDone >= ceiling) {
        // Exhaustion ⇒ paused + user notified; phaseIndex stays AT the gate
        // phase — forceContinuePastGate() performs the +1 when the human
        // accepts, or the panel re-runs the gate for another verified attempt.
        next.status = "paused";
        next.pausedReason = `loop-exhausted:${phase.loopBackTo} after ${runsDone} runs`;
        return next;
      }
      next.phaseIndex = targetIndex;
      next.status = "active";
      next.retryContext = {
        targetPhaseId: phase.loopBackTo,
        attempt: runsDone + 1,
        maxAttempts: ceiling,
        feedback: buildRetryFeedback(parsed, phase.feedbackFrom ?? phase.id, cwd, sprintNumber),
      };
      return next;
    }

    // Approved: loop over — reset the shared counter and continue linearly.
    delete next.attempts[phase.loopBackTo];
    next.retryContext = undefined;
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

/** D4 panel choice 1: treat the parked phase as approved and continue linearly. */
export function forceApproveParked(state: WorkflowState, phases?: WorkflowPhase[]): WorkflowState {
  const phaseId = state.verdictPark!;
  // Reset the loop target's attempt counter — same contract as
  // forceContinuePastGate: the human approved moving on, so the NEXT gate
  // must get a fresh ceiling rather than inheriting a burned one.
  const gate = phases?.[state.phaseIndex];
  const attempts = { ...(state.attempts ?? {}) };
  if (gate?.loopBackTo) delete attempts[gate.loopBackTo];
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
    attempts,
    results: { ...state.results, [phaseId]: { status: "completed", summary: "Continued as approved by explicit user decision (verdict was unreadable)." } },
  };
}

/**
 * D4 panel choice 2: send the looped phase back to work with context, without
 * burning an attempt. `extraFeedback` carries the typed answer of the
 * "Other…" escape when provided.
 */
export function returnParkedWithContext(state: WorkflowState, phases: WorkflowPhase[], extraFeedback?: string, cwd: string = process.cwd()): WorkflowState | null {
  const phaseId = state.verdictPark!;
  const phase = phases.find((p) => p.id === phaseId);
  if (!phase?.loopBackTo) return null;
  const targetIndex = phases.findIndex((p) => p.id === phase.loopBackTo);
  if (targetIndex < 0) return null;
  const prior = state.pendingVerdict?.parsed;
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
    pausedReason: undefined,
    retryContext: {
      targetPhaseId: phase.loopBackTo,
      attempt: (state.attempts?.[phase.loopBackTo] ?? 0) + 1,
      maxAttempts: ceilingFor(phase.loopBackTo, phase.maxAttempts),
      feedback:
        [
          prior ? buildRetryFeedback(prior, phase.feedbackFrom ?? phase.id, cwd, state.sprintNumber) : "",
          extraFeedback,
        ]
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
  const next: WorkflowState = { ...state, frozenUntilHuman: false, freezeInfo: undefined, pausedReason: undefined, status: "active", stepIndex: undefined, results: { ...state.results } };
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
 * The attempt counter of the gate's loop TARGET is reset: the ceiling is
 * documented as CONSECUTIVE reruns per review gate (config.ts), and the next
 * gate (e.g. qa-verdict after an accepted devsecops-review) must get a fresh
 * budget instead of parking on its first rejection with zero rework.
 */
export function forceContinuePastGate(state: WorkflowState, phases?: WorkflowPhase[]): WorkflowState {
  const gate = phases?.[state.phaseIndex];
  const attempts = { ...(state.attempts ?? {}) };
  if (gate?.loopBackTo) delete attempts[gate.loopBackTo];
  // INV-01: moving phaseIndex clears stepIndex (stale cursor → skipped gates).
  return { ...state, status: "active", phaseIndex: state.phaseIndex + 1, stepIndex: undefined, pendingVerdict: undefined, pausedReason: undefined, attempts };
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
  return { ...state, status: "active" };
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
    state: { ...state, results: { ...state.results, [key]: result }, stepIndex: si + 1 },
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
  // attempt must not survive to misroute the rerun.
  return { ...state, status: "active", pausedReason: undefined, verdictPark: undefined, pendingVerdict: undefined };
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
  if (gatePhase?.loopBackTo) {
    const ceiling = ceilingFor(gatePhase.loopBackTo, gatePhase.maxAttempts);
    // ceiling - 2, deliberately unclamped: a ceiling of 1 or 2 must still
    // grant the promised ONE verified run (negative counters make the next
    // rejection's runsDone = attempts + 1 < ceiling).
    attempts[gatePhase.loopBackTo] = ceiling - 2;
  }
  // Re-running the gate phase restarts it — INV-01: a stale step cursor must
  // not carry into the re-run (harmless today: no stepped phase is a gate).
  const next: WorkflowState = { ...state, status: "active", stepIndex: undefined, pausedReason: undefined, attempts, results: { ...state.results } };
  // INV-04: the gate phase re-runs — purge its attempt-local step keys.
  purgeStepResults(next.results, phases, state.phaseIndex, state.phaseIndex);
  return next;
}
