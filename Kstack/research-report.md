# Evolution research — report di base (S5)

Ricerca approfondita dell'utente sulle tecniche di agent engineering —
fonte delle decisioni S5. Riassunto dei punti azionabili (report completo
nella conversazione del progetto).

## Verdetto esecutivo

L'architettura gstack-pi è validata: orchestrazione deterministica con
autonomia LLM confinata nelle fasi = dove converge l'industria (CrewAI
"Flow is the manager"; Google Science of Scaling: centralizzato 4.4× vs
indipendente 17.2× error amplification; MAST: spec/design 41.8% dei
fallimenti, verifica 21.3%; Hallucination Snowball: gate ai confini
58.4%→16.2%; Cognition: subagent read-only ok, scritture single-threaded).
Multi-agente "a conversazione" = negativo per coding — i subagent
deterministici con contratto stretto sono la forma corretta.

## I 12 finding ad alto impatto

1. **Resume-prefix variabile rompe la KV-cache** — prefisso byte-stable
   (tools→system→metodologia→contratto) + delta volatili in coda; >82.5%
   dei miss da compaction/idle-timeout; telemetria cache_read/creation.
2. **Push, don't poll** — graft/blast-radius iniettato all'edit senza
   che l'agente lo chieda.
3. **DAG executor ~150 LOC** — LLMCompiler: waves level-synchronous,
   trigger rules per-nodo, verdict-nodi che appendono nodi = replanning
   bounded (vittoria non reclamata).
4. **Tool overload** — collasso ~60 tool; phase masking deterministico
   (whitelist per fase) batte retrieval; −85% token, acc 49→74%.
5. **CodeAct** — 65 tool → search+execute TS API; −41.6% step, −56.3%
   token; intermedi nel sandbox. Caveat: PTC perde 14.1% su parallel
   calls → mantenere entrambi i percorsi.
6. **Loop/stopping tassonomia** — OpenHands stuck.py 5 regole; budget
   multi-dim (turni/token/USD/wall/velocity); retry marginal recovery
   23→11→8→5% → cap≈3; CCRM: traccia grezza nel contesto ×7.1 errore →
   blocker riassunto.
7. **Self-check dannoso; reviewer isolato funziona** — judge: n≥3 voti
   cross-family, rubrica booleani pesati, CANNOT_ASSESS escape,
   calibrazione TPR+TNR≥0.90 su ≥100 tracce.
8. **Handoff** — mai transcript (task+path artefatti); campi
   vincolo/verdict verbatim; ledger append-only con frontmatter +
   resume-gate + precompact-gate.
9. **Sleep-phase memory** — consolidamento tra run; ACE delta mai
   rewrite; bi-temporale (valid_from/until); write-gates anti-poisoning
   (persiste 84.2%).
10. **Context budget ~≤32K** — rilevante degrada quanto l'irrilevante;
    istruzioni critiche a inizio/fine; self-report inaffidabile →
    checklist esterna.
11. **Eval rigorosa** — pass^k per flakiness; trajectory-diff + first-
    divergence CI gate; Wilcoxon/Bayesian, trialCount≥3 stable/flaky.
12. **Latency** — eager dispatch a stream-block chiuso (−50% E2E);
    prefetch deterministico; memoize read-only + singleflight.

## Da evitare (cross-agente)

Multi-agent debate/mesh · LSP-saves-tokens (smentito) · semantic cache su
fasi deterministiche · full GraphRAG ($33K/5GB) · auto-prompt-opt su tutte
le skill (49% sotto zero-shot) · Reflexion/self-refine come gate ·
"checkpointing=durability" senza fencing · vendor SOTA web-agent (infla-
zione 15-20pt) · SaaS observability per local-first · x402/AP2.

## Priorità (come deciso)

- **S5a**: quick wins additivi (tool masking, datamarking, telemetria
  hit-rate) + completamento/tuning di ciò che S3/S4 hanno implementato
  per D28 (prefix-stable, stuck/budget, ledger, blocker-summary).
- **S5b ordine (D29)**: eval harness → DAG executor → memory redesign
  (sleep/ACE/bi-temporal) → judge → CodeAct → blast-radius push.
- **S6 backlog**: fleet best-of-N, SLM FAST tier, eager dispatch,
  sandbox srt + secret-egress, RL-ready records, espansione catalogo
  post-ricerca, telemetry endpoint proprio.
