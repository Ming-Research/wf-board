// Temporary (item memory-flags-flake): for a traced run of the probe, prints the readings that passed 8.3 MB and the trace lines around them.
const text = require("node:fs").readFileSync(process.argv[2], "utf8").split("\n");
const result = JSON.parse(text.find(l => l.startsWith("RESULT ")).slice(7));
const over = result.sizes.map((s, i) => [i, s]).filter(([, s]) => s > 8.3).map(([i]) => i);
if (!over.length) { console.log("no reading over 8.3"); process.exit(0); }
const from = result.at[Math.max(over[0] - 1, 0)] - 150, to = result.at[Math.min(over.at(-1) + 1, result.at.length - 1)] + 150;
console.log("readings (sample k, time ms, size MB, used MB):");
for (let i = Math.max(over[0] - 2, 0); i <= Math.min(over.at(-1) + 2, result.sizes.length - 1); i++) console.log(`  ${i * 50}k  ${result.at[i]} ms  ${result.sizes[i].toFixed(1)}  ${result.used[i].toFixed(1)}`);
console.log(`trace lines from ${from} to ${to} ms:`);
for (const l of text) {
  const m = /\]\s+(\d+) ms: /.exec(l);
  if (m && Number(m[1]) >= from && Number(m[1]) <= to) console.log(l.replace(/\[\d+:0x[0-9a-f]+(:\d+)?\]\s+/, "").replace(/, pooled.*?ms\s+\(average mu = [\d.]+, current mu = [\d.]+\)/, " ...").slice(0, 200));
}
