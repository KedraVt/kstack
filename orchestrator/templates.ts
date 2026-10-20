import type { WorkflowPhase, WorkflowContext, Workflow, WorkflowStep } from "./types.ts";
import { getWorkflow } from "./workflows.ts";
import { loadSkillFull, loadSkillGate, getSkillInfo } from "./skills.ts";
import { reportCliPath, projectRootFor, verdictKeysFor } from "./records.ts";
import { expectationsFor, NEGATIVE_VALUES } from "./verdicts.ts";
import { skillsEnabled, manualGates, deterministicSubagents } from "./config.ts";
import { replaceExact } from "./text.ts";
import { extractHandoff } from "./handoff.ts";
import { parseRootCauseMarker, validateStrategyTask } from "./skip.ts";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { pad2 } from "./sprint.ts";
import { qaArtifactName, softwareArchitectArtifactName } from "./artifacts.ts";

/**
 * Sprint loop engine support (plan B6 / E6).
 *
 * RETRY CONTEXT: a looped-back phase gets its previous failure's blockers
 * prepended so attempt n+1 does not repeat attempt n.
 */
export function retryContextBlock(ctx: WorkflowContext, phaseId: string): string {
  const rc = ctx.state.retryContext;
  if (!rc || rc.targetPhaseId !== phaseId) return "";
  return [
    `## RETRY CONTEXT (attempt ${rc.attempt}/${rc.maxAttempts})`,
    `This phase was returned by a review gate. Address EVERY blocker below before finishing — repeating attempt ${rc.attempt - 1} wastes the remaining budget.`,
    "",
    rc.feedback || "(no structured blockers extracted — re-read the prior review/QA artifact in the project root)",
  ].join("\n");
}

/** Master Definition-of-Done checklist appended to every P07–P10 sprint task. */
export const MASTER_DOD = `## SPRINT DEFINITION OF DONE (every box mandatory)
- [ ] Code compiles and passes all pipelines
- [ ] Unit, API, and E2E tests written and passing (AAA structure)
- [ ] Observability (logs/metrics) implemented for all new boundaries
- [ ] No hardcoded secrets or severe vulnerabilities
- [ ] ADR created/updated for any significant architectural change
- [ ] Project documentation updated to reflect new behavior
- [ ] Conventional Commits only (feat:, fix:, docs:, …)
- [ ] Strict task branching: all code lives in an isolated task/<slug> branch; never mix tasks in one branch`;

const SPRINT_EXECUTION_PHASES = new Set(["implement", "devsecops-review", "qa-browsing", "docker-review", "pipeline-review", "archive"]);

/**
 * MASTER_DOD suffix for sprint execution phases — appended to chain tails
 * (legacy path), delegated-step tasks, and main-step instructions alike, so
 * the steps[] migration keeps the same DoD contract the chain path enforced.
 */
export function sprintDodSuffix(workflowId: string, phaseId: string): string {
  return workflowId === "sprint" && SPRINT_EXECUTION_PHASES.has(phaseId) ? `\n\n${MASTER_DOD}` : "";
}

// --- Conditional digests (D14): docker needs containers, pipeline needs CI ---

function repoHasDocker(cwd: string): boolean {
  try {
    return existsSync(path.join(cwd, "Dockerfile")) || existsSync(path.join(cwd, "docker-compose.yml")) || existsSync(path.join(cwd, "compose.yml"));
  } catch {
    return false;
  }
}

function repoHasCI(cwd: string): boolean {
  const probes = [
    ".github/workflows",
    ".gitlab-ci.yml",
    "Jenkinsfile",
    ".circleci/config.yml",
    "azure-pipelines.yml",
  ];
  try {
    return probes.some((p) => existsSync(path.join(cwd, p)));
  } catch {
    return false;
  }
}

/**
 * Drop conditionally-loaded sprint digests whose trigger is absent in the
 * project: kstack-docker-manager requires Docker files, kstack-pipeline-sre
 * requires CI configs. Everything else passes through untouched.
 */
export function conditionalSkillIds(ids: string[] | undefined, cwd?: string): string[] | undefined {
  if (!ids || !cwd) return ids;
  const filtered = ids.filter((id) => {
    if (id === "kstack-docker-manager") return repoHasDocker(cwd);
    if (id === "kstack-pipeline-sre") return repoHasCI(cwd);
    return true;
  });
  // Return [] (not undefined) when filtering emptied the list: downstream
  // uses `filtered ?? phase.skills` — undefined would resurrect the very
  // Docker/CI digests this function just proved absent in the repo.
  return filtered;
}

/** Scrape the BINDING Ubiquitous Language table out of system-design_XX.md. */
export function glossaryTable(cwd: string, sprintNumber?: number): string {
  if (sprintNumber === undefined) return "(glossary not yet available — proceed with the task's own terminology)";
  const file = path.join(cwd, `system-design_${pad2(sprintNumber)}.md`);
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    return "(glossary not yet available — proceed with the task's own terminology)";
  }
  const headingMatch = /^#{1,3}\s.*Ubiquitous.*$/im.exec(content);
  if (!headingMatch) return "(no Ubiquitous Language table found in system-design artifact)";
  const rest = content.slice(headingMatch.index + headingMatch[0].length);
  const end = rest.search(/^##\s/m);
  const body = (end >= 0 ? rest.slice(0, end) : rest).trim();
  if (!body) return "(Ubiquitous Language section is empty)";
  return body.length > 4000 ? `${body.slice(0, 4000)}…(truncated)` : `### Ubiquitous Language (BINDING)
${body}`;
}

/** Deterministic slug for the plan file written by the interactive planning phase. */
export function planFileSlug(goal: string): string {
  return (
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "plan"
  );
}

/** Directory every plan file must live in. */
const PLAN_DIR = ".kstack/plans";

/**
 * Accept a model-chosen plan file path (plan-naming fix): must stay inside the
 * plans directory and be a safe single-path-segment kebab-case slug. Anything
 * else — traversal, subdirectories, wrong casing/characters, wrong extension —
 * is refused so a sloppy model answer can never write outside .kstack/plans.
 */
export function isValidPlanFile(value: string): boolean {
  return /^\.kstack\/plans\/[a-z0-9][a-z0-9-]*\.md$/.test(value);
}

/**
 * Extract the `PLAN FILE: <path>` marker from the plan phase's kstack_advance
 * summary. Iterates EVERY occurrence and returns the first VALID one — the
 * first match alone is shadowed by the prompt's own template fragments
 * (mindrun F3: a summary echoing "end with PLAN FILE: <path>" before the real
 * marker parsed as `<path>`, rejected, and the real marker was never reached).
 * No valid occurrence ⇒ null ⇒ callers fall back to the legacy slug.
 */
