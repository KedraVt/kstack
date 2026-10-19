/**
 * S4 capability ids — probed once by `kstack init` into state.capabilities.
 * `requires:` on a step = missing ⇒ skip (the step is useless without it);
 * `prefers:` = missing ⇒ run degraded and note `~capability: no-<cap>`.
 */
export type Capability = "graft" | "browse" | "node" | "gh" | "design";

/**
 * S3 step model: an atomic work-delivery unit inside a phase. `skill` is
 * SINGULAR (0-or-1 per D19); `task` supports {previous}/{x}_summary
 * interpolation like chain-step tasks. Absent `steps[]` on a phase means the
 * implicit single step — the legacy path, byte-verbatim.
 */
export interface WorkflowStep {
  id: string;
  execution: "main" | "subagent";
  /** Agent definition for delegated steps (execution: "subagent"). */
  agent?: string;
  /**
   * Step instructions; interpolated like phase tasks ({goal}, {previous},
   * {x}_summary). For main steps, the DELIVERABLE contract re-injected on
   * resume is extracted from this text (mainContractFor) — a step without a
   * `## DELIVERABLE`/`## OUTPUT CONTRACT` block resumes with no contract.
   */
  task: string;
  /** 0-or-1 skill id delivered just-in-time for this step (D19). */
  skill?: string;
  /**
   * S4: ambient behavioral skills injected alongside the task — OUTSIDE the
   * 0-1 task-skill slot (ponytail, AC banks, writing guides). Ambient ids
   * never occupy `skill` and may be scope-conditional at the phase level.
   */
  ambientSkills?: string[];
  /**
   * S4: declarative skip — the step skips when `state.vars[var]` equals
   * `equals` (e.g. `{var:"scope", equals:"backend"}`, `{var:"target",
   * equals:"external"}`). Distinct from phase.skipWhen (a function):
   * step conditions are data, resolvable before any code runs.
   */
  skipWhen?: { var: string; equals: string };
  /**
   * S4 capability gate: every listed capability must be present — a missing
   * required capability SKIPS the step with a ledger note (the step is
   * useless without it, e.g. browse for qa-browsing).
   */
  requires?: Capability[];
  /**
   * S4 capability preference: a missing preferred capability DEGRADES the
   * step instead of skipping it — the run continues and the report notes
   * `~capability: no-<cap>` (e.g. graft-first scout falls back to rg).
   */
  prefers?: Capability[];
  /**
   * S4: steps may open visible UI ONLY when declared — default contract is
   * headless. "interactive" is reserved for steps whose purpose IS user
   * interaction (login, captcha, visual inspection).
   */
  ui?: "interactive";
  /**
   * The step interviews the user and waits for answers (grilling, triage,
   * office-hours). Must run as a main step — a headless subagent has nobody
   * to ask (coherenceProblems) — and its phase is never offered "auto" at
   * the pre-flight panel: human or skip only.
   */
  needsUser?: true;
  /** Delegated-step timeout (seconds) overriding the phase's class — for steps known to outlast it. */
  timeoutSec?: number;
  /** Extra env for a delegated step's child; values interpolate like the task ({runId}, {phase}, {step}). */
  env?: Record<string, string>;
  /**
   * S4: side-effect step — parks at an entry ⚠ gate BEFORE running
   * (publishing review comments, shipping). The human must approve via
   * /kstack; the model can never self-approve.
   */
  sideEffect?: true;
  /**
   * S4: completion signal the router must observe in the step's
   * kstack-report record before advancing:
   * - `verdict` → the step emits verdict var `value` (marks the step
   *   VERDICT-BEARING — the phase merges flagged steps only, closing the
   *   chain→steps[] verdict hole);
   * - `artifact` → the step completes when the file at `value` exists
   *   (path relative to cwd);
   * - `marker` → the step completes when the record carries marker `value`.
   * Absent ⇒ legacy advance semantics (the step completes on kstack_advance
   * / delegation return — the ghost-step path kept for migrated phases).
   */
  signal?: { kind: "verdict" | "artifact" | "marker"; value: string };
}

