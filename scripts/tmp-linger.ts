// Temporary (item ci-gate-45): for each test file's process, the seconds from the end of its last test to its exit, and what
// was still open 200 ms after the last test. Loaded into every process of the shard by NODE_OPTIONS; acts only in a test file's.
if (process.env.LINGER_LOG && process.env.NODE_TEST_CONTEXT && process.argv[1]?.endsWith(".test.ts")) {
  const { after } = await import("node:test");
  const { appendFileSync } = await import("node:fs");
  const file = process.argv[1], log = process.env.LINGER_LOG!;
  let ended = performance.now(), held = "";
  after(() => { ended = performance.now(); setTimeout(() => { held = process.getActiveResourcesInfo().join(","); }, 200).unref(); });
  process.on("exit", () => appendFileSync(log, `${((performance.now() - ended) / 1000).toFixed(2)} ${file.replace(process.cwd() + "/", "")} ${held}\n`));
}
export {};
