#!/bin/bash
# update.sh — Rebuild runtime + sync skills from gstack source (submodule)
# Usage: bash update.sh [--skip-pull]
set -e

DEST="$(cd "$(dirname "$0")" && pwd)"
REPO="$DEST/source"
SKILLS=(gstack gstack-autoplan gstack-context-restore gstack-context-save gstack-cso gstack-design-review gstack-document-generate gstack-document-release gstack-investigate gstack-learn gstack-office-hours gstack-plan-ceo-review gstack-plan-design-review gstack-plan-devex-review gstack-plan-eng-review gstack-qa-only gstack-qa gstack-retro gstack-review gstack-scrape gstack-ship gstack-skillify gstack-spec)
# Self-contained scripts (bash, or bun with no relative imports) synced into runtime/bin.
# SKILL.md references point here for these.
BIN_SCRIPTS=(gstack-config gstack-slug gstack-update-check gstack-session-kind gstack-repo-mode gstack-learnings-search gstack-timeline-log gstack-brain-sync gstack-codex-probe gstack-developer-profile gstack-diff-scope gstack-first-task-detect gstack-next-version gstack-paths gstack-pr-title-rewrite.sh gstack-question-preference gstack-review-log gstack-review-read gstack-specialist-stats gstack-team-init gstack-version-bump)
# TS-backed scripts that import ../lib — they MUST stay in source/bin (bun resolves
# their deps from the vendored checkout). SKILL.md references point to source/bin.
SOURCE_BIN_SCRIPTS=(gstack-brain-cache gstack-decision-log gstack-decision-search gstack-learnings-log gstack-question-log gstack-redact gstack-telemetry-log)

if [ ! -d "$REPO/.git" ] && [ ! -f "$REPO/.git" ]; then
  echo "ERROR: gstack source not found at $REPO"
  echo "Run: git submodule update --init --recursive"
  exit 1
fi

# 1. Pull latest
if [ "$1" != "--skip-pull" ]; then
  echo "==> Pulling latest gstack..."
  cd "$REPO" && git pull --ff-only origin main
else
  echo "==> Skipping pull (--skip-pull)"
fi

cd "$REPO"
VERSION=$(cat VERSION 2>/dev/null || echo "unknown")
echo "==> gstack version: $VERSION"

# 2. Detect new upstream features not yet in the extension
echo "==> Checking for new upstream features..."
NEW_FEATURES=""