/**
 * One selectable item in the pre-flight selection-gate component, produced by
 * gateInventory(workflow). kind "entry" is rendered ⚠ (side-effect gate).
 */
export interface GateRow {
  phaseId: string;
  /** Display name (phase name + position). */
  name: string;
  kind: "optional" | "entry" | "manual";
  /** True for entry gates (side-effect phases) — rendered with ⚠. */
  warning?: boolean;
  /**
   * S4/INV-13 (optional rows only): false when an enabled phase `needs` an
   * artifact this phase `produces` — the panel must not offer "skip".
   * Absent = skippable (legacy default).
   */
  skippable?: boolean;
  /** The phase has a needsUser step — the panel offers no "auto". */
  interactive?: boolean;
  /** enabled:"auto" row — its default lets the engine detect (it never parks). */
  detect?: boolean;
}

export interface WorkflowPhase {
  id: string;
  name: string;
  execution: "main" | "subagent";
  agent?: string;
  /**
   * S3: declared steps of a stepped phase. Absent/empty = implicit single
   * step (legacy path, byte-verbatim — no WorkflowStep is materialized).
   */
  steps?: WorkflowStep[];
  /**
   * Optional task override for single-agent phases. When absent, the generic
   * template keyed by phase id is used (buildAgentTask). Placeholders
   * ({goal}, {branch}, {x}_summary) are interpolated like chain-step tasks.
   * Guard: every {x}_summary used here MUST match a phase id in the same
   * workflow — covered by the orchestrator coherence test.
   */
  task?: string;
  chain?: Array<{
    agent: string;
    task: string;
    /**
     * Per-step skill override (STEP 3). Default: inherits phase.skills —
     * lets a chain step receive a role-scoped digest (e.g. the planner gets
     * kstack-fix-strategy instead of the full investigation methodology).
     */
    skills?: string[];
  }>;
  /**
   * LEGACY (retired by S4/TASK_08): optional-phase rows at the pre-flight
   * panel. New defs use `enabled: "auto"` + derived skippability instead —
   * the field stays readable so un-migrated states/defs keep working.
   */
  optional?: boolean;
  skipWhen?: (ctx: WorkflowContext) => boolean;
  /** Distilled skill digests injected by the orchestrator (ids from the skills registry). */
  skills?: string[];
  /** Phase behavior variant, e.g. "report-only" for QA phases. */
  variant?: string;
  /**
   * Advancement policy. "auto" (default): the workflow proceeds as soon as the
   * phase completes via kstack_advance. "manual": after completion the
   * workflow enters awaiting_approval and only `/kstack next` moves it on.
   */
  advance?: "auto" | "manual";
  /**
   * Sprint loop engine: when this phase completes with a parsed rejection
   * verdict, execution returns to the phase named here instead of advancing
   * linearly. Presence of this field marks the phase as VERDICT-BEARING:
   * the executor parses its subagent output with verdicts.ts and stashes the
   * result in state.pendingVerdict (the model can never influence routing).
   */
  loopBackTo?: string;
  /** Max runs of the loopBackTo TARGET phase before exhaustion parks the workflow. */
  maxAttempts?: number;
  /**
   * Phase whose artifact supplies the retry feedback payload (default: this
   * phase itself — the reviewer/QA artifact is exactly the feedback source).
   */
  feedbackFrom?: string;
  /**
   * S4: phase toggle resolved at panel/start. "on" (absent = on) always
   * runs; "off" never runs; "auto" resolves on computable state via
   * `autoWhen` (file presence, touched diff, tasks.md). "User choice"
   * phases are auto+override: the engine detects, the user may force.
   */
  enabled?: "on" | "off" | "auto";
  /**
   * S4: resolver for enabled:"auto" — returns true when the phase should
   * run (e.g. Dockerfile present and touched). Evaluated at phase entry
   * and pre-computed at the panel for display.
   */
  autoWhen?: (ctx: WorkflowContext) => boolean;
  /**
   * S4 derived-skippability contract: artifact ids this phase produces /
   * needs. A phase is skippable iff no enabled phase `needs` what it
   * `produces` — the panel computes it, so a run can never be broken by
   * construction.
   */
  produces?: string[];
  needs?: string[];
  /**
   * S4 multi-target routing: verdict VALUE → target phase id (e.g.
   * `{persists: "fix", refuted: "root-cause"}`). Evaluated BEFORE the
   * legacy `loopBackTo` fallback — absent map ⇒ legacy negative→loopBackTo
   * semantics unchanged.
   */
  loopBackOn?: Record<string, string>;
  /**
   * S4: verdict VALUE → park mode. `severity: "freeze"` reproduces the
   * devsecops D3 typed-unfreeze; `"park"` is the standard D4-style
   * no-attempt-burn park. parkOn wins over loopBackOn/advance.
   */
  parkOn?: Record<string, "park" | "freeze">;
  /**
   * S4: unconditional bounded back-edge on a NON-verdict phase (review's
   * fix → findings). Fires ONLY on a "completed" result — never on
   * skipped/auto-disabled (INV-16) — and never carries retryContext
   * feedback (the re-entered phase re-reads fresh state). The target
   * must name an EARLIER phase in the same workflow.
   */
  onComplete?: string;
  /**
   * A verdict step emitting a NEGATIVE verdict closes the phase at once —
   * remaining steps record "skipped" and the phase routes on what it has.
   * For build→verify phases, where later steps judge work the loop redoes.
   */
  failFast?: true;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  phases: WorkflowPhase[];
  /**
   * S4: questions asked ONCE at run start (the panel's sequential step) —
   * `scope`, `target`, `parallel`… Each answer lands in `state.vars` and
   * drives step `skipWhen`, ambient selection and phase `enabled`:"auto"
   * resolvers. `when` hides questions whose condition fails (e.g.
   * `parallel` is only asked when `scope == "mixed"`).
   */
  asks?: Array<{
    /** Routing var the answer is stored under (state.vars[var]). */
    var: string;
    /** Question text shown to the user. */
    question: string;
    /** Selectable options; the first is the displayed default unless
        `default` overrides it. */
    options: string[];
    default?: string;
    /** Ask only when state.vars[var] already equals `equals`. */
    when?: { var: string; equals: string };
  }>;
}

