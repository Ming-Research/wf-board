// Temporary (item memory-flags-flake): reads the probe's output on stdin and prints "ROW <variant> <flags> <peak> <median> <min of the second half>".
const [variant, flags] = process.argv.slice(2);
const line = require("node:fs").readFileSync(0, "utf8").split("\n").find(l => l.startsWith("RESULT "));
if (!line) { console.log(`ROW ${variant} ${flags} NaN NaN NaN`); process.exit(0); }
const { sizes } = JSON.parse(line.slice(7));
const sorted = [...sizes].sort((a, b) => a - b);
const late = sizes.slice(Math.floor(sizes.length / 2));
console.log(`ROW ${variant} ${flags} ${Math.max(...sizes)} ${sorted[Math.floor(sorted.length / 2)]} ${Math.min(...late)}`);
