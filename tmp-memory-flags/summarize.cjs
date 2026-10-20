// Temporary (item memory-flags-flake): reads lines "<variant> <flags|none> <peak> <median> <min of the second half>" and prints, per variant
// and flags, the number of readings, the histogram of peaks and the largest median.
const rows = require("node:fs").readFileSync(0, "utf8").split("\n").filter(l => /^ROW /.test(l)).map(l => l.split(" ").slice(1));
const groups = new Map();
for (const [variant, flags, peak, median, lateMin] of rows) {
  const key = `${variant} ${flags}`;
  const g = groups.get(key) ?? { peaks: [], medians: [], lateMins: [] };
  g.peaks.push(Number(peak)); g.medians.push(Number(median)); g.lateMins.push(Number(lateMin));
  groups.set(key, g);
}
for (const [key, g] of [...groups].sort()) {
  const hist = {};
  for (const p of g.peaks) hist[p] = (hist[p] ?? 0) + 1;
  const over12 = g.peaks.filter(p => p > 12).length, medOver12 = g.medians.filter(p => p > 12).length;
  console.log(`${key}: n=${g.peaks.length} peak>12: ${over12} median>12: ${medOver12} max peak ${Math.max(...g.peaks)} max median ${Math.max(...g.medians)} min median ${Math.min(...g.medians)} max late-min ${Math.max(...g.lateMins)} min late-min ${Math.min(...g.lateMins)}`);
  console.log("   peaks:", JSON.stringify(hist));
}
