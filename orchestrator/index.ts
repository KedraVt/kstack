import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { handleKstackCommand, getCompletions } from "./command.ts";
import { createInputRouter } from "./router.ts";
import { loadActiveState, saveState, advancePhase, gateForApproval, recordStepResult } from "./state.ts";
import { stepCompletionStatus } from "./records.ts";
import { evaluateStepRecordTrust, repairKey } from "./repair.ts";
import { NEGATIVE_VALUES } from "./verdicts.ts";
import type { AdvanceOptions } from "./state.ts";
import { getWorkflow } from "./workflows.ts";
import { launchPhase, invalidateRuntime, advanceBlockReason, setKstackStatus, finalizeRun } from "./executor.ts";
import { manualGates, autoGateValidated, optionalPhases, deterministicSubagents } from "./config.ts";
import { parsePlanFileMarker, buildPhaseInstructions, buildStepInstructions, resolvePlanFilePath } from "./templates.ts";
import { detectGitContext } from "./git.ts";
import { isValidatedStrategy } from "./skip.ts";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { phaseArtifactPaths, artifactSignalFiles, runStartMs } from "./artifacts.ts";
import { appendLedger } from "./ledger.ts";
import { feedWatchEvent, endStepWatch, stepWatchStats, type StepWatchEvent } from "./stuck.ts";
import { SECURITY_SECTION } from "../lib/content-security.ts";
import { EXTENSION_ROOT } from "./skills.ts";

/** Automatic re-deliveries of a main step whose completion signal is missing. */
const MAX_AUTO_REISSUES = 2;

