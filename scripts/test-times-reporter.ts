// A node:test reporter for the sharded CI: how many tests ran and how many seconds each test file took, as a Markdown table
// for the job summary (docs/design.md, section 11, Sharding the script tests). The seconds are what test/shard-costs.json
// holds. Item ci-shards-gate.
//   node --test --test-reporter=./scripts/test-times-reporter.ts --test-reporter-destination=times.md <files>
import { relative, resolve } from "node:path";

interface TestEvent { type: string; data: { name?: string; file?: string; nesting: number; details: { type?: string; duration_ms: number } } }

export default async function* (source: AsyncIterable<TestEvent>) {
  const seconds = new Map<string, number>();
  let tests = 0;
  for await (const { type, data } of source) {
    // A test, and not a suite (the summary line "tests" leaves suites out too).
    if ((type === "test:pass" || type === "test:fail") && data.details.type !== "suite") tests++;
    // The runner reports each file as one entry named by its path: the time from starting the file's process to its end,
    // which is what the file holds a shard for (the sum of its tests leaves out loading it and its hooks).
    if (type === "test:complete" && data.nesting === 0 && data.file !== undefined && data.name !== undefined && resolve(data.name) === data.file) {
      seconds.set(relative(process.cwd(), data.file), data.details.duration_ms / 1000);
    }
  }
  const rows = [...seconds].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const total = rows.reduce((sum, [, s]) => sum + s, 0);
  yield [
    `${tests} tests in ${rows.length} files, ${total.toFixed(1)} s of file time`,
    "",
    "| file | seconds |",
    "|---|---|",
    ...rows.map(([file, s]) => `| ${file} | ${s.toFixed(1)} |`),
    "",
  ].join("\n");
}
