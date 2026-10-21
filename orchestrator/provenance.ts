/**
 * TASK_15 / TASK_16 — the provenance guard (ADR-37, ADR-40, ADR-42, ADR-44,
 * ADR-49, ADR-53, ADR-57, ADR-58; INV-22..INV-26).
 *
 * A phase with browser access can copy page text into an artifact that a
 * later, higher-authority phase reads as instructions (TB-10, R3). No human
 * can review every string an agent copies, so the control is MECHANICAL: the
 * taint store (`orchestrator/taint.ts`) PROVES that a passage was copied from
 * a page, and the guard quarantines every such copy inside the
 * `UNTRUSTED_BEGIN/END` envelope — losslessly. Only an instruction-SHAPED
 * copy escalates to a human (ADR-44): the agent's own prose that merely
 * discusses injection patterns must never park a run.
 *
 * The four pieces:
 *  - `guardArtifact`  — the matcher and the lossless, idempotent quarantine;
 *  - `guardTargets`   — WHICH files are guarded (the `produces` rule);
 *  - `childMayBrowse` — WHEN a delegated child could have seen a page;
 *  - `runProvenanceGuard` — the runner: read → back up → rewrite → report.
 *
 * The rules that are invariants, not preferences:
 *  - the quarantine NEVER deletes or rewords a line (ADR-37);
 *  - a second pass finds no span (idempotence, INV-22);
 *  - only the CURRENT sprint's stamped files are targets (ADR-49);
 *  - the escalation scan runs over the taint-VERIFIED copies only (ADR-44);
 *  - a failed backup means the file is NOT rewritten (ADR-49);
 *  - a guard error never blocks the run (fail open, ADR-28).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  UNTRUSTED_BEGIN,
  UNTRUSTED_END,
  escapeMarkers,
  scanInstructionLines,
  scanInstructions,
} from "../lib/content-security.ts";
import { SHINGLE_K, loadTaint, shingleHash, taintOwnState, taintPathFor, tokens } from "./taint.ts";
import { BROWSER_TOOLS, profileForPhaseId } from "./toolmask.ts";
import { phaseArtifactPaths, sprintStamp, type SprintRef } from "./artifacts.ts";
import { safeCopyFile } from "./safe-append.ts";
import { safeSegment } from "./records.ts";
import { appendLedger } from "./ledger.ts";
import { EXTENSION_ROOT } from "./skills.ts";
import type { WorkflowPhase, WorkflowState } from "./types.ts";

/** A copied run is at least this many consecutive tainted windows. */
export const MIN_RUN_WINDOWS = 5;

/** …which is at least this many consecutive tokens (8 + 4). */
export const MIN_RUN_TOKENS = MIN_RUN_WINDOWS + SHINGLE_K - 1;

/** Artifacts above this size are skipped (the guard is bounded, §3.8). */
const MAX_ARTIFACT_BYTES = 1024 * 1024;

/** The park list holds at most this many entries. */
const MAX_FINDINGS = 10;

/** The excerpt in a park entry is at most this long. */
const MAX_EXCERPT = 120;

/** A heading in a park entry is at most this long. */
const MAX_HEADING = 80;

// --- The matcher ------------------------------------------------------------

/** One segment of an artifact: the text between the envelope markers. */
interface Segment {
  /** The segment's text. */
  text: string;
  /** The 1-based line the segment starts on. */
  startLine: number;
  /** True when the segment is INSIDE an existing envelope. */
  enveloped: boolean;
}

/**
 * Split an artifact into segments by the `UNTRUSTED_BEGIN … UNTRUSTED_END`
 * pairs. An already-enveloped segment passes through untouched and is never
 * re-wrapped; an unterminated BEGIN swallows the rest of the file (the
 * content is already marked, so it is not the guard's to wrap).
 */
function splitSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const newlines = (s: string): number => {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
  };
  let pos = 0;
  let line = 1;
  while (pos <= text.length) {
    const beginIdx = text.indexOf(UNTRUSTED_BEGIN, pos);
    if (beginIdx === -1) {
      const chunk = text.slice(pos);
      if (chunk.length > 0) segments.push({ text: chunk, startLine: line, enveloped: false });
      break;
    }
    if (beginIdx > pos) {
      const chunk = text.slice(pos, beginIdx);
      segments.push({ text: chunk, startLine: line, enveloped: false });
      line += newlines(chunk);
    }
    const afterBegin = beginIdx + UNTRUSTED_BEGIN.length;
    const endIdx = text.indexOf(UNTRUSTED_END, afterBegin);
    const envEnd = endIdx === -1 ? text.length : endIdx;
    const envChunk = text.slice(afterBegin, envEnd);
    segments.push({ text: envChunk, startLine: line, enveloped: true });
    line += newlines(envChunk);
    if (endIdx === -1) break; // an unterminated envelope runs to the end
    pos = endIdx + UNTRUSTED_END.length;
  }
  return segments;
}

/** A token list with the line each token sits on. */
interface Tokenized {
  /** The tokens (the shared normalisation — identical to the writer's). */
  list: string[];
  /** The 1-based line of each token, relative to the segment. */
  lineOf: number[];
}

/**
 * Tokenise a segment and remember each token's line.
 *
 * The token list is the WRITER's list (`tokens()` on the whole segment), so
 * the hashes match the taint store exactly. The line map is derived from the
 * per-line token counts — exact for every text the normalisation does not
 * change across a line break.
 */
function tokenizeWithLines(text: string): Tokenized {
  const list = tokensOf(text);
  const counts = text.split("\n").map((line) => tokensOf(line).length);
  const lineOf: number[] = [];
  let li = 0;
  let used = 0;
  for (let i = 0; i < list.length; i++) {
    while (li < counts.length - 1 && used >= counts[li]) {
      used = 0;
      li++;
    }
    lineOf.push(li + 1);
    used++;
  }
  return { list, lineOf };
}

/** The shared normalisation — the writer's own tokeniser (one rule, both sides). */
function tokensOf(text: string): string[] {
  return tokens(text);
}

// --- The detection ----------------------------------------------------------

/** A maximal group of consecutive copied lines. */
interface LineGroup {
  /** The 1-based first line. */
  start: number;
  /** The 1-based last line. */
  end: number;
}

/** What one pass over an artifact found. */
interface Detection {
  /** Every copied line (1-based), sorted. */
  copied: number[];
  /** The groups of consecutive copied lines OUTSIDE an envelope. */
  groups: LineGroup[];
}

/** A maximal sequence of consecutive tainted windows. */
interface Run {
  /** The first token of the run. */
  startTok: number;
  /** The last token of the run. */
  endTok: number;
}

/**
 * The maximal runs of consecutive tainted windows in a token list.
 *
 * A window is 8 consecutive tokens (the writer's shingle). A run of
 * `MIN_RUN_WINDOWS` consecutive tainted windows is a copied passage of at
 * least `MIN_RUN_TOKENS` tokens.
 */
