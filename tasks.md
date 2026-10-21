# Tasks — Sprint 02 (S5a evolution: foundation hardening)

Backlog for the implement chain. Built from `system-design_02.md`
(§2 aggregates, §3 component design, §5 immutable contracts, §7
invariant→home map, §11 risk passes) + `ADR-log_02.md` (ADR-25..63,
**approved** by the architect gate) + `user-story.md` (AC-1..AC-30) +
`capability.md` (INV-1..31, TB-1..TB-10).

Atomicity law: each task is executable on its own branch with its own
falsifiable success condition. All artifacts in English (AGENTS.md language
rule). Every AC-1..AC-30 is claimed by exactly one task (see the claim table
in §4). The glossary in `system-design_02.md` §1 is BINDING.

**Lanes.** Two roles, one file set: BACKEND DEVELOPER (the code) and
QA-ENGINEER (the verification + the C3 retro). The lanes are **not**
parallel-safe: the QA lane runs the suite the backend lane writes, and both
touch `test/`. `parallel-safe==false`.

**Order.** Backend tasks are sequenced by their dependencies (TASK_01 →
TASK_02 → …); the QA lane starts after the backend lane it verifies. TASK_19
(the C3 retro) is last: it reads this sprint's own run report.

---

## ROLE — BACKEND DEVELOPER

### Goal_01 — Phase tool masking (W1)

Give every phase a deterministic browser-tool profile (`full` / `read` /
`none`) so a phase sees only the browser tools it needs, applied to the main
session only, always reversible.

#### TASK_01 — The toolmask module
- **Atomic description**: new `orchestrator/toolmask.ts` with
  `ToolProfile` (re-exported from `types.ts`), `CONTROL_TOOLS`
  (`kstack_advance`, `kstack_phase`), `BROWSER_TOOLS` (derived from the
  `TOOLS` array — no hand-copied list), the 32-name `READ_TOOLS` allowlist,
  the literal `PHASE_TOOL_PROFILE` table (one key per `"workflow:phase"`,
  38 pairs), `profileFor`, `maskedFor`, `reconcileToolMask(pi, profile)` and
  `restoreAllTools(pi)`.
- **Context & inputs**: `system-design_02.md` §3.1 (READ_TOOLS list, the
  profile table, the reconcile algebra, `INV-1/2/3/4`), ADR-25, ADR-41,
  ADR-45, ADR-50. `pi` API: `getActiveTools()` / `setActiveTools(names)` /
  `getAllTools()` (`types.d.ts:1282/1291/1284`).
- **Constraints**: the mask adds **no** name and removes exactly the masked
  ones (pi drops unknown names — `_applyToolLoadout`,
  `agent-session.js:1160-1164`); `CONTROL_TOOLS` are never masked; the
  result is ordered by the `getAllTools()` index; the ledger is
  `{ ownerRunId, removedByMask }` and **survives `invalidateRuntime`**, being
  cleared only on an owner change or after a successful terminal restore
  (ADR-60, `INV-28`); a missing table key resolves `full` at runtime but the
  CI test fails (INV-3).
- **Unhappy paths**: `setActiveTools` throws or the pi version lacks it →
  catch, ledger a `report`, continue **unmasked** (masking is an
  optimisation, not a security boundary — ADR-28); a name pi does not know →
  pi drops it, the mask is not blamed; the ledger is non-empty at a phase
  boundary → restore the previous owner first, then re-mask.
- **Success condition**:
  - Action: `bun test test/toolmask.test.ts`
  - Expected: 0 failures — the profile table covers all 38 registered pairs
    (enumerated from the **static** workflow list, sprint included even when
    `KSTACK_PI_SPRINT=off`); `read` ∩ the INV-4 forbidden list = ∅; the
    reconcile adds nothing and removes exactly the masked names; `full` after
    `none` restores the removed set (AC-1, AC-2, AC-3, AC-4, INV-1..4).
- **Execution steps**: 1) module skeleton + the derived `BROWSER_TOOLS`;
  2) `READ_TOOLS` + the profile table; 3) `reconcileToolMask` + the ledger
  rules; 4) `restoreAllTools`; 5) the test file.

#### TASK_02 — Wire the mask into the orchestrator
- **Atomic description**: apply the mask at the three call sites — the eager
  call in `executeCurrentPhase` (`executor.ts:344`), the per-turn re-assert in
  the `before_agent_start` hook (`orchestrator/index.ts:38-40`), and the
  terminal restores (completion `executor.ts:290-291`, abort
  `command.ts:110` **before** `invalidateRuntime()`).
