# Architecture Decision Review

This document contains the official history of approvals and Architect directives for each Sprint of the project.

---

## Architectural Assessment: Sprint 01 — S4 workflow step-migration + generalized verdict engine

### Summary

The Planner produced a coherent standalone design, but it contradicts the two
authoritative inputs it was told to refine: the user-approved T1 spec
(`Kstack/workflow-redesign.md`, committed e759d41 — 6-workflow catalog, full S4
machinery) and the S4 machinery already landed in the working tree
(`orchestrator/types.ts` diff, `runtime/bin/kstack-report`, `state.ts` v5,
`ledger.ts` "report" event). Implemented as written, this design would build a
second, incompatible step model on top of the one the codebase is already
growing, resurrect four workflows the user approved for removal, and leave two
approved workflows undesigned.

### Analysis and Critical Issues

- 🔴 **Critical Inconsistencies:**

  1. **Workflow catalog contradicts the approved T1 spec.** `system-design_01.md`
     §6 decomposes `qa`, `qa-report`, `ship` and `quick` — all explicitly marked
     **REMOVED** in `Kstack/workflow-redesign.md:103-123`; the approved final
     catalog is 6 workflows (`develop · sprint · investigate · review ·
     discover · audit`, `workflow-redesign.md:217-221`). `discover` and `audit`
     are absent from the design entirely, though the spec lists them as S4
     deliverables (`:73-77`). Failure scenario: implement migrates four dead
     workflows and ships none of the two approved new ones; T9's registry→step
     map then validates against a catalog that was never supposed to exist.
     The doc never mentions the discrepancy; no ADR re-opens it (ADR-log_01.md
     has no entry on the catalog).

  2. **Machinery spec conflicts with S4 types already in the working tree.**
     The uncommitted `types.ts` diff implements the approved spec's machinery;
     the design re-specifies it differently on four load-bearing fields:
     - Design `WorkflowStep.verdict?: boolean` (§2, ADR-2) vs landed
       `signal?: { kind: "verdict" | "artifact" | "marker"; value: string }`
       (`orchestrator/types.ts:77`) — two competing verdict-declaration
       mechanisms; the landed one additionally carries the expected var name.
     - ADR-10 `WorkflowStep.skipWhen?: (ctx) => boolean` vs landed declarative
       `skipWhen?: { var: string; equals: string }` (`types.ts:40`) — function
       form cannot express the spec's `scope:`/`target:` data conditions.
     - Design `WorkflowPhase.sideEffect?: boolean` (§8.2) vs landed step-level
       `sideEffect?: true` (`types.ts:64`) — wrong granularity: the spec's
       `review.comment/post` ⚠ gate is a *step* inside a non-side-effect
       phase (`workflow-redesign.md:139`); a phase flag cannot express it.
     - Design invents `WorkflowPhase.onComplete` (§5, ADR-4) while ignoring
       landed `parkOn` (`types.ts:181`), which the spec uses for
       severity-routing (`workflow-redesign.md:279-280`).
     - `version → 5` framed as a new change (§8.2, INV-10) — v5 is already
       in the type union (`types.ts:327`) and `createState` already writes it
       (`state.ts` diff, `version: 5`). INV-10's "v4 states load with
       record-protocol defaults" describes a version line that no longer
       exists.

  3. **`kstack-report` redesigned as new while already landed with a different
     contract.** §3/§8.1 specify `--run --phase --step --summary --deliverable
     --evidence <path> --status --rationale [--blockers] [--var <name> --value
     <v>]`; the existing `runtime/bin/kstack-report` accepts `--workflow
     --run-id --phase [--step] [--attempt] [--verdict K==V]... [--var K==V]...
     [--evidence <text>]... [--deliverable <path>]... [--marker]... [--summary]`
     (`runtime/bin/kstack-report:9-14`), and `ledger.ts:44-60` already wires
     the `"report"` event + `.kstack/runs/` record path. Rebuilding to the
     doc's flag set breaks the landed producer and every task template that
     will be generated against it — pure churn with no ADR justifying the
     flag-level redesign (ADR-1 ratifies the *concept*, which the code already
     embodies).

  4. **Every §6 decomposition diverges from the approved spec — silently.**
     - `develop`: spec has 8 phases with 5-step plan
       (`evolve→interrogate→draft→eng-review→design-review`),
       `build→walkthrough→ui-check` implement with self-loops, `asksScope`,
       `ambientSkills`, `retro` (`workflow-redesign.md:24-33`). Design ships a
       different 8-phase shape: 3-step plan, `mindrun→build→self-check`, no
       walkthrough/ui-check loops, no scope, no ambient, no retro (§6).
     - `investigate`: spec adds `explore` scout, `triage→repro` two-step
       reproduce, `trace→validate` root-cause, `retro` (`:89-101`). Design
       keeps the legacy 5-phase shape without triage/validate/retro (§6).
     - `sprint`: approved light-review is 14 phases incl. architect-gate
       repositioned **before** backlog (`:241-257`), separate
       docker-review/pipeline-review phases, archive + retro. Design's
       6-phase sprint (`system-design/implement/devsecops-review/qa-verdict/
       architect-gate/commit-archive`) matches neither the spec nor the
       current code (`workflows.ts:437-597` — which already has 10 phases).
     - `review`: spec has `explore`, `qa-browsing`, `asks:target` forking
       `comment` (⚠) vs `fix`, `retro` (`:133-145`). Design: `diff /
       findings / fix` only (§6).

  5. **Machinery required by the approved decompositions is absent from the
     change list.** §8 never mentions `ambientSkills`, `asks`/`state.vars`,
     `requires`/`prefers` capability gates, `ephemeralArtifacts`,
     `enabled`/`autoWhen`, `produces`/`needs` derived-skippability, parallel
     lanes, `resumeMode`, or `signal` completion — all landed in `types.ts`
     and all load-bearing in the approved spec (e.g., `qa-browsing` needs
     `requires: browse`; `docker-review` needs `enabled: auto`; scope-
     conditional steps need `asks`+vars+declarative `skipWhen`). A build
     following §8 cannot implement the spec it claims to refine.

  6. **Forward `loopBackTo` breaks purge/attempt semantics.** §6 qa gives
     `test` (index 1) `loopBackTo: fix` (index 2) — a *forward* edge under a
     field named and built for back-edges; same hack in `ship.review→fix`.
     The loop engine purges results across `[target..gate]`
     (`product-capability_01.md` C10, `verdicts.ts` loop semantics): a
     forward target makes that span inverted — either a no-op purge (fix
     re-enters with stale context) or an indexing bug; `attempts[target]++`
     then counts ceiling on a phase that was never re-entered, while INV-4
     only guards `onComplete`'s direction, leaving `loopBackTo` direction
     unconstrained. The approved spec expresses the same fix-retest cycles
     without forward loopBackTo (verdict loops + step self-loops).

  7. **§2 domain model is a regression against the working tree.** The
     designed `Phase`/`Step` records drop `enabled`, `autoWhen`, `produces`,
     `needs`, `parkOn`, `asks`, `vars`, `capabilities`,
     `ephemeralArtifacts`, `resumeMode`, `ambientSkills`, `requires`,
     `prefers`, `ui`, `signal` — all present in `types.ts` today. Merging
     T10's legacy-field removal with this model would delete landed S4
     surface along with the legacy fields.

