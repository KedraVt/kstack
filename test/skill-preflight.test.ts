import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Mechanical pre-flight from .devin/skills/authoring-skills/references/pre-flight.md.
// Structural rules run over the whole catalog; the router rules run over the skills
// whose descriptions the trigger eval actually measured (see evals/trigger/*.json).

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const skillsDir = path.join(root, "skills");
const skillIds = fs.readdirSync(skillsDir).filter((d) => fs.existsSync(path.join(skillsDir, d, "SKILL.md")));

// Skills whose description was re-authored and measured by the trigger eval.
const ROUTER_AUDITED = new Set([
  "kstack-design-taste-frontend",
  "kstack-grilling",
  "kstack-idea-refine",
  "kstack-impeccable",
  "kstack-investigate",
  "kstack-office-hours",
  "kstack-qa",
  "kstack-triage",
]);

const ALLOWED_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const HARNESS_EXTRAS = new Set(["disable-model-invocation"]);

function frontmatter(id: string): { body: string; raw: string } {
  const text = fs.readFileSync(path.join(skillsDir, id, "SKILL.md"), "utf-8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(m, `${id}: SKILL.md has no YAML frontmatter`);
  return { body: m![1], raw: text };
}

function descriptionOf(body: string): string {
  const folded = /description:\s*(?:>[-+]?)\r?\n([\s\S]*?)(?=\r?\n[a-z-]+:|$)/.exec(body);
  if (folded) return folded[1].replace(/\r?\n\s+/g, " ").trim();
  const quoted = /description:\s*"([^"]*)"/.exec(body);
  if (quoted) return quoted[1].trim();
  return (/description:\s*(.+)$/m.exec(body)?.[1] ?? "").trim();
}

describe("skill pre-flight (authoring-skills)", () => {
  test("every skill: name matches its directory, frontmatter keys are allowed, description is legal", () => {
    for (const id of skillIds) {
      const { body } = frontmatter(id);
      const name = /^name:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? "";
      assert.equal(name, id, `${id}: frontmatter name must equal the directory name`);
      assert.match(name, /^[a-z0-9-]+$/, `${id}: name charset`);
      assert.ok(name.length <= 64, `${id}: name longer than 64 chars`);

      for (const key of body.split(/\r?\n(?=[a-z-]+:)/).map((l) => l.split(":")[0]).filter((k) => /^[a-z-]+$/.test(k))) {
        assert.ok(ALLOWED_KEYS.has(key) || HARNESS_EXTRAS.has(key), `${id}: unexpected frontmatter key "${key}"`);
      }

      const desc = descriptionOf(body);
      assert.ok(desc.length > 0, `${id}: empty description`);
      assert.ok(desc.length <= 1024, `${id}: description is ${desc.length} chars (cap 1024)`);
      assert.doesNotMatch(desc, /[<>]/, `${id}: description contains < or >`);
    }
  });

  test("every skill: no README/CHANGELOG/QUICK_REFERENCE, references stay one level deep", () => {
    for (const id of skillIds) {
      const dir = path.join(skillsDir, id);
      for (const entry of fs.readdirSync(dir)) {
        assert.doesNotMatch(entry, /^(README|CHANGELOG|QUICK_REFERENCE)/i, `${id}: ${entry} does not belong in a skill folder`);
        if (!fs.statSync(path.join(dir, entry)).isDirectory()) continue;
        if (entry === "references") {
          for (const sub of fs.readdirSync(path.join(dir, entry))) {
            assert.ok(!fs.statSync(path.join(dir, entry, sub)).isDirectory(), `${id}: references/${sub}/ is nested — flatten it`);
          }
        }
      }
    }
  });

  test("every skill: SKILL.md carries a DoD gate and a provenance comment", () => {
    for (const id of skillIds) {
      const text = fs.readFileSync(path.join(skillsDir, id, "SKILL.md"), "utf-8");
      assert.ok(text.includes("## DoD gate"), `${id}: missing "## DoD gate" section`);
      assert.match(text, /<!--\s*provenance/i, `${id}: missing the provenance comment`);
    }
  });

  test("every skill: body under 500 lines; audited skills keep a table of contents in long references", () => {
    for (const id of skillIds) {
      const text = fs.readFileSync(path.join(skillsDir, id, "SKILL.md"), "utf-8");
      assert.ok(text.split(/\r?\n/).length <= 500, `${id}: SKILL.md is over 500 lines`);
      if (!ROUTER_AUDITED.has(id)) continue;
      const refs = path.join(skillsDir, id, "references");
      if (!fs.existsSync(refs)) continue;
      for (const f of fs.readdirSync(refs).filter((x) => x.endsWith(".md"))) {
        const body = fs.readFileSync(path.join(refs, f), "utf-8");
        if (body.split(/\r?\n/).length <= 300) continue;
        assert.match(body, /^#{2,4}\s+(Contents|Table of contents)\s*$/m, `${id}/references/${f}: over 300 lines without a table of contents`);
      }
    }
  });

  test("audited skills: the description is a third-person router with triggers and boundaries", () => {
    for (const id of ROUTER_AUDITED) {
      const { body } = frontmatter(id);
      const desc = descriptionOf(body);
      assert.doesNotMatch(desc, /\b(I can|You can|I'll|We can)\b/, `${id}: description is not third person`);
      assert.match(desc, /Use (when|whenever|for)\b/i, `${id}: description has no "Use when" clause`);
      assert.match(desc, /"[^"]{6,}"/, `${id}: description quotes no user utterance`);
      assert.match(desc, /Do NOT use/i, `${id}: description has no boundary clause`);
    }
  });
});
