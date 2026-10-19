import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadActiveState } from "./state.ts";
import { buildResumeContext } from "./executor.ts";

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

/**
 * Re-anchors user input during an ACTIVE workflow. Without one, input passes
 * through untouched — workflows start only via /kstack (keyword-based
 * workflow suggestions were removed: single words like "review" or "sprint"
 * misfired on ordinary requests).
 */
export function createInputRouter(_pi: ExtensionAPI) {
  return (event: InputEvent, ctx: ExtensionContext): InputEventResult => {
    if (event.source !== "interactive") return { action: "continue" };
    if (event.text.startsWith("/")) return { action: "continue" };
    // A bare stop word is a request to halt — never wrap it in "continue working".
    // Only the WHOLE message: "stop asking and use X" still gets the re-anchor.
    if (/^\s*(abort|cancel|stop|terminate|quit|exit|annulla|termina|esci|fermati)\s*[.!]*\s*$/i.test(event.text)) return { action: "continue" };

    const activeState = loadActiveState(ctx);
    if (!activeState) return { action: "continue" };
    // Q4 fix: during an ACTIVE workflow even short inputs ("ok", "vai") mean
    // "proceed" and need the re-anchoring prefix — the phase instructions may
    // be many turns back. Preserve event.images — dropping them silently ate
    // pasted screenshots in the transformed message.
    return { action: "transform", text: `${buildResumeContext(activeState)}\n\n${event.text}`, images: event.images };
  };
}
