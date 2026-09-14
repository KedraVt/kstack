# TODOS — gstack-pi extension

Single backlog for the pi extension itself — absorbed `FUTURE_UPDATES.md` (deferred
features & skill integrations) so all not-yet-built work lives in one place.
The vendored gstack source keeps its own `source/TODOS.md`; this file tracks extension-level work only.

## INTEGRATION FOLLOW-UPS (feat/sprint-workflow)

### Code-review pass-1 deferred items (2026-08-31) — RESOLVED 2026-09-14

All five shipped on `feat/sprint-workflow`:

- **Browse binary bloat — DONE without LFS:** `runtime/` was already gitignored and
  provisioned by `update.sh` + `downloadBinary`; the tracked dist files were index
  leftovers. `git rm --cached` untracked ~197MB (`b6a71df`). No LFS needed.
- **D4 park cause distinction — DONE:** three causes (`no-verdict` /
  `artifact-mismatch` / `unroutable`) ride in `pausedReason` as a third segment;
  the D4 panel names each for triage (`a2b5f87`).
- **Centralized artifact filenames — DONE:** `orchestrator/artifacts.ts` owns every
  sprint-stamped name; `verdicts.ts`, `state.ts` freeze path and `templates.ts` task
  prose all consume it (`15c024e`).
- **Executor integration tests — DONE:** `test/executor-delegation.test.ts` runs the
  real `runDeterministicDelegation` with an injected `spawnFn` (`a78de38`).
- **`handoff.ts` cutAtParagraph — DONE:** true tail cut (`a2b5f87`).

### Non-distilled .agents-clean skills — fold into existing gstack skills (D12)

> **Update 2026-08-27:** the FULL raw sources of the .agents-clean skills now ship verbatim in
> `skills/kedra/` (18 of 20 — `acceptance-criteria-backend`/`-frontend` excluded, already living
> in the sub-agent bodies) for manual `/skill:` invocation. The disposition below still governs
> the **digest-injection** side: which methodology the workflows inject and which mechanisms
> absorb it.

None forgotten; each maps to an existing mechanism and lands when its host skill next evolves:

