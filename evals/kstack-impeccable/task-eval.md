# Task eval — kstack-impeccable

**Protocol.** Fixture `coupon cart` (Tiny Shop): a cart page with a working coupon
flow (`SAVE10` → 10% off, case-insensitive; unknown code → "Invalid code"). Task:
"critique and polish this cart page — keep the behavior exactly as it is". Two
runs, same model and harness: baseline without the skill, with-skill run with
`skills/kstack-impeccable` loaded. Each result was served on a local port and
driven with a real browser (fill `save10`, apply, read the total, apply `BOGUS`,
read the error, screenshot).

## Baseline (no skill) — fails

- **Fails the bundled detector.** `detect-antipatterns.mjs` on the baseline page:
  `low-contrast` — "2.0:1 (need 4.5:1) — text #ffffff on #a5b4fc" (severity
  warning), plus the advisory `gpt-thin-border-wide-shadow` ("1px border + 44px
  shadow blur" — the generated-UI signature).
- **Touches a project artifact.** The run wrote `plan.md` (a plan document for
  the audit) — 3 files changed, 728 insertions. The audit was supposed to be a
  change to the page.
- **No audit trail.** The output is a summary of what was changed; there is no
  finding list, no score, no statement of which behaviors were preserved.
- The coupon flow still worked (total $45.00 with `SAVE10`, "Invalid code" for
  `BOGUS`) — so the regression risk was not the failure, the *quality bar* was.

## With skill — passes

- **Detector clean.** `detect-antipatterns.mjs` on the with-skill page: **0
  findings** (the low-contrast violation and the hairline-plus-shadow advisory
  are both gone). The bundled detector was degraded in this environment until
  the HTML parser dependencies were declared — see `fix(skills): ship the
  impeccable detector's HTML parser dependencies`; the with-skill run had to
  install them in a scratch copy to get a real reading, which is exactly the
  failure the dependency fix removes.
- **Behavior preserved byte-for-byte.** Verified in the browser on both runs:
  subtotal $50.00 → `SAVE10`/`save10` → discount −$5.00 → total $45.00; `BOGUS`
  → "Invalid code"; item text still `Mug — $20 × 1`; `data-testid="total"` and
  the `code`/`apply`/`coupon-msg` ids unchanged.
- **Only the surface changed.** 2 files (index.html, app.js), 619 insertions —
  `plan.md` untouched.
- **Accessibility and state work.** `lang`, landmarks (`main`/`aside`/`section`),
  h1→h2 hierarchy, a labelled coupon form (Enter submits), a live region for the
  coupon message, `aria-invalid` + focus-to-input on error, `aria-label` on the
  remove buttons, visible focus rings, 44px targets, dark mode, reduced motion.
- **The upstream quirk is reported, not silently changed.** The discount is
  captured at apply time and never re-derived, so emptying the cart after a
  coupon yields $-5.00. The run left the behavior alone (changing it would change
  the computed total) and recorded it as a follow-up: make `discount` a rate
  rather than a fixed amount.
- **Audit trail.** The report states the score (7/20 → 19/20, with the per-domain
  breakdown), the detector result, the preserved-behavior list, and the
  deliberate changes (a real `<form>`, the accessible name on the remove buttons,
  the empty state).

## Verdict

| | baseline | with skill |
|---|---|---|
| detector findings | 1 warning + 1 advisory | 0 |
| files touched | 3 (incl. `plan.md`) | 2 |
| behavior drift | none | none |
| audit trail | summary prose | scored audit + preserved-behavior list |
| upstream quirk | not mentioned | reported as a follow-up |

The baseline produces a prettier page that fails the house detector and edits a
file it was not asked to edit. The skill produces a page that passes the detector,
changes only what it should, and proves the behavior did not move.
