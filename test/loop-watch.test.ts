import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { GcTime, LoopWatch, systemMeters, watchLoop } from "../src/loop-watch.ts";

// The log line of a held event loop and the readings it carries to say why (docs/design.md, section 4, Time limits).

/** Meters the test sets: the totals so far, as the real ones count them. */
function fake() {
  const total = { cpu: 0, gc: 0, load: 0 };
  return { total, meters: { cpuMs: () => total.cpu, gcMs: () => total.gc, load: () => total.load } };
}
/** A watch on a clock the test moves, its readings taken at once. */
function watcher(options: { settle?: (read: () => void) => void } = {}) {
  const { total, meters } = fake();
  const lines: string[] = [];
  const watch = new LoopWatch({ now: 0, intervalMs: 100, stallMs: 500, log: line => lines.push(line), meters, settle: options.settle ?? (read => read()) });
  return { total, lines, watch };
}
/** The number after `name` in a held-loop line. */
const reading = (line: string, name: string): number => Number(new RegExp(`${name} (\\d+(?:\\.\\d+)?)`).exec(line)?.[1]);

/** A function that runs a collection, which node gives only to a process started with the flag. */
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
/** Allocates and drops, then collects, until `ms` have passed on the clock. */
function collectFor(ms: number): void {
  for (const until = performance.now() + ms; performance.now() < until;) { void Array.from({ length: 20000 }, (_, i) => ({ i })); collect(); }
}
/** Blocks the thread for `ms` without using the CPU, as a process that is not given one does. */
const blockFor = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

test("the event loop watch tells a timer that came late, by how late, and not one that came on time", () => {
  const { lines, watch: w } = watcher();
  w.tick(100); w.tick(205); w.tick(699);
  assert.deepEqual(lines, [], "up to 399 ms late is within the 500 ms");
  w.tick(1299);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^event loop held for 500 ms \(a timer due every 100 ms came that late\); cpu /, "exactly the limit counts");
  w.tick(1399); w.tick(3699);
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /^event loop held for 2200 ms /);
});

test("the line tells the CPU time of the process since the timer's last firing, not its total", () => {
  const { total, lines, watch: w } = watcher();
  // Used before the watch started, and in a quiet interval: neither is the stall's.
  total.cpu = 5000; w.tick(100);
  total.cpu = 5030; w.tick(200);
  total.cpu = 5930; w.tick(1200);
  assert.equal(lines.length, 1);
  assert.equal(reading(lines[0]!, "cpu"), 900, lines[0]);
  // The second stall is counted from the first line's reading.
  total.cpu = 6330; w.tick(2300);
  assert.equal(reading(lines[1]!, "cpu"), 400, lines[1]);
});

test("the line tells the time the process spent in garbage collection since the timer's last firing, not its total", () => {
  const { total, lines, watch: w } = watcher();
  total.gc = 800; w.tick(100);
  total.gc = 810; w.tick(200);
  total.gc = 880; w.tick(1200);
  assert.equal(lines.length, 1);
  assert.equal(reading(lines[0]!, "gc"), 70, lines[0]);
  total.gc = 1280; w.tick(2300);
  assert.equal(reading(lines[1]!, "gc"), 400, lines[1]);
});

test("the line tells the load average as it is when the stall is told, with two decimals", () => {
  const { total, lines, watch: w } = watcher();
  total.load = 0.5; w.tick(100);
  total.load = 2.5; w.tick(1200);
  total.load = 0.3; w.tick(2300);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /; cpu 0 ms, gc 0 ms, load 2\.50$/);
  assert.match(lines[1]!, /; cpu 0 ms, gc 0 ms, load 0\.30$/);
});

test("the readings of a stall are taken after the timer's callback, when the entries of its collections have arrived", () => {
  const waiting: (() => void)[] = [];
  const { total, lines, watch: w } = watcher({ settle: read => { waiting.push(read); } });
  w.tick(1200);
  assert.deepEqual(lines, [], "nothing is told while the readings wait");
  // The entries of a collection that ran in the stall are handed over now.
  total.gc = 70;
  assert.equal(waiting.length, 1);
  waiting[0]!();
  assert.equal(reading(lines[0]!, "gc"), 70, lines[0]);
});

test("the meters of the process turn the CPU time into milliseconds, add its user and system parts and take the first load average", () => {
  const meters = systemMeters({ ms: () => 12.5 }, { cpuUsage: () => ({ user: 1_500_000, system: 250_000 }), loadavg: () => [1.5, 2.5, 3.5] });
  assert.equal(meters.cpuMs(), 1750);
  assert.equal(meters.gcMs(), 12.5);
  assert.equal(meters.load(), 1.5);
});

test("the garbage collection time counts the collections and stops counting when stopped", async () => {
  const gc = new GcTime();
  const before = gc.ms();
  for (let i = 0; i < 5; i++) { void Array.from({ length: 20000 }, (_, n) => ({ n })); collect(); }
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const after = gc.ms();
  assert.ok(after > before, `five collections took no time: ${before} to ${after}`);
  gc.stop();
  collectFor(30);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gc.ms(), after, "a stopped meter counts no more");
});

test("a loop that is really held is told, and a stopped watch tells nothing more", async () => {
  const lines: string[] = [];
  const stop = watchLoop({ intervalMs: 20, stallMs: 300, log: line => lines.push(line) });
  await sleep(60);
  // Hold the loop, as a long piece of synchronous work would.
  const from = performance.now();
  while (performance.now() - from < 450) { /* held */ }
  await sleep(60);
  assert.ok(lines.length >= 1, "the stall is told");
  const held = reading(lines.at(-1)!, "event loop held for");
  assert.ok(held >= 400, String(lines.at(-1)));
  stop();
  const told = lines.length, stopped = performance.now();
  while (performance.now() - stopped < 450) { /* held again, unwatched */ }
  await sleep(60);
  assert.equal(lines.length, told);
});

test("a loop held by code that computes tells the CPU it used, and one held by a blocked process tells it used none", async () => {
  const lines: string[] = [];
  const stop = watchLoop({ intervalMs: 20, stallMs: 300, log: line => lines.push(line) });
  try {
    await sleep(60);
    const from = performance.now();
    while (performance.now() - from < 450) { /* computing */ }
    await sleep(60);
    const busy = lines.at(-1)!;
    assert.ok(reading(busy, "cpu") >= reading(busy, "event loop held for") / 2, busy);
    const told = lines.length;
    blockFor(450);
    await sleep(60);
    assert.ok(lines.length > told, "the blocked stretch is told");
    const blocked = lines.at(-1)!;
    assert.ok(reading(blocked, "event loop held for") >= 400, blocked);
    assert.ok(reading(blocked, "cpu") <= reading(blocked, "event loop held for") / 2, blocked);
  } finally { stop(); }
});

test("a loop held by garbage collection tells the time of the collections, also when they ran in a callback of the check phase", async () => {
  const lines: string[] = [];
  const stop = watchLoop({ intervalMs: 20, stallMs: 300, log: line => lines.push(line) });
  try {
    await sleep(60);
    await new Promise<void>(resolve => setImmediate(() => { collectFor(450); resolve(); }));
    await sleep(60);
    assert.equal(lines.length, 1, lines.join("\n"));
    const line = lines[0]!;
    assert.ok(reading(line, "event loop held for") >= 400, line);
    assert.ok(reading(line, "gc") >= reading(line, "event loop held for") / 4, line);
  } finally { stop(); }
});
