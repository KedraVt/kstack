## Working rules — gstack-devin port

- **No building without explicit consent.** We are still in the design phase:
  discuss, plan, and detail first. Do not scaffold or write implementation code
  until the user explicitly approves a plan.
- **Skill strategy (decided)**: Devin activates one skill at a time. If multiple
  skills are needed simultaneously, merge them into one; when sequential is
  enough, switch between skills instead.
- **`source/` is FROZEN read-only** (S1 precondition). The upstream sync
  pipeline (`update.sh`, `scripts/{sync,adapt}-skills.ts`, `gen-tools.ts`) was
  deleted; generated outputs stay committed as-is. Do not edit inside the
  submodule — it is deleted at the end of S1.
