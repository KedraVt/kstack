# Task eval — kstack-investigate

**Protocol.** Fixture `datebug` — a bookings dashboard that buckets the day by the
UTC calendar date while the `day` argument is documented in venue time
(Europe/Lisbon). The bug shows only in summer (UTC+1), so a midday-UTC test suite
cannot see it. Task: "the dashboard puts late-evening bookings on the previous
day, only in summer — fix it". Two runs, same model and harness: baseline without
the skill, with-skill run with `skills/kstack-investigate` loaded.

Both runs fix the bug. The difference is the *report* and the *regression guard*.

## Baseline (no skill) — partially fails

- **The fix is correct.** `venueDayOf` via `Intl.DateTimeFormat` with
  `timeZone: "Europe/Lisbon"`, `bookingsOnDay` compares venue-local days.
- **The report is prose.** The output is a chat-style summary ("All good — DST
  transition days are handled correctly by the IANA timezone data"), with no
  root-cause statement, no before/after evidence, no regression-test inventory,
  no related-work check, no status verdict. A reader cannot tell what was
  verified from what was assumed.
- **The blind spot stays invisible.** The run notes "verified across the
  2026-03-29 and 2026-10-25 transitions" but never explains *why* the original
  suite could not catch this class of bug.
- 30 s, 2 files.

## With skill — passes

- **Structured DEBUG REPORT**, every field filled: Symptom, Root cause
  (`src/slots.js:3` bucketed by the UTC calendar date while the argument is
  venue-local; Lisbon is UTC+1 in summer, UTC+0 in winter — which is exactly why
  the bug showed only in summer), Fix (`src/slots.js:4-22`, `venueDay` with
  `formatToParts`), Evidence (before: `countByDay([2026-07-10T23:30Z,
  2026-07-10T22:30Z], …)` → `{Jul 10: 2, Jul 11: 0}`; after: `{Jul 10: 1,
  Jul 11: 1}`; plus a brute force over all 8760 hours of 2026: 8760/8760 counted
  exactly once, 0 mismatches, 210 correctly shifted = 92 DST days × the 23:00 UTC
  hour), Regression test (4 new tests, all 4 failing before the fix), Related
  (none — single-commit repo), Discoveries (the two pre-existing tests used
  midday-UTC timestamps, identical in UTC and Lisbon local time, so the suite had
  a blind spot for any timestamp between 23:00 and 24:00 UTC during DST), Status
  DONE.
- **Scope lock honoured.** Only `src/slots.js` and `test/slots.test.js` touched;
  the scratch `repro.mjs` was written, used, then removed.
- **The blind spot is named** — the pre-existing tests could never catch this
  class of bug, which is why the bug shipped.
- 78 s, 2 files + 1 scratch file (removed).

## Hidden check

A separate 5-case oracle (DST-start night, DST-end night, summer late booking,
winter late booking, summer midday) run against both fixes: **5/5 for both**. The
implementations are equivalent — the skill's value is the evidence and the
regression guard, not a different fix.

## Verdict

| | baseline | with skill |
|---|---|---|
| fix correct | yes | yes |
| report | prose | structured DEBUG REPORT, 8 fields |
| before/after evidence | none | 8760-hour brute force |
| why the suite missed it | not stated | stated |
| scope | 2 files | 2 files + scratch (removed) |

The baseline ships a fix a reviewer cannot audit. The skill ships a fix a reviewer
can re-derive.
