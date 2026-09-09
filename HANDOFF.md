# HANDOFF — 2026-09 orchestrator fixes: open follow-ups

Session: four root-cause fixes for the develop/sprint cycle, committed as
`f30b849` ("parked-gate re-anchor, in-flight decision guards, LLM-named plans,
open-questions carry-over") on `feat/sprint-workflow`. Typecheck clean, 243/243
tests passing (`npm test` / `bun test test/orchestrator.test.ts test/sprint.test.ts …`).

This document is the resume point for the remaining `follow up` items found by
the mindrun walkthrough of the committed code. All are low severity; none
blocks a normal cycle.

## F4 — Sprint-panel decision paths lack the in-flight guard · *fix next*

**What.** The 2026-09 race fix added `decisionBlockedByInFlightChain()` and
wired it into the three GENERIC decision paths (`/gstack next` optional-park,
optional Run/Skip, generic Approve — `orchestrator/command.ts:77,103,134,139,168`).
The sprint-only interactive panels were NOT wired: they can mutate state and
re-launch a phase while a delegation chain for the same phase is still running.

**Where.**
- D4 unreadable-verdict panel: `command.ts:324-326` — `forceApproveParked(state)` → `launchPhase`.
- Kill-switch / loop-exhaustion panels: `command.ts:338, 362-364, 394, 396-398` —
  `resumeState`/`reissueGate`/`forceContinuePastGate` → `launchPhase`.

**Mitigations that exist today.** The executor's B7 staleness check
(`executor.ts:384`: `live.phaseIndex !== state.phaseIndex` ⇒ results dropped)
and the duplicate-chain guard (`inFlightPhases`) prevent state corruption for
same-process relaunches. The residual exposure is the same racing class fixed
for the generic paths: a decision + launch against a chain still in flight.

**Suggested remedy.** At the top of each sprint panel branch (after the choice
is taken, before any state mutation), call
`if (decisionBlockedByInFlightChain(ctx, state)) return;` — identical pattern
to the generic paths. Test seam: the `sprint.test.ts` describe
"in-flight decision guards (2026-09 fix 4)" already exercises the helper via
`launchPhase` with a gated promise; mirror it for the panel branches.

## F2 — Input router re-anchors from a stale state snapshot · *follow up*

**What.** `createInputRouter` loads the workflow state ONCE per input event
(`orchestrator/router.ts:27`) and builds the resume prefix from it
(`:30-32`). Phase chains run fire-and-forget (`executor.ts:798-800`), so a gate
that resolves mid-turn (e.g. the model's `gstack_advance` landing while the
user is still typing) leaves the rest of the turn prefixed with the OLD
posture — worst case, the pre-fix "Continue working" behavior for one turn.

**Mitigations that exist today.** `advanceBlockReason` refuses model-side
advances while parked (`index.ts:77-85`), and the parked-gate constraint text
itself is fail-safe ("do NOT continue … only /gstack next"). Exposure is
therefore a one-turn stale prefix, not silent advancement.

**Suggested remedy.** Re-read `loadActiveState(ctx)` immediately before
`buildResumeContext(activeState)` (it is cheap: session-entry scan), or
re-validate `state.status` after any `await` gap in the handler.

## F5 — Same-line `OPEN QUESTIONS:` bullets — WITHDRAWN (refuted by probe)

Recorded in the mindrun report as a low-confidence edge; mechanically refuted
before any code change:

```
same-line bullet: "### Carried-over open questions …\n\n- Which storage backend?"
newline bullets : "### Carried-over open questions …"   (both extract fine)
```

The capture regex `templates.ts:854`
(`/OPEN QUESTIONS:\s*\n?((?:[ \t]*[-*•]\s*[^\n]+\n?)+)/`) tolerates the bullet
group on the same line because `\s*` consumes the separator space; the `\n?`
is optional, not required. No change needed.

## Design note (accepted, not a defect)

DoD-2's "remain parked after revisions" is enforced at PROMPT level: the
parked-gate constraint (`executor.ts:761-765` and `:808-821`) re-anchors every
user message, while the hard mechanical block lives in `advanceBlockReason`
(model cannot advance a parked state) and the in-flight guard. A model that
ignores the constraint mid-turn can still drift — that is inherent to in-turn
behavior and was accepted in the 2026-09 review. Do not "fix" by adding a
second state machine.

## Proposed tasks

- [ ] `[mindrun]` F4: guard the sprint-panel decision paths with `decisionBlockedByInFlightChain` (+ panel-branch tests)
- [ ] `[mindrun]` F2: router re-reads `loadActiveState(ctx)` before building the resume prefix
- [x] `[mindrun]` F5: withdrawn — refuted by probe (no change needed)
- [ ] Dogfood: run a full develop cycle in pi to verify the parked gate, the
      in-flight guards and LLM plan naming end to end
