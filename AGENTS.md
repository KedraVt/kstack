## Working rules — kstack-devin port

- **No building without explicit consent.** Standing rule: discuss, plan,
  and detail first — no implementation until the user approves a plan.
  For S4 the consent was given (sprint run on `task/s4-workflow-migration`;
  approved plan = `tasks.md` backlog + `system-design_01.md` §10).
- **Skill strategy (decided)**: Devin activates one skill at a time. If multiple
  skills are needed simultaneously, merge them into one; when sequential is
  enough, switch between skills instead.
- **Canonical catalog (post-S1)**: `skills/kstack-<id>/` is the flat skill
  catalog — every skill has `SKILL.md` + colocated `references/` + a literal
  `## DoD gate` section + `<!-- provenance -->` comment. The pre-S1 layered
  skill dirs, `skills-distilled/`, `source/`, `update.sh` and `scripts/` are
  deleted; `main` stays the stable baseline, work happens on `kstack`.
- **Telemetry convention**: telemetry belongs to the orchestrator — every
  step and run lands in `.kstack/ledger/` and the run report. The ledger and
  the step records live under `.kstack/` only while the run is live and are
  deleted at run end (completed or aborted); the run report under
  `.kstack/runs/` is the durable record. Skill bodies carry methodology
  only, with zero telemetry calls.
- **Headless rule**: skills that may run inside spawned subagents
  (`pi --mode json -p --no-session`, no user on the wire) must not block on
  `ask_user_question` — each carries a "Headless run?" fallback line that
  picks the safe option and records `~assumed` choices in the report.
- **Language**: all artifacts and inter-agent communication are English —
  docs, skills, ephemeral files, subagent task briefs, and their reports.
  Exception: the main agent replies to the user in the user's language
  (Italian if the user writes Italian).
- **Skill authoring gate**: every new or revised `kstack-*` skill passes
  the `.devin/skills/authoring-skills` pipeline (Phases 0-4 + pre-flight
  minimum; baseline/evals validated on live runs).
