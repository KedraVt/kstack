# ADR Log — Sprint 01 (S4 workflow step-migration)

Append-only record of decisions taken during this sprint's design phase.
Format: decision / context / consequences.

---

## ADR-1 — `kstack-report` is the delegation completion protocol

**Decision.** Every delegated step ends by invoking a new CLI
(`runtime/bin/kstack-report`, bash) that writes a structured record to
`.kstack/runs/<runId>/<phase>.<step>.json` and appends a ledger event.
Records become the canonical source for step summaries, `{previous}`
plumbing, and gate variables — HANDOFF text survives only as a migration
redundancy.

**Context.** Verdicts today are text-sniffed out of `## HANDOFF` sections —
a channel a planted string can reach and that forced heuristics like
`isRefutedStrategy`/`isLastStep`. Structured records make the contract
explicit, enum-validated, and file-verifiable.

**Consequences.** New CLI + record consumption in the executor; HANDOFF
verdict parsing retires post-migration; `isRefutedStrategy` deleted;
record↔evidence cross-check preserves the dual-channel guarantee. The
protocol is transport — routing stays deterministic and unchanged.

HANDOFF verdict parsing retired (Phase C, 2026-10-21).

## ADR-2 — Verdict authorship is delegated-step only

**Decision.** `verdict?: boolean` on `WorkflowStep`, legal only on
`execution: "subagent"` steps. Phase verdict = merge of flagged steps'
record vars; disagreement ⇒ null ⇒ park. Gate vars in a record from a
non-flagged step ⇒ park; flagged step closing without a record ⇒ park
(no attempt burned). `isLastStep` eliminated.

**Context.** The evaluating context must not be the producing context —
no self-certification. Main steps may emit records only for factual
status where a spec justifies it.

**Consequences.** `devsecops-review` keeps both verdict channels by
construction (code-review step + security step); chain→steps migration
cannot silently drop verdicts; today's dual semantics (chain-merge vs
last-step-only) collapse into one rule.

## ADR-3 — `loopBackOn` for multi-target verdict routing

**Decision.** `loopBackTo` stays single-target (sprint-compat); new
`loopBackOn?: Record<negativeValue, phaseId>` maps verdict values to
targets. A parsed negative without a map entry ⇒ park — never an
implicit default. `maxAttempts` applies per target (existing
`attempts[target]` counters).

**Context.** `investigate.verify` needs `persists→fix` and
`refuted→root-cause` on one gate — the current single-target model can't
express it, and the refuted path was text-sniffed.

**Consequences.** `verify` emits `--var outcome --value
persists|refuted|verified`; `isRefutedStrategy`/`isValidatedStrategy`
deleted; routing stays fail-closed.

## ADR-4 — `onComplete` unconditional back-edge

**Decision.** New `WorkflowPhase.onComplete?: phaseId` — on normal
completion, route to a lower-indexed phase: purge span, per-target
ceiling, exhaustion parks. Serves qa `fix→test`, ship `fix→review`,
review `fix→findings`.

**Context.** Fix cycles need re-entry into the gate from a non-verdict
phase; alternatives (park-per-cycle, contrived fix verdicts) were either
human-costly or dishonest.

**Consequences.** ~20 lines in `advancePhase` + invariants + tests; three
workflows get true bounded fix-retest loops.

## ADR-5 — Registry derived from `skills/`; aliases eliminated

**Decision.** `skills.ts` REGISTRY is replaced by a derived registry:
`skills/` is the catalog, id = dir name, summary read from SKILL.md
frontmatter. `kstack-sprint-*` aliases and
`kstack-document-{release,generate}` are removed; all refs rewritten to
dir names. Optional per-skill dir renames for shorter names: deferred.

**Context.** The alias layer (21 ids → 28 dirs via `dir:`) duplicated
what the filesystem already states and produced id/dir drift
(`kstack-sprint-qa` → `kstack-qa`).

