// The runner's block of the agent list as a table, on the current page (test/dom/runner-table.ts holds the scenario). The same scenario on pages
// with one thing spoiled is in runner-table-spoiled-*.test.ts.

import { test } from "node:test";
import { runnerTable } from "./runner-table.ts";

test("the runner's block is a table: the title first, the key on the hover only, one cut line for what it does, no commit id and no path, a person's work first", async t => {
  await runnerTable(t);
});
