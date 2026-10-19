// The write path's CPU in interleaved pairs: this tree against a base commit, with a twin of the base as the control, as the
// shared rules' engineering standards ask of a performance comparison (Experiments and performance) and as the n-key lane does
// for the page (docs/design.md, section 11, The n-key lane). Single runs of scripts/bench-writes.ts on hosted runners differ by
// up to 12 ms per write for the same code, more than a comparison or a 50 ms line can stand; pairs made one after the other on
// one machine cancel what the machine adds. The `bench` workflow runs it by hand, on several runners at once.
//
// A round runs scripts/bench-writes.ts once for each of the base, its twin (the same base again) and this tree, in an order drawn
// afresh each round, each in a process of its own. It prints each side's CPU milliseconds per write with the 95% interval of the
// mean, the twin's ratio to the base (this run's noise), this tree's ratio to the base and to the reference (per round the
// geometric mean of base and twin), each side's growth of the heap after a full collection per write with the difference of
// this tree's to the base's, and each side's peak RSS. It judges nothing and never fails on the numbers; a run of
// bench-writes that fails or prints no result fails it.
//
// Usage: node scripts/bench-pairs.ts --base-src <dir> [--rounds 10] [--writes 200] [--unread 4000] [--seed N]
//   --base-src is the src directory of the base commit; --writes and --unread are passed to every run of bench-writes.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { compare, randomOrder, reference, show, tQuantile } from "../test/nkey/stats.ts";
import { prng } from "../test/e2e/board-gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: {
  "base-src": { type: "string" }, rounds: { type: "string", default: "10" }, writes: { type: "string", default: "200" },
  unread: { type: "string", default: "4000" }, seed: { type: "string" },
} });
if (!args["base-src"]) throw new Error("--base-src names the base commit's src directory");
const ROUNDS = Number(args.rounds), seed = Number(args.seed ?? Math.floor(Math.random() * 2 ** 31));
const sides = [
  { label: "base", src: args["base-src"] },
  { label: "twin", src: args["base-src"] },
  { label: "cand", src: join(here, "../src") },
];
const cpu: Record<string, number[]> = { base: [], twin: [], cand: [] }, rss: Record<string, number[]> = { base: [], twin: [], cand: [] };
const heap: Record<string, number[]> = { base: [], twin: [], cand: [] };
const rnd = prng(seed);
console.log(`bench-pairs: ${ROUNDS} rounds of ${args.writes} writes, the owner ${args.unread} commits behind; order seed ${seed}`);
for (let round = 1; round <= ROUNDS; round++) {
  for (const k of randomOrder(sides.length, rnd.next)) {
    const side = sides[k]!;
    const run = spawnSync(process.execPath, [join(here, "bench-writes.ts"), "--label", side.label, "--src", side.src, "--writes", args.writes!, "--unread", args.unread!], { encoding: "utf8", maxBuffer: 64 << 20 });
    const line = run.stdout.split("\n").find(l => l.startsWith("BENCH "));
    if (run.status !== 0 || !line) { process.stderr.write(run.stderr); throw new Error(`bench-writes (${side.label}, round ${round}) ended with ${run.status} and printed ${line ? "a result" : "no result"}`); }
    const result = JSON.parse(line.slice("BENCH ".length)) as { cpuMsPerWrite: number; peakRssMB: number; heapGrowthKBPerWrite: number };
    cpu[side.label]!.push(result.cpuMsPerWrite); rss[side.label]!.push(result.peakRssMB); heap[side.label]!.push(result.heapGrowthKBPerWrite);
    console.log(`round ${round} ${side.label}: ${result.cpuMsPerWrite} ms/write, peak RSS ${result.peakRssMB} MB, heap ${result.heapGrowthKBPerWrite >= 0 ? "+" : ""}${result.heapGrowthKBPerWrite} KB/write`);
  }
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1));
const interval = (xs: number[], unit: string) => { const m = mean(xs), h = tQuantile(xs.length - 1) * sd(xs) / Math.sqrt(xs.length); return `${m.toFixed(1)} ${unit} [${(m - h).toFixed(1)}, ${(m + h).toFixed(1)}]`; };
for (const label of ["base", "twin", "cand"]) console.log(`${label} CPU ms/write ${interval(cpu[label]!, "ms")}; heap growth ${interval(heap[label]!, "KB/write")}; peak RSS MB ${rss[label]!.join(" ")}`);
// The heap a write leaves reachable is compared as a difference: both sides keep the growing unread list, so a ratio of two small
// numbers would say little.
console.log(`heap growth cand-base ${interval(heap.cand!.map((x, k) => x - heap.base![k]!), "KB/write")}, twin-base ${interval(heap.twin!.map((x, k) => x - heap.base![k]!), "KB/write")}`);
console.log(`twin/base ${show(compare(cpu.twin!, cpu.base!))}`);
console.log(`cand/base ${show(compare(cpu.cand!, cpu.base!))}`);
console.log(`cand/ref ${show(compare(cpu.cand!, reference(cpu.base!, cpu.twin!)))}`);
