import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { handleGstackCommand, getCompletions } from "./command.ts";
import { createInputRouter } from "./router.ts";
import { loadActiveState, saveState, advancePhase, gateForApproval, createState } from "./state.ts";
import type { AdvanceOptions } from "./state.ts";
import { getWorkflow, getWorkflowIds } from "./workflows.ts";
import { launchPhase, invalidateRuntime, advanceBlockReason } from "./executor.ts";
import { manualGates, autoGateValidated, optionalPhases, deterministicSubagents } from "./config.ts";
import { parsePlanFileMarker } from "./templates.ts";
import { isValidatedStrategy } from "./skip.ts";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { ensureRun, writeRunReport } from "./telemetry.ts";
import { SECURITY_SECTION } from "../lib/content-security.ts";

export function initOrchestrator(pi: ExtensionAPI): void {
  // WP2 §4.1: teach the model what the untrusted-content envelope markers mean.
  // Defensive `(pi as any)` + try/catch mirrors the session-event handling
  // above: older pi versions without before_agent_start simply skip it.
  try {
    (pi as any).on("before_agent_start", async (event: { systemPrompt?: string }) => ({
      systemPrompt: (event.systemPrompt ?? "") + "\n\n" + SECURITY_SECTION,
    }));
  } catch {
    /* event not supported by this pi version */
  }

  // Invalidate all in-flight background chains when the session is replaced,
  // reloaded or forked. Without this, a subagent chain started before the
  // reload keeps running against a stale ExtensionContext and any ctx.ui
  // access throws "Extension ctx is stale" — which, uncaught, kills pi.
  for (const ev of ["session_shutdown", "session_before_switch", "session_before_fork"] as const) {
    try {
      (pi as any).on(ev, () => invalidateRuntime());
    } catch {
      /* event not supported by this pi version */
    }
  }

  pi.registerCommand("gstack", {
    description: "Guided workflow orchestrator: develop, investigate, qa, ship, review (next: approve gated phase)",
    getArgumentCompletions: getCompletions,
    handler: async (args: string, ctx) => {
      await handleGstackCommand(args, ctx as any, pi);
    },
  });

  pi.on("input", createInputRouter(pi) as any);

  pi.registerTool({
    name: "gstack_advance",
    label: "Advance Workflow",
    description:
      "Signal completion of the current gstack workflow phase. ALWAYS call this yourself when a phase's work is done — never tell the user to run commands instead. On decision phases the workflow pauses for user approval after this call; the orchestrator handles that.",
    promptSnippet: "Advance the active gstack workflow to the next phase",
    promptGuidelines: [
      "Only call gstack_advance when a gstack workflow phase is active",
      "Provide a concise 2-3 sentence summary of what was accomplished",
      "Use status 'failed' if the phase could not be completed",
      "Never ask the user to run /gstack or any other command to progress — calling this tool IS the progression mechanism",
    ],
    parameters: Type.Object({
      summary: Type.String({ description: "2-3 sentence summary of what was accomplished in this phase" }),
      status: Type.Union([Type.Literal("completed"), Type.Literal("failed")], { description: "Whether the phase succeeded or failed" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext): Promise<any> {
      const state = loadActiveState(ctx);
      if (!state) {
        return { content: [{ type: "text" as const, text: "No active gstack workflow. Start one with /gstack." }] };
      }

      const workflow = getWorkflow(state.workflowId);
      if (!workflow) {
        return { content: [{ type: "text" as const, text: `Unknown workflow: ${state.workflowId}` }], isError: true };
      }

      const phase = workflow.phases[state.phaseIndex];

      // Optional-phase decision gate (STEP 2g v2): while the workflow is parked
      // at an optional phase awaiting the user's Run/Skip/Abort decision, the
      // model can neither complete nor skip the phase via gstack_advance — the
      // decision belongs exclusively to the /gstack panel.
      if (state.pendingOptional) {
        return {
          content: [{
            type: "text" as const,
            text: `The workflow is parked at the optional phase "${phase?.name ?? "?"}" awaiting an explicit user decision (Run / Skip / Abort) via /gstack. Do NOT call gstack_advance again and do not start the phase — the user decides.`,
          }],
        };
      }

      // Advance-block guard (audit fix): the state machine, not the model,
      // decides when a phase may be recorded. Two cases are refused: a parked
      // manual gate (only /gstack next continues it) and an in-flight
      // delegation (its results, not a model summary, complete the phase).
      const blocked = advanceBlockReason(state);
      if (blocked) {
        return {
          content: [{
            type: "text" as const,
            text: `gstack: ${blocked}. Do NOT call gstack_advance again.`,
          }],
        };
      }

      // Sprint loop engine (D1–D3): verdict routing needs the phase list and
      // cwd; the pendingVerdict was stashed at delegation time.
      const advanceOpts: AdvanceOptions = { phases: workflow.phases, cwd: ctx.cwd };
      const newState = advancePhase(
        state,
        phase.id,
        { status: params.status, summary: params.summary },
        workflow.phases.length,
        advanceOpts,
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
                `gstack: plan summary reported "${planFile}" but the file does not exist — falling back to the default plan path.`,
                "warning",
              );
            }
          } catch {
            /* unreadable cwd — keep the legacy fallback */
          }
        }
      }
      saveState(pi, newState);

      // D3 security freeze surfaced to both model and user.
      if (newState.frozenUntilHuman) {
        const info = newState.freezeInfo;
        return {
          content: [{
            type: "text" as const,
            text: `SECURITY FREEZE: ${info?.severity ?? "critical/high"} severity security rejection in "${phase.id}". The pipeline is FROZEN — no further automated work. A human security panel must review devsecops/security-review-artifact.md; only /gstack next can unfreeze after that review. Do NOT attempt fixes or call gstack_advance again.`,
          }],
          isError: false,
        };
      }

      if (newState.pausedReason?.startsWith("loop-exhausted:")) {
        return {
          content: [{
            type: "text" as const,
            text: `Retry budget exhausted (${newState.pausedReason}). Workflow paused for human decision — review the latest artifacts with the user; /gstack next continues past this gate manually.`,
          }],
        };
      }


      if (newState.status === "completed") {
        ctx.ui.setStatus("gstack", undefined);
        // STEP 0 telemetry: flush the structured run report for this run.
        writeRunReport(ctx.cwd, state.workflowId);
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
        ctx.ui.setStatus("gstack", undefined);
        return {
          content: [{
            type: "text" as const,
            text: `Phase "${phase.name}" failed. Workflow paused. The user can resume via /gstack.`,
          }],
        };
      }

      // Manual gate: decision phases park in awaiting_approval until the user
      // runs /gstack next. The model cannot bypass this — only /gstack next
      // resumes execution.
      if (manualGates() && phase.advance === "manual" && params.status === "completed") {
        // STEP 4e (opt-in): a VALIDATED validate-only diagnosis may auto-advance.
        if (autoGateValidated() && isValidatedStrategy(params.summary)) {
          ctx.ui.notify(
            `gstack: "${phase.name}" validated — auto-advancing to "${workflow.phases[newState.phaseIndex]?.name ?? "?"}" (GSTACK_PI_AUTO_GATE_VALIDATED).`,
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
        const gated = gateForApproval(newState);
        saveState(pi, gated);
        const nextPhase = workflow.phases[gated.phaseIndex];
        ctx.ui.notify(
          `gstack: "${phase.name}" complete — review the output, then run /gstack next to proceed to "${nextPhase?.name ?? "?"}".`,
          "info",
        );
        return {
          content: [{
            type: "text" as const,
            text: `Phase "${phase.name}" recorded. This was a decision phase: the workflow is now PAUSED for user approval. Present your results clearly. Do NOT call gstack_advance again and do not start the next phase — the user decides when to continue with /gstack next.`,
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
          ? ` This phase is OPTIONAL: the workflow will pause and the user decides via /gstack whether to run "${nextPhase.name}". Do not call gstack_advance for it.`
          : "";
      return {
        content: [{
          type: "text" as const,
          text: `Phase "${phase.name}" recorded. Advancing to: ${nextPhase.name} (${newState.phaseIndex + 1}/${workflow.phases.length}).${decisionNote}`,
        }],
      };
    },
  });

  // Programmatic workflow entry point. Because subagent processes load this
  // extension too, any agent (main or spawned) can bootstrap a workflow by
  // calling this tool — no slash command required.
  pi.registerTool({
    name: "gstack_start",
    label: "Start Workflow",
    description:
      "Start a gstack guided workflow programmatically. Workflows: develop | investigate | qa | qa-report | ship | review | quick | sprint. Use when a task matches one of these pipelines and no workflow is currently active.",
    promptSnippet: "Start a gstack workflow (develop, investigate, qa, qa-report, ship, review, quick, sprint)",
    parameters: Type.Object({
      workflow: Type.String({ description: "Workflow id: develop | investigate | qa | qa-report | ship | review | quick | sprint" }),
      goal: Type.String({ description: "What the workflow should accomplish" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext): Promise<any> {
      const existing = loadActiveState(ctx);
      if (existing) {
        return {
          content: [{
            type: "text" as const,
            text: `A "${existing.workflowId}" workflow is already ${existing.status} at phase ${existing.phaseIndex + 1}. Finish or abort it before starting a new one.`,
          }],
          isError: true,
        };
      }
      const workflow = getWorkflow(params.workflow.toLowerCase());
      if (!workflow) {
        return {
          content: [{
            type: "text" as const,
            text: `Unknown workflow "${params.workflow}". Available: ${getWorkflowIds().join(", ")}.`,
          }],
          isError: true,
        };
      }
      // Sprint gates route ONLY on pendingVerdict (executor delegation output);
      // without deterministic delegation they would be inert (Q2 fix).
      if (workflow.id === "sprint" && !deterministicSubagents()) {
        return {
          content: [{
            type: "text" as const,
            text: `The "sprint" workflow requires deterministic subagent delegation (GSTACK_PI_DETERMINISTIC). It is currently disabled: the review gates would be inert. Re-enable it or use a different workflow.`,
          }],
          isError: true,
        };
      }
      const state = createState(workflow.id, params.goal);
      saveState(pi, state);
      ensureRun(state.workflowId); // STEP 0 telemetry: start accumulating
      ctx.ui.notify(`gstack: starting ${workflow.name} (${workflow.phases.length} phases)`, "info");
      // Non-blocking: phase instructions arrive as a follow-up message once
      // any deterministic subagent work for the first phase has completed.
      launchPhase(pi, ctx, state);
      return {
        content: [{
          type: "text" as const,
          text: `Started workflow "${workflow.id}" (${workflow.phases.length} phases). The first phase instructions will arrive shortly.`,
        }],
      };
    },
  });
}
