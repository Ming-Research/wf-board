// Temporary (item memory-flags-flake): the test's probe, printing the new space's size at every sample (variant "sync").
(() => {
  const v8 = require("node:v8");
  const keep = [];
  const sizes = [], used = [], at = [];
  for (let i = 0; i < 3_000_000; i++) {
    keep.push({ i, text: "x" + i });
    if (i % 50_000 === 0) {
      const s = v8.getHeapSpaceStatistics().find(s => s.space_name === "new_space");
      sizes.push(s.space_size / 1048576); used.push(s.space_used_size / 1048576); at.push(Math.round(performance.now()));
    }
  }
  console.log("RESULT " + JSON.stringify({ sizes, used, at }));
})();
