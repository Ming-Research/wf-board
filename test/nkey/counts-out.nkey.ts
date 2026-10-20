// The counts of the n-key lane (test/nkey/lane.ts) on the pages with each change of a quiet press taken out, one at a time, which the
// counts must report. A part of its own beside test/nkey/counts.nkey.ts, so that each seeds its board and both run at once.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Revert } from "../e2e/variant.ts";
import { FILTERS_COUNTED_EACH_DRAW, NAVIGATION_DRAWS_THREE_TIMES, SCHEDULE_REBUILDS, WITNESS_LANDINGS, checkCounts, lap, log, startLane, describeCounts } from "./lane.ts";

test("the counts of one press of n report each change taken out alone", { timeout: 10 * 60_000 }, async t => {
  const lane = await startLane(t, { landings: WITNESS_LANDINGS });
  // Each change taken out alone: the counts must name it.
  const lost: Array<[string, Revert[], (v: string) => boolean]> = [
    ["views draw with the board's rules rebuilt", SCHEDULE_REBUILDS, v => v.includes("built the board's rules")],
    ["navigation draws the unfolded rows, the selected item and the comments one by one", NAVIGATION_DRAWS_THREE_TIMES, v => v.includes("drew")],
    ["every draw counts the filters again", FILTERS_COUNTED_EACH_DRAW, v => v.includes("counted the filters")],
  ];
  for (const [what, reverts, names] of lost) await t.test(`the counts report it when ${what}`, async () => {
    const list = await lane.walk({ label: "witness", reverts }, WITNESS_LANDINGS);
    const hits = checkCounts("reversed", list).filter(names);
    log(`press-n witness (${what} taken out): ${hits.length} violations reported; ${describeCounts(list)}`);
    assert.ok(hits.length > 0, "the counts of the page without the change report it (they reported: " + (checkCounts("reversed", list).join("\n") || "nothing") + ")");
  });
  lap("done");
});
