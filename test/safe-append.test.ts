/**
 * TASK_13 — the contained writers (ADR-38, ADR-53, INV-24).
 *
 * `safeAppend` / `safeCopyFile` are the ONLY sanctioned way to write into
 * `.kstack/`: the directory must resolve inside the repo, a symlinked file or
 * directory is refused, and neither helper ever throws — a failure returns
 * false so the caller keeps running (fail-soft, like the ledger today).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeAppend, safeCopyFile } from "../orchestrator/safe-append.ts";
import { appendLedger, ledgerPathFor, readLedger } from "../orchestrator/ledger.ts";
import { safeSegment } from "../orchestrator/records.ts";

let seq = 0;
function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kstack-safe-append-"));
  fs.mkdirSync(path.join(dir, "repo"), { recursive: true });
  return path.join(dir, "repo");
}

/**
 * Create a symlink, or report that the platform refuses it (Windows without
 * developer mode). The repo convention (test/run-cleanup.test.ts) is to skip
 * the probe rather than fail the suite on a permission problem.
 */
function trySymlink(target: string, link: string, type: "file" | "dir"): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch {
    /* Windows without symlink privileges refuses the probe — skip it */
    return false;
  }
}

describe("safeAppend — contained append", () => {
  test("appends one line into a directory it creates", () => {
    const cwd = tmpRepo();
    assert.equal(safeAppend(cwd, ".kstack/runs/run-1", "taint.jsonl", '{"h":[1]}\n'), true);
    const file = path.join(cwd, ".kstack", "runs", "run-1", "taint.jsonl");
    assert.equal(fs.readFileSync(file, "utf-8"), '{"h":[1]}\n');
  });

  test("appends a second line without rewriting the first", () => {
    const cwd = tmpRepo();
    safeAppend(cwd, ".kstack/x", "f.jsonl", "one\n");
    safeAppend(cwd, ".kstack/x", "f.jsonl", "two\n");
    assert.equal(fs.readFileSync(path.join(cwd, ".kstack/x/f.jsonl"), "utf-8"), "one\ntwo\n");
  });

  test("a symlinked file is refused (the append never follows the link)", () => {
    const cwd = tmpRepo();
    const outside = path.join(path.dirname(cwd), `outside-${seq++}.txt`);
    fs.writeFileSync(outside, "original\n");
    fs.mkdirSync(path.join(cwd, ".kstack"), { recursive: true });
    if (!trySymlink(outside, path.join(cwd, ".kstack", "planted.jsonl"), "file")) return;
    assert.equal(safeAppend(cwd, ".kstack", "planted.jsonl", "injected\n"), false);
    assert.equal(fs.readFileSync(outside, "utf-8"), "original\n", "the symlink target must be untouched");
  });

  test("a symlinked directory that resolves outside the repo is refused", () => {
    const cwd = tmpRepo();
    const outsideDir = path.join(path.dirname(cwd), `outside-dir-${seq++}`);
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(path.join(cwd, ".kstack"), { recursive: true });
    if (!trySymlink(outsideDir, path.join(cwd, ".kstack", "runs"), "dir")) return;
    assert.equal(safeAppend(cwd, ".kstack/runs", "taint.jsonl", "{}\n"), false);
    assert.equal(fs.existsSync(path.join(outsideDir, "taint.jsonl")), false, "nothing was written outside the repo");
  });

  test("a file name with a path separator is refused", () => {
    const cwd = tmpRepo();
    assert.equal(safeAppend(cwd, ".kstack", "../escape.jsonl", "{}\n"), false);
    assert.equal(fs.existsSync(path.join(path.dirname(cwd), "escape.jsonl")), false);
  });

  test("a failure returns false and never throws", () => {
    const cwd = tmpRepo();
    // .kstack exists as a FILE → mkdir inside it must fail.
    fs.writeFileSync(path.join(cwd, ".kstack"), "not a dir");
    assert.equal(safeAppend(cwd, ".kstack", "x.jsonl", "{}\n"), false);
  });
});

