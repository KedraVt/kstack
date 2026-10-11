/**
 * Skill ingestion for the workflow orchestrator.
 *
 * The orchestrator (not the model) decides when skill knowledge is needed:
 *  - main-execution phases get the FULL canonical SKILL.md injected;
 *  - subagent phases get the full skill inside the specialist's task string,
 *    while orchestrator instructions carry only the compact DoD gate
 *    (definition of done + best practices) needed to verify their output;
 *  - repeat deliveries within one workflow run degrade to the DoD gate too.
 *
 * SINGLE SOURCE (S1/D6+D13): every registry id maps to exactly one canonical
 * skill file at skills/<dir>/SKILL.md. The gate is parsed out of that file's
 * literal "## DoD gate" section by loadSkillGate — there is no separate
 * distilled layer, no inline dod field, and no per-layer path mapping.
 *
 * The canonical file is always the injected methodology (it is already the
 * distilled-size form). A missing skill file must never break a run — all
 * loaders degrade to null and callers fall back to generic instructions.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_ROOT = join(here, "..");
export const SKILLS_DIR = join(EXTENSION_ROOT, "skills");

export interface SkillInfo {
  id: string;
  /** One-line description of what the skill contributes to a phase. */
  summary: string;
  /** Absolute path of the canonical skills/<dir>/SKILL.md. */
  skillPath: string;
}

interface RegistryEntry {
  summary: string;
}

/**
 * Compact one-liner from a SKILL.md's YAML frontmatter `description` —
 * folded scalars (`>-`, `|`) flatten to one line, then cap at ~140 chars
 * on a word boundary (buildSkillIndex renders it verbatim).
 */
function skillSummary(content: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!fm) return "(no description)";
  const lines = fm[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^description:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const parts: string[] = [];
    const inline = m[1].replace(/^(>-?|\|[-+]?)\s*$/, "").trim();
    if (inline) parts.push(inline);
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^\s+\S/.test(l)) parts.push(l.trim());
      else break;
    }
    const desc = parts.join(" ").replace(/\s+/g, " ").trim();
    return desc.length > 140 ? `${desc.slice(0, 137).replace(/\s\S*$/, "")}…` : desc || "(no description)";
  }
  return "(no description)";
}

/**
 * S4/TASK_08 derived registry (ADR: skills/ is the ONLY registry source):
 * `skills/` scanned at load; every dir holding a SKILL.md is a registry id
 * (id = dir name). No aliases — callers use the canonical dir name.
 * A missing/unreadable skills dir degrades to an empty registry, never throws.
 */
function scanRegistry(): Record<string, RegistryEntry> {
  const registry: Record<string, RegistryEntry> = {};
  let dirs: string[] = [];
  try {
    dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return registry;
  }
  for (const dir of dirs) {
    const skillPath = join(SKILLS_DIR, dir, "SKILL.md");
    try {
      if (!existsSync(skillPath)) continue;
      registry[dir] = { summary: skillSummary(readFileSync(skillPath, "utf-8")) };
    } catch {
      registry[dir] = { summary: "(unreadable SKILL.md)" };
    }
  }
  return registry;
}

const REGISTRY: Record<string, RegistryEntry> = scanRegistry();

export function getSkillIds(): string[] {
  return Object.keys(REGISTRY);
}

export function getSkillInfo(id: string): SkillInfo | null {
  const entry = REGISTRY[id];
  if (!entry) return null;
  const skillPath = join(SKILLS_DIR, id, "SKILL.md");
  return { id, summary: entry.summary, skillPath };
}

function readSkill(id: string): string | null {
  const info = getSkillInfo(id);
  if (!info) return null;
  try {
    if (!existsSync(info.skillPath)) return null;
    const content = readFileSync(info.skillPath, "utf-8").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/**
 * Parse the literal `## DoD gate` section out of the canonical SKILL.md —
 * the compact verification contract injected into orchestrator instructions
 * and repeat deliveries (D13). Returns null when the skill or the section
 * is missing; callers degrade gracefully.
 */
export function loadSkillGate(id: string): string | null {
  const content = readSkill(id);
  if (!content) return null;
  const lines = content.split("\n");
  const start = lines.findIndex((l) => /^## DoD gate/.test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  const gate = rest.slice(0, end === -1 ? undefined : end).join("\n").trim();
  return gate ? `## DoD gate: ${id}\n${gate}` : null;
}

/** Load the full canonical SKILL.md for a registry id. */
export function loadSkillFull(id: string): string | null {
  return readSkill(id);
}

/** Compact index of all bundled skills, for optional deep consultation by the agent. */
export function buildSkillIndex(): string {
  const lines: string[] = ["Available kstack skills (read the full SKILL.md only if you need depth beyond your current instructions):"];
  for (const id of getSkillIds()) {
    const info = getSkillInfo(id)!;
    lines.push(`- ${id}: ${info.summary} (full doc: ${info.skillPath})`);
  }
  return lines.join("\n");
}
