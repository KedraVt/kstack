# Kstack — Transformation plan

Master plan: independence from gstack, a single validated skill catalog,
multi-step workflows, evolution. Living document — each sprint is
detailed via grilling before execution and this file is updated.

## Decision log (ADR)

| # | Decision | Outcome | Notes |
|---|-----------|-------|------|
| D1 | Rebrand | **Complete → kstack** | `/kstack` command, `kstack_*` tools, `KSTACK_*` env, `kstack-*` skill ids, package renamed |
| D2 | Step model | **Hybrid** | phase = container of heterogeneous steps: interactive main steps + isolated delegated steps; **step = atomic unit of delivery of one skill** |
| D3 | DoD | **Two layers** | global workflow rules → managed block in target repo's AGENTS.md via install script; per-skill contracts → `## DoD gate` section inside each SKILL.md |
| D4 | Telemetry | **Keep local, upstream sync disabled** | `telemetry-log`/`question-log` absorbed; `telemetry-sync` (POST to upstream Supabase) disabled until kstack has its own endpoint |
| D5 | Memory layer | **Direction: sleep-phase + ACE + bi-temporal** | decision-log/search, learnings-log/search absorbed in S1 as-is (capability preserved); S5b redesign per research findings: consolidation across runs, delta never rewrite, valid_from/until, anti-poisoning write-gates |
| D6 | Catalog | **Single catalog in `skills/`** | each skill = dir with `SKILL.md` + colocated `references/` + `## DoD gate`; provenance in `<!-- provenance: ... -->` comment; multi-layer setup removed |
| D7 | Validation | **Re-validate from scratch** | sprint-beta merges NOT trusted a priori: every overlap cluster is re-analyzed from the raw files; merging allowed following skill-authoring best practices |
| D8 | Digest | **Removed** | `skills-distilled/` deleted in S1; `dod` survives as a SKILL.md section; injection machinery simplified in S3 |
| D9 | Expansion | **4 local skills in S1 + dedicated post-research sprint** | `impeccable`, `design-taste-frontend`, `mindrun`, `retro` (already in `~/.agents/skills`, gated by the rubric); the bulk of expansion after the user's research. NOTE: local `retro` ≠ catalog `gstack-retro` (weekly retro on commits/team — unused, drop candidate) |
| D10 | Gating | **I propose, the user decides** | tabular batch review for keep/rewrite/merge/drop |
| D11 | Skill id rename | **In S2 with the rebrand sweep** | S1 builds the catalog with current ids (`gstack-*`/`beta-*`); S2 renames ids + dirs. Double pass over paths accepted |
| D12 | Catalog layout | **Flat `skills/<id>/`** | no intermediate subdirs; pi discovers recursively |
| D13 | DoD gate source | **Parsed from SKILL.md** | `loadSkillGate(id)` extracts `## DoD gate` from the file; the `dod` field in `skills.ts` goes away — single source of truth |
| D14 | Compat rename | **Clean cut + data migration** | no `/gstack` alias; migration `~/.gstack`→`~/.kstack` and `.gstack/`→`.kstack/`; versioned state entries → pre-rename sessions abort cleanly |
| D15 | Runtime scripts | **Rename everything** | `gstack-*`→`kstack-*` including bodies with internal cross-calls |
| D16 | Identity | **Full rename** | repo `KedraVt/kstack-pi`, package `@kedra/kstack-pi`, extension dir `~/.pi/agent/extensions/kstack-pi` at end of S2 |
| D17 | Rule install | **`/kstack init` command** | writes/updates managed block `<!-- kstack:begin -->…end` in target repo's AGENTS.md — idempotent |
| D18 | Step model | **`steps[]` inside phase** | step = unit of work+skill; phase = unit of routing/gate/verdict. Phase without `steps` = single implicit step (backward compat) |
| D19 | Skill per step | **0 or 1, enforced** | two skills needed = two steps; mechanical steps have zero |
| D20 | Pre-flight gates | **human-gate \| selection-gate** | at startup the `/kstack` panel asks for the mode; selection-gate shows all gates in an auto\|human multi-select. Side-effect gates (commit/push/archive) marked ⚠, default human, toggleable. Subsumes `GSTACK_PI_OPTIONAL_PHASES` (kept as the non-interactive default) |
| D21 | Pilot | **develop.plan** | decomposed into 3 steps (interrogate/draft/eng-review); acceptance = **full develop run** on a real task |
| D22 | office-hours | **Split → `plan-draft`** | office-hours stays intact (manual); a lean plan-draft skill is extracted from its body for the draft step — created in S1-T5 via batch review |
| D23 | Loop rollout | **All workflows where natural** | develop: qa/review→implement; qa: report→fix→retest; investigate: verify→fix; review: findings→fix→re-review; ship: review blocks pre-push (post-push = park+rollback, never loop); sprint unchanged (reference); qa-report/quick none |
| D24 | Sprint in S4 | **Light review** | decompose only where the value is clear (e.g. system-design→[design\|adr]); the verdict/loop machinery stays untouched |
| D25 | New skills in S4 | **Step-first: gap → catalog task** | steps are designed per task; a missing skill becomes a creation task (authoring best practice) — mindrun and verification are the first cases |
| D26 | S4 sequence | **One workflow at a time** | develop first (the plan pilot lives in it), then investigate, qa, qa-report, ship, review, sprint-light; each workflow: spec → implement → verification run |
| D27 | S5 structure | **S5a + S5b + S6 backlog** | S5a foundation hardening; S5b structural; expansion (fleet/SLM/sandbox/RL/catalog) + telemetry endpoint → S6 backlog |
| D28 | Quick-win constraints | **Implement in S3/S4** | prefix-stable assembly, stuck/budget hooks, ledger+resume-gate → inside the S3 design; blocker-summary feedback → S4 loop machinery. S5a = additive work + tuning only |
| D29 | S5b order | **Eval → DAG → memory → rest** | pass^k + trajectory-diff first (measure before optimizing); then DAG executor; then sleep-phase memory; then judge/CodeAct/blast-radius |
| D30 | Research report | **Saved** | `Kstack/research-report.md` — source of the S5 choices |
| D31 | Memory backend | **Configurable + pluggable** | `memory.enabled` yes/no independent of backend — identical workflow with memory off. Two levels: append-only ledger = canonical verbatim store for decisions/verdicts (epistemic markers, git-audit); above it, pluggable backend `local` (FTS over JSONL, zero-dep default) or `supermemory` (opt-in self-hosted engine, NO fork — closed-source binary; kstack auto-spawn/stop per run; pin v0.0.9+ for loopback+auth; hosted MCP excluded unless the user chooses) |
| D32 | Env rename scope (S2) | **ALL `GSTACK_*` → `KSTACK_*`** | not just `_PI_`: root/home/state/remote/search/redact/supabase + prefix literals (`"GSTACK_PI_"`, `"GSTACK_CODEX_"`); every consumer is in this repo — no half-branded contract |
| D33 | SKILL_INJECTION (S2) | **Removed, not renamed** | post-S1 no-op stub: env read, `skillInjectionMode()`, `SkillInjectionMode` type, `_mode` param and `beta-injection.test.ts` removed |
| D34 | Skill id prefix (S2) | **`kstack-` uniform across the whole catalog** | including the locally ported skills (`impeccable`, `mindrun`, `retro`, `design-taste-frontend`) and the unprefixed ids (`adr`, `tasks`, …) |
| D35 | Data migration (S2) | **NOT in S2 — S6 backlog** | `~/.kstack` starts clean; the old `.gstack/` dirs stay in place; `kstack-migrate` task after S5b; no lazy shim — `gstack-wf-state` entries are ignored → pre-rename sessions abort cleanly (D14 holds) |
| D36 | Document dir (S2) | **Shared `skills/kstack-document/`** | one dir, two registry ids (`kstack-document-release`/`-generate`) via `dir:` — the "one dir per SKILL.md" invariant holds |
| D37 | Env authority (S2) | **`KSTACK_*` sole source** | no dual-read fallback to the old names; the code reads only `KSTACK_*` |

