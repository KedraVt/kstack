// trigger-report.mjs <results.jsonl> [--detail] — per-skill trigger accuracy (case passes when >50% of its runs pass).
import fs from "node:fs";
const rows = fs.readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const detail = process.argv.includes("--detail");
const by = {};
for (const r of rows) {
  const c = ((by[r.skill] ??= {})[`${r.kind}|${r.i}`] ??= { ...r, runs: [] });
  c.runs.push(r.got);
}
console.log("skill                           fire(train) fire(val)  near-ok(train) near-ok(val)  runs");
for (const [skill, cases] of Object.entries(by)) {
  const stat = (kind, split) => {
    const cs = Object.values(cases).filter((c) => c.kind === kind && c.split === split);
    const ok = cs.filter((c) => c.runs.filter((g) => (kind === "fire" ? g === skill : g !== skill)).length > c.runs.length / 2).length;
    return `${ok}/${cs.length}`.padEnd(12);
  };
  const n = Object.values(cases).reduce((a, c) => a + c.runs.length, 0);
  console.log(skill.padEnd(32), stat("fire", "train"), stat("fire", "val"), stat("near", "train"), "  " + stat("near", "val"), n);
  if (detail) for (const c of Object.values(cases)) {
    const bad = c.runs.filter((g) => (c.kind === "fire" ? g !== skill : g === skill));
    if (bad.length > c.runs.length / 2) console.log(`   ✗ ${c.kind} ${c.split} [${c.runs.join(", ")}] ${c.prompt.slice(0, 90)}`);
  }
}
const errs = rows.filter((r) => /^ERROR|TIMEOUT|NONE\?/.test(r.got)).length;
console.log(`harness errors/timeouts: ${errs}/${rows.length}`);
