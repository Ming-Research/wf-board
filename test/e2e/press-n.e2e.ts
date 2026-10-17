// One press of n on a board of the live board's weight (test/e2e/live-board.ts), in a real browser. The owner reads the board a
// stop at a time with n and wants the page to answer within 0.2 s (board-read-fast); on the live board a press that lands on
// another item took 0.3–0.5 s, because each of its four draws rebuilt the board's rules and counted every filter again
// (page-n-fast). Two layers hold it:
//   counts  – a press that lands on another item builds the board's rules no time and counts the filters no time, and draws at
//             most twice (every draw from the key to the quiet); the page leaves a performance mark for each (countEvent in
//             web/app.ts). Exact on any machine: the draws depend on when the baselines of the rows around the target answer (the
//             navigation waits 100 ms at most for them), so the test holds the answer of one such row for a time it sets: within
//             the 100 ms the landing draws twice at most, after it exactly three times. The board's natural timing only has to build
//             no rules and count no filters.
//   time    – the main thread's busy time from the key until the page is quiet, over 30 landings: median 0.2 s at most and
//             90th percentile 0.3 s at most, with the board quiet and with sessions writing 3 times a second. It depends on the
//             machine (a hosted runner's speed differs by up to a factor of two between jobs); each run is made once.
// Each layer also runs on the page with what it protects taken out, where it must report: the three changes one at a time for
// the counts, a draw made 150 ms slower for the time (quiet and writing), and for the wait itself the page without it and the page
// without its 100 ms limit. Run by CI's e2e job (npm run test:e2e), not on the owner's Mac.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Browser, CDPSession } from "playwright";
import { prng } from "./board-gen.ts";
import { launch, BoardPage, serveBoard, variantWeb } from "./harness.ts";
import type { BoardServer, Revert } from "./harness.ts";
import { startLiveBoard } from "./live-board.ts";

const MEDIAN_MS = 200, P90_MS = 300, LANDINGS = 30, WITNESS_LANDINGS = 8, WRITES_PER_SECOND = 3;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
const p90 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(0.9 * xs.length))]!;
const ms = (x: number) => x.toFixed(0);

// The page's performance marks, counted from before its own scripts run. The page redoes its rules when a minute passes, and that
// rebuild would fall into whichever press it meets, so the test holds the page's minute tick still.
const INIT = `(() => {
  const counts = { "board:render": 0, "board:rules": 0, "board:filter-counts": 0 };
  let scopes = [], pressAt = 0, lastDraw = 0, answers = [];
  addEventListener("keydown", () => { pressAt = performance.now(); }, true);
  // When each baseline (/api/step) was asked for and answered, for how late the rows around a target get theirs.
  const fetch0 = window.fetch.bind(window);
  window.fetch = (...args) => {
    const began = performance.now(), url = String(args[0] && args[0].url || args[0]), p = fetch0(...args);
    if (url.includes("/api/step")) p.then(() => answers.push([began, performance.now()]), () => {});
    return p;
  };
  const bump = entries => { for (const e of entries) if (e.name in counts) { counts[e.name]++; if (e.name === "board:render") { scopes.push(e.detail); lastDraw = e.startTime; } } };
  const observer = new PerformanceObserver(list => bump(list.getEntries()));
  observer.observe({ entryTypes: ["mark"] });
  // The marks counted since the last call; those the observer has not delivered yet are taken from its queue.
  window.__takeMarks = () => { bump(observer.takeRecords()); const seen = { ...counts, scopes, lastDrawAfter: lastDraw - pressAt, answers: answers.map(([began, end]) => [began - pressAt, end - pressAt]) }; for (const k in counts) counts[k] = 0; scopes = []; answers = []; return seen; };
  const every = window.setInterval.bind(window);
  window.setInterval = (fn, delay, ...rest) => delay >= 30000 ? 0 : every(fn, delay, ...rest);
})();`;
interface Marks { "board:render": number; "board:rules": number; "board:filter-counts": number; scopes: string[]; lastDrawAfter: number; answers: Array<[number, number]> }
const marks = (bp: BoardPage) => bp.page.evaluate(() => (window as unknown as { __takeMarks(): Marks }).__takeMarks());