## Sprint skeleton

| Sprint | Title | Status |
|--------|-------|--------|
| S1 | Single skill catalog | **executed** |
| S2 | Independence + rebrand | **executed** (GitHub repo rename + extension dir remain — manual, D16) |
| S3 | Step model + pilot | **detailed** |
| S4 | Review + workflow migration | **detailed** |
| S5a | Evolution — foundation hardening | **detailed** |
| S5b | Evolution — structural upgrades | **detailed** |
| S6 | Expansion backlog | parking lot |

---

## S1 — Single skill catalog

**Goal**: a single skill catalog in `skills/`, each skill self-contained
(SKILL.md + references/ + `## DoD gate`), validated for usefulness and
effectiveness, no overlaps, no dependencies on `source/` or the upstream
pipeline.

**Precondition — upstream freeze** (immediately, before the audit):
delete `update.sh`, `scripts/sync-skills.ts`, `scripts/adapt-skills.ts`,
`scripts/gen-tools.ts` (their outputs stay frozen and committed);
`source/` marked read-only pending deletion at end of sprint.

### Tasks

- [ ] **T1 — Per-skill dependency audit.** For every skill in the three
  layers (~78 files: gstack 23, kedra 18, sprint-beta 37): which
  `source/bin` scripts, assets, references, memory-calls, telemetry-calls
  it actually references; which call sites are dead. Output: dependency
  table + `runtime/scripts/` absorption list + factual verdict
  "is the memory layer used by the skills that remain?" (feeds D5).
