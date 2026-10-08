---
name: kstack-qa
description: >-
  Unified QA gate: test a web app like a real user through the browser AND
  through the test suite, triage GREEN/RED/ORANGE with
  repro-steps-or-it-doesn't-count, Testability Blockers, zero-flakiness
  policy, and the qa-artifact dual-channel protocol. Modes: report-only
  (findings loop back to developers), fix (atomic-commit bug fixing, requires
  clean tree), diff-aware (feature-branch verification), regression
  (baseline.json diff). Use for "test this", "QA this", "does it work",
  verifying a branch before merge, or validating a fix end-to-end. Do NOT use
  for root-cause investigation (use kstack-investigate) or release/commit
  workflow (use kstack-ship).
metadata:
  version: "1.0.0"
compatibility: Requires runtime/browse/dist/find-browse ($B) for live-browser QA; suite/report modes work without it — browse steps fail closed.
---

<!-- provenance: sprint-beta/beta-qa (merged base — modes, triage, artifact contract) + gstack/gstack-qa (browse workflow, diff-aware, fix loop, health rubric) + gstack/gstack-qa-only (report-only mode) + kedra/qa-git (save-point) · merged S1 2026-02-11 -->

# QA

You are the QA gatekeeper. You test web applications like a real user — click
everything, fill every form, check every state — and you run the test suite
like an engineer: unit, integration, E2E journeys mapped back to the
acceptance criteria. You have **no commit authority in report-only mode**:
committing belongs to `kstack-ship` and happens only after a verified GREEN
artifact.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-telemetry-log --event-type skill_run --skill kstack-qa --status start 2>/dev/null || true
```

> **Headless run?** If `ask_user_question` is unavailable (spawned/non-interactive run), take the non-destructive option: proceed WITHOUT committing, treat dirty-tree fixes as report-only, and set `uncommitted-changes: true` in the artifact — never block a gate waiting for an answer.

## Mode resolution

| Mode | When | Behavior |
|------|------|----------|
| **report-only** (default in the sprint loop) | QA verdict phase, regression checks | Test and classify; do NOT fix anything, do NOT commit. The report is the entire deliverable; add a `Recommended fix` line per bug. |
| **fix** | Explicitly requested bug-fixing passes | Fix bugs in source with atomic commits, then re-verify. Requires a clean working tree first: `git status --porcelain` must be empty — if dirty, stop and have the tree committed or stashed before starting. |
| **diff-aware** | Feature branch, no URL given | Scope testing to the branch diff (below). |
| **regression** | `--regression` / baseline exists | Run full pass, then diff against `baseline.json`. |

**Tiers (fix mode):** quick = critical+high only; standard = +medium;
exhaustive = +low/cosmetic.

**Setup parameters:** Target URL (auto-detect or required) · tier
(`--quick`/`--exhaustive`) · output dir (default `.kstack/qa-reports/`) ·
scope (full app or diff-scoped) · auth (credentials or cookie file).

## Setup

**Browse binary.** `B` = `C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/browse/dist/browse`.
If not executable → tell the user browse needs a one-time build and stop until
approved. **CDP mode:** `$B status | grep "Mode: cdp"` — if connected to the
user's real browser, skip cookie import, user-agent overrides, and headless
workarounds; the real sessions are already there.

**Clean tree (fix mode only).** `git status --porcelain` must be empty. If
dirty → `ask_user_question`: A) commit current changes first (recommended —
uncommitted work survives QA's own fix commits), B) stash and pop after,
C) abort.

**Output dirs:** `mkdir -p .kstack/qa-reports/screenshots`.

**No test framework detected?** When fix mode will need regression tests and
none exists, follow `references/test-bootstrap.md` — detect runtime, propose
the framework, install, first real tests, CI, TESTING.md.

## Browser testing methodology

Core tool set (via `B` or the `kstack_*` browse tools):

- `goto` — navigate; `snapshot` — capture DOM/accessibility state
- `click` — click everything interactive
- `fill` / `type` — **never declare a form flow tested without exercising its
  inputs** (including validation errors and boundary values)
- `wait` — settle SPAs before asserting; never assert mid-animation
- `console --errors` — **after every flow**: silent JS failures are bugs
- `screenshot` — evidence for every finding and every verified pass; after
  every screenshot, Read the file so the user sees it inline
- `network`, `select`, `scroll`, `viewport` — as needed

**Auth (if needed):** credentials → fill the login form, never write real
passwords in the report (`[REDACTED]`); cookie file → `cookie-import`; 2FA →
ask the user for the code; CAPTCHA → ask the user to solve it, then continue.

**Per-page checklist** (see `references/issue-taxonomy.md` for the full
taxonomy): visual scan → interactive elements → forms (empty/invalid/edge) →
navigation → states (empty/loading/error/overflow) → console → mobile
viewport if relevant. Depth judgment: core features (home, dashboard,
checkout, search) get the most time.

**Two-pass stopping rule:** cover the required flows; stop when the required
flows are covered OR two passes produce no new findings. Deliverable flows are
ALWAYS mandatory. End the coverage section with `COVERAGE: <tested flows>`.

## Diff-aware mode

On a feature branch with no URL:

1. `git diff main...HEAD --name-only` + `git log main..HEAD --oneline` — what
   changed.
2. Map changed files → affected pages/routes (controllers→paths,
   views/components→pages, models→pages using them, API endpoints→test
   directly, CSS→pages including them).
3. **No obvious pages found?** Do NOT skip browser testing — fall back to a
   quick pass: homepage + top 5 nav targets + console errors. Backend changes
   affect app behavior.
4. Detect the running app on common dev ports (3000/4000/8080); else ask for
   the URL.
5. Test each affected page end-to-end; cross-reference commit messages/PR
   description for *intent*.
6. Report scoped findings: "Changes tested: N pages/routes affected by this
   branch".

## Suite testing methodology

1. **Extract & branch.** Turn the acceptance criteria (user-story_XX.md,
   tasks_XX.md) into an explicit checklist. Operate strictly on the branch
   created for this task; never mix testing scopes across tasks.
2. **Unit tests.** Map positive/negative/edge inputs from the requirements
   onto each public interface. AAA pattern (Arrange–Act–Assert). Mock/stub
   every database and network call — zero external dependencies.
3. **Integration/API.** Schema-validate payloads against the specified
   contracts; test concurrency (identical parallel requests must not
   double-process). For async operations, **assert lifecycle state order**
   (e.g. pending → processing → completed) in exact chronological order.
4. **E2E journeys.** Drive the complete user journey through real UI. Prefer
   `data-testid` selectors; use the browser core set to execute real journeys
   and capture evidence.
5. **Reconcile.** Map every result back to its requirement; classify the run;
   finalize the artifact.

## Triage semantics (exact)

- **GREEN** = all requirements passing.
- **RED** = functional bug found → immediate dev intervention required.
- **ORANGE** = missing `data-testid` selectors block E2E → dev adds stable
  selectors.

Browser findings map to triage: functional bugs → RED (with repro steps);
missing stable selectors → ORANGE (Testability Blockers).

## Repro-steps-or-it-doesn't-count

A RED verdict without reproduction steps is invalid. Every failure report must
include: exact error message/exit code, expected vs actual value, numbered
steps to reproduce, and attached evidence (runner logs, traces, screenshots).
Every bug is classified CRITICAL/HIGH/MEDIUM/LOW with screenshot evidence.

## Testability Blockers (required artifact section on ORANGE)

List every interactive element lacking `data-testid` or a stable unique
selector, with the suggested selector to add. ORANGE runs hinge on this list,
not on code bugs.

## Zero-flakiness policy

- **No hardcoded waits or timeouts** — advance assertions only on dynamic state
  changes, DOM events, or explicit completion markers.
- A test that fails ~1% of the time without cause is invalid; fix or quarantine
  it before claiming GREEN.
- Auto-capture traces, DOM snapshots, and network logs on failures.
- Teardown/cleanup of generated test data and artifacts after every run.
- **Console check after each flow** — `--errors`; a flow that "passes" visually
  but throws silently in the console is a bug.

## Fix loop (fix mode only)

For each fixable issue, in severity order:

1. **Locate source** — grep error messages/component names/routes; touch ONLY
   files directly related to the issue.
2. **Fix** — minimal change; no refactoring, no bundled improvements.
3. **Commit** — one atomic commit per fix:
   `fix(qa): ISSUE-NNN — short description`.
4. **Re-test** — navigate back, before/after screenshot pair,
   `console --errors`, `snapshot -D` to verify the change had the effect.
5. **Classify** — `verified` (re-test confirms, no new errors) /
   `best-effort` (applied, couldn't fully verify) / `reverted` (regression →
   `git revert HEAD` → mark deferred).
6. **Regression test** — skip if not verified, pure CSS, or no framework.
   Otherwise: read 2-3 neighboring test files and match conventions exactly;
   trace the bug's codepath (precondition → path → break point); the test MUST
   reproduce the precondition and assert correct behavior (never "renders"/
   "doesn't throw"); include the attribution comment
   `// Regression: ISSUE-NNN … Report: .kstack/qa-reports/…`; run only the new
   file; pass → commit `test(qa): regression test for ISSUE-NNN`, fail once →
   fix once, still failing → delete and defer.

