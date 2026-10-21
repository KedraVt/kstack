/**
 * TASK_12 — the two verdict-validation channels must AGREE (ADR-34, ADR-52).
 *
 * There are two validators for a verdict value and they used to disagree:
 *
 *  1. the WRITE-time channel — `kstack-report` refuses a value that is not
 *     in the `KSTACK_VERDICT_VALUES` list the orchestrator published;
 *  2. the READ-time channel — `evaluateStepRecordTrust` (the repair's
 *     "can this record be trusted?" check) decided routability with the
 *     GLOBAL `NEGATIVE_VALUES` set, so it accepted values the CLI refused
 *     (e.g. `ui==rejected`, a value no expectation map answers).
 *
 * A step that learned the value is refused at write time and a step that
 * wrote it anyway was accepted at read time — the two channels must now
 * agree on every registry phase, key and value.
 *
 * The parity is asserted over the WHOLE registry (every workflow, every
 * phase, every verdict-flagged step, every key the step owns) and over a
 * value set that contains every value the runtime can produce: the routing
 * negatives, the expectation positives, the declared park/loop values and
 * one value that is on no map at all ("bogus").
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getAllWorkflows } from "../orchestrator/workflows.ts";
import { evaluateStepRecordTrust, stepSpawnEnv } from "../orchestrator/repair.ts";
import { acceptedVerdictValues } from "../orchestrator/verdict-values.ts";
import { expectationsFor, NEGATIVE_VALUES } from "../orchestrator/verdicts.ts";
import { verdictKeysFor, type StepRecord } from "../orchestrator/records.ts";
import { buildRecordContract } from "../orchestrator/templates.ts";
import type { WorkflowPhase, WorkflowStep } from "../orchestrator/types.ts";

/** Every value the runtime can produce for a key, plus one off-map value. */
function candidateValues(workflowId: string, phase: WorkflowPhase): string[] {
  const out = new Set<string>(["bogus"]);
  for (const v of NEGATIVE_VALUES) out.add(v);
  for (const list of Object.values(expectationsFor(workflowId, phase.id) ?? {})) {
    for (const v of list) out.add(v);
  }
  for (const v of Object.keys(phase.parkOn ?? {})) out.add(v);
  for (const v of Object.keys(phase.loopBackOn ?? {})) out.add(v);
  return [...out];
}

/** The expectation positives of a key (the optional `key?` form included). */
function expectationValues(workflowId: string, phase: WorkflowPhase, key: string): string[] {
  const exp = expectationsFor(workflowId, phase.id) ?? {};
  return [...(exp[key] ?? exp[`${key}?`] ?? [])];
}

/**
 * A record that carries every key the step owns, with the key under test
 * overridden. The other keys carry their first expectation positive so the
 * record is otherwise trustworthy.
 */
function recordWith(
  workflowId: string,
  phase: WorkflowPhase,
  step: WorkflowStep,
  key: string,
  value: string,
): StepRecord {
  const verdicts: Record<string, string> = {};
  for (const owned of verdictKeysFor(workflowId, phase, step)) {
    const positives = expectationValues(workflowId, phase, owned);
    verdicts[owned] = positives[0] ?? "";
  }
  verdicts[key] = value;
  return {
    workflow: workflowId,
    runId: "parity",
    phase: phase.id,
    step: step.id,
    summary: "parity probe",
    verdicts,
    vars: {},
    evidence: [],
    deliverables: [],
    markers: [],
  };
}

/** The published `KSTACK_VERDICT_VALUES` map of a step, parsed. */
function publishedValues(
  workflowId: string,
  phase: WorkflowPhase,
  step: WorkflowStep,
): Map<string, string> {
  const env = stepSpawnEnv(workflowId, "parity", phase, step, ".");
  const map = new Map<string, string>();
  for (const entry of (env.KSTACK_VERDICT_VALUES ?? "").split(" ").filter(Boolean)) {
    const at = entry.indexOf("=");
    map.set(entry.slice(0, at), entry.slice(at + 1));
  }
  return map;
}

