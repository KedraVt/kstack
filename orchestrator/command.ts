import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAllWorkflows, getWorkflow, getWorkflowIds } from "./workflows.ts";
import { loadActiveState, createState, saveState, abortState, resumeState, reissueGate, approveNext, approveOptionalPhase, skipPendingOptional, isSecurityFrozen, unfreeze, forceApproveParked, returnParkedWithContext, forceContinuePastGate } from "./state.ts";
import { detectGitContext } from "./git.ts";
import { deterministicSubagents } from "./config.ts";
import { launchPhase, executeCurrentPhase, releasePhaseInFlight } from "./executor.ts";
import { writeRunReport } from "./telemetry.ts";
import type { GitContext, WorkflowState } from "./types.ts";

/**
 * Launch the executor with the optional-phase gate disarmed: the user just
 * explicitly approved this phase via the decision panel (or `/gstack next`).
 * Without `approvedOptional`, executeCurrentPhase would park the workflow
 * again instead of running the phase.
 */
function launchApprovedOptional(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: WorkflowState): void {
  launchPhase(pi, ctx, state, (p, c, s) => executeCurrentPhase(p, c, s, { approvedOptional: true }));
}

/**
 * Abort helper: records the aborted state AND releases the duplicate-chain
 * guard for the current phase. Without the release, restarting the same
 * workflow while the aborted run's chain is still settling would have its
 * first launch refused ("already running") — the exact racing class the guard
 * exists to prevent, turned against the user.
 */
function abortWorkflow(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: WorkflowState, message: string): void {
  releasePhaseInFlight(state.workflowId, state.phaseIndex);
  saveState(pi, abortState(state));
  try { ctx.ui.setStatus("gstack", undefined); } catch { /* stale */ }
  ctx.ui.notify(message, "info");
}

export function getCompletions(prefix: string) {
  // AutocompleteItem shape: { value, label, description? }
  const verbs = ["next"].map((v) => ({
    value: v,
    label: v,
    description: "Approve the gated phase and continue",
  }));
  const wf = getAllWorkflows()
    .filter((w) => w.id.startsWith(prefix.toLowerCase()))
    .map((w) => ({ value: w.id, label: w.id, description: w.description }));
  return [...wf, ...verbs];
}

