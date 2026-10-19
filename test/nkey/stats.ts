// What the n-key lane's time layer concludes from its pairs (docs/design.md, section 11, The n-key lane): the ratio of one page's busy
// time to another's over pairs of presses made one after the other, with its 95% interval, and the verdict that reads two such
// intervals together. A ratio is judged from its interval and the measured noise of the same page against itself, never from a
// threshold picked in advance (the shared rules' engineering standards, Experiments and performance).

/** Student's t quantile for a two-sided 95% interval, per degrees of freedom up to 30; beyond that the series in 1/df is exact to 4 digits. */
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
export function tQuantile(df: number): number {
  if (df < 1) return Infinity;
  if (df <= T95.length) return T95[df - 1]!;
  const z = 1.959964;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df);
}

/** The ratio of `a` to `b` over `n` pairs: the geometric mean of the per-pair ratios and its 95% interval, `half` the interval's half width as a fraction of the ratio (0.05 is ±5%). */
export interface Interval { n: number; ratio: number; lo: number; hi: number; half: number }

export function compare(a: readonly number[], b: readonly number[]): Interval {
  if (a.length !== b.length) throw new Error(`pairs of different lengths: ${a.length} and ${b.length}`);
  const n = a.length, logs = a.map((x, k) => Math.log(Math.max(x, 1e-9) / Math.max(b[k]!, 1e-9)));
  if (n < 2) return { n, ratio: n ? Math.exp(logs[0]!) : NaN, lo: 0, hi: Infinity, half: Infinity };
  const mean = logs.reduce((s, x) => s + x, 0) / n, sd = Math.sqrt(logs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const h = tQuantile(n - 1) * sd / Math.sqrt(n);
  return { n, ratio: Math.exp(mean), lo: Math.exp(mean - h), hi: Math.exp(mean + h), half: Math.exp(h) - 1 };
}

/** The reference a page is judged against: per pair, the geometric mean of the base and its twin, two samples of the same page. A
 * slow press of either falls half into the reference, where judging against each in turn would let whichever happened to be slower
 * decide, and the residual bias between identical windows is averaged (docs/design.md, The n-key lane). */
export function reference(base: readonly number[], twin: readonly number[]): number[] {
  if (base.length !== twin.length) throw new Error(`pairs of different lengths: ${base.length} and ${twin.length}`);
  return base.map((b, k) => Math.sqrt(b * twin[k]!));
}

/** Whether a page compared with its own twin shows the noise of this run: its interval is no wider than the noise floor measured for
 * this kind of press (the floor is the widest half width seen for pages that are the same). Where the interval lies is not asked: the
 * windows of one process keep a residual bias of 1–3% between identical pages (docs/design.md, The n-key lane), and a twin that misses 1
 * by it would otherwise leave a page several percent slower unjudged. */
export function twinIsSound(twin: Interval, floor: number): boolean {
  return twin.half <= floor;
}

/** How much wider the 95% interval over `n` pairs is than one over `full` pairs of the same spread: t(n−1)/√n against t(full−1)/√full. */
export function intervalWidth(n: number, full: number): number {
  const w = (k: number) => tQuantile(k - 1) / Math.sqrt(k);
  return w(n) / w(full);
}

/** The noise floor for a twin over `n` pairs, the floor having been measured over `full` pairs: widened by what fewer pairs widen the
 * interval, so that a round cut short by the time budget still asks for the same noise per pair. Not narrowed for more pairs: pooled
 * rounds keep the floor measured for one (docs/design.md, The n-key lane). The floor is a half width as a fraction (0.076 is ±7.6%),
 * so it is widened in the logs of the ratio, where the interval is symmetric. */
export function floorAt(floor: number, n: number, full: number): number {
  return Math.expm1(Math.log1p(floor) * Math.max(1, intervalWidth(n, full)));
}

/** Whether a round goes on pairing: it has fewer pairs than wanted, and either the time budget is not used up (`now` before `until`) or
 * it has not yet made the `least` pairs a verdict can be read from. Counts are of landings. */
export function keepPairing(landed: number, wanted: number, least: number, now: number, until: number): boolean {
  return landed < wanted && (now < until || landed < least);
}

/** Whether another round, taking as long as the last one did, ends within the time budget (`now` and `until` on the same clock). */
export function roundFits(now: number, lastRound: number, until: number): boolean {
  return now + lastRound <= until;
}

export type Verdict = "ok" | "red" | "undecided";
/** The verdict on a page compared with the reference (`reference`), read with the twin of the base compared with the base:
 * - undecided: the twin's interval is wider than the floor, so the run's noise is not the noise the floor was set from and it says nothing;
 * - red: the page's interval against the reference lies wholly on the slower side of 1, of any size;
 * - ok: otherwise (including a page that is faster). */
export function judge(twin: Interval, page: Interval, floor: number): Verdict {
  if (!twinIsSound(twin, floor)) return "undecided";
  return page.lo > 1 ? "red" : "ok";
}

/** An interval as a short text: `×1.031 [0.998, 1.065] ±3.3% over 30 pairs`. */
export function show(i: Interval): string {
  const f = (x: number) => x.toFixed(3);
  return `×${f(i.ratio)} [${f(i.lo)}, ${f(i.hi)}] ±${(i.half * 100).toFixed(1)}% over ${i.n} pairs`;
}

/** The order in which `n` windows press in one round: a random permutation drawn with `next` (uniform in [0, 1)), a new one each
 * round. A press leaves the process in a state the next presses inherit, so any fixed order lets a window carry the effect of the
 * windows before it into the comparison as a bias the interval does not see: the rotation balanced only the place in the round, and a
 * cycle in which each window follows each other once still left the base two presses after the slow witness in two rounds of three.
 * Drawn afresh each round with a seed of each run's own, the effect falls on every window alike on average and adds to the spread of
 * the pairs, which the interval measures (docs/design.md, The n-key lane). */
export function randomOrder(n: number, next: () => number): number[] {
  const order = [...Array(n).keys()];
  for (let k = n - 1; k > 0; k--) { const j = Math.floor(next() * (k + 1)); [order[k], order[j]] = [order[j]!, order[k]!]; }
  return order;
}
