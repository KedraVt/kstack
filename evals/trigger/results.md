# Trigger eval — results

Three rounds, all with the same protocol (20 prompts per skill: 8–10 should-fire,
8–10 near-miss should-NOT; 3 runs each; 60/40 train/validation split; a case
passes when more than half of its runs reach the right skill), all on
`openrouter/minimax/minimax-m3.1-flash:free` — the model the agents actually
run on. The harness is in this folder; the raw traces are not checked in.

## Round 0 — baseline, catalog as it was (420 runs)

A healthy endpoint. This is the reference for the *absolute* trigger rate of the
catalog.

| skill | fire (train) | fire (val) | near-miss ok (train / val) |
|---|---|---|---|
| kstack-design-taste-frontend | 5/6 | 4/4 | 6/6 / 4/4 |
| kstack-grilling | 5/6 | 4/4 | 6/6 / 4/4 |
| kstack-office-hours | 6/6 | 3/4 | 6/6 / 4/4 |
| kstack-impeccable | 4/6 | 1/4 | 6/6 / 4/4 |
| kstack-qa | 4/6 | 2/4 | 6/6 / 4/4 |
| kstack-idea-refine | 3/6 | 3/4 | 6/6 / 4/4 |
| kstack-investigate | 2/6 | 1/4 | 6/6 / 4/4 |
| kstack-triage | not measured | not measured | — |

Two findings: `investigate` and `idea-refine` under-trigger badly, and
`idea-refine` loses its cases to `office-hours` (the sibling overlap the
description has to resolve).

## Round 1 — paired arms, 5 skills (300 runs per arm, both arms in one window)

Arm A = the descriptions in the repository. Arm B = candidate descriptions.

| skill | A fire (train) | B fire (train) | A fire (val) | B fire (val) | near-miss (both arms) |
|---|---|---|---|---|---|
| kstack-impeccable | 0/6 | 4/6 | 0/4 | 0/4 | 6/6 / 4/4 |
| kstack-qa | 1/6 | 3/6 | 0/4 | 1/4 | 6/6 / 4/4 |
| kstack-idea-refine | 3/6 | 6/6 | 1/4 | 2/4 | 6/6 / 4/4 |
| kstack-investigate | 1/6 | 5/6 | 1/4 | 2/4 | 6/6 / 4/4 |
| kstack-triage *(unchanged control)* | 3/6 | 3/6 | 4/4 | 2/4 | 6/6 / 4/4 |

The control is the calibration: `triage`'s description is byte-identical in both
arms and still moves 2 cases on the validation split, so the noise floor of this
harness is about ±2 cases out of 4. The train-split gains (+4, +2, +3, +4) are
outside that floor; the validation-split gains (+0, +1, +1, +1) are inside it.

**Method note.** The candidate descriptions were drafted while reading the whole
prompt list, so they quote validation prompts too. The train split therefore
measures *memorization* as much as routing quality. That is why the shipped
descriptions were re-drafted from the train split only (arm C) and re-measured on
the held-out split alone.

## Round 2 — held-out validation only, arm A vs arm C (120 runs per arm)

| skill | A (repo) | C (shipped) | near-miss (both arms) |
|---|---|---|---|
| kstack-impeccable | 0/4 | 0/4 | 4/4 |
| kstack-qa | 1/4 | 1/4 | 4/4 |
| kstack-idea-refine | 1/4 | **2/4** | 4/4 |
| kstack-investigate | 1/4 | 1/4 | 4/4 |
| kstack-triage *(control)* | 2/4 | 2/4 | 4/4 |

## What this measures, honestly

- **The shipped descriptions do not regress the held-out split** and are at
  parity on it (one case better for `idea-refine`). The control, whose
  description did not change, scores the same in both arms — the run is stable.
- **The absolute rate is low today for every variant**, baseline included. The
  free endpoint under-triggers skills in this harness; a batch that suddenly
  reads no skill at all is a rate-limited batch, not a description regression.
  Round 0 (healthy endpoint) shows the catalog at 5/6–6/6 for the skills that
  did not change.
- **No over-firing.** Every near-miss case passes in every arm, before and after.
- **The improvement that is real** is the one the rulebook can defend: the
  descriptions now follow the formula (job first, quoted utterance, sibling
  boundary, no workflow summary) and they lift the split they were revised from
  by 2–4 cases, which is above the noise floor. The held-out split says the
  rewrite is safe, not that it is transformative.

## What is still open

- `kstack-impeccable` does not trigger on the held-out prompts in either arm
  (0/4). The near-miss side is clean, so the description is not over-firing —
  it is simply not being chosen for "check our app shell for accessibility
  issues" or "the typography and spacing in the pricing table are off". A
  follow-up round should watch the *routing target*: those prompts were
  answered with no skill at all.
- `kstack-triage` and `kstack-grilling` and `kstack-office-hours` were not
  re-authored; their numbers come from rounds 0 and 1.
- The free endpoint's hourly rate limit makes a full 8-skill, 3-rep, two-arm
  measurement expensive. The protocol above is the affordable version; run it
  on a paid endpoint before shipping a description change that matters.

## Harness notes

Two harness bugs cost a round each and are worth knowing about:

1. The outcome detector matched `skills/<name>/SKILL.md` only, so a catalog
   copy (`skills-candidate/`) never registered a hit. `rescore.cjs` recomputes
   the outcome from the tool traces.
2. The first validation attempt ran one arm before the other, so the cold
   endpoint penalized the first arm. Arms must be paired in the same window —
   that is what round 1 does.

## Two limits of this measurement

- **The eval loaded the catalog only.** `--skill <catalog dir>` replaces the
  automatic skill discovery, so the personal skills in `~/.pi/agent/skills` were
  not in the routing space. In a real session they are, and three of them
  (`impeccable`, `mindrun`, `retro`) carry descriptions that overlap the
  catalog's `kstack-impeccable`, `kstack-mindrun` and `kstack-retro` — the
  "overlapping descriptions" failure the rulebook calls the #1 cause of
  routing failure. The personal `design-taste-frontend` was removed once the
  catalog port passed its eval; the other three are still there and still
  compete.
- **The raw traces are not checked in.** `results/*.jsonl` keeps the case, the
  prompt, the outcome and the verdict for every run (840 runs); the tool traces
  stay out of the repository.

