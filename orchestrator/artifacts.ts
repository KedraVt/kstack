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
import { pad2, sprintArchiveDir } from "./sprint.ts";

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
 * Durable on-disk outputs a subagent phase leaves behind — used by the
 * kstack_phase tool to point at the record when the delegation results
 * (delivered via followUp message) are no longer in context.
 */
export function phaseArtifactPaths(phaseId: string, cwd: string, sprint?: SprintRef, planFile?: string): string[] {
  switch (phaseId) {
    case "architect-gate": {
      const newest = newestArchitectArtifact(cwd, typeof sprint === "number" ? sprint : undefined);
      return newest ? [newest] : [];
    }
    case "devsecops-review":
      return [codeReviewArtifactPath(cwd, sprint), securityReviewArtifactPath(cwd, sprint)];
    case "qa-browsing":
      return sprint !== undefined ? [qaArtifactPath(cwd, sprint)] : [];
    case "archive":
      return typeof sprint === "number" ? [sprintArchiveDir(cwd, sprint)] : [];
    case "plan":
      // S3 resume-gate: the plan FILE is the phase's artifact — the caller
      // resolves it (state.planFile captured from the PLAN FILE marker, else
      // the legacy goal slug) so the last step's re-delivery verifies the
      // file the draft actually wrote.
      return planFile ? [path.join(cwd, planFile)] : [];
    default:
      return [];
  }
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

// --- Ephemeral artifacts (§10.5 / TASK_07) -----------------------------------
//
// THINK docs consumed within the run — FLAT names (no _XX; only durables
// carry the archive slot). Registered on state at creation, deleted at run
// terminal status. Cross-run handoff artifacts under `.kstack/<wf>/` are
// NEVER listed here (independent lifetime, outside the project root).

export const EPHEMERAL_ARTIFACTS: Record<string, string[]> = {
  develop: ["understand.md", "plan.md"],
  sprint: ["understand.md", "user-story.md", "capability.md", "tasks.md", "summary_BE.md", "summary_FE.md"],
  investigate: ["bug-report.md"],
};

/**
 * Sprint gate reports (QA, devsecops reviews, docker report) are problems the
 * sprint resolves through its loops — ephemeral, not durables. Their names
 * carry the sprint number, so they are registered once it is assigned.
 */
export function sprintGateEphemerals(sprint: number): string[] {
  return [
    qaArtifactName(sprint),
    `devsecops/${codeReviewArtifactName(sprint)}`,
    securityReviewArtifactRel(sprint),
    `devsecops/${dockerBuildReportName(sprint)}`,
    // Sequenced per review round — the `*` expands at cleanup time.
    softwareArchitectArtifactName(sprint, "*"),
  ];
}

/** Ephemeral set for a workflow id — a fresh copy (state stamps it verbatim). */
export function ephemeralArtifactsFor(workflowId: string): string[] {
  return [...(EPHEMERAL_ARTIFACTS[workflowId] ?? [])];
}

/**
 * Delete the registered ephemeral paths at run terminal status. Paths are
 * repo-relative only — absolute/`..` segments are skipped with a warning
 * (untrusted state may have smuggled them in). A single failure never aborts
 * the cleanup and never throws — the caller ledger-notes via onWarn.
 * Returns the deleted + failed lists for the ledger event.
 */
export function cleanupEphemeralArtifacts(
  cwd: string,
  paths: string[],
  onWarn?: (message: string) => void,
): { deleted: string[]; failed: string[] } {
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const p of paths) {
    try {
      const rel = path.normalize(p);
      if (typeof p !== "string" || path.isAbsolute(rel) || rel.startsWith("..") || rel === ".") {
        failed.push(p);
        onWarn?.(`kstack: refusing to delete non-repo-relative ephemeral path "${p}"`);
        continue;
      }
      const base = path.basename(rel);
      if (base.includes("*")) {
        // Basename-only wildcard (sequenced artifacts); never crosses directories.
        const dir = path.dirname(rel);
        const re = new RegExp(`^${base.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
        const absDir = path.join(cwd, dir);
        const matches = fs.existsSync(absDir) ? fs.readdirSync(absDir).filter((f) => re.test(f)) : [];
        for (const f of matches) {
          fs.unlinkSync(path.join(absDir, f));
          deleted.push(path.join(dir, f));
        }
        continue;
      }
      const abs = path.join(cwd, rel);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
      deleted.push(rel);
    } catch (err) {
      failed.push(p);
      onWarn?.(`kstack: ephemeral cleanup failed for "${p}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { deleted, failed };
}
