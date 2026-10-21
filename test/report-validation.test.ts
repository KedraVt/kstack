// Write-time verdict validation: the step's own record CLI (kstack-report)
// refuses an off-map value, a missing declared verdict and a security
// rejection without a severity — the step learns of the mistake at once
// instead of the phase parking on a distrusted record later.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { getWorkflow } from "../orchestrator/workflows.ts";
import { stepSpawnEnv } from "../orchestrator/repair.ts";
import { readStepRecord } from "../orchestrator/records.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kstack-report-validation-"));
const SCRIPT = new URL("../runtime/bin/kstack-report", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const HAS_BASH = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf-8" }).status === 0;

/** The spawn env of a CLI call — `undefined` removes a variable. */
function envWith(overrides: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Run kstack-report in a fresh cwd and return the spawn result + the cwd. */
function report(args: string[], overrides: Record<string, string | undefined> = {}) {
  const cwd = fs.mkdtempSync(path.join(TMP, "cli-"));
  // The CLI resolves its project root from --root, then $KSTACK_PROJECT_ROOT,
  // then the cwd. The host env may carry a KSTACK_PROJECT_ROOT of its own
  // (the orchestrator exports it), which would drop the record OUTSIDE the
  // fresh cwd this test reads back — so the test pins the root to its cwd.
  const env = envWith({ KSTACK_PROJECT_ROOT: cwd, ...overrides });
  const run = spawnSync("bash", [SCRIPT, ...args], { cwd, encoding: "utf-8", env });
  return { run, cwd };
}

const UI_STEP_ENV = {
  KSTACK_VERDICT_KEYS: "ui",
  KSTACK_VERDICT_VALUES: "ui=pass,fail",
  KSTACK_VERDICT_REQUIRED: "ui",
};

const SECURITY_STEP_ENV = {
  KSTACK_VERDICT_KEYS: "security-review severity",
  KSTACK_VERDICT_VALUES: "security-review=approved,rejected severity=green,orange,low,medium,red,critical,high",
  KSTACK_VERDICT_REQUIRED: "security-review",
};

describe("kstack-report verdict value validation", () => {
  test("an off-map verdict value is refused and no record is written", () => {
    if (!HAS_BASH) return; // no bash on this host
    const { run, cwd } = report(
      ["--workflow", "sprint", "--run-id", "r1", "--phase", "implement", "--step", "ui-check",
        "--verdict", "ui==maybe", "--summary", "done"],
      UI_STEP_ENV,
    );
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /ui==maybe/);
    assert.match(run.stderr, /pass \| fail/);
    assert.equal(readStepRecord(cwd, "sprint", "r1", "implement", "ui-check"), null, "no record was written");
    assert.ok(!fs.existsSync(path.join(cwd, ".kstack", "runs")), "no run dir was created");
  });

  test("a value on the map is accepted and the record is written", () => {
    if (!HAS_BASH) return; // no bash on this host
    const { run, cwd } = report(
      ["--workflow", "sprint", "--run-id", "r2", "--phase", "implement", "--step", "ui-check",
        "--verdict", "ui==pass", "--summary", "done"],
      UI_STEP_ENV,
    );
    assert.equal(run.status, 0, run.stderr);
    const rec = readStepRecord(cwd, "sprint", "r2", "implement", "ui-check");
    assert.deepEqual(rec?.verdicts, { ui: "pass" });
  });

  test("without KSTACK_VERDICT_VALUES the CLI behaves exactly as before", () => {
    if (!HAS_BASH) return; // no bash on this host
    const { run, cwd } = report(
      ["--workflow", "sprint", "--run-id", "r3", "--phase", "implement", "--step", "ui-check",
        "--verdict", "ui==maybe", "--summary", "done"],
      { KSTACK_VERDICT_KEYS: "ui", KSTACK_VERDICT_VALUES: undefined, KSTACK_VERDICT_REQUIRED: undefined },
    );
    assert.equal(run.status, 0, run.stderr);
    const rec = readStepRecord(cwd, "sprint", "r3", "implement", "ui-check");
    assert.deepEqual(rec?.verdicts, { ui: "maybe" }, "an unvalidated value is written as before");
  });

  test("a verdict the step does not own is still dropped with a warning", () => {
    if (!HAS_BASH) return; // no bash on this host
    const { run, cwd } = report(
      ["--workflow", "sprint", "--run-id", "r4", "--phase", "implement", "--step", "ui-check",
        "--verdict", "be-walk==pass", "--verdict", "ui==pass", "--summary", "done"],
      UI_STEP_ENV,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /ignoring --verdict 'be-walk'/);
    const rec = readStepRecord(cwd, "sprint", "r4", "implement", "ui-check");
    assert.deepEqual(rec?.verdicts, { ui: "pass" });
  });

  test("the step's declared verdict is mandatory", () => {
    if (!HAS_BASH) return; // no bash on this host
    const { run, cwd } = report(
      ["--workflow", "sprint", "--run-id", "r5", "--phase", "implement", "--step", "ui-check",
        "--marker", "UI-DONE", "--summary", "done"],
      UI_STEP_ENV,
    );
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /ui==<value>/);
    assert.equal(readStepRecord(cwd, "sprint", "r5", "implement", "ui-check"), null, "no record was written");
  });

  test("a security rejection without a severity is refused", () => {
    if (!HAS_BASH) return; // no bash on this host
    const { run, cwd } = report(
      ["--workflow", "sprint", "--run-id", "r6", "--phase", "devsecops-review", "--step", "security",
        "--verdict", "security-review==rejected", "--summary", "done"],
      SECURITY_STEP_ENV,
    );
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /severity/);
    assert.equal(readStepRecord(cwd, "sprint", "r6", "devsecops-review", "security"), null, "no record was written");
  });

  test("a security rejection WITH a severity is accepted", () => {
    if (!HAS_BASH) return; // no bash on this host
    const { run, cwd } = report(
      ["--workflow", "sprint", "--run-id", "r7", "--phase", "devsecops-review", "--step", "security",
        "--verdict", "security-review==rejected", "--verdict", "severity==high", "--summary", "done"],
      SECURITY_STEP_ENV,
    );
    assert.equal(run.status, 0, run.stderr);
    const rec = readStepRecord(cwd, "sprint", "r7", "devsecops-review", "security");
    assert.deepEqual(rec?.verdicts, { "security-review": "rejected", severity: "high" });
  });
});

