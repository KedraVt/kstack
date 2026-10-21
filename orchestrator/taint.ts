/**
 * TASK_14 / ADR-39, ADR-57, ADR-61 — the taint store.
 *
 * The provenance guard needs to answer one question: "did this artifact copy
 * a passage that a browse tool once returned?". The store is the memory of
 * that: every untrusted output is reduced to the hashes of its 8-token
 * shingles, and the guard asks the store whether an artifact's shingles are
 * known. HASHES ONLY — no page text is ever persisted (TB-9): the file holds
 * lines of `{"h":[n,…]}` and nothing else.
 *
 * Rules that are invariants, not preferences:
 *  - ONE normalisation on both sides (NFKC, lower-case, `/[\p{L}\p{N}_]+/u`),
 *    so a Markdown-reflowed copy of a passage hashes like the original
 *    (ADR-39);
 *  - the store lives in the RUN's directory and dies with the run
 *    (`.kstack/runs/<safeSegment(runId)>/taint.jsonl`);
 *  - the path is resolved from the SESSION cwd on BOTH sides — the write
 *    side takes `ctx.cwd`, the read side the same root. `process.cwd()` is
 *    the PROCESS cwd and can differ: a store written in one tree and read in
 *    another silently disables the guard (ADR-61, INV-30);
 *  - the environment carries the RUN ID only (`KSTACK_TAINT_RUN`), never a
 *    path: no process can be steered to another location (ADR-57);
 *  - the file is written only through `safeAppend` — the same containment
 *    the ledger uses (ADR-38);
 *  - the size is bounded: at 16 MiB the writer stops (a process-local flag).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { safeAppend } from "./safe-append.ts";
import { projectRootFor, safeSegment } from "./records.ts";

/** The shingle width: 8 consecutive tokens make one shingle. */
export const SHINGLE_K = 8;

/** The store's size bound — at 16 MiB the writer stops recording. */
export const TAINT_MAX_BYTES = 16 * 1024 * 1024;

/** Integers per line — 256 keeps a line below 3 KiB. */
const HASHES_PER_LINE = 256;

/** The env var that carries the RUN ID (never a path). */
const RUN_ID_ENV = "KSTACK_TAINT_RUN";

/**
 * The process-local "the store is full" flag. It is deliberately NOT keyed
 * by run id: a full store stays full for this process (the aggregate bound
 * is 16 MiB + 3 KiB × the concurrent writers).
 */
let storeFull = false;

/**
 * The hashes THIS process recorded, and the bytes it wrote (ADR-39, G1).
 *
 * The agent has `bash`/`write`: it could delete or truncate the store it is
 * checked against. The main process therefore keeps its own evidence — a
 * file SMALLER than the bytes this process wrote is TAMPERED, and the guard
 * degrades to a whole-artifact scan instead of trusting a store the agent
 * may have emptied. Contributions of child processes live only in the file
 * (residual R6).
 *
 * The evidence is kept PER RUN: the store is per-run, so a byte count that
 * mixed two runs would call every later run tampered (its file is smaller
 * than another run's total).
 */
const ownByRun = new Map<string, { hashes: Set<number>; bytes: number }>();

/** The process-local evidence about the store — the guard's tamper check. */
export interface TaintOwnState {
  /** The hashes this process recorded. */
  hashes: Set<number>;
  /** The bytes this process appended. */
  bytes: number;
  /** True when this process stopped recording (the store hit its bound). */
  full: boolean;
}

/** The process-local evidence about the store. Never throws. */
export function taintOwnState(runId?: string): TaintOwnState {
  if (runId !== undefined) {
    const own = ownByRun.get(runId);
    return { hashes: new Set(own?.hashes ?? []), bytes: own?.bytes ?? 0, full: storeFull };
  }
  const hashes = new Set<number>();
  let bytes = 0;
  for (const own of ownByRun.values()) {
    for (const h of own.hashes) hashes.add(h);
    bytes += own.bytes;
  }
  return { hashes, bytes, full: storeFull };
}

/** Test seam: forget that the store was full. Never called in production. */
export function resetTaintStore(): void {
  storeFull = false;
  ownByRun.clear();
}

