/**
 * TASK_13 / ADR-38 / ADR-53 — the shared contained-append helper.
 *
 * Every writer that puts bytes into `.kstack/` goes through this module: the
 * directory must resolve INSIDE the repo, a symlinked file or directory is
 * refused, and neither helper ever throws — a failure returns `false` and the
 * caller keeps running (fail-soft, exactly like the ledger's own contract).
 *
 * The containment is the same one `appendLedger` used to own; it was extracted
 * here verbatim so a NEW writer (the taint store) cannot be less careful than
 * the ledger. `appendLedger` is the oracle: refactoring it onto these helpers
 * must not change a single byte it writes.
 *
 * `safeCopyFile` is a COPY, not an append: a backup of a tracked artifact is
 * a new file with the same bytes. It applies the same realpath containment on
 * BOTH sides and refuses a symlinked source or destination — a symlinked
 * backup target would otherwise turn the copy into a write outside the repo.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * True when `target` resolves inside `root`. Both sides are realpath'd
 * first: a symlinked directory must not smuggle a write out of the repo.
 * A missing path resolves to its closest existing ancestor.
 */
function containedIn(root: string, target: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    // The target may not exist yet (a fresh append) — resolve the deepest
    // existing ancestor and re-append the remainder.
    let probe = target;
    const tail: string[] = [];
    // Bounded walk: a path has finitely many segments.
    for (;;) {
      if (fs.existsSync(probe)) break;
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      tail.unshift(path.basename(probe));
      probe = parent;
    }
    const rel = path.relative(realRoot, fs.realpathSync(probe));
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    // The unresolved tail must not escape either (it cannot contain ".."
    // because basename() of ".." is "..", which the loop above would have
    // descended past — but a literal check keeps the invariant explicit).
    for (const seg of tail) {
      if (seg === ".." || seg === ".") return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * A file NAME, not a path: no separator, no traversal, not empty. The
 * directory is the caller's `relDir`; the name is a leaf inside it.
 */
function isLeafName(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes("\0")) return false;
  return true;
}

/** The outcome of a contained write — `reason` names the cause. */
export interface ContainedWriteResult {
  ok: boolean;
  reason?: string;
}

/**
 * Append ONE line to `<cwd>/<relDir>/<fileName>`, creating the directory.
 *
 * Containment: the directory must resolve inside the repo; the file must not
 * be a symlink (a planted link would redirect the append out of the repo).
 * Never throws — the outcome carries the reason instead.
 */
export function safeAppendDetailed(cwd: string, relDir: string, fileName: string, line: string): ContainedWriteResult {
  try {
    if (!isLeafName(fileName)) return { ok: false, reason: "file name is not a leaf" };
    const dir = path.join(cwd, relDir);
    fs.mkdirSync(dir, { recursive: true });
    if (!containedIn(cwd, dir)) return { ok: false, reason: "target directory resolves outside the repo" };
    const file = path.join(dir, fileName);
    // lstat (not existsSync) — it also catches a DANGLING symlink.
    let lst: fs.Stats | null = null;
    try {
      lst = fs.lstatSync(file);
    } catch {
      /* ENOENT — a new file, fine */
    }
    if (lst?.isSymbolicLink()) return { ok: false, reason: "target file is a symlink" };
    fs.appendFileSync(file, line, "utf-8");
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: err?.code ?? err?.message ?? "write failed" };
  }
}

/** `safeAppendDetailed` as a boolean — the shape most callers want. */
export function safeAppend(cwd: string, relDir: string, fileName: string, line: string): boolean {
  return safeAppendDetailed(cwd, relDir, fileName, line).ok;
}

/**
 * Copy `<cwd>/<srcRel>` to `<cwd>/<destRel>`, creating the destination's
 * parent directories. Containment is checked on BOTH sides; a symlinked source
 * or destination is refused. Returns false on ANY failure and never throws.
 */
export function safeCopyFile(cwd: string, srcRel: string, destRel: string): boolean {
  try {
    if (!srcRel || !destRel) return false;
    const src = path.resolve(cwd, srcRel);
    const dest = path.resolve(cwd, destRel);
    if (!containedIn(cwd, src)) return false;
    if (!containedIn(cwd, dest)) return false;
    // The SOURCE must be a real file, not a symlink.
    let srcLst: fs.Stats | null = null;
    try {
      srcLst = fs.lstatSync(src);
    } catch {
      return false; // ENOENT — nothing to copy
    }
    if (srcLst.isSymbolicLink() || !srcLst.isFile()) return false;
    // The DESTINATION must not be a symlink either.
    let destLst: fs.Stats | null = null;
    try {
      destLst = fs.lstatSync(dest);
    } catch {
      /* ENOENT — a new file, fine */
    }
    if (destLst?.isSymbolicLink()) return false;
    const destDir = path.dirname(dest);
    fs.mkdirSync(destDir, { recursive: true });
    if (!containedIn(cwd, destDir)) return false;
    fs.copyFileSync(src, dest);
    return true;
  } catch {
    return false;
  }
}
