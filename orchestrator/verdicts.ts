/**
 * Deterministic verdict parsing for the sprint workflow (plan B4 / D1–D4).
 *
 * SECURITY: everything a subagent emits is UNTRUSTED INPUT — repo content can
 * plant literal verdict strings anywhere in the report. Routing therefore
 * happens ONLY if ALL guards hold (guards mirror skip.ts):
 *  1. the `variable == value` line appears inside the structured `## HANDOFF`
 *     section of the subagent's output;
 *  2. every value is matched against a CLOSED whitelist after case
 *     normalization; hedged or malformed values ("high?", "medium-high",
 *     "approved but...") make the WHOLE parse null — never guessed at;
 *  3. each claimed verdict is confirmed by its on-disk artifact: the artifact
 *     must exist and contain the same `variable == value` line within its
 *     ≤64KB tail (dual channel: HANDOFF + disk must agree);
 *  4. ambiguity ⇒ null ⇒ D4 manual park WITHOUT burning an attempt.
 *
 * The orchestrator NEVER advances on doubt.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ParsedVerdict, VerdictSeverity, WorkflowPhase } from "./types.ts";
import { extractHandoff } from "./handoff.ts";
import {
  qaArtifactPath,
  codeReviewArtifactPath,
  securityReviewArtifactPath,
  dockerBuildReportPath,
  newestArchitectArtifact,
} from "./artifacts.ts";

/** Closed value whitelist (case-normalized to lowercase). Anything else ⇒ null. */
const VALUE_WHITELIST = [
  "approved", "rejected", "green", "red", "orange", "success", "failed",
  // S4 vocabulary (walkthrough/ui/outcome/pipeline gates).
  "verified", "persists", "refuted", "pass", "fail",
] as const;

/** Closed severity whitelist. Hedged values ⇒ null (legacy HANDOFF channel). */
const SEVERITY_WHITELIST = ["critical", "high", "medium", "low"] as const;

/**
 * Variables the parser recognizes anywhere in a HANDOFF. Unknown
 * `x == y`-shaped lines are ignored as prose; KNOWN variables carrying an
 * out-of-whitelist value are treated as tampered/hedged ⇒ whole parse fails.
 */
export const KNOWN_VARIABLES = [
  "status", // qa-engineer qa-artifact_XX.md
  "code-review", // devsecops code-review-artifact.md
  "security-review", // devsecops security-review-artifact.md
  "severity", // required on security rejection
  "docker-build", // devsecops docker-build-report.md
  "docker-security", // devsecops docker-build-report.md
  "software-architect-review", // software-architect-artifact_n.md
  // S4 verdict vars (kstack-report records + HANDOFF migration path).
  "outcome", // investigate.verify: verified|persists|refuted
  "walkthrough", // {be,fe}-walk: pass|fail
  "ui", // ui-check: pass|fail
  "pipeline", // pipeline-review: approved|rejected
] as const;

