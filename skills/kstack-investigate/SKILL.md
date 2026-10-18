---
name: kstack-investigate
description: >-
  Systematic debugging for any bug, test failure, or unexpected behavior.
  Iron Law: no fixes without root-cause investigation — five gated phases
  ending in a structured DEBUG REPORT (DONE / DONE_WITH_CONCERNS / BLOCKED).
  Use when a test fails, a bug reproduces, a stack trace appears, performance
  regresses, a build breaks, or the user says "it's broken", "fix this", "why
  does X fail" — even before proposing a fix, and especially under time
  pressure when guessing is tempting. Do NOT use for verifying an
  already-applied fix end-to-end (use kstack-qa), choosing between fix and
  refactor (use kstack-fix-strategy), or writing tests from scratch (use
  test-driven-development).
metadata:
  version: "1.0.1"
compatibility: Runtime helpers under runtime/ (skills/kstack-investigate/scripts/find-polluter.sh, browse binary); all degrade gracefully when absent.
---

<!-- provenance: sprint-beta/beta-debugging (merged base — phases, contract) + gstack/gstack-investigate (upstream body, stripped) + kedra/systematic-debugging (signals section, references) · merged S1 2026-02-11 -->

# Systematic Debugging

> **Headless run?** If `ask_user_question` is unavailable (spawned/non-interactive run), proceed with the strongest hypothesis at reduced confidence and mark every unconfirmed assumption `~assumed` in the DEBUG REPORT — never block a gate waiting for an answer.

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

Fixing symptoms creates whack-a-mole debugging: every fix that doesn't address
root cause makes the next bug harder to find. If you haven't completed Phase 1,
you cannot propose fixes. **Violating the letter of this process is violating
the spirit of debugging.**

Use for ANY technical issue: test failures, production bugs, unexpected
behavior, performance problems, build failures, integration issues. Use it
ESPECIALLY when under time pressure (emergencies make guessing tempting), when
"just one quick fix" seems obvious, when a previous fix didn't work, or when
you don't fully understand the issue. Simple bugs have root causes too —
rushing guarantees rework.

## The Five Phases

You MUST complete each phase before proceeding to the next.

### Phase 1: Root Cause Investigation

Gather context before forming any hypothesis.

1. **Read error messages carefully.** Read stack traces completely; note line
   numbers, file paths, error codes. Errors often contain the exact solution.

2. **Reproduce consistently.** Can you trigger it reliably? What are the exact
   steps? If not reproducible → gather more data, don't guess.

3. **Check recent changes.**
   ```bash
   git log --oneline -20 -- <affected-files>
   ```
   Was this working before? A regression means the root cause is in the diff.

4. **Instrument multi-component systems.** When the failure spans component
   boundaries (CI → build → signing, API → service → database), add diagnostic
   logging at EACH boundary — what enters, what exits, state at each layer —
   run once, and let the evidence show WHERE it breaks before investigating
   that specific component. Fix at the failing layer, not where the error
   surfaces.

5. **Trace data flow.** When the error is deep in a call stack: where does the
   bad value originate? What called this with a bad value? Keep tracing
   backward until you find the source. Read `references/root-cause-tracing.md`
   for the complete backward-tracing technique.

6. **Check investigation history.** Search TODOS.md and `git log` for prior
   investigations on the same files. Recurring bugs in the same area are an
   architectural smell — note patterns and check whether the prior root cause
   was structural. If a test fails only inside the full suite (never alone),
   suspect test pollution: run `scripts/find-polluter.sh` to isolate it.

**Output of Phase 1:** a specific, testable claim — *"Root cause hypothesis:
X, because Y"* — plus the mechanism pinned to `file:line` locations.

### Scope Lock

After forming the hypothesis, lock edits to the affected module (e.g.
`src/auth/`) to prevent scope creep, and say so explicitly: "Edits restricted
to `<dir>/` for this debug session." If the bug genuinely spans the repo, skip
the lock and note why.

### Phase 2: Pattern Analysis

Check if this bug matches a known pattern before fixing:

