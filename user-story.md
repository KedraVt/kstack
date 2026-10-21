# User Story 02 — Evolution: foundation hardening (kstack S5a)

## Goal

As a **kstack operator** (and the agents executing its workflows), I want
the S3/S4 orchestrator hardened — fewer irrelevant tools in each phase's
context, untrusted browser content always marked, cache reuse measured per
phase, subagent budgets that fit real work, and the S4 verdict residue
removed — so that runs are cheaper, safer, observable, and stop wasting work
on budget trips caused by guessed limits.

## Actor

- **Operator**: runs workflows, reads the run report and park messages,
  tunes limits through env.
- **Executing agent** (main session and delegated subagents): receives only
  the tools its phase needs; sees third-party text fenced as data.
- **Maintainer**: finds one verdict path (no dead park cause / ledger kind /
  fallback branch) and one source of truth for accepted verdict values.

## Outcome

After this sprint: each phase declares a browser-tool profile
(`full` / `read` / `none`) and the active tool set is masked at phase entry
with the control tools never hidden; browser tools that can carry
third-party text always return wrapped output; the run report carries
per-phase cache hit-rate including cache-creation for delegated steps;
subagent turn limits are per timeout class and a budget trip names its fix;
`artifact-mismatch`, the producer-less ledger `verdict` kind and the
non-flagged `advancePhase` branch are gone; `repair.ts` and the contract
hints agree with `kstack-report`; and this sprint's own run is the recorded
C3 baseline.

## Acceptance criteria (falsifiable)

### W1 — Browser-tool masking

- [ ] AC-1 — Every phase in `orchestrator/workflows.ts` resolves to exactly
  one of the profiles `full`, `read`, `none`; a phase with no declaration
  resolves to `full`. A unit test enumerates all phases and asserts this.
- [ ] AC-2 — Entering a phase calls `pi.setActiveTools` with
  `getActiveTools()` minus the browser tools outside the phase's profile;
  built-ins (bash/read/edit/write) and unrelated non-browser tools are
  never removed. A test asserts the set difference for each profile.
- [ ] AC-3 — `kstack_advance` and `kstack_phase` are present in the active
  set for every phase and every profile (registry-wide test).
- [ ] AC-4 — Profile assignment: `qa-browsing` (sprint/develop/review),
  `regression-qa`, `reproduce` → `full`; develop `plan` and sprint
  `understand`, `user-story`, `capability`, `system-design`, `backlog` →
  `read`; `read` contains **no interaction tool** (click, fill, type, press,
  select, hover, upload), **no cookie/header/useragent/style/session-state
  tool**, and no `chain`/`js`/`eval`; the navigation family stays in `read`
  (R2, accepted by the user).
- [ ] AC-5 — `orchestrator/README.md` renders the profile per phase and
  `test/workflow-table.test.ts` passes byte-for-byte.
- [ ] AC-6 — All fake `pi` objects in the test suite implement
  `setActiveTools`/`getActiveTools`; the full test suite is green.

### W2 — Untrusted marking

- [ ] AC-7 — Every browser tool in the declared untrusted set (console,
  network, cookies, storage, js, eval, html, plus the existing page-content
  commands) returns output between `UNTRUSTED_BEGIN/END` with markers inside
  the payload escaped, with `strictContent()` OFF. A table-driven test
  asserts the wrapper for each tool in the set.
- [ ] AC-8 — `strictContent()` default is still `false`; the heuristic scan
  does not run unless `KSTACK_PI_STRICT_CONTENT` is set.
- [ ] AC-9 — No file under `browser/browse/src/` is modified (git diff
  empty for that path); docs and code name the S5a mechanism "untrusted
  marking".

### W3 — Cache telemetry

- [ ] AC-10 — `RunReportStep` carries `cacheCreation` and `cacheWrite1h`
  for delegated steps, populated from the child's usage; a test feeds a
  fake usage event and asserts both fields in the written run report.
