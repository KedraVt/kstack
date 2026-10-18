---
name: kstack-lite-mindrun
description: >-
  Static code-walkthrough verdict gate for delegated runs: traces the
  just-built code against the plan doc's declared behaviors and emits a
  pass|fail walkthrough verdict for the orchestrator. Use when dispatched as
  an implement-phase post-build walkthrough step (develop, sprint) — "walk the code
  against the plan", "grade the build against Done when", "mindrun the
  implementation" — on `{plan_file}` + `{previous}`; no user on the wire.
  Do NOT use for interactive walkthroughs or pre-test bug discovery with a
  human on the wire (use kstack-mindrun), when a bug symptom is already
  known (use kstack-investigate), or for style/architecture review (use
  kstack-review).
metadata:
  version: "1.1.0"
compatibility: None — read-only delegated step; runtime/bin telemetry degrades gracefully.
---

<!-- provenance: derived from user-stack mindrun — lite variant for orchestrated delegated steps: plan-doc DoD, no artifacts, verdict output · S4 · reviewed per authoring-skills -->

# Lite Mindrun — walkthrough verdict gate

Run the code in your mind before the workflow runs it on a machine. You are the
delegated verifier of the implement phase: `build` just wrote code claiming the
plan — walk the real code and rule on it. `fail` loops back to `build`, so
findings are written FOR the builder: file:line-anchored, smallest repro,
paste-ready remedy. Read-only, artifact-free — the report body is the output.

> **Headless always.** This step only ever runs delegated — no user on the
> wire: never ask, never wait; ambiguity is `~assumed` or itself a finding.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/kstack-pi/runtime/bin/kstack-telemetry-log --event-type skill_run --skill kstack-lite-mindrun --status start 2>/dev/null || true
```

**The contract:** in = `{plan_file}` + `{previous}` (`build` summary) · grid =
the plan's `Done when` column + `## Edge cases & risks` · out = five-field
findings + one verdict line under the **verdict key** your task's RECORD
CONTRACT names (`walkthrough` in develop; the lane key `be-walk` / `fe-walk`
in sprint). The contract's key is the only one the orchestrator reads — any
other key is discarded and the step parks as missing its verdict.

## Central rules

1. Read the real execution path, never the memory of what the code "should" do —
   including the build summary's claims; "it must handle it" is a gap, not an answer.
2. A claim is not accepted until it cites file:line.
3. Every finding carries a falsifiable Trigger (input → chain → wrong output).

## Phase 0 — Grading grid (replaces the briefing)

Extract the grid BEFORE opening the implementation:

- Each `## Implementation tasks` row → a DoD item keyed by its falsifiable `Done when`.
- `## Edge cases & risks` → the scenarios to walk; `## Goal` + `## Architecture` → the pipeline shape.
- `{previous}` → what the build says it touched — walk that code; a plan↔build
  gap (missing file, skipped task) is itself a finding.

Grid absent → never self-infer it (the parent's cardinal failure): report the
missing pieces via the record's blocker channel; end with no verdict line.

## Phase 1 — Breadboard

Anchor the pipeline's entry point in real code — places / affordances / wiring
(file:line where control passes interface→code); declared-but-missing wiring is
the first candidate finding.

## Phase 2 — Pipeline walk

For the happy path and each grid-named scenario, answer the four fixed
questions per step — how does input arrive? what is assumed about it? what if
the assumption is violated? where does output go, who validates it? Keep a
trace table per scenario (`Iter | vars… | Output`).

**Naive standard.** A step is complete only when you could explain, from the
code alone, exactly why a wrong output would be wrong. An unreconstructable hop
is a mechanical question — "where does this variable come from?" — a candidate
finding, never silence.

## Phase 3 — Causal chain check

1. Run the trace tables against the six mismatch axes (`references/mismatch-axes.md`).
2. Write survivors in the five-field format (`references/finding-format.md`):
   Premises/Trace/Divergence/Trigger/Remedy — Remedy paste-ready for the builder.
3. **Design-intent gate:** explicitly handled boundaries (throw, reject, error
   path) are not bugs — report only silent past-boundary operation.
4. **Skeptic pass:** try to disprove each finding (premise/path/consequence
   rebuttal) — rejecting a real bug costs twice a false positive; the same
   hands wrote this code.
5. **Quote verification:** re-read ONLY the cited lines; withdraw on mismatch.

One wave only — the workflow's `build`↔walkthrough loop supplies iteration.

## Phase 4 — Verdict

`pass` ⟹ every `Done when` traced clean AND zero findings survive the skeptic
pass; `fail` ⟹ ≥1 survivor. Items no static trace settles (runtime timing,
external state) → `~unverifiable`, never failures; skeptic-downgraded
suggestions never flip the verdict.

End the report with exactly this terminal block:

```markdown
## Walkthrough verdict
<verdict key> == pass          ← or `fail`; exactly one, key from the RECORD CONTRACT
dod: N verified | N failed | N unverifiable · findings: N
[fail only — per finding:] file:line — divergence — trigger
```

Emitted via `kstack-report` (the step task carries the exact invocation):
`--verdict <verdict key>==pass|fail` is the gate; finding lines feed the
`build` loop-back.

❌ `--verdict walkthrough==pass` in a sprint `be-walk` step (discarded → park)
✅ `--verdict be-walk==pass` — the key the RECORD CONTRACT names

```bash
bash C:/Users/Mattia/.pi/agent/extensions/kstack-pi/runtime/bin/kstack-telemetry-log --event-type skill_run --skill kstack-lite-mindrun --status end 2>/dev/null || true
```

**Central rules, again:** read the real execution path, never the memory of
what the code "should" do — including the build summary's claims. A claim is
not accepted until it cites file:line. Every finding carries a falsifiable
Trigger. An absent grid is a blocker, never self-inferred. The verdict key is
the one the RECORD CONTRACT names.

## DoD gate (verification)

- Every `Done when` row accounted for — verified / failed / `~unverifiable`;
  the grid was never self-inferred (absent grid → blocker, not a verdict).
- Every claim cites file:line, re-read in the real file at quote verification.
- Every surviving finding: five fields + concrete Trigger; design-intent gate
  and skeptic pass applied; written for the builder (repro + remedy).
- Terminal block verbatim — one verdict line under the RECORD CONTRACT's key
  (also passed as `--verdict` to kstack-report); `fail` carries findings.
- Read-only, headless contract kept: zero files, zero commands, zero questions.

## Related skills

- `kstack-mindrun` — interactive full walkthrough (briefing, artifacts, waves)
- `kstack-test-driven-development` — turns surviving Triggers into red tests
- `kstack-verification-before-completion` — the run-it-for-real complement
- `kstack-fix-strategy` — fix strategy when a finding outgrows its Remedy
- `kstack-investigate` — root-cause debugging once a symptom is observed

---

**The plan declares; the code confesses. Trace it, then rule.**
