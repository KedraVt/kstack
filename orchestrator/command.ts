import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAllWorkflows, getWorkflow, getWorkflowIds } from "./workflows.ts";
import { loadActiveState, createState, saveState, abortState, resumeState, reissueGate, approveNext, approveEntryGate, approveOptionalPhase, skipPendingOptional, isSecurityFrozen, unfreeze, forceApproveParked, returnParkedWithContext, forceContinuePastGate } from "./state.ts";
import { detectGitContext } from "./git.ts";
import { initAgentsMd } from "./init.ts";
import { deterministicSubagents } from "./config.ts";
import { gateInventory, configureGates } from "./gates.ts";
import { launchPhase, executeCurrentPhase, releasePhaseInFlight, isPhaseInFlight, invalidateRuntime } from "./executor.ts";
import { writeRunReport } from "./telemetry.ts";
import { appendLedger } from "./ledger.ts";
import { endStepWatch } from "./stuck.ts";
import type { GitContext, WorkflowState } from "./types.ts";

/**
 * Launch the executor with the optional-phase gate disarmed: the user just
 * explicitly approved this phase via the decision panel (or `/kstack next`).
 * Without `approvedOptional`, executeCurrentPhase would park the workflow
 * again instead of running the phase.
 */
function launchApprovedOptional(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: WorkflowState): void {
  launchPhase(pi, ctx, state, (p, c, s) => executeCurrentPhase(p, c, s, { approvedOptional: true }));
}

/**
 * Skip/approve decision guard (2026-09 session post-mortem): a decision made
 * while a delegation chain for the current phase is STILL running double-fires
 * the pipeline — the 2026-08-31 incident showed a refused phase executing
 * anyway and the workflow advancing one phase too far (7 instead of 6).
 * The decision is refused without mutating any state; the chain's results are
 * then applied normally (or dropped by the B7 staleness check), so exactly one
 * execution ever counts.
 */
export function decisionBlockedByInFlightChain(
  ctx: ExtensionCommandContext,
  state: WorkflowState,
): boolean {
  if (!isPhaseInFlight(state.workflowId, state.phaseIndex)) return false;
  ctx.ui.notify(
    `kstack: a delegation chain for phase ${state.phaseIndex + 1} of "${state.workflowId}" is still running — decision refused. Wait for it to finish, or abort the workflow first.`,
    "warning",
  );
  return true;
}

/**
 * Abort helper: records the aborted state AND releases the duplicate-chain
 * guard for the current phase. Without the release, restarting the same
 * workflow while the aborted run's chain is still settling would have its
 * first launch refused ("already running") — the exact racing class the guard
 * exists to prevent, turned against the user.
 */
/**
 * The phase whose park a human resolution releases: verdict parks name the
 * phase directly; kill-switch/exhaustion reasons encode it after the first
 * colon; entry gates park AT the gated phase; post-completion manual gates
 * park one index past the completed phase; optional phases park at
 * phaseIndex. Falls back to the workflow id when nothing resolves.
 */
function parkedGateId(state: WorkflowState): string {
  if (state.verdictPark) return state.verdictPark;
  const reason = state.pausedReason ?? "";
  for (const p of ["verdicts-disabled:", "loopback-disabled:"]) {
    if (reason.startsWith(p)) return reason.slice(p.length).split(":")[0] || state.workflowId;
  }
  const phases = getWorkflow(state.workflowId)?.phases ?? [];
  const idx =
    state.entryGate || state.pendingOptional ? state.phaseIndex
    : state.status === "awaiting_approval" ? state.phaseIndex - 1
    : state.phaseIndex;
  return phases[idx]?.id ?? phases[state.phaseIndex]?.id ?? state.workflowId;
}

/**
 * Audit one interactive gate resolution (D28/INV-L1): parks and
 * env/override decisions are ledgered at their sites — the human's actual
 * Run/Skip/Abort click must land too, or the trail cannot prove WHO released
 * a gate. `gateId` = the phase whose park is being resolved.
 */
function auditGateDecision(
  ctx: ExtensionCommandContext,
  state: WorkflowState,
  decision: "run" | "skip" | "abort" | "return",
): void {
  const phaseId = parkedGateId(state);
  appendLedger(
    ctx.cwd, state,
    { kind: "gate", phaseId, payload: { gateId: phaseId, decision } },
    (m) => { try { ctx.ui.notify(m, "warning"); } catch { /* stale ctx */ } },
  );
}

