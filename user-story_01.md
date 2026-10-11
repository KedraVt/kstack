# User Story 01 — Workflow step-model migration + verdict loops (kstack S4)

## Goal

As a **kstack operator** (and the agent executing its workflows), I want every
workflow — develop, investigate, qa, qa-report, ship, review, sprint, quick —
redesigned on the step model introduced in S3, so that skill knowledge arrives
just-in-time per atomic unit of work, and rejection loops route
deterministically where they add value — instead of today's mixed model where
one piloted phase is stepped and everything else still injects skills
per-phase through legacy fields.

## Actor

- **Operator**: the human running kstack workflows on a target repo; decides
  at gates, reads verdicts, approves loops.
- **Executing agent**: the model consuming step instructions — receives
  exactly one skill per step (or none), never a triple injection.
- **Maintainer**: future contributor to this repo — finds one phase model,
  not two.

## Outcome

After this sprint, the workflow engine has a single execution model — phases
are containers of heterogeneous steps (main interactive + delegated
isolated) — and verdict-bearing gates exist outside sprint for the first
time: failed QA sends develop back to implementation, a rejected review
blocks a ship before the push, a persisting bug re-enters the fix. Sprint
stays the reference implementation with only a light review.

## Acceptance criteria (falsifiable)

- [ ] AC-1 — Every phase of every workflow in `orchestrator/workflows.ts`
  declares `steps[]`, and every declared step carries **zero or one** `skill`
  id (D19) — no step has two skills.
- [ ] AC-2 — No `WorkflowPhase` in any workflow carries a legacy
  `agent`/`task`/`skills`/`chain` field (T10); the fields exist in the type
  only if still needed by non-workflow machinery — otherwise removed.
- [ ] AC-3 — Verdict loops are active per the D23 rollout table: develop
  (qa FAIL→implement, review REQUEST_CHANGES→implement), qa (report
  FAIL→fix→retest), investigate (verify persists→fix, refuted→root-cause),
  review (findings→fix→re-review), ship (review blocks push pre-push);
  sprint loops unchanged.
- [ ] AC-4 — Every verdict-bearing phase outside sprint routes through the
  same fail-closed machinery as sprint: parsed verdict → expectation map →
  loop-back with ceiling → park on unreadable/off-map verdict — and
  `PHASE_EXPECTATIONS` lookups cannot collide across workflows that share a
  phase id.
- [ ] AC-5 — Loop retry feedback is the summarized blocker payload
  (D28), never the raw prior trace.
- [ ] AC-6 — Every skill id referenced by any step resolves to a registry
  entry whose `SKILL.md` exists under `skills/` (coherence test green),
  and every catalog skill is either step-mapped or explicitly marked
  manual-only (T9).
- [ ] AC-7 — `Kstack/workflow-redesign.md` holds an approved redesign spec
  per workflow (draft decompositions refined during this sprint, T1).
- [ ] AC-8 — `bun test` is green at sprint end, including new coverage for
  the non-sprint verdict machinery and per-step verdict semantics.
- [ ] AC-9 — No `pr push` / remote push is performed at any point this
  sprint (user constraint); commit-archive parks at its entry gate.
- [ ] AC-10 — Each migrated workflow has a recorded verification run or a
  documented reason a live run was not possible (sprint-light cannot fully
  re-run itself mid-session).

## Non-goals

- Changing sprint's verdict/loop machinery semantics (D24 — light review
  only).
- New skills beyond the ones the step-first gap analysis surfaces (D25).
- Parallel waves / DAG execution, memory redesign, eval harness — S5
  territory.
- Data migration `~/.gstack`→`~/.kstack` — backlog S6 (D35).

## Open questions

Carried from the understand phase + user-provided machinery constraints —
resolved during planning, not here:

- Verdict channel for phases that are `execution: "main"` in the draft
  (delegated step vs new main-phase channel).
- Multi-target loops (investigate verify: persists→fix vs
  refuted→root-cause).
- Non-sprint artifact channel + naming (`artifactForVariable`).
- Registry ids for mindrun/verification/tdd outside sprint.
- Whether severity→freeze semantics stays devsecops-only.
- Per-step verdict semantics when chains become `steps[]`.
- Ship loop shape; optional-phase × verdict interplay; `nul` file;
  verification-run depth.
