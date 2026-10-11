# System Design 01 — S4 workflow step-migration + generalized verdict engine

Counterpart: `user-story_01.md` + `product-capability_01.md`. Sprint 01.
All decisions below were resolved interactively during this sprint's design
phase; ADR-log_01.md carries the rationale per decision.

---

## 1. Binding Ubiquitous Language

| Term | Definition | Forbidden synonyms |
|---|---|---|
| **Step** | Atomic unit of work inside a phase (`WorkflowStep`); carries 0-or-1 `skill` | chain step, sub-phase, task |
| **Delegated step** | Step with `execution: "subagent"`; spawned by the executor | subagent phase, chain |
| **Main step** | Step with `execution: "main"`; executed by the orchestrating model | interactive phase |
| **Record** | Structured JSON emitted via `kstack-report` to `.kstack/runs/<runId>/`; canonical completion proof of a delegated step | handoff, verdict file, report text |
| **Evidence** | On-disk artifact named by a record's `--evidence`; second channel cross-checked against the record's vars | attachment, artifact |
| **Verdict-flagged step** | Delegated step with `verdict: true`; the ONLY construct allowed to emit gate variables | gate step, reviewer step |
| **Gate variable** | `name == value` pair inside a record's `vars` consumed by `routeVerdict` | verdict line, status line |
| **Phase verdict** | Merge of a phase's verdict-flagged records; disagreement on any variable ⇒ null ⇒ park | verdict text, HANDOFF verdict |
| **`loopBackTo`** | Single-target back-edge on a verdict-bearing phase (sprint-compat) | loop, retry edge |
| **`loopBackOn`** | `Record<negativeValue, phaseId>` multi-target routing map; value without entry ⇒ park | multi-loop, branch |
| **`onComplete`** | Unconditional bounded back-edge on a non-verdict phase (`fix→test`, `fix→review`) | goto, auto-advance |
| **Entry gate (⚠)** | Pre-run human gate on `sideEffect` phases; parks before execution | push gate, manual approval |
| **Ledger event** | Append-only JSONL entry in `.kstack/ledger/`; verbatim, never compressed | log line, telemetry row |
| **Retry context** | Summarized blockers (≤2000 chars) injected into a looped target's instructions | retry prompt, feedback dump |
| **Catalog skill** | Directory `skills/<id>/` with `SKILL.md`; id = dir name — the ONLY registry source | registry alias, kstack-sprint-* id |
| **Freeze** | Security-rejection park resolvable only by the typed phrase; devsecops-only | security park, lock |

---

## 2. Domain model

### Core domain — orchestrator (`orchestrator/`)

```
Workflow = { id, phases: Phase[] }
Phase    = { id, steps: Step[], optional?, skipWhen?, advance?,
             loopBackTo?, loopBackOn?, onComplete?, maxAttempts?,
             feedbackFrom?, variant? }          // legacy fields DELETED (T10)
Step     = { id, execution, agent?, task, skill?, verdict?, skipWhen? }
Record   = { runId, phase, step, summary, deliverable,
             evidence: string[], status, rationale, blockers?, vars? }
```

Boolean invariants:

- INV-1 — `step.skill` is a single catalog id or absent; never two.
- INV-2 — `step.verdict === true` ⟹ `step.execution === "subagent"`.
- INV-3 — A phase declaring `loopBackTo`/`loopBackOn` contains ≥1
  verdict-flagged step.
- INV-4 — `onComplete` names a phase at a LOWER index than the declaring
  phase (back-edge only; forward `onComplete` = definition bug ⇒
  coherence-test failure).
- INV-5 — `loopBackOn` values are a subset of `NEGATIVE_VALUES` ∪ the
  phase's expectation negatives; a parsed negative without a map entry ⇒
  park, never a default.
- INV-6 — Every `step.skill` resolves to `skills/<id>/SKILL.md` on disk.
- INV-7 — Phase ids are workflow-unique; step ids are phase-unique.
- INV-8 — A `loopBackTo`/`loopBackOn`/`onComplete` TARGET is never
  `optional`-skippable on re-entry (its `skipWhen`, if any, must evaluate
  `false` when reached via loop — asserted in tests).
- INV-9 — `pendingVerdict` is populated ONLY from verdict-flagged records
  merged by the orchestrator — never from model advance summaries.
- INV-10 — State version bumps to 5 on first record-protocol run; v4
  states load with record-protocol defaults (no verdict-flagged steps ⇒
  legacy behavior preserved).

### Supporting domain — runtime (`runtime/bin`)

- `kstack-report` — the completion protocol of EVERY delegated step.

### Supporting domain — catalog (`skills/`)

