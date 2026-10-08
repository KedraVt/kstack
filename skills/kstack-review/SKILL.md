---
name: kstack-review
description: >-
  Adversarial pre-merge code review: scope-drift detection, five-dimension
  audit (correctness, readability, architecture, security, performance),
  specialist dispatch, confidence-calibrated findings with a quote-the-line
  verification gate, and parseable verdict lines (code-review == approved /
  rejected) for deterministic routing. Use when reviewing a branch or diff
  before merge, when the user says "review this", "check my code", "is this
  ready", or when the sprint loop routes to the review gate. Do NOT use for
  browser-level QA of the running app (use kstack-qa), security threat
  modeling (use kstack-cso), or root-cause debugging (use kstack-investigate).
metadata:
  version: "1.0.0"
compatibility: "Optional helpers: runtime/bin/kstack-review-read (cross-review dedup) and repo script `bun run slop:diff`; both degrade gracefully when absent."
---

<!-- provenance: sprint-beta/beta-code-review (merged base — dimensions, calibration, verdict contract) + gstack/gstack-review (fix-first mode, review army, greptile, dedup) + kedra/code-audit-reviewer (severity, status block) · merged S1 2026-02-11 -->

# Code Review

You evaluate changes against the constraints defined in the system-design
artifact (`system-design_XX.md`) and the plan/task artifacts. You review
thoroughly across five dimensions, then report findings with calibrated
severity and confidence. **No finding without a concrete failure scenario and
a fix; no finding enters the report unless you can quote the line that
motivates it.**

```bash
bash C:/Users/Mattia/.pi/agent/extensions/kstack-pi/runtime/bin/kstack-telemetry-log --event-type skill_run --skill kstack-review --status start 2>/dev/null || true
```

> **Headless run?** If `ask_user_question` is unavailable (spawned/non-interactive run), emit ASK items in the report with `~assumed` resolutions and downgrade the verdict to `needs-human` — never block waiting for an answer.

## Modes

| Mode | When | Behavior |
|------|------|----------|
| **verdict** (default in the sprint loop) | Orchestrator review gate | Audit + emit the artifact; no edits to the diff. |
| **fix-first** | User-driven review with fixes | Classify findings AUTO-FIX/ASK, apply auto-fixes, batch-ask the rest. |

## Workflow

### Step 1: Establish the diff

1. `git branch --show-current` — if on the base branch with no changes:
   "Nothing to review" and stop.
2. `git fetch origin <base> --quiet && DIFF_BASE=$(git merge-base origin/<base> HEAD) && git diff "$DIFF_BASE"` —
   committed + uncommitted changes, excluding commits that landed on base
   after branching.

### Step 1.5: Scope Drift Detection

Before reviewing code quality, check: **did they build what was requested —
nothing more, nothing less?**

1. Read the intent sources: task backlog (`tasks_XX.md`), user story
   (`user-story_XX.md`), plan file, commit messages.
2. Identify the **stated intent** — what was this branch supposed to do?
3. `git diff "$DIFF_BASE" --stat` — compare files changed vs stated intent.

Evaluate with skepticism:

- **SCOPE CREEP**: files changed unrelated to intent; "while I was in there…"
  refactors expanding blast radius.
- **MISSING REQUIREMENTS**: plan requirements not addressed; test coverage
  gaps; partial implementations.

Output (informational — does not block):

```
Scope Check: [CLEAN / DRIFT DETECTED / REQUIREMENTS MISSING]
Intent: <1-line summary of what was requested>
Delivered: <1-line summary of what the diff actually does>
[If drift: list each out-of-scope change]
[If missing: list each unaddressed requirement]
```

### Plan Completion Audit (when a plan/tasks artifact exists)

Extract every actionable item from the plan (checkboxes, imperative steps,
file-level specs, test requirements — cap 50, ignore context/deferred items).
Classify each:

- **DONE** — clear evidence the item shipped (cite files; touched ≠ shipped).
- **PARTIAL** — work exists but incomplete.
- **NOT DONE** — negative evidence.
- **CHANGED** — goal achieved differently; be generous, note the difference.
- **UNVERIFIABLE** — diff can't prove it (external state); cite the manual
  check required. When in doubt between DONE and UNVERIFIABLE → UNVERIFIABLE.