- [ ] **T2 — Overlap map.** Overlap clusters across the three layers
  (e.g. debug: `gstack-investigate` / `systematic-debugging` /
  `beta-debugging`; review: `gstack-review` / `code-audit-reviewer` /
  `beta-code-review`; qa: `gstack-qa` / `gstack-qa-only` / `qa-git` /
  `beta-qa`).
- [ ] **T3 — Validation from scratch.** For each cluster → a winner or
  a merge proposal (skill-authoring best practices). Rubric:
  (a) useful — solves a real problem in the workflows;
  (b) non-overlapping — complements the rest of the catalog;
  (c) effective — correct, non-dated methodology;
  (d) format contract consistent with its consumers (verdict parser, steps);
  (e) assets/references resolvable inside the skill;
  (f) zero upstream dependencies.
  **Live** spot-checks on format-critical skills and merges.
- [ ] **T4 — Batch review.** Per-skill table with keep / rewrite /
  merge / drop + reason + target step → user decision.
- [ ] **T5 — Single catalog build.** Approved merges/rewrites,
  flat layout `skills/<id>/` (D12) with **current** ids (rename in S2 — D11),
  colocated references, `## DoD gate` in every SKILL.md, provenance comment.
- [ ] **T6 — Porting the 4 local skills.** impeccable, design-taste-frontend,
  mindrun, retro (from `~/.agents/skills/`) → gated by the rubric;
  step mapping TBD
  (candidates: manual-only vs future design/pre-test steps).
- [ ] **T7 — Asset absorption.** `runtime/scripts/` for the referenced
  scripts (telemetry-log, question-log, decision-*, learnings-*,
  redact…), `jargon-list.json`, `ETHOS.md`, per-skill templates →
  rewrite of the ~600 paths in skill files.
- [ ] **T8 — Orchestrator repoint.** `skills.ts` REGISTRY → single catalog
  path (single `skillPath` instead of `fullPath`/`betaPath`/`distilledPath`);
  `dod` → `loadSkillGate(id)` that parses `## DoD gate` from SKILL.md (D13);
  `loadSkillSource` reduced to full-only; `GSTACK_PI_SKILL_INJECTION` removed.
- [ ] **T9 — Deletions.** `skills/gstack/`, `skills/kedra/`,
  `skills-distilled/`, `source/` (only after T5–T8 are green).
- [ ] **T10 — Tests.** Update `beta-injection.test.ts` and the tests that
  assume multiple layers/digest; `bun test` green.

### Canonical skill format (D6/D12/D13)

```
skills/<id>/
├── SKILL.md          # frontmatter: name, description
│                     # methodology body
│                     # mandatory last section: ## DoD gate
│                     # first body line: <!-- provenance: <source> · <date> -->
└── references/       # optional: colocated templates, taxonomies, checklists
    └── <asset>
```

Rules: no references outside its own dir (except
`runtime/scripts/` and `runtime/browse`); zero calls to non-absorbed
scripts; `## DoD gate` = verifiable checklist + output format contract.

### Sequence and dependencies

