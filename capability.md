# Capability 02 — Evolution: foundation hardening (kstack S5a)

Input: `user-story.md` (AC-1..AC-24), `understand.md` (Settled Decisions),
`explore-notes.md`. Output feeds `system-design` and `backlog`.

## CAPABILITY

After S5a, the orchestrator (a) restricts the browser-tool set per phase by
a declared profile, (b) always fences output of browser tools that can carry
third-party text, (c) reports per-phase cache reuse including delegated-step
cache-creation, (d) enforces per-timeout-class turn limits for delegated
steps and reports which env raises a tripped limit, and (e) has one verdict
validation rule shared by `kstack-report` and `repair.ts`, with the S4
residue (`artifact-mismatch`, ledger `verdict` kind, non-flagged
`advancePhase` branch) removed. Operator is the human running workflows;
the executing agent is the model inside a phase.

## CONSTRAINTS — invariants (each boolean-checkable)

### Fixed policy (decided in `understand.md`)

- **INV-1** `kstack_advance` and `kstack_phase` are in the active tool set
  after masking for every phase × profile combination.
- **INV-2** Masking removes only names in the browser-tool set
  (`TOOLS` in `tools.generated.ts`); the active set after masking ⊇
  (active set before) ∖ (browser tools outside the profile). No other tool
  is removed.
- **INV-3** Every phase resolves to exactly one profile ∈ {`full`,`read`,
  `none`}; undeclared ⇒ `full`.
- **INV-4** `read` ∩ {click, fill, select, hover, type, press, upload,
  cookie, cookie_import, cookie_import_browser, header, useragent, style,
  cleanup, dialog_accept, dialog_dismiss, download, scrape, daemon_restart,
  state(save/load), handoff, resume, chain, js, eval} = ∅ — the **AC-4
  enumeration**: no interaction, no cookie/header/useragent/style/session-state,
  no arbitrary command or script. The **navigation family stays in `read`**
  (R2, accepted by the user), so INV-4 is NOT "no page or session mutation";
  a `read` phase may open and navigate pages, and may write a daemon-validated
  screenshot image.
- **INV-5** Masking is applied on every phase transition path (the
  `launchPhase` funnel), including `/kstack next`, loop-back, resume and
  re-run; no path leaves the previous phase's mask in force.
- **INV-6** With `strictContent()` OFF, output of every browse command, unless it matches that command's fixed trusted-ack shape (content-verified, not id-based; the trusted set is `restart`, `dialog-dismiss`, `closetab` — the commands whose output is a fixed string), is `UNTRUSTED_BEGIN … UNTRUSTED_END` with `escapeMarkers`. **The error path counts too (C3):** a tool failure returns before the normal wrap site and its body can carry raw stderr, so it is recorded and wrapped as well, and a trusted-ack shape never exempts an error body
  applied to the payload; the heuristic scan is not executed.
