# Architecture Decision Review

This document contains the official history of approvals and Architect directives for each Sprint of the project.

---

## Architectural Assessment: Sprint 01 — S4 workflow step-migration + generalized verdict engine (revision 2)

### Summary

The revision genuinely resolves all seven critical issues from the first
review: the catalog now matches the approved 6-workflow spec (ADR-11, §10.1)
with `§6` explicitly superseded by `Kstack/workflow-redesign.md`; the domain
model is anchored to the landed `types.ts`/`kstack-report` surface with honest
LANDED/PENDING marking (verified on disk); the verdict vocabulary is complete;
and every §8 machinery item exists in the change list. However, one AC-3-named
loop is still unbuildable as written: the `review` workflow's `target:own`
lane requires a verdict-driven `findings → fix` route, and no legal encoding
exists under the stated rules — every concrete option contradicts a written
constraint, while the literal decomposition yields a dead verdict plus a
guaranteed infinite cycle.

### Analysis and Critical Issues

- 🔴 **Critical Inconsistencies:**

  1. **The `review` own-lane loop has no consistent encoding under the stated
     machinery — and the literal spec produces a dead verdict or an infinite
     cycle.** AC-3 requires `review (target:own → fix→findings bounded)`
     (`user-story_01.md:44-46`); the approved spec declares `findings` (phase
     2) with `verdict code-review` and `fix` (phase 4b) with
     `skipWhen: target:external; bounded loop → findings`
     (`Kstack/workflow-redesign.md:140-144`), and `system-design_01.md:220`
     acknowledges only the back-edge (`fix→findings` via `onComplete`). The
     forward trigger — how `code-review == rejected` reaches `fix` — and the
     termination gate are unspecified, and every candidate encoding fails:

     - **Forward `loopBackOn: {rejected: "fix"}`** (fix at index 4b > findings
       at 2): purge semantics for forward targets are undefined — C10 defines
       loop-back purge as `[targetIndex..gateIndex]`
       (`product-capability_01.md:49-52`), §4's routing table says only
       "purge span" (`system-design_01.md:184`), and INV-4 constrains only
       `onComplete` direction (`system-design_01.md:68-70`). This is the same
       defect class as prior rejection issue #6 (forward `loopBackTo` in the
       superseded §6, `system-design_01.md:271,283,294`): the revision removed
       the declared forward edges but not the requirement that still needs
       one.
     - **No loop edge on `findings` + gate `fix` via `enabled:"auto"`:**
       fails C6 — verdict parsing is gated on
       `phase.loopBackTo|loopBackOn && verdictsEnabled() && step.signal`
       (`product-capability_01.md:37-40`, matching today's `state.ts:210-224`
       gate), so an edgeless `findings` never parses → `pendingVerdict` never
       populates → `autoWhen` has nothing to read → `fix` never enables →
       the own lane is dead.
     - **Findings emits a `--var` routing var instead:** gates `fix` on an
       unvalidated fact channel — bypasses the expectation-map re-validation
       that makes the verdict channel fail-closed (C37,
       `product-capability_01.md:137-140`; trust boundary
       `product-capability_01.md:149-151`), and is not written anywhere.

     And even granting the forward jump, the loop never terminates on
     approval: `findings` approved → advance → `qa-browsing` → `comment`
     skipped (own) → `fix` — `skipWhen:{var:target, equals:external}`
     evaluates false → fix runs → `onComplete` → `findings` → ... bounded
     only by the attempts ceiling ⇒ **every own-target review run ends
     `loop-exhausted`-parked**, and the `code-review` verdict never affects
     routing. Failure scenario: the T-review implementation either ships a
     workflow that always exhausts its ceiling on the own lane, or the
     implementer invents a routing semantic mid-build — exactly what this
     design phase exists to prevent. The spec must name the encoding
     (sanctioned forward `loopBackOn` with defined purge semantics, or a
     C6-amended signal-gated verdict read by `enabled:"auto"`/`autoWhen`)
     plus `fix`'s termination condition on re-advance.