- **Context & inputs**: `system-design_02.md` §3.1 (call sites 1–3),
  ADR-60. The hook must return early when `process.env.KSTACK_STEP` is set
  (delegated children only — `repair.ts:164-167`; children also run
  `--no-session`, `spawn.ts:437`), so the mask is main-session only
  (INV-29).
- **Constraints**: the hook resolves the profile from the persisted state
  (`full` when no run is active or the run is terminal/aborted); a delegated
  child's tool set is never touched (ADR-60, D1); the restore clears the
  ledger **only** after `setActiveTools` succeeded; every fake `pi` in the
  test suite grows `getActiveTools`/`setActiveTools`/`getAllTools` stubs.
- **Unhappy paths**: no active run → profile `full`; a stale context →
  catch and skip; the run ends without a terminal restore → the next turn's
  hook restores (the ledger survived the invalidation).
- **Success condition**:
  - Action: `bun test test/toolmask.test.ts test/orchestrator.test.ts`
  - Expected: 0 failures — a masked phase leaves the control tools active; a
    delegated child (env `KSTACK_STEP`) keeps its own tool set; abort during
    a masked phase restores the browser tools and a later `full` phase has
    them back (AC-2, AC-3, AC-6, INV-5, INV-28, INV-29).
- **Execution steps**: 1) the eager call; 2) the hook + the child guard;
  3) the two terminal restores; 4) the fake-`pi` stubs in the 5 test files;
  5) the lifecycle test.

#### TASK_03 — Render the profile in the generated table
- **Atomic description**: `scripts/gen-workflow-table.ts` renders a profile
  column from `PHASE_TOOL_PROFILE`; `orchestrator/README.md` is regenerated;
  `test/workflow-table.test.ts` stays byte-exact.
- **Context & inputs**: `system-design_02.md` §3.1 (the table), INV-18.
- **Constraints**: the README is generated, never hand-edited; the column
  comes from the same table the code uses (no registry field — ADR-45, W3).
- **Unhappy paths**: a phase missing from the table → the generator renders
  `full` and the CI test fails (the table is the single source of truth).
- **Success condition**:
  - Action: `bun run scripts/gen-workflow-table.ts && bun test test/workflow-table.test.ts`
  - Expected: the README is byte-identical to the generated output and the
    test passes (AC-5).
- **Execution steps**: 1) the generator column; 2) regenerate; 3) verify the
  byte-compare test.

### Goal_02 — Untrusted marking (W2)

Mark every byte of browser output that can carry third-party text, and record
it so the provenance guard can find copies later.

#### TASK_04 — The marking primitives
- **Atomic description**: in `lib/content-security.ts` add `plainWrap(body,
  cmd)` (the pinned header line + `UNTRUSTED_BEGIN` + `escapeMarkers(body)` +
  `UNTRUSTED_END`), `TRUSTED_ACK_SHAPES` with the three exact patterns
  (`restart` → `/^Restarting\.\.\.$/`, `dialog-dismiss` → `/^Dialogs will be
  dismissed$/`, `closetab` → `/^Closed tab( \d+)?$/`) and `isTrustedAck(cmd,
  body)`; extract the inline chain envelope into `chainEnvelope(body)`.
- **Context & inputs**: `system-design_02.md` §3.2 (the pinned header, the
  patterns, the deny-by-default rule), ADR-29, ADR-43, ADR-54, ADR-63. The
  daemon's real outputs: `meta-commands.ts:437`, `write-commands.ts:662`,
  `meta-commands.ts:295`.
- **Constraints**: trust is decided by the **output**, never by the command
  id; the trusted set is exactly those three commands — `dialog-accept`,
  `header`, `useragent`, `scroll`, `status` and `viewport` are always
  marked (they echo caller-supplied or page-derived text); `strictWrap` keeps
  the heuristic scan and stays opt-in (`strictContent()` default `false`).
- **Unhappy paths**: a body containing `UNTRUSTED_END` → `escapeMarkers`
  neutralises it; a regex does not match → marked (fail closed).
- **Success condition**:
  - Action: `bun test test/untrusted-marking.test.ts`
  - Expected: 0 failures — the three trusted samples are not wrapped, every
    other command's sample is wrapped, and a trusted command whose output
    carries page text is wrapped (AC-7, AC-8, AC-30).
- **Execution steps**: 1) `plainWrap` + the header text; 2) the patterns +
  `isTrustedAck`; 3) `chainEnvelope`; 4) the test file.

