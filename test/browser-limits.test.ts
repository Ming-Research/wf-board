// The browser file is kept small (docs/design.md, section 11, The browser file): at most 15 tests, each declared on a line of its own so that
// a loop cannot declare many. The seconds are held by the `timeout` of the workflow that runs it (.github/workflows/browser.yml). A test is
// added to the file only when a script cannot see the fact; the pull request that adds one says why.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_TESTS = 15;
const FILE = join(import.meta.dirname, "e2e/browser.e2e.ts");

/** The `test(` calls of a source: those that begin a line, and those anywhere else (in a loop, say), ignoring `//` comments. */
function declared(source: string): { onTheirOwnLine: number; elsewhere: number } {
  let onTheirOwnLine = 0, elsewhere = 0;
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "");
    const own = /^\s*(?:await\s+)?(?:t\.)?test\(/.test(line);
    const all = (line.match(/(?<![\w.$])(?:t\.)?test\(/g) ?? []).length;
    if (own) { onTheirOwnLine++; elsewhere += all - 1; } else elsewhere += all;
  }
  return { onTheirOwnLine, elsewhere };
}

test("the count sees the tests of every form of declaration, and a loop is not one", () => {
  const sixteen = Array.from({ length: 16 }, (_, i) => `test("t${i}", async () => {});`).join("\n");
  assert.deepEqual(declared(sixteen), { onTheirOwnLine: 16, elsewhere: 0 });
  assert.deepEqual(declared('await t.test("sub", async () => {});'), { onTheirOwnLine: 1, elsewhere: 0 });
  assert.deepEqual(declared('for (const w of list) test(w, async () => {});'), { onTheirOwnLine: 0, elsewhere: 1 });
  assert.deepEqual(declared('// test("in a comment", () => {});\nconst x = 1;'), { onTheirOwnLine: 0, elsewhere: 0 });
});

test(`the browser file declares at most ${MAX_TESTS} tests, each on a line of its own`, async () => {
  const { onTheirOwnLine, elsewhere } = declared(await readFile(FILE, "utf8"));
  assert.equal(elsewhere, 0, "a test is declared inside another line (a loop, say): declare each on a line of its own");
  assert.ok(onTheirOwnLine >= 1, "the browser file declares tests");
  assert.ok(onTheirOwnLine <= MAX_TESTS, `the browser file declares ${onTheirOwnLine} tests, over the limit of ${MAX_TESTS}: move a check into a script test, or ask for the limit to be raised`);
});
