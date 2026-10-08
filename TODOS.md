# TODOS — kstack-pi extension

Single backlog for the pi extension itself — absorbed `FUTURE_UPDATES.md` (deferred
features & skill integrations) so all not-yet-built work lives in one place.

## NEXT UP (designed 2026-09-14 — SHIPPED 2026-09-15)

All three items landed in one commit:

1. **Compaction guard — tiers 1+2** — tier 1: `buildResumeContext` re-anchors
   the current phase's DELIVERABLE/STOP CONDITION contract (`mainContractFor`,
   narrowed to `Pick<WorkflowContext,"state">`) for `execution:"main"` +
   `status:"active"` only. Tier 2: `kstack_phase` read-only tool returns
   `buildPhaseInstructions(current phase)`; one pointer line in the prefix.
2. **setStatus parked-state upgrade** — `statusLineFor(state, workflow)` maps
   every status to a truthful line with its unlock action; wired after
   `saveState` in `kstack_advance` and on the executor's anomaly/D4 park paths.
3. **Branch enforcement** — `executeCurrentPhase` parks fail-closed
   (`pausedReason:"branch-violation:<phase> on <branch>"` + panel Resume/Abort)
   when a sprint gate that audits developer output (`loopBackTo:"implement"`)
   is entered on main/master. Scope: developer gates only — `architect-gate`
   reviews documents on main legitimately; planning phases too.

## INTEGRATION FOLLOW-UPS (feat/sprint-workflow)

### Non-distilled .agents-clean skills — fold into existing kstack skills (D12)

> **Update 2026-10-08 (post-S1):** the layered `skills/kedra/` dir referenced here was
> deleted in S1-T9 — per-skill dispositions were resolved by `Kstack/review-table.md`
> and the survivors merged into the canonical `skills/kstack-*/` catalog. The items
> below are the residual follow-ups that the review table did NOT absorb.

None forgotten; each maps to an existing mechanism and lands when its host skill next evolves:

- `systematic-debugging` → deepen **kstack-investigate** SKILL.md (hypothesis-testing cadence overlap; merge unique sections only)
- `code-audit-reviewer` → fold remaining checklist items into **kstack-review** SKILL.md
- `kstack-code-simplification` → cross-reference **ponytail** `/kstack simplify` (better gate design already tracked here — do not double-inject)
- `kstack-agent-introspection-debugging` → future standalone skill if agent-self-debugging demand appears
- `code-tour` → dropped in the S1 review (`.tour` VSCode format, marginal — see review-table); nothing left to integrate

Deferred from the sprint-workflow integration (D12) — deliberate scope cuts, each
with its trigger for when to build it:

- **Parallel task waves (E3)** — `implement` currently runs strict BE→FE sequential
  chains per wave. Independent backend tasks could fan out concurrently once
  branch-per-task merge discipline is mechanically enforced.
- **Two niche skills** — the devsecops-review and qa-verdict phases reuse adjacent
  methodology skills; two dedicated skills (threat-modeling, test-design) would
  tighten gate quality if reviews keep coming back noisy.
- **Root-artifacts flag** — planning artifacts land in the project root by design
  (user-visible). A `KSTACK_PI_SPRINT_ARTIFACTS_DIR` env could relocate them for
  users who hate root clutter; archive already handles either location.

## BACKLOG

### Ponytail integration — gated code-simplification cycle (`/kstack simplify`)

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

Ship a canonical catalog skill (`skills/kstack-simplify/SKILL.md`, ~2K tokens) containing the
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
standalone `/kstack simplify` is useful on any dirty tree even outside develop.
**Cons:** One more workflow to maintain; the skill must track upstream ponytail rule
changes manually (MIT, pin a version in the skill header).

**Context / where to start:**
- Upstream ruleset: https://raw.githubusercontent.com/DietrichGebert/ponytail/main/skills/ponytail/SKILL.md
  (`lite|full|ultra` intensity table + never-lazy list are normative there).
- Install (optional, for users who want the live skill alongside):
  `pi install git:github.com/DietrichGebert/ponytail`
- Files: `orchestrator/workflows.ts` (new `simplify` workflow + optional develop phase),
  `orchestrator/router.ts` + menu (intent patterns: /\b(simplify|clean ?up|delete[- ]list|dead code)\b/i),
  `skills/kstack-simplify/SKILL.md` (new canonical skill).
- Design sketched in session of 2026-08-23 (see conversation summary in `.kstack/plans/` if persisted).

### Skill output-contract improvements — especially `kstack-office-hours`

