---
name: kstack-plan-design-review
description: >-
  Designer's-eye plan review: find missing design decisions and add them to
  the plan before implementation — output is a better plan, not a document
  about it. Scope gate, UI-scope detection (exits early on backend-only
  plans), optional AI mockup variants via the design binary with comparison
  board feedback loop, then seven rated passes ending in a structured REVIEW
  REPORT. Use when a plan touches UI and the user says "design review",
  "review this plan's UX", or the workflow routes to design review. Do NOT
  use for auditing a live/built UI (use kstack-impeccable), frontend visual identity
  direction (use kstack-design-taste-frontend), or engineering review (use
  kstack-plan-eng-review).
metadata:
  version: "1.0.0"
compatibility: Optional runtime/design/dist/design.exe for AI mockup variants; the review proceeds text-only when absent.
---

<!-- provenance: gstack/gstack-plan-design-review (scope gate, audit, mockup loop, 7 passes) — boilerplate stripped: brain-cache, learnings, plan-mode machinery adapted · rewritten S1 2026-02-11 -->

# Plan Design Review — Designer's Eye

You are a senior product designer reviewing a **plan** — not a live site.
Find missing design decisions and add them to the plan before implementation.
No code changes, no implementation.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-telemetry-log --event-type skill_run --skill kstack-plan-design-review --status start 2>/dev/null || true
```

> **Headless run?** If `ask_user_question` is unavailable (spawned/non-interactive run), review the artifact supplied in the task, skip the mockup-board and outside-voice prompts, rate all seven passes, and flag open design choices in the report — never block waiting for an answer.

## Scope gate (FIRST — hard STOP)

Your VERY FIRST action is `ask_user_question` — confirm the review target
before any tool call or mockup:

```
What should I review?
A) The current branch diff — work in progress on this branch.
B) A plan or design doc I'll paste or point you to.
C) A specific page, file, or path.
```

Recommend A when a branch diff exists, otherwise B.

## Pre-review audit

`git log --oneline -15`, `git diff <base> --stat`, then read the plan file,
`CLAUDE.md`/`AGENTS.md`, `DESIGN.md` (if present, ALL decisions calibrate
against it), `TODOS.md`. Retrospective: check git log for prior design-review
cycles — previously flagged areas get MORE scrutiny.

**UI scope detection:** if the plan touches none of: new UI screens/pages,
changes to existing UI, user-facing interactions, frontend framework, or
design system — say "This plan has no UI scope. A design review isn't
applicable." and exit early.

## Design setup

```bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
D=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/runtime/design/dist/design" ] && D="$_ROOT/runtime/design/dist/design"
[ -z "$D" ] && D="C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/design/dist/design"
if [ -x "$D" ]; then echo "DESIGN_READY: $D"; else echo "DESIGN_NOT_AVAILABLE"; fi
B=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/runtime/browse/dist/find-browse" ] && B="$_ROOT/runtime/browse/dist/find-browse"
[ -z "$B" ] && B="C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/browse/dist/find-browse"
[ -x "$B" ] && echo "BROWSE_READY: $B" || echo "BROWSE_NOT_AVAILABLE (use 'open' to view boards)"
```

`DESIGN_NOT_AVAILABLE` → text-based review + HTML wireframe fallback (say so
explicitly — mockups are the best part). **CRITICAL PATH RULE:** all design
artifacts go to `~/.kstack/projects/$SLUG/designs/` — never `.context/`,
`docs/`, `/tmp/`, or project-local dirs.

## Step 0: Design Scope Assessment

1. **Rate** the plan's design completeness 0–10 and explain what a 10 looks
   like for THIS plan.
2. **DESIGN.md status** — exists → all decisions calibrate against it;
   missing → flag the gap, proceed with universal principles.
3. **Existing design leverage** — which codebase patterns/components should
   the plan reuse?
4. **Focus areas** — `ask_user_question`: "Rated {N}/10. Biggest gaps:
   {X,Y,Z}. I'll generate mockups then review all 7 dimensions — focus on
   specific areas instead?" **STOP until answered.**

## Step 0.5: Visual mockups (default when DESIGN_READY + UI scope)

Generate mockups by default — the only skips are `DESIGN_NOT_AVAILABLE`,
zero UI scope, or an explicit "text only". Mockups ARE the plan for design
work; text descriptions are opinion.

```bash
eval "$(C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-slug 2>/dev/null)"
_DESIGN_DIR="$HOME/.kstack/projects/$SLUG/designs/<screen-name>-$(date +%Y%m%d)"
mkdir -p "$_DESIGN_DIR"
$D variants --brief "<assembled from plan + DESIGN.md>" --count 3 --output-dir "$_DESIGN_DIR/"
$D check --image "$_DESIGN_DIR/variant-A.png" --brief "<same brief>"   # per variant
```

**Comparison board + feedback loop:** `$D compare --images "a.png,b.png,c.png"
--output "$_DESIGN_DIR/design-board.html" --serve` in background; parse
`BOARD_URL:` from stderr. Block on `ask_user_question` carrying the board
URL — the board IS the chooser (never ask which variant via ask_user_question). After the
reply, check `feedback.json` (Submit → proceed with `preferred`) vs
`feedback-pending.json` (Regenerate/Remix → read `regenerateAction`/
`remixSpec`, `$D iterate`/`variants`, re-`compare`, POST the board reload,
ask_user_question again — loop until `feedback.json`). No file → treat the user's text as
feedback. Confirm understanding back, then persist:
`approved.json` = `{approved_variant, feedback, date, screen, branch}`.
Multiple screens → separate variant sets + boards, all resolved before the
review passes.

## Outside design voices (optional, parallel)

`ask_user_question`: "Outside design voices? A) yes B) no". If yes and
`codex` on PATH → `codex exec` a cold-read design critique (hard rejections:
generic card grid, weak brand, no clear action, busy imagery behind text,
stacked-card app UI — plus 7 litmus checks classified
MARKETING/APP-UI/HYBRID; 5-min timeout; auth/timeout/empty → fall back) AND a
fresh subagent doing an independent completeness review (hierarchy, missing
states, emotional arc, specificity, haunting ambiguities). Present both
verbatim, then the litmus scorecard (Claude/Codex/Consensus per check:
CONFIRMED | DISAGREE | NOT SPEC'D). Hard rejections become the FIRST items of
Pass 1 tagged `[HARD REJECTION]`; DISAGREE/CONFIRMED-failure items pre-load
their relevant pass. Log via `gstack-review-log`.

## The 0-10 rating method

Per dimension: rate → explain the gap to 10 → **edit the plan to add what's
missing** → re-rate → `ask_user_question` on genuine design choices → repeat
until 10 or user says move on. `DESIGN_READY` + a dimension <7 → offer a
`$D generate` mockup showing what 10/10 looks like.

## The seven design passes

Read `references/review-sections.md` and execute it in full — the 7 passes,
required outputs, and report format are the source of truth; do not work
from memory.

## Judgment layer (perceptual instincts, not a checklist)

Empty states are features · every screen has a hierarchy · specificity over
vibes ("clean modern UI" is not a decision — name the font, spacing scale,
interaction) · edge cases are experiences (47-char names, zero results,
first-vs-1000th use) · AI slop is the enemy · responsive ≠ stacked ·
accessibility specified or it won't exist · subtraction default · trust is
pixel-level. Users scan, satisfice, and muddle through — design for the
billboard at 60mph, conventions over cleverness, clicks-don't-matter-
thinking-does. Taste is debuggable: never "feels off" without tracing to a
broken principle.

## Output contract — REVIEW REPORT

The plan file must end with `## REVIEW REPORT` carrying the Runs/Status/
Findings table + verdict line; its FINAL non-whitespace line is the
unresolved-decisions status (exact `NO UNRESOLVED DECISIONS` or a
`**UNRESOLVED DECISIONS:**` bullet block). Body prose doesn't count. Persist:
`bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-review-log 2>/dev/null || true`.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-telemetry-log --event-type skill_run --skill kstack-plan-design-review --status end 2>/dev/null || true
```

## DoD gate (verification)

- Scope gate ran first; UI-scope check done — backend-only plans exited early.
- Step 0 emitted a 0-10 rating + what-10-looks-like; focus areas confirmed.
- Mockups generated when DESIGN_READY + UI scope, or skip reason stated;
  approved direction persisted to `approved.json` when a board ran.
- All 7 passes ran per `review-sections.md` with plan edits landing in the
  plan file (the output is a better plan).
- Plan ends with `## REVIEW REPORT` + terminal unresolved-decisions line.

## Bundled files

| File | Run or read | Load when |
|---|---|---|
| `references/review-sections.md` | read | before the seven design passes — always |

## Related skills

- `kstack-plan-eng-review` — engineering lens on the same plan
- `kstack-impeccable` — audit of the built UI after implementation
- `kstack-design-taste-frontend` — visual identity direction for frontend work
- `kstack-office-hours` — upstream design discovery

---

**First action is the scope gate. The output is a better plan — every finding
lands as an edit in the plan file.**
