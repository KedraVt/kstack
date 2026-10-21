/**
 * TASK_01 / ADR-25, ADR-41, ADR-45, ADR-50 — the tool mask.
 *
 * Every phase declares a TOOL PROFILE (`full` | `read` | `none`). The mask
 * narrows the MAIN session's active tool set to the browser tools the profile
 * allows. It is CONTEXT ECONOMY, not a security boundary: the model can
 * still reach a browser through `bash`, and the real trust boundary is the
 * untrusted marking in `lib/content-security.ts` (ADR-28, residual R1). Every
 * failure path therefore fails OPEN — a broken mask costs context, never
 * availability.
 *
 * Rules that are invariants, not preferences:
 *  - the control tools (`kstack_advance`, `kstack_phase`) are NEVER masked;
 *  - the mask ADDS no name and removes exactly the masked ones (INV-2);
 *  - the result is ordered by pi's `getAllTools()` index, so a restore never
 *    reorders the tool list (the prompt-cache prefix stays stable, INV-16);
 *  - an unchanged profile is a NO-OP — no `setActiveTools` call, no cache
 *    churn (risk-scan F2);
 *  - the mask ledger (`ownerRunId`, `removedByMask`) SURVIVES
 *    `invalidateRuntime()`: pi keeps the active loadout across an extension
 *    reload, so a reset would orphan the mask with no way to restore it. It
 *    is cleared only on an owner change or after a SUCCESSFUL terminal
 *    restore (ADR-60, INV-28).
 */

import { TOOLS } from "../tools.generated.ts";
import type { ToolProfile, WorkflowPhase } from "./types.ts";

/** The orchestrator's own tools — never masked, never in BROWSER_TOOLS. */
export const CONTROL_TOOLS: ReadonlySet<string> = new Set(["kstack_advance", "kstack_phase"]);

/** Every browser tool — derived from the tool registry, so a new tool is
 * masked out of `read`/`none` until the profile table is reviewed. */
export const BROWSER_TOOLS: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name));

/**
 * The read set — the literal allowlist of the `read` profile: non-mutating
 * inspection plus the navigation family (R2 was accepted by the user: a
 * planner must be able to open a page). Deliberately EXCLUDED: the
 * interaction tools (click/fill/select/hover/type/press/upload), the
 * cookie/header/useragent/style/session-state tools, `chain` (it runs any
 * command — it would bypass the profile), `js`/`eval` (arbitrary page
 * script) and every file-writing tool except the daemon-validated
 * screenshot image.
 */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  "kstack_goto", "kstack_back", "kstack_forward", "kstack_reload", "kstack_url",
  "kstack_load_html", "kstack_snapshot", "kstack_text", "kstack_html", "kstack_links",
  "kstack_forms", "kstack_accessibility", "kstack_media", "kstack_console",
  "kstack_network", "kstack_css", "kstack_attrs", "kstack_is", "kstack_inspect",
  "kstack_ux_audit", "kstack_screenshot", "kstack_wait", "kstack_scroll",
  "kstack_perf", "kstack_tabs", "kstack_tab", "kstack_newtab", "kstack_closetab",
  "kstack_frame", "kstack_dialog", "kstack_diff", "kstack_daemon_status",
]);

/**
 * The phase → profile table — DATA, not prose. One explicit key per
 * registered (workflow, phase) pair: no wildcards, no default. A pair
 * without a key resolves `full` at runtime (availability) but the CI test
 * enumerates the STATIC workflow list and fails (INV-3).
 */
export const PHASE_TOOL_PROFILE: Record<string, ToolProfile> = {
  // develop
  "develop:explore": "none",
  "develop:plan": "read",
  "develop:implement": "none",
  "develop:qa-browsing": "full",
  "develop:review": "none",
  "develop:document": "none",
  "develop:ship": "none",
  "develop:retro": "none",
  // sprint
  "sprint:explore": "none",
  "sprint:understand": "read",
  "sprint:user-story": "read",
  "sprint:capability": "read",
  "sprint:system-design": "read",
  "sprint:architect-gate": "none",
  "sprint:backlog": "read",
  "sprint:implement": "none",
  "sprint:qa-browsing": "full",
  "sprint:devsecops-review": "none",
  "sprint:docker-review": "none",
  "sprint:pipeline-review": "none",
  "sprint:archive": "none",
  "sprint:retro": "none",
  // investigate
  "investigate:explore": "none",
  "investigate:reproduce": "full",
  "investigate:root-cause": "read",
  "investigate:fix": "none",
  "investigate:verify": "full",
  "investigate:regression-qa": "full",
  "investigate:retro": "none",
  // review
  "review:explore": "none",
  "review:diff": "none",
  "review:findings": "none",
  "review:qa-browsing": "full",
  "review:comment": "none",
  "review:fix": "none",
  "review:retro": "none",
  // discover
  "discover:session": "full",
  // audit
  "audit:walk": "full",
};

/** The host surface the mask needs — pi's ExtensionAPI satisfies it. */
export interface ToolMaskHost {
  getActiveTools(): string[];
  getAllTools(): Array<{ name: string }>;
  setActiveTools(toolNames: string[]): void;
}

/** What the mask changed — the caller ledger it (the audit trail). */
export interface MaskChange {
  profile: ToolProfile;
  removed: number;
  added: number;
  ownerRunId: string | null;
}

