# ADR Log 02 — S5a foundation hardening

Counterpart: `user-story.md` (AC-1..AC-24), `capability.md`, `system-design_02.md`.
Numbering continues from `ADR-log_01.md` (ADR-24). Append-only; all entries
start `Proposed` and move to `Accepted` at the architect gate.

---

## ADR-25 — Per-phase browser-tool profiles (`full` / `read` / `none`)

### Status
Proposed

### Context
65 browser tool descriptions sit in the main session's context on every turn,
including phases that never open a browser; the research report (finding 4)
shows accuracy degrading around ~60 tools. The user approved masking and
asked that planning phases keep browsing so planners can verify evidence
(understand.md → W1).

### Decision
Each `WorkflowPhase` may declare `tools?: "full"|"read"|"none"`; undeclared ⇒
`full`. `full` = qa-browsing, investigate reproduce/regression-qa, discover,
audit; `read` = develop plan, sprint understand/user-story/capability/
system-design/backlog, investigate root-cause; `none` = everything else
(system-design_02.md §3.1). Masking applies to the **main session only**:
delegated children keep the explicit `--tools` list of their agent
definition (`spawn.ts:439`).
Alternatives rejected: (a) per-step masks — multiplies call sites and test
stubs for little extra saving; (b) semantic/retrieval tool selection —
research shows deterministic masking beats it and it adds miss-risk;
(c) one global trimmed set — no phase-specific gain.

### Consequences (Trade-offs)
Easier: smaller, stable tool prefix per phase; explicit, reviewable phase
table (rendered in the generated README). Harder: a new phase must be given
a profile or silently gets `full`; a test forces the choice. One prompt-cache
write per phase boundary is the price, measured by W3. `read` gives planning
phases a navigation channel (residual R2, below).

---

## ADR-26 — Reconcile the mask from persisted state every turn (plus eager apply)

### Status
Proposed

### Context
`pi.setActiveTools` replaces the whole set and is process-local. Runs are
resumed, looped back, aborted and restored across sessions; a mask applied
only at phase entry would leak into normal chat after an abort or be lost
after a restart.

### Decision
`reconcileToolMask(pi, profile)` is a pure function of the persisted
workflow state: `next = (active ∪ removedByMask) ∖ masked(profile)`, control
tools never masked, order preserved via `getAllTools()`, no call when the set
is unchanged, every change ledgered. It is called eagerly in
`executeCurrentPhase` and re-asserted in the existing `before_agent_start`
hook (profile `full` when no run is active).
Alternatives rejected: (a) apply only in `launchPhase` — misses abort/restore
paths; (b) restore at every terminal transition only — many exit paths,
easy to miss one; (c) recompute from `getAllTools()` — would resurrect tools
the user deliberately deactivated.

### Consequences (Trade-offs)
Robust to every lifecycle path and idempotent; costs one cheap set
comparison per turn. Depends on assumption A1 (a `setActiveTools` call in
`before_agent_start` applies to that turn) — validated in the first
implementation task; failure degrades timing by one turn, not safety.

---

## ADR-27 — `read` is a literal allowlist that excludes script/chain/credential tools

### Status
Proposed

### Context
A `read` profile must let a planner observe pages without mutating them.
Some "read-looking" tools are not read-only: `chain` runs any command,
`js`/`eval` run arbitrary page script, `storage` has a write mode, `cookies`
exposes credentials.

### Decision
`READ_TOOLS` is an explicit 32-name allowlist (system-design_02.md §3.1),
disjoint from a test-enforced excluded list that is stricter than
capability INV-4 (adds chain, js, eval, cookies, storage, state/skill/
handoff/resume, daemon_restart, download/scrape/pdf/archive).
Alternatives rejected: a denylist of mutating tools (a new generated tool
would be exposed by default).

### Consequences (Trade-offs)
Planners cannot run ad-hoc JS to verify a claim; they get snapshot/text/
console/network/screenshot instead. New tools are hidden from `read` until
reviewed.

---

## ADR-28 — The mask is context economy, not an enforcement boundary

### Status
Proposed

### Context
`bash` and any non-`kstack_*` tool can still reach the daemon; masking
cannot stop a determined or injected model. Risk-scan residual R1.

### Decision
Treat masking as an optimisation: `reconcileToolMask` fails open (a missing/
throwing `setActiveTools` leaves tools unmasked). The security control for
hostile page content is untrusted marking (ADR-29). Documented in the module
comment and README.
Alternatives rejected: deny-listing the `browse` binary in masked phases
(needs a pi permission hook; out of scope).

### Consequences (Trade-offs)
No false sense of security; availability over strictness. A real sandbox
remains future work.

---

## ADR-29 — Untrusted marking: deny-by-default plain wrap, extension-side

### Status
Proposed

### Context
Page text can contain instructions. Today only page-content commands are
wrapped, and only when `strictContent()` (default off) is on. Output of
`console`, `network`, `cookies`, `storage`, `js`, `eval`, the current URL,
navigation acknowledgements and tab titles reaches the model unmarked.
The daemon already has an unrelated exfil-watermark called "datamarking".

### Decision
Add `plainWrap` (sentinel envelope + `escapeMarkers`, no heuristic scan)
and apply it to every browse command except a small `TRUSTED_ACK_COMMANDS`
allowlist of fixed-format acknowledgements (deny-by-default, risk-scan F1);
a partition test forces every command into exactly one set. `strictContent()`
stays default `false` and keeps the heuristic scan opt-in. Changes live in
`lib/content-security.ts` and `tools.generated.ts` only; the vendored daemon
is untouched. The mechanism is named **"untrusted marking"**.
Alternatives rejected: (a) flip `strictContent()` default on — changes every
result's shape and adds false positives; (b) enumerated untrusted list —
silently misses new/URL-bearing outputs; (c) daemon-side marking — vendored
code, second place to maintain.

