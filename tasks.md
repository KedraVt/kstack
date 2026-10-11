# Tasks — Sprint 01 (S4 workflow step-migration)

Backlog for the implement phase. Ordered by dependency; each task carries a
falsifiable `Done when`. All artifacts in English (AGENTS.md language rule).

## Implementation tasks

1. **Types extension** (`orchestrator/types.ts`) ✅ DONE (verified)
   - `WorkflowStep`: `+ ambientSkills?`, `skipWhen?: {var,equals}`,
     `signal?: {kind: verdict|artifact|marker, value}` (verdict-kind =
     verdict-bearing step), `sideEffect?`, `requires?`/`prefers?`
     capabilities, `ui?: "interactive"`.
   - `WorkflowPhase`: `enabled: "on"|"off"|"auto"` + `autoWhen?`,
     `produces?`/`needs?` (derived skippability),
     `loopBackOn?: Record<value, phaseId>`,
     `parkOn?: Record<value, "park"|"freeze">`.
   - `Workflow`: `asks?: [{var, question, options, default?, when?}]`.
   - `WorkflowState`: `+ vars`, `capabilities`, `ephemeralArtifacts`,
     `resumeMode`; `version` bump → 5.
   - Done when: typecheck clean; old states still load (defaults). ✅

2. **`runtime/bin/kstack-report`** (new CLI) ✅ DONE (verified end-to-end)
   - Writes `.kstack/runs/<runId>/<phase>[.<step>].json` + ledger
     `kind:"report"` event; path segments sanitized.
   - Flags: `--verdict KEY==VAL`, `--var KEY==VAL`, `--evidence <text>`,
     `--deliverable <path>`, `--marker`, `--summary`, `--attempt`.
   - Done when: invoked with flags → record on disk parses; ledger line
     appended; bad input exits non-zero. ✅

3. **Expectations keyed (workflow, phase)**
   - `PHASE_EXPECTATIONS` → `EXPECTATIONS[workflowId][phaseId]`;
     `routeVerdict(phaseId, parsed)` → `routeVerdict(workflowId, phaseId,
     parsed)`; all callers updated.
   - Done when: a `verify` verdict in `investigate` routes differently from
     a `verify` verdict in a removed-workflow sense; tests cover two
     workflows sharing a phase id.

4. **Completion signals + per-step verdicts**
   - Router advances a step only when its declared signal is observed in
     the record (`verdict:`/artifact exists/`marker` in record).
   - Verdict-bearing flagged steps emit records; phase merges flagged
     steps only (chain→steps[] verdict hole closed).
   - Done when: unit test — step without signal does not advance;
     multi-verdict phase (devsecops-style) merges both flagged steps.

5. **`loopBackOn`/`parkOn` maps + `state.vars` + `lastVerdicts`**
   - `outcome: persists→fix, refuted→root-cause` multi-target routing;
     `severity==red → parkOn:freeze`.
   - kstack-report `--var` values land in `state.vars`; missing var ⇒ safe
     default (`parallel-safe` absent ⇒ sequential).
   - `state.lastVerdicts[phaseId]` — validated verdict write for EVERY
     verdict-bearing phase (edged or publish-only); publish-only
     advances (ADR-24). `state.lanes[laneId].stepIndex` per INV-14.
   - Done when: unit test — multi-value verdict routes to two different
     targets; missing var falls back to default; edgeless phase
     publishes to `lastVerdicts` and advances.

6. **Ledger events: `run-interrupted` / `quota-parked`**
   - Interruption kinds appended; not `phase-verdict`; do not consume
     `maxAttempts`.
   - Done when: simulated interruption appends the right kind and attempts
     counters unchanged.

