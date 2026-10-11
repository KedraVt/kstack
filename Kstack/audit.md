# S1-T1 — Per-skill dependency audit

Date: 2026-10-07. Method: mechanical extraction of references across all
SKILL.md files in the three layers + on-disk existence check of targets.
Test baseline: `bun run test` 309/309 green (pre-freeze).

## Inventory

| Layer | Dirs | Unique bodies | Notes |
|---|---|---|---|
| `skills/gstack/` | 23 | 23 | upstream ports, common heavy preamble |
| `skills/kedra/` | 18 | 18 | raw `.agents-clean`, zero runtime dependencies |
| `skills/sprint-beta/` | 37 | 7 | 16 identical gstack copies + 14 identical kedra copies + 5 `beta-*` merges + `grilling` + `gstack-fix-strategy` vendored |

Copies verified via `diff`: all 16 `gstack-*` in sprint-beta identical to
`skills/gstack/`; all 14 kedra copies identical to `skills/kedra/`.
Actual unique bodies to evaluate: **48**.

## Dependencies by category

### `runtime/bin/` scripts (already absorbed — 21 files)

Referenced by upstream skills (shared preamble): `gstack-config`,
`gstack-slug`, `gstack-session-kind`, `gstack-repo-mode`, `gstack-team-init`,
`gstack-timeline-log`, `gstack-brain-sync`, `gstack-learnings-search`,
`gstack-question-preference`, `gstack-first-task-detect`, `gstack-update-check`,
`gstack-paths`, `gstack-review-log`, `gstack-review-read`, `gstack-diff-scope`,
`gstack-next-version`, `gstack-version-bump`, `gstack-pr-title-rewrite.sh`,
`gstack-codex-probe`, `gstack-specialist-stats`, `gstack-developer-profile`.

**Dead call site**: `runtime/bin/gstack-global-discover` — referenced 8×
(only `gstack-retro`) but absent on disk. Does the command exist in
`source/bin/gstack-global-discover`? → check; if yes it goes on the
absorption list, otherwise the call must be removed from the skill.

### `source/bin/` scripts (to absorb — in the submodule, gone at end of S1)

| Script | Refs | Type | `source/lib/` dependencies |
|---|---|---|---|
| `gstack-telemetry-log` | 206 | bash | calls `bin/gstack-config`; `GSTACK_DIR` self-derived from its own location |
| `gstack-decision-search` | 80 | bun | `bin-context`, `gstack-decision`, `gstack-decision-semantic` (→ `gbrain-exec`, `gbrain-sources`) |
| `gstack-learnings-log` | 60 | bash + `bun -e` | `jsonl-store.ts`, `redact-engine.ts` (→ `redact-patterns`) |
| `gstack-decision-log` | 43 | bun | `bin-context`, `gstack-decision` (→ `jsonl-store`, `redact-engine`) |
| `gstack-question-log` | 40 | bash + `bun -e` | `jsonl-store.ts`, `redact-engine.ts` |
| `gstack-brain-cache` | 36 | bun (965 ln) | `gbrain-exec`, `scripts/brain-cache-spec.ts`, `gstack-schema-pack` — gbrain integration, **drop candidate** (opt-in, degrades) |
| `gstack-redact` | 10 | bun | `redact-engine`, `redact-audit-log` |

Transitive `source/lib/` closure to absorb if the skills keep the calls:
`bin-context.ts`, `gstack-decision.ts`, `gstack-decision-semantic.ts`,
`gbrain-exec.ts`, `gbrain-sources.ts`, `jsonl-store.ts`, `redact-engine.ts`,
`redact-patterns.ts`, `redact-audit-log.ts` + `scripts/brain-cache-spec.ts`,
`scripts/gstack-schema-pack.ts` (if brain-cache stays).

### Shared `source/` assets

| Asset | Refs | Proposed destination |
|---|---|---|
| `source/ETHOS.md` | 26 | `runtime/ETHOS.md` |
| `source/scripts/jargon-list.json` | 40 | `runtime/jargon-list.json` |
| `source/VERSION` + `source/.git` | 41 | update-check reads VERSION → point at `package.json` version |
| `source/browse/bin/remote-slug` | 14 | `runtime/bin/` (repo-slug helper for review/plan) |
| `source/office-hours/SKILL.md` | 10 | cross-ref → catalog skill `gstack-office-hours` |
| `source/lib/redact-audit-log.ts` | 2 | `runtime/lib/` (with redact) |
| `source/browse/src/browser-skill-write.ts` | 2 | referenced by gstack-skillify — evaluate whether needed or doc-only |

