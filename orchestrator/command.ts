import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAllWorkflows, getWorkflow, getWorkflowIds } from "./workflows.ts";
import { loadActiveState, createState, saveState, abortState, resumeState, reissueGate, approveNext, approveEntryGate, approveOptionalPhase, skipPendingOptional, isSecurityFrozen, forceApproveParked, returnParkedWithContext, forceContinuePastGate, advancePhase, recordStepResult, returnTargetFor } from "./state.ts";
import { readRemediationOptions, remediationLabel, FALLBACK_FIX_CHOICE } from "./security-options.ts";
import { detectGitContext } from "./git.ts";
import { initAgentsMd, syncAgents } from "./init.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { EXTENSION_ROOT } from "./skills.ts";
import { deterministicSubagents, modelTierFor } from "./config.ts";
import { gateInventory, configureGates } from "./gates.ts";
import { collectAskAnswers } from "./enabled.ts";
import { probeCapabilities } from "./capabilities.ts";
import { cleanupEphemeralArtifacts, ephemeralArtifactsFor } from "./artifacts.ts";
import { launchPhase, executeCurrentPhase, releasePhaseInFlight, isPhaseInFlight, invalidateRuntime, finalizeRun } from "./executor.ts";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { appendLedger } from "./ledger.ts";
import { writeRunReport } from "./telemetry.ts";
import { cleanupRunArtifacts } from "./runcleanup.ts";
import { endStepWatch } from "./stuck.ts";
import { verdictKeysFor, writeStepRecord } from "./records.ts";
import { evaluateStepRecordTrust, runRecordRepair, stepArtifactPaths, stepRecordFor, stepSpawnEnv } from "./repair.ts";
import { runSubagent } from "./spawn.ts";
import { restoreAllTools, type ToolMaskHost } from "./toolmask.ts";
import { verdictValuesFor } from "./verdict-values.ts";
import type { GitContext, WorkflowPhase, WorkflowState, WorkflowStep } from "./types.ts";

/**
 * Launch the executor with the optional-phase gate disarmed: the user just
 * explicitly approved this phase via the decision panel (or `/kstack next`).
 * Without `approvedOptional`, executeCurrentPhase would park the workflow
 * again instead of running the phase.
 */
