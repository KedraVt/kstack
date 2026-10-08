# Kstack — Piano di trasformazione

Piano master: indipendenza da gstack, catalogo skill unico e validato,
workflow a step multipli, evoluzione. Documento vivo — ogni sprint viene
dettagliato via grilling prima dell'esecuzione e questo file si aggiorna.

## Registro decisioni (ADR)

| # | Decisione | Esito | Note |
|---|-----------|-------|------|
| D1 | Rebrand | **Completo → kstack** | comando `/kstack`, tool `kstack_*`, env `KSTACK_*`, skill id `kstack-*`, package rinominato |
| D2 | Step model | **Ibrido** | fase = contenitore di step eterogenei: step main interattivi + step delegati isolati; **step = unità atomica di consegna di una skill** |
| D3 | DoD | **Due layer** | regole globali workflow → managed block in AGENTS.md della repo target via script di install; contratti per-skill → sezione `## DoD gate` dentro ogni SKILL.md |
| D4 | Telemetry | **Keep locale, sync upstream disabilitato** | `telemetry-log`/`question-log` assorbiti; `telemetry-sync` (POST a Supabase upstream) disabilitato finché kstack non ha un endpoint proprio |
| D5 | Memory layer | **Direzione: sleep-phase + ACE + bi-temporal** | decision-log/search, learnings-log/search assorbiti in S1 così come sono (capacità conservata); redesign S5b per research findings: consolidamento tra run, delta mai rewrite, valid_from/until, write-gates anti-poisoning |
| D6 | Catalogo | **Unico in `skills/`** | ogni skill = dir con `SKILL.md` + `references/` colocati + `## DoD gate`; provenance in commento `<!-- provenance: ... -->`; via i layer multipli |
| D7 | Validazione | **Re-valida da zero** | fusioni sprint-beta NON fidate a priori: ogni cluster di sovrapposizione si rianalizza dai raw; merge consentito seguendo best practice di skill-authoring |
| D8 | Digest | **Eliminati** | `skills-distilled/` cancellato in S1; `dod` sopravvive come sezione di SKILL.md; machinery di injection semplificata in S3 |
| D9 | Espansione | **4 locali in S1 + sprint dedicato post-ricerca** | `impeccable`, `design-taste-frontend`, `mindrun`, `retro` (già in `~/.agents/skills`, gated dalla rubrica); il grosso dell'espansione dopo la ricerca dell'utente. NOTA: `retro` locale ≠ `gstack-retro` del catalogo (retro settimanale su commit/team — non usata, drop candidato) |
| D10 | Gating | **Io propongo, l'utente decide** | batch review tabellare per keep/rewrite/merge/drop |
| D11 | Rename skill id | **In S2 col rebrand sweep** | S1 costruisce il catalogo con gli id attuali (`gstack-*`/`beta-*`); S2 rinomina id + dir. Accettato il doppio passaggio sui path |
| D12 | Layout catalogo | **Flat `skills/<id>/`** | niente subdir intermedie; pi scopre ricorsivamente |
| D13 | Sorgente DoD gate | **Parsato da SKILL.md** | `loadSkillGate(id)` estrae `## DoD gate` dal file; il campo `dod` in `skills.ts` sparisce — una sola fonte |
| D14 | Compat rename | **Clean cut + migrazione dati** | niente alias `/gstack`; migrazione `~/.gstack`→`~/.kstack` e `.gstack/`→`.kstack/`; state entries versionate → sessioni pre-rename abortiscono pulite |
| D15 | Script runtime | **Rinomina tutto** | `gstack-*`→`kstack-*` inclusi i corpi con cross-call interne |
| D16 | Identità | **Rename completo** | repo `KedraVt/kstack-pi`, package `@kedra/kstack-pi`, dir estensione `~/.pi/agent/extensions/kstack-pi` a fine S2 |
| D17 | Install regole | **Comando `/kstack init`** | scrive/aggiorna managed block `<!-- kstack:begin -->…end` in AGENTS.md della repo target — idempotente |
| D18 | Step model | **`steps[]` dentro phase** | step = unità di lavoro+skill; phase = unità di routing/gate/verdict. Phase senza `steps` = step implicito singolo (backward compat) |
| D19 | Skill per step | **0 o 1, enforced** | due skill necessarie = due step; step meccanici ne hanno zero |
| D20 | Pre-flight gates | **human-gate | selection-gate** | all'avvio il pannello `/kstack` chiede la modalità; selection-gate mostra tutti i gate in multi-select auto\|human. Gate side-effect (commit/push/archive) marcati ⚠, default human, toggleabili. Sussume `GSTACK_PI_OPTIONAL_PHASES` (resta come default non-interattivo) |
| D21 | Pilota | **develop.plan** | decomposto in 3 step (interrogate/draft/eng-review); accettazione = **full develop run** su task reale |
| D22 | office-hours | **Split → `plan-draft`** | office-hours resta integra (manual); dal suo corpo si estrae una skill snella plan-draft per lo step draft — creata in S1-T5 via batch review |
| D23 | Loop rollout | **Tutti i workflow dove naturali** | develop: qa/review→implement; qa: report→fix→retest; investigate: verify→fix; review: findings→fix→re-review; ship: review blocca pre-push (post-push = park+rollback, mai loop); sprint invariato (reference); qa-report/quick nessuno |
| D24 | Sprint in S4 | **Review leggera** | si decompone solo dove il valore è chiaro (es. system-design→[design\|adr]); la machinery verdict/loop resta intoccata |
| D25 | Skill nuove in S4 | **Step-first: gap → task catalogo** | gli step si progettano per compito; una skill mancante diventa task di creazione (best practice authoring) — mindrun e verification primi casi |
| D26 | Sequenza S4 | **Un workflow alla volta** | develop primo (il pilota plan ci vive), poi investigate, qa, qa-report, ship, review, sprint-light; ogni workflow: spec → implementa → run verifica |
| D27 | Struttura S5 | **S5a + S5b + backlog S6** | S5a foundation hardening; S5b structural; espansione (fleet/SLM/sandbox/RL/catalogo) + telemetry endpoint → backlog S6 |
| D28 | Quick-win constraints | **Implementa in S3/S4** | prefix-stable assembly, stuck/budget hooks, ledger+resume-gate → dentro il design di S3; blocker-summary feedback → S4 loop machinery. S5a = solo l'additivo + tuning |
| D29 | Ordine S5b | **Eval → DAG → memory → resto** | pass^k + trajectory-diff prima (misura prima di ottimizzare); poi DAG executor; poi memory sleep-phase; poi judge/CodeAct/blast-radius |
| D30 | Research report | **Salvato** | `Kstack/research-report.md` — fonte delle scelte S5 |
| D31 | Memory backend | **Configurabile + pluggabile** | `memory.enabled` si/no indipendente dal backend — workflow identico con memory off. Due livelli: ledger append-only = store canonico verbatim per decisioni/verdict (epistemic markers, git-audit); sopra, backend pluggabile `local` (FTS su JSONL, default zero-dep) o `supermemory` (engine self-hosted opt-in, NO fork — binary closed-source; kstack auto-spawn/stop per run; pin v0.0.9+ per loopback+auth; MCP hosted escluso salvo scelta utente) |
| D32 | Scope env rename (S2) | **TUTTI `GSTACK_*` → `KSTACK_*`** | non solo `_PI_`: root/home/state/remote/search/redact/supabase + prefix literals (`"GSTACK_PI_"`, `"GSTACK_CODEX_"`); ogni consumer è in questo repo — niente contratto mezzo-brandizzato |
| D33 | SKILL_INJECTION (S2) | **Eliminata, non rinominata** | stub post-S1 no-op: env read, `skillInjectionMode()`, tipo `SkillInjectionMode`, `_mode` param e `beta-injection.test.ts` rimossi |
| D34 | Skill id prefix (S2) | **`kstack-` uniforme su tutto il catalogo** | incluse le portate locali (`impeccable`, `mindrun`, `retro`, `design-taste-frontend`) e gli id non prefissati (`adr`, `tasks`, …) |
| D35 | Migrazione dati (S2) | **NON in S2 — backlog S6** | `~/.kstack` parte pulita; i vecchi `.gstack/` restano in place; task `kstack-migrate` dopo S5b; niente shim lazy — le entry `gstack-wf-state` sono ignorate → sessioni pre-rename abortiscono pulite (D14 regge) |
| D36 | Dir document (S2) | **`skills/kstack-document/` condivisa** | una dir, due registry id (`kstack-document-release`/`-generate`) via `dir:` — invariante "una dir per SKILL.md" regge |
| D37 | Env authority (S2) | **`KSTACK_*` unica sorgente** | niente fallback dual-read sui nomi vecchi; il codice legge solo `KSTACK_*` |

