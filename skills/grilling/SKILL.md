---
name: grilling
description: >
  Interview protocol: relentlessly map decisions as a design tree and work it
  in rounds over the frontier — every question with a recommended answer,
  facts looked up (never asked), decisions asked (never assumed), until
  nothing is silently assumed.
---

<!-- provenance: vendored from github.com/mattpocock/skills (MIT) · distilled digest materialized as first-class SKILL.md · 2026-08-28 -->

# Grilling

Interview the user relentlessly until you reach a shared understanding. Map
this as a **design tree**: every decision branches into the decisions that hang
off it.

## Rounds over the frontier

Work the tree in **rounds**. The **frontier** is every decision whose
prerequisites are already settled: the questions you can ask *now* without
guessing at answers you haven't heard yet. Ask the whole frontier in one round:
number each question and give your recommended answer. Then wait for the
user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree: settled decisions push the
frontier outward and unblock questions that depended on them. Recompute the
frontier and ask the next round. A question whose answer depends on another
question still open in this round belongs to a *later* round, not this one.

## Facts vs decisions

Finding *facts* is your job, never the user's. When a frontier question needs a
fact from the environment (filesystem, tools, scout findings), look it up
yourself or dispatch a sub-agent — don't ask the user for anything you could
look up. Don't block on it: a running exploration is an unsettled prerequisite,
so only the questions downstream of it wait; ask the rest of the frontier now.

The *decisions* are the user's: put each to them and wait.

## Termination

The session is done when the frontier is empty: every branch of the design tree
visited, nothing left silently assumed.

Workflow adaptation: when the frontier is empty (or the question cap is
reached), write the converged understanding to the plan/artifact the workflow
expects (e.g. `.gstack/plans/{plan_file}` or the sprint's user-story) and call
`gstack_advance` — the workflow's approval gate takes over from there. Do not
start implementing.

## DoD gate (verification)

- Rounds end only when the frontier is empty — nothing silently assumed.
- Every question carried a recommended answer.
- Facts looked up; decisions asked.
- Batch the frontier per round; wait for answers before recomputing.
