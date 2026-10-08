# S2 — rename surface inventory (T1, regenerated from code)

Baseline: worktree `C:/Users/Mattia/dev/gstack-pi-kstack` on branch `kstack`
(933d3fd). Post-S1 shape verified — `source/`, `skills-distilled/`,
`scripts/`, `update.sh`, `.gitmodules` all absent. `bun test` 309/309 green,
`bunx tsc --noEmit` clean. 308 tracked files.

## Per-area `rg -il gstack` counts (tracked files)

| Area | Files |
|---|---|
| `.gitignore` | 1 |
| `AGENTS.md` / `AGENTS_NOTES.md` | 1 + (notes below) |
| `Kstack.md` + `Kstack/*.md` | 6 (exempt narrative — tick/ADR edits only) |
| `README.md`, `TODOS.md` | 2 |
| `agents/*.md` | 10 |
| `index.ts` | 1 |
| `lib/*.ts` + `lib/*.cjs` | 7 |
| `orchestrator/*.ts` | 14 |
| `package.json` + `package-lock.json` | 2 |
| `runtime/bin/*`, `runtime/lib/*` | 26 |
| `skills/*/SKILL.md` + `references/` | 38 |
| `test/*.ts` | 6 |
| `tools.generated.ts` | 1 |

## `GSTACK_[A-Z_0-9]+` — full name list (56)

GSTACK_BINARY, GSTACK_CODEX_, GSTACK_COMMANDS, GSTACK_DIR, GSTACK_HEADLESS,
GSTACK_HOME, GSTACK_MISSING, GSTACK_OK, GSTACK_PI_, GSTACK_PI_ARCH_MAX_ATTEMPTS,
GSTACK_PI_AUTO_GATE_VALIDATED, GSTACK_PI_DEBUG, GSTACK_PI_DELEGATION_BUDGET_SEC,
GSTACK_PI_DETERMINISTIC, GSTACK_PI_E2E_SPAWN, GSTACK_PI_LEARNINGS,
GSTACK_PI_LIVENESS_SEC, GSTACK_PI_LOOPBACKS, GSTACK_PI_MANUAL_GATES,
GSTACK_PI_MAX_PARALLEL, GSTACK_PI_MAX_RUN_TOKENS, GSTACK_PI_MODEL_FAST,
GSTACK_PI_MODEL_STRONG, GSTACK_PI_OPTIONAL_PHASES, GSTACK_PI_SKILLS,
GSTACK_PI_SKILL_INJECTION (DELETED not renamed — D-scope-2), GSTACK_PI_SPRINT,
GSTACK_PI_SPRINT_ARCH_MAX_ATTEMPTS, GSTACK_PI_SPRINT_ARTIFACTS_DIR,
GSTACK_PI_SPRINT_MAX_ATTEMPTS, GSTACK_PI_STRICT_CONTENT, GSTACK_PI_SUBAGENT_TIMEOUT,
GSTACK_PI_TEST_NUMBER, GSTACK_PI_TIMEOUT_EXPLORE, GSTACK_PI_TIMEOUT_VERIFY,
GSTACK_PI_TIMEOUT_WORK, GSTACK_PI_VERDICTS, GSTACK_PLAN_DIR,
GSTACK_PLAN_TUNE_HOOKS, GSTACK_REDACT_PREPUSH, GSTACK_REDACT_PREPUSH_REASON,
GSTACK_RELINK, GSTACK_REMOTE_REPO, GSTACK_REMOTE_URL, GSTACK_REPO, GSTACK_ROOT,
GSTACK_SEARCH_CROSS, GSTACK_SEARCH_LIMIT, GSTACK_SEARCH_QUERY,
GSTACK_SEARCH_TYPE, GSTACK_SETTINGS_PATH, GSTACK_SETUP_RUNNING,
GSTACK_STATE_DIR, GSTACK_STATE_ROOT, GSTACK_SUPABASE_ANON_KEY,
GSTACK_SUPABASE_URL, GSTACK_TELEMETRY_SOURCE, GSTACK_VERSION

## `runtime/bin` inventory (24 tracked — gitignored but force-added)