# 2a. New skills in source not in our cherry-picked list
for skill_dir in "$REPO"/*/; do
  [ -f "$skill_dir/SKILL.md" ] || continue
  name=$(basename "$skill_dir")
  case "$name" in bin|browse|design|docs|extension|ios-qa|lib|make-pdf|node_modules|scripts|ship|test) continue ;; esac
  skill_id="gstack-$name"
  [ "$name" = "browse" ] && skill_id="gstack"
  found=0
  for local_skill in "${SKILLS[@]}"; do
    [ "$skill_id" = "$local_skill" ] && found=1 && break
  done
  if [ $found -eq 0 ]; then
    NEW_FEATURES="${NEW_FEATURES}\n  [skill] $skill_id"
  fi
done

# 2b. New bin scripts upstream not in our list
for script in "$REPO"/bin/gstack-*; do
  [ -f "$script" ] || continue
  name=$(basename "$script")
  found=0
  for local_bin in "${BIN_SCRIPTS[@]}" "${SOURCE_BIN_SCRIPTS[@]}"; do
    [ "$name" = "$local_bin" ] && found=1 && break
  done
  if [ $found -eq 0 ]; then
    NEW_FEATURES="${NEW_FEATURES}\n  [bin]   $name"
  fi
done

# 2c. New browse commands in source not in our allowlist
if [ -f "$REPO/browse/src/commands.ts" ]; then
  UPSTREAM_CMDS=$(grep -oE "^[[:space:]]*'[a-zA-Z0-9_-]+'" "$REPO/browse/src/commands.ts" 2>/dev/null | tr -d " '" | sort -u)
  LOCAL_CMDS=$(grep -oE "'[a-zA-Z0-9_-]+'" "$DEST/lib/commands.generated.ts" 2>/dev/null | tr -d "'" | sort -u)
  for cmd in $UPSTREAM_CMDS; do
    if ! echo "$LOCAL_CMDS" | grep -qx "$cmd"; then
      NEW_FEATURES="${NEW_FEATURES}\n  [tool]  gstack_$cmd"
    fi
  done
fi

if [ -n "$NEW_FEATURES" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  NEW FEATURES AVAILABLE UPSTREAM — update extension!    ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
  echo "  Not yet included in gstack-pi:"
  echo -e "$NEW_FEATURES"
  echo ""
  echo "  To include new skills: add them to SKILLS= in this script"
  echo "  To include new tools:  bun run scripts/gen-tools.ts"
  echo ""
else
  echo "    No new upstream features detected."
fi

# 3. Install deps if needed
if [ ! -d node_modules ]; then
  echo "==> Installing dependencies..."
  bun install --silent
fi

# 4. Build browse binary
echo "==> Building browse binary..."
mkdir -p browse/dist
bun build --compile browse/src/cli.ts --outfile browse/dist/browse

# 5. Build Windows node server bundle
echo "==> Building node server bundle..."
bash browse/scripts/build-node-server.sh

# 6. Deploy runtime
echo "==> Deploying runtime..."
mkdir -p "$DEST/runtime/browse/dist" "$DEST/runtime/bin"
cp browse/dist/browse.exe "$DEST/runtime/browse/dist/" 2>/dev/null || cp browse/dist/browse "$DEST/runtime/browse/dist/"
cp browse/dist/server-node.mjs "$DEST/runtime/browse/dist/"
cp browse/dist/bun-polyfill.cjs "$DEST/runtime/browse/dist/"

# 6b. Guard (HANDOFF WP2 §4.2): the server-side content envelope must survive
# rebuilds. If upstream browse ever drops wrapUntrustedContent, page-content
# output loses its untrusted-content envelope — warn loudly instead of
# degrading silently.
if ! grep -q "wrapUntrustedContent" "$DEST/runtime/browse/dist/server-node.mjs" 2>/dev/null; then
  echo ""
  echo "  WARNING: runtime/browse/dist/server-node.mjs no longer contains"
  echo "  'wrapUntrustedContent'. The daemon-side untrusted-content envelope may"
  echo "  be gone — inspect upstream browse/src changes before relying on QA output."
  echo ""
fi

# 7. Sync bin scripts
echo "==> Syncing bin scripts..."
for script in "${BIN_SCRIPTS[@]}"; do
  [ -f "bin/$script" ] && cp "bin/$script" "$DEST/runtime/bin/"
done

# 7b. Verify TS-backed scripts stay available in source/bin (never copied to runtime:
#     they import ../lib and only resolve from inside the checkout)
for script in "${SOURCE_BIN_SCRIPTS[@]}"; do
  [ -f "bin/$script" ] || echo "WARNING: missing source bin script (skills will degrade): $script"
done

# 8. Adapt skills from freshly-pulled source into pi form
#    scripts/adapt-skills.ts rewrites frontmatter, prepends the Pi adapter note and
#    maps ~/.claude/skills/gstack paths to runtime/ + source/. Idempotent; the root
#    gstack router skill is preserved untouched.
echo "==> Adapting ${#SKILLS[@]} skills..."
if command -v bun >/dev/null 2>&1; then
  (cd "$DEST" && bun scripts/adapt-skills.ts) || echo "WARNING: skill adaptation failed — previous skills kept"
else
  echo "WARNING: bun not found — skipping skill adaptation"
fi

# 8b. Digest drift check: warn when an upstream SKILL.md is newer than its distilled digest
echo "==> Checking digest freshness..."
STALE=""
for skill in "${SKILLS[@]}"; do
  digest="$DEST/skills-distilled/$skill.md"
  [ -f "$digest" ] || continue
  upstream="$DEST/skills/gstack/$skill/SKILL.md"
  [ -f "$upstream" ] || continue
  if [ "$upstream" -nt "$digest" ]; then
    STALE="$STALE\n  $skill (upstream SKILL.md changed after distillation)"
  fi
done
if [ -n "$STALE" ]; then
  echo ""
  echo "  WARNING: these distilled digests may be stale:"
  echo -e "$STALE"
  echo "  Review skills-distilled/ and refresh the affected digests."
  echo ""
fi

# 8c. Sync specialist agent definitions (HANDOFF WP3 §5.1). Backup-then-copy,
# never deletes: user-tuned files in ~/.pi/agent/agents are preserved as
# <name>.md.bak-<runstamp> before being overwritten by canonical versions.
AGENT_DEST="$HOME/.pi/agent/agents"
if [ -d "$AGENT_DEST" ]; then
  echo "==> Syncing specialist agents..."
  STAMP=$(date +%Y%m%d-%H%M%S)
  for agent_file in "$DEST"/agents/*.md; do
    [ -f "$agent_file" ] || continue
    name=$(basename "$agent_file")
    target="$AGENT_DEST/$name"
    if [ -f "$target" ]; then
      if cmp -s "$agent_file" "$target"; then
        continue  # identical — nothing to do
      fi
      cp "$target" "$target.bak-$STAMP"
      echo "  backed up: $name -> $name.bak-$STAMP"
    fi
    cp "$agent_file" "$target"
    echo "  synced: $name"
  done
else
  echo "==> Skipping agent sync ($AGENT_DEST not found)"
fi

# 9. Verify
echo "==> Verifying..."
BINARY="$DEST/runtime/browse/dist/browse.exe"
[ ! -f "$BINARY" ] && BINARY="$DEST/runtime/browse/dist/browse"
if [ -x "$BINARY" ]; then
  echo "OK: binary at $BINARY"
else
  echo "WARNING: binary not executable at $BINARY"
fi

# 10. Run tests (digest size caps, workflow integrity, tiering)
if command -v bun >/dev/null 2>&1; then
  echo "==> Running tests..."
  if (cd "$DEST" && bun test test/orchestrator.test.ts >/dev/null 2>&1); then
    echo "OK: tests pass"
  else
    echo "WARNING: tests failed — check bun test test/orchestrator.test.ts"
  fi
fi

echo ""
echo "==> Done. gstack-pi updated to v$VERSION"
echo "    Binary: $BINARY"
echo "    Skills: ${#SKILLS[@]} synced"
echo "    Bin:    ${#BIN_SCRIPTS[@]} scripts"
