# S5a — Evolution: foundation hardening
## Problem Statement
How might we make the S3/S4 orchestrator cheaper per phase (fewer tools in context), safer (untrusted payloads marked), measurable (cache hit-rate) and calibrated (stuck/budget thresholds from real runs) — while paying off the S4 verdict residue (C1/C2) — without changing how phases route?

Contract: `Kstack.md:488-540`. Evidence base: `Kstack/research-report.md` findings 1, 4, 6 + security §. Orientation: `explore-notes.md`.

## Actors
- **Maintainer (Mattia)** — approves the plan, owns the S5a DoD.
- **Main session agent** — receives the masked tool set and marked payloads; calls `kstack_advance` / `kstack_phase` (must never be masked).
- **Delegated subagents** (`pi --mode json -p --no-session`, headless) — carry budgets, produce `usage` (cacheRead/cacheWrite), write records via `kstack-report`.
- **Orchestrator** (`executor.ts` → `launchPhase`) — the single funnel where masking, telemetry and park handling land.
- **`kstack-report` CLI** vs **`repair.ts`** — two verdict-validation channels that currently disagree (C2).
- **Browse daemon** — source of untrusted page content.
- **Test suite** — 15 files, byte-enforced `orchestrator/README.md` (`test/workflow-table.test.ts`), fake `pi` stubs lacking `setActiveTools`.

## Variations considered (lensed)
1. **Literal** — implement W1–W4 + C1–C3 exactly as written. *(Audience: the checklist.)*
2. **Measure-first** — order work so evidence (C3 run + W3 telemetry) precedes tuning (W4). *(Inversion: tune last, not first.)*
3. **Cleanup-first** — C1/C2 before anything additive; they are fail-closed, test-bound and shrink the surface W1–W4 touch. *(Simplification.)*
4. **Per-step masks** — mask per step rather than per phase (qa-browsing.test needs browse, code-review needs none). *(10x version.)*
5. **Profile masks** — 4–5 named tool profiles (`read-only`, `browse`, `edit`, `control`) assigned per phase; no per-tool lists in the registry. *(Simplification of 4.)*
6. **Daemon-side marking** — mark every command's output in the browse daemon. *(Constraint removal.)* Rejected below.
7. **Defer concurrency** — reserve-then-settle designed but not built, because no concurrent phases exist until S5b W2 (DAG/event-driven delegation). *(Expert lens: YAGNI.)*
8. **Always-on strict marking** — flip `strictContent()` default to ON. *(Inversion of opt-in.)*

## Directions
- **A — Literal sweep.** All 7 items in one pass in the listed order. Risk: W4 tuned blind (no baseline); reserve-then-settle built for a concurrency that doesn't exist; breakpoint budget "1h+5m" has no code home.
- **B — Evidence-ordered, trimmed (recommended).** Order: C1+C2 (cleanup) → W1 (profile masks, per-phase) → W2 (extension-side marking, scoped) → W3 (carry `cacheCreation` through run report + per-phase hit-rate) → C3 (one recorded real run) → W4 (thresholds from that run; reserve-then-settle as a design note only).
- **C — DoD-minimal.** Only what the DoD sentence names (masking active, hit-rate measured, payloads marked, detectors calibrated); skip C1/C2. Fastest, but leaves the C2 trust disagreement open and breaks the S4 carry-over promise.

## Recommended Direction
**B.** It respects the DoD and the carry-overs, but fixes the ordering flaw in the written contract: W4 "calibration on real runs" depends on C3 and W3, so those must come first. C1/C2 go first because they are pure removal/alignment against existing tests — the smallest blast radius and they simplify `state.ts`/`templates.ts` before additive work lands.

Masking is a per-phase **profile** (not per-tool lists, not per-step) computed as `getActiveTools()` minus masked names, with `kstack_advance` and `kstack_phase` hard-excluded from any mask. Marking stays extension-side (`tools.generated.ts:888-899` is the single post-processing point) and extends to non-page outputs (`console`, `network`, `cookie`, `js`); the browser daemon's existing "datamarking" (exfil watermark) is a different concept and is renamed in docs to avoid confusion.