function launchApprovedOptional(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: WorkflowState): void {
  launchPhase(pi, ctx, state, (p, c, s, o) => executeCurrentPhase(p, c, s, { approvedOptional: true, launchId: o?.launchId }));
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
 *
 * S5a/TASK_17 (ADR-40, ADR-51): the prefix list carries the two S5a parks
 * — `provenance-review:<phase>:<step>` (the copied page text) and
 * `verdict-config:<phase>` (a verdict-bearing phase with no flagged step).
 * Both name their phase after the first colon, like the kill-switch parks.
 */
export function parkedGateId(state: WorkflowState): string {
  if (state.verdictPark) return state.verdictPark;
  const reason = state.pausedReason ?? "";
  for (const p of ["verdicts-disabled:", "loopback-disabled:", "provenance-review:", "verdict-config:"]) {
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

export function abortWorkflow(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: WorkflowState, message: string): void {
  // S5a/TASK_02 (call site 3): the terminal restore runs BEFORE
  // invalidateRuntime() — the browser tools come back and the mask ledger is
  // cleared (only after the restore succeeded, INV-28). A later `full` phase
  // in the same session has its browser tools.
  try {
    restoreAllTools(pi as unknown as ToolMaskHost);
  } catch {
    /* an abort never dies on a mask restore */
  }
  // Invalidate first: any in-flight delegation's shouldAbort() flips false→
  // true and the spawn loop terminates the child (SIGKILL). Previously the
  // orphaned chain kept running to completion, burning tokens after "aborted"
  // and racing a same-id restart for the in-flight registry.
  invalidateRuntime();
  releasePhaseInFlight(state.workflowId, state.phaseIndex);
  endStepWatch();
  auditGateDecision(ctx, state, "abort");
  // S4/§10.5: aborted is a terminal status too — ephemerals die with the run;
  // every cleanup failure is ledger-noted, never crashes the abort.
  if ((state.ephemeralArtifacts ?? []).length > 0) {
    const { deleted, failed } = cleanupEphemeralArtifacts(ctx.cwd, state.ephemeralArtifacts!, (m) => {
      try { ctx.ui.notify(m, "warning"); } catch { /* stale ctx */ }
    });
    appendLedger(
      ctx.cwd, state,
      { kind: "phase", phaseId: state.workflowId, payload: { summary: `ephemeral cleanup: ${deleted.length} deleted${failed.length ? `, ${failed.length} failed` : ""}`, artifacts: deleted } },
      () => {},
    );
  }
  // The run is over: its ledger file and step records die with it. The run
  // report is written FIRST — it is the durable record and must not depend
  // on the files deleted below.
  writeRunReport(ctx.cwd, state.workflowId, state.runId);
  cleanupRunArtifacts(ctx.cwd, state, (m) => {
    try { ctx.ui.notify(m, "warning"); } catch { /* stale ctx */ }
  });
  saveState(pi, { ...abortState(state), ephemeralArtifacts: [] });
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
    // Subagents load their profiles from pi's agents dir, not this repo — an
    // outdated deployed copy silently runs an old prompt.
    try {
      const sync = syncAgents(path.join(EXTENSION_ROOT, "agents"), path.join(getAgentDir(), "agents"));
      const parts = [
        sync.added.length ? `added ${sync.added.join(", ")}` : "",
        sync.updated.length ? `updated ${sync.updated.join(", ")} (backups: *.md.bak-*)` : "",
      ].filter(Boolean);
      ctx.ui.notify(parts.length ? `kstack agents: ${parts.join("; ")}.` : "kstack agents: all profiles current.", "info");
    } catch (err) {
      ctx.ui.notify(`kstack agents: sync failed (${err instanceof Error ? err.message : String(err)}) — profiles unchanged.`, "warning");
    }
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
        if (next.status === "completed") {
          finalizeRun(pi, ctx, next);
          ctx.ui.notify(`Workflow "${activeState.workflowId}" completed (optional phase skipped).`, "info");
        } else {
          saveState(pi, next);
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
            : activeState.stepGate
              ? `Approve & continue: ${activeState.workflowId} → ${phaseName} ${progress} · step "${currentStepOf(activeState)?.id ?? "?"}"`
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

    const choice = await ctx.ui.select(
      activeState.status === "paused" ? `Workflow paused${activeState.pausedReason ? ` — ${activeState.pausedReason}` : ""}` : "Workflow in progress",
      [
        `Resume: ${activeState.workflowId} → ${phaseName} ${progress}`,
        "Advance manually…",
        "Abort workflow",
        "Start new workflow",
      ],
    );

    if (!choice) return;

    if (choice === "Advance manually…") {
      await manualAdvancePanel(activeState, ctx, pi);
      return;
    }

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

  // S4/TASK_05 asks[]: sequential questions ONCE at run start — answers land
  // in state.vars and are visible to enabled:"auto" resolvers at panel time.
  const askVars = await collectAskAnswers(workflow, ctx);

  // Ephemerals are deleted at terminal status — a same-named file that existed
  // BEFORE the run is the user's, not scratch. Ask before touching it; with
  // no user to ask, keep it out of the cleanup list.
  let ephemeralArtifacts: string[] | undefined;
  const preexisting = ephemeralArtifactsFor(workflowId).filter((p) => existsSync(path.join(ctx.cwd, p)));
  if (preexisting.length > 0) {
    if (ctx.mode === "tui") {
      const ok = await ctx.ui.confirm(
        "Scratch files already exist",
        `This run uses ${preexisting.join(", ")} at the repo root as scratch files: they will be overwritten and DELETED when the run ends. Continue?`,
      );
      if (!ok) {
        ctx.ui.notify(`Not started — move or rename ${preexisting.join(", ")} first.`, "info");
        return;
      }
    } else {
      ephemeralArtifacts = ephemeralArtifactsFor(workflowId).filter((p) => !preexisting.includes(p));
      ctx.ui.notify(`kstack: ${preexisting.join(", ")} existed before the run — kept out of the end-of-run cleanup.`, "warning");
    }
  }

  // S3/D20 pre-flight configure (TRANSIENT — never a persisted status):
  // enumerate the gates this workflow can actually fire and, in interactive
  // mode only, let the user choose per-gate handling BEFORE the state exists.
  // Dismissed/headless ⇒ human-gate defaults. /kstack is the ONLY way to start
  // a workflow — there is no programmatic entry that could skip this panel.
  const gateRows = gateInventory(workflow, { state: { vars: askVars } as any, git, cwd: ctx.cwd });
  let gateMode: WorkflowState["gateMode"] = "human-gate";
  let gateOverrides: WorkflowState["gateOverrides"] = {};
  // TUI-only by design: RPC mode also exposes dialog UI (ctx.hasUI) but a
  // remote caller cannot see a dialog — the conservative default skips
  // configure and applies env/human-gate defaults (S3 review note).
  // Human step gating: choosing "human-gate" (or dismissing the panel, whose
  // announced default is human-gate) makes EVERY completed step wait for the
  // user's /kstack approval. Runs that never showed the panel keep phase gates.
  let stepGates = false;
  if (ctx.mode === "tui") {
    const config = await configureGates(gateRows, ctx, workflow.name);
    if (config) {
      gateMode = config.gateMode;
      gateOverrides = config.gateOverrides;
    }
    stepGates = gateMode === "human-gate";
  }

  // S4/TASK_06: stamp probed capabilities at run start (kstack init is the
  // primary writer — §10.8; this covers panel-started runs; the executor's
  // lazy probe covers tool-started/legacy states where {} means unprobed).
  const state: WorkflowState = { ...createState(workflowId, goal), gateMode, gateOverrides, vars: askVars, capabilities: probeCapabilities(), ...(stepGates ? { stepGates: true } : {}), ...(ephemeralArtifacts ? { ephemeralArtifacts } : {}), ...(git.head ? { baseHead: git.head } : {}) };
  saveState(pi, state);

  ctx.ui.notify(`Starting: ${workflow.name} (${workflow.phases.length} phases)`, "info");
  launchPhase(pi, ctx, state);
}

function menuScore(w: { id: string }, git: GitContext): number {
  switch (w.id) {
    case "investigate":
      return git.hasUncommittedChanges ? 7 : 3;
    case "review":
      return git.aheadOfRemote > 0 ? 8 : 3;
    case "develop":
      return git.isMainBranch ? 6 : 4;
    case "discover":
      return 3;
    case "audit":
      return 2;
    default:
      return 0;
  }
}

// --- Sprint human-control panels (plan B7 / D3, D4, D11) ---------------------

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
export async function handleSprintPanel(
  state: WorkflowState,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  // Test seam: the spawn used by the panel's record repair (the real
  // runSubagent in production).
  opts?: { spawnFn?: typeof runSubagent },
): Promise<boolean> {
  // Park panels serve EVERY workflow: without them a non-sprint verdict park
  // fell through to the generic Resume, which re-parked forever.
  const phases = getWorkflow(state.workflowId)?.phases ?? [];
  const wfId = state.workflowId;

  // D3 SECURITY FREEZE: the REVIEWER's remediation options are the only way
  // out. A critical/high finding can NEVER be accepted and re-running the
  // gate before a fix exists is pointless — the human picks a strategy (or
  // writes one) and the sprint loops back to implement.
  if (isSecurityFrozen(state)) {
    const info = state.freezeInfo;
    const artifactPath = info?.artifactPath ?? "devsecops/security-review-artifact.md";
    const reviewerOptions = readRemediationOptions(artifactPath, ctx.cwd);
    const fixChoices = reviewerOptions.length
      ? reviewerOptions.map((text, i) => `Fix ${i + 1}: ${remediationLabel(text)}`)
      : [FALLBACK_FIX_CHOICE];
    const choice = await ctx.ui.select(
      `SECURITY FREEZE: A ${info?.severity ?? "critical/high"}-severity security rejection froze the sprint at "${info?.phaseId}". A critical/high finding CANNOT be accepted — pick one of the reviewer's remediation options (or write your own fix) and the sprint loops back to implement. Read ${artifactPath} first.`,
      [...fixChoices, "Write my own fix…", "Abort workflow"],
    );
    const fixIndex = fixChoices.indexOf(choice ?? "");
    if (fixIndex >= 0) {
      if (panelGuard(ctx, state)) return true;
      const picked = reviewerOptions[fixIndex];
      const context = picked
        ? `HUMAN DECISION — the security review proposed ${reviewerOptions.length} remediation strategies for the ${info?.severity ?? "critical/high"}-severity findings and the human chose option ${fixIndex + 1}. Implement it EXACTLY as written (it MUST be applied before the gate re-runs):\n\n${picked}\n\nFull report: ${artifactPath}`
        : `HUMAN DECISION — the human chose to apply the reviewer's fixes. Read ${artifactPath} and implement EVERY critical/high fix it documents (the fixes MUST be applied before the gate re-runs).`;
      const next = returnParkedWithContext(state, phases, context, ctx.cwd);
      if (next) {
        auditGateDecision(ctx, state, "return");
        saveState(pi, next);
        launchPhase(pi, ctx, next);
      } else {
        ctx.ui.notify("Cannot loop back: the frozen phase has no loop-back target.", "error");
      }
    } else if (choice === "Write my own fix…") {
      if (panelGuard(ctx, state)) return true;
      const custom = await ctx.ui.input(
        "Custom security remediation",
        "Describe the fix the implementer must apply to the critical/high findings",
      );
      if (!custom?.trim()) {
        ctx.ui.notify("Freeze kept — no remediation given. The sprint stays frozen.", "warning");
        return true;
      }
      const next = returnParkedWithContext(
        state,
        phases,
        `HUMAN DECISION — the human wrote the remediation for the ${info?.severity ?? "critical/high"}-severity findings. Implement it (it MUST be applied before the gate re-runs):\n\n${custom.trim()}\n\nFull report: ${artifactPath}`,
        ctx.cwd,
      );
      if (next) {
        auditGateDecision(ctx, state, "return");
        saveState(pi, next);
        launchPhase(pi, ctx, next);
      } else {
        ctx.ui.notify("Cannot loop back: the frozen phase has no loop-back target.", "error");
      }
    } else if (choice === "Abort workflow") {
      if (await ctx.ui.confirm("Abort frozen workflow?", `Abandon "${wfId}" despite the unresolved security finding?`)) {
        abortWorkflow(pi, ctx, state, "Frozen workflow aborted.");
      }
    } else {
      ctx.ui.notify("Freeze kept (selection dismissed).", "warning");
    }
    return true;
  }

  // D4 UNREADABLE VERDICT PARK: fixed choices over ONLY the failing lines.
  if (state.verdictPark) {
    const phaseId = state.verdictPark;
    const phase = phases.find((p) => p.id === phaseId);
    // pausedReason encodes the park cause as "verdict-unreadable:<phaseId>:<cause>"
    // (state.ts); parks written before the cause existed fall back to no-verdict.
    const cause = state.pausedReason?.split(":")[2] ?? "no-verdict";
    const causeText =
      cause === "unroutable"
        ? "a whitelisted verdict value is off this phase's expectation map"
        : state.pausedReason?.startsWith("park-on:") || state.pausedReason?.startsWith("feedback-spec:")
          ? `a designed park fired (${state.pausedReason})`
          : "the agent emitted no trustworthy verdict";
    const excerpt = state.pendingVerdict?.excerpt?.trim() || "(no verdict-shaped lines found in the step records)";
    // A security verdict can NEVER be skipped: "Continue as approved" is not
    // offered for a phase whose verdict step is the security review.
    const securityVerdict = (phase?.steps ?? []).some(
      (st) => st.signal?.kind === "verdict" && st.signal.value === "security-review",
    );
    const options = [
      ...(securityVerdict ? [] : ["Continue as approved"]),
      ...(returnTargetFor(phase, state.pendingVerdict?.parsed) ? ["Return phase with context"] : []),
      "Repair the step record",
      "View report excerpt",
      "Abort workflow",
    ];
    const choice = await ctx.ui.select(
      `Verdict unreadable in "${phaseId}" — ${causeText} — parked WITHOUT burning an attempt. Verdict lines found: ${excerpt.slice(0, 200)}`,
      options,
    );
    if (choice === "Continue as approved") {
      if (panelGuard(ctx, state)) return true;
      const next = forceApproveParked(state, phases);
      auditGateDecision(ctx, state, "run");
      saveState(pi, next);
      launchPhase(pi, ctx, next);
    } else if (choice === "Return phase with context") {
      // No free-text input any more: the retry context carries the blockers
      // EXTRACTED from the step's own record (evidence lines) — a typed
      // instruction was never part of the record contract.
      if (panelGuard(ctx, state)) return true;
      const next = returnParkedWithContext(state, phases, undefined, ctx.cwd);
      if (!next) {
        ctx.ui.notify("Cannot loop back: the parked phase has no loop-back target.", "error");
        return true;
      }
      auditGateDecision(ctx, state, "return");
      saveState(pi, next);
      launchPhase(pi, ctx, next);
    } else if (choice === "Repair the step record") {
      if (panelGuard(ctx, state)) return true;
      await repairParkedStepRecord(pi, ctx, state, phase, phases, opts?.spawnFn ?? runSubagent);
    } else if (choice === "View report excerpt") {
      ctx.ui.notify(`Verdict excerpt: ${excerpt.slice(0, 1500)}`, "info");
    } else if (choice === "Abort workflow") {
      if (await ctx.ui.confirm("Abort workflow?", `Stop "${wfId}" at phase ${state.phaseIndex + 1}?`)) {
        abortWorkflow(pi, ctx, state, "Workflow aborted.");
      }
    }
    return true; // handled either way — never fall through while parked
  }

  const reason = state.pausedReason ?? "";
  // S5a/TASK_17 (ADR-40): the provenance park — text copied from a page
  // reached an artifact. The copy is already quarantined (marked as data,
  // nothing deleted); the human decides what happens to the phase.
  //
  // Accept: the human has read the listed lines — the gate is released and
  // the guard is NOT re-run. Re-run: the human edits the listed lines out
  // first — the step is re-issued in resume mode and the guard checks the
  // artifact again (a surviving match re-parks: one human click per
  // iteration, no autonomous loop). Abort: the run ends.
  if (state.status === "paused" && reason.startsWith("provenance-review:")) {
    const findings = state.provenanceFindings ?? [];
    const choice = await ctx.ui.select(
      `${wfId} paused — ${reason} — page text was copied into the artifact (quarantined, nothing deleted). Copied lines:\n${findings.map((f) => `- ${f}`).join("\n") || "- (no detail available)"}`,
      ["Accept result — continue past the gate", "Re-run the step (re-checks the artifact)", "Abort workflow"],
    );
    if (choice === "Accept result — continue past the gate") {
      if (panelGuard(ctx, state)) return true;
      const next = forceContinuePastGate(state, phases);
      // The guard parks BEFORE the step result is written, so the accepted
      // phase is absent from state.results — the Accept must record it, or
      // the phase vanishes from the run report and its verdict never routes
      // (the same contract forceApproveParked honours at state.ts).
      // The park reason names the phase the guard fired in
      // ("provenance-review:<phase>:<step>").
      const acceptedPhaseId =
        phases.find((p) => p.id === parkedGateId(state))?.id ??
        phases[state.phaseIndex]?.id ??
        parkedGateId(state);
      const accepted: WorkflowState = {
        ...next,
        // The accepted phase is OVER: the resume marker (the Re-run branch's
        // re-issue flag) must not label the NEXT phase's first step as an
        // interrupted, re-issued step — forceApproveParked clears it too.
        resumeMode: undefined,
        reissues: undefined,
        results: {
          ...next.results,
          [acceptedPhaseId]: {
            status: "completed",
            summary: "Accepted by explicit human decision (provenance guard: copied page text reviewed).",
          },
        },
      };
      auditGateDecision(ctx, state, "run");
      saveState(pi, accepted);
      launchPhase(pi, ctx, accepted);
    } else if (choice === "Re-run the step (re-checks the artifact)") {
      if (panelGuard(ctx, state)) return true;
      const resumed = resumeState(state);
      auditGateDecision(ctx, state, "run");
      saveState(pi, resumed);
      launchPhase(pi, ctx, resumed);
    } else if (choice === "Abort workflow") {
      if (await ctx.ui.confirm("Abort workflow?", `Stop "${wfId}" at phase ${state.phaseIndex + 1}?`)) {
        abortWorkflow(pi, ctx, state, "Workflow aborted.");
      }
    }
    return true;
  }
  // S5a/TASK_17 (ADR-51): a verdict-bearing phase that declares no flagged
  // step is a REGISTRY mistake — re-running a step cannot fix it, so the
  // only way out is Abort. A Resume here would re-park forever.
  if (state.status === "paused" && reason.startsWith("verdict-config:")) {
    const choice = await ctx.ui.select(
      `${wfId} paused — ${reason} — this phase declares a verdict but no step owns it: a workflow definition mistake, not a work problem. Only aborting can resolve it.`,
      ["Abort workflow"],
    );
    if (choice === "Abort workflow") {
      if (await ctx.ui.confirm("Abort workflow?", `Stop "${wfId}" at phase ${state.phaseIndex + 1}?`)) {
        abortWorkflow(pi, ctx, state, "Workflow aborted.");
      }
    }
    return true;
  }
  // Kill-switch parks (F2 fix): with KSTACK_PI_VERDICTS/_LOOPBACKS off, a
  // completed verdict-bearing gate pauses with verdicts-disabled:/
  // loopback-disabled:. Without a decision surface the only exits were Abort
  // or an endless Resume→re-run→pause loop — the documented "human decides"
  // contract had no decision UI. Offer the same choices as loop exhaustion.
  if (state.status === "paused" && (reason.startsWith("verdicts-disabled:") || reason.startsWith("loopback-disabled:"))) {
    const choice = await ctx.ui.select(`${wfId} paused — ${reason}`, [
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
      if (await ctx.ui.confirm("Abort workflow?", `Stop "${wfId}" at phase ${state.phaseIndex + 1}?`)) {
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
    const choice = await ctx.ui.select(`${wfId} paused — ${reason}`, choices);
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
      if (await ctx.ui.confirm("Abort workflow?", `Stop "${wfId}" at phase ${state.phaseIndex + 1}?`)) {
        abortWorkflow(pi, ctx, state, "Workflow aborted.");
      }
    }
    return true;
  }

  return false;
}

// --- Manual advance (human override, every workflow) ------------------------

/** The step the cursor points at, or undefined past the last step / unstepped phase. */
function currentStepOf(state: WorkflowState): WorkflowStep | undefined {
  const steps = getWorkflow(state.workflowId)?.phases[state.phaseIndex]?.steps;
  if (!steps?.length) return undefined;
  return steps[Math.min(state.stepIndex ?? 0, steps.length - 1)];
}

/**
 * D4 panel: repair the parked phase's verdict record.
 *
 * The step's own agent fixes its RECORD — the work is never redone and the
 * stale record is never accepted: a delegated step is re-invoked with the
 * repair task (the record's mtime must move), a main-session step gets a
 * message naming exactly what to fix. On success the phase re-routes
 * through the normal verdict merge — never through a hand-made verdict.
 */
async function repairParkedStepRecord(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: WorkflowState,
  phase: WorkflowPhase | undefined,
  phases: WorkflowPhase[],
  spawnFn: typeof runSubagent = runSubagent,
): Promise<void> {
  if (!phase) {
    ctx.ui.notify("kstack: the parked phase is unknown — nothing to repair.", "error");
    return;
  }
  const verdictSteps = (phase.steps ?? []).filter(
    (st) => st.signal?.kind === "verdict" && state.results[`${phase.id}.${st.id}`]?.status !== "skipped",
  );
  // Repair the step whose record is actually untrustworthy — not blindly the
  // first verdict step (the broken record may belong to a later step).
  const step =
    verdictSteps.find(
      (st) => !evaluateStepRecordTrust(state.workflowId, phase, st, stepRecordFor(ctx.cwd, state.workflowId, state.runId, phase, st)).ok,
    ) ?? verdictSteps[0];
  if (!step) {
    ctx.ui.notify("kstack: the parked phase has no verdict step to repair.", "error");
    return;
  }
  const trust = evaluateStepRecordTrust(
    state.workflowId,
    phase,
    step,
    stepRecordFor(ctx.cwd, state.workflowId, state.runId, phase, step),
  );
  if (step.execution === "subagent" && deterministicSubagents()) {
    const repair = await runRecordRepair(
      {
        workflowId: state.workflowId,
        runId: state.runId,
        phase,
        step,
        cwd: ctx.cwd,
        agent: step.agent ?? "worker",
        env: stepSpawnEnv(state.workflowId, state.runId, phase, step, ctx.cwd),
        modelOverride: modelTierFor(phase.id),
        cause: trust.cause ?? "no-verdict",
        defect: trust.defect ?? "the record cannot be trusted",
        excerpt: state.pendingVerdict?.excerpt,
        artifactPaths: stepArtifactPaths(phase, step, ctx.cwd, state.sprintNumber),
      },
      spawnFn,
    );
    if (!repair.ok) {
      ctx.ui.notify(
        `kstack: the record repair did not update the record (${repair.reason}) — the workflow stays parked.`,
        "warning",
      );
      return;
    }
  } else {
    // Main-session step: the main agent owns the record it wrote — it is
    // told exactly what to fix and re-delivers the step's kstack_advance.
    pi.sendUserMessage(
      `[kstack] The record of step "${phase.id}.${step.id}" cannot be trusted: ${trust.defect ?? "the record is not routable"} (park cause: ${trust.cause ?? "no-verdict"}). Fix ONLY the step record — re-run the record command from the step instructions with the corrected verdict — then call kstack_advance again. Do NOT redo the review and do NOT delete the record.`,
      { deliverAs: "followUp" },
    );
    return;
  }
  // The record was really rewritten: re-route through the normal merge.
  const summary = state.results[`${phase.id}.${step.id}`]?.summary ?? "Verdict record repaired via /kstack.";
  const next = advancePhase(
    state,
    phase.id,
    { status: "completed", summary },
    phases.length,
    { phases, cwd: ctx.cwd },
  );
  auditGateDecision(ctx, state, "run");
  saveState(pi, next);
  if (next.status === "active" || next.status === "completed") {
    ctx.ui.notify(`kstack: the record of "${phase.id}.${step.id}" was repaired — the phase re-routed.`, "info");
    launchPhase(pi, ctx, next);
  } else {
    ctx.ui.notify(
      `kstack: the repaired verdict routed to a new park — ${next.pausedReason ?? next.status}. Run /kstack to decide.`,
      "warning",
    );
  }
}

/**
 * "Advance manually…" — the human escape hatch from ANY non-terminal state:
 * complete the current step (writing the record its signal needs, verdict
 * chosen by the user) or jump to the next phase. Never blocked by a missing
 * signal: the human decision IS the signal.
 */
export async function manualAdvancePanel(state: WorkflowState, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const workflow = getWorkflow(state.workflowId);
  const phases = workflow?.phases ?? [];
  const phase = phases[state.phaseIndex];
  if (!phase) {
    ctx.ui.notify("kstack: no current phase to advance.", "warning");
    return;
  }
  const step = phase.steps?.length && (state.stepIndex ?? 0) < phase.steps.length ? currentStepOf(state) : undefined;
  const completeStep = step ? `Complete step "${step.id}" (${phase.name}) as done` : undefined;
  const nextPhase = `Advance to the next phase — skip the rest of "${phase.name}"`;
  const choice = await ctx.ui.select("Advance manually", [...(completeStep ? [completeStep] : []), nextPhase, "Cancel"]);
  if (!choice || choice === "Cancel") return;
  if (decisionBlockedByInFlightChain(ctx, state)) return;

  if (choice === nextPhase) {
    if (!(await ctx.ui.confirm("Skip ahead?", `Mark "${phase.name}" complete and start the next phase? Remaining steps of this phase will not run.`))) return;
    endStepWatch();
    const next = forceApproveParked(state, phases);
    auditGateDecision(ctx, state, "run");
    saveState(pi, next);
    ctx.ui.notify(`kstack: "${phase.name}" advanced manually.`, "info");
    launchPhase(pi, ctx, next);
    return;
  }

  // Complete the current step: satisfy its declared signal on the human's word.
  const sig = step!.signal;
  if (sig?.kind === "verdict") {
    if (!state.runId) {
      ctx.ui.notify("kstack: this run has no runId — the verdict record cannot be written.", "error");
      return;
    }
    const value = await ctx.ui.select(`Verdict for "${phase.id}.${step!.id}" (${sig.value})`, verdictValuesFor(state.workflowId, phase.id, sig.value));
    if (!value) return;
    writeStepRecord(ctx.cwd, { workflow: state.workflowId, runId: state.runId, phase: phase.id, step: step!.id, summary: `Verdict ${sig.value}==${value} set manually by the user via /kstack.`, verdicts: { [sig.value]: value } });
  } else if (sig?.kind === "marker" && state.runId) {
    writeStepRecord(ctx.cwd, { workflow: state.workflowId, runId: state.runId, phase: phase.id, step: step!.id, summary: "Completed manually by the user via /kstack.", markers: [sig.value] });
  }
  endStepWatch();
  const base: WorkflowState = {
    ...state, status: "active", pausedReason: undefined, verdictPark: undefined, pendingVerdict: undefined,
    resumeMode: undefined, reissues: undefined, stepGate: undefined,
  };
  const rec = recordStepResult(base, phase, { status: "completed", summary: "Completed manually by the user via /kstack." });
  if (!rec) return;
  appendLedger(ctx.cwd, state, { kind: "step", phaseId: phase.id, stepId: step!.id, payload: { summary: "completed manually by the user" } }, (m) => {
    try { ctx.ui.notify(m, "warning"); } catch { /* stale ctx */ }
  });
  auditGateDecision(ctx, state, "run");
  const next = rec.isLast
    ? advancePhase(rec.state, phase.id, { status: "completed", summary: state.results[`${phase.id}.${step!.id}`]?.summary ?? "Completed manually by the user via /kstack." }, phases.length, { phases, cwd: ctx.cwd })
    : rec.state;
  saveState(pi, next);
  if (next.status === "active" || next.status === "completed") {
    ctx.ui.notify(`kstack: step "${step!.id}" completed manually.`, "info");
    launchPhase(pi, ctx, next);
  } else {
    ctx.ui.notify(`kstack: step "${step!.id}" completed; the phase routed to a park — ${next.pausedReason ?? next.status}. Run /kstack to decide.`, "warning");
  }
}