export async function handleGstackCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const argId = args.trim().toLowerCase();

  const activeState = loadActiveState(ctx);

  // Optional-phase decision gate (STEP 2g v2): "/gstack next" while parked at
  // an optional phase means "Run it" — the explicit, foreground twin of the
  // panel choice below. Never a background prompt the user can miss.
  if (activeState?.pendingOptional && activeState.status === "awaiting_approval" && argId === "next") {
    const approved = approveOptionalPhase(activeState);
    saveState(pi, approved);
    ctx.ui.notify("Approved — running the optional phase.", "info");
    launchApprovedOptional(pi, ctx, approved);
    return;
  }

  // Sprint human-control panels (plan B7): freeze / unreadable verdict /
  // numbering anomaly / retry exhaustion. Intercepted for BOTH `/gstack next`
  // and bare `/gstack`, BEFORE any generic resume path — a single keystroke
  // must never bypass a security freeze or a parked verdict.
  if (activeState && (await handleSprintPanel(activeState, ctx, pi))) return;

  // /gstack next — approve a gated (awaiting_approval) workflow and continue.
  if (argId === "next") {
    if (!activeState) {
      ctx.ui.notify("No active workflow to advance.", "warning");
      return;
    }
    if (activeState.status !== "awaiting_approval") {
      const wf = getWorkflow(activeState.workflowId);
      const phaseName = wf?.phases[activeState.phaseIndex]?.name ?? "unknown";
      ctx.ui.notify(`Workflow is not waiting for approval (currently: ${activeState.status}, phase "${phaseName}").`, "warning");
      return;
    }
    const approved = approveNext(activeState);
    saveState(pi, approved);
    ctx.ui.notify("Approved — continuing workflow.", "info");
    launchPhase(pi, ctx, approved);
    return;
  }

  const git = await detectGitContext(ctx.cwd, pi);

  if (activeState) {
    const workflow = getWorkflow(activeState.workflowId);
    const phaseName = workflow?.phases[activeState.phaseIndex]?.name ?? "unknown";
    const progress = `(${activeState.phaseIndex + 1}/${workflow?.phases.length ?? 0})`;

    if (activeState.status === "awaiting_approval" && activeState.pendingOptional) {
      // Optional-phase decision gate (STEP 2g v2): the workflow is parked AT an
      // optional phase. Present explicit Run/Skip/Abort choices — the user
      // decides in the foreground with full context, never via a background
      // prompt that defaults to "Yes" on Enter.
      const wf = getWorkflow(activeState.workflowId);
      const phaseName = wf?.phases[activeState.phaseIndex]?.name ?? "unknown";
      const choice = await ctx.ui.select(
        `Optional phase "${phaseName}" ${progress} — your decision`,
        [
          `Run "${phaseName}" ${progress}`,
          `Skip "${phaseName}" — continue without it`,
          "Abort workflow",
        ],
      );
      if (choice?.startsWith("Run")) {
        const approved = approveOptionalPhase(activeState);
        saveState(pi, approved);
        launchApprovedOptional(pi, ctx, approved);
      } else if (choice?.startsWith("Skip")) {
        const next = skipPendingOptional(activeState, wf?.phases ?? [], wf?.phases.length ?? 0);
        saveState(pi, next);
        if (next.status === "completed") {
          writeRunReport(ctx.cwd, activeState.workflowId);
          ctx.ui.setStatus("gstack", undefined);
          ctx.ui.notify(`Workflow "${activeState.workflowId}" completed (optional phase skipped).`, "info");
        } else {
          ctx.ui.notify(`Skipped "${phaseName}" — continuing workflow.`, "info");
          launchPhase(pi, ctx, next);
        }
      } else if (choice === "Abort workflow") {
        const confirmed = await ctx.ui.confirm("Abort workflow?", `Stop "${activeState.workflowId}"?`);
        if (confirmed) {
          abortWorkflow(pi, ctx, activeState, "Workflow aborted.");
        }
      }
      return;
    }

    if (activeState.status === "awaiting_approval") {
      const choice = await ctx.ui.select(
        "Workflow awaiting your approval",
        [
          `Approve & continue: ${activeState.workflowId} → next phase after "${workflow?.phases[activeState.phaseIndex - 1]?.name ?? "previous phase"}" ${progress}`,
          "Abort workflow",
        ],
      );
      if (choice?.startsWith("Approve")) {
        const approved = approveNext(activeState);
        saveState(pi, approved);
        launchPhase(pi, ctx, approved);
      } else if (choice === "Abort workflow") {
        const confirmed = await ctx.ui.confirm("Abort workflow?", `Stop "${activeState.workflowId}"?`);
        if (confirmed) {
          abortWorkflow(pi, ctx, activeState, "Workflow aborted.");
        }
      }
      return;
    }

    const choice = await ctx.ui.select("Workflow in progress", [
      `Resume: ${activeState.workflowId} → ${phaseName} ${progress}`,
      "Abort workflow",
      "Start new workflow",
    ]);

    if (!choice) return;

    if (choice.startsWith("Resume")) {
      const resumed = resumeState(activeState);
      saveState(pi, resumed);
      launchPhase(pi, ctx, resumed);
      return;
    }

    if (choice === "Abort workflow") {
      const confirmed = await ctx.ui.confirm("Abort workflow?", `Stop "${activeState.workflowId}" at phase ${activeState.phaseIndex + 1}?`);
      if (confirmed) {
        abortWorkflow(pi, ctx, activeState, "Workflow aborted.");
      }
      return;
    }
  }

  if (argId) {
    const workflow = getWorkflow(argId);
    if (workflow) {
      await startWorkflow(workflow.id, ctx, pi, git);
      return;
    }
    ctx.ui.notify(`Unknown workflow: "${argId}". Available: ${getWorkflowIds().join(", ")}`, "warning");
    return;
  }

  const sorted = [...getAllWorkflows()].sort((a, b) => menuScore(b, git) - menuScore(a, git));
  const options = sorted.map((w) => `${w.id} — ${w.description}`);

  const selected = await ctx.ui.select("gstack: What would you like to do?", options);
  if (!selected) return;

  const selectedId = selected.split(" — ")[0];
  await startWorkflow(selectedId, ctx, pi, git);
}