## Skeleton sprint

| Sprint | Titolo | Stato |
|--------|--------|-------|
| S1 | Catalogo skill unico | **dettagliato** |
| S2 | Indipendenza + rebrand | **dettagliato** |
| S3 | Step model + pilota | **dettagliato** |
| S4 | Revisione + migrazione workflow | **dettagliato** |
| S5a | Evolution — foundation hardening | **dettagliato** |
| S5b | Evolution — structural upgrades | **dettagliato** |
| S6 | Backlog espansione | parking lot |

---

## S1 — Catalogo skill unico

**Goal**: un solo catalogo di skill in `skills/`, ogni skill autocontenuta
(SKILL.md + references/ + `## DoD gate`), validata per utilità ed efficacia,
senza sovrapposizioni, senza dipendenze da `source/` o pipeline upstream.

**Precondizione — freeze upstream** (subito, prima dell'audit):
cancellare `update.sh`, `scripts/sync-skills.ts`, `scripts/adapt-skills.ts`,
`scripts/gen-tools.ts` (i loro output restano congelati e committati);
`source/` marcato read-only in attesa di cancellazione a fine sprint.

### Tasks

- [ ] **T1 — Audit dipendenze per-skill.** Per ogni skill dei tre layer
  (~78 file: gstack 23, kedra 18, sprint-beta 37): quali script
  `source/bin`, asset, reference, memory-call, telemetry-call referenzia
  realmente; quali call-site sono morti. Output: tabella dipendenze +
  lista assorbimento `runtime/scripts/` + verdetto fattuale
  "il memory layer è usato dalle skill che restano?" (alimenta D5).
- [ ] **T2 — Overlap map.** Cluster di sovrapposizione tra i tre layer
  (es. debug: `gstack-investigate` / `systematic-debugging` /
  `beta-debugging`; review: `gstack-review` / `code-audit-reviewer` /
  `beta-code-review`; qa: `gstack-qa` / `gstack-qa-only` / `qa-git` /
  `beta-qa`).
- [ ] **T3 — Validazione da zero.** Per ogni cluster → vincitore o
  proposta di merge (best practice skill-authoring). Rubrica:
  (a) utile — risolve un problema reale dei workflow;
  (b) non sovrapposta — si completa col resto del catalogo;
  (c) efficace — metodologia corretta e non datata;
  (d) contratto di formato coerente con chi la consuma (verdict parser, step);
  (e) asset/references risolvibili dentro la skill;
  (f) zero dipendenze upstream.
  Spot-check **live** su format-critical e fusioni.
- [ ] **T4 — Batch review.** Tabella per-skill con keep / rewrite /
  merge / drop + motivo + step target → decisione utente.
- [ ] **T5 — Costruzione catalogo unico.** Merge/riscritture approvate,
  layout flat `skills/<id>/` (D12) con id **attuali** (rename in S2 — D11),
  references colocati, `## DoD gate` in ogni SKILL.md, provenance comment.
- [ ] **T6 — Porting 4 skill locali.** impeccable, design-taste-frontend,
  mindrun, retro (da `~/.agents/skills/`) → gated dalla rubrica;
  mapping a step da
  decidere (candidati: manual-only vs futuri step design/pre-test).
- [ ] **T7 — Assorbimento asset.** `runtime/scripts/` per gli script
  referenziati (telemetry-log, question-log, decision-*, learnings-*,
  redact…), `jargon-list.json`, `ETHOS.md`, template per-skill →
  rewrite dei ~600 path nei file skill.
- [ ] **T8 — Repoint orchestrator.** `skills.ts` REGISTRY → path catalogo
  unico (`skillPath` unico al posto di `fullPath`/`betaPath`/`distilledPath`);
  `dod` → `loadSkillGate(id)` che parsa `## DoD gate` da SKILL.md (D13);
  `loadSkillSource` ridotto a full-only; `GSTACK_PI_SKILL_INJECTION` rimosso.
- [ ] **T9 — Cancellazioni.** `skills/gstack/`, `skills/kedra/`,
  `skills-distilled/`, `source/` (solo dopo T5–T8 verdi).
- [ ] **T10 — Test.** Aggiornare `beta-injection.test.ts` e i test che
  assumono layer multipli/digest; `bun test` verde.

### Formato canonico skill (D6/D12/D13)

```
skills/<id>/
├── SKILL.md          # frontmatter: name, description
│                     # corpo metodologia
│                     # ultima sezione obbligatoria: ## DoD gate
│                     # prima riga corpo: <!-- provenance: <fonte> · <data> -->
└── references/       # opzionale: template, taxonomy, checklist colocati
    └── <asset>
```

Regole: nessun riferimento fuori dalla propria dir (tranne
`runtime/scripts/` e `runtime/browse`); zero call a script non assorbiti;
`## DoD gate` = checklist verificabile + contratto di formato output.

### Sequenza e dipendenze

```
freeze → T1 audit → T2 overlap map → T3 validazione → T4 batch review
                                                        ↓
                              T6 porting 4 locali ←── T5 catalogo ──→ T7 asset
                                                        ↓
                                              T8 repoint → T9 cancellazioni
T10 test: continuo, a ogni commit-point. T9 solo a sprint verde.
```

### Artefatti

`Kstack/audit.md` (T1) · `Kstack/overlap-map.md` (T2) ·
`Kstack/review-table.md` (T4) · `Kstack/catalog-inventory.md` (finale)

### Overlap map — draft iniziale (input T2)

| Cluster | Membri candidati | Fusione beta esistente |
|---|---|---|
| Debug/root-cause | gstack-investigate, systematic-debugging, agent-introspection-debugging, gstack-fix-strategy | beta-debugging |
| Code review | gstack-review, code-audit-reviewer, code-simplification, code-tour | beta-code-review |
| QA | gstack-qa, gstack-qa-only, qa-git | beta-qa |
| Security | gstack-cso, appsec-hardening, docker-manager, pipeline-sre | beta-security |
| Ship/release | gstack-ship, qa-git (parte ship) | beta-ship |
| Plan/interview | office-hours, grilling, plan-ceo/design/devex/eng-review, autoplan, spec | — |
| Sprint/DDD | product-capability, system-design, adr, tasks, tdd, verification | — (copie) |
| Docs | document-release, document-generate | — |
| Memory/context | context-save, context-restore, learn, retro, strategic-compact | — |
| Browser ops | browse, scrape, skillify, setup-browser-cookies, pair-agent, open-gstack-browser | — |

Da raffinare in T2: `code-simplification`/`code-tour` probabilmente
"code quality" non review; `agent-introspection-debugging` è self-debug,
dominio diverso dal debugging del codice utente.

### Non-goal S1

- Non toccare le acceptance-criteria embedded nei corpi degli agenti BE/FE.
- Non modificare `workflows.ts`/`executor.ts` (decomposizione = S3).
- Non rinominare skill id / tool / env (S2 — D1/D11).

### DoD sprint

- Ogni skill del catalogo passa la rubrica e ha `## DoD gate`.
- Nessuna sovrapposizione residua: overlap map chiusa cluster per cluster.
- Zero riferimenti a `source/` o a script non assorbiti nel catalogo.
- `skills/` contiene un solo layer; `source/` cancellato.
- Test verdi.

### Aperto

- Memory layer (D5): dipende da T1.
- Nome directory catalogo: resta `skills/`; rename definitivo in S2 col rebrand.

---

## S2 — Indipendenza + rebrand

**Goal**: zero riferimenti funzionali al nome gstack; identità completa
kstack; dati utente migrati; regole globali installabili via `/kstack init`.

### Superficie di rename (inventario verificato)

| Superficie | Entità | Note |
|---|---|---|
| Env | 24 `GSTACK_PI_*` → `KSTACK_PI_*` | `SKILL_INJECTION` già morta in S1 |
| Tool orchestratore | `gstack_start`/`_advance`/`_phase` | + call sites in templates/spawn/test |
| Tool browse | 65 nomi `gstack_*` | `tools.generated.ts` via script one-off (gen-tools.ts eliminato in S1) |
| Comando | `/gstack` → `/kstack` | + sotto-comando `init` (D17) |
| State keys | `gstack-wf-state`, `gstack-delegation-event` | + campo `version` (D14) |
| Dati repo target | `.gstack/` → `.kstack/` | plans/, sprints/, runs/ |
| Home dati | `~/.gstack` → `~/.kstack` | analytics, decisions, learnings |
| Script runtime | 21+ `gstack-*` + corpi cross-chiamanti | D15 |
| Skill id | uniforme `kstack-*` | `beta-*` perde il prefisso (fusione vive nel provenance comment); id senza prefisso (`adr`, `tasks`) → `kstack-adr`, `kstack-tasks` |
| Identità | package, repo, dir estensione | D16 |
| Docs/test | README, AGENTS*.md, 6 file test | sweep finale |

### Tasks

- [x] **T1 — Baseline.** `bun test` verde pre-sweep + checklist grep-driven
  della superficie (rigenerata dal codice, non dal piano).
- [x] **T2 — Skill id.** Rename dir + registry `skills.ts` + cross-refs nel
  testo skill + riferimenti in `agents/*.md`.
- [x] **T3 — Tool names.** Orchestratore (3) + browse (65): script one-off
  su `tools.generated.ts`, `lib/commands.generated.ts`, call sites in
  templates/agent defs/test.
- [x] **T4 — Env.** `GSTACK_PI_*`→`KSTACK_PI_*` in `config.ts` + callers +
  test (rename letterale, infix `_PI_` conservato). Ampliato a TUTTI i
  `GSTACK_*` (D32).
- [x] **T5 — Comando.** `/gstack`→`/kstack`; sotto-comandi esistenti
  (`next`, status…) preservati; niente alias (D14).
- [x] **T6 — State/data.** Entry type → `kstack-wf-state` con campo
  `version` (bump a 3); `.gstack/`→`.kstack/` nei path dell'orchestratore;
  entry pre-rename ignorate → sessioni abortiscono pulite. Migrazione dati
  rimandata a S6 (D35).
- [x] **T7 — Script rename.** `runtime/**/gstack-*`→`kstack-*` corpi
  inclusi; shebang/usage text; call-site nelle skill. Deviazione:
  `gstack-update-check` e `gstack-team-init` eliminati (macchinari
  upstream-coupled senza caller — stessa regola di update.sh in S1).
- [x] **T8 — Identità.** `package.json` → `@kedra/kstack-pi`; repo
  GitHub rinominato (redirect automatico); `download.ts` RELEASE_BASE
  aggiornato al primo release kstack (fino ad allora punta al release
  v2.0.0 esistente, ridiretto); dir estensione rinominata — step manuale
  a fine sprint.
- [x] **T9 — `/kstack init`.** Sotto-comando che scrive il managed block
  `<!-- kstack:begin -->…<!-- kstack:end -->` in AGENTS.md della repo
  corrente. Contenuto baseline: verdict format `KEY == VALUE`, contratto
  `## HANDOFF`, Iron Law (no fix senza root cause),
  verification-before-completion, vincoli report-only, red line sicurezza.
  Idempotente: update se il blocco esiste; upgrade dei blocchi legacy
  `<!-- gstack:begin -->`.
- [x] **T10 — Docs + test.** Sweep README/AGENTS*/AGENTS_NOTES; fix test
  stringhe; `bun test` verde.

### DoD sprint

- `rg -i gstack` sul codice dell'estensione = 0 (esclusi provenance
  comment e changelog; RELEASE_BASE URL finché il repo non è rinominato —
  commento in `lib/download.ts`).
