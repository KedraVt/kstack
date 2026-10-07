# S1-T3+T4 — Validazione e batch review

Rubrica: (a) utile (b) non sovrapposta (c) efficace/non datata
(d) contratto coerente coi consumer (e) references risolvibili in-dir
(f) zero dipendenze upstream.

`KW` = keep come vincitore di cluster · `K` = keep · `RW` = keep con rewrite
(strip boilerplate + adattamento pi/kstack) · `DR` = drop · `NEW` = da creare.

## Vincitori già fusi (sprint-beta `beta-*` + vendored)

| Skill | Azione | Motivo | Consumer |
|---|---|---|---|
| beta-debugging | KW + DoD gate | fusione già fatta; contratto DEBUG REPORT ok; 1561w | investigate.* (id gstack-investigate), develop |
| beta-code-review | KW + DoD gate | 5 dim + scope drift + quote-gate; verdict parser-ok | develop.review, review.*, ship.review, sprint |
| beta-qa | KW + DoD gate | triage GREEN/RED/ORANGE dual-channel | develop.qa, qa.*, qa-report, investigate.regression, sprint.qa |
| beta-security | KW + DoD gate | STRIDE-lite + FP filter + verdict | sprint.devsecops |
| beta-ship | KW + DoD gate | save-point + pipeline rilascio | develop.ship, ship.*, sprint.ship |
| grilling | KW (già DoD gate) | interview protocol vendored | develop.plan.s1 |
| gstack-fix-strategy | KW (già DoD gate) | validate→fix plan | investigate chain (planner step) |

## Drop per sussunzione (11)

| Skill | Assorbita da | Cosa migrare |
|---|---|---|
| gstack-investigate | beta-debugging | hook memory inline (se confermati) |
| systematic-debugging | beta-debugging | 8 file → `references/` |
| gstack-qa | beta-qa | `qa/references/*`, `qa/templates/*` |
| gstack-qa-only | beta-qa | — (report-only = mode) |
| qa-git | beta-qa + beta-ship | — |
| gstack-review | beta-code-review | `review/*` (10 file: checklist, greptile, 7 specialists, TODOS-format) |
| code-audit-reviewer | beta-code-review | — |
| gstack-cso | beta-security | `cso/sections/audit-phases.md` |
| appsec-hardening | beta-security | — |
| gstack-ship | beta-ship | `ship/sections/*` (8) + TODOS-format |
| gstack | — | router obsoleto (routing = orchestratore) |

## Keep-rewrite upstream (15) — strip boilerplate condiviso (~800 righe), metodologia + memory call + `## DoD gate`

| Skill | Consumer | Note specifiche |
|---|---|---|
| gstack-office-hours | manuale (+ sorgente plan-draft, D22) | YC diagnostic + premise challenge; asset `office-hours/sections/design-and-handoff.md` |
| gstack-plan-eng-review | develop.plan.s3 (registry) | exit-plan-mode gate → adattare (no plan mode su pi) |
| gstack-plan-ceo-review | manuale / autoplan | ceo-plans su `~/.gstack/projects/` |
| gstack-plan-design-review | manuale / autoplan | dip "design binary" upstream → neutralizzare |
| gstack-plan-devex-review | manuale / autoplan | asset `dx-hall-of-fame.md` |
| gstack-autoplan | manuale | meta-pipeline; Codex dual-voice → degrade; **redesign nativo in S4** |
| gstack-spec | manuale | redaction gate → `gstack-redact` assorbito |
| gstack-design-review | manuale | visual QA via browse; overlap c/ impeccable → open Q |
| gstack-document-generate | develop.document, ship.update-docs | Diataxis |
| gstack-document-release | develop.document, ship.update-docs | asset `release-body.md` |
| gstack-context-save | manuale | memory UX; redesign S5b |
| gstack-context-restore | manuale | idem |
| gstack-learn | manuale | UI store learnings |
| gstack-scrape | manuale | usa tool browse `gstack_*` |
| gstack-skillify | manuale | asset `browser-skill-write.ts`, `~/.gstack/browser-skills/` |

## Drop candidati / deboli

| Skill | Proposta | Motivo |
|---|---|---|
| gstack-retro | **DR** | non wired in nessun workflow; dipende da `gstack-global-discover` mancante; D9 la marca già "non usata" |
| code-tour | K-manuale (o DR) | formato `.tour` VSCode-specifico; basso valore workflow — a te la scelta |

## Keep kedra/vendored/utilities (18) — solo `## DoD gate` + eventuali reference colocati

`product-capability`, `system-design`, `adr`, `tasks`,
`test-driven-development` (+anti-patterns ref), `verification-before-completion`,
`docker-manager`, `pipeline-sre`, `strategic-compact`,
`agent-introspection-debugging`, `code-simplification`, `add-model`
(+schema ref + upsert.mjs), `manim-video` (+asset py).

## Porting locali T6 (4) + nuova (1)

| Skill | Azione | Note |
|---|---|---|
| impeccable | PORT | 35 ref + 40 script; riscrivere path `.pi/skills/impeccable/` → dir catalogo |
| design-taste-frontend | PORT | overlap parziale c/ impeccable → open Q (tenere entrambe?) |
| mindrun | PORT | candidato step pre-implement S4 |
| retro (locale) | PORT | session retro ≠ gstack-retro |
| **plan-draft** | **NEW** | estratta da office-hours (D22) per develop.plan.s2 |

## Totale catalogo proposto

5 beta + 2 vendored + 15 keep-rewrite + 13 kedra-keep + 4 port + 1 new ≈ **40 dir**
(conta precisa dipende da code-tour/retro/design-taste).

## Decisioni aperte (serve tua scelta prima di T5)

1. **Preamble policy**: strip integrale del boilerplate upstream (plan-mode,
   AUQ format, artifacts-sync gbrain, voice/writing-style, telemetry UX flag)
   mantenendo solo metodologia + chiamate memory/decision funzionali?
   *(propongo: sì — ~800 righe morte per skill)*
2. **Memory calls**: le 15 keep-rewrite conservano `decision-*`/`learnings-*`
   inline (implica assorbire gli script in runtime)? *(propongo: sì, D5)*
3. **gbrain machinery**: `gstack-brain-cache` (965 ln, opt-in esterno) e
   `gstack-brain-sync` nei corpi: strip o assorbire? *(propongo: strip —
   gbrain resta integrazione futura, non bloccante)*
4. **Telemetry**: assorbire `gstack-telemetry-log` (D4) mantenendo solo i
   marker `skill_run` start/end e droppando la UX-instrumentation
   (eureka, *-prompted, vendoring-warned)? *(propongo: sì)*
5. **Runtime dir**: assorbire in `runtime/bin/` (convenzione esistente) o
   creare `runtime/scripts/` come scritto nel piano? *(propongo: `runtime/bin/`)*
6. **code-tour** e **gstack-retro**: conferma drop/keep come da tabella.
7. **impeccable vs design-taste-frontend vs gstack-design-review**: tenere
   tutte e tre (scope diversi) o fondere?
