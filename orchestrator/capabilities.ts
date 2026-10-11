/**
 * S4 / TASK_06 (ADR-16) — machine capability probing + step gates.
 *
 * `state.capabilities` is written by `kstack init` (§10.8) and lazily at
 * dispatch when the map is empty (a run started without init — the
 * convention: `{}` means "never probed", a map with at least one true entry
 * means "probed"). Probing is PATH/binary detection only — never a stale
 * cache of repo hints (§10.8 explicitly forbids caching probes).
 *
 * - `requires:` — every listed capability must be present; a missing one
 *   SKIPS the step with a ledger note (useless without it, INV-16).
 * - `prefers:` — a missing preference DEGRADES the step: the step runs and
 *   its task/instructions carry `~capability: no-<cap>` (e.g. graft-first
 *   scout falls back to rg).
 */

import { spawnSync } from "node:child_process";
import { resolveBinary } from "../lib/browse.ts";
import type { Capability } from "./types.ts";

/** PATH membership check via `where`/`which` — no shell, no version output needed. */
function commandExists(name: string): boolean {
  try {
    const res = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
      stdio: "ignore",
      windowsHide: true,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Probe every declared capability. Deterministic, side-effect free:
 * graft/node/gh/design are PATH lookups; browse resolves the managed
 * kstack browse binary (never the user's visible session — INV-15).
 */
export function probeCapabilities(): Record<Capability, boolean> {
  return {
    graft: commandExists("graft"),
    browse: "path" in resolveBinary(),
    node: commandExists("node"),
    gh: commandExists("gh"),
    design: commandExists(process.platform === "win32" ? "design.exe" : "design"),
  };
}

/** True when the state's capability map has never been stamped by a probe. */
export function capabilitiesUnprobed(caps: Partial<Record<Capability, boolean>> | undefined): boolean {
  return !caps || Object.values(caps).every((v) => v !== true);
}

/** Required capabilities missing from the map. Empty ⇒ the step may run. */
export function missingRequires(
  step: { requires?: Capability[] },
  caps: Partial<Record<Capability, boolean>> | undefined,
): Capability[] {
  return (step.requires ?? []).filter((c) => caps?.[c] !== true);
}

/** Preferred capabilities missing from the map — each degrades to a `~capability: no-<cap>` note. */
export function missingPrefers(
  step: { prefers?: Capability[] },
  caps: Partial<Record<Capability, boolean>> | undefined,
): Capability[] {
  return (step.prefers ?? []).filter((c) => caps?.[c] !== true);
}
