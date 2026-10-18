import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowState, WorkflowContext, GitContext, WorkflowPhase } from "./types.ts";
import { getWorkflow } from "./workflows.ts";
import { saveState, advancePhase, gateOptionalPhase, gateEntry, parkForUnreadableVerdict, loadActiveState, recordStepResult, type AdvanceOptions } from "./state.ts";
import { resolvePhaseEnabled, stepSkippedByVars } from "./enabled.ts";
import { probeCapabilities, capabilitiesUnprobed, missingRequires, missingPrefers } from "./capabilities.ts";
import { buildPhaseInstructions, buildDeterministicPlan, mainContractFor, buildStepInstructions, buildStepTask, interpolateStepTask, resolvePlanFilePath, buildRecordContract, sprintDodSuffix } from "./templates.ts";
import { detectGitContext, type ExecFn } from "./git.ts";
import { runSubagent, type SpawnRequest, type SpawnResult, resolveTimeoutMs } from "./spawn.ts";
import { parseHandoffVerdicts, verifyArtifactVerdicts, mergeParseOutcomes } from "./verdicts.ts";
import { computeNextSprintNumber } from "./sprint.ts";
import { deterministicSubagents, skillsEnabled, optionalPhases, maxRunTokens, delegationBudgetMs, modelTierFor, verdictsEnabled, timeoutClassFor, manualGates } from "./config.ts";
import { ensureRun, recordDelegatedStep, writeRunReport, recordLiveness, recordTokens, totalTokensUsed } from "./telemetry.ts";
import { extractHandoff } from "./handoff.ts";
import { isRefutedStrategy, isValidatedStrategy } from "./skip.ts";
import { replaceExact } from "./text.ts";
import { appendLedger } from "./ledger.ts";
import { reportCliPath, verdictKeysFor } from "./records.ts";
import { newStepRun, feedStepEvent, detectStuck, checkStepBudgets, stepBudgetDefaults, beginStepWatch, endStepWatch } from "./stuck.ts";
import { phaseArtifactPaths, cleanupEphemeralArtifacts } from "./artifacts.ts";
import { existsSync } from "node:fs";

// --- Sequential-chain resilience (STEP 2f) -----------------------------------

/** Delay before the single allowed retry of a transient chain-step failure.
 * Timeouts get a long cooldown (give the provider room to recover); fast
 * failures are usually transient provider hiccups — retry quickly instead of
 * burning 30s on every blip. */
export const RETRY_DELAY_MS = 30_000;
export const FAST_RETRY_DELAY_MS = 5_000;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transient failures may recover on a single retry: timeout, abort, or a
 * non-zero exit without any output. Configuration errors (unknown agent,
 * spawn ENOENT, bad setup) are HARD and propagate immediately.
 */
export function isTransientFailure(result: SpawnResult): boolean {
  if (result.ok) return false;
  if (result.configError) return false;
  if (result.timedOut) return true;
  return (result.exitCode ?? 1) !== 0 && !result.output;
}

/**
 * Decision for attempt N (1-based). At most one retry is allowed; it runs
 * with a +50% timeout limit and a failure-class-dependent cooldown.
 */
export function retryDecision(result: SpawnResult, attempt: number): { retry: boolean; timeoutScale: number; delayMs: number } {
  if (attempt >= 2 || !isTransientFailure(result)) {
    return { retry: false, timeoutScale: 1, delayMs: 0 };
  }
  return {
    retry: true,
    timeoutScale: 1.5,
    delayMs: result.timedOut ? RETRY_DELAY_MS : FAST_RETRY_DELAY_MS,
  };
}

/**
 * Timeout for the single allowed retry (B2 fix): the REQUEST's own resolved
 * limit — per-phase timeout class included via resolveTimeoutMs — scaled by
 * the retry decision. Deriving from defaultTimeoutMs() instead would ignore
 * the phase class and could make the "raised" retry limit LOWER than the
 * original attempt's (e.g. class 900s vs default 300s × 1.5 = 450s).
 */
export function retryTimeoutMs(req: Pick<SpawnRequest, "timeoutMs" | "phaseId">, timeoutScale: number): number {
  return Math.round(resolveTimeoutMs(req) * timeoutScale);
}

/**
 * STEP 4d reopen decision (pure, B4): the collapsed validate-only root-cause
 * step declared REFUTED — the full scout→planner chain MUST be rebuilt and
 * re-run. Extracted for tests; the async path may never skip the reopen.
 */
export function shouldReopenFullChain(wasCollapsed: boolean, lastOutput: string | undefined): boolean {
  return wasCollapsed && isRefutedStrategy(lastOutput ?? "");
}

// --- Runtime liveness -------------------------------------------------------
// Background phase chains (deterministic subagent runs) intentionally outlive
// the tool/command handler that started them. But if the user reloads the
// session mid-chain, pi invalidates the captured ExtensionContext; ANY later
// ctx.ui access then throws "Extension ctx is stale…" and, being uncaught in a
// floating promise, kills pi entirely (uncaughtException). These guards make
// staleness detectable and non-fatal.

/** Bumped whenever the session is replaced/reloaded/forked. */
let runtimeEpoch = 0;

export function invalidateRuntime(): void {
  runtimeEpoch++;
}

/**
 * Probe whether this context is still valid. Merely touching the `ui` getter
 * triggers pi's assertActive(), which throws on stale contexts.
 */
export function ctxAlive(ctx: unknown): boolean {
  try {
    void (ctx as any).ui;
    return true;
  } catch {
    return false;
  }
}

/**
 * Persistent breadcrumb for delegation milestones. Written as a session
 * entry so progress and failures survive crashes and exports — the field
 * lesson from the 2026-08-23 incident was total silence between the advance
 * and the host crash. Best-effort by design: telemetry must never kill the
 * chain (and every callback that could throw is guarded at its source).
 */
function delegationEvent(pi: ExtensionAPI, data: Record<string, unknown>): void {
  try {
    pi.appendEntry("kstack-delegation-event", { at: new Date().toISOString(), ...data });
  } catch {
    /* best-effort */
  }
}

/**
 * Crash forensics: if a previous run died mid-delegation (host killed by an
 * uncaught exception), the last delegation event never reached a terminal
 * state. Annotate it so the restart has an explicit trail instead of silence.
 */
