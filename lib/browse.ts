/**
 * lib/browse.ts — CLI spawn wrapper for the gstack browse binary.
 *
 * Responsibilities (PLAN §8, §8b, §17):
 *   1. Resolve binary (Conv-A order: GSTACK_BINARY env -> $GSTACK_ROOT/browse/dist/browse
 *      -> ../gstack/browse/dist/browse -> bun run cli.ts fallback -> error).
 *   2. Spawn with shell:false, explicit arg arrays (no interpolation).
 *   3. AbortSignal -> child.kill("SIGTERM").
 *   4. timeoutMs (default 60s) -> child.kill("SIGTERM") + normalize exit 124.
 *   5. clearTimeout on close+exit (anti-handle-leak).
 *   6. Capture stdout+stderr via buffers.
 *   7. Normalize exit code (signal killed -> 124, GNU timeout convention).
 *   8. cap(): 32k output cap + enriched truncation hint reading ORIGINAL params
 *      (not built args — selector is positional for text/html/links so --selector
 *      grep would miss).
 *   9. classifyError(): 4-pattern semantic map + raw fallback (post-exit, non-blocking).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { silentChildEnv } from "./silent-spawn.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const CAP = 32_000; // ~8k tokens worst case (PLAN §18)

let cachedBinary: string | null | undefined;
let cachedError: string | null = null;

/**
 * Resolve the browse binary path.
 * Returns { path } on success, { error } with an actionable setup hint on failure.
 * Cached after first call (we never rebuild mid-session).
 */
export function resolveBinary(): { path: string } | { error: string } {
  if (cachedBinary !== undefined) {
    return cachedBinary === null ? { error: cachedError! } : { path: cachedBinary };
  }

  const here = fileURLToPath(new URL(".", import.meta.url)); // gstack-pi/lib/
  const localRuntime = resolve(here, "..", "runtime", "browse", "dist", "browse");
  const gstackRootGuess = resolve(here, "..", "..", "gstack");

  const candidates: { path: string; why: string }[] = [];
  if (process.env.GSTACK_BINARY) {
    candidates.push({ path: process.env.GSTACK_BINARY, why: "GSTACK_BINARY env" });
  }
  if (process.env.GSTACK_ROOT) {
    candidates.push({
      path: join(process.env.GSTACK_ROOT, "browse", "dist", "browse"),
      why: "$GSTACK_ROOT/browse/dist/browse (Conv-A)",
    });
  }
  candidates.push({
    path: localRuntime,
    why: "runtime/browse/dist/browse (bundled)",
  });
  candidates.push({
    path: join(gstackRootGuess, "browse", "dist", "browse"),
    why: "../gstack/browse/dist/browse (dev)",
  });

  for (const c of candidates) {
    if (c.path && existsSync(c.path)) {
      cachedBinary = c.path;
      return { path: c.path };
    }
    // Windows: compiled binary is browse.exe (PLAN §17)
    if (c.path) {
      const exePath = c.path + ".exe";
      if (existsSync(exePath)) {
        cachedBinary = exePath;
        return { path: exePath };
      }
    }
  }

  // bun-fallback: report source path so the user/LLM sees the actionable fix.
  // ponytail: we do NOT auto-spawn `bun run cli.ts` here — that would hide a
  //   missing build and require bun at runtime. Upgrade path: detect `which bun`
  //   and spawn it when the compiled binary is missing but a source tree exists.
  const cliTs = join(gstackRootGuess, "browse", "src", "cli.ts");
  cachedBinary = null;
  cachedError =
    "gstack browse binary not found. Tried: " +
    candidates.map((c) => c.path).join(", ") +
    ". Fix: export GSTACK_ROOT=/path/to/gstack and run " +
    "`cd \"$GSTACK_ROOT\" && bun install && bun run build`, or export GSTACK_BINARY=/full/path/browse. " +
    "Source fallback available at " + cliTs + " if Bun is on PATH.";
  return { error: cachedError };
}

/**
 * Drop the memoized resolution. index.ts calls this after a successful
 * session_start auto-download — without it runBrowse kept returning the
 * cached not-found error for the rest of the session, making the download
 * path dead code in the session that needed it most.
 */
export function invalidateBinaryCache(): void {
  cachedBinary = undefined;
  cachedError = null;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  signal?: string;
}