```
freeze → T1 audit → T2 overlap map → T3 validation → T4 batch review
                                                        ↓
                              T6 porting 4 locals ←── T5 catalog ──→ T7 assets
                                                        ↓
                                              T8 repoint → T9 deletions
T10 tests: continuous, at every commit point. T9 only on a green sprint.
```

### Artifacts

`Kstack/audit.md` (T1) · `Kstack/overlap-map.md` (T2) ·
`Kstack/review-table.md` (T4) · `Kstack/catalog-inventory.md` (final)

### Overlap map — initial draft (T2 input)

| Cluster | Candidate members | Existing beta merge |
|---|---|---|
| Debug/root-cause | gstack-investigate, systematic-debugging, agent-introspection-debugging, gstack-fix-strategy | beta-debugging |
| Code review | gstack-review, code-audit-reviewer, code-simplification, code-tour | beta-code-review |
| QA | gstack-qa, gstack-qa-only, qa-git | beta-qa |
| Security | gstack-cso, appsec-hardening, docker-manager, pipeline-sre | beta-security |
| Ship/release | gstack-ship, qa-git (ship part) | beta-ship |
| Plan/interview | office-hours, grilling, plan-ceo/design/devex/eng-review, autoplan, spec | — |
| Sprint/DDD | product-capability, system-design, adr, tasks, tdd, verification | — (copies) |
| Docs | document-release, document-generate | — |
| Memory/context | context-save, context-restore, learn, retro, strategic-compact | — |
| Browser ops | browse, scrape, skillify, setup-browser-cookies, pair-agent, open-gstack-browser | — |

To refine in T2: `code-simplification`/`code-tour` are probably
"code quality" not review; `agent-introspection-debugging` is self-debug,
a different domain from debugging user code.

### Non-goals S1

- Do not touch the acceptance criteria embedded in the BE/FE agent bodies.
- Do not modify `workflows.ts`/`executor.ts` (decomposition = S3).
- Do not rename skill ids / tools / env vars (S2 — D1/D11).

### Sprint DoD

- Every catalog skill passes the rubric and has a `## DoD gate`.
- No residual overlap: overlap map closed cluster by cluster.
- Zero references to `source/` or to non-absorbed scripts in the catalog.
- `skills/` contains a single layer; `source/` deleted.
- Tests green.

### Open

- Memory layer (D5): depends on T1.
- Catalog directory name: stays `skills/`; final rename in S2 with the rebrand.

---

## S2 — Independence + rebrand

**Goal**: zero functional references to the gstack name; complete kstack
identity; user data migrated; global rules installable via `/kstack init`.

### Rename surface (verified inventory)

| Surface | Entities | Notes |
|---|---|---|
| Env | 24 `GSTACK_PI_*` → `KSTACK_PI_*` | `SKILL_INJECTION` already dead in S1 |
| Orchestrator tools | `gstack_start`/`_advance`/`_phase` | + call sites in templates/spawn/test |
| Browse tools | 65 `gstack_*` names | `tools.generated.ts` via one-off script (gen-tools.ts deleted in S1) |
| Command | `/gstack` → `/kstack` | + `init` sub-command (D17) |
| State keys | `gstack-wf-state`, `gstack-delegation-event` | + `version` field (D14) |
| Target repo data | `.gstack/` → `.kstack/` | plans/, sprints/, runs/ |
| Data home | `~/.gstack` → `~/.kstack` | analytics, decisions, learnings |
| Runtime scripts | 21+ `gstack-*` + cross-calling bodies | D15 |
| Skill ids | uniform `kstack-*` | `beta-*` loses the prefix (the merge lives on in the provenance comment); unprefixed ids (`adr`, `tasks`) → `kstack-adr`, `kstack-tasks` |
| Identity | package, repo, extension dir | D16 |
| Docs/tests | README, AGENTS*.md, 6 test files | final sweep |

### Tasks

- [x] **T1 — Baseline.** `bun test` green pre-sweep + grep-driven surface
  checklist (regenerated from code, not from the plan).
- [x] **T2 — Skill ids.** Dir rename + `skills.ts` registry + cross-refs in
  skill text + references in `agents/*.md`.
- [x] **T3 — Tool names.** Orchestrator (3) + browse (65): one-off script
  on `tools.generated.ts`, `lib/commands.generated.ts`, call sites in
  templates/agent defs/tests.
