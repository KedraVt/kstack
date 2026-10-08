/**
 * lib/commands.ts — thin re-export of the auto-generated allowlist.
 *
 * Auto-emitted by scripts/gen-tools.ts from the upstream browse/src/commands.ts.
 * Single source of truth = COMMAND_DESCRIPTIONS keys ∩ INCLUDE filter (PLAN §9).
 * No manual allowlist. Drift risk: if COMMAND_DESCRIPTIONS format changes from
 * an object literal, gen-tools' regex fails loudly — no silent drift.
 */
export { ALLOWED_COMMANDS, KSTACK_COMMANDS } from "./commands.generated";
import { ALLOWED_COMMANDS } from "./commands.generated";

export function isAllowed(cmd: string): boolean {
  return ALLOWED_COMMANDS.has(cmd);
}
