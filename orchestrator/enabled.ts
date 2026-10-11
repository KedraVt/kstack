/**
 * S4 / TASK_05 — run-start + arrival-time resolution machinery.
 *
 * - `resolvePhaseEnabled` — `enabled:"auto"` evaluated at panel AND at phase
 *   arrival (ADR-24): lastVerdicts populate mid-run so the arrival re-check
 *   is REQUIRED, not a cache. A throwing autoWhen ⇒ "off" + a ledger note —
 *   never a crash mid-run.
 * - `stepSkippedByVars` — declarative step `skipWhen {var,equals}` against
 *   `state.vars`; missing keys ⇒ safe default (no skip).
 * - `derivedSkippable` — INV-13: a phase is skippable iff no enabled phase
 *   `needs` an artifact it `produces`. The panel computes it so a run can
 *   never be broken by construction.
 * - `coherenceProblems` — workflow-def validation: needs must reference
 *   produced artifact ids and the needs graph must be acyclic.
 * - `collectAskAnswers` — `asks[]` sequential select at run start; answers
 *   land in `state.vars`; `when` gates follow-ups; non-interactive modes
 *   resolve every question to its declared default.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Workflow, WorkflowContext, WorkflowPhase, WorkflowStep } from "./types.ts";

export interface EnabledResolution {
  enabled: "on" | "off";
  /** Set when a throwing autoWhen degraded the phase — the caller ledger-notes it. */
  note?: string;
}

/**
 * Resolve a phase's enabled toggle at panel or arrival. `enabled` absent or
 * "on" ⇒ "on"; "off" ⇒ "off"; "auto" ⇒ `autoWhen(ctx)` (missing/throwing
 * resolver ⇒ "off" — auto phases fail closed, never silently run).
 *
 * auto+override (workflow-redesign §rules): under selection-gate the user's
 * panel choice forces the auto phase — "auto"=always run, "skip"=never run,
 * "human"/absent = let the engine decide (autoWhen).
 */
export function resolvePhaseEnabled(
  phase: Pick<WorkflowPhase, "enabled" | "autoWhen" | "id">,
  ctx: WorkflowContext,
): EnabledResolution {
  const toggle = phase.enabled ?? "on";
  if (toggle !== "auto") return { enabled: toggle === "off" ? "off" : "on" };
  const override = ctx.state.gateMode === "selection-gate" ? ctx.state.gateOverrides?.[phase.id] : undefined;
  if (override === "auto") return { enabled: "on" };
  if (override === "skip") return { enabled: "off" };
  if (typeof phase.autoWhen !== "function") {
    return { enabled: "off", note: `enabled:"auto" phase "${phase.id}" declares no autoWhen resolver` };
  }
  try {
    return { enabled: phase.autoWhen(ctx) ? "on" : "off" };
  } catch (err) {
    return {
      enabled: "off",
      note: `autoWhen threw for phase "${phase.id}" (${err instanceof Error ? err.message : String(err)}) — resolved "off"`,
    };
  }
}

/**
 * Declarative step skip: `skipWhen {var,equals}` holds iff
 * `state.vars[var] === equals`. Missing vars ⇒ false (the step runs).
 */
export function stepSkippedByVars(
  step: Pick<WorkflowStep, "id" | "skipWhen">,
  vars: Record<string, string> | undefined,
): boolean {
  if (!step.skipWhen) return false;
  return vars?.[step.skipWhen.var] === step.skipWhen.equals;
}

/**
 * The set of phases that currently count as enabled (used by the
 * produces/needs skippability computation): everything whose toggle does not
 * resolve "off" under ctx.
 */
export function enabledPhaseIds(workflow: Workflow, ctx: WorkflowContext): Set<string> {
  const ids = new Set<string>();
  for (const p of workflow.phases) {
    if (resolvePhaseEnabled(p, ctx).enabled === "on") ids.add(p.id);
  }
  return ids;
}

/**
 * INV-13 derived skippability: a phase is skippable iff NO enabled phase
 * `needs` an artifact it `produces`. Skipping a needed producer would starve
 * a consumer mid-run — the panel must never offer it.
 */
