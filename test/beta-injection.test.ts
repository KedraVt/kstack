// Canonical flat-catalog resolution (S1/D6+D13).
//
// Contract: every registry id resolves to exactly one skills/<dir>/SKILL.md;
// loadSkillSource returns that file in both modes (it is already
// distilled-size — the env flag is retained for compat); loadSkillGate parses
// the literal "## DoD gate" section out of the file. A missing file degrades
// to null — never breaks a run.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  getSkillIds,
  getSkillInfo,
  loadSkillFull,
  loadSkillGate,
  loadSkillSource,
} from "../orchestrator/skills.ts";
import { skillInjectionMode } from "../orchestrator/config.ts";

const KEY = "GSTACK_PI_SKILL_INJECTION";

describe("canonical catalog resolution", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  test("default mode is full; digest opt-in still parses", () => {
    assert.equal(skillInjectionMode(), "full");
    process.env[KEY] = "digest";
    assert.equal(skillInjectionMode(), "digest");
    process.env[KEY] = "nonsense";
    assert.equal(skillInjectionMode(), "full");
  });

  test("every registry id maps to an existing canonical skills/<dir>/SKILL.md", () => {
    for (const id of getSkillIds()) {
      const info = getSkillInfo(id)!;
      assert.ok(info.skillPath.includes("skills"), `${id} path outside skills/: ${info.skillPath}`);
      assert.ok(!info.skillPath.includes("sprint-beta"), `${id} still mapped to sprint-beta`);
      assert.ok(existsSync(info.skillPath), `${id} canonical file missing: ${info.skillPath}`);
    }
  });

  test("both modes return the same canonical file (single source)", () => {
    const full = loadSkillSource("gstack-sprint-qa", "full");
    const digest = loadSkillSource("gstack-sprint-qa", "digest");
    assert.ok(full, "canonical source missing for gstack-sprint-qa");
    assert.equal(full, digest);
    assert.match(full!, /name: gstack-qa/); // sprint id → canonical dir
  });

  test("full mode and loadSkillFull agree on the source", () => {
    assert.equal(loadSkillSource("gstack-ship", "full"), loadSkillFull("gstack-ship"));
    assert.match(loadSkillFull("gstack-ship")!, /name: gstack-ship/);
  });

  test("merged ids resolve to their canonical dir", () => {
    for (const [id, dir] of [
      ["gstack-document-release", "gstack-document"],
      ["gstack-document-generate", "gstack-document"],
      ["gstack-sprint-appsec", "gstack-cso"],
      ["gstack-sprint-capability", "product-capability"],
    ] as const) {
      const info = getSkillInfo(id)!;
      assert.ok(info.skillPath.includes(`${dir}\\SKILL.md`) || info.skillPath.includes(`${dir}/SKILL.md`), `${id} → ${info.skillPath}`);
      assert.match(loadSkillFull(id)!, new RegExp(`name: ${dir}`));
    }
  });

  test("loadSkillGate parses the ## DoD gate section", () => {
    const gate = loadSkillGate("gstack-review")!;
    assert.match(gate, /DoD gate: gstack-review/);
    assert.match(gate, /code-review ==/);
    assert.ok(!gate.includes("## Bundled files"), "gate swallowed the next section");
  });

  test("unknown id degrades to null in both modes (never throws)", () => {
    assert.equal(loadSkillFull("no-such-skill"), null);
    assert.equal(loadSkillSource("no-such-skill", "full"), null);
    assert.equal(loadSkillSource("no-such-skill", "digest"), null);
    assert.equal(loadSkillGate("no-such-skill"), null);
  });
});
