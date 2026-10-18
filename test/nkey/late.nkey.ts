// The draws of a landing in the n-key lane (test/nkey/lane.ts) depend on when the baselines of the rows around its target answer: the
// navigation waits 100 ms at most for them. These tests set that time, 300 ms of a virtual clock. On a page that waits 2 s the rows come
// in the landing's draws, which are two at most; on the page itself the landing has drawn twice by then and the rows are drawn on their
// own, each draw of other items' rows alone. A row around the target is a baseline of kind item for another item than the target; the
// others answer after 20 ms. A landing has such a row about one time in six, so the walk goes on until enough landings had one.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Revert } from "../e2e/variant.ts";
import { PAIRS, Press, Scope, VirtualClock, WARMUP, landings } from "./press.ts";
import type { Landing } from "./press.ts";
import { LONG_WAIT, MIN_LANDINGS_WITH_ROW, OWN_ANSWER_MS, ROW_MS, ROWS_AROUND_NOT_WAITED_FOR, WAIT_FOR_ROWS_AROUND_HAS_NO_LIMIT, checkCounts, lap, log, startLane } from "./lane.ts";

test("a row around the target that answers late, and the checks that notice a page that waits wrongly", { timeout: 10 * 60_000 }, async t => {
  const lane = await startLane(t, { landings: WARMUP + PAIRS });
  const { targets } = lane;

  const withRowsHeld = async (reverts: Revert[], holdMs: number) => {
    const scope = new Scope();
    try {
      const clock = new VirtualClock(), held = new Map<number, Promise<void>>();
      const progress: { landed: number; done: () => boolean } = { landed: 0, done: () => held.size >= MIN_LANDINGS_WITH_ROW && progress.landed > [...held.keys()].at(-1)! };
      let armed = false;
      const player = lane.tape.player(url => {
        if (!armed || url.pathname !== "/api/step") return undefined;
        const k = progress.landed, around = url.searchParams.get("kind") === "item" && url.searchParams.get("doc") !== targets[k];
        if (!around) return clock.sleep(OWN_ANSWER_MS);
        if (!held.has(k)) held.set(k, clock.sleep(holdMs));
        return held.get(k)!;
      });
      const win = await Press.open(scope, lane.board, { label: "late rows", reverts, fetch: player.fetch, misses: player.misses, clock });
      armed = true;
      const list = await landings(win, targets.length, undefined, progress);
      // The times set are the times of the first walk's landings only if this walk reached the same items in the same order.
      assert.deepEqual(list.map(l => l.item), targets.slice(0, list.length), "the landings reached the items of the first walk");
      assert.equal(win.misses, 0, "every baseline asked for had an answer on the tape");
      const rows = list.map((_, k) => k).filter(k => held.has(k));
      log(`press-n rows around the target answering after ${holdMs} ms: ${rows.length} of ${list.length} landings had one; draws of those ${[...new Set(rows.map(k => list[k]!.draws))].join("/")}, of the others ${[...new Set(list.filter((_, k) => !held.has(k)).map(l => l.draws))].join("/")}`);
      assert.ok(rows.length >= MIN_LANDINGS_WITH_ROW, `at least ${MIN_LANDINGS_WITH_ROW} landings had a row around the target in the ${targets.length} the tape holds (${rows.length})`);
      return { list, rows };
    } finally { await scope.close(); }
  };
  /** Violations when the rows answer late: a landing with such a row draws twice at most for itself and then draws the rows on their own,
   * at least once, each later draw of other items' rows alone; whether two late rows share a draw is the frames' timing. */
  const lateRowsViolations = (list: Landing[], rows: number[]) => {
    const v = checkCounts("late rows", list, false);
    list.forEach((l, k) => {
      if (rows.includes(k)) {
        if (l.draws < 3) v.push(`press-n late rows: the press that landed on ${l.item} drew ${l.draws} times, not the landing's own and then the late rows' (scopes: ${l.scopes.join(" | ")})`);
        // The landing's own draws are the first one and the one its own baselines make; every later one is of the late rows.
        const later = l.scopes.slice(2).filter(scope => !scope.split(",").every(key => key.startsWith("item:")));
        if (later.length) v.push(`press-n late rows: a draw after the landing's own two, during the press that landed on ${l.item}, was not of other items' rows alone (${later.join(" | ")})`);
      } else if (l.draws < 1 || l.draws > 2) v.push(`press-n late rows: the press that landed on ${l.item} had no such row and drew ${l.draws} times`);
    });
    return v;
  };
  await t.test("a row around the target that answers within the navigation's wait is drawn with the landing: two draws at most", async () => {
    const { list } = await withRowsHeld(LONG_WAIT, ROW_MS);
    assert.deepEqual(checkCounts("rows in time", list), []);
  });
  await t.test("a row around the target that answers after 100 ms is drawn on its own, after the landing's two draws", async () => {
    const { list, rows } = await withRowsHeld([], ROW_MS);
    assert.deepEqual(lateRowsViolations(list, rows), []);
  });
  await t.test("the counts report a page whose navigation does not wait for the rows around its target", async () => {
    const { list } = await withRowsHeld([...LONG_WAIT, ...ROWS_AROUND_NOT_WAITED_FOR], ROW_MS);
    const hits = checkCounts("reversed", list).filter(v => v.includes("drew"));
    assert.ok(hits.length > 0, "the page that does not wait draws a third time for a row that answers within its wait (it reported: " + (checkCounts("reversed", list).join("\n") || "nothing") + ")");
  });
  await t.test("the counts report a page whose wait for the rows around its target has no limit", async () => {
    const { list, rows } = await withRowsHeld(WAIT_FOR_ROWS_AROUND_HAS_NO_LIMIT, ROW_MS);
    const hits = lateRowsViolations(list, rows);
    assert.ok(hits.length > 0, "the page that waits as long as the row takes draws twice for a row that answers after 300 ms");
  });
  lap("done");
});
