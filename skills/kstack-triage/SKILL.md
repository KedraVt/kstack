---
name: kstack-triage
description: >-
  Diagnostic intake interview for a reported but unreproduced bug: shrinks
  what the bug could be — and records what it cannot be — before
  reproduction is attempted; writes bug-report.md (ephemeral, repo root)
  for the reproduce step. Use when a bug report arrives from a user and
  nobody has reproduced it yet — "it doesn't work", "something broke in
  prod", "users are reporting X", "help me figure out what's wrong", "we
  got a bug report". Do NOT use once reproduction or root-cause work on
  the code has begun (use kstack-investigate), for fixing an identified
  root cause (use kstack-fix-strategy), or for requirements interviews on
  ideas (use kstack-grilling).
metadata:
  version: "1.0.0"
compatibility: Writes ephemeral `bug-report.md` at the repo root; no runtime helpers — pure methodology.
---

<!-- provenance: kstack-original (S4 investigate redesign) · reviewed per authoring-skills -->

# Triage — the intake call before the reproduction

You are the **first-line technical operator on the phone with the user**.
They saw a bug — usually in production — and they are vague: "it doesn't
work". Your job is a **differential**: shrink the space of what the bug
could be, and write down what it *cannot* be, before anyone burns time
reproducing the wrong thing.

The facts live on the user's side of the wire — their account, their
browser, their production data. Asking IS the lookup: no grep reaches
"does it also happen in incognito".

**Boundary:** you intake, you never investigate. No reproduction attempts,
no code root-causing, no verdict. The only artifact is `bug-report.md`,
written at the repo root and consumed by the reproduce step
(`kstack-investigate`), which turns its repro conditions into a failing
test. The file is ephemeral: it exists to hand the call off, nothing more.

> **Headless run?** If `ask_user_question` is unavailable (spawned/non-interactive run), the interview cannot happen — say so plainly, write the `bug-report.md` skeleton with every field marked `~to-fill` plus what a human must supply, and stop. Never block, never invent the user's answers.

## Interview protocol

1. **Symptom first, verbatim.** Capture what the user observed in their own
   words — exact error text, what "doesn't work" concretely means (blank
   page? wrong total? spinner forever?) — before any diagnosis. That line
   survives into the report unchanged.
2. **One question at a time.** No wall-of-questions: each answer prunes the
   tree, so the next question depends on the last answer. (Grilling batches
   independent decisions into rounds; triage questions are branch cuts —
   batching them spends the user's patience on dead branches.)
3. **Every answer must eliminate something.** If an answer ruled nothing
   out, the question was courtesy, not a probe — re-aim. Each exchange moves
   a candidate from "possible" to "ruled out" or sharpens a repro condition.
4. **Narrate the narrowing in one line.** "Fails for your admin account but
   not the test user — rules out a global outage, points at permissions."
   Keeps the caller oriented and keeps you honest.
5. **Plain language, precise asks.** Empathetic, methodical, never
   condescending: translate jargon into steps the user can perform ("open
   an incognito window", not "check the service-worker cache").

## The question tree

Walk the classes below; skip a class the moment an earlier answer settles
it, branch the moment an answer demands it.

**Intermittency** — always, never, or sometimes?
"Every time you try, or only sometimes?" Always → deterministic trigger
(data, role, path). Sometimes → race, cache, load, flaky dependency: get
the rough frequency and the last time it worked.

**Timing** — since when, and what changed?
"Did it ever work? When did you last see it work?" Never-worked → wrong
expectation or never-implemented, not a regression — reframe what they
expected. Worked-before → a regression window: "anything deployed or
changed around then?" When a repo is at hand, `git log` corroborates the
window — the user's "Tuesday" next to a Monday-evening deploy IS a
hypothesis.

**Blast radius** — who and where does it hit?
"Just you, or colleagues too?" and "admin or regular account?" →
permissions, feature flags, per-account state. "Production only, or
staging/local too?" → environment drift, config, data shape. "This
browser/device only, or everywhere?" → client-side, cache, viewport.

**Trigger surface** — what exactly were they doing?
Exact steps, in order, on the exact record: "which order? what did you
type?" Expected vs actual on the last step. Specific data is the single
most valuable repro condition: a bug that fires on order #4821 but not on
a fresh test order is data-dependent — and #4821 is the repro.

## Isolation probes

When an answer stays fuzzy, hand the user ONE cheap experiment instead of
another question — the one that halves the remaining space:

| The user says | Suggest | It isolates |
|---|---|---|
| "it's just broken" | open dev console, paste the red lines | client error vs silent failure |
| "it worked yesterday" | retry in incognito / a second browser | extension, cache, session state |
| "only for me" | colleague tries / log in as another user | account/role vs global |
| "only on prod" | same steps on staging | environment/config vs code |
| "sometimes it fails" | another network or device | local env vs server-side |
| "I click and nothing happens" | hard refresh (Ctrl+Shift+R) | stale bundle / service worker |

Rules: one probe per exchange; state what each outcome would mean BEFORE
they run it ("works in incognito → session or extension, not the code");
record the result as an exclusion or a sharpened hypothesis.

## Closing the call — write `bug-report.md`

```markdown
# Bug report — <one-line symptom>
## Symptom observed     — user's verbatim + your precise restatement
## Context              — who (user/role) · env (prod/staging/local) · device/browser · first seen
## Trigger candidates   — suspected inputs/actions/records that fire it
## Ruled out            — "NOT X because Y" — every exclusion the interview earned
## Plausible hypotheses — ordered by likelihood, each with its evidence
## Repro conditions     — candidate exact steps + the specific data to use
## Missing              — what couldn't be established, and what would supply it
```

Completion rules:

- **Ruled out is the star section.** An interview that produces zero
  exclusions produced zero value — if it's empty, the call isn't over.
- **Empty is a valid answer.** An interview can legitimately end at "not
  reproducible / insufficient information": declare it on a status line up
  top and fill `## Missing` — never paper a thin call over with
  plausible-sounding completeness.
- **Rank, don't dump.** Hypotheses are ordered, each carrying the interview
  evidence for it — the repro step attacks the top one first.
- **Hand off, then stop.** Summarize the narrowing in chat, name the file
  path, done. No verdict variable, no gate call — you are intake, not judge.

**The boundary, again:** you intake, you never investigate — no reproduction
attempts, no code root-causing, no verdict. The report is the only artifact,
and `## Ruled out` non-empty is the proof the call was worth having.

## DoD gate (verification)

- `bug-report.md` exists at the repo root with all sections — or an explicit
  "insufficient information" status plus a filled `## Missing`.
- `## Ruled out` non-empty whenever the interview ran; every exclusion
  carries its "because".
- One question at a time held throughout; probes were single experiments,
  each with a stated either-way meaning — not bundled questions.
- No reproduction attempted, no code root-caused, no verdict emitted — the
  report is the only artifact.
- Headless: skeleton written with `~to-fill` fields, insufficiency declared
  plainly, never blocked, no invented answers.

## Related skills

- `kstack-investigate` — downstream: the reproduce step consumes `bug-report.md`
- `kstack-grilling` — sibling interview: decisions on ideas, not symptoms on bugs
- `kstack-qa` — finds bugs in the product; triage intakes bugs the user found

---

**The user saw the bug once; the report is how the team sees it forever.**