/** What one press cost: the main thread's busy time from the key until the page was quiet, and what the page marked meanwhile. */
interface Landing { item: string; busy: number; draws: number; rules: number; filters: number; scopes: string[]; lastDraw: number; answers: Array<[number, number]> }

async function busyTime(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find(m => m.name === "TaskDuration")!.value * 1000;
}
/** Waits until nothing is in flight and the page has drawn what it was going to; the quiet stretch is idle time, not busy time. */
async function quiet(bp: BoardPage) {
  await bp.settle(); await sleep(120); await bp.settle();
}
async function openPage(browser: Browser, board: BoardServer) {
  const bp = await BoardPage.open(browser, board, {}, INIT);
  const cdp = await bp.context.newCDPSession(bp.page);
  await cdp.send("Performance.enable");
  await bp.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await marks(bp);
  return { bp, cdp };
}
/** Presses n until it has landed on `wanted` other items (a press inside the item shown does not count). */
async function landings(bp: BoardPage, cdp: CDPSession, wanted: number, progress?: { landed: number }): Promise<Landing[]> {
  const out: Landing[] = [];
  for (let presses = 0; out.length < wanted && presses < 8 * wanted; presses++) {
    const was = await bp.selected(), before = await busyTime(cdp);
    await bp.page.keyboard.press("n");
    await quiet(bp);
    const busy = await busyTime(cdp) - before, now = await bp.selected(), m = await marks(bp);
    if (now !== null && now !== was) out.push({ item: now, busy, draws: m["board:render"], rules: m["board:rules"], filters: m["board:filter-counts"], scopes: m.scopes, lastDraw: m.lastDrawAfter, answers: m.answers });
    if (progress) progress.landed = out.length;
  }
  return out;
}
/** Sessions writing to the board `perSecond` times a second, as the live board's are; `stop` ends it and says how many were made. */
function startWriters(board: BoardServer, perSecond: number) {
  const rnd = prng(777);
  let stopped = false, count = 0;
  const ids = Object.keys(board.store.snapshot().items).filter(id => !board.store.snapshot().items[id]!.record);
  const loop = (async () => {
    while (!stopped) {
      const id = rnd.pick(ids), it = board.store.snapshot().items[id]!, { rev, ...doc } = it, at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      try {
        await board.store.commit({ author: it.group, message: "writer", puts: [{ kind: "item", id, expectRev: rev, doc: { ...doc, log: [...it.log, { at, by: it.group, text: "持续写入。" }], updated: at } }] });
        count++;
      } catch { /* a lost race with another write: skip it */ }
      await sleep(1000 / perSecond);
    }
  })();
  return { stop: async () => { stopped = true; await loop; return count; } };
}

/**
 * Holds the answers to the baselines that a landing asks for the rows around its target, until `holdMs` after the first of them was
 * asked for. The rows a landing paints besides its target ask for their own baselines (kind item, another item than the target),
 * and when those answer decides how many times the landing draws. `targets` are the items the landings reach, in order, from an
 * earlier walk of the same board; `progress.landed` says which landing is under way. The answers are the server's, delivered
 * together at the time asked (or when the server has answered, if later). `heldFor(k)` tells whether landing k had such a row.
 */
