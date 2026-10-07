# S1-T2 — Overlap map (definitiva)

Basata sull'audit T1 (estrazione meccanica) + lettura dei corpi unici.
Le 78 dir si riducono a **48 corpi unici** (16+14 copie identiche tra layer).

## Cluster e sovrapposizioni reali

### 1. Debug / root-cause
| Membro | Layer | Note |
|---|---|---|
| `beta-debugging` | sprint-beta | fusione esistente: skeleton investigate + disciplina systematic. Contratto DEBUG REPORT + 3-strike. **Vincitore.** |
| `gstack-investigate` | gstack | sussunto; in più ha solo gli hook memory (da portare nel vincitore se si tiene il memory layer) |
| `systematic-debugging` | kedra | sussunto; 8 reference file utili → `beta-debugging/references/` |
| `gstack-fix-strategy` | sprint-beta | ruolo diverso (valida causa confermata → fix plan); usato dalla chain investigate. **Resta.** |
| `agent-introspection-debugging` | kedra | dominio diverso: self-debug dell'agente (loop, context drift). Non sovrapposto. **Resta** — candidato step S3 (stuck machinery). |

### 2. Code review
| Membro | Layer | Note |
|---|---|---|
| `beta-code-review` | sprint-beta | fusione review + code-audit-reviewer. Verdict `code-review == approved|rejected` compatibile col parser. **Vincitore.** |
| `gstack-review` | gstack | sussunto; asset da migrare: `review/checklist.md`, `design-checklist.md`, `greptile-triage.md`, `specialists/*` (7), `TODOS-format.md`. Persi: review-army dispatch, fix-first auto-fix, adversarial Codex (voluto — il fix-loop è materia di S4, Codex è dep esterna opt-in) |
| `code-audit-reviewer` | kedra | sussunto |
| `code-simplification` | kedra+β | NON review: refactoring clarity. **Resta** (manuale). |
| `code-tour` | kedra+β | NON review: file `.tour` VSCode. **Keep-manual debole** — vedi open question. |

### 3. QA
| Membro | Layer | Note |
|---|---|---|
| `beta-qa` | sprint-beta | fusione qa + qa-only + triage qa-git. Dual-channel `status == green|red|orange`. **Vincitore.** |
| `gstack-qa` | gstack | sussunto; asset: `qa/references/issue-taxonomy.md`, `qa/templates/qa-report-template.md` |
| `gstack-qa-only` | gstack | sussunto (report-only è un mode di beta-qa) |
| `qa-git` | kedra | sussunto (triage → beta-qa; save-point → beta-ship) |

### 4. Security
| Membro | Layer | Note |
|---|---|---|
| `beta-security` | sprint-beta | fusione appsec-hardening + cso. Verdict `security-review ==` + severity. **Vincitore.** |
| `gstack-cso` | gstack | sussunto; asset: `cso/sections/audit-phases.md` |
| `appsec-hardening` | kedra | sussunto |
| `docker-manager` | kedra+β | complementare (audit Dockerfile condizionale, sprint devsecops). **Resta.** |
| `pipeline-sre` | kedra+β | complementare (CI/CD audit condizionale). **Resta.** |

### 5. Ship / release
| Membro | Layer | Note |
|---|---|---|
| `beta-ship` | sprint-beta | fusione ship + save-point qa-git. SHIP REPORT + BLOCKED. **Vincitore.** |
| `gstack-ship` | gstack | sussunto; asset: `ship/sections/*` (8 file) + `review/TODOS-format.md` |

### 6. Plan / interview
Nessuna fusione beta esistente. Tutti upstream `gstack-*` con boilerplate condiviso.

