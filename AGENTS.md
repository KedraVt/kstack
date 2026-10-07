## Working rules — gstack-devin port

- **No building without explicit consent.** We are still in the design phase:
  discuss, plan, and detail first. Do not scaffold or write implementation code
  until the user explicitly approves a plan.
- **Skill strategy (decided)**: Devin activates one skill at a time. If multiple
  skills are needed simultaneously, merge them into one; when sequential is
  enough, switch between skills instead.
- **Canonical catalog (post-S1)**: `skills/<id>/` is the flat skill catalog —
  every skill has `SKILL.md` + colocated `references/` + a literal
  `## DoD gate` section + `<!-- provenance -->` comment. The old layers
  (`skills/{gstack,kedra,sprint-beta}`, `skills-distilled`, `source/`) are
  deleted; `main` stays the stable baseline, work happens on `kstack`.
- **Telemetry convention**: only session-level `gstack-*`/`plan-*` skills emit
  `skill_run` markers via `runtime/bin/gstack-telemetry-log`. kedra ports,
  vendored skills, and pure-methodology skills emit nothing — markers belong
  to orchestrated runs, not reference material.
- **Headless rule**: skills that may run inside spawned subagents
  (`pi --mode json -p --no-session`, no user on the wire) must not block on
  `ask_user_question` — each carries a "Headless run?" fallback line that
  picks the safe option and records `~assumed` choices in the report.
