---
name: kstack-plan-draft
description: >-
  Evolve the living plan doc into the full implementation plan: takes the
  interrogated problem (idea-refine's one-pager + grilling's settled
  decisions, plus any design doc) and rewrites the file in place — Goal,
  NOT-in-scope, Architecture, Files-to-change, Edge-cases & risks, Test
  strategy, Implementation tasks, Open questions — ready for engineering
  review. Use for the plan-draft step after interrogation is complete, or
  when the user says "write the plan", "turn this into a plan". Do NOT use
  for the interrogation itself (use grilling or kstack-office-hours) or for
  reviewing the draft (use kstack-plan-eng-review / kstack-plan-design-review).
metadata:
  version: "1.0.0"
compatibility: None — pure drafting methodology.
---

<!-- provenance: new skill (S1, D22) — extracted from gstack-office-hours handoff scope; plan structure aligned with gstack-plan-eng-review's gate contract — amended S4: living-doc evolution, task breakdown, open-questions-none -->

# Plan Draft — from interrogated problem to plan file

You are a **staff engineer writing the plan another engineer will execute**.
The thinking already happened upstream — your job is faithful, complete
transcription into a plan artifact with zero residual ambiguity. Drafting,
not interrogating: a decision genuinely still open means the interrogation
under-ran — resolve it in-flight (you run interactive), never silently
pick one.

**HARD GATE:** the only artifact is the plan file. No code, no scaffolding,
no implementation.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/kstack-pi/runtime/bin/kstack-telemetry-log --event-type skill_run --skill kstack-plan-draft --status start 2>/dev/null || true
```

## Step 1: Gather the inputs

- **The living plan file** — it already exists: `kstack-idea-refine` birthed
  it as a one-pager (Problem Statement, Recommended Direction, Key
  Assumptions, MVP Scope, Not Doing, Open Questions) and grilling appended
  the settled decisions. Read it first — you evolve it in place.
- **Interrogation output** — in an orchestrated run it arrives via
  `{previous}`; standalone, read the design doc at
  `~/.kstack/projects/$SLUG/*-design-*.md` (latest) or ask the user for the
  brief.
- **Codebase grounding** — verify every file/symbol the plan names exists:
  `Grep`/`Read` the paths you cite. A plan referencing invented structure is
  worse than no plan.
- **Conventions** — `AGENTS.md`/`CLAUDE.md`, `TODOS.md`, existing patterns the
  plan must conform to.

## Step 2: Evolve the plan file

Rewrite the living file in place — never create a second file (standalone
with no prior file, write `plan.md`/the path the workflow specifies) — with
exactly this skeleton, mapping the one-pager's sections rather than
re-deriving them: Recommended Direction → Architecture · Not Doing → NOT in
scope · Key Assumptions → Edge cases & Test strategy · MVP Scope → Goal +
boundaries. Every settled decision carries forward. Omit a section only when
it is genuinely empty, and say so:

```markdown
## Goal
[One paragraph — the observable outcome, in user terms]

## NOT in scope
[Bullet list — what a reader might assume is included but is not]

## Architecture
[The chosen approach + why it beat the alternatives. ASCII diagram for
data flow / state / dependencies whenever the shape is non-trivial]

## Files to change
| File | Change |
|------|--------|
| `path/to/file` | what changes and why |
| `path/to/file:line` | precise anchor when it matters |

## Edge cases & risks
| Case/Risk | Handling |
|-----------|----------|
[empty/null/enormous/duplicated/wrong-role/called-twice — the failure modes
the interrogation surfaced, each with its handling]

## Test strategy
[What proves it works: tests to add/modify per file, the verification
commands, coverage expectations]

## Implementation tasks
| # | Task | Done when |
|---|------|-----------|
[Ordered execution sequence derived from Files to change + Test strategy —
each Done-when falsifiable (a check that passes or fails). Ordered units of
work, not kstack-tasks-grade atomic payloads]

## Open questions
[Expected: `none` — idea-refine + grilling settle questions upstream. A
still-open blocker means the interrogation under-ran: resolve it in-flight
with the user before writing; unresolvable → flag BLOCKING. Never silently
assume]
```

## Step 3: Self-check before handing off

- Evolved in place — same file, every settled decision carried forward;
  every rejected alternative absent (no scope re-inflation).
- Every `Files to change` entry verified against the repo (paths exist,
  anchors real).
- `Implementation tasks` ordered, each `Done when` falsifiable.
- `Open questions` is `none`, or each item resolved in-flight / flagged
  BLOCKING — none silently assumed away.
- The plan is executable by an unfamiliar implementer — no "obvious" steps
  left implicit.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/kstack-pi/runtime/bin/kstack-telemetry-log --event-type skill_run --skill kstack-plan-draft --status end 2>/dev/null || true
```

## DoD gate (verification)

- Plan file evolved in place — one-pager sections mapped, every settled
  decision carried; no second file created.
- All eight sections present (explicit "none" where a section is
  legitimately empty); Implementation tasks ordered with falsifiable
  `Done when` checks.
- `Open questions` is `none`, or each item resolved in-flight / flagged
  BLOCKING — none silently assumed.
- Every file/symbol cited verified against the codebase.
- No implementation actions taken — output is the plan file only.

## Related skills

- `kstack-idea-refine` — upstream: births the living plan doc this evolves
- `kstack-grilling` — upstream interrogation settling its open questions
- `kstack-office-hours` — design discovery producing the design doc input
- `kstack-plan-eng-review` / `kstack-plan-design-review` — downstream reviews
  that gate this draft
- `kstack-tasks` — when `Implementation tasks` needs sprint-grade
  decomposition
- `kstack-spec` — when the output should be a filed issue instead of a plan
  file

---

**The thinking happened upstream — you transcribe it faithfully. Zero
implementation, zero silently-picked decisions.**
