---
name: gstack-scrape
description: >-
  Pull structured data off a web page, read-only by contract. Two paths:
  match an existing browser-skill via the browse CLI and run it (~200ms), or
  prototype the extraction with browse primitives (goto, snapshot, html,
  links) and emit one JSON document (~30s). Use when the user wants data
  scraped or extracted from a URL — "get the prices from…", "pull the table
  off…", "list the links on…". Refuses mutating intents (submit, login,
  click-to-write). Do NOT use for multi-page crawls, auth flows, or writing
  to a page.
metadata:
  version: "1.0.0"
compatibility: Requires runtime/browse/dist/find-browse ($B) — fail-closed when absent; gstack-skillify lives in the user-level stack, not this catalog.
---

<!-- provenance: gstack/gstack-scrape (match/prototype paths) — boilerplate stripped: learnings-log, eureka, preamble · rewritten S1 2026-02-11 -->

# Scrape — pull data from a page

One entry point for getting data off the web. **Read-only by contract.** `$B`
below is the browse binary — resolve once:

```bash
B="C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/browse/dist/find-browse"
[ -x "$B" ] || { echo "browse binary not found at $B"; exit 1; }
```

```bash
bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-telemetry-log --event-type skill_run --skill gstack-scrape --status start 2>/dev/null || true
```

## Step 1 — Determine intent

The request is the intent. Missing → ask once ("what do you want to scrape,
one line"). Never stack clarifying questions up front — they are cheaper in
the prototype path.

## Step 2 — Refuse mutating intents

Verbs like *submit, post, send, log in, click X, fill the form, delete,
create, order, book* → respond "scrape is read-only; use `$B click`/`$B
fill`/`$B type` directly for mutating flows" and **stop**.

## Step 3 — Match phase

```bash
$B skill list
```

For each candidate, `$B skill show <name>` exposes `triggers:`,
`description:`, `host:`, `args:`. A confident match needs all three: intent's
domain matches the `host` · a trigger/description covers the same data · the
intent needs no args the skill doesn't declare. Ambiguous between two → pick
the narrower tier (project > global > bundled); still ambiguous → fall
through to prototype rather than guess wrong.

Matched → `$B skill run <name> [--arg key=value ...]`, emit its JSON, stop.

## Step 4 — Prototype phase

Drive the page with primitives: `$B goto <url>` → `$B snapshot --text` (find
selectors) → `$B html` (structured data: lists, tables, repeated rows) →
`$B links` (URL gathering). Iterate: selector → output → refine.

Emit one JSON document on stdout — stable shape, typically
`{"items":[...],"count":N}`.

## Step 5 — Skillify nudge

After a successful prototype, append exactly one line: "Say `/gstack-skillify`
to make this a permanent skill (200ms on next call)." That's it — no nagging.

## When the prototype fails

After 3–4 selector attempts without a sensible shape: report what you tried
and what's blocking (lazy-loaded, JS-rendered, paywalled). Never write a
partial and call it done; never nudge skillify on a broken prototype. Ask:
different selector / different page / stop.

## Output discipline

- One JSON document on stdout; stderr/chat for logs and the nudge.
- No prose around the JSON — callers pipe to `jq`.
- Not for: mutations, auth flows/cookies, multi-page crawls.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-telemetry-log --event-type skill_run --skill gstack-scrape --status end 2>/dev/null || true
```

## DoD gate (verification)

- Mutating intent refused and stopped, OR one JSON document emitted.
- Match path ran `$B skill list` before prototyping; confident-match criteria
  applied (host + data + args).
- Failed prototype reported honestly (attempts + blocker), never a partial
  passed off as done.

## Related skills

- `gstack-skillify` (generic stack) — codifies a successful prototype into a
  permanent browser-skill

---

**Read-only by contract. One JSON document on stdout — never prose around
data.**
