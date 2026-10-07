---
name: adr
description: Provides a standard protocol for building an *ADR-log_XX.md* (Architecture Decision Record) file containing motivated strategic architectural decisions. Use when a sprint requires architectural changes or when recording design decisions alongside system-design.
---

<!-- provenance: kedra/adr (verbatim) · ported S1 2026-02-11 -->

# Architecture Decision Records

## Workflow

1. Scan *user-story_XX.md* and *system-design_XX.md* to evaluate whether the requests mandate architectural changes or can adapt to current structural constraints.
2. Identify and document at least one alternative technical solution.
3. Compare the candidate solutions: run a rigorous impact analysis on trade-offs, then choose the option that best suits the project.
4. Set each decision's initial status to `Proposed`.

## Rules

- *ADR-log_XX.md* must always be created. If *system-design_XX.md* requires no changes, create a placeholder *ADR-log_XX.md* stating "No architectural changes required for this sprint".
- Refer to the corresponding numbered files: if building sprint 05, do not refer to user-story_02! Cross-sprint consistency matters.
- Every decision must be followed by an explanation of why the choice was made and what its consequences are.

# ADR Template

```markdown
## ADR-[XXX]: [Decision Title]

### Status

Proposed | Accepted | Deprecated | Superseded by ADR-XXX

### Context

Summary of the changes requested in *user-story_XX.md*.

### Decision

The change being adopted, explaining why, with references to *system-design_XX.md*.

### Consequences (Trade-offs)

What becomes easier or harder because of this change? What are we giving up?
```

## Status Block

Every *ADR-log_XX.md* ends with a machine-readable status block so orchestrating agents can parse the verdict:

```markdown
## STATUS == pending | approved | rejected
## BLOCKING_ISSUES == none | <comma-separated list>
```

## DoD gate (verification)

- DoD: each ADR records Decision / Context / Consequences + status; only significant architectural changes; ADR-log_XX.md append-only, never rewritten. BP: one record per decision; note rejected alternatives when they were real.
