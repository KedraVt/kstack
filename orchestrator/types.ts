export interface WorkflowPhase {
  id: string;
  name: string;
  execution: "main" | "subagent";
  agent?: string;
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
  optional: boolean;
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
}

export interface IntentPattern {
  pattern: RegExp;
  weight: number;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  intents: IntentPattern[];
  phases: WorkflowPhase[];
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
 */
export type VerdictParkCause = "no-verdict" | "artifact-mismatch" | "unroutable";

/** D3 freeze payload: critical/high security rejection parked for human review. */
export interface FreezeInfo {
  phaseId: string;
  severity: VerdictSeverity;
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
  /** State schema version (v2 adds the sprint-loop fields below). Old states load with fresh defaults. */
  version?: 2;
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
}

export interface GitContext {
  branch: string;
  hasUncommittedChanges: boolean;
  hasStagedChanges: boolean;
  aheadOfRemote: number;
  behindRemote: number;
  isMainBranch: boolean;
  recentCommitSubject: string;
}

export interface WorkflowContext {
  state: WorkflowState;
  git: GitContext;
  cwd: string;
}
