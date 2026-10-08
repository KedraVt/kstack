---
name: kstack-plan-eng-review
description: >-
  Engineering plan review before implementation: scope challenge (minimum
  change set, complexity smell, built-in vs custom), design-doc grounding,
  four-section interactive review (architecture, code quality, tests,
  performance) with opinionated recommendations, ending in a structured
  REVIEW REPORT appended to the plan file. Use when a plan or branch needs an
  engineering gate, the user says "review this plan", "is this approach
  right", or the workflow routes to plan review. Do NOT use for design
  discovery (use kstack-office-hours), code-diff review (use kstack-review),
  or UX/design review (use kstack-plan-design-review).
metadata:
  version: "1.0.0"
compatibility: Runtime/bin helpers degrade gracefully; pure review methodology otherwise.
---

<!-- provenance: gstack/gstack-plan-eng-review (scope gate, Step 0, review sections) — boilerplate stripped: brain-cache, learnings, plan-mode machinery adapted to pi · rewritten S1 2026-02-11 -->

# Plan Engineering Review

Review the plan thoroughly before any code changes. For every issue or
recommendation: explain the concrete tradeoffs, give an **opinionated
recommendation**, and ask for input before assuming a direction.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-telemetry-log --event-type skill_run --skill kstack-plan-eng-review --status start 2>/dev/null || true
```

> **Headless run?** If `ask_user_question` is unavailable (spawned/non-interactive run), default the review target to the current branch diff or the artifact supplied in the task, make assumptions explicit with `~assumed`, and never block a gate waiting for an answer.

## Scope gate (FIRST — hard STOP, overrides everything below)

Your VERY FIRST action is `ask_user_question` — confirm the review target.
Do NOT run `git`, `Read`, `Grep`, or begin any section before the user
answers:

```
What should I review?
A) The current branch diff — work in progress on this branch.
B) A plan or design doc I'll paste or point you to.
C) A specific file, directory, or path.
```

Recommend A when a branch diff exists, otherwise B.

## Design Doc Check

```bash
eval "$(C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-slug 2>/dev/null)"
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-' || echo 'no-branch')
DESIGN=$(ls -t ~/.gstack/projects/$SLUG/*-$BRANCH-design-*.md 2>/dev/null | head -1)
[ -z "$DESIGN" ] && DESIGN=$(ls -t ~/.gstack/projects/$SLUG/*-design-*.md 2>/dev/null | head -1)
[ -n "$DESIGN" ] && echo "Design doc found: $DESIGN" || echo "No design doc found"
```

Found → read it; it is the source of truth for problem statement,
constraints, chosen approach (a `Supersedes:` field means revised design —
check the prior version). **Not found** → offer `kstack-office-hours` once
via `ask_user_question` ("produces a structured problem statement + premise
challenge; sharper review input, ~10 min"). Accepted → invoke
`kstack-office-hours`, then re-run the check; declined → proceed, never
re-offer this session.

## Step 0: Scope Challenge

Before reviewing anything:

1. **Existing code** — what already partially/fully solves each sub-problem?
   Capture outputs from existing flows instead of building parallel ones.
2. **Minimum change set** — flag work deferrable without blocking the core
   objective. Be ruthless on scope creep.
3. **Complexity smell** — >8 files touched or >2 new classes/services →
   challenge whether fewer moving parts achieve the goal.
4. **Search check** — for each architectural pattern/component the plan
   introduces: does the runtime/framework have a built-in? Is the approach
   current best practice? Known footguns? Custom-where-builtin-exists → flag
   as scope reduction. Search unavailable → note it and proceed
   in-distribution.
5. **TODOS cross-reference** — deferred items blocking this plan? Bundleable
   without scope expansion? New work the plan creates?
6. **Completeness** — AI-assisted coding makes the complete version ~cheap:
   a shortcut that saves human-hours but not machine-hours → recommend the
   complete version.
7. **Distribution** — new artifact type (binary, package, image, app) without
   a build/publish pipeline → flag it; deferred distribution must appear in
   "NOT in scope", never silently dropped.

**If the complexity check triggers (>8 files or >2 new services): STOP** —
`ask_user_question` naming what's overbuilt + a proposed minimal version;
reduce or proceed only on the answer. Once the user accepts/rejects the scope
reduction, commit fully — never re-argue scope in later sections.

## The four-section review

Work interactively, one section at a time (Architecture → Code Quality →
Tests → Performance), at most 8 top issues per section. Read
`references/review-sections.md` and execute it in full — sections, outside
voice, required outputs, and report format are the source of truth.

## Judgment layer (apply throughout — instincts, not checklist)

Blast radius first ("worst case, how many systems?") · boring by default
(three innovation tokens — spend wisely) · incremental over revolutionary
(strangler fig, canary) · systems over heroes (design for 3am humans) ·
reversibility preference (flags, rollouts) · essential vs accidental
complexity ("real problem or one we created?") · make the change easy, then
the easy change (never structural + behavioral in one move) · own your code
in production · error budgets over uptime targets.

**Review preferences:** flag repetition aggressively · well-tested is
non-negotiable · engineered-enough (not fragile, not over-abstracted) ·
explicit over clever · smallest clean diff — but a broken foundation earns
"scrap it and do this instead" · ASCII diagrams valued for flows/state/
dependencies — and stale in-code diagrams are findings, not decorations.

## Output contract — REVIEW REPORT

The plan file (or review artifact) must end with a `## REVIEW REPORT` section
carrying the Runs/Status/Findings table + verdict line, and its FINAL
non-whitespace line must be the unresolved-decisions status: exact
`NO UNRESOLVED DECISIONS` or a `**UNRESOLVED DECISIONS:**` bullet block. The
report is a structured terminal section — in-body review prose does not
count. Persist the result:
`bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-review-log 2>/dev/null || true`.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-telemetry-log --event-type skill_run --skill kstack-plan-eng-review --status end 2>/dev/null || true
```

## DoD gate (verification)

- Scope gate ran first — target confirmed via `ask_user_question` before any
  repo exploration.
- Step 0 scope challenge emitted; complexity-smell stop honored if triggered.
- All four review sections ran (or skip reasons stated); ≤8 issues each;
  every recommendation is opinionated with tradeoffs.
- Plan file ends with `## REVIEW REPORT` + terminal unresolved-decisions
  line (exact contract above) — body prose doesn't count.

## Bundled files

| File | Run or read | Load when |
|---|---|---|
| `references/review-sections.md` | read | before the four-section review — always |

## Related skills

- `kstack-office-hours` — design discovery producing the design doc input
- `kstack-plan-design-review` — UX/design lens on the same plan
- `kstack-review` — the post-implementation diff review
- `kstack-spec` — when the plan needs to become a backlog spec instead

---

**First action is the scope gate — `ask_user_question` before any repo
exploration. Every recommendation is opinionated with concrete tradeoffs.**
