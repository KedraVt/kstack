/**
 * Single source of truth for SPRINT-STAMPED verdict-artifact filenames
 * (B3-class stamping-drift fix). Three consumers must agree byte-for-byte on
 * these names:
 *  - templates.ts task prose tells subagents WHICH file to write;
 *  - verdicts.ts scans disk for exactly that file (dual-channel check);
 *  - state.ts names the artifact in security-freeze metadata.
 * When the names were inlined separately, an unstamped-name scan silently
 * emptied every RETRY CONTEXT (B3) — every stamped name now derives here.
 *
 * Stamp semantics — ALL preserved from the pre-consolidation call sites:
 *  - number    → `_NN` zero-padded — a real on-disk artifact;
 *  - undefined → "" — the UNSTAMPED fallback name disk scans use when the
 *    sprint number is unknown;
 *  - string    → `_<token>` verbatim — template/display placeholders
 *    (SPRINT_PLACEHOLDER → `_XX`, "{sprint}" → `_{sprint}`) that later
 *    interpolation fills in.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pad2 } from "./sprint.ts";

/**
 * Sprint reference accepted by the builders below: a real sprint number, a
 * literal placeholder token (SPRINT_PLACEHOLDER / "{sprint}"), or undefined
 * for the unstamped fallback name.
 */
export type SprintRef = number | string | undefined;

/** Placeholder token for template prose and display paths: renders as `_XX`. */
export const SPRINT_PLACEHOLDER = "XX";

/**
 * Filename stamp for a sprint reference: `_NN` for a number, "" for
 * undefined (unstamped fallback), `_<token>` verbatim for a string.
 */
export function sprintStamp(sprint?: SprintRef): string {
  if (sprint === undefined) return "";
  return `_${typeof sprint === "number" ? pad2(sprint) : sprint}`;
}

// --- QA verdict artifact (project root) --------------------------------------

/** QA verdict artifact filename: `qa-artifact_NN.md`. */
export function qaArtifactName(sprint: SprintRef): string {
  return `qa-artifact${sprintStamp(sprint)}.md`;
}

/** Absolute path of the QA artifact under the project root `cwd`. */
export function qaArtifactPath(cwd: string, sprint: SprintRef): string {
  return path.join(cwd, qaArtifactName(sprint));
}

// --- Devsecops gate artifacts (`<cwd>/devsecops/`) ----------------------------

/** Devsecops code-review artifact filename: `code-review-artifact_NN.md`. */
export function codeReviewArtifactName(sprint: SprintRef): string {
  return `code-review-artifact${sprintStamp(sprint)}.md`;
}

/** Devsecops security-review artifact filename (also carries `severity`). */
export function securityReviewArtifactName(sprint: SprintRef): string {
  return `security-review-artifact${sprintStamp(sprint)}.md`;
}

/** Devsecops docker-build report filename: `docker-build-report_NN.md`. */
export function dockerBuildReportName(sprint: SprintRef): string {
  return `docker-build-report${sprintStamp(sprint)}.md`;
}

/** Absolute path of the code-review artifact under `<cwd>/devsecops/`. */
export function codeReviewArtifactPath(cwd: string, sprint: SprintRef): string {
  return path.join(cwd, "devsecops", codeReviewArtifactName(sprint));
}

/** Absolute path of the security-review artifact under `<cwd>/devsecops/`. */
export function securityReviewArtifactPath(cwd: string, sprint: SprintRef): string {
  return path.join(cwd, "devsecops", securityReviewArtifactName(sprint));
}

/** Absolute path of the docker-build report under `<cwd>/devsecops/`. */
export function dockerBuildReportPath(cwd: string, sprint: SprintRef): string {
  return path.join(cwd, "devsecops", dockerBuildReportName(sprint));
}

/**
 * Forward-slash RELATIVE path for freeze metadata / display strings:
 * `devsecops/security-review-artifact_NN.md`. Display only — fs callers use
 * securityReviewArtifactPath for platform-correct separators.
 */
export function securityReviewArtifactRel(sprint: SprintRef): string {
  return `devsecops/${securityReviewArtifactName(sprint)}`;
}

// --- Software-architect verdict artifact (project root, sequenced) ------------

const ARCHITECT_BASE = "software-architect-artifact";

/**
 * Software-architect verdict artifact filename:
 * `software-architect-artifact_NN_<seq>.md` where `<seq>` is the review's own
 * sequence number — a string token like "N" in template prose.
 */
export function softwareArchitectArtifactName(sprint: SprintRef, seq: number | string): string {
  return `${ARCHITECT_BASE}${sprintStamp(sprint)}_${seq}.md`;
}

/**
 * Basename regexp for one sprint's architect artifacts; with no known sprint
 * the unstamped `software-architect-artifact_<seq>.md` fallback is matched.
 */
function architectFileRe(sprintNumber?: number): RegExp {
  return sprintNumber !== undefined
    ? new RegExp(`^${ARCHITECT_BASE}_${pad2(sprintNumber)}_(\\d+)\\.md$`)
    : new RegExp(`^${ARCHITECT_BASE}_(\\d+)\\.md$`);
}

/**
 * Absolute path of the NEWEST software-architect artifact for a sprint —
 * numeric tail sort, `_03_10` is newer than `_03_2` — or null when none
 * exists / the directory is unreadable.
 */
export function newestArchitectArtifact(cwd: string, sprintNumber?: number): string | null {
  try {
    const files = fs
      .readdirSync(cwd)
      .filter((f) => architectFileRe(sprintNumber).test(f))
      .sort((a, b) => {
        // numeric tail sort: _03_10 is newer than _03_2
        const na = Number(/_(\d+)\.md$/.exec(a)?.[1] ?? 0);
        const nb = Number(/_(\d+)\.md$/.exec(b)?.[1] ?? 0);
        return na - nb;
      });
    return files.length > 0 ? path.join(cwd, files[files.length - 1]) : null;
  } catch {
    return null;
  }
}