function findRuns(list: string[], taint: ReadonlySet<number>): Run[] {
  const runs: Run[] = [];
  const windowCount = list.length - SHINGLE_K + 1;
  if (windowCount <= 0) return runs;
  const hashes: number[] = [];
  for (let i = 0; i < windowCount; i++) hashes.push(shingleHash(list.slice(i, i + SHINGLE_K)));
  let i = 0;
  while (i < windowCount) {
    if (!taint.has(hashes[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < windowCount && taint.has(hashes[j + 1])) j++;
    if (j - i + 1 >= MIN_RUN_WINDOWS) runs.push({ startTok: i, endTok: j + SHINGLE_K - 1 });
    i = j + 1;
  }
  return runs;
}

/** Merge overlapping or touching groups into maximal consecutive groups. */
function mergeGroups(groups: LineGroup[]): LineGroup[] {
  if (groups.length === 0) return [];
  const sorted = [...groups].sort((a, b) => a.start - b.start);
  const out: LineGroup[] = [{ ...sorted[0] }];
  for (const g of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (g.start <= last.end + 1) last.end = Math.max(last.end, g.end);
    else out.push({ ...g });
  }
  return out;
}

/** One pass over an artifact: which lines were copied, and which to wrap. */
function detect(text: string, taint: ReadonlySet<number>): Detection {
  const copied = new Set<number>();
  const raw: LineGroup[] = [];
  for (const seg of splitSegments(text)) {
    const { list, lineOf } = tokenizeWithLines(seg.text);
    for (const run of findRuns(list, taint)) {
      const segLines: number[] = [];
      for (let t = run.startTok; t <= run.endTok; t++) segLines.push(seg.startLine + lineOf[t] - 1);
      const unique = [...new Set(segLines)].sort((a, b) => a - b);
      for (const line of unique) copied.add(line);
      // A run inside an existing envelope is already quarantined: it is
      // reported, never wrapped again.
      if (!seg.enveloped && unique.length > 0) raw.push({ start: unique[0], end: unique[unique.length - 1] });
    }
  }
  return { copied: [...copied].sort((a, b) => a - b), groups: mergeGroups(raw) };
}

// --- The public guard --------------------------------------------------------

/** A quarantined group of lines. */
export interface GuardSpan {
  /** The 1-based first line of the group (in the input text). */
  line: number;
  /** How many lines the group holds. */
  lines: number;
}

/** One copied line. */
export interface GuardHit {
  /** The 1-based line of the copy (in the returned text). */
  line: number;
  /** The line's text, trimmed and capped. */
  excerpt: string;
}

/** The guard's verdict on one artifact. */
export interface GuardResult {
  /** The artifact — rewritten when a copy was quarantined. */
  text: string;
  /** The groups this call wrapped (empty when nothing was new). */
  spans: GuardSpan[];
  /** Every copied line, in the returned text's coordinates. */
  hits: GuardHit[];
}

/** The text of one line, trimmed and capped. */
function excerptAt(lines: string[], line: number): string {
  const raw = lines[line - 1] ?? "";
  return raw.trim().slice(0, MAX_EXCERPT);
}

/**
 * Quarantine every copied run in an artifact.
 *
 * Lossless: the copied lines are wrapped in `UNTRUSTED_BEGIN/END`, never
 * deleted and never reworded. Idempotent: a second pass finds no span,
 * because the copies now sit inside an envelope. The hits are reported in
 * the RETURNED text's coordinates — the park list quotes the rewritten file.
 */
export function guardArtifact(text: string, taint: ReadonlySet<number>): GuardResult {
  const src = text ?? "";
  try {
    if (!taint || taint.size === 0) return { text: src, spans: [], hits: [] };
    const first = detect(src, taint);
    if (first.groups.length === 0) {
      // Nothing new to wrap: the copies are already inside an envelope (or
      // there are none). They are still REPORTED — that is the re-park case.
      const lines = src.split("\n");
      return { text: src, spans: [], hits: first.copied.map((line) => ({ line, excerpt: excerptAt(lines, line) })) };
    }
    const lines = src.split("\n");
    const out: string[] = [];
    let cursor = 0;
    for (const group of first.groups) {
      out.push(...lines.slice(cursor, group.start - 1));
      out.push(UNTRUSTED_BEGIN);
      out.push(escapeMarkers(lines.slice(group.start - 1, group.end).join("\n")));
      out.push(UNTRUSTED_END);
      cursor = group.end;
    }
    out.push(...lines.slice(cursor));
    const rewritten = out.join("\n");
    const second = detect(rewritten, taint);
    const rewrittenLines = rewritten.split("\n");
    return {
      text: rewritten,
      spans: first.groups.map((g) => ({ line: g.start, lines: g.end - g.start + 1 })),
      hits: second.copied.map((line) => ({ line, excerpt: excerptAt(rewrittenLines, line) })),
    };
  } catch {
    // Fail open: a guard error never blocks the run (ADR-28).
    return { text: src, spans: [], hits: [] };
  }
}

// --- The targets -------------------------------------------------------------

/** A candidate artifact and — when it is not guardable — WHY. */
interface TargetCandidate {
  /** The absolute path of the candidate. */
  file: string;
  /**
   * Why the guard skips it; `null` when the file IS guarded.
   *
   * A skip is never silent (ADR-40, §3.8): the runner reports it in the
   * ledger, because an artifact the guard could not scan is a coverage hole
   * only a human can see.
   */
  skip: string | null;
}

/** Classify one candidate artifact: guardable, or skipped for a named reason. */
function classifyTarget(file: string, cwd: string): TargetCandidate {
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // A missing artifact is not a skip worth reporting: the step simply has
    // not written it (the artifact-presence check owns that case).
    return { file, skip: code === "ENOENT" ? "missing" : "unreadable" };
  }
  // lstat does not follow: a symlink is never a regular file here.
  if (!lst.isFile()) return { file, skip: "not a regular file (a symlink or a directory)" };
  if (lst.size > MAX_ARTIFACT_BYTES) return { file, skip: `over the ${MAX_ARTIFACT_BYTES} byte bound` };
  try {
    const rel = path.relative(fs.realpathSync(cwd), fs.realpathSync(file));
    if (rel.startsWith("..") || path.isAbsolute(rel)) return { file, skip: "outside the repo" };
  } catch {
    return { file, skip: "unreadable" };
  }
  return { file, skip: null };
}

/**
 * The files a phase's guard covers: the phase's own artifact paths plus the
 * **`produces` rule** — a root file matches when its name is `stem.md` or
 * `stem_<currentSprintNN>.md` (case-insensitively). A file stamped with
 * another sprint's number is NEVER a target (ADR-49, INV-25).
 */
export function guardTargets(
  phase: Pick<WorkflowPhase, "id" | "produces">,
  cwd: string,
  sprint?: SprintRef,
  planFile?: string,
): string[] {
  return targetCandidates(phase, cwd, sprint, planFile)
    .filter((c) => c.skip === null)
    .map((c) => c.file);
}

/**
 * Every artifact a phase's guard MAY cover, with the reason each one is
 * skipped (or `null` when it is guarded).
 *
 * The runner uses the reasons to report every coverage hole in the ledger;
 * `guardTargets` keeps the plain contract (the files that ARE guarded).
 */
function targetCandidates(
  phase: Pick<WorkflowPhase, "id" | "produces">,
  cwd: string,
  sprint?: SprintRef,
  planFile?: string,
): TargetCandidate[] {
  const out = new Set<string>();
  try {
    for (const p of phaseArtifactPaths(phase.id, cwd, sprint, planFile)) out.add(path.resolve(p));
  } catch {
    /* no declared artifacts */
  }
  const stems = (phase.produces ?? [])
    .map((id) => String(id).trim().replace(/\.md$/i, ""))
    .filter((s) => s.length > 0);
  if (stems.length > 0) {
    const allowed = new Set<string>();
    const stamp = typeof sprint === "number" ? sprintStamp(sprint) : "";
    for (const stem of stems) {
      allowed.add(`${stem}.md`.toLowerCase());
      if (stamp) allowed.add(`${stem}${stamp}.md`.toLowerCase());
    }
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(cwd);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!allowed.has(name.toLowerCase())) continue;
      out.add(path.join(cwd, name));
    }
  }
  return [...out].map((file) => classifyTarget(file, cwd));
}