export function initOrchestrator(pi: ExtensionAPI): void {
  // Skills reach runtime helpers as "$KSTACK_EXTENSION_DIR/runtime/..." — one
  // portable root for the main session's bash, spawned subagents (inherited
  // env) and manual /skill: runs. Its own name: KSTACK_ROOT already means a
  // browse checkout root in lib/browse.ts. Forward slashes: bash eats backslashes.
  process.env.KSTACK_EXTENSION_DIR = EXTENSION_ROOT.replace(/\\/g, "/");

  // WP2 §4.1: teach the model what the untrusted-content envelope markers mean.
  // The try/catch stays: older pi versions without before_agent_start throw
  // at registration and simply skip the injection.
  try {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: event.systemPrompt + "\n\n" + SECURITY_SECTION,
    }));
  } catch {
    /* event not supported by this pi version */
  }

  // Invalidate all in-flight background chains when the session is replaced,
  // reloaded or forked. Without this, a subagent chain started before the
  // reload keeps running against a stale ExtensionContext and any ctx.ui
  // access throws "Extension ctx is stale" — which, uncaught, kills pi.
  const onSessionGone = () => invalidateRuntime();
  try {
    pi.on("session_shutdown", onSessionGone);
  } catch {
    /* event not supported by this pi version */
  }
  try {
    pi.on("session_before_switch", onSessionGone);
  } catch {
    /* event not supported by this pi version */
  }
  try {
    pi.on("session_before_fork", onSessionGone);
  } catch {
    /* event not supported by this pi version */
  }

  // S3/D28 precompact gate (advisory — never vetoes): ledger appends are
  // synchronous so nothing is pending to flush; the hook RE-ASSERTS the
  // newest state entry so post-compaction recovery sees the latest
  // stepIndex/results even if a later in-memory mutation raced the log.
  try {
    pi.on("session_before_compact", (_e, evCtx) => {
      try {
        const s = loadActiveState(evCtx);
        if (s) saveState(pi, s);
      } catch {
        /* snapshot is best-effort */
      }
    });
  } catch {
    // A safety hook failing open must announce itself — silent inertness is
    // worse than a missing control (S3 security review).
    console.warn("[kstack] could not subscribe to session_before_compact — precompact state snapshot is INACTIVE");
  }

  // S3/D28 main-step watch: tool/message events feed the transient StepRun of
  // the CURRENTLY delivered main step (begun in executeCurrentPhase). A trip
  // parks the run — never a silent kill; implicit phases start no watch and
  // are inert here. `misfire → human un-parks` is the fail-safe direction.
  const onWatchEvent = (event: StepWatchEvent, evCtx: ExtensionContext): void => {
    try {
      const verdict = feedWatchEvent(event);
      if (!verdict) return;
      // Validate the watch is still live BEFORE emitting anything — a
      // stale verdict (the run advanced past the watched step between the
      // event and this handler) must not spam warnings or freeze a
      // healthy run.
      const s = loadActiveState(evCtx);
      const wf = s ? getWorkflow(s.workflowId) : null;
      const ph = wf?.phases[s.phaseIndex];
      if (!s || s.status !== "active" || ph?.id !== verdict.phaseId || ph.steps?.[s.stepIndex ?? -1]?.id !== verdict.stepId) return;
      if (verdict.warnings) {
        try {
          evCtx.ui.notify(`kstack: step "${verdict.stepId}" at ~80% of its ${verdict.warnings.join("+")} budget`, "warning");
        } catch {
          /* stale ctx */
        }
      }
      if (!verdict.trip) return;
      const parked = { ...s, status: "paused" as const, pausedReason: verdict.trip };
      saveState(pi, parked);
      try {
        evCtx.ui.notify(`kstack: ${verdict.trip} — workflow paused for a human decision; resume via /kstack re-runs the step.`, "warning");
      } catch {
        /* stale ctx */
      }
    } catch {
      /* the detector must never crash the host event bus */
    }
  };
  for (const ev of ["tool_execution_start", "tool_execution_end", "message_end"] as const) {
    try {
      // Each call picks up the typed overload for that event name — the
      // per-event arrow lets TS infer the concrete event; the shared handler
      // takes the tolerant StepWatchEvent shape (all fields optional).
      switch (ev) {
        case "tool_execution_start":
          pi.on("tool_execution_start", (event, evCtx) => onWatchEvent(event, evCtx));
          break;
        case "tool_execution_end":
          pi.on("tool_execution_end", (event, evCtx) => onWatchEvent(event, evCtx));
          break;
        case "message_end":
          pi.on("message_end", (event, evCtx) => onWatchEvent(event, evCtx));
          break;
      }
    } catch {
      // A safety hook failing open must announce itself — silent inertness is
      // worse than a missing control (S3 security review).
      console.warn(`[kstack] could not subscribe to "${ev}" — step stuck-detector is INACTIVE`);
    }
  }

  pi.registerCommand("kstack", {
    description: "Guided workflow orchestrator: develop, investigate, qa, ship, review (init: install AGENTS.md rules block; next: approve gated phase)",
    getArgumentCompletions: getCompletions,
    handler: async (args: string, ctx) => {
      await handleKstackCommand(args, ctx as any, pi);
    },
  });

  pi.on("input", createInputRouter(pi) as any);

  pi.registerTool({
    name: "kstack_advance",
    label: "Advance Workflow",
    description:
      "Signal completion of the current kstack workflow phase. ALWAYS call this yourself when a phase's work is done — never tell the user to run commands instead. On decision phases the workflow pauses for user approval after this call; the orchestrator handles that.",
    promptSnippet: "Advance the active kstack workflow to the next phase",
    promptGuidelines: [
      "Only call kstack_advance when a kstack workflow phase is active",
      "Provide a concise 2-3 sentence summary of what was accomplished",
      "Use status 'failed' if the phase could not be completed",
      "Never ask the user to run /kstack or any other command to progress — calling this tool IS the progression mechanism",
    ],
    parameters: Type.Object({
      summary: Type.String({ description: "2-3 sentence summary of what was accomplished in this phase" }),
      status: Type.Union([Type.Literal("completed"), Type.Literal("failed")], { description: "Whether the phase succeeded or failed" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext): Promise<any> {
      const state = loadActiveState(ctx);
      if (!state) {
        return { content: [{ type: "text" as const, text: "No active kstack workflow. Start one with /kstack." }] };
      }

      const workflow = getWorkflow(state.workflowId);
      if (!workflow) {
        return { content: [{ type: "text" as const, text: `Unknown workflow: ${state.workflowId}` }], isError: true };
      }

      const phase = workflow.phases[state.phaseIndex];
      if (!phase) {
        return {
          content: [{
            type: "text" as const,
            text: `kstack: workflow "${state.workflowId}" has no phase at index ${state.phaseIndex} (status: ${state.status}) — the persisted state is inconsistent; resolve via /kstack.`,
          }],
          isError: true,
        };
      }
      // S3: the state binding must be mutable — a stepped phase's mid-step
      // advance replaces it below before the phase-level advancePhase runs.
      let advanceState = state;
      // Optional-phase decision gate (STEP 2g v2): while the workflow is parked
      // at an optional phase awaiting the user's Run/Skip/Abort decision, the
      // model can neither complete nor skip the phase via kstack_advance — the
      // decision belongs exclusively to the /kstack panel.
      if (state.pendingOptional) {
        return {
          content: [{
            type: "text" as const,
            text: `The workflow is parked at the optional phase "${phase?.name ?? "?"}" awaiting an explicit user decision (Run / Skip / Abort) via /kstack. Do NOT call kstack_advance again and do not start the phase — the user decides.`,
          }],
        };
      }

      // Advance-block guard (audit fix): the state machine, not the model,
      // decides when a phase may be recorded. Two cases are refused: a parked
      // manual gate (only /kstack next continues it) and an in-flight
      // delegation (its results, not a model summary, complete the phase).
      const blocked = advanceBlockReason(state);
      if (blocked) {
        return {
          content: [{
            type: "text" as const,
            text: `kstack: ${blocked}. Do NOT call kstack_advance again.`,
          }],
        };
      }

      // S3 stepped phase (INV-02): kstack_advance completes the CURRENT step
      // — the phase itself advances only after the LAST step, through the
      // normal phase-level advancePhase below (verdict routing included).
      if (phase.steps && phase.steps.length > 0) {
        // Set when a failFast phase's verifier step reports a negative verdict.
        let failFastFrom: string | undefined;
        // S4/TASK_02: the declared step signal must be OBSERVED before the
        // step may complete — a missing record/marker/artifact re-issues the
        // step in resumeMode instead of advancing; a verdict written by a
        // non-flagged step parks foreign-verdict.
        {
          const si = Math.min(state.stepIndex ?? 0, phase.steps.length - 1);
          const curStep = phase.steps[si];
          const check = stepCompletionStatus(state, phase, curStep, ctx.cwd);
          // Verdicts the step does not own were stripped by the reader — they
          // never route and never park; the drop is ledgered for the audit trail.
          if (check.kind === "ok" && check.dropped.length > 0) {
            appendLedger(
              ctx.cwd,
              state,
              { kind: "step", phaseId: phase.id, stepId: curStep.id, payload: { summary: `ignored unowned verdict(s): ${check.dropped.join(", ")}` } },
              (m) => { try { ctx.ui.notify(m, "warning"); } catch { /* stale ctx */ } },
            );
          }
          if (check.kind === "signal-missing" && params.status !== "failed") {
            // TASK_07 unhappy path: a DELEGATED step whose worker exited
            // without producing its record cannot be re-prompted cheaply —
            // re-spawning it is a real retry and belongs to the human.
            // Park; the /kstack resume path re-dispatches the same step.
            // Automatic re-issues are capped: a step that cannot produce its
            // signal (broken CLI, impossible artifact) must reach a human
            // instead of re-delivering itself forever.
            const reissues = (state.reissues ?? 0) + 1;
            if ((curStep.execution === "subagent" && deterministicSubagents()) || reissues > MAX_AUTO_REISSUES) {
              const parked = { ...state, status: "paused" as const, pausedReason: `signal-missing:${phase.id}.${curStep.id}:${check.want}` };
              saveState(pi, parked);
              setKstackStatus(ctx, parked, workflow);
              appendLedger(
                ctx.cwd,
                state,
                {
                  kind: "run-interrupted",
                  phaseId: phase.id,
                  stepId: curStep.id,
                  payload: { summary: `delegated subagent produced no record with signal "${check.want}"` },
                },
                (m) => { try { ctx.ui.notify(m, "warning"); } catch { /* stale ctx */ } },
              );
              return {
                content: [{
                  type: "text" as const,
                  text: `Step "${curStep.id}" ended without producing signal "${check.want}" — the workflow is parked. The user resolves it via /kstack (resume re-runs the step, or advance it manually). Do NOT call kstack_advance again.`,
                }],
              };
            }
            const reissue = { ...state, resumeMode: true, reissues };
            saveState(pi, reissue);
            setKstackStatus(ctx, reissue, workflow);
            // TASK_04: a missing completion signal is a boundary interruption —
            // the ledger records it verbatim (never phase-verdict, never an attempt).
            appendLedger(
              ctx.cwd,
              state,
              {
                kind: "run-interrupted",
                phaseId: phase.id,
                stepId: curStep.id,
                payload: { summary: `completion signal "${check.want}" not observed — step re-issued in resume mode` },
              },
              (m) => { try { ctx.ui.notify(m, "warning"); } catch { /* stale ctx */ } },
            );
            launchPhase(pi, ctx, reissue);
            return {
              content: [{
                type: "text" as const,
                text: `Step "${curStep.id}" completion signal "${check.want}" was not observed — the step is being re-issued in resume mode. Produce the signal (kstack-report record / declared artifact) and call kstack_advance again.`,
              }],
            };
          }
          // S4 rider — verdict-record REPAIR (main-session step): the main
          // agent owns the record it wrote, so it FIXES the record — it does
          // not redo the review. ONE attempt per step per park: the second
          // untrusted record falls through to the normal park.
          if (
            check.kind === "ok" &&
            curStep.signal?.kind === "verdict" &&
            (curStep.execution === "main" || !deterministicSubagents())
          ) {
            const key = repairKey(phase.id, curStep.id);
            const trust = evaluateStepRecordTrust(state.workflowId, phase, curStep, check.record);
            if (!trust.ok && trust.repairable && advanceState.verdictRepairTried !== key) {
              const marked = { ...advanceState, verdictRepairTried: key };
              saveState(pi, marked);
              setKstackStatus(ctx, marked, workflow);
              appendLedger(
                ctx.cwd,
                state,
                {
                  kind: "run-interrupted",
                  phaseId: phase.id,
                  stepId: curStep.id,
                  payload: { summary: `verdict record untrusted (${trust.cause}): ${trust.defect} — repair requested from the main session` },
                },
                (m) => { try { ctx.ui.notify(m, "warning"); } catch { /* stale ctx */ } },
              );
              return {
                content: [{
                  type: "text" as const,
                  text: `Your step record for "${phase.id}.${curStep.id}" cannot be trusted: ${trust.defect} (park cause: ${trust.cause}). Fix ONLY the record — re-run the record command from your step instructions with the corrected verdict (never delete the record: it is the repair's input) and call kstack_advance again. Do NOT redo the review. This is the ONE repair attempt for this step: if the record is still untrusted on the next kstack_advance, the workflow parks for a human decision.`,
                }],
              };
            }
          }
          // Routing vars emitted via the step's record land in state.vars.
          if (check.kind === "ok" && Object.keys(check.vars).length > 0) {
            advanceState = { ...advanceState, vars: { ...(advanceState.vars ?? {}), ...check.vars } };
          }
          if (
            phase.failFast &&
            params.status === "completed" &&
            check.kind === "ok" &&
            curStep.signal?.kind === "verdict" &&
            Object.values(check.record?.verdicts ?? {}).some((v) => NEGATIVE_VALUES.has(v))
          ) {
            failFastFrom = curStep.id;
          }
        }
        let recorded = recordStepResult(
          advanceState,
          phase,
          { status: params.status, summary: params.summary },
        );
        if (!recorded) {
          return {
            content: [{
              type: "text" as const,
              text: `kstack: stepped phase "${phase.id}" has no step at index ${state.stepIndex ?? 0} — the persisted state is inconsistent; resolve via /kstack.`,
            }],
            isError: true,
          };
        }
        // failFast: the remaining steps would judge or build on work the
        // loop-back is about to redo — record them skipped and close the phase.
        if (failFastFrom && !recorded.isLast) {
          const results = { ...recorded.state.results };
          for (const s of phase.steps.slice(recorded.state.stepIndex)) {
            results[`${phase.id}.${s.id}`] = { status: "skipped", summary: `Skipped: fail-fast after a negative "${failFastFrom}" verdict` };
          }
          recorded = { ...recorded, isLast: true, state: { ...recorded.state, results, stepIndex: phase.steps.length } };
          appendLedger(
            ctx.cwd,
            state,
            { kind: "step", phaseId: phase.id, stepId: failFastFrom, payload: { summary: `fail-fast: negative verdict — remaining steps skipped` } },
            (m) => { try { ctx.ui.notify(m, "warning"); } catch { /* stale ctx */ } },
          );
        }
        // S3 ledger (INV-L1/L2): every completed step lands verbatim — the
        // failed-status branch below is a step completion too. The watched
        // step's accumulated usage rides along so the byte-stable-prefix
        // claim is MEASURED (cache_read/cache_creation), not just asserted.
        const watchStats = stepWatchStats();
        appendLedger(
          ctx.cwd,
          state,
          {
            kind: "step",
            phaseId: phase.id,
            stepId: recorded.step.id,
            payload: {
              summary: params.summary,
              ...(watchStats ? { tokens: watchStats.tokens, cacheRead: watchStats.cacheRead, cacheCreation: watchStats.cacheCreation } : {}),
            },
          },
          (m) => { try { ctx.ui.notify(m, "warning"); } catch { /* stale ctx */ } },
        );
        // Plan-file capture mid-phase (S3): a PLAN FILE marker in a completed
        // step's summary resolves the artifact BEFORE the phase advance —
        // the eng-review resume-gate then checks the file the draft actually
        // wrote, not the legacy goal slug.
        if (phase.id === "plan" && params.status === "completed") {
          const planFile = parsePlanFileMarker(params.summary);
          if (planFile) {
            try {
              if (existsSync(path.join(ctx.cwd, planFile))) recorded.state.planFile = planFile;
            } catch {
              /* unreadable cwd — keep the legacy fallback */
            }
          }
        }
        if (params.status === "failed") {
          endStepWatch();
          saveState(pi, recorded.state);
          setKstackStatus(ctx, recorded.state, workflow);
          return {
            content: [{
              type: "text" as const,
              text: `Step "${recorded.step.id}" of phase "${phase.name}" FAILED — workflow paused for a human decision (${recorded.state.pausedReason}). Resume via /kstack to re-run the step. Do NOT call kstack_advance again.`,
            }],
          };
        }
        if (!recorded.isLast && state.stepGates) {
          // Human-gated run: every completed step waits for the user's /kstack approval.
          const gated: typeof recorded.state = { ...recorded.state, status: "awaiting_approval", stepGate: true };
          saveState(pi, gated);
          setKstackStatus(ctx, gated, workflow);
          appendLedger(
            ctx.cwd, state,
            { kind: "gate", phaseId: phase.id, stepId: recorded.step.id, payload: { gateId: `${phase.id}.${recorded.step.id}`, decision: "human" } },
            (m) => { try { ctx.ui.notify(m, "warning"); } catch { /* stale ctx */ } },
          );
          const nextStep = phase.steps[gated.stepIndex!];
          try {
            ctx.ui.notify(`kstack: step "${recorded.step.id}" recorded — review it, then /kstack next to continue with "${nextStep?.id ?? "?"}".`, "info");
          } catch { /* stale ctx */ }
          return {
            content: [{
              type: "text" as const,
              text: `Step "${recorded.step.id}" recorded. This run is HUMAN-GATED: the workflow is now PAUSED for the user's review. Present the step's output clearly and stop. Do NOT call kstack_advance again and do not start step "${nextStep?.id ?? "?"}" — the user continues via /kstack when satisfied (revisions they request apply to this step's output).`,
            }],
          };
        }
        if (!recorded.isLast) {
          saveState(pi, recorded.state);
          setKstackStatus(ctx, recorded.state, workflow);
          const nextStep = phase.steps[recorded.state.stepIndex!];
          // Fire-and-forget like every other phase launch: the next step's
          // instructions (or delegation) deliver as a follow-up message.
          launchPhase(pi, ctx, recorded.state);
          return {
            content: [{
              type: "text" as const,
              text: `Step "${recorded.step.id}" of "${phase.name}" recorded (${recorded.state.stepIndex}/${phase.steps.length}). Next step: "${nextStep?.id ?? "?"}" — its instructions are being delivered.`,
            }],
          };
        }
        // Last step: carry the recorded step result into the phase advance —
        // results[phase.id] gets the final step's summary verbatim.
        advanceState = recorded.state;
        endStepWatch();
      }

      // Sprint loop engine (D1–D3): verdict routing needs the phase list and
      // cwd; the pendingVerdict was stashed at delegation time.
      const advanceOpts: AdvanceOptions = { phases: workflow.phases, cwd: ctx.cwd };
      const newState = advancePhase(
        advanceState,
        phase.id,
        { status: params.status, summary: params.summary },
        workflow.phases.length,
        advanceOpts,
      );
      // S3 ledger (INV-L2): the phase roll-up lands verbatim with its declared
      // artifact paths (relative to the repo cwd).
      appendLedger(
        ctx.cwd,
        state,
        {
          kind: "phase",
          phaseId: phase.id,
          payload: {
            summary: params.summary,
            artifacts: phaseArtifactPaths(phase.id, ctx.cwd, advanceState.sprintNumber, resolvePlanFilePath({ state: advanceState })).map((p) => path.relative(ctx.cwd, p)),
          },
        },
        (m) => { try { ctx.ui.notify(m, "warning"); } catch { /* stale ctx */ } },
      );
      // Plan-naming fix (2026-09 session): plan names are the model's job. The
      // plan contract makes the summary end with `PLAN FILE: <path>`; capture
      // and persist it so {plan_file} interpolation points at the file the
      // planner actually wrote. The path must EXIST on disk (a model reporting
      // a plausible-but-unwritten path must not hijack the implement phase's
      // {plan_file}) and be structurally valid (isValidPlanFile inside the
      // parser). Invalid/absent/unwritten marker ⇒ legacy slug fallback.
      if (phase.id === "plan" && params.status === "completed") {
        const planFile = parsePlanFileMarker(params.summary);
        if (planFile) {
          try {
            if (existsSync(path.join(ctx.cwd, planFile))) {
              newState.planFile = planFile;
            } else {
              ctx.ui.notify(
                `kstack: plan summary reported "${planFile}" but the file does not exist — falling back to the default plan path.`,
                "warning",
              );
            }
          } catch {
            /* unreadable cwd — keep the legacy fallback */
          }
        }
      }
      // A manual gate (post-completion) still to come means newState will be
      // re-persisted as the gated variant below — skip the intermediate write
      // so the session log carries one entry per state transition.
      // S3/D20: a selection-gate "auto" override suppresses this phase's
      // post-completion park (the same row also covers the ⚠ entry gate) —
      // and the suppression is itself a decision, ledgered verbatim (INV-L1).
      const gateOverride = state.gateMode === "selection-gate" ? state.gateOverrides?.[phase.id] : undefined;
      const manualGateApplies =
        manualGates() &&
        phase.advance === "manual" &&
        params.status === "completed" &&
        newState.status === "active" &&
        state.entryGate !== "approved";
      // Human-gated runs park after EVERY completed step, the last one included.
      const stepGateApplies = state.stepGates === true && params.status === "completed" && newState.status === "active";
      const willManualGate = (manualGateApplies && gateOverride !== "auto") || stepGateApplies;
      if (manualGateApplies && gateOverride === "auto") {
        appendLedger(
          ctx.cwd, state,
          { kind: "gate", phaseId: phase.id, payload: { gateId: phase.id, decision: "auto" } },
          (m) => { try { ctx.ui.notify(m, "warning"); } catch { /* stale ctx */ } },
        );
      }
      // Completion is persisted by finalizeRun below (with the ephemeral cleanup).
      if (!willManualGate && newState.status !== "completed") saveState(pi, newState);
      setKstackStatus(ctx, newState, workflow);

      // D3 security freeze surfaced to both model and user.
      if (newState.frozenUntilHuman) {
        const info = newState.freezeInfo;
        return {
          content: [{
            type: "text" as const,
            text: `SECURITY FREEZE: ${info?.severity ?? "critical/high"} severity security rejection in "${phase.id}". The pipeline is FROZEN — no further automated work. A human security panel must review ${info?.artifactPath ?? "devsecops/security-review-artifact.md"}; only the user resolves the freeze via /kstack after that review. Do NOT attempt fixes or call kstack_advance again.`,
          }],
          isError: false,
        };
      }

      if (newState.pausedReason?.startsWith("loop-exhausted:")) {
        return {
          content: [{
            type: "text" as const,
            text: `Retry budget exhausted (${newState.pausedReason}). Workflow paused for human decision — review the latest artifacts with the user; /kstack next continues past this gate manually.`,
          }],
        };
      }


      if (newState.status === "completed") {
        // Close any watch left open by a completion path that skipped the
        // stepped branch — a stale watch would bleed into the next run.
        endStepWatch();
        // Run report + ephemeral cleanup: this is the normal last-phase exit,
        // the executor's terminal branch only sees skipped-last-phase runs.
        finalizeRun(pi, ctx, newState);
        const completedPhases = Object.entries(newState.results)
          .filter(([, r]) => r.status === "completed")
          .map(([id]) => id);
        return {
          content: [{
            type: "text" as const,
            text: `Workflow "${workflow.name}" completed! Phases done: ${completedPhases.join(", ")}.`,
          }],
        };
      }

      if (newState.status === "paused") {
        // Name the REAL park cause — reporting every park as a phase failure
        // trained the model (and the user) to misread verdict parks, freezes
        // and loop exhaustion as crashes.
        const reason = newState.pausedReason ?? "";
        const cause =
          newState.verdictPark
            ? `the phase's verdict was unreadable (${reason.split(":")[2] ?? "no verdict parsed"}); no retry budget was consumed`
            : reason.startsWith("loopback-disabled:") || reason.startsWith("verdicts-disabled:")
              ? `a verdict gate completed but auto-routing is disabled (${reason})`
              : reason.startsWith("anomaly:")
                ? `a sprint numbering anomaly needs manual resolution (${reason})`
                : reason.startsWith("branch-violation:")
                  ? `a verdict gate found the work on a protected branch (${reason})`
                  : reason
                    ? reason
                    : "the phase reported failure";
        return {
          content: [{
            type: "text" as const,
            text: `Phase "${phase.name}" done — workflow PARKED for a human decision: ${cause}. Do NOT call kstack_advance again; the user resolves it via /kstack.`,
          }],
        };
      }

      // Manual gate: decision phases park in awaiting_approval until the user
      // runs /kstack next. The model cannot bypass this — only /kstack next
      // resumes execution.
      if (willManualGate) {
        // STEP 4e (opt-in): a VALIDATED validate-only diagnosis may auto-advance.
        if (!stepGateApplies && autoGateValidated() && isValidatedStrategy(params.summary)) {
          ctx.ui.notify(
            `kstack: "${phase.name}" validated — auto-advancing to "${workflow.phases[newState.phaseIndex]?.name ?? "?"}" (KSTACK_PI_AUTO_GATE_VALIDATED).`,
            "info",
          );
          launchPhase(pi, ctx, newState);
          return {
            content: [{
              type: "text" as const,
              text: `Phase "${phase.name}" recorded as VALIDATED. Auto-gate enabled: advancing to ${workflow.phases[newState.phaseIndex]?.name ?? "?"}.`,
            }],
          };
        }
        const gated = stepGateApplies ? { ...gateForApproval(newState), stepGate: true } : gateForApproval(newState);
        saveState(pi, gated);
        setKstackStatus(ctx, gated, workflow);
        const nextPhase = workflow.phases[gated.phaseIndex];
        // gateId = the phase id — the gateId↔phaseId join must hold for
        // every gate row (S3 review: "manual" broke exactly the common one).
        appendLedger(
          ctx.cwd, state,
          { kind: "gate", phaseId: phase.id, payload: { gateId: phase.id, decision: "human" } },
          (m) => { try { ctx.ui.notify(m, "warning"); } catch { /* stale ctx */ } },
        );
        ctx.ui.notify(
          `kstack: "${phase.name}" complete — review the output, then run /kstack next to proceed to "${nextPhase?.name ?? "?"}".`,
          "info",
        );
        return {
          content: [{
            type: "text" as const,
            text: `Phase "${phase.name}" recorded. This was a decision phase: the workflow is now PAUSED for user approval. Present your results clearly. Do NOT call kstack_advance again and do not start the next phase — the user decides when to continue with /kstack next.`,
          }],
        };
      }

      const nextPhase = workflow.phases[newState.phaseIndex];
      // Fire-and-forget: the chain (possibly including long subagent runs)
      // must not block this tool result, and its errors must never surface as
      // uncaught rejections. See executor.launchPhase.
      launchPhase(pi, ctx, newState);

      // STEP 2g v2: when the next phase is optional in interactive mode, the
      // executor will park the workflow for the user's Run/Skip/Abort decision
      // — tell the model so it does not expect the phase to run on its own.
      const decisionNote =
        nextPhase?.optional && optionalPhases() === "ask"
          ? ` This phase is OPTIONAL: the workflow will pause and the user decides via /kstack whether to run "${nextPhase.name}". Do not call kstack_advance for it.`
          : "";
      return {
        content: [{
          type: "text" as const,
          text: `Phase "${phase.name}" recorded. Advancing to: ${nextPhase.name} (${newState.phaseIndex + 1}/${workflow.phases.length}).${decisionNote}`,
        }],
      };
    },
  });

  // Compaction guard tier 2: the full phase methodology is context-only — after
  // compaction the model can re-fetch it here. Read-only and deterministic
  // (pure function of the persisted state), so it can never be stale.
  pi.registerTool({
    name: "kstack_phase",
    label: "Show Phase Instructions",
    description:
      "Re-fetch the full instructions for the current kstack workflow phase. Call this when the phase's instructions are no longer in your context (e.g. after compaction).",
    promptSnippet: "Re-fetch the current kstack phase's full instructions",
    promptGuidelines: [
      "Call kstack_phase only when a kstack workflow is active and the current phase's instructions are missing from your context",
      "The output is a pure function of the persisted workflow state — it is never stale",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext): Promise<any> {
      const state = loadActiveState(ctx);
      if (!state) {
        return { content: [{ type: "text" as const, text: "No active kstack workflow. Start one with /kstack." }] };
      }
      const workflow = getWorkflow(state.workflowId);
      if (!workflow) {
        return {
          content: [{
            type: "text" as const,
            text: `Unknown workflow "${state.workflowId}" — the persisted state references a workflow this extension does not know (stale state entry?).`,
          }],
        };
      }
      const phase = workflow.phases[state.phaseIndex];
      if (!phase) {
        return {
          content: [{
            type: "text" as const,
            text: `Workflow "${state.workflowId}" has no phase at index ${state.phaseIndex} (status: ${state.status}).`,
          }],
        };
      }
      const git = await detectGitContext(ctx.cwd);
      // A parked workflow still answers — but the instructions end with "call
      // kstack_advance", which the park forbids. Lead with the posture.
      const posture =
        state.status === "active"
          ? ""
          : `[workflow ${state.status}${state.pausedReason ? `: ${state.pausedReason}` : ""} — reference only: do NOT start or continue this phase]\n\n`;
      // S3: a stepped phase re-fetches the CURRENT step's instructions —
      // post-compaction the model self-anchors on exactly the step it owns.
      const currentStep = phase.steps?.length
        ? phase.steps[Math.min(state.stepIndex ?? 0, phase.steps.length - 1)]
        : undefined;
      // Delegated results arrive via a followUp message and are never
      // persisted — after compaction "review the output above" points at
      // nothing. Name the durable record instead. S4: delegation is STEP-level
      // — the section fires for a legacy subagent phase OR a delegated current
      // step; the kstack-report record (.kstack/runs/<runId>/) is the
      // canonical channel under the step model.
      // Stepped phases: only the step's own artifact signal is a real file —
      // the legacy per-phase paths name files the S4 verifier rule forbids.
      const artifactPaths = currentStep
        ? currentStep.signal?.kind === "artifact"
          ? (() => {
              const hits = artifactSignalFiles(ctx.cwd, currentStep.signal.value, runStartMs(state.runId));
              return hits.length ? hits : [path.join(ctx.cwd, currentStep.signal.value)];
            })()
          : []
        : phaseArtifactPaths(phase.id, ctx.cwd, state.sprintNumber);
      const delegated = phase.execution === "subagent" || currentStep?.execution === "subagent";
      const recordLines =
        delegated && deterministicSubagents()
          ? [
              ...(state.runId
                ? [
                    `- ${path.join(".kstack", "runs", state.runId, `${phase.id}${currentStep ? `.${currentStep.id}` : ""}.json`)} (step record)`,
                  ]
                : []),
              ...(artifactPaths.length
                ? artifactPaths.map((p) => `- ${path.relative(ctx.cwd, p) || p}${existsSync(p) ? "" : " (not written yet)"}`)
                : ["- no fixed artifact — recover via git history and the files the phase produced"]),
            ]
          : [];
      const record = recordLines.length
        ? "\n\n### On-disk record\nSpecialist results were delivered in an earlier message and are not persisted — if they are gone from your context, the durable record is:\n" +
          recordLines.join("\n")
        : "";
      const instructions = currentStep
        ? buildStepInstructions(phase, currentStep, { state, git, cwd: ctx.cwd })
        : buildPhaseInstructions(phase, { state, git, cwd: ctx.cwd });
      return {
        content: [{ type: "text" as const, text: posture + instructions + record }],
      };
    },
  });
}