/** Spawn a gstack browse subprocess and capture its output. No shell. */
export function runBrowse(
  cmd: string,
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number; binaryPath?: string; stdin?: string } = {},
): Promise<RunResult> {
  const bin = opts.binaryPath
    ? { path: opts.binaryPath }
    : (resolveBinary() as { path: string; error?: undefined } | { error: string; path?: undefined });
  if ("error" in bin) {
    return Promise.resolve({
      stdout: "",
      stderr: bin.error,
      code: 127, // command-not-found convention
      signal: undefined,
    });
  }

  return new Promise((resolveP) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(bin.path, [cmd, ...args], {
      shell: false,
      windowsHide: true,
      // NODE_OPTIONS carries the silent-spawn preload into the daemon's own
      // `node -e` launcher so ITS detached children stay console-less too.
      env: silentChildEnv(),
    });
    let killedByTimeout = false;
    let settled = false;

    // WP1 §3.1: batch payloads (`chain`) travel via stdin, never argv —
    // argv-length limits and Windows quoting make argv the wrong transport
    // for a JSON batch. EPIPE when the child exits early must not crash the
    // host (this extension shares pi's process; 2026-08-23 crash class), so:
    //   - sync write wrapped in try/catch, explicit .end()
    //   - async stream errors swallowed via an "error" listener (an uncaught
    //     stream "error" event throws and would kill pi).
    if (opts.stdin !== undefined) {
      child.stdin?.on("error", () => {
        /* EPIPE / early-exit: result is read from stdout/stderr/exit code */
      });
      try {
        child.stdin?.write(opts.stdin);
        child.stdin?.end();
      } catch {
        /* see above */
      }
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));

    const timer = setTimeout(() => {
      killedByTimeout = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // pid already dead/recycled — ignore (handles ESRCH on a PID the OS may
        // have already reaped or recycled to another process).
      }
    }, timeoutMs);

    // Anti-handle-leak: clear the timer on BOTH close and exit, always. A child
    // that finishes in 2s must not leave a 58s timer dangling in the event loop
    // (blocks graceful exit + risks .kill() on a dead/recycled PID).
    const onDone = () => clearTimeout(timer);
    child.on("close", onDone);
    child.on("exit", onDone);

    // AbortSignal path: caller requested cancellation.
    if (opts.signal) {
      if (opts.signal.aborted) {
        killedByTimeout = true; // reuse SIGTERM/124 normalization path
        try {
          child.kill("SIGTERM");
        } catch {
          /* see above */
        }
      } else {
        opts.signal.addEventListener(
          "abort",
          () => {
            killedByTimeout = true;
            try {
              child.kill("SIGTERM");
            } catch {
              /* see above */
            }
          },
          { once: true },
        );
      }
    }

    // Single settle point. 'close' waits for ALL stdio to close — a detached
    // grandchild (daemon) inheriting the pipes can hold them open forever on
    // Windows — so 'exit' plus a 1.5s grace guarantees the promise settles.
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      let stderr = Buffer.concat(stderrChunks).toString("utf8");
      let normalizedCode = code;

      if (normalizedCode === null) {
        // Killed by signal. GNU `timeout` convention: exit 124 when timed out.
        if (signal === "SIGTERM" && killedByTimeout) {
          normalizedCode = 124;
          stderr = "timeout: process killed (SIGTERM)\n" + stderr;
        } else {
          normalizedCode = 1;
          stderr = "killed by signal " + String(signal) + "\n" + stderr;
        }
      }
      resolveP({ stdout, stderr, code: normalizedCode, signal: signal ?? undefined });
    };
    child.on("close", finish);
    child.on("exit", (code, signal) => {
      const grace = setTimeout(() => finish(code, signal), 1500);
      grace.unref?.();
    });
    // A failed spawn emits 'error' WITHOUT a subsequent 'close' — without a
    // listener the event throws inside the host process, and the returned
    // promise would never settle.
    child.on("error", (err) => {
      stderrChunks.push(Buffer.from(`spawn error: ${err.message}\n`));
      finish(127, null);
    });
  });
}

/**
 * Cap stdout at CAP chars and append an enriched truncation hint. Reads the
 * ORIGINAL LLM-supplied params (pre-buildArgs) for the scope, because buildArgs
 * converts `selector` to a positional arg for text/html/links/forms/media, so
 * grepping built args for `--selector` would always miss and imply "full
 * document". Passing params.selector / params.ref is format-agnostic.
 */
export function cap(
  stdout: string,
  params: unknown,
): { body: string; truncated: boolean } {
  if (stdout.length <= CAP) return { body: stdout, truncated: false };
  const p = (params ?? {}) as { selector?: string; ref?: string; commands?: unknown };
  const total = stdout.length;
  const head = stdout.slice(0, CAP);
  // Chain batches aggregate multiple sub-commands: a single "--selector" hint
  // would be meaningless there — point at re-running the interesting
  // sub-command individually instead (review finding #5).
  let hint: string;
  if (Array.isArray(p.commands)) {
    hint =
      "\n…[truncated at " +
      CAP +
      "/" +
      total +
      " chars. Batch output too large for one result: re-run the interesting sub-command individually (e.g. gstack_snapshot / gstack_text with a narrower --selector), or split the batch.]\n";
  } else {
    const scope = p.selector ?? p.ref ?? "(full document)";
    hint =
      "\n…[truncated at " +
      CAP +
      "/" +
      total +
      " chars. Last selector scope: " +
      scope +
      ". Re-run with a narrower --selector targeting the remaining region, or use gstack_attrs/gstack_inspect to find the next anchor.]\n";
  }
  return { body: head + hint, truncated: true };
}

/**
 * Semantic error map. Post-exit, non-blocking: produces a human message for the
 * tool `content`, while raw stderr is preserved separately in `details.rawStderr`
 * by the caller so no info is lost.
 */
export function classifyError(stderr: string, _args: string[]): string {
  const s = stderr.toLowerCase();
  // 1. Binary not found (compiled binary missing at resolved path)
  if (/spawn enoent|executable doesn'?t exist|browser was not found/.test(s))
    return "Browser binary missing. Build it: cd $GSTACK_ROOT && bun install && bun run build.";
  // 2. Playwright/Chromium engine missing
  if (/playwright|chromium not installed|err_playwright|executable doesn'?t exist at/.test(s))
    return "Browser engine missing. Run `bun install` inside the gstack checkout (downloads Chromium).";
  // 3. Daemon port busy (stuck daemon from prior session)
  if (/eaddrinuse|port .* is already in use|listen eacces/.test(s))
    return "gstack daemon port busy. Remove the stale gstack browse.json state file or kill the stale process.";
  // 4. ENOENT on resolved binary path
  if (/enoent/.test(s))
    return "Executable not found at resolved path. Rebuild: cd $GSTACK_ROOT && bun run build.";
  return stderr; // fallback: raw, LLM interprets
}