interface MaskLedgerState {
  ownerRunId: string | null;
  removedByMask: Set<string>;
}

/** The mask ledger — module level on purpose: it must survive an extension
 * reload (pi keeps the active loadout across one). */
const ledger: MaskLedgerState = { ownerRunId: null, removedByMask: new Set<string>() };

/** A read-only view of the mask ledger (tests + the terminal restore). */
export function maskLedger(): { ownerRunId: string | null; removedByMask: Set<string> } {
  return { ownerRunId: ledger.ownerRunId, removedByMask: new Set(ledger.removedByMask) };
}

/** Test seam: forget the mask ledger. Never called in production code. */
export function resetToolMaskLedger(): void {
  ledger.ownerRunId = null;
  ledger.removedByMask = new Set<string>();
}

/** The profile of a phase — `full` when the pair is not declared. */
export function profileFor(workflowId: string, phase: Pick<WorkflowPhase, "id">): ToolProfile {
  return PHASE_TOOL_PROFILE[`${workflowId}:${phase.id}`] ?? "full";
}

/** The profile of a (workflow, phase-id) pair — the id form of `profileFor`. */
export function profileForPhaseId(workflowId: string, phaseId: string): ToolProfile {
  return PHASE_TOOL_PROFILE[`${workflowId}:${phaseId}`] ?? "full";
}

/** The names a profile removes — never a control tool. */
export function maskedFor(profile: ToolProfile): ReadonlySet<string> {
  if (profile === "full") return new Set<string>();
  const masked = new Set<string>(BROWSER_TOOLS);
  if (profile === "read") for (const name of READ_TOOLS) masked.delete(name);
  for (const c of CONTROL_TOOLS) masked.delete(c);
  return masked;
}

/** The names to keep, ordered by pi's `getAllTools()` index. A name pi does
 * not know keeps its current position (pi drops unknown names itself — the
 * mask never filters by registry membership, it only removes). */
function orderByToolIndex(host: ToolMaskHost, names: string[], current: string[]): string[] {
  const index = new Map<string, number>();
  host.getAllTools().forEach((t, i) => index.set(t.name, i));
  const keyed = names.map((name, i) => {
    const known = index.get(name);
    if (known !== undefined) return { name, key: known, i };
    // Unknown name: inherit the rank of its predecessor so it keeps its place.
    let key = -1;
    for (let j = i - 1; j >= 0; j--) {
      const k = index.get(names[j]);
      if (k !== undefined) {
        key = k;
        break;
      }
    }
    return { name, key, i };
  });
  keyed.sort((a, b) => (a.key !== b.key ? a.key - b.key : a.i - b.i));
  return keyed.map((k) => k.name);
}

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((n, i) => n === b[i]);

/**
 * Narrow (or widen) the host's active tool set to the profile.
 *
 * The mask adds NO name and removes exactly the masked ones. When the owner
 * run changes, the previous owner's removals are restored first and the new
 * profile is applied on top (the composition below already yields that end
 * state — the previous owner's removed names are part of `base` and survive
 * only if the new profile keeps them).
 *
 * Never throws: a host without `setActiveTools` (an old pi) or a throwing
 * one leaves the session UNMASKED — the mask is an optimisation.
 */
export function reconcileToolMask(
  host: ToolMaskHost,
  profile: ToolProfile,
  opts?: { runId?: string | null; onChange?: (change: MaskChange) => void },
): void {
  try {
    const active = host.getActiveTools();
    const base = new Set<string>([...active, ...ledger.removedByMask]);
    const masked = maskedFor(profile);
    const owner = opts?.runId ?? null;
    const ownerChanged = owner !== null && ledger.ownerRunId !== null && ledger.ownerRunId !== owner;
    // A new owner takes over: the previous owner's removals are restored
    // (they are in `base`) and the new profile is applied on top — the
    // composition below already yields that end state.
    const kept = [...base].filter((n) => !masked.has(n));
    const next = orderByToolIndex(host, kept, active);
    if (sameSet(next, active)) {
      // Nothing changed: the ledger still describes the masked names (a
      // no-op must not forget that a restore is owed).
      if (ownerChanged) ledger.ownerRunId = owner;
      return;
    }
    host.setActiveTools(next);
    ledger.ownerRunId = owner;
    ledger.removedByMask = new Set([...base].filter((n) => masked.has(n)));
    const removed = ledger.removedByMask.size;
    const added = [...next].filter((n) => !active.includes(n)).length;
    opts?.onChange?.({ profile, removed, added, ownerRunId: owner });
  } catch {
    // Fail open: an unmasked session is correct, a crashed session is not.
  }
}

/**
 * Restore every tool this module removed. The ledger is cleared ONLY after
 * `setActiveTools` succeeded — a failed restore leaves the ledger in place
 * so the next turn (or the next run) can try again (INV-28).
 */
export function restoreAllTools(host: ToolMaskHost, opts?: { onChange?: (change: MaskChange) => void }): boolean {
  try {
    const active = host.getActiveTools();
    const base = [...new Set([...active, ...ledger.removedByMask])];
    const next = orderByToolIndex(host, base, active);
    if (!sameSet(next, active)) host.setActiveTools(next);
    ledger.removedByMask = new Set<string>();
    ledger.ownerRunId = null;
    opts?.onChange?.({ profile: "full", removed: 0, added: next.length - active.length, ownerRunId: null });
    return true;
  } catch {
    return false;
  }
}
