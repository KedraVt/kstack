/**
 * HANDOFF extraction (efficiency plan STEP 2b / COR-09).
 *
 * Chain steps pass context via `{previous}`. Injecting the ENTIRE upstream
 * report inflates every downstream turn's prefill and invites re-verification
 * of already-settled facts. Instead, the structured `## HANDOFF` section of
 * the REPORT is preferred; degraded levels are explicit so the receiver (and
 * the delegation summary) know how trustworthy the payload is.
 *
 * IMPORTANT: extraction runs on the RAW output, BEFORE any display cap —
 * the HANDOFF trails the report and would be lost after a head-truncation.
 */

export type HandoffLevel = "full" | "partial" | "raw" | "fallback";

export interface Handoff {
  text: string;
  level: HandoffLevel;
}

const RAW_WHOLE_LIMIT = 6000;
const FULL_HANDOFF_LIMIT = 4000;
const FALLBACK_TAIL = 12000;

/**
 * Tail cut at a paragraph boundary: keep the LAST `limit` characters, then
 * advance past the first line break so the result does not start mid-line.
 * With no break in the tail, the raw tail is returned.
 */
function cutAtParagraph(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const tail = text.slice(-limit);
  const firstBreak = tail.indexOf("\n");
  if (firstBreak < 0) return tail;
  return tail.slice(firstBreak + 1);
}

/**
 * Extract the best available handoff payload from a subagent's final output.
 * Rules, in order:
 * 1. incomplete === true → level capped at "fallback" (output unreliable as complete);
 * 2. output absent/empty → `{ text: "(previous step failed)", level: "raw" }`;
 * 3. output ≤ 6000 chars → whole, "raw";
 * 4. last `## HANDOFF` section present + contains VERIFIED FACTS + ≤4000 chars → that, "full";
 * 5. section present but incomplete/malformed + ≤4000 chars → that, "partial";
 * 6. otherwise → last 12000 chars cut at a paragraph boundary, "fallback".
 */
export function extractHandoff(output: string, opts?: { incomplete?: boolean }): Handoff {
  const incomplete = opts?.incomplete === true;

  // Rule 2: no output at all.
  if (!output || output.trim().length === 0) {
    if (incomplete) return { text: "(previous step failed)", level: "fallback" };
    return { text: "(previous step failed)", level: "raw" };
  }

  // Rule 3: small outputs travel whole.
  if (output.length <= RAW_WHOLE_LIMIT) {
    return { text: output, level: incomplete ? "fallback" : "raw" };
  }

  // Rules 4-5: prefer the structured HANDOFF section.
  const marker = output.lastIndexOf("## HANDOFF");
  if (marker >= 0) {
    let section = output.slice(marker).trim();
    const nextHeading = section.indexOf("\n## ", 1);
    if (nextHeading > 0) section = section.slice(0, nextHeading).trim();
    if (section.length <= FULL_HANDOFF_LIMIT) {
      if (section.includes("VERIFIED FACTS")) {
        // Rule 1 takes precedence: an incomplete run's output is unreliable
        // as complete, so even a well-formed HANDOFF caps at fallback.
        return { text: section, level: incomplete ? "fallback" : "full" };
      }
      return { text: section, level: "partial" };
    }
    // Oversized HANDOFF: fall through to tail fallback.
  }

  // Rule 6: tail fallback.
  return { text: cutAtParagraph(output, FALLBACK_TAIL), level: "fallback" };
}