| Pattern | Signature | Where to look |
|---------|-----------|---------------|
| Race condition | Intermittent, timing-dependent | Concurrent access to shared state |
| Nil/null propagation | NoMethodError, TypeError | Missing guards on optional values |
| State corruption | Inconsistent data, partial updates | Transactions, callbacks, hooks |
| Integration failure | Timeout, unexpected response | External APIs, service boundaries |
| Configuration drift | Works locally, fails in staging/prod | Env vars, feature flags, DB state |
| Stale cache | Shows old data, fixes on cache clear | Redis, CDN, browser cache |

If the bug involves flaky waits or timing-dependent assertions, read
`references/condition-based-waiting.md` — replace arbitrary sleeps with
condition polling.

Also find **working examples**: locate similar working code in the same
codebase, compare against references (read reference implementations
COMPLETELY — partial understanding guarantees bugs), and list every difference
between working and broken, however small.

**External search (optional):** if the bug matches no known pattern, search the
error *category* — sanitized first: strip hostnames, IPs, file paths, SQL,
customer data. Present a documented solution as a candidate hypothesis in
Phase 3.

### Phase 3: Hypothesis Testing

Before writing ANY fix, verify the hypothesis scientifically:

1. **Form a single hypothesis.** "I think X is the root cause because Y."
   Specific, not vague.

2. **Confirm it minimally.** Add a temporary log statement, assertion, or debug
   output at the suspected root cause. Run the reproduction. One variable at a
   time — never test multiple changes at once.

3. **If the hypothesis is wrong:** gather more evidence and return to Phase 1.
   Do NOT add fixes on top. Form a NEW hypothesis.

4. **When you don't know:** say "I don't understand X" — don't pretend to know.
   Research or ask.

5. **3-strike rule.** If 3 hypotheses fail, STOP and escalate to the human via
   `ask_user_question` with these options:
   - A) Continue investigating — new hypothesis: [describe]
   - B) Escalate for human review — this needs someone who knows the system
   - C) Add logging and wait — instrument the area, catch it next occurrence

### Phase 4: Implementation (Minimal Fix)

Fix the root cause, not the symptom:

1. **Create a failing test first** — simplest possible reproduction, automated
   if possible. Use the `kstack-test-driven-development` skill for proper failing
   tests. A regression test MUST fail without the fix and pass with it.

2. **Implement a single fix** — the smallest change that eliminates the actual
   problem. ONE change at a time. No "while I'm here" improvements, no bundled
   refactoring, minimal diff (fewest files touched).

3. **Verify the fix.** Test passes now? No other tests broken? Issue actually
   resolved? Run the full suite and paste the output.

4. **If the fix touches >5 files, flag the blast radius** via
   `ask_user_question` before proceeding: A) proceed — the root cause
   genuinely spans these; B) split — fix the critical path now, defer the
   rest; C) rethink — there may be a more targeted approach.

5. **If 3+ fixes failed, question the architecture.** Signals: each fix reveals
   new shared state/coupling in a different place; fixes require "massive
   refactoring"; each fix creates new symptoms elsewhere. This is NOT a failed
   hypothesis — it is a wrong architecture. STOP and discuss with the human
   before attempting more fixes.

6. **Add defense in depth where warranted.** After the fix lands, if the bug
   class could recur at a different layer, read
   `references/defense-in-depth.md` for the multi-layer validation pattern.

### Phase 5: Verification & Report

Fresh verification: reproduce the ORIGINAL bug scenario and confirm it's fixed.
This is not optional — never claim a fix works without re-running the
reproduction. Then output the structured report:

```
DEBUG REPORT
════════════════════════════════════════
Symptom:         [what the user observed]
Root cause:      [what was actually wrong]
Fix:             [what was changed, with file:line references]
Evidence:        [test output, reproduction attempt showing fix works]
Regression test: [file:line of the new test]
Related:         [TODOS.md items, prior bugs in same area, architectural notes]
Discoveries:     [non-obvious findings made along the way — brittle invariants, hidden couplings, surprising call paths]
Status:          DONE | DONE_WITH_CONCERNS | BLOCKED
════════════════════════════════════════
```