**Consequences.** One source of truth; every catalog skill is addressable
by its own name; T9's manual-only marking applies to catalog skills no
step references.

## ADR-6 — Freeze stays devsecops-only

**Decision.** severity→freeze semantics remain bound to
`security-review == rejected` + critical/high in the sprint workflow.
Panels generalize to non-sprint parks; freeze does not.

**Context.** No non-sprint gate emits severity; generalizing would add
surface for a need that doesn't exist yet.

**Consequences.** `isSecurityFrozen`/`unfreeze`/`freezeInfo` unchanged in
scope; revisit only if a non-sprint gate ever needs freeze.

## ADR-7 — `(workflowId, phaseId)`-keyed expectations

**Decision.** `PHASE_EXPECTATIONS` becomes workflow→phase keyed;
`routeVerdict` receives `workflowId`. Phase ids collide across workflows
(`report`, `verify`, `review`, `test`, `fix`, `implement`) — namespacing
is mandatory, not optional.

**Context.** Bare phase-id keying would let e.g. investigate's `verify`
read ship's `verify` expectations.

**Consequences.** Same variable can mean different things per workflow;
sprint entries migrate verbatim under the `sprint` key.

## ADR-8 — Full live verification on `agnes/agnes-3.0-flash`

**Decision.** Every migrated workflow gets a real verification run whose
delegated steps execute on model `agnes-3.0-flash` (agnes provider in
`~/.pi/agent/models.json`). The API key never enters this repo; the user
rotates it post-test.

**Context.** User requirement — structural tests alone don't prove a
redesigned workflow runs.

**Consequences.** Verification phase carries run records; model override
via existing model-tier config (`modelTierFor`/spawn model param).

## ADR-9 — `sideEffect` flag generalizes the entry gate

**Decision.** `WorkflowPhase.sideEffect?: boolean` marks ⚠ entry-gate
phases (ship `push-pr`, sprint `commit-archive`) — replaces the hardcoded
commit-archive detection; feeds `gateInventory` warnings and the
selection-gate defaults.

**Context.** D20 marks side-effect gates ⚠ with human defaults; push-pr
deserves the same protection commit-archive already has.

**Consequences.** Push/PR actions park pre-run across workflows; the
user's no-push constraint this sprint is naturally enforced at the gate.

## ADR-10 — Step-level `skipWhen`

**Decision.** `WorkflowStep.skipWhen?: (ctx) => boolean` added so
conditional steps (sprint `docker`, `pipeline`) can skip without
phase-level granularity.

**Context.** D19's one-skill-per-step rule splits devsecops into four
steps; docker/pipeline only apply to repos shipping those surfaces
(existing `conditionalSkillIds` precedent).

**Consequences.** Skipped steps record `{status:"skipped"}` results;
entry evaluation mirrors phase skipWhen.
**Amended by ADR-12**: the shipped form is declarative
`{var, equals}` — data resolvable before code runs.

## ADR-11 — Workflow catalog is six, not eight

**Decision.** The approved catalog: `develop`, `sprint`, `investigate`,
`review`, `discover`, `audit`. Removed: `qa` (never used standalone —
real cases covered by `review`'s internal `qa-browsing` + phase-level
qa-browsing), `qa-report` (a `qa` mode), standalone `ship` (survives
as a PHASE inside `develop` only — sprint's new decomposition ends at
`archive`+`retro` with no push phase), `quick` (gstack leftover — "quick" and
"workflow" contradict). Added: `discover` (product-improvement
conversation → `.kstack/discover/direction.md` handoff to develop) and
`audit` (mindrun walk → `.kstack/audit/findings.md` incremental handoff
to investigate).

**Context.** The per-workflow redesign session interrogated each
workflow's right to exist; a workflow earns its slot only when it owns
an artifact/verdict a phase elsewhere cannot produce.

**Consequences.** `workflows.ts` drops four definitions; expectations,
intents and registry entries migrate per `workflow-redesign.md`.

