# System Design 01 — S4 workflow step-migration + generalized verdict engine

Counterpart: `user-story_01.md` + `product-capability_01.md`. Sprint 01.
All decisions below were resolved interactively during this sprint's design
phase; ADR-log_01.md carries the rationale per decision.

---

## 1. Binding Ubiquitous Language

| Term | Definition | Forbidden synonyms |
|---|---|---|
| **Step** | Atomic unit of work inside a phase (`WorkflowStep`); carries 0-or-1 task `skill` | chain step, sub-phase, task |
| **Delegated step** | Step with `execution: "subagent"`; spawned by the executor — lifecycle: `spawn→work→report→exit` (ephemeral) | subagent phase, chain |
| **Main step** | Step with `execution: "main"`; executed by the orchestrating model | interactive phase |
| **Ambient skill** | Behavioral skill on `step.ambientSkills[]` (ponytail, AC banks); OUTSIDE the 0-1 task-skill slot | second skill, merged skill |
| **Record** | Structured JSON emitted via `kstack-report` to `.kstack/runs/<runId>/`; canonical completion proof of a delegated step | handoff, verdict file, report text |
| **Evidence** | On-disk artifact named by a record's `--evidence`; second channel cross-checked against the record's vars | attachment, artifact |
| **Signal** | `step.signal: {kind: "verdict"\|"artifact"\|"marker", value}` — the completion condition the router must observe before advancing the step | completion flag, done-check |
| **Verdict-flagged step** | Delegated step with `signal.kind == "verdict"`; the ONLY construct allowed to emit gate variables (supersedes `verdict: true`) | gate step, reviewer step |
| **Gate variable** | `name == value` pair inside a record's `verdicts` consumed by `routeVerdict` — JUDGMENTS, delegated steps only | verdict line, status line |
| **Routing var** | Factual `name == value` in a record's `vars` (`parallel-safe`, `feedback-type`) — land in `state.vars`; emittable by ANY step incl. main; never a judgment | verdict, gate variable |
| **`state.vars`** | Run-scoped `Record<string,string>`: `asks[]` answers + routing vars; sanitized on load; missing keys ⇒ safe defaults | env vars, config |
| **`asks[]`** | `Workflow.asks[]` — questions asked once at run start; answers write `state.vars` | prompts, flags |
| **Phase verdict** | Merge of a phase's verdict-flagged records; disagreement on any variable ⇒ null ⇒ park | verdict text, HANDOFF verdict |
| **`loopBackTo`** | Single-target back-edge on a verdict-bearing phase (sprint-compat) | loop, retry edge |
| **`loopBackOn`** | `Record<negativeValue, phaseId>` multi-target routing map; value without entry ⇒ park | multi-loop, branch |
| **`parkOn`** | `Record<value, "park"\|"freeze">` — park mode per verdict value; wins over loopBackOn/advance (devsecops `severity→freeze`) | conditional park |
| **`onComplete`** | Unconditional bounded back-edge on a non-verdict phase (`fix→findings`) — designed, lands with T2; fires ONLY on `completed` status, never on skipped/auto-disabled | goto, auto-advance |
| **`lastVerdicts`** | `state.lastVerdicts[phaseId]` — expectation-map-VALIDATED verdict of each verdict-bearing phase; readable by `autoWhen`/`skipWhen` downstream (PENDING T2) | raw verdict, --var route |
| **Publish-only verdict phase** | Verdict-bearing phase with NO routing edge — parses, validates, writes `lastVerdicts`, advances | edgeless gate |
| **Entry gate (⚠)** | Pre-run human gate on `sideEffect` STEPS; parks before execution | push gate, manual approval |
| **Ledger event** | Append-only JSONL entry in `.kstack/ledger/`; verbatim, never compressed | log line, telemetry row |
| **Retry context** | Summarized blockers (≤2000 chars) injected into a looped target's instructions | retry prompt, feedback dump |
| **Catalog skill** | Directory `skills/<id>/` with `SKILL.md`; id = dir name — the ONLY registry source | registry alias, kstack-sprint-* id |
| **Freeze** | Security-rejection park resolvable only by the typed phrase; devsecops-only | security park, lock |
| **Capability** | Probed machine capability (`graft`, `browse`, `node`, `gh`, `design`) in `state.capabilities`; step `requires:`⇒skip / `prefers:`⇒degrade | feature flag, dependency |
| **Ephemeral artifact** | Repo-relative path in `state.ephemeralArtifacts` deleted at terminal status (THINK docs) | temp file, scratch |
| **Handoff artifact** | Cross-run file under `.kstack/<workflow>/` (direction.md, findings.md); independent lifetime | output file, deliverable |
| **Resume-mode** | Step re-issued after interruption with "continue from disk state"; never mid-step, never burns `maxAttempts` | retry, checkpoint restore |