- The registry is DERIVED: `skills/` scanned at load; id = dir name;
  `summary` read from SKILL.md frontmatter `description`. Alias ids
  (`kstack-sprint-*`, `kstack-document-{release,generate}`) are REMOVED and
  all refs rewritten to dir names. Per-skill dir renames for shorter names:
  deferred, decided per skill.

---

## 3. `kstack-report` — delegation completion protocol

Location: `runtime/bin/kstack-report` (bash, consistent with the existing
bin scripts — `bun` not required).

Invocation (inside a delegated step, via bash):

```
kstack-report --run <runId> --phase <phaseId> --step <stepId> \
  --summary "<2-3 sentence outcome>" \
  --deliverable "<what the next step/phase consumes>" \
  --evidence <path> [<path>…] \
  --status green|orange|red \
  --rationale "<why this status>" \
  [--blockers "<summarized blockers — REQUIRED when status ≠ green>"] \
  [--var <name> --value <v>]…
```

Contract:

- `--run/--phase/--step` identify the record; the step's task text carries
  them pre-interpolated (absolute CLI path included — spawns run in the
  TARGET repo's cwd, not the extension dir).
- Writes `.kstack/runs/<runId>/<phaseId>.<stepId>.json` (atomic: tmp+rename)
  AND appends a ledger event to `.kstack/ledger/<workflowId>-<runId>.jsonl`.
- `--var` values are validated against a closed enum at write time
  (`--var` on a non-flagged step is still written — the ORCHESTRATOR parks
  on it; the CLI stays dumb, the state machine stays the judge).
- A delegated step that exits WITHOUT a record ⇒ missing record ⇒ the
  orchestrator treats it as `verdict-unreadable`-class park for flagged
  steps, or step failure for unflagged ones (no attempt burned).
- Main steps MAY emit records for factual status where a spec justifies
  (never `--var`, never `verdict` semantics).

Consumption (executor, post-delegation, deterministic mode):

- `PhaseResult.summary` ← record.summary; `{previous}` plumbing ←
  record.deliverable (fallback: extractHandoff during migration window).
- Phase verdict ← merge of all verdict-flagged steps' `vars` within the
  phase; disagreement on any variable ⇒ null ⇒ park.
- Record↔evidence cross-check for flagged steps: each evidence file must
  exist and contain the same `name == value` lines in its ≤64KB tail —
  dual-channel preserved, artifact naming generalized beyond sprint.
- `isLastStep` gate DELETED; `mergeParseOutcomes` over raw HANDOFF text
  retired once no legacy chains carry verdicts (HANDOFF parse survives as
  the legacy path during migration only).
- `isRefutedStrategy`/`isValidatedStrategy` text-sniff DELETED — refuted is
  a first-class record var.

---

## 4. Verdict engine generalization

| Change | From | To |
|---|---|---|
| Parse gate | `workflowId === "sprint"` | any phase with verdict-flagged delegated steps |
| Verdict source | HANDOFF text of last chain/step | flagged steps' `vars` records |
| Expectations | `PHASE_EXPECTATIONS[phaseId]` | `PHASE_EXPECTATIONS[workflowId][phaseId]` |
| Expectation shape | `var → allowed[]` | unchanged + `loopBackOn` value→target map on the phase |
| Routing | `loopBackTo` single target | `loopBackTo` (single) OR `loopBackOn` (per-value); unmapped negative ⇒ park |
| Artifact channel | sprint-stamped names | record-declared `evidence` paths; sprint keeps stamped names during migration |
| Panels | `handleSprintPanel` sprint-only | generalized to any workflow (verdict-park, loop-exhausted); freeze stays devsecops-only |
| Determinism guard | `workflow.id === "sprint"` refuses start | any workflow carrying verdict/loop/onComplete phases refuses start without deterministic subagents |
| Ceilings | `sprintMaxAttempts()` defaults | per-target counters (`attempts[targetId]`), phase `maxAttempts` explicit |

Value vocabulary (extends `VALUE_WHITELIST`):

- QA gates: `status == green|orange|red` (existing).
- Review gates: `code-review == approved|rejected` (existing).
- Security: `security-review` + `severity` + `docker-*` (existing, devsecops).
- Architect: `software-architect-review` (existing).
- NEW `outcome == verified|persists|refuted` — investigate.verify only;
  `persists`/`refuted` join `NEGATIVE_VALUES`; `verified` is the positive.

`routeVerdict` gains `workflowId`; devsecops-specific branch is keyed
`(sprint, devsecops-review)` — unchanged semantics.

---

## 5. Back-edges: `onComplete`

- `onComplete?: phaseId` on `WorkflowPhase`. On normal completion (not
  failed/skipped): `phaseIndex = targetIndex`, purge `[target..phase]`,
  `attempts[target]++` bounded by the TARGET's ceiling — exhaustion parks
  `loop-exhausted:<target>` identically to verdict loops.
- Used by: qa `fix→test`, ship `fix→review`, review `fix→findings`.
- Never carries feedback (the re-entered phase re-reads fresh state); the
  verdict channel's retry-context remains for verdict edges.

---

## 6. Per-workflow decompositions (T1 specs — refine `workflow-redesign.md`)

Step rows: `id (exec, skill, flags)` — `—` = no skill.

### develop
| Phase | Steps | Notes |
|---|---|---|
| understand | `frame (main, —)` | |
| explore | `scout (delegated scout, —)` | |
| plan | `interrogate (main, grilling)` → `draft (main, plan-draft)` → `eng-review (main, plan-eng-review)` | existing pilot; `advance: manual` |
| implement | `mindrun (main, mindrun)` → `build (delegated worker, test-driven-development)` → `self-check (main, verification-before-completion)` | loop target |
| qa (opt) | `test (delegated worker, qa, verdict)` | `status` var; `loopBackTo: implement` |
| review | `review (delegated reviewer, review, verdict)` | `code-review` var; `loopBackTo: implement` |
| ship (opt) | `ship (delegated worker, ship)` | |
| document (opt) | `sync (delegated worker, document)` → `fill (delegated worker, document)` | |

### investigate
| Phase | Steps | Notes |
|---|---|---|
| reproduce | `repro (main, investigate)` | |
| root-cause | `scout (delegated scout, investigate)` → `analyze (delegated planner, fix-strategy)` | `advance: manual` |
| fix | `patch (delegated worker, fix-strategy)` → `regression (delegated worker, test-driven-development)` | loop target |
| verify | `verify (delegated worker, verification-before-completion, verdict)` | `outcome` var; `loopBackOn: {persists→fix, refuted→root-cause}` |
| regression-qa (opt) | `qa (delegated worker, qa, verdict)` | `status` var; `loopBackTo: fix`; `skipWhen` unchanged |

### qa
| Phase | Steps | Notes |
|---|---|---|
| setup | `scope (main, —)` | |
| test | `smoke (delegated worker, qa)` → `deep (delegated worker, qa, verdict)` | `status` var; `loopBackTo: fix` (forward-adjacent: red routes to fix carrying blockers; green advances) |
| fix | `fix (delegated worker, —)` | `skipWhen: allTestsPassed(test)`; `onComplete: test` |
| report | `report (main, qa)` | consumes records; presentation only |

### qa-report
Same as qa minus fix/loop; all phases `variant: report-only`; no
verdict flags (report IS the deliverable).

### ship
| Phase | Steps | Notes |
|---|---|---|
| pre-checks | `repo-check (main, —)` → `test-check (main, —)` | |
| review | `review (delegated reviewer, review, verdict)` | `code-review` var; `loopBackTo: fix` (forward-adjacent) |
| fix | `fix (delegated worker, —)` | `skipWhen: review approved`; `onComplete: review` |
| test | `test (delegated worker, —)` | |
| push-pr | `push (delegated worker, ship)` | `sideEffect` ⇒ entry gate ⚠ (generalizes commit-archive's hardcoded one) |
| verify | `ci-check (main, —)` | fail ⇒ park + rollback path; never loops (D23) |
| update-docs (opt) | `docs (delegated worker, document)` | |

### review
| Phase | Steps | Notes |
|---|---|---|
| diff | `diff (delegated scout, —)` | |
| findings | `findings (delegated reviewer, review, verdict)` | `code-review` var; `loopBackTo: fix` (forward-adjacent) |
| fix (opt) | `fix (delegated worker, —)` | `onComplete: findings`; optional gate lets the human stop the cycle |

### sprint (light — D24; verdict vars/artifacts/ceilings unchanged)
| Phase | Steps | Notes |
|---|---|---|
| system-design | `design (main, system-design)` → `adr (main, adr)` | value-clear split only |
| implement | `backend (delegated backend-developer, test-driven-development)` → `backend-verify (delegated worker, verification-before-completion)` → `frontend (delegated frontend-developer, test-driven-development)` → `frontend-verify (delegated worker, verification-before-completion)` | D19: two skills/step ⇒ split into verify steps — flagged for approval |
| devsecops-review | `code-review (delegated reviewer, review, verdict)` → `security (delegated devsecops-reviewer, cso, verdict)` → `docker (delegated devsecops-reviewer, docker-manager, verdict, skipWhen no-docker)` → `pipeline (delegated devsecops-reviewer, pipeline-sre, skipWhen no-ci)` | needs step-level `skipWhen` |
| qa-verdict | `qa (delegated qa-engineer, qa, verdict)` | |
| architect-gate | `architect (delegated software-architect, system-design, verdict)` | |
| commit-archive | `commit (delegated worker, ship)` | `advance: manual` + `sideEffect` ⚠ |

### quick
| Phase | Steps | Notes |
|---|---|---|
| action | `act (main, —)` | unchanged semantics; pre-flight no-op |

---

## 7. Data flows

```
delegated step run ──bash──▶ kstack-report ──▶ .kstack/runs/<run>/<phase>.<step>.json
                                          └─▶ .kstack/ledger/<wf>-<run>.jsonl (event)

executor (post-delegation):
  read records[phase.*] ──▶ PhaseResult.summary / {previous}
  verdict-flagged records ──merge──▶ vars ──▶ evidence tail cross-check
       └─▶ pendingVerdict ──▶ routeVerdict(workflowId, phaseId)
              ├─ approved-map values ──▶ linear advance
              ├─ negative ──▶ loopBackTo | loopBackOn[value] ──▶ purge span,
              │     attempts[target]++, retryContext(blockers from record)
              ├─ unmapped/hedged/missing ──▶ park (no attempt burned)
              └─ security reject + crit/high (sprint only) ──▶ freeze

non-verdict phase completes ──onComplete?──▶ phaseIndex=target, purge span,
                                             attempts[target]++ (ceiling)
```

Unhappy paths (deterministic payloads):
- `verdict-unreadable:<phase>:no-verdict|evidence-mismatch|unroutable`
- `loop-exhausted:<target> after N runs`
- `step-failed:<phase>.<step>` / `detector-trip:<rule>`
- `branch-violation:<phase> on <branch>` (existing, generic)
- `security-freeze:<phase>` (sprint/devsecops only)

---

## 8. Machinery change list (implementation surface)

1. `runtime/bin/kstack-report` — new CLI (bash; arg validation, atomic
   record write, ledger append, enum-checked `--var`).
2. `types.ts` — `WorkflowStep.verdict?`, `WorkflowStep.skipWhen?`,
   `WorkflowPhase.loopBackOn?`, `WorkflowPhase.onComplete?`,
   `WorkflowPhase.sideEffect?`; legacy `agent`/`task`/`skills`/`chain`
   deleted (T10); `WorkflowState.version` → 5.
3. `verdicts.ts` — record-based parsing (`vars` merge, `outcome` values,
   persists/refuted negatives); evidence cross-check generalized;
   `PHASE_EXPECTATIONS` keyed `workflow → phase`; expectations entries for
   every verdict phase in §6.
4. `executor.ts` — un-gate sprint-only verdict path; read records after
   each delegated step; missing/foreign-var records ⇒ park; spawn env/
   task interpolation carries run/phase/step ids + CLI path.
5. `state.ts` — `routeVerdict(workflowId, phaseId, parsed)`; `loopBackOn`
   resolution; `onComplete` edge; per-target ceilings.
6. `command.ts` — deterministic-subagents guard generalized; panels for
   non-sprint parks (freeze stays devsecops).
7. `gates.ts`/`templates.ts` — `sideEffect` ⇒ ⚠ entry gate; step task
   template gains the kstack-report contract block for delegated steps;
   `{previous}` sources from record.deliverable.
8. `skills.ts` — REGISTRY derived from `skills/` dirs; aliases removed;
   summaries from frontmatter; manual-only marking for unreferenced
   catalog skills (T9).
9. Deletions — `isRefutedStrategy`, `isValidatedStrategy`, `isLastStep`
   gate, `mergeParseOutcomes` (post-migration), legacy phase-field paths,
   stray `nul` file.
10. Tests — records parser, (workflow,phase) expectations, `loopBackOn`
    routing incl. unmapped-negative park, `onComplete` bounds,
    step-`skipWhen`, verdict-flag invariants, per-workflow coherence,
    registry derivation.

## 9. Verification plan (per user: full live runs)

- Model for delegated verification runs: `agnes/agnes-3.0-flash` via the
  `agnes` provider in `~/.pi/agent/models.json` (model id referenced in
  run config only — the key never enters this repo; user rotates it after).
- Every migrated workflow gets a real run on a scoped task; sprint-light
  verified structurally + by this very run's machinery (documented).
- `bun test` green gate stays throughout.

---

## OPEN QUESTIONS: none — all frontier decisions resolved interactively
(round 1: verdict channel/records, per-step flags, multi-target,
onComplete; round 2: derived registry, devsecops-only freeze, canonical
records, full live runs on agnes-3.0-flash).
