// The arithmetic and the verdict of the n-key lane's time layer (test/nkey/stats.ts), on pairs made up here whose answer is known.
import { test } from "node:test";
import assert from "node:assert/strict";
import { balancedOrders, compare, judge, tQuantile, twinIsSound } from "./stats.ts";
import type { Interval } from "./stats.ts";
import { prng } from "../e2e/board-gen.ts";

/** `n` busy times around `center` with a relative spread of `noise` (uniform, from a seeded generator). */
function series(n: number, center: number, noise: number, seed: number): number[] {
  const rnd = prng(seed);
  return Array.from({ length: n }, () => center * (1 + noise * (2 * rnd.next() - 1)));
}
const interval = (lo: number, hi: number): Interval => ({ n: 30, ratio: Math.sqrt(lo * hi), lo, hi, half: Math.sqrt(hi / lo) - 1 });

test("the t quantile matches the table of the 95% two-sided values", () => {
  // Reference values of the t distribution (any statistics table): df 40, 60, 90, 120.
  for (const [df, want] of [[29, 2.045], [40, 2.021], [60, 2.000], [90, 1.987], [120, 1.980]] as const) assert.ok(Math.abs(tQuantile(df) - want) < 0.001, `df ${df}: ${tQuantile(df)} against ${want}`);
});

test("pairs of a page against itself give an interval that holds 1, and a page 30% slower gives one wholly above it", () => {
  const base = series(30, 80, 0.1, 1), same = series(30, 80, 0.1, 2), slower = series(30, 80 * 1.3, 0.1, 3);
  const noise = compare(same, base), slow = compare(slower, base);
  assert.ok(noise.lo < 1 && noise.hi > 1, `the interval of the same page holds 1: ${noise.lo}–${noise.hi}`);
  assert.ok(slow.lo > 1.2 && slow.hi < 1.45, `the page 30% slower reads ×${slow.ratio} [${slow.lo}, ${slow.hi}]`);
  assert.ok(Math.abs(slow.ratio - 1.3) < 0.06);
});

test("the interval is the t interval of the per-pair log ratios: a known case", () => {
  // Per-pair ratios 1.1, 1.2, 1.3 and 1.4: the interval is exp(mean ± t(3) * sd / 2) of their logs, t(3) = 3.182, worked out here.
  const i = compare([110, 120, 130, 140], [100, 100, 100, 100]);
  const logs = [1.1, 1.2, 1.3, 1.4].map(Math.log), mean = logs.reduce((a, b) => a + b) / 4;
  const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / 3), h = 3.182 * sd / 2;
  assert.ok(Math.abs(i.ratio - Math.exp(mean)) < 1e-9);
  assert.ok(Math.abs(i.lo - Math.exp(mean - h)) < 1e-9 && Math.abs(i.hi - Math.exp(mean + h)) < 1e-9);
  assert.throws(() => compare([1, 2], [1]), /different lengths/);
  assert.equal(compare([5], [5]).half, Infinity, "one pair says nothing");
});

test("the verdict: the twin must show this run's noise before the page is judged, and any size above 1 is red once it does", () => {
  const floor = 0.061;
  // A twin whose interval holds 1 within the floor: the run counts.
  const sound = interval(0.97, 1.03);
  assert.ok(twinIsSound(sound, floor));
  assert.equal(judge(sound, interval(1.001, 1.02), floor), "red", "a page a hair slower, wholly above 1, is red");
  assert.equal(judge(sound, interval(0.98, 1.04), floor), "ok", "an interval across 1 is no detected change");
  assert.equal(judge(sound, interval(0.8, 0.9), floor), "ok", "a page that is faster is not red");
  // A twin that misses 1 (the run's noise is too large or the machine drifted) or is wider than the floor: the run says nothing.
  assert.equal(judge(interval(1.01, 1.08), interval(1.3, 1.5), floor), "undecided", "the twin's interval misses 1");
  assert.equal(judge(interval(0.9, 1.1), interval(1.3, 1.5), floor), "undecided", "the twin's interval is ±10%, over the floor");
  assert.ok(!twinIsSound(interval(0.9, 1.1), floor));
});

/** How often each window comes right after each other one when the rounds repeat in a cycle, the step between rounds included. */
function followers(orders: number[][]): Map<string, number> {
  const seq = orders.flat(), count = new Map<string, number>();
  seq.forEach((x, k) => { const key = `${seq[(k - 1 + seq.length) % seq.length]}>${x}`; count.set(key, (count.get(key) ?? 0) + 1); });
  return count;
}

test("in the balanced orders every window presses once a round and follows each other window exactly once per cycle", () => {
  for (let n = 2; n <= 6; n++) {
    const orders = balancedOrders(n);
    assert.equal(orders.length, n - 1, `${n} windows: a cycle of ${n - 1} rounds`);
    for (const round of orders) assert.deepEqual([...round].sort(), [...Array(n).keys()], `${n} windows: each round is every window once`);
    const count = followers(orders);
    assert.equal(count.size, n * (n - 1), `${n} windows: every ordered pair of two windows occurs`);
    assert.ok([...count.values()].every(c => c === 1), `${n} windows: no pair occurs twice`);
  }
  // The rotation the lane used before is not balanced: with 4 windows the first (the base) follows the last (the slow witness) in
  // three rounds of four, and the third never.
  const rotation = [0, 1, 2, 3].map(r => [0, 1, 2, 3].map(k => (k + r) % 4));
  assert.equal(followers(rotation).get("3>0"), 3);
  assert.equal(followers(rotation).get("3>2"), undefined);
});