export function derivedSkippable(workflow: Workflow, enabledIds: Set<string>, phaseId: string): boolean {
  const target = workflow.phases.find((p) => p.id === phaseId);
  const produced = new Set(target?.produces ?? []);
  if (produced.size === 0) return true;
  for (const p of workflow.phases) {
    if (p.id === phaseId || !enabledIds.has(p.id)) continue;
    if ((p.needs ?? []).some((n) => produced.has(n))) return false;
  }
  return true;
}

/**
 * Workflow-def coherence (INV): every `needs` entry names an artifact id
 * that some phase `produces`, and the produces→needs graph is acyclic.
 * When `knownSkillIds` is supplied, INV-6 applies: every skill referenced
 * by a phase/chain/step must resolve — a missing skill is a def bug, not a
 * runtime condition. Returns problem strings — empty list means coherent.
 */
export function coherenceProblems(workflow: Workflow, knownSkillIds?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (knownSkillIds) {
    const check = (owner: string, ids: readonly string[] | undefined) => {
      for (const id of ids ?? []) {
        if (!knownSkillIds.has(id)) problems.push(`${owner} references missing skill "${id}"`);
      }
    };
    for (const p of workflow.phases) {
      check(`phase "${p.id}"`, p.skills);
      for (const c of p.chain ?? []) check(`phase "${p.id}" chain "${c.agent}"`, c.skills);
      for (const s of p.steps ?? []) {
        check(`step "${p.id}.${s.id}"`, s.skill ? [s.skill] : undefined);
        check(`step "${p.id}.${s.id}"`, s.ambientSkills);
      }
    }
  }
  const producedBy = new Map<string, string[]>(); // artifact -> producer phase ids
  for (const p of workflow.phases) {
    for (const art of p.produces ?? []) {
      (producedBy.get(art) ?? producedBy.set(art, []).get(art)!).push(p.id);
    }
  }
  for (const p of workflow.phases) {
    for (const need of p.needs ?? []) {
      if (!producedBy.has(need)) {
        problems.push(`phase "${p.id}" needs "${need}" but no phase produces it`);
      } else if (producedBy.get(need)!.includes(p.id)) {
        problems.push(`phase "${p.id}" needs its own product "${need}"`);
      }
    }
  }
  // Cycle detection on the phase graph producer→consumer.
  const edges = new Map<string, Set<string>>();
  for (const p of workflow.phases) {
    for (const need of p.needs ?? []) {
      for (const prod of producedBy.get(need) ?? []) {
        (edges.get(prod) ?? edges.set(prod, new Set()).get(prod)!).add(p.id);
      }
    }
  }
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string, trail: string[]): void => {
    const s = state.get(id);
    if (s === 2) return;
    if (s === 1) {
      problems.push(`needs cycle: ${[...trail, id].join(" → ")}`);
      return;
    }
    state.set(id, 1);
    for (const next of edges.get(id) ?? []) visit(next, [...trail, id]);
    state.set(id, 2);
  };
  for (const id of edges.keys()) visit(id, []);
  return problems;
}

/**
 * Sequential `asks[]` collection for the run-start panel (TASK_05). Each
 * answered question lands in the returned vars map; `when` conditions are
 * evaluated against answers collected so far. Non-interactive contexts (RPC,
 * headless) resolve every question to `default ?? options[0]` — the
 * "assumed" choice is still recorded, matching the headless-run rule.
 */
export async function collectAskAnswers(
  workflow: Workflow,
  ctx: ExtensionCommandContext,
): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};
  for (const ask of workflow.asks ?? []) {
    if (ask.when && vars[ask.when.var] !== ask.when.equals) continue;
    const fallback = ask.default ?? ask.options[0];
    if (ctx.mode !== "tui" || typeof ctx.ui?.select !== "function") {
      vars[ask.var] = fallback;
      continue;
    }
    const picked = await ctx.ui.select(ask.question, ask.options);
    vars[ask.var] = picked ?? fallback;
  }
  return vars;
}