Honest pushback: (1) "reserve-then-settle for concurrent phases" is premature — `inFlightPhases` is one chain per workflow; build it with the S5b DAG executor. (2) The "1h+5m breakpoint budget" has no representation in the repo and may not be controllable from pi at all — verify before promising it. (3) Thresholds picked before C3 are guesses; say so and keep them env-overridable.

## Key Assumptions to Validate
- [ ] pi's `setActiveTools` applied at phase entry persists across turns and is not reset by compaction/resume — *test: set mask in a fake-pi unit test + one live phase, inspect `getActiveTools()` after `/compact`.*
- [ ] Masking cannot dead-lock a phase (every phase can still reach `kstack_advance`) — *test: registry-wide test asserting control tools survive every profile.*
- [ ] Prefix stability survives masking (tool set changes between phases but is byte-stable within a phase) — *test: W3 hit-rate on two consecutive steps of the same phase.*
- [ ] pi usage events expose enough (`cacheRead`/`cacheWrite`, maybe TTL) to compute hit-rate and a breakpoint budget — *test: inspect a real delegated step's `usage`; `spawn.ts:470,542`.*
- [ ] Extension-side marking is sufficient (daemon already envelopes page content) — *test: enumerate which of the 65 tools return untrusted text and assert each is wrapped.*
- [ ] Dropping `artifact-mismatch` / non-flagged `pendingVerdict` changes only the asserted park cause — *test: grep + run `remediation`, `sprint`, `orchestrator`, `run-cleanup` suites after removal.*
- [ ] One real sprint/develop run is obtainable to serve as C3 baseline — *test: run it, confirm run report carries phase timings and cache stats.*

## MVP Scope
**In:** C1 (remove `artifact-mismatch`, dead ledger `verdict` kind, non-flagged `advancePhase` branch); C2 (repair.ts uses per-key `acceptedVerdictValues`; `buildRecordContract` hint advertises freezing severities); W1 (profile table + `toolmask.ts` + phase field rendered in README table + fake-pi stubs + control-tool exclusion test); W2 (extension-side marking for untrusted tool outputs, strict default decision); W3 (carry `cacheCreation` into `RunReportStep`, per-phase hit-rate in run report); C3 (one recorded run); W4 (thresholds from that run, documented defaults).
**Out:** see below.

## Not Doing (and Why)
- **Reserve-then-settle implementation** — no concurrent phases until S5b W2; design note only.
- **Per-step masks** — per-phase profiles hit the research gain; per-step multiplies call sites and test stubs.
- **Semantic/retrieval tool selection** — research says deterministic masking beats it.
- **Daemon-side marking of all commands** — extension-side post-processing point is single and testable; daemon is vendored.
- **CodeAct / tool collapse** — S5b/S6 scope.
- **USD budget dimension** — no pricing feed in-repo; stays off.
- **Eval harness / pass^k** — S5b W1; S5a calibrates with one real run, not statistics.

## Open Questions
1. W1: confirm per-phase profiles (not per-step) and the profile set; which phases get which?
2. W2: flip `strictContent()` default to ON, or keep opt-in and mark non-page outputs unconditionally?
3. W2: extension-side only, or also the daemon? Rename which "datamarking"?
4. W3: what is the "1h+5m breakpoint budget" concretely, and can pi control cache breakpoints at all? Where is it published?
5. W4: accept thresholds calibrated on a single C3 run (flagged as provisional), or require more?
6. W4: reserve-then-settle — design note only (recommended) or build now?
7. C1: confirm which park-cause assertions move (`remediation.test.ts:89,173`; `sprint.test.ts`; `orchestrator.test.ts:1846`; `run-cleanup.test.ts:105`).
8. C3: which workflow and task should be the real run (this sprint itself?).

