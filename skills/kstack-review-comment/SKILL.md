---
name: kstack-review-comment
description: >-
  Publishes an already-finished code review on an EXTERNAL contributor's
  GitHub PR as one batched review object — verdict plus inline comments —
  behind a mandatory human approval of the complete draft before anything
  is posted publicly. Use when review findings already exist on someone
  else's PR and must be posted as review comments — "post the review",
  "comment on the PR", "publish the findings", "turn these findings into
  a review". Do NOT use for producing the findings or judging the diff
  (kstack-review's verdict), for replying to bot review comments
  (kstack-review's greptile triage), or for our own branches' PR and
  release lifecycle (kstack-ship).
metadata:
  version: "1.0.0"
compatibility: "Requires `gh` CLI + write access to the PR's repo only at the publish step; everything up to the draft gate is read-only. Pure methodology: no telemetry, no verdict lines."
---

<!-- provenance: kstack-original (S4 review redesign) · reviewed per authoring-skills -->

# Review Comment — findings into a published PR review

You are the **correspondent of the review, not its judge**. The suite already
did the judging: findings (and qa-browsing results) arrive via `{previous}` in
orchestrated runs, or from the review artifact in a standalone run. Your job
is the correspondence: turn a verdict into a review a stranger wants to
receive. Anyone can find bugs — the difference between a useful review and
noise lives entirely in this step.

**Boundary:** you publish, you never re-review. You may demote or drop a
finding that fails the "would I want to receive this?" test — with a stated
reason — but you never add findings. If something looks missed, the findings
step ran thin: say so and hand back, don't smuggle new findings into
comments.

> **Headless run?** If `ask_user_question` is unavailable (spawned/non-interactive run), the draft-approval gate **fails closed**: write the full draft to stdout (or the draft path the task provides), declare "publication skipped — draft ready for human review", and stop. Never post to a public PR without human confirmation.

## Step 1: Re-classify every finding

The upstream severities (CRITICAL/HIGH/MEDIUM/LOW) describe *how bad* a
problem is. The comment taxonomy describes *what the contributor should do
with it*. Re-classify each finding into exactly one:

| Class | Meaning | Lands as |
|-------|---------|----------|
| **blocking** | must be resolved before merge | inline comment; ≥1 → REQUEST_CHANGES |
| **suggestion** | would improve the PR, doesn't block merge | inline comment |
| **nit** | style/smallness, contributor may ignore | inline only if ≤2–3 at distinct lines; else one `nits:` list in the body |
| **question** | context you lack could change the verdict | inline comment or body item |

Two rules that override the severity mapping:

- **Doubt → question.** Any finding whose truth depends on context you don't
  have (why a pattern exists, a constraint outside the diff) is a `question`,
  never a blocking assert. A wrong blocking assert on a public PR burns the
  project's trust; a question keeps the door open.
- **Dedup.** Two findings on the same line or mechanism are one comment. A
  review with fifteen inline comments is a wall — merge by mechanism, bundle
  nits, and keep the inline count honest.

## Step 2: Write each comment

Every comment carries four things — a comment missing any is noise:

1. **Anchor** — `file:line` on a line inside the PR diff (side `RIGHT` for
   added/context lines, `LEFT` for deleted). Findings anchored outside the
   diff hunks cannot go inline — they go in the body list instead. Never fake
   an anchor onto a nearby line.
2. **What** — what the code does wrong or fails to do, one sentence.
3. **Why** — the concrete consequence: the failure scenario, the reader
   cost, the broken edge case. "Best practice says" is not a why; if you
   cannot name the consequence, the finding is a nit at best.
4. **How** — the concrete fix, with a fenced `suggestion` block when it's
   short. For questions: what answer or evidence would resolve it.

````markdown
This drops the `Retry-After` header when the upstream 429s — clients
will hammer the endpoint on their default backoff instead of the
server's.

```suggestion
if (res.headers["retry-after"]) retryDelay = parseRetryAfter(res.headers["retry-after"]);
```
````

**Anti-patterns:** "this is wrong" (no why, no fix) · "why did you do it this
way?" (an assert wearing a question mark) · "you forgot X" (intent asserted —
say "this drops X when Y", never what they were thinking).

## Step 3: Tone — you are a guest on their PR

- **Collaborative, not authoritarian.** The contributor owes the project
  nothing; the review is a gift they can refuse. Write accordingly.
- **Questions before assertions** whenever context might be missing —
  "is there a reason this re-parses on every call?" beats "this should be
  memoized". Doubly true for blocking-class items.
- **Calibrate, don't pile on.** One body line naming something done well is
  not flattery — it signals the blocking items are judgment, not hostility.
- **Comment on the code, never the coder.** No effort assertions, no
  "clearly rushed".
- **Sign-post optionality.** Prefix nits with `nit:` so the contributor
  knows exactly what they may ignore.

## Step 4: Verdict + assemble ONE review

The verdict is a function of the blocking count — nothing else:

- **≥1 blocking** → `REQUEST_CHANGES`; the body names them.
- **0 blocking, feedback exists** → `COMMENT`.
- **0 blocking, nothing material** → `APPROVE` (an approve may carry
  comments; a request-changes never lacks its blocking list).

The review **body** is the deliverable's spine: one line stating what was
reviewed + the headline verdict · grouped summary of blocking items · the
`nit:` list and off-diff findings · a closing line inviting questions on
anything flagged.

Publish as **one review object** — never a barrage of separate comments:

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/reviews --input review.json
```

```json
{
  "event": "REQUEST_CHANGES",
  "body": "<full review body>",
  "comments": [
    { "path": "src/auth.ts", "line": 42, "side": "RIGHT", "body": "<comment markdown>" }
  ]
}
```

No inline comments → the shorthand `gh pr review <pr> --approve | --request-changes | --comment --body-file <file>` posts the same single-review shape. The contributor receives one notification containing a coherent deliverable — that unity is the point.

## Step 5: The draft gate (hard — side effect)

Posting on someone's public PR is **irreversible and attributable** — the
project speaks through this review. Before the API call:

1. Show the complete draft: the verdict event, the full body, and every
   inline comment with its anchor and rendered text.
2. Wait for **explicit approval**. Edits are cheap now, expensive after.
3. Only then publish. On API failure (closed PR, no write permission): warn,
   leave the draft on stdout, stop — do not retry with degraded content.

Headless runs never reach step 3 — see the headless rule above.

**Two rules never move:** you never add findings — demote or drop only,
with a stated reason, and hand back when coverage looks thin — and nothing
posts without explicit human approval of the complete draft; headless fails
closed.

## DoD gate (verification)

- Every finding from `{previous}` classified into exactly one of
  blocking / suggestion / nit / question — none invented; every demote/drop
  carries a stated reason.
- Every inline comment carries a real diff-line anchor (`path`, `line`,
  `side`) plus what · why · how — or is a question stating what would
  resolve it. Off-diff findings live in the body, never faked inline.
- Verdict = f(blocking count) only: ≥1 blocking → REQUEST_CHANGES; 0 →
  COMMENT or APPROVE; never APPROVE alongside open blocking comments.
- ONE review payload assembled (`event` + `body` + `comments[]`) — zero
  scattered `gh pr comment` calls.
- Full draft shown before publishing and explicit approval received —
  or, headless, draft written to stdout/file with "publication skipped"
  declared and nothing posted.
- No verdict lines, no telemetry: the draft and the published review are
  the only outputs.

## Related skills

- `kstack-review` — upstream: produces the findings and verdict this step publishes (it judges the code; you write the comments)
- `kstack-qa` — qa-browsing findings feed the same draft
- `kstack-ship` — sibling surface for `gh` PR mechanics, on our own PRs

---

**The suite found the problems; the review is judged on how they're told.**
