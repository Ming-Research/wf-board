// The service starts node with V8 flags that keep its resident memory down (docs/design.md, section 4, Memory beyond the heap;
// design node daemon/memory). The service file carries them, node accepts them, and with them the young generation stays small.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const plist = readFileSync(new URL("../ops/wf-board.plist", import.meta.url), "utf8");
/** The strings of the plist's ProgramArguments array, in order. */
const programArguments = [...(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/s.exec(plist)?.[1] ?? "").matchAll(/<string>(.*?)<\/string>/g)].map(m => m[1]!);
const flags = programArguments.filter(argument => argument.startsWith("--"));

/** Builds three million small objects that stay alive, so that the young generation grows as far as it is let, and prints the most
 * megabytes the new space held while they were made. */
const PROBE = `
const v8 = require("node:v8");
const keep = [];
let peak = 0;
for (let i = 0; i < 3_000_000; i++) {
  keep.push({ i, text: "x" + i });
  if (i % 50_000 === 0) peak = Math.max(peak, v8.getHeapSpaceStatistics().find(s => s.space_name === "new_space").space_size);
}
console.log(peak / 1048576);
`;
const peakNewSpaceMB = (nodeFlags: string[]) => Number(execFileSync(process.execPath, [...nodeFlags, "-e", PROBE], { encoding: "utf8" }).trim());

test("the service file starts node with the memory flags, between the node and the script", () => {
  assert.equal(programArguments[0], "{{NODE}}");
  assert.equal(programArguments.at(-1), "{{REPO}}/src/main.ts");
  assert.deepEqual(programArguments.slice(1, -1), ["--max-semi-space-size=4", "--heap-growing-percent=50"]);
});

test("node accepts the service's flags and with them the young generation stays within two 4 MB halves, where without them it grows past that", () => {
  const without = peakNewSpaceMB([]), withFlags = peakNewSpaceMB(flags);
  assert.ok(without > 8, `without the flags the new space grows past 8 MB: ${without}`);
  assert.ok(withFlags > 0 && withFlags <= 8, `with the service's flags it stays within 8 MB: ${withFlags}`);
});
