import type { Workflow } from "./types.ts";
import { allTestsPassed } from "./skip.ts";
import { sprintMaxAttempts, sprintArchMaxAttempts, sprintEnabled } from "./config.ts";

const develop: Workflow = {
  id: "develop",
  name: "Full Development Cycle",
  description: "Understand, plan, implement, QA, review, and ship a feature end-to-end",
  intents: [
    { pattern: /\b(build|implement|develop|create|add)\b.*\b(feature|component|module|page|api|endpoint)\b/i, weight: 0.85 },
    { pattern: /\b(new feature|feature request|let's build|i want to add)\b/i, weight: 0.8 },
    { pattern: /\b(from scratch|greenfield|start a new)\b/i, weight: 0.7 },
  ],
  phases: [
    {
      id: "understand",
      name: "Understand Requirements",
      execution: "main",
      optional: false,
    },
    {
      id: "explore",
      name: "Codebase Exploration",
      execution: "subagent",
      agent: "scout",
      optional: false,
    },
    {
      id: "plan",
      name: "Interactive Planning",
      execution: "main",
      optional: false,
      // Decision phase: interview rounds with the user, then the written
      // plan is reviewed before any code is written.
      advance: "manual",
      skills: ["kstack-office-hours", "kstack-grilling", "kstack-plan-eng-review"],
    },
    {
      id: "implement",
      name: "Implementation",
      execution: "subagent",
      agent: "worker",
      optional: false,
    },
    {
      id: "qa",
      name: "QA Testing",
      execution: "subagent",
      agent: "worker",
      optional: true,
      skills: ["kstack-qa"],
    },
    {
      id: "review",
      name: "Code Review",
      execution: "subagent",
      agent: "reviewer",
      optional: false,
      skills: ["kstack-review"],
    },
    {
      id: "ship",
      name: "Ship (PR + Push)",
      execution: "subagent",
      agent: "worker",
      optional: true,
      skills: ["kstack-ship"],
    },
    {
      id: "document",
      name: "Documentation Update",
      execution: "subagent",
      agent: "worker",
      optional: true,
      skills: ["kstack-document-release", "kstack-document-generate"],
    },
  ],
};

const investigate: Workflow = {
  id: "investigate",
  name: "Bug Investigation",
  description: "Systematic debugging: reproduce, find root cause, fix, and verify",
  intents: [
    { pattern: /\b(debug|fix\s+(this|the)\s+bug|why\s+is\s+.+\s+broken|root\s+cause|investigate)\b/i, weight: 0.9 },
    { pattern: /\b(error|500|stack\s*trace|exception|crash|panic)\b/i, weight: 0.7 },
    { pattern: /\b(it\s+was\s+working|stopped\s+working|broke|regression)\b/i, weight: 0.65 },
    { pattern: /\b(something's wrong|not working|doesn't work|wtf)\b/i, weight: 0.6 },
  ],
  phases: [
    {
      id: "reproduce",
      name: "Reproduce the Bug",
      execution: "main",
      optional: false,
      skills: ["kstack-investigate"],
    },
    {
      id: "root-cause",
      name: "Root Cause Analysis",
      execution: "subagent",
      chain: [
        { agent: "scout", skills: ["kstack-investigate"], task: "## DELIVERABLE\nSuspicious code paths, recent changes (git log), and likely culprits related to the bug — each with file references.\n\n## STOP CONDITION\nStop when: all code plausibly involved in the reported symptom has been identified. Further exploration is waste.\n\n## CONTEXT\nBug: {goal} | Branch: {branch}\nReproduction context: {reproduce_summary}\n\nFind all code related to this bug and report suspicious code paths, recent changes (git log), and likely culprits." },
        { agent: "planner", skills: ["kstack-fix-strategy"], task: "## DELIVERABLE\nRoot cause + minimal fix strategy: mechanism with file:line references, files to change, regression risks.\n\n## STOP CONDITION\nStop when: the root-cause mechanism is pinned to specific file:line locations and the fix strategy follows from it.\n\n## CONTEXT\nBug: {goal} | Branch: {branch}\nInvestigation context from the prior specialist:\n{previous}\n\nGiven this investigation context, identify the root cause and propose a minimal fix strategy. Output: root cause, fix approach, files to change, regression risks." },
      ],
      optional: false,
      skills: ["kstack-investigate"],
      // Decision phase: the user approves the diagnosis before any fix is applied.
      advance: "manual",
    },
    {
      id: "fix",
      name: "Implement Fix",
      execution: "subagent",
      agent: "worker",
      optional: false,
      skills: ["kstack-investigate"],
      // Context fix (2026-08-28 session post-mortem): this phase previously
      // fell back to the generic "fix" task template, whose {findings_summary}
      // placeholder only resolves in the review workflow (which has a phase
      // id "findings"). Here it silently interpolated to "(not yet
      // available)", so the worker ran with zero bug context, audited a green
      // test suite, and fixed nothing. Pin the context explicitly instead.
      task: `## DELIVERABLE
All diagnosed bugs fixed with minimal, targeted changes, suite green, and a regression test per bug per the fix plan.

## STOP CONDITION
Stop when: every bug in the diagnosis is fixed with a regression test and the suite is green.

## CONTEXT
Bug: {goal} | Branch: {branch}
Reproduction context: {reproduce_summary}
Root-cause analysis + fix plan from the prior specialist:
{root-cause_summary}

Apply the planned fixes. Run the tests after each fix. Report what was fixed.`,
    },
    {
      id: "verify",
      name: "Verify Fix",
      execution: "main",
      optional: false,
      skills: ["kstack-investigate"],
    },
    {
      id: "regression-qa",
      name: "Regression QA",
      execution: "subagent",
      agent: "worker",
      optional: true,
      skipWhen: (ctx) => !ctx.git.hasUncommittedChanges,
      skills: ["kstack-qa"],
    },
  ],
};

const qa: Workflow = {
  id: "qa",
  name: "QA Testing",
  description: "Browser-based QA: test user flows, find bugs, capture evidence",
  intents: [
    { pattern: /\b(test the site|qa|does this work|check the deploy|dogfood)\b/i, weight: 0.85 },
    { pattern: /\b(verify|validate|smoke test|e2e|end.to.end)\b/i, weight: 0.7 },
    { pattern: /\b(find bugs|break it|stress test|user flow)\b/i, weight: 0.65 },
  ],
  phases: [
    {
      id: "setup",
      name: "Setup & Scope",
      execution: "main",
      optional: false,
      skills: ["kstack-qa"],
    },
    {
      id: "test",
      name: "Browser Testing",
      execution: "subagent",
      agent: "worker",
      optional: false,
      skills: ["kstack-qa"],
    },
    {
      id: "report",
      name: "Bug Report",
      execution: "main",
      optional: false,
      skills: ["kstack-qa"],
    },
    {
      id: "fix",
      name: "Fix Issues",
      execution: "subagent",
      agent: "worker",
      optional: true,
      // STEP 4d: when the "test" phase already reported all tests passed,
      // the fix loop is structurally skipped (falsifiable, via skip.ts).
      skipWhen: (ctx) => allTestsPassed(ctx.state.results["test"]?.summary),
      skills: ["kstack-qa"],
      // Context fix (2026-08-28 session post-mortem): same class of bug as
      // investigate/fix — the generic "fix" template's {findings_summary}
      // never resolves here (no "findings" phase), so the worker got
      // "(not yet available)" instead of the QA findings. Use {report_summary}.
      task: `## DELIVERABLE
Minimal fixes applied for the QA findings below, tests green, regression coverage for CRITICAL/HIGH findings.

## STOP CONDITION
Stop when: all findings are addressed.

## CONTEXT
Goal: {goal} | Branch: {branch}
QA findings (from the report phase):
{report_summary}

Apply minimal, targeted fixes. Run tests after each fix. Report what was fixed.`,
    },
  ],
};

const ship: Workflow = {
  id: "ship",
  name: "Ship / Release",
  description: "Pre-checks, review, test, push, open PR, verify CI",
  intents: [
    { pattern: /\b(ship|deploy|push|create\s+(a\s+)?pr|open\s+(a\s+)?pr|let's land|send it)\b/i, weight: 0.9 },
    { pattern: /\b(release|cut a release|tag|publish)\b/i, weight: 0.8 },
    { pattern: /\b(merge|land this|ready to go)\b/i, weight: 0.7 },
  ],
  phases: [
    {
      id: "pre-checks",
      name: "Pre-flight Checks",
      execution: "main",
      optional: false,
      skills: ["kstack-ship"],
    },
    {
      id: "review",
      name: "Code Review",
      execution: "subagent",
      agent: "reviewer",
      optional: false,
      skills: ["kstack-review"],
    },
    {
      id: "test",
      name: "Run Tests",
      execution: "subagent",
      agent: "worker",
      optional: false,
      skills: ["kstack-ship"],
    },
    {
      id: "push-pr",
      name: "Push & Open PR",
      execution: "subagent",
      agent: "worker",
      optional: false,
      skills: ["kstack-ship"],
    },
    {
      id: "verify",
      name: "Verify CI",
      execution: "main",
      optional: false,
      skills: ["kstack-ship"],
    },
    {
      id: "update-docs",
      name: "Documentation Update",
      execution: "subagent",
      agent: "worker",
      optional: true,
      skills: ["kstack-document-release", "kstack-document-generate"],
    },
  ],
};

const review: Workflow = {
  id: "review",
  name: "Code Review",
  description: "Structured diff review: findings, suggestions, optional fixes",
  intents: [
    { pattern: /\b(review|check my code|look at (my|the) changes|diff check|pre-landing)\b/i, weight: 0.85 },
    { pattern: /\b(code review|pr review|check the diff)\b/i, weight: 0.8 },
  ],
  phases: [
    {
      id: "diff",
      name: "Diff Analysis",
      execution: "subagent",
      agent: "scout",
      optional: false,
    },
    {
      id: "findings",
      name: "Findings & Suggestions",
      execution: "main",
      optional: false,
      skills: ["kstack-review"],
    },
    {
      id: "fix",
      name: "Apply Fixes",
      execution: "subagent",
      agent: "worker",
      optional: true,
      skills: ["kstack-review"],
    },
  ],
};

const quick: Workflow = {
  id: "quick",
  name: "Quick Action",
  description: "Pick a single action (QA, review, ship, investigate) without the full pipeline",
  intents: [
    { pattern: /\b(quick\s+(qa|review|ship|test|check|debug))\b/i, weight: 0.8 },
  ],
  phases: [
    {
      id: "action",
      name: "Execute Action",
      execution: "main",
      optional: false,
    },
  ],
};

const qaReport: Workflow = {
  id: "qa-report",
  name: "QA Report (No Fixes)",
  description: "Browser QA that tests and reports bugs with severity but never modifies code",
  intents: [
    { pattern: /\b(qa[- ]only|report[- ]only|just report (the )?bugs|don'?t fix,? (just )?test)\b/i, weight: 0.85 },
    { pattern: /\b(test the site and report|find bugs without fixing)\b/i, weight: 0.7 },
  ],
  phases: [
    {
      id: "setup",
      name: "Setup & Scope",
      execution: "main",
      optional: false,
      skills: ["kstack-qa"],
      variant: "report-only",
    },
    {
      id: "test",
      name: "Browser Testing",
      execution: "subagent",
      agent: "worker",
      optional: false,
      skills: ["kstack-qa"],
      variant: "report-only",
    },
    {
      id: "report",
      name: "Bug Report",
      execution: "main",
      optional: false,
      skills: ["kstack-qa"],
      variant: "report-only",
    },
  ],
};

/**
 * Sprint workflow (plan B5): `.agents-clean` agile methodology fused with
 * kstack-pi's deterministic execution. Planning phases stay split (D6);
 * implement is a strict BE→FE chain (D5); review gates carry the loop
 * engine config consumed by state.advancePhase + executor verdict parsing.
 */
const sprint: Workflow = {
  id: "sprint",
  name: "Sprint (Agile Pipeline)",
  description: "Agile sprint: user story, capability, system design, architect gate, backlog, BE→FE implementation, devsecops + QA gates, archive",
  intents: [
    { pattern: /\b(sprint|scrum)\b/i, weight: 0.9 },
    { pattern: /\b(user stor(y|ies)|product backlog|sprint backlog)\b/i, weight: 0.85 },
    { pattern: /\b(agile pipeline|domain-driven design sprint)\b/i, weight: 0.8 },
  ],
  phases: [
    {
      id: "understand",
      name: "Understand Requirements",
      execution: "main",
      optional: false,
      advance: "manual",
    },
    {
      id: "user-story",
      name: "User Story",
      execution: "main",
      optional: false,
      skills: ["kstack-sprint-capability"],
    },
    {
      id: "capability",
      name: "Product Capability",
      execution: "main",
      optional: false,
      skills: ["kstack-sprint-capability"],
    },
    {
      id: "system-design",
      name: "System Design",
      execution: "main",
      optional: false,
      advance: "manual",
      skills: ["kstack-sprint-system-design", "kstack-sprint-adr"],
    },
    {
      id: "architect-gate",
      name: "Architect Review Gate",
      execution: "subagent",
      agent: "software-architect",
      optional: false,
      // Decision phase: the user sees the binary verdict before the backlog.
      advance: "manual",
      skills: ["kstack-sprint-system-design"],
      // REJECTED ⇒ loop back to system-design with the architect's handoff.
      loopBackTo: "system-design",
      maxAttempts: sprintArchMaxAttempts(),
      feedbackFrom: "architect-gate",
    },
    {
      id: "backlog",
      name: "Sprint Backlog",
      execution: "main",
      optional: false,
      advance: "manual",
      skills: ["kstack-sprint-tasks"],
    },
    {
      id: "implement",
      name: "Implement (BE → FE)",
      execution: "subagent",
      chain: [
        {
          agent: "backend-developer",
          skills: ["kstack-sprint-tdd", "kstack-sprint-verification"],
          task: `## DELIVERABLE
Backend implementation of your assigned tasks from tasks_{sprint}.md on a dedicated task/<slug> branch: code + failing-test-first tests green + observability hooks.

## STOP CONDITION
Stop when: every assigned backend task's success condition is demonstrably met and the suite passes.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
Read tasks_{sprint}.md FIRST and claim the backend-role tasks in order. Respect the Ubiquitous Language glossary below — synonym introduction is a review-blocking defect.

{glossary}

Sequential discipline: this phase runs strictly BEFORE the frontend developer; do not touch frontend-owned modules except defined interfaces. Emit ## HANDOFF with branch names, files touched, test evidence.`,
        },
        {
          agent: "frontend-developer",
          skills: ["kstack-sprint-tdd", "kstack-sprint-verification"],
          task: `## DELIVERABLE
Frontend implementation consuming the backend interfaces from tasks_{sprint}.md: code + tests green + UI wired to the agreed contracts.

## STOP CONDITION
Stop when: every assigned frontend task's success condition is demonstrably met and the suite passes.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
The backend specialist's handoff is below — consume its contracts, do not re-implement them. Respect the Ubiquitous Language glossary; synonyms are review-blocking defects.

{glossary}

Emit ## HANDOFF with branch names, files touched, test evidence.`,
        },
      ],
      optional: false,
    },
    {
      id: "devsecops-review",
      name: "DevSecOps Review",
      execution: "subagent",
      chain: [
        {
          agent: "reviewer",
          skills: ["kstack-review"],
          task: `## DELIVERABLE
Adversarial code audit of the sprint diff: findings with severity + file:line + concrete failure scenario, ending with the parseable line 'code-review == approved' or 'code-review == rejected' (also written into devsecops/code-review-artifact_{sprint}.md).

## STOP CONDITION
Stop when: the full diff has been audited and the artifact written.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
Audit the changes produced by the implement chain. Glossary violations are blocking defects.

{glossary}

Write devsecops/code-review-artifact_{sprint}.md ending with EXACTLY ONE of these two lines (your real verdict, nothing else on the line):
- 'code-review == approved'
- 'code-review == rejected'
Repeat the SAME line verbatim in your ## HANDOFF — the orchestrator cross-checks both channels before routing.`,
        },
        {
          agent: "devsecops-reviewer",
          skills: ["kstack-sprint-appsec", "kstack-sprint-docker", "kstack-sprint-pipeline"],
          task: `## DELIVERABLE
Security (+ conditional Docker/CI) audit of the sprint diff: STRIDE-lite pass over new boundaries, actionable remediations, artifacts under devsecops/ ending with parseable verdict lines — 'security-review == approved' or 'security-review == rejected', plus a 'severity ==' line (critical, high, medium or low) when rejecting.

## STOP CONDITION
Stop when: security-review-artifact_{sprint}.md exists with its verdict lines and every finding carries a copy-paste-ready fix.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
The code auditor ran before you ({previous}). Severity discipline: escalate-on-doubt — critical/high freeze the pipeline for human review; medium/low loop back automatically.

Write devsecops/security-review-artifact_{sprint}.md (+ docker-build-report_{sprint}.md ONLY if the repo ships Dockerfiles/compose). Repeat the SAME verdict lines verbatim in your ## HANDOFF — the orchestrator cross-checks both channels.`,
        },
      ],
      optional: false,
      loopBackTo: "implement",
      maxAttempts: sprintMaxAttempts(),
      feedbackFrom: "devsecops-review",
    },
    {
      id: "qa-verdict",
      name: "QA Verdict",
      execution: "subagent",
      agent: "qa-engineer",
      optional: false,
      // Sprint loop discipline: QA reports, developers fix (loop-back engine).
      // Pins beta-qa to its report-only mode — QA holds no commit/fix authority.
      variant: "report-only",
      skills: ["kstack-sprint-qa"],
      loopBackTo: "implement",
      maxAttempts: sprintMaxAttempts(),
      feedbackFrom: "qa-verdict",
    },
    {
      id: "commit-archive",
      name: "Commit & Archive Sprint",
      execution: "subagent",
      agent: "worker",
      optional: false,
      // Hard human gate: nothing lands without the user (D3 residual-risk control).
      advance: "manual",
      skills: ["kstack-ship", "kstack-sprint-verification"],
    },
  ],
};

// KSTACK_PI_SPRINT=off hides the sprint workflow from menu and router entirely
// (kill-switch; every other workflow is unaffected).
const ALL_WORKFLOWS: Workflow[] = [
  ...(sprintEnabled() ? [sprint] : []),
  develop,
  investigate,
  qa,
  qaReport,
  ship,
  review,
  quick,
];

export function getAllWorkflows(): Workflow[] {
  return ALL_WORKFLOWS;
}

export function getWorkflow(id: string): Workflow | undefined {
  return ALL_WORKFLOWS.find((w) => w.id === id);
}

export function getWorkflowIds(): string[] {
  return ALL_WORKFLOWS.map((w) => w.id);
}
