// One press of n on a board of the live board's weight (test/e2e/live-board.ts), in the real page run in jsdom, with no browser
// (docs/design.md, section 11, The n-key lane). The owner reads the board a stop at a time with n and wants the page to answer
// quickly (board-read-fast); on the live board a press that lands on another item took 0.3–0.5 s, because each of its four draws
// rebuilt the board's rules and counted every filter again (page-n-fast). Two layers hold it:
//   counts  – exact on any machine, from the page's performance marks (countEvent in web/app.ts) and what it writes: a press that
//             lands on another item builds the board's rules no time, counts the filters no time, draws once or twice, and writes
//             no more markup and makes no more elements than the numbers below. The draws depend on when the baselines of the rows
//             around the target answer (the navigation waits 100 ms at most for them), so the tests that hold that set the time on
//             a virtual clock: a row that answers in time comes in the landing's own draws, two at most, measured on a page whose
//             wait is 2 s with the row answering after 300 ms; a row that answers after the wait is drawn on its own, after the
//             landing's two draws. While sessions write (a change event right after the key, from a real write), each write builds the
//             rules again but derives them from scratch no time except in a new minute and counts the filters of every item no time.
//   time    – the seconds the event loop was busy from the key until the page was quiet, as the page of this commit over the page of
//             the base (the merge base, or the commit before a push to the main line), quiet and with a write in each press: pairs
//             of presses made one after the other in a rotating order, the twin of the base as the control, the 95% interval of the
//             ratio of the paired logs (test/nkey/stats.ts). The run counts when the twin's interval holds 1 within the noise floor;
//             then an interval wholly above 1 is red, of any size. When it does not count, 30 pairs more are made in fresh windows
//             (twice at most); still not counting, the layer says "undecided" in a warning, and passes. The absolute 0.2 s is not
//             held here: jsdom's time is not Chrome's.
// Each layer also runs on the page with what it protects taken out, where it must report: the three changes one at a time, a page
// whose draw takes 15 ms more (a window of every time phase), and for the wait itself the page without it and the page without its
// 100 ms limit. Run by CI's job `nkey` (npm run test:nkey), not on the owner's Mac.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { performance as perf } from "node:perf_hooks";
import { startLiveBoard } from "../e2e/live-board.ts";
import type { BoardServer, Hooks } from "../e2e/board-server.ts";
import type { Revert } from "../e2e/variant.ts";
import { Press, Scope, Tape, VirtualClock, currentPage, landings, pageAt, samePage, timePhase, writeEvents, PAIRS, WARMUP } from "./press.ts";
import type { Landing, OpenHow, PhaseResult, PhaseWindow } from "./press.ts";
import { show } from "./stats.ts";

const WITNESS_LANDINGS = 8, LATE_LANDINGS = 12, EVENTS = 64, OWN_ANSWER_MS = 20, ROW_MS = 300, MIN_LANDINGS_WITH_ROW = 3;
/** The widest half width of the twin's interval that still counts as this run's noise, as a fraction: 6.1% quiet (the widest of 15
 * comparisons of a page with itself on 5 hosted runners); while writing, measured again (docs/design.md, The n-key lane). */
const FLOOR = { quiet: 0.061, writing: 0.061 };
/** What one press that lands writes, the median over the landings of the first walk: characters assigned to innerHTML and elements
 * made. A page that writes more is red; a change to the page that moves them changes the numbers here, and the pull request says why. */
const WRITES = { innerHtml: Number.POSITIVE_INFINITY, created: Number.POSITIVE_INFINITY };

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
const ms = (x: number) => x.toFixed(0);
const log = (line: string) => console.log(line);
const warn = (title: string, text: string) => console.log(`::warning title=${title}::${text}`);
const summary = (text: string) => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n"); };
const began = perf.now();
const lap = (what: string) => log(`press-n lap: ${what} at ${((perf.now() - began) / 1000).toFixed(1)} s`);

