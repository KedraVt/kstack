# Design Notes — Skill di bug-discovery statica (nome da definire a fine progetto)

> Cartella di lavoro: `cline-skill/`. Il nome definitivo della skill viene deciso a fine progetto;
> nella bozza di `SKILL.md` si usa `pipeline-desk-check` come nome provvisorio.

## 1. Obiettivo e posizionamento

Scoprire bug e incoerenze **invisibili alla compilazione** testando il software *teoricamente*:
roleplay dell'agente attraverso la pipeline del software (UI → input → trasformazione → output),
con catene causa-effetto ancorate alla lettura del codice reale, senza eseguire l'app.

- **Quando si attiva**: il codice compila, nessun bug noto, prima dei test runtime.
- **Output**: trigger falsificabili pronti a diventare test + domande all'utente sui comportamenti
  non specificati + matrice DoD verificata.
- **Posizionamento esplicito** (per evitare overlap): è *pre-emptive static discovery*.
  - vs `diagnosing-bugs` (Pocock) / `systematic-debugging` (locale): quelle partono da un sintomo
    osservato e richiedono un feedback loop; questa genera i candidati E i feedback loop, senza sintomo.
  - vs `bug-hunt-swarm`: quella è diagnosis-first (bug già noto); questa cerca difetti latenti.
  - vs `code-audit-reviewer` (locale): quella revisiona a 5 dimensioni; questa cammina il flusso d'uso.
- **Collocazione nel sprint flow** (produttore/consumatore da registrare in README.md):
  dopo `code-audit-reviewer`, prima di `qa-git`.

## 2. Workflow a 6 fasi

### Fase 0 — Briefing DoD (non bloccante)
- Con l'utente si definiscono i DoD della pipeline: input attesi, trasformazioni, output, gestione errori.
- Si scelgono **2–3 scenari**: happy path + un edge case + un input "ostile". Ogni scenario avrà la sua trace table.
- Formato: investigation brief (da bug-hunt-swarm) — cosa deve succedere / cosa non è ancora provato /
  che cosa conterebbe come conferma.
- Se l'utente non è disponibile: si procede con assunzioni marcate `~` (non bloccante, pattern Pocock).

### Fase 1 — Breadboard UI
- Modello Places / affordances / wiring (da `breadboarding`, rjs/shaping-skills — Shape Up):
  cosa è visibile, cosa è bloccante, dove passa il controllo al codice.

### Fase 2 — Pipeline walk
- **Regola centrale (da trace-the-code)**: a ogni step si legge il codice reale, mai la memoria di
  quello che "dovrebbe" fare.
- Domande fisse ripetute a ogni step (da cognitive-walkthrough, adattate):
  come arriva l'input qui? / cosa assume il codice su di esso? / cosa succede se l'assunzione è violata? /
  dove finisce l'output e chi lo valida?
- **Output tabellare**: per ogni step → `step | input atteso | come lo riceve il codice | output prodotto | destinazione`.
- **Trace table per scenario** (desk-checking classico, da examprep-ai): `Iter | VarA | VarB | ... | Output`,
  che evolve step per step.
- **Marcatori**: `?` = comportamento non specificato → domanda per l'utente; `~` = assunzione
  non verificata, si prosegue.
- **Naive pass (comportamento "bambino")**: a ogni step, spiegare lo step come a un bambino di 6 anni;
  ogni "ovviamente / naturalmente / semplicemente" è un'assunzione implicita → Premessa da verificare.

#### Regole del naive pass (ri-armo e destini)
- Il naive pass **non è una fase, è un contesto**: si ri-arma a ogni confine strutturale
  (cambio modulo/file dominante, cambio paradigma: UI→backend, sync→async, processo→processo, app→DB, I/O esterno),
  **dopo ogni finding accettato** (momento di massima fiducia = massimo rischio di bias),
  e al checkpoint di metà walkthrough (rete di sicurezza).
