/**
 * Sprint-number discovery (plan B6 / E5) + archival layout (D7).
 *
 * The current sprint's artifacts live in the PROJECT ROOT while the sprint
 * runs; on GREEN everything archives to `.kstack/sprints/sprint_XX/`. Sprint
 * numbers are discovered by scanning root AND the archive: max+1.
 *
 * HIJACK GUARD: more than one plausible "current" number (multiple distinct
 * user-story_XX.md files in root), or a number present both in root and the
 * archive (un-archived collision / pre-planted file) ⇒ anomaly ⇒ the workflow
 * pauses and asks the human instead of guessing.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export interface SprintDiscovery {
  next: number;
  anomaly: string | null;
}

const USER_STORY_RE = /^user-story_(\d+)\.md$/;

function scanDir(dir: string): Map<number, string[]> {
  const found = new Map<number, string[]>();
  try {
    for (const entry of fs.readdirSync(dir)) {
      const match = USER_STORY_RE.exec(entry);
      if (!match) continue;
      const n = Number(match[1]);
      if (!Number.isInteger(n)) continue;
      const list = found.get(n) ?? [];
      list.push(path.join(dir, entry));
      found.set(n, list);
    }
  } catch {
    /* missing dir — nothing to scan */
  }
  return found;
}

/** All archived sprint dirs under `.kstack/sprints/` (best-effort). */
export function archivedSprintDirs(cwd: string): string[] {
  const root = path.join(cwd, ".kstack", "sprints");
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

/**
 * Compute the next sprint number from root + `.kstack/sprints/*` discovery.
 * Empty project ⇒ 01; gaps are fine ((01,03) ⇒ 04). Anomalies never guess:
 * they pause the workflow with a human-readable reason.
 */
export function computeNextSprintNumber(cwd: string): SprintDiscovery {
  const root = scanDir(cwd);
  const archiveDirs = archivedSprintDirs(cwd);
  const archived = new Map<number, string[]>();
  for (const dir of archiveDirs) {
    for (const [n, files] of scanDir(dir)) {
      const list = archived.get(n) ?? [];
      list.push(...files);
      archived.set(n, list);
    }
  }

  // Anomaly 1: a number present in BOTH root and the archive — either an old
  // sprint was never archived or a file was pre-planted; ambiguous state.
  const collisions = [...root.keys()].filter((n) => archived.has(n));
  if (collisions.length > 0) {
    return {
      next: NaN,
      anomaly: `sprint number ${collisions.map(pad2).join(", ")} exists both in project root and .kstack/sprints/ — archive or remove one copy first`,
    };
  }

  const allNumbers = new Set<number>([...root.keys(), ...archived.keys()]);

  // Anomaly 2: more than one plausible CURRENT sprint in root (>1 distinct
  // un-archived user-story numbers) — cannot tell which one is live.
  if (root.size > 1) {
    return {
      next: NaN,
      anomaly: `project root holds ${root.size} un-archived sprints (${[...root.keys()].map(pad2).join(", ")}) — archive finished sprints to .kstack/sprints/ first`,
    };
  }

  const max = allNumbers.size > 0 ? Math.max(...allNumbers) : 0;
  return { next: max + 1, anomaly: null };
}

/** D7 archival target for a completed sprint. */
export function sprintArchiveDir(cwd: string, sprintNumber: number): string {
  return path.join(cwd, ".kstack", "sprints", `sprint_${pad2(sprintNumber)}`);
}