// The page with what each layer protects taken out; each edit applies to the page's text where it stands.
const SCHEDULE_REBUILDS: Revert[] = [
  { file: "web/app.ts", edit: "a draw asked for later rebuilds the board's rules", find: "    invalidateView(); scope.forEach(s => dirty.add(s));\n    if (renderQueued) return;", replace: "    invalidate(); scope.forEach(s => dirty.add(s));\n    if (renderQueued) return;" },
  { file: "web/app.ts", edit: "a draw made at once rebuilds the board's rules", find: "function renderNow(...scope:string[]) { invalidateView();", replace: "function renderNow(...scope:string[]) { invalidate();" },
];
const NAVIGATION_DRAWS_THREE_TIMES: Revert[] = [
  { file: "web/app.ts", edit: "navigation draws the unfolded rows and the selected item one by one", find: "unfolded = openPath(it.id, false);\n      selectItem(it.id, false);", replace: "unfolded = openPath(it.id);\n      selectItem(it.id);" },
];
const FILTERS_COUNTED_EACH_DRAW: Revert[] = [
  { file: "web/app.ts", edit: "the filter counts are made again at each draw", find: "  function invalidateView() { memo = {}; }", replace: "  function invalidateView() { memo = {}; dataMemo = {}; filterRecount = null; }" },
];
const ROWS_AROUND_NOT_WAITED_FOR: Revert[] = [
  { file: "web/app.ts", edit: "a navigation waits for the target's baselines alone, and the rows around it draw when theirs arrive", find: "await Promise.all(around ? [...own, allWithin([...pendingDiffs.values()], AROUND_BASELINES_WAIT_MS)] : own);", replace: "await Promise.all(own);" },
];
// The wait for the rows around the target made 2 s, for the count of a row that answers in time.
const LONG_WAIT: Revert[] = [
  { file: "web/app.ts", edit: "the navigation waits 2 s for the rows around the target", find: "const AROUND_BASELINES_WAIT_MS = 100;", replace: "const AROUND_BASELINES_WAIT_MS = 2000;" },
];
const WAIT_FOR_ROWS_AROUND_HAS_NO_LIMIT: Revert[] = [
  { file: "web/app.ts", edit: "the wait for the rows around the target has no limit", find: "const timer = setTimeout(resolve, ms); void Promise.all", replace: "const timer = 0 as unknown as ReturnType<typeof setTimeout>; void Promise.all" },
];
const RULES_DERIVED_FROM_SCRATCH: Revert[] = [
  { file: "web/app.ts", edit: "every write derives the board's rules from scratch", find: "derived = rules(s, Date.now(), { activity: () => activityCache.activity(s), ...(previous ? { previous } : {}) });", replace: "derived = rules(s, Date.now(), { activity: () => activityCache.activity(s) });" },
];
const FILTERS_COUNTED_EACH_WRITE: Revert[] = [
  { file: "web/app.ts", edit: "every write counts every item's filters", find: "    if (!previous) filterRecount = null;\n", replace: "    filterRecount = null;\n" },
];
const SLOW_DRAW: Revert[] = [
  { file: "web/app.ts", edit: "a draw takes 15 ms more", find: '    countEvent("board:render", [...scope].join(","));\n', replace: '    countEvent("board:render", [...scope].join(","));\n    for (const began = performance.now(); performance.now() - began < 15;) {}\n' },
];
const READ_FETCHES_THE_BOARD: Revert[] = [
  { file: "web/app.ts", edit: "after a read the page fetches the board again", find: "    try { await refreshUnread(active,signal); }\n", replace: "    try { await loadSnapshot(active,signal); if (active()) await refreshUnread(active,signal); }\n" },
];

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
/** Violations of the counts while sessions write: each write builds the rules again, from what the rules before it derived except in a
 * new minute, and counts again only the filters of the items it reaches. */
function checkWritingCounts(label: string, list: Landing[]): string[] {
  const v: string[] = [];
  for (const l of list) {
    const scratch = l.full.filter(reason => reason !== "minute");
    if (scratch.length) v.push(`press-n writing counts (${label}): during the press that landed on ${l.item} the page derived the board's rules from scratch ${scratch.length} times (${scratch.join(", ")}), not 0`);
    if (l.filters !== 0) v.push(`press-n writing counts (${label}): during the press that landed on ${l.item} the page counted every item's filters ${l.filters} times, not 0`);
  }
  return v;
}
/** Violations of what a press writes. */
function checkWrites(list: Landing[]): string[] {
  const v: string[] = [], inner = median(list.map(l => l.innerHtml)), made = median(list.map(l => l.created));
  log(`press-n writes: a press that lands wrote ${inner} characters to innerHTML and made ${made} elements (median over ${list.length} landings; held at ${WRITES.innerHtml} and ${WRITES.created})`);
  if (inner > WRITES.innerHtml) v.push(`press-n writes: the median press that landed wrote ${inner} characters to innerHTML, over ${WRITES.innerHtml}`);
  if (made > WRITES.created) v.push(`press-n writes: the median press that landed made ${made} elements, over ${WRITES.created}`);
  return v;
}

