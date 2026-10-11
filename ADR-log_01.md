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
