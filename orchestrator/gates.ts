/**
 * S3 / D20 — pre-flight gate configuration.
 *
 * `gateInventory(workflow)` enumerates the human decision gates a workflow can
 * actually fire under the current env flags — it mirrors the SAME predicates
 * the three gate sites consult (optional phase park in executor.ts, the ⚠
 * side-effect entry gate in executor.ts, and the post-completion manual gate
 * in index.ts), so the dialog only ever shows rows that can happen.
 *
 * `configureGates` renders those rows as a checkbox list (ctx.ui.custom +
 * SettingsList) BEFORE the run's state is created — "configure" is transient
 * and is never persisted as a status. The chosen `gateMode`/`gateOverrides`
 * land on the WorkflowState at creation; the gate sites consult them and fall
 * back to the env defaults when mode is "human-gate".
 */

import { SettingsList, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import { getSettingsListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deterministicSubagents, manualGates, optionalPhases } from "./config.ts";
import { derivedSkippable, enabledPhaseIds, resolvePhaseEnabled } from "./enabled.ts";
import type { GateRow, Workflow, WorkflowContext } from "./types.ts";

export interface GateConfiguration {
  gateMode: "human-gate" | "selection-gate";
  /** Only non-"human" choices are kept — absent = the default (park). */
  gateOverrides: Record<string, "auto" | "human" | "skip">;
}

/**
 * One row per phase that can gate a human decision — first match wins:
 * optional → optional row (auto|skip|human); subagent + advance:"manual" → a
 * single ⚠ entry row (its own delegation IS the side effect — it dedupes the
 * entry + post-completion gates into one decision); else advance:"manual" →
 * manual row. push-pr is excluded explicitly.
 */
export function gateInventory(workflow: Workflow, wfCtx?: WorkflowContext): GateRow[] {
  const askOptional = optionalPhases() === "ask";
  const manual = manualGates();
  const deterministic = deterministicSubagents();
  const rows: GateRow[] = [];
  // S4/TASK_05: enabled:"off" phases never gate, and INV-13 derived
  // skippability (produces/needs) removes "skip" from optional producers an
  // enabled phase still needs. ctx is optional — legacy callers without it
  // keep the pre-S4 row set.
  const enabled = wfCtx ? enabledPhaseIds(workflow, wfCtx) : null;
  workflow.phases.forEach((phase, index) => {
    if (phase.id === "push-pr") return; // never a pre-flight row
    const name = `${index + 1}. ${phase.name}`;
    // S4: enabled:"auto" phases are the panel's "engine detects, user forces"
    // rows (auto+override). They always surface — even when the current
    // resolution is "off", because an "auto" override force-runs them.
    if (phase.enabled === "auto") {
      const skippable = enabled ? derivedSkippable(workflow, enabled, phase.id) : undefined;
      rows.push(skippable === false
        ? { phaseId: phase.id, name, kind: "optional", skippable: false }
        : { phaseId: phase.id, name, kind: "optional" });
      return;
    }
    if (wfCtx && resolvePhaseEnabled(phase, wfCtx).enabled === "off") return;
    if (phase.optional) {
      // "auto"/"skip" env modes already decide globally — no human gate exists.
      if (askOptional) {
        const skippable = enabled ? derivedSkippable(workflow, enabled, phase.id) : undefined;
        rows.push(skippable === false
          ? { phaseId: phase.id, name, kind: "optional", skippable: false }
          : { phaseId: phase.id, name, kind: "optional" });
      }
      return;
    }
    if (phase.execution === "subagent" && phase.advance === "manual") {
      // ⚠ entry rows are the ONLY gate for subagent+manual phases — the
      // entry park replaces the post-completion park today (executor.ts /
      // index.ts entryGate semantics). When deterministic delegation is off
      // no entry gate can fire, but the post-completion manual gate still
      // does — degrade to a manual row so the user can still pre-decide it.
      if (!manual) return;
      rows.push(
        deterministic
          ? { phaseId: phase.id, name, kind: "entry", warning: true }
          : { phaseId: phase.id, name, kind: "manual" },
      );
      return;
    }
    // S4/TASK_07: a phase containing sideEffect steps gets one ⚠ entry row —
    // "auto" on it pre-approves every side-effect step inside (executor
    // consults the same phase-keyed override at each gated step).
    if (manual && phase.steps?.some((s) => s.sideEffect)) {
      rows.push({ phaseId: phase.id, name, kind: "entry", warning: true });
      return;
    }
    if (manual && phase.advance === "manual") {
      rows.push({ phaseId: phase.id, name, kind: "manual" });
    }
  });
  return rows;
}

/** getSettingsListTheme throws when the interactive theme isn't initialized. */
function settingsTheme(): SettingsListTheme {
  try {
    return getSettingsListTheme();
  } catch {
    return { label: (t) => t, value: (t) => t, description: (t) => t, cursor: "> ", hint: (t) => t };
  }
}

const DESCRIPTIONS: Record<GateRow["kind"], string> = {
  optional: "human: pause for your decision · auto: always run · skip: never run",
  entry: "side-effect phase — human: approve before it runs · auto: run unattended",
  manual: "human: pause for approval · auto: continue without pausing",
};

/**
 * SettingsList with a title header — ctx.ui.custom renders the component with
 * no chrome of its own (unlike select/confirm, which carry titles), so the
 * panel itself must name what it configures, matching the pi panel convention.
 */
class GateConfigList extends SettingsList {
  constructor(
    private header: string[],
    items: SettingItem[],
    maxVisible: number,
    theme: SettingsListTheme,
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
  ) {
    super(items, maxVisible, theme, onChange, onCancel, { enableSearch: false });
  }
  render(width: number): string[] {
    return [...this.header, ...super.render(width)];
  }
}

/**
 * The pre-flight selection list. Resolves undefined when the dialog is
 * dismissed (Esc) — the caller then starts the run with human-gate defaults.
 * "▶ Start workflow" submits: `gateMode` comes from the mode row and
 * `gateOverrides` collects every row whose value is not the "human" default.
 * Per-gate choices only apply under selection-gate (the consultation sites
 * gate on it), so a human-gate submit drops them rather than persisting
 * inert overrides.
 */
export async function configureGates(
  rows: GateRow[],
  ctx: ExtensionContext,
  workflowName?: string,
): Promise<GateConfiguration | undefined> {
  const items: SettingItem[] = [
    {
      id: "__mode__",
      label: "Gate mode",
      description: "human-gate: EVERY step pauses until you approve it via /kstack · selection-gate: only the per-gate choices below",
      currentValue: "human-gate",
      values: ["human-gate", "selection-gate"],
    },
    ...rows.map<SettingItem>((row) => ({
      id: row.phaseId,
      label: `${row.warning ? "⚠ " : ""}${row.name}`,
      description: DESCRIPTIONS[row.kind],
      currentValue: "human",
      // INV-05: "skip" is only selectable on optional rows; INV-13 further
      // removes it from optional producers an enabled phase still needs.
      values: row.kind === "optional" && row.skippable !== false ? ["human", "auto", "skip"] : ["human", "auto"],
    })),
    { id: "__done__", label: "▶ Start workflow", currentValue: "", values: ["start"] },
  ];
  const values: Record<string, string> = {};
  return ctx.ui.custom<GateConfiguration | undefined>((_tui, theme, _kb, done) => {
    const paint = (color: "accent" | "dim", t: string) => {
      try {
        return color === "accent" ? theme.fg("accent", theme.bold(t)) : theme.fg("dim", t);
      } catch {
        return t; // theme unavailable (non-interactive/test ctx) — render plain
      }
    };
    const header = [
      paint("accent", `kstack — gate setup: ${workflowName ?? "workflow"}`),
      paint("dim", "Esc starts the run with human-gate defaults (every step waits for your /kstack approval)."),
      "",
    ];
    return new GateConfigList(
      header,
      items,
      Math.min(items.length, 14),
      settingsTheme(),
      (id, newValue) => {
        if (id === "__done__") {
          const gateMode = values["__mode__"] === "selection-gate" ? "selection-gate" : "human-gate";
          const gateOverrides: GateConfiguration["gateOverrides"] = {};
          if (gateMode === "selection-gate") {
            for (const row of rows) {
              const v = values[row.phaseId];
              if (v === "auto" || v === "skip") gateOverrides[row.phaseId] = v;
            }
          }
          done({ gateMode, gateOverrides });
          return;
        }
        values[id] = newValue;
      },
      () => done(undefined),
    );
  });
}
