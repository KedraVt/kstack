/**
 * Verdict routing tables and loop-back feedback for the step model (S4).
 *
 * A phase verdict is produced ONLY by the step records (ADR-1 / INV-9:
 * `runtime/bin/kstack-report` writes `.kstack/runs/<runId>/<phase>.<step>.json`,
 * `records.ts` merges them). The legacy `## HANDOFF` text channel was retired
 * with the migration — nothing here reads a subagent's report text any more,
 * so a planted verdict string in a report can no longer route.
 *
 * This module owns:
 *  - the CLOSED expectation map (ADR-7): every verdict variable a phase may
 *    emit must land on an expected POSITIVE value or a routing NEGATIVE —
 *    anything else parks for a human (fail-closed, never a silent advance);
 *  - the routing NEGATIVE vocabulary;
 *  - the verdict-bearing test (a phase routes only if it declares a gate);
 *  - the disk feedback extraction that fuels a loop-back.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ParsedVerdict, WorkflowPhase } from "./types.ts";
import {
  qaArtifactPath,
  codeReviewArtifactPath,
  securityReviewArtifactPath,
  dockerBuildReportPath,
  newestArchitectArtifact,
} from "./artifacts.ts";

/** Values that mean "the gated work did not pass" — routing negatives. */
export const NEGATIVE_VALUES = new Set(["rejected", "failed", "red", "orange", "persists", "refuted", "fail"]);

/**
 * Per-(workflow, phase) expectation maps (ADR-7): every known verdict variable
 * must land on an explicitly expected POSITIVE value or a routing NEGATIVE.
 * Whitelisted-but-off-map values park for human decision instead of silently
 * advancing. Keyed `workflowId → phaseId → var → allowed[]` so phase ids
 * shared across workflows (`verify`, `fix`, `review`, `qa-browsing`,
 * `implement`) can never collide.
 *
 * A `?`-suffixed var name marks it OPTIONAL — a legitimately-skipped step
 * (e.g. ui-check under scope:backend) emits nothing and must not park the
 * gate; an emitted optional var is still validated like any other.
 */
export const EXPECTATIONS: Record<string, Record<string, Record<string, readonly string[]>>> = {
  sprint: {
    "architect-gate": { "software-architect-review": ["approved"] },
    "qa-browsing": { status: ["green"] },
    "devsecops-review": {
      "code-review": ["approved"],
      "security-review": ["approved"],
      // severity is an ORDINARY verdict var in S4 — parkOn declares the
      // freeze outcome ({red|critical|high: "freeze"}); the values below
      // are the non-freezing outcomes. Legacy 4-word vocabulary still
      // validates so pre-migration records route the same.
      "severity?": ["green", "orange", "low", "medium"],
    },
    "docker-review": { "docker-build": ["success"], "docker-security?": ["approved"] },
    "pipeline-review": { pipeline: ["approved"] },
    // Per-lane walker vars (S4): two walkers sharing one `walkthrough` var
    // would contradiction-park on every be-fail/fe-pass. All `?` because
    // scope:backend|frontend skips whole lanes. No shared `walkthrough` key:
    // each walker owns ONLY its lane var (records.verdictKeysFor), named
    // explicitly in its record contract.
    "implement": { "be-walk?": ["pass"], "fe-walk?": ["pass"], "ui?": ["pass"] },
  },
  develop: {
    "implement": { walkthrough: ["pass"], "ui?": ["pass"] },
    "qa-browsing": { status: ["green"] },
    "review": { "code-review": ["approved"] },
  },
  investigate: {
    "verify": { outcome: ["verified"] },
    "regression-qa": { status: ["green"] },
  },
  review: {
    "findings": { "code-review": ["approved"] },
    "qa-browsing": { status: ["green"] },
  },
};

/**
 * Expectation map for one (workflowId, phaseId) — undefined when the pair is
 * not a verdict gate (fail-closed callers park on undefined, never default).
 */
export function expectationsFor(
  workflowId: string,
  phaseId: string,
): Record<string, readonly string[]> | undefined {
  return EXPECTATIONS[workflowId]?.[phaseId];
}

/** True when a phase emits gate variables: has ≥1 verdict-flagged step, or
 * carries a routing edge (loopBackTo / loopBackOn). Publish-only phases
 * (flagged step, no edges) count — they still parse and validate. */
export function isVerdictBearing(phase: Pick<WorkflowPhase, "loopBackTo" | "loopBackOn" | "steps"> | undefined): boolean {
  if (!phase) return false;
  if (phase.loopBackTo || (phase.loopBackOn && Object.keys(phase.loopBackOn).length > 0)) return true;
  return !!phase.steps?.some((s) => s.signal?.kind === "verdict");
}

// --- Artifact resolution + loop-back feedback ---------------------------------

/** Artifact tail window for the disk feedback reader (plan E2). */
export const ARTIFACT_TAIL_BYTES = 64 * 1024;

