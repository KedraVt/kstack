/**
 * Deterministic subagent execution.
 *
 * Spawns a dedicated headless `pi` process per task (same contract as the
 * subagent extension: --mode json -p --no-session) so workflow phases delegate
 * work by construction rather than by hoping the model calls the `subagent`
 * tool. Agent definitions come from ~/.pi/agent/agents/<name>.md (same
 * frontmatter format: name, description, optional model, tools).
 *
 * The `subagent` extension itself stays untouched and remains available to the
 * model for ad-hoc delegation outside workflows.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { silentChildEnv, winPreloadArgs } from "../lib/silent-spawn.ts";
// CRASH FIX (2026-08-23 incident): these were USED but never imported —
// `subagentTimeoutFor` blew up the first attempt inside the awaited promise
// (harmless-looking fast failure), and `livenessThresholdMs` threw inside the
// abort-poll TIMER callback 1s into the retry, which is an uncaughtException
// that killed the whole pi process ("pi exiting due to uncaughtException").
import { livenessThresholdMs, subagentTimeoutFor } from "./config.ts";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const OUTPUT_CAP = 50 * 1024;

/** Cap the output that reaches orchestrator context; rawOutput stays uncapped. */
function capOutput(raw: string): string {
  return raw.length > OUTPUT_CAP ? `${raw.slice(0, OUTPUT_CAP)}\n…(truncated)` : raw;
}

/**
 * Best-effort breadcrumb logging to the file in KSTACK_PI_DEBUG. Delegation
 * bugs historically left zero post-mortem trace; this gives every spawn
 * attempt a persistent trail without depending on the TUI.
 */
export function debugLog(message: string): void {
  const p = process.env.KSTACK_PI_DEBUG;
  if (!p) return;
  try {
    fs.appendFileSync(p, `${new Date().toISOString()} [spawn] ${message}\n`);
  } catch {
    /* ignore */
  }
}

/**
 * Kill the child AND its descendants. On Windows a plain kill() leaves
 * grandchildren (bash tools etc.) alive holding our stdio pipes, which can
 * keep the 'close' event from ever firing.
 */
function killTree(proc: any, hard: boolean): void {
  try {
    if (process.platform === "win32" && proc.pid) {
      const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        try {
          proc.kill(hard ? "SIGKILL" : "SIGTERM");
        } catch {
          /* ignore */
        }
      });
    } else {
      proc.kill(hard ? "SIGKILL" : "SIGTERM");
    }
  } catch {
    /* ignore */
  }
}

/** Resolve the effective timeout for a request (exported for tests). */
export function resolveTimeoutMs(req: Pick<SpawnRequest, "timeoutMs" | "phaseId">): number {
  return req.timeoutMs ?? (req.phaseId ? subagentTimeoutFor(req.phaseId) : defaultTimeoutMs());
}

/**
 * Per-subagent timeout. Default 20 min; override with
 * KSTACK_PI_SUBAGENT_TIMEOUT (seconds, e.g. "300" for 5 min).
 */
export function defaultTimeoutMs(): number {
  const raw = process.env.KSTACK_PI_SUBAGENT_TIMEOUT;
  if (raw) {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }
  return DEFAULT_TIMEOUT_MS;
}

export interface AgentDef {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  filePath: string;
}

export interface SpawnRequest {
  agent: string;
  task: string;
  cwd: string;
  /** Phase id — resolves the per-class timeout via config.subagentTimeoutFor. */
  phaseId?: string;
  /**
   * Model-tier override (plan E4/D10). Wins over the agent definition's own
   * model when set. Inert unless KSTACK_PI_MODEL_FAST/KSTACK_PI_MODEL_STRONG
   * are configured (config.modelTierFor) — the default keeps agent defaults.
   */
  modelOverride?: string;
  timeoutMs?: number;
  /**
   * Polled once per second; when it returns true (e.g. the session was
   * reloaded mid-run) the child process is killed and the run aborts.
   */
  shouldAbort?: () => boolean;
  /**
   * Live activity feed from the child's JSON event stream (current tool call,
   * assistant text preview). Lets the orchestrator show progress without a
   * tool-renderer — deterministic spawns run outside any tool call.
   */
  onActivity?: (label: string) => void;
  /**
   * STEP 5b: observe-only liveness sink. Called AT MOST ONCE per run when the
   * JSON event stream has been silent longer than KSTACK_PI_LIVENESS_SEC.
   * The process is NEVER terminated because of this.
   */
  onLiveness?: (observation: {
    agent: string;
    gapSec: number;
    lastEvent: string;
    lastTool?: string;
  }) => void;
  /**
   * Inline agent definition bypassing discovery — used by tests and callers
   * that construct specialists programmatically.
   */
  agentDef?: AgentDef;
  /**
   * Replace the resolved script argument with an absolute path. The default
   * resolution uses `process.argv[1]`, which inside a test-runner process is
   * the test file (it would execute the suite, not pi). Tests use this to
   * point at the real CLI while keeping the exact argument construction.
   */
  scriptOverride?: string;
  /**
   * Replace the runtime executable (default: process.execPath). Tests running
   * under `bun test` must force node.exe — bun cannot host the pi CLI.
   */
  execPathOverride?: string;
}