/** What a time phase says: the numbers go to the log and the run's summary either way; violations are red verdicts and witnesses that
 * were not reported, and an undecided run is a warning. */
function judgePhase(name: string, r: PhaseResult, floor: number, changed: boolean): string[] {
  const v: string[] = [];
  const base = median(r.busy.base!);
  log(`press-n time (${name}): ${r.rounds} round${r.rounds > 1 ? "s" : ""}, ${r.busy.base!.length} pairs; base busy median ${ms(base)} ms (the absolute limit of 200 ms is not held here: jsdom is not Chrome); twin/base ${show(r.ratios.twin!)}${r.sound ? "" : ` (not within ±${(floor * 100).toFixed(1)}%: the run does not count)`}`);
  const rows = [`| ${name} | base busy median ${ms(base)} ms | twin ${show(r.ratios.twin!)} | rounds ${r.rounds} | ${r.sound ? "counts" : "does not count"} |`];
  const polluted = (r.misses.base ?? 0) + (r.misses.twin ?? 0);
  for (const [label, verdict] of Object.entries(r.verdicts)) {
    const witness = label === "slow";
    log(`press-n time (${name}): ${label}/base ${show(r.ratios[label]!)}: ${verdict}`);
    rows.push(`| ${name} | ${label}/base | ${show(r.ratios[label]!)} | | ${verdict} |`);
    if ((r.misses[label] ?? 0) > 0) v.push(`press-n time (${name}): the ${label} window asked for ${r.misses[label]} reads the tape has no answer for; the real server answered them in this process`);
    if (witness) {
      if (verdict === "ok") v.push(`press-n time (${name}): the time layer did not report a page whose draw takes 15 ms more (${show(r.ratios.slow!)})`);
      else if (verdict === "undecided") warn(`n-key time layer (${name})`, "the twin's interval did not show this run's noise in " + r.rounds + " rounds, so the witness of 15 ms more per draw could not be judged");
    } else if (verdict === "red") v.push(`press-n time (${name}): the page is slower than its base: ${show(r.ratios[label]!)}, twin ${show(r.ratios.twin!)}`);
    else if (verdict === "undecided") warn(`n-key time layer (${name})`, `undecided: the twin of the base did not show this run's noise within ±${(floor * 100).toFixed(1)}% in ${r.rounds} rounds (twin/base ${show(r.ratios.twin!)}), so the page's ${show(r.ratios[label]!)} against its base was not judged`);
    else if (polluted > 0) warn(`n-key time layer (${name})`, `the base page asked for ${polluted} reads the tape has no answer for, so its time carries the server's work`);
  }
  if (!changed) log(`press-n time (${name}): the page is the same as its base, so only the twin and the witness were measured`);
  summary(rows.join("\n"));
  return v;
}