async function startWorkflow(workflowId: string, ctx: ExtensionCommandContext, pi: ExtensionAPI, git: GitContext): Promise<void> {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return;

  // The sprint loop engine routes ONLY on pendingVerdict, which is produced
  // exclusively by the executor's deterministic delegation. Without delegation
  // the gates would silently degrade to model-say-so advancement (Q2 fix).
  if (workflow.id === "sprint" && !deterministicSubagents()) {
    ctx.ui.notify(
      `The "sprint" workflow requires deterministic subagent delegation (GSTACK_PI_DETERMINISTIC). It is currently disabled: the review gates would be inert. Re-enable it or pick another workflow.`,
      "warning",
    );
    return;
  }

  const goal = await ctx.ui.input("Describe your goal", `e.g. "Add dark mode to the settings page"`);
  if (!goal) return;

  const state = createState(workflowId, goal);
  saveState(pi, state);

  ctx.ui.notify(`Starting: ${workflow.name} (${workflow.phases.length} phases)`, "info");
  launchPhase(pi, ctx, state);
}

function menuScore(w: { id: string }, git: GitContext): number {
  switch (w.id) {
    case "ship":
      return git.hasStagedChanges || git.aheadOfRemote > 0 ? 10 : 2;
    case "investigate":
      return git.hasUncommittedChanges ? 7 : 3;
    case "review":
      return git.aheadOfRemote > 0 ? 8 : 3;
    case "qa":
      return 5;
    case "qa-report":
      return 4;
    case "develop":
      return git.isMainBranch ? 6 : 4;
    case "quick":
      return 1;
    default:
      return 0;
  }
}

// --- Sprint human-control panels (plan B7 / D3, D4, D11) ---------------------

const FREEZE_RESUME_PHRASE = "security remediation approved";

/**
 * Interactive resolution of the sprint workflow's human-control states.
 * Returns true when the state was handled (caller must NOT fall through to
 * the generic resume/menu paths — that would let one keystroke bypass a
 * security freeze or an unresolved verdict).
 *
 * Every panel offers an explicit escape; nothing auto-resumes. Headless/RPC:
 * ctx.ui is the extension's only UI channel (same as every existing gate) —
 * no separate !hasUI protocol exists to hook into.
 */