For each PARTIAL/NOT DONE: `DISCREPANCY | item | delivered | likely reason |
impact HIGH/MEDIUM/LOW`.

### Step 2: The Five Dimensions

1. **Correctness** — spec met? edge cases? tests verify behavior?
2. **Readability** — clear? descriptive names? straightforward flow?
3. **Architecture** — aligns with `system-design_XX`? appropriate
   abstractions? **Glossary violations (Ubiquitous Language) are blocking
   defects.**
4. **Security** — input validated? secrets safe? parameterized queries? trust
   boundaries?
5. **Performance** — N+1? unbounded loops? unnecessary sync?

The full category list + "DO NOT flag" suppressions + the Fix-First heuristic:
`references/checklist.md`. UI in the diff → also `references/design-checklist.md`.

### Step 2.5: Advisory scans (skip silently if unavailable)

- `bun run slop:diff origin/<base> 2>/dev/null || true` — AI-slop findings
  (empty catches, redundant `return await`, over-abstraction); informational
  only, never blocking.
- Greptile comments on the PR → classify per `references/greptile-triage.md`
  (valid→fix-first flow, FP→reply-with-evidence, already-fixed→template).

### Step 3: Critical pass

Apply the CRITICAL categories from the checklist against the diff: SQL & Data
Safety, Race Conditions & Concurrency, LLM Output Trust Boundary, Shell
Injection, **Enum & Value Completeness** (requires reading code OUTSIDE the
diff: grep all files referencing sibling values and check the new one is
handled), Async/sync mixing, Column/field name safety, Type coercion,
Time-window safety, Completeness gaps.

**Search before recommending:** verify a fix pattern is current best practice
for the framework version in use; check built-in solutions in newer versions
first.

### Step 3.5: Specialist dispatch (when diff is large or high-risk)

For diffs touching multiple domains, dispatch focused passes using the
bundled specialist lenses — read the matching file under
`references/`: `security`, `performance`, `maintainability`,
`testing`, `api-contract`, `data-migration`, `red-team`. Dispatch only the
lenses the diff actually touches; each specialist finding still passes
through the Step 4 verification gate.

### Step 4: Confidence calibration + pre-emit gate

Every finding carries a confidence score (1–10):

| Score | Meaning | Display rule |
|-------|---------|--------------|
| 9-10 | Verified by reading specific code; bug demonstrated | Show |
| 7-8 | High-confidence pattern match | Show |
| 5-6 | Moderate; could be false positive | Show with caveat |
| 3-4 | Low; suspicious pattern | Appendix only |
| 1-2 | Speculation | Only if severity would be P0 |

**Pre-emit verification gate:** before a finding enters the report:

1. **Quote the specific code line(s)** that motivate it — file:line plus the
   verbatim triggering text. "Field X doesn't exist on Y" → quote Y's class
   body. "Race between A and B" → quote both.
2. **If you cannot quote the motivating line(s), the finding is unverified** —
   force confidence to 4-5 (appendix only). Never invent speculative 7+
   confidence to bypass the gate.

Framework-generated symbols (ORM Meta, decorators, migrations, generated
clients): quote the meta-construct — "I read the source that creates this
symbol", not "I grep'd and didn't find it."

**Verification of claims:** "this pattern is safe" → cite the line proving it;
"handled elsewhere" → cite the handler; "tests cover this" → name the test.
"This looks fine" is not a finding — cite evidence or flag unverified.

### Step 5: Findings + verdict (verdict mode)

**Finding format:**

```
[CRITICAL] (confidence: 9/10) app/models/user.rb:42 — SQL injection via string interpolation in where clause
  Failure scenario: <concrete scenario showing the failure>
  Fix: <copy-paste-ready remediation>
```

**Severity:** CRITICAL (must fix before merge — never approve with open
CRITICALs) · HIGH (should fix) · MEDIUM (quality gap worth fixing now) ·
LOW/Suggestion.

