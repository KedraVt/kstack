# Trigger eval harness

Reproducible trigger evaluation for the skill catalog: does the agent *reach for
the right skill* when a user asks for something, and does it stay away when the
request belongs to a sibling?

This is the `authoring-skills` pipeline, phase 6 ("Prove") — the E3 trigger eval:
~20 realistic prompts per skill (8–10 should-fire, 8–10 near-miss should-NOT),
3 runs each, a 60/40 train/validation split, a case passing when more than half
of its runs fire the right skill, and a target around 90%.

## Files

| file | what it is |
|---|---|
| `trigger-prompts.json` | the prompt set: per skill, a `fire` list and a `near` list, with file paths, real utterances, typos and abbreviations |
| `fixture/` | a small realistic project the agent is dropped into, so a run has somewhere to look before it decides |
| `trigger-run.mjs` | one isolated `pi` run per (skill, prompt, rep): the whole catalog is loaded, no other skills, no extensions, no MCP, read-only tools |
| `trigger-report.mjs` | per-skill fire rate on the train/validation split + the near-miss rate, and the failing cases |
| `rescore.cjs` | recomputes the outcome from the tool traces (the run's own detector is name-shape sensitive) |
| `dedupe.cjs` | keeps one row per case when two runners wrote the same file |

## Running it

```bash
# one arm: the catalog as it is, or a copy with candidate descriptions
node trigger-run.mjs trigger-prompts.json results.jsonl <skills-dir> \
  --runs 3 --conc 2 --max-tools 8 --fixture fixture --model agnes/agnes-3.0-flash

# score it
node rescore.cjs results.jsonl
node trigger-report.mjs results.jsonl --detail
```

`<skills-dir>` is the directory that *contains* the skill folders (the catalog
root), so both `skills/` and a copy like `skills-candidate/` work. The run is
killed as soon as the agent reads a `SKILL.md`, so a firing case costs one model
call; a non-firing case burns the tool budget and is what the near-miss split
measures.

## How to read the result

- `fire(train)` / `fire(val)` — cases where the agent reached for the skill
  (>50% of the 3 runs). The validation split is the honest number.
- `near-ok(train)` / `near-ok(val)` — near-miss prompts where the agent did
  **not** reach for that skill. A high fire rate with a low near-ok rate means
  the description is a magnet, not a router.
- A case that fires for the *wrong* skill appears in the `--detail` output with
  the sibling it picked — that is the overlap the descriptions must remove.

## Notes on the model

The eval needs a model that behaves like the one the skill will ship to. On a
free tier the runs degrade under load: a batch that suddenly reads no skill at
all is a rate-limited batch, not a description regression. Always run the
baseline and the candidate arms **paired** (same prompts, same window, same
model) and compare the delta, not the absolute number. If the endpoint returns
`429`, the rate limit is per hour, not per minute — wait it out rather than
lowering the number of reps.
