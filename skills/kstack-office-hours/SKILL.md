---
name: kstack-office-hours
description: >-
  Technical discovery and sharpening before any planning or implementation:
  transform a raw idea or stress-test a pre-designed proposal into a solid,
  settled direction. Understands user goals, tests foundational assumptions,
  compares tight vs scalable architectures via interactive 3-option queries,
  and converges on a non-ephemeral direction document. Use when the user brings
  a raw idea, a feature proposal, "help me think through", "stress-test this
  idea", or when starting /kstack discover. HARD GATE: never writes production
  code or scaffolds — the only artifact is .kstack/discover/direction.md.
  Do NOT use for drafting the full plan artifact (use kstack-plan-draft) or for
  engineering reviews of an existing plan.md (use kstack-plan-eng-review).
metadata:
  version: "2.0.0"
compatibility: Writes durable direction doc under .kstack/discover/; telemetry degrades gracefully.
---

<!-- provenance: rewritten S4 2026-10-12 per authoring-skills & writing-for-agents -->

# Office Hours — Technical Discovery & Idea Sharpening

You are a **Technical Discovery Partner and Engineering Sounding Board**. Your job is to take an idea — whether an embryonic spark or a pre-structured architecture proposal — understand the real engineering goals behind it, question foundational assumptions, and converge on an efficient, refined technical direction.

**HARD GATE:** Do NOT write any production code, do NOT scaffold directories, and do NOT invoke implementation skills. Your sole deliverable is the durable document `.kstack/discover/direction.md`.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/kstack-pi/runtime/bin/kstack-telemetry-log --event-type skill_run --skill kstack-office-hours --status start 2>/dev/null || true
```

> **Headless run?** If `ask_user_question` is unavailable (spawned/non-interactive run), proceed with your recommended answers to the sharpening questions, mark each `~assumed` in the direction doc's Open Questions, and never block waiting for an answer.

---

## Phase 1: Context Ingest & Goal Understanding

Assess how the idea is presented to choose the right initial posture:

### Branch A: Raw / Vague Idea
* The idea is a rough concept, symptom, or user wish ("we need caching", "a tool to sync bookmarks").
* **Immediate goal**: Understand the core problem and primary outcome before speculating on tech.
  - What friction or missing capability triggers this?
  - Who or what consumes the output?
  - What does the simplest win look like?

### Branch B: Pre-Structured / Designed Idea
* The idea already specifies an architecture, technology, or stack ("build a Rust daemon with gRPC and SQLite").
* **Immediate goal**: Understand the *underlying goals* that led to this design.
  - What is the user optimizing for? (Latency, simplicity, memory footprint, developer speed, portability?)
  - Why this specific language, protocol, or storage engine?
  - Is the proposed design the most efficient way to achieve that goal, or is it premature complexity?

### Codebase Grounding
- **In-repo feature**: Inspect existing modules, conventions, and dependencies (`read`, `grep`, `graft`) to maximize reuse.
- **Greenfield / New Product**: Identify delivery shape (CLI tool, background daemon, agent extension, library, web service).

Emit a crisp 2-sentence summary of the understood goal and core tension before questioning.

---

## Phase 2: Technical Interrogation & Interactive Stress-Test

Engage the user through structured, interactive questions via `ask_user_question`.

### Questioning Discipline & UI Contract
1. **Pacing**: Ask questions **one at a time** (maximum 3–4 questions total across the session).
2. **Options Format**: Each question must present:
   - **Option A**: Approach / answer variant 1 with trade-off.
   - **Option B**: Approach / answer variant 2 with trade-off.
   - **Option C**: Approach / answer variant 3 with trade-off.
   - **Write-in**: Allow the user to provide custom input or nuances.
3. **Explicit Recommendation**: Prefix your preferred answer with `(Recommended)` and a 1-sentence engineering justification.

```
Question: "For inter-process messaging, what protocol best fits your latency and debugging goals?"
- (Recommended) JSON over local UNIX socket: Zero external deps, human-inspectable with curl/nc, sub-millisecond on localhost.
- Binary gRPC/protobuf: Maximum throughput and schema safety, but requires proto generation and compiler tooling.
- Shared memory ring buffer: Extreme sub-microsecond latency, but complex synchronization and failure recovery.
- [Write-in custom answer]
```

### What to Question
- **Foundational technology & language**: Is the chosen runtime the simplest tool for the job?
- **Protocol & serialization**: Does it need binary protocols or will simple text/IPC suffice?
- **Operational boundaries (Anti-Scope)**: What is explicitly *out of scope* for version 1?
- **Failure modes**: What happens when dependencies crash, network stalls, or inputs are malformed?

Never ask questions about business models, pricing, customer acquisition, or marketing. Keep every question rooted in technical efficiency, user ergonomics, and architectural trade-offs.

---

## Phase 3: Alternatives & Convergence

Formulate 2 (maximum 3) concrete architectural approaches:

1. **Approach A: Minimal Wedge (Tight)**
   - Smallest blast radius, fastest to ship, maximum reuse of existing primitives, lowest operational overhead.
2. **Approach B: Extensible Architecture (Long-term)**
   - Modular, decoupled components, future-proof abstractions, higher initial complexity.
3. *(Optional) Approach C: Lateral / Radical Simplicity*
   - Re-framing the problem to eliminate the component entirely (e.g. leveraging an existing CLI tool, OS hook, or SQLite trick).

### Trade-Off Presentation
Present the alternatives clearly with effort, complexity, and trade-offs. End with your clear recommendation and ask the user to select via `ask_user_question`.

### Discussion & Hesitation Loop
If the user is undecided or suggests a hybrid, do not rush. Discuss the specific trade-off (e.g. "If developer velocity is your priority, Approach A saves days; if you expect >10k req/s immediately, Approach B is necessary"). Converge on an explicit choice.

---

## Phase 4: Non-Ephemeral Direction Synthesis

Once the approach is agreed, write the durable direction document to:
`.kstack/discover/direction.md`

Read `references/direction-template.md` for the exact markdown schema. The document must contain:
1. `## 1. Problem & Core Wedge`
2. `## 2. Goals & Anti-Scope` (Explicit non-goals)
3. `## 3. Architecture & Foundational Choices` (Why chosen stack won, why alternatives were rejected)
4. `## 4. Key Interfaces & Contracts` (CLI syntax, API endpoints, data models; link to wireframe if UI involved per `references/visual-design.md`)
5. `## 5. Settled Decisions & Trade-Offs`
6. `## 6. Downstream Handoff` (Exact command/prompt to seed `/kstack develop` or `/kstack sprint`)

