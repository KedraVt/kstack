# kstack workflows

<!-- GENERATED FILE — DO NOT EDIT BY HAND -->
<!-- Source: orchestrator/workflows.ts → getAllWorkflows() -->
<!-- Regenerate: bun scripts/gen-workflow-table.ts -->

This file is **generated** from the workflow registry in `orchestrator/workflows.ts`.
Hand-edits are lost on the next regeneration, and `test/workflow-table.test.ts`
fails as soon as the file and the registry disagree.

Regenerate after any change to the registry:

```sh
bun scripts/gen-workflow-table.ts
```

The output is deterministic — no timestamps, no ambient environment values — so the
file is byte-stable across machines.

## Legend

| Column | Meaning |
| --- | --- |
| **Phase** | Phase id and display name. The phase is the unit of routing. |
| **Profile** | The phase's TOOL PROFILE (`full`, `read`, `none`) — the browser tools the main session keeps in that phase. Read from `PHASE_TOOL_PROFILE`, the same table the mask uses. |
| **Flags** | Phase toggles (`optional`, `enabled: auto/off`, `fail-fast`), artifact contract (`produces`/`needs`) and step flags (`skip var=value`, `needs-user`, `side-effect`, `requires`/`prefers` capabilities, `timeout`, `ambient` skills). |
| **Step** | Step id inside the phase — the unit of execution. |
| **Exec** | `main` (runs in the model session) or `subagent` (delegated to a spawned agent). |
| **Agent** | Agent definition used by delegated steps. |
| **Skill** | Skill digest delivered with the step. |
| **Signal** | Completion signal the router observes in the step record (`kind:value`). |
| **Routing** | Phase routing: human gate (`advance: manual`), back-edges (`loop→`, `onComplete→`), ceilings (`max`), verdict maps (`loopOn`, `park`). |

Notes:

- `enabled: auto` phases are detected by the engine at the pre-flight panel; the user may force them.
- `side-effect` steps park at an entry gate before running — the model can never self-approve.
- `skip var=value` steps are skipped when the run-start answer `var` equals `value`.
- `advance: manual` phases park for human approval after completion (`/kstack next` moves them on).
- `-` means "not declared".

## sprint — Sprint (Agile Pipeline)

Agile sprint: story, capability, design, architect gate, backlog, implement, QA + devsecops gates, archive

Run-start questions:
- `scope` — Sprint scope? (mixed / frontend / backend; default mixed)

