// The arithmetic and the verdict of the n-key lane's time layer (test/nkey/stats.ts), on pairs made up here whose answer is known.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, floorAt, intervalWidth, judge, keepPairing, randomOrder, reference, roundFits, tQuantile, twinIsSound } from "./stats.ts";
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

test("the verdict: the twin's interval must be within the floor, and a page slower than the reference is red at any size", () => {
  const floor = 0.061;
  // A twin whose interval is within the floor: the run counts, wherever the interval lies.
  const sound = interval(0.97, 1.03);
  assert.ok(twinIsSound(sound, floor));
  assert.ok(twinIsSound(interval(1.005, 1.025), floor), "a twin that misses 1 by the residual bias still counts");
  assert.equal(judge(sound, interval(1.001, 1.02), floor), "red", "a page a hair slower, wholly above 1, is red");
  assert.equal(judge(sound, interval(0.98, 1.04), floor), "ok", "an interval across 1 is no detected change");
  assert.equal(judge(sound, interval(0.8, 0.9), floor), "ok", "a page that is faster is not red");
  // A twin wider than the floor: the run says nothing.
  assert.equal(judge(interval(0.9, 1.1), interval(1.3, 1.5), floor), "undecided", "the twin's interval is ±10%, over the floor");
  assert.ok(!twinIsSound(interval(0.9, 1.1), floor));
});

test("the reference is the geometric mean of base and twin: one of them 4% slow neither hides a page 6% slower nor reddens the same page", () => {
  const floor = 0.076, n = 30;
  // The base window read about 4% slow, as in an acceptance run where judging against the base and the twin in turn let a slower page pass.
  const base = series(n, 80 * 1.04, 0.05, 11), twin = series(n, 80, 0.05, 12), ref = reference(base, twin);
  const twinBase = compare(twin, base);
  assert.ok(twinIsSound(twinBase, floor), `the twin counts the run: ${twinBase.lo}–${twinBase.hi}`);
  const slower = compare(series(n, 80 * 1.06, 0.05, 13), ref);
  assert.equal(judge(twinBase, slower, floor), "red", `a page 6% slower against the reference: ×${slower.ratio} [${slower.lo}, ${slower.hi}]`);
  const same = compare(series(n, 80, 0.05, 14), ref);
  assert.equal(judge(twinBase, same, floor), "ok", `the same page against the reference: ×${same.ratio} [${same.lo}, ${same.hi}]`);
  // Each pair's reference lies between its base and its twin.
  for (let k = 0; k < n; k++) assert.ok(ref[k]! >= Math.min(base[k]!, twin[k]!) && ref[k]! <= Math.max(base[k]!, twin[k]!));
  assert.throws(() => reference([1, 2], [1]), /different lengths/);
});

test("a random order puts every window in every place and after every other window about equally often", () => {
  const rnd = prng(41), n = 4, rounds = 6000;
  const place = Array.from({ length: n }, () => Array(n).fill(0)), after = new Map<string, number>();
  let last: number | undefined;
  for (let r = 0; r < rounds; r++) {
    const order = randomOrder(n, rnd.next);
    assert.deepEqual([...order].sort(), [0, 1, 2, 3], "each round is every window once");
    order.forEach((w, k) => { place[w]![k]++; if (last !== undefined) after.set(`${last}>${w}`, (after.get(`${last}>${w}`) ?? 0) + 1); last = w; });
  }
  // Each window in each place in a quarter of the rounds, within 4 standard deviations (one is about 34 of 1500).
  for (const row of place) for (const c of row) assert.ok(Math.abs(c - rounds / n) < 4 * Math.sqrt(rounds * (1 / n) * (1 - 1 / n)), `a place held ${c} times of ${rounds}`);
  // After another window: each of the 12 ordered pairs, and a window after itself across a round's end, near their expected shares.
  const steps = rounds * n - 1, others = [...after].filter(([k]) => k[0] !== k[2]).map(([, c]) => c);
  assert.equal(others.length, n * (n - 1));
  const mean = others.reduce((a, c) => a + c, 0) / others.length;
  for (const c of others) assert.ok(Math.abs(c - mean) < 0.1 * mean, `an ordered pair followed ${c} times against ${mean.toFixed(0)} (${steps} steps)`);
});

test("a fixed rotation is not balanced, which the random order replaces", () => {
  // With 4 windows the first (the base) follows the last (the slow witness) in three rounds of four, and the third never.
  const rotation = [0, 1, 2, 3].map(r => [0, 1, 2, 3].map(k => (k + r) % 4)), seq = rotation.flat(), count = new Map<string, number>();
  seq.forEach((x, k) => { const key = `${seq[(k - 1 + seq.length) % seq.length]}>${x}`; count.set(key, (count.get(key) ?? 0) + 1); });
  assert.equal(count.get("3>0"), 3);
  assert.equal(count.get("3>2"), undefined);
});

