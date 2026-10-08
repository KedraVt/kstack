---
name: kstack-mindrun
description: Run your code in your mind before you run it on your machine. Static pre-test bug discovery via roleplay walkthrough of a software pipeline. Use when code compiles but no runtime test exists yet, to find logic bugs and unspecified behaviors by tracing cause-effect chains through the real code. Do NOT use when a bug symptom is already known (use a debugging skill instead) or for code-style review.
metadata:
  author: Mattia
  version: "0.1.2"
---

<!-- provenance: user-stack mindrun verbatim · polished S1-ff (sibling repoint) 2026-02-11 -->

# Mindrun

**Run your code in your mind, before you run it on your machine.**

Find bugs and inconsistencies invisible to compilation by testing software **theoretically**:
a roleplay walkthrough of the pipeline (UI → input → transformation → output), with cause-effect
chains anchored to reading the **real code**, without running the app.

## Positioning

- **When to activate**: the code compiles, no bug is known yet, before any runtime test.
- **What it produces**: falsifiable triggers ready to become tests + open questions for the user
  about unspecified behavior + a verified DoD matrix.
- **When NOT to use**:
  - a bug symptom is already observed → use a debugging skill (`kstack-investigate`);
  - the user asks for a style/architecture review → use an audit skill;
  - the task is to write tests → this skill *generates* the triggers, it does not write the tests.
- **Read-only by default**: the only exception is the optional Execution Gate (Phase 4).

## Tool requirements & degradation

| Capability | Required? | If missing |
|---|---|---|
| Read files | **Yes** | The skill cannot run |
| Write files | **Yes** | Findings are reported in chat only, no artifacts |
| Run commands | No | Skip the Execution Gate entirely |
| Sub-agents | No | Skeptic and quote-verification run as consecutive passes of the same agent |

## Central rules (apply in every phase)

1. **Read the real execution path, never the memory of what the code "should" do.**
2. **A claim is not accepted until it cites file:line.**
3. **Every finding must have a falsifiable Trigger** (specific input → chain → wrong output).
   Without a prediction, it is a vibe: discard or sharpen it.
4. **Two interaction regimes**: the Phase 0 briefing is **interactive and blocking by design** —
   you must ask the user and wait for answers before walking the pipeline. Questions that arise
   later during the walkthrough (Phases 2–3) are **non-blocking**: they go to the queue, never
   halting the walk.

## State & resume

There are **two artifacts only**, and the report is written **incrementally** (updated after every
step, not at the end). If a run is interrupted, the partially-written report *is* the state:
resume by reading it and continuing from the first incomplete step.

Default locations (configurable in the briefing): `qa/` if it exists, otherwise the repo root.

- `mindrun-briefing.md` — the contract, produced in Phase 0.
- `mindrun-report.md` — the deliverable, produced incrementally from Phase 2 onward.

## Workflow

### Phase 0 — Briefing (interactive by default)

Goal: fix the Definition-of-Done **before** judging the code against it.