### Consequences (Trade-offs)
Closer to "all untrusted content marked" with no new false positives; a few
extra envelope lines around short outputs; new tools are marked by default.
Double envelopes may appear where the daemon also wraps (accepted, existing
behaviour in strict mode).

---

## ADR-30 — Cache telemetry = measure + opt-in long retention; no breakpoint budget

### Status
Proposed

### Context
The research asks for a "1h+5m breakpoint budget". pi places `cache_control`
itself and picks the TTL from `PI_CACHE_RETENTION=long`; usage events expose
`cacheWrite` and `cacheWrite1h`. Delegated steps currently lose
cache-creation in the run report, and no hit-rate exists.

### Decision
Carry `tokensCacheCreation` and `tokensCacheWrite1h` into `RunReportStep`,
report a per-phase `cacheHitRate = cacheRead/(input+cacheRead+cacheWrite)`,
and add the opt-in env flag `KSTACK_PI_CACHE_LONG` that sets
`PI_CACHE_RETENTION=long` for spawned children (default off). Usage numbers
are coerced to finite non-negative values. No breakpoint-budget code.
Alternatives rejected: implementing breakpoint control (pi does not expose
it); defaulting retention to long (higher write cost before any measurement).

### Consequences (Trade-offs)
Hit-rate becomes observable per phase; the retention default can be decided
from data later. The research item "breakpoint budget" is satisfied by
measurement and documentation, not by a code feature.

---

## ADR-31 — Per-timeout-class turn budgets; budget trips are not quota parks

### Status
Proposed

### Context
The delegated-step turn limit is a flat 60. The scout step tripped it twice
and each trip lost work, then completed in ~50 turns on the third attempt.
Tokens already vary by class. A budget trip was ledgered `quota-parked`,
which conflates it with wall-clock/run-token exhaustion.

### Decision
`stepBudgetDefaults(phaseId).turns` = EXPLORE 150, WORK 200, VERIFY 100,
unmapped 100; `KSTACK_PI_STEP_MAX_TURNS` still wins (`off` allowed). The park
message names the env variable for the tripped dimension (`BUDGET_ENV`), and
a `budget-exceeded:*` trip is ledgered `run-interrupted`. Values are marked
provisional and recalibrated at this sprint's retro.
Alternatives rejected: one higher flat limit (loses the class distinction the
token budget already uses); auto-continue after a trip (hides runaway loops;
the stuck rules, not the turn cap, are the loop detector).

### Consequences (Trade-offs)
Fewer spurious parks on legitimate exploration; a genuinely runaway step can
now burn up to 150–200 turns before parking (bounded by token and wall-clock
limits and the stuck rules). Numbers are guesses until the C3 run.

---

## ADR-32 — Reserve-then-settle is a design note, not code

### Status
Proposed

### Context
Concurrent phases do not exist: `inFlightPhases` allows one chain per
workflow. The mechanism only matters with the S5b DAG/event-driven executor.

### Decision
Document the `BudgetPool {total, reserved, settled}` design, launchId-keyed
fencing and atomicity argument in system-design_02.md §8; add no code.
Alternative rejected: building it now (untestable against real concurrency;
speculative).

### Consequences (Trade-offs)
No dead code; S5b starts from a reviewed design. The W4 "reserve-then-settle"
line item in `Kstack.md` is closed as design-only.

---

## ADR-33 — Remove the S4 verdict residue and fail closed

### Status
Proposed — **superseded in part by ADR-51**: the runtime misconfigured-gate park uses the
new non-verdict reason `verdict-config:<phaseId>`, not the `no-expectation`
verdict cause named below. The removal targets and the fail-closed behaviour
stand.

### Context
`artifact-mismatch` has one producer (the manual return path), the ledger
`verdict` kind has none, and the non-flagged `advancePhase`/`pendingVerdict`
branch is unreachable by registry convention. `Kstack.md` claims removal
changes `remediation.test.ts`; the assertions there use `no-verdict` and
`unroutable`, which stay.

### Decision
Remove the three items and update the tests that name `artifact-mismatch`
(`sprint.test.ts`, `orchestrator.test.ts:1846-47`, `run-cleanup.test.ts:105`).
A verdict-bearing phase without a flagged step fails a registry test and, if
ever reached at runtime, parks `no-expectation` — never a fallback route.
Old persisted `pausedReason` strings containing `artifact-mismatch` render
through the generic status path.
Alternatives rejected: leaving the dead code (carries a second route to
reason about); runtime registry throw (could make kstack fail to load).

### Consequences (Trade-offs)
One verdict path, smaller state machine; test churn in three files.

---

## ADR-34 — Repair uses `acceptedVerdictValues`; the router keeps `NEGATIVE_VALUES`

### Status
Proposed

### Context
`kstack-report` enforces a per-key accepted list; `repair.ts:97` trusts the
global `NEGATIVE_VALUES`, and contract hints use `verdictValuesFor`, omitting
freezing severities.

### Decision
`repair.ts` accepts a value iff it is in `acceptedVerdictValues(...)`;
`buildRecordContract` lists the same values; a parity test covers every
registry phase/key/value. `state.ts` routing keeps `NEGATIVE_VALUES`: it
routes rather than accepts, and an unmapped negative already parks
`unroutable`.
Alternatives rejected: changing the router too (wider blast radius, no
behavioural gain; fail-closed already).

### Consequences (Trade-offs)
Repair and CLI can no longer disagree; the router still contains a global
set, documented as intentional.

---

## ADR-35 — This sprint is the C3 baseline; thresholds stay provisional

### Status
Proposed

### Context
C3 requires one recorded real run. No sprint/develop run report exists; this
run is live and writes `.kstack/runs/<runId>`.