export interface PhaseResult {
  status: "completed" | "skipped" | "failed";
  summary: string;
}

/** Normalized severity carried by security-rejection verdicts (D3). */
export type VerdictSeverity = "critical" | "high" | "medium" | "low";

/**
 * Deterministically parsed verdict (verdicts.ts). Produced ONLY by
 * orchestrator code from subagent raw output + on-disk artifact cross-check;
 * never taken from model summaries.
 */
export interface ParsedVerdict {
  /** variable -> normalized whitelist value, e.g. "security-review" -> "rejected". */
  verdicts: Record<string, string>;
  severity?: VerdictSeverity;
}

/** Feedback payload injected into a looped-back phase's instructions. */
export interface RetryContext {
  targetPhaseId: string;
  /** Attempt number of the UPCOMING run (1-based). */
  attempt: number;
  maxAttempts: number;
  feedback: string;
}

/** D4 park payload: a verdict-bearing phase completed but the verdict was unreadable. */
export interface PendingVerdict {
  phaseId: string;
  /** Null = parse failure → interactive panel required before anything moves. */
  parsed: ParsedVerdict | null;
  /** Raw failing verdict lines / report excerpt shown in the D4 panel. */
  excerpt: string;
}

/**
 * Why a D4 park fired, encoded as the trailing segment of
 * `pausedReason` ("verdict-unreadable:<phaseId>:<cause>"):
 * - "no-verdict": the subagent emitted nothing trustworthy (no verdict
 *   lines, hedged, or a contradiction across chain steps);
 * - "artifact-mismatch": the HANDOFF parsed but disagreed with the
 *   on-disk artifact (or the artifact was absent);
 * - "unroutable": the verdict parsed and whitelisted but is not on the
 *   phase's expectation map.
 * - "no-expectation": the (workflowId, phaseId) pair has no EXPECTATIONS
 *   entry at all — a misconfigured gate; never defaulted (ADR-7).
 * - "foreign-verdict": a NON verdict-flagged step's record emitted
 *   verdicts — only flagged records may carry gate variables.
 */
