# Catalog Flaw Audit — `skills/` (27 skills)

Audit of the canonical flat catalog against `.devin/skills/authoring-skills/references/rulebook.md`.
Severity: **CRITICAL** (spec-invalid / broken behavior) · **HIGH** (routing failure risk / systemic defect) · **MEDIUM** (real defect, bounded blast radius) · **LOW** (nit / convention drift) · **OK** (no significant flaws).
Mechanical findings are verified against the files. Behavioral findings (trigger/shadowing) are hypotheses — flagged `needs eval`.

---

## Cross-catalog findings (fix these first)

| # | Severity | Finding | Evidence | Fix |
|---|----------|---------|----------|-----|
| C1 | HIGH | **Asymmetric router quality.** The 11 rewritten skills (`gstack-*`, `plan-draft`) carry formula descriptions (capabilities + verbatim triggers + NOT-clauses). The 9 verbatim kedra ports kept summary-only descriptions — they will under-trigger and lose shadowing fights against gstack siblings on overlapping prompts (e.g. "audit this" → `pipeline-sre` vs `gstack-cso`; "break this into tasks" → nothing matches `tasks`). | description fields, all files | Rewrite the 9 weak descriptions (listed per-skill below) |
| C2 | HIGH (hypothesis) | **`ask_user_question` without headless fallback.** ~8 skills call AUQ with no degraded-mode story; only `mindrun` documents a fallback (`briefing_incomplete`). The old gstack preamble had spawned-session auto-choose machinery — stripped. If the sprint loop ever spawns these headless, scope gates and redaction gates block or improvise. | `gstack-investigate`, `gstack-spec`, `gstack-qa`, `gstack-document`, `gstack-cso`, `gstack-plan-eng-review` (AUQ is first action), `gstack-plan-design-review` (same), `gstack-office-hours` | Verify whether harness supplies AUQ in spawned runs; if not, add a one-line fallback per skill (mindrun pattern) |
| C3 | MEDIUM | **`design-taste-frontend` ↔ `impeccable` collision.** Both claim landing pages/redesigns; neither NOT-clauses the other. `impeccable`'s description is ~900 chars keyword-stuffed; `design-taste` has no "Use when" at all. Asymmetric fight — the stuffed router wins on prompts that should go to design-taste. `gstack-plan-design-review` disambiguates *to* both but they don't disambiguate each other. | `impeccable` desc (~909 chars); `design-taste-frontend` desc (~283 chars) | Add sibling boundaries both ways; thin impeccable's list or accept over-triggering (upstream-locked) |
| C4 | MEDIUM | **Undeclared doc-ecosystem contract.** `adr`, `system-design`, `tasks`, `product-capability`, `pipeline-sre` require the `*_XX.md` artifact chain (user-story → system-design → ADR-log → tasks) and a kedra role roster (planner, frontend-developer, devops-devsecops) that doesn't exist as skills here. Alone, the skills fire but have nothing to read. No `compatibility` field or requirements note declares this. | `adr` L3/12; `system-design` L3/25; `tasks` L3/24; `pipeline-sre` L10/36; `product-capability` L127 | Add `compatibility:` field or an Inputs/Requires note per skill |
| C5 | MEDIUM | **Dead cross-scope pointers.** `gstack-scrape`→`gstack-skillify`, `retro`→`writing-for-agents`, `gstack-investigate`→`gstack-skillify` resolve only via user-scope (`~/.agents`), not this catalog — dead if the catalog is shipped alone. `mindrun` names `diagnosing-bugs`/`systematic-debugging` — dead entirely (the skill here is `gstack-investigate`). | `gstack-scrape` L100; `retro` L11; `mindrun` L24; `gstack-investigate` L181 | Repoint to in-catalog names or mark external deps in a Requires note |
| C6 | LOW | **Undeclared runtime/binary deps.** gstack skills shell out to `runtime/bin/gstack-*`, `runtime/browse|design/dist/*`, `$GSTACK_STATE_ROOT`, `~/.gstack` — all extension-internal, all undocumented in frontmatter (`compatibility` exists for this). | telemetry/setup blocks throughout gstack-* | One `compatibility:` line or a catalog README note |
| C7 | LOW | **Count drift.** Commit/docs say "28 skills"; catalog contains 27. `gstack-skillify` is the likely missing one (referenced twice). | dir listing | Reconcile bookkeeping or re-add the skill |
| C8 | LOW | **Observability inconsistency.** `gstack-*` + `plan-draft` emit `skill_run` telemetry markers; kedra ports and vendored skills emit nothing. No policy either way. | presence/absence of `gstack-telemetry-log` | Decide convention; document it |

---

## Per-skill findings