- Migrazione dati rimandata a S6 (D35): il task `kstack-migrate` è
  tracciato nel backlog, test su fixture previsto lì.
- `/kstack init` idempotente: second-run = no-op. ✅
- `bun test` verde. ✅

### Aperto

- Contenuto esatto del managed block: baseline ora, evolve in S3 con
  verdict/step format.
- Timing rename repo GitHub + dir estensione: manuale, a fine sprint.
- Post-merge: `graft reindex` nel worktree; RELEASE_BASE flippa al primo
  release `kstack-pi`.

## S3 — Step model + pilota

**Goal**: le fasi si decompongono in step; ogni step riceve la **propria**
skill just-in-time (0 o 1, enforced — D19); isolamento ibrido main/delegato;
pre-flight gate config; pilota su `develop.plan` con **full develop run**.

### Data model

```ts
interface WorkflowStep {
  id: string;
  execution: "main" | "subagent";
  agent?: string;        // step delegati
  task: string;          // istruzioni, interpolazione {previous}/{x}_summary
  skill?: string;        // 0 o 1 — enforced
}
```

`WorkflowPhase` invariato su `optional`/`skipWhen`/`advance`/`loopBackTo`/
`maxAttempts`/`feedbackFrom`/`variant`; `steps?: WorkflowStep[]` nuovo —
assente = step implicito singolo (i workflow non migrati non si toccano).
`agent`/`task`/`skills`/`chain` legacy restano per le fasi non migrate.

