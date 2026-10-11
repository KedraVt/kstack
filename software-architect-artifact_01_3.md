# Architecture Decision Review

This document contains the official history of approvals and Architect directives for each Sprint of the project.

---

## Architectural Assessment: Sprint 01 — S4 workflow step-migration + generalized verdict engine (revision 3)

### Summary

The revision resolves the sole blocker from the second review: the `review`
own-lane `findings → fix → findings` cycle now has a legal, written encoding —
an edgeless publish-only verdict phase feeding `state.lastVerdicts`, plus an
`enabled:"auto"`/`autoWhen`-gated fix carrying a backward `onComplete` edge
(ADR-24, §10.15, `workflow-redesign.md:140-143`). The encoding terminates
correctly on approval and is bounded by `findings`' ceiling on rejection.
All claims marked LANDED were verified on disk; the remaining gaps are
spec-text precision issues, not structural defects.

### Analysis and Critical Issues

- 🔴 **Critical Inconsistencies:** None.

- 🟡 **Warnings & Risks:**

  - **INV-5 wording collides with the publish-only rule.** INV-5 states "a
    parsed negative without a map entry ⇒ park, never a default"
    (`system-design_01.md:75-77`), which — read literally — covers an edgeless
    verdict phase (a phase with *no* `loopBackOn` map at all), contradicting
    ADR-24/§10.15 where `findings: code-review == rejected` must publish to
    `lastVerdicts` and *advance* (`system-design_01.md:604-605`). Failure
    scenario: an implementer evaluating "unmapped negative ⇒ park" before the
    edgeless rule parks every rejected `review.findings` instead of advancing —
    the own-lane cycle never engages. Mitigated by five pinning statements
    (§4 routing row, §10.15, C6, C39, `tasks.md:56` "edgeless phase publishes
    to `lastVerdicts` and advances"), but the invariant should carry the
    carve-out explicitly ("on a phase declaring loop edges").
  - **`review.qa-browsing`'s `status` verdict has no declared consumer.** The
    spec emits `verdict status` (`workflow-redesign.md:141`) but names no
    routing target; under ADR-24 defaults it lands publish-only in
    `lastVerdicts["qa-browsing"]`, which `fix.autoWhen` does not read
    (`workflow-redesign.md:143` reads only `findings.code-review`). Failure
    scenario: own-lane run with approved review but red qa-browsing skips
    `fix` and terminates at `retro` with a UI-broken diff. Deterministic and
    non-blocking, but the spec should either extend the autoWhen disjunction
    (`|| lastVerdicts["qa-browsing"].status != "green"`) or mark the verdict
    informational.
  - **Doc drift on sprint's side-effect phase.** ADR-11 and
    `workflow-redesign.md:223-224` claim ship "stays a phase in
    develop·sprint", and `user-story_01.md` AC-9 / `product-capability_01.md`
    C21 still speak of commit-archive parking at its entry gate — but the
    approved sprint table ends at `archive` (file-moving, main, no ⚠) +
    `retro` (`workflow-redesign.md:260-261`); there is no ship/commit phase.
    Functionally consistent with the no-push constraint (the guarantee holds
    trivially), but the texts disagree and AC-9's phrasing is stale.
  - **`requires: browse` asymmetry.** `develop.qa-browsing` declares it
    (`workflow-redesign.md:31`); `review.qa-browsing` does not
    (`workflow-redesign.md:141`) — on a browse-less machine the review step
    would run degraded instead of skipping. Trivial uniformity fix at
    implementation.

- 🟢 **Approved Elements:**

  - **Review own-lane encoding (ADR-24/§10.15)** — traced end-to-end:
    `findings` (delegated, verdict-flagged — satisfies INV-2) is publish-only:
    validated verdict → `state.lastVerdicts["findings"]`, always advances.
    `fix` carries `skipWhen: target:external` + `enabled:"auto"` with
    `autoWhen` re-evaluated at phase arrival +
    `onComplete → findings` (backward, per INV-4). Rejected ⇒ fix runs ⇒
    `onComplete` re-enters `findings`, `attempts[findings]++` bounded by its
    ceiling ⇒ `loop-exhausted` park; approved ⇒ `autoWhen` resolves off ⇒
    auto-skip ⇒ `onComplete` never fires (INV-16) ⇒ `retro`. No forward edge,
    no dead verdict, no infinite cycle. `qa-browsing` keeps its position
    between the gate and the fix — the objection that killed the forward-
    `loopBackOn` alternative. The validated channel stays end-to-end: `fix`
    reads expectation-map-validated `lastVerdicts`, never a raw `--var`.
  - **`product-capability_01.md` reconciliation** — C6 rewritten (edge not
    required, publish-only advances), C39/C40/C41 added; the capability doc
    now matches the design instead of describing a retired gate.
  - **All prior warnings closed** — `--evidence` disambiguated (flagged =
    path list under `.kstack/runs/<runId>/` carrying the `name == value`
    lines; unflagged = inline text, §10.13 + C40); `phase.optional` retired
    at T10 with legacy states loading `enabled:"on"` (§10.15, C41,
    `tasks.md:98`); per-lane `state.lanes[laneId].stepIndex` itemized (§2,
    §10.15, `tasks.md:53`); sprint migration sequenced last per C22
    (`tasks.md:92-96`); `comment`'s `requires:[gh]`→skip recorded as a
    deliberate choice (ADR-24 consequences).
  - **LANDED claims verified** — `types.ts` carries `ambientSkills` (:33),
    declarative `skipWhen: {var, equals}` (:40), `requires`/`prefers` (:46-52),
    `ui` (:58), step-level `sideEffect` (:64), `signal` (:77), `enabled`/
    `autoWhen` (:154-160), `produces`/`needs` (:167-168), `loopBackOn` (:175),
    `parkOn` (:181), `asks[]` (:202-213), `vars`/`capabilities`/
    `ephemeralArtifacts`/`resumeMode` (:309-325), `version → 5` (:327);
    `state.ts:80` already writes `version: 5`. `onComplete`, `lastVerdicts`,
    `lanes` are honestly marked PENDING T2 — the doc does not overclaim.
  - **`kstack-report` specified as-built** — §3's flag contract matches
    `runtime/bin/kstack-report:9-14` verbatim and the record schema matches
    `:128-140`; verdicts-vs-vars separation (judgments vs facts) is the right
    trust split and matches the ledger `kind:"report"` event (:140-142).
  - **`(workflowId, phaseId)`-keyed expectations (ADR-7)** — mandatory:
    current `PHASE_EXPECTATIONS` is bare-phase keyed (`verdicts.ts:68`) and
    `verify`/`fix`/`review`/`test`/`report`/`implement` collide across
    workflows.
  - **Fail-closed routing order** — `parkOn` → `loopBackOn` → `loopBackTo`
    → advance, unmapped negatives park, `feedback-type==spec` parks
    (§4/§7 flow). Deterministic-subagents guard correctly generalized from
    the sprint-only check at `command.ts:323` to any verdict/loop/
    `onComplete` workflow.
  - **Catalog + ordering** — six approved workflows (`workflow-redesign.md`
    all sections APPROVED), port order `develop → investigate → review →
    discover → audit → sprint` with sprint last protecting this run's live
    state (C22, `tasks.md:92-96`); the `kstack-lite-mindrun` verdict-mode gap
    flagged in the spec (`workflow-redesign.md:320`) is itemized in
    `tasks.md:109`.

## Final verdict

**Approved.** The design is internally consistent, anchored to the landed
`types.ts`/`kstack-report` surface, and every functional requirement in
`user-story_01.md` (AC-1 through AC-16) has a corresponding machinery item,
spec section, or task entry. The revision's publish-only-verdict mechanism is
a clean generalization: it resolves the review own-lane cycle without
forward edges, keeps verdicts on the validated channel, and reuses the
existing purge/ceiling machinery for `onComplete` re-entry. Before or during
implementation, fold in the four warnings: (1) add the publish-only carve-out
to INV-5 so "unmapped negative ⇒ park" cannot be read as governing edgeless
phases; (2) declare whether `review.qa-browsing`'s `status` gates `fix` via
the `autoWhen` disjunction or is informational; (3) reconcile ADR-11/AC-9
phrasing with the sprint table's archive-only tail; (4) add `requires: browse`
to `review.qa-browsing`. None blocks implementation.

## software-architect-review == approved