/**
 * Derive a short human-readable activity label from one JSON stream event.
 * Defensive by design: the stream schema is pi-internal, so every access is
 * guarded and unknown shapes simply yield no label.
 */
export function activityLabelFromEvent(event: any): string | null {
  try {
    if (event?.type === "tool_execution_start") {
      const name = event.toolName ?? event.name ?? event.tool?.name ?? "tool";
      const args = event.args ?? event.input ?? event.tool?.args ?? {};
      const target =
        args.file_path ?? args.path ?? args.command ?? args.pattern ?? args.url ?? args.query ?? "";
      return target ? `${name}: ${String(target).slice(0, 48)}` : String(name);
    }
    if (event?.type === "message_start" && event.message?.role === "assistant") {
      return "thinking…";
    }
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      const content = event.message.content;
      const text = Array.isArray(content)
        ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join(" ")
        : typeof content === "string"
          ? content
          : "";
      const t = String(text).trim().replace(/\s+/g, " ");
      return t ? `writing: ${t.slice(0, 48)}` : null;
    }
  } catch {
    /* malformed event — no label */
  }
  return null;
}

export interface SpawnResult {
  ok: boolean;
  /** Final assistant text produced by the subagent (capped). */
  output: string;
  /**
   * UNCAPPED final output. The OUTPUT_CAP only applies to what reaches the
   * orchestrator context; handoff extraction must run on the raw text or a
   * trailing `## HANDOFF` section is lost on long reports (STEP 2c).
   */
  rawOutput?: string;
  error?: string;
  exitCode: number | null;
  durationMs: number;
  /** Number of tool calls the child executed — the real driver of wall time. */
  toolCalls?: number;
  /** Assistant turns completed by the child. */
  turns?: number;
  /**
   * True when the run ended without a complete output: timeout, abort, or
   * non-zero exit with partial output. Labeled partial output beats absent
   * output — receivers degrade the handoff level instead of guessing.
   */
  incomplete?: boolean;
  /** True when the child was killed by the timeout. */
  timedOut?: boolean;
  /** True when the failure is configuration-level (e.g. unknown agent) — never retried. */
  configError?: boolean;
  /** Aggregate provider usage reported on assistant messages. */
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, string> = {};
  // Minimal YAML: top-level `key: value` pairs only — enough for agent defs.
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) frontmatter[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { frontmatter, body: content.slice(match[0].length) };
}

/** Discover an agent definition by name from ~/.pi/agent/agents/*.md */
export function discoverAgent(name: string): AgentDef | null {
  const dir = path.join(getAgentDir(), "agents");
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.name.endsWith(".md")) continue;
      const filePath = path.join(dir, entry.name);
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const { frontmatter, body } = parseFrontmatter(content);
      if (!frontmatter.name || !frontmatter.description) continue;
      if (frontmatter.name !== name) continue;
      return {
        name: frontmatter.name,
        description: frontmatter.description,
        tools: frontmatter.tools?.split(",").map((t) => t.trim()).filter(Boolean),
        model: frontmatter.model,
        systemPrompt: body,
        filePath,
      };
    }
  } catch {
    /* agents dir missing */
  }
  return null;
}

function listAvailableAgents(): string {
  const dir = path.join(getAgentDir(), "agents");
  try {
    const names: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.name.endsWith(".md")) continue;
      try {
        const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(dir, entry.name), "utf-8"));
        if (frontmatter.name) names.push(frontmatter.name);
      } catch {
        /* ignore */
      }
    }
    return names.join(", ") || "none";
  } catch {
    return "none";
  }
}