#### TASK_05 — The wrap site
- **Atomic description**: in `tools.generated.ts` hoist `recordUntrusted(body)`
  above the branch, wrap conditionally on `isTrustedAck`, and handle the
  **error path**: `code !== 0` records the error body and wraps it with
  `plainWrap` before returning `isError: true`.
- **Context & inputs**: `system-design_02.md` §3.2 (the binding snippet and
  the error path), INV-6, INV-27, ADR-54, ADR-58. The error path today
  returns at `tools.generated.ts:875-881`, before the wrap site, and
  `classifyError` falls back to the raw stderr (`lib/browse.ts:325-346`).
- **Constraints**: exactly one `recordUntrusted` call per output, before the
  wrap decision; the chain branch keeps its own envelope; `isError` and
  `details` are unchanged (`details.rawStderr` never reaches the model);
  `browser/browse/src/**` is **not** touched (AC-9).
- **Unhappy paths**: a recording error → swallowed (the tool call still
  returns); a wrap error → the original body is returned (fail open, like
  the existing `strictWrap`).
- **Success condition**:
  - Action: `bun test test/untrusted-marking.test.ts`
  - Expected: 0 failures — every browse output is recorded exactly once
    (chain, strict, plain, trusted-ack and the error body) and only the
    wrapping is skipped for a trusted-ack match (AC-7, AC-30, INV-6, INV-27).
- **Execution steps**: 1) hoist the recording call; 2) the conditional wrap;
  3) the error path; 4) the partition test.

### Goal_03 — Cache telemetry (W3)

Make the prompt-cache reuse of every phase measurable, and let an operator
opt into longer cache retention.

#### TASK_06 — The input-only counter
- **Atomic description**: `StepRun` gains `tokensIn` (Σ `usage.input`, the
  fresh prompt part — pi's `input` excludes the cached prefix,
  `stuck.ts:115`); `stepWatchStats()` returns it; the main-step ledger
  payload carries `tokensIn`.
- **Context & inputs**: `system-design_02.md` §3.3, §5 (the
  `stepWatchStats()` shape and the ledger payload), ADR-47. Without this a
  main-session row has no hit-rate, and main rows are the mask's evidence.
- **Constraints**: `tokens` stays input+output (the SPEND measure); the
  naming mapping (`tokensIn`, `cacheRead`/`tokensCacheRead`,
  `cacheCreation`/`tokensCacheCreation`) is stated in §5 and is not renamed.
- **Unhappy paths**: a usage event without `input` → 0; a non-finite value →
  0 (`num()` coercion).
- **Success condition**:
  - Action: `bun test test/cache-telemetry.test.ts`
  - Expected: 0 failures — a main-step row carries a non-zero `tokensIn` and
    the watch's shape matches §5 exactly (AC-11).
- **Execution steps**: 1) the counter; 2) the watch's shape; 3) the ledger
  payload + the `index.ts` write.

#### TASK_07 — The run report rows
- **Atomic description**: `RunReportStep` gains `tokensCacheCreation` and the
  provider-conditional `tokensCacheWrite1h`; `writeRunReport(cwd, workflowId,
  runId?)` gains the run id; the report carries one `phases[]` row per
  `(phaseId, scope)` with `scope ∈ {main, delegated}` and the per-scope
  `cacheHitRate`.
- **Context & inputs**: `system-design_02.md` §3.3, §5, ADR-30, ADR-47,
  ADR-62. The main-scope rows are read through `ledgerPathFor(cwd, state)`
  (`ledger.ts:81`); both call sites pass `state.runId` (`executor.ts:279`,
  `command.ts:129`).
- **Constraints**: the two scopes are **never** averaged; a missing run id
  means no main-scope rows and the report says so; `cacheWrite1h` is
  *omitted* when the provider did not report it, never written as 0;
  `cacheHitRate` = 0 when the denominator is 0; the report is written
  **before** `cleanupRunArtifacts` (the ledger it reads dies with the run).
- **Unhappy paths**: a missing ledger → no main rows, the report says so; a
  non-numeric counter → coerced to 0.
- **Success condition**:
  - Action: `bun test test/cache-telemetry.test.ts`
  - Expected: 0 failures — known counters give the exact expected hit-rate
    for both scopes, the main scope is never mixed with the delegated one,
    and a run without a run id yields no main rows (AC-10, AC-11).
- **Execution steps**: 1) the step fields; 2) the report signature + the
  main-row read; 3) the per-scope aggregation; 4) the tests.

