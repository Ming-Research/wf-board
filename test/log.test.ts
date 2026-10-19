import { test } from "node:test";
import assert from "node:assert/strict";
import { stamped, startupLogger, startupMemory, stopwatch, timestampLogs } from "../src/log.ts";

const at = new Date("2026-10-16T18:30:00.123Z");

test("every line of a message carries the time", () => {
  assert.equal(stamped("one", at), "2026-10-16T18:30:00.123Z one");
  assert.equal(stamped("one\ntwo\n", at), "2026-10-16T18:30:00.123Z one\n2026-10-16T18:30:00.123Z two\n2026-10-16T18:30:00.123Z ");
});

test("timestampLogs stamps every level, formats like console and leaves other arguments readable", () => {
  const written: Array<[string, string]> = [];
  const fake = Object.fromEntries(["debug", "info", "log", "warn", "error"].map(level => [level, (text: string) => { written.push([level, text]); }])) as unknown as Console;
  timestampLogs(fake, () => at);
  fake.info("started %s in %d ms", "board", 12);
  fake.error(new Error("failed\nbadly").message, { a: 1 });
  fake.log("100%");
  assert.deepEqual(written, [
    ["info", "2026-10-16T18:30:00.123Z started board in 12 ms"],
    ["error", "2026-10-16T18:30:00.123Z failed\n2026-10-16T18:30:00.123Z badly { a: 1 }"],
    ["log", "2026-10-16T18:30:00.123Z 100%"],
  ]);
});

test("a startup line names the step, its milliseconds and what it found", () => {
  const lines: string[] = [];
  const startup = startupLogger(line => lines.push(line));
  startup("read documents", 12.6, "3 documents");
  startup("check board", 0.2);
  assert.deepEqual(lines, ["startup read documents: 13 ms (3 documents)", "startup check board: 0 ms"]);
});

test("a stopwatch reports the time since its previous call under each step", async () => {
  const seen: Array<[string, number, string | undefined]> = [];
  const lap = stopwatch((step, ms, detail) => seen.push([step, ms, detail]));
  await new Promise(resolve => setTimeout(resolve, 30));
  lap("first", "detail");
  lap("second");
  assert.deepEqual(seen.map(([step, , detail]) => [step, detail]), [["first", "detail"], ["second", undefined]]);
  assert.ok(seen[0]![1] >= 25 && seen[0]![1] < 1000, `the first step waited about 30 ms: ${seen[0]![1]}`);
  assert.ok(seen[1]![1] < seen[0]![1], "the second step started when the first ended");
  assert.doesNotThrow(() => stopwatch()("nobody listens"));
});

test("the startup memory line gives the time of a full collection, then the heap after it and the resident set", () => {
  const seen: Array<[string, number, string | undefined]> = [];
  let collections = 0;
  startupMemory((step, ms, detail) => seen.push([step, ms, detail]), { collect: () => { collections++; }, heapUsed: () => 55.75 * 1024 * 1024, rss: () => 275.04 * 1024 * 1024 });
  assert.equal(collections, 1, "the heap is read after a collection, not before");
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0]![0], seen[0]![2]], ["memory", "heap 55.8 MB in use after a full collection, rss 275.0 MB"]);
  const lines: string[] = [];
  startupLogger(line => lines.push(line))(...seen[0]!);
  assert.match(lines[0]!, /^startup memory: \d+ ms \(heap 55\.8 MB in use after a full collection, rss 275\.0 MB\)$/);
});

test("the startup memory line is a real reading: the process's own heap and resident set, after a collection that runs", () => {
  const lines: string[] = [];
  startupMemory(startupLogger(line => lines.push(line)));
  assert.match(lines[0]!, /^startup memory: \d+ ms \(heap [1-9]\d*\.\d MB in use after a full collection, rss [1-9]\d*\.\d MB\)$/);
});
