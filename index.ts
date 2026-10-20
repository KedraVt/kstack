import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerKstackTools } from "./tools.generated";
import { resolveBinary, invalidateBinaryCache } from "./lib/browse";
import { isBinaryInstalled, downloadBinary } from "./lib/download";
import { initOrchestrator } from "./orchestrator/index";

export default function (pi: ExtensionAPI) {
  const bin = resolveBinary();

  if ("error" in bin) {
    // resolveBinary() memoizes the miss — so after a successful download (or
    // an externally-provided binary appearing) we MUST drop the cache or
    // runBrowse keeps reporting the stale "not found" error all session.
    pi.on("session_start", async (_event, ctx) => {
      if (isBinaryInstalled()) {
        invalidateBinaryCache();
        return;
      }
      ctx.ui.notify("kstack: downloading browse binary...", "info");
      const result = await downloadBinary((msg) => ctx.ui.notify(`kstack: ${msg}`, "info"));
      if ("error" in result) {
        ctx.ui.notify(`kstack: ${result.error} — browse tools unavailable`, "warning");
      } else {
        invalidateBinaryCache();
        ctx.ui.notify(`kstack: binary ready at ${result.path}`, "info");
      }
    });
  }

  registerKstackTools(pi);
  initOrchestrator(pi);
}