export function parsePlanFileMarker(summary: string): string | null {
  const re = /PLAN FILE:\s*(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(summary ?? "")) !== null) {
    const candidate = m[1].replace(/["'`]/g, "").replace(/[.,;]+$/, "");
    if (isValidPlanFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the plan file for the CURRENT run: the model-named path captured at
 * plan-phase completion when present, else the legacy deterministic slug.
 * All {plan_file} interpolations go through this — the implement worker must
 * read the exact file the planner wrote.
 */
export function resolvePlanFilePath(ctx: Pick<WorkflowContext, "state">): string {
  return ctx.state.planFile ?? planFilePath(ctx.state.goal);
}

/**
 * Plan-path block for the plan phase instructions (mindrun F1 fix): the
 * orchestrator can NOT pin the path up front — resolving it deterministically
 * names the plan from the goal and the model just parrots it back, so the LLM
 * never actually names anything. Instead the model CHOOSES a short, meaningful
 * slug capturing the plan's essence, writes the file there, and reports the
 * actual path; isValidPlanFile validates the reported marker and the legacy
 * slug remains the fallback when the marker is missing or invalid.
 */
export function planInstructionsFor(_ctx: Pick<WorkflowContext, "state">): string {
  return [
    `The plan file lives under \`${PLAN_DIR}/\` — YOU choose the filename: a short kebab-case slug (3-6 words) capturing the plan's essence (e.g. \`${PLAN_DIR}/auth-refresh-rotation.md\`), not a generic echo of the goal.`,
    `End your kstack_advance summary with the line \`PLAN FILE: ${PLAN_DIR}/<your-slug>.md\` — the exact path of the file you actually wrote.`,
  ].join(" ");
}

export function planFilePath(goal: string): string {
  return `${PLAN_DIR}/${planFileSlug(goal)}.md`;
}

export function buildPhaseInstructions(phase: WorkflowPhase, ctx: WorkflowContext): string {
  const workflow = getWorkflow(ctx.state.workflowId);
  const totalPhases = workflow?.phases.length ?? 0;
  const parts: string[] = [];

  // Sprint loop engine: a looped-back phase leads with its failure blockers.
  const retry = retryContextBlock(ctx, phase.id);
  if (retry) {
    parts.push(retry);
    parts.push("");
  }

  parts.push(`## [kstack workflow: ${ctx.state.workflowId}] Phase: ${phase.name}`);
  parts.push(`**Goal:** ${ctx.state.goal}`);
  parts.push(`**Progress:** Phase ${ctx.state.phaseIndex + 1} of ${totalPhases}`);
  parts.push(`**Branch:** ${ctx.git.branch}`);
  parts.push("");

  const priorResults = Object.entries(ctx.state.results)
    .filter(([, r]) => r.status === "completed")
    .map(([id, r]) => `- **${id}**: ${briefSummary(r.summary)}`);
  if (priorResults.length > 0) {
    parts.push("### Completed phases");
    parts.push(priorResults.join("\n"));
    parts.push("");
  }

  if (phase.execution === "main") {
    parts.push(buildMainInstructions(phase, ctx));
    const boundary = scopeBoundaryFor(phase.id);
    if (boundary) {
      parts.push("");
      parts.push(boundary);
    }
  } else if (deterministicSubagents()) {
    // The executor has already spawned the specialists; their output arrives
    // above these instructions. Do not ask the model to delegate again — and
    // do not echo the skill-laden task JSON into orchestrator context.
    parts.push(
      "### Delegated execution",
      "This phase's specialist work was already dispatched deterministically by the orchestrator. Review the subagent output above, verify it against the skill gates below, and summarize.",
    );
  } else {
    parts.push(buildSubagentInstructions(phase, ctx));
  }

  // Skill knowledge tiering:
  //  - main phases work with the methodology themselves → full digest,
  //    unless it was already delivered earlier in this run (then DoD gate only);
  //  - subagent phases: the FULL digest travels inside the specialist's task
  //    (isolated context), while the orchestrator only needs the DoD gate to
  //    verify the output.
  const skillBlock = buildOrchestratorSkillBlock(phase, ctx);
  if (skillBlock) {
    parts.push("");
    parts.push(skillBlock);
  }

  parts.push("");
  parts.push(buildAdvancementRule(phase));

  return parts.join("\n");
}

/**
 * Advancement contract — one uniform rule so the model never improvises:
 * always end the phase by calling kstack_advance yourself; never defer to the
 * user. Whether the workflow continues automatically or pauses for approval
 * after that call is decided by the orchestrator, not the model.
 */
function buildAdvancementRule(phase: WorkflowPhase): string {
  const lines = [
    "---",
    "When this phase is complete, YOU call the `kstack_advance` tool with a 2-3 sentence summary of what was accomplished and status \"completed\". Never ask the user to run a command to continue — the workflow handles progression.",
    // STEP 4a (COR-01): the marker must survive into the SUMMARY — skip.ts
    // reads results[phase].summary, not the report body.
    "If your report ends with a `CONFIRMED ROOT CAUSE:` line, you MUST include that exact line verbatim in your kstack_advance summary.",
  ];
  if (manualGates() && phase.advance === "manual") {
    lines.push(
      "This phase is a DECISION PHASE: after you call kstack_advance, the workflow will pause so the user can review your output before the next phase starts. Present your results clearly and completely — the user's approval depends on them.",
    );
  }
  lines.push("If the phase failed, use status \"failed\" and explain why.");
  return lines.join("\n");
}

function variantDirective(phase: WorkflowPhase): string | null {
  if (phase.variant === "report-only") {
    return "**REPORT-ONLY MODE**: test and classify exactly as instructed, but do NOT fix anything and do NOT commit. The report is the entire deliverable; add a `Recommended fix` line per bug.";
  }
  return null;
}

/**
 * Skill blocks shown in ORCHESTRATOR instructions.
 */
function buildOrchestratorSkillBlock(phase: WorkflowPhase, ctx: WorkflowContext): string | null {
  if (!skillsEnabled() || !phase.skills || phase.skills.length === 0) {
    const vd = variantDirective(phase);
    return vd ? [vd].join("\n") : null;
  }

  const delivered = ctx.state.skillsDelivered ?? [];
  const parts: string[] = [];
  const isSubagentPhase = phase.execution === "subagent";

  for (const id of phase.skills) {
    const info = getSkillInfo(id);
    if (!info) continue;
    parts.push(`#### Skill gate: ${id}`);

    const alreadyDelivered = delivered.includes(id);
    const wantFullDigest =
      !isSubagentPhase && !alreadyDelivered;

    if (wantFullDigest) {
      const digest = loadSkillFull(id);
      if (digest) {
        parts.push(digest);
        parts.push(`(Full skill documentation for deep consultation: ${info.skillPath})`);
        continue;
      }
      // skill file missing → fall through to the gate
    }

    // Subagent phase or repeat delivery: compact DoD gate parsed from SKILL.md.
    const gate = loadSkillGate(id);
    if (gate) parts.push(gate);
    if (!isSubagentPhase && alreadyDelivered) {
      parts.push("(Full methodology delivered in an earlier phase — follow the same rules.)");
    }
  }

  const vd = variantDirective(phase);
  if (vd) parts.push(vd);

  return parts.length > 0 ? parts.join("\n") : null;
}

// Skill classes (efficiency plan §1c): how strictly a digest's output format
// must be treated inside a subagent task.
type SkillClass = "format-critical" | "support";
const SKILL_CLASSES: Record<string, SkillClass> = {
  "kstack-qa": "format-critical",
  "kstack-review": "format-critical",
  "kstack-investigate": "format-critical",
  "kstack-grilling": "format-critical",
  "kstack-document": "format-critical",
  "kstack-fix-strategy": "format-critical",
  "kstack-ship": "support",
  "kstack-office-hours": "support",
  "kstack-plan-eng-review": "support",
};
export function skillClassFor(id: string): SkillClass {
  return SKILL_CLASSES[id] ?? "format-critical";
}
const FORMAT_CRITICAL_PREFIX =
  "This methodology's output format IS part of the deliverable: severity categories, gates and report structures are MANDATORY.";
const SUPPORT_PREFIX = "Apply the parts useful to the deliverable; nothing more.";

/**
 * Deliverable-first contracts for MAIN-execution phases (path 2 of STEP 1).
 * Every main-phase instruction ends with a falsifiable DELIVERABLE /
 * STOP CONDITION pair so the model optimizes for the artifact, not the method.
 */
const MAIN_CONTRACTS: Record<string, (ctx: Pick<WorkflowContext, "state">) => string> = {
  "understand": () =>
    "## DELIVERABLE\nA shared-understanding summary: what exists today, what must change, and the chosen approach. End the summary with a section `OPEN QUESTIONS:` followed by one bullet per unresolved question (or exactly `OPEN QUESTIONS: none` when everything is settled).\n\n## STOP CONDITION\nStop when: ambiguities are resolved with the user or explicitly listed as open questions.",
  "plan": (c) =>
    `## DELIVERABLE\nA converged plan file under \`${PLAN_DIR}/\` following the Plan file contract, briefly summarized to the user. ${planInstructionsFor(c)}\n\n## STOP CONDITION\nStop when: the interview frontier is empty (nothing silently assumed) and the plan file is written. Do NOT start implementing.`,
  "reproduce": () =>
    '## DELIVERABLE\nA reliable, deterministic way to trigger the bug + expected vs actual symptoms, ending with the trailing line `CONFIRMED ROOT CAUSE: <one-line cause> | files: <comma-separated file paths>` or `CONFIRMED ROOT CAUSE: none | files: none`.\n\n## STOP CONDITION\nStop when: the bug is reproduced AND the suspected cause is verified against the code (≤3 targeted reads), or a reliable reproduction exists without an obvious cause.',
  "verify": () =>
    "## DELIVERABLE\nFixed / not-fixed verdict with evidence (reproduction outcome + test results).\n\n## STOP CONDITION\nStop when: the original reproduction steps have been re-run and related tests have been executed.",
  "setup": () =>
    "## DELIVERABLE\nA concrete QA scope: target URL/dev server, user flows under test, and the test plan.\n\n## STOP CONDITION\nStop when: the test plan is defined and summarized.",
  "report": () =>
    "## DELIVERABLE\nA structured bug report: every finding with severity, repro steps, evidence reference, plus what passed and a fix-priority order.\n\n## STOP CONDITION\nStop when: all collected findings are compiled into the report.",
  "pre-checks": () =>
    "## DELIVERABLE\nA ready-to-ship verdict or an explicit blocker list (commits, tests, lint, TODOs, branch status).\n\n## STOP CONDITION\nStop when: every checklist item has been checked and reported.",
  "findings": () =>
    "## DELIVERABLE\nReview findings categorized by severity with file:line references and suggested fixes, plus an overall assessment.\n\n## STOP CONDITION\nStop when: the full diff analysis has been presented.",
  "action": () =>
    '## DELIVERABLE\nThe requested single action (QA / review / ship / investigate) completed, with its standard report.\n\n## STOP CONDITION\nStop when: the action\'s own deliverable is produced.',
};

/**
 * Completed-phase summaries are re-sent with EVERY later step; the full text
 * (up to 4000 chars each) made them ~90% of a mid-sprint prompt. The detail
 * lives in the phase's artifacts on disk.
 */
const BRIEF_SUMMARY_CHARS = 600;
function briefSummary(summary: string): string {
  return summary.length > BRIEF_SUMMARY_CHARS ? `${summary.slice(0, BRIEF_SUMMARY_CHARS)}…` : summary;
}

export function mainContractFor(phase: WorkflowPhase, ctx: Pick<WorkflowContext, "state">, step?: WorkflowStep): string {
  // S3 stepped phases: the step task carries its own DELIVERABLE/STOP lines —
  // extract exactly that pair (up to the next unrelated heading or EOF).
  if (step) {
    const m = /## DELIVERABLE[\s\S]*?(?=\n## (?!DELIVERABLE|STOP CONDITION)|$)/.exec(step.task);
    if (m) {
      // The resume/re-issue contract must carry the RUN's values — a literal
      // {sprint} would let the model write artifacts under the placeholder.
      let contract = m[0].trim();
      contract = replaceExact(contract, /\{sprint\}/g, ctx.state.sprintNumber !== undefined ? pad2(ctx.state.sprintNumber) : "??");
      contract = replaceExact(contract, /\{goal\}/g, ctx.state.goal);
      return contract;
    }
    return `## DELIVERABLE\nA clear, verifiable result for the "${step.id}" step of the "${phase.name}" phase.\n\n## STOP CONDITION\nStop when: the step task is complete and its deliverable exists.`;
  }
  const builder = MAIN_CONTRACTS[phase.id];
  if (builder) return builder(ctx);
  return `## DELIVERABLE\nA clear, verifiable result for the "${phase.name}" phase, directly usable by the next phase.\n\n## STOP CONDITION\nStop when: the result can be checked against this description as done or not done. Further work is waste.`;
}

// Sprint planning-phase contracts (plan D6: story / capability / system-design /
// backlog stay four separate main phases). The assigned sprint number travels
// inside the contract — the main model never sees UI notifications, so "XX"
// alone would leave it guessing the artifact name.
function sprintNum(ctx?: Pick<WorkflowContext, "state">): string {
  return ctx?.state.sprintNumber !== undefined ? pad2(ctx.state.sprintNumber) : "XX";
}
MAIN_CONTRACTS["user-story"] = (c) =>
  `## DELIVERABLE\nuser-story_${sprintNum(c)}.md in the project root: goal/actor/outcome with falsifiable acceptance criteria.\n\n## STOP CONDITION\nStop when: every acceptance criterion is boolean-checkable and the artifact exists on disk.`;
MAIN_CONTRACTS["capability"] = (c) =>
  `## DELIVERABLE\nproduct-capability_${sprintNum(c)}.md: engineering constraints as boolean conditions, enumerated trust boundaries, explicit non-goals.\n\n## STOP CONDITION\nStop when: each constraint is testable and no vague adjective remains.`;
MAIN_CONTRACTS["system-design"] = (c) =>
  `## DELIVERABLE\nsystem-design_${sprintNum(c)}.md (+ ADR-log_${sprintNum(c)}.md): domains with data flows, aggregates with boolean invariants, unhappy-path error payloads, and the BINDING Ubiquitous Language glossary table.\n\n## STOP CONDITION\nStop when: the glossary table exists and every aggregate invariant is falsifiable.`;
MAIN_CONTRACTS["backlog"] = (c) =>
  `## DELIVERABLE\ntasks_${sprintNum(c)}.md: atomic tasks each specifying inputs, payload, constraints, unhappy paths, a falsifiable success condition, owning role (backend/frontend), and dependencies.\n\n## STOP CONDITION\nStop when: every task's success condition is externally checkable and role assignment covers the whole capability.`;

function buildMainInstructions(phase: WorkflowPhase, ctx: WorkflowContext): string {
  const templates: Record<string, (ctx: WorkflowContext) => string> = {
    "plan": (c) => [
      "### Instructions — Interactive Planning",
      "You are conducting the planning interview. The scout's codebase findings are in your context above.",
      "",
      ...(carryOverOpenQuestions(c) ? [carryOverOpenQuestions(c), ""] : []),
      "**Interview protocol (grilling)**: map decisions as a design tree; work in rounds over the frontier (questions whose prerequisites are settled). Each round: number the questions, give YOUR recommended answer under each, then STOP and wait for the user's replies.",
      "- Maximum 5 questions per round; only questions that change architecture or scope.",
      "- Never ask the user for a fact you can look up yourself (use the scout output or tools).",
      "- Apply office-hours judgment: challenge vague premises, demand specificity, push for the narrowest shippable scope.",
      "- Apply engineering rigor: blast radius, hidden assumptions, edge cases, test strategy; complexity gate at 8+ files or 2+ new services.",
      "",
      "**Termination**: when the frontier is empty (or answers are exhausted), write the converged plan following the Plan file contract in the skill gates below — " + planInstructionsFor(c) + " Summarize the plan briefly to the user, then call kstack_advance. Do NOT start implementing.",
    ].join("\n"),

    "understand": (c) => [
      "### Instructions",
      "Analyze the user's goal and the current codebase to establish shared understanding:",
      `1. Read relevant files and understand the existing architecture`,
      `2. Identify constraints, dependencies, and patterns to follow`,
      `3. Clarify ambiguities by asking the user (if needed)`,
      `4. Summarize: what exists, what needs to change, what's the approach`,
      "",
      "5. End the report with a section `OPEN QUESTIONS:` followed by one bullet (`- …`) per unresolved question — or exactly `OPEN QUESTIONS: none` when everything is settled. The planner phase consumes this section; never drop it.",
    ].join("\n"),

    "reproduce": (c) => [
      "### Instructions",
      "Reproduce the bug systematically:",
      `1. Read error messages, stack traces, or user description: "${c.state.goal}"`,
      `2. Identify the affected code path (read relevant files)`,
      `3. Attempt reproduction (run tests, start dev server, or use browser tools)`,
      `4. Document: exact steps to reproduce, expected vs actual behavior`,
      `5. If you cannot reproduce, state what you tried and what's needed`,
      "",
      "If your report ends with a `CONFIRMED ROOT CAUSE:` line, you MUST include that exact line verbatim in your kstack_advance summary.",
    ].join("\n"),

    "verify": (c) => [
      "### Instructions",
      "Verify the fix works correctly:",
      `1. Re-run the reproduction steps from the "reproduce" phase`,
      `2. Confirm the bug is fixed (expected behavior now occurs)`,
      `3. Run related tests: unit tests, integration tests`,
      `4. Check for obvious regressions in adjacent functionality`,
      `5. Report: fixed (with evidence) or not fixed (with details)`,
    ].join("\n"),

    "setup": (c) => [
      "### Instructions",
      "Set up the QA testing scope:",
      `1. Identify what to test: "${c.state.goal}"`,
      `2. Determine the target URL or dev server (ask user if unclear)`,
      `3. Define the test plan: which user flows, which breakpoints`,
      `4. Ensure the kstack browser binary is available (use the kstack_daemon_status tool)`,
      `5. Summarize the test plan before proceeding`,
    ].join("\n"),

    "report": (c) => [
      "### Instructions",
      "Compile the QA findings into a structured report:",
      `1. List all bugs found with severity (critical/major/minor/cosmetic)`,
      `2. For each bug: steps to reproduce, expected vs actual, screenshot reference`,
      `3. Note what passed (working flows)`,
      `4. Recommend fix priority order`,
      `5. Ask user: "Want me to fix these issues, or just report?"`,
    ].join("\n"),

    "pre-checks": (c) => [
      "### Instructions",
      "Run pre-flight checks before shipping:",
      `1. Verify all changes are committed (git status)`,
      `2. Run the test suite (identify test command from package.json/Makefile)`,
      `3. Run linter/type checker if configured`,
      `4. Check for TODO/FIXME in changed files`,
      `5. Verify branch is up to date with remote`,
      `6. Report: ready to ship, or blockers found`,
    ].join("\n"),

    "findings": (c) => [
      "### Instructions",
      "Present the code review findings:",
      `1. Read the diff analysis from the previous phase`,
      `2. Categorize findings: critical (must fix), warning (should fix), suggestion (nice to have)`,
      `3. For each finding: file, line, issue, suggested fix`,
      `4. Give an overall assessment: approve, request changes, or needs discussion`,
      `5. Ask user: "Want me to apply the suggested fixes?"`,
    ].join("\n"),

    "action": (c) => [
      "### Instructions",
      `The user requested a quick action: "${c.state.goal}"`,
      `Determine which single action to perform (QA, review, ship, or investigate) and execute it directly.`,
      `Use the appropriate kstack tools and workflows. Keep it focused and fast.`,
    ].join("\n"),

    // Sprint planning phases (plan D6).
    "user-story": (c) => [
      "### Instructions",
      `Sprint planning step 1/4 — write the USER STORY for: "${c.state.goal}"`,
      "1. Read the skill digest below; it defines goal/actor/outcome structure and falsifiable acceptance criteria.",
      `2. Write user-story_${sprintNum(c)}.md into the project root (sprint number ${sprintNum(c)}, assigned by the orchestrator).`,
      "3. Every acceptance criterion must be boolean-checkable (a machine or a bored human can verify it).",
      "4. No implementation talk — this artifact is WHAT + WHY, never HOW.",
    ].join("\n"),

    "capability": (c) => [
      "### Instructions",
      `Sprint planning step 2/4 — derive PRODUCT CAPABILITY from user-story_${sprintNum(c)}.md for: "${c.state.goal}"`,
      "1. Read the skill digest; engineering constraints are boolean conditions only.",
      `2. Write product-capability_${sprintNum(c)}.md: constraints, enumerated trust boundaries (who talks to what with which authority), explicit non-goals.`,
      "3. Vague adjectives ('fast', 'user-friendly') must be replaced by measurable conditions.",
    ].join("\n"),

    "system-design": (c) => [
      "### Instructions",
      `Sprint planning step 3/4 — SYSTEM DESIGN for: "${c.state.goal}"`,
      "1. Read BOTH skill digests below (design + ADR discipline).",
      `2. Write system-design_${sprintNum(c)}.md (+ ADR-log_${sprintNum(c)}.md): domains with data flows, aggregates with boolean invariants, unhappy-path error payloads.`,
      "3. CRITICAL: include the BINDING Ubiquitous Language glossary table (term | definition | forbidden synonym). Later phases quote it verbatim; synonyms introduced downstream are review-blocking defects.",
      "This phase is a MANUAL gate — present the design and wait for user approval before continuing.",
    ].join("\n"),

    "backlog": (c) => [
      "### Instructions",
      `Sprint planning step 4/4 — SPRINT BACKLOG from system-design_${sprintNum(c)}.md for: "${c.state.goal}"`,
      "1. Read the task-breakdown digest; atomicity is the law.",
      `2. Write tasks_${sprintNum(c)}.md: each task has inputs, payload, constraints, unhappy paths, a FALSIFIABLE success condition, owning role (backend/frontend), dependencies.`,
      "3. Tasks must be executable in isolation on their own branch — no cross-task coupling before merge.",
      "Present the backlog and wait for approval before the implement chain starts.",
    ].join("\n"),
  };

  const builder = templates[phase.id];
  const base = builder
    ? builder(ctx)
    : [
        "### Instructions",
        `Execute the "${phase.name}" phase for goal: "${ctx.state.goal}"`,
        "Use available tools to accomplish this phase.",
        "Focus on producing a clear, actionable result.",
      ].join("\n");
  return `${base}\n\n${mainContractFor(phase, ctx)}`;
}

function buildSubagentInstructions(phase: WorkflowPhase, ctx: WorkflowContext): string {
  const parts: string[] = [];

  parts.push("### Action: Use the `subagent` tool");
  parts.push("");

  if (phase.chain && phase.chain.length > 1) {
    parts.push("Call the `subagent` tool in **chain mode** with these parameters:");
    parts.push("");
    parts.push("```json");
    parts.push(JSON.stringify({
      chain: phase.chain.map((step) => ({
        agent: step.agent,
        // STEP 3c: per-step skill override, defaulting to the phase's skills.
        task: interpolate(buildTaskSkills(phase, step.task, conditionalSkillIds(step.skills ?? phase.skills, ctx.cwd)), ctx),
      })),
    }, null, 2));
    parts.push("```");
    parts.push("");
    parts.push("Each step receives the previous step's output via `{previous}`.");
  } else {
    const agent = phase.agent ?? "worker";
    const task = interpolate(buildAgentTask(phase, ctx), ctx);
    parts.push(`Call the \`subagent\` tool with these parameters:`);
    parts.push("");
    parts.push("```json");
    parts.push(JSON.stringify({ agent, task }, null, 2));
    parts.push("```");
  }

  parts.push("");
  parts.push("After the subagent completes, review its output and call `kstack_advance` with a summary.");
  parts.push("If the subagent fails, call `kstack_advance` with status \"failed\" and explain what went wrong.");

  return parts.join("\n");
}

function buildAgentTask(phase: WorkflowPhase, ctx: WorkflowContext): string {
  // Deliverable-first contracts (STEP 1): fixed 4-block order for every
  // subagent task — DELIVERABLE / STOP CONDITION / CONTEXT / METHODOLOGY
  // (methodology is appended last by buildTaskSkills).
  const tasks: Record<string, string> = {
    "explore": `## DELIVERABLE
Relevant files with absolute paths and line references, architectural patterns, constraints, and test infrastructure. Facts only — no design proposals.

## STOP CONDITION
Stop when: every area of the goal has at least one mapped file and the patterns/constraints are listed. Further exploration is waste.

## CONTEXT
Goal: {goal} | Branch: {branch}

Find all code that matters: entry points, affected modules, existing patterns, architecture constraints, test infrastructure. Report file paths (absolute), key functions, patterns to follow, and anything surprising.`,
    "implement": `## DELIVERABLE
Code implementing the approved plan, a list of justified deviations (if any), and the tests you ran.

## STOP CONDITION
Stop when: the plan is implemented and tests are green.

## CONTEXT
Goal: {goal} | Branch: {branch}
The full plan is in the file: {plan_file}. Read it FIRST and follow it — it contains the goal, scope, architecture, files to change, edge cases, and test strategy agreed with the user.
Context from prior phases:
{plan_summary}

Write production-quality code. Run tests after implementation. Report what was implemented, any deviations from the plan (and why), and any issues.`,
    "qa": `## DELIVERABLE
For each goal-related flow: pass/fail verdict + screenshot evidence + severity (CRITICAL/HIGH/MEDIUM/LOW) per bug found, ending with the line \`COVERAGE: <tested flows>\`.

## STOP CONDITION
Stop when: the required flows are covered OR two passes produce no new findings. Deliverable flows are ALWAYS mandatory.

## CONTEXT
Goal: {goal} | Branch: {branch}

Use the kstack browser tools to test user flows. Core set: kstack_goto, kstack_snapshot, kstack_click, kstack_fill or kstack_type (form inputs — never declare a form flow tested without exercising its inputs), kstack_wait (settle SPAs before asserting), kstack_console with --errors after each flow (silent JS failures are bugs), kstack_screenshot for evidence; others (kstack_network, kstack_select, kstack_scroll, ...) as needed. Report all bugs found with severity.`,
    "review": `## DELIVERABLE
Findings with severity + file:line + concrete failure scenario, a scope check, and a final verdict APPROVE or REQUEST_CHANGES.

## STOP CONDITION
Stop when: the full diff has been analyzed.

## CONTEXT
Goal: {goal} | Branch: {branch}

Run git diff to see changes. Check for: bugs, security issues, performance problems, style violations, missing tests. Report findings categorized by severity.`,
    "ship": `## DELIVERABLE
Branch pushed, PR URL, TODOS.md updated, atomic commits verified.

## STOP CONDITION
Stop when: the ship checklist is complete.

## CONTEXT
Goal: {goal} | Branch: {branch}

1. Ensure all changes are committed
2. Push to remote
3. Create a PR with a clear title and description
4. Report the PR URL and any CI status`,
    "fix": `## DELIVERABLE
Minimal fixes applied for the findings below, tests green, regression coverage for CRITICAL/HIGH findings.

## STOP CONDITION
Stop when: all findings are addressed.

## CONTEXT
Goal: {goal} | Branch: {branch}
Confirmed root cause:
{root-cause_summary}
Prior findings:
{findings_summary}

Apply minimal, targeted fixes. Run tests after each fix. Report what was fixed.
If your report ends with a \`CONFIRMED ROOT CAUSE:\` line, you MUST include that exact line verbatim in your kstack_advance summary.`,
    "test": `## DELIVERABLE
Test commands identified + pass/fail counts + failure details.

## STOP CONDITION
Stop when: the suite has completed.

## CONTEXT
Goal: {goal} | Branch: {branch}

Identify the test command (package.json scripts, Makefile, etc.) and run it.`,
    "push-pr": `## DELIVERABLE
PR URL + CI status.

## STOP CONDITION
Stop when: the PR is created.

## CONTEXT
Goal: {goal} | Branch: {branch}
Prior review summary: {review_summary}

1. Push branch to remote
2. Create PR via gh cli with title and body summarizing changes
3. Report PR URL`,
    "diff": `## DELIVERABLE
Files changed, lines added/removed, a summary of what each change does per area, and any concerns.

## STOP CONDITION
Stop when: the full diff analysis is complete.

## CONTEXT
Goal: {goal} | Branch: {branch}

Run: git diff main...HEAD (or appropriate base branch).`,
    "regression-qa": `## DELIVERABLE
Pass/fail + screenshot evidence + severity (CRITICAL/HIGH/MEDIUM/LOW) for each adjacent flow tested, ending with the line \`COVERAGE: <tested flows>\`.

## STOP CONDITION
Stop when: the required adjacent flows are covered OR two passes produce no new findings.

## CONTEXT
Goal: {goal} | Branch: {branch}

Use browser tools to test adjacent functionality — same core set as the qa phase (kstack_goto, kstack_snapshot, kstack_click, kstack_fill/kstack_type, kstack_wait, kstack_console --errors). Verify the fix didn't break other flows.`,
    "document": `## DELIVERABLE
A DOC REPORT block (files reviewed, updated, generated, remaining gaps) plus doc updates committed as their own atomic commit.

## STOP CONDITION
Stop when: every changed area has a Diataxis classification and the dictated factual updates are committed.

## CONTEXT
Goal: {goal} | Branch: {branch}

1. Analyze the branch diff against the base branch (git diff/log) and classify changes (new features / changed behavior / removed functionality)
2. Discover all markdown docs (maxdepth 2, excluding .git/node_modules/.kstack)
3. Build a Diataxis coverage map per changed area (tutorial / how-to / reference / explanation) and apply factual updates the diff dictates
4. Where docs are missing entirely, research the code (read implementations end-to-end + tests) and write them following Diataxis; write reference docs first
5. Sweep cross-doc consistency (versions, paths, counts, stale references)
6. Commit doc updates as their own atomic commit with a docs: prefix
7. Output the DOC REPORT block`,
    "update-docs": `## DELIVERABLE
A DOC REPORT block (files reviewed, updated, generated, remaining gaps) plus doc updates committed as their own atomic commit.

## STOP CONDITION
Stop when: every changed area has a Diataxis classification and the dictated factual updates are committed.

## CONTEXT
Goal: {goal} | Branch: {branch}

1. Analyze the branch diff against the base branch (git diff/log) and classify changes (new features / changed behavior / removed functionality)
2. Discover all markdown docs (maxdepth 2, excluding .git/node_modules/.kstack)
3. Build a Diataxis coverage map per changed area (tutorial / how-to / reference / explanation) and apply factual updates the diff dictates
4. Where docs are missing entirely, research the code (read implementations end-to-end + tests) and write them following Diataxis; write reference docs first
5. Sweep cross-doc consistency (versions, paths, counts, stale references)
6. Commit doc updates as their own atomic commit with a docs: prefix
7. Output the DOC REPORT block`,
    // Sprint gates (plan B5): verdicts live BOTH on disk and in ## HANDOFF.
    "architect-gate": `## DELIVERABLE
${softwareArchitectArtifactName("{sprint}", "N")} in the project root (N = next sequence number): binary verdict 'software-architect-review == approved' or 'software-architect-review == rejected', each rejection with file:line findings and concrete failure scenarios.

## STOP CONDITION
Stop when: the artifact exists with its parseable verdict line and every finding cites code.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
Audit system-design_XX.md + ADR-log_XX.md against the capability. Rejections loop back to the design phase automatically — be precise about WHAT fails and WHY.

End the artifact with EXACTLY ONE of these two lines (your real verdict, nothing else on the line):
- 'software-architect-review == approved'
- 'software-architect-review == rejected'
Repeat the SAME line verbatim inside your ## HANDOFF — the orchestrator cross-checks both channels before routing.`,
    "qa-verdict": `## DELIVERABLE
${qaArtifactName("{sprint}")} in the project root: test execution report ending with 'status == green', 'status == red' or 'status == orange' (exactly one, as a bare line) plus failure reports for RED (repro steps) or Testability Blockers for ORANGE (missing selectors/ids).

## STOP CONDITION
Stop when: the artifact exists with its STATUS line and every non-GREEN finding is reproducible from the report alone.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
Execute the acceptance criteria of user-story_{sprint}.md against the implemented branch using browser tools. RED/ORANGE loops back to implement automatically.

Write ${qaArtifactName("{sprint}")} ending with EXACTLY ONE of these three lines (your real verdict, nothing else on the line):
- 'status == green'
- 'status == red'
- 'status == orange'
Repeat the SAME line verbatim inside your ## HANDOFF — the orchestrator cross-checks both channels before routing.`,
    "commit-archive": `## DELIVERABLE
Sprint closed: all work committed via Conventional Commits, artifacts archived to .kstack/workflows/sprint/sprint_{sprint}/, archive manifest written.

## STOP CONDITION
Stop when: git status is clean, the archive directory contains all sprint_{sprint} artifacts, and the manifest lists them.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
This phase runs ONLY after explicit user approval (the orchestrator entry-gates it). Steps: 1) verify suite green, 2) commit any uncommitted work (Conventional Commits), 3) move ALL sprint artifacts (user-story/capability/system-design/ADR/tasks/QA/review files) into .kstack/workflows/sprint/sprint_{sprint}/, 4) write manifest.md listing the moved files.`,
  };

  // Explicit phase.task wins over the generic per-id template (same
  // precedence as chain steps). Session post-mortem 2026-08-28: the
  // investigate/qa "fix" phases could not carry context any other way, and
  // the shared generic template's {findings_summary} silently interpolated
  // to "(not yet available)" outside the review workflow.
  let task = phase.task ?? tasks[phase.id] ?? (phase.steps?.length ? phase.steps[0].task : undefined) ?? `Execute the "${phase.name}" phase for: {goal}. Use available tools and report results.`;
  const vd = phase.variant === "report-only"
    ? "\n\n**REPORT-ONLY MODE**: do NOT fix anything and do NOT commit. The report is the entire deliverable."
    : "";
  return buildTaskSkills(phase, task + vd);
}

/**
 * Embed the skill methodology into a subagent task string. Subagent
 * processes have isolated contexts — embedding the methodology in the task is
 * the only reliable way for them to receive it. Source is the canonical
 * skills/<dir>/SKILL.md (single source post-S1).
 */
// OUTPUT CONTRACT (STEP 2a): every specialist ends its work with a structured
// HANDOFF section so the next chain step receives verified facts, not a wall
// of text. Appended AFTER the METHODOLOGY block.
const OUTPUT_CONTRACT = `## OUTPUT CONTRACT
1. "## REPORT" — the full report in your role's format.
2. "## HANDOFF" (mandatory, ≤300 words, for the next specialist):
   - VERIFIED FACTS: confirmed facts only, each with evidence \`claim @ file:line\`
   - DECISIONS: choices made and why (one line each)
   - OPEN QUESTIONS: what remains open (or "none")
   - DO NOT REDO: what the next agent must NOT redo`;

function appendOutputContract(task: string): string {
  return `${task}\n\n---\n\n${OUTPUT_CONTRACT}`;
}

function buildTaskSkills(phase: WorkflowPhase, task: string, skillsOverride?: string[]): string {
  const ids = skillsOverride ?? phase.skills;
  if (!skillsEnabled() || !ids || ids.length === 0) {
    return appendOutputContract(task);
  }
  const blocks: string[] = [];
  for (const id of ids) {
    const digest = loadSkillFull(id);
    const info = getSkillInfo(id);
    // Per-skill class prefix (STEP 1c): format-critical digests are part of
    // the deliverable; support digests are applied only as useful.
    const prefix = skillClassFor(id) === "format-critical" ? FORMAT_CRITICAL_PREFIX : SUPPORT_PREFIX;
    if (digest) {
      // Embedded text has no location of its own: without the folder, the
      // skill's relative references/ and scripts/ paths resolve nowhere.
      const folder = info ? `\nSkill folder — resolve every relative path in this methodology (references/, scripts/, assets/, "<skill>", "<skill-base-dir>") against: ${path.dirname(info.skillPath).replace(/\\/g, "/")}` : "";
      blocks.push(`## Skill methodology: ${id} (${skillClassFor(id)})\n${prefix}${folder}\n\n${digest}`);
    } else if (info && existsSync(info.skillPath)) {
      blocks.push(`## Skill methodology: ${id} (${skillClassFor(id)})\n${prefix}\nBefore starting, read the file ${info.skillPath} and follow its methodology.`);
    }
  }
  if (blocks.length === 0) return appendOutputContract(task);
  // Fixed block order: the task (DELIVERABLE / STOP CONDITION / CONTEXT)
  // first, then METHODOLOGY, then the OUTPUT CONTRACT last.
  return `${task}\n\n---\n\n## METHODOLOGY\n\n${blocks.join("\n\n---\n\n")}\n\n---\n\n${OUTPUT_CONTRACT}`;
}

/**
 * Resolve the concrete subagent work for a phase: single agent or chain, with
 * all {goal}/{branch}/{*_summary} placeholders and skill methodology already
 * interpolated. Used by the deterministic executor to spawn subagents itself.
 */
// Scope boundaries keyed by phase id. The session debug of 2026-08-22 showed
// the reproduce phase drifting into full root-causing (the injected
// kstack-investigate digest contains the whole debugging methodology), which
// made the subsequent root-cause chain — and its manual approval gate — feel
// redundant to the user. These directives keep each phase inside its lane.
const PHASE_BOUNDARIES: Record<string, string> = {
  reproduce:
    "SCOPE BOUNDARY: This is the REPRODUCTION phase. Deliverable: a reliable, deterministic way to trigger the bug + precise symptoms. Briefly NOTE suspected causes if obvious, but do NOT deep-dive them, do NOT produce a full diagnosis, and do NOT change any files — that is the next phase's job.",
  "root-cause":
    "EFFICIENCY DIRECTIVE: Check the completed-phase summaries first. If a confirmed root cause already emerged during reproduction, VALIDATE it quickly against the code (confirm mechanism + affected files) instead of re-investigating from scratch, then report. Only widen the investigation if validation fails.",
};

/**
 * Open-questions carry-over (2026-09 session gap): the understand phase may
 * legitimately close with unresolved ambiguities (its contract says so), but
 * nothing reinjected them into the planning interview — the planner rebuilt
 * its own frontier and the questions silently died. Extract the parseable
 * `OPEN QUESTIONS:` section from the understand summary and surface it to the
 * plan phase so every carried question is either resolved or folded into a
 * round explicitly.
 */
export function carryOverOpenQuestions(ctx: Pick<WorkflowContext, "state">): string {
  // Newest summary carrying the section wins: develop records it under
  // "plan.evolve", sprint under "understand.evolve" / "understand".
  let summary = "";
  for (const res of Object.values(ctx.state.results)) {
    if (res?.summary?.includes("OPEN QUESTIONS:")) summary = res.summary;
  }
  const m = /OPEN QUESTIONS:\s*\n?((?:[ \t]*[-*•]\s*[^\n]+\n?)+)/.exec(summary);
  if (!m) return "";
  const items = m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 10);
  if (items.length === 0) return "";
  return [
    "### Carried-over open questions",
    "These were left unresolved by an earlier step. Resolve them with the user or fold each into an interview round — do not silently assume them away.",
    "",
    ...items,
  ].join("\n");
}



export function scopeBoundaryFor(phaseId: string): string {
  return PHASE_BOUNDARIES[phaseId] ?? "";
}

export function buildDeterministicPlan(phase: WorkflowPhase, ctx: WorkflowContext): Array<{ agent: string; task: string }> {
  // STEP 4c: structural skip. If reproduction already CONFIRMED the root cause
  // (marker inside a valid HANDOFF, all cited files existing), collapse the
  // scout→planner chain to ONE validate-only planner step. The validate step
  // is never skippable and the workflow never collapses directly to fix.
  if (phase.id === "root-cause") {
    const marker = parseRootCauseMarker(
      extractHandoff(ctx.state.results["reproduce"]?.summary ?? "").text,
      ctx.cwd,
    );
    if (marker) {
      return [{ agent: "planner", task: interpolate(validateStrategyTask(marker), ctx) }];
    }
  }
  const boundary = scopeBoundaryFor(phase.id);
  const suffix = boundary ? `\n\n${boundary}` : "";
  // Sprint loop engine (B6): looped-back phases lead with their blockers.
  const retry = retryContextBlock(ctx, phase.id);
  const prefix = retry ? `${retry}\n\n` : "";
  // Sprint execution phases carry the master DoD checklist on their FINAL
  // output (chain tail or single agent); earlier chain steps stay lean.
  const dod = sprintDodSuffix(ctx.state.workflowId, phase.id);

  if (phase.chain && phase.chain.length > 0) {
    // STEP 3c: each chain step resolves its own skill set (default: phase.skills).
    return phase.chain.map((step, i) => ({
      agent: step.agent,
      task:
        prefix +
        interpolate(
          buildTaskSkills(phase, step.task, conditionalSkillIds(step.skills ?? phase.skills, ctx.cwd)),
          ctx,
        ) +
        (i === phase.chain.length - 1 ? dod : "") +
        suffix,
    }));
  }
  return [
    {
      agent: phase.agent ?? (phase.steps?.length ? phase.steps[0].agent : undefined) ?? "worker",
      task:
        prefix +
        interpolate(buildAgentTaskWithSkills(phase, ctx), ctx) +
        dod +
        suffix,
    },
  ];
}

function buildAgentTaskWithSkills(phase: WorkflowPhase, ctx: WorkflowContext): string {
  let task = buildAgentTask(phase, ctx);
  if (ctx.state.workflowId !== "sprint") return task;
  // Re-filter conditional digests for single-agent sprint phases too.
  const filtered = conditionalSkillIds(phase.skills, ctx.cwd);
  if (filtered !== phase.skills) {
    const clone = { ...phase, skills: filtered };
    task = buildTaskSkills(clone, stripAppendedContract(task));
  }
  return task;
}

/** Remove the OUTPUT_CONTRACT tail so buildTaskSkills can re-append it. */
function stripAppendedContract(task: string): string {
  const marker = "\n---\n\n## METHODOLOGY";
  const idx = task.indexOf(marker);
  return idx >= 0 ? task.slice(0, idx) : task;
}

function interpolate(template: string, ctx: WorkflowContext): string {
  // $-safe (STEP 2c): untrusted values may contain `$&`, `$'`, `$1` etc.
  let out = replaceExact(template, /\{goal\}/g, ctx.state.goal);
  out = replaceExact(out, /\{branch\}/g, ctx.git.branch);
  out = replaceExact(out, /\{plan_file\}/g, resolvePlanFilePath(ctx));
  // Sprint tokens: number + BINDING Ubiquitous Language table.
  out = replaceExact(out, /\{sprint\}/g, ctx.state.sprintNumber !== undefined ? pad2(ctx.state.sprintNumber) : "??");
  out = replaceExact(out, /\{glossary\}/g, glossaryTable(ctx.cwd, ctx.state.sprintNumber));
  // [\w-] not \w: hyphenated phase ids (root-cause, regression-qa) carry
  // real summaries — with \w the {root-cause_summary} token never matched
  // and the fix phase ran without the diagnosis.
  // S3: [\w.-] not [\w-] — stepped phases record results under dotted keys
  // ("plan.draft"), and {plan.draft_summary} must resolve like any phase id.
  // Superset of the old class: no legacy template's output changes.
  out = replaceExact(out, /\{([\w.-]+)_summary\}/g, (_, phaseId: string) =>
    ctx.state.results[phaseId]?.summary ?? "(not yet available)");
  return out;
}

// --- S3 step model (TASK_02) --------------------------------------------------
//
// Step instructions assemble in a FIXED order (D28 research constraint):
// system header → step task → skill gate → contract → advancement rule.
// Volatile deltas (prior-step results, retry context, resume notes) append at
// the tail ONLY — two calls differing only in retry/resume state share a
// byte-identical prefix, so cached prompt prefixes stay warm.

/**
 * Step-scoped interpolation: everything `interpolate` handles plus `{previous}`
 * (the previous same-phase step's recorded summary — for a delegated step that
 * summary carries its ## HANDOFF digest) and `{open_questions}` (carry-over
 * from the understand phase; "(none carried over)" when absent).
 */
export function interpolateStepTask(task: string, phase: WorkflowPhase, stepIndex: number, ctx: WorkflowContext): string {
  let out = interpolate(task, ctx);
  const prev = stepIndex > 0 ? phase.steps?.[stepIndex - 1] : undefined;
  const prevSummary = prev ? ctx.state.results[`${phase.id}.${prev.id}`]?.summary : undefined;
  out = replaceExact(out, /\{previous\}/g, prevSummary || "(no prior output)");
  out = replaceExact(out, /\{open_questions\}/g, carryOverOpenQuestions(ctx) || "(none carried over)");
  // S4/ADR-23 record contract: the step learns its identity + the report CLI
  // path from task tokens (mirrored in spawn env for delegated steps).
  out = replaceExact(out, /\{workflow\}/g, ctx.state.workflowId);
  out = replaceExact(out, /\{runId\}/g, ctx.state.runId ?? "");
  out = replaceExact(out, /\{phase\}/g, phase.id);
  out = replaceExact(out, /\{step\}/g, phase.steps?.[stepIndex]?.id ?? "");
  out = replaceExact(out, /\{kstack_report\}/g, reportCliPath());
  // The record must land in the project the orchestrator reads from — the
  // agent may cd elsewhere before reporting (the record would be invisible).
  out = replaceExact(out, /\{kstack_root\}/g, projectRootFor(ctx.cwd));
  return out;
}

/**
 * Step-scoped skill gate (D19): at most ONE skill per step. Main steps get the
 * full digest on first delivery per run (skillsDelivered), the parsed
 * ## DoD gate on repeats. Delegated steps never need the gate here — their
 * FULL digest rides inside buildStepTask; a bare gate is enough if the
 * orchestrator ever surfaces them.
 */
function buildStepSkillBlock(step: WorkflowStep, ctx: WorkflowContext): string | null {
  if (!skillsEnabled() || !step.skill) return null;
  const id = step.skill;
  const info = getSkillInfo(id);
  if (!info) return null;
  const parts = [`#### Skill gate: ${id}`];
  const alreadyDelivered = (ctx.state.skillsDelivered ?? []).includes(id);
  if (!alreadyDelivered && step.execution === "main") {
    const digest = loadSkillFull(id);
    if (digest) {
      parts.push(digest);
      parts.push(`(Full skill documentation for deep consultation: ${info.skillPath})`);
      return parts.join("\n");
    }
  }
  const gate = loadSkillGate(id);
  if (gate) parts.push(gate);
  if (alreadyDelivered) parts.push("(Full methodology delivered earlier in this run — follow the same rules.)");
  return parts.join("\n");
}

/**
 * Advancement contract for a step: same uniform rule as phases (the model
 * always calls kstack_advance itself), worded at step granularity and naming
 * the persisted result key so the model's summary lands under phase.step.
 */
function buildStepAdvancementRule(phase: WorkflowPhase, step: WorkflowStep, isLast: boolean, stepGates = false): string {
  const lines = [
    "---",
    `When this step ("${step.id}") is complete, YOU call the \`kstack_advance\` tool with a 2-3 sentence summary of what was accomplished and status "completed". The orchestrator records it under "${phase.id}.${step.id}" and delivers the next step (or closes the phase on the last step).`,
    "If this step needs the user's input (questions, choices, confirmation), ask, then END YOUR TURN and wait for the replies — never call kstack_advance in the same turn you asked something; the step is complete only once the user's answers are folded in.",
  ];
  if (stepGates) {
    lines.push(
      "HUMAN GATE: this run is human-gated — after you call kstack_advance the workflow PAUSES until the user approves this step via /kstack. Present the step's output clearly; do not start the next step yourself.",
    );
  } else if (isLast && manualGates() && phase.advance === "manual") {
    lines.push(
      "This is the LAST step of a DECISION PHASE: after you call kstack_advance, the workflow will pause so the user can review the phase output before the next phase starts. Present results clearly and completely.",
    );
  }
  lines.push('If the step failed, use status "failed" and explain why.');
  return lines.join("\n");
}

/**
 * Orchestrator instructions for ONE step of a stepped phase. Deltas that
 * change between deliveries of the SAME step (retry context after a verdict
 * loop-back, prior-step results, resume notes) are appended at the tail so
 * the stable prefix stays byte-identical (D28).
 */
export function buildStepInstructions(phase: WorkflowPhase, step: WorkflowStep, ctx: WorkflowContext): string {
  const workflow = getWorkflow(ctx.state.workflowId);
  const steps = phase.steps ?? [];
  // Dev-time defect guard: duplicate step ids collide on results["phase.step"]
  // keys and findIndex resolution — fail loudly at delivery, not silently
  // mid-run.
  if (new Set(steps.map((s) => s.id)).size !== steps.length) {
    throw new Error(`phase "${phase.id}" declares duplicate steps[].id values — step ids must be unique`);
  }
  const stepIndex = steps.findIndex((s) => s.id === step.id);
  const idx = stepIndex < 0 ? 0 : stepIndex;
  const parts: string[] = [];

  // System header.
  parts.push(`## [kstack workflow: ${ctx.state.workflowId}] Phase: ${phase.name} — Step ${idx + 1}/${steps.length}: ${step.id}`);
  parts.push(`**Goal:** ${ctx.state.goal}`);
  parts.push(`**Progress:** Phase ${ctx.state.phaseIndex + 1} of ${workflow?.phases.length ?? 0} · step ${idx + 1}/${steps.length}`);
  parts.push(`**Branch:** ${ctx.git.branch}`);
  parts.push("");

  // Phase-level results only — dotted "phase.step" keys belong to the tail.
  const priorPhases = Object.entries(ctx.state.results)
    .filter(([id, r]) => r.status === "completed" && !id.includes("."))
    .map(([id, r]) => `- **${id}**: ${briefSummary(r.summary)}`);
  if (priorPhases.length > 0) {
    parts.push("### Completed phases");
    parts.push(priorPhases.join("\n"));
    parts.push("");
  }

  // Step task. A delegated step under KSTACK_PI_DETERMINISTIC=off gets no
  // chain spawn — the model must call the `subagent` tool itself, so the
  // instructions become delegation guidance carrying the FULL digest inside
  // the task (a bare DoD gate would starve a step executing out-of-context).
  // {previous} interpolates on step.task BEFORE the digest is embedded —
  // doing it after would mangle a literal `{previous}` inside SKILL.md docs.
  if (step.execution === "subagent" && !deterministicSubagents()) {
    const delegatedTask = buildStepTask({ ...step, task: interpolateStepTask(step.task, phase, idx, ctx) });
    parts.push("### Action: Use the `subagent` tool");
    parts.push("");
    parts.push("Call the `subagent` tool with these parameters:");
    parts.push("");
    parts.push("```json");
    parts.push(JSON.stringify({ agent: step.agent ?? "worker", task: delegatedTask }, null, 2));
    parts.push("```");
    parts.push("");
    parts.push("After the subagent completes, review its output and call `kstack_advance` with a summary.");
    parts.push('If the subagent fails, call `kstack_advance` with status "failed" and explain what went wrong.');
  } else {
    parts.push(`### Instructions — step "${step.id}"`);
    parts.push(interpolateStepTask(step.task, phase, idx, ctx));
  }

  // Skill gate (0-or-1, D19).
  const skillBlock = buildStepSkillBlock(step, ctx);
  if (skillBlock) {
    parts.push("");
    parts.push(skillBlock);
  }

  // S4 ambient skills (D25): behavioral digests OUTSIDE the task-skill slot.
  const ambientBlock = buildAmbientSkillBlock(step);
  if (ambientBlock) {
    parts.push("");
    parts.push(ambientBlock);
  }

  // Contract = the step task's own DELIVERABLE/STOP lines. Sprint execution
  // phases carry the master DoD on main steps as well (the chain path
  // appended it to the phase's final output).
  const dod = sprintDodSuffix(ctx.state.workflowId, phase.id);
  if (dod) parts.push(dod.trimStart());
  // An inline step task already carries its own DELIVERABLE/STOP pair —
  // repeating it only re-sends the same tokens on every delivery. The
  // subagent-tool branch buries the task in JSON, so it keeps the contract.
  const taskInline = !(step.execution === "subagent" && !deterministicSubagents());
  if (!taskInline || !/## DELIVERABLE/.test(step.task)) {
    parts.push("");
    parts.push(mainContractFor(phase, ctx, step));
  }

  // Tool contract: the step ends by calling kstack_advance.
  parts.push("");
  parts.push(buildStepAdvancementRule(phase, step, idx === steps.length - 1, ctx.state.stepGates === true));

  // Volatile tail — everything that may change between two deliveries of the
  // same step. Prior-step results first, then retry context, then resume.
  const tail: string[] = [];
  const priorSteps = Object.entries(ctx.state.results)
    .filter(([id, r]) => id.startsWith(phase.id + ".") && r.status === "completed")
    .map(([id, r]) => `- **${id.slice(phase.id.length + 1)}**: ${r.summary}`);
  if (priorSteps.length > 0) {
    tail.push("### Completed steps in this phase");
    tail.push(priorSteps.join("\n"));
  }
  const retry = retryContextBlock(ctx, phase.id);
  if (retry) tail.push(retry);
  if (tail.length > 0) {
    parts.push("");
    parts.push(tail.join("\n\n"));
  }

  return parts.join("\n");
}

/**
 * ADR-23 record contract appended to every deterministic delegated-step task:
 * the child's lifecycle is spawn → work → report → exit, and "report" means
 * the canonical kstack-report record — HANDOFF text alone does NOT satisfy a
 * declared signal. Identity comes from the spawn env ($KSTACK_*), which the
 * executor sets verbatim; a declared signal gets its mandatory flag named.
 * `--root` pins the project that owns .kstack/ — a child that cd'd away
 * would otherwise drop the record where the orchestrator never looks.
 */
export function buildRecordContract(step: WorkflowStep, scope?: { workflowId: string; phase: Pick<WorkflowPhase, "id" | "steps">; cwd?: string }): string {
  const sig = step.signal;
  const owned = scope ? verdictKeysFor(scope.workflowId, scope.phase, step) : sig?.kind === "verdict" ? [sig.value] : [];
  const valuesFor = (key: string): string =>
    (scope ? verdictValuesFor(scope.workflowId, scope.phase.id, key) : []).join("|") || "value";
  const required =
    sig?.kind === "verdict"
      ? ` Your record MUST carry \`--verdict ${sig.value}==<${valuesFor(sig.value)}>\` — the workflow parks when it is missing.`
      : sig?.kind === "marker"
        ? ` Your record MUST carry \`--marker ${sig.value}\` — the workflow parks when it is missing.`
        : sig?.kind === "artifact"
          ? ` The artifact \`${sig.value}\` must exist at the repo root when you exit — the workflow parks when it is missing.`
          : "";
  // Only the flags this step may use are advertised: a step that owns no gate
  // verdict is never offered --verdict (kstack-report drops unowned keys).
  const verdictFlags = owned.map((k) => ` --verdict ${k}==<${valuesFor(k)}>`).join("");
  const ownership = owned.length
    ? ` This step owns ONLY these verdict keys: ${owned.join(", ")} — any other key is discarded.`
    : " This step owns NO gate verdict: do NOT pass --verdict (it would be discarded).";
  // The record must land in the project the orchestrator reads from
  // (<cwd>/.kstack/runs) — a child that cd'd elsewhere would drop it
  // elsewhere and the step would park as signal-missing.
  const root = scope?.cwd ? projectRootFor(scope.cwd) : null;
  const rootFlag = root ? ` --root "${root}"` : "";
  return `## RECORD CONTRACT (canonical)
Before exiting you MUST write your step record exactly once via the kstack-report CLI (its path is in $KSTACK_REPORT):
\`\`\`
"$KSTACK_REPORT" --workflow "$KSTACK_WORKFLOW" --run-id "$KSTACK_RUN_ID" --phase "$KSTACK_PHASE" --step "$KSTACK_STEP"${rootFlag} \\
  --summary '<2-3 sentence outcome>'${verdictFlags} [--var KEY==VALUE]... [--evidence '<finding @ file:line — fix>']... [--marker <text>]... [--deliverable <path>]...
\`\`\`
Quote every value in SINGLE quotes — inside double quotes the shell expands \`$50.00\` to \`0.00\`. An apostrophe inside a value is written \`'\\''\`.
The orchestrator never accepts HANDOFF text as a completion signal — the record is the only channel.${required}${ownership}${owned.length ? " One --evidence per finding: on a negative verdict they are the ONLY feedback the re-run worker receives." : ""}`;
}

/**
 * Routable values for one verdict key: the phase's expected positives plus
 * the negatives that answer them (approved→rejected, green→red|orange, …).
 * Feeds the record-contract hint and the manual advance panel.
 */
export function verdictValuesFor(workflowId: string, phaseId: string, key: string): string[] {
  const exp = expectationsFor(workflowId, phaseId) ?? {};
  const allowed = exp[key] ?? exp[`${key}?`] ?? [];
  const negs = [...NEGATIVE_VALUES].filter((n) => NEGATIVE_FOR[n]?.some((pos) => allowed.includes(pos)));
  return [...allowed, ...negs];
}

/** Positive values each routing negative answers (record-contract hints). */
const NEGATIVE_FOR: Record<string, string[]> = {
  rejected: ["approved"],
  failed: ["success"],
  red: ["green"],
  orange: ["green"],
  fail: ["pass"],
  persists: ["verified"],
  refuted: ["verified"],
};

/**
 * Deterministic-task text for a DELEGATED step: the step's own task plus its
 * FULL skill methodology (delegation always delivers the full digest — the
 * subagent's context is fresh) and the OUTPUT_CONTRACT. Never routes through
 * buildDeterministicPlan — steps are not chains.
 */
export function buildStepTask(step: WorkflowStep): string {
  const stub: WorkflowPhase = { id: step.id, name: step.id, execution: "subagent", optional: false };
  // S4 ambient skills: behavioral digests ride alongside the task's single
  // task-skill — OUTSIDE the 0-1 `skill` slot (D19/D25). Merged into the same
  // METHODOLOGY block; the slot rule governs `skill`, not digest count.
  const ids = [...(step.skill ? [step.skill] : []), ...(step.ambientSkills ?? [])];
  return buildTaskSkills(stub, step.task, ids.length > 0 ? ids : undefined);
}

/**
 * S4 ambient digest block for MAIN steps: `ambientSkills` ids render as
 * full digests (behavioral methodology the worker must actually follow —
 * never degraded to a DoD gate, never occupying `skill`).
 */
function buildAmbientSkillBlock(step: WorkflowStep): string | null {
  const ids = step.ambientSkills ?? [];
  if (!skillsEnabled() || ids.length === 0) return null;
  const blocks: string[] = [];
  for (const id of ids) {
    const digest = loadSkillFull(id);
    if (digest) blocks.push(`#### Ambient skill: ${id}\n${digest}`);
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}
