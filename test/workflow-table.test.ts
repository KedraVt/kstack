/**
 * Guard for the generated workflow table: `orchestrator/README.md` is rendered
 * from the registry, so any drift between the two must fail the suite.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REGENERATE_CMD, loadCanonicalWorkflows, renderWorkflowTable } from "../scripts/gen-workflow-table.ts";
import { PHASE_TOOL_PROFILE } from "../orchestrator/toolmask.ts";

const README_PATH = fileURLToPath(new URL("../orchestrator/README.md", import.meta.url));

/** CRLF → LF: a checkout with autocrlf must not fail the byte comparison. */
function readReadme(): string {
  return readFileSync(README_PATH, "utf-8").replace(/\r\n/g, "\n");
}

describe("generated workflow table (orchestrator/README.md)", () => {
  test("README matches a fresh render of the registry", async () => {
    const workflows = await loadCanonicalWorkflows();
    const rendered = renderWorkflowTable(workflows);
    const onDisk = readReadme();
    if (onDisk !== rendered) {
      // Report the first divergent line instead of dumping both documents.
      const diskLines = onDisk.split("\n");
      const renderLines = rendered.split("\n");
      const at = renderLines.findIndex((line, i) => line !== diskLines[i]);
      const where =
        at === -1
          ? `the file carries ${diskLines.length - renderLines.length} extra line(s)`
          : `first difference at line ${at + 1}`;
      assert.fail(
        `orchestrator/README.md is out of date (${where}) — regenerate it with:\n  ${REGENERATE_CMD}\n`,
      );
    }
  });

  test("every registered workflow appears in the table", async () => {
    const workflows = await loadCanonicalWorkflows();
    const rendered = renderWorkflowTable(workflows);
    assert.ok(workflows.length > 0, "the registry is empty");
    for (const workflow of workflows) {
      assert.ok(
        rendered.includes(workflow.id),
        `workflow "${workflow.id}" is missing from orchestrator/README.md — regenerate with:\n  ${REGENERATE_CMD}\n`,
      );
      assert.ok(
        rendered.includes(`## ${workflow.id} — ${workflow.name}`),
        `workflow section "${workflow.id}" is missing from orchestrator/README.md — regenerate with:\n  ${REGENERATE_CMD}\n`,
      );
    }
  });

  test("the table renders the tool profile of every phase (TASK_03)", async () => {
    const workflows = await loadCanonicalWorkflows();
    const rendered = renderWorkflowTable(workflows);
    // The profile column comes from the SAME table the code uses — no
    // registry field, no second source of truth (ADR-45, W3).
    for (const workflow of workflows) {
      for (const phase of workflow.phases) {
        const expected = PHASE_TOOL_PROFILE[`${workflow.id}:${phase.id}`] ?? "full";
        const row = rendered
          .split("\n")
          .find((line) => line.startsWith(`| ${phase.id} — ${phase.name} `));
        assert.ok(row, `the phase "${workflow.id}:${phase.id}" is missing from the table`);
        const cells = row.split("|").map((c) => c.trim());
        assert.ok(
          cells.includes(expected),
          `the phase "${workflow.id}:${phase.id}" must render the profile "${expected}" — the row is: ${row}`,
        );
      }
    }
  });

  test("the render is deterministic and free of empty cells", async () => {
    const workflows = await loadCanonicalWorkflows();
    const first = renderWorkflowTable(workflows);
    const second = renderWorkflowTable(workflows);
    assert.equal(first, second, "renderWorkflowTable is not deterministic");
    for (const line of first.split("\n")) {
      if (!line.startsWith("| ") || line.startsWith("| ---")) continue;
      for (const cell of line.split("|").slice(1, -1)) {
        assert.notEqual(cell.trim(), "", `empty table cell in: ${line}`);
      }
    }
  });
});