- [x] **T4 — Env.** `GSTACK_PI_*`→`KSTACK_PI_*` in `config.ts` + callers +
  tests (literal rename, `_PI_` infix preserved). Widened to ALL
  `GSTACK_*` (D32).
- [x] **T5 — Command.** `/gstack`→`/kstack`; existing sub-commands
  (`next`, status…) preserved; no aliases (D14).
- [x] **T6 — State/data.** Entry type → `kstack-wf-state` with `version`
  field (bump to 3); `.gstack/`→`.kstack/` in orchestrator paths;
  pre-rename entries ignored → sessions abort cleanly. Data migration
  deferred to S6 (D35).
- [x] **T7 — Script rename.** `runtime/**/gstack-*`→`kstack-*` bodies
  included; shebang/usage text; call sites in skills. Deviation:
  `gstack-update-check` and `gstack-team-init` removed (upstream-coupled
  machinery with no callers — same rule as update.sh in S1).
- [x] **T8 — Identity.** `package.json` → `@kedra/kstack-pi`; GitHub repo
  renamed (automatic redirect); `download.ts` RELEASE_BASE updated to the
  first kstack release (until then it points at the existing v2.0.0
  release, redirected); extension dir renamed — manual step at end of sprint.
- [x] **T9 — `/kstack init`.** Sub-command that writes the managed block
  `<!-- kstack:begin -->…<!-- kstack:end -->` in the current repo's
  AGENTS.md. Baseline content: verdict format `KEY == VALUE`, `## HANDOFF`
  contract, Iron Law (no fix without root cause),
  verification-before-completion, report-only constraints, security red
  lines. Idempotent: update if the block exists; upgrade legacy
  `<!-- gstack:begin -->` blocks.
- [x] **T10 — Docs + tests.** README/AGENTS*/AGENTS_NOTES sweep; test
  string fixes; `bun test` green.

### Sprint DoD

- `rg -i gstack` on the extension code = 0 (excluding provenance
  comments and changelog; RELEASE_BASE URL until the repo is renamed —
  comment in `lib/download.ts`).
- Data migration deferred to S6 (D35): the `kstack-migrate` task is
  tracked in the backlog, fixture tests planned there.
- `/kstack init` idempotent: second run = no-op. ✅
- `bun test` green. ✅

### Open

- Exact managed-block content: baseline now, evolves in S3 with
  verdict/step format.
- GitHub repo + extension dir rename timing: manual, at end of sprint.
- Post-merge: `graft reindex` in the worktree; RELEASE_BASE flips to the
  first `kstack-pi` release.

## S3 — Step model + pilot

**Goal**: phases decompose into steps; each step gets its **own** skill
just-in-time (0 or 1, enforced — D19); hybrid main/delegated isolation;
pre-flight gate config; pilot on `develop.plan` with **full develop run**.

### Data model

```ts
interface WorkflowStep {
  id: string;
  execution: "main" | "subagent";
  agent?: string;        // delegated steps
  task: string;          // instructions, {previous}/{x}_summary interpolation
  skill?: string;        // 0 or 1 — enforced
}
```

`WorkflowPhase` unchanged on `optional`/`skipWhen`/`advance`/`loopBackTo`/
`maxAttempts`/`feedbackFrom`/`variant`; `steps?: WorkflowStep[]` is new —
absent = single implicit step (non-migrated workflows are untouched).
Legacy `agent`/`task`/`skills`/`chain` remain for non-migrated phases.

### Mechanics

- **Main step**: instructions (task + full skill) → followUp → model works
  → `gstack_advance` completes the step → next step's instructions.
- **Delegated step**: existing chain machinery (spawn, HANDOFF, timeout,
  circuit-breaker) — per-process isolation.
- `{previous}` = last delegated `## HANDOFF` or the main step's summary.
- Verdict = parse of the last step's output in the phase (phase-level).
- State: `stepIndex`, `results["phase.step"]`, `gateMode`, `gateOverrides`.
- Delivery: full skill on first delivery per skill-id in the run; repeat →
  only `## DoD gate` parsed from SKILL.md (D13). `skillsDelivered` stays.
- Resume: context includes the current phase **and** step.

### Pre-flight gate config (D20)

