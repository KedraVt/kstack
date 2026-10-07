# Report Template — mindrun-report.md

The report is written **incrementally**: the pipeline table and trace tables are appended after
every step in Phase 2; the rest is finalized in Phase 4.

```markdown
# Mindrun Report

**Date:** YYYY-MM-DD
**Scope:** <from briefing>
**Briefing:** link to mindrun-briefing.md

## DoD Matrix

| DoD | Scenario | Verdict | Evidence (file:line + trace row) |
|-----|----------|---------|----------------------------------|
| DoD-1 | S1 | verified | core/pipeline.ts:17, trace S1 row 2 |
| DoD-2 | S2 | mismatch | services/translator.ts:44, trace S2 row 3 |
| DoD-3 | S3 | unspecified → question | — |

## Pipeline walk (evidence)

### Pipeline table

| Step | Expected input | How the code receives it | Output produced | Destination |
|------|----------------|--------------------------|-----------------|-------------|
| 1. UI entry | text | ui/Input.tsx:58 → handleSubmit | raw value | core/pipeline.ts:17 |
| 2. ... | | | | |

### Trace tables (one per scenario)

**S1 — Happy path**

| Iter | VarA | VarB | Output |
|------|------|------|--------|
| 1 | "hello" | ... | ... |

## Findings

### Finding 1 — <short title> (confidence: high | medium | low) [prove now]

**Premises:** ...
**Trace:** ...
**Divergence:** ...
**Trigger:** ...
**Remedy:** ...

**Smallest proof step:** <the cheapest experiment that confirms/rejects this>

### Finding 2 — ...

## Questions for the user

### Priority (on the happy path)

1. <question> — arose at step N, marked `?`

### Overflow (lower priority, recorded not asked)

- <question> — step N

## Execution Gate results (if runtime was available)

- Finding 1: ✅ execution-verified / ❌ withdrawn (false positive) / not run

## Proposed tasks

- [ ] [mindrun] <task title> — <finding link>

## Status

STATUS == clean | findings | blocked
findings_confirmed: N
questions_open: N
briefing_incomplete: true | false
results_presented: true | false
```

## Rules

- Every evidence cell must cite file:line and (where relevant) a trace table row.
- A finding without the five fields is not listed here.
- The STATUS block must be the last thing in the file.