- Due tipi di "perché", due destini:
  - *Perché-meccanico* ("come lo sai? dove nel codice?") → l'agente si risponde SOLO rileggendo il codice.
  - *Perché-intent* ("perché si rifiuta l'input vuoto invece di autocorreggerlo?") → se il briefing
    non lo copre, va nella coda `?` per l'utente. Mai rispondersi da solo.
- **Regola d'oro**: una risposta non è accettata finché non cita file+riga.

### Fase 3 — Causal chain check
- **Checklist degli assi del mismatch** (da code-review-and-quality, addyosmani):
  tipo, unità/misura, ordine, stato, null/vuoto, encoding.
- **Formato finding a 5 campi** (da Logic-Lens logic-review):
  `Premises: / Trace: / Divergence: / Trigger: / Remedy:` — campi obbligatori, non parafrasabili.
  Un finding senza Trigger concreto (input specifico → catena → output errato) è "a vibe": si scarta o si affina.
- **Design-intent gate** (Logic-Lens): prima di segnalare un problema a un boundary, verificare se il codice
  gestisce esplicitamente il caso (throw, 429, reject). Se sì, NON è un bug.
- **Rebuttal avversariale** (Logic-Lens 5.5 + uglybug): per ogni finding, 3 domande di confutazione
  (premise / path / consequence rebuttal). Penalità asimmetrica nello Skeptic: respingere un bug vero
  costa 2x rispetto ad accettarne uno falso (anti-sycophancy, SycEval arXiv 2502.08177).
- **Verifica fedeltà citazioni** (ruolo Reproducer di uglybug): pass separato in cui si rileggono SOLO
  le citazioni di codice dei finding. Critico: l'agente sta testando il proprio codice.
- Multi-wave con dedup e auto-stop (2 wave pulite consecutive) se il progetto è grande.

### Fase 4 — Report
- **Matrice DoD come singola fonte di verità**: una riga per ogni DoD del briefing,
  verdetto `verificata / mismatch / non specificata → domanda`.
