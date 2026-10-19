# AGENTS_NOTES — state of the subagent definitions

## Where the agent files live

Canonical, versioned copies live in this repo at `agents/*.md`. `/kstack init`
syncs them into `~/.pi/agent/agents/` (where spawn discovers them): missing
profiles are added, differing ones are replaced after a
`<name>.md.bak-<timestamp>` backup. If you hand-tuned a deployed copy,
re-apply the change from its backup — or better, make it in `agents/`.

> **History:** this file previously claimed agent definitions were NOT
> versioned here and described a mirror-test premise. That was stale: the
> canonical files ARE in `agents/` and had already drifted from deployed copies
> before the deep review (2026-09). The deployed `~/.pi/agent/agents/` may lag
> `agents/` until the next manual sync — keep that in mind when debugging
> "the prompt says X but the subagent did Y".

## Shared contract (S4 step model)

Every delegated subagent (`execution: "subagent"`) runs under an ephemeral lifecycle:
`spawn → work → report → exit`.

- **Canonical Record Contract**: Delegated subagents complete their work by invoking
  the `kstack-report` CLI (carried in `$KSTACK_REPORT`), writing a structured record
  to `.kstack/runs/<runId>/`. The orchestrator NEVER accepts free-form `HANDOFF` text
  as a completion signal — the record is the only channel.
- **Verifier Rule (§10.13)**: Verifier specialists (`qa-engineer`, `devsecops-reviewer`,
  `software-architect`) write NO artifact files to the repository root or subtrees.
  Findings, repro steps, and remediations ride the record's `--evidence` (or
  `--deliverable` under `.kstack/runs/<runId>/` if massive), and verdicts ride
  `--verdict <key>==<value>`.
- **Trust Directive**: Specialists trust `{previous}` output as prior context,
  re-checking only claims that are load-bearing for their immediate actions.

Per-agent notes:

- **worker.md / reviewer.md** — general and code-review specialists; invoke
  `$KSTACK_REPORT` with `--marker` or `--verdict` as declared in task.
- **scout.md** — fast codebase orientation; uses `read, bash` and browser tools
  `kstack_*` for web evidence; signals via `--marker SCOUT-DONE`.
- **frontend-developer.md** — must NEVER `git checkout main`/`git pull`
  mid-chain: the sprint implement chain has backend commits on the task branch
  that `checkout main` would abandon. Handles implementation, `fe-walk`, and `ui-check`.
- **backend-developer.md** — handles atomic backend tasks (TDD) and `be-walk` mindrun
  walkthroughs.
- **qa-engineer.md** — browser QA and test verification; classifies verdicts as
  `green`, `orange` (testability blocker), or `red`; emits `--verdict status==<value>`
  and `--evidence`.
- **devsecops-reviewer.md** — adversarial code and security audit; emits verdicts for
  `code-review`, `security-review` (with required `severity` on rejection), and conditional
  `docker-*` via `$KSTACK_REPORT`.
- **software-architect.md** — principal architecture review of design artifacts; emits
  `--verdict software-architect-review==approved|rejected`.
- **planner.md** — fallback planner for deterministic plans; planning in canonical S4
  workflows runs as `execution: "main"` on the host agent.
- **sprint-planner.md** — ORPHANED: planning steps run as main phases on the host agent.
  Kept documented-as-such for manual invocation and future planner-delegation variants.
