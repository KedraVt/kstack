/**
 * TASK_14 — the taint store (ADR-39, ADR-57, ADR-61, INV-24, INV-30).
 *
 * The store is the ONLY place where untrusted output is remembered, and it
 * remembers HASHES ONLY: no page text is ever persisted (TB-9). Both sides
 * of the guard share one tokenisation and one hash, so a Markdown-reflowed
 * copy of a passage produces the same shingles as the original.
 *
 * The store lives in the run's directory and dies with the run; it is
 * written through `safeAppend` (the contained writer) and resolved from the
 * SESSION cwd on both sides — never from `process.cwd()` (ADR-61, INV-30).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  tokens,
  shingleHashes,
  recordUntrusted,
  loadTaint,
  resetTaintStore,
  SHINGLE_K,
  TAINT_MAX_BYTES,
} from "../orchestrator/taint.ts";

let seq = 0;
function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kstack-taint-"));
  fs.mkdirSync(path.join(dir, "repo"), { recursive: true });
  return path.join(dir, "repo");
}

/** The run id travels in the environment — never a path (ADR-57). */
function withRunId(runId: string | undefined, fn: () => void): void {
  const prev = process.env.KSTACK_TAINT_RUN;
  if (runId === undefined) delete process.env.KSTACK_TAINT_RUN;
  else process.env.KSTACK_TAINT_RUN = runId;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.KSTACK_TAINT_RUN;
    else process.env.KSTACK_TAINT_RUN = prev;
  }
}

function trySymlink(target: string, link: string, type: "file" | "dir"): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch {
    /* Windows without symlink privileges refuses the probe — skip it */
    return false;
  }
}

const taintFile = (cwd: string, runId: string) =>
  path.join(cwd, ".kstack", "runs", runId, "taint.jsonl");

describe("tokens — the shared normalisation", () => {
  test("lower-cases, normalises NFKC and splits on punctuation", () => {
    assert.deepEqual(tokens("Hello, World!"), ["hello", "world"]);
    assert.deepEqual(tokens("CAFÉ"), ["café"]);
    // NFKC folds the fullwidth latin letters onto ASCII.
    assert.deepEqual(tokens("ＡＢ"), ["ab"]);
    assert.deepEqual(tokens("a_b-c 42"), ["a_b", "c", "42"]);
  });

  test("markdown syntax is a separator, not a token", () => {
    assert.deepEqual(tokens("**bold** `code`"), ["bold", "code"]);
  });

  test("an empty text has no tokens", () => {
    assert.deepEqual(tokens(""), []);
    assert.deepEqual(tokens("... !?"), []);
  });
});

describe("shingleHashes — the shared shingle hash", () => {
  test("a passage and its Markdown reflow share the hashes", () => {
    const original = "The quick brown fox jumps over the lazy dog near the river bank";
    const reflowed = "The quick brown fox\n\njumps over the lazy dog near the **river bank**";
    assert.deepEqual(shingleHashes(original), shingleHashes(reflowed));
  });

  test("a shingle is SHINGLE_K consecutive tokens", () => {
    const text = Array.from({ length: SHINGLE_K }, (_, i) => `t${i}`).join(" ");
    assert.equal(shingleHashes(text).length, 1, "exactly one window for exactly K tokens");
    const shorter = Array.from({ length: SHINGLE_K - 1 }, (_, i) => `t${i}`).join(" ");
    assert.equal(shingleHashes(shorter).length, 0, "a passage shorter than one shingle yields nothing");
  });

  test("the hashes are 32-bit unsigned integers", () => {
    for (const h of shingleHashes("one two three four five six seven eight nine ten")) {
      assert.ok(Number.isInteger(h) && h >= 0 && h < 2 ** 32, `not a u32: ${h}`);
    }
  });
});

