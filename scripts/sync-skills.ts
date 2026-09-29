/**
 * scripts/sync-skills.ts — Vendored skills importer and translator (PLAN §11).
 *
 * Responsibilities:
 *   1. Check if source skills are stale relative to the generator script (warning).
 *   2. Copy 23 gstack skills from `gstack/.pi/skills/gstack-*` to `gstack-pi/skills/gstack/*`.
 *   3. Run a 6-step rewrite pipeline on each SKILL.md to map paths to $GSTACK_ROOT.
 *   4. Verify zero remaining `$GSTACK_BIN/` calls in output files (post-check).
 *   5. Clean non-pi frontmatter keys, keeping only name and description.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
// GSTACK_REPO is canonical; GSTACK_SOURCE_DIR accepted as alias (matches gen-tools.ts).
const gstackRoot =
  process.env.GSTACK_REPO || process.env.GSTACK_SOURCE_DIR || resolve(here, "..", "source");
const gstackPiRoot = resolve(here, "..");

const INCLUDE = [
  "gstack", // root browser skill
  "office-hours", "plan-ceo-review", "plan-eng-review", "plan-design-review", "plan-devex-review",
  "autoplan", "spec", "review", "investigate", "qa", "qa-only", "design-review", "scrape", "skillify",
  "ship", "document-release", "document-generate", "cso", "learn", "retro", "context-save", "context-restore",
];

// Rewrite pipeline (PLAN §11 pseudo-code)
const REWRITES = [
  // 1. Inizializzazione della preamble: rispetta la variabile GSTACK_ROOT dell'utente se presente
  { pat: /GSTACK_ROOT="\$HOME\/\.pi\/agent\/skills\/gstack"/g, rep: 'GSTACK_ROOT="${GSTACK_ROOT:-$HOME/.pi/agent/skills/gstack}"' },
  // 2. $GSTACK_BIN/ -> $GSTACK_ROOT/bin/
  { pat: /\$GSTACK_BIN\//g, rep: "$GSTACK_ROOT/bin/" },
  // 3. GSTACK_BIN="$GSTACK_ROOT/bin" -> keep definition intact (no-op matching)
  { pat: /GSTACK_BIN="\$GSTACK_ROOT\/bin"/g, rep: 'GSTACK_BIN="$GSTACK_ROOT/bin"' },
  // 4. bun run ./scripts/... -> bun run "$GSTACK_ROOT/scripts/..."
  { pat: /bun run \.\/scripts\//g, rep: 'bun run "$GSTACK_ROOT/scripts/' },
  // 5. ./setup -> cd "$GSTACK_ROOT" && ./setup (implicit /SKILL_DIR setups)
  { pat: /cd <SKILL_DIR> && \.\/setup/g, rep: 'cd "$GSTACK_ROOT" && ./setup' },
  { pat: /(&& \.\/setup)(?!["'])/g, rep: '&& cd "$GSTACK_ROOT" && ./setup' },
];

function main() {
  const repoSkillsDir = join(gstackRoot, ".pi", "skills");
  const localSkillsDir = join(gstackPiRoot, "skills");
  const srcSkillsDir = existsSync(repoSkillsDir) ? repoSkillsDir : localSkillsDir;
  // gstack skills land nested under skills/gstack/ (kedra/gstack split)
  const dstSkillsDir = join(localSkillsDir, "gstack");

  if (!existsSync(srcSkillsDir)) {
    console.error(`Error: No skills found. Tried:\n  ${repoSkillsDir}\n  ${localSkillsDir}\nRun \`bun run gen:skill-docs\` in source/ first.`);
    process.exit(1);
  }
  console.log(`Skills source: ${srcSkillsDir}`);

  // 1. Stale protection
  const genScript = join(gstackRoot, "scripts", "gen-skill-docs.ts");
  const rootSkillMd = join(srcSkillsDir, "gstack", "SKILL.md");
  if (existsSync(genScript) && existsSync(rootSkillMd)) {
    const genMtime = statSync(genScript).mtimeMs;
    const skillMtime = statSync(rootSkillMd).mtimeMs;
    if (genMtime > skillMtime) {
      console.warn("\x1b[33m%s\x1b[0m", `\nWARN: gstack/.pi/skills may be stale. Run "bun run gen:skill-docs:user" in gstack/ first!\n`);
    }
  }

  mkdirSync(dstSkillsDir, { recursive: true });

  for (const name of INCLUDE) {
    const srcSubdir = name === "gstack" ? "gstack" : `gstack-${name}`;
    const srcDir = join(srcSkillsDir, srcSubdir);
    const srcFile = join(srcDir, "SKILL.md");

    if (!existsSync(srcFile)) {
      console.error(`Error: Required source file missing at ${srcFile}`);
      process.exit(1);
    }

    const dstDir = join(dstSkillsDir, name);
    mkdirSync(dstDir, { recursive: true });
    const dstFile = join(dstDir, "SKILL.md");

    let content = readFileSync(srcFile, "utf8");

    // Clean frontmatter keeping name and description
    content = cleanFrontmatter(content, name);

    // Apply rewrites
    for (const r of REWRITES) {
      content = content.replace(r.pat, r.rep);
    }

    writeFileSync(dstFile, content, "utf8");

    // Verify rewrite 1: count occurrences of $GSTACK_BIN/ -> must be 0
    if (content.includes("$GSTACK_BIN/")) {
      console.error(`Error: Post-check failed on ${dstFile}. File still contains '$GSTACK_BIN/'.`);
      process.exit(1);
    }
  }

  console.log(`Successfully synced and translated ${INCLUDE.length} skills!`);
}

function cleanFrontmatter(content: string, expectedName: string): string {
  if (!content.startsWith("---")) return content;
  const endMarker = content.indexOf("---", 3);
  if (endMarker === -1) return content;

  const fmText = content.slice(3, endMarker);
  const rest = content.slice(endMarker + 3);

  // Loose parse YAML-like key-value pairs
  const lines = fmText.split(/\r?\n/);
  let name = "";
  let descriptionLines: string[] = [];
  let inDesc = false;

  for (const line of lines) {
    const naked = line.trim();
    if (!naked) continue;

    if (naked.startsWith("name:")) {
      inDesc = false;
      name = naked.slice(5).trim();
    } else if (naked.startsWith("description:")) {
      inDesc = true;
      const restLine = naked.slice(12).trim();
      if (restLine && restLine !== "|") {
        descriptionLines.push(restLine);
      }
    } else if (inDesc && (naked.startsWith(" ") || line.startsWith("  ") || line.startsWith("\t"))) {
      descriptionLines.push(line);
    } else {
      inDesc = false;
    }
  }

  // Strip trailing tag from description if present
  let descText = descriptionLines.join("\n");
  if (descText.endsWith(" (gstack)")) {
    descText = descText.slice(0, -9);
  }

  // Validate frontmatter name matches expected folder name
  if (name !== expectedName) {
    console.error(`Frontmatter name mismatch: got '${name}', expected '${expectedName}'`);
    process.exit(1);
  }

  const cleanFm = `---
name: ${name}
description: |
${descriptionLines.map(l => "  " + l.trimStart()).join("\n")}
---`;

  return cleanFm + rest;
}

main();
