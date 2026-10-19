// Noise measurement for the 14900K (the `noise-14900k` workflow runs it by hand): how much the time of one fixed small job
// varies on this machine when the same command is timed against itself. The run's answer is the noise floor of this kind of
// load, the number later runs on the machine are judged against (the shared rules' engineering standards, Experiments and
// performance; docs/design.md, section 11, The n-key lane, uses the same pairs, twin and floor).
//
// Two uses of one file:
//   node scripts/bench-noise.ts --work
//     the job: 1,000,000 integers from a seeded xorshift generator, sorted, folded into one checksum that is compared with the
//     known value; exits 1 when it differs, so a broken sort or generator is never timed as if it were a measurement.
//   node scripts/bench-noise.ts [--pairs 30] [--rounds 5] [--cpu 2]
//     the measurement. A round times `pairs` pairs after 2 pairs that are dropped. Both sides of a pair are the same command,
//     `taskset -c <cpu> node scripts/bench-noise.ts --work`, timed as a whole child process from start to exit; the base and its
//     twin run first by turns, so the effect of running second cancels. Each round prints the ratio of twin to base with its 95%
//     interval (test/nkey/stats.ts); the last line is the noise floor: the widest half width of the rounds' intervals, and
//     whether every round's interval holds 1. Noise itself (an interval that misses 1, or a wide one) never fails the run, it is
//     the result. A child that cannot be pinned (taskset refuses the cpu or is missing) or whose checksum is wrong fails the run.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compare, show } from "../test/nkey/stats.ts";
import type { Interval } from "../test/nkey/stats.ts";

const SELF = fileURLToPath(import.meta.url);

/** The job: how many integers, the generator's seed, and the checksum of the sorted result (worked out apart from this code, with a
 * plain Python version of the same generator, sort and fold). */
export const WORK_SIZE = 1_000_000, WORK_SEED = 0x2545f491, WORK_CHECKSUM = 2828140031;

/** Pairs a round times before the pairs it keeps, so the first runs (cold file cache, a core still waking) are not in the interval. */
export const WARMUP_PAIRS = 2;

/** `size` integers from the 32-bit xorshift generator (13, 17, 5) started at `seed` (not 0). */
export function generate(size: number, seed: number): Uint32Array {
  const out = new Uint32Array(size);
  let x = seed | 0;
  for (let i = 0; i < size; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x; }
  return out;
}

/** The values folded into one 32-bit number, FNV-1a over whole values: it changes when a value or the order of values changes. */
export function fold(values: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < values.length; i++) h = Math.imul(h ^ values[i]!, 0x01000193);
  return h >>> 0;
}

/** The job itself: generate, sort, fold. */
export function work(size = WORK_SIZE, seed = WORK_SEED): number {
  return fold(generate(size, seed).sort());
}

/** The exit status of the job for the checksum it got: 0 only for the known one. */
export const jobStatus = (checksum: number): number => (checksum === WORK_CHECKSUM ? 0 : 1);

/** Which side of pair `k` runs first: base, twin, twin, base, base, ... so a side is as often second as first. */
export type Side = "base" | "twin";
export const firstOfPair = (k: number): Side => (k % 2 === 0 ? "base" : "twin");

/** One round: `warmup` pairs dropped, then `pairs` pairs kept; `timeOf` runs one side's command and returns its time in ms.
 * The result is the interval of the ratio of twin to base. */
export function measureRound(pairs: number, warmup: number, timeOf: (side: Side) => number): Interval {
  const base: number[] = [], twin: number[] = [];
  for (let k = 0; k < warmup + pairs; k++) {
    const first = firstOfPair(k), second: Side = first === "base" ? "twin" : "base";
    const t: Record<Side, number> = { base: 0, twin: 0 };
    t[first] = timeOf(first);
    t[second] = timeOf(second);
    if (k >= warmup) { base.push(t.base); twin.push(t.twin); }
  }
  return compare(twin, base);
}

/** The noise floor of the rounds: the widest half width of their intervals (a fraction, 0.05 is ±5%), and how many hold 1. */
export function noiseFloor(rounds: readonly Interval[]): { floor: number; holding: number } {
  return { floor: Math.max(...rounds.map(i => i.half)), holding: rounds.filter(i => i.lo <= 1 && i.hi >= 1).length };
}

/** The line a round prints. */
export const roundLine = (i: Interval, r: number): string => `round ${r + 1}: ${show(i)}`;

/** The last line the run prints. */
export function floorLine(rounds: readonly Interval[]): string {
  const { floor, holding } = noiseFloor(rounds);
  return `noise floor: ±${(floor * 100).toFixed(2)}% (the widest half width of ${rounds.length} rounds); every round's interval holds 1: ${holding === rounds.length ? "yes" : "no"} (${holding} of ${rounds.length})`;
}

/** The time in ms of one whole child process, `taskset -c <cpu> node bench-noise.ts --work`, from start to exit. */
function timeChild(cpu: number): number {
  const command = ["taskset", "-c", String(cpu), process.execPath, SELF, "--work"];
  const start = process.hrtime.bigint();
  const run = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (run.error || run.status !== 0) {
    throw new Error(`${command.join(" ")} failed (${run.error?.message ?? `status ${run.status ?? run.signal}`}): ${String(run.stderr ?? "").trim()}`);
  }
  return ms;
}

function count(name: string, text: string, least: number): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < least) throw new Error(`--${name} must be a whole number of at least ${least}, not "${text}"`);
  return n;
}

function main(argv: string[]): number {
  try {
    const { values } = parseArgs({ args: argv, options: { work: { type: "boolean", default: false }, pairs: { type: "string", default: "30" }, rounds: { type: "string", default: "5" }, cpu: { type: "string", default: "2" } } });
    if (values.work) {
      const status = jobStatus(work());
      if (status !== 0) console.error("the job's checksum is not the known one: the generator or the sort is broken");
      return status;
    }
    const pairs = count("pairs", values.pairs!, 2), rounds = count("rounds", values.rounds!, 1), cpu = count("cpu", values.cpu!, 0);
    const done: Interval[] = [];
    for (let r = 0; r < rounds; r++) {
      done.push(measureRound(pairs, WARMUP_PAIRS, () => timeChild(cpu)));
      console.log(roundLine(done[r]!, r));
    }
    console.log(floorLine(done));
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