### Meccanica

- **Step main**: istruzioni (task + skill full) → followUp → modello lavora
  → `gstack_advance` completa lo step → istruzioni step successivo.
- **Step delegato**: machinery chain esistente (spawn, HANDOFF, timeout,
  circuit-breaker) — isolamento per processo.
- `{previous}` = ultimo `## HANDOFF` delegato o summary dello step main.
- Verdict = parse dell'output dell'ultimo step della fase (phase-level).
- State: `stepIndex`, `results["phase.step"]`, `gateMode`, `gateOverrides`.
- Delivery: full skill alla prima consegna per skill-id nella run; repeat →
  solo `## DoD gate` parsato da SKILL.md (D13). `skillsDelivered` resta.
- Resume: contesto include fase **e** step corrente.

### Pre-flight gate config (D20)

- Nuovo status `configure` a inizio workflow: il pannello `/kstack` offre
  `human-gate` (comportamento attuale) | `selection-gate`.
- `selection-gate` → multi-select su tutti i gate (manual, entry-gate,
  optional): ciascuno marcato auto|human; le fasi optional accettano anche
  skip. Required mai skippabili.
- Gate side-effect (commit-archive, push): in lista, marcati ⚠, default
  human, toggleabili.
- Persistito in state (`gateMode`, `gateOverrides`) → sopravvive a resume.
- `GSTACK_PI_OPTIONAL_PHASES` resta come default non-interattivo.

