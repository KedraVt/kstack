# Tasks — Sprint 01 (S4 workflow step-migration)

Backlog for the implement chain. Built from `system-design_01.md`
(§2 domain model, §4 verdict engine, §8 change list, §10.1–10.15) +
`Kstack/workflow-redesign.md` (approved per-workflow decomposition) +
`ADR-log_01.md` (ADR-1..24). Atomicity law: each task is executable on
its own branch with its own `Done when`. All artifacts in English
(AGENTS.md language rule). Supersedes `tasks.md` as the implement input.

## ROLE — BACKEND DEVELOPER

### Goal_01 — Verdict engine generalization

Un-sprint the verdict machinery so every workflow routes through the
same fail-closed path: `(workflowId,phaseId)` expectations, record-based
per-step verdicts, `loopBackOn`/`parkOn`/`onComplete` routing, publish-
only `lastVerdicts`, `state.vars` merge, interruption events.

#### TASK_01
- **Atomic description**: `PHASE_EXPECTATIONS` → keyed `EXPECTATIONS
  [workflowId][phaseId]`; `routeVerdict(phaseId, parsed)` →
  `routeVerdict(workflowId, phaseId, parsed)`; update all callers.
- **Context & inputs**: `orchestrator/verdicts.ts` (bare-phase map at
  :68-77), `orchestrator/state.ts:210-224` (callers), expectation entries
  for every verdict phase in `workflow-redesign.md` (develop review,
  investigate verify, review findings/qa-browsing publish-only, sprint
  gates).
- **Constraints**: glossary BINDING — `signal`, `publish-only`,
  `loopBackOn`; collisions across shared phase ids (`verify`, `fix`,
  `review`, `report`, `implement`) must be impossible (C7).
- **Unhappy paths**: missing `[workflowId][phaseId]` entry ⇒ unreadable
  park (`verdict-unreadable:<phase>:no-expectation`), never a default.
- **Success condition**:
  - Action: `bun test` + typecheck
  - Expected: two workflows sharing `verify` route differently; 0 failures.
- **Execution steps**: 1) rekey map + signature; 2) migrate all callers;
  3) add cross-workflow shared-id test; 4) typecheck.

#### TASK_02
- **Atomic description**: completion signals + per-step verdicts — a step
  advances only when its declared `signal` is observed in its record;
  phase verdict merges flagged steps ONLY.
- **Context & inputs**: `WorkflowStep.signal` (landed types :77);
  records under `.kstack/runs/<runId>/`; current `isLastStep` gate
  (`state.ts`) retired per ADR-17/ADR-23.
- **Constraints**: multi-verdict phases (devsecops: code-review +
  security-review) merge BOTH flagged records; disagreement ⇒ null ⇒
  park (INV-2/C37). Non-flagged `--verdict` ⇒ park.
- **Unhappy paths**: missing/foreign-verdict record ⇒ park; signal
  absent ⇒ resumeMode re-issue, no advance.
- **Success condition**:
  - Action: `bun test`
  - Expected: step without observed signal does not advance; dual-flagged
    merge yields both vars; chain→steps verdict hole closed.
- **Execution steps**: 1) records reader; 2) signal-observation gate in
  executor; 3) flagged-only merge; 4) tests.

#### TASK_03
- **Atomic description**: `loopBackOn`/`parkOn` routing maps +
  `state.vars` merge + `state.lastVerdicts`/`state.lanes` state fields.
- **Context & inputs**: types landed (`loopBackOn` :175, `parkOn` :181);
  routing order §4 (`parkOn` → `loopBackOn` → `loopBackTo` → advance);
  publish-only semantics §10.15/ADR-24; `feedback-type==spec` ⇒ park
  (ADR-21).
- **Constraints**: `state.lastVerdicts[phaseId]` receives ONLY
  expectation-map-validated values (INV-17); edgeless phases publish +
  advance; `parkOn:{red:"freeze"}` preserves devsecops typed-unfreeze;
  interruption/quota events never consume attempts.
- **Unhappy paths**: unmapped negative on an EDGED phase ⇒ park;
  malformed record vars ⇒ record rejected + park.
- **Success condition**:
  - Action: `bun test`
  - Expected: multi-value verdict routes to 2 targets; publish-only
    advances writing `lastVerdicts`; `severity==red` ⇒ freeze;
    `parallel-safe` absent ⇒ sequential default.
- **Execution steps**: 1) add `lastVerdicts`/`lanes` to types+state
  (sanitize on load like `vars`); 2) routeVerdict precedence; 3) vars
  merge; 4) tests for each branch.

#### TASK_04
- **Atomic description**: ledger events `run-interrupted` /
  `quota-parked` appended on interruption; never `phase-verdict`, never
  consume `maxAttempts`.
- **Context & inputs**: `ledger.ts:47` kinds already extended; executor
  interruption path.
- **Constraints**: append-only, verbatim (glossary); resumable after
  interruption without attempt inflation.
- **Unhappy paths**: quota hit mid-delegation ⇒ `quota-parked` + clean
  park; resume re-dispatches the same step.
