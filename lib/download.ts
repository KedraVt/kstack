import { existsSync, mkdirSync, createWriteStream, renameSync, unlinkSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const here = fileURLToPath(new URL(".", import.meta.url));
const RUNTIME_DIR = resolve(here, "..", "runtime", "browse", "dist");

// NOTE: pinned release tag — must be bumped alongside package.json's version
// when a new binary release is cut, or fresh installs download a stale build.
const RELEASE_BASE = "https://github.com/KedraVt/kstack/releases/download/v3.0.0";

// Release asset → local file name, per `${platform}-${arch}` (built by
// browser/build.sh). Windows runs the server under Node, so browse.exe needs
// its server bundle + polyfill beside it. The binary comes LAST: it is the
// "installed" marker, so an interrupted download is retried on next start.
const ASSETS: Record<string, Array<[asset: string, file: string]>> = {
  "win32-x64": [
    ["server-node.mjs", "server-node.mjs"],
    ["bun-polyfill.cjs", "bun-polyfill.cjs"],
    ["browse.exe", "browse.exe"],
  ],
  "darwin-arm64": [["browse-darwin-arm64", "browse"]],
  "darwin-x64": [["browse-darwin-x64", "browse"]],
  "linux-x64": [["browse-linux-x64", "browse"]],
};

const platformAssets = () => ASSETS[`${process.platform}-${process.arch}`];

// Records which release the runtime came from: a binary from another
// release (e.g. a 2.x build writing .gstack/) counts as not installed.
const RELEASE_STAMP = join(RUNTIME_DIR, ".release");

export function getBinaryPath(): string {
  const name = process.platform === "win32" ? "browse.exe" : "browse";
  return join(RUNTIME_DIR, name);
}

export function isBinaryInstalled(): boolean {
  // Every companion file must be there — a pre-3.0 Windows install had only
  // browse.exe and could not start its server.
  const assets = platformAssets();
  if (!assets) return existsSync(getBinaryPath());
  try {
    if (readFileSync(RELEASE_STAMP, "utf-8").trim() !== RELEASE_BASE) return false;
  } catch {
    return false;
  }
  return assets.every(([, file]) => existsSync(join(RUNTIME_DIR, file)));
}

export async function downloadBinary(
  onProgress?: (msg: string) => void,
): Promise<{ path: string } | { error: string }> {
  const assets = platformAssets();
  if (!assets) {
    return { error: `Unsupported platform: ${process.platform}-${process.arch}` };
  }
  mkdirSync(RUNTIME_DIR, { recursive: true });
  for (const [asset, file] of assets) {
    const result = await downloadAsset(asset, join(RUNTIME_DIR, file), onProgress);
    if ("error" in result) return result;
  }
  writeFileSync(RELEASE_STAMP, RELEASE_BASE);
  onProgress?.("Download complete.");
  return { path: getBinaryPath() };
}

async function downloadAsset(
  asset: string,
  dest: string,
  onProgress?: (msg: string) => void,
): Promise<{ path: string } | { error: string }> {
  const url = `${RELEASE_BASE}/${asset}`;
  // Write to a sibling temp file and rename on success: an interrupted
  // download must never leave a half-written binary that resolveBinary()
  // then happily resolves and executes.
  const tmp = `${dest}.part-${process.pid}`;

  onProgress?.(`Downloading ${asset} from GitHub Releases...`);

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
          onProgress(`Downloading ${asset}... ${pct}%`);
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