function readTail(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, ARTIFACT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, stat.size - length);
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Resolve the on-disk artifacts that carry a verdict variable's report,
 * relative to cwd. Gate artifacts are SPRINT-STAMPED (BUG-2 fix): a stale
 * report from a prior sprint can no longer feed this sprint's loop-back.
 * QA status rides the sprint-numbered artifact; architect review rides the
 * NEWEST sprint-stamped software-architect-artifact. All names come from
 * artifacts.ts — the single source shared with the task templates that tell
 * subagents which files to write (B3-class drift guard).
 */
export function artifactForVariable(variable: string, cwd: string, sprintNumber?: number): string[] {
  switch (variable) {
    case "status":
      return sprintNumber !== undefined ? [qaArtifactPath(cwd, sprintNumber)] : [];
    case "code-review":
      return [codeReviewArtifactPath(cwd, sprintNumber)];
    case "security-review":
    // The severity rides the security-review artifact — the rejection's
    // blockers are read from the same file.
    case "severity":
      return [securityReviewArtifactPath(cwd, sprintNumber)];
    case "docker-build":
    case "docker-security":
      return [dockerBuildReportPath(cwd, sprintNumber)];
    case "software-architect-review": {
      const newest = newestArchitectArtifact(cwd, sprintNumber);
      return newest ? [newest] : [];
    }
    default:
      return [];
  }
}

// --- Feedback extraction (loop engine fuel) ---------------------------------

const FEEDBACK_CAP = 2000;

function section(content: string, headingRe: RegExp): string | null {
  const match = headingRe.exec(content);
  if (!match) return null;
  const rest = content.slice(match.index + match[0].length);
  const end = rest.search(/^##\s/m);
  const body = (end >= 0 ? rest.slice(0, end) : rest).trim();
  return body.length > 0 ? body : null;
}

/**
 * Extract retry feedback from a review/QA artifact:
 *  - RED → failure-report sections (repro steps + evidence),
 *  - ORANGE → Testability Blockers (missing selectors),
 *  - reviews → finding/problem list lines.
 * Capped at FEEDBACK_CAP chars; empty when nothing structured is present.
 */
export function extractBlockers(artifactContent: string, kind: "qa-red" | "qa-orange" | "review"): string {
  if (!artifactContent) return "";
  const parts: string[] = [];

  if (kind === "qa-orange") {
    const blockers = section(artifactContent, /###?\s*.*Testability Blockers.*$/im);
    if (blockers) parts.push(blockers);
  } else if (kind === "qa-red") {
    const failures = section(artifactContent, /###?\s*.*(Failure|Bug).*$/gim);
    if (failures) parts.push(failures);
    const rationale = section(artifactContent, /###?\s*Final Status Rationale\s*$/im);
    if (rationale) parts.push(rationale);
  } else {
    // Review rejects: take bullet/finding lines mentioning problems.
    const findings = artifactContent.split("\n").filter((l) => {
      const t = l.trim();
      if (!/^[-*]\s/.test(t) && !/^#{2,3}\s/.test(t)) return false;
      return /(critical|warning|risk|issue|finding|vulnerab|inconsisten|violat|missing|must fix)/i.test(t);
    });
    if (findings.length > 0) parts.push(findings.join("\n"));
  }

  const joined = parts.join("\n\n");
  return joined.length > FEEDBACK_CAP ? `${joined.slice(0, FEEDBACK_CAP)}…(truncated)` : joined;
}

/**
 * Build the RETRY CONTEXT feedback payload for a loop-back: reads the source
 * phase's artifact(s) from disk and extracts its blockers. Best-effort by
 * design — an unreadable artifact degrades to an empty payload, never throws.
 */
export function buildRetryFeedback(
  parsed: ParsedVerdict,
  sourcePhaseId: string,
  cwd: string,
  sprintNumber?: number,
): string {
  if (sourcePhaseId === "qa-verdict") {
    const value = parsed.verdicts["status"] ?? "";
    const kind = value === "orange" ? "qa-orange" : "qa-red";
    const artifactPath = artifactForVariable("status", cwd, sprintNumber)[0];
    const content = artifactPath ? (readTail(artifactPath) ?? "") : "";
    return extractBlockers(content, kind);
  }
  // Review phases: concatenate whatever review artifacts exist.
  // B3 fix: pass sprintNumber — gate artifacts are SPRINT-STAMPED
  // (code-review-artifact_XX.md); scanning the unstamped names found nothing
  // and silently emptied the RETRY CONTEXT of every review loop-back.
  const parts: string[] = [];
  for (const variable of ["code-review", "security-review", "software-architect-review"]) {
    for (const p of artifactForVariable(variable, cwd, sprintNumber)) {
      const content = readTail(p);
      if (content) {
        const blockers = extractBlockers(content, "review");
        if (blockers) parts.push(`From ${path.basename(p)}:\n${blockers}`);
      }
    }
  }
  return parts.join("\n\n").slice(0, FEEDBACK_CAP);
}