function abortWorkflow(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: WorkflowState, message: string): void {
  // Invalidate first: any in-flight delegation's shouldAbort() flips false→
  // true and the spawn loop terminates the child (SIGKILL). Previously the
  // orphaned chain kept running to completion, burning tokens after "aborted"
  // and racing a same-id restart for the in-flight registry.
  invalidateRuntime();
  releasePhaseInFlight(state.workflowId, state.phaseIndex);
  endStepWatch();
  auditGateDecision(ctx, state, "abort");
  saveState(pi, abortState(state));
  try { ctx.ui.setStatus("kstack", undefined); } catch { /* stale */ }
  ctx.ui.notify(message, "info");
}

export function getCompletions(prefix: string) {
  // AutocompleteItem shape: { value, label, description? }
  const verbs = [
    { value: "next", label: "next", description: "Approve the gated phase and continue" },
    { value: "init", label: "init", description: "Install kstack rules into AGENTS.md" },
  ];
  const wf = getAllWorkflows()
    .filter((w) => w.id.startsWith(prefix.toLowerCase()))
    .map((w) => ({ value: w.id, label: w.id, description: w.description }));
  return [...wf, ...verbs];
}

export async function handleKstackCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const argId = args.trim().toLowerCase();

  // /kstack init — install/refresh the managed rules block in AGENTS.md.
  // Orthogonal to workflow state: handled before loadActiveState so a parked
  // sprint's panels never intercept it.
  if (argId === "init") {
    const res = initAgentsMd(ctx.cwd);
    const msgs = {
      created: `Created ${res.file} with the kstack rules block.`,
      installed: `Installed the kstack rules block in ${res.file}.`,
      upgraded: `Upgraded the legacy rules block in ${res.file} to kstack.`,
      refreshed: `Refreshed the kstack rules block in ${res.file}.`,
      unchanged: `${res.file} already has the current kstack block.`,
    } as const;
    ctx.ui.notify(msgs[res.status], "info");
    return;
  }

  const activeState = loadActiveState(ctx);

  // Optional-phase decision gate (STEP 2g v2): "/kstack next" while parked at
  // an optional phase means "Run it" — the explicit, foreground twin of the
  // panel choice below. Never a background prompt the user can miss.
  if (activeState?.pendingOptional && activeState.status === "awaiting_approval" && argId === "next") {
    if (decisionBlockedByInFlightChain(ctx, activeState)) return;
    const approved = approveOptionalPhase(activeState);
    auditGateDecision(ctx, activeState, "run");
    saveState(pi, approved);
    ctx.ui.notify("Approved — running the optional phase.", "info");
    launchApprovedOptional(pi, ctx, approved);
    return;
  }

  // Sprint human-control panels (plan B7): freeze / unreadable verdict /
  // numbering anomaly / retry exhaustion. Intercepted for BOTH `/kstack next`
  // and bare `/kstack`, BEFORE any generic resume path — a single keystroke
  // must never bypass a security freeze or a parked verdict.
  if (activeState && (await handleSprintPanel(activeState, ctx, pi))) return;

  // /kstack next — approve a gated (awaiting_approval) workflow and continue.
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
    if (decisionBlockedByInFlightChain(ctx, activeState)) return;
    // entryGate parks BEFORE the gated phase runs — a plain approveNext would
    // leave the marker at `true` and executeCurrentPhase would re-park.
    const approved = activeState.entryGate === true ? approveEntryGate(activeState) : approveNext(activeState);
    auditGateDecision(ctx, activeState, "run");
    saveState(pi, approved);
    ctx.ui.notify("Approved — continuing workflow.", "info");
    launchPhase(pi, ctx, approved);
    return;
  }

  const git = await detectGitContext(ctx.cwd);

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
        if (decisionBlockedByInFlightChain(ctx, activeState)) return;
        const approved = approveOptionalPhase(activeState);
        auditGateDecision(ctx, activeState, "run");
        saveState(pi, approved);
        launchApprovedOptional(pi, ctx, approved);
      } else if (choice?.startsWith("Skip")) {
        if (decisionBlockedByInFlightChain(ctx, activeState)) return;
        const next = skipPendingOptional(activeState, wf?.phases ?? [], wf?.phases.length ?? 0);
        auditGateDecision(ctx, activeState, "skip");
        saveState(pi, next);
        if (next.status === "completed") {
          writeRunReport(ctx.cwd, activeState.workflowId);
          ctx.ui.setStatus("kstack", undefined);
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
      const entryGated = activeState.entryGate === true;
      const choice = await ctx.ui.select(
        "Workflow awaiting your approval",
        [
          entryGated
            ? `Approve & RUN: ${activeState.workflowId} → gated phase "${phaseName}" ${progress} (it has not executed yet)`
            : `Approve & continue: ${activeState.workflowId} → next phase after "${workflow?.phases[activeState.phaseIndex - 1]?.name ?? "previous phase"}" ${progress}`,
          "Abort workflow",
        ],
      );
      if (choice?.startsWith("Approve")) {
        if (decisionBlockedByInFlightChain(ctx, activeState)) return;
        const approved = entryGated ? approveEntryGate(activeState) : approveNext(activeState);
        auditGateDecision(ctx, activeState, "run");
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
      // Same racing class as the decision panels: a resume while a delegation
      // is still in flight launches a second chain for the same phase.
      if (decisionBlockedByInFlightChain(ctx, activeState)) return;
      const resumed = resumeState(activeState);
      // No ledger row: this branch resumes stuck:/step-failed:/budget parks —
      // detector events, not gate releases. The resume is inferable from the
      // step entries that follow (S3 review: audit-trail over-attribution).
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

    if (choice === "Start new workflow") {
      // Explicit user choice — record the old workflow as aborted so a new
      // state's loadActiveState isn't shadowed, and refuse while a chain is
      // in flight (the orphaned children would keep burning tokens).
      if (decisionBlockedByInFlightChain(ctx, activeState)) return;
      abortWorkflow(pi, ctx, activeState, `Aborted "${activeState.workflowId}" — pick a new workflow.`);
      // fall through to the menu below
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

  const selected = await ctx.ui.select("kstack: What would you like to do?", options);
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
      `The "sprint" workflow requires deterministic subagent delegation (KSTACK_PI_DETERMINISTIC). It is currently disabled: the review gates would be inert. Re-enable it or pick another workflow.`,
      "warning",
    );
    return;
  }

  const goal = await ctx.ui.input("Describe your goal", `e.g. "Add dark mode to the settings page"`);
  if (!goal) return;

  // S3/D20 pre-flight configure (TRANSIENT — never a persisted status):
  // enumerate the gates this workflow can actually fire and, in interactive
  // mode only, let the user choose per-gate handling BEFORE the state exists.
  // Dismissed/headless ⇒ human-gate defaults; the kstack_start tool path never
  // engages configure (env defaults apply there).
  const gateRows = gateInventory(workflow);
  let gateMode: WorkflowState["gateMode"] = "human-gate";
  let gateOverrides: WorkflowState["gateOverrides"] = {};
  // TUI-only by design: RPC mode also exposes dialog UI (ctx.hasUI) but a
  // remote caller cannot see a dialog — the conservative default skips
  // configure and applies env/human-gate defaults (S3 review note).
  if (gateRows.length > 0 && ctx.mode === "tui") {
    const config = await configureGates(gateRows, ctx, workflow.name);
    if (config) {
      gateMode = config.gateMode;
      gateOverrides = config.gateOverrides;
    }
  }

  const state: WorkflowState = { ...createState(workflowId, goal), gateMode, gateOverrides };
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
 * F4 guard (2026-09 handoff): sprint panels can mutate state and relaunch a
 * phase while a delegation chain for the same phase is still running — the
 * same racing class fixed for the GENERIC paths via decisionBlockedByInFlightChain.
 * The executor's B7 staleness check would drop the racing chain's results for
 * same-process relaunches, so state does not corrupt; the residual exposure is
 * the double-launch class the guard exists to prevent.
 *
 * Panels must never fall through: while parked, a "handled" panel returning
 * false would expose the generic resume path to exactly the bypass the panels
 * exist to prevent. So a refused decision still returns true (handled) — the
 * user stays parked and re-decides after the chain settles.
 */
function panelGuard(ctx: ExtensionCommandContext, state: WorkflowState): boolean {
  if (!decisionBlockedByInFlightChain(ctx, state)) return false;
  return true; // refused, but the park is still handled — never fall through
}

/**
 * Interactive resolution of the sprint workflow's human-control states.
 * Returns true when the state was handled (caller must NOT fall through to
 * the generic resume/menu paths — that would let one keystroke bypass a
 * security freeze or an unresolved verdict).
 *
 * Every panel offers an explicit escape; nothing auto-resumes. Decision
 * mutations are guarded by panelGuard (F4): a choice taken while a delegation
 * chain for the phase is still in flight is refused WITHOUT state mutation,
 * and the panel still returns true (handled) — never falls through.
 *
 * Headless/RPC:
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
      if (panelGuard(ctx, state)) return true;
      const unfrozen = unfreeze(state, getWorkflow(state.workflowId)?.phases);
      auditGateDecision(ctx, state, "run");
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
    // pausedReason encodes the park cause as "verdict-unreadable:<phaseId>:<cause>"
    // (state.ts); parks written before the cause existed fall back to no-verdict.
    const cause = state.pausedReason?.split(":")[2] ?? "no-verdict";
    const causeText =
      cause === "artifact-mismatch"
        ? "the parsed HANDOFF verdict disagrees with the on-disk artifact"
        : cause === "unroutable"
          ? "a whitelisted verdict value is off this phase's expectation map"
          : "the agent emitted no trustworthy verdict";
    const excerpt = state.pendingVerdict?.excerpt?.trim() || "(no verdict-shaped lines found in the subagent HANDOFF)";
    const choice = await ctx.ui.select(
      `Verdict unreadable in "${phaseId}" — ${causeText} — parked WITHOUT burning an attempt. Verdict lines found: ${excerpt.slice(0, 200)}`,
      ["Continue as approved", "Return phase with context", "View report excerpt", "Other…", "Abort workflow"],
    );
    if (choice === "Continue as approved") {
      if (panelGuard(ctx, state)) return true;
      const next = forceApproveParked(state, phases);
      auditGateDecision(ctx, state, "run");
      saveState(pi, next);
      launchPhase(pi, ctx, next);
    } else if (choice === "Return phase with context" || choice === "Other…") {
      const extra = await ctx.ui.input(
        "Feedback for the retried phase",
        "Optional custom guidance appended to the RETRY CONTEXT (empty = rely on extracted blockers)",
      );
      if (panelGuard(ctx, state)) return true;
      const next = returnParkedWithContext(state, phases, extra?.trim() || undefined, ctx.cwd);
      if (!next) {
        ctx.ui.notify("Cannot loop back: the parked phase has no loopBackTo target.", "error");
        return true;
      }
      auditGateDecision(ctx, state, "return");
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
  // Kill-switch parks (F2 fix): with KSTACK_PI_VERDICTS/_LOOPBACKS off, a
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
      if (panelGuard(ctx, state)) return true;
      const next = forceContinuePastGate(state, phases);
      auditGateDecision(ctx, state, "run");
      saveState(pi, next);
      launchPhase(pi, ctx, next);
    } else if (choice === "Re-run the gated phase") {
      if (panelGuard(ctx, state)) return true;
      const resumed = resumeState(state);
      auditGateDecision(ctx, state, "run");
      saveState(pi, resumed);
      launchPhase(pi, ctx, resumed);
    } else if (choice === "Abort workflow") {
      if (await ctx.ui.confirm("Abort workflow?", `Stop "sprint" at phase ${state.phaseIndex + 1}?`)) {
        abortWorkflow(pi, ctx, state, "Workflow aborted.");
      }
    }
    return true;
  }

  // Loop exhaustion / numbering anomaly / branch violation: paused for a HUMAN decision.
  if (state.status === "paused" && (reason.startsWith("loop-exhausted:") || reason.startsWith("anomaly:") || reason.startsWith("branch-violation:"))) {
    const exhausted = reason.startsWith("loop-exhausted:");
    const choices = exhausted
      ? ["Re-run the gated phase (+1 verified attempt)", "Accept result — continue past the gate", "Abort workflow"]
      : [reason.startsWith("branch-violation:") ? "Resume (re-checks the git branch first)" : "Resume (re-checks sprint numbering first)", "Abort workflow"];
    const choice = await ctx.ui.select(`Sprint paused — ${reason}`, choices);
    if (choice?.startsWith("Resume")) {
      if (panelGuard(ctx, state)) return true;
      const resumed = resumeState(state);
      // No ledger row: this branch only fires for anomaly:/branch-violation:
      // parks (exhausted loops show Re-run/Accept instead) — ops parks, not
      // gate releases.
      saveState(pi, resumed);
      launchPhase(pi, ctx, resumed);
    } else if (choice === "Re-run the gated phase (+1 verified attempt)") {
      // B9: a bare resume would re-park on the FIRST rejection (the attempt
      // counter is already at the ceiling). reissueGate restores exactly one
      // verified run of the loop target before the loop re-exhausts.
      if (panelGuard(ctx, state)) return true;
      const reissued = reissueGate(state, phases);
      auditGateDecision(ctx, state, "run");
      saveState(pi, reissued);
      launchPhase(pi, ctx, reissued);
    } else if (exhausted && choice === "Accept result — continue past the gate") {
      if (panelGuard(ctx, state)) return true;
      const next = forceContinuePastGate(state, phases);
      auditGateDecision(ctx, state, "run");
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
