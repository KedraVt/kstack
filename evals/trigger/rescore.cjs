// rescore.cjs <results.jsonl> — recompute `got` from the tool traces (the skill dir may be skills, skills-r1, skills-r2, ...).
const fs = require("fs");
const file = process.argv[2];
const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
let changed = 0;
for (const r of rows) {
  let got = "NONE";
  for (const t of r.trace ?? []) {
    const m = /([^\\/]+)[\\/]SKILL\.md/i.exec(t);
    if (m) { got = m[1]; break; }
  }
  if (got !== r.got) changed++;
  r.got = got;
  r.pass = r.kind === "fire" ? got === r.skill : got !== r.skill;
}
fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`rescored ${file}: ${changed} changed`);