#### TASK_08 — Child cache retention
- **Atomic description**: `config.ts` gains `cacheLong()` (env
  `KSTACK_PI_CACHE_LONG`, default false); `spawn.ts` accumulates
  `usage.cacheWrite1h` into the spawn result; the child env is built
  explicitly and `PI_CACHE_RETENTION` is **deleted** when the flag is off.
- **Context & inputs**: `system-design_02.md` §3.3, ADR-30, ADR-56. The
  child env inherits the whole parent env (`lib/silent-spawn.ts:36-42`), so
  merely not adding the key leaks an operator-exported value.
- **Constraints**: the key is present in the child env **iff** the flag is
  set (INV-10); the value is the fixed string `long`; the child env keeps
  every other inherited variable.
- **Unhappy paths**: an unset flag → the key is removed, not left inherited;
  a child that reports no `cacheWrite1h` → the field is omitted.
- **Success condition**:
  - Action: `bun test test/cache-telemetry.test.ts`
  - Expected: 0 failures — with the flag on the child env carries
    `PI_CACHE_RETENTION=long`; with it off (and the variable exported in the
    parent env) the child env does **not** carry it (AC-12, INV-10).
- **Execution steps**: 1) `cacheLong()`; 2) the child env; 3) the
  `cacheWrite1h` accumulation; 4) the tests.

### Goal_04 — Stuck and budget tuning (W4)

Give a delegated step enough turns to finish real work, and make a budget
trip say which limit to raise.

#### TASK_09 — Per-class turn budgets
- **Atomic description**: `stuck.ts` gains `CLASS_TURN_LIMITS = {EXPLORE: 150,
  WORK: 200, VERIFY: 100}` and `DEFAULT_TURN_LIMIT = 100`;
  `stepBudgetDefaults(phaseId)` uses them; `BUDGET_ENV` is exported.
- **Context & inputs**: `system-design_02.md` §3.4, ADR-31. The flat 60-turn
  limit tripped the scout twice in this sprint's own run; the token budget
  already varies by class (`stuck.ts:270-275`).
- **Constraints**: `KSTACK_PI_STEP_MAX_TURNS` still wins (a number, or
  `off` = unlimited); the token, context and ms budgets are unchanged; the
  values are labelled **provisional** in the module comment; main-session
  watches stay budget-free (INV-19).
- **Unhappy paths**: an unmapped phase id → 100 turns; an invalid env value
  → the default.
- **Success condition**:
  - Action: `bun test test/budget.test.ts`
  - Expected: 0 failures — the three classes and the fallback return
    150/200/100/100, and the env override (number and `off`) wins
    (AC-13).
- **Execution steps**: 1) the table; 2) `stepBudgetDefaults`; 3)
  `BUDGET_ENV`; 4) the tests.

#### TASK_10 — The budget trip report
- **Atomic description**: a `budget-exceeded:` trip is ledgered
  `run-interrupted` (not `quota-parked`); the park message names
  `BUDGET_ENV[dim]`; the new optional `state.budgetRaiseEnv` persists it and
  the ledger `report` carries `raiseWith`.
- **Context & inputs**: `system-design_02.md` §3.4, ADR-62, INV-12. The
  wall-clock and run-token quota sites keep `quota-parked`
  (`executor.ts:961`, `:1152`).
- **Constraints**: the trip burns **no** attempt; the two true quota sites
  are unchanged; the env name survives a restart (it is in the state and the
  ledger, not only in a notification).
- **Unhappy paths**: a park with no dim → no env name; a ledger failure →
  the park still happens (fail soft, like every other ledger write).
- **Success condition**:
  - Action: `bun test test/budget.test.ts`
  - Expected: 0 failures — a tripped budget parks with a message naming the
    env var, the ledger kind is `run-interrupted`, and the persisted state
    carries the same env name (AC-14, INV-12).
- **Execution steps**: 1) the ledger kind; 2) the state field; 3) the
  message + the ledger payload; 4) the tests.

### Goal_05 — Verdict residue and parity (C1, C2)

Remove the S4 verdict residue and make the two verdict-validation channels
agree.

#### TASK_11 — Remove the verdict residue
- **Atomic description**: delete the `artifact-mismatch` park cause and its
  producer (`types.ts:303`, `command.ts:583`), the producer-less ledger
  `verdict` kind (`ledger.ts:48`) and the non-flagged `pendingVerdict`
  fallback (`state.ts:411-414`); add the registry validation that a
  verdict-bearing phase declares a flagged step, and the **non-verdict**
  `verdict-config:<phaseId>` pause for the runtime case.