| Skill | Verdict | Flaws |
|-------|---------|-------|
| `adr` | MEDIUM | Description = capability summary + artifact jargon (`*ADR-log_XX.md*`, markdown italics are noise chars in the router), no verbatim triggers, no NOT-clauses (C1). Undeclared input contract (C4). Body itself is clean: template + status block + DoD. |
| `agent-introspection-debugging` | **HIGH** | Description is a pure summary — zero trigger conditions. The body's "When to Activate" list (loop-limit failures, retry storms, context drift) is invisible to the router (C1). Add verbatim behavioral triggers ("agent loop", "burning tokens", "same tool call repeating") to the description. Body is solid. |
| `code-simplification` | MEDIUM | One trigger branch written 3× ("refactoring for clarity" ≈ "harder to read" ≈ "accumulated complexity" — synonym duplication, not coverage). No NOT-clauses; "reviewing code that has accumulated complexity" overlaps `gstack-review`'s trigger zone (C1). Body strong (principles, metrics, rationalization table, DoD). |
| `design-taste-frontend` | MEDIUM-HIGH | Description has capabilities but **no "Use when" clause at all** and no NOT-clauses — the scope line ("Not dashboards, not data tables") lives in the body (L8) where it can't route (C3 asymmetry). 1206-line single file, 2.4× the <500 guidance — flat-reference genre partially excuses it, but nothing is disclosed; all 13 sections load together. Nit: H1 reads `# tasteskill` — upstream name drift vs the `design-taste-frontend` dir/name (cosmetic). |
| `docker-manager` | MEDIUM | **`version: "2.0.0"` is a top-level frontmatter key — not a spec field**; fails strict validation. Fix: **delete it** (local catalog, no registry/tooling reads it — dead weight) or move to `metadata.version` if some consumer needs it. Description enumerates artifacts well but no verbatim utterances / NOT-clauses (vs `pipeline-sre`). Body: comprehensive Domain A/B, ~15 MUSTs (contract genre, defensible), 422 lines near ceiling — candidate to disclose templates into `references/`. |
| `grilling` | MEDIUM | Description describes the mechanism ("Interview protocol: relentlessly map decisions…") with zero user-facing triggers — nothing matches "interview me", "ask me questions", "don't assume my requirements" (C1). Orchestrator-invoked today, so severity capped; if direct-invocation is wanted the router needs a Use-when. Body excellent (frontier/rounds, facts-vs-decisions, termination). Nit: vendored MIT (`mattpocock/skills`) but no LICENSE file in the dir — attribution nit. |
| `gstack-cso` | OK/LOW | Exemplary: dual-channel verdict, quote-the-line gate, IR playbook, scope-flag mutual exclusion. Nits only: `system-design_XX.md` ecosystem dep (C4), abs-path telemetry (C6). |
| `gstack-document` | OK/LOW | Exemplary (mode table, coverage map, redaction-at-sink, DoD). Nit: `gstack-redact` abs path (C6). |
| `gstack-fix-strategy` | MEDIUM | Description: "For planners validating an already-identified cause" — no user vocabulary, no Use-when, no NOT-clauses (C1). Primarily orchestrator-routed → capped. Body tight (VALIDATED/REFUTED contract, 3-hypothesis bound, DoD). |
| `gstack-investigate` | MEDIUM | (1) AUQ at 3-strike and blast-radius gates, no headless fallback (C2). (2) Write-back loop ("log non-obvious discoveries") dropped in merge. (3) `"95% of 'no root cause' conclusions"` (L249) — unverified statistic, violates honesty rule → soften to "most". (4) Description carries a mini process-summary ("five gated phases ending in DEBUG REPORT") — A9 workflow-leak, low risk. (5) `gstack-skillify` pointer dead in-catalog (C5). Otherwise exemplary structure. |
| `gstack-office-hours` | OK/LOW | Exemplary (mode routing, premise challenge, alternatives gate). AUQ is the core mechanic — fine for human-facing use, but no headless story if the sprint loop spawns it (C2). `$SLUG`/`~/.gstack` env deps (C6). |
| `gstack-plan-design-review` | OK/LOW | Exemplary; AUQ-first scope gate without fallback (C2); `AUQ` shorthand used once undefined (L104 — expand or avoid). |
| `gstack-plan-eng-review` | OK/LOW | Exemplary; same scope-gate AUQ concern (C2). |
| `gstack-qa` | OK/LOW | Exemplary (triage semantics, repro-gate, WTF-likelihood self-regulation, dual-channel artifact). Fix-mode AUQs without fallback (C2); `$B` abs path fail-closed — correct. |
| `gstack-review` | MEDIUM-LOW | Exemplary core. Flaws: `references/specialists/<lens>.md` is **2 levels deep** — partial-read risk vs one-level convention. Step 2.5 `bun run slop:diff` assumes a repo script that may not exist — degradation path present (`|| true`) but undocumented. |
| `gstack-scrape` | OK/LOW | Exemplary (refusal boundary, attempt bound, bookend, fail-closed `$B`). Flaw: `gstack-skillify` pointer (L100) dead in-catalog (C5). `[ -x "$B" ] \|\| { …; exit 1; }` fine. |
| `gstack-ship` | OK/LOW | Exemplary (save-point, stop/never-stop posture, idempotency, supply-chain hook rule). Nits: `<base>`/`{previous}`-style placeholders unexplained (orchestrator convention — C6-adjacent). |
| `gstack-spec` | OK/LOW | Exemplary (hard gate, flags table, redaction scan-at-sink, worktree TOCTOU). Nits: `AUQ` shorthand undefined (L124–125); `$GSTACK_STATE_ROOT`/`gstack-paths`/`gstack-slug` deps (C6); redaction/dedupe AUQs lack headless fallback (C2). |
| `impeccable` | MEDIUM | Vendored upstream — flag, don't rewrite blindly. (1) Description ~909 chars, 15 verbs + 2 noun catalogs = keyword-stuffed; over-triggers vs `design-taste-frontend` (C3). (2) **`version: 4.1.1` top-level is not a spec field** (same violation as `docker-manager`); but it tracks upstream — **keep it vendored-identical, or strip on update**; don't relocate, that breaks diff-against-upstream. `license:` top-level IS spec-valid and earns its place here (vendored Apache-2.0 content). (3) `allowed-tools` as YAML list is Claude-dialect (spec: space-separated string); its entries hardcode a `.pi/skills/impeccable/` install location — portability nits. (4) `reference/` singular + `reference/degraded/*` = 2-level nesting (partial-read risk). Body itself is excellent (modes, routing rules, bounded-verify). |
| `mindrun` | OK/LOW | Exemplary — the only skill with a documented AUQ fallback (the C2 reference pattern). Flaw: names sibling debuggers that don't exist in this catalog — `diagnosing-bugs`, `systematic-debugging` → repoint to `gstack-investigate` (C5). |
| `pipeline-sre` | **HIGH** | Description is a topic sentence ("Framework for CI/CD automation…") — zero triggers, zero boundaries; nothing routes to it (C1). Body references `docker-manager` (✓ exists) but depends on kedra role artifacts + `system-design_XX` (C4). Body content is thin-but-fine; the router is the defect. |
| `plan-draft` | OK/LOW | Exemplary (hard gate, skeleton, self-check, bookend). Nit: `{previous}` interpolation unexplained (orchestrator convention). |
| `product-capability` | MEDIUM | "Use when the user needs a PRD-to-SRS lane" — jargon trigger nobody types; no verbatim utterances; no NOT-clauses vs `plan-draft`/`gstack-spec`/`system-design` neighbors (C1). Body good (contract output, handoff tiers, DoD). |
| `retro` | LOW | **Correctly** models the invocation split — human-facing description + `disable-model-invocation: true` + `agents/openai.yaml` mirror (`allow_implicit_invocation: false`) — positive example for the catalog. Flaws: hard dep on `writing-for-agents` outside the catalog (C5); no DoD gate (only skill missing one — informational inconsistency); body has no H1 title. |
| `system-design` | MEDIUM | Description is jargon-first ("Provides a standard protocol for building a *system-design_XX.md* file") with one thin trigger — nothing matches "design the architecture", "technical design doc" (C1). Missing H1 title (first heading is `# Workflow`). ~15 MUST-rules — contract-generation genre, defensible. Undeclared `user-story_XX`/`ADR-log_XX` contract (C4). |
| `tasks` | MEDIUM-HIGH | Description narrates inputs, has **no trigger at all** — nothing fires it (C1). Italic-markdown filenames in the description are router noise (same as `adr`). Depends on `user-story_XX`/`system-design_XX`/`definition-of-done.md` + a 6-role roster that exists nowhere in the catalog (C4). Body/template/DoD are good; it's unroutable. |
| `test-driven-development` | MEDIUM | (1) **`@references/testing-anti-patterns.md`** (L361) — the `@`-link anti-pattern: force-loads the reference in harnesses that resolve it, defeating progressive disclosure; should be a when-pointer (it already has the condition text). (2) DoD cites "AAA structure" — never defined in body; "≥80% coverage" arbitrary threshold not argued in body. (3) `npm test` hardcodes the runner in a stack-agnostic skill — minor. (4) Description thin: behavioral trigger is decent but no utterances/NOT-clauses (vs `gstack-investigate`, `verification-before-completion`). Body otherwise textbook discipline-genre. |
| `verification-before-completion` | LOW-MED | Description is a 240-char run-on with sloppy punctuation and leads with "Use when" instead of capability. Behavioral trigger is genre-appropriate (fires on agent action, not user words) — keep that, tighten the prose. Body exemplary (gate function, rationalization table, red flags). |