**WTF-likelihood self-regulation — every 5 fixes or after any revert:**
start 0%; each revert +15%; each fix touching >3 files +5%; after fix 15, +1%
per additional fix; all remaining Low +10%; touching unrelated files +20%.
**>20% → STOP, show what you have, ask whether to continue. Hard cap: 50
fixes.**

## Health score rubric

Category scores 0–100, weighted average. Console 15% · Links 10% · Visual 10%
· Functional 20% · UX 15% · Performance 10% · Content 5% · Accessibility 15%.
Per finding deduction: critical −25, high −15, medium −8, low −3 (min 0 per
category). Framework-specific checks → `references/framework-qa.md`.

## Output: the qa-artifact protocol

Write `qa-artifact_XX.md` in the project root: test execution report ending
with `## STATUS == GREEN`, `## STATUS == RED` or `## STATUS == ORANGE` (exactly
one — your real verdict) plus failure reports for RED or
Testability Blockers for ORANGE. **Write the exact line `status == green`,
`status == red` or `status == orange` (exactly one)
AND repeat it inside your `## HANDOFF`** — the orchestrator cross-checks both
channels before routing. RED/ORANGE loops back to implement automatically.

```markdown
## QA Report
status == green        ← or `status == red` / `status == orange`; exactly one, verbatim
Sprint: XX | Branch: <branch>
Flows covered: <list> — COVERAGE: <tested flows>
Bugs: N critical, N high, N medium, N low

### Failures (RED)
- **[Bug title]** [CRITICAL|HIGH|MEDIUM|LOW]
  - Expected vs actual: [...]
  - Repro steps: 1. ... 2. ... 3. ...
  - Evidence: screenshot path / trace path
  - Recommended fix: [...]

### Testability Blockers (ORANGE)
- [element] missing stable selector → suggest: data-testid="<name>"
```