- New `configure` status at workflow start: the `/kstack` panel offers
  `human-gate` (current behavior) | `selection-gate`.
- `selection-gate` → multi-select over all gates (manual, entry-gate,
  optional): each marked auto|human; optional phases also accept
  skip. Required phases are never skippable.
- Side-effect gates (commit-archive, push): listed, marked ⚠, default
  human, toggleable.
- Persisted in state (`gateMode`, `gateOverrides`) → survives resume.
- `GSTACK_PI_OPTIONAL_PHASES` remains as the non-interactive default.

### Pilot — develop.plan

```
plan (advance: manual, gate at end of phase)
├── s1 interrogate   (main, skill: grilling)
├── s2 draft         (main, skill: plan-draft — new, D22)
└── s3 eng-review    (main, skill: plan-eng-review)
```

The rest of develop stays implicit-single-step → mixed interop is part
of the verification. Acceptance: full run on a small real task.

### Tasks

- [ ] **T1 — Types.** `WorkflowStep`, `steps[]` on phase; state:
  `stepIndex`, per-step results, `gateMode`, `gateOverrides`, `version` bump.
- [ ] **T2 — Executor.** Main+delegated step iteration, `{previous}`
  plumbing, per-step resume, in-flight guards at step level.
- [ ] **T3 — Templates.** `buildStepInstructions` (task + skill);
  step-aware resume context; full/gate-on-repeat delivery.
- [ ] **T4 — skills.ts.** `loadSkillGate(id)` parses `## DoD gate` from
  SKILL.md (lands D13 in code).
- [ ] **T5 — Pre-flight.** `configure` status, mode selection in the
  panel, `gateOverrides` consulted by advance/gate machinery.
- [ ] **T6 — Pilot.** develop.plan decomposition (depends on
  `plan-draft` created in S1-T5 — D22).
- [ ] **T7 — Tests.** Step state machine, gate overrides, mixed interop,
  sprint verdict/loop regression intact.
- [ ] **T8 — Full develop run.** On a small real task; verify per-step
  delivery, resume, gate, handoff toward implement.

### Sprint DoD

- develop.plan runs as 3 steps, each with its own skill — no more
  triple injection.
- selection-gate works: human-marked gates pause, the others advance.
- Mid-step resume survives restart.
- Sprint verdict/loop machinery intact (regression green).
- `bun test` green.

### Research constraints implemented here (D28)

- **Byte-stable prefix** (finding 2.1): `buildStepInstructions` assembles
  tools→system→skill→contract in fixed order; volatile deltas (verdict,
  resume, retry) only at the tail of the message, never in the prefix.
  Hook for per-phase `cache_read`/`cache_creation` telemetry.
- **Stuck-detector + budget caps** (2.6): the step runner is born with
  hooks — 5 OpenHands rules (identical action-obs ≥4×, action-error ≥3×,
  monologue ≥3, alternating pairs ≥6, repeated ctx-error) + multi-dim
  budget (turns/tokens/USD/wall-clock/cost-velocity), soft-warn ~80% →
  hard-kill → park.
- **Append-only ledger + gates** (2.8): results/verdicts/artifacts on an
  append-only ledger with frontmatter (`.kstack/ledger/`), never just a
  transient message; resume-gate + precompact-gate (block
  compaction/transitions until artifacts are flushed);
  constraint/verdict fields always verbatim, never compressed.
- **Retry feedback** (2.6/CCRM): cap ~3 attempts (marginal recovery
  23→11→8→5%), then park — already aligned with existing loop ceilings.

### Open

- Context accumulation between consecutive main steps: compact/handoff
  mitigation → S5 candidate.
- Step-level gates: the type allows it in the future, not built now.
- `quick` (no gates): pre-flight is a no-op, to be verified.

## S4 — Review + workflow migration