- 🟡 **Warnings & Risks:**

  - **`--evidence` path-vs-text ambiguity.** §3's record↔evidence cross-check
    requires "each evidence file must exist and contain the same `name ==
    value` lines" (`system-design_01.md:165-167`), but §10.13 says "findings
    ride the record's `--evidence`" (`:558-560`) which reads as inline text,
    and the CLI accepts any string (`runtime/bin/kstack-report:45`). A
    verifier emitting inline findings fails the dual-channel check → every
    gate parks. The spec must state that flagged steps pass *paths* to
    finding files under `.kstack/runs/<runId>/` carrying the verdict lines.
  - **Three overlapping skippability mechanisms.** `optional: boolean`
    (required, `types.ts:121`), `enabled` (`:154`), and `produces`/`needs`
    derived skippability (`:167-168`) coexist; the design never states
    whether T10 retires `optional` or how the panel reconciles them.
  - **Parallel-lane state representation unspecified.** INV-14/ADR-22 require
    "per-lane stepIndex state" but `WorkflowState.stepIndex` is scalar
    (`types.ts:291`); §8's change list does not itemize the lane-state field
    (`system-design_01.md:380-383`).
  - **C22 sprint-last ordering invisible in the backlog.** The capability doc
    requires sprint's own decomposition to land last to protect THIS run's
    live state (`product-capability_01.md:94-96`), but `tasks.md:86-93`
    groups all six workflow ports into one unordered task.
  - **`review.comment` `requires:[gh]`** silently skips the external lane's
    only deliverable (ledger note only) when gh is absent
    (`workflow-redesign.md:142`; requires semantics `types.ts:42-46`) —
    defensible, but a park-fallback would be safer; record the choice.

- 🟢 **Approved Elements:**

  - **Catalog reconciliation** — 6 workflows, `qa`/`qa-report`/`ship`/`quick`
    removed, `discover`/`audit` added (ADR-11, `system-design_01.md:430-434`),
    matching the user-approved spec (`workflow-redesign.md:220-224`) and the
    Kstack.md S4 amendment (`Kstack.md:382-391`).
  - **Domain model = landed types** — `signal`/`ambientSkills`/declarative
    `skipWhen`/`requires`/`prefers`/`ui`/step-level `sideEffect`
    (`types.ts:33-77`), `enabled`/`autoWhen`/`produces`/`needs`/`loopBackOn`/
    `parkOn` (`:154-181`), `asks[]` (`:202-213`), `vars`/`capabilities`/
    `ephemeralArtifacts`/`resumeMode`/v5 (`:309-327`) — all verified on disk;
    `onComplete` honestly marked PENDING (`system-design_01.md:365-367`).
  - **`kstack-report` specified as-built** — flag contract and record schema
    match the landed CLI verbatim (`runtime/bin/kstack-report:9-14,128-140`);
    the verdicts/vars separation (judgments vs facts) is architecturally
    correct and matches `ledger.ts:47` event kinds.
  - **`(workflowId, phaseId)`-keyed expectations** (ADR-7) — mandatory fix:
    current keys are bare phase ids (`verdicts.ts:68-77`) and `verify`/
    `fix`/`review`/`test`/`report`/`implement` collide across
    `workflows.ts`.
  - **Record-based verdicts + dual-channel evidence** — preserves the
    `verifyArtifactVerdicts` guarantee (`verdicts.ts:281-296`) while
    shrinking the planted-string surface.
  - **Routing order** `parkOn` → `loopBackOn` → `loopBackTo` → advance, with
    unmapped negatives parking and `feedback-type==spec` parking — fail-closed
    throughout (`system-design_01.md:184`).
  - **Self-loop sanction** (`§10.7`) cleanly resolves develop's
    within-phase `walkthrough→build`/`ui-check→build` loops.
  - **Deterministic-subagents guard generalization** — correctly extends the
    sprint-only guard at `command.ts:323` to any looped workflow.
  - **Artifact lifecycle triad** (ephemeral/durable/handoff, ADR-15/§10.5)
    and the devsecops-only freeze decision (ADR-6) are consistent with
    existing machinery scope.
  - **Honest deletion list** — `isRefutedStrategy`/`isValidatedStrategy`/
    `isLastStep`/`mergeParseOutcomes` retirement is correctly scoped to
    post-migration (`system-design_01.md:399-401`).

## Final verdict

**Rejected — narrowly.** The revision is ~95% aligned and demonstrates the
planner integrated the prior feedback faithfully; the single blocker is the
`review` own-lane loop, which AC-3 names explicitly and which no written rule
encodes correctly. Required before resubmission:

1. **Pick and declare the `findings → fix` encoding for `target:own`** —
   either (a) sanction forward `loopBackOn` targets with defined semantics
   (purge results across the skipped span `(gate..target)`,
   `attempts[target]++`, `retryContext` to the target), recorded as an ADR;
   or (b) relax C6's parse gate to `verdictsEnabled() && step.signal` so an
   edgeless `findings` still parses and `fix` gates via
   `enabled:"auto"`/`autoWhen` on the parsed verdict.
2. **Specify `fix`'s termination gate on re-advance** — e.g.
   `enabled:"auto"` with `autoWhen` reading `state.retryContext`/last
   verdict, or an explicit emitted routing var — so an approved re-review
   terminates at `retro` instead of re-entering `fix` until the ceiling.
3. **Write both into the review spec table** and reconcile
   `product-capability_01.md` C6/C10 to match.
4. **Disambiguate `--evidence`** (path list vs inline text) for flagged vs
   unflagged steps in `system-design_01.md` §3/§10.13 and the T11 verifier
   skill updates.
5. Recommended (non-blocking): state whether T10 retires the `optional`
   field; itemize per-lane `stepIndex` state for INV-14; sequence sprint's
   own migration last inside `tasks.md` item 10 per C22; consider a
   park-fallback for `comment`'s `requires:[gh]`.

## software-architect-review == rejected