- [ ] AC-11 — The run report contains a per-`(phaseId, scope)` `cacheHitRate =
  cacheRead / (input + cacheRead + cacheWrite)` (0 when the denominator is 0),
  where `input` is the input-only count (the delegated step's `usage.input`,
  the main step's new `tokensIn` ledger field); a test with known counters
  asserts the exact value for both scopes, and a main-step row has one at all.
- [ ] AC-12 — Spawned children receive `PI_CACHE_RETENTION=long` only when
  the new opt-in env flag is set; with the flag unset the child env does
  not contain it (two assertions).

### W4 — Budget and stuck tuning

- [ ] AC-13 — `stepBudgetDefaults(phaseId)` returns turns EXPLORE=150,
  WORK=200, VERIFY=100 and 100 for an unmapped phase; `KSTACK_PI_STEP_MAX_TURNS`
  set to a number or `off` overrides every class.
- [ ] AC-14 — A budget trip park message contains the env variable name
  that raises the tripped dimension, and the trip is not ledgered with
  kind `quota-parked`.
- [ ] AC-15 — Calibrated threshold values are recorded in the run report /
  docs marked `provisional`, each overridable by env.
- [ ] AC-16 — Reserve-then-settle exists as a design note in
  `system-design_02.md` and no reserve/settle code is added.

### C1 — Verdict residue

- [ ] AC-17 — `grep -rn "artifact-mismatch"` over `*.ts` returns no
  matches; `VerdictParkCause` no longer contains it; `command.ts` no
  longer branches on it.
- [ ] AC-18 — `LedgerEntry.kind` no longer includes `"verdict"`; no
  compile error anywhere.
- [ ] AC-19 — `advancePhase` has no non-flagged `pendingVerdict` fallback;
  a verdict-bearing phase without a flagged step fails registry validation
  or a test, not silently.
- [ ] AC-20 — Tests formerly asserting `artifact-mismatch`
  (`sprint.test.ts`, `orchestrator.test.ts:1846-47`,
  `run-cleanup.test.ts:105`) assert the remaining causes; `remediation.test.ts:89,173`
  (`no-verdict`, `unroutable`) are unchanged.

### C2 — Report vs trust-check parity

- [ ] AC-21 — For any (phase, key, value) the accept decision of
  `repair.ts` equals the decision of `kstack-report` (both derived from
  `acceptedVerdictValues`); a parity test over all registry phases and keys
  asserts equality, including a case where a global `NEGATIVE_VALUES` entry
  (e.g. `rejected`) is refused for a key that doesn't list it.
- [ ] AC-22 — `buildRecordContract` hints list exactly
  `acceptedVerdictValues` for each key, including the freezing severities
  from `parkOn`/`loopBackOn`.

### C3 — Real-run evidence

- [ ] AC-23 — This sprint's run report exists under `.kstack/runs/` with
  per-phase timings, per-phase cache hit-rate and the budget stats, and the
  provisional thresholds in AC-15 cite it.

### Whole-sprint

- [ ] AC-24 — `npm test` (full suite) is green and `tsc --noEmit` reports
  no errors on the final commit.

## Out of scope

Per-step masks, semantic tool retrieval, daemon-side marking, USD budget
dimension, reserve-then-settle code, CodeAct, eval harness (S5b).

### Added at the architect gate — provenance guard (W2 extension, TB-10)

- [ ] AC-25 — Property test: for an artifact containing a verbatim copy (≥ 12
  tokens, also after Markdown reflow) of recorded untrusted output, the guard
  returns text where that copy is inside `UNTRUSTED_BEGIN/END`; unrelated text
  is untouched; a second pass changes nothing (INV-22).
- [ ] AC-26 — A taint-verified copied passage matching the injection patterns parks the run
  `provenance-review:<phase>:<step>` with a ≤ 10-line `file:line` list and no
  attempt consumed; the `/kstack` panel offers Accept / Re-run / Abort; a clean
  copy advances with no human step (INV-23).
- [ ] AC-27 — The taint store holds integer lines only, is written via
  `safeAppend` (a symlinked directory or file is refused), never exceeds
  `TAINT_MAX_BYTES` (16 MiB) + 3 KiB per concurrent writer, a partial line is
  skipped by `loadTaint`, and spawned children receive `KSTACK_TAINT_RUN` (INV-24).
- [ ] AC-28 — `guardTargets` resolves each `produces` id of the sprint planning
  phases to its existing root file (`system-design`→`system-design_NN.md`,
  `adr-log`→`ADR-log_NN.md`); a planted copy in `capability.md` is quarantined
  (INV-25).
- [ ] AC-29 — `childMayBrowse` is true for all 7 agents without a `tools:` line
  (incl. `qa-engineer`) and for `scout`; false for `planner` and `reviewer`
  (INV-26).
- [ ] AC-30 — A `chain` result and a strict-mode result are recorded exactly
  once; **every** browse output is recorded (trusted-ack included) and only the
  wrapping is skipped for a trusted-ack shape match; the trusted set is exactly
  `restart`, `dialog-dismiss`, `closetab`; `dialog-accept`, `header`,
  `useragent`, `scroll`, `status` and `viewport` are always wrapped; **a tool
  error body is recorded and wrapped for every command**, and a trusted-ack
  shape never exempts an error body (INV-27, INV-6).

Amended at the gate: **AC-1** is satisfied by a literal `PHASE_TOOL_PROFILE` table
with one key per (workflow, phase) pair (a missing key fails the test, runtime
default `full`); **AC-7** uses content-verified trusted-ack shapes instead of a
command list.

### Amended after the third architect review (F1–F8)

- **F1** AC-30's trusted set is exactly `restart`, `dialog-dismiss`,
  `closetab`; the other four echo caller-supplied text and are always marked.
- **F2** AC-11 needs the new input-only `tokensIn` counter, otherwise a
  main-session row has no hit-rate.
- **F3** The report's `phases[]` rows carry `scope: "main" | "delegated"`.
- **F4** AC-4 is the enumeration above (navigation stays in `read`).
- **F5** AC-28's `produces` rule targets `stem_<currentSprintNN>.md` only, and
  the pre-guard content is backed up under
  `.kstack/runs/<runKey>/guard-backup/`.
- **F6** AC-2's fake pi mirrors pi's rule of dropping unknown tool names.
- **F7** AC-20's misconfigured-gate case uses `verdict-config:<phaseId>`.
- **F8** The value helpers live in `orchestrator/verdict-values.ts` (no cycle).

### Amended after the fourth risk pass (H1–H5)

- **H1** AC-26's panel offers Accept / Re-run / Abort for the provenance park;
  the separate `verdict-config:<phaseId>` park (AC-20) offers Abort only.
- **H2/H3** AC-25's quarantine keeps a pre-guard copy under
  `.kstack/guard-backup/<runKey>/` (a contained copy; a symlinked source or a
  failed copy means the artifact is not rewritten).
- **H4** AC-11's main and delegated rows use the same `input` convention.
- **H5** The backup directory is pruned at run start.

### Amended after the fourth architect review (C1–C3, W1–W6)

- **C1** AC-20's misconfigured-gate case uses `verdict-config:<phaseId>` (one
  reason everywhere).