export async function handleSprintPanel(state: WorkflowState, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<boolean> {
  if (state.workflowId !== "sprint") return false;
  const phases = getWorkflow("sprint")?.phases ?? [];

  // D3 SECURITY FREEZE: blocked until the typed confirmation phrase arrives.
  if (isSecurityFrozen(state)) {
    const info = state.freezeInfo;
    const answer = await ctx.ui.input(
      "SECURITY FREEZE",
      `A ${info?.severity ?? "critical/high"}-severity security rejection froze the sprint at "${info?.phaseId}".\n\n` +
        `Review ${info?.artifactPath ?? "devsecops/security-review-artifact.md"} with your security panel FIRST.\n` +
        `Type exactly "${FREEZE_RESUME_PHRASE}" to unfreeze and re-run the review gate. Leave empty to keep the freeze; type ABORT to abandon the workflow.`,
    );
    if (answer !== undefined && answer.trim().toLowerCase() === FREEZE_RESUME_PHRASE) {
      const unfrozen = unfreeze(state);
      saveState(pi, unfrozen);
      ctx.ui.notify("Freeze lifted — re-running the devsecops review gate.", "info");
      launchPhase(pi, ctx, unfrozen);
    } else if (answer !== undefined && answer.trim().toUpperCase() === "ABORT") {
      // Review W3: an explicit escape hatch — the freeze must never soft-lock
      // a user who lost the phrase or wants to abandon the sprint.
      if (await ctx.ui.confirm("Abort frozen workflow?", `Abandon "sprint" despite the unresolved security finding?`)) {
        abortWorkflow(pi, ctx, state, "Frozen workflow aborted.");
      }
    } else {
      ctx.ui.notify(`Freeze kept${answer === undefined ? " (prompt dismissed)" : answer.trim() === "" ? "" : " — exact phrase not provided"}.`, "warning");
    }
    return true;
  }

  // D4 UNREADABLE VERDICT PARK: fixed choices over ONLY the failing lines.
  if (state.verdictPark) {
    const phaseId = state.verdictPark;
    const excerpt = state.pendingVerdict?.excerpt?.trim() || "(no verdict-shaped lines found in the subagent HANDOFF)";
    const choice = await ctx.ui.select(
      `Verdict unreadable in "${phaseId}" — parked WITHOUT burning an attempt. Verdict lines found: ${excerpt.slice(0, 200)}`,
      ["Continue as approved", "Return phase with context", "View report excerpt", "Other…", "Abort workflow"],
    );
    if (choice === "Continue as approved") {
      const next = forceApproveParked(state);
      saveState(pi, next);
      launchPhase(pi, ctx, next);
    } else if (choice === "Return phase with context" || choice === "Other…") {
      const extra = await ctx.ui.input(
        "Feedback for the retried phase",
        "Optional custom guidance appended to the RETRY CONTEXT (empty = rely on extracted blockers)",
      );
      const next = returnParkedWithContext(state, phases, extra?.trim() || undefined);
      if (!next) {
        ctx.ui.notify("Cannot loop back: the parked phase has no loopBackTo target.", "error");
        return true;
      }
      saveState(pi, next);
      launchPhase(pi, ctx, next);
    } else if (choice === "View report excerpt") {
      ctx.ui.notify(`Verdict excerpt: ${excerpt.slice(0, 1500)}`, "info");
    } else if (choice === "Abort workflow") {
      if (await ctx.ui.confirm("Abort workflow?", `Stop "sprint" at phase ${state.phaseIndex + 1}?`)) {
        abortWorkflow(pi, ctx, state, "Workflow aborted.");
      }
    }
    return true; // handled either way — never fall through while parked
  }

  const reason = state.pausedReason ?? "";
  // Kill-switch parks (F2 fix): with GSTACK_PI_VERDICTS/_LOOPBACKS off, a
  // completed verdict-bearing gate pauses with verdicts-disabled:/
  // loopback-disabled:. Without a decision surface the only exits were Abort
  // or an endless Resume→re-run→pause loop — the documented "human decides"
  // contract had no decision UI. Offer the same choices as loop exhaustion.
  if (state.status === "paused" && (reason.startsWith("verdicts-disabled:") || reason.startsWith("loopback-disabled:"))) {
    const choice = await ctx.ui.select(`Sprint paused — ${reason}`, [
      "Accept result — continue past the gate",
      "Re-run the gated phase",
      "Abort workflow",
    ]);
    if (choice === "Accept result — continue past the gate") {
      const next = forceContinuePastGate(state, phases);
      saveState(pi, next);
      launchPhase(pi, ctx, next);
    } else if (choice === "Re-run the gated phase") {
      const resumed = resumeState(state);
      saveState(pi, resumed);
      launchPhase(pi, ctx, resumed);
    } else if (choice === "Abort workflow") {
      if (await ctx.ui.confirm("Abort workflow?", `Stop "sprint" at phase ${state.phaseIndex + 1}?`)) {
        abortWorkflow(pi, ctx, state, "Workflow aborted.");
      }
    }
    return true;
  }

  // Loop exhaustion / numbering anomaly: paused for a HUMAN decision.
  if (state.status === "paused" && (reason.startsWith("loop-exhausted:") || reason.startsWith("anomaly:"))) {
    const exhausted = reason.startsWith("loop-exhausted:");
    const choices = exhausted
      ? ["Re-run the gated phase (+1 verified attempt)", "Accept result — continue past the gate", "Abort workflow"]
      : ["Resume (re-checks sprint numbering first)", "Abort workflow"];
    const choice = await ctx.ui.select(`Sprint paused — ${reason}`, choices);
    if (choice === "Resume (re-checks sprint numbering first)") {
      const resumed = resumeState(state);
      saveState(pi, resumed);
      launchPhase(pi, ctx, resumed);
    } else if (choice === "Re-run the gated phase (+1 verified attempt)") {
      // B9: a bare resume would re-park on the FIRST rejection (the attempt
      // counter is already at the ceiling). reissueGate restores exactly one
      // verified run of the loop target before the loop re-exhausts.
      const reissued = reissueGate(state, phases);
      saveState(pi, reissued);
      launchPhase(pi, ctx, reissued);
    } else if (exhausted && choice === "Accept result — continue past the gate") {
      const next = forceContinuePastGate(state, phases);
      saveState(pi, next);
      launchPhase(pi, ctx, next);
    } else if (choice === "Abort workflow") {
      if (await ctx.ui.confirm("Abort workflow?", `Stop "sprint" at phase ${state.phaseIndex + 1}?`)) {
        abortWorkflow(pi, ctx, state, "Workflow aborted.");
      }
    }
    return true;
  }

  return false;
}