7. **Panel machinery: `asks[]`, `enabled`, derived skippability**
   - `asks[]` resolved sequentially at start → `state.vars`.
   - `enabled: auto` resolved on computable state (file presence, diff)
     — autoWhen RE-EVALUATES at phase arrival (panel resolution is
     display-only; ADR-24).
   - Derived skippability: `produces`/`needs` — panel computes which
     phases may be skipped safely.
   - `skipWhen` conditions: `scope:`, `target:`, `requires:`/`prefers:`.
   - Done when: unit tests for ask→vars, auto-resolution, skip graph.

8. **Capabilities + UI contract**
   - `state.capabilities` (probe result stored at init); `requires`→skip,
     `prefers`→degrade + `~capability: no-X` note.
   - `capability.ui: headless|interactive` — visible windows only for
     interactive-purpose steps.
   - Done when: capability matrix unit test; missing required cap skips
     the step with a ledger note.

9. **Executor: ambientSkills + resume-mode + ephemeralArtifacts**
   - `ambientSkills` injected outside the task-skill slot.
   - Step-boundary resume-mode: re-issued task says "continue from disk
     state" (builders: diff+tests oracle; writers: overwrite; appenders:
     dedup).
   - `ephemeralArtifacts` deleted at terminal status + ledger event.
   - `sideEffect` steps → entry gate ⚠.
   - Done when: unit tests for each mechanism; resume re-delivers with the
     resume hint.

10. **Workflow migration** (`workflows.ts`, `skills.ts` registry)
    - Port approved designs in this order — `sprint` LAST (C22: it is
      the live workflow running THIS session; migrating it first breaks
      the run): develop (8) → investigate (7) → review (7) →
      discover (1) → audit (1) → sprint (14).
    - Remove workflows `qa`, `qa-report`, `ship`, `quick` + stale
      expectations/intents; retire `phase.optional` (C41 — legacy
      states load as `enabled:"on"`).
    - Register new skills in the registry.
    - Done when: every workflow's steps reference existing skills/defs;
      coherence test green; sprint migrated last with this run's state
      intact.

11. **Skills work**
    - Write `kstack-risk-scan` (authoring pipeline 0–4 + pre-flight).
    - Update: idea-refine (understand*.md wording), plan-draft (I/O),
      tasks (parallel-safe + scope + `~out-of-scope` marking), 5
      verifiers → `--evidence`, lite-mindrun (`outcome` verdict mode
      for investigate.verify), kstack-investigate (triage NOT-clause).
    - Wire-only: `kstack-impeccable` (steps + capability-degrade note),
      `kstack-retro` (steps + repoint the writing-for-agents dep to the
      new in-catalog port).
    - Port: ponytail, acceptance-criteria-{be,fe}, writing-for-agents,
      agent defs ×5.
    - Deferred (post-S4 backlog): `kstack-office-hours` revision (too
      long, unrelated parts) — candidate for the first real develop run.
    - **Inputs**: `Kstack/flaws-audit.md` (catalog defect list C1–C8 +
      per-skill findings — fix alongside the touched skills: weak
      descriptions, AUQ headless fallbacks, dead pointers incl.
      retro→writing-for-agents now in-catalog, impeccable↔design-taste
      collision) and `Kstack/overlap-map.md` open items.
    - Done when: each skill loads, `## DoD gate` parses, registry wiring
      compiles; flaws-audit findings on touched skills are resolved or
      re-flagged.

12. **`kstack init` extension** (`init.ts`)
    - Block → `<!-- kstack:begin v1 -->` (2-rule v1); re-run → "already
      run — use `--update`"; `--update` rewrites only the block + re-probe
      + reinstall defs.
    - Capability probe (graft/browse/node/gh/design.exe) with consequence
      notes; agent-defs install; `.kstack/` scaffold.
    - Done when: init on a temp repo produces all artifacts; re-run is
      refused; `--update` bumps the block only.

13. **Verification**
    - `bun test` suite green incl. new coverage; typecheck clean.
    - E2E smoke: develop + investigate on a scratch repo.
    - Done when: suite output shows new tests passing; smoke run completes
      the full phase list.