- **Context & inputs**: `system-design_02.md` §3.5, ADR-33 (superseded in
  part by ADR-51), ADR-51, INV-15. The park reason is not a
  `VerdictParkCause` member, so the vocabulary stays stable.
- **Constraints**: no `VerdictParkCause` member changes meaning; the park
  offers **Abort only** (no Resume: re-running a step cannot fix a
  registry mistake, and a Resume that re-parks is a click-loop); the
  remaining causes (`no-verdict`, `unroutable`, `no-expectation`,
  `foreign-verdict`) behave exactly as before.
- **Unhappy paths**: a verdict-bearing phase with no flagged step → the CI
  test fails; the same state at runtime → the `verdict-config:<phaseId>`
  pause, never a fallback route.
- **Success condition**:
  - Action: `grep -rn "artifact-mismatch" --include=*.ts . | wc -l` and
    `bun test test/sprint.test.ts test/orchestrator.test.ts test/run-cleanup.test.ts test/remediation.test.ts`
  - Expected: the grep prints `0` (only this file's own prose may mention
    it), the four suites pass, and `remediation.test.ts` is unchanged
    (AC-17, AC-18, AC-19, AC-20).
- **Execution steps**: 1) the type + the producer; 2) the ledger kind; 3)
  the fallback + the registry validation; 4) the pause + the panel branch;
  5) the test updates.

#### TASK_12 — The verdict value leaf
- **Atomic description**: new leaf module `orchestrator/verdict-values.ts`
  hosting `verdictValuesFor` (moved from `templates.ts:1243`) and
  `acceptedVerdictValues` (moved from `repair.ts:137`); `repair.ts`,
  `templates.ts` and `command.ts` import from it; `repair.ts:97` accepts a
  value **iff** it is in `acceptedVerdictValues`; `buildRecordContract` lists
  the same values.
- **Context & inputs**: `system-design_02.md` §3.6, ADR-34, ADR-52. The
  module graph must stay acyclic: `repair.ts:23` already imports
  `templates.ts`.
- **Constraints**: the CLI's `KSTACK_VERDICT_VALUES` publisher stays in
  `repair.ts:176`; the router (`state.ts`) keeps `NEGATIVE_VALUES` — it
  routes, it does not accept; the hints list the freezing severities.
- **Unhappy paths**: a value off the per-key list → refused by both
  channels and the record parks `unroutable`; a key with no expectation
  entry → `foreign-verdict`.
- **Success condition**:
  - Action: `bun test test/verdict-parity.test.ts test/report-validation.test.ts`
  - Expected: 0 failures — for every registry phase, key and value the
    repair decision equals the CLI's, and the contract hint lists exactly
    `acceptedVerdictValues` (AC-21, AC-22).
- **Execution steps**: 1) the leaf module; 2) the three importers; 3)
  `repair.ts:97`; 4) the hints; 5) the parity test.

### Goal_06 — The provenance guard (TB-10)

Find, quarantine and escalate verbatim copies of untrusted content that
reached a sprint artifact, without a human reading every string.

#### TASK_13 — The contained writers
- **Atomic description**: new `orchestrator/safe-append.ts` with
  `safeAppend(cwd, relDir, fileName, line)` and `safeCopyFile(cwd, srcRel,
  destRel)`; `appendLedger` is refactored to use it (behaviour-preserving);
  `records.ts` exports `safeSegment`.
- **Context & inputs**: `system-design_02.md` §3.8, ADR-38, ADR-53. The
  containment today lives only in `appendLedger` (`ledger.ts:96-129`).
- **Constraints**: the directory's `realpath` must stay inside the repo's;
  a symlinked file or directory is refused; `safeAppend` appends one line
  atomically; `safeCopyFile` copies a file (a backup is a copy, not an
  append); neither throws.
- **Unhappy paths**: any containment failure → return `false`, the caller
  continues (fail soft, like the ledger today).
- **Success condition**:
  - Action: `bun test test/safe-append.test.ts test/ledger.test.ts`
  - Expected: 0 failures — a symlinked ledger file or directory is refused,
    a normal append still works, and a copy produces the same bytes
    (AC-27, INV-24).
- **Execution steps**: 1) the module; 2) the `appendLedger` refactor; 3)
  `safeSegment`; 4) the tests.