**What:** Review and improve the canonical `skills/kstack-*/SKILL.md` files so they steer agent
behavior more reliably inside workflows. Priority: `kstack-office-hours` (planning-phase
quality gate).

> **Update 2026-10-08 (post-S1/S2):** the digest layer is gone — `skills-distilled/` was deleted
> and the canonical SKILL.md is the only injected source. The `## DoD gate` parsed from each
> SKILL.md is what verification phases and repeat deliveries receive (D13). The output-contract
> critique below now applies to the canonical files.

Pain points to address:
- Office-hours is persona-heavy (YC partner voice) but light on **workflow integration**:
  when to smart-skip, how to converge to a plan artifact, what handoff format the next phase
  (`develop.plan`) actually consumes. The skill should specify its output contract, not just its posture.
- Missing exit criteria: no explicit "session done when X" condition, so planning phases can loop.
- Other skills: audit each for the same gap — do they define inputs, output shape, and stop
  conditions, or only tone?

**Why:** Skill bodies are injected into subagent prompts every session; vague ones cost tokens AND
produce mushy plans that downstream gates reject → retry loops. Sharper office-hours output =
fewer develop-plan rework cycles = better end-to-end workflow.

**Files:** `skills/kstack-office-hours/SKILL.md` first, then the rest; cross-check against
phase instructions in `orchestrator/workflows.ts` so skill output matches what gates expect.

### Workflow: `/kstack design` — full design-review cycle

Same shape as `develop` / `investigate`: visual audit of the running app → severity-rated
design findings (spacing, hierarchy, consistency, AI-slop detection) → interactive fix loop
with before/after screenshots → regression pass. Build on the `kstack-design-review` skill
methodology **composed with the locally installed `kstack-impeccable` skill**
(`~/.pi/agent/skills/kstack-impeccable`) for frontend quality standards. Needs: browser tools
(already native), a taste-feedback loop (interactive, like the plan approval gate).

### Workflow: `/kstack secure` — security audit

Security audit workflow on the `kstack-cso` methodology: scout diffs → OWASP Top 10 +
STRIDE checklist phase → findings gate.

### Workflow: `/kstack retro`

Weekly retro reading session history; depends on the learnings memory below.

### Spec-as-goal entry for `develop`

Accept a `kstack-spec`-style spec file as `develop`'s goal input, skipping the interview
when a spec already exists.

### Orchestrator: `/kstack status`

Non-interactive printout of the workflow state machine (current phase x/y, results,
gate/pause state). NOTE — naming: this is a *slash command* over the orchestrator state
machine and is unrelated to the browser-daemon health tool planned as
`kstack_daemon_status` (upgrade-plan WP1, commit `1cae721`); the `daemon-` prefix on the tool side is the
deliberate disambiguator.

> **Rescoped 2026-09-14:** the setStatus upgrade (NEXT UP) covers the interactive
> need — a parked workflow currently keeps showing a stale "running" label. The
> remaining value is headless/RPC sessions with no TUI status line. Build only if
> headless use appears.

### Orchestrator: per-step checkpoint + `WorkflowState` versioning

Persist a checkpoint after each chain step so a session reload can resume mid-chain without
redoing scout work. Paired requirement: the persisted schema needs an explicit version field.
(`orchestrator/state.ts` + `orchestrator/telemetry.ts`.)

### Learnings memory — CLOSED (verified 2026-08-24; nothing to implement)

Residual future idea: read-side injection into phases (`KSTACK_PI_LEARNINGS`) —
optional; ranking only matters if that ever ships. The writers in `runtime/bin/`
(kstack-learnings-search et al.) are vendored and verified; bun is a runtime dep for
skill memory (README Requirements covers it).

### Skill promotions

- **`kstack-plan-devex-review`** — promote into planning when building developer-facing
  products (APIs, CLIs, SDKs).
- **`kstack-plan-design-review`** — promote for UI-heavy work once `/kstack design` exists.
- **skillify-assisted skill authoring** — use the `kstack-skillify` methodology to semi-automate
  porting new upstream skills into the `skills/` catalog.

### Browse commands tier-3 (deferred from the WP1 regeneration)

Deferred during planning (2026-08-24) to keep the tool surface minimal; revisit when a
real workflow needs them. All are supported by the browse binary — adding one means a
new registration in `tools.generated.ts` + a `buildArgs`/`commands.generated.ts` entry
(the `scripts/gen-tools.ts` generator was removed in the S1 freeze; the generated files
are now hand-maintained):

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

