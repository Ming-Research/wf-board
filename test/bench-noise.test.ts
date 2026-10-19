// The noise measurement script (scripts/bench-noise.ts): its report on pairs whose answer is known, the order and the dropped
// pairs of a round, the checksum of the job against an apart implementation, and the exits of the script as a process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compare, show } from "./nkey/stats.ts";
import type { Interval } from "./nkey/stats.ts";
import { WORK_CHECKSUM, WORK_SEED, WORK_SIZE, firstOfPair, floorLine, fold, generate, jobStatus, measureRound, noiseFloor, roundLine, work } from "../scripts/bench-noise.ts";
import type { Side } from "../scripts/bench-noise.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/bench-noise.ts", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

/** Four pairs whose per-pair log ratio is `m + s`, `m - s`, `m + s`, `m - s`: the mean is `m` and the sample sd is 2s/√3, so the
 * 95% interval (t = 3.182 for 3 degrees of freedom) is exp(m ± 3.182·s/√3) and its half width exp(3.182·s/√3) - 1, worked out here. */
function round(m: number, s: number): { interval: Interval; half: number } {
  const base = [100, 100, 100, 100], twin = [m + s, m - s, m + s, m - s].map(l => 100 * Math.exp(l));
  return { interval: compare(twin, base), half: Math.exp(3.182 * s / Math.sqrt(3)) - 1 };
}

test("the noise floor is the widest half width of the rounds, whichever round it is", () => {
  // The widest round is in the middle: a floor taken from the first, the last or the mean of the rounds would not be it.
  const rounds = [round(0, 0.01), round(0.002, 0.04), round(-0.001, 0.02)];
  for (const r of rounds) assert.ok(Math.abs(r.interval.half - r.half) < 1e-9, `the interval of the data: ${r.interval.half}, worked out: ${r.half}`);
  const { floor, holding } = noiseFloor(rounds.map(r => r.interval));
  assert.ok(Math.abs(floor - rounds[1]!.half) < 1e-9, `floor ${floor}, widest ${rounds[1]!.half}`);
  assert.ok(floor > rounds[0]!.half && floor > rounds[2]!.half && floor > (rounds[0]!.half + rounds[1]!.half + rounds[2]!.half) / 3);
  assert.equal(holding, 3);
});