Status semantics:
- **DONE** — root cause found, fix applied, regression test written, all tests pass
- **DONE_WITH_CONCERNS** — fixed but cannot fully verify (intermittent, needs staging)
- **BLOCKED** — root cause unclear after investigation, escalated

## Human Partner's Signals You're Doing It Wrong

Watch for these redirections — they mean: STOP, return to Phase 1:

- "Is that not happening?" — you assumed without verifying
- "Will it show us...?" — you should have added evidence gathering
- "Stop guessing" — you're proposing fixes without understanding
- "Ultrathink this" — question fundamentals, not just symptoms
- "We're stuck?" (frustrated) — your approach isn't working

## Red Flags — STOP and Return to Phase 1

- "Quick fix for now, investigate later" — there is no "for now"
- "Just try changing X and see if it works" — that's guessing
- "Add multiple changes, run tests" — can't isolate what worked
- "Skip the test, I'll manually verify" — untested fixes don't stick
- "It's probably X, let me fix that" — seeing symptoms ≠ understanding cause
- Proposing solutions before tracing data flow
- "One more fix attempt" (when already 2+ have failed)
- Each fix reveals a new problem in a different place — wrong layer, not wrong code

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process" | Systematic debugging is FASTER than guess-and-check thrashing. |
| "Just try this first, then investigate" | The first fix sets the pattern. Do it right from the start. |
| "I'll write the test after the fix works" | Test first proves the fix means something. |
| "Multiple fixes at once saves time" | Can't isolate what worked. Causes new bugs. |
| "Reference too long, I'll adapt the pattern" | Partial understanding guarantees bugs. Read it completely. |
| "I see the problem, let me fix it" | Seeing the symptom is not the mechanism. |
| "One more fix attempt" (after 2+ failures) | 3+ failures = architectural problem. Question the pattern. |

## Quick Reference

| Phase | Key activities | Success criteria |
|-------|----------------|------------------|
| 1. Root cause | Read errors, reproduce, check changes, instrument, trace | Mechanism @ file:line |
| 2. Pattern | Known-pattern table, working examples, differences | Identified differences |
| 3. Hypothesis | Form theory, test minimally, 3-strike | Confirmed or new hypothesis |
| 4. Fix | Failing test → single minimal fix → verify | Tests green, no regressions |
| 5. Report | Fresh reproduction, DEBUG REPORT | Evidence before claims |

## When Process Reveals "No Root Cause"

If investigation shows the issue is truly environmental, timing-dependent, or
external: document what you investigated, implement appropriate handling
(retry, timeout, clearer error), add monitoring for future investigation.
**But: most "no root cause" conclusions are incomplete investigation.**

## DoD gate (verification)

- Root cause hypothesis named, with mechanism pinned to `file:line`.
- Regression test exists: fails without the fix, passes with it.
- Full suite run after the fix — output pasted, no regressions.
- `DEBUG REPORT` emitted verbatim with `Status: DONE | DONE_WITH_CONCERNS | BLOCKED`.
- Scope lock declared (or skip reason noted); >5 files touched → blast radius confirmed via `ask_user_question`.
- Termination: after 3 failed hypotheses → escalate A/B/C; after 3 failed fixes → question architecture.

## Bundled files

| File | Run or read | Load when |
|---|---|---|
| `references/root-cause-tracing.md` | read | error is deep in a call stack (Phase 1) |
| `references/defense-in-depth.md` | read | bug class could recur at another layer (Phase 4) |
| `references/condition-based-waiting.md` | read | flaky waits / timing-dependent failures (Phase 2) |
| `references/condition-based-waiting-example.ts` | read | concrete pattern for the above |
| `scripts/find-polluter.sh` | run (`bash scripts/find-polluter.sh`) | test fails only inside the full suite |

## Related skills

- `kstack-test-driven-development` — failing-test-first discipline (Phase 4)
- `kstack-verification-before-completion` — evidence before claims (Phase 5)
- `kstack-fix-strategy` — validate-first minimal-fix strategy once the cause is confirmed
- `kstack-qa` — end-to-end verification of the shipped fix

---

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1, you cannot propose fixes. **Violating the
letter of this process is violating the spirit of debugging.**
