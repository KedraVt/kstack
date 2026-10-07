# S1-T1 — Audit dipendenze per-skill

Data: 2026-10-07. Metodo: estrazione meccanica dei riferimenti su tutte le
SKILL.md dei tre layer + verifica esistenza on-disk dei target.
Baseline test: `bun run test` 309/309 verde (pre-freeze).

## Inventario

| Layer | Dir | Corpi unici | Note |
|---|---|---|---|
| `skills/gstack/` | 23 | 23 | upstream portati, preambolo pesante comune |
| `skills/kedra/` | 18 | 18 | raw `.agents-clean`, zero dipendenze runtime |
| `skills/sprint-beta/` | 37 | 7 | 16 copie identiche gstack + 14 copie identiche kedra + 5 `beta-*` fusioni + `grilling` + `gstack-fix-strategy` vendored |

Copie verificate via `diff`: tutte le 16 `gstack-*` in sprint-beta identiche a
`skills/gstack/`; tutte le 14 kedra-copie identiche a `skills/kedra/`.
Corpi unici effettivi da valutare: **48**.

## Dipendenze per categoria

### Script `runtime/bin/` (già assorbiti — 21 file)

Referenziati dalle skill upstream (preambolo condiviso): `gstack-config`,
`gstack-slug`, `gstack-session-kind`, `gstack-repo-mode`, `gstack-team-init`,
`gstack-timeline-log`, `gstack-brain-sync`, `gstack-learnings-search`,
`gstack-question-preference`, `gstack-first-task-detect`, `gstack-update-check`,
`gstack-paths`, `gstack-review-log`, `gstack-review-read`, `gstack-diff-scope`,
`gstack-next-version`, `gstack-version-bump`, `gstack-pr-title-rewrite.sh`,
`gstack-codex-probe`, `gstack-specialist-stats`, `gstack-developer-profile`.

**Call-site morto**: `runtime/bin/gstack-global-discover` — referenziato 8×
(solo `gstack-retro`) ma assente su disco. Il comando esiste in
`source/bin/gstack-global-discover`? → verificare; se sì va nella lista
assorbimento, altrimenti la chiamata è da rimuovere dalla skill.

### Script `source/bin/` (da assorbire — nel submodule, sparisce a fine S1)

| Script | Refs | Tipo | Dipendenze `source/lib/` |
|---|---|---|---|
| `gstack-telemetry-log` | 206 | bash | chiama `bin/gstack-config`; `GSTACK_DIR` auto-derivato dalla propria posizione |
| `gstack-decision-search` | 80 | bun | `bin-context`, `gstack-decision`, `gstack-decision-semantic` (→ `gbrain-exec`, `gbrain-sources`) |
| `gstack-learnings-log` | 60 | bash + `bun -e` | `jsonl-store.ts`, `redact-engine.ts` (→ `redact-patterns`) |
| `gstack-decision-log` | 43 | bun | `bin-context`, `gstack-decision` (→ `jsonl-store`, `redact-engine`) |
| `gstack-question-log` | 40 | bash + `bun -e` | `jsonl-store.ts`, `redact-engine.ts` |
| `gstack-brain-cache` | 36 | bun (965 ln) | `gbrain-exec`, `scripts/brain-cache-spec.ts`, `gstack-schema-pack` — integrazione gbrain, **candidato drop** (opt-in, degrada) |
| `gstack-redact` | 10 | bun | `redact-engine`, `redact-audit-log` |

Chiusura transitiva `source/lib/` da assorbire se le skill mantengono le
chiamate: `bin-context.ts`, `gstack-decision.ts`, `gstack-decision-semantic.ts`,
`gbrain-exec.ts`, `gbrain-sources.ts`, `jsonl-store.ts`, `redact-engine.ts`,
`redact-patterns.ts`, `redact-audit-log.ts` + `scripts/brain-cache-spec.ts`,
`scripts/gstack-schema-pack.ts` (se brain-cache resta).

### Asset `source/` condivisi

| Asset | Refs | Destinazione proposta |
|---|---|---|
| `source/ETHOS.md` | 26 | `runtime/ETHOS.md` |
| `source/scripts/jargon-list.json` | 40 | `runtime/jargon-list.json` |
| `source/VERSION` + `source/.git` | 41 | update-check legge VERSION → puntare a `package.json` version |
| `source/browse/bin/remote-slug` | 14 | `runtime/bin/` (helper repo-slug per review/plan) |
| `source/office-hours/SKILL.md` | 10 | cross-ref → skill catalogo `gstack-office-hours` |
| `source/lib/redact-audit-log.ts` | 2 | `runtime/lib/` (con redact) |
| `source/browse/src/browser-skill-write.ts` | 2 | referenziato da gstack-skillify — valutare se serve o è doc |

### Asset `source/` per-skill (→ `skills/<id>/references/`)

| Skill | Asset referenziati |
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

### Home dati `~/.gstack/` (usata, non assorbita — diventa `~/.kstack` in S2)

`sessions/`, `analytics/{skill-usage,eureka,spec-review}.jsonl`,
`analytics/.pending-*`, `projects/<slug>/` (decisions/learnings jsonl),
`retros/`, `developer-profile.json`, `greptile-history.md`,
`retro-context.md`, `browser-skills/`, `.git` + flag file
(`.activated`, `.telemetry-prompted`, `.proactive-prompted`,
`.vendoring-warned-*`, `.first-loop-tip-shown`, `.completeness-intro-seen`,
`.writing-style-prompted(-pending)`, `.plan-tune-nudge-shown`).

## Uso funzionale vs boilerplate (verdetto D5)

Il preambolo condiviso (~30-120 righe) delle 16 skill upstream `gstack-*`:
env-probe (`gstack-config`, `repo-mode`, `session-kind`, `team-init`,
`first-task-detect`, `update-check`), session tracking (`~/.gstack/sessions`),
marker telemetria start/finalize, **recall proattivo `learnings-search
--limit 3`**, `question-preference`, flag-file UX.

Nel corpo (non boilerplate): `decision-search`/`decision-log` per decisioni
cross-session, `question-log` per cattura risposte, `learnings-log` per
scrittura insight a fine run, `learnings-search --query` mirato.

**Verdetto fattuale**: il memory layer (decision-* + learnings-*) è usato
funzionalmente da tutte e 16 le skill upstream-derived — recall a inizio,
scrittura a fine, decisioni a metà flusso. Le skill beta/kedra/vendored non
lo usano affatto. → Se nel catalogo restano skill upstream-derived con il
loro corpo, gli script memory vanno assorbiti (D5: "così come sono").
Domanda aperta per T4: stripping del preambolo telemetria/UX-flag
(`eureka.jsonl`, `.*-prompted`, `.plan-tune-nudge-shown` — UX instrumentation
upstream, non memory) vs conservazione integrale.

## Inventario extra-file nei dir skill

- `kedra/systematic-debugging`: 8 file extra (references candidate:
  condition-based-waiting*, defense-in-depth, root-cause-tracing,
  find-polluter.sh, test-academic/pressure-*.md, CREATION-LOG.md)
- `*/add-model`: `references/schema.md`, `upsert.mjs`
- `*/manim-video`: `assets/network_graph_scene.py`
- `*/test-driven-development`: `testing-anti-patterns.md`

## Note freeze

`update.sh` faceva anche: provisioning binario browse (coperto da
`lib/download.ts` a session_start) e sync `agents/*.md` →
`~/.pi/agent/agents/` (ora manuale — README da aggiornare nello sweep
docs di S2-T10). `package.json` già ripulito (files + script entries).