test("a round whose interval misses 1 is counted out, and the floor line says so", () => {
  // Round 2 sits wholly above 1 (a twin 10% slower, with a spread of 1%).
  const rounds = [round(0, 0.01), round(Math.log(1.1), 0.01), round(0, 0.02)].map(r => r.interval);
  assert.ok(rounds[1]!.lo > 1);
  assert.equal(noiseFloor(rounds).holding, 2);
  assert.match(floorLine(rounds), /every round's interval holds 1: no \(2 of 3\)/);
  // The same rounds without the shifted one: all hold.
  assert.match(floorLine([rounds[0]!, rounds[2]!]), /every round's interval holds 1: yes \(2 of 2\)/);
});

test("the lines the run prints: a line per round in the format of the n-key lane, then the floor in percent", () => {
  const { interval, half } = round(0, 0.04);
  assert.equal(roundLine(interval, 2), `round 3: ${show(interval)}`);
  assert.match(roundLine(interval, 2), /^round 3: ×1\.000 \[0\.\d+, 1\.\d+\] ±\d+\.\d% over 4 pairs$/);
  assert.equal(floorLine([interval]), `noise floor: ±${(half * 100).toFixed(2)}% (the widest half width of 1 rounds); every round's interval holds 1: yes (1 of 1)`);
});

test("a round alternates which side runs first and drops the first pairs", () => {
  const calls: Side[] = [];
  // The dropped pairs read 1000 ms for the base and 1 ms for the twin; the kept ones 100 and 150 ms. The 4 calls of the 2 dropped
  // pairs come first: if they were kept the ratio would not be 1.5.
  const i = measureRound(3, 2, side => { calls.push(side); return calls.length <= 4 ? (side === "base" ? 1000 : 1) : (side === "base" ? 100 : 150); });
  assert.deepEqual(calls, ["base", "twin", "twin", "base", "base", "twin", "twin", "base", "base", "twin"]);
  assert.deepEqual([0, 1, 2, 3].map(firstOfPair), ["base", "twin", "base", "twin"]);
  assert.equal(i.n, 3);
  assert.ok(Math.abs(i.ratio - 1.5) < 1e-12 && Math.abs(i.lo - 1.5) < 1e-12 && Math.abs(i.hi - 1.5) < 1e-12);
});

test("the checksum of the job is the one an apart implementation gets, and it changes when the job is wrong", () => {
  assert.equal(work(), WORK_CHECKSUM);
  // The fixed value was worked out with a plain Python version of the generator, the sort and the fold. Here a second version,
  // written with ordinary arrays, a comparator sort and BigInt, agrees on smaller sizes.
  const reference = (size: number, seed: number) => {
    const M = 0xffffffffn;
    let x = BigInt(seed), values: bigint[] = [];
    for (let i = 0; i < size; i++) { x ^= (x << 13n) & M; x ^= x >> 17n; x ^= (x << 5n) & M; values.push(x); }
    values = values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let h = 0x811c9dc5n;
    for (const v of values) h = ((h ^ v) * 0x01000193n) & M;
    return Number(h);
  };
  for (const size of [1, 10, 1000, 20_000]) assert.equal(work(size, WORK_SEED), reference(size, WORK_SEED), `size ${size}`);
  // A different seed, a different size, values in the wrong order and a changed value all give another checksum.
  assert.notEqual(work(WORK_SIZE, WORK_SEED + 1), WORK_CHECKSUM);
  assert.notEqual(work(WORK_SIZE - 1, WORK_SEED), WORK_CHECKSUM);
  const sorted = generate(WORK_SIZE, WORK_SEED).sort();
  assert.equal(fold(sorted), WORK_CHECKSUM);
  assert.equal(jobStatus(fold(sorted)), 0);
  assert.equal(jobStatus(fold(generate(WORK_SIZE, WORK_SEED))), 1, "the job exits non-zero for values left unsorted");
  assert.notEqual(fold(generate(WORK_SIZE, WORK_SEED)), WORK_CHECKSUM, "the values as generated, not sorted");
  assert.notEqual(fold(sorted.slice().reverse()), WORK_CHECKSUM, "sorted the wrong way");
  const middle = WORK_SIZE >> 1;
  sorted[middle] = sorted[middle]! ^ 1;
  assert.notEqual(fold(sorted), WORK_CHECKSUM, "one value changed");
  assert.equal(jobStatus(fold(sorted)), 1, "the job exits non-zero for one value changed");
});

test("as a process: the job exits 0, a wrong argument exits 1 saying which", () => {
  const job = run("--work");
  assert.equal(job.status, 0, job.stderr);
  for (const [args, message] of [[["--pairs", "1"], /--pairs must be a whole number of at least 2, not "1"/], [["--rounds", "0"], /--rounds must be .* at least 1/], [["--cpu", "two"], /--cpu must be .* not "two"/], [["--nothing"], /Unknown option/]] as const) {
    const bad = run(...args);
    assert.equal(bad.status, 1, `${args.join(" ")} exits 1`);
    assert.match(bad.stderr, message);
    assert.equal(bad.stdout, "", "nothing is measured");
  }
});

test("as a process: a cpu that cannot be pinned fails the run, naming the command", () => {
  const bad = run("--pairs", "2", "--rounds", "1", "--cpu", "99");
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "", "no round is printed");
  assert.match(bad.stderr, /taskset -c 99 .*bench-noise\.ts --work failed/);
  // On Linux taskset runs and refuses the cpu; the reason is in what it says. Elsewhere there is no taskset to run.
  if (process.platform === "linux") assert.match(bad.stderr, /failed to set pid \d+'s affinity/);
});

test("as a process on Linux: rounds and the noise floor are printed, exit 0", { skip: process.platform !== "linux" }, () => {
  const ok = run("--pairs", "2", "--rounds", "2", "--cpu", "0");
  assert.equal(ok.status, 0, ok.stderr);
  const lines = ok.stdout.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^round 1: ×\d+\.\d{3} \[.*\] ±\d+\.\d% over 2 pairs$/);
  assert.match(lines[1]!, /^round 2: /);
  assert.match(lines[2]!, /^noise floor: ±\d+\.\d{2}% \(the widest half width of 2 rounds\); every round's interval holds 1: (yes|no) \(\d of 2\)$/);
});