## ADR-12 — `asks[]` run-start inputs + declarative step `skipWhen`

**Decision.** `Workflow.asks[]` — `{var, question, options[], default?,
when?}` asked once at run start (sequential panel); answers land in
`state.vars`. Step `skipWhen` takes the declarative form
`{var, equals}` (data, not a function) — supersedes ADR-10.
`workflow.asksScope` dissolves into the general `asks[]` mechanism
(`scope`, `target`, `parallel` are ordinary asks).

**Context.** develop needs scope (fe/be/mixed), review needs target
(external/own), sprint needs parallel — same shape: a question whose
answer is a routing var. Declarative conditions are evaluable by the
panel, the skip evaluator and tests without invoking repo code.

**Consequences.** `state.vars: Record<string,string>` sanitized on load;
missing vars resolve to safe defaults (`parallel-safe` absent ⇒
sequential).

## ADR-13 — `enabled: on|off|auto` + derived skippability

**Decision.** Every phase carries `enabled` (absent = on); `auto`
resolves via `autoWhen(ctx)` on computable state (file presence,
touched diff, tasks.md) — "user choice" phases are `auto`+override.
Skippability is derived from `produces[]`/`needs[]`: a phase is
skippable iff no enabled phase needs its output.

**Context.** Optional phases were a blunt instrument: the engine already
knows whether docker-review applies (Dockerfile touched). Computed
skippability makes a broken run impossible by construction.

**Consequences.** `autoWhen` predicates live on the phase; the panel
renders resolved `auto` values plus user overrides.

## ADR-14 — `ambientSkills` outside the task-skill slot

**Decision.** `WorkflowStep.ambientSkills?: string[]` injects behavioral
skills (ponytail, AC banks, writing guides) alongside the task —
restated rule: 0-1 task-skill per step, ambient separate. Entries may
be scope-conditional.

**Context.** AC banks and minimalism rules are cross-cutting behavior,
not the step's methodology — mixing them into `skill` would break the
0-1 contract that keeps step prompts focused.

**Consequences.** Ambient digests ride the same delivery path as task
skills but a distinct slot; catalog gains
`kstack-acceptance-criteria-{be,fe}` as ambient-marked skills.

## ADR-15 — Artifact lifecycle: ephemeral, durable, handoff

**Decision.** Three classes: (a) `state.ephemeralArtifacts[]` — deleted
at run terminal status (THINK docs consumed in-run: understand.md,
plan.md, bug-report.md); (b) durable `_XX` archive docs
(system-design_XX, ADR-log_XX only); (c) cross-run handoff under
`.kstack/<workflow>/` — independent lifetime, never ephemeral-deleted,
outside the project root.

**Context.** discover's direction.md must outlive its run to feed
develop; audit's findings.md feeds investigate. Project-root files were
polluting repos; full-ephemeral would kill handoffs.

**Consequences.** Cleanup runs at terminal status + ledger event;
`.kstack/<wf>/` dirs are scaffolded by `kstack init`/on first write.

## ADR-16 — Capability model + UI contract

**Decision.** `state.capabilities` (probed by `kstack init`): `graft`,
`browse`, `node`, `gh`, `design`. Step `requires:` missing ⇒ skip;
`prefers:` missing ⇒ degrade + `~capability: no-<cap>` note (graft is
prefers-everywhere — rg fallback). `capability.ui`: headless default;
`ui:"interactive"` only where user interaction IS the purpose (login,
captcha, inspect). Managed headless Chromium; never attach to the
user's visible session.

**Context.** graft is fundamental but not universal; browse can pop
windows — the contract makes both explicit instead of ambient.

**Consequences.** No step absolutely requires graft; qa-browsing is the
main `requires: browse` user; UI violations block at the capability
boundary.

## ADR-17 — Completion signals + step-boundary resume

