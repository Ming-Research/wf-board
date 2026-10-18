// The time layer of the n-key lane (test/nkey/lane.ts) while sessions write: a change event from a real write is delivered right after
// each key, and the seconds the event loop is busy from the key until the page is quiet are compared as in the quiet phase, the page of
// this commit over the page of the base with the twin of the base as the control. The current page's counts while writing are held on
// the first round too. A page whose draw takes 15 ms more must be reported.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PAIRS, WARMUP, timePhase } from "./press.ts";
import { FLOOR, checkWritingCounts, judgePhase, lap, log, startLane } from "./lane.ts";

test("time of one press of n with a write in each press on a board of the live board's weight: the current page against its base", { timeout: 10 * 60_000 }, async t => {
  const lane = await startLane(t, { landings: WARMUP + PAIRS, base: true, events: WARMUP + PAIRS + 12 });
  const r = await timePhase(lane.windows(), FLOOR.writing, lane.events);
  lap(`time phase (${r.rounds} rounds)`);
  const list = r.first[lane.currentLabel]!;
  log(`press-n writing counts: rules builds ${list.reduce((a, l) => a + l.rules, 0)}, from scratch ${list.flatMap(l => l.full).join(", ") || "none"}, filter counts of every item ${list.reduce((a, l) => a + l.filters, 0)} over ${list.length} landings`);
  assert.deepEqual([...checkWritingCounts("writing", list), ...judgePhase("writing", r, FLOOR.writing, lane.changed)], []);
});
