// dedupe.cjs <results.jsonl> — keep the first row per key (concurrent launchers wrote duplicates).
const fs = require("fs");
const file = process.argv[2];
const seen = new Set();
const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const out = rows.filter((r) => {
  if (seen.has(r.key)) return false;
  seen.add(r.key);
  return true;
});
fs.writeFileSync(file, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`${file}: ${rows.length} -> ${out.length}`);
