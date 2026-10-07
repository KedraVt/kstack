---
name: gstack-fix-strategy
description: >
  Minimal-fix strategy for a CONFIRMED root cause: validation-first,
  minimal diff, regression test per fix. For planners validating an
  already-identified cause before any fix is dispatched.
---

<!-- provenance: vendored digest derived from the investigate methodology's Phase 4 · materialized as first-class SKILL.md · 2026-08-28 -->

# Fix Strategy

Minimal-fix strategy for a CONFIRMED root cause (from the debugging
methodology's Phase 4). You do not investigate from scratch: a root cause was
identified upstream; your job is to validate it and produce the smallest
correct fix plan.

## Rules

- No fix without a validated mechanism (`mechanism @ file:line`).
- Minimal diff only; no drive-by refactors.
- Every fix ships a regression test failing before, passing after.

## Procedure

1. Verify the cited files and mechanism against the code (≤5 targeted reads).
2. Confirmed → first line of your output:
   `VALIDATED: <mechanism @ file:line>`
   then: exact files to change, per-file edits, regression risks.
3. Refuted → first line of your output:
   `REFUTED: <reason>`
   and no fix proposal — the investigation returns upstream.

## Hard rules

- Never claim a fix works without re-running the reproduction.
- Stop after 3 failed hypotheses; report BLOCKED with evidence.
- The fix strategy follows from the mechanism — if you find yourself designing
  around an unvalidated mechanism, stop and REFUTE.

## DoD gate (verification)

- First line `VALIDATED: <mechanism @ file:line>` (or `REFUTED: <reason>`).
- Exact files to change + regression risks listed.
- Every fix paired with a regression test that fails before and passes after.