---

## 2. Domain model

### Core domain — orchestrator (`orchestrator/`)

```
Workflow = { id, phases: Phase[], asks?: Ask[] }
Ask      = { var, question, options[], default?, when?: {var,equals} }
Phase    = { id, steps: Step[], optional?, skipWhen?, advance?,
             enabled?: on|off|auto, autoWhen?, produces?, needs?,
             loopBackTo?, loopBackOn?, parkOn?, onComplete?,      // onComplete: designed (T2)
             maxAttempts?, feedbackFrom?, variant? }             // legacy fields DELETED (T10)
Step     = { id, execution, agent?, task, skill?, ambientSkills?,
             skipWhen?: {var,equals}, requires?: Cap[], prefers?: Cap[],
             ui?: "interactive", sideEffect?: true,
             signal?: {kind: verdict|artifact|marker, value} }
Record   = { v, workflow, runId, phase, step, at, summary,
             verdicts{}, vars{}, evidence[], deliverables[], markers[] }
State   += { lastVerdicts?: Record<phaseId, Record<var,value>>,   // PENDING T2
             lanes?: Record<laneId, {stepIndex}> }                // PENDING T2
```

Boolean invariants:

- INV-1 — `step.skill` is a single catalog id or absent; never two
  (ambient skills never occupy the slot).
- INV-2 — `step.signal?.kind === "verdict"` ⟹ `step.execution === "subagent"`.
- INV-3 — A phase declaring `loopBackTo`/`loopBackOn` contains ≥1
  verdict-flagged step.
- INV-4 — `onComplete` names a phase at a LOWER index than the declaring
  phase (back-edge only; forward `onComplete` = definition bug ⇒
  coherence-test failure).
- INV-5 — `loopBackOn` values are a subset of `NEGATIVE_VALUES` ∪ the
  phase's expectation negatives; a parsed negative without a map entry ⇒
  park, never a default — EXCEPT publish-only (edgeless) verdict phases,
  which route NOTHING: every validated value writes `lastVerdicts` and
  advances (ADR-24).
- INV-6 — Every `step.skill` and `step.ambientSkills[]` id resolves to
  `skills/<id>/SKILL.md` on disk.
- INV-7 — Phase ids are workflow-unique; step ids are phase-unique.
- INV-8 — A `loopBackTo`/`loopBackOn`/`onComplete` TARGET is never
  `optional`-skippable on re-entry (its `skipWhen`, if any, must evaluate
  `false` when reached via loop — asserted in tests).
- INV-9 — `pendingVerdict` is populated ONLY from verdict-flagged records
  merged by the orchestrator — never from model advance summaries.
- INV-10 — State version bumps to 5 on first record-protocol run; v4
  states load with record-protocol defaults (no verdict-flagged steps ⇒
  legacy behavior preserved).
- INV-11 — `step.skipWhen.var` names a var resolvable from `state.vars`
  (an `asks[]` var or a record-emitted routing var); an unresolvable var
  ⇒ the condition is false, the step runs.
- INV-12 — `parkOn` keys are whitelisted verdict values; `parkOn` is
  evaluated BEFORE `loopBackOn` and advance (park wins).
- INV-13 — A phase `enabled:"off"` that another enabled phase `needs` ⇒
  coherence failure (derived skippability is enforced at panel AND
  checked at run start).
- INV-14 — Parallel lanes engage iff `vars.scope=="mixed"` ∧ panel
  opt-in ∧ `vars["parallel-safe"]=="true"`; lanes MUST have disjoint
  file-sets (asserted from tasks.md) — per-lane resume depends on it.
- INV-15 — `step.ui === "interactive"` only on steps whose purpose IS
  user interaction; every other step runs headless (a browse step that
  would open a visible window blocks at the capability boundary).
