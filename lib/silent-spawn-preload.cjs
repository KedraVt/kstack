"use strict";
/**
 * silent-spawn-preload.cjs — Windows console-suppression preload.
 *
 * Injected into spawned subagent processes via `node -r <this>` and the
 * NODE_OPTIONS env var (silentChildEnv in silent-spawn.ts). A child spawned
 * with windowsHide:true gets CREATE_NO_WINDOW — NO console at all — so every
 * console-subsystem process IT then spawns (pi's exec/grep/find/git calls,
 * cmd.exe shells, bash probes) would allocate a brand-new VISIBLE console
 * window. pi's internal spawn sites don't pass windowsHide, so we wrap the
 * child_process spawn family here and inject it. NODE_OPTIONS propagates the
 * same preload to nested node processes, so the whole descendant tree stays
 * silent. Explicit caller-set windowsHide values are always respected.
 *
 * CJS (.cjs) on purpose: `node --require` needs a CommonJS file even when the
 * host package is ESM. Idempotent via a marker — NODE_OPTIONS plus an argv -r
 * can legitimately deliver it twice.
 */
const cp = require("node:child_process");

if (process.platform === "win32" && !cp.__gstackSilentSpawnPatched) {
  /**
   * Find the options position in a spawn-family overload list
   * (cmd [,args][, options][, callback]) and inject windowsHide.
   * Arrays are argument lists; the first plain object is the options object;
   * a function is the callback — options belong before it.
   */
  const injectHide = (rest) => {
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (Array.isArray(a)) continue; // args array — not the options position
      if (a && typeof a === "object") {
        if (a.windowsHide === undefined) a.windowsHide = true;
        return rest;
      }
      rest.splice(i, 0, { windowsHide: true });
      return rest;
    }
    rest.push({ windowsHide: true });
    return rest;
  };

  const wrap = (orig) =>
    function (command, ...rest) {
      return orig.call(this, command, ...injectHide(rest));
    };

  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    const orig = cp[name];
    if (typeof orig === "function") {
      cp[name] = wrap(orig);
    }
  }
  cp.__gstackSilentSpawnPatched = true;
}
