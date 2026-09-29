/**
 * scripts/adapt-skills.ts — Translate upstream gstack SKILL.md (Claude-targeted) into
 * pi-adapted skills. This replaces the gen-skill-docs/pi-host pipeline that used to
 * live in a separate dev clone: everything needed now ships inside this extension.
 *
 * Pipeline per skill (SKILLS list read from update.sh):
 *   input : source/<skill>/SKILL.md            (raw upstream, references ~/.claude/skills/gstack)
 *   output: skills/gstack/<gstack-skill>/SKILL.md  (pi frontmatter + adapter note + rewritten paths)
 *
 * Usage:
 *   bun run scripts/adapt-skills.ts           adapt all skills, write changed files
 *   bun run scripts/adapt-skills.ts --check   dry-run: report diffs, write nothing
 *   bun run scripts/adapt-skills.ts gstack-cso gstack-qa   restrict to listed skills
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const EXT_ROOT = resolve(here, "..");
// GSTACK_REPO is canonical; GSTACK_SOURCE_DIR accepted as alias (matches gen-tools.ts).
const SOURCE_DIR_RAW = process.env.GSTACK_REPO || process.env.GSTACK_SOURCE_DIR;
const SOURCE_DIR = SOURCE_DIR_RAW ? resolve(SOURCE_DIR_RAW) : join(EXT_ROOT, "source");
// gstack skills are nested one level down (skills/gstack/) so the same root can
// also host skills/kedra/ (.agents-clean raw sources) without name conflicts.
const SKILLS_OUT_DIR = join(EXT_ROOT, "skills", "gstack");

// Absolute targets baked into adapted docs (forward slashes: valid in bash snippets on Windows).
const EXT_URI = EXT_ROOT.replace(/\\/g, "/");
const RUNTIME_BIN = `${EXT_URI}/runtime/bin`;
const SOURCE_BIN = `${EXT_URI}/source/bin`;
const SOURCE_ROOT = `${EXT_URI}/source`;
const RUNTIME_BROWSE = `${EXT_URI}/runtime/browse/dist/browse`;
const RUNTIME_DESIGN = `${EXT_URI}/runtime/design/dist/design`;
const FEATURE_MARKERS_DIR = join(homedir(), ".gstack").replace(/\\/g, "/");

// Scripts that import ../lib — must be invoked from source/bin so bun resolves their deps.
const TS_BIN_SCRIPTS = [
  "gstack-brain-cache",
  "gstack-decision-log",
  "gstack-decision-search",
  "gstack-learnings-log",
  "gstack-question-log",
  "gstack-redact",
  "gstack-telemetry-log",
];

const UPSTREAM_URL = "https://github.com/garrytan/gstack";

// Skill names referenced as pi commands get rewritten `/name` -> `/skill:gstack-name`.
// Vocabulary mirrors the full upstream skill set the adapter recognizes (superset of
// the 23 shipped skills: preambles cross-reference skills we don't vendor).
const PREFIX_SKILL_NAMES = [
  "autoplan", "benchmark", "browse", "canary", "careful", "codex",
  "context-restore", "context-save", "cso", "design-consultation",
  "design-review", "design-shotgun", "devex-review", "document-generate",
  "document-release", "freeze", "guard", "health", "investigate",
  "land-and-deploy", "learn", "make-pdf", "office-hours",
  "open-gstack-browser", "plan-ceo-review", "plan-design-review",
  "plan-devex-review", "plan-eng-review", "plan-tune", "qa-only", "qa",
  "retro", "review", "scrape", "setup-browser-cookies", "setup-deploy",
  "setup-gbrain", "ship", "skillify", "spec", "sync-gbrain", "unfreeze",
];

// Longest-first so /qa never matches inside /qa-only.
const SORTED_PREFIX_NAMES = [...PREFIX_SKILL_NAMES].sort((a, b) => b.length - a.length);

/** Rewrite bare `/name` skill references to pi command form `/skill:gstack-name`. */
function rewriteSkillRefs(text: string): string {
  for (const name of SORTED_PREFIX_NAMES) {
    // Not preceded by word char, ':', '/', '-', '.', or '>' (so ../freeze and
    // <gstack-install>/browse never match); not followed by word char, '-' (qa-only),
    // or '(' (retro's "/ship(12)" examples).
    const re = new RegExp(`(?<![\\w:\\-/\\.>])/${name}(?![\\w-(])`, "g");
    text = text.replace(re, `/skill:gstack-${name}`);
  }
  return text;
}

