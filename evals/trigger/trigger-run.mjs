// trigger-run.mjs <prompts.json> <results.jsonl> <skillsDir> [--runs 3] [--conc 3] [--only id,id] [--split train|val|all]
// One isolated pi run per (skill, prompt, rep): whole kstack catalog loaded, no other skills/extensions.
// Outcome = first skill whose SKILL.md the agent reads; NONE after 4 tool calls or a final message without one.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [promptsFile, outFile, skillsDir, ...rest] = process.argv.slice(2);
const arg = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const RUNS = Number(arg("--runs", 3)), CONC = Number(arg("--conc", 3));
const ONLY = arg("--only", "") ? arg("--only").split(",") : null;
const SPLIT = arg("--split", "all");
const MODEL = arg("--model", "openrouter/minimax/minimax-m3.1-flash:free");
const MAXTOOLS = Number(arg("--max-tools", 12));
const FIXTURE = arg("--fixture");
const CTX = "The project you work on is the current working directory. Stay inside it.";
const CLI = path.join(process.env.APPDATA, "npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

const prompts = JSON.parse(fs.readFileSync(promptsFile, "utf8"));
const done = new Set(fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).key) : []);

// Deterministic 60/40 split: items 0-5 of each list train, 6-9 validation.
const jobs = [];
for (const [skill, sets] of Object.entries(prompts)) {
  if (ONLY && !ONLY.includes(skill)) continue;
  for (const kind of ["fire", "near"]) sets[kind].forEach((prompt, i) => {
    const split = i < 6 ? "train" : "val";
    if (SPLIT !== "all" && SPLIT !== split) return;
    for (let r = 0; r < RUNS; r++) {
      const key = `${skill}|${kind}|${i}|${r}|${hash(prompt)}`;
      if (!done.has(key)) jobs.push({ key, skill, kind, i, r, split, prompt });
    }
  });
}
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); }

function runOne(job) {
  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "trig-"));
    fs.cpSync(FIXTURE, cwd, { recursive: true });
    const child = spawn(process.execPath, [CLI, "--mode", "json", "-p", "--no-session", "--no-skills", "--no-extensions", "--no-mcp", "--tools", "read,grep,find,ls", "--append-system-prompt", CTX, "--skill", skillsDir, "--model", MODEL], { cwd, windowsHide: true });
    let buf = "", tools = 0, outcome = null, err = ""; const trace = [];
    const finish = (o) => { if (outcome) return; outcome = o; try { child.kill(); } catch {} };
    const timer = setTimeout(() => finish("TIMEOUT"), 180_000);
    child.stdout.on("data", (d) => {
      buf += d; let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "tool_execution_start") {
          const a = e.args ?? {};
          const target = String(a.path ?? a.file_path ?? a.command ?? "").replace(/\\/g, "/");
          trace.push(e.toolName + ":" + target.slice(-60));
          const m = /skills[^\\/]*[\\/]([\w-]+)[\\/]SKILL\.md/i.exec(target);
          if (m) return finish(m[1]);
          if (++tools >= MAXTOOLS) return finish("NONE");
        }
        if (e.type === "agent_end") return finish("NONE");
        if (e.type === "message_end" && e.message?.role === "assistant" && e.message?.stopReason === "error") return finish("ERROR:" + (e.message.errorMessage ?? "").slice(0, 120));
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => { clearTimeout(timer); fs.rmSync(cwd, { recursive: true, force: true }); resolve({ got: outcome ?? ("NONE?" + err.slice(-120)), trace }); });
    child.stdin.end(job.prompt + "\n");
  });
}

let next = 0, n = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    let res = await runOne(job);
    for (let t = 0; t < 4 && /^ERROR|TIMEOUT/.test(res.got); t++) { await new Promise((r) => setTimeout(r, 15_000 * (t + 1))); res = await runOne(job); }
    const { got, trace } = res;
    const pass = job.kind === "fire" ? got === job.skill : got !== job.skill;
    fs.appendFileSync(outFile, JSON.stringify({ ...job, got, pass, trace }) + "\n");
    if (++n % 20 === 0) console.error(`${n}/${jobs.length}`);
  }
}
console.error(`jobs: ${jobs.length}`);
await Promise.all(Array.from({ length: CONC }, worker));