- 🟡 **Warnings & Risks:**

  - **Verdict var vocabulary incomplete.** Spec requires new vars
    `walkthrough`, `ui`, `pipeline`, `parallel-safe`, `feedback-type`
    (`workflow-redesign.md:300-303`); §4 adds only `outcome`. The
    `(workflow,phase)` expectation map cannot route the approved gates
    without them.
  - **Capability-vs-design drift:** `product-capability_01.md` C6 still gates
    verdict parsing on `isLastStep` (`:35-36`); ADR-2 eliminates `isLastStep`.
    C6's `phase.loopBackTo`-gated parse also can't cover verdict-bearing
    phases with no loop edge (e.g., spec's `comment` verdict). The capability
    doc was not reconciled — QA will test a gate the design removed.
  - **User-story/catalog drift:** `user-story_01.md` still requires loops for
    `qa`/`ship` (AC-3) on workflows the approved spec deletes — the sprint's
    own artifacts disagree; the design should have forced the reconciliation
    (update the story or ADR the catalog decision), not silently picked one.
  - **`--evidence` semantics differ** between doc (path list) and landed CLI
    (`--evidence <text>` repeatable, `runtime/bin/kstack-report:38`) — the
    dual-channel cross-check spec must be re-stated against the real flag.

- 🟢 **Approved Elements:**

  - `(workflowId, phaseId)`-keyed `PHASE_EXPECTATIONS` (ADR-7) — correct and
    mandatory: current keys are bare phase ids (`verdicts.ts:68-77`) and
    `report`/`verify`/`review`/`test`/`fix`/`implement` collide across
    `workflows.ts` — a real C7-class hazard.
  - `loopBackOn` multi-target routing (ADR-3) — matches the landed type
    (`types.ts:175`) and the investigate `persists→fix / refuted→root-cause`
    requirement.
  - Record-based verdict channel + record↔evidence dual-channel cross-check
    (§3) — preserves the `verifyArtifactVerdicts` guarantee
    (`verdicts.ts:281-296`) while removing planted-string surface.
  - Freeze stays devsecops-only (ADR-6) — consistent with `isSecurityFrozen`
    scope today.
  - Generalizing the deterministic-subagents guard beyond `workflow.id ===
    "sprint"` (§4) — correctly extends `command.ts:323`.
  - Per-target attempt ceilings — consistent with the `attempts[]` model.
  - Deleting `isRefutedStrategy`/`isValidatedStrategy` text-sniffing —
    refuted as a first-class var is the right direction.

## Final verdict

**Rejected.** The design is internally sound but anchored to the wrong base:
it refines the legacy codebase instead of the approved `workflow-redesign.md`
spec and the S4 machinery already landed in the working tree. Before
resubmission the Planner must: (1) reconcile the workflow catalog — 6
workflows per the approved spec, with the `qa/qa-report/ship/quick` removals
and `discover`/`audit` additions either adopted or explicitly ADR'd back; (2)
re-state §6 decompositions to match the approved per-workflow tables; (3)
align every machinery item with `types.ts` as committed (`signal`,
declarative `skipWhen`, step-level `sideEffect`, `parkOn`, `enabled`,
`ambientSkills`, `requires`/`prefers`, `ephemeralArtifacts`, `resumeMode`,
v5) — documenting deltas as ADRs where the design genuinely intends to change
landed behavior; (4) specify `kstack-report` as it exists
(`--workflow/--run-id/--verdict/--var/--marker` contract) or justify a flag
migration; (5) eliminate forward `loopBackTo` edges in favor of the spec's
verdict/step-loop model; (6) update `product-capability_01.md` C6 and the
var vocabulary (`walkthrough`, `ui`, `pipeline`, `parallel-safe`,
`feedback-type`) to match.

## software-architect-review == rejected