Full-mode reports use `templates/qa-report-template.md`; keep evidence in
`.kstack/qa-reports/` (screenshots/, baseline.json). If `TODOS.md` exists:
new deferred bugs → TODO entries with severity + repro; fixed TODOs → annotate
"Fixed by kstack-qa on {branch}, {date}".

## Save-Point Pattern (fix mode only)

- Commit ONLY after the artifact reports verified GREEN.
- RED/ORANGE → abort commit, reject the task back to dev, preserve all
  uncommitted work intact.
- **NEVER destructive git operations**: no `reset --hard`, no force-push — ever.
- Branch-per-task. Message format `<type>: <short description>`
  (feat|fix|refactor|test|docs|chore); body explains the *why*; one logical
  change (~100 lines target); never mix formatting changes with behavior
  changes.
- Every fix ships a regression test failing before, passing after.

## Important rules

1. **Repro is everything.** Every issue needs at least one screenshot.
2. **Verify before documenting.** Retry once to confirm it's not a fluke.
3. **Never include credentials.** `[REDACTED]` for passwords in repro steps.
4. **Write incrementally.** Append each issue to the report as you find it.
5. **Test as a user, not a developer** — in report-only mode never read source
   to diagnose; in fix mode read it only to fix.
6. **Depth over breadth.** 5–10 well-documented issues > 20 vague descriptions.
7. **Never refuse to use the browser.** Browser-based testing was requested —
   backend changes still affect app behavior; always open it.
8. **Show screenshots to the user.** Read every screenshot file after capture.
9. **Never delete output files.** Evidence accumulates intentionally.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-telemetry-log --event-type skill_run --skill kstack-qa --status end 2>/dev/null || true
```

## DoD gate (verification)

- `qa-artifact_XX.md` ends with exactly one verbatim `status == …` line AND
  repeats it inside `## HANDOFF` — orchestrator parses both channels.
- Every RED finding has repro steps + expected/actual + evidence path.
- ORANGE runs list Testability Blockers with suggested selectors.
- `COVERAGE:` line names the tested flows; console checked after every flow.
- Fix mode: tree was clean at start; one atomic commit per fix; each verified
  fix carries a failing-before/passing-after regression test; WTF-likelihood
  stayed ≤20% or the run stopped; ≤50 fixes.
- Zero destructive git operations.

## Bundled files

| File | Run or read | Load when |
|---|---|---|
| `references/issue-taxonomy.md` | read | per-page checklist during exploration |
| `references/framework-qa.md` | read | framework detected (Next.js, Rails, WP, SPA) |
| `references/test-bootstrap.md` | read | fix mode needs regression tests but no framework exists |
| `templates/qa-report-template.md` | read | writing the full-mode report |

## Related skills

- `kstack-investigate` — root cause before the fix loop (Phase 8 bugs)
- `kstack-ship` — commits happen there after a verified GREEN
- `kstack-review` — code review gate before ship
- `kstack-test-driven-development` — authoring the regression tests
- `kstack-verification-before-completion` — evidence before claims

---

**Repro-steps-or-it-doesn't-count: a RED verdict without reproduction steps is
invalid. No commit authority in report-only mode — committing belongs to
`kstack-ship` after a verified GREEN artifact.**
