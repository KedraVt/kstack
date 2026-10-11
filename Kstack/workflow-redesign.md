# Workflow redesign — step decompositions (S4-T1)

Working document: per-step decomposition of every workflow. Each row
`[step · skill]` — `—` = mechanical step with no skill (D19). Each
workflow is refined and approved in its redesign spec during S4.

Legend: `⚠` side-effect gate · `⟲` verdict-bearing (loopBackTo) ·
`(opt)` optional · `[main]` implicit where not marked delegated.

All project artifacts are written in English.

---

## develop — APPROVED (S4 design session, user)

Identity: lean intent→merge path for a feature that doesn't revolutionize
the project. `document` BEFORE `ship` (docs land in the diff); ship is
the last side effect; retro closes it. Speed comes from subtracting
ceremony, not judgment.

**Setup**: `asksScope: true` — at start (same UI as phase-selection)
the user declares `scope: frontend|backend|mixed` (default `mixed`).

| Phase | Step | Exec | Skill | Note |
|---|---|---|---|---|
| explore | scout | del | — | required; graft-first in the agent def |
| plan | evolve → interrogate → draft → eng-review → design-review | main | idea-refine · grilling · plan-draft · plan-eng-review · plan-design-review | NO loop (fix-forward); `advance: manual`; design-review `skipWhen: scope:backend` + internal self-exit |
| implement | build → walkthrough → ui-check | del | tdd · lite-mindrun · impeccable | build `ambientSkills: [ponytail, taste(cond), AC(scope)]`; `walkthrough` verdict → loop `build`; `ui-check` `skipWhen: scope:backend`, verdict `ui` → `build` |
| qa-browsing (opt) | test | del | qa | `requires: browse`; `ambientSkills: [AC(scope)]`; verdict `status` → `implement` |
| review | review | del | review | mono-step; verdict `code-review` → `implement` |
| document (opt) | document | del | document | 1 step; end of life of the ephemeral docs |
| ship (opt) | ship | del | ship | `sideEffect` → entry gate ⚠ |
| retro (opt) | retro | main | retro | session environment-tuning; advisory |

### Ephemeral THINK docs (2 files, same lifecycle)

`evolve` writes **`understand.md`** (one-pager: direction, actors,
options) → `interrogate` appends decisions → `draft` reads understand.md
and writes **`plan.md` as a new file** (8 sections, incl.
`## Implementation tasks` with falsifiable `Done when` + `## Scope`)
→ `eng-review` annotates plan.md + REVIEW REPORT with the
`UNRESOLVED DECISIONS` line visible at the gate → plan.md consumed by
implement/qa/document → **both deleted at run terminal status**
(`state.ephemeralArtifacts` + ledger event). Semantic split:
understand = *what we decided* (raw); plan = *how we build it*
(engineered). `kstack-idea-refine` always emits `understand*` (path from
task); `kstack-plan-draft` does not mutate — it produces.

### Verdict/loop map

`walkthrough`(fail) → `build` · `ui-check`(fail) → `build` ·
`test`(status red/orange) → `implement` · `review`(rejected) → `implement`.
Plan: no loops — eng-review applies fix-forward, only genuine trade-offs
remain as `UNRESOLVED DECISIONS` at the manual gate.

### New machinery required by this design

- `step.ambientSkills?: string[]` — behavioral skills injected into the
  task (outside the task-skill slot). Restated rule: **0-1 task skill
  per step; ambient skills separate**. Entries conditionable on scope.
- `workflow.asksScope` + `state.scope` + `step.skipWhen` (conditions
  `scope:` and `requires:` capability) — see machinery constraints §5-6.
- `state.ephemeralArtifacts: string[]` + delete on terminal status.
- Loops: phase self-loop (walkthrough→build) to verify at the router;
  dynamic `feedbackFrom` (implement receives from multiple phases).
- `kstack init` writes ~2 behavioral rules in the target repo's
  AGENTS.md (evidence-before-claims, minimalism) — deterministic channel
  that also reaches spawned subagents.