### Per-skill `source/` assets (→ `skills/<id>/references/`)

| Skill | Referenced assets |
|---|---|
| gstack-cso | `cso/sections/audit-phases.md` |
| gstack-document-release | `document-release/sections/release-body.md` |
| gstack-office-hours | `office-hours/sections/design-and-handoff.md` |
| gstack-plan-ceo-review | `plan-ceo-review/sections/review-sections.md` |
| gstack-plan-design-review | `plan-design-review/sections/review-sections.md` |
| gstack-plan-devex-review | `plan-devex-review/sections/review-sections.md`, `plan-devex-review/dx-hall-of-fame.md` |
| gstack-plan-eng-review | `plan-eng-review/sections/review-sections.md` |
| gstack-qa, gstack-qa-only | `qa/references/issue-taxonomy.md`, `qa/templates/qa-report-template.md` |
| gstack-review | `review/checklist.md`, `design-checklist.md`, `greptile-triage.md`, `specialists/{api-contract,data-migration,maintainability,performance,red-team,security,testing}.md`, `TODOS-format.md` |
| gstack-ship | `ship/sections/{adversarial,changelog,greptile,plan-completion,pr-body,review-army,test-coverage,tests}.md`, `review/TODOS-format.md` |

### `~/.gstack/` data home (used, not absorbed — becomes `~/.kstack` in S2)

`sessions/`, `analytics/{skill-usage,eureka,spec-review}.jsonl`,
`analytics/.pending-*`, `projects/<slug>/` (decisions/learnings jsonl),
`retros/`, `developer-profile.json`, `greptile-history.md`,
`retro-context.md`, `browser-skills/`, `.git` + flag files
(`.activated`, `.telemetry-prompted`, `.proactive-prompted`,
`.vendoring-warned-*`, `.first-loop-tip-shown`, `.completeness-intro-seen`,
`.writing-style-prompted(-pending)`, `.plan-tune-nudge-shown`).

## Functional use vs boilerplate (D5 verdict)

The shared preamble (~30-120 lines) of the 16 upstream `gstack-*` skills:
env-probes (`gstack-config`, `repo-mode`, `session-kind`, `team-init`,
`first-task-detect`, `update-check`), session tracking (`~/.gstack/sessions`),
start/finalize telemetry markers, **proactive recall `learnings-search
--limit 3`**, `question-preference`, UX flag files.

In the body (non-boilerplate): `decision-search`/`decision-log` for
cross-session decisions, `question-log` for answer capture, `learnings-log`
for end-of-run insight writes, targeted `learnings-search --query`.

**Factual verdict**: the memory layer (decision-* + learnings-*) is
functionally used by all 16 upstream-derived skills — recall at the start,
writes at the end, decisions mid-flow. The beta/kedra/vendored skills
don't use it at all. → If upstream-derived skills stay in the catalog with
their bodies, the memory scripts must be absorbed (D5: "as they are").
Open question for T4: stripping the telemetry/UX-flag preamble
(`eureka.jsonl`, `.*-prompted`, `.plan-tune-nudge-shown` — upstream UX
instrumentation, not memory) vs full preservation.

## Extra-file inventory in skill dirs

- `kedra/systematic-debugging`: 8 extra files (candidate references:
  condition-based-waiting*, defense-in-depth, root-cause-tracing,
  find-polluter.sh, test-academic/pressure-*.md, CREATION-LOG.md)
- `*/add-model`: `references/schema.md`, `upsert.mjs`
- `*/manim-video`: `assets/network_graph_scene.py`
- `*/test-driven-development`: `testing-anti-patterns.md`

## Freeze notes

`update.sh` also did: browse binary provisioning (covered by
`lib/download.ts` at session_start) and `agents/*.md` sync →
`~/.pi/agent/agents/` (now manual — README to update in the S2-T10
docs sweep). `package.json` already cleaned (files + script entries).