describe("stepSpawnEnv publishes the verdict value map", () => {
  const phaseOf = (wf: string, id: string) => getWorkflow(wf)!.phases.find((p) => p.id === id)!;

  test("the devsecops-review code-review step publishes its accepted values", () => {
    const phase = phaseOf("sprint", "devsecops-review");
    const step = phase.steps!.find((s) => s.id === "code-review")!;
    const env = stepSpawnEnv("sprint", "r1", phase, step, ".");
    assert.equal(env.KSTACK_VERDICT_KEYS, "code-review");
    assert.equal(env.KSTACK_VERDICT_VALUES, "code-review=approved,rejected");
    assert.equal(env.KSTACK_VERDICT_REQUIRED, "code-review");
  });

  test("the devsecops-review security step publishes the severity values too", () => {
    const phase = phaseOf("sprint", "devsecops-review");
    const step = phase.steps!.find((s) => s.id === "security")!;
    const env = stepSpawnEnv("sprint", "r1", phase, step, ".");
    assert.equal(env.KSTACK_VERDICT_REQUIRED, "security-review");
    const map = new Map(
      env.KSTACK_VERDICT_VALUES.split(" ").map((entry) => {
        const at = entry.indexOf("=");
        return [entry.slice(0, at), entry.slice(at + 1)] as const;
      }),
    );
    assert.deepEqual(map.get("security-review")?.split(","), ["approved", "rejected"]);
    assert.deepEqual(
      new Set(map.get("severity")?.split(",")),
      new Set(["green", "orange", "low", "medium", "red", "critical", "high"]),
    );
  });

  test("a step that owns no verdict publishes no values and no required key", () => {
    const phase = phaseOf("sprint", "implement");
    const step = phase.steps!.find((s) => s.id === "backend")!;
    const env = stepSpawnEnv("sprint", "r1", phase, step, ".");
    assert.equal(env.KSTACK_VERDICT_KEYS, "");
    assert.equal(env.KSTACK_VERDICT_VALUES, "");
    assert.equal(env.KSTACK_VERDICT_REQUIRED, "");
  });
});
