# Task eval — kstack-office-hours

**Protocol.** Fixture `notekeep`, task: "teams want to add their own integrations —
stress-test this before we plan". Two runs, same model and harness: baseline
without the skill, with-skill run with `skills/kstack-office-hours` loaded. The
skill is discovery-only: its hard gate says the only artifact is a direction
document and it never writes production code.

## Baseline (no skill) — fails

- **Wrong output shape.** The run stress-tested by *building*: `spike/runtime.js`
  (a plugin runtime), six example plugins, 22 assertions, latency and isolation
  benchmarks, `spike/bench.js`, `spike/stress.test.js` — 20 new files, and
  `package.json` modified so `npm test` runs the spike suite.
- **No direction document.** The findings live in `spike/FINDINGS.md`; nothing
  settles a direction, nothing says what to build next.
- **The report buries the decision.** The one question that gates the most ("is
  notekeep one team per instance, or many teams per host?") sits at the end of a
  findings table, unanswered.
- Cost: 20 minutes, 20 files, the fixture's own `npm test` now runs the agent's
  spike instead of the project's tests.

## With skill — passes

- **One artifact, one direction.** `.kstack/discover/direction-notekeep-integration-contract.md`:
  problem and core wedge, goals and anti-scope, architecture and foundational
  choices, key interfaces and contracts (event envelope, REST surface, delivery
  state machine), settled decisions and trade-offs (decision matrix + 6 open
  questions, each `~assumed` because the run was headless), downstream handoff.
- **The load-bearing argument is made.** "The request is *teams can add their own
  integrations*, not *notekeep must run third-party code*" — different problems,
  different costs. Then the decisive one: a contract-first surface is safe in both
  the per-team and the shared-hosting world, so the unresolved multi-tenant
  question no longer blocks the design.
- **Scope respected.** No production code, no scaffold; the plan file is the only
  artifact. Cost: 214 s, 1 file.
- The run states the assumption it had to make ("the snapshot exposes only GET
  endpoints — events are impossible without a write path") instead of inventing one.

## Verdict

| | baseline | with skill |
|---|---|---|
| files written | 20 (code + benchmarks) | 1 (direction) |
| production code written | yes (a plugin runtime) | no — hard gate |
| direction settled | no | yes, with a decision matrix |
| open questions | 1, unanswered | 6, each answered or `~assumed` |

The baseline produced evidence; the skill produced a decision. Only the second one
can start a plan.