// --- The delegated trigger ---------------------------------------------------

/**
 * May this delegated child have SEEN a page? (ADR-42, INV-26)
 *
 * The trigger is the child's EFFECTIVE tool exposure, not its metadata: an
 * agent WITHOUT a `tools:` line gets pi's default set, which includes every
 * browser tool — so it counts as browse-capable (7 of the 10 shipped
 * agents, `qa-engineer` among them). An agent that lists its tools may
 * browse only if one of them is a browser tool.
 */
export function childMayBrowse(agent: { tools?: string[] } | null | undefined): boolean {
  const tools = agent?.tools;
  if (!tools) return true;
  return tools.some((name) => BROWSER_TOOLS.has(name));
}

/**
 * The `tools:` line of a shipped agent profile (ADR-42, INV-26).
 *
 * `undefined` means the profile declares NO tools line — pi then hands the
 * child its DEFAULT tool set, which includes every browser tool. An empty
 * array means the profile declares an empty tool set.
 *
 * Never throws: an unreadable or missing profile degrades to `undefined`
 * (the child may browse — the fail-open direction of a trigger, never a
 * silent skip of the guard).
 */
export function agentTools(agent: string): string[] | undefined {
  try {
    const file = path.join(EXTENSION_ROOT, "agents", `${agent}.md`);
    const raw = fs.readFileSync(file, "utf-8");
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!front) return undefined;
    const line = /tools:\s*(.*)$/m.exec(front[1]);
    if (!line) return undefined;
    const tools = line[1]
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    return tools;
  } catch {
    return undefined;
  }
}