### Pilota — develop.plan

```
plan (advance: manual, gate a fine fase)
├── s1 interrogate   (main, skill: grilling)
├── s2 draft         (main, skill: plan-draft — nuova, D22)
└── s3 eng-review    (main, skill: plan-eng-review)
```

Il resto di develop resta implicit-single-step → l'interop mista è parte
della verifica. Acceptance: run completa su task reale piccolo.

### Tasks

- [ ] **T1 — Types.** `WorkflowStep`, `steps[]` su phase; state:
  `stepIndex`, results per-step, `gateMode`, `gateOverrides`, `version` bump.
- [ ] **T2 — Executor.** Iterazione step main+delegated, plumbing
  `{previous}`, resume per-step, in-flight guards a livello step.
- [ ] **T3 — Templates.** `buildStepInstructions` (task + skill);
  resume context step-aware; delivery full/gate-on-repeat.
- [ ] **T4 — skills.ts.** `loadSkillGate(id)` parsa `## DoD gate` da
  SKILL.md (atterra D13 nel codice).
- [ ] **T5 — Pre-flight.** Status `configure`, selezione modalità nel
  pannello, `gateOverrides` consultato da advance/gate machinery.
- [ ] **T6 — Pilota.** Decomposizione develop.plan (dipende da
  `plan-draft` creata in S1-T5 — D22).
