// The counts of the n-key lane (test/nkey/lane.ts): what a press of n that lands on another item builds, counts, draws and writes on a
// board of the live board's weight, quiet and while sessions write, and the pages that derive the rules or count the filters from
// scratch at every write, which the writing counts must report.

import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNT_LANDINGS, FILTERS_COUNTED_EACH_WRITE, RULES_DERIVED_FROM_SCRATCH, WITNESS_LANDINGS, checkCounts, checkWrites, checkWritingCounts, lap, log, startLane } from "./lane.ts";

test("counts of one press of n on a board of the live board's weight, and the checks that notice their loss", { timeout: 10 * 60_000 }, async t => {
  const lane = await startLane(t, { landings: COUNT_LANDINGS, writes: true });

  await t.test("the current page: a press that lands rebuilds and recounts nothing, and writes no more than it did", async () => {
    const list = await lane.walk({ label: "current" }, COUNT_LANDINGS);
    log(`press-n counts: draws of the landing ${[...new Set(list.map(l => l.draws))].join("/")}, rules builds ${list.reduce((a, l) => a + l.rules, 0)}, filter counts ${list.reduce((a, l) => a + l.filters, 0)} over ${list.length} landings`);
    assert.deepEqual([...checkCounts("quiet", list), ...checkWrites(list)], []);
  });
  await t.test("the current page: while sessions write no write derives the rules or counts the filters from scratch", async () => {
    const list = await lane.walk({ label: "current writing" }, COUNT_LANDINGS, true);
    log(`press-n writing counts: rules builds ${list.reduce((a, l) => a + l.rules, 0)}, from scratch ${list.flatMap(l => l.full).join(", ") || "none"}, filter counts of every item ${list.reduce((a, l) => a + l.filters, 0)} over ${list.length} landings`);
    assert.deepEqual(checkWritingCounts("writing", list), []);
  });
  for (const [what, reverts, names] of [
    ["derives the board's rules from scratch at every write", RULES_DERIVED_FROM_SCRATCH, "from scratch"],
    ["counts every item's filters at every write", FILTERS_COUNTED_EACH_WRITE, "every item's filters"],
  ] as const) await t.test(`the writing counts report a page that ${what}`, async () => {
    const hits = checkWritingCounts("reversed", await lane.walk({ label: "writing witness", reverts: [...reverts] }, WITNESS_LANDINGS, true)).filter(v => v.includes(names));
    assert.ok(hits.length > 0, "the writing counts report it");
  });

  lap("done");
});
