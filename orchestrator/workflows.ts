import type { Workflow } from "./types.ts";
import { sprintMaxAttempts, sprintArchMaxAttempts, sprintEnabled } from "./config.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * S4 canonical catalog — six workflows, all `steps[]` (Kstack/workflow-redesign.md).
 * qa / qa-report / ship / quick were removed by the approved redesign:
 * their real cases live as qa-browsing / ship phases inside the survivors.
 *
 * Conventions:
 * - delegated steps (execution:"subagent") end spawn → work → report → exit;
 *   `signal` names the record completion token the router must observe;
 * - main steps signal via `artifact` (a file exists) or `marker` (the model
 *   writes its own kstack-report record — REC line in the task);
 * - `(opt)` redesign rows map to `enabled:"auto"` + panel override;
 * - `ambientSkills` ids must resolve to skills/<id>/SKILL.md (INV-6) —
 *   ponytail + the AC banks are TASK_09 ports, so ambient banks land there.
 */

/** Standard record-write line for main steps whose signal is a marker. */
const REC = (marker: string) => `On completion, BEFORE calling kstack_advance, write your step record:
\`{kstack_report} --workflow {workflow} --run-id {runId} --phase {phase} --step {step} --marker ${marker} --summary "<1-2 line outcome>"\``;

const develop: Workflow = {
  id: "develop",
  name: "Full Development Cycle",
  description: "Lean intent→merge path: understand, plan, implement, QA, review, document, ship",
  intents: [
    { pattern: /\b(build|implement|develop|create|add)\b.*\b(feature|component|module|page|api|endpoint)\b/i, weight: 0.85 },
    { pattern: /\b(new feature|feature request|let's build|i want to add)\b/i, weight: 0.8 },
    { pattern: /\b(from scratch|greenfield|start a new)\b/i, weight: 0.7 },
  ],
  asks: [
    { var: "scope", question: "Scope of this change?", options: ["mixed", "frontend", "backend"], default: "mixed" },
  ],
  phases: [
    {
      id: "explore",
      name: "Codebase Exploration",
      execution: "main",
      produces: ["explore-notes"],
      steps: [
        {
          id: "scout",
          execution: "subagent",
          agent: "scout",
          prefers: ["graft"], // graft-first in the agent def; rg fallback
          signal: { kind: "marker", value: "SCOUT-DONE" },
          task: `## DELIVERABLE
A codebase orientation brief for the goal: relevant modules, existing patterns to reuse, integration points, and anything that already does part of the work — each with file references.

## STOP CONDITION
Stop when: the planner can act without re-exploring. Map territory; do NOT design or implement.

## CONTEXT
Goal: {goal} | Branch: {branch}

Probe graft-first when available; fall back to ripgrep/ls. Report entry points, conventions, and reuse candidates.`,
        },
      ],
    },
    {
      id: "plan",
      name: "Interactive Planning",
      execution: "main",
      needs: ["explore-notes"],
      produces: ["plan.md"],
      // NO loop by design (fix-forward): only genuine trade-offs survive to
      // the manual gate as UNRESOLVED DECISIONS.
      advance: "manual",
      steps: [
        {
          id: "evolve",
          execution: "main",
          skill: "kstack-idea-refine",
          signal: { kind: "artifact", value: "understand.md" },
          task: `## DELIVERABLE
\`understand.md\` at the repo root — a one-pager: direction, actors, options. This is the "what we decided" doc the rest of the plan builds on.

## STOP CONDITION
Stop when: understand.md exists and captures the raw direction. Do NOT write the plan; do NOT implement.

## CONTEXT
Goal: {goal} | Branch: {branch}
Exploration notes:
{explore_summary}`,
        },
        {
          id: "interrogate",
          execution: "main",
          skill: "kstack-grilling",
          signal: { kind: "marker", value: "INTERROGATE-DONE" },
          task: `## DELIVERABLE
A settled decision frontier appended to understand.md: every open question answered by the user or explicitly folded into a design decision.

## STOP CONDITION
Stop when: the frontier is empty — nothing remains silently assumed. Do NOT write plan.md; drafting is the next step.

## CONTEXT
Goal: {goal} | Branch: {branch}
{open_questions}

Conduct the grilling interview: design-tree rounds over the frontier (max 5 questions per round, only questions that change architecture or scope), YOUR recommended answer under each, then STOP and wait for replies. Never ask for a fact you can look up yourself.

${REC("INTERROGATE-DONE")}`,
        },
        {
          id: "draft",
          execution: "main",
          skill: "kstack-plan-draft",
          signal: { kind: "artifact", value: "plan.md" },
          task: `## DELIVERABLE
\`plan.md\` at the repo root — the engineered plan (8 sections incl. \`## Implementation tasks\` with falsifiable Done-when and \`## Scope\`), built on understand.md. "how we build it".

## STOP CONDITION
Stop when: plan.md exists on disk and covers every settled decision. Do NOT start implementing.

## CONTEXT
Goal: {goal} | Branch: {branch}
Interview outcome:
{previous}

Write the plan to plan.md at the repo root (the ephemeral THINK doc — deleted at run end).
End your kstack_advance summary with the line \`PLAN FILE: plan.md\`.`,
        },
        {
          id: "eng-review",
          execution: "main",
          skill: "kstack-plan-eng-review",
          signal: { kind: "marker", value: "ENG-REVIEW-DONE" },
          task: `## DELIVERABLE
An engineering review of plan.md — correctness, scope discipline, blast radius, testability — annotated in place. Fix-forward: resolve what you can; leave ONLY genuine trade-offs as an \`UNRESOLVED DECISIONS\` line for the gate.

## STOP CONDITION
Stop when: plan.md is reviewed and amended on disk, with UNRESOLVED DECISIONS (if any) visible for the approval gate. Do NOT implement.

## CONTEXT
Goal: {goal} | Branch: {branch}

${REC("ENG-REVIEW-DONE")}`,
        },
        {
          id: "design-review",
          execution: "main",
          skill: "kstack-plan-design-review",
          skipWhen: { var: "scope", equals: "backend" },
          signal: { kind: "marker", value: "DESIGN-REVIEW-DONE" },
          task: `## DELIVERABLE
A design review of plan.md's user-facing surface — IA, flows, states, copy — annotated in place. Self-exit early when the plan touches no UI.

## STOP CONDITION
Stop when: the design pass is done (or self-exited as not-applicable) and plan.md is final for the gate. Do NOT implement.

## CONTEXT
Goal: {goal} | Branch: {branch}

${REC("DESIGN-REVIEW-DONE")}`,
        },
      ],
    },
    {
      id: "implement",
      name: "Implementation",
      execution: "main",
      needs: ["plan.md"],
      produces: ["impl"],
      // Phase-level self-loop: a walkthrough/ui-check failure loops the phase
      // (the walk steps emit the only verdicts; build itself is not flagged).
      loopBackTo: "implement",
      maxAttempts: sprintMaxAttempts(),
      feedbackFrom: "implement",
      steps: [
        {
          id: "build",
          execution: "subagent",
          agent: "worker",
          skill: "kstack-test-driven-development",
          // T09: ambientSkills [ponytail, AC(scope-bank), taste-when-frontend]
          // land when the ports ship (INV-6 — nonexistent ids can't be wired).
          ambientSkills: ["kstack-design-taste-frontend"],
          signal: { kind: "marker", value: "BUILD-DONE" },
          task: `## DELIVERABLE
The plan implemented: code + tests green, matching the plan's Implementation tasks exactly — nothing more, nothing less.

## STOP CONDITION
Stop when: every implementation task's Done-when is demonstrably met and the suite passes.

## CONTEXT
Goal: {goal} | Branch: {branch}
Read plan.md FIRST — it contains the agreed architecture, files to change, edge cases, and test strategy.
{open_questions}

TDD: failing test first, minimal diff, no opportunistic refactoring.`,
        },
        {
          id: "walkthrough",
          execution: "subagent",
          agent: "worker",
          skill: "kstack-lite-mindrun",
          signal: { kind: "verdict", value: "walkthrough" },
          task: `## DELIVERABLE
A mindrun walkthrough of the fresh diff against plan.md: trace each changed path, grade the implementation against the plan's Done-when conditions, and emit the verdict — \`--verdict walkthrough==pass\` or \`--verdict walkthrough==fail\` in your step record with evidence.

## STOP CONDITION
Stop when: every Done-when in plan.md has been traced once. Do NOT fix — judge.

## CONTEXT
Goal: {goal} | Branch: {branch}
The build step just ran ({previous}). Walk the diff as the oracle.`,
        },
        {
          id: "ui-check",
          execution: "subagent",
          agent: "worker",
          skill: "kstack-impeccable",
          skipWhen: { var: "scope", equals: "backend" },
          prefers: ["browse"], // degrade to a static check without a DOM
          signal: { kind: "verdict", value: "ui" },
          task: `## DELIVERABLE
A UI verification pass over the shipped surface: states, flows, copy, responsive behavior — emit \`--verdict ui==pass\` or \`--verdict ui==fail\` in your step record with evidence per finding.

## STOP CONDITION
Stop when: every user-facing change from the diff has been exercised (or statically inspected without browse). Judge, do NOT fix.

## CONTEXT
Goal: {goal} | Branch: {branch}
Walkthrough outcome:
{previous}`,
        },
      ],
    },
    {
      id: "qa-browsing",
      name: "QA Browsing",
      execution: "main",
      needs: ["impl"],
      enabled: "auto", // (opt): engine detects scope, user may force at panel
      autoWhen: (ctx) => ctx.state.vars?.scope !== "backend",
      // status red/orange loops back to implement (verdict-bearing).
      loopBackTo: "implement",
      maxAttempts: sprintMaxAttempts(),
      feedbackFrom: "qa-browsing",
      steps: [
        {
          id: "test",
          execution: "subagent",
          agent: "worker",
          skill: "kstack-qa",
          requires: ["browse"],
          // T09: ambient AC(scope-bank) when the ports land.
          signal: { kind: "verdict", value: "status" },
          task: `## DELIVERABLE
A browser QA pass over the implemented feature as a real user: flows exercised, findings severity-classified, emit \`--verdict status==green\` / \`==orange\` / \`==red\` in your step record plus \`--evidence\` per finding.

## STOP CONDITION
Stop when: every user-facing flow the feature touches has been exercised once. Report, do NOT fix.

## CONTEXT
Goal: {goal} | Branch: {branch}
plan.md describes intended behavior; the diff is the oracle for what shipped.`,
        },
      ],
    },
    {
      id: "review",
      name: "Code Review",
      execution: "main",
      needs: ["impl"],
      // code-review rejected loops back to implement.
      loopBackTo: "implement",
      maxAttempts: sprintMaxAttempts(),
      feedbackFrom: "review",
      steps: [
        {
          id: "review",
          execution: "subagent",
          agent: "reviewer",
          skill: "kstack-review",
          signal: { kind: "verdict", value: "code-review" },
          task: `## DELIVERABLE
An adversarial review of the full diff: findings with severity + file:line + failure scenario, emit \`--verdict code-review==approved\` or \`--verdict code-review==rejected\` in your step record.

## STOP CONDITION
Stop when: the entire diff has been audited. Findings only — do NOT fix.

## CONTEXT
Goal: {goal} | Branch: {branch}
plan.md states intent; the diff is what exists. Scope drift and skipped tests are blocking defects.`,
        },
      ],
    },
    {
      id: "document",
      name: "Documentation Update",
      execution: "main",
      enabled: "auto", // (opt)
      autoWhen: () => true,
      steps: [
        {
          id: "document",
          execution: "subagent",
          agent: "worker",
          skill: "kstack-document",
          signal: { kind: "marker", value: "DOC-DONE" },
          task: `## DELIVERABLE
Docs updated to match the shipped diff: coverage map checked, factual updates applied, stale references swept. Docs land INSIDE the diff (document runs before ship).

## STOP CONDITION
Stop when: user-facing docs reflect the change, or a brief report states none were needed.

## CONTEXT
Goal: {goal} | Branch: {branch}
plan.md + the diff are the oracle; factual updates only, no marketing.`,
        },
      ],
    },
    {
      id: "ship",
      name: "Ship (PR + Push)",
      execution: "main",
      enabled: "auto", // (opt) — the ⚠ entry gate still protects the side effect
      autoWhen: () => true,
      steps: [
        {
          id: "ship",
          execution: "subagent",
          agent: "worker",
          skill: "kstack-ship",
          sideEffect: true,
          signal: { kind: "marker", value: "SHIPPED" },
          task: `## DELIVERABLE
The diff shipped: pre-flight checks, atomic commits, branch pushed, PR opened with a faithful description.

## STOP CONDITION
Stop when: the PR exists and CI is either green or reported pending.

## CONTEXT
Goal: {goal} | Branch: {branch}
Ship discipline: never force-push, never skip the pre-flight checks.`,
        },
      ],
    },
    {
      id: "retro",
      name: "Retro",
      execution: "main",
      enabled: "auto", // (opt) advisory environment-tuning
      autoWhen: () => true,
      steps: [
        {
          id: "retro",
          execution: "main",
          skill: "kstack-retro",
          signal: { kind: "marker", value: "RETRO-DONE" },
          task: `## DELIVERABLE
A short retro on this run: what the process got right, what it missed, one environment/skill improvement worth making.

## STOP CONDITION
Stop when: findings are on the record. Advisory only — do NOT start new work.

## CONTEXT
Goal: {goal} | Branch: {branch}

${REC("RETRO-DONE")}`,
        },
      ],
    },
  ],
};

const investigate: Workflow = {
  id: "investigate",
  name: "Bug Investigation",
  description: "Production hotfix: reproduce, confirm root cause, minimal fix, verify",
  intents: [
    { pattern: /\b(debug|fix\s+(this|the)\s+bug|why\s+is\s+.+\s+broken|root\s+cause|investigate)\b/i, weight: 0.9 },
    { pattern: /\b(error|500|stack\s*trace|exception|crash|panic)\b/i, weight: 0.7 },
    { pattern: /\b(it\s+was\s+working|stopped\s+working|broke|regression)\b/i, weight: 0.65 },
    { pattern: /\b(something's wrong|not working|doesn't work|wtf)\b/i, weight: 0.6 },
  ],
  phases: [
    {
      id: "explore",
      name: "Codebase Exploration",
      execution: "main",
      produces: ["explore-notes"],
      steps: [
        {
          id: "scout",
          execution: "subagent",
          agent: "scout",
          prefers: ["graft"],
          signal: { kind: "marker", value: "SCOUT-DONE" },
          task: `## DELIVERABLE
An orientation brief around the reported symptom: suspicious code paths, recent changes (git log), likely culprits — each with file references.

## STOP CONDITION
Stop when: all code plausibly involved in the symptom is mapped. Further exploration is waste.

## CONTEXT
Bug: {goal} | Branch: {branch}

Probe graft-first when available; fall back to ripgrep.`,
        },
      ],
    },
    {
      id: "reproduce",
      name: "Reproduce the Bug",
      execution: "main",
      needs: ["explore-notes"],
      produces: ["bug-report.md"],
      steps: [
        {
          id: "triage",
          execution: "main",
          skill: "kstack-triage",
          signal: { kind: "artifact", value: "bug-report.md" },
          task: `## DELIVERABLE
\`bug-report.md\` at the repo root — diagnostic intake: expected vs actual, repro hints, environment, and an explicit \`## Ruled out\` section.

## STOP CONDITION
Stop when: bug-report.md exists with a Ruled out section. One question at a time — each answer cuts branches; do NOT fix.

## CONTEXT
Bug: {goal} | Branch: {branch}
Exploration notes:
{explore_summary}`,
        },
        {
          id: "repro",
          execution: "main",
          skill: "kstack-investigate",
          signal: { kind: "marker", value: "REPRO-DONE" },
          task: `## DELIVERABLE
A FAILING test that reproduces the bug — the checkpoint and future regression guard. Append the repro path + command to bug-report.md.

## STOP CONDITION
Stop when: the failing test exists and fails for the reported reason. If the bug genuinely cannot be reproduced here, call kstack_advance with status "failed" and say why — the workflow parks for a human, never guesses.

## CONTEXT
Bug: {goal} | Branch: {branch}
Triage intake:
{previous}

${REC("REPRO-DONE")}`,
        },
      ],
    },
    {
      id: "root-cause",
      name: "Root Cause Analysis",
      execution: "main",
      needs: ["bug-report.md"],
      produces: ["root-cause"],
      // Decision phase: the user approves the confirmed diagnosis before any fix.
      advance: "manual",
      steps: [
        {
          id: "trace",
          execution: "main",
          skill: "kstack-investigate",
          signal: { kind: "marker", value: "TRACE-DONE" },
          task: `## DELIVERABLE
A hypothesis→experiment trace against bug-report.md: candidate mechanisms, what each experiment ruled in/out — appended to bug-report.md.

## STOP CONDITION
Stop when: the hypothesis space is exhausted to one surviving mechanism (or the trace shows none fits — say so honestly). Do NOT fix.

## CONTEXT
Bug: {goal} | Branch: {branch}

${REC("TRACE-DONE")}`,
        },
        {
          id: "validate",
          execution: "main",
          skill: "kstack-investigate",
          signal: { kind: "marker", value: "RCA-CONFIRMED" },
          task: `## DELIVERABLE
A CONFIRMATORY experiment proving the surviving hypothesis IS the cause (hypothesis ≠ cause until proven) — the RCA result appended to bug-report.md for the approval gate.

## STOP CONDITION
Stop when: the root cause is confirmed with evidence, or explicitly reported unconfirmed. Iron Law: no fix without a confirmed root cause.

## CONTEXT
Bug: {goal} | Branch: {branch}
Trace outcome:
{previous}

${REC("RCA-CONFIRMED")}`,
        },
      ],
    },
    {
      id: "fix",
      name: "Minimal Fix",
      execution: "main",
      needs: ["root-cause"],
      produces: ["fix"],
      steps: [
        {
          id: "patch",
          execution: "subagent",
          agent: "worker",
          skill: "kstack-test-driven-development",
          signal: { kind: "marker", value: "PATCH-DONE" },
          task: `## DELIVERABLE
The minimal patch for the CONFIRMED root cause: the failing repro test now green, no refactoring, minimal blast radius — production hotfix discipline.

## STOP CONDITION
Stop when: the repro test passes and the suite is green.

## CONTEXT
Bug: {goal} | Branch: {branch}
Confirmed root cause + reproduction (bug-report.md):
{root-cause_summary}

Patch the cause, not the symptom. No opportunistic refactors.`,
        },
      ],
    },
    {
      id: "verify",
      name: "Verify Fix",
      execution: "main",
      needs: ["fix"],
      // First real multi-target loopBackOn: persists→fix, refuted→root-cause.
      loopBackOn: { persists: "fix", refuted: "root-cause" },
      maxAttempts: sprintMaxAttempts(),
      feedbackFrom: "verify",
      steps: [
        {
          id: "verify",
          execution: "subagent",
          agent: "worker",
          skill: "kstack-lite-mindrun",
          signal: { kind: "verdict", value: "outcome" },
          task: `## DELIVERABLE
Trace the fix against the confirmed cause: does the mechanism actually hold? Emit \`--verdict outcome==verified\` (fix holds), \`==persists\` (bug still reproduces → back to fix), or \`==refuted\` (the diagnosis was wrong → back to root-cause) in your step record with evidence.

## STOP CONDITION
Stop when: the repro + the surrounding call paths have been traced once against the diff. Judge, do NOT fix.

## CONTEXT
Bug: {goal} | Branch: {branch}
bug-report.md names the cause; the patch diff is the claim under test.`,
        },
      ],
    },
    {
      id: "regression-qa",
      name: "Regression QA",
      execution: "main",
      needs: ["fix"],
      enabled: "auto", // browse if the fix touched UI; suite coverage may auto-skip
      autoWhen: (ctx) => ctx.git.hasUncommittedChanges,
      loopBackTo: "fix",
      maxAttempts: sprintMaxAttempts(),
      feedbackFrom: "regression-qa",
      steps: [
        {
          id: "test",
          execution: "subagent",
          agent: "worker",
          skill: "kstack-qa",
          requires: ["browse"],
          signal: { kind: "verdict", value: "status" },
          task: `## DELIVERABLE
A browser regression pass around the fix's blast radius: adjacent flows exercised, emit \`--verdict status==green\` / \`==orange\` / \`==red\` in your step record plus \`--evidence\` per finding.

## STOP CONDITION
Stop when: the flows the fix could have touched are exercised once. Report, do NOT fix.

## CONTEXT
Bug: {goal} | Branch: {branch}
The fix diff is the blast radius; bug-report.md names the original symptom.`,
        },
      ],
    },
    {
      id: "retro",
      name: "Retro",
      execution: "main",
      enabled: "auto", // a prod bug is an environment flaw — read it as a symptom
      autoWhen: () => true,
      steps: [
        {
          id: "retro",
          execution: "main",
          skill: "kstack-retro",
          signal: { kind: "marker", value: "RETRO-DONE" },
          task: `## DELIVERABLE
A short retro: how did this bug reach production — which check was missing — and one process/skill improvement worth making.

## STOP CONDITION
Stop when: findings are on the record. Advisory only — do NOT start new work.

## CONTEXT
Bug: {goal} | Branch: {branch}
bug-report.md is the case file.

${REC("RETRO-DONE")}`,
        },
      ],
    },
  ],
};

const review: Workflow = {
  id: "review",
  name: "Code Review",
  description: "Evaluate code not produced by a run — external PRs, own diffs, dirty worktree",
  intents: [
    { pattern: /\b(review|check my code|look at (my|the) changes|diff check|pre-landing)\b/i, weight: 0.85 },
    { pattern: /\b(code review|pr review|check the diff)\b/i, weight: 0.8 },
  ],
  asks: [
    { var: "target", question: "What is being reviewed?", options: ["external", "own"], default: "external" },
  ],
  phases: [
    {
      id: "explore",
      name: "Codebase Exploration",
      execution: "main",
      produces: ["explore-notes"],
      steps: [
        {
          id: "scout",
          execution: "subagent",
          agent: "scout",
          prefers: ["graft"],
          signal: { kind: "marker", value: "SCOUT-DONE" },
          task: `## DELIVERABLE
A blast-radius brief for the diff under review: callers of touched symbols (graft callers), adjacent modules, contracts the diff relies on.

## STOP CONDITION
Stop when: the reviewer can judge the diff without re-exploring.

## CONTEXT
Review target: {goal} | Branch: {branch}

Probe graft-first when available; fall back to ripgrep.`,
        },
      ],
    },
    {
      id: "diff",
      name: "Resolve Diff",
      execution: "main",
      needs: ["explore-notes"],
      produces: ["diff"],
      steps: [
        {
          id: "resolve",
          execution: "main",
          signal: { kind: "marker", value: "DIFF-RESOLVED" },
          task: `## DELIVERABLE
The review material: the concrete diff resolved from whatever the user gave — PR number, branch, range, or the dirty worktree — stated plainly with its base.

## STOP CONDITION
Stop when: the exact diff under review is materialized and named. Mechanical step — do NOT review it.

## CONTEXT
Goal: {goal} | Branch: {branch}
Exploration notes:
{explore_summary}

${REC("DIFF-RESOLVED")}`,
        },
      ],
    },
    {
      id: "findings",
      name: "Findings & Suggestions",
      execution: "main",
      needs: ["diff"],
      produces: ["findings"],
      // PUBLISH-ONLY (ADR-24): no loop edge — the parsed verdict lands in
      // lastVerdicts["findings"] and the phase always advances.
      steps: [
        {
          id: "review",
          execution: "subagent",
          agent: "reviewer",
          skill: "kstack-review",
          signal: { kind: "verdict", value: "code-review" },
          task: `## DELIVERABLE
A severity-classified review of the diff: findings with file:line + failure scenario, emit \`--verdict code-review==approved\` or \`--verdict code-review==rejected\` in your step record.

## STOP CONDITION
Stop when: the whole diff has been audited. Publish the verdict — judgment only, do NOT fix.

## CONTEXT
Goal: {goal} | Branch: {branch}
The resolved diff from the previous step is the subject.`,
        },
      ],
    },
    {
      id: "qa-browsing",
      name: "QA Browsing",
      execution: "main",
      needs: ["diff"],
      enabled: "auto", // browse if the diff touches UI
      autoWhen: () => true,
      // Publish-only status → lastVerdicts["qa-browsing"], consumed by fix.autoWhen.
      steps: [
        {
          id: "test",
          execution: "subagent",
          agent: "worker",
          skill: "kstack-qa",
          requires: ["browse"],
          signal: { kind: "verdict", value: "status" },
          task: `## DELIVERABLE
A browser pass over the diff's user-facing surface: emit \`--verdict status==green\` / \`==orange\` / \`==red\` in your step record plus \`--evidence\` per finding.

## STOP CONDITION
Stop when: the changed flows have been exercised once. Report, do NOT fix.

## CONTEXT
Goal: {goal} | Branch: {branch}
The resolved diff names what changed.`,
        },
      ],
    },
    {
      id: "comment",
      name: "Post Review Comment",
      execution: "main",
      needs: ["findings"],
      steps: [
        {
          id: "post",
          execution: "main",
          skill: "kstack-review-comment",
          skipWhen: { var: "target", equals: "own" },
          requires: ["gh"],
          // ⚠ side effect: `gh pr review` publishes — never without confirmation.
          sideEffect: true,
          signal: { kind: "marker", value: "POSTED" },
          task: `## DELIVERABLE
The review posted to the external PR via \`gh\`: findings re-classified (doubt→question), anatomized what/why/how + file:line, single batched review.

## STOP CONDITION
Stop when: the review is posted (or reported why posting was impossible). Fail closed — never fake a post.

## CONTEXT
Goal: {goal} | Branch: {branch}
Findings verdict:
{findings_summary}

${REC("POSTED")}`,
        },
      ],
    },
    {
      id: "fix",
      name: "Apply Fixes",
      execution: "main",
      needs: ["findings"],
      // autoWhen re-evaluates at ARRIVAL: lastVerdicts populate mid-run, so a
      // red UI verdict on approved code still gets fixed (ADR-24).
      enabled: "auto",
      autoWhen: (ctx) =>
        ctx.state.vars?.target !== "external" &&
        (ctx.state.lastVerdicts?.["findings"]?.["code-review"] !== "approved" ||
          ctx.state.lastVerdicts?.["qa-browsing"]?.["status"] === "red"),
      // onComplete → findings: re-review the patched diff (bounded by the
      // findings ceiling), fires only on "completed" (INV-16).
      onComplete: "findings",
      maxAttempts: sprintMaxAttempts(),
      steps: [
        {
          id: "patch",
          execution: "subagent",
          agent: "worker",
          skill: "kstack-test-driven-development",
          skipWhen: { var: "target", equals: "external" },
          signal: { kind: "marker", value: "PATCH-DONE" },
          task: `## DELIVERABLE
Minimal patches for the findings: each blocking finding fixed, tests green, no opportunistic refactors.

## STOP CONDITION
Stop when: every blocking finding is addressed and the suite is green.

## CONTEXT
Goal: {goal} | Branch: {branch}
Review findings:
{findings_summary}`,
        },
      ],
    },
    {
      id: "retro",
      name: "Retro",
      execution: "main",
      enabled: "auto",
      autoWhen: () => true,
      steps: [
        {
          id: "retro",
          execution: "main",
          skill: "kstack-retro",
          signal: { kind: "marker", value: "RETRO-DONE" },
          task: `## DELIVERABLE
A short retro on this review run: signal quality, missed classes, one improvement.

## STOP CONDITION
Stop when: findings are on the record. Advisory only.

## CONTEXT
Goal: {goal} | Branch: {branch}

${REC("RETRO-DONE")}`,
        },
      ],
    },
  ],
};

const discover: Workflow = {
  id: "discover",
  name: "Product Discovery",
  description: "Office-hours session: improve the product when you don't know what yet",
  intents: [
    { pattern: /\b(office[- ]hours|product (discovery|direction)|what should (i|we) build|improve the product)\b/i, weight: 0.85 },
    { pattern: /\b(explore ideas|brainstorm product|find the wedge)\b/i, weight: 0.7 },
  ],
  phases: [
    {
      id: "session",
      name: "Office Hours Session",
      execution: "main",
      steps: [
        {
          id: "session",
          execution: "main",
          skill: "kstack-office-hours",
          // Cross-run handoff (NOT ephemeral): .kstack/discover/ outlives the
          // run — a later develop.evolve reads it instead of a raw idea.
          signal: { kind: "artifact", value: ".kstack/discover/direction.md" },
          task: `## DELIVERABLE
\`.kstack/discover/direction.md\` — the sharpened direction from the session (durable handoff artifact, never ephemeral).

## STOP CONDITION
Stop when: direction.md exists and names a direction concrete enough to seed a develop run. Conversation, not code.

## CONTEXT
Goal: {goal} | Branch: {branch}`,
        },
      ],
    },
  ],
};

const audit: Workflow = {
  id: "audit",
  name: "Codebase Audit",
  description: "Structured codebase re-read: incremental findings file, resume-safe, hands off to investigate",
  intents: [
    { pattern: /\b(audit|code audit|re-?read the codebase|architecture audit|review the whole (repo|codebase))\b/i, weight: 0.85 },
    { pattern: /\b(technical debt|health check|code quality scan)\b/i, weight: 0.7 },
  ],
  phases: [
    {
      id: "walk",
      name: "Structured Walk",
      execution: "main",
      steps: [
        {
          id: "walk",
          execution: "main",
          skill: "kstack-mindrun",
          // Cross-run handoff: each finding can become an investigate run;
          // written incrementally = real resume on a long walk.
          signal: { kind: "artifact", value: ".kstack/audit/findings.md" },
          task: `## DELIVERABLE
\`.kstack/audit/findings.md\` written INCREMENTALLY during the walk — every finding appended as discovered (progress checkpoint + handoff queue).

## STOP CONDITION
Stop when: the structured walk is complete and findings.md holds the full set. Detect, do NOT fix.

## CONTEXT
Goal: {goal} | Branch: {branch}
Interrupted walks resume from findings.md — dedup-check before appending.`,
        },
      ],
    },
  ],
};

/**
 * Sprint workflow (plan B5 + S4 redesign): durable artifacts are the project's
 * backbone — only system-design_XX.md and ADR-log_XX.md survive at run end;
 * ephemerals (understand/user-story/capability/tasks/summary_*) die at
 * terminal status. Verifiers write NO files — findings go in --evidence.
 */
const sprint: Workflow = {
  id: "sprint",
  name: "Sprint (Agile Pipeline)",
  description: "Agile sprint: story, capability, design, architect gate, backlog, implement, QA + devsecops gates, archive",
  intents: [
    { pattern: /\b(sprint|scrum)\b/i, weight: 0.9 },
    { pattern: /\b(user stor(y|ies)|product backlog|sprint backlog)\b/i, weight: 0.85 },
    { pattern: /\b(agile pipeline|domain-driven design sprint)\b/i, weight: 0.8 },
  ],
  asks: [
    { var: "scope", question: "Sprint scope?", options: ["mixed", "frontend", "backend"], default: "mixed" },
    { var: "parallel", question: "Run BE and FE lanes in parallel?", options: ["no", "yes"], default: "no", when: { var: "scope", equals: "mixed" } },
  ],
  phases: [
    {
      id: "explore",
      name: "Codebase Exploration",
      execution: "main",
      produces: ["explore-notes"],
      steps: [
        {
          id: "scout",
          execution: "subagent",
          agent: "scout",
          prefers: ["graft"],
          signal: { kind: "marker", value: "SCOUT-DONE" },
          task: `## DELIVERABLE
A codebase orientation brief for the sprint goal: domain seams, reuse candidates, integration points — with file references.

## STOP CONDITION
Stop when: the planning phases can act without re-exploring.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}

Probe graft-first when available; fall back to ripgrep.`,
        },
      ],
    },
    {
      id: "understand",
      name: "Understand Requirements",
      execution: "main",
      needs: ["explore-notes"],
      produces: ["understand.md"],
      advance: "manual",
      steps: [
        {
          id: "evolve",
          execution: "main",
          skill: "kstack-idea-refine",
          signal: { kind: "artifact", value: "understand.md" },
          task: `## DELIVERABLE
\`understand.md\` at the repo root — the raw direction one-pager for this sprint (ephemeral; interrogate appends to it).

## STOP CONDITION
Stop when: understand.md exists and captures direction + actors + options.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
Exploration notes:
{explore_summary}`,
        },
        {
          id: "interrogate",
          execution: "main",
          skill: "kstack-grilling",
          signal: { kind: "marker", value: "INTERROGATE-DONE" },
          task: `## DELIVERABLE
A settled decision frontier appended to understand.md — every open question answered or folded into a decision.

## STOP CONDITION
Stop when: the frontier is empty. Do NOT draft stories or plans yet.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
{open_questions}

Design-tree rounds over the frontier (max 5 questions per round), recommended answer under each, then STOP and wait.

${REC("INTERROGATE-DONE")}`,
        },
      ],
    },
    {
      id: "user-story",
      name: "User Story",
      execution: "main",
      needs: ["understand.md"],
      produces: ["user-story.md"],
      steps: [
        {
          id: "story",
          execution: "main",
          skill: "kstack-product-capability",
          signal: { kind: "artifact", value: "user-story.md" },
          task: `## DELIVERABLE
\`user-story.md\` at the repo root — the sprint's user story with falsifiable acceptance criteria (the skill's DoD).

## STOP CONDITION
Stop when: user-story.md exists with boolean-checkable ACs.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
Direction:
{understand_summary}`,
        },
      ],
    },
    {
      id: "capability",
      name: "Product Capability",
      execution: "main",
      needs: ["user-story.md"],
      produces: ["capability.md"],
      steps: [
        {
          id: "constraints",
          execution: "main",
          skill: "kstack-product-capability",
          signal: { kind: "artifact", value: "capability.md" },
          task: `## DELIVERABLE
\`capability.md\` at the repo root — story translated to engineering constraints: boolean-checkable invariants, non-goals, and ENUMERATED TRUST BOUNDARIES (the risk-scan's input).

## STOP CONDITION
Stop when: capability.md exists with invariants + trust boundaries.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
User story:
{user-story_summary}`,
        },
      ],
    },
    {
      id: "system-design",
      name: "System Design",
      execution: "main",
      needs: ["capability.md"],
      produces: ["system-design", "adr-log"],
      // Durable artifacts (system-design_XX, ADR-log_XX) are the project's
      // long-term decision memory — the only files surviving the run.
      advance: "manual",
      steps: [
        {
          id: "design",
          execution: "main",
          skill: "kstack-system-design",
          signal: { kind: "marker", value: "DESIGN-DONE" },
          task: `## DELIVERABLE
\`system-design_{sprint}.md\` — the DDD design doc: ubiquitous-language glossary, aggregates with boolean invariants, context mapping, immutable contracts.

## STOP CONDITION
Stop when: the design doc exists and every capability.md invariant has a home. Glossary violations downstream are blocking defects.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
Capability constraints + trust boundaries:
{capability_summary}

${REC("DESIGN-DONE")}`,
        },
        {
          id: "risk-scan",
          execution: "main",
          skill: "kstack-risk-scan",
          signal: { kind: "marker", value: "RISK-SCAN-DONE" },
          task: `## DELIVERABLE
A STRIDE-lite risk pass over system-design_{sprint}.md using the trust boundaries enumerated in capability.md: each boundary rated, fixable issues corrected IN SESSION, unresolvable ones carried as an open decision to the gate.

## STOP CONDITION
Stop when: every declared boundary has been rated once. No verdict — findings and fixes land in the docs.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
Design under scan:
{previous}

${REC("RISK-SCAN-DONE")}`,
        },
        {
          id: "adr",
          execution: "main",
          skill: "kstack-adr",
          signal: { kind: "marker", value: "ADR-DONE" },
          task: `## DELIVERABLE
\`ADR-log_{sprint}.md\` appended — every significant decision from design + risk-scan in decision/context/consequences form (append-only).

## STOP CONDITION
Stop when: the ADR log covers the decisions this design made. Do NOT re-litigate them.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}

${REC("ADR-DONE")}`,
        },
      ],
    },
    {
      id: "architect-gate",
      name: "Architect Review Gate",
      execution: "main",
      needs: ["system-design"],
      // Bounded loop to system-design; approved still lands at the manual gate.
      advance: "manual",
      loopBackTo: "system-design",
      maxAttempts: sprintArchMaxAttempts(),
      feedbackFrom: "architect-gate",
      steps: [
        {
          id: "review",
          execution: "subagent",
          agent: "software-architect",
          skill: "kstack-system-design",
          signal: { kind: "verdict", value: "software-architect-review" },
          task: `## DELIVERABLE
A principal-architect review of system-design_{sprint}.md: invariants, boundaries, contracts — emit \`--verdict software-architect-review==approved\` or \`==rejected\` in your step record with evidence per finding.

## STOP CONDITION
Stop when: the design has been audited once end to end. Judge, do NOT redesign.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
Review system-design_{sprint}.md against capability.md's constraints — a rejected verdict loops the design phase (bounded).`,
        },
      ],
    },
    {
      id: "backlog",
      name: "Sprint Backlog",
      execution: "main",
      needs: ["system-design"],
      produces: ["tasks.md"],
      advance: "manual",
      steps: [
        {
          id: "tasks",
          execution: "main",
          skill: "kstack-tasks",
          // T09: ambient AC(scope-bank) when the ports land.
          signal: { kind: "marker", value: "TASKS-DONE" },
          task: `## DELIVERABLE
\`tasks.md\` at the repo root — the atomic task backlog: inputs/payloads/constraints/unhappy-paths/falsifiable success conditions, role-assigned (backend|frontend) with dependencies. In-scope tasks only; required-but-out-of-scope tasks marked \`~out-of-scope\`.

## STOP CONDITION
Stop when: tasks.md exists and every user-story AC has a task. Emit \`--var parallel-safe==true\` or \`==false\` in your record — true only when the lanes have zero cross-role dependencies AND disjoint file sets.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
Design + constraints:
{system-design_summary}

${REC("TASKS-DONE")}`,
        },
      ],
    },
    {
      id: "implement",
      name: "Implement (BE → FE)",
      execution: "main",
      needs: ["tasks.md"],
      produces: ["impl"],
      // Phase-level self-loop: a walkthrough/ui-check failure re-enters the
      // phase. Sequential lanes today — the ∥ option (vars.scope==mixed ∧
      // vars.parallel==yes ∧ vars.parallel-safe==true, INV-14) needs the lane
      // dispatcher; wired when it ships.
      loopBackTo: "implement",
      maxAttempts: sprintMaxAttempts(),
      feedbackFrom: "implement",
      steps: [
        {
          id: "backend",
          execution: "subagent",
          agent: "backend-developer",
          skill: "kstack-test-driven-development",
          skipWhen: { var: "scope", equals: "frontend" },
          // T09: ambient [ponytail, AC-BE] when the ports land.
          signal: { kind: "marker", value: "BACKEND-DONE" },
          task: `## DELIVERABLE
Backend implementation of the backend-role tasks in tasks.md on a dedicated task/<slug> branch: code + failing-test-first tests green + observability hooks. Emits summary_BE.md.

## STOP CONDITION
Stop when: every assigned backend task's success condition is demonstrably met and the suite passes.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
Read tasks.md FIRST and claim backend tasks in order. Respect the ubiquitous-language glossary — synonym introduction is a review-blocking defect. Do not touch frontend-owned modules except defined interfaces.`,
        },
        {
          id: "be-walk",
          execution: "subagent",
          agent: "backend-developer",
          skill: "kstack-lite-mindrun",
          skipWhen: { var: "scope", equals: "frontend" },
          // Per-lane verdict var: two walkers sharing one `walkthrough` var
          // would contradict-merge on any be-fail+fe-pass and park every run.
          signal: { kind: "verdict", value: "be-walk" },
          task: `## DELIVERABLE
A mindrun walkthrough of the BACKEND diff against tasks.md: trace each backend task's Done-when, emit \`--verdict be-walk==pass\` or \`--verdict be-walk==fail\` in your step record with evidence.

## STOP CONDITION
Stop when: every backend task in tasks.md has been traced once. Judge, do NOT fix.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
The backend step just ran ({previous}); the diff is the oracle.`,
        },
        {
          id: "frontend",
          execution: "subagent",
          agent: "frontend-developer",
          skill: "kstack-test-driven-development",
          skipWhen: { var: "scope", equals: "backend" },
          // T09: ambient [ponytail, AC-FE, design-taste] when the ports land.
          ambientSkills: ["kstack-design-taste-frontend"],
          signal: { kind: "marker", value: "FRONTEND-DONE" },
          task: `## DELIVERABLE
Frontend implementation consuming the backend interfaces from tasks.md: code + tests green + UI wired to the agreed contracts. Emits summary_FE.md.

## STOP CONDITION
Stop when: every assigned frontend task's success condition is demonstrably met and the suite passes.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
The backend handoff ({previous}) carries contracts — consume, do not re-implement. Glossary synonyms are review-blocking defects.`,
        },
        {
          id: "fe-walk",
          execution: "subagent",
          agent: "frontend-developer",
          skill: "kstack-lite-mindrun",
          skipWhen: { var: "scope", equals: "backend" },
          signal: { kind: "verdict", value: "fe-walk" },
          task: `## DELIVERABLE
A mindrun walkthrough of the FRONTEND diff against tasks.md: trace each frontend task's Done-when, emit \`--verdict fe-walk==pass\` or \`--verdict fe-walk==fail\` in your step record with evidence.

## STOP CONDITION
Stop when: every frontend task in tasks.md has been traced once. Judge, do NOT fix.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
The frontend step just ran ({previous}); the diff is the oracle.`,
        },
        {
          id: "ui-check",
          execution: "subagent",
          agent: "frontend-developer",
          skill: "kstack-impeccable",
          skipWhen: { var: "scope", equals: "backend" },
          prefers: ["browse"],
          signal: { kind: "verdict", value: "ui" },
          task: `## DELIVERABLE
A UI verification pass over the shipped frontend surface: states, flows, copy — emit \`--verdict ui==pass\` or \`--verdict ui==fail\` in your step record with evidence per finding.

## STOP CONDITION
Stop when: every user-facing task from tasks.md has been exercised (or statically inspected without browse). Judge, do NOT fix.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
Frontend walkthrough outcome:
{previous}`,
        },
      ],
    },
    {
      id: "qa-browsing",
      name: "QA Browsing",
      execution: "main",
      needs: ["impl"],
      // status orange/red loops back to implement (before devsecops — cheap
      // checks near the producer, expensive once downstream).
      loopBackTo: "implement",
      maxAttempts: sprintMaxAttempts(),
      feedbackFrom: "qa-browsing",
      steps: [
        {
          id: "test",
          execution: "subagent",
          agent: "qa-engineer",
          skill: "kstack-qa",
          requires: ["browse"],
          // T09: ambient AC(scope-bank) when the ports land.
          signal: { kind: "verdict", value: "status" },
          task: `## DELIVERABLE
A browser QA pass over the sprint diff as a real user: ACs exercised, findings severity-classified, emit \`--verdict status==green\` / \`==orange\` / \`==red\` in your step record plus \`--evidence\` per finding. NO files — findings live in the record.

## STOP CONDITION
Stop when: every user-facing AC from user-story.md has been exercised once. Report, do NOT fix.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
tasks.md names what shipped; user-story.md names what was promised.`,
        },
      ],
    },
    {
      id: "devsecops-review",
      name: "DevSecOps Review",
      execution: "main",
      needs: ["impl"],
      // Dual verdicts → implement; severity==red|critical|high freezes for the
      // human (typed-unfreeze panel), parkOn evaluated before any edge.
      loopBackTo: "implement",
      parkOn: { critical: "freeze", high: "freeze", red: "freeze" },
      maxAttempts: sprintMaxAttempts(),
      feedbackFrom: "devsecops-review",
      steps: [
        {
          id: "code-review",
          execution: "subagent",
          agent: "devsecops-reviewer",
          skill: "kstack-review",
          signal: { kind: "verdict", value: "code-review" },
          task: `## DELIVERABLE
Adversarial code audit of the sprint diff: findings with severity + file:line + concrete failure scenario, emit \`--verdict code-review==approved\` or \`==rejected\` in your step record. NO artifact files — findings go in --evidence.

## STOP CONDITION
Stop when: the full diff has been audited once. Glossary violations are blocking defects.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
Audit what implement shipped against plan/design intent.`,
        },
        {
          id: "security",
          execution: "subagent",
          agent: "devsecops-reviewer",
          skill: "kstack-cso",
          signal: { kind: "verdict", value: "security-review" },
          task: `## DELIVERABLE
Security audit of the sprint diff: STRIDE-lite over new trust boundaries from capability.md, secrets hygiene, injection prevention — emit \`--verdict security-review==approved\` or \`==rejected\` PLUS \`--verdict severity==<critical|high|medium|low|red|orange|green>\` on rejection in your step record. Findings in --evidence.

## STOP CONDITION
Stop when: every new boundary has been rated and each finding carries a copy-paste-ready fix. Escalate-on-doubt — critical/high/red freeze the pipeline for human review; medium/low loop back automatically.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}
Code audit ran before you ({previous}); capability.md enumerates the trust boundaries.`,
        },
      ],
    },
    {
      id: "docker-review",
      name: "Docker Review",
      execution: "main",
      needs: ["impl"],
      enabled: "auto", // Dockerfile present (touched can't be computed synchronously)
      autoWhen: (ctx) => existsSync(join(ctx.cwd, "Dockerfile")) || existsSync(join(ctx.cwd, "docker-compose.yml")),
      loopBackTo: "implement",
      maxAttempts: sprintMaxAttempts(),
      feedbackFrom: "docker-review",
      steps: [
        {
          id: "audit",
          execution: "subagent",
          agent: "worker",
          skill: "kstack-docker-manager",
          signal: { kind: "verdict", value: "docker-build" },
          task: `## DELIVERABLE
A Docker audit of the sprint diff: build correctness + image security, emit \`--verdict docker-build==success\` / \`==failed\` and \`--verdict docker-security==approved\` / \`==rejected\` in your step record. Findings in --evidence.

## STOP CONDITION
Stop when: every Dockerfile/compose change has been audited once. Report, do NOT fix.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}`,
        },
      ],
    },
    {
      id: "pipeline-review",
      name: "Pipeline Review",
      execution: "main",
      needs: ["impl"],
      enabled: "auto", // CI config present
      autoWhen: (ctx) =>
        existsSync(join(ctx.cwd, ".github", "workflows")) ||
        existsSync(join(ctx.cwd, ".gitlab-ci.yml")) ||
        existsSync(join(ctx.cwd, "Jenkinsfile")),
      loopBackTo: "implement",
      maxAttempts: sprintMaxAttempts(),
      feedbackFrom: "pipeline-review",
      steps: [
        {
          id: "audit",
          execution: "subagent",
          agent: "worker",
          skill: "kstack-pipeline-sre",
          signal: { kind: "verdict", value: "pipeline" },
          task: `## DELIVERABLE
A CI pipeline audit of the sprint diff: workflow correctness, caching, secret handling, emit \`--verdict pipeline==approved\` or \`==rejected\` in your step record. Findings in --evidence.

## STOP CONDITION
Stop when: every CI change has been audited once. Report, do NOT fix.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}`,
        },
      ],
    },
    {
      id: "archive",
      name: "Archive Sprint",
      execution: "main",
      steps: [
        {
          id: "archive",
          execution: "main",
          signal: { kind: "marker", value: "ARCHIVED" },
          task: `## DELIVERABLE
Only the DURABLE artifacts moved to their archive slots under sprints/sprint_{sprint}/ — system-design_{sprint}.md and ADR-log_{sprint}.md are the survivors; ephemerals stay in place (the run's terminal cleanup deletes them).

## STOP CONDITION
Stop when: the durables are moved and named. Mechanical step — do NOT commit, do NOT start new work.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}

${REC("ARCHIVED")}`,
        },
      ],
    },
    {
      id: "retro",
      name: "Retro",
      execution: "main",
      steps: [
        {
          id: "retro",
          execution: "main",
          skill: "kstack-retro",
          signal: { kind: "marker", value: "RETRO-DONE" },
          task: `## DELIVERABLE
A sprint retro: pipeline quality, gate signal value, missed classes — one improvement worth making.

## STOP CONDITION
Stop when: findings are on the record. Advisory only.

## CONTEXT
Sprint {sprint} | Goal: {goal} | Branch: {branch}

${REC("RETRO-DONE")}`,
        },
      ],
    },
  ],
};

// KSTACK_PI_SPRINT=off hides the sprint workflow from menu and router entirely
// (kill-switch; every other workflow is unaffected).
const ALL_WORKFLOWS: Workflow[] = [
  ...(sprintEnabled() ? [sprint] : []),
  develop,
  investigate,
  review,
  discover,
  audit,
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
