/**
 * Structural skip: root-cause marker parsing with anti-spoofing guards
 * (efficiency plan STEP 4 / COR-01, COR-02).
 *
 * SECURITY: everything in a subagent summary is UNTRUSTED INPUT — repo content
 * can plant the literal marker string anywhere. A collapse therefore triggers
 * ONLY if ALL guards hold:
 *  1. when a `## HANDOFF` marker is present, the root-cause marker must
 *     appear at or after its LAST occurrence (a planted earlier heading must
 *     not redefine the section). Summaries without any HANDOFF marker — e.g.
 *     a MAIN phase's summary, whose contract has no HANDOFF section — are
 *     scanned whole; guard 2 and the never-skipped validation step carry the
 *     anti-spoofing weight there;
 *  2. EVERY cited file exists on disk relative to cwd;
 *  3. the validate-only step itself is NEVER skipped nor compressed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface RootCauseMarker {
  cause: string;
  files: string[];
}

const MARKER_RE = /^CONFIRMED ROOT CAUSE:\s*(.+?)\s*\|\s*files:\s*(.+)$/im;

/**
 * Parse the `CONFIRMED ROOT CAUSE: <cause> | files: <f1, f2>` marker from an
 * extractHandoff payload. Returns null when absent, malformed, or when any
 * anti-spoofing guard fails ("none" counts as absent).
 */
export function parseRootCauseMarker(
  handoffText: string,
  cwd: string,
  warn?: (message: string) => void,
): RootCauseMarker | null {
  const match = MARKER_RE.exec(handoffText ?? "");
  if (!match) return null;

  // Guard 1: when a ## HANDOFF marker exists, the root-cause marker must sit
  // at or after its LAST occurrence — an earlier planted heading cannot
  // smuggle a marker into the section's position. With NO marker at all the
  // text is scanned whole: main-phase summaries (the channel this parser
  // actually reads) never contain a HANDOFF section, and requiring one made
  // the collapse unreachable in production.
  const handoffStart = handoffText.lastIndexOf("## HANDOFF");
  if (handoffStart >= 0 && match.index! < handoffStart) {
    warn?.("[skip] root-cause marker outside HANDOFF ignored");
    return null;
  }

  const cause = match[1].trim();
  const files = match[2]
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

  if (!cause || cause.toLowerCase() === "none" || files.length === 0 || files.some((f) => f.toLowerCase() === "none")) {
    return null;
  }

  // Guard 2: every cited file must exist on disk relative to cwd.
  for (const file of files) {
    try {
      if (!fs.existsSync(path.resolve(cwd, file))) return null;
    } catch {
      return null;
    }
  }

  return { cause, files };
}

/**
 * The validate-only task for a collapsed root-cause chain. This step is the
 * anti-spoofing barrier: it is NEVER skippable nor compressible, and the
 * workflow never collapses directly to fix.
 */
export function validateStrategyTask(marker: RootCauseMarker): string {
  const files = marker.files.join(", ");
  return `## DELIVERABLE
Validated fix strategy.
The prior specialist CONFIRMED this cause: "${marker.cause}" (files: ${files}).
1. Quickly verify it against the code (≤5 targeted reads of the cited files).
2. If confirmed: produce "VALIDATED: <mechanism @ file:line>" + full fix strategy.
3. If refuted: produce "REFUTED: <reason>" as the FIRST line of your output.

## STOP CONDITION
Stop when: cause validated or refuted.`;
}

/** True when a text's first meaningful line starts with VALIDATED:. */
export function isValidatedStrategy(text: string): boolean {
  return leadingKeyword(text, "VALIDATED:");
}

/** True when the text's first meaningful line starts with REFUTED:. */
export function isRefutedStrategy(text: string): boolean {
  return leadingKeyword(text, "REFUTED:");
}

function leadingKeyword(text: string, keyword: string): boolean {
  // Tolerate markdown decoration around the tag: models emit "**REFUTED:**",
  // "REFUTED :", or lowercase "refuted:" often enough that a strict
  // startsWith on the raw line let real refusals slide past the reopen check.
  const first = (text.split("\n").find((line) => line.trim().length > 0) ?? "")
    .trim()
    .replace(/^[\s#>*_`-]+/, "");
  const normalized = first.toUpperCase().replace(/\s+:/g, ":");
  return normalized.startsWith(keyword.toUpperCase());
}

/**
 * Falsifiable "all tests passed" detection for the QA fix-loop skip
 * (STEP 4d). Malformed or ambiguous summaries → false (never skip on doubt).
 */
export function allTestsPassed(summary: string | undefined | null): boolean {
  if (!summary) return false;
  const s = summary.toLowerCase();
  // Negation guard: "not all tests passed" / "all tests didn't pass" must
  // never read as a pass. Reject when a negator sits in the ~60 chars before
  // the pass-shaped match.
  const passMatch = /\ball (tests |checks )?(pass|passed|green)\b/.exec(s);
  if (passMatch && /\b(?:not|n't|never|without|barely)\b[^.;]{0,40}$/i.test(s.slice(0, passMatch.index))) {
    return false;
  }
  return (
    /\b0 failures?\b/.test(s) ||
    /\bno failures\b/.test(s) ||
    passMatch !== null
  );
}