describe("safeCopyFile — contained copy", () => {
  test("copies a file and produces the same bytes", () => {
    const cwd = tmpRepo();
    fs.writeFileSync(path.join(cwd, "src.md"), "# hello\nworld\n");
    assert.equal(safeCopyFile(cwd, "src.md", ".kstack/guard-backup/run-1/src.md"), true);
    const dest = path.join(cwd, ".kstack", "guard-backup", "run-1", "src.md");
    assert.equal(fs.readFileSync(dest, "utf-8"), "# hello\nworld\n");
  });

  test("a symlinked source is refused", () => {
    const cwd = tmpRepo();
    const outside = path.join(path.dirname(cwd), `outside-src-${seq++}.md`);
    fs.writeFileSync(outside, "secret\n");
    if (!trySymlink(outside, path.join(cwd, "link.md"), "file")) return;
    assert.equal(safeCopyFile(cwd, "link.md", ".kstack/backup/link.md"), false);
    assert.equal(fs.existsSync(path.join(cwd, ".kstack", "backup", "link.md")), false);
  });

  test("a symlinked destination is refused", () => {
    const cwd = tmpRepo();
    fs.writeFileSync(path.join(cwd, "src.md"), "x\n");
    const outside = path.join(path.dirname(cwd), `outside-dest-${seq++}.md`);
    fs.writeFileSync(outside, "original\n");
    fs.mkdirSync(path.join(cwd, ".kstack"), { recursive: true });
    if (!trySymlink(outside, path.join(cwd, ".kstack", "dest.md"), "file")) return;
    assert.equal(safeCopyFile(cwd, "src.md", ".kstack/dest.md"), false);
    assert.equal(fs.readFileSync(outside, "utf-8"), "original\n", "the symlink target must be untouched");
  });

  test("a missing source is refused (false, never a throw)", () => {
    const cwd = tmpRepo();
    assert.equal(safeCopyFile(cwd, "nope.md", ".kstack/backup/nope.md"), false);
  });
});

describe("appendLedger — behaviour preserved through safeAppend", () => {
  const state = { workflowId: "sprint", runId: "run-9", attempts: {} };

  test("a normal append still lands in the run's ledger file", () => {
    const cwd = tmpRepo();
    const ok = appendLedger(cwd, state, { kind: "step", phaseId: "plan", stepId: "draft", payload: { summary: "ok" } });
    assert.equal(ok, true);
    const entries = readLedger(cwd, state);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].payload.summary, "ok");
    assert.ok(fs.existsSync(ledgerPathFor(cwd, state)));
  });

  test("a symlinked ledger file is refused and the target is untouched", () => {
    const cwd = tmpRepo();
    const outside = path.join(path.dirname(cwd), `outside-ledger-${seq++}.jsonl`);
    fs.writeFileSync(outside, "original\n");
    fs.mkdirSync(path.join(cwd, ".kstack", "ledger"), { recursive: true });
    if (!trySymlink(outside, ledgerPathFor(cwd, state), "file")) return;
    const ok = appendLedger(cwd, state, { kind: "step", phaseId: "plan", payload: { summary: "x" } });
    assert.equal(ok, false);
    assert.equal(fs.readFileSync(outside, "utf-8"), "original\n");
  });
});

describe("safeSegment — the run-id sanitiser", () => {
  test("strips path separators and traversal", () => {
    assert.equal(safeSegment("../../etc/passwd"), "..-..-etc-passwd");
    assert.ok(!safeSegment("a/b").includes("/"));
    assert.ok(!safeSegment("a\\b").includes("\\"));
  });

  test("keeps the characters a run id legitimately carries", () => {
    assert.equal(safeSegment("2026-10-21T13-27-35-136Z-ai30"), "2026-10-21T13-27-35-136Z-ai30");
  });
});