| Phase                                  | Profile | Flags                                                                                         | Step        | Exec     | Agent              | Skill                          | Signal                            | Routing                                                               |
| -------------------------------------- | ------- | --------------------------------------------------------------------------------------------- | ----------- | -------- | ------------------ | ------------------------------ | --------------------------------- | --------------------------------------------------------------------- |
| explore — Codebase Exploration         | none    | produces: explore-notes; prefers: graft                                                       | scout       | subagent | scout              | -                              | marker:SCOUT-DONE                 | -                                                                     |
| understand — Understand Requirements   | read    | produces: understand.md; needs: explore-notes; needs-user                                     | evolve      | main     | -                  | kstack-idea-refine             | artifact:understand.md            | advance: manual                                                       |
| understand — Understand Requirements   | read    | produces: understand.md; needs: explore-notes; needs-user                                     | interrogate | main     | -                  | kstack-grilling                | marker:INTERROGATE-DONE           | advance: manual                                                       |
| user-story — User Story                | read    | produces: user-story.md; needs: understand.md                                                 | story       | main     | -                  | kstack-product-capability      | artifact:user-story.md            | -                                                                     |
| capability — Product Capability        | read    | produces: capability.md; needs: user-story.md                                                 | constraints | main     | -                  | kstack-product-capability      | artifact:capability.md            | -                                                                     |
| system-design — System Design          | read    | produces: system-design, adr-log; needs: capability.md                                        | design      | main     | -                  | kstack-system-design           | marker:DESIGN-DONE                | advance: manual                                                       |
| system-design — System Design          | read    | produces: system-design, adr-log; needs: capability.md                                        | risk-scan   | main     | -                  | kstack-risk-scan               | marker:RISK-SCAN-DONE             | advance: manual                                                       |
| system-design — System Design          | read    | produces: system-design, adr-log; needs: capability.md                                        | adr         | main     | -                  | kstack-adr                     | marker:ADR-DONE                   | advance: manual                                                       |
| architect-gate — Architect Review Gate | none    | needs: system-design                                                                          | review      | subagent | software-architect | kstack-system-design           | verdict:software-architect-review | advance: manual; loop→ system-design; max 5                           |
| backlog — Sprint Backlog               | read    | produces: tasks.md; needs: system-design                                                      | tasks       | main     | -                  | kstack-tasks                   | marker:TASKS-DONE                 | advance: manual                                                       |
| implement — Implement (BE → FE)        | none    | fail-fast; produces: impl; needs: tasks.md; skip scope=frontend                               | backend     | subagent | backend-developer  | kstack-test-driven-development | marker:BACKEND-DONE               | loop→ implement; max 4                                                |
| implement — Implement (BE → FE)        | none    | fail-fast; produces: impl; needs: tasks.md; skip scope=frontend                               | be-walk     | subagent | backend-developer  | kstack-lite-mindrun            | verdict:be-walk                   | loop→ implement; max 4                                                |
| implement — Implement (BE → FE)        | none    | fail-fast; produces: impl; needs: tasks.md; skip scope=backend                                | frontend    | subagent | frontend-developer | kstack-test-driven-development | marker:FRONTEND-DONE              | loop→ implement; max 4                                                |
| implement — Implement (BE → FE)        | none    | fail-fast; produces: impl; needs: tasks.md; skip scope=backend; prefers: node; timeout: 3600s | design      | subagent | frontend-developer | kstack-design-taste-frontend   | marker:DESIGN-DONE                | loop→ implement; max 4                                                |
| implement — Implement (BE → FE)        | none    | fail-fast; produces: impl; needs: tasks.md; skip scope=backend                                | fe-walk     | subagent | frontend-developer | kstack-lite-mindrun            | verdict:fe-walk                   | loop→ implement; max 4                                                |
| implement — Implement (BE → FE)        | none    | fail-fast; produces: impl; needs: tasks.md; skip scope=backend; prefers: browse               | ui-check    | subagent | frontend-developer | kstack-impeccable              | verdict:ui                        | loop→ implement; max 4                                                |
| qa-browsing — QA Browsing              | full    | needs: impl; requires: browse                                                                 | test        | subagent | qa-engineer        | kstack-qa                      | verdict:status                    | loop→ implement; max 4                                                |
| devsecops-review — DevSecOps Review    | none    | needs: impl                                                                                   | code-review | subagent | devsecops-reviewer | kstack-review                  | verdict:code-review               | loop→ implement; max 4; park critical→freeze, high→freeze, red→freeze |
| devsecops-review — DevSecOps Review    | none    | needs: impl                                                                                   | security    | subagent | devsecops-reviewer | kstack-cso                     | verdict:security-review           | loop→ implement; max 4; park critical→freeze, high→freeze, red→freeze |
| docker-review — Docker Review          | none    | enabled: auto; needs: impl                                                                    | audit       | subagent | worker             | kstack-docker-manager          | verdict:docker-build              | loop→ implement; max 4                                                |
| pipeline-review — Pipeline Review      | none    | enabled: auto; needs: impl                                                                    | audit       | subagent | worker             | kstack-pipeline-sre            | verdict:pipeline                  | loop→ implement; max 4                                                |
| archive — Archive Sprint               | none    | -                                                                                             | archive     | main     | -                  | -                              | marker:ARCHIVED                   | -                                                                     |
| retro — Retro                          | none    | -                                                                                             | retro       | main     | -                  | kstack-retro                   | marker:RETRO-DONE                 | -                                                                     |

## develop — Full Development Cycle

Lean intent→merge path: understand, plan, implement, QA, review, document, ship

Run-start questions:
- `scope` — Scope of this change? (mixed / frontend / backend; default mixed)