async function holdRowsAround(bp: BoardPage, targets: string[], progress: { landed: number }, holdMs: number) {
  const until = new Map<number, Promise<void>>();
  await bp.context.route(/\/api\/step\?/, async route => {
    const url = new URL(route.request().url()), k = progress.landed;
    if (url.searchParams.get("kind") !== "item" || url.searchParams.get("doc") === targets[k]) return route.continue();
    if (!until.has(k)) until.set(k, sleep(holdMs));
    const [response] = await Promise.all([route.fetch(), until.get(k)]);
    await route.fulfill({ response });
  });
  return { heldFor: (k: number) => until.has(k) };
}
/** Violations of the counts. A press that lands draws at least once, or the page marks nothing and the check proves nothing. */
function checkCounts(label: string, list: Landing[], drawsToo = true): string[] {
  const v: string[] = [];
  for (const l of list) {
    if (l.draws < 1 || drawsToo && l.draws > 2) v.push(`press-n counts (${label}): the press that landed on ${l.item} drew ${l.draws} times, not once or twice (scopes: ${l.scopes.join(" | ")})`);
    if (l.rules !== 0) v.push(`press-n counts (${label}): the press that landed on ${l.item} built the board's rules ${l.rules} times, not 0`);
    if (l.filters !== 0) v.push(`press-n counts (${label}): the press that landed on ${l.item} counted the filters ${l.filters} times, not 0`);
  }
  return v;
}
/** Violations of the time limit; the numbers go to the log either way. */
function checkTime(label: string, list: Landing[], log: (line: string) => void): string[] {
  const busy = list.map(l => l.busy), med = median(busy), top = p90(busy);
  log(`press-n time (${label}): ${list.length} landings, busy ms median ${ms(med)} (limit ${MEDIAN_MS}), 90th percentile ${ms(top)} (limit ${P90_MS}), max ${ms(Math.max(...busy))}; draws per landing median ${median(list.map(l => l.draws))}; last draw ${ms(median(list.map(l => l.lastDraw)))} ms after the key (median); ${busy.map(ms).join(" ")}`);
  const v: string[] = [];
  if (med > MEDIAN_MS) v.push(`press-n time (${label}): the median landing took ${ms(med)} ms, over ${MEDIAN_MS}`);
  if (top > P90_MS) v.push(`press-n time (${label}): the 90th percentile of the landings was ${ms(top)} ms, over ${P90_MS}`);
  return v;
}

/** How late the baselines of a landing's draws arrive: the page waits for those of the rows around its target for 100 ms at most
 * (AROUND_BASELINES_WAIT_MS in web/app.ts), so this says whether the wait was long enough. Logged, not asserted. */
function logAnswers(label: string, list: Landing[], log: (line: string) => void) {
  const last = list.map(l => Math.max(0, ...l.answers.map(a => a[1]))), slowest = list.map(l => Math.max(0, ...l.answers.map(a => a[1] - a[0])));
  const asked = list.map(l => l.answers.length);
  log(`press-n baselines (${label}): ${list.length} landings, ${median(asked)} baselines asked for per landing (median); the last one answered ${ms(median(last))} ms after the key (median), ${ms(p90(last))} (90th percentile), ${ms(Math.max(...last))} (max); the slowest single answer took ${ms(median(slowest))} ms (median), ${ms(Math.max(...slowest))} (max)`);
}

// The three changes of page-n-fast taken out one at a time, and a draw made slower; each applies to the page's text where it stands.
const SCHEDULE_REBUILDS: Revert[] = [
  { file: "web/app.ts", edit: "a draw asked for later rebuilds the board's rules", find: "    invalidateView(); scope.forEach(s => dirty.add(s));\n    if (renderQueued) return;", replace: "    invalidate(); scope.forEach(s => dirty.add(s));\n    if (renderQueued) return;" },
  { file: "web/app.ts", edit: "a draw made at once rebuilds the board's rules", find: "function renderNow(...scope:string[]) { invalidateView();", replace: "function renderNow(...scope:string[]) { invalidate();" },
];
const NAVIGATION_DRAWS_THREE_TIMES: Revert[] = [
  { file: "web/app.ts", edit: "navigation draws the unfolded rows and the selected item one by one", find: "unfolded = openPath(it.id, false);\n      selectItem(it.id, false);", replace: "unfolded = openPath(it.id);\n      selectItem(it.id);" },
];
const ROWS_AROUND_NOT_WAITED_FOR: Revert[] = [
  { file: "web/app.ts", edit: "a navigation waits for the target's baselines alone, and the rows around it draw when theirs arrive", find: "await Promise.all(around ? [...own, allWithin([...pendingDiffs.values()], AROUND_BASELINES_WAIT_MS)] : own);", replace: "await Promise.all(own);" },
];
const WAIT_FOR_ROWS_AROUND_HAS_NO_LIMIT: Revert[] = [
  { file: "web/app.ts", edit: "the wait for the rows around the target has no limit", find: "const timer = setTimeout(resolve, ms); void Promise.all", replace: "const timer = 0 as unknown as ReturnType<typeof setTimeout>; void Promise.all" },
];
const FILTERS_COUNTED_EACH_DRAW: Revert[] = [
  { file: "web/app.ts", edit: "the filter counts are made again at each draw", find: "  function invalidateView() { memo = {}; }", replace: "  function invalidateView() { memo = {}; dataMemo = {}; }" },
];
const SLOW_DRAW: Revert[] = [
  { file: "web/app.ts", edit: "a draw takes 150 ms more", find: '    countEvent("board:render", [...scope].join(","));\n', replace: '    countEvent("board:render", [...scope].join(","));\n    for (const began = performance.now(); performance.now() - began < 150;) {}\n' },
];
const READ_FETCHES_THE_BOARD: Revert[] = [
  { file: "web/app.ts", edit: "after a read the page fetches the board again", find: "    try { await refreshUnread(active,signal); }\n", replace: "    try { await loadSnapshot(active,signal); if (active()) await refreshUnread(active,signal); }\n" },
];

