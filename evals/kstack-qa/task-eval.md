# Task eval — kstack-qa

**Protocol.** Two workflows, each run twice from the same model: the baseline
without the skill, the with-skill run with `skills/kstack-qa` loaded. Each run
uses a planted-bug fixture and the skill's own output modes — `record` for
develop/sprint/review, `case-file` for investigate. Assertions were written after
reading the outputs.

## Develop workflow — QA step

**Baseline — finds the bugs, but the report is not reusable.**
- All 3 planted bugs were found. ✔
- The report was written as a *repo file* (`qa-artifact_01.md`) instead of being
  recorded through the QA record contract. ✘
- The evidence was not reusable: no repro/file/fix triple per finding, so the
  next step (the fix worker) had nothing to act on. ✘

**With skill — passes.**
- All 3 planted bugs found. ✔
- The findings are recorded through the record contract, each with repro steps,
  the file and the fix — the fix worker receives the same evidence. ✔
- No report file is left in the repo: the QA output belongs to the ledger, not to
  the user's tree. ✔

## Investigate workflow — regression QA

**Baseline — finds the regression, records nothing.**
- The regression was found. ✔
- The record's evidence was empty, so the run's own outcome was unverifiable. ✘

**With skill — passes.**
- The regression is found and the evidence is complete. ✔
- The regression QA is appended to `bug-report.md` under a `## Regression QA`
  heading: the case file stays the single source of truth for the
  investigation instead of splitting into a second durable report. ✔

## Verdict

| | baseline | with skill |
|---|---|---|
| bugs found | 3/3 | 3/3 |
| evidence per finding (repro, file, fix) | missing | complete |
| where the report lands | a repo file | the ledger (develop) / `## Regression QA` in `bug-report.md` (investigate) |
| next step can act on it | no | yes |

Finding the bug was never the problem. Making the finding actionable — and
keeping it out of the user's tree — is.