/** `n` (even) pairs whose log ratios alternate ±`d`: the interval of their ratio is centred on 1 and its width follows `d` alone. */
const alternating = (n: number, d: number) => Array.from({ length: n }, (_, k) => 80 * Math.exp(k % 2 ? d : -d));

test("a floor measured over 30 pairs is widened for fewer pairs by what the interval widens, and kept for more", () => {
  assert.equal(intervalWidth(30, 30), 1);
  // t(19)/√20 against t(29)/√30 = (2.093 / 4.472) / (2.045 / 5.477) = 1.2535.
  assert.ok(Math.abs(intervalWidth(20, 30) - 1.2535) < 0.001, `20 pairs: ×${intervalWidth(20, 30)}`);
  assert.ok(intervalWidth(60, 30) < 1, "more pairs narrow it");
  assert.equal(floorAt(0.076, 30, 30), 0.076);
  assert.equal(floorAt(0.076, 60, 30), 0.076, "pooled rounds keep the floor of one round");
  // The floor is a fraction (0.076 is ±7.6%), widened in the logs: log(1.076) × 1.2535 = 0.0918, and exp(0.0918) − 1 = 0.0962.
  assert.ok(Math.abs(floorAt(0.076, 20, 30) - 0.0962) < 0.0005, `20 pairs: ±${floorAt(0.076, 20, 30)}`);
});

test("a round cut short asks for the same noise per pair: the widened floor takes a twin of the floor's spread and refuses a noisier one", () => {
  const floor = 0.076;
  // The spread at which the interval over 30 pairs is exactly the floor: half width = t(29) · sd / √30, in logs; sd of ±d alternating is d√(n/(n−1)).
  const d30 = Math.log1p(floor) * Math.sqrt(30) / tQuantile(29) / Math.sqrt(30 / 29);
  const at = (n: number, factor: number) => compare(alternating(n, d30 * factor), Array(n).fill(80));
  assert.ok(twinIsSound(at(30, 0.99), floor) && !twinIsSound(at(30, 1.03), floor), "the floor is the edge over 30 pairs");
  for (const n of [16, 20, 24]) {
    const narrow = at(n, 0.97), wide = at(n, 1.05);
    assert.ok(!twinIsSound(narrow, floor), `over ${n} pairs the same spread is wider than the floor of 30 (±${(narrow.half * 100).toFixed(1)}%)`);
    assert.ok(twinIsSound(narrow, floorAt(floor, n, 30)), `and counts against the widened floor (±${(floorAt(floor, n, 30) * 100).toFixed(1)}%)`);
    assert.ok(!twinIsSound(wide, floorAt(floor, n, 30)), `a spread 5% above the floor's is refused over ${n} pairs`);
  }
});

test("the time budget: a round pairs until the pairs wanted, or until the budget is used up if the least a verdict needs is made", () => {
  // landed, wanted, least, now, until (landings; milliseconds)
  assert.ok(keepPairing(5, 32, 18, 10_000, 34_000), "within the budget, short of the pairs wanted");
  assert.ok(!keepPairing(32, 32, 18, 10_000, 34_000), "the pairs wanted are made");
  assert.ok(!keepPairing(25, 32, 18, 34_000, 34_000), "the budget is used up and more than the least is made");
  assert.ok(!keepPairing(18, 32, 18, 40_000, 34_000), "the least itself is enough");
  assert.ok(keepPairing(17, 32, 18, 40_000, 34_000), "the budget is used up but the least is not made: go on");
  assert.ok(roundFits(20_000, 13_000, 34_000) && roundFits(21_000, 13_000, 34_000), "a round of 13 s begun at 21 s ends at the budget");
  assert.ok(!roundFits(21_001, 13_000, 34_000), "a round of 13 s begun at 21.001 s ends after it");
});

test("a witness of 10 pairs is read as slower than the reference: the page 15 ms slower reads about ×1.5 and a spread of 10% does not hide it", () => {
  // 80 ms and 124 ms are the base and the witness in a writing press of the sample; noise of ±10% in each.
  for (const seed of [1, 2, 3, 4, 5]) {
    const slow = compare(series(10, 124, 0.1, seed), series(10, 80, 0.1, seed + 100));
    assert.ok(slow.lo > 1.3, `seed ${seed}: ×${slow.ratio} [${slow.lo}, ${slow.hi}] over ${slow.n} pairs`);
    assert.equal(judge(interval(0.97, 1.03), slow, 0.076), "red");
  }
});