> **AMENDMENT (S4 design session, user-approved):** the plan below was
> written for the 8-workflow gstack catalog. The approved catalog is now
> **6 workflows** — `develop`, `sprint`, `investigate`, `review`,
> `discover`, `audit` (ADR-11 in `ADR-log_01.md`). `qa`, `qa-report`,
> standalone `ship` and `quick` are REMOVED (their cases live inside
> `review`/develop/sprint phases); `discover`/`audit` are new. The D23
> loop table and D26 order below are SUPERSEDED by the approved
> per-workflow specs and verdict/loop maps in
> `Kstack/workflow-redesign.md`. Tasks T1–T11 below are SUPERSEDED by
> the sprint backlog `tasks.md` (types+records done; verdict engine,
> panel machinery, executor, migration, skills, `kstack init`,
> verification). New machinery decided after this section was written:
> `asks[]`/`state.vars`, `enabled:"auto"`+derived skippability,
> `ambientSkills`, `signal`-based completion, `parkOn`, capabilities,
> `ephemeralArtifacts`/handoff dirs, resume-mode, `kstack init`,
> parallel lanes, ephemeral-subagent model — all specced in
> `system-design_01.md` §10 + ADR-11..23.

**Goal**: every workflow **redesigned**, not just migrated — decomposition
into steps, skill assigned per task (step-first: gap → new skill, D25),
verdict loops where natural (D23). Sprint = reference with light review
(D24). Draft decompositions: `Kstack/workflow-redesign.md`.

### Method — one workflow at a time (D26)

```
for each workflow:  redesign spec (grilling → approval)
                 →  steps + loops + skill map implementation
                 →  end-to-end verification run
                 →  feedback into the next redesign
```

Order: **develop** (the plan pilot lives in it) → investigate → qa →
qa-report → ship → review → sprint-light → quick (no-gate edge case).

### Loop rollout (D23)

| Workflow | Loop | Ceiling |
|---|---|---|
| develop | qa FAIL → implement · review REQUEST_CHANGES → implement | maxAttempts |
| qa | report FAIL → fix → re-test | bounded |
| investigate | verify persists → fix (refuted → root-cause) | bounded |
| review | findings REQUEST_CHANGES → fix → re-review | bounded |
| ship | review blocks push pre-push; verify post-push fail → park + rollback path | never loop post-push |
| sprint | unchanged — reference implementation | — |

All reusing the sprint machinery: deterministic verdict parse,
feedback from the artifact, park on unreadable verdict.
**Research constraint (D28)**: loop-back feedback is the **summarized
blocker**, never the raw trace (CCRM: failed attempt in context
×7.1 per-step error).

### Tasks

- [ ] **T1 — Per-workflow redesign spec.** For each: step decomposition,
  skill map (step-first → gap = new skill), loop, gate; spec in
  `Kstack/workflow-redesign.md` → per-workflow approval.
- [ ] **T2..T8 — Per workflow**: steps + loops implementation + verification
  run (develop → investigate → qa → qa-report → ship → review →
  sprint-light). develop already includes the S3 plan pilot.
- [ ] **T9 — Final registry→step mapping.** `skills.ts` REGISTRY
  aligned with the post-S1 catalog; skills without a step → marked
  manual-only or dropped (loop back to S1-T4 if they surface).
- [ ] **T10 — Legacy removal.** `agent`/`task`/`skills`/`chain` phase
  fields removed once all phases are `steps[]`; legacy
  injection/tiering cleaned up.
- [ ] **T11 — Docs.** README, AGENTS_NOTES, catalog README, agent def
  comments aligned with the step model.

### Sprint DoD

- Every workflow decomposed into steps, each step with 0-1 mapped skill.
- Verdict loops active where planned, with ceiling and park on unreadable.
- No legacy fields on phase; verification run green for every workflow.
- `bun test` green; catalog and workflows consistent (no unjustified
  orphan skills).

### Open

- Draft decompositions in `Kstack/workflow-redesign.md` — starting
  point, each workflow is refined in its redesign spec (T1).
- Candidate skills from the draft: `mindrun` (pre-implement step),
  `verification` (self-check/verify everywhere), `tdd` (fix/regression
  steps), `plan-draft` (already D22).

## S5a — Evolution: foundation hardening

Additive quick wins + completion/tuning of what S3/S4 already
implemented for D28. Source: `Kstack/research-report.md`.

### Work-streams

- [ ] **W1 — Phase tool masking** (finding 2.4). Per-phase deterministic
  whitelist over the 65 browse tools (investigate→read/grep, qa→browse…);
  beats semantic retrieval, zero miss-risk. + description engineering
  on tool descriptions where needed.