- **C2** AC-30's recording covers a trusted-ack output.
- **C3** AC-30 adds the tool-error path.
- **W1** The taint module is `orchestrator/taint.ts`; no `lib/` file imports
  `orchestrator/`.
- **W2** `PI_CACHE_RETENTION` is absent from the child env when the flag is
  off, even if the operator exported it.
- **W3** The taint store exists only for a real run id and dies with the run.
- **W4** AC-11's main-row inputs (`tokensIn`) are in the ledger payload.
- **W6** The taint path is `<project root>/.kstack/runs/<runId>/taint.jsonl`.

### Amended after the sixth architect review (C1, W1–W8) and the fifth review's D1/D2

- **C1** AC-2's mask lifecycle: the ledger survives `invalidateRuntime`; an
  abort during a masked phase restores the browser tools, and a later `full`
  phase in the same session has them back.
- **D1** AC-2's scope: a delegated child (env `KSTACK_STEP`) is never masked,
  so the `scout` step of every `explore` phase keeps its browser tools.
- **D2** AC-27's path: the taint store is written, read and deleted under the
  **session** cwd, so the guard and the store always agree.
- **W1** AC-11's main-scope rows are computable: the report contract carries
  the run id, and a report without one states that no main rows exist.
- **W2** AC-12's env name is persisted, so the panel shows it after a restart.
- **W3** AC-25's backup directory is sanitised like the taint path.
- **W4** The chain envelope is extracted into `chainEnvelope()`.
- **W5** AC-10's field names: the run-report row uses the `tokens*` prefix;
  the mapping is in the design.
- **W6** AC-30's trusted set publishes its exact patterns.
- **W7** AC-1's table test covers all 38 pairs even when the sprint workflow
  is disabled.
- **W8** The hook's child-safety preconditions are stated in the design.
