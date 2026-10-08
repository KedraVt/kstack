# Finding Format — The Five Fields

Every finding MUST use these literal fields, in this order. Do not paraphrase the labels.

## The fields

**Premises:** What the code assumes. Every implicit assumption surfaced by the naive standard,
stated explicitly. If a premise is itself unverified, mark it `~`.

**Trace:** The execution path, step by step, citing file:line for every hop. No hops from memory.
This is where the pipeline table row and the trace table row are referenced.

**Divergence:** Where the real behavior diverges from the expected one (from the briefing's DoD).
The specific point in the trace where the chain breaks.

**Trigger:** The concrete input that reproduces the bug. Required for every finding.
Format: "Given `<specific input>`, when `<condition>`, then `<wrong output>`".
A finding without a Trigger is a vibe: discard or sharpen it. (This is the falsifiability rule.)

**Remedy:** A paste-ready fix proposal. If the fix is not obvious, state the smallest change that
eliminates the divergence without breaking the happy path.

## Acceptance gate

A finding is reported only if ALL of these hold:

- [ ] All five fields are present and non-empty.
- [ ] The Trigger is concrete (a real input value, not "some large input").
- [ ] The design-intent gate passed: the code does NOT already handle this case explicitly.
- [ ] The skeptic pass failed to disprove it (or it survived with a downgrade to suggestion).
- [ ] Every citation in Trace was re-read in the actual file (quote verification).

## Example — good

**Premises:** `translate_in()` assumes `rawText` is NFC-normalized Unicode (not stated in code, marked `~`).

**Trace:** `ui/Input.tsx:58` submits raw value → `core/pipeline.ts:17` `enter(text)` → `core/pipeline.ts:31` calls `translate_in(text)` → `services/translator.ts:44` splits on `\n` and joins.

**Divergence:** At `services/translator.ts:44`, the input with decomposed emoji (`e` + U+0301) splits mid-grapheme, producing a malformed translation request.

**Trigger:** Given the input `"cafe\u0301"` (decomposed), when submitted through the happy path, then the translator receives a corrupted string and returns a 400 that surfaces as a generic error to the user (DoD-3 expects a specific translation-error message).

**Remedy:** Add `text = text.normalize("NFC")` at the entry point `core/pipeline.ts:17`, before any processing.

## Example — bad (would be discarded)

**Premises:** The code probably handles large inputs.

**Trace:** It goes through the pipeline.

**Divergence:** It might break on large inputs.

**Trigger:** A large input. *(not concrete — this is a vibe)*

**Remedy:** Add validation. *(not paste-ready)*
