// The counts of the n-key lane (test/nkey/lane.ts) on pages with what they protect taken out, and the draws of a landing when the rows
// around its target answer late. First the draws: they depend on when the baselines of the rows around the target answer, and the
// navigation waits 100 ms at most for them. These tests set that time, 300 ms of a virtual clock. On a page that waits 2 s the rows come
// in the landing's draws, which are two at most; on the page itself the landing has drawn twice by then and the rows are drawn on their
// own, each draw of other items' rows alone. A row around the target is a baseline of kind item for another item than the target; the
// others answer after 20 ms. A landing has such a row about one time in six, so the walk goes on until enough landings had one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { performance as perf } from "node:perf_hooks";
import type { Revert } from "../e2e/variant.ts";
import { PAIRS, Press, Scope, VirtualClock, WARMUP, landings } from "./press.ts";
import type { Landing } from "./press.ts";
import { FILTERS_COUNTED_EACH_DRAW, LONG_WAIT, MIN_LANDINGS_WITH_ROW, NAVIGATION_DRAWS_THREE_TIMES, OWN_ANSWER_MS, READ_FETCHES_THE_BOARD, ROW_MS, ROWS_AROUND_NOT_WAITED_FOR, SCHEDULE_REBUILDS, WAIT_FOR_ROWS_AROUND_HAS_NO_LIMIT, WITNESS_LANDINGS, checkCounts, lap, log, ms, startLane } from "./lane.ts";

test("the counts of one press of n report a page with what they protect taken out, and a row around the target that answers late is drawn as it should be", { timeout: 10 * 60_000 }, async t => {
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
  await t.test("with all three taken out, the counts report each of them", async () => {
    const list = await lane.walk({ label: "witness", reverts: [...SCHEDULE_REBUILDS, ...NAVIGATION_DRAWS_THREE_TIMES, ...FILTERS_COUNTED_EACH_DRAW] }, WITNESS_LANDINGS);
    const violations = checkCounts("all three out", list);
    log(`press-n all three out: draws of the landing ${[...new Set(list.map(l => l.draws))].join("/")}`);
    for (const family of ["drew", "built the board's rules", "counted the filters"]) assert.ok(violations.some(v => v.includes(family)), "the counts report: " + family);
  });
  lap("count witnesses");

  // Marking a read does not fetch the board again: the unread list carries the new cursor, and a read changes nothing on the board.
  // These windows are answered by the real server, which this check is about.
  const readOnce = async (reverts: Revert[]) => {
    const scope = new Scope();
    try {
      const asked: string[] = [];
      const win = await Press.open(scope, lane.board, {
        label: "read", reverts, stream: "server",
        fetch: async (url, init) => { if (url.pathname.startsWith("/api/")) asked.push((init?.method ?? "GET") + " " + url.pathname); return fetch(url, init); },
      });
      const unreadNow = () => Number((win.page.$("#unread-row .sbtn.s-new")?.textContent ?? "").match(/\d+/)?.[0] ?? 0);
      const [landed] = await landings(win, 1);
      const unreadBefore = unreadNow();
      asked.length = 0;
      const from = perf.eventLoopUtilization();
      win.page.key("m");
      await win.page.settle();
      return { landed, asked: [...asked], busy: perf.eventLoopUtilization(from).active, unreadBefore, unreadAfter: unreadNow() };
    } finally { await scope.close(); }
  };
  const checkRead = (r: Awaited<ReturnType<typeof readOnce>>): string[] => {
    const v: string[] = [], count = (what: string) => r.asked.filter(a => a === what).length;
    if (count("POST /api/read") !== 1) v.push(`press-n read: m sent ${count("POST /api/read")} reads, not 1 (${r.asked.join(", ")})`);
    if (count("GET /api/unread") < 1) v.push("press-n read: the page did not ask for the unread list after the read");
    if (count("GET /api/snapshot") !== 0) v.push(`press-n read: the page fetched the whole board ${count("GET /api/snapshot")} times after a read`);
    if (!(r.unreadAfter < r.unreadBefore)) v.push(`press-n read: the unread number was ${r.unreadBefore} before m and ${r.unreadAfter} after`);
    return v;
  };
  await t.test("m refreshes the unread list and does not fetch the board again, and the check reports a page that does", async () => {
    const bad = await readOnce(READ_FETCHES_THE_BOARD);
    const hits = checkRead(bad).filter(v => v.includes("fetched the whole board"));
    assert.ok(hits.length > 0, "the check reports a page that fetches the board (it reported: " + (checkRead(bad).join("\n") || "nothing") + ")");
    const good = await readOnce([]);
    log(`press-n read: m kept the event loop busy ${ms(good.busy)} ms (${ms(bad.busy)} ms on the page that fetches the board); the page asked for ${good.asked.join(", ")}`);
    assert.deepEqual(checkRead(good), []);
  });
    lap("done");
});
