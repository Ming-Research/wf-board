// The counts of the n-key lane (test/nkey/lane.ts): what a press of n that lands on another item builds, counts, draws and writes on a
// board of the live board's weight, quiet and while sessions write, and the pages that redo at every write what the page keeps, which the
// writing counts must report. The pages with each change of a quiet press taken out are test/nkey/counts-out.nkey.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNT_LANDINGS, FILTERS_COUNTED_EACH_WRITE, RULES_DERIVED_FROM_SCRATCH, STRUCTURE_REMADE_EACH_WRITE, WITNESS_LANDINGS, checkCounts, checkWrites, checkWritingCounts, lap, log, startLane, describeCounts } from "./lane.ts";

test("counts of one press of n on a board of the live board's weight, quiet and while writing, and the checks that notice a page redoing its work at every write", { timeout: 10 * 60_000 }, async t => {
  const lane = await startLane(t, { landings: COUNT_LANDINGS, writes: true });

  await t.test("the current page: a press that lands rebuilds and recounts nothing, and writes no more than it did", async () => {
    const list = await lane.walk({ label: "current" }, COUNT_LANDINGS);
    log(`press-n counts: ${describeCounts(list)}`);
    assert.deepEqual([...checkCounts("quiet", list), ...checkWrites(list)], []);
  });
  await t.test("the current page: while sessions write no write derives the rules or counts the filters from scratch", async () => {
    const list = await lane.walk({ label: "current writing" }, COUNT_LANDINGS, true);
    log(`press-n writing counts: ${describeCounts(list)}`);
    assert.deepEqual(checkWritingCounts("writing", list), []);
  });
  for (const [what, reverts, names] of [
    ["derives the board's rules from scratch at every write", RULES_DERIVED_FROM_SCRATCH, "from scratch"],
    ["counts every item's filters at every write", FILTERS_COUNTED_EACH_WRITE, "every item's filters"],
    ["makes its structure and its stop lists again at every write", STRUCTURE_REMADE_EACH_WRITE, "structure again"],
  ] as const) await t.test(`the writing counts report a page that ${what}`, async () => {
    const list = await lane.walk({ label: "writing witness", reverts: [...reverts] }, WITNESS_LANDINGS, true);
    const hits = checkWritingCounts("reversed", list).filter(v => v.includes(names));
    log(`press-n witness (page that ${what}): ${hits.length} violations reported; ${describeCounts(list)}`);
    assert.ok(hits.length > 0, "the writing counts report it");
  });
  lap("done");
});
