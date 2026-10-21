/**
 * Generates `orchestrator/README.md` from the workflow registry.
 *
 * The table is derived from `orchestrator/workflows.ts` (getAllWorkflows()) so
 * it can never drift from the code: `test/workflow-table.test.ts` fails
 * whenever the file on disk and a fresh render disagree.
 *
 * Regenerate: bun scripts/gen-workflow-table.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Workflow, WorkflowPhase, WorkflowStep } from "../orchestrator/types.ts";
import { PHASE_TOOL_PROFILE } from "../orchestrator/toolmask.ts";

/** Exact command a developer must run to refresh the generated file. */
export const REGENERATE_CMD = "bun scripts/gen-workflow-table.ts";

const OUT_FILE = new URL("../orchestrator/README.md", import.meta.url);
const EMPTY = "-";

/** Escape the only character that would break a markdown table cell. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function text(value: string | undefined): string {
  const v = (value ?? "").trim();
  return v.length > 0 ? v : EMPTY;
}

function entries(map: Record<string, string> | undefined): string {
  if (!map) return EMPTY;
  return Object.entries(map).map(([key, value]) => `${key}→${value}`).join(", ");
}

/** Join flag fragments; an empty set collapses to the dash placeholder. */
function join(parts: string[]): string {
  return parts.length > 0 ? parts.join("; ") : EMPTY;
}

/** Phase-level toggles and artifact contract. */
function phaseFlags(phase: WorkflowPhase): string[] {
  const flags: string[] = [];
  if (phase.optional) flags.push("optional");
  if (phase.enabled) flags.push(`enabled: ${phase.enabled}`);
  if (phase.failFast) flags.push("fail-fast");
  if (phase.produces?.length) flags.push(`produces: ${phase.produces.join(", ")}`);
  if (phase.needs?.length) flags.push(`needs: ${phase.needs.join(", ")}`);
  return flags;
}

/** Step-level conditions, capability gates and budget overrides. */
function stepFlags(step: WorkflowStep): string[] {
  const flags: string[] = [];
  if (step.skipWhen) flags.push(`skip ${step.skipWhen.var}=${step.skipWhen.equals}`);
  if (step.needsUser) flags.push("needs-user");
  if (step.sideEffect) flags.push("side-effect");
  if (step.ui) flags.push(`ui: ${step.ui}`);
  if (step.requires?.length) flags.push(`requires: ${step.requires.join(", ")}`);
  if (step.prefers?.length) flags.push(`prefers: ${step.prefers.join(", ")}`);
  if (step.ambientSkills?.length) flags.push(`ambient: ${step.ambientSkills.join(", ")}`);
  if (step.timeoutSec) flags.push(`timeout: ${step.timeoutSec}s`);
  return flags;
}

/** Phase-level routing: back-edges, ceilings, verdict maps, human gate. */
function routing(phase: WorkflowPhase): string[] {
  const parts: string[] = [];
  if (phase.advance) parts.push(`advance: ${phase.advance}`);
  if (phase.loopBackTo) parts.push(`loop→ ${phase.loopBackTo}`);
  if (phase.maxAttempts !== undefined) parts.push(`max ${phase.maxAttempts}`);
  if (phase.loopBackOn && Object.keys(phase.loopBackOn).length) parts.push(`loopOn ${entries(phase.loopBackOn)}`);
  if (phase.parkOn && Object.keys(phase.parkOn).length) parts.push(`park ${entries(phase.parkOn)}`);
  if (phase.onComplete) parts.push(`onComplete→ ${phase.onComplete}`);
  return parts;
}

function signal(step: WorkflowStep): string {
  return step.signal ? `${step.signal.kind}:${step.signal.value}` : EMPTY;
}

/** Aligned markdown table — deterministic padding keeps the diff readable. */
function table(headers: string[], rows: string[][]): string {
  const cells = [headers, ...rows].map((row) => row.map(escapeCell));
  const widths = headers.map((_, i) => Math.max(...cells.map((row) => row[i].length)));
  const render = (row: string[]) => `| ${row.map((cell, i) => cell.padEnd(widths[i])).join(" | ")} |`;
  return [
    render(cells[0]),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...cells.slice(1).map(render),
  ].join("\n");
}