**Cross-review dedup:** run `bash C:/Users/Mattia/.pi/agent/extensions/kstack-pi/runtime/bin/kstack-review-read 2>/dev/null` —
suppress findings whose fingerprint was previously `skipped` by the user AND
whose file is unchanged since that review. Never suppress `fixed`/`auto-fixed`
(those may regress). No prior reviews → skip silently.

**Cross-references:** if `TODOS.md` exists — does the diff close open TODOs
(note them) or create new TODO-shaped work (flag)? If docs exist — flag stale
documentation the diff invalidates.

**Adversarial pass (optional):** if a `codex` CLI is on PATH, run an
adversarial second-opinion pass on the diff and merge its confirmed findings;
if absent, skip silently.

**Output artifact** (dual channel — the orchestrator cross-checks both before
routing): write `devsecops/code-review-artifact_XX.md` ending with EXACTLY ONE
verbatim verdict line — `code-review == approved` or
`code-review == rejected` — repeated in your `## HANDOFF`:

```markdown
## Code Review Report
code-review == approved        ← or `code-review == rejected`; exactly one, verbatim
Scope Check: CLEAN | DRIFT DETECTED | REQUIREMENTS MISSING
problems-code: none | <summary of critical/high issues for developers>

### Critical/High Issues (problems-code details)
- **[File:line]** [Description]
  - *Failure scenario:* [concrete failure]
  - *Fix:* [actionable snippet]

### Suggestions
- **[File:line]** [Description]

### Verification Checklist
* [ ] Code compiles and passes CI
* [ ] Unit/E2E tests verify the change
* [ ] Adheres to system-design_XX architecture
* [ ] No hardcoded secrets or vulnerabilities
```

**Verdict discipline:** `approved` only with zero open CRITICALs (and no
unaddressed HIGH-impact plan discrepancies). `rejected` requires the problems
list so developers can act without re-deriving the analysis. Persist the
verdict: `bash C:/Users/Mattia/.pi/agent/extensions/kstack-pi/runtime/bin/kstack-review-log 2>/dev/null || true`
(enables cross-review dedup on the next run).

## Fix-first mode

When the user asked for review *and* fixes:

1. Classify every finding per the Fix-First Heuristic in `references/checklist.md`:
   mechanical/informational → AUTO-FIX; critical/judgment → ASK. Any finding
   carrying a `test_stub` → forced ASK (show proposed test path + code).
2. Auto-fix all AUTO-FIX items; one line each:
   `[AUTO-FIXED] [file:line] Problem → what you did`.
3. Batch all ASK items in ONE `ask_user_question` (numbered, severity,
   problem, recommended fix, A) Fix B) Skip + overall RECOMMENDATION).
4. Apply approved fixes; `[FIXED + TEST]` when a test stub shipped too.
5. Then emit the normal verdict artifact.

## DoD gate (verification)

- Artifact ends with exactly one verbatim `code-review ==` verdict line
  (value `approved` or `rejected`) AND repeats it inside `## HANDOFF`.
- `approved` ⟹ zero open CRITICALs and no unaddressed HIGH-impact plan
  discrepancy; `rejected` ⟹ `problems-code` filled.
- Every finding has: file:line, confidence, concrete failure scenario, fix.
- No finding ≥5 confidence without the quoted motivating line(s).
- Scope Check emitted (CLEAN / DRIFT / MISSING).
- Termination: nothing to review on base → stop early, say so.

## Bundled files

| File | Run or read | Load when |
|---|---|---|
| `references/checklist.md` | read | every run — categories, suppressions, fix-first heuristic |
| `references/design-checklist.md` | read | diff touches UI/frontend |
| `references/greptile-triage.md` | read | Greptile comments exist on the PR |
| `references/TODOS-format.md` | read | writing new TODO entries |
| `references/<lens>.md` | read | Step 3.5 — security, performance, maintainability, testing, api-contract, data-migration, red-team |

## Related skills

- `kstack-cso` — deep security audit beyond review's security dimension
- `kstack-qa` — runtime/browser verification after review
- `kstack-ship` — release workflow once approved
- `kstack-investigate` — root-cause the bugs the review surfaces

---

**No finding without a concrete failure scenario and a fix; no finding enters
the report unless you can quote the line that motivates it.**
