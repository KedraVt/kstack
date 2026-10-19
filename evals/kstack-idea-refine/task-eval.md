# Task eval — kstack-idea-refine

**Protocol.** One fixture (`notekeep`, a self-hosted notes app), one task
("team-shared bookmarks" is a rough idea — refine it before we plan), two runs
from the same model in the same harness: the baseline without the skill, the
with-skill run with `skills/kstack-idea-refine` loaded. Assertions were written
after reading both outputs. Runner: `pi --mode json -p --no-session --no-skills
--no-extensions --no-mcp --model <subagent model>`, fixture copied per run, write
scope checked afterwards (`validity.cjs` — no tool call touched a path outside the
run folder).

## Baseline (no skill) — fails

- **Wrong output shape.** The run *built the product*: 17 files touched — `src/db.js`
  (schema + migrations), `src/auth.js` (scrypt + sessions), `src/links/*` (canonicalize,
  SSRF-hardened title fetcher, store, worker, limits), `src/errors.js`, rewritten
  `src/notes.js` / `src/server.js`, 40 tests, a rewritten README. No direction
  document exists anywhere.
- **Scope inversion.** The task was to shape an idea; the deliverable is code that
  locks five product decisions (scrypt, opaque sessions, per-team quotas, soft
  deletes, dedup-as-200) into the repo before anyone chose them.
- **No assumption ledger.** The run listed five open questions at the end of a
  README, with no recommended answer and no way to tell assumption from decision.
- Cost: 69 tool calls, 499 s, `npm test` executed.

## With skill — passes

- **One artifact, one direction.** `.kstack/plans/team-shared-bookmarks.md`: HMW
  restatement, 8 lensed variations (each grounded in the repo — `src/notes.js`
  scopes every query by `user_id`, there is no teams table, `?user=` in the query
  string, tags are comma-separated `TEXT`), 3 candidate directions, one recommended
  (A) with the fallback (B) and the deferral (C), 9 assumptions each with a
  how-to-test, MVP in/out, 11 "Not Doing" items, 11 enumerated open questions —
  headless run, so each is marked `~assumed` rather than blocking.
- **Pushback kept.** "Team-shared bookmarks is a checkbox feature — Slack already
  shares links; what dies there is the reason", plus the two hard facts that would
  change the priority order (a 40% fill rate on the required "why" field means ship
  direction B; identity is the prerequisite, not the schema).
- **Hard gate honoured.** `src/` is byte-identical: the plan file is the only
  artifact. Cost: 122 s, 1 file.
- The run states the downstream handoff (`kstack-grilling` → `kstack-plan-draft`).

## Verdict

| | baseline | with skill |
|---|---|---|
| artifact | 17 files of code | 1 one-pager |
| decisions locked in code | 5, unasked | 0 |
| assumptions recorded with a test | 0 | 9 |
| open questions | 5, unanswered | 11, each answered or `~assumed` |

The skill turns "build it" into "choose it". Same model, same fixture, opposite
deliverable.