### Decision
Calibrate at this sprint's retro from its own run report and ledger;
label the resulting budget defaults `provisional`; keep every value
env-overridable.
Alternative rejected: a separate dedicated run (delays S5a, adds no
independent evidence the first run cannot give).

### Consequences (Trade-offs)
Calibration is circular (the sprint that ships the limits is the sample) and
rests on a single run; accepted and flagged until more runs exist.

---

## ADR-36 — Sprint-number collision resolved by renaming the legacy archive to 00

### Status
Proposed

### Context
Starting S5a paused the workflow: sprint number 01 existed both in the root
(`*_01.md`, S4) and in the legacy `.kstack/sprints/sprint_01/` archive.

### Decision
Rename the stale gitignored legacy archive to `sprint_00` (`*_00.md`); the
root S4 files stay. This sprint is number 02. A proper numbering fix
(archive on completion / ignore the legacy path) is deferred.
Alternative rejected: renaming the tracked root files (cited by docs and
AGENTS.md).

### Consequences (Trade-offs)
Unblocks the run; the collision guard in `orchestrator/sprint.ts` still fires
on any future double-numbered sprint, and the permanent fix is a backlog item.

---

## ADR-37 — Provenance guard: mechanical quarantine of untrusted copies in artifacts

### Status
Proposed (added at the architect gate, after review of residual R3)

### Context
A phase with browser access (a `read` planner, or a delegated scout/QA with
`kstack_*` tools) can copy page text into an artifact that a later phase
trusts — second-order injection (TB-10 / R3). The first proposal relied on
the manual gates plus an evidence-quoting convention; the user rejected it:
no human can review every string an agent copies, and reviewer time is a
real limit. The control has to be mechanical.

