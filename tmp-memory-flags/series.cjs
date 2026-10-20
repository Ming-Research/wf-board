// Temporary (item memory-flags-flake): the test's probe, printing the new space's readings at every sample.
(() => {
  const v8 = require("node:v8");
  const keep = [];
  const series = [];
  let peak = 0;
  for (let i = 0; i < 3_000_000; i++) {
    keep.push({ i, text: "x" + i });
    if (i % 50_000 === 0) {
      const s = v8.getHeapSpaceStatistics().find(s => s.space_name === "new_space");
      series.push([i / 1000, s.space_size, s.space_used_size, s.physical_space_size]);
      peak = Math.max(peak, s.space_size);
    }
  }
  const mb = x => (x / 1048576).toFixed(1);
  console.log(JSON.stringify({ peak: peak / 1048576, series: series.map(([k, a, b, c]) => `${k}k:${mb(a)}/${mb(b)}/${mb(c)}`).join(" ") }));
})();