- **Success condition**:
  - Action: `bun test`
  - Expected: simulated interruption appends right kind; attempts
    counters unchanged.
- **Execution steps**: 1) detect interruption points; 2) emit kinds;
  3) assert counter stability; 4) test.

### Goal_02 — Run-start machinery

`asks[]` → `state.vars`, `enabled:"auto"` resolution + derived
skippability, capability probing/gates, headless UI contract.

#### TASK_05
- **Atomic description**: panel machinery — `asks[]` sequential answers
  → `state.vars`; `enabled:"auto"` resolved at panel AND re-evaluated at
  phase arrival (ADR-24); derived skippability via `produces`/`needs`;
  declarative `skipWhen {var,equals}` step evaluation.
- **Context & inputs**: types `asks[]` :202-213, `enabled`/`autoWhen`
  :154-160, `produces`/`needs` :167-168, step `skipWhen` :40; panel code
  `command.ts`/`gates.ts`.
- **Constraints**: a needed producer is never skippable (INV-13);
  `autoWhen` at arrival is REQUIRED — `lastVerdicts` populates mid-run;
  ask `when` conditions gate follow-ups.
- **Unhappy paths**: `autoWhen` throws ⇒ `enabled:"off"` + ledger note;
  circular `needs` ⇒ coherence failure (INV).
- **Success condition**:
  - Action: `bun test`
  - Expected: ask→vars round-trip; auto resolves off when producer
    disabled; skipWhen `target:external` skips fix; needs-cycle fails
    coherence.
- **Execution steps**: 1) asks engine; 2) enabled resolver (panel +
  arrival); 3) skip graph; 4) skipWhen evaluator; 5) tests.

#### TASK_06
- **Atomic description**: capability probing + gates — `state.capabilities`
  written at init; `requires`→skip + ledger note, `prefers`→degrade +
  `~capability: no-X` report note; `ui:"interactive"` only on interactive-
  purpose steps (INV-15).
- **Context & inputs**: types `requires`/`prefers` :46-52, `ui` :58;
  probes: graft/browse/node/gh/design (§10.6); `init.ts` probe storage.
- **Constraints**: headless default; managed headless Chromium for
  browse — never the user's visible session (INV-15 boundary).
- **Unhappy paths**: probe missing ⇒ capability `no`; a `requires`
  violation at dispatch ⇒ skip not crash.
- **Success condition**:
  - Action: `bun test` + a `requires:[gh]` step on a gh-less PATH skips
  - Expected: skip + ledger note; degrade path emits `~capability` note.
- **Execution steps**: 1) probe → state; 2) gate in step dispatch;
  3) degrade annotation; 4) tests.

### Goal_03 — Executor delivery

Step dispatch machinery: ambient skills, signal observation, resume-mode,
ephemeral lifecycle, side-effect gates.

#### TASK_07
- **Atomic description**: executor — `ambientSkills` injection outside
  the task-skill slot; signal-observation gate per step; resumeMode
  re-issue ("continue from disk state"); `ephemeralArtifacts` register +
  delete at terminal status; `sideEffect` ⇒ ⚠ entry gate.
- **Context & inputs**: `executor.ts`, `templates.ts` step task template
  (stable context first, retry/feedback LAST — prefix-cache §10.12);
  `.kstack/runs/<runId>/` records; ephemeral set per §10.5.
- **Constraints**: spawn env carries run/phase/step ids + CLI path;
  delegated steps follow spawn→work→report→exit (ADR-23); handoff
  artifacts `.kstack/<wf>/` never deleted.
- **Unhappy paths**: missing record after delegation ⇒ park; interrupted
  re-issue ⇒ same step with resume hint; terminal cleanup failure ⇒
  ledger warning, not crash.
- **Success condition**:
  - Action: `bun test`
  - Expected: ephemeral file deleted at terminal + ledger event; re-issue
    carries resume hint; sideEffect step parks pre-exec.
- **Execution steps**: 1) ambientSkills into spawn context; 2) signal
  gate; 3) resume template; 4) ephemeral lifecycle; 5) tests.

### Goal_04 — Workflow migration

Port the approved 6-workflow spec into `workflows.ts`, derived registry,
legacy field removal.

#### TASK_08
- **Atomic description**: migrate all six workflows to `steps[]`;
  **sprint LAST** (C22 — it is the live workflow running this session);
  remove `qa`/`qa-report`/`ship`/`quick` + stale expectations/intents;
  retire `phase.optional`; derive registry from `skills/` dirs (T9).
- **Context & inputs**: `Kstack/workflow-redesign.md` phase tables
  (develop 8, investigate 7, review 7, discover 1, audit 1, sprint 14);
  expectation entries per workflow; skill ids per table.
- **Constraints**: every `step.skill`/`ambientSkills` resolves to a
  `skills/<id>/SKILL.md` (INV-6); verdict phases carry expectation
  entries; ambient AC banks only where the spec says (§10.14); legacy
  `agent`/`task`/`skills`/`chain` deleted (T10/AC-2).