---

## Settled Decisions (interrogate, frontier empty)

Answered by the user (rounds 1-2) or folded in with their consent.

**W1 — browser-tool masking (per-phase).** Masking hides only the browser tools (`kstack_*` browse tools, ~65). pi built-ins (bash/read/edit/write) and the orchestrator tools `kstack_advance` / `kstack_phase` are never masked. Three profiles, per phase, default `full` for any phase not listed (a new phase can't lose tools by accident):
- `full` — all browser tools: `qa-browsing` (sprint/develop/review), `regression-qa`, `reproduce` (investigate).
- `read` — navigate + read-only inspection (goto/back/forward/reload/url, snapshot, text, html, links, forms, accessibility, console, network, js, eval, css, attrs, is, inspect, screenshot, tabs, wait, scroll, perf, …); no click/fill/type/cookie-set/header/useragent/style/upload/download tools. **User amendment: planning phases get `read`** so the planner can base tasks on evidence it can verify itself. Planning phases = develop `plan`, sprint `understand`, `user-story`, `capability`, `system-design`, `backlog`. The exact `read` tool list and the phase table are finalised in system-design (user reviews at that gate).
- `none` — control tools only: remaining phases (implement, document, ship, retro, archive, devsecops/docker/pipeline reviews, …).

**W2 — untrusted marking.** Always wrap (sentinel envelope) the output of every browser tool that can carry third-party text (console, network, cookies, storage, js, eval, html, …), unconditionally. The heuristic scanner stays opt-in (`strictContent()` unchanged, default OFF). Extension-side only (`tools.generated.ts` wrap point); the daemon is untouched. The S5a mechanism is named **"untrusted marking"** to avoid the clash with the daemon's exfil-watermark "datamarking".

**W3 — cache telemetry (redefined).** The "1h+5m breakpoint budget" is not a code feature: pi places `cache_control` breakpoints itself and sets TTL from `PI_CACHE_RETENTION=long`. W3 = (1) carry `cacheCreation` + `cacheWrite1h` into `RunReportStep` and the main-step ledger, (2) per-phase hit-rate `cacheRead / (input + cacheRead + cacheWrite)` in the run report, (3) env switch passing `PI_CACHE_RETENTION=long` to spawned children — default OFF, documented.

**W4 — budget/stuck tuning.**
- New (user-raised): the subagent turn limit is a flat 60 for every step; the scout tripped it twice (13:31, 13:37) and each trip lost work. Make turns per timeout class: EXPLORE 150, WORK 200, VERIFY 100, generic 100; env override (`KSTACK_PI_STEP_MAX_TURNS`) still wins. The trip message names the env var that raises the limit. A budget trip is no longer ledgered as `quota-parked`.
- Thresholds are calibrated on one real run (C3) and marked **provisional** (recalibrate after more runs), env-overridable.
- Reserve-then-settle: **design note only** (no code); it needs concurrent phases, which arrive with the S5b DAG executor.

**C1 — verdict residue.** Remove the `artifact-mismatch` park cause (`types.ts:303`, its single producer `command.ts:583`), the producer-less ledger `verdict` kind (`ledger.ts:48`) and the non-flagged `advancePhase`/`pendingVerdict` branch (`state.ts:411-414`). Tests that assert `artifact-mismatch` move: `sprint.test.ts:492,559,600,1336,1412,1424`, `orchestrator.test.ts:1846-47`, `run-cleanup.test.ts:105`. Correction to Kstack.md: `remediation.test.ts:89,173` assert `no-verdict` / `unroutable`, which are not removed.

**C2 — parity.** `repair.ts` trusts the per-key `acceptedVerdictValues` instead of the global `NEGATIVE_VALUES`; `buildRecordContract` hints call `acceptedVerdictValues` so they advertise the freezing severities.

**C3 — real-run evidence.** This sprint is the recorded run; W4 calibration happens at its retro phase. Numbers stay provisional.

**Frontier: empty.**