function extractFinalOutput(events: any[]): string {
  // Walk backwards for the last assistant message with text content.
  for (let i = events.length - 1; i >= 0; i--) {
    const msg = events[i];
    if (msg?.role !== "assistant") continue;
    const parts = Array.isArray(msg.content) ? msg.content : [];
    const text = parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

async function writePromptToTempFile(agentName: string, systemPrompt: string): Promise<{ dir: string; filePath: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-pi-agent-"));
  const safeName = agentName.replace(/[^a-z0-9_-]/gi, "_");
  const filePath = path.join(dir, `${safeName}.md`);
  try {
    await fs.promises.writeFile(filePath, systemPrompt, "utf-8");
  } catch (err) {
    // A failed write would otherwise leak the empty mkdtemp dir (the caller's
    // finally only sees a dir it was never handed).
    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
    throw err;
  }
  return { dir, filePath };
}

/**
 * The pi CLI entry script (dist/cli.js), resolved from the installed package
 * rather than PATH: the `pi` binary on Windows is an npm `pi.cmd` shim that
 * raw spawn() cannot exec without a shell (EINVAL on Node ≥20.12), and
 * `process.argv[1]` is unreliable inside compiled/test-runner hosts.
 */
function resolvePiCliScript(): string | null {
  try {
    // import.meta.resolve honors the package's "import" exports condition —
    // createRequire's "require" condition is NOT exported by this package and
    // always throws (verified: ERR_PACKAGE_PATH_NOT_EXPORTED). bin: dist/cli.js
    // is a sibling of the resolved main (dist/index.js).
    const pkgEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const cli = path.join(path.dirname(pkgEntry), "cli.js");
    return fs.existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

function resolvePiInvocation(
  args: string[],
  scriptOverride?: string,
  execPathOverride?: string,
): { command: string; args: string[] } {
  const preload = winPreloadArgs();
  // Test seam: force a specific runtime (e.g. node.exe). Without it a test
  // running under `bun test` would spawn the CLI with bun, which cannot host
  // pi reliably and hangs. Behaves like the normal script branch: the CLI
  // script stays the first argument.
  if (execPathOverride) {
    const script = scriptOverride ?? process.argv[1];
    return { command: execPathOverride, args: script ? [...preload, script, ...args] : args };
  }
  const currentScript = scriptOverride ?? process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [...preload, currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    // Compiled/self-contained pi host (e.g. devin.exe): argv goes straight to
    // the binary — no -r slot exists, but NODE_OPTIONS still covers any
    // nested node processes it launches.
    return { command: process.execPath, args };
  }
  const cliScript = resolvePiCliScript();
  if (cliScript) {
    return { command: process.execPath, args: [...preload, cliScript, ...args] };
  }
  return { command: "pi", args };
}

/**
 * Run one subagent task to completion. Never throws — failures come back as
 * `{ ok: false, error }` so workflow phases can degrade gracefully.
 */
export async function runSubagent(req: SpawnRequest): Promise<SpawnResult> {
  const started = Date.now();
  const agent = req.agentDef ?? discoverAgent(req.agent);
  if (!agent) {
    return {
      ok: false,
      output: "",
      error: `Unknown agent "${req.agent}". Available agents: ${listAvailableAgents()}.`,
      exitCode: 1,
      durationMs: 0,
      configError: true,
    };
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  const effectiveModel = req.modelOverride ?? agent.model;
  if (effectiveModel) args.push("--model", effectiveModel);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;
  const collected: any[] = [];
  let stderr = "";

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }
    // The task payload travels via stdin, never argv: full-mode skill
    // injection makes `Task:` tens of kilobytes and CreateProcess' ~32K-char
    // command-line limit would EINVAL the spawn on Windows (Bugs & Fixes #3).
    // pi reads piped stdin as the initial message in -p mode
    // (readPipedStdin → buildInitialMessage), so semantics are identical.
    const stdinPayload = `Task: ${req.task}\n`;

    // All mutable state lives OUTSIDE the promise executor: the result below
    // references it, and a nested declaration would be a runtime
    // ReferenceError on every successful spawn (latent bug found by tsc).
    let aborted = false;
    let toolCalls = 0;
    let timedOut = false;
    let spawnErrorMessage: string | null = null;
    let buffer = "";
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let turns = 0;
    // STEP 5b: observe-only liveness tracking.
    let lastEventAt = Date.now();
    let lastEventType = "(start)";
    let lastToolName: string | undefined;
    let livenessNotified = false;
    // Provider health: the last provider-level error (auto_retry_start events
    // and error stop reasons). When a child dies with no output, this is far
    // more actionable than the stderr noise (e.g. the model-registry banner).
    let lastProviderError: string | null = null;
    const timeoutMs = resolveTimeoutMs(req);

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = resolvePiInvocation(args, req.scriptOverride, req.execPathOverride);
      debugLog(`attempt: ${invocation.command} + ${invocation.args.length} args, cwd=${req.cwd}`);
      let proc: any;
      try {
        proc = spawn(invocation.command, invocation.args, {
          cwd: req.cwd,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          // CREATE_NO_WINDOW for the child itself. Its OWN spawned tools get
          // windowsHide via the silent-spawn preload (argv -r + NODE_OPTIONS),
          // which is the only way to stop pi's internal exec/grep/find spawns
          // — none pass the flag — from flashing a console window per call.
          windowsHide: true,
          env: silentChildEnv(),
        });
      } catch (err: any) {
        // Synchronous spawn failures (invalid args, permissions) are
        // configuration problems — record and fail without retry.
        spawnErrorMessage = err?.message ?? String(err);
        debugLog(`spawn threw synchronously: ${spawnErrorMessage}`);
        resolve(1);
        return;
      }
      debugLog(`child pid=${proc.pid}`);

      // Deliver the task on stdin (see stdinPayload note above). An EPIPE
      // from a child that already exited must not crash the host — same
      // guard as lib/browse.ts.
      try {
        proc.stdin?.on("error", () => {});
        proc.stdin?.write(stdinPayload);
        proc.stdin?.end();
      } catch {
        /* child already gone — the exit/close path resolves the promise */
      }

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          lastEventAt = Date.now();
          if (event?.type) lastEventType = String(event.type);
          const toolName = event?.toolName ?? event?.name ?? event?.tool?.name;
          if (toolName) lastToolName = String(toolName);
          if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
            collected.push(event.message);
          }
          if (event.type === "message_end" && event.message?.role === "assistant") {
            turns++;
            const u = event.message.usage;
            if (u) {
              usage.input += Number(u.input ?? u.inputTokens ?? 0) || 0;
              usage.output += Number(u.output ?? u.outputTokens ?? 0) || 0;
              usage.cacheRead += Number(u.cacheRead ?? u.cacheReadTokens ?? 0) || 0;
              usage.cacheWrite += Number(u.cacheWrite ?? u.cacheWriteTokens ?? 0) || 0;
            }
          }
          if (event?.type === 'tool_execution_start') toolCalls++;
          if (event?.type === "auto_retry_start" && event?.errorMessage) {
            lastProviderError = String(event.errorMessage);
          }
          if (event?.type === "message_end" && event?.message?.role === "assistant" && event?.message?.stopReason === "error") {
            lastProviderError = lastProviderError ?? "assistant message ended with stopReason=error";
          }
          const label = activityLabelFromEvent(event);
          if (label) req.onActivity?.(label);
        } catch {
          /* not JSON — ignore */
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        try {
          timedOut = true;
          debugLog(`timeout after ${Math.round(timeoutMs / 1000)}s — killing tree`);
          killTree(proc, false);
          setTimeout(() => killTree(proc, true), 5000);
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      timer.unref?.();

      // Cooperative abort: if the parent chain is invalidated (session
      // reload/switch), kill the child promptly instead of letting it run to
      // completion for work nobody will read.
      const abortPoll = setInterval(() => {
        try {
          if (req.shouldAbort?.()) {
            aborted = true;
            clearInterval(abortPoll);
            debugLog("abort requested — killing tree");
            killTree(proc, false);
            setTimeout(() => killTree(proc, true), 5000);
            return;
          }
          // STEP 5b: observe-only liveness — notify + record, NEVER terminate.
          if (req.onLiveness && !livenessNotified) {
            const threshold = livenessThresholdMs();
            if (threshold !== "off") {
              const gapMs = Date.now() - lastEventAt;
              if (gapMs > threshold) {
                livenessNotified = true;
                debugLog(`liveness gap ${Math.round(gapMs / 1000)}s (last event: ${lastEventType})`);
                req.onLiveness({
                  agent: req.agent,
                  gapSec: Math.round(gapMs / 1000),
                  lastEvent: lastEventType,
                  lastTool: lastToolName,
                });
              }
            }
          }
        } catch (err: any) {
          // CRASH GUARD: an exception inside a timer callback is an
          // uncaughtException and kills the whole host process. A liveness or
          // abort hiccup must only degrade this run, never pi itself.
          debugLog(`abortPoll tick error: ${err?.message ?? err}`);
        }
      }, 1000);
      abortPoll.unref?.();

      let settled = false;
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearInterval(abortPoll);
        clearTimeout(timer);
        try {
          proc.stdout?.destroy();
        } catch {
          /* ignore */
        }
        try {
          proc.stderr?.destroy();
        } catch {
          /* ignore */
        }
        resolve(code);
      };
      const flushAndFinish = (code: number) => {
        if (settled) return;
        if (buffer.trim()) processLine(buffer);
        buffer = "";
        finish(code);
      };
      proc.on("close", (code: number | null) => {
        flushAndFinish(aborted ? 130 : code ?? 0);
      });
      // Fallback: 'close' only fires once stdio streams close; grandchildren
      // inheriting the pipes can keep them open forever on Windows. 'exit' +
      // a grace period guarantees this promise always settles.
      proc.on("exit", (code: number | null) => {
        const grace = setTimeout(() => flushAndFinish(aborted ? 130 : code ?? 0), 1500);
        grace.unref?.();
      });
      proc.on("error", (err: Error) => {
        spawnErrorMessage = spawnErrorMessage ?? err.message;
        debugLog(`spawn error event: ${err.message}`);
        flushAndFinish(1);
      });
    });

    debugLog(
      `attempt done: exit=${exitCode} timedOut=${timedOut} aborted=${aborted} outputChars=${(extractFinalOutput(collected) || "").length}`,
    );

    const rawOutput = extractFinalOutput(collected);
    if (!rawOutput && spawnErrorMessage) {
      // Spawn-level failure (ENOENT, permissions, invalid args): retrying the
      // identical invocation cannot help — classify as a hard config error.
      return {
        ok: false,
        output: "",
        error: `Failed to start subagent "${req.agent}": ${spawnErrorMessage}`,
        exitCode,
        durationMs: Date.now() - started,
        configError: true,
      };
    }
    if (timedOut) {
      // STEP 2d: preserve the partial transcript, labeled incomplete.
      return {
        ok: false,
        output: capOutput(rawOutput),
        rawOutput,
        incomplete: true,
        timedOut: true,
        error: `Subagent "${req.agent}" timed out after ${Math.round(timeoutMs / 1000)}s (limit configurable via KSTACK_PI_SUBAGENT_TIMEOUT, in seconds).`,
        exitCode,
        durationMs: Date.now() - started,
      };
    }
    if (!rawOutput && stderr.trim()) {
      const providerHint = lastProviderError ? ` (last provider error: ${lastProviderError})` : "";
      return {
        ok: false,
        output: "",
        error: `${stderr.trim().slice(0, 2000)}${providerHint}`,
        exitCode,
        durationMs: Date.now() - started,
        incomplete: aborted || undefined,
      };
    }

    const exitFailed = exitCode !== null && exitCode !== 0;
    return {
      ok: Boolean(rawOutput),
      output: capOutput(rawOutput),
      rawOutput,
      turns,
      usage: { ...usage },
      incomplete: !rawOutput || aborted || exitFailed || undefined,
      timedOut: undefined,
      error: rawOutput
        ? undefined
        : lastProviderError
          ? `Subagent produced no output. Last provider error: ${lastProviderError}.`
          : "Subagent produced no output.",
      exitCode,
      durationMs: Date.now() - started,
      toolCalls,
    };
  } catch (err: any) {
    return { ok: false, output: "", error: err?.message ?? String(err), exitCode: 1, durationMs: Date.now() - started };
  } finally {
    if (tmpPromptPath) {
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    }
    if (tmpPromptDir) {
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
    }
  }
}
