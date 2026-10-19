// The time layer of the n-key lane (test/nkey/lane.ts) on a quiet board: the seconds the event loop is busy from the key until the page
// is quiet, the page of this commit over the page of the base, in interleaved pairs with the twin of the base as the control. The
// current page's counts are held on the first round too. A page whose draw takes 15 ms more must be reported.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PAIRS, WARMUP } from "./press.ts";
import { FLOOR, checkCounts, lap, log, startLane, describeCounts, timeLayer } from "./lane.ts";

test("time of one press of n on a quiet board of the live board's weight: the current page against its base", { timeout: 10 * 60_000 }, async t => {
  const lane = await startLane(t, { landings: WARMUP + PAIRS, base: true });
  const { result: r, violations } = await timeLayer("quiet", lane.windows(), FLOOR.quiet, lane.changed);
  lap(`time phase (${r.rounds} rounds)`);
  const list = r.first[lane.currentLabel]!;
  log(`press-n counts: ${describeCounts(list)}`);
  // Both layers are run before either is asserted, so a failure of one still shows the other's numbers.
  assert.deepEqual([...checkCounts("quiet", list), ...violations], []);
});
