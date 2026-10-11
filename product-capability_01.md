# Product Capability 01 — Step-model migration + non-sprint verdict loops (S4)

Source: `user-story_01.md`. Engineering constraints only — boolean conditions
a machine can check. Sprint number: 01.

## CAPABILITY

The orchestrator gains a single execution model: every phase of every
workflow is a container of declared `steps[]` (main interactive or delegated
isolated), each step carrying at most one skill id (ambient skills live in a
separate slot). The sprint verdict/loop engine becomes workflow-general:
gates in develop, sprint, investigate and review (the approved 6-workflow
catalog — `qa`, `qa-report`, standalone `ship`, `quick` removed; `discover`
and `audit` added, verdict-free) parse deterministic verdicts from delegated
records and route — advance, loop-back under a ceiling, or park for a
human — with sprint's own gates behaving byte-identically.

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

- C6 — Verdict parsing is gated on `verdictsEnabled() && step.signal`
  (≥1 verdict-flagged delegated step; signal-observed on the step's
  record per ADR-17) — a loop edge is NOT required. A verdict-bearing
  phase without `loopBackTo`/`loopBackOn` is publish-only: the validated
  verdict writes `state.lastVerdicts[phaseId]` and the phase advances
  (ADR-24). Parsing is **not** gated on `workflowId === "sprint"` and
  not on
  `isLastStep`.
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

- C15 — The chain→steps[] migration preserves verdict coverage via
  per-step `signal.kind=="verdict"` declaration: a phase merges ONLY its
  flagged steps' `record.verdicts` (unflagged delegated steps are
  invisible to the gate; disagreement ⇒ null ⇒ park) — and
  `devsecops-review`'s `code-review` verdict can never silently
  disappear.
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
  workflow before that workflow's implementation lands — approved catalog:
  develop, sprint, investigate, review, discover, audit (all six sections
  approved).
- C20 — `bun test` reports 0 failures at sprint end, with added coverage
  for C6–C15.
- C21 — No `git push` or PR creation runs this sprint; this live run's
  legacy commit-archive phase parks at its entry gate (expected park,
  not a defect); the new sprint decomposition has no push phase.
- C22 — Running-sprint integrity: edits to `workflows.ts` land in a way
  that cannot desync the live state of THIS run — sprint's own
  decomposition lands last, after all other workflows are done.
- C23 — Stray `nul` artifact file removed from repo root. ✅ (done)

### Run-start + lifecycle machinery (S4 late additions)

- C24 — `state.vars` carries only string→string entries (sanitized on
  load); `Workflow.asks[]` answers write vars; a step whose
  `skipWhen: {var, equals}` matches skips without executing.
- C25 — `enabled:"auto"` phases resolve via `autoWhen(ctx)`; skippability
  is derived — a phase is user-skippable iff no enabled phase `needs`
  what it `produces`.
- C26 — `step.requires:` capability missing ⇒ step skipped with a ledger
  note; `step.prefers:` missing ⇒ step runs degraded and the report
  carries `~capability: no-<cap>`.
- C27 — A step declaring `signal` advances only when the signal is
  observed (record verdict var / artifact exists / record marker);
  interruption appends `run-interrupted`/`quota-parked` (never
  `phase-verdict`) and never burns `maxAttempts`.
- C28 — `state.ephemeralArtifacts` paths are deleted at terminal status;
  `.kstack/<workflow>/` handoff files are never ephemeral-deleted.
- C29 — `kstack-report` records validate: required flags enforced, path
  segments sanitized, record + ledger line parse as JSON.
- C30 — All project artifacts and inter-agent content are English.

### Verdict routing completions (ADR-21..23)

- C31 — `parkOn[value]` evaluates BEFORE `loopBackOn`/advance;
  `severity==red` under `(sprint, devsecops-review)` ⇒ freeze with
  typed-unfreeze; every other phase parks standard.
- C32 — `vars["feedback-type"]=="spec"` ⇒ park (never auto-rerun
  backlog); `code` or absent ⇒ normal loop routing.
- C33 — Parallel lanes engage iff `vars.scope=="mixed"` ∧ panel opt-in
  ∧ `vars["parallel-safe"]=="true"`; absent var ⇒ sequential; lanes
  hold disjoint file-sets and resume per-lane.
- C34 — Verifier steps (qa, devsecops code/security, docker, pipeline)
  write NO repo files — findings ride `--evidence`/`--deliverable`
  under `.kstack/runs/<runId>/`.
- C35 — `sideEffect` is declared at STEP level and parks at an ⚠ entry
  gate before running; the model cannot self-approve.
- C36 — Delegated steps are `spawn→work→report→exit`; shared memory is
  artifacts+records+ledger; task templates order stable context before
  feedback (prefix-cache friendly).
- C37 — `record.verdicts` counts only from `signal.kind=="verdict"`
  delegated steps; a `--verdict` from a non-flagged step ⇒ park;
  `record.vars` merges into `state.vars` from any step.
- C38 — Check ordering: walkthroughs sit inside implement (cheap, near
  producer); qa-browsing precedes devsecops-review (expensive, once).
- C39 — `state.lastVerdicts[phaseId]` contains ONLY expectation-map-
  validated values; `autoWhen`/`skipWhen` MAY read it (review.fix:
  auto-enabled iff `lastVerdicts.findings.code-review != "approved"`
  OR `lastVerdicts["qa-browsing"]?.status == "red"` — a red UI finding
  on approved code still gets patched; re-evaluated at phase arrival).
  `onComplete` fires only on `completed` status — skipped/auto-disabled
  phases never loop back.
- C40 — For verdict-flagged steps `--evidence` is a PATH LIST (files
  under `.kstack/runs/<runId>/` carrying the same `name == value`
  lines); for unflagged steps it may be inline text.
- C41 — `phase.optional` is retired (T10): skippability derives from
  `enabled`/`produces`/`needs`; legacy states load as `enabled:"on"`.
  Parallel lanes store step state in `state.lanes[laneId].stepIndex`.

## TRUST BOUNDARIES (who talks to what, with which authority)

- **Subagent → verdict parser**: untrusted text; only `## HANDOFF`-contained
  `variable == value` lines on the closed whitelist parse (legacy path);
  malformed/hedged known variables null the whole parse.
- **Subagent → record file**: untrusted JSON; the orchestrator re-validates
  `verdicts` against the (workflow,phase) expectation map — a `--verdict`
  from a non-flagged step parks, never routes.
- **Subagent → evidence artifact**: the second verdict channel; record and
  evidence must agree (dual-channel). Paths are record-declared —
  `artifactForVariable` is superseded for new workflows.
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