describe("recordUntrusted — the writer", () => {
  test("the file holds only integer-hash lines — no page text", () => {
    const cwd = tmpRepo();
    withRunId("run-1", () => {
      assert.equal(recordUntrusted("secret passage from the page about llamas and alpacas", cwd), true);
    });
    const raw = fs.readFileSync(taintFile(cwd, "run-1"), "utf-8");
    for (const line of raw.split("\n").filter(Boolean)) {
      assert.match(line, /^\{"h":\[[0-9]+(,[0-9]+)*\]\}$/, `not an integer-hash line: ${line}`);
    }
    assert.ok(!raw.includes("llamas"), "no page text may be persisted");
  });

  test("the recorded hashes are the ones the reader finds", () => {
    const cwd = tmpRepo();
    const body = "one two three four five six seven eight nine ten eleven";
    withRunId("run-2", () => {
      recordUntrusted(body, cwd);
    });
    const taint = loadTaint(cwd, "run-2");
    for (const h of shingleHashes(body)) assert.ok(taint.has(h), `missing hash ${h}`);
  });

  test("a run without a run id disables the store", () => {
    const cwd = tmpRepo();
    withRunId(undefined, () => {
      assert.equal(recordUntrusted("a passage that is long enough to be recorded", cwd), false);
    });
    assert.equal(fs.existsSync(path.join(cwd, ".kstack")), false, "no store is created without a run id");
  });

  test("a symlinked run directory is refused — nothing is written outside the repo", () => {
    const cwd = tmpRepo();
    const outsideDir = path.join(path.dirname(cwd), `outside-taint-${seq++}`);
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(path.join(cwd, ".kstack", "runs"), { recursive: true });
    if (!trySymlink(outsideDir, path.join(cwd, ".kstack", "runs", "run-3"), "dir")) return;
    withRunId("run-3", () => {
      assert.equal(recordUntrusted("a passage that is long enough to be recorded", cwd), false);
    });
    assert.equal(fs.existsSync(path.join(outsideDir, "taint.jsonl")), false);
  });

  test("the size bound stops the recording", () => {
    const cwd = tmpRepo();
    resetTaintStore();
    const file = taintFile(cwd, "run-4");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    fs.truncateSync(file, TAINT_MAX_BYTES);
    withRunId("run-4", () => {
      assert.equal(recordUntrusted("a passage that is long enough to be recorded", cwd), false);
    });
    assert.equal(fs.statSync(file).size, TAINT_MAX_BYTES, "the full store is not appended to");
    resetTaintStore();
  });
});

describe("loadTaint — the reader", () => {
  test("a missing file yields an empty set", () => {
    const cwd = tmpRepo();
    assert.equal(loadTaint(cwd, "run-nope").size, 0);
  });

  test("a partial last line is skipped", () => {
    const cwd = tmpRepo();
    const file = taintFile(cwd, "run-5");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"h":[1,2,3]}\n{"h":[4,5,6]}\n{"h":[7,8');
    const taint = loadTaint(cwd, "run-5");
    assert.ok(taint.has(1) && taint.has(4), "the complete lines are read");
    assert.equal(taint.has(7), false, "the partial line is skipped");
  });

  test("a garbled line never throws and never poisons the set", () => {
    const cwd = tmpRepo();
    const file = taintFile(cwd, "run-6");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json\n{"h":"nope"}\n{"h":[9]}\n');
    const taint = loadTaint(cwd, "run-6");
    assert.ok(taint.has(9));
    assert.equal(taint.size, 1);
  });

  test("the write and the read resolve the same path even when the process cwd differs", () => {
    const cwd = tmpRepo();
    const body = "the same passage on both sides of the path rule";
    withRunId("run-7", () => {
      recordUntrusted(body, cwd);
    });
    // The reader is handed the same session cwd — never process.cwd().
    const taint = loadTaint(cwd, "run-7");
    assert.ok(taint.size > 0, "the store written under the session cwd is readable there");
    const elsewhere = loadTaint(tmpRepo(), "run-7");
    assert.equal(elsewhere.size, 0, "another tree holds another store");
  });
});