- [ ] **T7 — Test.** Step state machine, gate overrides, interop mista,
  regressione sprint verdict/loop intatta.
- [ ] **T8 — Full develop run.** Su task reale piccolo; verifica delivery
  per-step, resume, gate, handoff verso implement.

### DoD sprint

- develop.plan gira come 3 step, ognuno con la sua skill — niente più
  iniezione tripla.
- selection-gate funziona: gate marcati human pausano, gli altri avanzano.
- Resume a metà step sopravvive a restart.
- Verdict/loop machinery sprint intatta (regressione verde).
- `bun test` verde.

### Vincoli da ricerca implementati qui (D28)

- **Prefix byte-stable** (finding 2.1): `buildStepInstructions` assembla
  tools→system→skill→contratto in ordine fisso; delta volatili (verdict,
  resume, retry) solo in coda al messaggio, mai nel prefisso. Hook per
  telemetria `cache_read`/`cache_creation` per fase.
- **Stuck-detector + budget caps** (2.6): lo step runner nasce con gli
  hook — 5 regole OpenHands (azione-obs identica ≥4×, action-error ≥3×,
  monologo ≥3, coppie alternanti ≥6, ctx-error ripetuto) + budget
  multi-dim (turni/token/USD/wall-clock/cost-velocity), soft-warn ~80% →
  hard-kill → park.
- **Ledger append-only + gates** (2.8): risultati/verdict/artefatti su
  ledger append-only con frontmatter (`.kstack/ledger/`), mai solo
  messaggio transiente; resume-gate + precompact-gate (bloccare
  compaction/transizioni finché gli artefatti non sono flushati);
  campi vincolo/verdict sempre verbatim, mai compressi.