test("n on a board of the live board's weight: draws, rebuilds, writes and time, and the checks that notice their loss", { timeout: 15 * 60_000 }, async t => {
  const board = await startLiveBoard(t);
  lap(`board seeded (${Object.keys(board.store.snapshot().items).length} items)`);
  assert.ok(Object.keys(board.store.snapshot().items).length >= 1500, "the board has about 1,600 items");

  // The pages: the current one, and the base to compare it with (the same page when none is given or it did not change).
  const current = await currentPage();
  const baseRef = process.env.NKEY_BASE;
  const older = baseRef ? await pageAt(baseRef) : undefined;
  if (baseRef && !older) warn("n-key time layer", `the base ${baseRef} is not in this checkout, so the page is compared with itself`);
  const changed = !!older && !samePage(older, current);
  log(`press-n base: ${baseRef ?? "none given"}, ${changed ? "the page differs from it" : "the page is the same as it"}`);
  const basePage = changed ? { page: older! } : {};

  // The first walk, on the real server: its answers are the tape every other window is answered from.
  const tape = new Tape();
  let targets: string[] = [];
  {
    const scope = new Scope();
    try {
      const recorder = await Press.open(scope, board, { label: "recorder", fetch: tape.recorder() });
      const walk = await landings(recorder, WARMUP + PAIRS);
      assert.equal(walk.length, WARMUP + PAIRS, `n reached ${WARMUP + PAIRS} other items`);
      targets = walk.map(l => l.item);
    } finally { await scope.close(); }
  }
  const snapshotBytes = tape.sizeOf("/api/snapshot") ?? 0;
  lap(`walk recorded (${tape.size} answers, ${(tape.bytes / 1e6).toFixed(1)} MB)`);
  // The premise of every number below: a board as big as the live one, with a long unread list.
  assert.ok(snapshotBytes >= 12e6, `the snapshot is ${(snapshotBytes / 1e6).toFixed(1)} MB, as heavy as the live board's (about 15 MB)`);
  const events = await writeEvents(board, EVENTS);
  lap(`${events.length} change events written`);

  /** A window answered from the tape. */
  const open = (scope: Hooks, how: Omit<OpenHow, "fetch" | "misses">) => { const player = tape.player(); return Press.open(scope, board, { ...how, fetch: player.fetch, misses: player.misses }); };
  /** The windows of a time phase: the base and its twin, the current page when it differs, and the current page with 15 ms more per draw. */
  const windows = (): PhaseWindow[] => [
    { label: "base", open: s => open(s, { label: "base", ...basePage }) },
    { label: "twin", open: s => open(s, { label: "twin", ...basePage }) },
    ...(changed ? [{ label: "cand", open: (s: Hooks) => open(s, { label: "cand" }) }] : []),
    { label: "slow", open: s => open(s, { label: "slow", reverts: SLOW_DRAW }) },
  ];
  const currentLabel = changed ? "cand" : "base";

  await t.test("the current page: a press that lands rebuilds and recounts nothing, and the time is no more than its base's", async () => {
    const r = await timePhase(windows(), FLOOR.quiet);
    lap(`quiet time phase (${r.rounds} rounds)`);
    const list = r.first[currentLabel]!;
    log(`press-n counts: draws of the landing ${[...new Set(list.map(l => l.draws))].join("/")}, rules builds ${list.reduce((a, l) => a + l.rules, 0)}, filter counts ${list.reduce((a, l) => a + l.filters, 0)} over ${list.length} landings`);
    // Both layers are run before either is asserted, so a failure of one still shows the other's numbers.
    assert.deepEqual([...checkCounts("quiet", list), ...checkWrites(list), ...judgePhase("quiet", r, FLOOR.quiet, changed)], []);
  });

  await t.test("the current page: the same while sessions write, and no write derives the rules or counts the filters from scratch", async () => {
    const r = await timePhase(windows(), FLOOR.writing, events);
    lap(`writing time phase (${r.rounds} rounds)`);
    const list = r.first[currentLabel]!;
    log(`press-n writing counts: rules builds ${list.reduce((a, l) => a + l.rules, 0)}, from scratch ${list.flatMap(l => l.full).join(", ") || "none"}, filter counts of every item ${list.reduce((a, l) => a + l.filters, 0)} over ${list.length} landings`);
    assert.deepEqual([...checkWritingCounts("writing", list), ...judgePhase("writing", r, FLOOR.writing, changed)], []);
  });

  /** `list` of a window that opened on the current page or a variant, over `wanted` landings, in a scope of its own. */
  const walk = async (how: Omit<OpenHow, "fetch" | "misses">, wanted: number, withEvents = false) => {
    const scope = new Scope();
    try {
      const win = await open(scope, how);
      const list = await landings(win, wanted, withEvents ? events : undefined);
      assert.equal(win.misses, 0, "every read the page asked for had an answer on the tape");
      return list;
    } finally { await scope.close(); }
  };
  for (const [what, reverts, names] of [
    ["derives the board's rules from scratch at every write", RULES_DERIVED_FROM_SCRATCH, "from scratch"],
    ["counts every item's filters at every write", FILTERS_COUNTED_EACH_WRITE, "every item's filters"],
  ] as const) await t.test(`the writing counts report a page that ${what}`, async () => {
    const hits = checkWritingCounts("reversed", await walk({ label: "writing witness", reverts: [...reverts] }, WITNESS_LANDINGS, true)).filter(v => v.includes(names));
    assert.ok(hits.length > 0, "the writing counts report it");
  });

  // The draws of a landing depend on when the baselines of the rows around its target answer: the navigation waits 100 ms at most for
  // them. The test sets that time, 300 ms of a virtual clock. On a page that waits 2 s they come in the landing's draws, which are two
  // at most; on the page itself the landing has drawn twice by then and the rows are drawn on their own, each draw of other items'
  // rows alone. A row around the target is a baseline of kind item for another item than the target; the others answer after 20 ms.
  const withRowsHeld = async (reverts: Revert[], holdMs: number) => {
    const scope = new Scope();
    try {
      const clock = new VirtualClock(), progress = { landed: 0 }, held = new Map<number, Promise<void>>();
      let armed = false;
      const player = tape.player(url => {
        if (!armed || url.pathname !== "/api/step") return undefined;
        const k = progress.landed, around = url.searchParams.get("kind") === "item" && url.searchParams.get("doc") !== targets[k];
        if (!around) return clock.sleep(OWN_ANSWER_MS);
        if (!held.has(k)) held.set(k, clock.sleep(holdMs));
        return held.get(k)!;
      });
      const win = await Press.open(scope, board, { label: "late rows", reverts, fetch: player.fetch, misses: player.misses, clock });
      armed = true;
      const list = await landings(win, LATE_LANDINGS, undefined, progress);
      // The times set are the times of the first walk's landings only if this walk reached the same items in the same order.
      assert.deepEqual(list.map(l => l.item), targets.slice(0, LATE_LANDINGS), "the landings reached the items of the first walk");
      assert.equal(win.misses, 0, "every baseline asked for had an answer on the tape");
      const rows = list.map((_, k) => k).filter(k => held.has(k));
      log(`press-n rows around the target answering after ${holdMs} ms: ${rows.length} of ${list.length} landings had one; draws of those ${[...new Set(rows.map(k => list[k]!.draws))].join("/")}, of the others ${[...new Set(list.filter((_, k) => !held.has(k)).map(l => l.draws))].join("/")}`);
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
    const { list, rows } = await withRowsHeld(LONG_WAIT, ROW_MS);
    assert.ok(rows.length >= MIN_LANDINGS_WITH_ROW, `at least ${MIN_LANDINGS_WITH_ROW} landings had a row around the target (${rows.length})`);
    assert.deepEqual(checkCounts("rows in time", list), []);
  });
  await t.test("a row around the target that answers after 100 ms is drawn on its own, after the landing's two draws", async () => {
    const { list, rows } = await withRowsHeld([], ROW_MS);
    assert.ok(rows.length >= MIN_LANDINGS_WITH_ROW, `at least ${MIN_LANDINGS_WITH_ROW} landings had a row around the target (${rows.length})`);
    assert.deepEqual(lateRowsViolations(list, rows), []);
  });
  await t.test("the counts report a page whose navigation does not wait for the rows around its target", async () => {
    const { list, rows } = await withRowsHeld([...LONG_WAIT, ...ROWS_AROUND_NOT_WAITED_FOR], ROW_MS);
    assert.ok(rows.length >= MIN_LANDINGS_WITH_ROW, "enough landings had a row around the target");
    const hits = checkCounts("reversed", list).filter(v => v.includes("drew"));
    assert.ok(hits.length > 0, "the page that does not wait draws a third time for a row that answers within its wait (it reported: " + (checkCounts("reversed", list).join("\n") || "nothing") + ")");
  });
  await t.test("the counts report a page whose wait for the rows around its target has no limit", async () => {
    const { list, rows } = await withRowsHeld(WAIT_FOR_ROWS_AROUND_HAS_NO_LIMIT, ROW_MS);
    assert.ok(rows.length >= MIN_LANDINGS_WITH_ROW, "enough landings had a row around the target");
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
    const list = await walk({ label: "witness", reverts }, WITNESS_LANDINGS);
    const hits = checkCounts("reversed", list).filter(names);
    assert.ok(hits.length > 0, "the counts of the page without the change report it (they reported: " + (checkCounts("reversed", list).join("\n") || "nothing") + ")");
  });
  await t.test("with all three taken out, the counts report each of them", async () => {
    const list = await walk({ label: "witness", reverts: [...SCHEDULE_REBUILDS, ...NAVIGATION_DRAWS_THREE_TIMES, ...FILTERS_COUNTED_EACH_DRAW] }, WITNESS_LANDINGS);
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
      const win = await Press.open(scope, board, {
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