/**
 * May THIS delegated child have seen a page? (ADR-42, INV-26)
 *
 * The shipped profile decides it: an agent without a `tools:` line gets pi's
 * default set (which includes every browser tool), an agent that lists its
 * tools may browse only when one of them is a browser tool.
 */
export function agentMayBrowse(agent: string): boolean {
  return childMayBrowse({ tools: agentTools(agent) });
}

/**
 * May the MAIN session browse in this phase? (ADR-40, INV-23)
 *
 * The trigger is the phase's tool profile: a `none` phase has NO browser
 * tool at all, so nothing it writes can be a copy of a page. A `read` or
 * `full` phase can fetch page text, so its artifacts are guarded.
 */
export function mainMayBrowse(workflowId: string, phaseId: string): boolean {
  return profileForPhaseId(workflowId, phaseId) !== "none";
}

/**
 * The identity of one guard run: the phase and the step whose artifacts it
 * covers. It is the tail of the park reason, so the panel and the ledger
 * name the same step.
 */
export function guardStepKey(phaseId: string, stepId: string): string {
  return `${phaseId}:${stepId}`;
}

/**
 * The park reason of a provenance park (ADR-40): the phase and the step.
 * The vocabulary is bound — the panel's prefix list matches on it.
 */
export function provenanceParkReason(phaseId: string, stepId: string): string {
  return `provenance-review:${guardStepKey(phaseId, stepId)}`;
}

/**
 * The park list, one entry per finding: `file:line  <the first 120 chars>`.
 *
 * The list is what the human reads, so it names the artifact and the line in
 * the REWRITTEN file (the coordinates the human sees) and quotes the copied
 * line. At most 10 entries (the guard caps them).
 */
export function formatGuardFindings(findings: GuardFinding[]): string[] {
  return findings.map((f) => `${f.file}:${f.line}  ${f.excerpt}`);
}

// --- The runner ---------------------------------------------------------------

/** One park entry: where the copy is and what it says. */
export interface GuardFinding {
  /** The artifact, repo-relative. */
  file: string;
  /** The 1-based line in the REWRITTEN file. */
  line: number;
  /** The nearest section heading above the line (≤ 80 chars). */
  heading: string;
  /** The copied line (≤ 120 chars). */
  excerpt: string;
}

/** The guard's verdict on a step's artifacts. */
export interface GuardRun {
  /** True when a human must decide (an instruction-shaped copy). */
  escalate: boolean;
  /** The park list — at most 10 entries. */
  findings: GuardFinding[];
  /** True when the taint store was full or tampered (degraded mode). */
  degraded: boolean;
  /** The artifacts that were rewritten. */
  rewritten: string[];
  /** Why an artifact was skipped. */
  skipped: string[];
}

/** What the guard needs to run for one step. */
export interface GuardRunOptions {
  /** The phase whose artifacts are guarded. */
  phase: Pick<WorkflowPhase, "id" | "produces">;
  /** The step that produced the artifacts. */
  stepId: string;
  /** The session cwd — the guard resolves every path from it. */
  cwd: string;
  /** The run id — without it the taint store is disabled (G4). */
  runId?: string;
  /** The run's sprint number — the stamped targets. */
  sprint?: SprintRef;
  /** The plan file (the `plan` phase's artifact). */
  planFile?: string;
  /** The workflow id — the ledger lane. */
  workflowId?: string;
}

/** The nearest Markdown heading above a line (≤ 80 chars), or "". */
function headingAbove(lines: string[], line: number): string {
  for (let i = Math.min(line, lines.length) - 2; i >= 0; i--) {
    const m = /^\s{0,3}#{1,6}\s+(.*)$/.exec(lines[i] ?? "");
    if (m) return m[1].trim().slice(0, MAX_HEADING);
  }
  return "";
}

