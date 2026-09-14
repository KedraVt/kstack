import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowState, PhaseResult, WorkflowPhase, ParsedVerdict } from "./types.ts";
import { sprintMaxAttempts, sprintArchMaxAttempts, loopbacksEnabled, verdictsEnabled } from "./config.ts";
import { buildRetryFeedback, PHASE_EXPECTATIONS, NEGATIVE_VALUES } from "./verdicts.ts";
import { securityReviewArtifactRel, SPRINT_PLACEHOLDER } from "./artifacts.ts";

const ENTRY_TYPE = "gstack-wf-state";

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
        return state;
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
    version: 2,
    attempts: {},
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
  if (!expectations) return { kind: "advance" }; // non-gated phase (defensive)

  let sawNegative = false;
  for (const [variable, allowed] of Object.entries(expectations)) {
    const value = v[variable];
    if (value === undefined) continue; // optional variable for this phase
    if (NEGATIVE_VALUES.has(value)) {
      sawNegative = true;
      continue;
    }
    if (!allowed.includes(value)) {
      // Whitelisted globally but off-map here (e.g. `status == failed` at QA):
      // ambiguous intent ⇒ human decision, never default-advance.
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
  const next: WorkflowState = {
    ...state,
    attempts: { ...(state.attempts ?? {}) },
    results: { ...state.results, [phaseId]: result },
    pendingVerdict: undefined,
    verdictPark: undefined,
    pausedReason: undefined,
  };

  if (result.status === "failed") {
    next.status = "paused";
    return next;
  }

  // Clear the retry marker when its target phase completes again.
  if (next.retryContext && next.retryContext.targetPhaseId === phaseId) {
    next.retryContext = undefined;
  }

  const phase = opts?.phases?.find((p) => p.id === phaseId);
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
  const parsed = state.pendingVerdict?.parsed ?? null;
  if (phase?.loopBackTo && parsed) {
    const action = routeVerdict(phase.id, parsed);

    if (action.kind === "park") {
      // BUG-1 fail-closed: whitelisted-but-unroutable verdict ⇒ D4 panel,
      // WITHOUT recording completion or burning an attempt.
      return parkForUnreadableVerdict({ ...state, pendingVerdict: state.pendingVerdict }, phase.id);
    }

    const targetIndex = opts!.phases!.findIndex((p) => p.id === phase.loopBackTo);
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
      // GSTACK_PI_LOOPBACKS=off: negative verdicts pause instead of retrying
      // (pre-loop behavior; the human decides what happens next).
      next.status = "paused";
      next.pausedReason = `loopback-disabled:${phase.id}`;
      return next;
    }

    if (action.kind === "loop-back" && targetIndex >= 0) {
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
 * parsed. Park WITHOUT recording completion or incrementing any attempt —
 * only the interactive panel in command.ts resolves this.
 */
export function parkForUnreadableVerdict(state: WorkflowState, phaseId: string): WorkflowState {
  if (state.verdictPark) return state; // idempotent
  return { ...state, status: "paused", verdictPark: phaseId, pausedReason: `verdict-unreadable:${phaseId}` };
}

/** D4 panel choice 1: treat the parked phase as approved and continue linearly. */
export function forceApproveParked(state: WorkflowState): WorkflowState {
  const phaseId = state.verdictPark!;
  return {
    ...state,
    status: "active",
    phaseIndex: state.phaseIndex + 1,
    verdictPark: undefined,
    pendingVerdict: undefined,
    pausedReason: undefined,
    results: { ...state.results, [phaseId]: { status: "completed", summary: "Continued as approved by explicit user decision (verdict was unreadable)." } },
  };
}

/**
 * D4 panel choice 2: send the looped phase back to work with context, without
 * burning an attempt. `extraFeedback` carries the typed answer of the
 * "Other…" escape when provided.
 */
export function returnParkedWithContext(state: WorkflowState, phases: WorkflowPhase[], extraFeedback?: string): WorkflowState | null {
  const phaseId = state.verdictPark!;
  const phase = phases.find((p) => p.id === phaseId);
  if (!phase?.loopBackTo) return null;
  const targetIndex = phases.findIndex((p) => p.id === phase.loopBackTo);
  if (targetIndex < 0) return null;
  const prior = state.pendingVerdict?.parsed;
  return {
    ...state,
    status: "active",
    phaseIndex: targetIndex,
    verdictPark: undefined,
    pausedReason: undefined,
    retryContext: {
      targetPhaseId: phase.loopBackTo,
      attempt: (state.attempts?.[phase.loopBackTo] ?? 0) + 1,
      maxAttempts: ceilingFor(phase.loopBackTo, phase.maxAttempts),
      feedback:
        [
          prior ? buildRetryFeedback(prior, phase.feedbackFrom ?? phase.id, process.cwd(), state.sprintNumber) : "",
          extraFeedback,
        ]
          .filter(Boolean)
          .join("\n\n") || "(no structured blockers extracted — see the phase report above)",
    },
  };
}

/** D3 unfreeze: clear the freeze; caller then advances manually. */
export function unfreeze(state: WorkflowState): WorkflowState {
  return { ...state, frozenUntilHuman: false, freezeInfo: undefined, pausedReason: undefined, status: "active" };
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
  return { ...state, status: "active", phaseIndex: state.phaseIndex + 1, pendingVerdict: undefined, pausedReason: undefined, attempts };
}

/**
 * When the just-completed phase is a manual-gate phase, park the workflow in
 * awaiting_approval. The phaseIndex already points at the next phase so
 * approval (/gstack next) simply resumes execution.
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
// still generating after gstack_advance returned), steals editor focus, and
// defaults to "Yes" on Enter — so a user typing "no, skip QA" literally
// LAUNCHED the QA phase they were refusing. Prompting from a background chain
// cannot be a real decision point, so the decision now lives where every other
// human decision lives: the foreground /gstack panel (Run / Skip / Abort),
// exactly like the manual decision gates. The model cannot bypass it: while
// parked, gstack_advance refuses and the executor never enters the phase.

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

export function pauseState(state: WorkflowState): WorkflowState {
  return { ...state, status: "paused" };
}

export function abortState(state: WorkflowState): WorkflowState {
  return { ...state, status: "aborted" };
}

export function resumeState(state: WorkflowState): WorkflowState {
  return { ...state, status: "active" };
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
    attempts[gatePhase.loopBackTo] = Math.max(0, ceiling - 2);
  }
  return { ...state, status: "active", pausedReason: undefined, attempts };
}
