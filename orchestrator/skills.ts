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
 * GSTACK_PI_SKILL_INJECTION=full is now a no-op kept for config compat:
 * the canonical file is always the injected methodology (it is already the
 * distilled-size form). A missing skill file must never break a run — all
 * loaders degrade to null and callers fall back to generic instructions.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillInjectionMode } from "./config.ts";

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
  /** Directory under skills/ holding the canonical SKILL.md. Defaults to
   *  the registry id itself when omitted. */
  dir?: string;
}

const REGISTRY: Record<string, RegistryEntry> = {
  "gstack-investigate": {
    summary: "Systematic debugging: Iron Law (no fixes without root cause), hypothesis testing, structured debug report",
  },
  "gstack-review": {
    summary: "Pre-landing review: scope drift detection, severity-classified findings, completeness gaps",
  },
  "gstack-qa": {
    summary: "Browser QA: test like a real user, severity-classified bug reports, evidence screenshots",
  },
  "gstack-ship": {
    summary: "Release pipeline: pre-flight checks, test gates, TODOS.md management, atomic commits, PR discipline",
  },
  "gstack-office-hours": {
    summary: "Product judgment for planning: premise-challenge, specificity, wedge thinking, scope ambition",
  },
  "gstack-plan-eng-review": {
    summary: "Engineering rigor for plans: blast radius, hidden assumptions, edge cases, test strategy",
  },
  "gstack-document-release": {
    dir: "gstack-document",
    summary: "Post-ship docs: Diataxis coverage map, factual updates from the diff, stale-reference sweep",
  },
  "gstack-document-generate": {
    dir: "gstack-document",
    summary: "Author missing documentation: codebase archaeology first, Diataxis partitioning, reference-first writing",
  },
  "grilling": {
    summary: "Interview protocol: design-tree rounds over the frontier, recommended answers, facts-vs-decisions split",
  },
  "gstack-fix-strategy": {
    summary: "Minimal-fix strategy for a CONFIRMED root cause: validation-first, minimal diff, regression test per fix",
  },

  // --- sprint workflow digests (canonical kedra ports, S1) ---
  "gstack-sprint-capability": {
    dir: "product-capability",
    summary: "User-story writing + story→engineering-constraints translation: boolean-checkable invariants, explicit trust boundaries, non-goals",
  },
  "gstack-sprint-system-design": {
    dir: "system-design",
    summary: "DDD system design: binding ubiquitous-language glossary, aggregates with boolean invariants, context mapping, contract immutability",
  },
  "gstack-sprint-adr": {
    dir: "adr",
    summary: "Architecture decision records: decision/context/consequences format, append-only sprint log",
  },
  "gstack-sprint-tasks": {
    dir: "tasks",
    summary: "Atomic task backlog: inputs/payloads/constraints/unhappy-paths/falsifiable success conditions, role-assigned with dependencies",
  },
  "gstack-sprint-tdd": {
    dir: "test-driven-development",
    summary: "Test-first discipline: red-green-refactor, AAA structure, prove-it bug reproduction, anti-pattern avoidance",
  },
  "gstack-sprint-verification": {
    dir: "verification-before-completion",
    summary: "Iron Law: completion claims require fresh verification evidence — run it now, read the output, cite it",
  },
  "gstack-sprint-appsec": {
    dir: "gstack-cso",
    summary: "AppSec review: STRIDE-lite threat model over new trust boundaries, secrets hygiene, injection prevention, actionable remediations",
  },
  "gstack-sprint-docker": {
    dir: "docker-manager",
    summary: "Conditional Docker audit: multi-stage builds, pinned bases, non-root runtime, resource limits, network isolation",
  },
  "gstack-sprint-qa": {
    dir: "gstack-qa",
    summary: "QA triage GREEN/RED/ORANGE, Testability Blockers, Save-Point git pattern, evidence-first reporting",
  },
  "gstack-sprint-pipeline": {
    dir: "pipeline-sre",
    summary: "Conditional CI/CD authoring audit: least privilege, pinned versions, vault secrets, reproducible builds, rollback story",
  },
};

export function getSkillIds(): string[] {
  return Object.keys(REGISTRY);
}

export function getSkillInfo(id: string): SkillInfo | null {
  const entry = REGISTRY[id];
  if (!entry) return null;
  const dir = entry.dir ?? id;
  const skillPath = join(SKILLS_DIR, dir, "SKILL.md");
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

/**
 * Mode-aware methodology source. Post-S1 the canonical SKILL.md is the
 * single source for both modes — it is already distilled-size. The mode
 * argument is retained for config compat (GSTACK_PI_SKILL_INJECTION).
 */
export function loadSkillSource(id: string, _mode: SkillInjectionMode): string | null {
  return readSkill(id);
}

/** Compact index of all bundled skills, for optional deep consultation by the agent. */
export function buildSkillIndex(): string {
  const lines: string[] = ["Available gstack skills (read the full SKILL.md only if you need depth beyond your current instructions):"];
  for (const id of getSkillIds()) {
    const info = getSkillInfo(id)!;
    lines.push(`- ${id}: ${info.summary} (full doc: ${info.skillPath})`);
  }
  return lines.join("\n");
}
