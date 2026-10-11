# Evolution research — base report (S5)

The user's deep research on agent engineering techniques — source of the
S5 decisions. Summary of the actionable points (full report in the project
conversation).

## Executive verdict

The gstack-pi architecture is validated: deterministic orchestration with
LLM autonomy confined inside phases = where the industry converges (CrewAI
"Flow is the manager"; Google Science of Scaling: centralized 4.4× vs
independent 17.2× error amplification; MAST: spec/design 41.8% of
failures, verification 21.3%; Hallucination Snowball: gates at boundaries
58.4%→16.2%; Cognition: read-only subagents ok, writes single-threaded).
"Conversational" multi-agent = negative for coding — deterministic
subagents with a strict contract are the correct shape.

## The 12 high-impact findings

1. **Variable resume-prefix breaks the KV-cache** — byte-stable prefix
   (tools→system→methodology→contract) + volatile deltas at the tail;
   >82.5% of misses from compaction/idle-timeout; cache_read/creation
   telemetry.
2. **Push, don't poll** — graft/blast-radius injected at edit time without
   the agent asking.
3. **DAG executor ~150 LOC** — LLMCompiler: level-synchronous waves,
   per-node trigger rules, verdict-nodes appending nodes = bounded
   replanning (unclaimed win).
4. **Tool overload** — collapse at ~60 tools; deterministic phase masking
   (per-phase whitelist) beats retrieval; −85% tokens, acc 49→74%.
5. **CodeAct** — 65 tools → search+execute TS API; −41.6% steps, −56.3%
   tokens; intermediates in the sandbox. Caveat: PTC loses 14.1% on
   parallel calls → keep both paths.
6. **Loop/stopping taxonomy** — OpenHands stuck.py 5 rules; multi-dim
   budget (turns/tokens/USD/wall/velocity); retry marginal recovery
   23→11→8→5% → cap≈3; CCRM: raw trace in context ×7.1 error →
   summarized blocker.
7. **Self-check harmful; isolated reviewer works** — judge: n≥3
   cross-family votes, weighted-boolean rubric, CANNOT_ASSESS escape,
   TPR+TNR≥0.90 calibration on ≥100 traces.
8. **Handoff** — never transcript (task+artifact paths); constraint/verdict
   fields verbatim; append-only ledger with frontmatter + resume-gate +
   precompact-gate.
9. **Sleep-phase memory** — consolidation across runs; ACE deltas never
   rewritten; bi-temporal (valid_from/until); anti-poisoning write-gates
   (84.2% persists).
10. **Context budget ~≤32K** — relevant degrades like irrelevant;
    critical instructions at start/end; self-report unreliable →
    external checklist.
11. **Rigorous eval** — pass^k for flakiness; trajectory-diff + first-
    divergence CI gate; Wilcoxon/Bayesian, trialCount≥3 stable/flaky.
12. **Latency** — eager dispatch on closed stream-block (−50% E2E);
    deterministic prefetch; memoize read-only + singleflight.

## To avoid (cross-agent)

Multi-agent debate/mesh · LSP-saves-tokens (disproven) · semantic cache
over deterministic phases · full GraphRAG ($33K/5GB) · auto-prompt-opt on
all skills (49% below zero-shot) · Reflexion/self-refine as a gate ·
"checkpointing=durability" without fencing · vendor SOTA web-agent (15-20pt
inflation) · SaaS observability for local-first · x402/AP2.

## Priorities (as decided)

- **S5a**: additive quick wins (tool masking, datamarking, hit-rate
  telemetry) + completion/tuning of what S3/S4 implemented
  for D28 (prefix-stable, stuck/budget, ledger, blocker-summary).
- **S5b order (D29)**: eval harness → DAG executor → memory redesign
  (sleep/ACE/bi-temporal) → judge → CodeAct → blast-radius push.
- **S6 backlog**: best-of-N fleet, SLM FAST tier, eager dispatch,
  srt sandbox + secret-egress, RL-ready records, post-research catalog
  expansion, own telemetry endpoint.
