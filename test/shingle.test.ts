import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shingleHashes, shingleHashesFromTokens, tokens, SHINGLE_K } from "../orchestrator/taint.ts";

/**
 * CR-2 — the WRITER (the taint store) and the MATCHER (the guard) must
 * agree on the hash of every shingle. They used to compute the same window
 * loop twice; now they share one helper, and this test pins the agreement.
 */
describe("the shingle window helper", () => {
  test("the writer and the matcher compute the same windows", () => {
    const text = "the quick brown fox jumps over the lazy dog and keeps running";
    const fromText = shingleHashes(text);
    const fromTokens = shingleHashesFromTokens(tokens(text));
    assert.deepEqual(fromTokens, fromText);
    assert.equal(fromText.length, tokens(text).length - SHINGLE_K + 1);
  });

  test("a text shorter than the window yields no hash", () => {
    assert.deepEqual(shingleHashes("too short"), []);
    assert.deepEqual(shingleHashesFromTokens(tokens("too short")), []);
  });

  test("the same tokens in a different order hash differently", () => {
    // Eight tokens are needed for one window to exist at all.
    const a = shingleHashesFromTokens(tokens("alpha beta gamma delta epsilon zeta eta theta"));
    const b = shingleHashesFromTokens(tokens("theta eta zeta epsilon delta gamma beta alpha"));
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.notEqual(a[0], b[0]);
  });
});