describe("verdict parity — the repair and the CLI agree", () => {
  test("every registry phase, key and value: the repair accepts exactly what the CLI accepts", () => {
    let probes = 0;
    for (const workflow of getAllWorkflows()) {
      for (const phase of workflow.phases) {
        for (const step of phase.steps ?? []) {
          if (step.signal?.kind !== "verdict") continue;
          const owned = verdictKeysFor(workflow.id, phase, step);
          for (const key of owned) {
            const accepted = acceptedVerdictValues(workflow.id, phase, key, step.signal.value);
            for (const value of candidateValues(workflow.id, phase)) {
              probes++;
              const trust = evaluateStepRecordTrust(
                workflow.id,
                phase,
                step,
                recordWith(workflow.id, phase, step, key, value),
              );
              const repairAccepts = trust.ok;
              const cliAccepts = accepted.includes(value);
              assert.equal(
                repairAccepts,
                cliAccepts,
                `${workflow.id}.${phase.id}.${step.id} ${key}==${value}: repair=${repairAccepts} (${trust.cause ?? "ok"}) cli=${cliAccepts}`,
              );
              if (cliAccepts) {
                assert.notEqual(trust.cause, "unroutable", `${workflow.id}.${phase.id}.${step.id} ${key}==${value} is on the map but refused`);
                assert.notEqual(trust.cause, "foreign-verdict", `${workflow.id}.${phase.id}.${step.id} ${key}==${value} is owned but refused`);
              }
            }
          }
        }
      }
    }
    assert.ok(probes > 0, "the parity probe must have exercised the registry");
  });

  test("the CLI's published list is exactly acceptedVerdictValues for every owned key", () => {
    for (const workflow of getAllWorkflows()) {
      for (const phase of workflow.phases) {
        for (const step of phase.steps ?? []) {
          if (step.signal?.kind !== "verdict") continue;
          const published = publishedValues(workflow.id, phase, step);
          for (const key of verdictKeysFor(workflow.id, phase, step)) {
            const expected = acceptedVerdictValues(workflow.id, phase, key, step.signal.value).join(",");
            assert.equal(
              published.get(key) ?? "",
              expected,
              `${workflow.id}.${phase.id}.${step.id} publishes a different list for '${key}'`,
            );
          }
        }
      }
    }
  });

  test("the record contract lists exactly the accepted values of every owned key", () => {
    for (const workflow of getAllWorkflows()) {
      for (const phase of workflow.phases) {
        for (const step of phase.steps ?? []) {
          if (step.signal?.kind !== "verdict") continue;
          const contract = buildRecordContract(step, { workflowId: workflow.id, phase });
          for (const key of verdictKeysFor(workflow.id, phase, step)) {
            const expected = acceptedVerdictValues(workflow.id, phase, key, step.signal.value).join("|");
            assert.ok(
              contract.includes(`--verdict ${key}==<${expected}>`),
              `${workflow.id}.${phase.id}.${step.id} contract does not list ${key}==<${expected}>`,
            );
          }
        }
      }
    }
  });
});

describe("verdict parity — the known divergence is closed", () => {
  test("a value the CLI refuses is refused by the repair too", () => {
    const sprint = getAllWorkflows().find((w) => w.id === "sprint")!;
    const phase = sprint.phases.find((p) => p.id === "implement")!;
    const step = phase.steps!.find((s) => s.id === "ui-check") ?? phase.steps!.find((s) => s.id === "ui")!;
    const key = verdictKeysFor("sprint", phase, step)[0];
    const trust = evaluateStepRecordTrust("sprint", phase, step, recordWith("sprint", phase, step, key, "rejected"));
    assert.equal(trust.ok, false, "the repair must not accept a value the CLI refuses");
    assert.equal(trust.cause, "unroutable");
    assert.ok(
      !acceptedVerdictValues("sprint", phase, key, step.signal!.value).includes("rejected"),
      "'rejected' answers no expectation of this phase",
    );
  });
});