export type VerdictParkCause = "no-verdict" | "artifact-mismatch" | "unroutable" | "no-expectation" | "foreign-verdict";

/** D3 freeze payload: security rejection parked for human review.
 * `severity` is the emitted severity value — legacy vocabulary
 * (critical|high) plus the S4 record vocabulary (red). */
export interface FreezeInfo {
  phaseId: string;
  severity: string;
  artifactPath: string;
}

export interface WorkflowState {
  workflowId: string;
  phaseIndex: number;
  status: "active" | "paused" | "completed" | "aborted" | "awaiting_approval";
  goal: string;
  results: Record<string, PhaseResult>;
  /** Skill digests already delivered in full during this run — repeats get the DoD gate only. */
  skillsDelivered?: string[];
  /**
   * S3 ledger: per-run identifier persisted at creation — restarts/resumes
   * append to the SAME .kstack/ledger/<workflowId>-<runId>.jsonl file.
   * Absent on v≤3 loads (the ledger falls back to a shared "adhoc" lane).
   */
  runId?: string;
  /**
   * S3: 0-based position of the CURRENT step inside phases[phaseIndex].steps.
   * Defined ⟺ the current phase declares steps[] (INV-01); implicit-step
   * phases never read or write it. Absent on v≤3 loads — access as `?? 0`.
   */
  stepIndex?: number;
  /**
   * S3/D20: pre-flight gate resolution mode. Absent or "human-gate" ⇒ today's
   * park-for-human semantics; "selection-gate" ⇒ gates resolve from
   * `gateOverrides`; gates WITHOUT an override fall back to the
   * `KSTACK_PI_OPTIONAL_PHASES` env policy (default `ask` = park for human).
   */
  gateMode?: "human-gate" | "selection-gate";
  /**
   * S3/D20: persisted per-gate choices from the selection-gate panel. "skip"
   * is legal only on optional-phase rows (INV-05; enforced at selection).
   */
  gateOverrides?: Record<string, "auto" | "human" | "skip">;
  /**
   * S4 routing vars: `asks[]` answers written at run start plus `kstack-report
   * --var` records emitted by steps (parallel-safe, feedback-type…). Missing
   * keys resolve to safe defaults — e.g. `parallel-safe` absent ⇒ sequential.
   */
  vars?: Record<string, string>;
  /**
   * S4: expectation-map-VALIDATED verdict of each verdict-bearing phase,
   * written on completion (edged or publish-only). Read by downstream
   * `autoWhen`/`skipWhen` resolvers (INV-17) — e.g. review.fix re-runs
   * only when lastVerdicts["findings"]["code-review"] != "approved".
   */
  lastVerdicts?: Record<string, Record<string, string>>;
  /**
   * S4: per-lane step cursors for parallel lane execution
   * (sprint.implement backend∥frontend). Only engaged when vars.scope ==
   * "mixed" ∧ vars.parallel == "yes" ∧ vars["parallel-safe"] == "true"
   * (INV-14). Absent ⇒ sequential delivery.
   */
  lanes?: Record<string, { stepIndex: number }>;
  /** S4: probed capabilities (kstack init / runtime probe). Missing/false key = absent. */
  capabilities?: Partial<Record<Capability, boolean>>;
  /**
   * S4: repo-relative artifact paths that die at run terminal status
   * (understand.md, plan.md, bug-report.md…). Cross-run handoff artifacts
   * live under `.kstack/<workflow>/` instead — never listed here.
   */
  ephemeralArtifacts?: string[];
  /**
   * S4: set when the current step is being re-delivered after an
   * interruption (crash, quota, missing completion signal) — the step's
   * task is re-issued in resume-mode ("continue from disk state":
   * builders read diff+tests as the progress oracle; writers overwrite;
   * appenders dedup-check). Cleared when the step completes.
   */
  resumeMode?: boolean;
  /** State schema version (v2 added the sprint-loop fields; v3 = post-S2 kstack entry type; v4 = S3 step model + gate fields; v5 = S4 vars/capabilities/ephemeral/resumeMode). Old states load with fresh defaults. */
  version?: 2 | 3 | 4 | 5;
  /** Completed-run counters per phase id — drives loop ceilings. Missing = fresh (backward-compatible). */
  attempts?: Record<string, number>;
  /** Orchestrator-parsed verdict for the current verdict-bearing phase (consumed by advancePhase). */
  pendingVerdict?: PendingVerdict;
  /** D4: verdict unreadable → parked until the interactive panel resolves it. No attempt burned. */
  verdictPark?: string;
  /** D3: critical/high security rejection froze the loop engine until explicit human re-issue. */
  frozenUntilHuman?: boolean;
  freezeInfo?: FreezeInfo;
  /** Why the workflow is paused ("loop-exhausted:<phase>", "sprint-number-anomaly", …) — surfaced to the user. */
  pausedReason?: string;
  /** Active retry injection for a looped-back phase (cleared when that phase completes). */
  retryContext?: RetryContext;
  /** Sprint number, discovered once at the user-story phase (E5). Zero-pad to 2 digits when interpolating. */
  sprintNumber?: number;
  /**
   * Optional-phase decision gate (STEP 2g v2): the workflow is parked at an
   * `optional` phase awaiting an explicit human Run/Skip/Abort decision in the
   * /kstack panel. Never set for KSTACK_PI_OPTIONAL_PHASES=auto|skip, and
   * cleared the moment the user decides. While set, kstack_advance refuses to
   * touch the phase — the model cannot bypass the gate.
   */
  pendingOptional?: boolean;
  /**
   * Human step gating: set at run start when the user picks "human-gate" in
   * the pre-flight panel. Every completed step then parks awaiting_approval
   * (stepGate) — only /kstack advances the run, when the human is satisfied.
   */
  stepGates?: boolean;
  /** Parked after a completed step (stepGates) — phaseIndex/stepIndex already point at the NEXT step. */
  stepGate?: boolean;
  /** Automatic signal-missing re-issues of the CURRENT step (capped; cleared when the step completes). */
  reissues?: number;
  /**
   * Entry gate for side-effect phases (commit-archive): `true` = parked
   * BEFORE the gated phase runs, awaiting an explicit human Run/Abort via
   * /kstack; `"approved"` = approved once — the executor proceeds and
   * advancePhase clears the marker when the phase completes.
   */
  entryGate?: true | "approved";
  /**
   * Plan-file path captured from the plan phase's marker (PLAN FILE: …).
   * Lets the LLM name the plan after its essence instead of the legacy
   * goal-prefix slug; absent ⇒ planFilePath(goal) fallback keeps old sessions
   * and untouched runs working.
   */
  planFile?: string;
  /** HEAD at run start — lets resolvers see commits made during the run. */
  baseHead?: string;
}

export interface GitContext {
  branch: string;
  hasUncommittedChanges: boolean;
  hasStagedChanges: boolean;
  aheadOfRemote: number;
  behindRemote: number;
  isMainBranch: boolean;
  recentCommitSubject: string;
  /** Current HEAD sha (absent on an unborn branch or when git fails). */
  head?: string;
}

export interface WorkflowContext {
  state: WorkflowState;
  git: GitContext;
  cwd: string;
}