export function annotateOrphanedDelegation(pi: ExtensionAPI, ctx: ExtensionContext): void {
  try {
    const entries = ((ctx.sessionManager as any)?.getEntries?.() ?? []) as any[];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type === "custom" && e.customType === "kstack-delegation-event") {
        if (e.data?.event === "started" || e.data?.event === "retrying") {
          delegationEvent(pi, {
            phaseId: e.data.phaseId,
            agent: e.data.agent,
            event: "interrupted",
            detail: "previous run ended mid-delegation (host restart?)",
          });
        }
        break;
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Fire-and-forget phase execution. Errors are never allowed to become
 * uncaught rejections: stale-context failures are dropped silently, anything
 * else is reported best-effort (the report itself is guarded against a stale
 * context).
 *
 * Duplicate-chain guard (2026-08-31 session post-mortem): the user refused the
 * investigate `regression-qa` phase in the confirm dialog — "Skipped by user"
 * was recorded and the workflow completed — yet a SECOND chain for the same
 * phase (relaunched via /kstack → Resume while the first dialog was still
 * pending) ran the QA worker 15 seconds later. Each relaunch spawned a new
 * dialog that disposed the previous one (auto-resolving it to "No"), so the
 * refusal only ever governed one of N racing chains, and the last standing
 * dialog took the Enter-default "Yes". A phase therefore must never have two
 * concurrent chains: the in-flight registry refuses any relaunch while one is
 * still running in this process.
 *
 * In-flight key is `wf:phaseIndex` (design §117-120 sketched
 * `wf:phaseIndex:stepIndex` — equivalent here: a stepped phase's whole
 * step lifecycle sits inside ONE launchPhase hold, so the phase-level key
 * already blocks every mid-delegation duplicate).
 */
const inFlightPhases = new Set<string>();

/** Test hook: observe whether a phase currently has a running chain. */
export function isPhaseInFlight(workflowId: string, phaseIndex: number): boolean {
  return inFlightPhases.has(`${workflowId}:${phaseIndex}`);
}

/**
 * Abort support: drop the in-flight marker so a restarted workflow of the same
 * id can launch its phases immediately instead of being refused by the
 * duplicate-chain guard until the aborted run's orphaned chain settles.
 */
export function releasePhaseInFlight(workflowId: string, phaseIndex: number): void {
  inFlightPhases.delete(`${workflowId}:${phaseIndex}`);
}

/**
 * Advance-block guard (audit fix, same class as the 2026-08-31 post-mortem).
 * Two mechanical blocks, both "the state machine decides, not the model":
 *
 * 1. Manual gate (awaiting_approval): after a decision phase completes, ONLY
 *    /kstack next or the /kstack panel may continue. Without this check a
 *    second kstack_advance in the same turn would record the NEXT phase —
 *    which never ran — as completed, silently bypassing the gate (the parked
 *    state points at a subagent phase with no chain in flight, so the
 *    delegation guard alone cannot catch it).
 *
 * 2. In-flight delegation: a kstack_advance while the deterministic
 *    delegation for the CURRENT phase is still running would record the phase
 *    completed before its work exists; when the real chain then delivers its
 *    results, the follow-up advance silently skips the NEXT phase (e.g. a
 *    user typing mid-delegation — the input router tells the model to
 *    "continue the current phase", inviting exactly this).
 */
export function advanceBlockReason(state: WorkflowState): string | null {
  if (state.status === "awaiting_approval") {
    return `the workflow is PARKED awaiting user approval (manual decision gate) — only /kstack next or the /kstack panel may continue it`;
  }
  // Fail-closed parks (F1 fix): EVERY paused state is a human decision point
  // (security freeze, loop exhaustion, numbering anomaly, unreadable verdict,
  // failed phase). A repeat kstack_advance call must never advance past one —
  // pendingVerdict is cleared by then, so verdict routing would be skipped and
  // the park bypassed on the model's say-so.
  if (state.status === "paused") {
    const reason = state.pausedReason ?? "";
    if (state.frozenUntilHuman || reason.startsWith("security-freeze:")) {
      return `the sprint is FROZEN by a critical/high security rejection — only the /kstack panel (with the exact confirmation phrase) may unfreeze it`;
    }
    if (state.verdictPark) {
      return `the phase's verdict was unreadable — only the /kstack panel may continue, return or abort (no attempt was burned)`;
    }
    return `the workflow is PAUSED${reason ? ` (${reason})` : ""} — a human decision is pending; only /kstack may resume, re-run or abort it`;
  }
  if (isPhaseInFlight(state.workflowId, state.phaseIndex)) {
    return `the subagent delegation for phase ${state.phaseIndex + 1} of "${state.workflowId}" is still running — wait for its results before calling kstack_advance`;
  }
  return null;
}

export function launchPhase(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: WorkflowState,
  run: (pi: ExtensionAPI, ctx: ExtensionContext, state: WorkflowState) => Promise<void> = executeCurrentPhase,
): void {
  const key = `${state.workflowId}:${state.phaseIndex}`;
  if (inFlightPhases.has(key)) {
    try {
      ctx.ui.notify(
        `kstack: a chain for workflow "${state.workflowId}" phase ${state.phaseIndex + 1} is already running — ignoring the duplicate launch.`,
        "warning",
      );
    } catch {
      /* stale ctx */
    }
    return;
  }
  inFlightPhases.add(key);
  void run(pi, ctx, state)
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (/stale/i.test(msg)) return;
      try {
        ctx.ui.notify(`kstack error: ${msg}`, "error");
      } catch {
        /* context went stale while reporting — nothing left to do */
      }
    })
    .finally(() => {
      inFlightPhases.delete(key);
    });
}