| Phase                           | Profile | Flags                                                                                        | Step          | Exec     | Agent       | Skill                          | Signal                    | Routing                |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------- | ------------- | -------- | ----------- | ------------------------------ | ------------------------- | ---------------------- |
| explore — Codebase Exploration  | none    | produces: explore-notes; prefers: graft                                                      | scout         | subagent | scout       | -                              | marker:SCOUT-DONE         | -                      |
| plan — Interactive Planning     | read    | produces: plan.md; needs: explore-notes; needs-user                                          | evolve        | main     | -           | kstack-idea-refine             | artifact:plan.md          | advance: manual        |
| plan — Interactive Planning     | read    | produces: plan.md; needs: explore-notes; needs-user                                          | interrogate   | main     | -           | kstack-grilling                | marker:INTERROGATE-DONE   | advance: manual        |
| plan — Interactive Planning     | read    | produces: plan.md; needs: explore-notes                                                      | draft         | main     | -           | kstack-plan-draft              | marker:DRAFT-DONE         | advance: manual        |
| plan — Interactive Planning     | read    | produces: plan.md; needs: explore-notes                                                      | eng-review    | main     | -           | kstack-plan-eng-review         | marker:ENG-REVIEW-DONE    | advance: manual        |
| plan — Interactive Planning     | read    | produces: plan.md; needs: explore-notes; skip scope=backend                                  | design-review | main     | -           | kstack-plan-design-review      | marker:DESIGN-REVIEW-DONE | advance: manual        |
| implement — Implementation      | none    | fail-fast; produces: impl; needs: plan.md                                                    | build         | subagent | worker      | kstack-test-driven-development | marker:BUILD-DONE         | loop→ implement; max 4 |
| implement — Implementation      | none    | fail-fast; produces: impl; needs: plan.md; skip scope=backend; prefers: node; timeout: 3600s | design        | subagent | worker      | kstack-design-taste-frontend   | marker:DESIGN-DONE        | loop→ implement; max 4 |
| implement — Implementation      | none    | fail-fast; produces: impl; needs: plan.md                                                    | walkthrough   | subagent | worker      | kstack-lite-mindrun            | verdict:walkthrough       | loop→ implement; max 4 |
| implement — Implementation      | none    | fail-fast; produces: impl; needs: plan.md; skip scope=backend; prefers: browse               | ui-check      | subagent | worker      | kstack-impeccable              | verdict:ui                | loop→ implement; max 4 |
| qa-browsing — QA Browsing       | full    | enabled: auto; needs: impl; requires: browse                                                 | test          | subagent | qa-engineer | kstack-qa                      | verdict:status            | loop→ implement; max 4 |
| review — Code Review            | none    | needs: impl                                                                                  | review        | subagent | reviewer    | kstack-review                  | verdict:code-review       | loop→ implement; max 4 |
| document — Documentation Update | none    | enabled: auto                                                                                | document      | subagent | worker      | kstack-document                | marker:DOC-DONE           | -                      |
| ship — Ship (PR + Push)         | none    | enabled: auto; side-effect                                                                   | ship          | subagent | worker      | kstack-ship                    | marker:SHIPPED            | -                      |
| retro — Retro                   | none    | enabled: auto                                                                                | retro         | main     | -           | kstack-retro                   | marker:RETRO-DONE         | -                      |

## investigate — Bug Investigation

Production hotfix: reproduce, confirm root cause, minimal fix, verify