#### TASK_14 — The taint store
- **Atomic description**: new `orchestrator/taint.ts` with `tokens(text)`,
  `shingleHashes(text, k = 8)`, `recordUntrusted(body, cwd)`,
  `loadTaint(cwd, runId)`, `SHINGLE_K = 8`, `TAINT_MAX_BYTES = 16 MiB`; the
  path is `projectRootFor(cwd) + "/.kstack/runs/" + safeSegment(runKey) +
  "/taint.jsonl"`.
- **Context & inputs**: `system-design_02.md` §3.8, ADR-39, ADR-57, ADR-61.
  The tokenisation is shared by both sides: NFKC, lower-case, tokens =
  `/[\p{L}\p{N}_]+/u`; a shingle is 8 consecutive tokens; the hash is
  FNV-1a 32-bit.
- **Constraints**: the **session** cwd on every side (the write side takes
  `ctx.cwd`; the read side takes the same root) — `process.cwd()` is wrong
  (ADR-61, INV-30); the store holds integers only, one ≤ 3 KiB line per
  append; recording stops at `TAINT_MAX_BYTES`; a run without a run id
  disables the store; the file dies with the run.
- **Unhappy paths**: a partial or garbled line → skipped by `loadTaint`,
  which never throws; a missing file → an empty set; a write failure → the
  tool call still succeeds.
- **Success condition**:
  - Action: `bun test test/provenance.test.ts`
  - Expected: 0 failures — the file holds only `{"h":[…]}` lines, a
    symlinked directory is refused, a partial line is skipped, the size
    bound holds, and the write and the read resolve the same path even when
    the process cwd differs (AC-27, INV-24, INV-30).
- **Execution steps**: 1) the tokenisation + the hashes; 2) the writer; 3)
  the reader; 4) the tests.

#### TASK_15 — The guard
- **Atomic description**: new `orchestrator/provenance.ts` with
  `guardArtifact(text, taint)` (quarantine the copied runs, lossless and
  idempotent), `guardTargets(phase, cwd, sprint)` (the `produces` rule: a
  root file matches `stem.md` or `stem_<currentSprintNN>.md`, case
  insensitively), `childMayBrowse(agent)`, `MIN_RUN_WINDOWS = 5`,
  `MIN_RUN_TOKENS = 12`.
- **Context & inputs**: `system-design_02.md` §3.8, ADR-37, ADR-42, ADR-44,
  ADR-49, ADR-58. A copied run is ≥ 5 consecutive tainted windows (≥ 12
  consecutive tokens); matching is artifact-scoped and segment-scoped.
- **Constraints**: the quarantine wraps the copied lines in
  `UNTRUSTED_BEGIN/END` and **never deletes or rewords** them; the guard is
  idempotent (a second pass finds no span); only the current sprint's
  stamped files are targets; `childMayBrowse` is true for every agent
  without a `tools:` line (7 of 10, incl. `qa-engineer`) and for any agent
  listing a browser tool.
- **Unhappy paths**: an artifact over 1 MiB → skipped with a ledger
  `report`; a symlinked artifact or one outside the repo → skipped; a
  guard error → the run continues (fail open).
- **Success condition**:
  - Action: `bun test test/provenance.test.ts`
  - Expected: 0 failures — a planted 12-token copy ends inside an envelope
    and the rest of the file is untouched; a Markdown-reflowed copy is still
    found; a second pass changes nothing; the `produces` rule resolves
    `system-design` → `system-design_02.md` and `adr-log` → `ADR-log_02.md`
    but never `system-design_01.md` (AC-25, AC-28, AC-29, INV-22, INV-25,
    INV-26).
- **Execution steps**: 1) the shingle matcher; 2) the quarantine; 3) the
  targets; 4) the trigger helper; 5) the tests.

#### TASK_16 — Wire the guard
- **Atomic description**: run the guard after a browse-capable step — a main
  step of a phase whose profile is not `none` (in the `kstack_advance`
  handler, `index.ts:237-394`) and a delegated step whose agent can browse
  (in `executor.ts`, before the verdict handling at ~`:742-760`); back the
  file up before the first rewrite; park on an instruction-shaped copy.
- **Context & inputs**: `system-design_02.md` §3.8 (the trigger, the
  backup, the park, the post-rewrite line map), ADR-37, ADR-40, ADR-49.
- **Constraints**: the backup goes to `.kstack/guard-backup/<safeSegment(runKey)>/`
  through `safeCopyFile` (a failed copy means the file is **not** rewritten);
  the rewrite is atomic (temp file + `renameSync`); the park list is
  computed from the **rewritten** file and carries the nearest heading; the
  park reason is `provenance-review:<phase>:<step>`, burns no attempt, and
  the panel offers Accept / Re-run / Abort.
