# S1-T2 — Overlap map (final)

Based on the T1 audit (mechanical extraction) + reading of the unique bodies.
The 78 dirs reduce to **48 unique bodies** (16+14 identical copies across layers).

## Clusters and real overlaps

### 1. Debug / root-cause
| Member | Layer | Notes |
|---|---|---|
| `beta-debugging` | sprint-beta | existing merge: investigate skeleton + systematic discipline. DEBUG REPORT + 3-strike contract. **Winner.** |
| `gstack-investigate` | gstack | subsumed; only adds the memory hooks (to port into the winner if the memory layer is kept) |
| `systematic-debugging` | kedra | subsumed; 8 useful reference files → `beta-debugging/references/` |
| `gstack-fix-strategy` | sprint-beta | different role (validates confirmed cause → fix plan); used by the investigate chain. **Stays.** |
| `agent-introspection-debugging` | kedra | different domain: agent self-debug (loops, context drift). Not overlapping. **Stays** — S3 step candidate (stuck machinery). |

### 2. Code review
| Member | Layer | Notes |
|---|---|---|
| `beta-code-review` | sprint-beta | review + code-audit-reviewer merge. `code-review == approved|rejected` verdict compatible with the parser. **Winner.** |
| `gstack-review` | gstack | subsumed; assets to migrate: `review/checklist.md`, `design-checklist.md`, `greptile-triage.md`, `specialists/*` (7), `TODOS-format.md`. Lost: review-army dispatch, fix-first auto-fix, adversarial Codex (intentional — the fix-loop is S4 business, Codex is an opt-in external dep) |
| `code-audit-reviewer` | kedra | subsumed |
| `code-simplification` | kedra+β | NOT review: refactoring clarity. **Stays** (manual). |
| `code-tour` | kedra+β | NOT review: VSCode `.tour` files. **Weak keep-manual** — see open question. |

### 3. QA
| Member | Layer | Notes |
|---|---|---|
| `beta-qa` | sprint-beta | qa + qa-only + qa-git triage merge. Dual-channel `status == green|red|orange`. **Winner.** |
| `gstack-qa` | gstack | subsumed; assets: `qa/references/issue-taxonomy.md`, `qa/templates/qa-report-template.md` |
| `gstack-qa-only` | gstack | subsumed (report-only is a beta-qa mode) |
| `qa-git` | kedra | subsumed (triage → beta-qa; save-point → beta-ship) |

### 4. Security
| Member | Layer | Notes |
|---|---|---|
| `beta-security` | sprint-beta | appsec-hardening + cso merge. `security-review ==` verdict + severity. **Winner.** |
| `gstack-cso` | gstack | subsumed; asset: `cso/sections/audit-phases.md` |
| `appsec-hardening` | kedra | subsumed |
| `docker-manager` | kedra+β | complementary (conditional Dockerfile audit, sprint devsecops). **Stays.** |
| `pipeline-sre` | kedra+β | complementary (conditional CI/CD audit). **Stays.** |

### 5. Ship / release
| Member | Layer | Notes |
|---|---|---|
| `beta-ship` | sprint-beta | ship + qa-git save-point merge. SHIP REPORT + BLOCKED. **Winner.** |
| `gstack-ship` | gstack | subsumed; assets: `ship/sections/*` (8 files) + `review/TODOS-format.md` |

### 6. Plan / interview
No existing beta merge. All upstream `gstack-*` with shared boilerplate.

| Member | Notes |
|---|---|
| `grilling` | vendored, has `## DoD gate`. develop.plan.s1 step. **Stays.** |
| `gstack-office-hours` | YC product judgment, 2 modes. **Keep-rewrite** + `plan-draft` split source (D22). |
| `gstack-plan-eng-review` | load-bearing develop.plan.s3. **Keep-rewrite.** |
| `gstack-plan-ceo-review` | mega review, EXPANSION/HOLD etc. modes. **Keep-rewrite.** |
| `gstack-plan-design-review` | designer's eye; upstream "design binary" dep → to neutralize. **Keep-rewrite.** |
| `gstack-plan-devex-review` | DX review. **Keep-rewrite.** |
| `gstack-autoplan` | meta-pipeline orchestrating the 4 plan-reviews + Codex dual-voice. With the S3/S4 step model it becomes native decomposition. **Manual keep-rewrite** (marked: S4 redesign). |
| `gstack-spec` | spec → backlog-ready issue, redaction gate (uses `gstack-redact`). **Keep-rewrite.** |

### 7. Sprint / DDD (kedra, identical copies in β)
`product-capability`, `system-design`, `adr`, `tasks`, `test-driven-development`
(+`testing-anti-patterns.md`), `verification-before-completion`,
`strategic-compact`. All referenced by the sprint workflow or complementary.
**All stay.** `_XX.md`/`STATUS ==` contracts already compatible.

### 8. Docs
`gstack-document-generate` + `gstack-document-release`: no merge —
used by develop.document and ship.update-docs. **Keep-rewrite.**
Asset: `document-release/sections/release-body.md`.

### 9. Memory / context
| Member | Notes |
|---|---|
| `gstack-context-save` / `gstack-context-restore` | context save/restore UX on `~/.gstack/projects/`. **Keep-rewrite** (S5b redesign). |
| `gstack-learn` | UI over the learnings store (show/search/prune/export/add). **Keep-rewrite.** |
| `gstack-retro` | weekly git retro; not wired; dep `gstack-global-discover` **missing** from runtime/bin. **Drop candidate** (D9 note). |
| `strategic-compact` | compact report for sub-agents — see cluster 7. |

### 10. Browser ops
`gstack-scrape` (intent→refuse-mutating→prototype over the `gstack_*` browse tools) and
`gstack-skillify` (codify a scrape → permanent skill; deps `browse/src/browser-skill-write.ts`,
`~/.gstack/browser-skills/`). **Keep-rewrite both.**

### 11. Utility / misc
| Member | Notes |
|---|---|
| `add-model` | helper `~/.pi/agent/models.json` + `upsert.mjs` + `references/schema.md`. Pi-native. **Stays.** |
| `manim-video` | Manim pipeline + py assets. Niche but self-contained. **Stays** (manual). |
| `gstack` (root) | router meta-skill — routing is now done by `/kstack` + the orchestrator. **Drop.** |

### 12. Local skills (T6 — from `~/.agents/skills/`, rubric-gated)
| Member | Notes |
|---|---|
| `impeccable` | full UI design: 35 references + 40 .mjs scripts. `.pi/skills/impeccable/` paths to adapt. Partial overlap with `gstack-design-review` and `design-taste-frontend` → see open questions. **Port.** |
| `design-taste-frontend` | anti-slop landing/portfolio, 87KB single-file. Partial impeccable overlap. **Port** (or merge — user decision). |
| `mindrun` | pre-test static walkthrough; first S4 pre-implement step candidate. **Port.** |
| `retro` (local) | session retro → agent env improvements. ≠ gstack-retro. **Port.** |

## Numbers

- Unique bodies evaluated: 48 (23 gstack + 18 kedra + 7 beta-unique)
- Beta winners (already merged): 5
- Drops by subsumption: 11
- Router/meta drops: 1 (+ retro if confirmed)
- Upstream keep-rewrites: 16 → 15 if retro dropped
- Keeps (kedra/vendored/utilities): 21
- Local ports: 4 (+ new plan-draft from D22)
- **Target catalog: ~34-36 skills** (+1 plan-draft)