---

## Severity tally

| Severity | Count | Items |
|----------|-------|-------|
| HIGH | 3 | C1 weak-router cohort (9 skills), C2 AUQ-headless, plus worst individual routers (`agent-introspection-debugging`, `pipeline-sre`, `tasks`) |
| MEDIUM | ~10 | C3–C5 + `docker-manager` version field, `tdd` @-link, `code-simplification`, `grilling`, `gstack-fix-strategy`, `product-capability`, `system-design`, `adr`, `impeccable`, `design-taste-frontend` |
| LOW | ~8 | C6–C8, `AUQ` shorthand, H1 gaps (`system-design`, `impeccable`, `retro`), nested specialists, undefined `AAA`/`{previous}` |
| OK (exemplary) | 11 | `gstack-cso`, `gstack-document`, `gstack-office-hours`, `gstack-plan-eng-review`, `gstack-plan-design-review`, `gstack-qa`, `gstack-scrape`, `gstack-ship`, `gstack-spec`, `plan-draft`, `mindrun` — the rewrite cohort is consistently strong |

## Recommended order

1. **C1** — rewrite the 9 kedra-port descriptions with the formula (capabilities + verbatim triggers + NOT-clauses). Highest leverage: routing is the #1 measured failure mode.
2. **C2** — verify AUQ behavior in spawned/headless runs; adopt the `mindrun` fallback pattern where needed.
3. **C3/C5** — pairwise boundary clauses + dead-pointer repointing (cheap, mechanical).
4. **C4/C6** — add `compatibility:` / Requires notes for the doc-ecosystem and runtime binaries.
5. Mechanical: `docker-manager` delete top-level `version:` (no consumer — dead weight; `metadata.version` only if a tool reads it); `tdd` `@`-link → pointer; `gstack-investigate` "95%" → "most" + restore write-back line. `impeccable`/`grilling` vendored: keep identical to upstream, handle version/LICENSE at re-vendoring time, not by edit.
6. `design-taste-frontend` — add Use-when/NOT to the description; consider disclosing sections 4–13 into `references/`.

