# Task eval — kstack-grilling

**Protocol.** Fixture `notekeep`, task: "we need a CSV export of a user's notes so
the team can open it in Excel — interview me about the requirements before we
plan". Two runs, same model and harness: baseline without the skill, with-skill
run with `skills/kstack-grilling` loaded.

Both runs read the repo first and both produce sensible questions. The difference
is the *shape* of the interview: what is asked, what is held back, and when the
run stops.

## Baseline (no skill) — partially fails

- **Asks for facts it can look up.** The opening round asks "Do your users'
  machines run an Italian/European locale?" and "Is that query param the real
  identity mechanism in production, or is this a trimmed copy?" — the second is
  answerable from the repo it just read.
- **No frontier.** 17 questions in three numbered rounds, with no statement of
  which answers unlock which other answers. The reader cannot see why question 9
  matters before answering 3.
- **No per-question recommendation.** Questions are open questions; the agent
  never says which answer it would take, so the interview is a form to fill, not
  a decision to converge.
- **Keeps going past the decision.** The run asks about encoding, line endings,
  formula injection, tag encoding and the 32,767-character cell limit in the
  same breath as the structural question, so the user answers facts about Excel
  before the shape of the export is settled.

## With skill — passes

- **Facts looked up, decisions asked.** The run states what it found (the schema,
  `exportJSON` → `listNotes` → `SELECT *` materialized in memory, no auth layer,
  the README plan limits, no `notes.db` in the repo) and then asks only what the
  code cannot answer.
- **The frontier is explicit.** "Everything downstream (column set, tag encoding,
  body format, date format) depends on your answers to these, so I'll hold those
  for round 2." The run stops at the frontier instead of flattening every
  question into one form.
- **Every question carries a recommendation.** Each one names the options (a)/(b)/(c)
  with the cost of each ("(b) is a nice-to-have that can ship later as a second
  format/endpoint") and then answers itself: "➡️ **(a) One row per note.**" A user
  can confirm in one word instead of writing a paragraph.
- **The questions are the real ones.** Q1 "What is one row?", Q2 "Which spreadsheet
  has to open it, and what format bundle do you want?", Q3 "How do people actually
  get the file?" — each drives a downstream decision, and the recommendation
  shows the reasoning (BOM is what makes Excel detect UTF-8; CRLF is what Windows
  Excel expects; `pandas` handles BOM fine via `utf-8-sig`).

## Verdict

| | baseline | with skill |
|---|---|---|
| questions | 17 in 3 rounds | 3 on the frontier |
| facts asked that the repo answers | 2+ | 0 |
| recommendation per question | no | yes, with the cost of each option |
| what is deferred and why | not stated | stated ("I'll hold those for round 2") |

The baseline is a form. The skill is an interview that converges.
