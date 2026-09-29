# AGENTS_NOTES — state of the subagent definitions

## Where the agent files live

Canonical, versioned copies live in this repo at `agents/*.md`. `update.sh`
syncs them into `~/.pi/agent/agents/` (backing up existing files to
`.bak-<timestamp>` first, never deleting). If you hand-tuned deployed copies,
re-apply your changes after a sync.

> **History:** this file previously claimed agent definitions were NOT
> versioned here and described a mirror-test premise. That was stale: the
> canonical files ARE in `agents/` and had already drifted from deployed copies
> before the deep review (2026-09). The deployed `~/.pi/agent/agents/` may lag
> `agents/` until the next `update.sh` run — keep that in mind when debugging
> "the prompt says X but the subagent did Y".

## Shared contract (all workflow subagents)

Every agent that participates in a deterministic delegation chain ends its
report with a `## HANDOFF` section (≤4000 chars) beginning with
`VERIFIED FACTS:`. The orchestrator parses the LAST `## HANDOFF` marker —
earlier markers in the report body are ignored. Verdict lines inside HANDOFF
are bare `KEY == VALUE` lines; `##`-prefixed heading lines also parse.

Per-agent notes:

- **worker.md / reviewer.md** — carry the `Trust the HANDOFF…` trust directive
  AND the emit contract (added 2026-09 review; both are chain participants).
- **frontend-developer.md** — must NEVER `git checkout main`/`git pull`
  mid-chain: the sprint implement chain has backend commits on the task branch
  that `checkout main` would abandon.
- **qa-engineer.md / software-architect.md** — emit `##`-prefixed verdict lines
  (`## STATUS == GREEN`, `## software-architect-review == blank`); the parser
  tolerates the prefix, so no prompt change was needed.
- **sprint-planner.md** — ORPHANED: no workflow phase delegates to it. Kept
  documented-as-such for manual invocation and a future planner-delegation
  variant.
- **planner.md** — "VERIFIED FACTS … treat as context, not proof, re-check
  load-bearing claims" directive (efficiency plan STEP 2e).

Rationale for the trust directive (unchanged): without it the receiving
specialist re-verifies its input end-to-end, duplicating turns and wall time.
Load-bearing claims justifying code changes are always re-checked.
