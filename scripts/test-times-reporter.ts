// A node:test reporter for the sharded CI: how many tests ran and how many seconds each test file took, as a Markdown table
// for the job summary (docs/design.md, section 11, Sharding). The seconds are what test/shard-costs.json holds. Item ci-shards-gate.
//   node --test --test-reporter=./scripts/test-times-reporter.ts --test-reporter-destination=times.md <files>
import { relative } from "node:path";

interface TestEvent { type: string; data: { file?: string; nesting: number; details: { type?: string; duration_ms: number } } }

export default async function* (source: AsyncIterable<TestEvent>) {
  const seconds = new Map<string, number>();
  let tests = 0;
  for await (const { type, data } of source) {
    if (type !== "test:pass" && type !== "test:fail") continue;
    // A suite is not a test (the summary line "tests" leaves it out too), and a file's time is the time of its top-level entries.
    if (data.details.type !== "suite") tests++;
    if (data.nesting === 0 && data.file !== undefined) {
      const file = relative(process.cwd(), data.file);
      seconds.set(file, (seconds.get(file) ?? 0) + data.details.duration_ms / 1000);
    }
  }
  const rows = [...seconds].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const total = rows.reduce((sum, [, s]) => sum + s, 0);
  yield [
    `${tests} tests in ${rows.length} files, ${total.toFixed(1)} s of test time`,
    "",
    "| file | seconds |",
    "|---|---|",
    ...rows.map(([file, s]) => `| ${file} | ${s.toFixed(1)} |`),
    "",
  ].join("\n");
}