export async function executeCurrentPhase(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: WorkflowState,
  opts?: { approvedOptional?: boolean; execGit?: ExecFn; spawnFn?: typeof runSubagent },
): Promise<void> {
  const startEpoch = runtimeEpoch;
  const alive = (): boolean => runtimeEpoch === startEpoch && ctxAlive(ctx);
  const notify = (msg: string, level: "info" | "warning" | "error") => {
    try {
      ctx.ui.notify(msg, level);
    } catch {
      /* stale ctx — drop the notification rather than crash */
    }
  };

  if (!alive()) return;

  const workflow = getWorkflow(state.workflowId);
  if (!workflow) {
    notify(`Unknown workflow: ${state.workflowId}`, "error");
    return;
  }
  // STEP 0 telemetry: make sure this run is being accumulated.
  ensureRun(state.workflowId);
  // Crash forensics: annotate a delegation that never reached a terminal
  // event in the previous run (host died mid-flight).
  annotateOrphanedDelegation(pi, ctx);

  const phase = workflow.phases[state.phaseIndex];
  // state.status === "completed" with a phase still under phaseIndex happens
  // when the LAST phase was skipped: advancePhase leaves the index parked on
  // it, so without this check the skipWhen/optional recursion re-entered the
  // same phase and skipped forever.
  if (!phase || state.status === "completed") {
    // Workflow completed: flush the structured run report (STEP 0 telemetry).
    writeRunReport(ctx.cwd, state.workflowId);
    // S4/§10.5: ephemeral THINK docs die with the run — delete at terminal
    // status, ledger-note every failure (cleanup never crashes the finish).
    if ((state.ephemeralArtifacts ?? []).length > 0) {
      const { deleted, failed } = cleanupEphemeralArtifacts(ctx.cwd, state.ephemeralArtifacts!, (m) => notify(m, "warning"));
      appendLedger(ctx.cwd, state, {
        kind: "phase",
        phaseId: state.workflowId,
        payload: { summary: `ephemeral cleanup: ${deleted.length} deleted${failed.length ? `, ${failed.length} failed` : ""}`, artifacts: deleted },
      }, () => {});
      state = { ...state, ephemeralArtifacts: [] };
    }
    saveState(pi, { ...state, status: "completed" });
    try {
      ctx.ui.setStatus("kstack", undefined);
    } catch {
      /* stale ctx */
    }
    notify(`Workflow "${workflow.name}" completed!`, "info");
    return;
  }

  const git = await detectGitContext(ctx.cwd, opts?.execGit);
  if (!alive()) return;
  const wfCtx: WorkflowContext = { state, git, cwd: ctx.cwd };

  // Sprint numbering hook (plan E5): computed ONCE at P02 entry.
  // Anomaly ⇒ pause + human decision panel; never guess a number.
  if (state.workflowId === "sprint" && phase.id === "user-story" && state.sprintNumber === undefined) {
    const discovery = computeNextSprintNumber(ctx.cwd);
    if (discovery.anomaly) {
      const parked = { ...state, status: "paused" as const, pausedReason: `anomaly:${discovery.anomaly}` };
      saveState(pi, parked);
      setKstackStatus(ctx, parked, workflow);
      notify(`kstack sprint: sprint numbering anomaly — ${discovery.anomaly}. Resolve manually, then resume via /kstack (the panel re-checks the numbering).`, "warning");
      return;
    }
    const numbered = { ...state, sprintNumber: discovery.next };
    saveState(pi, numbered);
    state = numbered;
    wfCtx.state = numbered;
    notify(`kstack sprint: assigned sprint number ${String(discovery.next).padStart(2, "0")}.`, "info");
  }

  // Branch enforcement: gates that loop back to "implement" audit the BE/FE
  // chain's diff — meaningless if a specialist committed to main/master
  // (subagents share the host's git tree). architect-gate is deliberately out:
  // it loops to system-design and reviews documents — main is legitimate
  // there. Fail closed like every other park: the /kstack panel's Resume
  // re-runs this function, which re-detects the branch.
  if (state.workflowId === "sprint" && phase.loopBackTo === "implement" && git.isMainBranch) {
    const parked = { ...state, status: "paused" as const, pausedReason: `branch-violation:${phase.id} on ${git.branch}` };
    saveState(pi, parked);
    setKstackStatus(ctx, parked, workflow);
    notify(
      `kstack sprint: BRANCH VIOLATION — "${phase.id}" is a verdict gate and MASTER_DOD requires work on task/<slug> branches, but HEAD is "${git.branch}". Move the work onto a task branch, then resume via /kstack.`,
      "warning",
    );
    return;
  }

  // S3 step model: a stepped phase with stepIndex set is ALREADY inside —
  // entry-time gates (skipWhen / optional / entry) fired on first entry and
  // must never re-fire on step transitions or mid-step resumes.
  const steps = phase.steps;
  const stepped = !!(steps && steps.length > 0);
  const insidePhase = stepped && state.stepIndex !== undefined;

  // S4/TASK_05 (ADR-24): enabled:"off"/"auto" resolve at ARRIVAL — autoWhen
  // reads lastVerdicts/vars populated mid-run, so it must re-evaluate on
  // every entry (never cached). A throwing resolver fails closed to "off"
  // with a ledger note; every skip decision lands in results + ledger.
  if (!insidePhase) {
    const res = resolvePhaseEnabled(phase, wfCtx);
    if (res.enabled === "off") {
      const summary = res.note ?? (phase.enabled === "auto" ? "Auto-skipped: autoWhen false" : "Auto-skipped: enabled:off");
      const skipped = advancePhase(state, phase.id, { status: "skipped", summary }, workflow.phases.length, { phases: workflow.phases, cwd: ctx.cwd });
      saveState(pi, skipped);
      appendLedger(ctx.cwd, state, { kind: "gate", phaseId: phase.id, payload: { gateId: phase.id, decision: "skip", summary } }, (m) => notify(m, "warning"));
      return executeCurrentPhase(pi, ctx, skipped);
    }
  }

  if (!insidePhase && phase.skipWhen?.(wfCtx)) {
    const skipped = advancePhase(state, phase.id, { status: "skipped", summary: "Auto-skipped by condition" }, workflow.phases.length);
    saveState(pi, skipped);
    return executeCurrentPhase(pi, ctx, skipped);
  }

  if (phase.optional && !insidePhase) {
    // S3/D20: a selection-gate override takes precedence over the env mode —
    // "human" behaves exactly like today's "ask" park.
    const override = state.gateMode === "selection-gate" ? state.gateOverrides?.[phase.id] : undefined;
    const mode = override === "human" ? "ask" : override ?? optionalPhases();
    if (mode === "ask" && !opts?.approvedOptional) {
      // STEP 2g v2 — optional-phase decision gate. The previous flow prompted
      // `ctx.ui.confirm` HERE, inside this fire-and-forget background chain:
      // the dialog appeared mid-stream (the model keeps generating after
      // kstack_advance returned), stole editor focus, and defaulted to "Yes"
      // on Enter — a user typing "no, skip QA" + Enter literally launched the
      // QA phase they were refusing. A prompt from a background chain is not
      // a decision point. Park instead: the foreground /kstack panel owns the
      // Run/Skip/Abort decision (command.ts), like every other manual gate.
      const gated = gateOptionalPhase(state);
      saveState(pi, gated);
      appendLedger(ctx.cwd, state, { kind: "gate", phaseId: phase.id, payload: { gateId: phase.id, decision: "human" } }, (m) => notify(m, "warning"));
      notify(
        `kstack: optional phase "${phase.name}" (${state.phaseIndex + 1}/${workflow.phases.length}) awaits your decision — run /kstack to Run it, Skip it, or Abort.`,
        "info",
      );
      return;
    }
    if (mode === "skip" && !opts?.approvedOptional) {
      // Promptless background behavior (fire-and-forget runs, stale contexts):
      // record the skip explicitly rather than abandoning the chain silently.
      const skipped = advancePhase(
        state,
        phase.id,
        { status: "skipped", summary: "Auto-skipped: KSTACK_PI_OPTIONAL_PHASES=skip" },
        workflow.phases.length,
      );
      saveState(pi, skipped);
      appendLedger(ctx.cwd, state, { kind: "gate", phaseId: phase.id, payload: { gateId: phase.id, decision: "skip" } }, (m) => notify(m, "warning"));
      return executeCurrentPhase(pi, ctx, skipped);
    }
    // mode === "auto", or the user explicitly approved this phase via the
    // /kstack decision panel (approvedOptional) — fall through and run it.
    appendLedger(ctx.cwd, state, { kind: "gate", phaseId: phase.id, payload: { gateId: phase.id, decision: opts?.approvedOptional ? "run" : "auto" } }, (m) => notify(m, "warning"));
  }

  // Entry gate for side-effect phases (commit-archive): advance:"manual"
  // alone can only park AFTER the phase completes — far too late when the
  // phase's own delegation commits and archives. Park BEFORE anything runs;
  // the /kstack approve path flips entryGate to "approved" (cleared by
  // advancePhase when the phase completes).
  // S3/D20: "auto" on the phase's ⚠ entry row pre-approves the side effect —
  // no entry park (and no post-completion park either — index.ts consults the
  // same override for willManualGate).
  const entryOverride = state.gateMode === "selection-gate" ? state.gateOverrides?.[phase.id] : undefined;
  if (
    !insidePhase &&
    entryOverride !== "auto" &&
    deterministicSubagents() &&
    phase.execution === "subagent" &&
    manualGates() &&
    phase.advance === "manual" &&
    state.entryGate !== "approved"
  ) {
    const gated = gateEntry(state);
    saveState(pi, gated);
    setKstackStatus(ctx, gated, workflow);
    appendLedger(ctx.cwd, state, { kind: "gate", phaseId: phase.id, payload: { gateId: phase.id, decision: "human" } }, (m) => notify(m, "warning"));
    notify(
      `kstack: "${phase.name}" is a human-gated side-effect phase — it has NOT run yet. Approve via /kstack (Run) before it executes.`,
      "info",
    );
    return;
  }
  if (
    !insidePhase &&
    entryOverride === "auto" &&
    deterministicSubagents() &&
    phase.execution === "subagent" &&
    manualGates() &&
    phase.advance === "manual" &&
    state.entryGate !== "approved"
  ) {
    appendLedger(ctx.cwd, state, { kind: "gate", phaseId: phase.id, payload: { gateId: phase.id, decision: "auto" } }, (m) => notify(m, "warning"));
  }

  // S3/INV-01: first entry into a stepped phase persists stepIndex. From here
  // on, the step runner dispatches on phase.steps[stepIndex] — main steps get
  // instructions; delegated steps spawn through the same chain machinery.
  if (stepped && state.stepIndex === undefined) {
    state = { ...state, stepIndex: 0 };
    saveState(pi, state);
    wfCtx.state = state;
  }
  const stepIndex = stepped ? Math.min(state.stepIndex ?? 0, steps!.length - 1) : undefined;
  const step = stepped ? steps![stepIndex!] : undefined;

  // S4/TASK_05-06: declarative step skips — skipWhen {var,equals} against
  // state.vars (per-dispatch, unlike entry gates) and requires:<caps> against
  // state.capabilities. The skipped step records a "skipped" result; when
  // every step of the phase skipped, the phase itself reports "skipped" so
  // onComplete back-edges never fire off an untouched phase (INV-16).
  const skipStep = async (note: string): Promise<void> => {
    const rec = recordStepResult(state, phase, { status: "skipped", summary: note });
    if (!rec) return;
    saveState(pi, rec.state);
    appendLedger(ctx.cwd, state, { kind: "step", phaseId: phase.id, stepId: step!.id, payload: { summary: note } }, (m) => notify(m, "warning"));
    if (!rec.isLast) return executeCurrentPhase(pi, ctx, rec.state);
    const ran = Object.entries(rec.state.results).some(([k, r]) => k.startsWith(phase.id + ".") && r.status === "completed");
    const next = advancePhase(rec.state, phase.id, { status: ran ? "completed" : "skipped", summary: note }, workflow.phases.length, { phases: workflow.phases, cwd: ctx.cwd });
    saveState(pi, next);
    return executeCurrentPhase(pi, ctx, next);
  };
  if (step && stepSkippedByVars(step, state.vars)) {
    return skipStep(`Auto-skipped: skipWhen ${step.skipWhen!.var}==${step.skipWhen!.equals}`);
  }

  // S4/TASK_06 capability gate (ADR-16): `requires` missing ⇒ skip with a
  // ledger note; `prefers` missing ⇒ run degraded — the spawned task (or
  // main-step instructions) carries `~capability: no-<cap>` notes.
  let degradedNote = "";
  if (step && (step.requires?.length || step.prefers?.length)) {
    if (capabilitiesUnprobed(state.capabilities)) {
      // A run started without `kstack init`: probe lazily ONCE and stamp the
      // result — `{}` is the unprobed convention, not "everything absent".
      state = { ...state, capabilities: probeCapabilities() };
      saveState(pi, state);
      wfCtx.state = state;
    }
    const missing = missingRequires(step, state.capabilities);
    if (missing.length > 0) {
      return skipStep(`Auto-skipped: missing required capability ${missing.join(", ")}`);
    }
    const degraded = missingPrefers(step, state.capabilities);
    if (degraded.length > 0) {
      degradedNote = degraded.map((c) => `~capability: no-${c}`).join(" ");
      appendLedger(ctx.cwd, state, { kind: "step", phaseId: phase.id, stepId: step.id, payload: { summary: `degraded: ${degradedNote}` } }, (m) => notify(m, "warning"));
    }
  }

  // S4/TASK_07 ⚠ entry gate on side-effect STEPS (ADR-16/glossary): parks
  // BEFORE the step runs — delegated or main makes no difference, the side
  // effect IS the step. The /kstack approve path flips entryGate to
  // "approved"; a selection-gate "auto" row pre-approves the whole phase's
  // side effects. recordStepResult clears the flag when the gated step
  // completes, so each side-effect step gates independently.
  const stepGateOverride = state.gateMode === "selection-gate" ? state.gateOverrides?.[phase.id] : undefined;
  if (step?.sideEffect && manualGates() && state.entryGate !== "approved" && stepGateOverride !== "auto") {
    const gated = gateEntry(state);
    saveState(pi, gated);
    setKstackStatus(ctx, gated, workflow);
    appendLedger(ctx.cwd, state, { kind: "gate", phaseId: phase.id, stepId: step.id, payload: { gateId: `${phase.id}.${step.id}`, decision: "human" } }, (m) => notify(m, "warning"));
    notify(
      `kstack: step "${step.id}" (${phase.name}) is a human-gated side-effect step — it has NOT run yet. Approve via /kstack before it executes.`,
      "info",
    );
    return;
  }
  if (step?.sideEffect && state.entryGate !== "approved" && stepGateOverride === "auto") {
    appendLedger(ctx.cwd, state, { kind: "gate", phaseId: phase.id, stepId: step.id, payload: { gateId: `${phase.id}.${step.id}`, decision: "auto" } }, (m) => notify(m, "warning"));
  }

  setKstackStatus(ctx, state, workflow);

  // S4/TASK_07 resume-mode hint (§10.7): an interrupted step re-issues with
  // a "continue from disk state" note on the volatile tail — the stable
  // prefix stays byte-identical, builders read diff+tests as the oracle.
  const resumeHint = state.resumeMode
    ? "\n\n[resume] This step was interrupted and is being re-issued — continue from on-disk state (builders: read diff+tests as the oracle; writers: overwrite; appenders: dedup-check) rather than restarting from scratch."
    : "";

  // Deterministic mode: the executor spawns subagents itself for subagent
  // phases — and, in stepped phases, for delegated STEPS (step.execution).
  // Delegation no longer depends on the model choosing to call the
  // `subagent` tool — it happens by construction.
  let delegationPrefix = "";
  const delegatedStep = step !== undefined && deterministicSubagents() && step.execution === "subagent";
  const delegatedPhase = !stepped && deterministicSubagents() && phase.execution === "subagent";
  if (delegatedStep || delegatedPhase) {
    // S3/D28: delegated steps carry a transient StepRun — the stuck detector
    // and budget caps poll the raw child event stream via SpawnRequest.onEvent.
    const stepGuard: { stepId: string; trip?: string } | undefined = delegatedStep
      ? { stepId: step.id }
      : undefined;
    // TASK_04: quota/interruption flag returned by the delegation loop —
    // budget-exceeded marks it, the park below is the clean interruption stop.
    const interruption: { kind?: "quota-parked" | "run-interrupted" } = {};
    const results = await runDeterministicDelegation(
      phase,
      wfCtx,
      ctx,
      alive,
      pi,
      opts?.spawnFn ?? runSubagent,
      delegatedStep
        ? [{
            agent: step.agent ?? "worker",
            // {previous} interpolates on the step's OWN task BEFORE the skill
            // digest is embedded — interpolating the assembled task would
            // also rewrite a literal `{previous}` documented inside SKILL.md.
            // prefers-degrade: ~capability notes land INSIDE the task (the
            // report context), after interpolation.
            task:
              buildStepTask({ ...step, task: interpolateStepTask(step.task, phase, stepIndex!, wfCtx) }) +
              // Sprint execution phases carry the master DoD contract on
              // delegated steps too (chain path enforced it on chain tails).
              sprintDodSuffix(state.workflowId, phase.id) +
              // ADR-23: spawn → work → report → exit — the record contract is
              // mandatory for every deterministic delegated step.
              `\n\n${buildRecordContract(step, { workflowId: state.workflowId, phase })}` +
              (degradedNote ? `\n\n${degradedNote}` : "") + resumeHint,
            // Already interpolated — runSteps' own {previous} pass would
            // rewrite the literal token inside the embedded skill digest.
            interpolated: true,
            // ADR-23: the child learns run/phase/step ids + the report CLI
            // path from env — it can emit its own canonical record.
            env: {
              KSTACK_WORKFLOW: state.workflowId,
              KSTACK_RUN_ID: state.runId ?? "",
              KSTACK_PHASE: phase.id,
              KSTACK_STEP: step.id,
              KSTACK_REPORT: reportCliPath(),
              // kstack-report drops verdict keys outside this list (empty = none owned).
              KSTACK_VERDICT_KEYS: verdictKeysFor(state.workflowId, phase, step).join(" "),
            },
          }]
        : undefined,
      stepGuard,
      interruption,
    );
    if (!alive()) return;

    // Abort-resurrect guard (audit fix, same class as the 2026-08-31
    // post-mortem): the user may have aborted the workflow while this chain
    // was delegating. Persisting anything now (sprint verdict stash, skill
    // tracking) would append a FRESH ACTIVE state entry after the aborted one
    // and silently resurrect the workflow. No persisted workflow ⇒ the run is
    // over — drop the results instead of writing them.
    // B7 fix: when a state DOES exist, it may be a newer one (the user aborted
    // and re-started mid-delegation). Adopt the authoritative entry instead of
    // continuing to persist the stale pre-delegation snapshot over it.
    const live = loadActiveState(ctx);
    if (!live || live.workflowId !== state.workflowId || live.phaseIndex !== state.phaseIndex) {
      return;
    }
    state = live;
    wfCtx.state = live;

    // S3/D28 + TASK_04: a tripped detector or an exhausted quota parks the
    // run at the CURRENT stepIndex — resume re-delivers the same step in
    // resumeMode. Ledger kinds: stuck rules ⇒ run-interrupted, budget/quota
    // trips ⇒ quota-parked. Never a phase-verdict, never an attempt burn.
    if (stepGuard?.trip || interruption.kind) {
      const reason = stepGuard?.trip ?? `quota-parked:${phase.id}${step ? `.${step.id}` : ""}`;
      const kind =
        interruption.kind ?? (stepGuard!.trip!.startsWith("stuck:") ? "run-interrupted" : "quota-parked");
      const parked = { ...state, status: "paused" as const, pausedReason: reason, resumeMode: true };
      saveState(pi, parked);
      setKstackStatus(ctx, parked, workflow);
      // The budget-exceeded path already appended its quota-parked event
      // inside the delegation loop — only the detector trip lands here.
      if (stepGuard?.trip) {
        appendLedger(ctx.cwd, state, { kind, phaseId: phase.id, stepId: step!.id, payload: { summary: `detector trip: ${stepGuard.trip}` } }, (m) => notify(m, "warning"));
      }
      notify(`kstack: ${reason} — step paused for a human decision; resume via /kstack re-runs the step in resume mode.`, "warning");
      return;
    }

    // Sprint verdict parsing at DELEGATION time (plan B4 / D1): the raw
    // subagent outputs are the source of truth — never the main model's
    // paraphrase. Each CHAIN STEP parses independently (review W1: joining
    // outputs first would drop every non-final HANDOFF once the total passed
    // extractHandoff's whole-output threshold), then outcomes merge with
    // contradiction ⇒ null. Dual-channel check against on-disk artifacts;
    // any disagreement ⇒ parsed=null ⇒ D4 park (no attempt burned).
    // S3: the verdict is PHASE-LEVEL and comes from the FINAL step — mid-step
    // delegations never parse.
    const isLastStep = !step || stepIndex === steps!.length - 1;
    // INV-9: a phase with verdict-flagged steps gets its phase verdict ONLY
    // from the flagged kstack-report records (advancePhase merges them) — the
    // legacy HANDOFF stash stays for UNFLAGGED verdict phases (pre-migration).
    const hasFlaggedSteps = (phase.steps ?? []).some((s) => s.signal?.kind === "verdict");
    if (state.workflowId === "sprint" && phase.loopBackTo && !hasFlaggedSteps && verdictsEnabled() && isLastStep) {
      const outcome = mergeParseOutcomes(
        // B1 fix: parse the UNCAPPED rawOutput. `output` is capOutput()'d at
        // 50KB — and the ## HANDOFF section (the only channel the parser
        // reads) trails the report, so any subagent producing >50KB of output
        // would lose its verdict lines to the truncation and park the gate
        // on every realistic run. rawOutput exists precisely for this.
        results.map((r) => parseHandoffVerdicts(r.result.rawOutput || r.result.output || "")),
      );
      let parsed = outcome.parsed;
      // D4 park cause: capture whether the merge produced a verdict BEFORE the
      // artifact check can null it — a non-null start means the park is a
      // HANDOFF/disk disagreement, not an agent that emitted nothing.
      const parkCause = parsed ? "artifact-mismatch" : "no-verdict";
      if (parsed && !verifyArtifactVerdicts(parsed, ctx.cwd, state.sprintNumber)) {
        parsed = null; // HANDOFF says X, artifact disagrees ⇒ fail closed
      }
      if (!parsed) {
        const parkedState = parkForUnreadableVerdict(
          { ...state, pendingVerdict: { phaseId: phase.id, parsed: null, excerpt: outcome.lines.join("\n") } },
          phase.id,
          parkCause,
        );
        saveState(pi, parkedState);
        setKstackStatus(ctx, parkedState, workflow);
        notify(
          `kstack sprint: no trustworthy verdict found for "${phase.id}" — pipeline parked for manual review (/kstack next). No retry budget consumed.`,
          "warning",
        );
        return;
      }
      const withVerdict = { ...state, pendingVerdict: { phaseId: phase.id, parsed, excerpt: outcome.lines.join("\n") } };
      saveState(pi, withVerdict);
      state = withVerdict;
      // S3 ledger: verdict resolution lands verbatim (INV-L2).
      appendLedger(ctx.cwd, state, { kind: "verdict", phaseId: phase.id, stepId: step?.id, attempt: (state.attempts?.[phase.id] ?? 0) + 1, payload: { verdicts: { ...parsed.verdicts } } }, (m) => notify(m, "warning"));
    }

    // STEP 0 telemetry: persist per-step measurements (persistence only —
    // every number already exists on SpawnResult). S3 delegated steps record
    // the real phaseId + a separate stepId field (system-design §Report).
    for (const [chainIndex, { agent, result }] of results.entries()) {
      recordDelegatedStep({
        phaseId: phase.id,
        stepId: step?.id,
        stepIndex: step ? stepIndex! : chainIndex,
        agent,
        durationMs: result.durationMs,
        toolCalls: result.toolCalls,
        turns: result.turns,
        tokensIn: result.usage?.input,
        tokensCacheRead: result.usage?.cacheRead,
        tokensOut: result.usage?.output,
        timeoutClass: timeoutClassFor(phase.id) ?? "default",
      });
    }
    delegationPrefix = formatDelegationResults(step ? `${phase.id}.${step.id}` : phase.id, results);
    // STEP 4d: make the skip outcome explicit in what the model reviews.
    // (Phase-level chains only — steps never route through buildDeterministicPlan.)
    if (!stepped && phase.id === "root-cause" && results.length > 0) {
      const lastOutput = results[results.length - 1].result.output ?? "";
      if (isRefutedStrategy(lastOutput)) {
        delegationPrefix += "\n\n[root-cause outcome: refuted→full-reinvestigation]";
      } else if (isValidatedStrategy(lastOutput)) {
        delegationPrefix += "\n\n[root-cause outcome: validated]";
      }
    }
    // Restore the phase status line (delegation left subagent progress there).
    setKstackStatus(ctx, state, workflow);
  }

  let instructions = step
    ? buildStepInstructions(phase, step, wfCtx)
    : buildPhaseInstructions(phase, wfCtx);
  // prefers-degrade (ADR-16): main steps see the same ~capability note the
  // delegated task carried — the run continues degraded, never silently.
  if (degradedNote) instructions += `\n\n${degradedNote}`;
  // resume-mode re-issue (§10.7): same hint the delegated task carried.
  instructions += resumeHint;

  // S3 resume-gate (D28): re-delivering a phase's LAST step whose declared
  // artifact is missing keeps the step open — the note rides the volatile
  // tail so the stable instruction prefix stays byte-identical.
  if (step && insidePhase && stepIndex === steps!.length - 1) {
    const missing = phaseArtifactPaths(phase.id, ctx.cwd, state.sprintNumber, resolvePlanFilePath({ state })).filter((p) => !existsSync(p));
    if (missing.length > 0) {
      instructions += `\n\n[resume-gate] Missing expected artifact(s): ${missing.join(", ")} — this step stays OPEN. Produce the artifact first, then call kstack_advance.`;
    }
  }

  // S3/D28: the main-step watch begins at instruction delivery; any other
  // delivery (implicit phase, delegated step) drops a stale watch so the
  // detector is inert outside declared main steps.
  if (step?.execution === "main") beginStepWatch(phase.id, step.id);
  else endStepWatch();

  // Record that this run has now DELIVERED these skill digests in full, so
  // later phases of the same skill degrade to their compact DoD gate.
  // S3: for a stepped phase the delivered digest is the CURRENT step's single
  // skill (D19) — and only when the step itself is main (a delegated step's
  // digest went to the subagent, not this context).
  const deliveredSkillIds = step
    ? step.execution === "main" && step.skill ? [step.skill] : []
    : phase.execution === "main" ? (phase.skills ?? []) : [];
  if (skillsEnabled() && deliveredSkillIds.length > 0) {
    const delivered = new Set([...(state.skillsDelivered ?? []), ...deliveredSkillIds]);
    const updated = { ...state, skillsDelivered: Array.from(delivered) };
    saveState(pi, updated);
  }

  // The executor runs inside tool/command handlers while the agent loop is
  // streaming. pi requires an explicit delivery behavior in that case, or it
  // throws "Agent is already processing. Specify streamingBehavior..." and the
  // phase instructions are silently lost. "followUp" queues them as a fresh
  // message after the current turn completes — the correct handoff semantic.
  try {
    pi.sendUserMessage(delegationPrefix + instructions, { deliverAs: "followUp" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/stale/i.test(msg)) notify(`kstack: failed to deliver phase instructions: ${msg}`, "error");
  }
}

export async function runDeterministicDelegation(
  phase: { id: string },
  wfCtx: WorkflowContext,
  ctx: ExtensionContext,
  alive: () => boolean,
  pi: ExtensionAPI,
  // Test seam: inject a fake spawn to exercise the delegation engine
  // end-to-end without real child processes. The production call site
  // (executeCurrentPhase) passes nothing and gets the real runSubagent.
  spawnFn: typeof runSubagent = runSubagent,
  // S3 delegated step: a prebuilt one-entry plan built from buildStepTask
  // (steps never route through buildDeterministicPlan). S4/ADR-23: `env`
  // carries run/phase/step ids + the kstack-report CLI path into the child.
  planOverride?: Array<{ agent: string; task: string; interpolated?: boolean; env?: Record<string, string> }>,
  // S3/D28 out-param: when set (delegated-step runs only) a StepRun watches the
  // child event stream; a detector trip lands in .trip and aborts the spawn.
  stepGuard?: { stepId: string; trip?: string },
  // TASK_04 out-param: set when the delegation stopped early on a quota
  // (wall-clock budget) — the caller parks cleanly instead of completing the
  // phase on partial results. The quota-parked ledger event is appended at
  // the break point; resume re-dispatches the SAME step (resumeMode).
  interruption?: { kind?: "quota-parked" | "run-interrupted" },
): Promise<Array<{ agent: string; result: SpawnResult }>> {
  const plan = planOverride ?? buildDeterministicPlan(phase as any, wfCtx);
  // STEP 4d: a collapsed validate-only root-cause step may be REFUTED — then
  // the FULL original scout→planner chain is rebuilt and re-run. (Native-plan
  // concept only — a step override is never the collapsed validate step.)
  const wasCollapsed =
    !planOverride && phase.id === "root-cause" && plan.length === 1 && plan[0].agent === "planner";

  // Wall-clock guard (STEP D3): one phase's whole delegation must never hang
  // forever — past the budget the chain stops orderly with a visible trail.
  const budget = delegationBudgetMs();
  const delegationStart = Date.now();

  const runSteps = async (
    steps: Array<{ agent: string; task: string; interpolated?: boolean; env?: Record<string, string> }>,
  ): Promise<Array<{ agent: string; result: SpawnResult }>> => {
    const out: Array<{ agent: string; result: SpawnResult }> = [];
    let previous = "";
    let prevIncomplete = false;
    for (const [index, step] of steps.entries()) {
      if (!alive()) break; // session reloaded mid-chain — stop spawning work
      if (budget !== "off" && Date.now() - delegationStart > budget) {
        delegationEvent(pi, {
          phaseId: phase.id,
          step: index,
          agent: step.agent,
          event: "budget-exceeded",
          budgetSec: Math.round((budget as number) / 1000),
        });
        // TASK_04: quota hit mid-delegation — ledger kind quota-parked (never
        // phase-verdict, never an attempt), interruption flag tells the caller
        // to park rather than complete the phase on partial chain results.
        if (interruption) interruption.kind = "quota-parked";
        appendLedger(
          ctx.cwd,
          wfCtx.state,
          {
            kind: "quota-parked",
            phaseId: phase.id,
            stepId: stepGuard?.stepId,
            payload: { summary: `delegation wall-clock budget (${Math.round((budget as number) / 1000)}s) exhausted before "${step.agent}"` },
          },
          () => { /* ledger failures never block the park path */ },
        );
        try {
          ctx.ui.notify(
            `kstack: delegation wall-clock budget (${Math.round((budget as number) / 1000)}s) exhausted — stopping phase "${phase.id}" before "${step.agent}".`,
            "warning",
          );
        } catch {
          /* stale ctx */
        }
        break;
      }
      // STEP 2c: the receiver gets the extracted HANDOFF (computed on the RAW
      // uncapped upstream output), never the entire report — a full 50K-char
      // payload inflated every downstream turn's prefill and encouraged
      // re-verification of already-settled facts.
      const handoff = extractHandoff(previous, { incomplete: prevIncomplete });
      // `interpolated` tasks (S3 delegated steps) arrive fully resolved —
      // a second pass would rewrite a literal `{previous}` documented inside
      // the embedded skill digest.
      const task = step.interpolated === true
        ? step.task
        : replaceExact(step.task, /\{previous\}/g, handoff.text || "(no prior output)");
      try {
        ctx.ui.notify(`kstack: running subagent "${step.agent}"…`, "info");
      } catch {
        /* stale ctx — keep working, notifications are best-effort */
      }

      // Live progress in the status bar (deterministic spawns have no tool
      // renderer, so the status line is the real-time view).
      const stepStart = Date.now();
      const setStatus = (extra: string) => {
        try {
          const secs = Math.round((Date.now() - stepStart) / 1000);
          ctx.ui.setStatus(
            "kstack",
            `subagent ${step.agent} (${index + 1}/${steps.length}) · ${secs}s — ${extra}`,
          );
        } catch {
          /* stale ctx */
        }
      };
      setStatus("starting…");

      // S3/D28: delegated STEP runs carry a transient detector — its counters
      // die with the step, never persist.
      const stepRun = stepGuard ? newStepRun() : null;
      const stepLimits = stepRun ? stepBudgetDefaults() : null;

      const req: SpawnRequest = {
        agent: step.agent,
        task,
        cwd: wfCtx.cwd,
        // S4/ADR-23: run/phase/step ids + kstack-report path for step records.
        env: step.env,
        // STEP 5a: per-class timeout resolved from the phase id.
        phaseId: phase.id,
        // E4/D10 model tiers: inert unless KSTACK_PI_MODEL_FAST/_STRONG are set.
        modelOverride: modelTierFor(phase.id),
        shouldAbort: () => !alive() || !!stepGuard?.trip,
        onActivity: setStatus,
        onEvent: stepRun
          ? (event: any) => {
              if (!stepGuard || stepGuard.trip) return;
              feedStepEvent(stepRun, event);
              const rule = detectStuck(stepRun);
              if (rule) {
                stepGuard.trip = `stuck:${rule}:${phase.id}.${stepGuard.stepId}`;
                return;
              }
              const budget = checkStepBudgets(stepRun, stepLimits!);
              for (const dim of budget.warn) {
                try {
                  ctx.ui.notify(`kstack: step "${stepGuard.stepId}" at ~80% of its ${dim} budget`, "warning");
                } catch {
                  /* stale ctx */
                }
              }
              if (budget.exceeded) stepGuard.trip = `budget-exceeded:${budget.exceeded}:${phase.id}.${stepGuard.stepId}`;
            }
          : undefined,
        // STEP 5b: observe-only liveness — dual sink (notify + run report).
        onLiveness: (obs) => {
          recordLiveness(obs);
          try {
            ctx.ui.notify(
              `[liveness-observe] would abort '${obs.agent}' after ${obs.gapSec}s of silence (last event: ${obs.lastEvent}, tool: ${obs.lastTool ?? "n/a"})`,
              "warning",
            );
          } catch {
            /* stale ctx */
          }
        },
      };
      delegationEvent(pi, { phaseId: phase.id, step: index, agent: step.agent, event: "started" });
      // STEP 2f/4d: at most one retry for transient failures; the cooldown
      // depends on the failure class (timeout → long, fast blip → short).
      let result = await spawnFn(req);
      const decision = retryDecision(result, 1);
      // A detector trip is NOT a transient failure — retrying would re-run the
      // same looping/budget-blown step, so the single-retry path is skipped.
      if (decision.retry && alive() && !stepGuard?.trip) {
        delegationEvent(pi, {
          phaseId: phase.id,
          step: index,
          agent: step.agent,
          event: "retrying",
          reason: result.timedOut ? "timeout" : `exit ${result.exitCode}`,
          delaySec: Math.round(decision.delayMs / 1000),
        });
        try {
          ctx.ui.notify(
            `kstack: subagent "${step.agent}" failed transiently (${result.timedOut ? "timeout" : `exit ${result.exitCode}`}) — retrying once in ${Math.round(decision.delayMs / 1000)}s with a raised limit…`,
            "warning",
          );
        } catch {
          /* stale ctx */
        }
        await delay(decision.delayMs);
        if (alive()) {
          result = await spawnFn({
            ...req,
            timeoutMs: retryTimeoutMs(req, decision.timeoutScale),
          });
        }
      }
      out.push({ agent: step.agent, result });
      delegationEvent(pi, {
        phaseId: phase.id,
        step: index,
        agent: step.agent,
        event: result.ok ? "completed" : result.timedOut ? "timeout" : "failed",
        durationSec: Math.round(result.durationMs / 1000),
        toolCalls: result.toolCalls,
        turns: result.turns,
        incomplete: result.incomplete === true || undefined,
        error: result.error ? String(result.error).slice(0, 300) : undefined,
      });
      previous = result.rawOutput ?? (result.output || result.error || "");
      prevIncomplete = !result.ok || result.incomplete === true;
      // STEP 5c: token budget circuit-breaker — notify + orderly stop, no kill.
      const used =
        (result.usage?.input ?? 0) +
        (result.usage?.cacheRead ?? 0) +
        (result.usage?.cacheWrite ?? 0) +
        (result.usage?.output ?? 0);
      recordTokens(used);
      if (totalTokensUsed() > maxRunTokens()) {
        try {
          ctx.ui.notify(
            `kstack: KSTACK_PI_MAX_RUN_TOKENS exceeded (${totalTokensUsed()} tokens) — stopping the chain orderly.`,
            "warning",
          );
        } catch {
          /* stale ctx */
        }
        break;
      }
      // A failed step's error text is not a usable handoff for downstream
      // work — continuing burned a full extra delegation on garbage (e.g. the
      // FE developer "implementing" against a BE step that never produced
      // code). Stopping is also verdict-safe: a missing step parses as
      // unreadable and the gate parks fail-closed either way.
      if (!result.ok) {
        delegationEvent(pi, { phaseId: phase.id, step: index, agent: step.agent, event: "chain-stopped", reason: "step-failed" });
        break;
      }
    }
    return out;
  };

  const out = await runSteps(plan);

  // STEP 4d — mandatory reopen path: REFUTED validation → run the FULL
  // original chain, prefixing the scout so it does not revisit the dead end.
  // B4 fix: the reopen is UNCONDITIONAL once refuted. Previously it was gated
  // on a regex extracting the refuted cause from the validate task — a drift
  // there silently dropped the mandatory reopen and the workflow continued
  // with nothing but a refuted validation output. The "do not revisit" NOTE
  // is the only conditional part (plus a visible warning when absent).
  if (shouldReopenFullChain(wasCollapsed, out[out.length - 1]?.result.output)) {
    try {
      ctx.ui.notify("kstack: root-cause hypothesis REFUTED by validation — rebuilding the full investigation chain.", "warning");
    } catch {
      /* stale ctx */
    }
    const refutedText = out[out.length - 1].result.output ?? "";
    const causeMatch = /CONFIRMED this cause: "(.+?)" \(files?:/.exec(plan[0].task);
    const reasonMatch = /^REFUTED:\s*(.+)$/im.exec(refutedText);
    const freshCtx: WorkflowContext = {
      ...wfCtx,
      state: { ...wfCtx.state, results: { ...wfCtx.state.results } },
    };
    // Keep the reproduce evidence in the rebuilt chain's context — only strip
    // the CONFIRMED ROOT CAUSE marker line itself. Deleting the whole result
    // (previous behavior) hid the original reproduction steps from the fresh
    // scout; the marker is what triggers re-collapse, not the summary.
    const repro = freshCtx.state.results["reproduce"];
    if (repro?.summary) {
      freshCtx.state.results["reproduce"] = {
        ...repro,
        summary: repro.summary.replace(/^CONFIRMED ROOT CAUSE:.*$/gim, "").trim(),
      };
    }
    const fullPlan = buildDeterministicPlan(phase as any, freshCtx);
    if (fullPlan.length > 0) {
      if (causeMatch) {
        const note = `NOTE: the hypothesis '${causeMatch[1]}' was REFUTED because: ${reasonMatch?.[1]?.trim() ?? "validation against the code failed"}. Do not revisit it.\n\n`;
        fullPlan[0] = { ...fullPlan[0], task: replaceExact(fullPlan[0].task, /^/, note) };
      } else {
        try {
          ctx.ui.notify(
            "kstack: could not extract the refuted cause from the validate task — reopening the full chain WITHOUT the 'do not revisit' note.",
            "warning",
          );
        } catch {
          /* stale ctx */
        }
      }
      return [...out, ...(await runSteps(fullPlan))];
    }
  }
  return out;
}

function workflowPhaseOf(wfCtx: WorkflowContext, phaseId: string): any {
  const wf = getWorkflow(wfCtx.state.workflowId);
  return wf?.phases.find((p) => p.id === phaseId) ?? {};
}

function formatDelegationResults(
  phaseId: string,
  results: Array<{ agent: string; result: SpawnResult }>,
): string {
  const parts: string[] = [`## Subagent execution complete (phase: ${phaseId})`];
  parts.push("The work below was already performed by dedicated subagent processes spawned by the orchestrator.");
  parts.push("Review their outputs, then call kstack_advance with your summary. Do NOT redo the delegated work unless a result is clearly wrong or incomplete.");
  for (const { agent, result } of results) {
    parts.push("");
      const secs = Math.round(result.durationMs / 1000);
      const turns = result.turns ?? 0;
      const avgTurn = turns > 0 ? `${(result.durationMs / turns / 1000).toFixed(1)}s/turn` : "n/a";
      const tok = result.usage
        ? `tokens in ${result.usage.input} (cache ${result.usage.cacheRead}) out ${result.usage.output}`
        : "tokens n/a";
      // STEP 2c: make the handoff quality visible for every step.
      let handoffSuffix = "";
      if (result.ok) {
        const level = extractHandoff(result.rawOutput ?? result.output ?? "", { incomplete: result.incomplete }).level;
        handoffSuffix = ` · handoff: ${level}`;
        if (result.incomplete) {
          handoffSuffix += `, output INCOMPLETE (${result.timedOut ? "timed out" : "partial output"})`;
        }
      }
      // `ok` means "produced output" — a crash that still emitted a report
      // must not read as a clean completion.
      const statusLabel =
        result.ok && (result.exitCode ?? 0) === 0
          ? "completed"
          : `FAILED (exit ${result.exitCode ?? "?"})`;
      parts.push(`### Subagent: ${agent} — ${statusLabel} (${secs}s · ${result.toolCalls ?? "?"} tool calls · ${turns} turns · ${avgTurn}${handoffSuffix} · ${tok})`);
    if (result.ok) {
      parts.push(result.output || "(no textual output)");
    } else {
      parts.push(`Error: ${result.error ?? "unknown error"} (exit code ${result.exitCode}). Decide whether to retry the work yourself or report the failure via kstack_advance with status "failed".`);
    }
  }
  parts.push("");
  return parts.join("\n");
}

/**
 * Binding constraints in force RIGHT NOW (Q4 fix): the resume prefix is the
 * last thing the model reads before the user's message, so it must re-anchor
 * not only WHERE the workflow is but WHICH rules still bind this turn —
 * freezes, unreadable verdicts, report-only posture and manual gates would
 * otherwise drift out of effective attention across a long phase.
 */
export function activeConstraintLines(state: WorkflowState, phase?: WorkflowPhase): string[] {
  const lines: string[] = [];
  if (state.frozenUntilHuman || (state.pausedReason ?? "").startsWith("security-freeze:")) {
    lines.push(
      "CONSTRAINT: a review gate is FROZEN by a critical/high security rejection. Do NOT work around it and do NOT call kstack_advance — the user must unfreeze via /kstack (exact confirmation phrase).",
    );
  }
  if (state.verdictPark) {
    lines.push(
      "CONSTRAINT: the phase's verdict was UNREADABLE. Do not start new work and do NOT call kstack_advance — the user decides via /kstack (continue / return / abort).",
    );
  }
  if (state.status === "paused" && state.pausedReason && lines.length === 0) {
    lines.push(
      `CONSTRAINT: the workflow is PAUSED (${state.pausedReason}) — a human decision is pending via /kstack. Do NOT call kstack_advance.`,
    );
  }
  if (state.status === "paused" && !state.pausedReason && lines.length === 0) {
    lines.push(
      "CONSTRAINT: the previous phase FAILED — the user decides how to proceed via /kstack (resume re-runs the phase). Do NOT call kstack_advance.",
    );
  }
  // Parked-gate fix (2026-09 session): an awaiting_approval state is a manual
  // decision gate. The input router prefixes EVERY user message with the
  // resume context, so a "continue working" body here reads as an instruction
  // to keep going — the exact mechanic that made a parked plan phase implement
  // the plan instead of waiting for /kstack next.
  if (state.status === "awaiting_approval" && state.entryGate === true) {
    lines.push(
      "CONSTRAINT: the workflow is PARKED BEFORE a human-gated side-effect phase — it has NOT run yet. Do NOT perform the phase's work and do NOT call kstack_advance; the user decides via /kstack (Run / Abort).",
    );
  } else if (state.status === "awaiting_approval" && state.stepGate) {
    lines.push(
      "CONSTRAINT: this run is HUMAN-GATED and the last completed step awaits the user's approval. Do NOT start the next step and do NOT call kstack_advance; if the user asks for revisions or answers questions, apply them to the completed step's output only — the user continues via /kstack when satisfied.",
    );
  } else if (state.status === "awaiting_approval" && !state.pendingOptional) {
    lines.push(
      "CONSTRAINT: the workflow is PARKED at a decision gate — the completed phase awaits user approval. Do NOT continue the phase, do NOT implement anything, and do NOT call kstack_advance; the user decides via /kstack next. If the user asks for revisions, apply them to the completed phase's output only.",
    );
  }
  if (phase?.variant === "report-only") {
    lines.push("CONSTRAINT: this phase is REPORT-ONLY — test and classify, do NOT fix, do NOT commit.");
  }
  if (phase?.advance === "manual") {
    lines.push(
      "CONSTRAINT: this is a DECISION phase — after calling kstack_advance the workflow pauses for user review; do not start the next phase yourself.",
    );
  }
  return lines;
}

/**
 * Truthful status line for the workflow's current posture: a parked or frozen
 * workflow must never keep showing the last "running" label. Every non-running
 * line names its unlock action (/kstack next vs the /kstack panel). Returns
 * undefined for terminal states so callers can pass the result straight to
 * ctx.ui.setStatus (undefined clears the line).
 */
export function statusLineFor(state: WorkflowState, workflow: { name: string; phases: WorkflowPhase[] }): string | undefined {
  const phase = workflow.phases[state.phaseIndex];
  const progress = `(${state.phaseIndex + 1}/${workflow.phases.length})`;
  if (state.status === "completed" || state.status === "aborted") return undefined;
  if (state.status === "awaiting_approval") {
    if (state.entryGate === true) {
      return `${workflow.name}: PARKED — gated phase "${phase?.name ?? "?"}" awaits approval to RUN via /kstack`;
    }
    if (state.stepGate) {
      return `${workflow.name}: PARKED — review the completed step, then /kstack next ${progress}`;
    }
    return state.pendingOptional
      ? `${workflow.name}: PARKED — optional phase "${phase?.name ?? "?"}" awaits Run/Skip/Abort via /kstack`
      : `${workflow.name}: PARKED for approval — /kstack next`;
  }
  if (state.status === "paused") {
    const reason = state.pausedReason ?? "";
    const cause =
      state.frozenUntilHuman || reason.startsWith("security-freeze:")
        ? `FROZEN: ${state.freezeInfo?.severity ?? "critical/high"} security rejection`
        : state.verdictPark
          ? `verdict unreadable (${reason.split(":")[2] ?? "?"})`
          : reason.startsWith("loop-exhausted:")
            ? "loop exhausted"
            : reason.startsWith("anomaly:")
              ? "sprint numbering anomaly"
              : reason.startsWith("branch-violation:")
                ? "branch violation"
                : reason.startsWith("step-failed:")
                  ? `step failed (${reason.slice("step-failed:".length)})`
                  : reason.startsWith("stuck:")
                    ? `stuck detector tripped (${reason.slice("stuck:".length)})`
                    : reason.startsWith("budget-exceeded:")
                      ? `step budget exceeded (${reason.slice("budget-exceeded:".length).split(":").join(" · ")})`
                      : reason
                        ? `paused: ${reason}`
                        : "phase failed";
    return `${workflow.name}: ${cause} ${progress} — /kstack`;
  }
  // S3: a stepped phase names its current step — `phase (n/m) · step <id> (i/k)`.
  if (phase?.steps?.length && state.stepIndex !== undefined) {
    const i = Math.min(state.stepIndex, phase.steps.length - 1);
    return `${workflow.name}: ${phase.name} ${progress} · step ${phase.steps[i].id} (${i + 1}/${phase.steps.length})`;
  }
  return `${workflow.name}: ${phase?.name ?? "unknown"} ${progress}`;
}

export function setKstackStatus(ctx: ExtensionContext, state: WorkflowState, workflow: { name: string; phases: WorkflowPhase[] }): void {
  try {
    ctx.ui.setStatus("kstack", statusLineFor(state, workflow));
  } catch {
    /* stale ctx */
  }
}

export function buildResumeContext(state: WorkflowState): string {
  const workflow = getWorkflow(state.workflowId);
  if (!workflow) return "";

  const phase = workflow.phases[state.phaseIndex];
  // S3: when the phase is stepped, the resume anchor names the CURRENT step —
  // "continue the current phase" alone would let the model drift back to a
  // completed step's work.
  const step = phase?.steps?.length
    ? phase.steps[Math.min(state.stepIndex ?? 0, phase.steps.length - 1)]
    : undefined;
  const parts: string[] = [];
  parts.push(`[kstack workflow active: ${workflow.name}]`);
  parts.push(`Current phase: ${phase?.name ?? "unknown"} (${state.phaseIndex + 1}/${workflow.phases.length})`);
  if (step) {
    // Clamp the displayed index like statusLineFor — a corrupt over-high
    // stepIndex must not render "step draft (5/3)".
    const stepPos = Math.min(state.stepIndex ?? 0, phase!.steps!.length - 1) + 1;
    parts.push(`Current step: ${step.id} (${stepPos}/${phase!.steps!.length})`);
  }
  parts.push(`Goal: ${state.goal}`);

  // Phase keys only — dotted "phase.step" keys are step completions, not
  // phase completions; the step posture is carried by "Current step:" above.
  const completed = Object.entries(state.results).filter(([id, r]) => r.status === "completed" && !id.includes("."));
  if (completed.length > 0) {
    parts.push(`Completed: ${completed.map(([id]) => id).join(", ")}`);
  }

  // Re-anchor the binding rules, not just the position (Q4 fix).
  const constraints = activeConstraintLines(state, phase);
  if (constraints.length > 0) {
    parts.push("");
    parts.push(...constraints);
  }

  if (state.pendingOptional) {
    // Optional-phase decision gate: parked AT the optional phase. The model
    // must not start it — the user decides via /kstack (Run / Skip / Abort).
    parts.push(
      `This phase is OPTIONAL and the workflow is PARKED awaiting the user's decision. Do not work on it and do not call kstack_advance — tell the user to run /kstack to Run it, Skip it, or Abort.`,
    );
    return parts.join("\n");
  }

  if (state.status === "awaiting_approval") {
    if (state.entryGate === true) {
      // Entry gate: phaseIndex still points AT the gated phase — it has NOT
      // run. Telling the model to "continue the current phase" here would
      // literally start the gated work.
      parts.push(
        `The workflow is PARKED BEFORE the human-gated side-effect phase "${phase?.name ?? "the next phase"}" — it has NOT run yet.`,
        "Do NOT perform that phase's work and do NOT call kstack_advance — only the user's approval via /kstack starts it.",
      );
      return parts.join("\n");
    }
    if (state.stepGate) {
      parts.push(
        `The workflow is PARKED for user approval (human-gated run) BEFORE step "${step?.id ?? "the next step"}" — the previous step is complete and awaits the user's review.`,
        "Do NOT start the next step and do NOT call kstack_advance — only the user continues via /kstack.",
        "If the user answers questions or asks for revisions, fold them into the completed step's output, then stop and remain parked.",
      );
      return parts.join("\n");
    }
    // Parked at a manual decision gate: never tell the model to keep working.
    // phaseIndex already points at the NEXT phase (advancePhase moved it), so
    // "continue the current phase" here meant "start the next phase without
    // approval" — and any plan tweak read as "resume and implement".
    parts.push(
      `The workflow is PARKED for user approval BEFORE "${phase?.name ?? "the next phase"}" — the previous (decision) phase is complete and awaits the user's review.`,
      "Do NOT start or continue any phase, do NOT implement the plan, and do NOT call kstack_advance — only /kstack next (the user) continues the workflow.",
      "If the user asks for revisions in this turn, apply them to the completed phase's output only, then stop and remain parked.",
    );
    return parts.join("\n");
  }

  if (state.status === "paused") {
    // Paused = human decision pending (freeze, loop exhaustion, anomaly,
    // branch violation, failed phase). The CONSTRAINT lines above carry the
    // rules — printing "continue working" after them would invite exactly the
    // work the park exists to stop (a branch violation forbids work on main,
    // not just the advance call).
    parts.push(
      `The workflow is PAUSED (${state.pausedReason ?? "phase failed"}) — only /kstack resumes, re-runs or aborts it. Do not continue work and do NOT call kstack_advance.`,
    );
    return parts.join("\n");
  }

  // Compaction guard tier 1: durable artifacts survive compaction on disk, but
  // the phase contract is context-only — re-anchor it every turn for main
  // phases. Subagent phases self-heal (delegation results arrive with fresh
  // instructions); parked states need constraints, not contracts.
  // S3: a stepped phase re-anchors the CURRENT step's contract.
  if (state.status === "active" && phase && (phase.execution === "main" || step)) {
    parts.push("");
    parts.push(mainContractFor(phase, { state }, step));
  }

  parts.push("Continue working on the current phase. Call kstack_advance when done.");
  if (state.status === "active") {
    // Compaction guard tier 2: kstack_phase re-fetches the full phase
    // instructions on demand — the model self-detects the loss after compaction.
    parts.push("If this phase's full instructions are not in your context, call the kstack_phase tool.");
  }
  // F2 mitigation (2026-09 handoff): the router snapshots the state once per
  // input event and this prefix cannot refresh mid-turn, so a chain that lands
  // mid-turn (gate resolves, verdict re-parks — possibly FROZEN) is invisible
  // to the text above. State the precedence rule explicitly: a park that lands
  // afterwards wins over this message — obey it, never kstack_advance past a
  // decision gate. When the chain is still in flight at prefix time, warn that
  // the posture may flip mid-turn.
  parts.push(
    isPhaseInFlight(state.workflowId, state.phaseIndex)
      ? "NOTE: a delegation chain for this phase is STILL RUNNING — its results may land mid-turn and re-park the workflow (PARKED for approval, FROZEN, or otherwise paused for a human decision). If the workflow is parked or frozen by then, that state wins: obey it and do NOT call kstack_advance."
      : "If the workflow has been re-parked meanwhile (PARKED for approval, FROZEN, or otherwise paused for a human decision), that state wins over everything above: obey it and do NOT call kstack_advance.",
  );
  return parts.join("\n");
}
