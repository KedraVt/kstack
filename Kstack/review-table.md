# S1-T3+T4 — Validation and batch review → D10 RESOLVED

Rubric: (a) useful (b) non-overlapping (c) effective/non-dated
(d) contract consistent with consumers (e) references resolvable in-dir
(f) zero upstream dependencies.

## D10 decisions — approved by the user

1. **Preamble**: full strip of the upstream boilerplate (~775 lines/skill:
   adapter note, env-probes, plan-mode, AUQ format, artifacts-sync gbrain,
   voice/writing-style, behavioral patch, telemetry UX flag). What stays:
   methodology, DoD gate, provenance, normalized frontmatter.
2. **gbrain**: stripped from bodies. `gstack-brain-cache` NOT absorbed;
   `.gbrain-source` pins and brain-sync calls removed. gbrain = future
   non-blocking integration.
3. **Runtime dir**: absorbed scripts go in `runtime/bin/` (existing
   convention), not `runtime/scripts/`.
4. **Telemetry**: `gstack-telemetry-log` absorbed (local D4); bodies keep
   only the `skill_run` start/end markers — eureka/`*-prompted`/warned
   flags are gone.
5. **Beta identities cancelled**: no `beta-*` in the catalog — beta bodies
   are only a merge base. Canonical ids = the consumer-facing ones
   (gstack-* until S2).
6. **Merge policy**: each cluster takes the best of every source.
   ⏸ T5 blocked pending the user's research on merge best practices.
7. **skillify**: saved to `~/.agents/skills/gstack-skillify` (generic
   stack), excluded from the extension.
8. **Memory skills**: `context-save`, `context-restore`, `learn` → all
   three EXCLUDED, deferred to the "persistent memory" sprint (S5b).
   ↳ *open sub-question*: the inline memory calls (`learnings-search`,
   `decision-log`…) in the other skills' bodies — strip consistent with
   the deferral (proposal) or keep with absorbed scripts (original D5)?

## Overlap merges (best-of-merge)

| Canonical | Sources | Merge base | Assets to migrate |
|---|---|---|---|
| `gstack-investigate` | investigate + systematic-debugging | beta-debugging | systematic-debugging: 8 files → `references/` |
| `gstack-qa` | qa + qa-only + qa-git | beta-qa | `qa/references/*`, `qa/templates/*` |
| `gstack-review` | review + code-audit-reviewer | beta-code-review | `review/*` (10: checklist, greptile, 7 specialists, TODOS-format) |
| `gstack-ship` | ship | beta-ship | `ship/sections/*` (8) + TODOS-format |
| `gstack-cso` | cso + appsec-hardening | beta-security | `cso/sections/audit-phases.md` |
| `gstack-document` | document-generate + document-release | both | section templates + `release-body.md` |
| `impeccable` | local port + kedra design-review | impeccable | fold design-review checklist in |

## Final catalog — 28 skills

### Workflow core (7)
`gstack-investigate` · `gstack-qa` · `gstack-review` · `gstack-ship` ·
`gstack-cso` · `grilling` · `gstack-fix-strategy` (vendored, DoD gate already ok)

### Plan (5)
`gstack-office-hours` · `gstack-plan-eng-review` · `gstack-plan-design-review` ·
`gstack-spec` · `plan-draft` (NEW, extracted from office-hours for develop.plan.s2)

### Sprint/DDD (8)
`product-capability` · `system-design` · `adr` · `tasks` ·
`test-driven-development` · `verification-before-completion` ·
`docker-manager` · `pipeline-sre`

### Docs (1)
`gstack-document`

### Browser (1)
`gstack-scrape`

### Utility (2)
`agent-introspection-debugging` · `code-simplification`

### Local ports (4)
`impeccable` · `design-taste-frontend` · `mindrun` · `retro`

## Definitive drops (19)

| Skill | Reason |
|---|---|
| systematic-debugging, qa-only, qa-git, code-audit-reviewer, appsec-hardening, document-release, design-review (kedra) | merged into the canonicals |
| gstack-plan-ceo-review, gstack-plan-devex-review | user drop — slow unused reviews |
| gstack-autoplan | user drop — meta-pipeline dies, S4 redesigns it as steps |
| strategic-compact | redundant with the orchestrator `## HANDOFF` machinery |
| gstack-retro | not wired, depends on missing `gstack-global-discover` |
| code-tour | VSCode `.tour` format, marginal |
| add-model, manim-video | out of workflow scope |
| gstack-skillify | saved in the generic stack, out of the extension |
| gstack (router) | routing = orchestrator |
| gstack-context-save, gstack-context-restore, gstack-learn | memory skills — deferred to the persistent-memory sprint |

## Next step

T5 pending merge best-practice research → then build the `skills/<id>/`
catalog with strip + merge + DoD gate + provenance + path rewrite.

---

## Implementation state — COMPLETED (2026-02-11, kstack branch)

- **T5 catalog**: 28 canonical skills in `skills/<id>/` — 6 best-of merges
  (investigate, qa, review, ship, cso, document), 5 upstream keep-rewrites
  (office-hours, plan-eng-review, plan-design-review, spec, scrape),
  `plan-draft` new (D22), 2 vendored ports, 10 kedra ports, 4 local verbatim.
- **T6 locals**: impeccable, design-taste-frontend, mindrun, retro copied
  verbatim (diff-verified). `impeccable` still references global paths —
  intentional (verbatim mandate).
- **T7 runtime**: `gstack-telemetry-log`, `gstack-redact(+prepush)`,
  `runtime/lib/redact-{engine,patterns}.ts` absorbed; `design.exe` copied to
  `runtime/design/dist/` (untracked, provisioned — skill degrades on
  DESIGN_NOT_AVAILABLE).
- **T8 orchestrator**: `skills.ts` single-source — `skillPath` →
  `skills/<dir>/SKILL.md`, `loadSkillGate()` parses `## DoD gate` (D13),
  `dod`/`betaPath`/`distilledPath` fields removed; sprint id → canonical
  dir via `dir:`.
- **T9 deletions**: `skills/{gstack,kedra,sprint-beta}`, `skills-distilled`,
  `source/` submodule + `.gitmodules` removed. `package.json` and
  `AGENTS.md` updated.
- **T10 tests**: `beta-injection.test.ts` rewritten on the canonical
  contract; `orchestrator.test.ts` repointed; suite **309/309 green**.
- **Inline memory**: resolved — all `learnings-*`/`decision-*` calls
  stripped from canonical bodies (consistent with the S5b deferral). The
  `gstack-learnings-search` script stays in `runtime/bin` (inert until
  memory returns).
- **Commits**: `52a14a6` freeze → `3729e6e` review → `bbf115f` pilot →
  `9700d85` catalog → `55d7a79` runtime+orchestrator → `f22bd95` cleanup.
  `main` untouched at `a9af432`.
