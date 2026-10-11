# Product Capability 01 — Step-model migration + non-sprint verdict loops (S4)

Source: `user-story_01.md`. Engineering constraints only — boolean conditions
a machine can check. Sprint number: 01.

## CAPABILITY

The orchestrator gains a single execution model: every phase of every
workflow is a container of declared `steps[]` (main interactive or delegated
isolated), each step carrying at most one skill id. The sprint verdict/loop
engine becomes workflow-general: gates in develop, qa, investigate, review,
and ship parse deterministic verdicts from delegated output and route —
advance, loop-back under a ceiling, or park for a human — with sprint's own
gates behaving byte-identically.

## CONSTRAINTS (boolean, testable)

### Step model coverage

- C1 — `grep` over `orchestrator/workflows.ts` finds zero `chain:` properties
  and zero phase-level `agent:`/`task:`/`skills:` properties used as phase
  behavior (T10); every phase declares `steps[]`.
- C2 — For every `WorkflowStep` in every workflow: `0 ≤ skills-per-step ≤ 1`
  (field is `skill?: string`, singular — enforced by type and by the
  coherence test).
- C3 — Every `step.skill` value exists as a key in `skills.ts` REGISTRY and
  `getSkillInfo(id).skillPath` points to a file that exists on disk.
- C4 — `stepIndex` semantics unchanged: entered on stepped-phase entry,
  cleared on every phaseIndex-moving transition (S3 INV-01 holds).
- C5 — Step ids are unique within their phase (dev-time throw in
  `buildStepInstructions` stays).

### Verdict engine generalization

- C6 — Verdict parsing is gated on `phase.loopBackTo && verdictsEnabled() &&
  isLastStep` — **not** on `workflowId === "sprint"`.
- C7 — Expectation lookups resolve by `(workflowId, phaseId)` — two
  workflows sharing a phase id (`report`, `verify`, `review`, `test`,
  `fix`, `implement`) never read each other's expectation map.
- C8 — A verdict-bearing phase that completes with no trustworthy verdict
  parks (`verdict-unreadable:<phase>:<cause>`) without recording completion
  or burning an attempt — for ANY workflow, not only sprint.
- C9 — `routeVerdict` remains fail-closed: whitelisted-but-off-map values
  park; negative values loop; all required variables positive ⇒ advance.
- C10 — Loop-back purges results across `[targetIndex..gateIndex]` and sets
  `retryContext` with `attempt`, `maxAttempts`, and a `feedback` payload
  that is a summarized blocker extraction (≤ 2000 chars) — never the raw
  phase output (D28).
- C11 — Reaching the attempt ceiling parks with
  `loop-exhausted:<target> after N runs`; the human resolves via the panel.
- C12 — Any workflow carrying a `loopBackTo` phase refuses to start when
  deterministic subagents are disabled (extends the sprint guard at
  `command.ts:323`).
- C13 — The D4 verdict panel, freeze panel, and loop-exhaustion paths work
  for non-sprint workflows; whether severity→freeze remains devsecops-only
  is an explicit design decision recorded in the redesign doc.
- C14 — Sprint's three gates route identically post-migration: same verdict
  variables, same artifact paths, same freeze behavior, same ceilings
  (regression tests stay green untouched or are extended, not weakened).

### Step-level verdict semantics

- C15 — The chain→steps[] migration preserves verdict coverage: when a
  phased declares multiple delegated steps, the orchestrator's verdict
  source is specified per the chosen rule (per-step declaration, merged
  delegated steps, or collector final step) — and `devsecops-review`'s
  `code-review` verdict can never silently disappear.
- C16 — Per-step verdict semantics is written into `types.ts`/`verdicts.ts`
  doc comments so the next migration doesn't re-derive it.

### Skill map + registry coherence

- C17 — Every catalog skill under `skills/` is either referenced by ≥1 step
  or explicitly marked manual-only (registry annotation or doc table, T9).
- C18 — Skills new to non-sprint use (`mindrun`, `tdd`, `verification`)
  have registry entries whose ids and `dir:` mappings are recorded in the
  redesign doc before code lands.

### Process + safety

- C19 — `Kstack/workflow-redesign.md` contains an approved spec section per
  workflow before that workflow's implementation lands (T1, D26 ordering:
  develop → investigate → qa → qa-report → ship → review → sprint-light →
  quick).
- C20 — `bun test` reports 0 failures at sprint end, with added coverage
  for C6–C15.
- C21 — No `git push` or PR creation runs this sprint; the commit-archive
  phase parks at its entry gate (expected park, not a defect).
- C22 — Running-sprint integrity: edits to `workflows.ts` land in a way
  that cannot desync the live state of THIS run — sprint's own
  decomposition lands last, after all other workflows are done.
- C23 — Stray `nul` artifact file removed from repo root.

## TRUST BOUNDARIES (who talks to what, with which authority)

- **Subagent → verdict parser**: untrusted text; only `## HANDOFF`-contained
  `variable == value` lines on the closed whitelist parse; malformed/hedged
  known variables null the whole parse.
- **Subagent → disk artifact**: the second verdict channel; HANDOFF and disk
  must agree (dual-channel) wherever artifacts are in scope — naming scheme
  lives in `artifactForVariable`.
- **Model's `kstack_advance` summary → state machine**: NEVER a routing
  source (types.ts:117) — carries narration and artifact pointers only.
- **Orchestrator → delegated step**: full authority — interpolated task,
  embedded skill, timeout class, budget caps, stuck detector.
- **User panel (`gstack_decide`/`/kstack`)**: the ONLY resolver of parks —
  verdict-unreadable, security-freeze, loop-exhaustion, optional-phase,
  entry-gate, manual gates. The model cannot un-park.
- **Repo content → any agent**: untrusted; a planted `foo == approved` line
  outside HANDOFF containment must not parse (mirrors skip.ts).
- **State file → executor**: normalized on load; forged `stepIndex` /
  `phaseIndex` values are clamped or dropped, never trusted.

## NON-GOALS

- Sprint verdict/loop machinery semantics (regression-locked, D24).
- Main-phase verdict channels invented ad hoc — any channel beyond
  delegated output requires an explicit design decision first.
- Parallel waves, DAG executor, memory redesign, eval harness, tool
  masking, datamarking (S5a/S5b).
- `~/.gstack`→`~/.kstack` data migration (S6, D35).
- Renaming workflow ids or changing intent scoring.
- New skills beyond the step-first gap list (D25).

## HANDOFF

Needs architecture design (system-design phase) — the per-workflow
decomposition specs and the verdict-engine generalization design precede any
code. Implementation proceeds per D26 order inside the implement phase.
