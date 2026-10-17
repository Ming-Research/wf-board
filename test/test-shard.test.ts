// How the CI shares the test files among its shards (scripts/test-shard.ts; docs/design.md, section 11, Sharding).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_COST, assign, testFiles } from "../scripts/test-shard.ts";
import reporter from "../scripts/test-times-reporter.ts";

const sorted = (list: readonly string[]) => [...list].sort();

test("the files go longest first, each to the shard with the least cost so far", () => {
  const costs = { "a.test.ts": 10, "b.test.ts": 6, "c.test.ts": 5, "d.test.ts": 4, "e.test.ts": 3 };
  // a to shard 1 (10), b to shard 2 (6), c to shard 2 (11), d to shard 1 (14), e to shard 2 (14).
  assert.deepEqual(assign(Object.keys(costs), costs, 2), [["a.test.ts", "d.test.ts"], ["b.test.ts", "c.test.ts", "e.test.ts"]]);
});

test("the files of a shard are listed longest first, which is the order the runner starts them in", () => {
  assert.deepEqual(assign(["a.test.ts", "b.test.ts", "c.test.ts"], { "a.test.ts": 1, "b.test.ts": 5, "c.test.ts": 3 }, 1), [["b.test.ts", "c.test.ts", "a.test.ts"]]);
});

test("a tie in cost goes to the lower shard, and the input order does not matter", () => {
  const costs = { "a.test.ts": 3, "b.test.ts": 3, "c.test.ts": 3, "d.test.ts": 3 };
  const files = Object.keys(costs);
  const expected = [["a.test.ts", "c.test.ts"], ["b.test.ts", "d.test.ts"]];
  assert.deepEqual(assign(files, costs, 2), expected);
  assert.deepEqual(assign([...files].reverse(), costs, 2), expected);
});

test("a file the cost table does not know costs the default, and an entry for a file that is gone changes nothing", () => {
  const costs = { "a.test.ts": DEFAULT_COST + 0.1, "gone.test.ts": 1000 };
  // a is a little dearer than an unknown file. The first two unknown files fill shard 2 up to twice the default, which is
  // more than a costs, so the third goes to shard 1. An unknown file costing nothing would have gone to shard 2 as well.
  const shards = assign(["a.test.ts", "new1.test.ts", "new2.test.ts", "new3.test.ts"], costs, 2);
  assert.deepEqual(shards, [["a.test.ts", "new3.test.ts"], ["new1.test.ts", "new2.test.ts"]]);
});

test("with more shards than files the extra shards are empty and every file still runs once", () => {
  const files = ["a.test.ts", "b.test.ts"];
  const shards = assign(files, {}, 5);
  assert.equal(shards.length, 5);
  assert.deepEqual(sorted(shards.flat()), files);
});

test("the test files are those named *.test.ts at any depth, as `npm test` runs them", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-board-shard-"));
  try {
    mkdirSync(join(dir, "sub/deeper"), { recursive: true });
    for (const name of ["a.test.ts", "b.ts", "sub/c.test.ts", "sub/d.e2e.ts", "sub/deeper/e.test.ts", "sub/deeper/f.test.js"]) writeFileSync(join(dir, name), "");
    assert.deepEqual(testFiles(dir), [`${dir}/a.test.ts`, `${dir}/sub/c.test.ts`, `${dir}/sub/deeper/e.test.ts`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("each test file of the repository runs in exactly one shard, whatever the number of shards", () => {
  // The oracle is git's list of files (tracked, or new and not ignored), not the function under test.
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "test"], { encoding: "utf8" })
    .split("\n").filter(name => name.endsWith(".test.ts")).sort();
  assert.ok(listed.length > 50, "the repository has its test files");
  assert.deepEqual(testFiles(), listed);
  const costs = JSON.parse(readFileSync("test/shard-costs.json", "utf8")) as Record<string, number>;
  for (const shards of [1, 3, 8, 13]) assert.deepEqual(sorted(assign(testFiles(), costs, shards).flat()), listed, `${shards} shards`);
});

test("the cost table holds a positive number of seconds for every file it names", () => {
  const costs = JSON.parse(readFileSync("test/shard-costs.json", "utf8")) as Record<string, unknown>;
  for (const [file, seconds] of Object.entries(costs)) {
    assert.match(file, /^test\/.+\.test\.ts$/, file);
    assert.ok(typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0, `${file}: ${String(seconds)}`);
  }
});

/** The events the runner sends a reporter for a file: one entry per test, and one named by the file's path when the file ends. */
function* events(file: string, tests: number, fileMs: number, testMs: number) {
  const path = resolve(file);
  for (let i = 0; i < tests; i++) {
    yield { type: "test:pass", data: { name: `test ${i}`, file: path, nesting: 0, details: { type: "test", duration_ms: testMs } } };
    yield { type: "test:complete", data: { name: `test ${i}`, file: path, nesting: 0, details: { type: "test", duration_ms: testMs } } };
  }
  yield { type: "test:complete", data: { name: file, file: path, nesting: 0, details: { duration_ms: fileMs } } };
}

async function report(source: Iterable<{ type: string; data: { name?: string; file?: string; nesting: number; details: { type?: string; duration_ms: number } } }>) {
  const chunks: string[] = [];
  for await (const chunk of reporter((async function* () { yield* source; })())) chunks.push(chunk);
  return chunks.join("");
}

test("the reporter gives each file the time of the file, not the sum of its tests, the largest first, and counts tests only", async () => {
  const text = await report([
    ...events("test/a-small.test.ts", 2, 1500, 10),
    ...events("test/z-big.test.ts", 3, 12340, 20),
    // A suite and a test inside it: the suite is not a test, and neither is a file.
    { type: "test:pass", data: { name: "a group", file: resolve("test/z-big.test.ts"), nesting: 0, details: { type: "suite", duration_ms: 5 } } },
    { type: "test:fail", data: { name: "inside", file: resolve("test/z-big.test.ts"), nesting: 1, details: { type: "test", duration_ms: 5 } } },
  ]);
  assert.match(text, /^6 tests in 2 files, 13\.8 s of file time\n/);
  assert.deepEqual(text.split("\n").filter(line => line.startsWith("| test/")), ["| test/z-big.test.ts | 12.3 |", "| test/a-small.test.ts | 1.5 |"]);
});