- **INV-7** `strictContent()` default is `false`.
- **INV-8** No file under `browser/browse/src/` changes.
- **INV-9** `cacheHitRate = cacheRead / (input + cacheRead + cacheWrite)`,
  and is 0 when the denominator is 0. `input` is the input-only count: the
  delegated step's `usage.input`, the main step's new `tokensIn` ledger field
  (added in S5a — without it a main-session row's hit-rate is undefined).
- **INV-10** `PI_CACHE_RETENTION` is present in a child's env iff the
  opt-in flag is set (default unset ⇒ absent).
- **INV-11** `stepBudgetDefaults(phaseId).turns` ∈ {150 EXPLORE, 200 WORK,
  100 VERIFY, 100 unmapped}; env `KSTACK_PI_STEP_MAX_TURNS` always wins.
- **INV-12** A budget-exceeded park message contains the env name for the
  tripped dimension; its ledger kind ≠ `quota-parked`.
- **INV-13** For every (workflow, phase, key, value), `repair.ts` accepts
  ⇔ `kstack-report` accepts ⇔ `value ∈ acceptedVerdictValues(...)`.
- **INV-14** `buildRecordContract` lists exactly `acceptedVerdictValues`
  per key.
- **INV-15** After C1, a verdict-bearing phase without a flagged step fails a registry test, and if such state is ever reached at runtime the run pauses with the **non-verdict** reason `verdict-config:<phaseId>` (a new reason string, not a `VerdictParkCause` member); it is never routed through a fallback. No `VerdictParkCause` member changes meaning.

### Preserved from earlier sprints (must not regress)

- **INV-16** Prompt-prefix byte-stability (`templates.ts:1001-1006`
  assembly order) is unchanged: masking changes the tool set only at phase
  boundaries, never within a phase.
- **INV-17** Verdict routing stays one-way: steps emit records, the
  orchestrator merges and routes; no new path lets model output alter
  routing.
- **INV-18** `orchestrator/README.md` equals the generated registry table
  (`test/workflow-table.test.ts`).
- **INV-19** Main-session step watches stay budget-free (stuck rules only);
  only delegated steps carry budgets.
- **INV-20** Skill bodies contain zero telemetry calls; telemetry stays in
  the orchestrator (project convention).
- **INV-21** Headless/spawned steps never block on `ask_user_question`.

## TRUST BOUNDARIES (enumerated — input to the risk scan)

| # | Boundary | Untrusted side → trusted side | Control after S5a |
|---|---|---|---|
| TB-1 | Web page → browse daemon → tool result → model context | Third-party page text, console, network, cookies, storage, JS results | Always-on sentinel envelope + `escapeMarkers` for the untrusted set; `SECURITY_SECTION` in system prompt; heuristic scan opt-in |
| TB-2 | `chain` batch result → model | Aggregated sub-command output | Existing unconditional chain envelope (unchanged) |
| TB-3 | Model → tool call (browser mutate tools) | Model-chosen args to click/fill/cookie/header… | `read` and `none` profiles remove mutating tools from phases that don't need them (reduces blast radius of an injected instruction) |
| TB-4 | Model → `kstack-report` CLI → step record on disk | Model-authored verdict values | Write-time per-key enforcement; `repair.ts` re-validates with the same `acceptedVerdictValues` (C2) |
| TB-5 | Step record / verdict files → orchestrator router | On-disk records (could be planted or stale) | Fail-closed park on no-verdict/unroutable/no-expectation/foreign-verdict; the legacy fallback branch is removed |
| TB-6 | Orchestrator → spawned child process (env, argv) | Env passthrough (`PI_CACHE_RETENTION`, step budgets) | Only the documented opt-in flag adds env; values are fixed strings, never model-controlled |
| TB-7 | Child JSON event stream → telemetry/run report | Child `usage` numbers | Numeric coercion; missing fields default 0; report is write-only data, not read back into routing |
| TB-8 | Operator env → thresholds/flags | `KSTACK_PI_*` env | `numberEnv` parsing with `off`/min handling; invalid values fall back to defaults |
| TB-9 | Ledger / run-report writers → `.kstack/` filesystem | Paths derived from run ids | Existing `appendLedger` symlink containment + allowlisted filename (reuse, no new writer bypassing it) |
| TB-10 | Third-party text inside `explore-notes`/planning docs fed to later phases | Page-derived text copied into artifacts by a `read`-profile planner | Planner output is an artifact reviewed at the phase gate; the marking envelope is stripped only by the author's quoting, never automatically |

## NON-GOALS

- Per-step masks, semantic/retrieval tool selection, CodeAct tool collapse.
- Masking pi built-ins (bash/read/edit/write) or other extensions' tools.
- Daemon-side or classifier changes (`browser/browse/src/**`).
- A USD budget dimension; budgets for main-session watches.
- Reserve-then-settle code (design note only) and any concurrency model.
- Controlling cache breakpoints (pi owns `cache_control`); only the
  retention env knob and measurement.
- Eval harness / pass^k / DAG executor (S5b).
- Making provisional thresholds final — they are recalibrated after more
  runs.

## INTERFACES / DATA IMPLICATIONS

- `WorkflowPhase` gains an optional tool-profile field (name finalised in
  system-design); rendered in the generated README table.
- New module for profile → tool-name sets: `orchestrator/toolmask.ts` with the
  literal `PHASE_TOOL_PROFILE` table (keyed `"workflow:phase"`) and
  `reconcileToolMask(pi, profile)`; **no `WorkflowPhase` field is added** (W3 — the
  mapping is data, not a registry field, so the registry and the README table
  cannot drift);
  called from the `launchPhase` funnel.
- `RunReportStep` gains `cacheCreation`, `cacheWrite1h`; run report gains
  per-phase `cacheHitRate`.
- `LedgerEntry.kind` loses `"verdict"`; `VerdictParkCause` loses
  `"artifact-mismatch"`.
- `lib/content-security.ts` gains a plain-wrap function (envelope without
  heuristic scan); `tools.generated.ts` calls it for the untrusted set.
- `stuck.ts` turn limit becomes a per-class table.
- Test fakes for `pi` gain `setActiveTools`/`getActiveTools`.

## OBSERVABILITY / OPERATOR

- Run report: per-phase `cacheHitRate`, `cacheCreation`, `cacheWrite1h`,
  budget usage; thresholds labelled `provisional`.
- Park message for budget trips names the raising env variable.

## OPEN QUESTIONS

- Exact member list of `read` and of the untrusted set (finalised in
  system-design; invariants INV-4/INV-6 constrain them).
- Whether `none` should still expose `kstack_skill`/`kstack_state`
  (currently treated as browser-only and masked).
- Opt-in env flag name for cache retention (proposal:
  `KSTACK_PI_CACHE_LONG`).
- Where a mask is restored when a phase is re-entered after
  compaction/resume (INV-5 requires it; mechanism is a design item).

## HANDOFF

Ready for `system-design`: no product clarification is blocking. The four
open items above are design decisions with a recommended default each.

## Added at the architect gate (provenance guard, TB-10) — INV-22..27

Mirrors `system-design_02.md` §3.8 / §7; reworded after two architect reviews.

- **INV-22** For every artifact `t` produced by a browse-capable step,
  `guardArtifact(t)` returns `t′` where every token of every copied run (≥ 12
  consecutive tokens, shared NFKC/lower-case/`[\p{L}\p{N}_]+` tokenisation, every
  8-token window in the run's taint set) lies inside an
  `UNTRUSTED_BEGIN/END` envelope, and `guardArtifact(t′)` finds no span.
- **INV-23** A taint-verified copied span matching the injection patterns ⇒ the phase parks
  `provenance-review:<phase>:<step>` and does not advance without a human
  Accept / Re-run / Abort; no other guard outcome blocks the phase; the park
  consumes no attempt.
- **INV-24** The taint store contains only integer-hash lines, is written only
  through `safeAppend` (realpath + lstat containment) at
  `.kstack/runs/<safeSegment(runKey)>/taint.jsonl`, and its size is
  ≤ `TAINT_MAX_BYTES` (16 MiB) + 3 KiB × concurrent writers.
- **INV-25** For every phase whose `produces` ids name markdown files the guard's
  targets include the existing root file (case-insensitive, `stem.md` or
  `stem_<currentSprintNN>.md` only — another sprint's stamp is never a target),
  unioned with `phaseArtifactPaths`.
- **INV-26** The guard's delegated trigger is the child's *effective* tool
  exposure: true for every agent without a `tools:` line and for any agent
  listing a browser tool.
- **INV-27** Every browse output is recorded exactly once before the wrap
  decision — chain, strict, plain, trusted-ack **and the error body** alike;
  only the wrapping is skipped for a trusted-ack shape match on a success body.

Also amended at the gate: **INV-4** is the AC-4 enumeration above (no interaction, no cookie/header/useragent/style/session-state, no chain/js/eval) plus "no file write other than a daemon-validated screenshot image"; navigation stays in `read` (R2, accepted by the user) (`kstack_screenshot` stays
in `read`); **TB-3**'s blast-radius reduction applies to main-session steps only
(7 of 10 agents get pi's default tool set as delegated children); **TB-10**'s
control is the provenance guard, not human review.

### Amended after the third architect review (F1–F8)

- **F1** The trusted-ack set is three commands whose output is a fixed string
  (`restart`, `dialog-dismiss`, `closetab`); `dialog-accept`, `header`,
  `useragent`, `scroll`, `status` and `viewport` are always marked.
- **F2** `INV-9` needs an input-only counter: the step watch gains `tokensIn`
  (Σ `usage.input`) and the main-step ledger payload carries it, so a
  main-session row has a defined hit-rate.
- **F3** The run report's `phases[]` has one row per `(phaseId, scope)`
  (`main` | `delegated`); the two scopes are never averaged.
- **F4** `INV-4` is the AC-4 enumeration; the navigation family stays in
  `read`.
- **F5** Guard targets are stamped with the **current** sprint only; the
  pre-guard content is backed up under the run directory; the park's
  `file:line` list is computed from the rewritten file.
- **F6** pi drops tool names it does not know; the mask adds none and removes
  exactly the masked ones.
- **F7** The misconfigured-gate park uses the new non-verdict reason
  `verdict-config:<phaseId>`; no `VerdictParkCause` member changes meaning.
- **F8** `verdictValuesFor` and `acceptedVerdictValues` move to the leaf
  module `orchestrator/verdict-values.ts`; `templates.ts` and `repair.ts`
  import from it, so no cycle.

### Amended after the fourth risk pass (H1–H5)

- **H1** The misconfigured-gate park (`verdict-config:<phaseId>`) offers Abort
  only — no Resume, so there is no click-loop; the CI registry test is the
  real guard.
- **H2** The guard's backup lives under `.kstack/guard-backup/<runKey>/`, not
  under the run directory (which is deleted at run end).
- **H3** The backup is a contained file copy (`safeCopyFile`: realpath on both
  sides, symlinks refused); a failed copy means the artifact is not rewritten.
- **H4** The `input` convention is identical on both scopes (pi's `input`
  excludes the cached prefix), so a main and a delegated hit-rate are
  comparable.
- **H5** `.kstack/guard-backup/` is pruned (entries older than 14 days) at run
  start.

### Amended after the fourth architect review (C1–C3, W1–W6)

- **C1** One park reason everywhere: the misconfigured gate pauses with the
  non-verdict reason `verdict-config:<phaseId>` (ADR-33 is superseded in part
  by ADR-51).
- **C2** The recording call is hoisted above the branch, so a trusted-ack
  output is recorded too.
- **C3** The tool-error path is recorded and wrapped; the trusted-ack shapes
  never exempt an error body.
- **W1** The taint module lives in `orchestrator/` (`orchestrator/taint.ts`), so
  no `lib/` file imports `orchestrator/`.
- **W2** `PI_CACHE_RETENTION` is deleted from the child env when the flag is
  off (the parent env is inherited wholesale).
- **W3** The run key is `state.runId` only — no workflow-id fallback, so the
  taint file always dies with the run.
- **W4** §5 now carries the ledger payload's `tokensIn` and the
  `stepWatchStats()` shape; the glossary names both cache-creation fields.
- **W5** The pi drop-unknown-names citation points at `_applyToolLoadout`
  (`agent-session.js:1160-1164`) and `setActiveToolsByName` (`1104-1112`).
- **W6** The taint path is derived from `process.cwd()` (the project root for
  both the orchestrator and its children).

### Amended after the sixth architect review (C1, W1–W8) and the fifth review's D1/D2

- **C1** The mask ledger survives `invalidateRuntime`; it is cleared only on an
  owner change or after a successful terminal restore, and the abort path
  restores the tools **before** invalidating the runtime.
- **D1** The mask is applied in the **main session only**: a process whose
  environment carries the child marker `KSTACK_STEP` never has its tool set
  changed by kstack, so a delegated child keeps its own allowlist.
- **D2** The taint store's path comes from the **session** cwd on every side
  (write, read, cleanup), via `projectRootFor(cwd)`.
- **W1** The run report's contract carries the run id, so the main-scope cache
  rows are computable; without a run id there are no main-scope rows.
- **W2** The env var that raises a tripped budget limit is **persisted**
  (`state.budgetRaiseEnv` and the ledger report), so it survives a restart.
- **W3** The guard's backup directory uses the same `safeSegment` rule as the
  taint path.
- **W4** The chain envelope is extracted into `chainEnvelope()`; its text is
  unchanged.
- **W5** The run-report counters use the `tokens*` prefix; the ledger payload
  keeps the un-prefixed names. The mapping is stated in the design.
- **W6** The three trusted acknowledgements publish their exact patterns.
- **W7** The profile test enumerates the **static** workflow list, so all 38
  pairs are tested even when the sprint workflow is disabled.
- **W8** The hook's child-safety has two stated preconditions: children run
  `--no-session` and carry the `KSTACK_STEP` marker.

### Added invariants (INV-28..INV-31)

- **INV-28** `removedByMask ≠ ∅` ⇒ a restore is owed; the ledger survives
  `invalidateRuntime` and is cleared only on an owner change or after a
  successful terminal restore.
- **INV-29** A process whose environment carries `KSTACK_STEP` never has its
  tool set changed by kstack; the main session is masked.
- **INV-30** The taint store's write, read and cleanup paths resolve the same
  path from the session cwd via `projectRootFor(cwd)`.
- **INV-31** A budget trip persists the env var that raises the tripped
  dimension (`state.budgetRaiseEnv`) and names it in the ledger report.

### Amended after the architect approval (W1–W9, naming level)

- **W1** The glossary binds one name: `reconcileToolMask(pi, profile)`.
- **W2** The hit-rate row carries the three-term field mapping.
- **W3** The interface section no longer promises a `WorkflowPhase` tool-profile
  field or `applyToolMask(pi, phase)`: the mapping is the literal
  `PHASE_TOOL_PROFILE` table in `orchestrator/toolmask.ts`.
- **W5** `parkedGateId` learns two prefixes: `provenance-review:` and
  `verdict-config:`.
- **W6** The main-scope rows are read through `ledgerPathFor(cwd, state)`, and
  both `writeRunReport` call sites pass `state.runId`.
- **W9** The C3 retro reads the **main-scope** rows only: the mask reaches the
  main session, and the sprint planning phases are main-session steps — the
  right target for the context-economy goal.
