import { existsSync, mkdirSync, createWriteStream, renameSync, unlinkSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const here = fileURLToPath(new URL(".", import.meta.url));
const RUNTIME_DIR = resolve(here, "..", "runtime", "browse", "dist");

// NOTE: pinned release tag — must be bumped alongside package.json's version
// when a new binary release is cut, or fresh installs download a stale build.
// DoD exemption: host segment stays "gstack-pi" until the GitHub repo is
// renamed and the first kstack-pi release exists (post-merge manual task);
// GitHub redirects old release URLs after the rename, so this keeps working.
const RELEASE_BASE = "https://github.com/KedraVt/gstack-pi/releases/download/v2.0.0";

const ASSETS: Record<string, string> = {
  win32: "browse.exe",
  darwin: "browse-macos",
  linux: "browse-linux",
};

export function getBinaryPath(): string {
  const name = process.platform === "win32" ? "browse.exe" : "browse";
  return join(RUNTIME_DIR, name);
}

export function isBinaryInstalled(): boolean {
  return existsSync(getBinaryPath());
}

export async function downloadBinary(
  onProgress?: (msg: string) => void,
): Promise<{ path: string } | { error: string }> {
  const asset = ASSETS[process.platform];
  if (!asset) {
    return { error: `Unsupported platform: ${process.platform}` };
  }

  const url = `${RELEASE_BASE}/${asset}`;
  const dest = getBinaryPath();
  // Write to a sibling temp file and rename on success: an interrupted
  // download must never leave a half-written binary that resolveBinary()
  // then happily resolves and executes.
  const tmp = `${dest}.part-${process.pid}`;

  mkdirSync(RUNTIME_DIR, { recursive: true });
  onProgress?.(`Downloading browse binary from GitHub Releases...`);

  try {
    // 120s ceiling: a silently-stalled fetch previously hung session_start
    // forever (the extension host awaited the hook).
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!res.ok || !res.body) {
      return { error: `Download failed: HTTP ${res.status}` };
    }

    const total = Number(res.headers.get("content-length") || 0);
    let received = 0;
    const fileStream = createWriteStream(tmp);

    const reader = res.body.getReader();
    const readable = new Readable({
      async read() {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        received += value.length;
        if (total && onProgress) {
          const pct = Math.round((received / total) * 100);
          onProgress(`Downloading... ${pct}%`);
        }
        this.push(value);
      },
    });

    await pipeline(readable, fileStream);
    renameSync(tmp, dest);
    // POSIX: a downloaded file lands 0644 — the binary cannot exec until
    // chmod +x, which previously made every fresh macOS/Linux install fail
    // with EACCES on first use.
    if (process.platform !== "win32") {
      try {
        chmodSync(dest, 0o755);
      } catch {
        /* leave the file; the spawn error surfaces readably downstream */
      }
    }
    onProgress?.("Download complete.");
    return { path: dest };
  } catch (err: any) {
    try {
      unlinkSync(tmp);
    } catch {
      /* no partial file, or removal failed — either way nothing to leak */
    }
    return { error: `Download failed: ${err.message}` };
  }
}