**Decision.** `WorkflowStep.signal?: {kind:"verdict"|"artifact"|"marker",
value}` — the router advances a step only on the observed signal
(record verdict var / artifact exists / record marker). `verdict`-
signaled steps ARE the verdict-bearing steps (supersedes ADR-2's
`verdict?: boolean` — same invariant: delegated-only). Interruption
(crash/quota) appends `run-interrupted`/`quota-parked` — never
`phase-verdict`, never burns `maxAttempts`; re-run is `resumeMode`:
continue from disk state (builders: diff+tests oracle; writers
overwrite; appenders dedup-check).

**Context.** Ghost main-steps advanced on nothing; crash and verdict
rejection were indistinguishable in the counters.

**Consequences.** Signal declaration is the step's honest contract;
infra events are first-class ledger kinds.

## ADR-18 — `kstack init`: per-repo, versioned, non-destructive

**Decision.** `kstack init` runs in the target repo, once: writes the
managed block `<!-- kstack:begin v1 -->…end` (v1 = 2 rules:
evidence-before-claims, minimalism), probes capabilities, installs
missing agent defs, scaffolds `.kstack/`. Re-run ⇒ "already run — use
`--update`"; `--update` rewrites only the block to the current version +
re-probes + reinstalls defs — never stomps outside markers.

**Context.** Behavioral rules must reach spawned subagents; AGENTS.md
managed block is the deterministic channel. Versioning lets future rule
additions land without forcing re-init.

**Consequences.** init.ts extends (markers gain the version suffix);
capability probe feeds `state.capabilities`.

## ADR-19 — Language + skill authoring gate

**Decision.** All artifacts and inter-agent communication are English
(docs, skills, ephemeral files, subagent briefs and reports); the main
agent replies in the user's language. Every new/revised `kstack-*`
skill passes `.devin/skills/authoring-skills` (Phases 0-4 + pre-flight;
baseline/evals on live runs).

**Context.** Mixed-language artifacts degrade every future consumer;
the authoring pipeline is the standing quality bar.

**Consequences.** Working rules recorded in AGENTS.md; the four S4
skills were revised against the canons (static phases) as their first
application.

## ADR-20 — Extended verdict vocabulary

**Decision.** `walkthrough == pass|fail`, `ui == pass|fail`,
`outcome == verified|persists|refuted`, `pipeline == approved|rejected`
join the whitelist; `fail`, `persists`, `refuted` join
`NEGATIVE_VALUES`. Routing vars `parallel-safe`, `feedback-type` are
`--var` facts, not verdicts.

**Context.** The redesigned workflows emit these vars (walkthroughs,
ui-checks, investigate verify, pipeline-review); severity keeps its own
whitelist.

**Consequences.** `VALUE_WHITELIST`/`NEGATIVE_VALUES` extend;
expectations entries per (workflow,phase) in `verdicts.ts`.

## ADR-21 — `parkOn`, severity as ordinary var, `feedback-type`

**Decision.** `WorkflowPhase.parkOn?: Record<value, "park"|"freeze">` —
park mode per verdict value, evaluated BEFORE `loopBackOn` and advance
(park wins). `severity` becomes an ordinary var: its outcome is declared
per phase via `parkOn` — devsecops gets `{red: "freeze"}` (the D3
typed-unfreeze); every other workflow gets standard park semantics.
`feedback-type` is a routing var: `code` (default) ⇒ normal loop
routing; `spec` ⇒ PARK — the human decides whether to reopen backlog;
a broken spec never auto-re-runs tasks.

**Context.** Severity→freeze was sprint-hardcoded; generalizing parks
to non-sprint workflows needed the outcome configurable per phase.
Reviewers emitting `feedback-type: spec` protect the backlog from
auto-loops on spec defects.

**Consequences.** INV-12 asserts parkOn precedence; devsecops freeze
survives unchanged as `(sprint, devsecops-review)` config, not a
special code path.

## ADR-22 — Parallel lanes in sprint.implement