---

## Resolution (kstack, post-audit)

Applied on 2026-02-11:

- **C1** — all 12 weak descriptions rewritten with the formula (capabilities + verbatim triggers + NOT-clauses): `adr`, `agent-introspection-debugging`, `code-simplification`, `docker-manager`, `grilling`, `gstack-fix-strategy`, `pipeline-sre`, `product-capability`, `system-design`, `tasks`, `test-driven-development`, `verification-before-completion`.
- **C2** — confirmed real: spawned subagents run `pi --mode json -p --no-session` (no user). Added a "Headless run?" fallback line (mindrun pattern: safe option + `~assumed`, never block) to all 10 AUQ callers: `gstack-investigate`, `gstack-qa`, `gstack-document`, `gstack-cso`, `gstack-plan-eng-review`, `gstack-plan-design-review`, `gstack-office-hours`, `gstack-review`, `gstack-ship`, `gstack-spec`.
- **C4** — `compatibility:` frontmatter + **Inputs** body note on `adr`, `system-design`, `tasks`, `product-capability`, `pipeline-sre` (+ `gstack-cso`).
- **C5** — `gstack-scrape`/`gstack-investigate` skillify pointers marked user-stack-external (compat field). `retro`→`writing-for-agents`, `mindrun`→`diagnosing-bugs/systematic-debugging` = deferred: protected verbatim skills.
- **C6** — `compatibility:` frontmatter on all runtime-dependent skills.
- **C7** — audit miscounted: catalog is 28 dirs; docs correct.
- **C8** — convention documented in AGENTS.md (markers = session-level skills only).
- Mechanical: `docker-manager` `version:` deleted; `tdd` @-link→pointer, AAA spelled out, coverage un-arbitrary'd, runner note added; `gstack-investigate` 95%→most + `Discoveries:` field restored in DEBUG REPORT; `gstack-review` specialists flattened to one level + TODOS-format copied to `gstack-ship/references/`; `AUQ`/`{previous}`/`<base>` shorthands explained; `system-design` got its H1.
- **Protected-skill polish** (user clarified: no merge/no functionality change, refinement welcome) — `design-taste-frontend` got Use-when + NOT vs impeccable + real H1; `impeccable` got a thinned description + NOT vs design-taste + `version`→`metadata` + `allowed-tools` space-separated; `mindrun` repointed to `gstack-investigate`; `retro` got H1 + DoD gate + `writing-for-agents` marked as user-stack dep. All four keep identity and functionality — no merges.
- Verified: pre-flight 0 failures, suite 309/309 green.
