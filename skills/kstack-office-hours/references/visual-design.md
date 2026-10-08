# Visual Design Exploration

```bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
D=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/design/dist/design" ] && D="$_ROOT/C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/design/dist/design"
[ -z "$D" ] && D="C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/design/dist/design"
[ -x "$D" ] && echo "DESIGN_READY" || echo "DESIGN_NOT_AVAILABLE"
```

**If `DESIGN_NOT_AVAILABLE`:** Fall back to the HTML wireframe approach below
(the existing DESIGN_SKETCH section). Visual mockups require the design binary.

**If `DESIGN_READY`:** Generate visual mockup explorations for the user.

Generating visual mockups of the proposed design... (say "skip" if you don't need visuals)

**Step 1: Set up the design directory**

```bash
eval "$(C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-slug 2>/dev/null)"
_DESIGN_DIR="$HOME/.kstack/projects/$SLUG/designs/mockup-$(date +%Y%m%d)"
mkdir -p "$_DESIGN_DIR"
echo "DESIGN_DIR: $_DESIGN_DIR"
```

**Step 2: Construct the design brief**

Read DESIGN.md if it exists — use it to constrain the visual style. If no DESIGN.md,
explore wide across diverse directions.

**Step 3: Generate 3 variants**

```bash
$D variants --brief "<assembled brief>" --count 3 --output-dir "$_DESIGN_DIR/"
```

This generates 3 style variations of the same brief (~40 seconds total).

**Step 4: Show variants inline, then open comparison board**

Show each variant to the user inline first (read the PNGs with Read tool), then
create and serve the comparison board:

```bash
$D compare --images "$_DESIGN_DIR/variant-A.png,$_DESIGN_DIR/variant-B.png,$_DESIGN_DIR/variant-C.png" --output "$_DESIGN_DIR/design-board.html" --serve
```

This opens the board in the user's default browser and blocks until feedback is
received. Read stdout for the structured JSON result. No polling needed.

If `$D serve` is not available or fails, fall back to AskUserQuestion:
"I've opened the design board. Which variant do you prefer? Any feedback?"

**Step 5: Handle feedback**

If the JSON contains `"regenerated": true`:
1. Read `regenerateAction` (or `remixSpec` for remix requests)
2. Generate new variants with `$D iterate` or `$D variants` using updated brief
3. Create new board with `$D compare`
4. POST the new HTML to the running board. Parse the board URL from stderr
   (`BOARD_URL: http://127.0.0.1:N/boards/<id>/` — the daemon path) or fall
   back to the legacy port (`SERVE_STARTED: port=N` — only emitted under
   `--no-daemon`, hits `/api/reload` root). Daemon path:
   `curl -X POST "${BOARD_URL}api/reload" -H 'Content-Type: application/json' -d '{"html":"$_DESIGN_DIR/design-board.html"}'`
5. Board auto-refreshes in the same tab

If `"regenerated": false`: proceed with the approved variant.

**Step 6: Save approved choice**

```bash
echo '{"approved_variant":"<VARIANT>","feedback":"<FEEDBACK>","date":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","screen":"mockup","branch":"'$(git branch --show-current 2>/dev/null)'"}' > "$_DESIGN_DIR/approved.json"
```

Reference the saved mockup in the design doc or plan.

# Visual Sketch (UI ideas only)

If the chosen approach involves user-facing UI (screens, pages, forms, dashboards,
or interactive elements), generate a rough wireframe to help the user visualize it.
If the idea is backend-only, infrastructure, or has no UI component — skip this
section silently.

**Step 1: Gather design context**

1. Check if `DESIGN.md` exists in the repo root. If it does, read it for design
   system constraints (colors, typography, spacing, component patterns). Use these
   constraints in the wireframe.
2. Apply core design principles:
   - **Information hierarchy** — what does the user see first, second, third?
   - **Interaction states** — loading, empty, error, success, partial
   - **Edge case paranoia** — what if the name is 47 chars? Zero results? Network fails?
   - **Subtraction default** — "as little design as possible" (Rams). Every element earns its pixels.
   - **Design for trust** — every interface element builds or erodes user trust.

**Step 2: Generate wireframe HTML**

Generate a single-page HTML file with these constraints:
- **Intentionally rough aesthetic** — use system fonts, thin gray borders, no color,
  hand-drawn-style elements. This is a sketch, not a polished mockup.
- Self-contained — no external dependencies, no CDN links, inline CSS only
- Show the core interaction flow (1-3 screens/states max)
- Include realistic placeholder content (not "Lorem ipsum" — use content that
  matches the actual use case)
- Add HTML comments explaining design decisions

Write to a temp file:
```bash
SKETCH_FILE="/tmp/gstack-sketch-$(date +%s).html"
```

**Step 3: Render and capture**

```bash
$B goto "file://$SKETCH_FILE"
$B screenshot /tmp/gstack-sketch.png
```

If `$B` is not available (browse binary not set up), skip the render step. Tell the
user: "Visual sketch requires the browse binary. Run the setup script to enable it."

**Step 4: Present and iterate**

Show the screenshot to the user. Ask: "Does this feel right? Want to iterate on the layout?"

If they want changes, regenerate the HTML with their feedback and re-render.
If they approve or say "good enough," proceed.

**Step 5: Include in design doc**

Reference the wireframe screenshot in the design doc's "Recommended Approach" section.
The screenshot file at `/tmp/gstack-sketch.png` can be referenced by downstream skills
(`/skill:kstack-plan-design-review`, `/skill:gstack-design-review`) to see what was originally envisioned.

**Step 6: Outside design voices** (optional)

After the wireframe is approved, offer outside design perspectives:

```bash
command -v codex >/dev/null 2>&1 && echo "CODEX_AVAILABLE" || echo "CODEX_NOT_AVAILABLE"
```

If Codex is available, use AskUserQuestion:
> "Want outside design perspectives on the chosen approach? Codex proposes a visual thesis, content plan, and interaction ideas. A Claude subagent proposes an alternative aesthetic direction."
>
> A) Yes — get outside design voices
> B) No — proceed without

If user chooses A, launch both voices simultaneously:

1. **Codex** (via Bash, `model_reasoning_effort="medium"`):
```bash
TMPERR_SKETCH=$(mktemp /tmp/codex-sketch-XXXXXXXX)
_REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
codex exec "For this product approach, provide: a visual thesis (one sentence — mood, material, energy), a content plan (hero → support → detail → CTA), and 2 interaction ideas that change page feel. Apply beautiful defaults: composition-first, brand-first, cardless, poster not document. Be opinionated." -C "$_REPO_ROOT" -s read-only -c 'model_reasoning_effort="medium"' --enable web_search_cached < /dev/null 2>"$TMPERR_SKETCH"
```
Use a 5-minute timeout (`timeout: 300000`). After completion: `cat "$TMPERR_SKETCH" && rm -f "$TMPERR_SKETCH"`

2. **Claude subagent** (via Agent tool):
"For this product approach, what design direction would you recommend? What aesthetic, typography, and interaction patterns fit? What would make this approach feel inevitable to the user? Be specific — font names, hex colors, spacing values."

Present Codex output under `CODEX SAYS (design sketch):` and subagent output under `CLAUDE SUBAGENT (design direction):`.
Error handling: all non-blocking. On failure, skip and continue.