function workflowSection(workflow: Workflow): string {
  const rows: string[][] = [];
  for (const phase of workflow.phases) {
    const phaseCell = `${phase.id} — ${phase.name}`;
    // The TOOL PROFILE of the phase — read from the SAME table the mask uses
    // (ADR-45, W3): no registry field, no second source of truth.
    const profileCell = PHASE_TOOL_PROFILE[`${workflow.id}:${phase.id}`] ?? "full";
    const phasePart = phaseFlags(phase);
    const routingPart = routing(phase);
    const steps = phase.steps ?? [];
    if (steps.length === 0) {
      // Implicit single step (legacy path) — no WorkflowStep is materialized.
      rows.push([
        phaseCell,
        profileCell,
        join(phasePart),
        EMPTY,
        phase.execution,
        text(phase.agent),
        EMPTY,
        EMPTY,
        join(routingPart),
      ]);
      continue;
    }
    for (const step of steps) {
      rows.push([
        phaseCell,
        profileCell,
        join([...phasePart, ...stepFlags(step)]),
        step.id,
        step.execution,
        text(step.agent),
        text(step.skill),
        signal(step),
        join(routingPart),
      ]);
    }
  }

  const lines: string[] = [`## ${workflow.id} — ${workflow.name}`, "", workflow.description];
  if (workflow.asks?.length) {
    lines.push("", "Run-start questions:");
    for (const ask of workflow.asks) {
      const options = ask.options.join(" / ");
      const fallback = ask.default ? `; default ${ask.default}` : "";
      const when = ask.when ? ` (asked only when \`${ask.when.var}\` = \`${ask.when.equals}\`)` : "";
      lines.push(`- \`${ask.var}\` — ${ask.question} (${options}${fallback})${when}`);
    }
  }
  lines.push(
    "",
    table(
      ["Phase", "Profile", "Flags", "Step", "Exec", "Agent", "Skill", "Signal", "Routing"],
      rows,
    ),
  );
  return lines.join("\n");
}

const HEADER = `# kstack workflows

<!-- GENERATED FILE — DO NOT EDIT BY HAND -->
<!-- Source: orchestrator/workflows.ts → getAllWorkflows() -->
<!-- Regenerate: ${REGENERATE_CMD} -->

This file is **generated** from the workflow registry in \`orchestrator/workflows.ts\`.
Hand-edits are lost on the next regeneration, and \`test/workflow-table.test.ts\`
fails as soon as the file and the registry disagree.

Regenerate after any change to the registry:

\`\`\`sh
${REGENERATE_CMD}
\`\`\`

The output is deterministic — no timestamps, no ambient environment values — so the
file is byte-stable across machines.

## Legend

| Column | Meaning |
| --- | --- |
| **Phase** | Phase id and display name. The phase is the unit of routing. |
| **Profile** | The phase's TOOL PROFILE (\`full\`, \`read\`, \`none\`) — the browser tools the main session keeps in that phase. Read from \`PHASE_TOOL_PROFILE\`, the same table the mask uses. |
| **Flags** | Phase toggles (\`optional\`, \`enabled: auto/off\`, \`fail-fast\`), artifact contract (\`produces\`/\`needs\`) and step flags (\`skip var=value\`, \`needs-user\`, \`side-effect\`, \`requires\`/\`prefers\` capabilities, \`timeout\`, \`ambient\` skills). |
| **Step** | Step id inside the phase — the unit of execution. |
| **Exec** | \`main\` (runs in the model session) or \`subagent\` (delegated to a spawned agent). |
| **Agent** | Agent definition used by delegated steps. |
| **Skill** | Skill digest delivered with the step. |
| **Signal** | Completion signal the router observes in the step record (\`kind:value\`). |
| **Routing** | Phase routing: human gate (\`advance: manual\`), back-edges (\`loop→\`, \`onComplete→\`), ceilings (\`max\`), verdict maps (\`loopOn\`, \`park\`). |

Notes:

- \`enabled: auto\` phases are detected by the engine at the pre-flight panel; the user may force them.
- \`side-effect\` steps park at an entry gate before running — the model can never self-approve.
- \`skip var=value\` steps are skipped when the run-start answer \`var\` equals \`value\`.
- \`advance: manual\` phases park for human approval after completion (\`/kstack next\` moves them on).
- \`-\` means "not declared".
`;

/** Render the whole document. Pure: same workflows in, same text out. */
export function renderWorkflowTable(workflows: Workflow[]): string {
  const sections = workflows.map(workflowSection);
  return [HEADER.trimEnd(), ...sections].join("\n\n") + "\n";
}

/**
 * The registry resolves the sprint workflow and the loop ceilings from env
 * vars — pin them to their defaults so the generated file never depends on
 * the developer's shell.
 */
export async function loadCanonicalWorkflows(): Promise<Workflow[]> {
  delete process.env.KSTACK_PI_SPRINT;
  delete process.env.KSTACK_PI_SPRINT_MAX_ATTEMPTS;
  delete process.env.KSTACK_PI_SPRINT_ARCH_MAX_ATTEMPTS;
  const { getAllWorkflows } = await import("../orchestrator/workflows.ts");
  return getAllWorkflows();
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const workflows = await loadCanonicalWorkflows();
  writeFileSync(OUT_FILE, renderWorkflowTable(workflows), "utf-8");
  console.log(`[kstack] wrote orchestrator/README.md (${workflows.length} workflows)`);
}