// Doc paths referenced relative to the repo root get baked to the vendored checkout.
// (Only skill dirs — upstream keeps `scripts/...` refs bare on purpose.)
const REL_DOC_DIRS = new Set(PREFIX_SKILL_NAMES);

// Bespoke preamble patches the old pi generator applied (stable shared boilerplate).
const SENTENCE_PATCHES: Array<[RegExp, string]> = [
  [
    /When the user's request matches an available skill, invoke it via the Skill tool\. When in doubt, invoke the skill\./g,
    "When the user's request matches an available skill, invoke it via the Pi skill command (`/skill:name`). When in doubt, invoke the skill.",
  ],
  [
    /Then commit the change: `git add CLAUDE\.md && git commit -m "chore: add gstack skill routing rules to CLAUDE\.md"`/g,
    "Pi adapter: if the user approves routing rules, append them to `AGENTS.md` or `CLAUDE.md`, but do not commit unless the user explicitly asks.",
  ],
  [
    /If output shows `UPGRADE_AVAILABLE <old> <new>`: read `[^`]*gstack-upgrade\/SKILL\.md` and follow the "Inline upgrade flow" \(auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined\)\./g,
    "If output shows `UPGRADE_AVAILABLE <old> <new>`: use `/skill:gstack-upgrade` for the Pi-native update flow, or ask whether to run `/gstack-sync` and `/gstack-build`.",
  ],
];

/** Global phrase-level patches applied after skill-ref and path rewrites. */
const PHRASE_PATCHES: Array<[RegExp, string]> = [
  // Both sentence variants that point at Claude's Skill tool
  [/via the Skill tool/g, "via the Pi skill command (`/skill:name`)"],
];

// ---------------------------------------------------------------------------
// Skill list: parsed from update.sh (single source of truth)
// ---------------------------------------------------------------------------
function loadSkillList(): string[] {
  const sh = readFileSync(join(EXT_ROOT, "update.sh"), "utf8");
  const m = sh.match(/^SKILLS=\(([^)]*)\)/m);
  if (!m) throw new Error("SKILLS=(...) not found in update.sh");
  return m[1].split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Literal string replacement helpers
// ---------------------------------------------------------------------------
function replaceAll(s: string, needle: string, replacement: string): string {
  return s.split(needle).join(replacement);
}

/** Rewrite ~/.claude/skills/gstack paths to extension-local targets. */
function rewritePaths(body: string): string {
  let out = rewriteSkillRefs(body);

  for (const [re, rep] of SENTENCE_PATCHES) out = out.replace(re, rep);

  const claudeRoots = ["~/.claude/skills/gstack", "$HOME/.claude/skills/gstack", ".claude/skills/gstack"];

  // 1. TS-backed bin scripts -> source/bin (all ~, $HOME and project-relative forms)
  for (const n of TS_BIN_SCRIPTS) {
    for (const root of claudeRoots) {
      out = replaceAll(out, `${root}/bin/${n}`, `${SOURCE_BIN}/${n}`);
    }
  }

  // 2. Generic bin scripts -> runtime/bin
  for (const root of claudeRoots) {
    out = replaceAll(out, `${root}/bin/`, `${RUNTIME_BIN}/`);
  }

  // 3. Compiled artifacts -> runtime/
  for (const root of claudeRoots) {
    out = replaceAll(out, `${root}/browse/dist/browse`, RUNTIME_BROWSE);
    out = replaceAll(out, `${root}/design/dist/design`, RUNTIME_DESIGN);
  }

  // 4. Feature-prompted marker files -> shared state dir (~/.gstack), never inside the checkout
  for (const marker of [
    ".feature-prompted-continuous-checkpoint",
    ".feature-prompted-model-overlay",
  ]) {
    for (const root of claudeRoots) {
      out = replaceAll(out, `${root}/${marker}`, `${FEATURE_MARKERS_DIR}/${marker}`);
    }
  }

  // 5. Legacy variable forms
  out = replaceAll(out, "$GSTACK_BIN/", `${RUNTIME_BIN}/`);
  out = replaceAll(out, 'GSTACK_ROOT="$HOME/.claude/skills/gstack"', `GSTACK_ROOT="${SOURCE_ROOT}"`);
  out = replaceAll(out, "$GSTACK_ROOT/", `${SOURCE_ROOT}/`);

  // 6. Any remaining reference (docs, sections, scripts/) -> vendored source checkout
  out = replaceAll(out, "$HOME/.claude/skills/gstack", SOURCE_ROOT);
  out = replaceAll(out, "~/.claude/skills/gstack", SOURCE_ROOT);
  out = replaceAll(out, ".claude/skills/gstack", SOURCE_ROOT);

  // 7. Last catch-all: `.claude/skills/<name>/...` (unprefixed form) -> source/<name>/...
  //    EXCEPT inside the codex-disclaimer string, which legitimately names Claude's dirs.
  const DISCLAIMER = "~/.claude/, ~/.agents/, .claude/skills/";
  const MASK = "\u0000DISCLAIMER\u0000";
  out = replaceAll(out, DISCLAIMER, MASK);
  out = replaceAll(out, ".claude/skills/", `${SOURCE_ROOT}/`);
  out = replaceAll(out, MASK, DISCLAIMER);

  // 8. <SKILL_DIR> placeholders and backticked repo-relative doc paths -> source/
  //    (old generator emitted an unquoted cd)
  out = replaceAll(out, "cd <SKILL_DIR> && ./setup", `cd ${SOURCE_ROOT} && ./setup`);
  out = out.replace(
    /`([a-z][a-z0-9-]*)\/([a-zA-Z0-9_][a-zA-Z0-9_./-]*)`/g,
    (m, dir: string, rest: string) =>
      REL_DOC_DIRS.has(dir) ? `\`${SOURCE_ROOT}/${dir}/${rest}\`` : m,
  );

  // 9. Collapse accidental doubled absolute paths (legacy generator artifact)
  while (out.includes(`${SOURCE_ROOT}/C:/`)) {
    out = replaceAll(out, `${SOURCE_ROOT}/C:/Users/Mattia/.pi/agent/extensions/gstack-pi/source/`, `${SOURCE_ROOT}/`);
  }

  for (const [re, rep] of PHRASE_PATCHES) out = out.replace(re, rep);
  return out;
}

