/**
 * lib/silent-spawn.ts — Windows silent-process helpers.
 *
 * A child spawned with `windowsHide: true` gets CREATE_NO_WINDOW: no console
 * at all. Every console-subsystem process IT then spawns (pi's exec/grep/find
 * internals, git, cmd.exe, playwright drivers, …) allocates a brand-new
 * VISIBLE console window — the flashing terminal windows reported in the
 * field. The flag does not propagate down the tree; each spawn site must set
 * it. We cannot edit every dependency's spawn sites, so instead we inject a
 * CJS preload (`silent-spawn-preload.cjs`) into spawned node processes —
 * argv `-r` where we control the command line, plus NODE_OPTIONS so the
 * child (and every nested node process it launches) inherits the patch.
 *
 * Usage:
 *   - argv: `...winPreloadArgs(), script, ...args` — only when the command is
 *     a node/bun runtime interpreting a script (not for compiled exes).
 *   - env: `env: silentChildEnv()` on every spawn we control.
 *   - leaf spawns (taskkill etc.): keep explicit `windowsHide: true`.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const WIN_HIDE_PRELOAD_PATH = fileURLToPath(new URL("./silent-spawn-preload.cjs", import.meta.url));

/** `["-r", preload]` on win32 when the preload file is present; [] otherwise. */
export function winPreloadArgs(): string[] {
  return process.platform === "win32" && existsSync(WIN_HIDE_PRELOAD_PATH) ? ["-r", WIN_HIDE_PRELOAD_PATH] : [];
}

/**
 * Return `base` env with NODE_OPTIONS carrying `--require <preload>` so every
 * node process spawned under it (including nested ones — NODE_OPTIONS is
 * inherited) patches its child_process spawns with windowsHide. Merges with a
 * pre-existing NODE_OPTIONS; idempotent on repeated calls.
 */
export function silentChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform !== "win32" || !existsSync(WIN_HIDE_PRELOAD_PATH)) return base;
  const preloadPath = WIN_HIDE_PRELOAD_PATH.replace(/\\/g, "/");
  const req = `--require "${preloadPath}"`;
  const existing = base.NODE_OPTIONS?.trim();
  if (existing && (existing.includes(WIN_HIDE_PRELOAD_PATH) || existing.includes(preloadPath))) return base;
  return { ...base, NODE_OPTIONS: existing ? `${req} ${existing}` : req };
}
