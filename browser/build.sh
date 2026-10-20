#!/usr/bin/env bash
# build.sh — build the vendored kstack browser binaries from browser/ source.
#
# Upstream layout is preserved inside browser/ (browser/browse/src, browser/lib),
# so every import path in the vendored source is unchanged. Only the OUTPUT
# layout is kstack-specific: binaries land in browser/dist/<target>/.
#
#   win32-x64     browse.exe  + server-node.mjs + bun-polyfill.cjs
#   darwin-arm64  browse
#   darwin-x64    browse
#   linux-x64     browse
#
# The Windows target also ships the Node.js server bundle: on Windows Bun
# cannot launch or connect to Playwright's Chromium (oven-sh/bun#4253, #9911),
# so the daemon runs under Node with the Bun API polyfill. Upstream does the
# same in browse/scripts/build-node-server.sh.
#
# Usage:
#   bash build.sh              # every target listed above
#   bash build.sh win32-x64    # only the named target(s)
#
# Env:
#   BUN_CMD   bun executable to use (default: bun)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
cd "$ROOT"

BUN_CMD="${BUN_CMD:-bun}"

# Bun cannot open MSYS-style absolute paths ("FileNotFound opening root
# directory"), so on Git Bash / MSYS / Cygwin convert to a Windows-style path.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) ROOT="$(cygpath -m "$ROOT")" ;;
esac
cd "$ROOT"

SRC_DIR="$ROOT/browse/src"
DIST_DIR="$ROOT/dist"

ALL_TARGETS="win32-x64 darwin-arm64 darwin-x64 linux-x64"
TARGETS="${*:-$ALL_TARGETS}"

# Version stamp next to the binaries. Upstream writes the git HEAD of the
# checkout; the vendored copy has no upstream git history, so the vendored
# upstream commit is used. The CLI and the server bundle compare this file
# (browse/src/cli.ts) and refuse to run when they disagree.
VERSION_STAMP="43d6ed28f2bf55acae23a13be3d1e053f8958d3b"

log() { printf '[build] %s\n' "$*"; }

# bun --compile target triple for a kstack target name.
bun_target() {
  case "$1" in
    win32-x64)    echo "bun-windows-x64" ;;
    darwin-arm64) echo "bun-darwin-arm64" ;;
    darwin-x64)   echo "bun-darwin-x64" ;;
    linux-x64)    echo "bun-linux-x64" ;;
    *) echo "unknown target: $1" >&2; return 1 ;;
  esac
}

# Output binary name for a kstack target name.
binary_name() {
  case "$1" in
    win32-x64) echo "browse.exe" ;;
    *) echo "browse" ;;
  esac
}

# build_browse_binary <target> — compile browse/src/cli.ts into a standalone
# bun executable. Upstream flags are kept: a project's .env / bunfig.toml must
# never reach a shipped binary (it runs inside untrusted repos).
build_browse_binary() {
  local target="$1"
  local out_dir="$DIST_DIR/$target"
  local out_file="$out_dir/$(binary_name "$target")"
  mkdir -p "$out_dir"
  log "compiling browse for $target -> $out_file"
  "$BUN_CMD" build --compile \
    --no-compile-autoload-dotenv \
    --no-compile-autoload-bunfig \
    --target="$(bun_target "$target")" \
    "$SRC_DIR/cli.ts" \
    --outfile "$out_file"
  chmod +x "$out_file" 2>/dev/null || true
}

# build_node_server <target> — Node.js-compatible server bundle (Windows).
#
# Mirrors upstream browse/scripts/build-node-server.sh:
#   1. bundle browse/src/server.ts for node, externalizing the deps that
#      carry native addons or runtime resolution (sharp, socks, ngrok, …)
#   2. replace import.meta.dir with a resolvable reference
#   3. inject the polyfill header (Bun API shim + createRequire)
#   4. copy the polyfill next to the bundle
build_node_server() {
  local target="$1"
  local out_dir="$DIST_DIR/$target"
  local bundle="$out_dir/server-node.mjs"
  mkdir -p "$out_dir"
  log "bundling node server for $target -> $bundle"

  "$BUN_CMD" build "$SRC_DIR/server.ts" \
    --target=node \
    --outfile "$bundle" \
    --external playwright \
    --external playwright-core \
    --external diff \
    --external "bun:sqlite" \
    --external "@ngrok/ngrok" \
    --external socks \
    --external sharp

  # The bundle lives in browser/dist/<target>/, so the source tree sits two
  # levels up and to the side (browser/browse/src). Upstream had it at
  # ../src — resolve it relative to the bundle instead of hardcoding.
  local src_rel
  src_rel="$(realpath --relative-to="$(dirname "$out_dir")" "$SRC_DIR" 2>/dev/null || echo "../browse/src")"

  perl -pi -e 's/import\.meta\.dir/__browseNodeSrcDir/g' "$bundle"

  {
    head -1 "$bundle"
    echo '// ── Windows Node.js compatibility (auto-generated) ──'
    echo 'import { fileURLToPath as _ftp } from "node:url";'
    echo 'import { dirname as _dn } from "node:path";'
    echo "const __browseNodeSrcDir = _dn(_dn(_ftp(import.meta.url))) + \"/$src_rel\";"
    echo '{ const _r = createRequire(import.meta.url); _r("./bun-polyfill.cjs"); }'
    echo '// ── end compatibility ──'
    tail -n +2 "$bundle"
  } > "$bundle.tmp"

  mv "$bundle.tmp" "$bundle"
  cp "$SRC_DIR/bun-polyfill.cjs" "$out_dir/bun-polyfill.cjs"
}

for target in $TARGETS; do
  build_browse_binary "$target"
  if [ "$target" = "win32-x64" ]; then
    build_node_server "$target"
  fi
  printf '%s\n' "$VERSION_STAMP" > "$DIST_DIR/$target/.version"
done

log "done:"
for target in $TARGETS; do
  for f in "$DIST_DIR/$target"/*; do
    [ -e "$f" ] || continue
    printf '  %-52s %10s bytes\n' "${f#$ROOT/}" "$(wc -c < "$f" | tr -d ' ')"
  done
done