1. Read the code just enough to ask intelligent questions.
2. **STOP and ask the user.** This is the one interactive phase: use your question/ask tool to
   present the briefing and WAIT for the answers before proceeding. Ask about:
   - the **DoD** of the pipeline (numbered: DoD-1, DoD-2, ...): expected inputs, transformations,
     outputs, error handling;
   - **2–3 scenarios**: a happy path, an edge case, a hostile input;
   - whether a runtime is available (activates the Execution Gate).
   While reading, note the behaviors that are *finished but unspecified* ("what should happen when
   X fails?") and confirm them here — this is the cheapest moment to fix ambiguity.
3. Write `mindrun-briefing.md` using [references/briefing-template.md](references/briefing-template.md).
4. **Fallback (only when interaction is genuinely impossible)** — automated/background run, or the
   user explicitly declines the briefing: record the most plausible DoD, mark every unverified
   assumption with `~`, set `briefing_incomplete: true` in the report, and proceed.
   "The user hasn't answered yet", "asking would interrupt the flow", or "I can infer the DoD from
   the code" are NOT valid reasons to use this fallback. If in doubt, ask.

**Gate**: every scenario has a declared expected input and expected output, AND the user was asked
(or a genuine fallback condition above holds). Never skip this phase: without the briefing, the
DoD matrix in the report has no grading grid — it grades against your guesses instead of the
user's intent, which is exactly the failure this skill exists to prevent.

### Phase 1 — Breadboard (the entry point)

Goal: anchor step 1 of the pipeline in real code.

Model the entry point (UI, CLI, or API) with **places / affordances / wiring**:
- *Places*: what is visible to the user;
- *Affordances*: what actions are possible, and what is blocking (verified in code, with file:line);
- *Wiring*: where exactly control passes from the interface to the code (cite file:line).

If the wiring cannot be found in the code, that is already a finding (the interface does something
that does not exist in the code, or vice versa). The breadboard becomes the **first row** of the
pipeline table in the report — it is not a separate artifact.

### Phase 2 — Pipeline walk

Goal: the theoretical test itself. For each scenario, for each step of the pipeline:

1. Answer the four fixed questions:
   - how does the input arrive here?
   - what does the code assume about it?
   - what happens if the assumption is violated?
   - where does the output go, and who validates it?
2. Append a row to the pipeline table: `step | expected input | how the code receives it | output produced | destination`.
3. Update the scenario's **trace table**: `Iter | VarA | VarB | ... | Output`.
4. Mark `?` for behavior not covered by the briefing (→ question queue) and `~` for unverified
   assumptions you proceed with.

**The naive standard (the curious personality).** A step is complete only when you can reconstruct
the full input→output chain by following the real code line by line, **without gaps**. The test is
not "is this code clear?" — compact, implicit code is fine. The test is: *if this step produced a
wrong output, could I explain exactly why, from the code alone?* Only when the answer is **no** —
a jump you cannot reconstruct — does a question arise, and it is always a *mechanical* one
("where does this variable come from?"), never an aesthetic one. When you can trace the chain,
stop asking: curiosity that has succeeded goes silent.

### Phase 3 — Causal chain check

Goal: turn suspicion into defensible findings, or discard it.

1. Run the trace tables against the **mismatch axes** checklist
   ([references/mismatch-axes.md](references/mismatch-axes.md)):
   type, unit/measure, ordering, state, null/empty, encoding.
2. Write each surviving candidate in the **five-field format**
   ([references/finding-format.md](references/finding-format.md)):
   `Premises: / Trace: / Divergence: / Trigger: / Remedy:`.
3. **Design-intent gate**: if the code explicitly handles the boundary (throw, 429, reject),
   it is NOT a bug. Report only when the code operates past the boundary silently.
4. **Skeptic pass**: for each finding, attempt to disprove it (premise / path / consequence
   rebuttal). Asymmetry: rejecting a real bug costs twice as much as accepting a false one.
   Remember: this code was written by whoever is now testing it.
5. **Quote verification**: in a separate pass, re-read ONLY the lines cited by the findings in the
   real files. Withdraw any finding whose citation does not match.

**Multi-wave (optional)**: if the project is large and the last wave produced ≥1 confirmed finding,
run another walk wave (max 3), carrying forward prior findings for dedup. Stop after 2 consecutive
clean waves.

### Phase 4 — Report

Finalize `mindrun-report.md` using [references/report-template.md](references/report-template.md):

1. **DoD matrix**: one row per DoD from the briefing, verdict
   `verified / mismatch / unspecified → question`, with evidence (file:line + trace table row).
2. **Ranked findings**: five fields + confidence (high/medium/low) + smallest proof step,
   triaged `prove now / fix next / follow up`.
3. **Question queue**: priority questions first (those on the happy path), then overflow.
   The soft cap (~3 user-facing questions per step) protects the user's attention; overflow goes
   to the report, **never to silence** (dedup before overflowing). If more than 2–3 consecutive
   steps overflow, the briefing was incomplete: reopen Phase 0 instead of accumulating questions.
4. **Execution Gate (optional)**: only if the briefing declared a runtime. Generate a minimal
   reproducer for `prove now` findings only and run it; verified findings get the ✅ tag.
5. Closing block:
   ```
   STATUS == clean | findings | blocked
   findings_confirmed: N
   questions_open: N
   briefing_incomplete: true | false
   results_presented: true | false
   ```
   `results_presented` may be set to `true` only after the Phase 5 final presentation.

### Phase 5 — Handoff & final presentation

**Present the results to the user.** Writing the report is not enough: walk the user through the
outcomes at the end of the run. All of the following must be surfaced in the final message (use
your question/ask tool where an answer is needed):

1. **DoD matrix summary** — one line per DoD with its verdict (verified / mismatch / unspecified);
2. **Findings** — ranked, with triage (`prove now / fix next / follow up`) and smallest proof step;
3. **Question queue** — priority questions asked directly; overflow questions summarized and
   offered for review (they are recorded in the report, never dropped);
4. **Tasks** — task tracker entries if available, otherwise the `## Proposed tasks` checklist,
   presented item by item;
5. **STATUS block** — with counters.

Then:
- Mismatches become **tasks**: if a task tracker is available, create one task per mismatch
  (title prefixed `[mindrun]`, body linking the finding); otherwise append a
  `## Proposed tasks` checklist section at the end of the report.
- Every `prove now` finding is handed off as a ready feedback loop for a debugging skill or real QA.
- The skill ends here: it delivers, it does not execute (except the Execution Gate).

## Failure signs — the walkthrough is degenerating if:

| Sign | Corrective action |
|---|---|
| Phase 0 was skipped, or the DoD were self-inferred instead of asked | STOP: return to Phase 0 and ask the user |
| Only the issues were surfaced at the end — questions and tasks stayed in the report | Complete the Phase 5 presentation: DoD matrix, findings, questions, tasks |
| You describe what you *meant* to write, not what you wrote | Re-read the actual file, discard the memory |
| You answer a "why" without opening a file | Return to the naive standard: open the code |
| You cannot reconstruct a step's chain but move on anyway | Stop: that gap is the investigation point |
| The `?` questions are all variants of the same one | The briefing is incomplete: reopen Phase 0 |
| You stop asking "where does this come from?" after the first steps | Bias of familiarity: re-read the last step line by line |

## Red flags — STOP

- Proceeding to Phase 1+ without having asked the user the briefing questions (or a genuine
  fallback condition: automated run, or user explicitly declined).
- "Obviously", "surely", "it must handle it" — without an open file.
- Marking a step complete without being able to trace its input→output chain.
- A finding without a concrete Trigger.
- Silently dropping a question because the step's cap was reached (overflow goes to the report).
- Claiming a citation without having re-read it in the file.

