# Mismatch Axes Checklist

Run every trace table against these six axes. Each axis is a lens: it asks one question about the
chain. A candidate must map to at least one axis to proceed to the five-field format.

## 1. Type

Does the value crossing this step have the type the next step expects?

*Questions:* Is a string passed where a number is parsed? Is a Promise awaited before use?
Is a nullable type dereferenced?

*Example:* `config.timeout` read as string `"5000"` and passed to `setTimeout` — works in JS,
silently wrong elsewhere.

## 2. Unit / measure

Are quantities in the same unit on both sides of the step?

*Questions:* Seconds vs milliseconds? Bytes vs kilobytes? UTC vs local time? Currency minor units
(cents) vs major (dollars)?

*Example:* An LLM context limit in tokens compared against `text.length` (characters).

## 3. Ordering

Do operations happen in the order the logic requires?

*Questions:* Is normalization applied before or after translation? Is a lock acquired before the
check or after? Is cleanup before or after the error is thrown?

*Example:* Input is translated *before* being normalized, so the edge-case input hits the
translator raw.

## 4. State

Is shared state consistent across the step's boundaries?

*Questions:* Is the same variable read before an async write completes? Is state reset between
requests, or does it leak? Are two code paths updating the same store with different assumptions?

*Example:* A module-level cache keyed by user input that is never invalidated between requests.

## 5. Null / empty

What happens at the empty end of the domain?

*Questions:* Empty string, empty array, zero, null, undefined — does the step treat them as valid
input, as an error, or crash? Is "no results" distinguished from "the call failed"?

*Example:* An empty translation result `""` is rendered as a blank message instead of an error,
because the check is `if (!result)` which also catches legitimate empty output.

## 6. Encoding

Is the data in the encoding the next step assumes?

*Questions:* UTF-8 vs Latin-1? NFC vs NFD Unicode? URL-encoded vs raw? Escaped vs unescaped HTML?
Base64 with or without padding?

*Example:* User input URL-encoded by the form is passed un-decoded to the LLM prompt, so `%20`
appears literally in the translated text.

## Usage rule

For each trace table, walk each axis row and ask its questions against the chain. If no axis
produces a hit for a step, that step is clean — do not invent findings. A real bug almost always
maps to exactly one axis; if a candidate maps to several, it is probably poorly specified:
sharpen it until one axis dominates.
