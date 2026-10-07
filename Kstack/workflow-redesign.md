# Workflow redesign — draft decomposizioni (S4-T1)

Documento di lavoro: draft iniziale della decomposizione per-step di ogni
workflow. Ogni riga `[step · skill]` — `—` = step meccanico senza skill (D19).
Ogni workflow viene raffinato e approvato nel suo redesign spec durante S4.

Legenda: `⚠` side-effect gate · `⟲` verdict-bearing (loopBackTo) ·
`(opt)` optional · `[main]` implicito dove non marcato delegated.

---

## develop

| Fase | Step proposti | Skill | Loop/Gate |
|---|---|---|---|
| understand | frame | — | — |
| explore | scout | — (delegated) | — |
| plan | interrogate → draft → eng-review | grilling · plan-draft (D22) · plan-eng-review | manual gate a fine fase |
| implement | mindrun → build → self-check | mindrun · tdd · verification | ⟲ target di qa/review |
| qa (opt) | test | qa | ⟲ FAIL → implement |
| review | review | code-review | ⟲ REQUEST_CHANGES → implement |
| ship (opt) | ship | ship | ⚠ side-effect |
| document (opt) | sync → fill | document-release · document-generate | — |

## investigate

| Fase | Step proposti | Skill | Loop/Gate |
|---|---|---|---|
| reproduce | repro | investigate | — |
| root-cause | scout → validate | investigate · fix-strategy | (già chain → steps) · manual gate |
| fix | patch → regression-test | fix-strategy · tdd | ⟲ target |
| verify | verify | verification | ⟲ persists→fix / refuted→root-cause |
| regression-qa (opt) | qa | qa | ⟲ FAIL→fix · skipWhen no-changes |

## qa

| Fase | Step proposti | Skill | Loop/Gate |
|---|---|---|---|
| setup | scope | — | — |
| test | smoke → deep | qa · qa | — |
| report | report | qa | ⟲ FAIL → fix |
| fix (opt) | fix | — | loop rientra a test |

## qa-report

Come qa senza fix: setup→[scope] · test→[smoke|deep] · report→[report] —
tutti `variant: report-only`, nessun loop (il report È il deliverable).

## ship

| Fase | Step proposti | Skill | Loop/Gate |
|---|---|---|---|
| pre-checks | repo-check → test-check | — · — | — |
| review | review | code-review | ⟲ REQUEST_CHANGES → blocca push (fix step pre-push) |
| test | test | — | — |
| push-pr | push-pr | ship | ⚠ side-effect |
| verify | ci-check | — | fail → park + rollback path (mai loop post-push) |
| update-docs (opt) | docs | document-release | — |

## review

| Fase | Step proposti | Skill | Loop/Gate |
|---|---|---|---|
| diff | diff | — (delegated scout) | — |
| findings | findings | code-review | ⟲ REQUEST_CHANGES → fix |
| fix (opt) | fix → re-review | — · code-review | bounded loop |

## sprint (review leggera — D24)

Invariato tranne decomposizioni a valore chiaro, es.:

| Fase | Step proposti | Skill |
|---|---|---|
| system-design | design → adr | system-design · adr |
| implement | backend → frontend | tdd · verification (già chain ≈ steps) |
| devsecops-review | code-review → security | review · appsec(+docker/pipeline condizionali) |

Verdict/loop machinery: **intoccata**.

## quick

Invariato: singolo step main, nessuna skill, nessun gate — verifica solo
che il pre-flight sia no-op.

---

## Skill nuove emerse dal draft (input catalogo — D25)

| Skill | Step target | Origine |
|---|---|---|
| plan-draft | develop.plan/draft | split office-hours (D22, S1-T5) |
| mindrun | develop.implement/mindrun | ~/.agents/skills (porting S1-T6) |
| verification | implement/self-check, investigate/verify | catalogo (verification-before-completion) |
| tdd | implement/build, fix/regression-test | catalogo (test-driven-development) |

## Aperto

- `agent-introspection-debugging`, `code-simplification`, `code-tour`,
  `code-audit-reviewer`: placement deciso a S1-T4 (overlap map) — poi
  eventuali step li consumano.
- Nomi step/id definitivi durante il redesign spec di ogni workflow.
