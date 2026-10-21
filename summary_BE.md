# Summary Backend — Sprint 02 (S5a evolution: foundation hardening)

## Executive Summary

The backend lane of Sprint 02 implemented the S5a foundation-hardening
workstreams (W1–W4) and the S4 carry-overs (C1–C2) as specified in
`tasks.md`, `system-design_02.md` (approved by the architect gate) and
`ADR-log_02.md`. The work landed as conventional commits on the branch
`task/s5a-foundation-hardening`.

**Verification:** the full suite is **676 pass / 0 fail** across 25 files and
`bunx tsc --noEmit` is **clean** (0 errors).

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

- `bun test` → **676 pass, 0 fail** (25 files).
- `bunx tsc --noEmit` → **0 errors**.
- `grep -rn "artifact-mismatch" --include=*.ts .` → **0** matches.
- `git diff --stat -- browser/browse/src` → **empty** (the vendored daemon is
  untouched).
