---
name: kstack-plan-draft
description: >-
  Draft the implementation-plan artifact from an already-interrogated
  problem: takes the interrogation output (answered frontier, decided
  questions, chosen approach) plus any design doc, and writes a structured
  plan file — Goal, NOT-in-scope, Architecture, Files-to-change, Edge-cases &
  risks, Test strategy, Open questions — ready for engineering review. Use
  for the plan-draft step after interrogation is complete, or when the user
  says "write the plan", "turn this into a plan". Do NOT use for the
  interrogation itself (use grilling or kstack-office-hours) or for reviewing
  the draft (use kstack-plan-eng-review / kstack-plan-design-review).
metadata:
  version: "1.0.0"
compatibility: None — pure drafting methodology.
---

<!-- provenance: new skill (S1, D22) — extracted from gstack-office-hours handoff scope; plan structure aligned with gstack-plan-eng-review's gate contract -->

# Plan Draft — from interrogated problem to plan file

You are a **staff engineer writing the plan another engineer will execute**.
The thinking already happened upstream — your job is faithful, complete
transcription into a plan artifact with zero residual ambiguity. Drafting,
not interrogating: if a decision is genuinely still open, it goes in `Open
questions` — you never silently pick one.

**HARD GATE:** the only artifact is the plan file. No code, no scaffolding,
no implementation.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-telemetry-log --event-type skill_run --skill plan-draft --status start 2>/dev/null || true
```

## Step 1: Gather the inputs

- **Interrogation output** — the prior step's answers (frontier items,
  decisions, rejected alternatives). In an orchestrated run it arrives via
  `{previous}`; standalone, read the design doc at
  `~/.kstack/projects/$SLUG/*-design-*.md` (latest) or ask the user for the
  brief.
- **Codebase grounding** — verify every file/symbol the plan names exists:
  `Grep`/`Read` the paths you cite. A plan referencing invented structure is
  worse than no plan.
- **Conventions** — `AGENTS.md`/`CLAUDE.md`, `TODOS.md`, existing patterns the
  plan must conform to.

## Step 2: Write the plan file

Write `plan.md` (or the path the workflow/parent specifies) with exactly this
skeleton — omit a section only when it is genuinely empty, and say so:

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

## Open questions
[Numbered; each either resolved inline ("→ decided: X") or genuinely open.
Target: near-zero. An open question that blocks implementation must be
flagged BLOCKING]
```

## Step 3: Self-check before handing off

- Every `Files to change` entry verified against the repo (paths exist,
  anchors real).
- Every alternative the interrogation rejected is implicitly or explicitly
  absent — no scope re-inflation.
- `Open questions` is honest: near-zero, and none silently assumed away.
- The plan is executable by an unfamiliar implementer — no "obvious" steps
  left implicit.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-telemetry-log --event-type skill_run --skill plan-draft --status end 2>/dev/null || true
```

## DoD gate (verification)

- Plan file contains all seven sections (explicit "none" where a section is
  legitimately empty).
- Every file/symbol cited verified against the codebase.
- Open questions enumerated; BLOCKING ones flagged; near-zero count.
- No implementation actions taken — output is the plan file only.

## Related skills

- `kstack-grilling` — upstream interrogation producing this step's input
- `kstack-office-hours` — design discovery producing the design doc input
- `kstack-plan-eng-review` / `kstack-plan-design-review` — downstream reviews
  that gate this draft
- `kstack-spec` — when the output should be a filed issue instead of a plan
  file

---

**The thinking happened upstream — you transcribe it faithfully. Zero
implementation, zero silently-picked decisions.**