- INV-16 — `onComplete` fires ONLY on `status:"completed"` — skipped,
  auto-disabled and failed phases never trigger the back-edge (the
  review own-lane's termination depends on it).
- INV-17 — `lastVerdicts[phaseId]` contains ONLY expectation-map-
  validated values; every verdict-bearing phase writes it on completion
  (edged or publish-only).

### Supporting domain — runtime (`runtime/bin`)

- `kstack-report` — the completion protocol of EVERY delegated step.

### Supporting domain — catalog (`skills/`)

- The registry is DERIVED: `skills/` scanned at load; id = dir name;
  `summary` read from SKILL.md frontmatter `description`. Alias ids
  (`kstack-sprint-*`, `kstack-document-{release,generate}`) are REMOVED and
  all refs rewritten to dir names. Per-skill dir renames for shorter names:
  deferred, decided per skill.

---

## 3. `kstack-report` — delegation completion protocol (AS-BUILT)

Location: `runtime/bin/kstack-report` (bash, consistent with the existing
bin scripts — `bun` not required). Implemented and verified end-to-end
(this sprint, T1): record write + ledger append + segment sanitization.

Invocation (inside a delegated step, via bash):

```
kstack-report --workflow <id> --run-id <runId> --phase <phaseId> [--step <stepId>] \
  [--attempt <n>] \
  [--summary "<2-3 sentence outcome>"] \
  [--verdict KEY==VALUE]... \
  [--var KEY==VALUE]... \
  [--evidence <path-or-text>]... \
  [--deliverable <path>]... \
  [--marker <text>]...
```

Contract:

- `--workflow/--run-id/--phase[--step]` identify the record; the step's
  task text carries them pre-interpolated (absolute CLI path included —
  spawns run in the TARGET repo's cwd, not the extension dir).
- Writes `.kstack/runs/<runId>/<phaseId>[.<stepId>].json` AND appends a
  `kind:"report"` ledger event to
  `.kstack/ledger/<workflowId>-<runId>.jsonl` carrying
  `{summary, verdicts, vars, record}`.
- **verdicts vs routing vars** (ADR-2 + redesign): `--verdict` =
  JUDGMENTS, emitted only by verdict-flagged (delegated) steps, consumed
  by `routeVerdict` after re-validation against the (workflow,phase)
  expectation map; `--var` = FACTS (`parallel-safe`, `feedback-type`) —
  any step may emit them; they land in `state.vars`. A `--verdict` from a
  non-flagged step is written (CLI stays dumb) but the ORCHESTRATOR parks
  on it — the state machine stays the judge.
- Record schema:
  `{v, workflow, runId, phase, step, at, summary, verdicts{}, vars{},
    evidence[], deliverables[], markers[]}`.
- A delegated step that exits WITHOUT a record ⇒ missing record ⇒ the
  orchestrator treats it as `verdict-unreadable`-class park for flagged
  steps, or step failure for unflagged ones (no attempt burned).
- Main steps MAY emit records for factual status where a spec justifies
  (never `--verdict`).

Consumption (executor, post-delegation, deterministic mode):

- `PhaseResult.summary` ← record.summary; `{previous}` plumbing ←
  record.deliverable (fallback: extractHandoff during migration window).
- Phase verdict ← merge of all verdict-flagged steps' `verdicts` within
  the phase; disagreement on any variable ⇒ null ⇒ park. Steps' `vars`
  merge separately into `state.vars` (facts, never routing judgments).
- Record↔evidence cross-check for flagged steps: each `--evidence` value
  is a PATH to a file under `.kstack/runs/<runId>/` that must exist and
  contain the same `name == value` verdict lines in its ≤64KB tail —
  dual-channel preserved, artifact naming generalized beyond sprint.
  For UNflagged steps `--evidence` may be inline text (no cross-check).
- `isLastStep` gate DELETED; `mergeParseOutcomes` over raw HANDOFF text
  retired once no legacy chains carry verdicts (HANDOFF parse survives as
  the legacy path during migration only).
- `isRefutedStrategy`/`isValidatedStrategy` text-sniff DELETED — refuted is
  a first-class record var.

---

## 4. Verdict engine generalization

| Change | From | To |
|---|---|---|
| Parse gate | `workflowId === "sprint"` | any phase with ≥1 verdict-flagged delegated step (`signal.kind=="verdict"`) — **loop edge NOT required** (edgeless = publish-only → `lastVerdicts` + advance) |
| Verdict source | HANDOFF text of last chain/step | flagged steps' record `verdicts` |
| Expectations | `PHASE_EXPECTATIONS[phaseId]` | `PHASE_EXPECTATIONS[workflowId][phaseId]` |
| Expectation shape | `var → allowed[]` | unchanged + `loopBackOn` value→target map + `parkOn` value→park-mode on the phase |
| Routing | `loopBackTo` single target | evaluation order: `parkOn[value]` ⇒ park/freeze · `loopBackOn[value]` ⇒ named target · negative ⇒ `loopBackTo` · positive ⇒ advance; unmapped negative ⇒ park. **Edgeless verdict phase** (no loopBackTo/loopBackOn) ⇒ every validated value publishes to `lastVerdicts[phaseId]` and advances |
| Artifact channel | sprint-stamped names | record-declared `evidence` paths; verifier steps write NO repo files — findings ride `--evidence` (or `--deliverable` under `.kstack/runs/<runId>/` when massive); sprint keeps stamped names during migration |
| Panels | `handleSprintPanel` sprint-only | generalized to any workflow (verdict-park, loop-exhausted); freeze stays devsecops-only via `parkOn:{red:"freeze"}` |
| Determinism guard | `workflow.id === "sprint"` refuses start | any workflow carrying verdict/loop/onComplete phases refuses start without deterministic subagents |
| Ceilings | `sprintMaxAttempts()` defaults | per-target counters (`attempts[targetId]`), phase `maxAttempts` explicit |

Value vocabulary (extends `VALUE_WHITELIST`):

- QA gates: `status == green|orange|red` (existing).
- Review gates: `code-review == approved|rejected` (existing).
- Security: `security-review` + `severity` + `docker-*` (existing, devsecops).
- Architect: `software-architect-review` (existing).
- NEW `outcome == verified|persists|refuted` — investigate.verify only;
  `persists`/`refuted` join `NEGATIVE_VALUES`; `verified` is the positive.
- NEW `walkthrough == pass|fail` (develop/sprint lite-mindrun steps),
  `ui == pass|fail` (ui-check), `pipeline == approved|rejected`
  (pipeline-review); `fail` joins `NEGATIVE_VALUES`.
- Routing vars (facts, NOT verdicts — `--var` only): `parallel-safe ==
  true|false`, `feedback-type == code|spec`. `feedback-type: code`
  (default when absent) ⇒ normal loop routing to implement; `spec` ⇒
  PARK — the human decides whether to reopen backlog; a broken spec
  never auto-re-runs tasks.
- `severity` is an ORDINARY var; its outcome is declared per phase via
  `parkOn` (devsecops: `{red: "freeze"}`; elsewhere standard park).

`routeVerdict` gains `workflowId`; devsecops-specific branch is keyed
`(sprint, devsecops-review)` — unchanged semantics.

---

## 5. Back-edges: `onComplete`

- `onComplete?: phaseId` on `WorkflowPhase`. On normal completion (not
  failed/skipped): `phaseIndex = targetIndex`, purge `[target..phase]`,
  `attempts[target]++` bounded by the TARGET's ceiling — exhaustion parks
  `loop-exhausted:<target>` identically to verdict loops.
- Used by: review `fix→findings` (target:own lane); the qa/ship uses
  died with their workflows — new consumers per the redesign doc.
- Never carries feedback (the re-entered phase re-reads fresh state); the
  verdict channel's retry-context remains for verdict edges.

---

## 6. Per-workflow decompositions — SUPERSEDED

> **Superseded by `Kstack/workflow-redesign.md` (approved, this session).**
> The catalog changed from 8 workflows to **6**: `develop`, `sprint`,
> `investigate`, `review`, `discover`, `audit`. `qa`, `qa-report`,
> `ship` (standalone) and `quick` were REMOVED — `kstack-qa`/`kstack-ship`
> remain skills consumed by phases. `discover` and `audit` are new
> workflows. The tables below are kept for history only — the approved
> per-workflow phases/steps/verdicts live in the redesign doc.
>
> Machinery deltas vs this section: `asks[]` (panel questions →
> `state.vars`), `enabled: on|off|auto` + `autoWhen`, declarative step
> `skipWhen: {var, equals}`, `ambientSkills`, `ephemeralArtifacts`,
> `.kstack/<workflow>/` handoff dirs, `capabilities` requires/prefers,
> `resume-mode`, per-step completion `signal` (replaces `verdict: true` —
> see §10), `kstack init`. See §10 for the full delta spec.

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
run start ──asks[]──▶ state.vars ──▶ step.skipWhen / enabled:"auto" / ambient selection

delegated step run ──bash──▶ kstack-report ──▶ .kstack/runs/<run>/<phase>.<step>.json
                                          └─▶ .kstack/ledger/<wf>-<run>.jsonl (event)

executor (post-delegation):
  step.signal? ──▶ observed? ── no ──▶ re-issue step (resumeMode)
       └─ yes ──▶ read records[phase.*] ──▶ PhaseResult.summary / {previous}
  record.vars ──merge──▶ state.vars (routing facts: parallel-safe, feedback-type…)
  verdict-flagged records ──merge──▶ record.verdicts ──▶ evidence tail cross-check
       └─▶ pendingVerdict ──▶ routeVerdict(workflowId, phaseId)
              ├─ parkOn[value] ──▶ park | freeze (devsecops severity→freeze only)
              ├─ vars["feedback-type"]=="spec" ──▶ park (never auto-rerun backlog)
              ├─ approved-map values ──▶ linear advance
              ├─ negative ──▶ loopBackOn[value] | loopBackTo ──▶ purge span,
              │     attempts[target]++, retryContext(blockers from record)
              └─ unmapped/hedged/missing ──▶ park (no attempt burned)

non-verdict phase completes ──onComplete?──▶ phaseIndex=target, purge span,
                                             attempts[target]++ (ceiling)

interruption (crash/quota/missing signal at boundary):
  append run-interrupted | quota-parked ──▶ resume re-issues the step
  in resumeMode — never phase-verdict, never attempts burn

run terminal status:
  delete state.ephemeralArtifacts[] ──▶ ledger event;
  .kstack/<workflow>/ handoffs + _XX durables untouched
```

Unhappy paths (deterministic payloads):
- `verdict-unreadable:<phase>:no-verdict|evidence-mismatch|unroutable`
- `loop-exhausted:<target> after N runs`
- `step-failed:<phase>.<step>` / `detector-trip:<rule>`
- `branch-violation:<phase> on <branch>` (existing, generic)
- `security-freeze:<phase>` (sprint/devsecops only, via `parkOn`)
- `capability-skip:<phase>.<step>:<cap>` (missing `requires:` — ledger note)

---

## 8. Machinery change list (implementation surface)

1. `runtime/bin/kstack-report` — new CLI (bash; arg validation, atomic
   record write, ledger append, enum-checked `--var`). **DONE (T1).**
2. `types.ts` — LANDED (T1): `WorkflowStep.{ambientSkills, skipWhen:{var,
   equals}, requires, prefers, ui, sideEffect, signal}`,
   `WorkflowPhase.{enabled, autoWhen, produces, needs, loopBackOn,
   parkOn}`, `Workflow.asks[]`, `WorkflowState.{vars, capabilities,
   ephemeralArtifacts, resumeMode}`, version union → 5. PENDING (T2):
   `WorkflowPhase.onComplete`; legacy `agent`/`task`/`skills`/`chain`
   deleted (T10).
3. `verdicts.ts` — record-based parsing (`verdicts` merge from flagged
   steps only, `vars` merge into `state.vars`, `outcome` values,
   persists/refuted negatives); evidence cross-check generalized;
   `PHASE_EXPECTATIONS` keyed `workflow → phase`; `parkOn` evaluation
   before `loopBackOn`; `feedback-type==spec` ⇒ park; expectations
   entries for every verdict phase in the redesign doc; parse gate =
   signal-flagged steps ONLY (edge optional); publish-only phases write
   `state.lastVerdicts[phaseId]` (validated values) and advance.
4. `executor.ts` — un-gate sprint-only verdict path; read records after
   each delegated step; missing/foreign-verdict records ⇒ park; signal
   observation gate (absent signal ⇒ resumeMode re-issue, no advance);
   ambientSkills injection; ephemeralArtifacts registration; sideEffect
   step ⇒ ⚠ entry gate; spawn env/task interpolation carries
   run/phase/step ids + CLI path.
5. `state.ts` — `routeVerdict(workflowId, phaseId, parsed)`; `loopBackOn`
   resolution; `parkOn` resolution; `onComplete` edge; per-target
   ceilings; `run-interrupted`/`quota-parked` ledger events on
   interruption; ephemeralArtifacts deletion at terminal status;
   `lastVerdicts`/`lanes` state fields (sanitize on load like `vars`).
6. `command.ts` — deterministic-subagents guard generalized; panels for
   non-sprint parks (freeze stays devsecops); `asks[]` sequential panel
   writing `state.vars`; `enabled`/`autoWhen` resolution + derived
   skippability at the panel; capability probe gates (requires⇒skip).
7. `gates.ts`/`templates.ts` — `sideEffect` ⇒ ⚠ entry gate; step task
   template gains the kstack-report contract block for delegated steps;
   `{previous}` sources from record.deliverable; resumeMode re-issue
   template ("continue from disk state").
8. `skills.ts` — REGISTRY derived from `skills/` dirs; aliases removed;
   summaries from frontmatter; manual-only marking for unreferenced
   catalog skills (T9).
9. `init.ts` — `kstack init`: versioned managed block
   `<!-- kstack:begin v1 -->…end` (2 rules), re-run refused,
   `--update` rewrites only the block + re-probes capabilities +
   reinstalls missing agent defs; `.kstack/` scaffold.
10. Deletions — `isRefutedStrategy`, `isValidatedStrategy`, `isLastStep`
    gate, `mergeParseOutcomes` (post-migration), legacy phase-field
    paths, `phase.optional` RETIRED (skippability derived via
    `enabled`/`produces`/`needs`; legacy states load as `enabled:"on"`),
    stray `nul` file. ✅ `nul` already removed.
11. Tests — records parser, (workflow,phase) expectations, `loopBackOn`/
    `parkOn` routing incl. unmapped-negative park, `feedback-type==spec`
    park, `onComplete` bounds, step-`skipWhen`, `asks[]`→vars,
    enabled/autoWhen + derived skippability, capability gates, signal
    observation + resumeMode, ephemeral cleanup, interruption events,
    sideEffect step gates, verdict-flag invariants, edgeless publish
    → `lastVerdicts` + autoWhen termination (review own-lane),
    per-workflow coherence, registry derivation.

## 9. Verification plan (per user: full live runs)

- Model for delegated verification runs: `agnes/agnes-3.0-flash` via the
  `agnes` provider in `~/.pi/agent/models.json` (model id referenced in
  run config only — the key never enters this repo; user rotates it after).
- Every migrated workflow gets a real run on a scoped task; sprint-light
  verified structurally + by this very run's machinery (documented).
- `bun test` green gate stays throughout.

---

---

## 10. S4 late additions (approved in the follow-up design session)

Decisions taken after this document's first cut — recorded in
`Kstack/workflow-redesign.md` (authoritative per-workflow spec) and
`ADR-log_01.md` (ADR-11+). Types already reflect them (`WorkflowStep`,
`WorkflowPhase`, `Workflow`, `WorkflowState` v5).

### 10.1 Catalog: 6 workflows

`develop` · `sprint` · `investigate` · `review` · `discover` · `audit`.
Removed: `qa`, `qa-report`, `ship` (standalone — stays a phase),
`quick`. `kstack-qa`/`kstack-ship` remain skills.

### 10.2 Run-start inputs: `asks[]` → `state.vars`

`Workflow.asks[]` asks the user once at start (sequential panel step):
`{var, question, options[], default?, when?}` — `when` hides questions
whose condition fails (`parallel` only when `scope == "mixed"`).
Answers land in `state.vars` and drive: declarative step
`skipWhen: {var, equals}` (supersedes ADR-10's function form — data,
resolvable before code), `enabled:"auto"` resolvers, ambient selection.

### 10.3 `enabled: on|off|auto` + derived skippability

Every phase carries `enabled` (absent = on). `auto` resolves via
`autoWhen(ctx)` on computable state (file presence, touched diff).
Skippability is DERIVED: `produces[]`/`needs[]` per phase — a phase is
skippable iff no enabled phase needs its output (the panel computes it;
a broken run is impossible by construction).

### 10.4 `ambientSkills`

Step-level behavioral skills injected alongside the task, OUTSIDE the
0-1 `skill` slot (ponytail, AC banks, writing guides). Task-skill rule
restated: 0-1 per step, ambient separate.

### 10.5 Artifact lifecycle

- `state.ephemeralArtifacts[]` — repo-relative paths deleted at run
  terminal status (develop: `understand.md`, `plan.md`; sprint adds
  `user-story.md`, `capability.md`, `tasks.md`, `summary_BE/FE.md`;
  investigate: `bug-report.md`): THINK docs consumed within the run.
  Ephemerals are FLAT (no `_XX`) — only durables carry the archive slot.
- Durable docs keep `_XX` archive naming (system-design, ADR-log only).
- Cross-run handoff artifacts live in `.kstack/<workflow>/`
  (`discover/direction.md`, `audit/findings.md`) — independent lifetime,
  never ephemeral-deleted, outside the project root.

### 10.6 Capabilities + UI contract

`state.capabilities` probed by `kstack init` (`graft`, `browse`, `node`,
`gh`, `design`). Step `requires:` missing ⇒ SKIP (useless without);
`prefers:` missing ⇒ run degraded + `~capability: no-<cap>` note (graft
is prefers-everywhere: rg fallback). UI: headless default; `ui:
"interactive"` only on steps whose purpose IS user interaction —
managed headless Chromium, never attach to the user's session.

### 10.7 Completion signals + resume-mode

- Step `signal?: {kind, value}` — `verdict` (step is verdict-bearing;
  phase merges flagged steps' records — supersedes ADR-2's
  `verdict?: boolean`, same invariant INV-2: delegated-only),
  `artifact` (file must exist), `marker` (record carries the marker).
  Router advances a step only on the observed signal; absent signal ⇒
  legacy advance semantics. **Explicit-empty output IS a deliverable**
  — `## Risks: none found` is a line that satisfies the contract;
  the signal checks presence, not volume.
- Resume = step boundary. Interruption (crash/quota) appends
  `run-interrupted`/`quota-parked` ledger events — never `phase-verdict`,
  never burns `maxAttempts`. Re-run happens in `resumeMode`:
  "continue from disk state" (builders read diff+tests as the oracle;
  writers overwrite; appenders dedup-check).
- **Self-loop**: a `loopBackTo`/`loopBackOn` target MAY equal the
  declaring phase (e.g. `implement` walkthrough → back to `build`):
  purge `[phase..phase]` and re-run from step 0, where builders resume
  from disk state rather than restart from scratch.

### 10.8 `kstack init`

Command run **in the target repo**, per-repo, once:

1. **AGENTS.md managed block** `<!-- kstack:begin v1 -->…end` — v1 = 2
   rules (evidence-before-claims, minimalism), authored with
   writing-for-agents. Re-run refused ("already run — use
   `--update`"); `--update` rewrites ONLY the block at the current
   version (never stomps outside markers).
2. **Capability probe** (graft·browse·node·gh·design.exe) →
   `state.capabilities`; for each MISSING capability the report names
   what is lost + an install hint.
3. **Agent defs** — the 5 ported defs installed if absent.
4. **`.kstack/` scaffold** — `runs/`, `ledger/`, config defaults.

Explicitly NOT: repo-hints caching (Dockerfile/CI detection) —
`enabled:"auto"` resolves at runtime, never stale-cached at init.

### 10.9 Language + authoring gate

All artifacts and inter-agent communication are English (AGENTS.md
rule); the main agent replies in the user's language. Every new/revised
`kstack-*` skill passes `.devin/skills/authoring-skills` pipeline
(Phases 0-4 + pre-flight; baseline/evals on live runs).

### 10.10 New verdict vocabulary

`walkthrough == pass|fail` · `ui == pass|fail` · `outcome ==
verified|persists|refuted` · `pipeline == approved|rejected` join the
whitelist; `fail|persists|refuted` join `NEGATIVE_VALUES`. Routing vars
(facts): `parallel-safe`, `feedback-type` — see §4 vocabulary.

### 10.11 Parallel lanes (sprint.implement)

Engage iff ALL three hold (INV-14): `vars.scope == "mixed"` ∧ panel
opt-in (`asks: parallel`, default no, asked only when scope==mixed) ∧
`vars["parallel-safe"] == "true"` (emitted by backlog.tasks — 0
cross-role deps ∧ BE∩FE file-set = ∅, read from tasks.md). Missing var
⇒ sequential (safe default). Lanes:
`(backend→be-walk) ∥ (frontend→fe-walk→ui-check)`. File-set disjointness
makes per-lane resume clean — a lane resumes independently without
re-running the sibling.

### 10.12 Ephemeral subagent execution model

Every delegated step: `spawn → work → report → exit`. Shared memory =
artifacts + records + ledger, NEVER live processes. Prompt caching is
provider-side prefix caching: the step task template puts STABLE
context first (role, skill digest, repo facts) and feedback/retry
context LAST. Optional persistent session only for intra-phase
bounded loops (verifier held during its own gate) — decided per phase.

**Check ordering by cost**: cheap checks near the producer
(walkthroughs inside implement), expensive checks once downstream
(risk-scan in main pre-gate; qa-browsing BEFORE devsecops-review).

### 10.13 Verifier artifact rule

Verifier steps (qa, devsecops code/security, docker, pipeline) write
NO repo files — findings ride the record's `--evidence` (or
`--deliverable` → file under `.kstack/runs/<runId>/` when massive).
For verdict-flagged steps `--evidence` is a PATH LIST: each entry a
file under `.kstack/runs/<runId>/` carrying the same `name == value`
lines (the cross-checked dual channel — §3). For unflagged steps
`--evidence` may be inline text. Supersedes the sprint
`artifactForVariable` naming scheme (`devsecops/*-artifact_XX.md`,
`qa-artifact_XX.md`) for all new verdict phases; sprint keeps stamped
names during the migration window only.

### 10.14 Skill placement summary

Ambient AC banks `kstack-acceptance-criteria-{be,fe}` — always
scope-conditional: sprint `backlog.tasks`, `implement.{backend,
frontend}`, `qa-browsing.test`; develop `implement.build`,
`qa-browsing.test`. `kstack-ponytail` ambient on builder steps;
`kstack-writing-for-agents` ambient for retro/init authoring. Full
per-skill status table: `Kstack/workflow-redesign.md` §"New/modified
skills".

### 10.15 `review` own-lane encoding (ADR-24)

The `findings → fix → findings` cycle uses an **edgeless publish-
verdict** plus an auto-gated fix — no forward loop edge:

```
findings  verdict-bearing, NO loop edge ⇒ publish-only
          rejected|approved → lastVerdicts["findings"], advance
qa-browsing  (unchanged)
comment      skipWhen: target==own
fix          skipWhen: target==external
             enabled:"auto"  autoWhen: lastVerdicts.findings.code-review != "approved"
                                  || lastVerdicts["qa-browsing"]?.status == "red"
             onComplete → findings   (backward; attempts[findings] bounded)
```

`qa-browsing` publishes its `status` too — a red UI finding on approved
code still routes to `fix` (consumes the otherwise-consumerless
verdict). Purge `[findings..fix]` re-runs qa-browsing each cycle, so
its status is always fresh.

- `enabled:"auto"`/`autoWhen` RE-EVALUATES when the phase is reached —
  the panel resolution at run start is display-only; `lastVerdicts` is
  populated mid-run, so arrival-time evaluation is REQUIRED (this is the
  general rule for all auto phases, not review-specific).
- findings `rejected` ⇒ advance → qa-browsing → fix runs → onComplete
  re-enters findings (attempts++, retryContext) → re-review.
- findings `approved` ⇒ fix `autoWhen` resolves off ⇒ fix auto-skips ⇒
  `onComplete` never fires (INV-16) ⇒ retro. Terminates cleanly.
- Ceiling: `maxAttempts` on `findings` bounds the whole cycle; exhausted
  ⇒ `loop-exhausted:findings` park.
- `lastVerdicts` carries ONLY expectation-map-validated values — fix
  reads the validated verdict, never an unvalidated `--var` (the
  rejected gating alternative).
- Parallel lanes: `state.lanes[laneId].stepIndex` holds per-lane step
  cursors (INV-14); scalar `stepIndex` remains for the sequential path.
- `phase.optional` is retired at T10 — `enabled` + derived skippability
  cover it; legacy states load as `enabled:"on"`.

---

## OPEN QUESTIONS: none — all frontier decisions resolved interactively
(round 1: verdict channel/records, per-step flags, multi-target,
onComplete; round 2: derived registry, devsecops-only freeze, canonical
records, full live runs on agnes-3.0-flash; round 3: 6-workflow catalog,
asks/enabled/ambient/ephemeral machinery, capabilities, resume-mode,
kstack init — all in §10).