- **Unhappy paths**: no taint recorded → the guard is a no-op (one `stat`);
  the store is full or tampered → **degraded mode**: the injection scan runs
  over the whole artifact and the same park fires; a guard error → a ledger
  `report` and the run continues.
- **Success condition**:
  - Action: `bun test test/provenance.test.ts`
  - Expected: 0 failures — a hostile copy parks with a ≤ 10-line list and no
    attempt burned, a clean copy advances with no human step, the backup
    holds the pre-guard bytes, and the quoted line numbers match the
    rewritten file (AC-25, AC-26, INV-23).
- **Execution steps**: 1) the two hook sites; 2) the backup + the atomic
  rewrite; 3) the park + the panel branch; 4) the degraded mode; 5) the
  tests.

#### TASK_17 — The park decision surface
- **Atomic description**: `parkedGateId` (`command.ts:75`) learns the prefixes
  `provenance-review:` and `verdict-config:`; the sprint panel gains the
  Accept / Re-run / Abort branch for the first and the Abort-only branch for
  the second.
- **Context & inputs**: `system-design_02.md` §3.5, §3.8, ADR-40, ADR-51,
  ADR-54. The panel matches a prefix whitelist (`command.ts:585-706`); an
  unknown prefix falls to the generic panel, whose Resume would re-park
  forever.
- **Constraints**: Accept continues without re-running the guard; Re-run
  re-checks the artifact (the human edits the lines out first) and a
  surviving match re-parks — every iteration costs one human click, and no
  attempt is consumed; the `verdict-config:` park offers Abort only.
- **Unhappy paths**: the selection is dismissed → the run stays parked; the
  panel's guard (an in-flight chain) → the decision is refused.
- **Success condition**:
  - Action: `bun test test/remediation.test.ts test/orchestrator.test.ts`
  - Expected: 0 failures — a `provenance-review:` park shows the three
    choices and a `verdict-config:` park shows Abort only (AC-20, AC-26).
- **Execution steps**: 1) the prefix list; 2) the provenance branch; 3) the
  verdict-config branch; 4) the tests.

---

## ROLE — QA-ENGINEER

### Goal_07 — Verification and the C3 baseline

Prove the sprint's acceptance criteria, then use this run's own numbers to
calibrate the provisional budgets.

#### TASK_18 — The full verification pass
- **Atomic description**: run the whole suite and the type check; add the
  new test files the backend lane's tasks name; confirm the two
  implementation-surface greps.
- **Context & inputs**: AC-24; `system-design_02.md` §10 (the verification
  plan). New test files: `test/toolmask.test.ts`,
  `test/untrusted-marking.test.ts`, `test/cache-telemetry.test.ts`,
  `test/verdict-parity.test.ts`, `test/budget.test.ts`,
  `test/safe-append.test.ts`, `test/provenance.test.ts`.
- **Constraints**: no file under `browser/browse/src/` changed (AC-9);
  `grep -rn "artifact-mismatch" --include=*.ts .` returns 0 (AC-17); every
  AC-1..AC-30 is claimed by a task and has a green test or a green command.
- **Unhappy paths**: a failing test ⇒ the owning backend task is re-issued
  (never patched around in the test); a flaky test ⇒ it is quarantined with
  a note, never silently retried.
- **Success condition**:
  - Action: `bun test && npx tsc --noEmit && git diff --stat -- browser/browse/src`
  - Expected: the suite is green, `tsc` reports no errors, and the daemon
    diff is empty (AC-9, AC-24).
- **Execution steps**: 1) the suite; 2) the type check; 3) the two greps;
  4) the AC claim table.

#### TASK_19 — The C3 baseline and the calibration
- **Atomic description**: read this sprint's run report and ledger, write
  the observed per-phase numbers into the retro artifact, and confirm or
  adjust the provisional thresholds.