Implement `runtime/bin/kstack-decision-log` + `kstack-decision-search` per the upstream
contracts (`bin/kstack-decision-log`: append / `--supersede <id>` / `--redact <id>` /
`--compact`; event log + bounded `decisions.active.json` snapshot; scope-filtered reads by
branch/issue; strictly non-interactive; HIGH-secret rejection). Blocked on vendoring
upstream `lib/kstack-decision.ts` (~200 lines TS + deps: `lib/bin-context`). Highest-value
consumer: plan-gate rationale persistence and `/kstack retro` (also still open above).

## Efficiency plan follow-ups (deferred by efficiency plan v3.1, preserved as commit `f06870a` in git history — the plan file itself was deleted; everything it contained is either shipped or listed below)

- **Phase-level parallel waves** — parallelism must live at the `WorkflowPhase` level, not on
  chain steps (the only real chain, investigate/root-cause, must stay sequential; the
  v3-proposed wave entities did not exist in the workflows). Requirements for the future design:
  - extend `after` / `exclusive` to phase types; touches `orchestrator/state.ts` result merging;
  - `{previous}` semantics in wave mode: concat of the handoffs of the steps in `after`, in
    declared order;
  - mechanized `exclusive` guard: a test reading `tools:` from agent frontmatter
    (`~/.pi/agent/agents/*.md`) validating that a wave never mixes conflicting tools
    (git-write, ports/dev-servers, shared `.kstack`); manual annotation as override only;
  - gate handling (`advance:"manual"`) during waves; result merge in `formatDelegationResults`;
    concurrency via `KSTACK_PI_MAX_PARALLEL` (use the `numberEnv` parser in `orchestrator/config.ts`).
- **Liveness kill activation** — the observe-only liveness (`KSTACK_PI_LIVENESS_SEC`,
  spawn.ts) must NEVER terminate processes until data from at least 2 real runs shows
  false-positive rates are acceptable (gaps > 240s are normal during long builds/tests).
  Decide on run-report data in `.kstack/runs/`.
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
- **KStack Browser Chrome extension** — separate distribution + maintenance; headless
  daemon already covers QA.
- **gbrain / PGLite knowledge brain** — heavy dependency overlapping the learnings
  memory; revisit only if WP4 learnings prove valuable in practice.
- **SKILL.md template generation (`gen-skill-docs` port)** — solves doc drift we do not
  have: `tools.generated.ts` is generated from source; digests are methodology, not
  command references.
- **Full egress receipt ledger** — designed for upstream's dozens of off-machine sinks;
  ours are two (binary download, update-check). A log line suffices.
- **Multi-host abstraction (`hosts/`)** — meaningless for a pi-only extension.
- **`manim-video` / `add-model` (.agents-clean)** — domain utilities of the source
  project, zero workflow relation (rejected at D12 intake).

## Known upstream limitations (documented in the 2026-09 deep review — not fixable in this repo)

These live in the upstream project / bundled browse binary — not fixable in
this repo. `update.sh` and the `source/` submodule were deleted in S1, so they now
track only the pinned binary release (`lib/download.ts`):

- **Browse daemon detached spawns lack `windowsHide`** (`browse/src/cli.ts`
  node launcher, `security.ts` telemetry spawn, `bun-polyfill.cjs` drops the
  flag) — our child-side `--require` preload (`lib/silent-spawn-preload.cjs`)
  covers Node-level descendants; the daemon's own detached launcher is the
  residual window-flash source.
- **`timeoutMs` is advisory at the daemon layer** — the client caps ~30s; long
  upstream operations can outlive it silently.
- **Chain "stops at first error" doc** — upstream `commands.ts` claims it;
  `meta-commands.ts` actually runs the whole batch. Our tool description and
  schema now tell the truth locally.
- **`kstack_download` release asset** is pinned to `v2.0.0` (package is 2.1.0)
  and lacks the server sidecars some commands expect — bump the release tag or
  ship the sidecars before relying on the download fallback on fresh machines.
- **pi dist child-process calls miss `windowsHide`** (`exec.js`, `tools/grep.js`,
  `tools/find.js`, `utils/clipboard.js`) — patched at runtime by our preload
  inside orchestrator-spawned children only; the host pi process is
  intentionally untouched (user decision).

## Notes

- All 28 bundled skills remain invocable manually via `/skill:kstack-*` regardless of wiring.
- Canonical SKILL.md files should stay verbatim-stable across releases where possible —
  provider prompt caches key on exact prefixes.
