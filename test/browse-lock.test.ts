// Stale browse start-lock cleanup (PID reuse on Windows kept a crash-left
// lock "alive" for weeks and blocked every server start).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearStaleServerLock, serverLockPath, STALE_LOCK_MS } from "../lib/browse.ts";

function withLock(ageMs: number, run: (cwd: string, lock: string) => void): void {
  const prev = process.env.BROWSE_STATE_FILE;
  delete process.env.BROWSE_STATE_FILE;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kstack-lock-"));
  try {
    const lock = serverLockPath(cwd);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    // A LIVE pid — exactly the reused-PID case upstream's liveness check trusts.
    fs.writeFileSync(lock, `${process.pid}\n`);
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(lock, t, t);
    run(cwd, lock);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    if (prev !== undefined) process.env.BROWSE_STATE_FILE = prev;
  }
}

test("a lock older than STALE_LOCK_MS is removed even when its PID is alive", () => {
  withLock(STALE_LOCK_MS + 60_000, (cwd, lock) => {
    assert.equal(clearStaleServerLock(cwd), true);
    assert.equal(fs.existsSync(lock), false);
  });
});

test("a fresh lock (a server booting right now) is left alone", () => {
  withLock(5_000, (cwd, lock) => {
    assert.equal(clearStaleServerLock(cwd), false);
    assert.equal(fs.existsSync(lock), true);
  });
});

test("no lock is a no-op", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kstack-lock-"));
  try {
    assert.equal(clearStaleServerLock(cwd), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("BROWSE_STATE_FILE relocates the lock like the CLI does", () => {
  const prev = process.env.BROWSE_STATE_FILE;
  process.env.BROWSE_STATE_FILE = path.join(os.tmpdir(), "x", "browse.json");
  try {
    assert.equal(serverLockPath("."), `${process.env.BROWSE_STATE_FILE}.lock`);
  } finally {
    if (prev === undefined) delete process.env.BROWSE_STATE_FILE;
    else process.env.BROWSE_STATE_FILE = prev;
  }
});
