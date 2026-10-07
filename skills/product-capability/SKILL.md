---
name: product-capability
description: Turns PRDs, roadmap asks, or product discussions into an implementation-ready capability plan — constraints, invariants, interfaces, open decisions. Use when the user says "turn this PRD into a plan", "requirements breakdown", "product requirements document", "what exactly must be true before we build", or product intent needs engineering constraints. Do NOT use for filing issue specs (use gstack-spec), technical architecture (use system-design), or task breakdown (use tasks).
compatibility: Sprint doc-chain producer — its capability plan feeds system-design and tasks; works standalone on pasted PRD or discussion text.
---

<!-- provenance: kedra/product-capability (verbatim) · ported S1 2026-02-11 -->

# Product Capability

**Inputs**: PRD/roadmap/discussion text (inline or file); output feeds `system-design` and `tasks`.

This skill turns product intent into explicit engineering constraints.

Use it when the gap is not "what should we build?" but "what exactly must be true before implementation starts?"

## When to Use

- A PRD, roadmap item, discussion, or founder note exists, but the implementation constraints are still implicit
- A feature crosses multiple services, repos, or teams and needs a capability contract before coding
- Product intent is clear, but architecture, data, lifecycle, or policy implications are still fuzzy
- Senior engineers keep restating the same hidden assumptions during review
- You need a reusable artifact that can survive across harnesses and sessions

## Non-Negotiable Rules

- Do not invent product truth. Mark unresolved questions explicitly.
- Separate user-visible promises from implementation details.
- Call out what is fixed policy, what is architecture preference, and what is still open.
- If the request conflicts with existing repo constraints, say so clearly instead of smoothing it over.
- Prefer one reusable capability artifact over scattered ad hoc notes.

## Inputs

Read only what is needed:

1. Product intent
   - issue, discussion, PRD, roadmap note, founder message
2. Current architecture
   - relevant repo docs, contracts, schemas, routes, existing workflows
3. Existing capability context
   - `PRODUCT.md`, design docs, RFCs, migration notes, operating-model docs
4. Delivery constraints
   - auth, billing, compliance, rollout, backwards compatibility, performance, review policy

## Core Workflow

### 1. Restate the capability

Compress the ask into one precise statement:

- who the user or operator is
- what new capability exists after this ships
- what outcome changes because of it

If this statement is weak, the implementation will drift.

### 2. Resolve capability constraints

Extract the constraints that must hold before implementation:

- business rules
- scope boundaries
- invariants
- trust boundaries
- data ownership
- lifecycle transitions
- rollout / migration requirements
- failure and recovery expectations

These are the things that often live only in senior-engineer memory.

### 3. Define the implementation-facing contract

Produce an SRS-style capability plan with:

- capability summary
- explicit non-goals
- actors and surfaces
- required states and transitions
- interfaces / inputs / outputs
- data model implications
- security / billing / policy constraints
- observability and operator requirements
- open questions blocking implementation

### 4. Translate into execution

End with the exact handoff:

- ready for direct implementation
- needs architecture review first
- needs product clarification first

## Output Format

Return the result in this order:

```text
CAPABILITY
- one-paragraph restatement

CONSTRAINTS
- fixed rules, invariants, and boundaries

IMPLEMENTATION CONTRACT
- actors
- surfaces
- states and transitions
- interface/data implications

NON-GOALS
- what this lane explicitly does not own

OPEN QUESTIONS
- blockers or product decisions still required

HANDOFF
- what should happen next and which delivery lane should take it
```

## Good Outcomes

- Product intent is now concrete enough to implement without rediscovering hidden constraints mid-PR.
- Engineering review has a durable artifact instead of relying on memory or Slack context.
- The resulting plan is reusable across Claude Code, Codex, Cursor, OpenCode, pi, and other planning surfaces.

## DoD gate (verification)

- DoD: user-story_XX.md states goal/actor/outcome with falsifiable acceptance criteria; product-capability_XX.md lists invariants as boolean conditions, enumerated trust boundaries, non-goals. BP: constraints testable, no vague adjectives, every boundary named.
