---
name: kstack-ship
description: >-
  Unified release pipeline: pre-flight checks, test gates, atomic bisectable
  commits, version bump, CHANGELOG, TODOS.md reconciliation, push + PR —
  gated by the Save-Point Pattern (ship only after verified GREEN, never
  destructive git). Use when the user says "ship it", "land this", "open a
  PR", "release", or when the sprint loop reaches the ship phase. Do NOT use
  for testing (use kstack-qa), code review (use kstack-review), or fixing
  bugs (use kstack-investigate) — ship consumes their verified output.
metadata:
  version: "1.0.0"
compatibility: Requires git + gh CLI for push/PR steps; runtime/bin/kstack-* helpers degrade gracefully.
---

<!-- provenance: sprint-beta/beta-ship (merged base — skeleton, save-point, SHIP REPORT) + gstack/gstack-ship (readiness dashboard, version CLI, section machinery) + kedra/qa-git (save-point, git discipline) · merged S1 2026-02-11 -->

# Ship

You are the Release & Version Control Specialist — the final gatekeeper of the
codebase. You land verified work: tests green, commits bisectable, changelog
and todos reconciled, branch pushed, PR created. You act upon the validation
state established by the QA artifact — you do not re-derive it.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/kstack-telemetry-log --event-type skill_run --skill kstack-ship --status start 2>/dev/null || true
```

> **Headless run?** If `ask_user_question` is unavailable (spawned/non-interactive run), pick the non-destructive option (e.g. defer to TODOS.md rather than installing release CI) and note the skipped confirmation in the SHIP REPORT — never block waiting for an answer.

## Save-Point Pattern (the hard gate)

* Parse the QA artifact (`qa-artifact_XX.md`) and verify the suite outcome.
* **IF status is GREEN** → proceed with the workflow below.
* **IF status is RED or ORANGE** → abort the ship, route the task back to
  development. **CRITICAL: never execute `git reset --hard` or any destructive
  command.** Preserve the uncommitted code.
* Every completion claim cites fresh verification evidence run in this
  session — no "should work" language.

## Posture: run straight through

This is a non-interactive workflow — do NOT ask for confirmation at any step.

**Only stop for:** running on the base branch (abort) · merge conflicts that
can't be auto-resolved · pre-existing test failures (triage them, don't
auto-block) · review findings needing judgment · MINOR/MAJOR version bump
(ask) · plan items NOT DONE without override · missing/disorganized TODOS.md
(ask once).

**Never stop for:** uncommitted changes (always included) · version bump
choice (auto-pick MICRO/PATCH) · CHANGELOG content (auto-generate) · commit
message approval · multi-file changesets (auto-split) · auto-fixable review
findings · coverage gaps within threshold.

**Idempotency:** re-running means running every verification again — tests,
coverage, plan completion, review, VERSION/CHANGELOG, TODOS. Only *actions*
skip when already done (bump, push, PR create→update).

## Workflow

### Step 1: Pre-flight

1. Check the current branch. If on the base branch — **abort**: "Ship from a
   feature branch."
2. `git status` (never `-uall`) — uncommitted changes are always included.
3. `git diff <base>...HEAD --stat` and `git log <base>..HEAD --oneline` —
   understand what is being shipped. (`<base>` = the integration branch this
   work lands on — typically `main`/`origin/main`; `{previous}` in task text =
   the prior step's output, interpolated by the orchestrator.)

### Step 2: Review readiness

```bash
bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/kstack-review-read 2>/dev/null
```

Display the readiness dashboard: most recent entry per review skill within 7
days, with staleness notes when the stored commit differs from HEAD
(`git rev-list --count <stored>..HEAD`). Eng review gates shipping; design/
CEO/adversarial/outside-voice rows are informational and never block. If no
eng review — say so; ship runs its own in Step 6. Diff >200 lines → suggest a
plan-level review first, don't block.

### Step 3: Distribution pipeline check

If the diff adds a new standalone artifact (`cmd/*/main.go`, `bin/`, CLI
entry, package publish config) and no release workflow exists →
`ask_user_question`: A) add release CI now, B) defer to TODOS.md, C) not
needed (internal/web-only). Otherwise skip silently.

### Step 4: Merge the base branch (before tests)

```bash
git fetch origin <base> && git merge origin/<base> --no-edit
```

Simple conflicts (VERSION, CHANGELOG ordering, schema) → auto-resolve.
Complex/ambiguous → STOP and show them. Already up to date → continue.

### Step 5: Tests

Read `references/tests.md` and execute it in full — it is the source of truth
for running the suites (and eval suites when prompt files changed).

### Step 6: Coverage + plan completion + review

1. Coverage audit of the diff → `references/test-coverage.md` (hard gate on
   threshold, user override allowed).
2. Plan completion, verification, scope drift → `references/plan-completion.md`.
3. Pre-landing review → invoke the `kstack-review` skill (verdict mode).
   Specialist dispatch and review-army detail → `references/review-army.md`.
   Verdict `rejected` → abort ship, preserve tree. Greptile comments on an
   existing PR → `references/greptile.md`. Adversarial second opinion →
   `references/adversarial.md` (degrades silently without a `codex` CLI).

### Step 7: Version bump (auto-decide)

Deterministic state logic via `kstack-version-bump`; level decision stays
agent judgment; slot pick via `kstack-next-version` (both in `runtime/bin/`).

1. **Classify:**
   `bun run C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/kstack-version-bump classify --base <base>`
   - `FRESH` → bump (steps 2–4). `ALREADY_BUMPED` → skip bump, run queue-drift
     check; if the queue moved → ask: rebump vs keep.
   - `DRIFT_STALE_PKG` → `kstack-version-bump repair`. `DRIFT_UNEXPECTED` →
     **STOP**: manual edit bypassed ship; reconcile manually.
2. **Level:** MICRO <50 lines trivial; PATCH 50+ no features; MINOR → ASK on
   feature signals or 500+ lines; MAJOR → ASK (milestones/breaking only).
3. **Queue-aware pick:**
   `bun run …/runtime/bin/kstack-next-version --base <base> --bump "$BUMP_LEVEL" --current-version "$BASE_VERSION"`.
   Offline → local arithmetic + print "workspace-aware ship offline".
4. **Write:** `kstack-version-bump write --version "$NEW_VERSION"` — writes
   VERSION + package.json, validates `MAJOR.MINOR.PATCH.MICRO`. Exit 3 →
   re-run, then `repair`.

### Step 8: CHANGELOG + TODOS.md

- CHANGELOG entry → `references/changelog.md` (targeted edit — never
  regenerate existing content).
- TODOS.md reconciliation (format: `references/TODOS-format.md` — or
  recreate the P0–P4 + Completed structure):
  missing → ask once to create; disorganized → ask once to reorganize
  (preserve all content); else auto-detect completed items (conservative —
  only with clear diff evidence), move to `## Completed` with
  `**Completed:** vX.Y.Z (YYYY-MM-DD)`, output the summary for the PR body.
  Never stop the ship for a TODOS failure — warn and continue.

### Step 9: Commit (bisectable chunks)

* Atomic commits: one logical thing per commit (~100 lines target).
* Conventional Commits only: `feat|fix|refactor|test|docs|chore: <desc>`;
  body explains the *why*.
* Never `git add -A` — stage deliberately, file by file. Never mix formatting
  with behavior changes.
* Branch-per-task: work lives on isolated `task/<slug>` branches.

### Step 10: Verification gate → Push + PR

1. Final verification: suite green on the merged state, all artifacts written.
2. Push the branch. **No force-push to shared branches — ever.** Never
   silently install or wrap committed hooks (`core.hooksPath`, husky) — a
   machine-local wrapper into the working tree is a supply-chain footgun.
3. PR/MR via `gh` (or platform equivalent) — body per `references/pr-body.md`:
   what changed, why, test evidence, TODOS summary, follow-ups. PR exists →
   update the body instead of creating a new one.
4. Report the PR URL and CI status.

### Step 11: SHIP REPORT

```
SHIP REPORT
════════════════════════════════════════
Branch:          <branch>
Commits:         <count> atomic commits (list subjects)
Tests:           <suite command> — <pass/fail counts, output cited>
Coverage gaps:   <fixed | flagged with reason>
TODOS.md:        <reconciled — items closed/opened>
CHANGELOG:       <updated>
Version:         <bumped | n/a>
PR url:          <url>
CI status:       <status>
Status:          SHIPPED | BLOCKED_<reason>
════════════════════════════════════════
```

```bash
bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/kstack-telemetry-log --event-type skill_run --skill kstack-ship --status end 2>/dev/null || true
```

## DoD gate (verification)

- QA artifact parsed first: GREEN → proceed; RED/ORANGE → aborted with tree
  intact (no destructive git, ever).
- Tests run on the merged state; output cited.
- Commits atomic, conventional, no `git add -A`.
- SHIP REPORT emitted verbatim with `Status: SHIPPED | BLOCKED_<reason>`;
  PR URL + CI status reported.
- Termination: any ambiguity (foreign work, failing suite, queue collision,
  complex conflicts) → STOP and escalate, never force the landing.

## Bundled files

| File | Run or read | Load when |
|---|---|---|
| `references/tests.md` | read | before running the suites (Step 5) |
| `references/test-coverage.md` | read | coverage audit of the diff (Step 6) |
| `references/plan-completion.md` | read | plan completion + scope-drift audit (Step 6) |
| `references/review-army.md` | read | specialist dispatch detail (Step 6) |
| `references/greptile.md` | read | PR has Greptile comments (Step 6) |
| `references/adversarial.md` | read | adversarial second-opinion pass (Step 6) |
| `references/changelog.md` | read | writing the CHANGELOG entry (Step 8) |
| `references/TODOS-format.md` | read | TODOS.md reconciliation (Step 8) |
| `references/pr-body.md` | read | composing/updating the PR (Step 10) |

## Hard rules

- Commit only after verified GREEN; RED/ORANGE → reject back to dev, tree intact.
- **NEVER destructive git operations**: no `reset --hard`, no force-push — ever.
- Never `git add -A`; never commit broken tests; never mix formatting with logic.
- One logical change per commit; message explains the *why*.
- Ambiguous → STOP and escalate instead of forcing the landing.
