// The test files one shard of the CI runs: `node scripts/test-shard.ts <shard> <shards>` prints them, one per line, shard
// counted from 1 (docs/design.md, section 11, Sharding). Item ci-shards-gate.
//
// Node's own --test-shard splits the file list by position, and a few files take most of the time (a file of this suite runs
// from 0.1 s to 30 s), so the shards came out 21.6, 47.5 and 39.8 s. Here each file goes to the lightest shard, longest
// first, by the seconds it took on a hosted runner (test/shard-costs.json). A file the table does not know gets
// DEFAULT_COST: a new test file is run by some shard from its first push, and the table is brought up to date from the
// per-file table every shard writes to its job summary.
import { readFileSync, readdirSync } from "node:fs";

/** The seconds assumed for a test file with no entry in the cost table: about a median file of the suite. */
export const DEFAULT_COST = 1.5;

/** Every `*.test.ts` file under `dir`, at any depth, which is what `npm test` runs, as `test/<path>`, sorted. */
export function testFiles(dir = "test"): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter(name => name.endsWith(".test.ts"))
    .map(name => `${dir}/${name}`)
    .sort();
}

/** The shards, each a list of files: the files longest first, each into the shard with the least cost so far (the lowest number on a tie). */
export function assign(files: readonly string[], costs: Readonly<Record<string, number>>, shards: number): string[][] {
  const cost = (file: string) => costs[file] ?? DEFAULT_COST;
  const bins = Array.from({ length: shards }, () => ({ load: 0, files: [] as string[] }));
  for (const file of [...files].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : 1))) {
    const lightest = bins.reduce((best, bin) => (bin.load < best.load ? bin : best));
    lightest.load += cost(file);
    lightest.files.push(file);
  }
  return bins.map(bin => bin.files.sort());
}

if (import.meta.main) {
  const [shard, shards] = process.argv.slice(2).map(Number);
  if (!Number.isInteger(shard) || !Number.isInteger(shards) || shard! < 1 || shard! > shards! || process.argv.length !== 4) {
    console.error("usage: node scripts/test-shard.ts <shard> <shards>   (shard from 1 to shards)");
    process.exit(2);
  }
  const costs = JSON.parse(readFileSync("test/shard-costs.json", "utf8")) as Record<string, number>;
  console.log(assign(testFiles(), costs, shards!)[shard! - 1]!.join("\n"));
}
