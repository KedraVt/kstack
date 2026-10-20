/**
 * Reviewer remediation options for the D3 security freeze panel.
 *
 * A critical/high security rejection FREEZES the sprint: the finding can
 * never be accepted, the human must choose a remediation strategy and the
 * implementer applies it. The devsecops reviewer writes its strategies into
 * the security artifact under `### Remediation options` (a numbered list);
 * the freeze panel reads them and offers them as `Fix 1: …`, `Fix 2: …`.
 *
 * The artifact is UNTRUSTED input (a subagent wrote it) — the parse is
 * tolerant but bounded: only numbered lines under the heading count, every
 * option is trimmed, and the SELECT LABEL is capped (the FULL text still
 * travels to the implementer as the retry context).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Cap for the option label shown in the select UI. */
export const REMEDIATION_LABEL_CAP = 200;

/**
 * The single choice offered when the security artifact is missing or carries
 * no `### Remediation options` section: apply everything the report says.
 */
export const FALLBACK_FIX_CHOICE = "Apply the reviewer's fixes (from the report)";

/** The heading the reviewer writes the options under (any level, any case). */
const OPTIONS_HEADING = /^#{1,6}\s*remediation options\b/i;

/** Any markdown heading — it ends the options section. */
const HEADING = /^#{1,6}\s/;

/** A numbered list item: `1. text` or `1) text`. */
const NUMBERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;

/**
 * Extract the numbered remediation options of a security artifact.
 * Returns [] when the artifact has no options section (the panel falls
 * back to a single "apply the reviewer's fixes" choice).
 */
export function parseRemediationOptions(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => OPTIONS_HEADING.test(l.trim()));
  if (start < 0) return [];
  const options: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line.trim())) break; // the next heading ends the section
    const item = NUMBERED_ITEM.exec(line);
    if (!item) continue;
    const text = item[1].trim();
    if (text) options.push(text);
  }
  return options;
}

/** Select-UI label for an option: the full text, capped for readability. */
export function remediationLabel(text: string): string {
  return text.length > REMEDIATION_LABEL_CAP ? `${text.slice(0, REMEDIATION_LABEL_CAP - 1)}…` : text;
}

/**
 * Read the remediation options of a security artifact. `artifactRel` is the
 * repo-relative path the freeze metadata carries
 * (`devsecops/security-review-artifact_NN.md`); a missing or unreadable
 * artifact yields no options (the panel falls back).
 */
export function readRemediationOptions(artifactRel: string, cwd: string): string[] {
  try {
    const abs = path.isAbsolute(artifactRel) ? artifactRel : path.join(cwd, artifactRel);
    if (!fs.existsSync(abs)) return [];
    return parseRemediationOptions(fs.readFileSync(abs, "utf-8"));
  } catch {
    return [];
  }
}
