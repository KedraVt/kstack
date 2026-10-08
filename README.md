# gstack-pi

Browser automation + guided workflow orchestrator for the [pi](https://github.com/earendil-works/pi) coding agent.

One extension, two layers:
- **65 native browser tools** — headless Chromium via gstack, ~100ms/command (chain batches N commands into one call)
- **Workflow orchestrator** — `/gstack` command that guides you through develop, investigate, QA, ship, and review pipelines

## What's new (feat/skill-ingestion branch)

- **Deterministic subagents** — specialists (scout/planner/worker/reviewer) are spawned by the orchestrator itself in isolated `pi` processes; delegation no longer depends on the model's discretion. The `subagent` tool remains for ad-hoc use.
- **Interactive plan cycle** — scout explores → you are interviewed (grilling protocol rounds with recommended answers + office-hours judgment + eng-review rigor, ≤5 questions/round) → plan written to `.gstack/plans/<slug>.md` → your approval gate (`/gstack next`) → worker implements from the plan file.
- **Manual decision gates** — `develop.plan` and `investigate.root-cause` pause for user approval before code is touched. Optional phases (e.g. `investigate.regression-qa`) park the same way: the workflow pauses and the `/gstack` panel asks you to **Run / Skip / Abort** — no background Yes-defaulted dialog you can answer by accident.
- **Skill ingestion** — distilled methodology digests (~2K tokens) from gstack's SKILL.md files are injected by the workflow itself: full digest to whoever does the work, compact DoD+best-practices gates for verification and repeats.
- **Documentation phases** — optional doc-update phase on `develop` and `ship` (Diataxis coverage map, chained generation for missing docs).
- **`qa-report` workflow** — full QA methodology, report-only, never modifies code.
- **`gstack_start` tool** — programmatic workflow entry point (usable by any agent, including subagents).

## What's new (feat/sprint-workflow branch)

- **`sprint` workflow (default-on)** — a 10-phase agile delivery pipeline distilled from `.agents-clean` methodology: understand → user-story → capability → system-design → ⏸ architect gate → backlog → implement → devsecops review → QA verdict → commit/archive. Planning artifacts (`user-story_XX.md`, `system-design_XX.md`, `tasks_XX.md`, …) live in the project root and archive to `.gstack/sprints/sprint_XX/` when the sprint goes green.
- **Deterministic verdict routing** — review gates emit machine-parseable verdict lines (`status == red|green|orange`, `security-review == approved|rejected`) inside a `## HANDOFF` section. The orchestrator parses them fail-closed (whitelist-only values, containment-checked), cross-verifies them against the artifact files on disk (dual channel: chat + disk must agree), and routes deterministically — never on the model's say-so.
- **Parks are code-enforced** — every parked state (security freeze, unreadable verdict, loop exhaustion, numbering anomaly, branch violation, failed phase) is refused by the `gstack_advance` tool itself, not just discouraged in prose: a repeat call cannot advance past a park on the model's say-so. Only the `/gstack` panel (or `/gstack next` where applicable) can resume, re-run, accept or abort.
- **Branch enforcement** — sprint gates that audit developer output (`devsecops-review`, `qa-verdict`) park fail-closed when entered on main/master: MASTER_DOD requires `task/<slug>` branches for implementation work. Document-level phases (`architect-gate`, planning) legitimately run on main.
- **Compaction guard** — the per-turn resume prefix re-anchors the active main phase's deliverable/stop-condition contract, and the read-only `gstack_phase` tool re-fetches full phase instructions on demand — for delegated phases it also names the durable artifact files, since specialist results arrive via a transient message and are never persisted.
- **Truthful status line** — the footer shows the real state instead of the last running label: `PARKED for approval — /gstack next`, `FROZEN: <severity> security rejection`, `verdict unreadable (<cause>)`, `loop exhausted`, `branch violation`, `phase failed`; cleared on completion/abort.
- **Security freeze** — a critical/high security rejection parks the whole sprint until a human types the confirmation phrase in the panel; medium/low rejections loop back to implement normally.
- **Trust boundary note** — dual-channel verification trusts files in the repo root: a malicious repo can pre-plant both channels against a predictable next sprint number. Sprint stamping, anomaly guards, and the hard commit-archive gate raise the bar but do not close within-sprint planting — review gate artifacts before approving.
- **Bounded loop-backs** — rejected reviews return work to the implementing phase with extracted blocker feedback; after N attempts (configurable) the sprint parks for human decision instead of looping forever. Accepting an exhausted gate ("Accept result — continue past the gate") resets the loop budget, so the next review gate gets a fresh ceiling instead of parking on its first rejection.
- **Unreadable-verdict park** — if a gate's output can't be parsed into a known verdict, the sprint parks WITHOUT burning an attempt; the panel shows only the failing lines so you can approve/loop/inspect deliberately.
- **Sprint requires deterministic delegation** — the sprint gates route exclusively on executor-produced verdicts, so the workflow refuses to start while `GSTACK_PI_DETERMINISTIC=off` (both `/gstack sprint` and the `gstack_start` tool explain this). Kill-switch parks (`GSTACK_PI_VERDICTS=off` / `_LOOPBACKS=off`) likewise land in a decision panel offering **Accept / Re-run / Abort**.
- **Strict BE→FE chain** — implementation runs backend-developer then frontend-developer sequentially per task wave; model tiers (`GSTACK_PI_MODEL_STRONG/FAST`) let judgment phases run on stronger models while mechanical phases stay cheap.
- **Fixed**: phase instructions are now delivered with `followUp` streaming behavior — eliminates the "Agent is already processing" error that silently dropped phase handoffs.
- **Raw skill library split** — the bundled skill surface is organized in two folders: `skills/gstack/` (23 cherry-picked gstack skills, manual `/skill:gstack-*` invocation) and `skills/kedra/` (18 full `.agents-clean` methodology skills, verbatim, manual `/skill:<name>` invocation — the whole source library except `acceptance-criteria-backend/-frontend`, which live inside the sub-agent bodies).
- **Centralized artifact names** — `orchestrator/artifacts.ts` is the single source for every sprint-stamped filename (`qa-artifact_XX.md`, `code-review-artifact_XX.md`, `software-architect-artifact_XX_N.md`, …); verdict verification, task templates and the freeze path all consume it, closing the stamping-drift bug class.
- **D4 park causes** — an unreadable-verdict park now records *why* in `pausedReason` (`no-verdict` / `artifact-mismatch` / `unroutable`) and the panel names the cause for triage; no attempt is burned either way.
- **Runtime binaries untracked** — `runtime/` is gitignored and provisioned on demand (session-start download / `update.sh`); ~197MB of browse daemon binaries were dropped from the git index.
- **Delegation test harness** — `runDeterministicDelegation` accepts an injected `spawnFn`; `test/executor-delegation.test.ts` exercises the real chain engine (HANDOFF threading, retry, budgets, REFUTED reopen, circuit breakers) with fake spawns.

## Requirements

- [pi](https://github.com/earendil-works/pi) >= 0.82.0
- For updates **and skill memory scripts**: [Bun](https://bun.sh) >= 1.3.0 + Git Bash (Windows). The bundled skills' operational-memory preamble (`gstack-telemetry-log`, `gstack-learnings-log`, `gstack-question-log`, …) executes bash wrappers from `source/bin/` that validate via `bun -e` — verified working 2026-08-24 (write → search roundtrip, fail-loud validation, latest-wins dedup). Without bun those calls fail silently (`|| true` guards) and memory writes are dropped; the orchestrator itself is unaffected.

## Installation

### 1. Clone with submodules

```bash
git clone --recurse-submodules https://github.com/YOUR_USER/gstack-pi ~/.pi/agent/extensions/gstack-pi
```

Pi auto-discovers extensions in `~/.pi/agent/extensions/`. No settings.json changes needed.

The browse binary is not committed (`runtime/` is gitignored): it downloads automatically at the first `session_start` (`lib/download.ts`) or is provisioned by `update.sh`.

The `source/` submodule (~69MB) contains the gstack repo. It's only needed for updates — you can skip it on first clone with `--no-recurse-submodules` and fetch it later when you want to update.

### 2. Verify

Open pi in any project. Type `/gstack` — you should see the workflow menu.

## Usage

### The `/gstack` command

```
/gstack              # Interactive menu (context-aware, sorted by git state)
/gstack ship         # Start a specific workflow directly
/gstack investigate  # Bug debugging pipeline
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

⏸ = decision phase: the workflow pauses in `awaiting_approval` until you run `/gstack next`.

Each phase runs either in the main agent context (analysis, verification, planning) or is delegated deterministically to a spawned specialist subagent — scout / planner / worker / reviewer (implementation, exploration, heavy testing). The orchestrator injects structured instructions and advances when the model calls `gstack_advance`; it can never bypass a manual gate or a parked state — the advance tool refuses `paused`/`awaiting_approval` states outright, so only you can resume, re-run, accept or abort from the `/gstack` panel.

While a workflow is active, every interactive input is prefixed with a resume context that re-anchors the current phase, the goal, and the constraints still binding this turn (frozen gate, unreadable verdict, report-only posture, decision phase) — short acknowledgements like "ok" stay on-workflow instead of drifting back to plain chat.

### The interactive plan cycle (`develop`)

1. **understand** — requirements analysis in the main context
2. **explore** — the scout subagent gathers codebase facts (its own context window)
3. **plan** — *you are interviewed*. Using the grilling protocol (design-tree rounds of ≤5 questions, each with a recommended answer), office-hours product judgment, and plan-eng-review rigor, the orchestrator converges on scope with you and writes `.gstack/plans/<slug>.md`
4. ⏸ you read the actual plan file, then `/gstack next`
5. **implement** — worker reads the plan file directly; QA, review, ship and docs follow autonomously

### Skill methodology injection

The workflow decides when skill knowledge applies — the model never has to guess:

- Every mapped phase injects the canonical `skills/<id>/SKILL.md` — a missing catalog file degrades to the compact DoD gate so a run never breaks.
- Main phases embed the methodology; subagent phases receive it inside their task string while orchestrator instructions carry only the compact **DoD + best-practices gate**
- Repeated deliveries within one run degrade to the DoD gate (~40% skill-token savings)
- Wired skills: investigate, qa, review, ship, office-hours, plan-eng-review, document-release (+generate), grilling, plus the sprint family (capability, system-design, adr, tasks, tdd, verification, appsec, docker, qa, pipeline). All 41 bundled skills stay manually invocable via `/skill:` (23 under the `gstack-` prefix, 18 kedra skills under their own name).

### Raw skill library (`skills/gstack/` + `skills/kedra/`)

Pi's recursive discovery (`pi-agent-core` harness) loads `SKILL.md` files at any depth, so both families coexist under one `"skills": ["./skills"]` root:

| Folder | Contents | Invocation | Source |
|---|---|---|---|
| `skills/gstack/` | 23 cherry-picked gstack skills (router nested at `gstack/gstack/`) | `/skill:kstack-qa`, `/skill:kstack-spec`, … | upstream gstack, adapted by `scripts/adapt-skills.ts` |
| `skills/kedra/` | 18 full `.agents-clean` skills — sprint methodology, process discipline (Iron Laws), security/infra, code quality | `/skill:systematic-debugging`, `/skill:adr`, `/skill:tasks`, … | `C:\Users\Mattia\Desktop\.agents-clean\skills\`, copied verbatim 2026-08-27 |

`kedra/` ships the FULL source methodology. Deliberately excluded: `acceptance-criteria-backend` and `acceptance-criteria-frontend` — already folded into the `backend-developer`/`frontend-developer` sub-agent bodies (TODOS D12). Companion files (e.g. `testing-anti-patterns.md`, `systematic-debugging` reference material) are copied too — pi resolves skill-relative paths against the skill's own directory.

### Automatic routing

The extension monitors your input and suggests workflows when it detects intent:

- "why is login broken" → suggests `investigate`
- "let's ship this" → suggests `ship`
- "build a new dashboard" → suggests `develop`
- "test the site" → suggests `qa`
- "just report the bugs, don't fix" → suggests `qa-report`

Suggestions are advisory — the LLM asks before starting a workflow. Slash commands and short inputs are never intercepted.

### Programmatic start

Any agent — including spawned subagents, which load this extension too — can bootstrap a workflow with the `gstack_start { workflow, goal }` tool.

### Browser tools (65)

All registered as native pi tools, callable by the LLM automatically:

```
gstack_goto, gstack_snapshot, gstack_click, gstack_fill,
gstack_screenshot, gstack_text, gstack_html, gstack_console,
gstack_network, gstack_responsive, gstack_diff, gstack_is,
gstack_cookie_import_browser, gstack_pdf, ...
```

WP1 additions: `gstack_chain` runs a JSON array of `[cmd, ...args]` batches in ONE
call (payload via stdin; output enveloped as untrusted web content), `gstack_dialog`
reads the daemon's dialog ring buffer, `gstack_perf` returns page metrics, and
`gstack_daemon_status` / `gstack_daemon_restart` expose daemon health and recovery
(the `daemon-` prefix distinguishes them from the orchestrator's own `/gstack status`).

Full list: see `tools.generated.ts` (65 commands from the gstack browse CLI).

### Skills (41)

Two families, two folders:

```
skills/
├── gstack/   23 cherry-picked gstack skills   → /skill:kstack-qa, /skill:kstack-ship, /skill:kstack-spec, ...
└── kedra/    18 .agents-clean methodology     → /skill:systematic-debugging, /skill:tdd (test-driven-development), ...
```

They coexist with the orchestrator. Use them when you want the raw methodology without the guided pipeline. Registry skills referenced by the orchestrator's digest injection resolve their deep-dive SKILL.md under `skills/gstack/<id>/` (see `orchestrator/skills.ts`).

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `GSTACK_BINARY` | Absolute path to the browse binary | Auto-resolved |
| `GSTACK_ROOT` | Root of a gstack installation (alternative binary source) | Not set |
| `GSTACK_REPO` | Path to gstack source (overrides submodule for scripts) | `<extension>/source/` |

### Binary resolution order

The extension searches for the browse binary in this order:

1. `$GSTACK_BINARY` (explicit override)
2. `$GSTACK_ROOT/browse/dist/browse` (standard gstack install)
3. `<extension>/runtime/browse/dist/browse` (built by update.sh / downloaded at session start)
4. `../../gstack/browse/dist/browse` (dev sibling layout)

On Windows, `.exe` is appended automatically.

## Updating

```bash
# Full update: pull gstack submodule, rebuild binary, sync skills + bin scripts
bash ~/.pi/agent/extensions/gstack-pi/update.sh

# Rebuild without pulling (local patches in source/)
bash ~/.pi/agent/extensions/gstack-pi/update.sh --skip-pull

# Update the submodule to latest upstream manually
cd ~/.pi/agent/extensions/gstack-pi/source && git pull origin main
```

The script also detects new upstream features (skills, tools, bin scripts) not yet included in the extension and prints them:

```
╔══════════════════════════════════════════════════════════╗
║  NEW FEATURES AVAILABLE UPSTREAM — update extension!    ║
╚══════════════════════════════════════════════════════════╝

  [skill] gstack-canary
  [tool]  gstack_handoff
  [bin]   gstack-analytics
```

To include new skills: add them to `SKILLS=` in `update.sh`.
To include new tools: run `bun run scripts/gen-tools.ts`.

### Skill adaptation pipeline

`scripts/adapt-skills.ts` translates freshly-pulled upstream SKILL.md files (written for Claude Code) into the pi form bundled in `skills/gstack/`: frontmatter rebuild, Pi adapter note, and path mapping to this extension's `runtime/bin`, `source/bin` and `source/`. It runs automatically as step 8 of `update.sh`; standalone usage:

```bash
bun run scripts/adapt-skills.ts --check          # dry-run: report diffs, write nothing
bun run scripts/adapt-skills.ts kstack-cso ...   # restrict to specific skills
```

The root `gstack` router skill is hand-maintained and never regenerated.

### Backups

A pre-migration snapshot of `skills/` and `update.sh` (before the runtime-path decoupling from the legacy adapter install) is kept at:

```
%TEMP%\opencode\gstack-pi-backup-20260824\
```

This is temporary storage: it can be deleted once you're satisfied with the adapted skills (a fresh backup is always one `git checkout` away — see `git log -- skills/`).

## Regenerating tools

When gstack adds new browse commands:

```bash
cd ~/.pi/agent/extensions/gstack-pi
bun run scripts/gen-tools.ts
```

This regenerates `tools.generated.ts` and `lib/commands.generated.ts` from `source/browse/src/commands.ts`.

## Architecture

```
gstack-pi/
├── index.ts                 Entry: registers tools + orchestrator
├── tools.generated.ts       65 browser tool registrations (auto-generated)
├── lib/
│   ├── browse.ts            Binary resolution + subprocess spawn
│   ├── download.ts          Auto-download browse binary from GitHub Releases
│   ├── commands.ts          Allowlist re-export
│   ├── commands.generated.ts  Allowed command set (auto-generated)
│   └── schemas.ts           TypeBox parameter schemas
├── orchestrator/
│   ├── index.ts             Registers /gstack, gstack_advance, gstack_phase, gstack_start, input router
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
│   ├── artifacts.ts         Sprint-stamped artifact filenames + phase→artifact map — single source for templates, verdicts, freeze path, gstack_phase
│   ├── handoff.ts           ## HANDOFF extraction for {previous} (tail fallback)
│   ├── skip.ts              Structural-skip guards (root-cause collapse, QA fix loop)
│   ├── telemetry.ts         Per-step run reports (.gstack/runs)
│   ├── text.ts              $-safe interpolation
│   ├── config.ts            Feature flags (GSTACK_PI_*)
│   ├── command.ts           /gstack command handler (+ /gstack next)
│   └── router.ts            Input intent detection (transform, never block)
├── skills/                  Raw skill library, recursive discovery (manual /skill: use)
│   ├── gstack/              23 cherry-picked gstack skills (router at gstack/gstack/)
│   └── kedra/               18 .agents-clean methodology skills, verbatim full sources
├── skills-distilled/        Distilled methodology digests (~2K tokens each) + vendored grilling protocol
├── scripts/
│   ├── gen-tools.ts         Regenerate tools from source/ commands
│   └── sync-skills.ts       Re-sync skills with path rewriting
├── test/
│   ├── orchestrator.test.ts  Unit tests (state machine, gates, workflows, tiering, intents)
│   ├── sprint.test.ts        Sprint workflow tests (verdicts, routing, loop engine, parks)
│   └── executor-delegation.test.ts  Fake-spawn integration tests over runDeterministicDelegation
├── TODOS.md                 Backlog: deferred features, skill integrations, follow-ups
├── update.sh                Pull submodule + build + deploy + feature detection
└── .gitignore               Excludes runtime/ (built artifacts)
```

### How the orchestrator works

```
/gstack or gstack_start ──┐
                          ├──→ State Machine ──→ Phase Executor ──► main phase:
input router ─────────────┘         ↑                              instructions to LLM
                                    │                                    │
                     manual gate? ──┤                       subagent phase: spawn
                       yes: pause   │                       specialists first, then
                       (/gstack next)│                      prefix their output
                                    │                                    ↓
                      gstack_advance ←──── LLM executes/reviews ←── instructions
```

1. User starts a workflow via `/gstack`, `gstack_start`, or the router suggests one
2. The orchestrator injects phase instructions into the LLM context (`followUp` delivery — never mid-turn)
3. Subagent phases are executed by the orchestrator itself: specialists run in isolated `pi` processes and their output is prefixed for review
4. The LLM calls `gstack_advance` with a summary — this is the only progression mechanism; it must never defer back to the user
5. Auto phases advance immediately; decision phases (`develop.plan`, `investigate.root-cause`) park in `awaiting_approval` until you run `/gstack next`
6. Sprint parks (security freeze, unreadable verdict, loop exhaustion, numbering anomaly, branch violation, kill-switch pauses, failed phases) are tool-enforced: a repeat `gstack_advance` is refused and only the `/gstack` panel moves the state machine
7. Repeat until all phases complete

State persists across session reloads via pi's `appendEntry` (not sent to LLM context).

### Token overhead

| | Per-session fixed | Per-phase |
|---|---|---|
| Browser tools | ~180 tokens (tool descriptions) | 0 |
| Orchestrator | ~150 tokens (advance/start) | ~600-1000 (instructions) |
| Skill methodology | 0 (on disk) | full SKILL.md on first delivery (main phases); DoD gate only for subagent-phase verification and repeats |

## Branches & feature flags

- `main` — pre-upgrade behavior (advisory subagent hints, no skill injection). Switch with `git checkout main` in the extension folder, then restart pi.
- `feat/skill-ingestion` — everything documented here.
- Runtime kill switches (env): `GSTACK_PI_SKILLS=off`, `GSTACK_PI_DETERMINISTIC=off`, `GSTACK_PI_MANUAL_GATES=off`.

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
| "gstack browse binary not found" | Run `update.sh` or set `GSTACK_BINARY` |
| "server-node.mjs not found" (Windows) | Run `bash browse/scripts/build-node-server.sh` in the gstack repo |
| `/gstack` not showing in pi | Ensure the extension is in `~/.pi/agent/extensions/gstack-pi/` with `index.ts` at root |
| Subagent phases fail | Ensure `~/.pi/agent/agents/` has scout.md, planner.md, worker.md, reviewer.md — plus the sprint specialists (sprint-planner, software-architect, backend-developer, frontend-developer, qa-engineer, devsecops-reviewer) for the sprint workflow. Canonical copies live in this repo's [`agents/`](agents/) and are synced by `update.sh` (existing files backed up, never deleted). If you hand-tuned them, re-apply your changes after a sync or restore from the `.bak-<timestamp>` copy |
| Skills not loading | Pi requires `"skills": ["./skills"]` in a package.json, or project `.pi/settings.json` |

## License

MIT

---

## Injection & efficiency

The orchestrator controls WHAT is injected into subagent prompts and HOW chains are orchestrated. All protocols below apply in **deterministic mode** (`GSTACK_PI_DETERMINISTIC=on`, the default). With `GSTACK_PI_DETERMINISTIC=off`, tasks flow through the advisory `subagent`-tool path where `{previous}` stays literal and handoff extraction is never invoked (documented advisory divergence). The `sprint` workflow refuses to start in this mode: its review gates route exclusively on delegation-produced verdicts.

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
`GSTACK_PI_TIMEOUT_EXPLORE` (default 900s), `GSTACK_PI_TIMEOUT_WORK` (default 1500s), `GSTACK_PI_TIMEOUT_VERIFY` (default 900s); unknown ids fall back to `GSTACK_PI_SUBAGENT_TIMEOUT` (default 1200s). Values are seconds. Every registered phase id maps to exactly one class (`timeoutClassFor`), enforced by test.

### Environment variables

| variable | default | effect |
|---|---|---|
| `GSTACK_PI_SKILLS` | on | skill digest injection |
| `GSTACK_PI_DETERMINISTIC` | on | executor-spawned subagents; `off` also makes the `sprint` workflow refuse to start (its gates route on delegation verdicts) |
| `GSTACK_PI_MANUAL_GATES` | on | approval pause after decision phases |
| `GSTACK_PI_OPTIONAL_PHASES` | ask | `ask` \| `auto` \| `skip` handling of optional phases |
| `GSTACK_PI_AUTO_GATE_VALIDATED` | off | auto-advance past root-cause gate when validation starts with `VALIDATED:` |
| `GSTACK_PI_SPRINT` | on | registers the sprint workflow; `off` hides it from menu and router entirely |
| `GSTACK_PI_LOOPBACKS` | on | sprint loop-back engine; `off` ⇒ negative gate verdicts park in a `/gstack` panel (Accept / Re-run / Abort) instead of retrying |
| `GSTACK_PI_VERDICTS` | on | deterministic verdict parsing; `off` ⇒ no auto-routing; gates park in a `/gstack` panel (Accept / Re-run / Abort) |
| `GSTACK_PI_DELEGATION_BUDGET_SEC` | 2700 | wall-clock budget for one phase's whole delegation chain; `off` disables |
| `GSTACK_PI_SPRINT_MAX_ATTEMPTS` | 4 | consecutive implement-rerun ceiling per review gate (counter resets on gate approval or on "Accept result — continue past the gate") |
| `GSTACK_PI_ARCH_MAX_ATTEMPTS` | 5 | system-design rerun ceiling after architect rejections (reads `GSTACK_PI_SPRINT_ARCH_MAX_ATTEMPTS` / `GSTACK_PI_ARCH_MAX_ATTEMPTS`) |
| `GSTACK_PI_MODEL_FAST` / `_STRONG` | unset | model tiers for mechanical vs judgment-heavy phases; unset keeps each agent's own default (inert) |
| `GSTACK_PI_STRICT_CONTENT` | off | heuristic scan + ASCII-sentinel enveloping of page-content tool output (WP2 defense-in-depth) |
| `GSTACK_PI_SUBAGENT_TIMEOUT` | 1200 | fallback timeout, seconds |
| `GSTACK_PI_TIMEOUT_EXPLORE` / `_WORK` / `_VERIFY` | 900 / 1500 / 900 | per-class timeouts, seconds |
| `GSTACK_PI_LIVENESS_SEC` | 240 | observe-only silence threshold, seconds; `off` disables |
| `GSTACK_PI_MAX_RUN_TOKENS` | disabled | orderly chain stop after cumulative token usage exceeds it |

Run reports land in `.gstack/runs/<ISO-timestamp>-<workflowId>.json` (per-step durations, tool calls, turns, token usage, handoff levels, incompleteness, timeout class, liveness observations).

## Security & trust boundaries

Everything INJECTED into prompts (user goals, skill digests, subagent output, HANDOFF payloads) is **untrusted input**: it comes from the user or from analyzed repository content, which can plant marker strings verbatim (a repo documenting its own processes can contain the literal `CONFIRMED ROOT CAUSE:` line).

Therefore:

- The root-cause collapse triggers ONLY if (a) the marker appears inside the structured `## HANDOFF` section, (b) every cited file exists on disk relative to cwd, and (c) the validate step always executes and cannot be compressed. A marker planted in repo content outside those guards produces no collapse.
- VERIFIED FACTS are context, not proof: agent directives (see `AGENTS_NOTES.md`) instruct specialists to re-check claims that are load-bearing for code changes they are about to make.
- `$`-safe interpolation everywhere (`replaceExact`, orchestrator/text.ts): untrusted text containing `$&`, `` $` ``, `$'` or `$1` can never alter task structure.
- Liveness observation never terminates processes; kills remain a manual, data-driven decision.

## Troubleshooting

**Phase advanced but nothing happens / pi exited unexpectedly.**

The deterministic delegation runs as a fire-and-forget background chain. Diagnose in this order:

1. **Session breadcrumbs** — every delegation milestone is persisted as a `gstack-delegation-event` session entry (`started`, `retrying`, `completed`, `failed`, `timeout`, `budget-exceeded`, `interrupted`). A `started` with no terminal event followed by an `interrupted` annotation means the host died mid-delegation (crash or restart).
2. **Debug log** — set `GSTACK_PI_DEBUG=<file>` before launching pi; every spawn attempt, pid, timeout, abort and provider error is appended there.
3. **Run reports** — `.gstack/runs/<ISO>-<workflow>.json` carries per-step durations, tool calls, token usage, handoff levels and liveness observations.

**Subagent fails fast with a provider error.** Errors like `Provider finish_reason: network_error` surface in the delegation summary and the failure event. pi auto-retries internally (3 attempts); the orchestrator adds one chain-level retry. If the provider outage persists, switch models (`--model`) and re-run. This is a provider problem, not an orchestrator bug.

**Type safety.** `bun run typecheck` (tsc --noEmit) gates the exact crash class from 2026-08-23 (a function used but never imported — a runtime `ReferenceError` thrown from a timer callback that killed pi; bundlers don't type-check). It also runs as part of `bun test`.

**Real-spawn end-to-end test.** `GSTACK_PI_E2E_SPAWN=1 bun test test/orchestrator.test.ts` spawns a real `pi -p` child through the production `runSubagent` path (opt-in because it needs a healthy provider and takes ~30-60s).
