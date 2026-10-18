// The counts of the n-key lane (test/nkey/lane.ts): what a press of n that lands on another item builds, counts, draws and writes on a
// board of the live board's weight, quiet and while sessions write, and the pages with each change taken out, which the counts must
// report. Also that m marks a read without fetching the board again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { performance as perf } from "node:perf_hooks";
import type { Revert } from "../e2e/variant.ts";
import { Press, Scope, landings } from "./press.ts";
import { COUNT_LANDINGS, FILTERS_COUNTED_EACH_DRAW, FILTERS_COUNTED_EACH_WRITE, NAVIGATION_DRAWS_THREE_TIMES, READ_FETCHES_THE_BOARD, RULES_DERIVED_FROM_SCRATCH, SCHEDULE_REBUILDS, WITNESS_LANDINGS, checkCounts, checkWrites, checkWritingCounts, lap, log, ms, startLane } from "./lane.ts";

test("counts of one press of n on a board of the live board's weight, and the checks that notice their loss", { timeout: 10 * 60_000 }, async t => {
  const lane = await startLane(t, { landings: COUNT_LANDINGS, events: COUNT_LANDINGS + 12 });

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