- **Unhappy paths**: workflow referencing a missing skill ⇒ coherence
  test failure (fail closed, not silent skip).
- **Success condition**:
  - Action: `bun test` + coherence suite
  - Expected: 6 workflows all `steps[]`; sprint migrated last with live
    state intact; zero unresolved skill references.
- **Execution steps**: 1) develop; 2) investigate; 3) review;
  4) discover; 5) audit; 6) sprint (state-safe); 7) registry derive +
  alias removal; 8) coherence tests.

## ROLE — PLANNER

### Goal_05 — Skills catalog

Write `kstack-risk-scan`; update the six skills whose contracts changed;
port ambient/agent assets; all through the authoring gate.

#### TASK_09
- **Atomic description**: skills work — write `kstack-risk-scan`; update
  idea-refine / plan-draft / tasks / 5 verifiers (`--evidence` paths) /
  lite-mindrun (`outcome` verdict) / kstack-investigate (NOT-clause);
  wire-only impeccable + retro; port ponytail, AC-{be,fe},
  writing-for-agents, agent defs ×5.
- **Context & inputs**: `Kstack/flaws-audit.md` (catalog defect list
  C1–C8 + per-skill findings — fix alongside touched skills);
  `Kstack/overlap-map.md` open items; authoring pipeline
  `.devin/skills/authoring-skills` (phases 0–4 + pre-flight, ADR-19);
  agents-clean sources for the 5 defs.
- **Constraints**: `## DoD gate` literal + provenance comment; headless
  fallback lines (`~assumed`); 0-or-1 task-skill per step — ambient
  banks live in `ambientSkills`, not `skill`.
- **Unhappy paths**: description that fails the NOT-clause test ⇒
  rewrite before wiring; a skill that cannot satisfy its DoD ⇒ flag
  `~out-of-scope` instead of shipping it broken.
- **Success condition**:
  - Action: `bun test` (skill load/parse suite) + grep each SKILL.md for
    `## DoD gate` + provenance
  - Expected: all skills load; flaws-audit findings on touched skills
    resolved or re-flagged; defs installed.
- **Execution steps**: 1) risk-scan through authoring pipeline; 2)
  contract updates; 3) ports; 4) wire + registry; 5) suite.

## ROLE — BACKEND DEVELOPER

### Goal_06 — `kstack init`

Versioned managed block + probes + defs + `.kstack/` scaffold —
non-destructive re-run contract.

#### TASK_10
- **Atomic description**: `init.ts` — `<!-- kstack:begin v1 -->`…end
  block (2 rules: evidence-before-claims, minimalism); re-run refused
  with update hint; `--update` rewrites ONLY the block + re-probes +
  reinstalls missing defs; `.kstack/` scaffold.
- **Context & inputs**: existing `init.ts` (managed block without
  version/update); probes per §10.8; agent-def install sources.
- **Constraints**: NEVER touch content outside the managed block;
  no repo-hints (§10.8); capability consequences printed per probe.
- **Unhappy paths**: block markers absent but file exists ⇒ append at
  end, report; unwritable file ⇒ non-zero exit with reason.
- **Success condition**:
  - Action: run `init` on a scratch repo; re-run; `--update`
  - Expected: first run writes block+`.kstack/`+defs; re-run refused;
    `--update` changes only the block.
- **Execution steps**: 1) versioned markers; 2) refusal path;
  3) update path; 4) probe/store; 5) defs; 6) scaffold; 7) manual verify.

## ROLE — QA-ENGINEER

### Goal_07 — Verification

Suite green, typecheck clean, live runs recorded.

#### TASK_11
- **Atomic description**: full verification — `bun test` (incl. all new
  machinery coverage) + typecheck + E2E smoke (develop + investigate on
  a scratch repo); each migrated workflow gets a recorded run or a
  documented reason (AC-10).
- **Context & inputs**: test list §8 item 11 (records parser, keyed
  expectations, loopBackOn/parkOn, unmapped-negative, feedback-type,
  onComplete bounds, skipWhen, asks→vars, enabled/autoWhen arrival-time,
  derived skippability, capability gates, signal observation, ephemeral
  cleanup, interruption events, sideEffect gates, verdict-flag
  invariants, edgeless publish + autoWhen termination, per-workflow
  coherence, registry derivation); §9 model (agnes-3.0-flash delegated).
- **Constraints**: verification-before-completion rule — fresh run,
  read output, report evidence; no push/PR anywhere (AC-9).
- **Unhappy paths**: a workflow that cannot fully run mid-session
  (sprint self-run) ⇒ documented reason, not a fake green.
- **Success condition**:
  - Action: `bun test` + `bunx tsc --noEmit` + smoke script
  - Expected: 0 failures; typecheck clean; smoke run completes the full
    phase list or parks at a declared gate.
- **Execution steps**: 1) unit coverage per §8.11; 2) typecheck; 3)
  scratch-repo init; 4) develop smoke; 5) investigate smoke; 6) record
  runs + reasons.