/**
 * The shared tokenisation: NFKC, lower-case, then every maximal match of
 * `/[\p{L}\p{N}_]+/u`. Everything else — whitespace, punctuation, Markdown
 * syntax — is a separator.
 */
export function tokens(text: string): string[] {
  if (!text) return [];
  return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/** FNV-1a, 32-bit, over the UTF-8 bytes of the shingle. */
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The hash of ONE shingle, given as its tokens — the shared hash the guard
 * uses when it walks an artifact's own token list (the writer hashes the
 * same token sequence).
 */
export function shingleHash(list: string[]): number {
  return fnv1a32(list.join(" "));
}

/**
 * The hashes of every shingle of the text. A text shorter than `k` tokens
 * yields no hash at all — it cannot be a copied run.
 */
export function shingleHashes(text: string, k: number = SHINGLE_K): number[] {
  const list = tokens(text);
  if (k < 1 || list.length < k) return [];
  const hashes: number[] = [];
  for (let i = 0; i + k <= list.length; i++) {
    hashes.push(shingleHash(list.slice(i, i + k)));
  }
  return hashes;
}

/** The store's directory, relative to the session cwd. */
function storeDir(runId: string): string {
  return path.posix.join(".kstack", "runs", safeSegment(runId));
}

/** The store's file — resolved from the SESSION cwd on both sides. */
export function taintPathFor(cwd: string, runId: string): string {
  return path.join(projectRootFor(cwd), ".kstack", "runs", safeSegment(runId), "taint.jsonl");
}

/** The run id the environment carries — empty when no run is active. */
function activeRunId(): string {
  return (process.env[RUN_ID_ENV] ?? "").trim();
}

/**
 * Record an untrusted output: append the shingle hashes, 256 per line.
 *
 * Returns true when at least one line was appended. Never throws: a write
 * failure is swallowed (the tool call still succeeds — the store is an
 * optimisation for the guard, not a gate).
 */
export function recordUntrusted(body: string, cwd: string): boolean {
  try {
    if (storeFull) return false;
    const runId = activeRunId();
    if (!runId) return false;
    const hashes = shingleHashes(body ?? "");
    if (hashes.length === 0) return false;
    const relDir = storeDir(runId);
    const file = path.join(cwd, relDir, "taint.jsonl");
    let wrote = false;
    for (let i = 0; i < hashes.length; i += HASHES_PER_LINE) {
      const chunk = hashes.slice(i, i + HASHES_PER_LINE);
      // The size bound: stat BEFORE the append and stop at 16 MiB.
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0;
      }
      if (size >= TAINT_MAX_BYTES) {
        storeFull = true;
        break;
      }
      const line = `{"h":[${chunk.join(",")}]}\n`;
      if (safeAppend(cwd, relDir, "taint.jsonl", line)) {
        wrote = true;
        // The process-local evidence: what THIS process recorded and wrote.
        const own = ownByRun.get(runId) ?? { hashes: new Set<number>(), bytes: 0 };
        for (const h of chunk) own.hashes.add(h);
        own.bytes += Buffer.byteLength(line, "utf-8");
        ownByRun.set(runId, own);
      }
    }
    return wrote;
  } catch {
    return false;
  }
}

/**
 * Read the store: every hash of every well-formed line.
 *
 * Only `{h:[n,…]}` with integers in [0, 2³²) is accepted. A partial last
 * line (the file does not end with a newline) is skipped, a garbled line is
 * skipped, a missing file yields an empty set. Never throws.
 */
export function loadTaint(cwd: string, runId: string): Set<number> {
  const out = new Set<number>();
  try {
    if (!runId) return out;
    const file = taintPathFor(cwd, runId);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      return out; // ENOENT — nothing was recorded
    }
    const lines = raw.split("\n");
    // A file that does not end with a newline has a PARTIAL last line.
    if (!raw.endsWith("\n")) lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const hashes = (parsed as { h?: unknown }).h;
      if (!Array.isArray(hashes)) continue;
      for (const value of hashes) {
        if (typeof value !== "number" || !Number.isInteger(value)) continue;
        if (value < 0 || value >= 2 ** 32) continue;
        out.add(value);
      }
    }
    return out;
  } catch {
    return out;
  }
}
