# Task eval — kstack-design-taste-frontend (tasteskill v2.1.1)

**Protocol.** Two page briefs, each built twice from the same model: the baseline
without the skill, the with-skill run with `skills/kstack-design-taste-frontend`
loaded. Every build is then rendered and measured by the skill's own inspector
(`scripts/inspect.mjs`) — the FAIL count is the score. Case 1 is an app screen
(coupon cart), case 2 is a marketing page (Osteria Nove). The upstream case list
lives in `evals.json`; this file records what the live runs measured.

## Case 1 — Tiny Shop coupon cart (app screen)

**Baseline — 8 inspector FAILs, and it invented policy.**
- 8 FAILs from `inspect.mjs` (contrast, hierarchy and state rules).
- The redesign *invented* a shipping policy the app never had (a delivery
  estimate and a free-shipping threshold that the code does not implement).

**With skill — 0 FAILs, behavior preserved.**
- Inspector: **0 FAIL**.
- The cart's behavior is preserved: subtotal $50.00 → `SAVE10` → −$5.00 → $45.00;
  unknown code → "Invalid code"; the item line still reads `Mug — $20 × 1`.
- **One real defect exposed by the run:** the coupon code was *visible* in the
  summary ("Discount SAVE10 −$5.00" with the code as a badge). The with-skill
  run surfaced it; the design step's task now forbids inventing or exposing
  codes, prices, policies and promises the code does not have.

## Case 2 — Osteria Nove (marketing page)

**Baseline — the template.**
- A generic cream-and-terracotta restaurant page: the kind of page that could be
  for any trattoria. No researched direction, no credited imagery.

**With skill — a researched direction.**
- The run researched a direction before building (a dealt direction from the
  library), and credited its imagery and video instead of passing them off as
  the restaurant's own.
- Inspector: **0 FAIL**.
- **Incomplete:** the run timed out during the final polishing pass (it hit the
  harness limit, not the skill's 60-minute step limit), so the page still needs a
  cleaner pass. The timeout is why the in-product design step now carries its own
  60-minute budget (`KSTACK_PI_TIMEOUT_STEP_DESIGN`) — a measured restyle took
  ≥29 minutes, over the normal WORK class.

## What the runs changed in the product

- The design step is autonomous: it picks the direction and reports its
  assumptions instead of blocking on a user.
- The design step runs **one** look-and-fix round (inspect → critique → fix →
  inspect), not three: the second round of a restyle was where the run drifted.
- The task forbids invented content — shipping policies, prices, promises and
  coupon codes that the code does not contain.
- Working files live in the run folder (`TASTE_SKILL_WORKDIR=.kstack/runs/<id>/design`);
  `.taste-skill/` stays git-ignored working material.

## Verdict

| | baseline | with skill |
|---|---|---|
| inspector FAILs (cart) | 8 | 0 |
| invented content | shipping policy | none |
| direction | generic template | researched and credited |
| inspector FAILs (Osteria) | generic | 0 |
| completion | — | timed out in the final polish pass (documented) |

The skill does not make the agent design better by taste — it makes the agent
*measure* what it designed, and the measurement caught a real leak that the
baseline shipped.