- **Retry feedback** (2.6/CCRM): cap ~3 tentativi (recovery marginale
  23→11→8→5%), poi park — già allineato ai loop ceiling esistenti.

### Aperto

- Accumulo contesto tra step main consecutivi: mitigazione compact/handoff
  → candidato S5.
- Gate step-level: il tipo lo permette in futuro, non costruito ora.
- `quick` (nessun gate): il pre-flight è no-op, da verificare.

## S4 — Revisione + migrazione workflow

**Goal**: ogni workflow **ridisegnato**, non solo migrato — decomposizione
in step, skill assegnata per compito (step-first: gap → nuova skill, D25),
verdict-loop dove naturali (D23). Sprint = reference con review leggera
(D24). Draft decomposizioni: `Kstack/workflow-redesign.md`.

### Metodo — un workflow alla volta (D26)

```
per ogni workflow:  redesign spec (grilling → approvazione)
                 →  implementazione steps + loops + skill map
                 →  run verifica end-to-end
                 →  feedback nel redesign del prossimo
```

Ordine: **develop** (il pilota plan ci vive) → investigate → qa →
qa-report → ship → review → sprint-light → quick (edge case no-gate).

### Loop rollout (D23)

| Workflow | Loop | Ceiling |
|---|---|---|
| develop | qa FAIL → implement · review REQUEST_CHANGES → implement | maxAttempts |
| qa | report FAIL → fix → re-test | bounded |
| investigate | verify persists → fix (refuted → root-cause) | bounded |
| review | findings REQUEST_CHANGES → fix → re-review | bounded |
| ship | review blocca push pre-push; verify post-push fail → park + rollback path | mai loop post-push |
| sprint | invariato — reference implementation | — |

Tutti con machinery sprint riusata: verdict parse deterministico,
feedback dall'artefatto, park su verdict illeggibile.
**Vincolo ricerca (D28)**: il feedback di loop-back è il **blocker
riassunto**, mai la traccia grezza (CCRM: tentativo fallito in contesto
×7.1 errore per-step).

### Tasks

- [ ] **T1 — Redesign spec per workflow.** Per ciascuno: decomposizione
  step, skill map (step-first → gap = nuova skill), loop, gate; spec in
  `Kstack/workflow-redesign.md` → approvazione per-workflow.
- [ ] **T2..T8 — Per workflow**: implementazione steps + loops + run
  verifica (develop → investigate → qa → qa-report → ship → review →
  sprint-light). develop include già il pilota plan di S3.
- [ ] **T9 — Registry→step mapping definitivo.** `skills.ts` REGISTRY
  allineato al catalogo post-S1; skill senza step → marcate manual-only
  o droppate (loop back a S1-T4 se emergono).
- [ ] **T10 — Rimozione legacy.** Campi `agent`/`task`/`skills`/`chain`
  su phase eliminati una volta che tutte le fasi sono `steps[]`;
  injection/tiering legacy ripulita.
- [ ] **T11 — Docs.** README, AGENTS_NOTES, README catalogo, commenti
  agent defs allineati al modello step.

### DoD sprint

- Ogni workflow decomposto in step, ogni step con 0-1 skill mappata.
- Loop verdict attivi dove previsti, con ceiling e park su illeggibile.
- Nessun campo legacy su phase; run verifica verde per ogni workflow.
- `bun test` verde; catalogo e workflow coerenti (niente skill orfane
  non-giustificate).

### Aperto

- Decomposizioni draft in `Kstack/workflow-redesign.md` — punto di
  partenza, ogni workflow si raffina nel suo redesign spec (T1).
- Skill candidate emerse dal draft: `mindrun` (step pre-implement),
  `verification` (self-check/verify ovunque), `tdd` (fix/regression
  steps), `plan-draft` (già D22).

## S5a — Evolution: foundation hardening

Quick win additivi + completamento/tuning di ciò che S3/S4 hanno già
implementato per D28. Fonte: `Kstack/research-report.md`.

### Work-streams

- [ ] **W1 — Phase tool masking** (finding 2.4). Whitelist deterministica
  per fase sui 65 tool browse (investigate→read/grep, qa→browse…);
  batte retrieval semantico, zero miss-risk. + description engineering
  delle descrizioni tool dove serve.
- [ ] **W2 — Datamarking payload untrusted** (§security). Marcatura del
  browser output e di ogni contenuto non fidato prima di entrare nel
  contesto (<2% ASR).