- [ ] **W2 — Datamarking untrusted payloads** (§security). Marking of
  browser output and all untrusted content before it enters the
  context (<2% ASR).
- [ ] **W3 — Cache telemetry** (2.1). Measure per-phase cache_read/creation
  on the already byte-stable S3 assembly; breakpoint budget 1h+5m;
  tuning.
- [ ] **W4 — Stuck/budget/ledger tuning** (2.6/2.8). The detectors were
  born in S3; here real thresholds, reserve-then-settle for concurrent
  phases, and verification of resume/precompact gates on real runs.

### DoD

- Per-phase tool masking active; cache hit-rate measured and stable;
  browser payloads marked; detectors calibrated on real runs.

## S5b — Evolution: structural upgrades

Order decided (D29): measure → architecture → memory → judgment →
interface → push.

- [ ] **W1 — Eval harness** (2.11). `pass^k` for orchestrator flakiness;
  trajectory-diff (DAG+LCS, first-divergence primitive) as a workflow CI
  gate; rigorous stats (Wilcoxon/Bayesian, trialCount≥3 → stable/flaky
  label). Without this every later upgrade is vibes.
- [ ] **W2 — DAG executor** (2.3). ~150 LOC: planner emits a DAG once,
  runtime executes in level-synchronous waves, per-node trigger rules
  (all_success/none_failed/one_success), joiner-verdict;
  **verdict-nodes appending nodes = bounded replanning**. Complements
  the phase machine, doesn't replace it.
- [ ] **W3 — Memory redesign** (2.9, resolves D5, D31 architecture).
  Memory interface with `enabled` yes/no + `local|supermemory` backend;
  canonical verbatim ledger for decisions/verdicts; optional semantic
  backend for learnings. Sleep-phase consolidation across runs;
  learnings as incremental deltas never rewritten (ACE); bi-temporal
  edges valid_from/valid_until; write-gates + anti-poisoning trust
  scoring; ADD/UPDATE/DELETE/NOOP ops vocabulary. Supermemory backend:
  lifecycle managed by kstack (spawn/stop per run), pin v0.0.9+.
- [ ] **W4 — Judge protocol** (2.7). n≥3 cross-family votes (never the
  generator's family), weighted-boolean rubric, CANNOT_ASSESS escape,
  TPR+TNR≥0.90 calibration on ≥100 labeled traces.
- [ ] **W5 — CodeAct tier** (2.5). The 65 browse tools → TypeScript
  `search`+`execute` API; intermediates in the sandbox. Keep the
  parallel-calls path (caveat −14.1%).
- [ ] **W6 — Blast-radius push** (2.2). graft → blast-radius injected
  into context at edit time, without the agent asking for it.

### DoD

- Eval harness measures a known regression (test on a recorded run);
  DAG executor runs a real workflow in waves; memory consolidated across
  two runs; at least one calibrated multi-judge verdict.

## S6 — Expansion backlog *(parking lot, unscheduled)*

- Best-of-N fleet: worktrees, atomic claim-locks, merge preflight matrix,
  honest-skip — **only after decomposable verification oracles**.
- SLM FAST tier: constrained router + SLM arg-gen + constrained decoding +
  STRONG→FAST distillation.
- Eager dispatch during streaming + deterministic prefetch of phase setup.
- `srt` sandbox on spawned processes + secret-substitution-at-egress.
- RL-ready records: token-faithful request/response + trajectory IDs +
  loss masks (the orchestrator is already the boundary where RL attaches).
- Post-research skill catalog expansion (user list + gaps surfaced in
  S4 — D9/D25).
- Own telemetry endpoint (D4) if ever desired.
- Remote A2A/adapters only if external agents are needed.
- **Pre-rename data migration** (D35, after S5b): `kstack-migrate` script
  that moves `~/.gstack`→`~/.kstack` (analytics, decisions, learnings) and
  `.gstack/`→`.kstack/` in target repos (plans/, sprints/, runs/) —
  with fixture tests.

### Avoid (recorded by research — don't waste time)

Multi-agent debate/mesh · semantic cache over deterministic phases ·
full GraphRAG · global auto-prompt-optimization on skills ·
Reflexion/self-check as a gate · vendor SOTA web-agent · SaaS
observability · "checkpointing = durability" without fencing.
