# Explore notes - S5a orientation (branch `kstack`)

Codebase orientation brief for the S5a sprint ("Evolution - foundation
hardening", `Kstack.md:488-540`). Written by the `explore.scout` step
(run `2026-10-21T13-27-35-136Z-ai30`, re-issued after two quota parks).
Every claim carries a `file:line` reference so the planning phases do not
have to re-explore.

---

## 1. Repo map (4 layers)

| Layer | Path | What lives there |
|---|---|---|
| Orchestrator | `orchestrator/` (34 files) | workflow registry, phase machine, delegation, records/verdicts, ledger, stuck-detector, telemetry |
| Extension/tools | `index.ts` + `tools.generated.ts` + `lib/` | 65 browse tools + 2 orchestrator tools, command allowlist, content-security (untrusted markers) |
| Runtime CLI | `runtime/bin/` (bash) | `kstack-report` (the S4 step-record protocol), plus 20 other `kstack-*` helper scripts |
| Browser (vendored) | `browser/browse/src/` (~65 files) | the headless browse daemon: server, browser-manager, content-security, security-classifier |

Supporting: `skills/` (31 `kstack-*` skills), `agents/` (10 agent defs),
`evals/` (7 skill evals + `evals/trigger/`), `test/` (15 test files),
`graft/` (gitignored local repo-map cache; the `graft` CLI **is** installed
on this host - `C:/Users/Mattia/AppData/Roaming/npm/graft`).

Entry points: `index.ts:30` `registerKstackTools(pi)` then `index.ts:31`
`initOrchestrator(pi)`. The 65 browse tools live in the `TOOLS` array
(`tools.generated.ts:13-469`) and are registered in a loop
(`tools.generated.ts:780-782` `for (const t of TOOLS) pi.registerTool(...)`).
Two orchestrator tools are registered separately: `kstack_advance`
(`orchestrator/index.ts:153`) and `kstack_phase` (`orchestrator/index.ts:668`).

---

## 2. Domain seams (the S5a work-streams mapped to code)

### W1 - Phase tool masking (research finding 4, "tool overload")

**Seam: the pi API already exposes it; kstack never calls it.**

- `pi.setActiveTools(names)` / `pi.getActiveTools()` - the active tool set is
  "the set declared to the model" (pi `dist/core/extensions/types.d.ts:1291`,
  docs `docs/extensions.md:165,187`).
- `grep -rn "setActiveTools" --include=*.ts .` -> **no hits** in this repo:
  masking is greenfield.
- Tool inventory: 65 browse tools (`tools.generated.ts:13-469`) + 2
  orchestrator tools = **67**. Of the 65, six are NOT browse commands but
  orchestrator-adjacent control tools living in the same array:
  `kstack_state` (`tools.generated.ts:407`), `kstack_skill` (`:414`),
  `kstack_handoff` (`:421`), `kstack_resume` (`:428`), `kstack_chain`
  (`:435`), `kstack_dialog` (`:442`).
- Hook point: phase entry. `orchestrator/executor.ts:344` `executeCurrentPhase`
  resolves the phase and delivers instructions; every transition funnels
  through `launchPhase` (`orchestrator/executor.ts:300`, called from
  `orchestrator/command.ts:34,221,263,292,328,444,538,561,612,625,656,662,
  685,694,700,808,845,879`).
- Declaration surface: `WorkflowPhase` (`orchestrator/types.ts:116-241`) has no
  tool field - a `tools?: string[]` (or `toolProfile`) field plus a new
  `orchestrator/toolmask.ts` is the natural shape.
- **Trap:** `setActiveTools` replaces the WHOLE active set - it must be
  computed from `getActiveTools()` minus the masked names, and `kstack_advance`
  / `kstack_phase` must never be masked (the phase could not advance).
- **Trap:** every fake `pi` in the test suite would need `setActiveTools` /
  `getActiveTools` stubs - they are minimal today
  (`test/workflow-control.test.ts:221,245`, `test/s4.test.ts:709-710`,
  `test/remediation.test.ts:352`, `test/orchestrator.test.ts:1887,2542`).
- Phase id inventory (for the whitelist table), from `orchestrator/workflows.ts`:
  - sprint: `explore:942, understand:967, user-story:1015, capability:1040,
    system-design:1065, architect-gate:1129, backlog:1158, implement:1187,
    qa-browsing:1296, devsecops-review:1328, docker-review:1374,
    pipeline-review:1402, archive:1433, retro:1455`
  - develop: `explore:68, plan:93, implement:198, qa-browsing:271, review:304,
    document:332, ship:357, retro:383`
  - investigate: `explore:416, reproduce:441, root-cause:485, fix:530,
    verify:558, regression-qa:586, retro:621`
  - review: `explore:658, diff:683, findings:709, qa-browsing:736, comment:765,
    fix:795, retro:832`
  - (plus `discover:860` and `audit:894` - legacy single-phase workflows)
- Side effect: the generated table `orchestrator/README.md` is derived from the
  registry by `scripts/gen-workflow-table.ts` and byte-enforced by
  `test/workflow-table.test.ts:20-35` - a new phase field must be rendered or
  the test fails.

### W2 - Datamarking untrusted payloads (research §security)

**Seam: the marking machinery exists but is OFF by default and covers only
page-content commands.**

- Extension side: `lib/content-security.ts` - `UNTRUSTED_BEGIN/END` sentinels
  (`:22-23`), `escapeMarkers` (`:31-35`), `PAGE_CONTENT_COMMANDS` (`:38`),
  `strictWrap` (`:79-131`), `SECURITY_SECTION` (`:133`).
- Gate: `strictContent()` = `KSTACK_PI_STRICT_CONTENT` env, **default false**
  (`orchestrator/config.ts:60-61`).
- Application: `tools.generated.ts:898-899` wraps ONLY `PAGE_CONTENT_COMMANDS`
  and only when strict mode is on; the `chain` batch path always wraps
  (`tools.generated.ts:892-897`).
- System-prompt injection of `SECURITY_SECTION`: `orchestrator/index.ts:39`
  (`event.systemPrompt + "\n\n" + SECURITY_SECTION`).
- Daemon side: `browser/browse/src/content-security.ts:1-50` already has a
  *different* thing called "datamarking" (invisible zero-width exfil
  watermark, `text` command only, `datamarkContent()` at `:44`); and
  `browser/browse/src/security-classifier.ts` is an ML prompt-injection
  classifier that runs **only** inside the security sidecar subprocess
  (import restriction documented at `security-classifier.ts:1-20`).
  -> **Naming collision**: browser "datamarking" (exfil watermark) != S5a W2
  "datamarking" (visible trust marking). Rename one of them in the plan.
- Gap vs the research: W2 wants *all* untrusted content marked before it
  enters the context - today non-page commands (`console`, `network`,
  `cookie`, `screenshot` text, `kstack_js` output) are unmarked, and strict
  mode is opt-in per process.

### W3 - Cache telemetry (research finding 1)

**Seam: usage is counted but never turned into a hit-rate.**

- Counters: `orchestrator/stuck.ts:49-50` (`cacheRead`, `cacheWrite` on
  `StepRun`), fed at `stuck.ts:221-222`; exposed by `stepWatchStats()`
  (`stuck.ts:392-396`).
- Main-step path: ledgered at `orchestrator/index.ts:380-394`
  (`payload.tokens / cacheRead / cacheCreation`).
- Delegated-step path: `orchestrator/telemetry.ts:17-38` `RunReportStep`
  has `tokensCacheRead` (`:27`) but **no** `cacheCreation`; written by
  `recordDelegatedStep` (`telemetry.ts:79-91`); persisted by `writeRunReport`
  (`telemetry.ts:132-159`) to `.kstack/runs/*.json`.
- Ledger schema fields already exist: `orchestrator/ledger.ts:67-69`
  (`tokens`, `cacheRead`, `cacheCreation`).
- Child stream already captures both: `orchestrator/spawn.ts:470`
  (`usage = { input, output, cacheRead, cacheWrite }`), accumulated at
  `spawn.ts:542-543`.
- Gaps:
  (a) delegated steps lose cache-creation - the child has it, the run report
      does not;
  (b) nothing aggregates a per-phase hit-rate
      (`cacheRead / (input + cacheRead + cacheWrite)`);
  (c) the "1h+5m breakpoint budget" has **no representation anywhere** -
      `grep -rn "breakpoint" --include=*.ts orchestrator/` -> no hits;
  (d) `usage.cacheWrite` from the child stream is not carried into the run
      report.
- Prefix-stability machinery that must stay byte-stable:
  `orchestrator/templates.ts:1001-1006` (the fixed assembly-order comment:
  system header -> step task -> skill gate -> contract -> advancement rule,
  volatile deltas at the tail) and `buildStepInstructions` /
  `interpolateStepTask` (`templates.ts:1013+`).

### W4 - Stuck/budget/ledger tuning (research finding 6)

**Seam: the detectors exist and are wired; only the thresholds are guesses.**

- Rules (OpenHands, 5): `orchestrator/stuck.ts:33-37` (`identical-action`,
  `action-errors`, `monologue`, `alternating`, `context-errors`); the rule
  evaluator is `detectStuck` `stuck.ts:233-246`.
- Budget dims: `turns / tokens / context / usd / ms / usdPerMin`
  (`stuck.ts:250-258`, `BUDGET_DIMS` at `stuck.ts:301`); 80% soft-warn once,
  100% trips (`checkStepBudgets`, `stuck.ts:329-352`).
- Current thresholds (`stepBudgetDefaults`, `stuck.ts:286-299`):
  `turns=60`, `tokens=` per timeout class (`EXPLORE 400k / WORK 600k /
  VERIFY 300k`, `stuck.ts:270-275`; generic 250k), `context=180k`
  (`stuck.ts:278`), `ms=30min`, `usd`/`usdPerMin` **off** (no pricing feed
  in-repo, `stuck.ts:293-297`).
- **Main-session watches are budget-free by design** (`beginStepWatch`,
  `stuck.ts:368-376`: all dims = Infinity) - only the stuck RULES guard a
  main step. This is why the current run was quota-parked on
  `budget-exceeded:turns:explore.scout` (a *delegated* step) rather than
  warned.
- Delegated budget: `delegationBudgetMs()` default 45 min
  (`orchestrator/config.ts`, `KSTACK_PI_DELEGATION_BUDGET_SEC`).
- Concurrency: `inFlightPhases` map (`orchestrator/executor.ts:185`,
  set at `:325`, deleted at `:340`) - one chain per workflow id. There is **no**
  "reserve-then-settle" mechanism today; that is net-new for W4.
- Resume gate: `orchestrator/executor.ts:860-866` (re-delivering a phase's
  last step whose declared artifact is missing keeps the step OPEN) +
  `orchestrator/artifacts.ts:127`.
- Precompact gate: `orchestrator/index.ts:66-83` - advisory, never vetoes;
  re-asserts the newest state entry on `session_before_compact`.
- Trip -> park: `orchestrator/executor.ts:742` ledgered as
  `detector trip: <dim>`; the ledger already carries the exact shape seen in
  `.kstack/ledger/sprint-2026-10-21T13-27-35-136Z-ai30.jsonl`.

### C1 - Legacy verdict residue (carry-over from S4)

- `artifact-mismatch` park cause: declared in
  `orchestrator/types.ts:303` (`VerdictParkCause` union) and produced by
  `orchestrator/state.ts:394-416` (`mergePhaseVerdicts` ->
  `parkForUnreadableVerdict`). Producers of that cause:
  `orchestrator/command.ts:583` (the manual "return phase with context" path)
  and the state machine. Asserted in `test/sprint.test.ts:492,559,600,1336,
  1412,1424`, `test/orchestrator.test.ts:1846-1847`,
  `test/run-cleanup.test.ts:105`.
  -> **Removal changes the park cause asserted in `test/remediation.test.ts`**
  (the suite asserts `verdict-unreadable:gate:no-verdict` at
  `test/remediation.test.ts:89` and `verdict-unreadable:gate:unroutable` at
  `:173`).
- Producer-less ledger `verdict` kind: declared in the `LedgerEntry` union
  `orchestrator/ledger.ts:48` (`"step" | "phase" | "verdict" | "gate" |
  "report" | "run-interrupted" | "quota-parked"`) but **no writer produces
  it** - every `appendLedger` call site uses `step`/`phase`/`gate`/`report`/
  `run-interrupted`/`quota-parked` (call sites: `orchestrator/command.ts:98,
  120, 869`; `orchestrator/executor.ts:282,459,486,503,508,532,548,574,604,
  619,627,742,774,957,1148`; `orchestrator/index.ts:237,257,380`).
  -> Dead enum member; safe to drop from the type.
- Non-flagged branch of `advancePhase`: `orchestrator/state.ts:411-414` -
  a verdict-bearing phase **without** a flagged step falls back to
  `state.pendingVerdict`; the comment at `state.ts:386-391` states no
  registry phase is in that shape ("every verdict-bearing phase declares a
  flagged step"). The stash itself is written at
  `orchestrator/executor.ts:756` and read at `orchestrator/state.ts:394,
  402-404, 412, 430`; cleared at `state.ts:350,588` and
  `orchestrator/command.ts:864`.

### C2 - Report vs trust-check parity (carry-over from S4)

- `kstack-report` enforces a per-key accepted-value list at write time
  (`runtime/bin/kstack-report:114-145`), sourced from the
  `KSTACK_VERDICT_VALUES` env (`repair.ts:176`), which is built by
  `acceptedVerdictValues()` (`orchestrator/repair.ts:137-148`).
- `repair.ts:97` marks a value routable when `NEGATIVE_VALUES.has(value)` -
  and `NEGATIVE_VALUES` is a **global** set
  (`orchestrator/verdicts.ts:31`: `rejected, failed, red, orange, persists,
  refuted, fail`). So a value the CLI would refuse (e.g. `ui==rejected`) is
  accepted by the repair path. -> **the two channels disagree**; the CLI
  list is per-key, the repair check is global.
- The record-contract hints use a *different* function again:
  `buildRecordContract` (`orchestrator/templates.ts:1204-1235`) calls
  `verdictValuesFor()` (`templates.ts:1243`), NOT `acceptedVerdictValues()`.
  `acceptedVerdictValues` adds the phase's `parkOn`/`loopBackOn` values for
  non-signal keys (`repair.ts:143-146`) - those are exactly the freezing
  severities the hint omits. -> **the hint under-advertises the severities**.
- Test coverage of the CLI side: `test/report-validation.test.ts:38-44,
  75-80, 145, 155, 172`.

### C3 - Real-run evidence (carry-over from S4)

- No end-to-end run result is recorded for S4 (TASK_11). W4 calibration
  needs at least one. Evidence on disk: `.kstack/runs/` holds only
  `*-qa.json` and `*-investigate.json` reports plus a handful of per-step
  record directories; no S4 sprint run report with real phase timings.

---

## 3. Reuse candidates (do not rebuild these)

| Need | Reuse | Where |
|---|---|---|
| Per-step usage counters | `StepRun` + `feedStepEvent` + `stepWatchStats()` | `orchestrator/stuck.ts:41-70, 392-396` |
| Ledger append (safe path) | `appendLedger()` - symlink containment, allowlist filename | `orchestrator/ledger.ts:96-120` |
| Delegated-step telemetry | `recordDelegatedStep` / `writeRunReport` | `orchestrator/telemetry.ts:79-91, 132-159` |
| Per-key accepted verdict values | `acceptedVerdictValues()` (already the CLI's source of truth) | `orchestrator/repair.ts:137-148` |
| Untrusted-content envelope | `strictWrap()` / `escapeMarkers()` / sentinels | `lib/content-security.ts:22-131` |
| Command allowlist | `isAllowed()` + `ALLOWED_COMMANDS` (auto-generated) | `lib/commands.ts:12-14` |
| Phase/verdict ownership map | `verdictKeysFor` / `verdictValuesFor` / `expectationsFor` | `orchestrator/verdicts.ts`, `templates.ts:1243` |
| Repo-map / blast-radius | `graft` CLI is installed on this host | `graft/` + `C:/Users/Mattia/AppData/Roaming/npm/graft` |
| Delegated spawn plumbing | `runSubagent` (usage already captured) | `orchestrator/spawn.ts:470, 542-543` |

## 4. Integration points (where new code plugs in)

- **Phase-entry hook for masking** -> `orchestrator/executor.ts:344`
  `executeCurrentPhase` (phase resolution + instruction delivery) or
  `orchestrator/executor.ts:300` `launchPhase` (the single funnel for every
  transition, incl. `/kstack next` from `command.ts`).
- **Phase declaration surface** -> `orchestrator/types.ts:116-241`
  `WorkflowPhase` (add `tools?: string[]`); registry in
  `orchestrator/workflows.ts` (sprint at `:932-1490`).
- **Generated-table coupling** -> `scripts/gen-workflow-table.ts` +
  `test/workflow-table.test.ts:20-35` (byte-compare against
  `orchestrator/README.md`).
- **Untrusted-payload wrapping** -> `tools.generated.ts:888-899` (the single
  post-processing point of every browse tool result) and
  `orchestrator/index.ts:39` (the system prompt).
- **Telemetry write path** -> `orchestrator/telemetry.ts:79-91`
  (`RunReportStep` shape) + `orchestrator/ledger.ts:67-69` (payload shape) +
  `orchestrator/index.ts:380-394` (main-step ledger).
- **Budget/detector thresholds** -> `orchestrator/stuck.ts:288-304`
  (`stepBudgetDefaults`) and `orchestrator/config.ts` (`numberEnv`,
  `CLASS_TOKEN_LIMITS` consumers) - env-overridable, no code change needed to
  calibrate.
- **Park/resume gates** -> `orchestrator/executor.ts:742` (trip ledger),
  `orchestrator/executor.ts:860-866` (resume gate),
  `orchestrator/index.ts:66-83` (precompact gate).
- **Verdict-routing cleanup** -> `orchestrator/types.ts:303`
  (`VerdictParkCause`), `orchestrator/state.ts:394-416` (park + non-flagged
  branch), `orchestrator/ledger.ts:48` (dead `verdict` kind),
  `orchestrator/repair.ts:97` vs `runtime/bin/kstack-report:114-145`
  (parity), `orchestrator/templates.ts:1204-1235` (hint).

## 5. Open questions for the planning phase

1. **W1 mask granularity** - per phase, or per *step* inside a stepped phase
   (e.g. `qa-browsing.test` needs browse tools but `devsecops-review.code-review`
   needs none)? The registry already has per-step ids (`workflows.ts`), so a
   per-step field is feasible but touches more call sites.
2. **W2 strict-mode default** - flipping `strictContent()` to ON by default
   changes every tool result's shape; the flag is currently documented as
   defense-in-depth opt-in (`config.ts:52-62`).
3. **W2 marking scope** - the browser daemon already envelopes page content
   (`browser/browse/src/content-security.ts`); is W2 about the *extension* side
   (all 65 tools) or about the daemon side (all commands)?
4. **W3 breakpoint budget** - "1h+5m" is not represented anywhere; it needs a
   new field (per-phase cache TTL target?) and a place to publish it.
5. **W4 thresholds** - no real-run baseline exists (C3), so any threshold
   chosen now is a guess until a recorded run provides one.
6. **C1 removal blast radius** - dropping `artifact-mismatch` and the
   non-flagged `pendingVerdict` branch touches `remediation.test.ts`,
   `sprint.test.ts`, `orchestrator.test.ts`, `run-cleanup.test.ts`.

## 6. Start here

- `Kstack.md:488-540` - the S5a work-stream list and DoD (the contract).
- `orchestrator/types.ts:116-241` - `WorkflowPhase`; the first place to put
  the W1 mask declaration.
- `orchestrator/executor.ts:344` - `executeCurrentPhase`; the phase-entry
  seam where W1 masking and W3 telemetry both hook.
- `orchestrator/stuck.ts:233-352` - the detector + budget core that W4
  tunes.
- `lib/content-security.ts:1-142` - the whole untrusted-content marking
  layer that W2 extends.