- **Context & inputs**: `system-design_02.md` §3.3 (the main-scope rows are
  the mask's evidence), §3.4, ADR-35, AC-15, AC-23. The report is
  `.kstack/runs/<runId>.json`; the thresholds are `stepBudgetDefaults`
  (turns 150/200/100, tokens 400k/600k/300k, context 180k, ms 30 min).
- **Constraints**: read the **main-scope** rows for the mask's effect and
  the delegated rows separately (never averaged); the thresholds stay
  **provisional** until more runs exist; every value stays env-overridable.
- **Unhappy paths**: no run report (the run never finished) → the retro says
  so and the thresholds stay provisional; a phase with no main rows → the
  gap is recorded rather than filled with an estimate.
- **Success condition**:
  - Action: `ls .kstack/runs/*.json` and the retro artifact's numbers
  - Expected: the run report exists with per-phase timings, per-phase
    hit-rate per scope and the budget stats, and the retro records the
    observed turns/tokens/context/ms against the provisional defaults
    (AC-15, AC-23).
- **Execution steps**: 1) read the report + the ledger; 2) compare with the
  defaults; 3) write the retro; 4) propose any adjustment.

---

## ROLE — BACKEND DEVELOPER (deferred, not in this sprint)

#### TASK_20 ~out-of-scope — The sprint-numbering collision guard
- **Atomic description**: the permanent fix for the sprint-number collision
  that paused this run: the root/archive collision guard
  (`orchestrator/sprint.ts:88-104`) should not fire for a legacy archive.
- **Context & inputs**: ADR-36; the run was unblocked by renaming the stale
  legacy archive `sprint_01` → `sprint_00`.
- **Constraints**: deferred — the guard must keep refusing a genuinely
  ambiguous state (the same number in the root and in the archive).
- **Success condition**: deferred to a follow-up sprint; recorded in the
  backlog, not implemented here.

### ~out-of-scope items (recorded, not built)

- **Reserve-then-settle** — design note only (ADR-32, AC-16); it needs the
  S5b DAG executor.
- **A host allowlist for the `read` profile** (`KSTACK_PI_READ_URL_ALLOW`) —
  the follow-up for residual R2 if the retro shows planners browsing
  external hosts.
- **Enforcing the profile for delegated children** — the child's effective
  tool set is pi's default for 7 of 10 agents; enforcing it needs pi's
  built-in tool names, which the extension cannot enumerate.
- **Child-written taint integrity** (residual R6) — S5b's event-driven
  delegation can stream hashes instead of sharing a file.
- **The eval harness, DAG executor, memory redesign** — S5b.

---

## 4. AC claim table

| AC | Task |
|---|---|
| AC-1 profile table | TASK_01 |
| AC-2 reconcile | TASK_01, TASK_02 |
| AC-3 control tools survive | TASK_01, TASK_02 |
| AC-4 profile assignment | TASK_01 |
| AC-5 README table | TASK_03 |
| AC-6 fake-pi stubs | TASK_02 |
| AC-7 untrusted output wrapped | TASK_04, TASK_05 |
| AC-8 strictContent default | TASK_04 |
| AC-9 no daemon change | TASK_05, TASK_18 |
| AC-10 cache fields | TASK_07 |
| AC-11 hit-rate per scope | TASK_06, TASK_07 |
| AC-12 child retention flag | TASK_08 |
| AC-13 turn limits | TASK_09 |
| AC-14 budget trip message | TASK_10 |
| AC-15 provisional thresholds | TASK_19 |
| AC-16 reserve-then-settle note | already in `system-design_02.md` §8 |
| AC-17 no artifact-mismatch | TASK_11 |
| AC-18 no ledger verdict kind | TASK_11 |
| AC-19 no pendingVerdict fallback | TASK_11 |
| AC-20 tests updated | TASK_11, TASK_17 |
| AC-21 repair/CLI parity | TASK_12 |
| AC-22 contract hints | TASK_12 |
| AC-23 the run report | TASK_19 |
| AC-24 suite + tsc | TASK_18 |
| AC-25 quarantine | TASK_15, TASK_16 |
| AC-26 escalation | TASK_16, TASK_17 |
| AC-27 taint store | TASK_13, TASK_14 |
| AC-28 guard targets | TASK_15 |
| AC-29 childMayBrowse | TASK_15 |
| AC-30 record coverage | TASK_04, TASK_05 |

## 5. Dependency graph

```
TASK_01 ──► TASK_02 ──► TASK_03
TASK_04 ──► TASK_05
TASK_06 ──► TASK_07 ──► TASK_08
TASK_09 ──► TASK_10
TASK_11 ──► TASK_12
TASK_13 ──► TASK_14 ──► TASK_15 ──► TASK_16 ──► TASK_17
(all backend tasks) ──► TASK_18 ──► TASK_19
```

Cross-lane: TASK_18 and TASK_19 depend on the backend lane. The lanes share
`test/`, so `parallel-safe==false`.