All 21 upstream `BIN_SCRIPTS` (from `git show main:update.sh`) present, plus 3
absorbed SOURCE_BIN_SCRIPTS: `gstack-redact`, `gstack-redact-prepush`,
`gstack-telemetry-log`. The other 4 source scripts (`gstack-brain-cache`,
`gstack-decision-log`, `gstack-decision-search`, `gstack-learnings-log`,
`gstack-question-log`) were never absorbed into this repo — not in scope.

Scripts: brain-sync, codex-probe, config, developer-profile, diff-scope,
first-task-detect, learnings-search, next-version, paths, pr-title-rewrite.sh,
question-preference, redact, redact-prepush, repo-mode, review-log,
review-read, session-kind, slug, specialist-stats, team-init, telemetry-log,
timeline-log, update-check, version-bump.

## Notable single points

- `tools.generated.ts`: ~65 `gstack_*` tool names + `gstackCmd` field
  (consumed in-file and asserted in `test/security-boundary.test.ts`).
- `orchestrator/index.ts`: `gstack_advance`/`gstack_phase`/`gstack_start`
  registrations + `registerCommand("gstack")` + `handleGstackCommand`.
- `orchestrator/state.ts`: `ENTRY_TYPE = "gstack-wf-state"`, `version: 2`.
- `orchestrator/executor.ts`: `gstack-delegation-event` customType (×2).
- `orchestrator/templates.ts`: `PLAN_DIR = ".gstack/plans"`, validation regex,
  SKILL_VARIANTS keys, many model-facing `gstack_*` strings.
- `orchestrator/{sprint,telemetry}.ts`: `.gstack/sprints`, `.gstack/runs`.
- `lib/browse.ts`: `GSTACK_BINARY`/`GSTACK_ROOT` envs + `../gstack` sibling
  guess — **no `~/dev/gstack` or extensions-sibling `gstack/` checkout exists
  on this machine** → rename to `../kstack` (exemption d not applicable).
- `lib/commands.generated.ts`: `GSTACK_COMMANDS` export.
- `lib/download.ts`: `RELEASE_BASE` → `KedraVt/gstack-pi` — KEEP (exemption a).
- `lib/silent-spawn-preload.cjs`: `__gstackSilentSpawnPatched` marker.
- `skills/gstack-document/`: shared dir for registry ids
  `gstack-document-release` + `gstack-document-generate` (D-scope-5).
- `runtime/bin/gstack-telemetry-log`: local JSONL only — NO live Supabase POST
  (`GSTACK_TELEMETRY_SOURCE` read only; sync script absent from tree). D4
  residual: nothing to disable. Supabase reads live in `gstack-update-check`
  (version-check GET) — env names rename only.
- `.gitignore`: `.gstack/` ignore entry → `.kstack/`.
- `test/beta-injection.test.ts`: deleted wholesale at T2 (D-scope-2) —
  `package.json` `scripts.test` list updated in the same commit.

## Skill catalog (28 dirs → `kstack-<id>`)

Prefixed (12): cso, document, fix-strategy, investigate, office-hours,
plan-design-review, plan-eng-review, qa, review, scrape, ship, spec.
Unprefixed (16): adr, agent-introspection-debugging, code-simplification,
design-taste-frontend, docker-manager, grilling, impeccable, mindrun,
pipeline-sre, plan-draft, product-capability, retro, system-design, tasks,
test-driven-development, verification-before-completion.

Registry-only ids (10, `dir:` mapped): `gstack-document-release` /
`gstack-document-generate` → `kstack-document`; `gstack-sprint-{capability,
system-design, adr, tasks, tdd, verification, appsec, docker, qa, pipeline}`
→ dirs `kstack-{product-capability, system-design, adr, tasks,
test-driven-development, verification-before-completion, cso, docker-manager,
qa, pipeline-sre}`.

Rename traps found: `system-design` is BOTH a sprint phase id (config.ts
TIMEOUT_CLASS_MAP, state.ts ceilingFor, workflows.ts id/loopBackTo — KEEP)
and a skill dir (RENAME); `tasks` collides with `tasks_{sprint}.md` artifact
names (KEEP those); bare `grilling`/`tasks` appear in prose (KEEP prose).