- [ ] **W3 — Cache telemetria** (2.1). Misurare cache_read/creation per
  fase sull'assembly già byte-stable di S3; breakpoint budget 1h+5m;
  tuning.
- [ ] **W4 — Tuning stuck/budget/ledger** (2.6/2.8). I detector sono
  nati in S3; qui soglie vere, reserve-then-settle per fasi concorrenti,
  e verifica dei gate resume/precompact su run reali.

### DoD

- Tool masking attivo per fase; hit-rate cache misurato e stabile;
  payload browser marcati; detector tarati su run reali.

## S5b — Evolution: structural upgrades

Ordine deciso (D29): misura → architettura → memoria → giudizio →
interfaccia → push.

- [ ] **W1 — Eval harness** (2.11). `pass^k` per flakiness orchestratore;
  trajectory-diff (DAG+LCS, first-divergence primitive) come CI gate di
  workflow; stats rigorose (Wilcoxon/Bayesian, trialCount≥3 → label
  stable/flaky). Senza questo ogni upgrade successivo è vibes.
- [ ] **W2 — DAG executor** (2.3). ~150 LOC: planner emette DAG una
  volta, runtime esegue a ondate level-synchronous, trigger rules
  per-nodo (all_success/none_failed/one_success), joiner-verdict;
  **verdict-nodi che appendono nodi = replanning bounded**. Complementa
  la macchina a fasi, non la sostituisce.
- [ ] **W3 — Memory redesign** (2.9, risolve D5, architettura D31).
  Interfaccia memory con `enabled` si/no + backend
  `local|supermemory`; ledger canonico verbatim per
  decisioni/verdict; backend semantico opzionale per learnings.
  Sleep-phase consolidamento tra run; learnings a delta
  incrementali mai rewrite (ACE); edges bi-temporali
  valid_from/valid_until; write-gates + trust scoring
  anti-poisoning; ops vocabulary ADD/UPDATE/DELETE/NOOP.
  Backend supermemory: lifecycle gestito da kstack
  (spawn/stop per run), pin v0.0.9+.
- [ ] **W4 — Judge protocol** (2.7). n≥3 voti cross-family (mai stessa
  famiglia del generatore), rubrica booleani pesati, CANNOT_ASSESS
  escape, calibrazione TPR+TNR≥0.90 su ≥100 tracce etichettate.
- [ ] **W5 — CodeAct tier** (2.5). I 65 tool browse → API TypeScript
  `search`+`execute`; intermedi nel sandbox. Mantenere il percorso
  parallel-calls (caveat −14.1%).
- [ ] **W6 — Blast-radius push** (2.2). graft → blast-radius iniettato
  nel contesto al momento dell'edit, senza che l'agente lo chieda.

### DoD

- Eval harness misura una regressione nota (test su run registrata);
  DAG executor gira un workflow reale a ondate; memory consolidata tra
  due run; almeno un verdict multi-giudice calibrato.

## S6 — Backlog espansione *(parking lot, non schedulato)*

- Best-of-N fleet: worktree, claim-lock atomici, merge preflight matrix,
  honest-skip — **solo dopo oracoli di verifica decomponibili**.
- SLM FAST tier: router vincolato + arg-gen SLM + constrained decoding +
  distillazione STRONG→FAST.
- Eager dispatch durante streaming + prefetch deterministico setup fasi.
- Sandbox `srt` sui processi spawnati + secret-substitution-at-egress.
- RL-ready records: request/response token-faithful + trajectory IDs +
  loss masks (l'orchestratore è già il boundary dove l'RL si attacca).
- Espansione catalogo skill post-ricerca (lista utente + gap emersi in
  S4 — D9/D25).
- Endpoint telemetry proprio (D4) se mai desiderato.
- A2A/adapter remoti solo se serviranno agenti esterni.
- **Migrazione dati pre-rename** (D35, dopo S5b): script `kstack-migrate`
  che sposta `~/.gstack`→`~/.kstack` (analytics, decisions, learnings) e
  `.gstack/`→`.kstack/` nelle repo target (plans/, sprints/, runs/) —
  con test su fixture.

### Evitare (registrato dalla ricerca — non perdere tempo)

Multi-agent debate/mesh · semantic cache su fasi deterministiche ·
full GraphRAG · auto-prompt-optimization globale sulle skill ·
Reflexion/self-check come gate · vendor SOTA web-agent · SaaS
observability · "checkpointing = durability" senza fencing.
