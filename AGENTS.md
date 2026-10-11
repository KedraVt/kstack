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
- **Telemetry convention**: only session-level `kstack-*`/`plan-*` skills emit
  `skill_run` markers via `runtime/bin/kstack-telemetry-log`. kedra ports,
  vendored skills, and pure-methodology skills emit nothing — markers belong
  to orchestrated runs, not reference material.
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
