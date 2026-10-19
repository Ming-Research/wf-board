// The counts of the n-key lane (test/nkey/lane.ts) on the page with all three changes of a quiet press taken out, and that m marks a read
// without fetching the board again. The late rows around a landing's target are test/nkey/late-rows.nkey.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { performance as perf } from "node:perf_hooks";
import type { Revert } from "../e2e/variant.ts";
import { Press, Scope, landings } from "./press.ts";
import { FILTERS_COUNTED_EACH_DRAW, NAVIGATION_DRAWS_THREE_TIMES, READ_FETCHES_THE_BOARD, SCHEDULE_REBUILDS, WITNESS_LANDINGS, checkCounts, lap, log, ms, startLane, describeCounts } from "./lane.ts";

test("the counts report the page with all three changes taken out, and m marks a read without fetching the board", { timeout: 10 * 60_000 }, async t => {
  const lane = await startLane(t, { landings: WITNESS_LANDINGS });

  await t.test("with all three taken out, the counts report each of them", async () => {
    const list = await lane.walk({ label: "witness", reverts: [...SCHEDULE_REBUILDS, ...NAVIGATION_DRAWS_THREE_TIMES, ...FILTERS_COUNTED_EACH_DRAW] }, WITNESS_LANDINGS);
    const violations = checkCounts("all three out", list);
    log(`press-n witness (all three taken out): ${violations.length} violations reported; ${describeCounts(list)}`);
    for (const family of ["drew", "built the board's rules", "counted the filters"]) assert.ok(violations.some(v => v.includes(family)), "the counts report: " + family);
  });
  lap("all three taken out");

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