// ---------------------------------------------------------------------------
// Frontmatter handling
// ---------------------------------------------------------------------------
function parseRawFrontmatter(text: string): { fmName: string; descLines: string[]; bodyStart: number } | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = text.slice(0, end);
  const nameM = block.match(/^name:\s*(.+)$/m);
  const descLines: string[] = [];
  let inDesc = false;
  for (const line of block.split(/\r?\n/)) {
    if (/^description:\s*/.test(line)) {
      inDesc = true;
      const rest = line.replace(/^description:\s*/, "");
      if (rest) descLines.push(rest);
    } else if (inDesc && /^\s+\S/.test(line)) {
      descLines.push(line.trim());
    } else if (inDesc) {
      inDesc = false;
    }
  }
  return { fmName: nameM ? nameM[1].trim() : "", descLines, bodyStart: end + "\n---".length };
}

function buildAdaptedFile(raw: string): string {
  const parsed = parseRawFrontmatter(raw);
  if (!parsed) throw new Error("missing frontmatter");
  const { fmName, bodyStart } = parsed;
  // Skill references inside descriptions get prefixed too (e.g. skillify mentions /scrape).
  const descLines = parsed.descLines.map((l) => rewriteSkillRefs(l));
  const body = raw.slice(bodyStart).replace(/^\r?\n/, "");

  const newFrontmatter = [
    "---",
    `name: gstack-${fmName}`,
    "description: |",
    ...descLines.map((l) => `  ${l}`),
    "license: MIT",
    "metadata:",
    `  upstream: ${UPSTREAM_URL}`,
    `  source: ${fmName}/SKILL.md`,
    "---",
  ].join("\n");

  const note = [
    "# Pi adapter note",
    "",
    `This skill was generated from Garry Tan's [gstack](${UPSTREAM_URL}) for Pi.`,
    "",
    "- Use Pi's lowercase tools (`read`, `bash`, `edit`, `write`) when the upstream skill says Read, Bash, Edit, or Write.",
    "- pi-gstack provides compatibility tools named `AskUserQuestion`, `Agent`, `Task`, `TodoWrite`, `ExitPlanMode`, and `gstack_safety` for upstream Claude Code workflows.",
    "- For best `Agent` / `Task` behavior, install Pi's native subagent package with `pi install npm:pi-subagents`. If the `subagent` tool is available, prefer it for independent specialist agents; otherwise pi-gstack's built-in `Agent` / `Task` fallback is supported.",
    `- gstack runtime path: \`${SOURCE_ROOT}\`. This adapter rewrites global \`~/.claude/skills/gstack\` and project \`.claude/skills/gstack\` references to that path and does not install anything into \`~/.claude\`.`,
    "- Browser, design, and PDF workflows need gstack's compiled binaries plus Bun/Playwright Chromium. If `/gstack-status` reports a missing or stale build, run `/gstack-build` once.",
  ].join("\n");

  return `${newFrontmatter}\n${note}\n\n${rewritePaths(body)}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const outIdx = args.indexOf("--out");
  const outOverride = outIdx !== -1 ? args[outIdx + 1] : undefined;
  const filter = args.filter((a, i) => !a.startsWith("--") && (outIdx === -1 || i !== outIdx + 1));
  const allSkills = loadSkillList();
  const skills = filter.length ? allSkills.filter((s) => filter.includes(s)) : allSkills;
  const outDir = outOverride ? resolve(outOverride) : SKILLS_OUT_DIR;

  let identical = 0;
  let updated = 0;
  const failures: string[] = [];

  for (const skill of skills) {
    // The root "gstack" skill is a bespoke router document maintained by hand in
    // skills/gstack/gstack/ — it is NOT derived from source/browse and must never be regenerated.
    if (skill === "gstack") {
      console.log(`preserve ${skill} (hand-maintained router, not upstream-derived)`);
      identical++;
      continue;
    }
    const srcDirName = skill.replace(/^gstack-/, "");
    const srcFile = join(SOURCE_DIR, srcDirName, "SKILL.md");
    const compareFile = join(SKILLS_OUT_DIR, skill, "SKILL.md");
    const dstFile = join(outDir, skill, "SKILL.md");
    try {
      if (!existsSync(srcFile)) throw new Error(`source missing: ${srcFile}`);
      const adapted = buildAdaptedFile(readFileSync(srcFile, "utf8"));

      if (outOverride || !existsSync(compareFile)) {
        mkdirSync(join(outDir, skill), { recursive: true });
      }

      if (!existsSync(compareFile)) {
        writeFileSync(dstFile, adapted, "utf8");
        console.log(`NEW      ${skill} (${adapted.length} bytes)`);
        updated++;
        continue;
      }
      const current = readFileSync(compareFile, "utf8");
      if (current === adapted) {
        if (outOverride) {
          // keep a copy in the out dir too, useful for side-by-side inspection
          writeFileSync(dstFile, adapted, "utf8");
        }
        identical++;
        continue;
      }
      // Count differing lines for the report
      const a = current.split("\n");
      const b = adapted.split("\n");
      let diffLines = 0;
      for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diffLines++;
      if (check && !outOverride) {
        console.log(`DIFFERS  ${skill}: ${diffLines} righe diverse su ${Math.max(a.length, b.length)}`);
      } else {
        mkdirSync(join(outDir, skill), { recursive: true });
        writeFileSync(dstFile, adapted, "utf8");
        console.log(`written  ${skill}: ${diffLines} righe differiscono dalla versione installata`);
      }
      updated++;
    } catch (e) {
      failures.push(skill);
      console.error(`ERROR    ${skill}: ${(e as Error).message}`);
    }
  }

  console.log(`\n${identical} identiche, ${updated} da scrivere${failures.length ? `, ${failures.length} errori: ${failures.join(", ")}` : ""}${check ? " [dry-run]" : ""}`);
  if (failures.length) process.exit(1);
}

main();
