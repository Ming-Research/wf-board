import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { GcTime, LoopWatch, systemMeters, watchLoop } from "../src/loop-watch.ts";

// The log line of a held event loop and the readings it carries to say why (docs/design.md, section 4, Time limits).

/** Meters the test sets: the CPU total so far and the load as the real ones count them, and the collections, each with the time it
 * began on the clock the test moves. */
function fake() {
  const total = { cpu: 0, load: 0 };
  const collections: { start: number; ms: number }[] = [];
  const collected = (start: number, ms: number): void => { collections.push({ start, ms }); };
  const gcMs = (from: number, to: number): number => collections.filter(c => c.start > from && c.start <= to).reduce((sum, c) => sum + c.ms, 0);
  return { total, collected, meters: { cpuMs: () => total.cpu, gcMs, load: () => total.load } };
}
/** A watch on a clock the test moves, its readings taken at once. */
function watcher(options: { settle?: (read: () => void) => void } = {}) {
  const { total, collected, meters } = fake();
  const lines: string[] = [];
  const watch = new LoopWatch({ now: 0, intervalMs: 100, stallMs: 500, log: line => lines.push(line), meters, settle: options.settle ?? (read => read()) });
  return { total, collected, lines, watch };
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
  assert.equal(reading(lines[0]!, "cpu"), 900, lines[0]!);
  // The second stall is counted from the timer's firing before it.
  total.cpu = 6330; w.tick(2300);
  assert.equal(reading(lines[1]!, "cpu"), 400, lines[1]!);
});

test("the line tells the time of the collections that began between the timer's last two firings, not the total", () => {
  const { collected, lines, watch: w } = watcher();
  // Before the stall's stretch, and one that began as the stretch began: neither is the stall's.
  collected(50, 800); w.tick(100);
  collected(150, 10); collected(200, 5); w.tick(200);
  // Two inside, and one that began as the timer fired.
  collected(700, 70); collected(1100, 30); collected(1200, 2); w.tick(1200);
  assert.equal(lines.length, 1);
  assert.equal(reading(lines[0]!, "gc"), 102, lines[0]!);
  collected(2000, 400); w.tick(2300);
  assert.equal(reading(lines[1]!, "gc"), 400, lines[1]!);
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

test("a stall is told after the timer's callback, when the entries of its collections have arrived", () => {
  const waiting: (() => void)[] = [];
  const { collected, lines, watch: w } = watcher({ settle: read => { waiting.push(read); } });
  w.tick(100);
  w.tick(1200);
  assert.deepEqual(lines, [], "nothing is told while the telling waits");
  // The entries of a collection that ran in the stall are handed over now, one that began before the stretch with it.
  collected(900, 70); collected(50, 40);
  assert.equal(waiting.length, 1);
  waiting[0]!();
  assert.equal(reading(lines[0]!, "gc"), 70, lines[0]!);
});

test("when the loop is held again before a stall is told, each line has the readings of its own stretch", () => {
  const waiting: (() => void)[] = [];
  const { total, collected, lines, watch: w } = watcher({ settle: read => { waiting.push(read); } });
  total.cpu = 10; w.tick(100);
  total.cpu = 40; w.tick(200);
  // The first stall: 900 ms of CPU and a collection of 20 ms between the firings at 200 and 1200.
  collected(700, 20); total.cpu = 940; w.tick(1200);
  // Before it is told the loop is held for much longer, by code that computes and by a collection.
  collected(3000, 300); total.cpu = 4940; total.load = 7.5;
  waiting[0]!();
  // The second stall, between the firings at 1200 and 6100, which is told after the first.
  w.tick(6100);
  waiting[1]!();
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^event loop held for 900 ms .*; cpu 900 ms, gc 20 ms, load 7\.50$/, lines[0]!);
  assert.match(lines[1]!, /^event loop held for 4800 ms .*; cpu 4000 ms, gc 300 ms, load 7\.50$/, lines[1]!);
});

test("the meters of the process turn the CPU time into milliseconds, add its user and system parts and take the first load average", () => {
  const asked: number[][] = [];
  const meters = systemMeters({ ms: (from, to) => { asked.push([from, to]); return 12.5; } }, { cpuUsage: () => ({ user: 1_500_000, system: 250_000 }), loadavg: () => [1.5, 2.5, 3.5] });
  assert.equal(meters.cpuMs(), 1750);
  assert.equal(meters.gcMs(100, 900), 12.5);
  assert.deepEqual(asked, [[100, 900]], "the stretch is passed on to the collections' record");
  assert.equal(meters.load(), 1.5);
});

test("the garbage collection time counts the collections by the stretch they began in, and stops counting when stopped", async () => {
  const gc = new GcTime();
  const burst = (): void => { for (let i = 0; i < 5; i++) { void Array.from({ length: 20000 }, (_, n) => ({ n })); collect(); } };
  burst();
  const middle = performance.now();
  burst();
  const end = performance.now();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const first = gc.ms(0, middle), second = gc.ms(middle, end);
  assert.ok(first > 0 && second > 0, `five collections took no time: ${first}, ${second}`);
  assert.ok(Math.abs(gc.ms(0, end) - (first + second)) < 1e-6, "the two stretches add up to the whole, each collection in one");
  gc.stop();
  const stopped = performance.now();
  collectFor(30);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gc.ms(stopped, performance.now()), 0, "a stopped meter counts no more");
});

test("the garbage collection time forgets the collections older than it keeps", async () => {
  const gc = new GcTime(50);
  try {
    const start = performance.now();
    collect();
    await sleep(120);
    collect();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(gc.ms(start, start + 60), 0, "the first collection is forgotten");
    assert.ok(gc.ms(start + 100, performance.now()) > 0, "the later one is kept");
  } finally { gc.stop(); }
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
