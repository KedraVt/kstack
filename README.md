# kstack

Browser automation + guided workflow orchestrator for the [pi](https://github.com/earendil-works/pi) coding agent.

One extension, two layers:
- **65 native browser tools** — headless Chromium, ~100ms/command (chain batches N commands into one call)
- **Workflow orchestrator** — `/kstack` command that guides you through develop, investigate, QA, ship, and review pipelines

> **Born from [gstack](https://github.com/garrytan/gstack).** The headless-browser runtime in [`browser/`](browser/) is vendored from gstack (MIT, © 2026 Garry Tan) and renamed; see [Credits & attribution](#credits--attribution).

## What's new (feat/skill-ingestion branch)

- **Deterministic subagents** — specialists (scout/planner/worker/reviewer) are spawned by the orchestrator itself in isolated `pi` processes; delegation no longer depends on the model's discretion. The `subagent` tool remains for ad-hoc use.
- **Interactive plan cycle** — scout explores → you are interviewed (grilling protocol rounds with recommended answers + office-hours judgment + eng-review rigor, ≤5 questions/round) → plan written to `.kstack/plans/<slug>.md` → your approval gate (`/kstack next`) → worker implements from the plan file.
- **Manual decision gates** — `develop.plan` and `investigate.root-cause` pause for user approval before code is touched. Optional phases (e.g. `investigate.regression-qa`) park the same way: the workflow pauses and the `/kstack` panel asks you to **Run / Skip / Abort** — no background Yes-defaulted dialog you can answer by accident.
- **Skill ingestion** — the canonical `skills/<id>/SKILL.md` is injected by the workflow itself: full methodology to whoever does the work, compact DoD+best-practices gates for verification and repeats.
- **Documentation phases** — optional doc-update phase on `develop` and `ship` (Diataxis coverage map, chained generation for missing docs).
- **`qa-report` workflow** — full QA methodology, report-only, never modifies code.

## What's new (feat/sprint-workflow branch)

- **`sprint` workflow (default-on)** — a 10-phase agile delivery pipeline distilled from `.agents-clean` methodology: understand → user-story → capability → system-design → ⏸ architect gate → backlog → implement → devsecops review → QA verdict → commit/archive. Planning artifacts (`user-story_XX.md`, `system-design_XX.md`, `tasks_XX.md`, …) live in the project root and archive to `.kstack/sprints/sprint_XX/` when the sprint goes green.
- **Deterministic verdict routing** — review gates emit machine-parseable verdict lines (`status == red|green|orange`, `security-review == approved|rejected`) inside a `## HANDOFF` section. The orchestrator parses them fail-closed (whitelist-only values, containment-checked), cross-verifies them against the artifact files on disk (dual channel: chat + disk must agree), and routes deterministically — never on the model's say-so.
- **Parks are code-enforced** — every parked state (security freeze, unreadable verdict, loop exhaustion, numbering anomaly, branch violation, failed phase) is refused by the `kstack_advance` tool itself, not just discouraged in prose: a repeat call cannot advance past a park on the model's say-so. Only the `/kstack` panel (or `/kstack next` where applicable) can resume, re-run, accept or abort.
- **Branch enforcement** — sprint gates that audit developer output (`devsecops-review`, `qa-verdict`) park fail-closed when entered on main/master: MASTER_DOD requires `task/<slug>` branches for implementation work. Document-level phases (`architect-gate`, planning) legitimately run on main.
- **Compaction guard** — the per-turn resume prefix re-anchors the active main phase's deliverable/stop-condition contract, and the read-only `kstack_phase` tool re-fetches full phase instructions on demand — for delegated phases it also names the durable artifact files, since specialist results arrive via a transient message and are never persisted.
- **Truthful status line** — the footer shows the real state instead of the last running label: `PARKED for approval — /kstack next`, `FROZEN: <severity> security rejection`, `verdict unreadable (<cause>)`, `loop exhausted`, `branch violation`, `phase failed`; cleared on completion/abort.
- **Security freeze** — a critical/high security rejection parks the whole sprint until a human types the confirmation phrase in the panel; medium/low rejections loop back to implement normally.
- **Trust boundary note** — dual-channel verification trusts files in the repo root: a malicious repo can pre-plant both channels against a predictable next sprint number. Sprint stamping, anomaly guards, and the hard commit-archive gate raise the bar but do not close within-sprint planting — review gate artifacts before approving.
- **Bounded loop-backs** — rejected reviews return work to the implementing phase with extracted blocker feedback; after N attempts (configurable) the sprint parks for human decision instead of looping forever. Accepting an exhausted gate ("Accept result — continue past the gate") resets the loop budget, so the next review gate gets a fresh ceiling instead of parking on its first rejection.
- **Unreadable-verdict park** — if a gate's output can't be parsed into a known verdict, the sprint parks WITHOUT burning an attempt; the panel shows only the failing lines so you can approve/loop/inspect deliberately.
- **Sprint requires deterministic delegation** — the sprint gates route exclusively on executor-produced verdicts, so the workflow refuses to start while `KSTACK_PI_DETERMINISTIC=off` (`/kstack sprint` explains this). Kill-switch parks (`KSTACK_PI_VERDICTS=off` / `_LOOPBACKS=off`) likewise land in a decision panel offering **Accept / Re-run / Abort**.
- **Strict BE→FE chain** — implementation runs backend-developer then frontend-developer sequentially per task wave; model tiers (`KSTACK_PI_MODEL_STRONG/FAST`) let judgment phases run on stronger models while mechanical phases stay cheap.
- **Fixed**: phase instructions are now delivered with `followUp` streaming behavior — eliminates the "Agent is already processing" error that silently dropped phase handoffs.
- **Unified skill catalog** — 28 skills in a flat `skills/kstack-*/` layout, all manually invocable via `/skill:kstack-*`.
- **Centralized artifact names** — `orchestrator/artifacts.ts` is the single source for every sprint-stamped filename (`qa-artifact_XX.md`, `code-review-artifact_XX.md`, `software-architect-artifact_XX_N.md`, …); verdict verification, task templates and the freeze path all consume it, closing the stamping-drift bug class.
- **D4 park causes** — an unreadable-verdict park now records *why* in `pausedReason` (`no-verdict` / `unroutable` / `no-expectation` / `foreign-verdict`) and the panel names the cause for triage; no attempt is burned either way. A gate that declares no verdict-flagged step is a registry mistake and parks as `verdict-config:<phase>` (Abort only).
- **Runtime binaries untracked** — `runtime/` is gitignored and provisioned on demand (session-start download); ~197MB of browse daemon binaries were dropped from the git index.
- **Delegation test harness** — `runDeterministicDelegation` accepts an injected `spawnFn`; `test/executor-delegation.test.ts` exercises the real chain engine (HANDOFF threading, retry, budgets, REFUTED reopen, circuit breakers) with fake spawns.

## What's new (S5a foundation hardening)

- **Phase tool masking** — every workflow phase carries a deterministic browser-tool profile (`full` / `read` / `none`), so a phase sees only the browser tools it needs. The mask applies to the **main session only** (delegated children keep their own tool set), never removes the control tools, and is always reversible: the browser tools come back at the phase boundary, on completion and on abort.
- **Untrusted marking** — every browse output is **recorded** (hashes only — no page text is ever persisted) and wrapped in an `UNTRUSTED` envelope before it reaches the model. Only a fixed trusted acknowledgement (`Restarting…`, `Dialogs will be dismissed`, `Closed tab N`) is left unwrapped, and the decision is made on the **output**, never on the command id.
- **Provenance guard** — a verbatim copy of page text that reaches a sprint artifact is **quarantined** (wrapped as data — never deleted, never reworded) and the pre-guard bytes are kept under `.kstack/guard-backup/`. Only an instruction-shaped copy escalates: the run parks for a human (**Accept / Re-run / Abort**) without burning an attempt. A tampered or full taint store degrades to a whole-artifact scan rather than to silence.
- **Cache telemetry** — the run report carries the fresh-prompt token count (`tokensIn`) and the **per-scope** cache hit rate (main and delegated are never averaged). `KSTACK_PI_CACHE_LONG=1` gives delegated children a longer cache retention; with the flag off the retention key is removed from the child env instead of being inherited.
- **Per-class budgets** — the turn and token budgets follow the phase's timeout class (explore / work / verify — provisional, every one env-overridable). A budget trip parks the run and names the env var that raises the tripped dimension; the two true quota parks (wall-clock, run tokens) are unchanged.

## Requirements

- [pi](https://github.com/earendil-works/pi) >= 0.82.0
- For skill memory scripts: [Bun](https://bun.sh) >= 1.3.0 + Git Bash (Windows). The bundled skills' operational-memory preamble (`runtime/bin/kstack-telemetry-log`, `kstack-slug`, `kstack-redact`, `kstack-review-log`, `kstack-developer-profile`, …) executes bash wrappers that validate via `bun -e`. Without bun those calls fail silently (`|| true` guards) and memory writes are dropped; the orchestrator itself is unaffected.

## Installation

### 1. Clone

```bash
git clone https://github.com/YOUR_USER/kstack ~/.pi/agent/extensions/kstack
```

Pi auto-discovers extensions in `~/.pi/agent/extensions/`. No settings.json changes needed.

The browse binary is not committed (`runtime/` is gitignored): it downloads automatically at the first `session_start` (`lib/download.ts`).

### 2. Verify

Open pi in any project. Type `/kstack` — you should see the workflow menu.

## Usage

### The `/kstack` command

```
/kstack              # Interactive menu (context-aware, sorted by git state)
/kstack ship         # Start a specific workflow directly
/kstack investigate  # Bug debugging pipeline
/kstack init         # Install/refresh the AGENTS.md rules block + sync agents/*.md into ~/.pi/agent/agents
```

The menu adapts to your git context:
- Uncommitted changes → "investigate" and "review" float to top
- Ahead of remote → "ship" floats to top
- On main branch → "develop" floats to top

### Workflows

| Workflow | Phases | Use case |
|----------|--------|----------|
| `develop` | understand → explore → **plan (interactive)** → implement → QA → review → ship → docs (opt.) | Full feature cycle |
| `investigate` | reproduce → root-cause (⏸ gate) → fix → verify → regression QA (opt.) | Systematic debugging |
| `qa` | setup → browser test → report → fix (opt.) | Browser-based QA with fixes |
| `qa-report` | setup → browser test → report — **never modifies code** | QA report without fixes |
| `ship` | pre-checks → review → test → push+PR → verify CI → docs (opt.) | Release pipeline |
| `review` | diff analysis → findings → fix (optional) | Code review |
| `quick` | single action picker | One-shot actions |
| `sprint` | understand → user-story → capability → system-design (⏸) → backlog → implement (BE→FE) → devsecops-review → qa-verdict → commit+archive | Full agile delivery with deterministic gates, security freeze, bounded retries |

⏸ = decision phase: the workflow pauses in `awaiting_approval` until you run `/kstack next`.

Each phase runs either in the main agent context (analysis, verification, planning) or is delegated deterministically to a spawned specialist subagent — scout / planner / worker / reviewer (implementation, exploration, heavy testing). The orchestrator injects structured instructions and advances when the model calls `kstack_advance`; it can never bypass a manual gate or a parked state — the advance tool refuses `paused`/`awaiting_approval` states outright, so only you can resume, re-run, accept or abort from the `/kstack` panel.

While a workflow is active, every interactive input is prefixed with a resume context that re-anchors the current phase, the goal, and the constraints still binding this turn (frozen gate, unreadable verdict, report-only posture, decision phase) — short acknowledgements like "ok" stay on-workflow instead of drifting back to plain chat.

### The interactive plan cycle (`develop`)

1. **understand** — requirements analysis in the main context
2. **explore** — the scout subagent gathers codebase facts (its own context window)
3. **plan** — *you are interviewed*. Using the grilling protocol (design-tree rounds of ≤5 questions, each with a recommended answer), office-hours product judgment, and plan-eng-review rigor, the orchestrator converges on scope with you and writes `.kstack/plans/<slug>.md`
4. ⏸ you read the actual plan file, then `/kstack next`
5. **implement** — worker reads the plan file directly; QA, review, ship and docs follow autonomously

### Skill methodology injection

The workflow decides when skill knowledge applies — the model never has to guess:

- Every mapped phase injects the canonical `skills/<id>/SKILL.md` — a missing catalog file degrades to the compact DoD gate so a run never breaks.
- Main phases embed the methodology; subagent phases receive it inside their task string while orchestrator instructions carry only the compact **DoD + best-practices gate**
- Repeated deliveries within one run degrade to the DoD gate (~40% skill-token savings)
- Wired skills: investigate, qa, review, ship, office-hours, plan-eng-review, document-release (+generate), grilling, plus the sprint family (capability, system-design, adr, tasks, tdd, verification, appsec, docker, qa, pipeline). All 28 bundled skills stay manually invocable via `/skill:kstack-*`.

### Skill catalog (`skills/`)

28 skills in a flat `skills/kstack-<id>/` layout — each with `SKILL.md`, colocated
`references/`, and a `## DoD gate` section. Pi's recursive discovery loads them under
one `"skills": ["./skills"]` root; invoke manually via `/skill:kstack-qa`,
`/skill:kstack-spec`, … The orchestrator's wired phases embed the same canonical files.

### Input routing

Workflows start only via `/kstack` — there are no keyword-based workflow suggestions. While a workflow is active, every interactive message is prefixed with the current phase/step and its binding constraints (parked, frozen, decision gate) so the model stays anchored. Slash commands and bare stop words are never intercepted.

### Starting a workflow

Workflows start ONLY through `/kstack` — the pre-flight panel (gate mode, per-gate choices) is never skipped. There is no programmatic start tool: agents and subagents cannot bootstrap a workflow on their own.

### Browser tools (65)

All registered as native pi tools, callable by the LLM automatically:

```
kstack_goto, kstack_snapshot, kstack_click, kstack_fill,
kstack_screenshot, kstack_text, kstack_html, kstack_console,
kstack_network, kstack_responsive, kstack_diff, kstack_is,
kstack_cookie_import_browser, kstack_pdf, ...
```

WP1 additions: `kstack_chain` runs a JSON array of `[cmd, ...args]` batches in ONE
call (payload via stdin; output enveloped as untrusted web content), `kstack_dialog`
reads the daemon's dialog ring buffer, `kstack_perf` returns page metrics, and
`kstack_daemon_status` / `kstack_daemon_restart` expose daemon health and recovery
(the `daemon-` infix distinguishes them from the orchestrator tools).

Full list: see `tools.generated.ts` (65 commands from the kstack browse CLI).

### Skills (28)

Flat catalog, uniform `kstack-` prefix:

```
skills/
├── kstack-qa/        SKILL.md + references/  → /skill:kstack-qa
├── kstack-ship/                             → /skill:kstack-ship
├── kstack-spec/                             → /skill:kstack-spec
└── … 25 more                                → /skill:kstack-*
```

They coexist with the orchestrator. Use them when you want the raw methodology without the guided pipeline. Registry skills referenced by the orchestrator's digest injection resolve their SKILL.md under `skills/kstack-<id>/` (see `orchestrator/skills.ts`).

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `KSTACK_BINARY` | Absolute path to the browse binary | Auto-resolved |
| `KSTACK_ROOT` | Root of a kstack installation (alternative binary source) | Not set |

### Binary resolution order

The extension searches for the browse binary in this order:

1. `$KSTACK_BINARY` (explicit override)
2. `$KSTACK_ROOT/browse/dist/browse` (standard kstack install)
3. `<extension>/runtime/browse/dist/browse` (downloaded at session start)
4. `../kstack/browse/dist/browse` (dev sibling layout)

On Windows, `.exe` is appended automatically.

## Updating

`git pull` in the extension directory, then restart pi. The browse binary
re-downloads automatically on the next session start when the pinned release
tag changes (`lib/download.ts`).

<!-- audit-exempt: pre-rename names in this section are intentional migration notes -->
### Upgrading from gstack-pi

The extension was renamed gstack → kstack (command `/kstack`, tools `kstack_*`,
env `KSTACK_*`, skills `kstack-*`). Install it as a separate extension dir —
`~/.pi/agent/extensions/kstack` — and remove the old `gstack-pi` one.

State lives in two places, both renamed: `.kstack/` inside each target repo
(`plans/`, `sprints/`, `runs/`) and `~/.kstack` for session-level data
(sessions, analytics, learnings; overridable via `KSTACK_HOME`). **No data
migration ships yet** — `~/.kstack` starts clean, and the old `~/.gstack` and
`.gstack/` dirs are moved aside to `~/.kstack/legacy/gstack-home` and
`<repo>/.kstack/legacy/gstack-repo-state` (not deleted), while persisted
pre-rename workflow sessions simply don't resume (the state entry type
changed). A migration script (`kstack-migrate`) is planned for a later
sprint. A legacy `<!-- gstack:begin -->` managed block in a repo's AGENTS.md
is upgraded in place by `/kstack init`.

## Architecture

```
kstack/
├── index.ts                 Entry: registers tools + orchestrator
├── tools.generated.ts       65 browser tool registrations (auto-generated)
├── lib/
│   ├── browse.ts            Binary resolution + subprocess spawn
│   ├── download.ts          Auto-download browse binary from GitHub Releases
│   ├── commands.ts          Allowlist re-export
│   ├── commands.generated.ts  Allowed command set (auto-generated)
│   └── schemas.ts           TypeBox parameter schemas
├── orchestrator/
│   ├── index.ts             Registers /kstack, kstack_advance, kstack_phase, input router
│   ├── types.ts             Workflow, Phase, State interfaces
│   ├── state.ts             State machine (persist via pi appendEntry; approval gates)
│   ├── git.ts               Git context detection
│   ├── workflows.ts         8 workflow definitions (data-driven, skill mappings)
│   ├── templates.ts         Phase instruction builders + skill tiering + plan-file protocol
│   ├── executor.ts          Phase execution, deterministic subagent delegation, skip logic
│   ├── skills.ts            Skill registry: digests, DoD gates, paths
│   ├── spawn.ts             Deterministic subagent execution (pi --mode json)
│   ├── sprint.ts            Sprint numbering discovery + root/archive anomaly guards
│   ├── verdicts.ts          Deterministic verdict parsing, dual-channel verification, retry feedback
│   ├── artifacts.ts         Sprint-stamped artifact filenames + phase→artifact map — single source for templates, verdicts, freeze path, kstack_phase
│   ├── handoff.ts           ## HANDOFF extraction for {previous} (tail fallback)
│   ├── skip.ts              Structural-skip guards (root-cause collapse, QA fix loop)
│   ├── telemetry.ts         Per-step run reports (.kstack/runs)
│   ├── text.ts              $-safe interpolation
│   ├── config.ts            Feature flags (KSTACK_PI_*)
│   ├── command.ts           /kstack command handler (+ /kstack next, /kstack init)
│   ├── init.ts              /kstack init — managed AGENTS.md rules block
│   └── router.ts            Active-workflow re-anchoring of user input (transform, never block)
├── runtime/
│   └── bin/                 kstack-* helper scripts (bash, memory + telemetry)
├── skills/kstack-*/         Flat catalog — 28 skills, recursive discovery (manual /skill: use)
├── agents/                  Canonical specialist agent definitions (sync to ~/.pi/agent/agents/)
├── test/                    bun test suites (orchestrator, sprint, delegation, boundaries)
├── TODOS.md                 Backlog: deferred features, skill integrations, follow-ups
└── .gitignore               Excludes runtime/ build artifacts (dist binaries)
```

### How the orchestrator works

```
/kstack ──────────────────┐
                          ├──→ State Machine ──→ Phase Executor ──► main phase:
input router ─────────────┘         ↑                              instructions to LLM
                                    │                                    │
                     manual gate? ──┤                       subagent phase: spawn
                       yes: pause   │                       specialists first, then
                       (/kstack next)│                      prefix their output
                                    │                                    ↓
                      kstack_advance ←──── LLM executes/reviews ←── instructions
```

1. User starts a workflow via `/kstack`
2. The orchestrator injects phase instructions into the LLM context (`followUp` delivery — never mid-turn)
3. Subagent phases are executed by the orchestrator itself: specialists run in isolated `pi` processes and their output is prefixed for review
4. The LLM calls `kstack_advance` with a summary — this is the only progression mechanism; it must never defer back to the user
5. Auto phases advance immediately; decision phases (`develop.plan`, `investigate.root-cause`) park in `awaiting_approval` until you run `/kstack next`
6. Sprint parks (security freeze, unreadable verdict, loop exhaustion, numbering anomaly, branch violation, kill-switch pauses, failed phases) are tool-enforced: a repeat `kstack_advance` is refused and only the `/kstack` panel moves the state machine
7. Repeat until all phases complete

State persists across session reloads via pi's `appendEntry` (not sent to LLM context).

### Token overhead

| | Per-session fixed | Per-phase |
|---|---|---|
| Browser tools | ~180 tokens (tool descriptions) | 0 |
| Orchestrator | ~150 tokens (advance/start) | ~600-1000 (instructions) |
| Skill methodology | 0 (on disk) | full SKILL.md on first delivery (main phases); DoD gate only for subagent-phase verification and repeats |

## Branches & feature flags

- `main` — stable baseline. Development happens on `kstack`.
- Runtime kill switches (env): `KSTACK_PI_SKILLS=off`, `KSTACK_PI_DETERMINISTIC=off`, `KSTACK_PI_MANUAL_GATES=off`.

Deferred ideas live in `TODOS.md` (absorbed the old `FUTURE_UPDATES.md`).

## Security

- Browse binary spawned with `shell: false` (no shell injection)
- Command allowlist: only the 65 registered commands can execute
- Output capped at 32,000 chars per tool call
- `cookie-import-browser` requires explicit user confirmation
- Input router never blocks (`action: "handled"` is never returned)

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "kstack browse binary not found" | Restart pi (auto-download) or set `KSTACK_BINARY` |
| "server-node.mjs not found" (Windows) | Run `bash browse/scripts/build-node-server.sh` in the kstack repo |
| `/kstack` not showing in pi | Ensure the extension is in `~/.pi/agent/extensions/kstack/` with `index.ts` at root |
| Subagent phases fail | Ensure `~/.pi/agent/agents/` has scout.md, planner.md, worker.md, reviewer.md — plus the sprint specialists (sprint-planner, software-architect, backend-developer, frontend-developer, qa-engineer, devsecops-reviewer) for the sprint workflow. Canonical copies live in this repo's [`agents/`](agents/) — copy them to `~/.pi/agent/agents/` manually |
| Skills not loading | Pi requires `"skills": ["./skills"]` in a package.json, or project `.pi/settings.json` |

## License

MIT

---

## Credits & attribution

kstack is a fork and rebrand of **[gstack](https://github.com/garrytan/gstack)** by [Garry Tan](https://github.com/garrytan) (MIT).

| What | Origin | State here |
|---|---|---|
| Headless-browser runtime (`browse/`) | [garrytan/gstack](https://github.com/garrytan/gstack) `browse/` (commit `43d6ed2`, v1.91.165.0) | Vendored into [`browser/`](browser/) with the gstack → kstack rename applied (`.gstack` → `.kstack`, `GSTACK_*` → `KSTACK_*`). Upstream layout is preserved so import paths are unchanged. The upstream MIT license is reproduced verbatim in [`browser/LICENSE`](browser/LICENSE) and the provenance in [`browser/NOTICE.md`](browser/NOTICE.md). |
| Browser tools (65 `kstack_*` commands) | gstack `browse/src/commands.ts` | Re-exposed as native pi tools; the command set is unchanged. |
| Workflow orchestrator (`/kstack`) | kstack | Original work: the deterministic multi-phase orchestrator, sprint workflow, verdict routing, park model, and skill catalog were written for this project. |

gstack remains the upstream of the browser layer only: the vendored tree is maintained in this repo and is no longer synced from upstream. Its license and copyright notice are preserved, as MIT requires.

Earlier releases were published as `gstack-pi`; v3.0.0 is the first release under the `kstack` name.

---

## Injection & efficiency

The orchestrator controls WHAT is injected into subagent prompts and HOW chains are orchestrated. All protocols below apply in **deterministic mode** (`KSTACK_PI_DETERMINISTIC=on`, the default). With `KSTACK_PI_DETERMINISTIC=off`, tasks flow through the advisory `subagent`-tool path where `{previous}` stays literal and handoff extraction is never invoked (documented advisory divergence). The `sprint` workflow refuses to start in this mode: its review gates route exclusively on delegation-produced verdicts.

### Task contracts (three paths)
Every delegated task and every main-phase instruction carries a falsifiable pair of blocks in a fixed order:

```text
## DELIVERABLE      <- what must exist when the work is done (verifiable yes/no)
## STOP CONDITION   <- "Stop when: <observable condition>. Further exploration is waste."
## CONTEXT          <- goal, branch, prior-phase summaries, {previous}
## METHODOLOGY      <- skill digests with a per-class prefix
## OUTPUT CONTRACT  <- REPORT + structured HANDOFF requirement
```

The contracts cover all three injection paths: single-agent tasks (`buildAgentTask`), chain steps (inline in `workflows.ts`), and main-phase instructions (`buildMainInstructions`). A cross-cutting unit test fails if any workflow phase loses its contract.

### HANDOFF protocol
Chain steps no longer receive the entire upstream report. `extractHandoff()` (orchestrator/handoff.ts) computes what travels into `{previous}`, preferring the structured `## HANDOFF` section each specialist must emit (VERIFIED FACTS / DECISIONS / OPEN QUESTIONS / DO NOT REDO). Levels are visible in delegation summaries:

| level | meaning |
|---|---|
| `full` | well-formed HANDOFF section, VERIFIED FACTS present, <= 4000 chars |
| `partial` | HANDOFF section present but incomplete/malformed |
| `raw` | small output (<= 6000 chars) passed whole |
| `fallback` | tail cut of oversized output, or output from an incomplete run |

Extraction runs on the RAW uncapped output (`SpawnResult.rawOutput`); the 50KB display cap only applies to what reaches orchestrator context.

### Root-cause structural skip
If the reproduce phase's summary contains a valid marker line inside its HANDOFF section:

```text
CONFIRMED ROOT CAUSE: <one-line cause> | files: <comma-separated file paths>
```

the root-cause scout->planner chain collapses to ONE validate-only planner step. Anti-spoofing guards (ALL mandatory, see skip.ts): (a) the marker only counts inside the `## HANDOFF` section, (b) every cited file must exist on disk relative to cwd, (c) the validate step itself is never skippable and the workflow never collapses directly to fix. A leading `REFUTED:` line rebuilds and re-runs the full original chain prefixed with an explicit NOTE. The QA fix phase is structurally skipped when the test phase falsifiably reports zero failures (`allTestsPassed`).

### Per-class timeouts
`KSTACK_PI_TIMEOUT_EXPLORE` (default 3600s), `KSTACK_PI_TIMEOUT_WORK` (default 14400s), `KSTACK_PI_TIMEOUT_VERIFY` (default 3600s); unknown ids fall back to `KSTACK_PI_SUBAGENT_TIMEOUT` (default 3600s). Values are seconds. Every registered phase id maps to exactly one class (`timeoutClassFor`), enforced by test.

These are **runaway backstops**, not work quotas: they catch a child that never stops, and they no longer cut a working one in half. What actually guards a delegated child is the **pulse** (below).

### The pulse — the sanity check on a delegated child
There is **no budget**: no turn cap, no token cap, no context cap, no phase
wall-clock cap (ADR-64). The orchestrator instead checks **periodically**
whether the child is still working:

| signal | meaning | default |
|---|---|---|
| `stalled` | no progress for a while — a progress tick is a tool call with a new `(tool, args)` key or an assistant message whose text differs from the previous one | `KSTACK_PI_NO_PROGRESS_SEC` = 900 (15 min) |
| `lexical-drift` | the child's recent words stopped sharing the brief's words **while the previous window still did** (the collapse is the signal) | window 8 messages, ≥3 shared terms, ≥120 words, every `KSTACK_PI_DRIFT_EVERY_EVENTS` = 20 events |
| `scope-drift` | the child wrote a file outside the repository it was given (the OS temp dir is allowed) | acts at once |

A pulse trip does **not** park immediately: the step is re-dispatched **once**
with a recovery brief that names what went wrong and forbids a restart ("the
repository already holds what the previous attempt completed"). Only the second
trip parks — and the park carries the diagnosis, so the panel says *what the
child was doing* instead of "raise a budget". The run report carries the
pulse row per step (the evaluations, the longest gap without progress, the
signal). The loop rules of `stuck.ts` (identical action, alternating, error
streak, monologue, context errors) stay as they are — they are the "is it
going mad" check.

The old caps still work when an operator asks for them explicitly:
`KSTACK_PI_STEP_MAX_TURNS` / `_TOKENS` / `_CONTEXT` / `_MS` / `_USD` /
`_USD_PER_MIN` (a number enables that cap, `off` is unlimited). The phase
wall-clock budget `KSTACK_PI_DELEGATION_BUDGET_SEC` is **off** by default.

### Environment variables

| variable | default | effect |
|---|---|---|
| `KSTACK_PI_SKILLS` | on | skill digest injection |
| `KSTACK_PI_DETERMINISTIC` | on | executor-spawned subagents; `off` also makes the `sprint` workflow refuse to start (its gates route on delegation verdicts) |
| `KSTACK_PI_MANUAL_GATES` | on | approval pause after decision phases |
| `KSTACK_PI_OPTIONAL_PHASES` | ask | `ask` \| `auto` \| `skip` handling of optional phases |
| `KSTACK_PI_AUTO_GATE_VALIDATED` | off | auto-advance past root-cause gate when validation starts with `VALIDATED:` |
| `KSTACK_PI_SPRINT` | on | registers the sprint workflow; `off` hides it from menu and router entirely |
| `KSTACK_PI_LOOPBACKS` | on | sprint loop-back engine; `off` ⇒ negative gate verdicts park in a `/kstack` panel (Accept / Re-run / Abort) instead of retrying |
| `KSTACK_PI_VERDICTS` | on | deterministic verdict parsing; `off` ⇒ no auto-routing; gates park in a `/kstack` panel (Accept / Re-run / Abort) |
| `KSTACK_PI_DELEGATION_BUDGET_SEC` | off | wall-clock budget for one phase's whole delegation chain; `off` (the default) disables it — the pulse guards the child instead (ADR-64) |
| `KSTACK_PI_SPRINT_MAX_ATTEMPTS` | 4 | consecutive implement-rerun ceiling per review gate (counter resets on gate approval or on "Accept result — continue past the gate") |
| `KSTACK_PI_SPRINT_ARCH_MAX_ATTEMPTS` | 5 | system-design rerun ceiling after architect rejections |
| `KSTACK_PI_MODEL_FAST` / `_STRONG` | unset | model tiers for mechanical vs judgment-heavy phases; unset keeps each agent's own default (inert) |
| `KSTACK_PI_STRICT_CONTENT` | off | heuristic scan + ASCII-sentinel enveloping of page-content tool output (WP2 defense-in-depth) |
| `KSTACK_PI_SUBAGENT_TIMEOUT` | 3600 | fallback timeout, seconds |
| `KSTACK_PI_TIMEOUT_EXPLORE` / `_WORK` / `_VERIFY` | 3600 / 14400 / 3600 | per-class runaway backstops, seconds (ADR-64 raised them: they are not work quotas) |
| `KSTACK_PI_NO_PROGRESS_SEC` | 900 | the pulse's stall threshold: no progress for this long stops the child, seconds |
| `KSTACK_PI_DRIFT_WINDOW` / `_TERMS` / `_MIN_WORDS` / `_EVERY_EVENTS` | 8 / 3 / 120 / 20 | the pulse's lexical-drift measure: the window size, the shared terms that must collapse, the minimum words, the evaluation cadence |
| `KSTACK_PI_PULSE_HEARTBEAT_SEC` | 30 | how often the orchestrator wakes up to evaluate the pulse, seconds |
| `KSTACK_PI_LIVENESS_SEC` | 240 | observe-only silence threshold, seconds; `off` disables |
| `KSTACK_PI_MAX_RUN_TOKENS` | disabled | orderly chain stop after cumulative token usage exceeds it |

Run reports land in `.kstack/runs/<ISO-timestamp>-<workflowId>.json` (per-step durations, tool calls, turns, token usage, handoff levels, incompleteness, timeout class, liveness observations, and the pulse row: the evaluations, the longest gap without progress, the signal that stopped the child).

## Security & trust boundaries

Everything INJECTED into prompts (user goals, skill digests, subagent output, HANDOFF payloads) is **untrusted input**: it comes from the user or from analyzed repository content, which can plant marker strings verbatim (a repo documenting its own processes can contain the literal `CONFIRMED ROOT CAUSE:` line).

Therefore:

- The root-cause collapse triggers ONLY if (a) the marker appears inside the structured `## HANDOFF` section, (b) every cited file exists on disk relative to cwd, and (c) the validate step always executes and cannot be compressed. A marker planted in repo content outside those guards produces no collapse.
- VERIFIED FACTS are context, not proof: agent directives (see `AGENTS_NOTES.md`) instruct specialists to re-check claims that are load-bearing for code changes they are about to make.
- `$`-safe interpolation everywhere (`replaceExact`, orchestrator/text.ts): untrusted text containing `$&`, `` $` ``, `$'` or `$1` can never alter task structure.
- Liveness observation never terminates processes; kills remain a manual, data-driven decision.
- **Page text never lands in the taint store as text**: every browse output is reduced to 8-token shingle hashes (FNV-1a) before it is written, and the store lives under `.kstack/runs/<runId>/` with the run. The **provenance guard** uses those hashes to PROVE that a passage was copied from a page: a verbatim copy in a sprint artifact is quarantined losslessly, and only an instruction-shaped copy parks the run for a human. A store that was truncated or filled is treated as tampered — the guard then scans the whole artifact instead of trusting a store the agent could have emptied.

## Troubleshooting

**Phase advanced but nothing happens / pi exited unexpectedly.**

The deterministic delegation runs as a fire-and-forget background chain. Diagnose in this order:

1. **Session breadcrumbs** — every delegation milestone is persisted as a `kstack-delegation-event` session entry (`started`, `retrying`, `completed`, `failed`, `timeout`, `budget-exceeded`, `interrupted`). A `started` with no terminal event followed by an `interrupted` annotation means the host died mid-delegation (crash or restart).
2. **Debug log** — set `KSTACK_PI_DEBUG=<file>` before launching pi; every spawn attempt, pid, timeout, abort and provider error is appended there.
3. **Run reports** — `.kstack/runs/<ISO>-<workflow>.json` carries per-step durations, tool calls, token usage, handoff levels and liveness observations.

**Subagent fails fast with a provider error.** Errors like `Provider finish_reason: network_error` surface in the delegation summary and the failure event. pi auto-retries internally (3 attempts); the orchestrator adds one chain-level retry. If the provider outage persists, switch models (`--model`) and re-run. This is a provider problem, not an orchestrator bug.

**Type safety.** `bun run typecheck` (tsc --noEmit) gates the exact crash class from 2026-08-23 (a function used but never imported — a runtime `ReferenceError` thrown from a timer callback that killed pi; bundlers don't type-check). It also runs as part of `bun test`.

**Real-spawn end-to-end test.** `KSTACK_PI_E2E_SPAWN=1 bun test test/orchestrator.test.ts` spawns a real `pi -p` child through the production `runSubagent` path (opt-in because it needs a healthy provider and takes ~30-60s).