### Decision
Record shingle hashes of all untrusted tool output in a per-run taint store
(any process, via `KSTACK_TAINT_RUN`); after a browse-capable step, wrap
every verbatim-copied run (≥ 12 consecutive tokens) of its produced artifacts
in `UNTRUSTED_BEGIN/END`, lossless and idempotent; run the existing injection
patterns over the quarantined spans only and park (`provenance-review`,
≤ 10 lines) when one matches. Everything else continues with no human step.
Fail-open on guard errors. Details: system-design_02.md §3.8; invariants
INV-22..24; acceptance criteria AC-25..27.
Alternatives rejected: (a) human review of artifacts (not scalable);
(b) strip/redact copied text (lossy, breaks legitimate evidence);
(c) scan the whole artifact with the injection patterns (false positives on
security prose; the planner's own text is not the threat); (d) LLM judge over
artifacts (cost and flakiness; research finding 7); (e) lowering the
authority of the consuming phase (large redesign).

### Consequences (Trade-offs)
Verbatim carriers can no longer silently cross the artifact boundary, and the
human is pulled in only for confirmed attack-shaped copies. Cost: a small
taint file per run, one artifact scan per browse-capable step, ~150 LOC plus
tests, and a scope increase for S5a (three new acceptance criteria).
Paraphrased injections and `bash`-borne exfil remain residual (R3′).

---

### Amendment (architect review rejected the first form; attempt 2)

The review kept the mechanism and rejected its specification. Decisions added,
not re-litigated: (1) the taint store is written through a **shared
`safeAppend`** extracted from `appendLedger` (realpath + lstat containment),
at `.kstack/runs/<safeSegment(runId)>/taint.jsonl`; the environment carries
the run id (`KSTACK_TAINT_RUN`), never a path. A ledger kind was rejected
because children have no workflow state to call `appendLedger`. (2) The cap is
a **file-size bound** (≤ 16 MiB + 3 KiB per concurrent writer), one atomic
`safeAppend` per ≤ 3 KiB line; `loadTaint` skips partial/garbled lines.
(3) One **normalisation for both sides** (NFKC, lower-case,
`[\p{L}\p{N}_]+` tokens), 8-token shingles, artifact-scoped matching,
copied run = ≥ 12 consecutive tokens; INV-22 restated as a property test.
(4) The `provenance-review:<phase>:<step>` park gets a decision surface in
the existing `command.ts:645` branch (Accept / Re-run / Abort), burns no
attempt, and cannot loop without a human click. Also from the same review:
the mask ledger is keyed by run id (owner switch restores first), reconcile
never filters by `getAllTools()` membership, the trusted-ack list is
expressed in command ids, and the terminal-transition mask restore is an
explicit third call site. Second risk pass (G1–G4): the store is also kept in the main process memory with a shrink check, a full or tampered store switches the guard to **degraded mode** (whole-artifact instruction scan, same park), guard rewrites are atomic and symlink-refusing, and the run key falls back to the workflow id. New residual R6: child-written taint is tamper-exposed until S5b event-driven delegation.
Details: system-design_02.md §3.1, §3.2, §3.8.

---

## ADR-38 — One contained-append helper (`safeAppend`) for every new `.kstack/` writer; the taint store is a run-directory file, not a ledger kind

### Status
Proposed

### Context
The provenance guard (ADR-37) needs a store that the main session and spawned
children both append to. The architect review found that a plain file writer
would bypass the symlink-plant containment that only `appendLedger`
(`ledger.ts:96-129`) enforces, while the design claimed no new writer.
Children have no workflow state, so they cannot call `appendLedger`; ledger
entries are JSON objects of fixed kinds.

### Decision
Extract the containment (realpath of the directory inside the repo, `lstat`
refusal of a symlinked file, one `appendFileSync`, never throws) into
`orchestrator/safe-append.ts` and make `appendLedger` and `lib/taint.ts` both
use it. Export the run-id sanitiser as `safeSegment`. The store lives at
`.kstack/runs/<safeSegment(runKey)>/taint.jsonl`; the environment passes the
run key (`KSTACK_TAINT_RUN`), never a path.
Alternatives rejected: a new ledger entry kind (children cannot write it);
an env-supplied file path (lets a spawned process be pointed elsewhere);
duplicating the checks in `taint.ts` (two copies drift).

### Consequences (Trade-offs)
One audited containment path for both writers; `appendLedger` is touched by a
behaviour-preserving refactor (existing ledger tests are the oracle). TB-9 now
lists one additional writer, honestly.

---

## ADR-39 — Taint-store bounds and degraded mode: coverage loss fails toward human attention

### Status
Proposed

### Context
The store can be filled by a hostile page, truncated by the agent (it has
`bash`/`write`), or partially written by a crash or an interleaved append; a
per-process cap would leave the aggregate unbounded. A silent miss would turn
the guard into a false assurance.

### Decision
Bound the file, not the process: one `safeAppend` per ≤ 3 KiB line, recording
stops at 16 MiB (aggregate ≤ 16 MiB + 3 KiB per concurrent writer), hashes
de-duplicated before appending, `loadTaint` skips partial or malformed lines.
The main process keeps its own hashes in memory and its written byte count; a
file smaller than that count means **tampered**. When the store is **full or
tampered** the guard runs in **degraded mode**: `scanInstructions` over the
whole artifact, parking `provenance-review` on a match. Errors inside the
guard still fail open (ADR-28).
Alternatives rejected: failing closed on a full store (parks benign large
browsing sessions); ignoring tampering (an injected agent could simply delete
the evidence); per-child files with hash chaining (more machinery; revisit with
S5b event-driven delegation — residual R6).

### Consequences (Trade-offs)
A flood or deletion degrades precision, not safety, and costs the human a look
only when instruction-shaped text is present. Child-written taint stays
tamper-exposed (R6). Memory use is bounded (~1.6 M hashes at the cap).

---

## ADR-40 — Provenance park has its own decision surface and consumes no attempt

### Status
Proposed

### Context
A new park reason without a panel branch falls to the generic `/kstack` panel,
whose Resume re-runs the step, rewrites the artifact and re-parks with no way
out (`command.ts:302-311`).

### Decision
`pausedReason = "provenance-review:<phaseId>:<stepId>"`, `resumeMode: true`,
saved like the budget/quota park (never a verdict, no attempt burned).
`parkedGateId` (`command.ts:75`) and the human-decision branch at
`command.ts:645` learn the prefix, offering **Accept result** (the human has
read the listed ≤ 10 lines; `forceContinuePastGate` + `auditGateDecision`; no
guard re-run), **Re-run the step** (the human edited the lines out; guard
re-checks; a surviving match re-parks) and **Abort**. Every iteration needs one
human click.
Alternatives rejected: auto-resume after N minutes (hides the event);
burning an attempt per re-park (conflates a security review with a quality
retry); reusing `loop-exhausted:` (wrong semantics: no retry ceiling is hit).

### Consequences (Trade-offs)
One more prefix to keep in the panel whitelist and the gate-id resolver; the
decision is explicit and audited.

---

## ADR-41 — Mask ledger is owned by one run key; reconcile never filters by tool-list membership

### Status
Proposed

### Context
`removedByMask` was session-global while profiles are run-scoped
(`inFlightPhases` is per workflow id, `loadActiveState` returns the newest
state), and the reconcile formula filtered by `getAllTools()` membership, which
could drop an active tool unknown to that list (violating capability INV-2).

### Decision
`{ ownerRunId, removedByMask }` with `runKey = state.runId ?? state.workflowId`:
a different key restores the previous owner's removals first, then applies the
new profile. The result is a set filter on `masked(profile)` **only**, then a
stable sort by `getAllTools()` index with unknown names keeping their
neighbour's rank. Three call sites enumerated: phase entry
(`executor.ts:344`), the `before_agent_start` re-assert (`index.ts:39`), and the
terminal transitions (`executor.ts:290-291`, `command.ts:132-133`).
Alternatives rejected: asserting a single-active-run invariant only (a session
switch breaks it silently); filtering by membership (drops tools).

### Consequences (Trade-offs)
Capability INV-2 and INV-5 become testable; one extra comparison per turn.

---

## ADR-42 — Guard targets resolve through a `produces` rule, and the delegated trigger follows effective tool exposure

### Status
Proposed

### Context
The architect review found the guard inert for the phases it exists to
protect: `phaseArtifactPaths` returns `[]` for most phases
(`artifacts.ts:114-146`), so the sprint planning phases (`user-story`,
`capability`, `system-design`, `backlog`) resolved to no file, and the
`produces` ids are not file names (`system-design` vs `system-design_02.md`,
`adr-log` vs `ADR-log_02.md`). The delegated trigger keyed on agent metadata
and so missed `qa-engineer`: only 3 of 10 agent definitions have a `tools:`
line, and the other 7 get pi's default set, including all 65 browser tools
(`spawn.ts:439`, `tools.generated.ts:782`).

### Decision
`guardTargets(phase, cwd, sprint)` = `phaseArtifactPaths(...)` ∪ the
**produces rule**: for each `produces` id, a root file matches when its name,
case-insensitively, is `<stem>.md` or `<stem>_NN.md` (ids naming no markdown
file match nothing). Only regular files inside `cwd` and ≤ 1 MiB are kept.
The delegated trigger uses `childMayBrowse(agent) = agent.tools ?
agent.tools.some(t => BROWSER_TOOLS.has(t)) : true` — an agent without a
`tools:` line can browse, because pi gives it the default set.
Alternatives rejected: naming the sprint artifacts explicitly in the registry
(three more places to keep in sync, and the plan-file name is already
dynamic); triggering on "the agent's task mentions a URL" (unreliable);
trusting agent metadata (the defect itself).

### Consequences (Trade-offs)
The guard now actually runs where TB-10 needs it, and the trigger is correct
for the 7 agents that get pi defaults. The trigger is deliberately
conservative: it fires for agents that could browse, and the guard is a no-op
(one `stat`) when nothing was recorded.

---

## ADR-43 — Trust is decided by the output's shape, and every output is recorded

### Status
Proposed

### Context
Trusting a command *id* left an echo hole: `dialog-accept` prints back the
prompt text the model passed, and the model can pass text copied from a page.
The same applies to `header`, `useragent` and `scroll`. A trusted output was
also excluded from recording, so a copy of it escaped the guard.

### Decision
`TRUSTED_ACK_SHAPES` maps a command id to a fixed output pattern, and the
wrap is skipped only when the **output** matches it. The trusted set is the
three commands whose output is a fixed string: `restart`, `dialog-dismiss`,
`closetab`. Every browse output — including trusted ones — is passed to
`recordUntrusted` exactly once, before the wrap decision; only the wrapping is
conditional.
Alternatives rejected: trusting by id (the defect); dropping the trusted
concept entirely (a handful of fixed acknowledgements would be wrapped for
nothing); recording only wrapped outputs (a copy of an un-wrapped output would
escape).

### Consequences (Trade-offs)
The echo hole is closed twice over: the echo is wrapped, and it is recorded.
`status` (prints the page URL) and `viewport` are marked like any other
output. The taint store grows slightly (a few hashes per acknowledgement).

---

## ADR-44 — Escalation fires on taint-verified copies only

### Status
Proposed

### Context
The first escalation rule scanned every enveloped segment of an artifact. A
security review that legitimately *discusses* injection patterns (quoting
examples) would park the run — a false positive on the agent's own writing.

### Decision
`scanInstructions` runs over the spans the taint store proves were copied
from a page, not over every envelope. Degraded mode (store full or tampered)
still scans the whole artifact, because there the taint store cannot be
trusted and failing toward the human is the point.
Alternatives rejected: scanning everything (false positives); dropping the
escalation (the attack case is the whole point of the guard); an LLM judge
(cost, flakiness — research finding 7).

### Consequences (Trade-offs)
The park means "a page passage reached an artifact", which is provable. The
degraded path stays noisier by design (residual R7).

---

## ADR-45 — The phase→profile mapping is literal data; the mask applies to the main session only

### Status
Proposed

### Context
The review asked for the mapping to be enumerable data (a test must fail on an
unlisted phase) and corrected the claim that delegated children keep their
agent allowlist: only `planner`, `reviewer` and `scout` have a `tools:` line,
so the other 7 children run with all browser tools whatever the phase says.

### Decision
`PHASE_TOOL_PROFILE` is a literal `Record<string, ToolProfile>` keyed
`"workflow:phase"` with one explicit key per registered pair; a missing key
fails the CI test and resolves `full` at runtime. `ToolProfile` is declared in
`orchestrator/types.ts` (leaf module, no import cycle). The mask's effect is
scoped to the main session: TB-3's blast-radius claim and the C3 cache
attribution are stated accordingly, and the run report separates `main` from
`delegated` counters. Enforcing the profile for children is a non-goal (pi's
built-in tool names are not enumerable from the extension, so a derived list
could silently drop tools).
Alternatives rejected: wildcard patterns (a test cannot enumerate them);
deriving a child `--tools` list (drops pi built-ins silently).

### Consequences (Trade-offs)
The profile table is testable and the README column renders from it. The
reduction in a delegated child's tool surface does not happen in S5a — a
follow-up worth tracking with S5b.

---

## ADR-46 — The binding glossary and the body must state the same trusted set

### Status
Proposed

### Context
The glossary is declared BINDING for every dev agent, but it still listed
seven trusted commands while the body, `capability.md` and `user-story.md`
fixed the set at three. An implementer following the glossary would leave
`dialog-accept`, `header`, `useragent` and `scroll` output unmarked, which is
the exact hole the third pass closed.

### Decision
The glossary row names the same three commands (`restart`, `dialog-dismiss`,
`closetab`) and states that the others are always marked. The general rule
is unchanged and now explicit: trust is decided per **output**, not per
command id.
Alternatives rejected: a machine-checked glossary (the doc is the contract;
the test asserts the behaviour instead).

### Consequences (Trade-offs)
The binding text and the behaviour agree; a drift like this is caught by the
next review, not by the compiler.

---

## ADR-47 — The cache metric gets an input-only counter and a per-scope row

### Status
Proposed

### Context
The hit-rate needs an input count, but the step watch only keeps
`tokens` = input+output, so a main-session row had no defined hit-rate — and
main rows are the ones that evidence the mask effect and feed the C3
baseline. The report contract also had one row per phase with no scope,
while the design required main and delegated never to be averaged.

### Decision
`StepRun.tokensIn` (Σ `usage.input`, the fresh-prompt part; pi's `input`
excludes the cached prefix) is exposed by `stepWatchStats()` and written into
the main-step ledger payload. The run report's `phases[]` has one row per
`(phaseId, scope)` with `scope ∈ {main, delegated}`, and the hit-rate is
computed per scope.
Alternatives rejected: restricting the metric to delegated steps (loses the
main-session evidence the sprint is about); keeping a single mixed row (the
averages are not comparable — a delegated child has no mask).

### Consequences (Trade-offs)
One more counter in the watch and the ledger payload; the report gains a
discriminator. Main and delegated numbers become comparable within their own
scope.

---

## ADR-48 — INV-4 is the AC-4 enumeration; navigation stays in `read`

### Status
Proposed

### Context
The design restated INV-4 as "no page/session mutation", which the
`READ_TOOLS` set violates (it keeps the navigation family). The user had
already accepted R2: planning phases may open pages.

### Decision
INV-4 is the **AC-4 enumeration**: no interaction tool, no
cookie/header/useragent/style/session-state tool, no `chain`/`js`/`eval`, and
no file write other than a daemon-validated screenshot image. The navigation
family stays in `read`. `capability.md` and the design use this wording.
Alternatives rejected: dropping the navigation tools from `read` (defeats
the user-approved goal of evidence-verifying planners); keeping the loose
wording (the binding text must match the tool set).

### Consequences (Trade-offs)
No contradiction between the invariant and the implementation; the residual
R2 (a navigation channel) stays visible and accepted.

---

## ADR-49 — The guard targets the current sprint's files, keeps a backup, and quotes post-rewrite lines

### Status
Proposed

### Context
The guard rewrites artifacts, which are git-tracked in a project repo. The
quarantine inserts marker lines, so line numbers computed before the rewrite
go stale — and the park list is what the human acts on. `stem_NN.md` was
ambiguous enough to target a committed `system-design_01.md`. The first
backup location was under the run directory, which `cleanupRunArtifacts`
deletes at run end.

### Decision
Targets are stamped with the **current** sprint number only. Before the first
rewrite of a file, its content is copied to
`.kstack/guard-backup/<runKey>/<relative path>` by `safeCopyFile` (contained
copy: realpath on both sides, symlinks refused, never throws — a failed copy
means the file is not rewritten). The park list is computed from the
**rewritten** file and carries the nearest section heading. The backup
directory is pruned (entries older than 14 days) at run start.
Alternatives rejected: restricting the guard to run-produced files (the sprint
documents ARE the run's output, and the rule was less precise); refusing to
rewrite tracked files (the guard would stop working exactly where the risk is
highest); quoting pre-rewrite lines (stale by construction).

### Consequences (Trade-offs)
The rewrite is always recoverable and the human's line references are
accurate. One extra directory under `.kstack/` (git-ignored) and one copy
per rewritten file per run.

---

## ADR-50 — The mask promises what pi can deliver

### Status
Proposed

### Context
INV-2's proof claimed pi keeps tool names it does not know; pi drops them
(`agent-session.js:626-644`). The honest promise is narrower.

### Decision
The mask **adds no name** and removes exactly the masked ones; it does not
filter by `getAllTools()` membership (that would drop an active name the
registry does not list). pi's own drop rule is acknowledged, and the test's
fake pi mirrors it, so an unknown name is dropped **by pi**, not by the mask.
Alternatives rejected: keeping the old proof (it is false); filtering by
membership (it removes tools the mask was not asked to remove).

### Consequences (Trade-offs)
The invariant is true and testable; a tool pi does not expose is out of scope
for the mask.

---

## ADR-51 — The misconfigured-gate park is a new non-verdict reason with no Resume

### Status
Proposed

### Context
C1 removes the non-flagged `advancePhase` fallback. The remaining runtime
case (a verdict-bearing phase with no flagged step) needs a park. Reusing the
`no-expectation` verdict cause gave an existing member a new meaning, which
INV-15 forbids. Offering Resume would be a click-loop: re-running a step
cannot fix a registry mistake.

### Decision
The run pauses with the **non-verdict** reason `verdict-config:<phaseId>`
(a new reason string, not a `VerdictParkCause` member). `parkedGateId`
resolves it to the phase id; the panel offers Abort plus a notification naming
the misconfigured phase and the registry rule to fix. The CI registry test is
the real guard.
Alternatives rejected: reusing `no-expectation` (changes a documented
meaning); a runtime throw (kstack would fail to load); offering Resume (a
loop with no exit).

### Consequences (Trade-offs)
The verdict-cause vocabulary stays stable, and a misconfiguration surfaces as
a clear, non-retryable pause.

---

## ADR-52 — The verdict value helpers move to a leaf module

### Status
Proposed

### Context
The C2 parity change makes `templates.ts` need
`acceptedVerdictValues`, which lived in `repair.ts` — and `repair.ts`
already imports `templates.ts`, so the change would have created a cycle
(the design had avoided exactly this for `ToolProfile`).

### Decision
New leaf module `orchestrator/verdict-values.ts` hosts `verdictValuesFor`
(moved from `templates.ts:1243`) and `acceptedVerdictValues` (moved from
`repair.ts:137`), importing only `verdicts.ts` and `types.ts`.
`templates.ts`, `repair.ts` and `command.ts` import from the leaf. The
`KSTACK_VERDICT_VALUES` publisher stays in `repair.ts:176` (it is the CLI's
channel, not a value map).
Alternatives rejected: duplicating the helper (drift); inlining the list in
the hint (the hint must match the CLI exactly).

### Consequences (Trade-offs)
A small move with a small diff (three importers), and the dependency
direction stays inward.

---

## ADR-53 — Backups, park reasons and the input convention are specified in one place

### Status
Proposed

### Context
The fourth risk pass found three gaps created by the fixes: the backup lived
under the run directory (deleted at run end) and was described as an append
although it copies a file; the misconfigured-gate park could be click-looped;
and the two scopes had to agree on what `input` means.

### Decision
The backup is a contained copy under `.kstack/guard-backup/<runKey>/` via
`safeCopyFile`, pruned at run start (H2, H3, H5); the misconfigured-gate
park offers Abort only (H1); pi's `input` convention (excludes the cached
prefix) is used identically for the main-side counter and the delegated
`usage.input`, so the hit-rate means the same thing in both scopes (H4).
Alternatives rejected: an append-based backup (cannot copy a document);
a Resume on a misconfiguration (loop); two different input conventions
(incomparable hit-rates).

### Consequences (Trade-offs)
The recovery path survives the run, the backup cannot grow without bound, no
park can be click-looped, and the C3 numbers are comparable.

---

## ADR-54 — One park reason for the misconfigured gate, and the error path is marked

### Status
Proposed

### Context
Two binding-text defects: the risk table still named the `no-expectation`
verdict cause for the misconfigured gate (contradicting INV-15 and ADR-51),
and the tool-error path returned before the wrap site, so an error body that
carries raw stderr was neither marked nor recorded.

### Decision
The misconfigured gate pauses with the **non-verdict** reason
`verdict-config:<phaseId>` everywhere (ADR-33 is marked as superseded in
part). The error path records and wraps its body with `plainWrap` (not
`strictWrap`, so the guarantee does not depend on the heuristic scan);
`isError` and `details` are unchanged, and a trusted-ack shape never exempts
an error body.
Alternatives rejected: leaving the error path unmarked (it is the cheapest
carrier of page-influenced text); excluding errors from INV-6 (the same hole
by another name); `strictWrap` for errors (adds a heuristic that can
mislabel a legitimate error).

### Consequences (Trade-offs)
Every byte a tool returns is either marked or a fixed acknowledgement, and
every byte is recorded. The error body gains two marker lines, which is the
intended cost.

---

## ADR-55 — The taint module lives in the orchestrator layer

### Status
Proposed

### Context
`lib/taint.ts` imported `safeAppend` and `safeSegment` from `orchestrator/`,
while `orchestrator/provenance.ts` imported `lib/taint.ts` — a lib-to-orchestrator
layer inversion (no `lib/` file imported `orchestrator/` before).

### Decision
The taint module is `orchestrator/taint.ts`; it imports its siblings
`orchestrator/safe-append.ts` and `orchestrator/records.ts`, and
`orchestrator/provenance.ts` imports it. The extension root
(`tools.generated.ts`) imports it too, as it already does for
`orchestrator/config.ts`.
Alternatives rejected: moving the shared helpers into `lib/` (the ledger's
containment is orchestrator-owned); duplicating the helpers (drift).

### Consequences (Trade-offs)
The layer rule holds: `lib/` stays independent, `orchestrator/` depends
inward only on itself and on `lib/`.

---

## ADR-56 — The child env is corrected, not merely extended

### Status
Proposed

### Context
INV-10 says `PI_CACHE_RETENTION` is in the child env **iff** the flag is set.
The design only *added* the key, but `silentChildEnv()` returns the whole
parent env, so an operator-exported value reached every child with the flag
off.

### Decision
The child env is built explicitly and the key is **deleted** when the flag is
off (`delete childEnv.PI_CACHE_RETENTION`), set to `"long"` when it is on.
Alternatives rejected: stripping the whole parent env (children need the
toolchain's env); documenting the leak (the invariant would be false).

### Consequences (Trade-offs)
INV-10 becomes true; the child env construction gains one explicit rule.

---

## ADR-57 — The taint store needs a real run id and dies with the run

### Status
Proposed

### Context
The run key fell back to the workflow id. Without a run id nothing is cleaned
up (`cleanupRunArtifacts` removes no records dir), so the store would outlive
the run with no prune rule.

### Decision
`runKey = state.runId` only. With no run id the taint store is disabled
(`recordUntrusted` is a no-op, the guard has nothing to match). The file lives
in the run's records directory and is therefore deleted with the run.
Alternatives rejected: a workflow-id fallback (an orphan file); a separate
prune rule (one more lifecycle to maintain).

### Consequences (Trade-offs)
The store's lifetime is exactly the run's lifetime. A run without an id
records nothing, which is acceptable because such a run has no records either.

---

## ADR-58 — One recording call, hoisted above every branch

### Status
Proposed

### Context
The binding wrap-site snippet called `recordUntrusted` inside two branches
(the chain branch and the non-trusted-ack branch), so a trusted-ack output was
never recorded — contradicting INV-27, AC-30 and the design's own prose, which
said every output is recorded.

### Decision
The recording call is **hoisted above the branch**: every browse output is
passed to `recordUntrusted` exactly once, before the wrap decision. The
wrapping stays conditional on `isTrustedAck`, and the error path records and
wraps too (ADR-54).
Alternatives rejected: recording only the untrusted outputs (the same hole the
G6 fix closed); a per-branch call (the invariant would depend on which branch
runs).

### Consequences (Trade-offs)
One call site, one invariant, and the trusted-ack set can change without
touching the recording path. The store grows by a few hashes per
acknowledgement.

---

## ADR-59 — The contracts, the citations and the paths name what the code does

### Status
Proposed

### Context
Three small drifts between the design and the code: §5 omitted the ledger
payload's `tokensIn` and the changed `stepWatchStats()` shape; the glossary
bound `cacheCreation` while the contract used `tokensCacheCreation`; the
INV-2 proof cited a region of pi's source that is not the drop rule; and the
taint path's working directory was unspecified for child processes.

### Decision
§5 now carries the ledger payload's `tokensIn` and the full
`stepWatchStats()` shape, and the glossary names both cache-creation fields
(`cacheCreation` on the main-step side, `tokensCacheCreation` on the
delegated-step side — one number, two names). The INV-2 proof cites
`_applyToolLoadout` (`agent-session.js:1160-1164`) and `setActiveToolsByName`
(`1104-1112`). The taint path is `<session cwd>/.kstack/runs/<safeSegment(runKey)>/taint.jsonl`
(**amended by ADR-61**: the session cwd, not `process.cwd()`); children are spawned
with the project root as cwd (`spawn.ts:492`), so main and child resolve the same
file, and the environment carries only the run key.
Alternatives rejected: leaving the glossary to a single name (the two sides
really do use different field names); keeping the old citation (it pointed at
boundary-context code).

### Consequences (Trade-offs)
The binding text can be used as an implementation checklist without a second
lookup, and the layer rule stays visible in the path rule.

---

## ADR-60 — The mask ledger survives invalidation, and the mask is main-session only

### Status
Proposed

### Context
Two defects in the mask's runtime contract. The ledger was reset on
`invalidateRuntime`, which `abortWorkflow` calls **before** the restore site,
so both the safety net and the abort restore read an empty ledger: after Abort
workflow the operator's session kept the browser tools masked, and a later
`full` phase in that session had none at all. And the re-assert hook lives in
the extension factory, so it also ran inside delegated children: a `none`
phase's `scout` child (allowlist `read, bash, kstack_goto, kstack_text,
kstack_snapshot`) would have been stripped of its browser tools, blinding the
explore phase.

### Decision
The ledger **survives** `invalidateRuntime` and is cleared only on an owner
change or after a **successful** terminal restore; `restoreAllTools(pi)` runs
before `invalidateRuntime()` in the abort path. The hook returns early when
the environment carries the child marker `KSTACK_STEP` (set only for delegated
children, `repair.ts:164-167`; children also run `--no-session`,
`spawn.ts:437`), so the mask is applied in the main session only.
Alternatives rejected: moving the restore alone (the reload path would still
orphan the mask, since pi keeps the loadout across a reload); masking children
too (it would strip the agents' own allowlists and contradict INV-26's
premise).

### Consequences (Trade-offs)
The mask is always reversible and never touches a child. The ledger survives a
session switch, so the next turn's re-assert restores exactly what was removed.
The child marker becomes part of the extension's contract.

---

## ADR-61 — One root for the taint store: the session cwd

### Status
Proposed

### Context
The store's write side derived its path from `process.cwd()` while the guard,
the ledger and the run cleanup use the session cwd (`ctx.cwd`). Those can
differ, in which case the write lands in one tree and the read in another: the
guard silently finds nothing (the TB-10 control is off) and the file is
orphaned.

### Decision
`recordUntrusted(body, cwd)` takes the session cwd (available in the tool
handler as `ctx.cwd`) and resolves the path with `projectRootFor(cwd)`; the
guard, the ledger and the cleanup use the same root, so write, read and delete
always agree. The guard's own backup directory uses the same segment rule
(`safeSegment(runKey)`) as the taint path, so both writers share one rule (W3).
Alternatives rejected: using the process cwd on both sides (the ledger and the
record writer would then disagree with the guard); passing the whole path in
the environment (a process could be pointed elsewhere).

### Consequences (Trade-offs)
One root, one path rule, and the store always dies with the run it belongs to.

---

## ADR-62 — The budget trip persists the env var that raises it

### Status
Proposed

### Context
The env var that raises a tripped budget dimension appeared only in a
transient notification, so after a restart the operator could not see which
limit to raise.

### Decision
The park persists `state.budgetRaiseEnv = BUDGET_ENV[dim]` and the ledger
`report` carries `raiseWith: BUDGET_ENV[dim]`; the panel prints the persisted
value. The run report's contract also gains the run id
(`writeRunReport(cwd, workflowId, runId?)`) so the main-scope cache rows are
computable.
Alternatives rejected: a notification only (lost on restart); deriving the
name from the dim at panel time (the dim→env map would live in two places).

### Consequences (Trade-offs)
One optional state field and one ledger field; INV-12 becomes observable
after a restart.

---
## ADR-63 — The trust rules and the wrap site are published, and the profile test uses the static registry

### Status
Proposed

### Context
Four small drifts between the binding text and the code, each of which an
implementer would have to guess at. The wrap-site snippet called a
`chainEnvelope` helper that does not exist (the chain envelope is inline in
`tools.generated.ts:893-899`). The glossary called the three trusted
acknowledgements "fixed strings", but `closetab` returns `Closed tab <id>`. The
delegated cache field names deviate from AC-10 with no in-design marker. And
the profile test enumerated `getAllWorkflows()`, which drops the sprint
workflow when the `KSTACK_PI_SPRINT=off` kill-switch hides it, leaving 14 of
the 38 registered pairs untested.

### Decision
The chain envelope is **extracted** into `chainEnvelope()` in
`lib/content-security.ts` as part of the change, with its text unchanged. The
exact patterns of the three trusted commands are published in §3.2. The
field-name mapping (`tokens*` on the run-report row, un-prefixed on the ledger
payload) is stated in §5 and §11. The profile test enumerates the **static**
workflow list, so all 38 pairs are always tested.
Alternatives rejected: leaving the envelope inline (the snippet would name a
function that does not exist); publishing the shapes as prose only (the
implementation needs the patterns); testing only the enabled workflows (a
kill-switch would silently reduce the coverage).

### Consequences (Trade-offs)
The binding text can be used as an implementation checklist, and the trust
decisions are auditable against the daemon's real output strings. One extra
export in `lib/content-security.ts` and one small refactor of the wrap site.

---
## Residual risks carried to the gate (not decisions)

R1 mask is not a sandbox (ADR-28) · R2 `read` adds a navigation channel
(accepted by the user at the gate; optional host allowlist as a follow-up) ·
R3′ paraphrased second-order injection (verbatim carriers handled by
ADR-37/39/44/54/58) · R4 assumption A1 (**answered by pi's own source**,
`agent-session.js:1455-1465`: a `setActiveTools` call in `before_agent_start`
applies on the same turn) · R5 provisional thresholds · R6 child-written taint
is tamper-exposed until S5b event-driven delegation (ADR-39) · R7
false-positive quarantine and degraded-mode park (ADR-44). Details:
system-design_02.md §11, §11.1, §11.2, §11.3, §11.4.

## STATUS == approved
## BLOCKING_ISSUES == none

<!-- The architect gate approved system-design_02.md (verdict
     software-architect-review==approved, 9 naming-level findings applied in
     session). Every ADR above moves from Proposed to Accepted. -->

