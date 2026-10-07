# S1-T3+T4 — Validazione e batch review → D10 RISOLTO

Rubrica: (a) utile (b) non sovrapposta (c) efficace/non datata
(d) contratto coerente coi consumer (e) references risolvibili in-dir
(f) zero dipendenze upstream.

## Decisioni D10 — approvate dall'utente

1. **Preamble**: strip integrale del boilerplate upstream (~775 righe/skill:
   adapter note, env-probes, plan-mode, AUQ format, artifacts-sync gbrain,
   voice/writing-style, behavioral patch, telemetry UX flag). Restano:
   metodologia, DoD gate, provenance, frontmatter normalizzato.
2. **gbrain**: strip dai corpi. `gstack-brain-cache` NON assorbito; `.gbrain-source`
   pins e brain-sync calls rimossi. gbrain = integrazione futura non bloccante.
3. **Runtime dir**: gli script assorbiti vanno in `runtime/bin/` (convenzione
   esistente), non `runtime/scripts/`.
4. **Telemetry**: `gstack-telemetry-log` assorbito (D4 locale); nei corpi restano
   solo i marker `skill_run` start/end — via eureka/`*-prompted`/warned flags.
5. **Identità beta cancellate**: nessun `beta-*` nel catalogo — i corpi beta sono
   solo base di merge. Id canonici = quelli consumer-facing (gstack-* fino a S2).
6. **Merge policy**: per ogni cluster si prende il meglio di ogni sorgente.
   ⏸ T5 bloccata in attesa della ricerca utente sulle best practice di merge.
7. **skillify**: salvato in `~/.agents/skills/gstack-skillify` (stack generico),
   escluso dall'estensione.
8. **Memory skills**: `context-save`, `context-restore`, `learn` → ESCLUSE tutte e
   tre, rinviate allo sprint "memoria persistente" (S5b).
   ↳ *sub-question aperta*: le chiamate memory inline (`learnings-search`,
   `decision-log`…) nei corpi delle altre skill — strip coerente col rinvio
   (proposta) o keep con script assorbiti (D5 originale)?

## Fusioni per overlap (best-of-merge)

| Canonica | Sorgenti | Base merge | Asset da migrare |
|---|---|---|---|
| `gstack-investigate` | investigate + systematic-debugging | beta-debugging | systematic-debugging: 8 file → `references/` |
| `gstack-qa` | qa + qa-only + qa-git | beta-qa | `qa/references/*`, `qa/templates/*` |
| `gstack-review` | review + code-audit-reviewer | beta-code-review | `review/*` (10: checklist, greptile, 7 specialists, TODOS-format) |
| `gstack-ship` | ship | beta-ship | `ship/sections/*` (8) + TODOS-format |
| `gstack-cso` | cso + appsec-hardening | beta-security | `cso/sections/audit-phases.md` |
| `gstack-document` | document-generate + document-release | entrambe | template sezioni + `release-body.md` |
| `impeccable` | port locale + kedra design-review | impeccable | fold checklist design-review dentro |

## Catalogo finale — 28 skill

### Workflow core (7)
`gstack-investigate` · `gstack-qa` · `gstack-review` · `gstack-ship` ·
`gstack-cso` · `grilling` · `gstack-fix-strategy` (vendored, DoD gate già ok)

### Plan (5)
`gstack-office-hours` · `gstack-plan-eng-review` · `gstack-plan-design-review` ·
`gstack-spec` · `plan-draft` (NEW, estratta da office-hours per develop.plan.s2)

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

### Port locali (4)
`impeccable` · `design-taste-frontend` · `mindrun` · `retro`

## Drop definitivi (19)

| Skill | Motivo |
|---|---|
| systematic-debugging, qa-only, qa-git, code-audit-reviewer, appsec-hardening, document-release, design-review (kedra) | fuse nelle canoniche |
| gstack-plan-ceo-review, gstack-plan-devex-review | drop utente — lenti review non usate |
| gstack-autoplan | drop utente — meta-pipeline muore, S4 ridisegna come step |
| strategic-compact | ridondante col machinery `## HANDOFF` orchestratore |
| gstack-retro | non wired, dipende da `gstack-global-discover` mancante |
| code-tour | formato `.tour` VSCode, marginale |
| add-model, manim-video | fuori scope workflow |
| gstack-skillify | salvata nello stack generico, fuori dall'estensione |
| gstack (router) | routing = orchestratore |
| gstack-context-save, gstack-context-restore, gstack-learn | memory skills — rinviate a sprint memoria persistente |

## Prossimo passo

T5 in attesa della ricerca merge best-practice → poi costruzione catalogo
`skills/<id>/` con strip + merge + DoD gate + provenance + path rewrite.