| Membro | Note |
|---|---|
| `grilling` | vendored, ha `## DoD gate`. Step develop.plan.s1. **Resta.** |
| `gstack-office-hours` | YC product judgment, 2 mode. **Keep-rewrite** + sorgente split `plan-draft` (D22). |
| `gstack-plan-eng-review` | load-bearing develop.plan.s3. **Keep-rewrite.** |
| `gstack-plan-ceo-review` | mega review, mode EXPANSION/HOLD ecc. **Keep-rewrite.** |
| `gstack-plan-design-review` | designer's eye; dip. "design binary" upstream → da neutralizzare. **Keep-rewrite.** |
| `gstack-plan-devex-review` | DX review. **Keep-rewrite.** |
| `gstack-autoplan` | meta-pipeline che orchestra i 4 plan-review + Codex dual-voice. Con step model S3/S4 diventa decomposizione nativa. **Keep-rewrite manuale** (marcato: redesign S4). |
| `gstack-spec` | spec → issue backlog-ready, redaction gate (usa `gstack-redact`). **Keep-rewrite.** |

### 7. Sprint / DDD (kedra, copie identiche in β)
`product-capability`, `system-design`, `adr`, `tasks`, `test-driven-development`
(+`testing-anti-patterns.md`), `verification-before-completion`,
`strategic-compact`. Tutti referenziati dal workflow sprint o complementari.
**Tutti restano.** Contratti `_XX.md`/`STATUS ==` già compatibili.

### 8. Docs
`gstack-document-generate` + `gstack-document-release`: nessuna fusione —
usati da develop.document e ship.update-docs. **Keep-rewrite.**
Asset: `document-release/sections/release-body.md`.

### 9. Memory / context
| Membro | Note |
|---|---|
| `gstack-context-save` / `gstack-context-restore` | UX save/restore contesto su `~/.gstack/projects/`. **Keep-rewrite** (redesign S5b). |
| `gstack-learn` | UI sullo store learnings (show/search/prune/export/add). **Keep-rewrite.** |
| `gstack-retro` | retro settimanale su git; non wired; dip `gstack-global-discover` **mancante** in runtime/bin. **Drop candidato** (D9 note). |
| `strategic-compact` | compact report per sub-agent — vedi cluster 7. |

### 10. Browser ops
`gstack-scrape` (intent→refuse-mutating→prototype sui tool `gstack_*` browse) e
`gstack-skillify` (codifica scrape → skill permanente; dip `browse/src/browser-skill-write.ts`,
`~/.gstack/browser-skills/`). **Keep-rewrite entrambe.**

### 11. Utility / misc
| Membro | Note |
|---|---|
| `add-model` | helper `~/.pi/agent/models.json` + `upsert.mjs` + `references/schema.md`. Pi-nativo. **Resta.** |
| `manim-video` | pipeline Manim + asset py. Nicchia ma autocontenuta. **Resta** (manuale). |
| `gstack` (root) | router meta-skill — il routing ora lo fa `/kstack` + orchestratore. **Drop.** |

### 12. Locali (T6 — da `~/.agents/skills/`, gated rubrica)
| Membro | Note |
|---|---|
| `impeccable` | design UI completo: 35 reference + 40 script .mjs. Path `.pi/skills/impeccable/` da adattare. Overlap parziale con `gstack-design-review` e `design-taste-frontend` → vedi open questions. **Port.** |
| `design-taste-frontend` | anti-slop landing/portfolio, 87KB single-file. Overlap parziale impeccable. **Port** (o merge — decisione utente). |
| `mindrun` | pre-test static walkthrough; primo candidato step pre-implement S4. **Port.** |
| `retro` (locale) | session retro → migliorie env agente. ≠ gstack-retro. **Port.** |

## Numeri

- Corpi unici valutati: 48 (23 gstack + 18 kedra + 7 beta-unique)
- Vincitori beta (già fusi): 5
- Drop per sussunzione: 11
- Drop router/meta: 1 (+ retro se confermato)
- Keep-rewrite upstream: 16 → 15 se retro drop
- Keep (kedra/vendored/utilities): 21
- Port locali: 4 (+ plan-draft nuova da D22)
- **Catalogo target: ~34-36 skill** (+1 plan-draft)
