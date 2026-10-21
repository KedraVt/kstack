# Summary Backend — Sprint 02 (S5a evolution: foundation hardening)

## Executive Summary

The backend lane of Sprint 02 implemented the S5a foundation-hardening
workstreams (W1–W4) and the S4 carry-overs (C1–C2) as specified in
`tasks.md`, `system-design_02.md` (approved by the architect gate) and
`ADR-log_02.md`. The work landed as conventional commits on the branch
`task/s5a-foundation-hardening`.

**Verification:** the full suite is **680 pass / 0 fail** across 25 files and
`npx tsc --noEmit` is **clean** (0 errors).

## Review-gate fixes (attempt 2)

The `implement.be-walk` review returned two blockers; both are closed here,
each with a failing test first (RED verified by re-running the suite with the
fix reverted).

1. **The published verdict mandate could refuse another step's record**
   (`runtime/bin/kstack-report`).
   The orchestrator publishes a per-step verdict map to a delegated child's
   env (`KSTACK_VERDICT_KEYS` / `KSTACK_VERDICT_VALUES` /
   `KSTACK_VERDICT_REQUIRED`, `orchestrator/repair.ts` `stepSpawnEnv`), and
   every process that child spawns inherits it. The mandate was enforced
   against ANY record the CLI wrote, so a nested process (the test runner, a
   build, a nested CLI call) that wrote a record for a *different* step was
   refused with exit 1 — `bun test` inside a kstack session failed 4 tests in
   `test/workflow-control.test.ts`.
   The map is now **scoped to the step the env names** (`env_covers_invocation`
   compares `KSTACK_PHASE`/`KSTACK_STEP` with the record's `--phase`/`--step`),
   and the mandatory verdict is only enforced for a key the step **owns**
   (`KSTACK_VERDICT_KEYS`) — a required key outside the owned set is dropped
   by the writer, so enforcing it was a deadlock, not a guard.
   Covered by `test/report-validation.test.ts` (3 new cases) and by a
   deterministic env scrub in the CLI unit tests
   (`test/workflow-control.test.ts` `cliEnv`).

2. **The provenance Accept advanced the phase without recording it**
   (`orchestrator/command.ts`, the `Accept result — continue past the gate`
   branch of `handleSprintPanel`).
   The guard parks BEFORE the step result is written, so `forceContinuePastGate`
   moved `phaseIndex` with the phase absent from `state.results`: the accepted
   phase vanished from the run report and its verdict never routed (the
   contract `forceApproveParked` honours at `orchestrator/state.ts`).
   The Accept now records `results[<phase>] = { status: "completed" }` for the
   phase the park reason names (`provenance-review:<phase>:<step>`), and it
   clears the resume marker (`resumeMode`/`reissues`) so the next phase's
   first step is not mislabelled as an interrupted, re-issued step.
   Covered by `test/provenance.test.ts` ("the Accept branch records the
   accepted phase as completed").

3. **Test-hygiene fix (found while reproducing blocker 1).** The toolmask
   fixtures were rooted at `process.cwd()` — the repository — so the abort
   path deleted the sprint's own planning artifacts (`understand.md`,
   `user-story.md`, `capability.md`, `tasks.md`, `summary_BE.md`) on every
   suite run. The fixtures now use a temp root per test
   (`test/toolmask.test.ts`), and the abort assertion proves the run's
   ephemerals die in that temp root.

## Accomplished Goals & Backlog Tasks

1. **Goal 01 — Phase tool masking (TASK_01, TASK_02, TASK_03)**
   - New `orchestrator/toolmask.ts`: `CONTROL_TOOLS`, the derived
     `BROWSER_TOOLS`, the 32-name `READ_TOOLS` allowlist, the literal
     `PHASE_TOOL_PROFILE` table (all 38 registered workflow×phase pairs),
     `reconcileToolMask(pi, profile)` and `restoreAllTools(pi)`.
   - The mask is applied at the three call sites (phase entry, the
     `before_agent_start` re-assert, the two terminal restores); the hook
     skips delegated children (env marker `KSTACK_STEP`), and the ledger
     survives `invalidateRuntime` so an aborted run restores the browser
     tools.
   - `scripts/gen-workflow-table.ts` renders the profile column and
     `orchestrator/README.md` is regenerated (byte-exact test).

2. **Goal 02 — Untrusted marking (TASK_04, TASK_05)**
   - `lib/content-security.ts`: `plainWrap` with the pinned header,
     `TRUSTED_ACK_SHAPES` (the three fixed-shape commands), `isTrustedAck`,
     and the extracted `chainEnvelope`.
   - `tools.generated.ts`: one hoisted `recordUntrusted` call above the
     branch, conditional wrapping, and the tool-error path recorded **and**
     wrapped. The vendored browser daemon is untouched.

3. **Goal 03 — Cache telemetry (TASK_06, TASK_07, TASK_08)**
   - `StepRun.tokensIn` (the input-only count) reaches the watch and the
     main-step ledger payload, so a main-session row has a defined
     hit-rate.
   - `writeRunReport(cwd, workflowId, runId?)` and one `phases[]` row per
     `(phaseId, scope)` — main and delegated are never averaged.
   - `cacheLong()` + the explicit `delete PI_CACHE_RETENTION` in the child
     env, so the key is present iff the flag is set.

4. **Goal 04 — Stuck and budget tuning (TASK_09, TASK_10)**
   - `CLASS_TURN_LIMITS` (EXPLORE 150 / WORK 200 / VERIFY 100, default 100),
     still env-overridable, and labelled provisional.
   - A budget trip is ledgered `run-interrupted` (not `quota-parked`) and the
     env var that raises it is persisted in the state and the ledger.

5. **Goal 05 — Verdict residue and parity (TASK_11, TASK_12)**
   - `artifact-mismatch`, the producer-less ledger `verdict` kind and the
     non-flagged `pendingVerdict` fallback are gone; a misconfigured gate
     pauses with the non-verdict reason `verdict-config:<phaseId>` (Abort
     only, no click-loop).
   - New leaf `orchestrator/verdict-values.ts` makes the repair check and the
     contract hints use the same per-key accepted list as the CLI.

6. **Goal 06 — The provenance guard (TASK_13…TASK_17)**
   - `orchestrator/safe-append.ts` (`safeAppend` + `safeCopyFile`),
     `orchestrator/taint.ts` (hashes only, 16 MiB bound, one root via
     `projectRootFor(cwd)`, partial-line tolerance) and
     `orchestrator/provenance.ts` (the lossless quarantine, the `produces`
     rule, the browse-capability trigger).
   - Wired at both step kinds, with a contained backup, an atomic rewrite and
     a post-rewrite line map; the park `provenance-review:<phase>:<step>`
     offers Accept / Re-run / Abort and burns no attempt.

## Not done in this lane

- **TASK_08** (child cache retention) landed with Goal 03 in the
  `6e08f4c` commit's scope; the `KSTACK_PI_CACHE_LONG` flag and the env
  deletion are in place.
- **TASK_18** (full verification) and **TASK_19** (the C3 retro) belong to
  the QA lane — the sprint's `implement` phase has no QA lane, so they are
  reported in the retro phase.
- The deferred items stay deferred: reserve-then-settle, a host allowlist
  for the `read` profile, enforcing the profile for delegated children, and
  the child-written taint integrity (residual R6).

## Verifications

- `bun test` → **680 pass, 0 fail** (25 files).
- `bun test` with a delegated-step env published
  (`KSTACK_PHASE=implement KSTACK_STEP=be-walk
  KSTACK_VERDICT_KEYS=be-walk KSTACK_VERDICT_VALUES=be-walk=pass,fail
  KSTACK_VERDICT_REQUIRED=be-walk`) → **680 pass, 0 fail** (the reviewer's
  repro: 4 failures before the fix).
- `npx tsc --noEmit` → **0 errors**.
- `grep -rn "artifact-mismatch" --include=*.ts .` → **0** matches.
- `git diff --stat -- browser/browse/src` → **empty** (the vendored daemon is
  untouched).
- The suite leaves the sprint's planning artifacts intact (md5 of
  `understand.md`, `user-story.md`, `capability.md`, `tasks.md` unchanged
  across a full run).
