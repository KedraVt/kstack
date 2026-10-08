# Briefing Template — mindrun-briefing.md

Fill this in during Phase 0, with the user. If the user is unavailable, fill in the most plausible
answers and mark every unverified line with `~`.

```markdown
# Mindrun Briefing

**Date:** YYYY-MM-DD
**Scope:** <the pipeline or feature under review>
**Runtime available for Execution Gate:** yes | no

## Definitions of Done

| # | DoD | Source (user / assumed~) |
|---|-----|--------------------------|
| DoD-1 | <expected behavior, stated measurably> | user |
| DoD-2 | ... | ~ |
| DoD-3 | ... | user |

## Scenarios

| # | Name | Input | Expected output | Notes |
|---|------|-------|-----------------|-------|
| S1 | Happy path | <concrete input> | <concrete output> | |
| S2 | Edge case | <concrete input> | <concrete output> | |
| S3 | Hostile input | <concrete input> | <concrete output or expected rejection> | |

## Open assumptions (~)

- <assumption that the briefing could not resolve — will proceed with it, flagged>

## Artifact locations (optional overrides)

- Briefing: qa/mindrun-briefing.md
- Report: qa/mindrun-report.md
```

## Completion gate

- Every scenario has a **concrete** input and expected output (not "some text").
- Every DoD is stated measurably ("shows error message X", not "handles errors").
- Every unverified line is marked `~`.