- **Findings ranke** con confidence (high/medium/low) + "smallest proof step" (da bug-hunt-swarm).
- **Triage a 3 velocità**: `prove now / fix next / follow up later`.
- **Coda domande**: prioritarie (sul percorso happy-path) prima; poi **overflow**
  (cap indicativo ~3 domande/step per proteggere l'attenzione dell'utente — l'overflow va nel report,
  MAI verso il silenzio; dedup prima dell'overflow).
- **Sensore di briefing incompleto**: se più di 2–3 step consecutivi traboccano il cap,
  riaprire il briefing invece di accumulare domande.
- **Execution Gate opzionale** (Logic-Lens step 8): se un runtime è disponibile, generare un riproducer
  minimo per i finding critici ed eseguirlo; i verificati prendono tag ✅.
- Artefatto: `qa/desk-check_XX.md` con blocco `STATUS ==` parseable dal planner
  (convenzione `code-audit-reviewer` locale).

### Fase 5 — Handoff
- I mismatch diventano **task** (via skill `kstack-tasks` locale), non righe di report dimenticate.
- Ogni finding critico diventa un **feedback loop / test** per `diagnosing-bugs` o QA reale.
  La skill NON esegue nulla di suo (salvo Execution Gate opzionale).

## 3. Failure signs (come riconoscere la degenerazione)

- L'agente descrive ciò che *intendeva* scrivere, non ciò che ha scritto (da trace-the-code).
- L'agente risponde ai "perché" senza aprire file → torna al naive pass.
- Le domande `?` superano il cap o sono varianti della stessa → briefing incompleto, riaprirlo.
- L'agente smette di chiedere "come fai a saperlo?" dopo i primi step → bias dell'esperto tornato,
  ri-armare il naive pass.

## 4. Architettura d'esecuzione

Single-agent a fasi separate (walkthrough → skeptic → reproducer), con sub-agent opzionali
per progetti grandi (pattern bug-hunt-swarm: "for a tiny and obvious issue, investigate locally").

## 5. Fonti (verificate durante la ricerca)

| Fonte | Stato | Prende |
|---|---|---|
| Logic-Lens / logic-review (hyhmrright, via sickn33) | ✅ verificata | 5 campi, rebuttal, design-intent gate, exec gate |
| uglybug / bug-hunt (mathifonseca / danpeg) | ✅ verificata | Skeptic asimmetrico, Reproducer, multi-wave |
| cognitive-walkthrough (mastepanoski) | ✅ verificata | roleplay novice, domande fisse per step |
| grill-me / grilling / to-questionnaire / diagnosing-bugs (mattpocock) | ✅ verificata | briefing-interview, checkpoint non bloccante, falsificabilità |
| bug-hunt-swarm (dimillian) | ✅ verificata | investigation brief, ranking+confidence, triage |
| trace-the-code (alinafe82/cognitive-deadlift) | ✅ verificata (1 install) | regola "codice reale mai memoria", failure signs |
| breadboarding (rjs/shaping-skills) | ✅ verificata | Places/affordances/wiring, tabelle come verità |
| examprep-ai (sickn33) | ✅ verificata | trace table Iter/Vars/Output |
| double-check (meain/dotfiles) | ⚠️ plausibile non confermata | verifica per affermazione (stato→file, comportamento→trace) |
| code-review-and-quality (addyosmani) | ⚠️ plausibile non verificata | assi del mismatch |
| TRACE (2389-research), Virtual-Lab | ❓ non verificate | matrice di verifica, multi-scenario (assunte sul merito) |

## 6. Decisioni aperte

- **Nome della skill**: ✅ **DEFINITO: `kstack-mindrun`** (verificato libero su skills.sh; concorrenti scartati:
  `premortem` affollato 1.2k+ install, `preflight` inquinato, `prebug` libero ma meno fedele al metodo).
  Cartella rinominata `cline-skill/` → `mindrun/`, frontmatter `name: mindrun`, artefatti rinominati
  `mindrun-briefing.md` / `mindrun-report.md`, prefisso task `[mindrun]`, tagline nella description.
- Registrare producer/consumer nel `README.md` quando la skill è finalizzata.
- Licenza: campo omesso per ora (da aggiungere se distribuita).

## 7. Stato attuale (post-stesura)

Skill scritta e **validata** (`skills-ref validate` → "Valid skill"):

```
cline-skill/
├── SKILL.md                      # 138 righe, inglese, frontmatter conforme
├── design-notes.md               # questo file (non distribuito)
└── references/
    ├── briefing-template.md      # template F0
    ├── finding-format.md         # 5 campi + acceptance gate + esempi good/bad
    ├── mismatch-axes.md          # 6 assi con domande ed esempi
    └── report-template.md        # template report incrementale + STATUS block
```

Decisioni applicate rispetto al piano v2:
- Artefatti ridotti 5 → 2 (`desk-check-briefing.md`, `desk-check-report.md`); breadboard e walk
  sono sezioni del report, proposed-tasks è sezione di coda del report.
- Naive pass riformulato come **standard di comprensione per-step** ("riesci a ricostruire la
  catena input→output dal solo codice?"), non come comportamento ispettivo: niente ri-armo
  esplicito, niente bacchettamento degli impliciti, domande solo meccaniche.
- Report scritto **incrementalmente** dopo ogni step → il report parziale è lo stato di resume.
- Lingua: inglese ovunque (SKILL.md + references).
- Validazione formale passata con nome provvisorio coincidente con la cartella.

## 8. Installazioni

- **Pi** (earendil-works/pi): `~/.pi/agent/skills/kstack-mindrun/` (user-level, tutti i progetti) — ✅ validata
- **Cline**: `~/.cline/skills/kstack-mindrun/` (user-level, IDE/CLI/SDK) — ✅ validata
- Sorgente di verità: `Desktop\.agents-clean\mindrun\` — le installazioni sono copie: dopo ogni
  modifica al sorgente, ricopiare sulle destinazioni (o sostituire con symlink/junction).