/** Replace a file atomically: a temp file in the same directory + rename. */
function atomicWrite(file: string, text: string): boolean {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.kstack-guard.tmp`);
  try {
    fs.writeFileSync(tmp, text, "utf-8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file may never have been created */
    }
    return false;
  }
}

/** The guard prunes the backup directory once per process (best effort). */
let backupsPruned = false;

/** Delete backup entries older than 14 days (H5) — the directory stays bounded. */
function pruneGuardBackups(cwd: string, maxAgeDays = 14): void {
  if (backupsPruned) return;
  backupsPruned = true;
  try {
    const dir = path.join(cwd, ".kstack", "guard-backup");
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      try {
        if (fs.statSync(target).mtimeMs < cutoff) fs.rmSync(target, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* best effort */
  }
}

/**
 * Run the guard over a step's artifacts.
 *
 * The order is fixed: read → back up → rewrite atomically → report. A failed
 * backup means the file is NOT rewritten (the user's document is never lost
 * to a half-finished guard). The escalation fires only on an
 * instruction-SHAPED copy — in degraded mode (a full or tampered store) the
 * whole artifact is scanned instead, because there the store cannot be
 * trusted.
 */
export function runProvenanceGuard(opts: GuardRunOptions): GuardRun {
  const run: GuardRun = { escalate: false, findings: [], degraded: false, rewritten: [], skipped: [] };
  try {
    const cwd = opts.cwd;
    const runId = opts.runId;
    // No run id ⇒ no per-run taint store ⇒ the guard is disabled (G4).
    if (!runId) return run;

    // The store: absent, empty, FULL or TAMPERED? (ADR-39)
    let size = 0;
    try {
      size = fs.statSync(taintPathFor(cwd, runId)).size;
    } catch {
      size = 0;
    }
    const own = taintOwnState(runId);
    const tampered = own.bytes > 0 && size < own.bytes;
    const degraded = tampered || own.full;
    // Nothing was recorded ⇒ nothing can have been copied: a no-op at the
    // cost of one stat.
    if (!degraded && size === 0) return run;

    // The taint set: the file (every process's contributions) UNION the
    // hashes THIS process recorded (ADR-39, G1) — the in-memory evidence
    // survives a store the agent truncated.
    const taint = new Set<number>([...loadTaint(cwd, runId), ...own.hashes]);
    pruneGuardBackups(cwd);

    const attackFindings: GuardFinding[] = [];
    const otherFindings: GuardFinding[] = [];
    let copiedLines = 0;
    let attackHits = 0;

    // The candidates: every artifact the phase MAY own, with the reason each
    // one is skipped. A skip is a coverage hole — it is reported, never
    // silent (ADR-40, §3.8).
    const candidates = targetCandidates(opts.phase, cwd, opts.sprint, opts.planFile);
    for (const candidate of candidates) {
      if (!candidate.skip || candidate.skip === "missing") continue;
      const rel = path.relative(cwd, candidate.file).replace(/\\/g, "/");
      run.skipped.push(`${rel}: ${candidate.skip}`);
    }

    for (const file of candidates.filter((c) => c.skip === null).map((c) => c.file)) {
      const rel = path.relative(cwd, file).replace(/\\/g, "/");
      let text: string;
      try {
        text = fs.readFileSync(file, "utf-8");
      } catch {
        run.skipped.push(`${rel}: unreadable`);
        continue;
      }
      const result = guardArtifact(text, taint);
      if (result.spans.length > 0) {
        // 1) The backup: the PRE-guard bytes, kept outside the run directory
        //    (it must outlive the run — it is the user's recovery path).
        const backupRel = path.posix.join(".kstack", "guard-backup", safeSegment(runId), rel);
        let backedUp = fs.existsSync(path.join(cwd, backupRel));
        if (!backedUp) {
          backedUp = safeCopyFile(cwd, rel, backupRel);
          if (!backedUp) {
            run.skipped.push(`${rel}: backup failed — the file was not rewritten`);
            continue;
          }
        }
        // 2) The rewrite: atomic (temp file + rename).
        if (!atomicWrite(file, result.text)) {
          run.skipped.push(`${rel}: rewrite failed`);
          continue;
        }
        run.rewritten.push(rel);
      }
      // 3) The findings: computed from the file as it now stands, so the
      //    quoted line numbers match the rewritten document (F5).
      let onDisk = text;
      try {
        onDisk = fs.readFileSync(file, "utf-8");
      } catch {
        /* keep the text we already have */
      }
      const lines = onDisk.split("\n");
      const hits = guardArtifact(onDisk, taint).hits;
      copiedLines += hits.length;
      // The escalation scan: over the taint-VERIFIED copies only (ADR-44);
      // in degraded mode over the WHOLE artifact — the store cannot be
      // trusted there, and failing toward the human is the point (R7).
      const copiedText = hits.map((h) => lines[h.line - 1] ?? "").join("\n");
      const attack = degraded ? scanInstructions(onDisk) : scanInstructions(copiedText);
      if (attack.length > 0) attackHits += attack.length;
      for (const hit of hits) {
        const finding: GuardFinding = {
          file: rel,
          line: hit.line,
          heading: headingAbove(lines, hit.line),
          excerpt: hit.excerpt,
        };
        if (attack.length > 0) attackFindings.push(finding);
        else otherFindings.push(finding);
      }
      // Degraded mode: the store cannot be trusted, so the scan ran over the
      // WHOLE artifact — the offending line may not be a taint-verified copy
      // at all. Name it anyway: a park list that says "something matched"
      // tells the human nothing (ADR-44, R7).
      if (degraded && attack.length > 0) {
        for (const line of scanInstructionLines(onDisk, MAX_EXCERPT)) {
          if (attackFindings.some((f) => f.file === rel && f.line === line.line)) continue;
          attackFindings.push({
            file: rel,
            line: line.line,
            heading: headingAbove(lines, line.line),
            excerpt: line.excerpt,
          });
        }
      }
    }

    // The park list: the attack-shaped copies first, then the rest, capped.
    run.findings = [...attackFindings, ...otherFindings].slice(0, MAX_FINDINGS);
    run.degraded = degraded;
    run.escalate = attackHits > 0;

    // The report: what the guard did, where the backup is (the list survives
    // a restart through the ledger).
    const backupDir = path.posix.join(".kstack", "guard-backup", safeSegment(runId));
    appendLedger(
      cwd,
      { workflowId: opts.workflowId ?? "sprint", runId },
      {
        kind: "report",
        phaseId: opts.phase.id,
        stepId: opts.stepId,
        payload: {
          summary:
            `provenance guard: ${copiedLines} copied line(s) in ${run.rewritten.length} rewritten file(s)` +
            `${run.rewritten.length > 0 ? ` (${run.rewritten.slice(0, 3).join(", ")})` : ""}` +
            `${degraded ? " (degraded mode: the taint store is full or tampered)" : ""}; backup: ${backupDir}/`,
          artifacts: run.rewritten,
          // Every artifact the guard could not scan: the coverage holes the
          // human must know about.
          skipped: run.skipped,
          // The park list, verbatim: it must survive a restart through the
          // ledger (the panel reads the state, the ledger keeps the trail).
          findings: formatGuardFindings(run.findings),
        },
      },
    );
    return run;
  } catch {
    // Fail open: a guard error never blocks the run (ADR-28).
    return run;
  }
}

/**
 * The parked state of a provenance park (ADR-40, INV-23).
 *
 * The park is NOT a verdict: it burns no attempt, it is not forgeable from
 * a record, and it is released only by the human's decision (Accept /
 * Re-run / Abort). `resumeMode` is set so the panel's Re-run re-issues the
 * step with the guard re-checking the artifact.
 */
export function provenancePark(
  state: WorkflowState,
  phaseId: string,
  stepId: string,
  run: GuardRun,
): WorkflowState {
  return {
    ...state,
    status: "paused",
    pausedReason: provenanceParkReason(phaseId, stepId),
    resumeMode: true,
    provenanceFindings: formatGuardFindings(run.findings),
  };
}