| Phase                            | Profile | Flags                                                     | Step     | Exec     | Agent       | Skill                          | Signal                 | Routing                                        |
| -------------------------------- | ------- | --------------------------------------------------------- | -------- | -------- | ----------- | ------------------------------ | ---------------------- | ---------------------------------------------- |
| explore — Codebase Exploration   | none    | produces: explore-notes; prefers: graft                   | scout    | subagent | scout       | -                              | marker:SCOUT-DONE      | -                                              |
| reproduce — Reproduce the Bug    | full    | produces: bug-report.md; needs: explore-notes; needs-user | triage   | main     | -           | kstack-triage                  | artifact:bug-report.md | -                                              |
| reproduce — Reproduce the Bug    | full    | produces: bug-report.md; needs: explore-notes             | repro    | main     | -           | kstack-investigate             | marker:REPRO-DONE      | -                                              |
| root-cause — Root Cause Analysis | read    | produces: root-cause; needs: bug-report.md                | trace    | main     | -           | kstack-investigate             | marker:TRACE-DONE      | advance: manual                                |
| root-cause — Root Cause Analysis | read    | produces: root-cause; needs: bug-report.md                | validate | main     | -           | kstack-investigate             | marker:RCA-CONFIRMED   | advance: manual                                |
| fix — Minimal Fix                | none    | produces: fix; needs: root-cause                          | patch    | subagent | worker      | kstack-test-driven-development | marker:PATCH-DONE      | -                                              |
| verify — Verify Fix              | full    | needs: fix                                                | verify   | subagent | worker      | kstack-lite-mindrun            | verdict:outcome        | max 4; loopOn persists→fix, refuted→root-cause |
| regression-qa — Regression QA    | full    | enabled: auto; needs: fix; requires: browse               | test     | subagent | qa-engineer | kstack-qa                      | verdict:status         | loop→ fix; max 4                               |
| retro — Retro                    | none    | enabled: auto                                             | retro    | main     | -           | kstack-retro                   | marker:RETRO-DONE      | -                                              |

## review — Code Review

Evaluate code not produced by a run — external PRs, own diffs, dirty worktree

Run-start questions:
- `target` — What is being reviewed? (external / own; default external)

| Phase                             | Profile | Flags                                                       | Step    | Exec     | Agent       | Skill                          | Signal               | Routing                     |
| --------------------------------- | ------- | ----------------------------------------------------------- | ------- | -------- | ----------- | ------------------------------ | -------------------- | --------------------------- |
| explore — Codebase Exploration    | none    | produces: explore-notes; prefers: graft                     | scout   | subagent | scout       | -                              | marker:SCOUT-DONE    | -                           |
| diff — Resolve Diff               | none    | produces: diff; needs: explore-notes                        | resolve | main     | -           | -                              | marker:DIFF-RESOLVED | -                           |
| findings — Findings & Suggestions | none    | produces: findings; needs: diff                             | review  | subagent | reviewer    | kstack-review                  | verdict:code-review  | -                           |
| qa-browsing — QA Browsing         | full    | enabled: auto; needs: diff; requires: browse                | test    | subagent | qa-engineer | kstack-qa                      | verdict:status       | -                           |
| comment — Post Review Comment     | none    | needs: findings; skip target=own; side-effect; requires: gh | post    | main     | -           | kstack-review-comment          | marker:POSTED        | -                           |
| fix — Apply Fixes                 | none    | enabled: auto; needs: findings; skip target=external        | patch   | subagent | worker      | kstack-test-driven-development | marker:PATCH-DONE    | max 4; onComplete→ findings |
| retro — Retro                     | none    | enabled: auto                                               | retro   | main     | -           | kstack-retro                   | marker:RETRO-DONE    | -                           |

## discover — Product Discovery

Technical discovery & idea sharpening: refine raw ideas or stress-test designs into a solid direction

| Phase                                    | Profile | Flags      | Step    | Exec | Agent | Skill               | Signal                                   | Routing |
| ---------------------------------------- | ------- | ---------- | ------- | ---- | ----- | ------------------- | ---------------------------------------- | ------- |
| session — Discovery & Sharpening Session | full    | needs-user | session | main | -     | kstack-office-hours | artifact:.kstack/discover/direction-*.md | -       |

## audit — Codebase Audit

Structured codebase re-read: incremental findings file, resume-safe, hands off to investigate

| Phase                  | Profile | Flags | Step | Exec | Agent | Skill          | Signal                               | Routing |
| ---------------------- | ------- | ----- | ---- | ---- | ----- | -------------- | ------------------------------------ | ------- |
| walk — Structured Walk | full    | -     | walk | main | -     | kstack-mindrun | artifact:.kstack/audit/findings-*.md | -       |