test("n on a board of the live board's weight: draws, rebuilds and time, and the checks that notice their loss", { timeout: 30 * 60_000 }, async t => {
  const board = await startLiveBoard(t), browser = await launch(t);
  const snap = board.store.snapshot(), bytes = Buffer.byteLength(JSON.stringify(snap));
  // The premise of every number below: a board as big as the live one, with a long unread list.
  assert.ok(Object.keys(snap.items).length >= 1500, "the board has about 1,600 items");
  assert.ok(bytes >= 12e6, `the snapshot is ${(bytes / 1e6).toFixed(1)} MB, as heavy as the live board's (about 15 MB)`);
  const log = (line: string) => console.log(line);

  /** A page of this board served from the current page directory, or from a variant of it. */
  const pageOf = async (reverts: Revert[] | null) => reverts ? serveBoard(t, board, await variantWeb(t, reverts)) : board;

  // The items the landings reach, in order: n walks the unread stops in page order, the same on every page of this board.
  let targets: string[] = [];
  await t.test("the current page: a press that lands rebuilds and recounts nothing, and the time limit holds", async () => {
    const { bp, cdp } = await openPage(browser, board);
    const list = await landings(bp, cdp, LANDINGS);
    await bp.context.close();
    assert.equal(list.length, LANDINGS, "n reached " + LANDINGS + " other items");
    logAnswers("quiet", list, log);
    log(`press-n counts: draws of the landing ${[...new Set(list.map(l => l.draws))].join("/")}, rules builds ${list.reduce((a, l) => a + l.rules, 0)}, filter counts ${list.reduce((a, l) => a + l.filters, 0)} over ${list.length} landings`);
    targets = list.map(l => l.item);
    // Both layers are run before either is asserted, so a failure of one still shows the other's numbers. The draws are held to their
    // limit below, where the test sets when the rows around the target answer; here the board's own timing only has to build no rules.
    assert.deepEqual([...checkCounts("quiet", list, false), ...checkTime("quiet", list, log)], []);
  });

  // With sessions writing, the busy time of a press includes the page's handling of the writes that fall into it (about 50 ms each,
  // the board's rules built again for each). The limits are those of the quiet board, and the run is made once.
  const withWriters = async (served: BoardServer, wanted: number) => {
    const { bp, cdp } = await openPage(browser, served);
    const writers = startWriters(served, WRITES_PER_SECOND);
    const list = await landings(bp, cdp, wanted), written = await writers.stop();
    await bp.context.close();
    log(`press-n time (writing): ${written} writes during ${list.length} landings`);
    logAnswers("writing", list, log);
    assert.ok(written >= wanted, "the sessions wrote while n was pressed");
    return list;
  };
  await t.test("the current page: the same time limit while sessions write", async () => {
    assert.deepEqual(checkTime("writing", await withWriters(board, LANDINGS), log), []);
  });

  // The draws of a landing depend on when the baselines of the rows around its target answer: the navigation waits 100 ms at most for
  // them. The test sets that time. In 60 ms they come in the landing's draws, which are two at most; after 200 ms the landing has drawn
  // twice and the row is drawn on its own, which makes exactly three.
  const IN_TIME_MS = 60, LATE_MS = 200, MIN_LANDINGS_WITH_ROW = 3;
  const withRowsHeld = async (served: BoardServer, holdMs: number) => {
    assert.ok(targets.length === LANDINGS, "the walk of the current page came first");
    const { bp, cdp } = await openPage(browser, served);
    const progress = { landed: 0 }, hold = await holdRowsAround(bp, targets, progress, holdMs);
    const list = await landings(bp, cdp, targets.length, progress);
    await bp.context.close();
    const rows = list.map((_, k) => k).filter(k => hold.heldFor(k));
    log(`press-n rows around the target answering after ${holdMs} ms: ${rows.length} of ${list.length} landings had one; draws of those ${[...new Set(rows.map(k => list[k]!.draws))].join("/")}, of the others ${[...new Set(list.filter((_, k) => !hold.heldFor(k)).map(l => l.draws))].join("/")}`);
    return { list, rows };
  };
  /** Violations when the rows answer late: a landing with such a row draws exactly three times, the last for the row alone. */
  const lateRowsViolations = (list: Landing[], rows: number[]) => {
    const v = checkCounts("late rows", list, false);
    list.forEach((l, k) => {
      if (rows.includes(k)) {
        if (l.draws !== 3) v.push(`press-n late rows: the press that landed on ${l.item} drew ${l.draws} times, not 3 (scopes: ${l.scopes.join(" | ")})`);
        else if (!l.scopes[2]!.split(",").every(key => key.startsWith("item:"))) v.push(`press-n late rows: the third draw of the press that landed on ${l.item} was not of other items' rows alone (${l.scopes[2]})`);
      } else if (l.draws < 1 || l.draws > 2) v.push(`press-n late rows: the press that landed on ${l.item} had no such row and drew ${l.draws} times`);
    });
    return v;
  };
  await t.test("a row around the target that answers within 100 ms is drawn with the landing: two draws at most", async () => {
    const { list, rows } = await withRowsHeld(board, IN_TIME_MS);
    assert.ok(rows.length >= MIN_LANDINGS_WITH_ROW, `at least ${MIN_LANDINGS_WITH_ROW} landings had a row around the target (${rows.length})`);
    assert.deepEqual(checkCounts("rows in time", list), []);
  });
  await t.test("a row around the target that answers after 100 ms is drawn on its own: exactly three draws", async () => {
    const { list, rows } = await withRowsHeld(board, LATE_MS);
    assert.ok(rows.length >= MIN_LANDINGS_WITH_ROW, `at least ${MIN_LANDINGS_WITH_ROW} landings had a row around the target (${rows.length})`);
    assert.deepEqual(lateRowsViolations(list, rows), []);
  });
  await t.test("the counts report a page whose navigation does not wait for the rows around its target", async () => {
    const { list, rows } = await withRowsHeld(await pageOf(ROWS_AROUND_NOT_WAITED_FOR), IN_TIME_MS);
    assert.ok(rows.length >= MIN_LANDINGS_WITH_ROW, "enough landings had a row around the target");
    const hits = checkCounts("reversed", list).filter(v => v.includes("drew"));
    assert.ok(hits.length > 0, "the page that does not wait draws a third time for a row that answers in 60 ms (it reported: " + (checkCounts("reversed", list).join("\n") || "nothing") + ")");
  });
  await t.test("the counts report a page whose wait for the rows around its target has no limit", async () => {
    const { list, rows } = await withRowsHeld(await pageOf(WAIT_FOR_ROWS_AROUND_HAS_NO_LIMIT), LATE_MS);
    assert.ok(rows.length >= MIN_LANDINGS_WITH_ROW, "enough landings had a row around the target");
    const hits = lateRowsViolations(list, rows);
    assert.ok(hits.length > 0, "the page that waits as long as the row takes draws twice for a row that answers after 200 ms");
  });

  // Each change taken out alone: the counts must name it.
  const lost: Array<[string, Revert[], (v: string) => boolean]> = [
    ["views draw with the board's rules rebuilt", SCHEDULE_REBUILDS, v => v.includes("built the board's rules")],
    ["navigation draws the unfolded rows, the selected item and the comments one by one", NAVIGATION_DRAWS_THREE_TIMES, v => v.includes("drew")],
    ["every draw counts the filters again", FILTERS_COUNTED_EACH_DRAW, v => v.includes("counted the filters")],
  ];
  for (const [what, reverts, names] of lost) await t.test(`the counts report it when ${what}`, async () => {
    const { bp, cdp } = await openPage(browser, await pageOf(reverts));
    const list = await landings(bp, cdp, WITNESS_LANDINGS);
    await bp.context.close();
    const hits = checkCounts("reversed", list).filter(names);
    assert.ok(hits.length > 0, "the counts of the page without the change report it (they reported: " + (checkCounts("reversed", list).join("\n") || "nothing") + ")");
  });

  await t.test("with all three taken out, the counts report each of them", async () => {
    const { bp, cdp } = await openPage(browser, await pageOf([...SCHEDULE_REBUILDS, ...NAVIGATION_DRAWS_THREE_TIMES, ...FILTERS_COUNTED_EACH_DRAW]));
    const list = await landings(bp, cdp, WITNESS_LANDINGS);
    await bp.context.close();
    const violations = checkCounts("all three out", list);
    log(`press-n all three out: draws of the landing ${[...new Set(list.map(l => l.draws))].join("/")}`);
    checkTime("all three out", list, log);
    for (const family of ["drew", "built the board's rules", "counted the filters"]) assert.ok(violations.some(v => v.includes(family)), "the counts report: " + family);
  });

  await t.test("the time limit reports a page whose draw takes 150 ms more", async () => {
    const { bp, cdp } = await openPage(browser, await pageOf(SLOW_DRAW));
    const list = await landings(bp, cdp, WITNESS_LANDINGS);
    await bp.context.close();
    const violations = checkTime("slow draw", list, log);
    assert.ok(violations.some(v => v.includes("median")), "the median of the slowed page is over the limit (it reported: " + (violations.join("\n") || "nothing") + ")");
  });

  await t.test("the time limit reports a page whose draw takes 150 ms more while sessions write", async () => {
    const violations = checkTime("slow draw, writing", await withWriters(await pageOf(SLOW_DRAW), WITNESS_LANDINGS), log);
    assert.ok(violations.some(v => v.includes("median")), "the median of the slowed page is over the limit while sessions write (it reported: " + (violations.join("\n") || "nothing") + ")");
  });

  // Marking a read does not fetch the board again: the unread list carries the new cursor, and a read changes nothing on the board.
  const readOnce = async (b: BoardServer) => {
    const { bp, cdp } = await openPage(browser, b);
    const asked: string[] = [];
    bp.page.on("request", req => { const url = new URL(req.url()); if (url.pathname.startsWith("/api/")) asked.push(req.method() + " " + url.pathname); });
    const unreadNow = () => bp.page.evaluate(() => Number((document.querySelector("#unread-row .sbtn.s-new")?.textContent ?? "").match(/\d+/)?.[0] ?? 0));
    const [landed] = await landings(bp, cdp, 1);
    const unreadBefore = await unreadNow();
    asked.length = 0;
    const began = await busyTime(cdp);
    await bp.page.keyboard.press("m");
    await quiet(bp);
    const busy = await busyTime(cdp) - began, unreadAfter = await unreadNow();
    await bp.context.close();
    return { landed, asked, busy, unreadBefore, unreadAfter };
  };
  const checkRead = (r: Awaited<ReturnType<typeof readOnce>>): string[] => {
    const v: string[] = [];
    const count = (what: string) => r.asked.filter(a => a === what).length;
    if (count("POST /api/read") !== 1) v.push(`press-n read: m sent ${count("POST /api/read")} reads, not 1 (${r.asked.join(", ")})`);
    if (count("GET /api/unread") < 1) v.push("press-n read: the page did not ask for the unread list after the read");
    if (count("GET /api/snapshot") !== 0) v.push(`press-n read: the page fetched the whole board ${count("GET /api/snapshot")} times after a read`);
    if (!(r.unreadAfter < r.unreadBefore)) v.push(`press-n read: the unread number was ${r.unreadBefore} before m and ${r.unreadAfter} after`);
    return v;
  };
  await t.test("m refreshes the unread list and does not fetch the board again, and the check reports a page that does", async () => {
    const bad = await readOnce(await pageOf(READ_FETCHES_THE_BOARD));
    const hits = checkRead(bad).filter(v => v.includes("fetched the whole board"));
    assert.ok(hits.length > 0, "the check reports a page that fetches the board (it reported: " + (checkRead(bad).join("\n") || "nothing") + ")");
    const good = await readOnce(board);
    log(`press-n read: m kept the main thread busy ${ms(good.busy)} ms (${ms(bad.busy)} ms on the page that fetches the board); the page asked for ${good.asked.join(", ")}`);
    assert.deepEqual(checkRead(good), []);
  });
});