// Verdict lines: `status == green`. An optional markdown heading prefix is
// tolerated (`## status == green`) — the agent prompts and the artifact
// channel (artifactConfirmsLine below) both already allow it, so requiring a
// bare line in the HANDOFF channel alone split the contract in two.
const VAR_LINE_RE = /^\s*(?:#{1,6}\s+)?([A-Za-z][A-Za-z0-9 _-]*?)\s*==\s*(\S[^\n]*)$/;

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

export interface VerdictParseOutcome {
  parsed: ParsedVerdict | null;
  /** Raw verdict-shaped lines found in the HANDOFF, for the D4 panel display. */
  lines: string[];
}

/**
 * Parse verdict variable/value pairs from the `## HANDOFF` section of a
 * subagent output (containment starts at the LAST `## HANDOFF` marker of the
 * raw output per extractHandoff — for short outputs the whole text is scanned
 * from its first marker — and runs to end-of-text; chain steps are parsed
 * separately then merged — see
 * mergeParseOutcomes). Returns `{parsed: null}` when no valid verdict set can be
 * extracted: missing HANDOFF, no known-variable lines, or any known variable
 * carrying an out-of-whitelist (hedged/malformed) value.
 */
export function parseHandoffVerdicts(output: string): VerdictParseOutcome {
  // Guard 1 (mirrors skip.ts): only text at or after the literal `## HANDOFF`
  // marker is scanned. extractHandoff() returns the WHOLE output for short
  // reports (<6KB), so without this containment check a verdict line planted
  // in a short report's body would parse. Fail closed on missing marker.
  const extracted = extractHandoff(output ?? "").text;
  // LAST marker, matching extractHandoff's own contract: a `## HANDOFF`
  // heading planted earlier in the report body must not become the scan
  // origin for the real handoff's verdict lines.
  const markerIdx = extracted.lastIndexOf("## HANDOFF");
  if (markerIdx < 0 || !extracted.includes("==")) {
    return { parsed: null, lines: [] };
  }
  const handoff = extracted.slice(markerIdx);

  const lines: string[] = [];
  const verdicts: Record<string, string> = {};
  let severity: VerdictSeverity | undefined;

  for (const raw of handoff.split("\n")) {
    const match = VAR_LINE_RE.exec(raw);
    if (!match) continue;
    const variable = match[1].trim().toLowerCase().replace(/\s+/g, "-");
    if (!(KNOWN_VARIABLES as readonly string[]).includes(variable)) continue;

    lines.push(raw.trim());
    const value = match[2].trim().toLowerCase();

    if (variable === "severity") {
      if (!(SEVERITY_WHITELIST as readonly string[]).includes(value)) {
        return { parsed: null, lines }; // hedged/malformed severity ⇒ D4 panel (D3)
      }
      // BUG-4: a second, DIFFERENT severity line is self-contradiction ⇒ null.
      if (severity !== undefined && severity !== value) {
        return { parsed: null, lines };
      }
      severity = value as VerdictSeverity;
      continue;
    }

    if (!(VALUE_WHITELIST as readonly string[]).includes(value)) {
      return { parsed: null, lines }; // fail-closed on any malformed known verdict
    }
    // BUG-4: contradictory duplicate of a variable we already captured ⇒ null
    // (identical repeats are redundant, not conflicting — keep first).
    if (verdicts[variable] !== undefined && verdicts[variable] !== value) {
      return { parsed: null, lines };
    }
    verdicts[variable] = value;
  }

  if (Object.keys(verdicts).length === 0) {
    return { parsed: null, lines };
  }
  // D3 fail-closed: a security rejection WITHOUT a parsable severity must
  // never auto-route — it could be a critical hole looping silently. Missing
  // or hedged severity ⇒ whole parse null ⇒ D4 manual panel.
  if (verdicts["security-review"] === "rejected" && !severity) {
    return { parsed: null, lines };
  }
  return { parsed: { verdicts, severity }, lines };
}

/**
 * Merge per-step parse outcomes across a chain (review fix W1): parsing the
 * JOINED outputs would keep only the LAST ## HANDOFF once the total exceeds
 * extractHandoff's whole-output threshold — silently dropping earlier chain
 * steps' verdicts and parking every realistic gate run. Each step parses
 * independently; merged maps conflict on any variable/severity disagreement
 * ⇒ null (preserves BUG-4 contradiction semantics).
 */
export function mergeParseOutcomes(outcomes: VerdictParseOutcome[]): VerdictParseOutcome {
  const lines = outcomes.flatMap((o) => o.lines);
  const parsedResults = outcomes.map((o) => o.parsed);
  if (parsedResults.every((p) => p === null)) {
    return { parsed: null, lines };
  }
  // Any step failing to produce a trustworthy verdict ⇒ null overall:
  // a gate needs EVERY chain step's verdict to route deterministically.
  if (parsedResults.some((p) => p === null)) {
    return { parsed: null, lines };
  }
  const verdicts: Record<string, string> = {};
  let severity: VerdictSeverity | undefined;
  for (const p of parsedResults as NonNullable<(typeof parsedResults)[number]>[]) {
    for (const [variable, value] of Object.entries(p.verdicts)) {
      if (verdicts[variable] !== undefined && verdicts[variable] !== value) {
        return { parsed: null, lines }; // cross-step contradiction
      }
      verdicts[variable] = value;
    }
    if (p.severity !== undefined) {
      if (severity !== undefined && severity !== p.severity) {
        return { parsed: null, lines };
      }
      severity = p.severity;
    }
  }
  if (Object.keys(verdicts).length === 0) return { parsed: null, lines };
  if (verdicts["security-review"] === "rejected" && !severity) return { parsed: null, lines };
  return { parsed: { verdicts, severity }, lines };
}

// --- Dual-channel artifact cross-check --------------------------------------

/** Artifact tail window for STATUS-line confirmation (plan E2). */
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
 * Resolve the on-disk artifacts expected to carry each verdict variable,
 * relative to cwd. Gate artifacts are SPRINT-STAMPED (BUG-2 fix): a stale
 * report from a prior sprint can no longer satisfy this sprint's disk channel.
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
    // B5: the severity rides the security-review artifact — freeze/loop-back
    // routing must be disk-confirmable against the same file.
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

/**
 * Confirm one `variable == value` line against the variable's on-disk
 * artifact(s) within the ≤64KB tail (line-anchored — see B5/BUG-3 notes).
 */
function artifactConfirmsLine(variable: string, value: string, cwd: string, sprintNumber?: number): boolean {
  const escapedVar = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedVal = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const needle = new RegExp(`^\\s*(?:#+\\s*)?${escapedVar}\\s*==\\s*${escapedVal}\\s*$`, "im");
  const candidates = artifactForVariable(variable, cwd, sprintNumber);
  return candidates.some((artifactPath) => {
    const tail = readTail(artifactPath)?.toLowerCase();
    return tail ? needle.test(tail) : false;
  });
}

/**
 * Verify EVERY parsed verdict against its on-disk artifact (guard 3): the
 * artifact must exist AND contain the same `variable == value` verdict on its
 * OWN line within the ≤64KB tail (BUG-3 fix: line-anchored match — template
 * prose like `code-review == approved|rejected` can no longer confirm a
 * verdict). Any disagreement/absence ⇒ false (fail-closed).
 *
 * B5 fix: on a security rejection the severity is disk-verified too. It is
 * not part of `parsed.verdicts`, yet it alone decides freeze-vs-loop-back
 * (D3) — leaving it HANDOFF-only would let a planted/paraphrased HANDOFF
 * downgrade a critical rejection to low and silently bypass the security
 * freeze.
 */
export function verifyArtifactVerdicts(parsed: ParsedVerdict, cwd: string, sprintNumber?: number): boolean {
  for (const [variable, value] of Object.entries(parsed.verdicts)) {
    if (!artifactConfirmsLine(variable, value, cwd, sprintNumber)) return false;
  }
  // Severity is disk-verified only on a security REJECTION (the only routing
  // that consumes it — freeze vs loop-back). A stray severity line beside an
  // approved review is noise, not a channel to confirm.
  if (
    parsed.severity !== undefined &&
    parsed.verdicts["security-review"] === "rejected" &&
    !artifactConfirmsLine("severity", parsed.severity, cwd, sprintNumber)
  ) {
    return false;
  }
  return true;
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