**Decision.** Parallel lanes `(backend→be-walk) ∥ (frontend→fe-walk→
ui-check)` engage iff `vars.scope=="mixed"` ∧ panel opt-in
(`asks: parallel`, default no, shown only when scope==mixed) ∧
`vars["parallel-safe"]=="true"` (emitted by backlog.tasks: 0 cross-role
deps ∧ BE∩FE file-set = ∅). Absent var ⇒ sequential. File-set
disjointness makes per-lane resume clean.

**Context.** Parallel was repeatedly raised; the gate makes it
opt-in-only-when-provable rather than a structural executor feature
(S5 DAG stays out of scope).

**Consequences.** INV-14; per-lane stepIndex state; lanes never share
attempt counters.

## ADR-23 — Ephemeral subagent execution model + verifier artifacts

**Decision.** Delegated steps are `spawn→work→report→exit` — shared
memory is artifacts+records+ledger, never live processes. Prompt
caching relies on provider-side prefix caching: task templates put
stable context first, feedback last. Optional persistent session only
for intra-phase bounded loops. Checks order by cost: cheap near the
producer (walkthroughs), expensive once downstream (qa before
devsecops). Verifier steps write NO repo files — findings ride
`--evidence`/`--deliverable` under `.kstack/runs/<runId>/`, superseding
`artifactForVariable` stamped names for new phases.

**Context.** Live subagent processes cannot be shared memory (crashes,
resume); stamped artifact paths were the last sprint-coupled channel.

**Consequences.** Executor treats every delegation as cold-start;
`artifactForVariable` retires for new workflows; `kstack-qa` and the
devsecops skills drop file-writing from their contracts (T6 updates).

## ADR-24 — Edgeless publish-verdicts + `lastVerdicts` (review own-lane)

**Decision.** The parse gate becomes `verdictsEnabled() && ≥1
signal-verdict delegated step` — a loop edge is NOT required. A
verdict-bearing phase WITHOUT edges is *publish-only*: the parsed,
expectation-map-validated verdict is written to
`state.lastVerdicts[phaseId]` (`Record<phaseId, Record<var,value>>`)
and the phase advances. Downstream phases consume the VALIDATED value:
`review.fix` carries `enabled:"auto"` +
`autoWhen: lastVerdicts[findings].code-review != "approved" ||
lastVerdicts["qa-browsing"]?.status == "red"` (red-UI findings on
approved code still get patched — consumes the qa-browsing verdict)
plus the declarative `skipWhen: target:external`, and `onComplete: findings`
(backward, bounded by `findings`' ceiling). `autoWhen` RE-EVALUATES at
phase arrival — panel resolution is display-only; `lastVerdicts`
populates mid-run. An approved re-review ⇒ `autoWhen` resolves off ⇒
fix auto-skips ⇒ `onComplete` never fires ⇒ retro. `optional` phase
field is RETIRED at T10 — `enabled` + derived skippability covers it.
Parallel-lane step state lands as `state.lanes[laneId].stepIndex`
(scalar `stepIndex` stays for the sequential path).

**Context.** Architect rejection #2: the own lane needed a verdict
→fix→re-review cycle with no legal encoding. Forward `loopBackOn` was
rejected: it would skip `qa-browsing` (which sits between findings and
fix AND must verify UI-touching findings pre-patch), and it still
required a separate termination gate. Gating `fix` on an emitted
`--var` was rejected: unvalidated facts bypass the fail-closed
expectation-map check. The publish-verdict keeps the validated channel
end-to-end.

**Consequences.** C6 rewritten (edge optional). `--evidence` clarified:
flagged steps pass file PATHS under `.kstack/runs/<runId>/` carrying
the `name == value` lines (dual channel); unflagged steps may pass
inline text. `review.comment` keeps `requires:[gh]`→skip semantics
(uniform capability rule; ledger note + summary surface the loss —
no third mechanism).