- `systematic-debugging` → deepen **gstack-investigate** digest (hypothesis-testing cadence overlap; merge unique sections only)
- `strategic-compact` → **HANDOFF protocol** (handoff.ts already covers compaction; the named-artifact habit shipped as the workers' HANDOFF section duty)
- `code-audit-reviewer` → fold remaining checklist items into **gstack-review** digest
- `code-simplification` → cross-reference **ponytail** `/gstack simplify` (better gate design already tracked here — do not double-inject)
- `acceptance-criteria-backend` / `-frontend` → DONE: folded into backend-/frontend-developer agent bodies at port time
- `agent-introspection-debugging` → future standalone digest if agent-self-debugging demand appears
- `code-tour` → DONE at raw level: `skills/kedra/code-tour/` (digest/execution integration still future, orthogonal to execution)
- `manim-video`, `add-model` → REJECTED (domain utilities of the source project, zero workflow relation)

Deferred from the sprint-workflow integration (D12) — deliberate scope cuts, each
with its trigger for when to build it:

- **Parallel task waves (E3)** — `implement` currently runs strict BE→FE sequential
  chains per wave. Independent backend tasks could fan out concurrently once
  branch-per-task merge discipline is mechanically enforced.
- **Branch enforcement** — the executor instructs specialists to work on branches but
  does not verify it mechanically. Add a git-state assertion before each review gate.
- **Two niche digests** — the devsecops-review and qa-verdict phases reuse adjacent
  methodology digests; two dedicated digests (threat-modeling, test-design) would
  tighten gate quality if reviews keep coming back noisy.
- **Root-artifacts flag** — planning artifacts land in the project root by design
  (user-visible). A `GSTACK_PI_SPRINT_ARTIFACTS_DIR` env could relocate them for
  users who hate root clutter; archive already handles either location.

## BACKLOG

### Ponytail integration — gated code-simplification cycle (`/gstack simplify`)

**What:** Add a new workflow to `orchestrator/workflows.ts` implementing a bounded,
gate-protected code-cleanup pass based on [ponytail](https://github.com/DietrichGebert/ponytail)
(the "lazy senior dev" minimizer skill, MIT). Shape:

1. `scan` (subagent, scout): analyze the current diff against ponytail's 7-rung ladder
   (YAGNI → reuse codebase → stdlib → native platform → installed dep → one line → minimum)
   → produce a DELETE-LIST artifact: each finding with rung number, impacted lines,
   estimated risk. Report-only.
2. `gate` (main, `advance: manual`): user approves/rejects the delete-list. Nothing is
   deleted without explicit consent — same decision-gate pattern as `develop.plan`.
3. `apply` (subagent, worker): apply ONLY approved deletions. Hard constraints:
   scope limited to the current task's diff; no public API / contract changes; tests
   green before AND after (verification-before-completion discipline).
4. `re-review` (subagent, reviewer, `optional: true`): confirm nothing essential was cut,
   reviewing only the simplification delta.

Also insert an `optional: true` `simplify` phase into the `develop` workflow between
`implement` and `qa`, with `skipWhen` on empty diff, so the full cycle becomes
implement → simplify → review → qa → ship.

Ship a distilled methodology digest (~2K tokens, `skills-distilled/`) containing the
ladder, the never-cut list (input validation at trust boundaries, data-loss error
handling, security, accessibility, anything explicitly requested), the `ponytail:`
ceiling-comment convention, and the delete-list output format — so the extension stays
self-contained whether or not the user has ponytail installed.

**Why:** Agents over-build on everyday tasks; ponytail's agentic benchmark shows ~54%
mean LOC reduction (and ~20% cost) on real repos. Injecting it ambiently into every
phase, however, directly conflicts with this pipeline's contracts: DoD requires
observability at boundaries, QA requires tests, ship requires doc phases, and an
injected reviewer told to be lazy flags fewer problems (weakened gates → thrash loops:
worker trims → review rejects → FEEDBACK retry costs more than the savings). As a
post-implement, manually-gated pass, minimization stops being ambient pressure and the
existing review/QA gates validate the deletions instead of fighting them.

**Mode mapping (from ponytail's own intensity levels):**
- `lite` ("build what's asked, name the lazier alternative in one line") is safe to
  reference from the `implement` phase instructions as an advisory nudge — it never
  blocks delivery.
- `full` / `ultra` logic must live ONLY inside the simplify cycle, never in ambient
  subagent injection. If the host also has the real ponytail plugin installed with
  always-on hooks, document setting `PONYTAIL_DEFAULT_MODE=off` for pipeline sessions
  (or scope `PONYTAIL_SUBAGENT_MATCHER`) so the two systems don't double-inject.

**Pros:** Counterweight to over-building without touching gate integrity; reuses the
existing patterns (`advance: manual`, skipWhen, skill ingestion, reviewer delta-review);
standalone `/gstack simplify` is useful on any dirty tree even outside develop.
**Cons:** One more workflow to maintain; the digest must track upstream ponytail rule
changes manually (MIT, pin a version in the digest header).

**Context / where to start:**
- Upstream ruleset: https://raw.githubusercontent.com/DietrichGebert/ponytail/main/skills/ponytail/SKILL.md
  (`lite|full|ultra` intensity table + never-lazy list are normative there).
- Install (optional, for users who want the live skill alongside):
  `pi install git:github.com/DietrichGebert/ponytail`
- Files: `orchestrator/workflows.ts` (new `simplify` workflow + optional develop phase),
  `orchestrator/router.ts` + menu (intent patterns: /\b(simplify|clean ?up|delete[- ]list|dead code)\b/i),
  `skills-distilled/gstack-simplify.md` (new digest).
- Design sketched in session of 2026-08-23 (see conversation summary in `.gstack/plans/` if persisted).

### Skill digest improvements — especially `gstack-office-hours`

**What:** Review and improve all `skills-distilled/*.md` digests so they steer agent behavior
more reliably inside workflows. Priority: `gstack-office-hours.md` (planning-phase quality gate).

Pain points to address:
- Office-hours digest is persona-heavy (YC partner voice) but light on **workflow integration**:
  when to smart-skip, how to converge to a plan artifact, what handoff format the next phase
  (`develop.plan`) actually consumes. Digest should specify its output contract, not just its posture.
- Missing exit criteria: no explicit "session done when X" condition, so planning phases can loop.
- Other digests: audit each for the same gap — do they define inputs, output shape, and stop
  conditions, or only tone?

**Why:** Digests are injected into subagent prompts every session; vague ones cost tokens AND
produce mushy plans that downstream gates reject → retry loops. Sharper office-hours output =
fewer develop-plan rework cycles = better end-to-end workflow.

**Files:** `skills-distilled/gstack-office-hours.md` first, then the rest; cross-check against
phase instructions in `orchestrator/workflows.ts` so digest output matches what gates expect.

### Workflow: `/gstack design` — full design-review cycle

Same shape as `develop` / `investigate`: visual audit of the running app → severity-rated
design findings (spacing, hierarchy, consistency, AI-slop detection) → interactive fix loop
with before/after screenshots → regression pass. Build on the `gstack-design-review` skill
methodology **composed with the locally installed `impeccable` skill**
(`~/.pi/agent/skills/impeccable`) for frontend quality standards. Needs: browser tools
(already native), a taste-feedback loop (interactive, like the plan approval gate).

### Workflow: `/gstack secure` — security audit

Security audit workflow on the `gstack-cso` methodology: scout diffs → OWASP Top 10 +
STRIDE checklist phase → findings gate.

### Workflow: `/gstack retro`

Weekly retro reading session history; depends on the learnings memory below.

### Spec-as-goal entry for `develop`

Accept a `gstack-spec`-style spec file as `develop`'s goal input, skipping the interview
when a spec already exists.

### Orchestrator: `/gstack status`

Non-interactive printout of the workflow state machine (current phase x/y, results,
gate/pause state). NOTE — naming: this is a *slash command* over the orchestrator state
machine and is unrelated to the browser-daemon health tool planned as
`gstack_daemon_status` (upgrade-plan WP1, commit `1cae721`); the `daemon-` prefix on the tool side is the
deliberate disambiguator.

### Orchestrator: per-step checkpoint + `WorkflowState` versioning

Persist a checkpoint after each chain step so a session reload can resume mid-chain without
redoing scout work. Paired requirement: the persisted schema needs an explicit version field.
(`orchestrator/state.ts` + `orchestrator/telemetry.ts`.)

### Orchestrator: compaction guard

On `session_start`, if a workflow is active but the phase instructions were compacted away,
re-inject via existing `buildResumeContext()`.

### Learnings memory — CLOSED (no work needed)

**Resolved 2026-08-24 by direct verification.** The upgrade plan's WP4 (HANDOFF.md §6,
preserved as commit `1cae721`) proposed reimplementing
the memory writers, based on the claim they "were never vendored". That claim was wrong:
the writers already exist in `source/bin/` (`gstack-learnings-log`, `-question-log`,
`-telemetry-log`, `-decision-log`) — exactly where the adapted skills' preambles point
(absolute `source/bin/...` paths with `-x` guards and `|| true` fallbacks). Roundtrip
verified under Git Bash: write exit 0, valid JSONL with auto `ts`, `gstack-learnings-search`
(the vendored reader) returns entries, invalid types rejected exit 1 (fail-loud), duplicate
key+type resolves latest-wins at read time. **Nothing to implement.**

Residual notes:
- Writers validate via `bun -e`, so bun is a **runtime** dependency for skill memory, not
  just updates (documented in README Requirements).
- `update.sh` step 7b already warns if these go missing from `source/bin`.
- Minor: `gstack-question-log` accepts malformed ad-hoc question ids (e.g. `"x"`) without
  rejection — lenient but harmless; upstream contract keeps it log-only.
- Read-side injection into phases (`GSTACK_PI_LEARNINGS`) remains a *separate*, optional
  future idea; ranking only matters if that ever ships.

### Skill promotions

- **`gstack-plan-devex-review`** — promote into planning when building developer-facing
  products (APIs, CLIs, SDKs).
- **`gstack-plan-design-review`** — promote for UI-heavy work once `/gstack design` exists.
- **skillify-assisted digests** — use the `gstack-skillify` methodology to semi-automate
  distilling new upstream skills into `skills-distilled/`.

### Browse commands tier-3 (deferred from the WP1 regeneration)

Deferred during planning (2026-08-24) to keep the tool surface minimal; revisit when a
real workflow needs them. All are supported by the browse binary — adding one is an
`INCLUDE` entry in `scripts/gen-tools.ts` plus a `buildArgs` case:

- **`watch`** — snapshot on DOM mutation; removes wait+retry churn on SPA re-renders.
  Worth it only once SPA QA volume justifies it.
- **`cdp`** — raw CDP escape hatch with server-side allowlist, for what Playwright does
  not abstract (geolocation emulation, coverage profiling). Power tool; document
  guardrails before exposing.
- **`tab-each`** — run a command across all tabs. Multi-tab QA convenience only.
- **`domain-skill` / browser-skills subsystem** — reusable site-specific automation
  recipes. A whole subsystem (see upstream `browser-skills/`); consider only if the same
  app is QA-ed repeatedly.

### Decision log (event-sourced) — requires vendoring upstream lib

Implement `runtime/bin/gstack-decision-log` + `gstack-decision-search` per the upstream
contracts (`bin/gstack-decision-log`: append / `--supersede <id>` / `--redact <id>` /
`--compact`; event log + bounded `decisions.active.json` snapshot; scope-filtered reads by
branch/issue; strictly non-interactive; HIGH-secret rejection). Blocked on vendoring
upstream `lib/gstack-decision.ts` (~200 lines TS + deps: `lib/bin-context`). Highest-value
consumer: plan-gate rationale persistence and `/gstack retro` (also still open above).

## Efficiency plan follow-ups (deferred by efficiency plan v3.1, preserved as commit `f06870a` in git history — the plan file itself was deleted; everything it contained is either shipped or listed below)

- **Phase-level parallel waves** — parallelism must live at the `WorkflowPhase` level, not on
  chain steps (the only real chain, investigate/root-cause, must stay sequential; the
  v3-proposed wave entities did not exist in the workflows). Requirements for the future design:
  - extend `after` / `exclusive` to phase types; touches `orchestrator/state.ts` result merging;
  - `{previous}` semantics in wave mode: concat of the handoffs of the steps in `after`, in
    declared order;
  - mechanized `exclusive` guard: a test reading `tools:` from agent frontmatter
    (`~/.pi/agent/agents/*.md`) validating that a wave never mixes conflicting tools
    (git-write, ports/dev-servers, shared `.gstack`); manual annotation as override only;
  - gate handling (`advance:"manual"`) during waves; result merge in `formatDelegationResults`;
    concurrency via `GSTACK_PI_MAX_PARALLEL` (use the `numberEnv` parser in `orchestrator/config.ts`).
- **Liveness kill activation** — the observe-only liveness (`GSTACK_PI_LIVENESS_SEC`,
  spawn.ts) must NEVER terminate processes until data from at least 2 real runs shows
  false-positive rates are acceptable (gaps > 240s are normal during long builds/tests).
  Decide on run-report data in `.gstack/runs/`.
- **`{previous}` `$`-safe fix in the subagent extension** — the same unsafe-replacement bug
  class fixed here via `replaceExact` exists at `~/.pi/agent/extensions/subagent/index.ts`
  (~line 536); separate extension, out of scope for this repo.
- **Skip extension to other workflows** — the structural-skip pattern (marker-in-HANDOFF +
  file-existence guards + never-skippable validate step) currently covers investigate
  root-cause and the QA fix loop only.

## Rejected proposals (2026-08-24 capability audit — do not re-propose without new evidence)

- **ML prompt-injection classifier (L4 sidecar)** — 112MB model, extra process, crash
  blast-radius inside pi's event loop, for a single-user threat model. L1–L3 envelope +
  SECURITY system-prompt section (upgrade-plan WP2, commit `5c9efa1`) cover the realistic risk.
- **pair-agent / ngrok remote browser tunnel** — no single-machine use case; large attack
  surface (dual-listener, scoped tokens).
- **GStack Browser Chrome extension** — separate distribution + maintenance; headless
  daemon already covers QA.
- **gbrain / PGLite knowledge brain** — heavy dependency overlapping the learnings
  memory; revisit only if WP4 learnings prove valuable in practice.
- **SKILL.md template generation (`gen-skill-docs` port)** — solves doc drift we do not
  have: `tools.generated.ts` is generated from source; digests are methodology, not
  command references.
- **Full egress receipt ledger** — designed for upstream's dozens of off-machine sinks;
  ours are two (binary download, update-check). A log line suffices.
- **Multi-host abstraction (`hosts/`)** — meaningless for a pi-only extension.

## Notes

- All 23 bundled skills remain invocable manually via `/skill:gstack-*` regardless of wiring.
- Digests must stay verbatim-stable across releases where possible — provider prompt caches
  key on exact prefixes.
