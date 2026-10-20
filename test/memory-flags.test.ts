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
 * megabytes the new space held at a reading. Each reading comes right after a young-generation collection (`--expose-gc` gives the
 * probe `gc`), because the flags set the size the new space returns to at a collection, not a ceiling between collections: once the
 * old generation reaches its limit V8 starts marking it and makes no young-generation collection until the marking ends, and the new
 * space runs on meanwhile, to 12.75 to 21.75 MB when cores are busy (docs/design.md, section 4, Memory beyond the heap). */
const PROBE = `
(() => {
  const v8 = require("node:v8");
  const keep = [];
  let peak = 0;
  for (let i = 0; i < 3_000_000; i++) {
    keep.push({ i, text: "x" + i });
    if (i % 50_000 === 0) {
      gc({ type: "minor" });
      peak = Math.max(peak, v8.getHeapSpaceStatistics().find(s => s.space_name === "new_space").space_size);
    }
  }
  console.log(peak / 1048576);
})();
`;
/** A limit on this probe, not a bound on the daemon, which was seen with more between collections (same section): two halves of 4 MB
 * read 8 MB here in each of 240 probes with cores busy; the limit leaves room for a V8 that holds a few pages more, and still rejects
 * halves of 8 MB (16 MB). */
const LIMIT_MB = 12;
const peakNewSpaceMB = (nodeFlags: string[]) => Number(execFileSync(process.execPath, ["--expose-gc", ...nodeFlags, "-e", PROBE], { encoding: "utf8" }).trim());

test("the service file starts node with the memory flags, between the node and the script", () => {
  assert.equal(programArguments[0], "{{NODE}}");
  assert.equal(programArguments.at(-1), "{{REPO}}/src/main.ts");
  assert.deepEqual(programArguments.slice(1, -1), ["--max-semi-space-size=4", "--heap-growing-percent=50"]);
});

test("node accepts the service's flags and with them the probe's young generation stays within 12 MB, where without them it grows past that", () => {
  const without = peakNewSpaceMB([]), withFlags = peakNewSpaceMB(flags);
  assert.ok(without > LIMIT_MB, `without the flags the new space grows past ${LIMIT_MB} MB: ${without}`);
  assert.ok(withFlags > 0 && withFlags <= LIMIT_MB, `with the service's flags it stays within ${LIMIT_MB} MB: ${withFlags}`);
});
