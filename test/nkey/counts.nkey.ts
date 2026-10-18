// The counts of the n-key lane (test/nkey/lane.ts): what a press of n that lands on another item builds, counts, draws and writes on a
// board of the live board's weight, quiet and while sessions write, and the pages with each change taken out, one at a time, which the
// counts must report.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Revert } from "../e2e/variant.ts";
import { COUNT_LANDINGS, FILTERS_COUNTED_EACH_DRAW, FILTERS_COUNTED_EACH_WRITE, NAVIGATION_DRAWS_THREE_TIMES, RULES_DERIVED_FROM_SCRATCH, SCHEDULE_REBUILDS, WITNESS_LANDINGS, checkCounts, checkWrites, checkWritingCounts, lap, log, startLane } from "./lane.ts";

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

  // Each change taken out alone: the counts must name it.
  const lost: Array<[string, Revert[], (v: string) => boolean]> = [
    ["views draw with the board's rules rebuilt", SCHEDULE_REBUILDS, v => v.includes("built the board's rules")],
    ["navigation draws the unfolded rows, the selected item and the comments one by one", NAVIGATION_DRAWS_THREE_TIMES, v => v.includes("drew")],
    ["every draw counts the filters again", FILTERS_COUNTED_EACH_DRAW, v => v.includes("counted the filters")],
  ];
  for (const [what, reverts, names] of lost) await t.test(`the counts report it when ${what}`, async () => {
    const list = await lane.walk({ label: "witness", reverts }, WITNESS_LANDINGS);
    const hits = checkCounts("reversed", list).filter(names);
    assert.ok(hits.length > 0, "the counts of the page without the change report it (they reported: " + (checkCounts("reversed", list).join("\n") || "nothing") + ")");
  });
  lap("done");
});