- Capability degradation: `skip` when the step is useless without the
  capability (browse for qa-browsing), `degrade` when the core survives
  (static ui-check without DOM).

### New workflows emerged (S4 deliverables)

- `discover` — dedicated workflow for `kstack-office-hours` ("I want to
  improve the product but don't know what").
- `audit` — dedicated workflow for `kstack-mindrun` (interactive, as-is).

## investigate — APPROVED (S4 design session, user)

Identity: **production hotfix** — the user finds a bug in prod and it
must be fixed. Urgency with rigor: minimal blast radius, no opportunistic
refactoring. Iron Law: no fix without a **confirmed** root cause.
Boundary: "existing behavior broken vs intended" — if root-cause
concludes not-a-bug/missing-feature → **park + handoff to develop**
(never scope creep disguised as bugfix). **No `asksScope`**: scope is
determined by the bug (from the fix's diff), not declared by the user.

| # | Phase | Steps | Exec | Skill | Note |
|---|---|---|---|---|---|
| 0 | explore | scout | del | — | graft-first |
| 1 | reproduce | triage→repro | main | triage·investigate | `triage` = diagnostic intake interview (on-call operator; **one question at a time**, each answer cuts branches) → ephemeral `bug-report.md` (with explicit `## Ruled out`); `repro` → **failing test** (checkpoint + future regression guard); no-repro → park |
| 2 | root-cause | trace→validate | main | investigate | trace: hypothesis→experiment on bug-report; validate: **confirmatory** experiment (hypothesis≠cause until proven); RCA → ledger |
| 3 | fix | patch | del | tdd | minimal patch — prod = no refactors |
| 4 | verify | verify | del | lite-mindrun | trace of the fix against the cause; verdict `outcome`: `persists`→`fix` · `refuted`→`root-cause` (first real multi-target `loopBackOn`) |
| 5 | regression-qa | test | del | qa | `enabled: auto` — browse if the fix touches UI; backend-only → degrade to code-level regression check; may auto-skip if verify+suite cover |
| 6 | retro | retro | main | retro | `enabled: auto` — a prod bug = an environment flaw; retro reads the bug as a symptom of the process ("which check was missing?") |

Skills: `kstack-triage` ✅ written (new, 156 lines, DoD verified) —
wiring pending at implementation. `kstack-investigate` covers
repro+trace+validate (same methodology, different steps/activities).

## qa — REMOVED (workflow)

Never used standalone (user confirmed). Real cases are covered by
`review` with internal `qa-browsing` + the qa-browsing phases of
develop/sprint/investigate. `kstack-qa` remains a skill used by phases.

## qa-report — REMOVED

Was "qa without fix" — died together with the `qa` workflow itself
(never used standalone).

## ship — REMOVED (workflow)

The `ship` phase stays inside develop/sprint; the standalone workflow
died of overlap ("why do you exist if your phase already does?").

## quick — REMOVED

gstack leftover. "Quick" and "workflow" contradict each other: if no
ceremony is needed, kstack isn't needed. If the need for minimal tracked
runs resurfaces, the steps[] machinery supports a degenerate workflow.

## review — APPROVED (S4 design session, user)

Identity: evaluates code **not produced by a run** — external PRs, own
diffs outside workflows, dirty worktree. The tail forks on the `target`
declared at the panel (`asks: [{var: target, options: [external, own]}]`
— generalization of asksScope): **external → `comment` (judgment, no
fix); own → `fix` (patch + re-review)**.

| # | Phase | Steps | Exec | Skill | Note |
|---|---|---|---|---|---|
| 0 | explore | scout | del | — | blast-radius-aware: `graft callers` on symbols touched by the diff |
| 1 | diff | resolve | main | — | mechanical: PR#/branch/range/worktree → materializes the diff |
| 2 | findings | review | del | kstack-review | verdict `code-review` |
| 3 | qa-browsing | test | del | kstack-qa | `enabled: auto` — browse if UI in the diff; verdict `status` |
| 4a | comment | post | main | kstack-review-comment | `skipWhen: target:own`; ⚠ sideEffect gate before `gh pr review` — never publish without confirmation |
| 4b | fix | patch | del | kstack-tdd | `skipWhen: target:external`; bounded loop → `findings` |
| 5 | retro | retro | main | kstack-retro | `enabled: auto` |

`kstack-review-comment` ✅ written (new, 176 lines): re-classifies
findings (doubt→question), anatomy what·why·how·file:line, single batch
`gh api .../reviews`, verdict = f(#blocking), headless fails-closed.

## discover — APPROVED

Identity: "I want to improve the product but don't know what" — product
discovery conversation, not code (no scout).

| # | Phase | Steps | Exec | Skill | Note |
|---|---|---|---|---|---|
| 0 | session | session | main | kstack-office-hours | uses the skill **as-is** for now; → `.kstack/discover/direction.md` (**not ephemeral**: cross-run handoff input — outlives terminal status) |

Handoff: run end suggests `develop`; develop.evolve reads direction.md
as input instead of a raw idea. No verdict/gate.

**Debt**: `kstack-office-hours` needs revision (too long, parts
unrelated to the domain) — explicit backlog task, candidate for the
first real `develop` run. Until then discover uses the base version.

## audit — APPROVED

Identity: structured codebase re-read — the detector, not the fixer.
Audit *is* explore pushed to the maximum: no scout.

**Why a workflow and not a callable skill**: the artifact is the
justification — `findings.md` written **incrementally** during the walk
= progress checkpoint (real resume on a long run) + handoff queue to
`investigate` + run tracked in the ledger. Without the artifact it
would be "mindrun in chat" → ceremony without value.

| # | Phase | Steps | Exec | Skill | Note |
|---|---|---|---|---|---|
| 0 | walk | walk | main | kstack-mindrun | full interactive version; → `.kstack/audit/findings.md` incremental (not ephemeral: cross-run handoff — each finding can become an `investigate` run) |

**Artifact rule (general)**: project-root = doc-chain consumed within
the run (ephemeral) or archived (durable `_XX`); **cross-run handoff
artifacts** = `.kstack/<workflow>/`, lifetime independent of the run.

## kstack init — decided

Command exposed by the extension, run **in the target repo**, per-repo,
once. Does:

1. **AGENTS.md managed block** — `<!-- kstack:begin v1 -->`…`<!-- kstack:end -->`,
   authored with writing-for-agents. v1: 2 rules (evidence-before-claims,
   minimalism). Re-run → "already run — run `kstack init --update`";
   `--update` rewrites ONLY the block to the current version (bump v) +
   reinstalls missing defs + re-probes — never stomps outside markers.
2. **Capability probe** — graft·browse·node·gh·design.exe →
   `state.capabilities`; for each missing: what is lost + install hint.
3. **Agent defs** — installed if absent (5 ported defs).
4. **`.kstack/` scaffold** — runs/, ledger, config.
5. NOT repo-hints (Dockerfile/CI) — `enabled:auto` resolves at runtime.

## Capabilities & UI — rules

- `state.capabilities.{graft,browse,node,gh,design}` — probed at init.
- `requires:` (skip if absent) vs `prefers:` (degrade + `~capability: no-X`
  note). graft: `prefers` everywhere (rg fallback).
- `capability.ui: headless | interactive` — no visible windows unless
  the step's purpose IS user interaction (login/captcha/inspect).
  browse: managed headless Chromium, never attach to the user's session.

## Authoring skills — clarified

- `.devin/skills/authoring-skills/` = S1 build-time pipeline (our
  tooling in this repo — baseline→router→eval→ship). Stays there.
- `writing-for-agents` → port `kstack-writing-for-agents` for runtime
  use (retro, init block). The 4 skills written in S4 were authored
  with writing-for-agents + sibling templates + catalog research.
- **Authoring gate**: every new/revised kstack-* skill goes through the
  authoring-skills pipeline — at minimum Phases 0-4 + pre-flight.

## Final catalog — 6 workflows

`develop` · `sprint` · `investigate` · `review` · `discover` · `audit`.
`kstack-qa` remains a skill (qa-browsing phase everywhere); `kstack-ship`
remains a skill/phase inside develop·sprint.

## sprint — APPROVED (S4 design session, user)

Same deterministic base as develop (`asksScope`, `ambientSkills`,
verdicts via `kstack-report`, `loopBackOn`, ephemeralArtifacts). The
difference: **durable** artifacts are the project's backbone — at run
end only `system-design_XX.md` and `ADR-log_XX.md` survive (long-term
decision memory).

**Naming**: `_XX` exists to name the archive slot → only durable
artifacts carry it. Ephemerals are flat: `understand.md` `user-story.md`
`capability.md` `tasks.md` `summary_BE/FE.md`. Verifiers (qa, devsecops,
docker, pipeline) **write no files**: findings go in `--evidence` of
the record (or `--deliverable` → file inside `.kstack/runs/<run>/` if
massive).

**Setup**: `asksScope: true` (+ `parallel: yes/no`, default no, shown
only when `scope: mixed`) → `state.scope` drives implement.

| # | Phase | Steps | Exec | Skill | Note |
|---|---|---|---|---|---|
| 0 | explore | scout | del | — | graft-first in the agent def |
| 1 | understand | evolve→interrogate | main | idea-refine·grilling | → `understand.md` (ephemeral; evolve creates it, interrogate appends) |
| 2 | user-story | story | main | product-capability | → `user-story.md`; falsifiable ACs in the doc (skill's DoD) |
| 3 | capability | constraints | main | product-capability | → `capability.md`; enumerated trust boundaries → risk-scan input |
| 4 | system-design | design→risk-scan→adr | main | system-design·**risk-scan**·adr | → `system-design_XX`+`ADR-log_XX` (durable); risk-scan: STRIDE-lite, no verdict, in-session fixes, unresolvable→open decision at the gate |
| 5 | architect-gate | review | del(software-architect) | system-design | verdict `software-architect-review`→`system-design` (bounded); approved→**manual gate** |
| 6 | backlog | tasks | main | tasks | `ambient: AC[scope]`; → `tasks.md`; in-scope tasks only; required-but-out-of-scope tasks marked `~out-of-scope`; emits var `parallel-safe` |
| 7 | implement | backend→be-walk→frontend→fe-walk→ui-check | del | tdd·lite-mindrun·impeccable | FE+fe-walk+ui-check `skipWhen: scope:backend`; ambient: ponytail+AC-FE+taste on frontend, ponytail+AC-BE on backend; walkthrough loops to its own builder; **parallel**: `(backend→be-walk) ∥ (frontend→fe-walk→ui-check)` if opt-in+safe |
| 8 | qa-browsing | test | del(qa-engineer) | qa | `ambient: AC[scope]`; `requires: browse`; verdict `status`→`implement`; **before** devsecops |
| 9 | devsecops-review | code-review→security | del(devops-devsecops) | review·cso | dual verdicts `code-review`+`security-review`→`implement`; `severity==red`→freeze typed-unfreeze |
| 10 | docker-review | audit | del | docker-manager | `enabled: auto` (Dockerfile present and touched); verdict `docker-build`/`docker-security`→`implement` |
| 11 | pipeline-review | audit | del | pipeline-sre | `enabled: auto` (CI config present and touched); verdict `pipeline`→`implement` |
| 12 | archive | archive | main | — | moves only durables to `sprints/sprint_XX/` |
| 13 | retro | retro | main | retro | |

### Rules decided in this design (general)

- **`enabled: on|off|auto` on EVERY phase** — `auto` resolves on
  computable state (detected files, touched diff, tasks.md). "User
  choice" phases are really `auto`+override: the engine detects, the
  user forces. **Derived** skippability: `produces:`/`requires:` per
  phase → skippable ⟺ no enabled phase requires its output (the panel
  computes it — never a broken run by construction).
- **Completion signal per step** — every step declares `verdict` |
  `artifact:path` | `marker`; the router advances only on an observed
  signal. Historical fix for "ghost main-steps". Explicit-empty output
  = a deliverable (`## Risks: none found` is a line).
- **Verdicts vs routing-vars**: verdicts = judgments → **delegated
  only** (never self-certification). Routing-vars = facts
  (`parallel-safe`, `feedback-type`) → emittable via `kstack-report` by
  whoever knows them (main included). Missing var → safe default
  (missing `parallel-safe` ⇒ sequential).
- **feedback-type in the record**: `code`→loop implement (default);
  `spec`→park (the human decides whether to reopen backlog — never
  auto-re-run tasks on a broken spec).
- **Severity**: an ordinary var; configurable outcome — `advance`·
  `loopBackOn`·`parkOn` (devsecops: `parkOn:{red: freeze}`; elsewhere
  standard park).
- **Parallel**: `scope==mixed` + panel opt-in + `parallel-safe==true`
  (0 cross-role deps + BE∩FE file-set=∅, read from tasks.md). The
  file-set disjointness also makes per-lane resume clean.
- **Resume = step boundary, never mid-step**: missing signal → step
  re-runs in **resume-mode** ("continue from disk state": diff+test
  suite are the builders' progress oracle; writers overwrite; appenders
  dedup-check). Crash/quota do NOT consume maxAttempts — ledger event
  `run-interrupted`/`quota-parked`, not `phase-verdict`.
- **Ephemeral subagents**: `spawn→work→report→exit`. Shared memory =
  artifacts+records+ledger, never live processes. Cache: provider-side
  prefix-caching (task template: stable context first, feedback last);
  optional persistent session only for intra-phase loops (bounded hold
  during own verifier).
- **Check ordering by cost**: cheap near the producer, expensive once
  downstream (risk-scan in main pre-gate; qa before devsecops).
- **AC banks = ambient skills** `kstack-acceptance-criteria-{be,fe}`
  (not AGENTS.md: everyone would always load them). Placement: sprint
  backlog.tasks/implement.{be,fe}/qa-browsing.test; develop
  implement.build/qa-browsing.test — always scope-conditional.
- Vars preserved: `status` `code-review` `security-review` `docker-build`
  `docker-security` `software-architect-review` `severity`. New:
  `walkthrough` `ui` `pipeline` `parallel-safe` `feedback-type` →
  (workflow,phase)-keyed expectations map.
- **Agent defs to port** (agents-clean→pi subagent defs):
  `software-architect` `backend-developer` `frontend-developer`
  `qa-engineer` `devops-devsecops`.

---

## New/modified skills emerged (catalog input — D25)

| Skill | Target step | Origin | Status |
|---|---|---|---|
| kstack-idea-refine | develop.plan/evolve · sprint.understand/evolve | MIT port addyosmani/agent-skills | ✅ written — **to update**: always emits `understand*.md` (path from task) |
| kstack-lite-mindrun | develop.implement/walkthrough · sprint.implement/{be,fe}-walk · investigate.verify | derived from kstack-mindrun: DoD grid, verdict, zero artifacts | ✅ written — **contract gap**: hard-codes grid-from-plan + `walkthrough == pass|fail`; investigate.verify needs `outcome: persists|refuted` grading the fix against its cause — add a second verdict mode or a sibling |
| kstack-plan-draft | develop.plan/draft | +Implementation tasks, open-questions-none | ✅ refined — **to update**: input `understand.md` → output new `plan.md` |
| kstack-plan-eng-review | develop.plan/eng-review | +orchestrated mode, fidelity check, fix-forward | ✅ refined |
| kstack-risk-scan | sprint.system-design/risk-scan | **NEW** — thin (~100 lines): STRIDE-lite on design doc, reads trust boundaries from capability.md, main exec, no verdict, in-session fixes | to write |
| kstack-triage | investigate.reproduce/triage | **NEW** — diagnostic intake interview (operator), one question at a time, → bug-report.md | ✅ written (156 lines, DoD verified) — wiring pending |
| kstack-review-comment | review.comment/post | **NEW** — findings→batched review on external PR: blocking/suggestion/nit/question taxonomy, ⚠ sideEffect gate | ✅ written (176 lines, DoD verified) — wiring pending |
| kstack-acceptance-criteria-{be,fe} | ambient on backlog/implement/qa-browsing (sprint) · build/qa-browsing (develop) | port agents-clean acceptance-criteria-* | to port (2 skills, ambient-marked) |
| kstack-tasks | sprint.backlog/tasks | catalog — **to update**: emits `parallel-safe` var via kstack-report + dependency/file-set fields + respects state.scope | to update |
| kstack-qa | develop.qa-browsing · sprint.qa-browsing | catalog — **to update**: no more qa-artifact file → findings in `--evidence` | to update |
| kstack-review · kstack-cso | develop.review · sprint.devsecops | catalog — **to update**: no artifact-file → `--evidence` | to update |
| kstack-docker-manager · kstack-pipeline-sre | sprint.docker-review · pipeline-review | catalog — **to update**: no artifact-file → `--evidence` | to update |
| kstack-ponytail | implement/build (ambient) | port from ~/.agents/skills/ponytail | to port |
| kstack-impeccable | develop.implement/ui-check · sprint.implement/ui-check | catalog — wiring + capability-degrade note only | to wire |
| kstack-retro | develop.retro · sprint.retro | catalog — wiring + external dep (writing-for-agents) to flag | to wire |
| kstack-writing-for-agents | retro output · init block authoring | port ~/.agents/skills/writing-for-agents | to port |
| kstack-office-hours | discover.session | revision DEFERRED (too long/unrelated parts) — backlog task; base for now | use as-is |
| verification (AGENTS.md rules) | ambient | distill into ~2 lines via `kstack init` | to write |
| agent defs (5) | sprint delegated steps | port agents-clean/agents → pi subagent defs | to port |

## Open

- `kstack-investigate` description still claims vague-report triggers
  ("it's broken") that per approved design belong to `kstack-triage`
  intake — add a NOT-clause pointing to triage at wiring (flagged by the
  authoring-canons review).
- `agent-introspection-debugging`, `code-simplification`, `code-tour`,
  `code-audit-reviewer`: placement decided at S1-T4 (overlap map) — then
  steps may consume them.
- Final step/phase ids during each workflow's redesign spec.

## Machinery constraints emerged at S4-understand (user input — to honor in redesign specs)

1. **Freeze ≠ park.** `handleSprintPanel` also covers the D3
   security-freeze (typed phrase to unfreeze). Generalizing parks to
   non-sprint: decide whether severity→freeze semantics stays
   devsecops-only — a separate piece from generic "park panels".
   → RESOLVED: `parkOn` configurable; devsecops gets freeze, others
   standard park.
2. **Expectations per (workflow, phase).** `PHASE_EXPECTATIONS` is keyed
   on bare phase-id, but phase-ids are NOT unique across workflows
   (`report` in qa/qa-report, `verify` in investigate/ship, `review` in
   develop/ship/review, `test` in qa/ship, `fix` in
   qa/review/investigate, `implement` in develop/sprint). The
   per-workflow→phase map is a requirement, not an option →
   `routeVerdict` must receive workflowId.
3. **`artifactForVariable` = home of the naming scheme.** The third
   sprint-coupled point besides expectations and feedback: the
   non-sprint artifact-channel decision lives here (where files live,
   how they're named — sprint used `devsecops/*-artifact_XX.md` /
   `qa-artifact_XX.md`). → SUPERSEDED: verifiers write no files;
   evidence lives in the verdict record.
4. **Per-step verdict semantics on chain → steps[].** Two semantics
   exist today: legacy chain → `mergeParseOutcomes` merges parses of
   EVERY step (a chain missing a verdict on one step ⇒ null ⇒ park);
   stepped phase → parse ONLY on the last step (`isLastStep`,
   executor.ts:530) — intermediate delegated steps are invisible to the
   gate. Migrating devsecops-review to steps[], the first step's
   `code-review == X` verdict would be lost. → RESOLVED: per-step
   `verdict: true` declaration on WorkflowStep; flagged steps emit
   records, the phase merges flagged steps only.
