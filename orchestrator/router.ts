import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Workflow } from "./types.ts";
import { getAllWorkflows } from "./workflows.ts";
import { loadActiveState } from "./state.ts";
import { buildResumeContext } from "./executor.ts";

const CONFIDENCE_THRESHOLD = 0.65;
const MIN_INPUT_LENGTH = 8;

interface InputEvent {
  text: string;
  images?: unknown[];
  source: "interactive" | "rpc" | "extension";
  streamingBehavior?: "steer" | "followUp";
}

type InputEventResult =
  | { action: "continue" }
  | { action: "transform"; text: string; images?: unknown[] }
  | { action: "handled" };

export function createInputRouter(_pi: ExtensionAPI) {
  return (event: InputEvent, ctx: ExtensionContext): InputEventResult => {
    if (event.source !== "interactive") return { action: "continue" };
    if (event.text.startsWith("/")) return { action: "continue" };

    const activeState = loadActiveState(ctx);
    if (activeState) {
      // Q4 fix: during an ACTIVE workflow even short inputs ("ok", "vai") mean
      // "proceed" and need the re-anchoring prefix — the phase instructions may
      // be many turns back. MIN_INPUT_LENGTH only guards intent matching below.
      const contextPrefix = buildResumeContext(activeState);
      // Preserve event.images — dropping them silently ate pasted screenshots
      // in the transformed message.
      return { action: "transform", text: `${contextPrefix}\n\n${event.text}`, images: event.images };
    }

    if (event.text.length < MIN_INPUT_LENGTH) return { action: "continue" };

    const scores = scoreIntents(event.text);
    if (scores.length === 0 || scores[0].confidence < CONFIDENCE_THRESHOLD) {
      return { action: "continue" };
    }

    const best = scores[0];
    const suggestion = buildSuggestion(best.workflow);
    return { action: "transform", text: `${suggestion}\n\n${event.text}`, images: event.images };
  };
}

function scoreIntents(text: string): Array<{ workflow: Workflow; confidence: number }> {
  const results: Array<{ workflow: Workflow; confidence: number }> = [];

  for (const workflow of getAllWorkflows()) {
    let maxScore = 0;
    for (const intent of workflow.intents) {
      if (intent.pattern.test(text)) {
        maxScore = Math.max(maxScore, intent.weight);
      }
    }
    if (maxScore > 0) {
      results.push({ workflow, confidence: maxScore });
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}

function buildSuggestion(workflow: Workflow): string {
  const phaseNames = workflow.phases.map((p) => p.name).join(" → ");
  return [
    `[gstack-orchestrator] The user's input matches the "${workflow.name}" workflow.`,
    `Suggested workflow: ${phaseNames}`,
    `If this matches the user's intent, suggest running /kstack ${workflow.id} for the guided workflow.`,
    `If unsure, ask: "This looks like a ${workflow.name.toLowerCase()} task. Want the full guided workflow (/kstack ${workflow.id}), or should I handle it directly?"`,
    `---`,
  ].join("\n");
}