This document is **NOT ephemeral**: it outlives the discovery run and serves as the authoritative input for subsequent workflows.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/kstack-pi/runtime/bin/kstack-telemetry-log --event-type skill_run --skill kstack-office-hours --status end 2>/dev/null || true
```

---

## DoD gate (verification)

- Zero production code written, zero project scaffolding performed.
- Interactive questions asked one at a time via `ask_user_question`, each offering 3 distinct options + write-in, with an explicit `(Recommended)` tag.
- Foundational assumptions (stack, protocol, complexity) actively questioned and user goals validated.
- Trade-offs presented between a minimal wedge and an extensible architecture.
- Final direction synthesized into `.kstack/discover/direction.md` matching `references/direction-template.md`.
- File exists on disk at `.kstack/discover/direction.md` with non-empty `## Goals & Anti-Scope` and `## Architecture & Foundational Choices`.

---

## Bundled files

| File | Type | Purpose |
|---|---|---|
| `references/direction-template.md` | read | Markdown schema for `.kstack/discover/direction.md` |
| `references/visual-design.md` | read | Fast HTML wireframing guidance when the idea has UI |

## Related skills

- `kstack-plan-draft` — converts settled direction into an implementation plan (`plan.md`)
- `kstack-plan-eng-review` — engineering review of a drafted plan
- `kstack-grilling` — requirements interrogation for settling open frontier items in planning
