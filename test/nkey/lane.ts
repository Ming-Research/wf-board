// The n-key lane (docs/design.md, section 11, The n-key lane): one press of n on a board of the live board's weight (test/e2e/live-board.ts),
// in the real page run in jsdom, with no browser. The owner reads the board a stop at a time with n and wants the page to answer
// quickly (board-read-fast); on the live board a press that landed on another item took 0.3–0.5 s, because each of its four draws
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
// whose draw takes 15 ms more, and for the wait itself the page without it and the page without its 100 ms limit.
// The lane is four files, one CI job each (`*.nkey.ts`, `npm run test:nkey`; never on the owner's Mac): they share this module, and each
// seeds the board and records the server's answers itself, so that the four finish together in the time of the longest.

import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { performance as perf } from "node:perf_hooks";
import { startLiveBoard } from "../e2e/live-board.ts";
import type { BoardServer, Hooks } from "../e2e/board-server.ts";
import type { Revert } from "../e2e/variant.ts";
import { Press, Scope, Tape, currentPage, landings, pageAt, sameSourceAs, samePage, writeEvents } from "./press.ts";
import type { Landing, OpenHow, PhaseResult, PhaseWindow } from "./press.ts";
import { show } from "./stats.ts";

export const WITNESS_LANDINGS = 8, COUNT_LANDINGS = 12, LANDINGS_FOR_LATE_ROWS = 20, OWN_ANSWER_MS = 20, ROW_MS = 300, MIN_LANDINGS_WITH_ROW = 3;
/** The widest half width of the twin's interval that still counts as this run's noise, as a fraction: 6.1% quiet (the widest of 15
 * comparisons of a page with itself on 5 hosted runners); while writing, measured again (docs/design.md, The n-key lane). */
export const FLOOR = { quiet: 0.061, writing: 0.061 };
/** What one press that lands writes, the median over the landings of the first walk: characters assigned to innerHTML and elements
 * made. A page that writes more is red; a change to the page that moves them changes the numbers here, and the pull request says why. */
const WRITES = { innerHtml: 33873, created: 756 };

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
export const ms = (x: number) => x.toFixed(0);
export const log = (line: string) => console.log(line);
const warn = (title: string, text: string) => console.log(`::warning title=${title}::${text}`);
const summary = (text: string) => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n"); };
const began = perf.now();
export const lap = (what: string) => log(`press-n lap: ${what} at ${((perf.now() - began) / 1000).toFixed(1)} s`);

// The page with what each layer protects taken out; each edit applies to the page's text where it stands.
export const SCHEDULE_REBUILDS: Revert[] = [
  { file: "web/app.ts", edit: "a draw asked for later rebuilds the board's rules", find: "    invalidateView(); scope.forEach(s => dirty.add(s));\n    if (renderQueued) return;", replace: "    invalidate(); scope.forEach(s => dirty.add(s));\n    if (renderQueued) return;" },
  { file: "web/app.ts", edit: "a draw made at once rebuilds the board's rules", find: "function renderNow(...scope:string[]) { invalidateView();", replace: "function renderNow(...scope:string[]) { invalidate();" },
];
export const NAVIGATION_DRAWS_THREE_TIMES: Revert[] = [
  { file: "web/app.ts", edit: "navigation draws the unfolded rows and the selected item one by one", find: "unfolded = openPath(it.id, false);\n      selectItem(it.id, false);", replace: "unfolded = openPath(it.id);\n      selectItem(it.id);" },
];
export const FILTERS_COUNTED_EACH_DRAW: Revert[] = [
  { file: "web/app.ts", edit: "the filter counts are made again at each draw", find: "  function invalidateView() { memo = {}; }", replace: "  function invalidateView() { memo = {}; dataMemo = {}; filterRecount = null; }" },
];
export const ROWS_AROUND_NOT_WAITED_FOR: Revert[] = [
  { file: "web/app.ts", edit: "a navigation waits for the target's baselines alone, and the rows around it draw when theirs arrive", find: "await Promise.all(around ? [...own, allWithin([...pendingDiffs.values()], AROUND_BASELINES_WAIT_MS)] : own);", replace: "await Promise.all(own);" },
];
// The wait for the rows around the target made 2 s, for the count of a row that answers in time.
export const LONG_WAIT: Revert[] = [
  { file: "web/app.ts", edit: "the navigation waits 2 s for the rows around the target", find: "const AROUND_BASELINES_WAIT_MS = 100;", replace: "const AROUND_BASELINES_WAIT_MS = 2000;" },
];
export const WAIT_FOR_ROWS_AROUND_HAS_NO_LIMIT: Revert[] = [
  { file: "web/app.ts", edit: "the wait for the rows around the target has no limit", find: "const timer = setTimeout(resolve, ms); void Promise.all", replace: "const timer = 0 as unknown as ReturnType<typeof setTimeout>; void Promise.all" },
];
export const RULES_DERIVED_FROM_SCRATCH: Revert[] = [
  { file: "web/app.ts", edit: "every write derives the board's rules from scratch", find: "derived = rules(s, Date.now(), { activity: () => activityCache.activity(s), ...(previous ? { previous } : {}) });", replace: "derived = rules(s, Date.now(), { activity: () => activityCache.activity(s) });" },
];
export const FILTERS_COUNTED_EACH_WRITE: Revert[] = [
  { file: "web/app.ts", edit: "every write counts every item's filters", find: "    if (!previous) filterRecount = null;\n", replace: "    filterRecount = null;\n" },
];
export const SLOW_DRAW: Revert[] = [
  { file: "web/app.ts", edit: "a draw takes 15 ms more", find: '    countEvent("board:render", [...scope].join(","));\n', replace: '    countEvent("board:render", [...scope].join(","));\n    for (const began = performance.now(); performance.now() - began < 15;) {}\n' },
];
export const READ_FETCHES_THE_BOARD: Revert[] = [
  { file: "web/app.ts", edit: "after a read the page fetches the board again", find: "    try { await refreshUnread(active,signal); }\n", replace: "    try { await loadSnapshot(active,signal); if (active()) await refreshUnread(active,signal); }\n" },
];

/** Violations of the counts. A press that lands draws at least once, or the page marks nothing and the check proves nothing. */
export function checkCounts(label: string, list: Landing[], drawsToo = true): string[] {
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
export function checkWritingCounts(label: string, list: Landing[]): string[] {
  const v: string[] = [];
  for (const l of list) {
    const scratch = l.full.filter(reason => reason !== "minute");
    if (scratch.length) v.push(`press-n writing counts (${label}): during the press that landed on ${l.item} the page derived the board's rules from scratch ${scratch.length} times (${scratch.join(", ")}), not 0`);
    if (l.filters !== 0) v.push(`press-n writing counts (${label}): during the press that landed on ${l.item} the page counted every item's filters ${l.filters} times, not 0`);
  }
  return v;
}
/** Violations of what a press writes. */
export function checkWrites(list: Landing[]): string[] {
  const v: string[] = [], inner = median(list.map(l => l.innerHtml)), made = median(list.map(l => l.created));
  log(`press-n writes: a press that lands wrote ${inner} characters to innerHTML and made ${made} elements (median over ${list.length} landings; held at ${WRITES.innerHtml} and ${WRITES.created})`);
  if (inner > WRITES.innerHtml) v.push(`press-n writes: the median press that landed wrote ${inner} characters to innerHTML, over ${WRITES.innerHtml}`);
  if (made > WRITES.created) v.push(`press-n writes: the median press that landed made ${made} elements, over ${WRITES.created}`);
  return v;
}

/** What the counts of a set of landings come to, for the log: the draws of a landing, the rebuilds of the rules (and those from scratch), the filter counts. */
export function describeCounts(list: Landing[]): string {
  return `draws of a landing ${[...new Set(list.map(l => l.draws))].sort().join("/")}, rules builds ${list.reduce((a, l) => a + l.rules, 0)}, from scratch ${list.reduce((a, l) => a + l.full.filter(reason => reason !== "minute").length, 0)}, filter counts ${list.reduce((a, l) => a + l.filters, 0)} over ${list.length} landings`;
}

/** What a time phase says: the numbers go to the log and the run's summary either way; violations are red verdicts and witnesses that
 * were not reported, and an undecided run is a warning. */
export function judgePhase(name: string, r: PhaseResult, floor: number, changed: boolean): string[] {
  const v: string[] = [];
  const base = median(r.busy.base!);
  log(`press-n time (${name}): ${r.rounds} round${r.rounds > 1 ? "s" : ""}, ${r.busy.base!.length} pairs; base busy median ${ms(base)} ms (the absolute limit of 200 ms is not held here: jsdom is not Chrome); twin/base ${show(r.ratios.twin!)}${r.sound ? "" : ` (not within ±${(floor * 100).toFixed(1)}%: the run does not count)`}`);
  r.twins.forEach((twin, k) => log(`press-n twin (${name}): round ${k + 1}: ${show(twin)}`));
  const rows = [`| ${name} | base busy median ${ms(base)} ms | twin ${show(r.ratios.twin!)} | rounds ${r.rounds} | ${r.sound ? "counts" : "does not count"} |`];
  const polluted = (r.misses.base ?? 0) + (r.misses.twin ?? 0);
  for (const [label, verdict] of Object.entries(r.verdicts)) {
    const witness = label === "slow";
    const against = `${label}/${r.versus[label]}`;
    log(`press-n time (${name}): ${against} ${show(r.ratios[label]!)}: ${verdict}`);
    rows.push(`| ${name} | ${against} | ${show(r.ratios[label]!)} | | ${verdict} |`);
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


/** What a part of the lane works with: the board of the live board's weight, the tape of the server's answers to a first walk of n,
 * the change events of real writes, and the windows made from them. */
export interface Lane {
  board: BoardServer;
  tape: Tape;
  /** The items the first walk landed on, in order: the walk every window repeats. */
  targets: string[];
  /** Change events of real writes, each against the commit before it, by the number of the press that lands and takes it (a press
   * that stays inside the item shown has none); the presses of every window are those of the first walk. */
  events: Array<string | undefined>;
  /** Whether the current page differs from the base page. */
  changed: boolean;
  /** `cand` when it does, else `base`: the window that holds the current page in a time phase. */
  currentLabel: string;
  /** A window answered from the tape. */
  open: (scope: Hooks, how: Omit<OpenHow, "fetch" | "misses">) => Promise<Press>;
  /** The windows of a time phase: the base and its twin, the current page when it differs, and the current page with 15 ms more per draw. */
  windows: () => PhaseWindow[];
  /** The landings of a window that opened on the current page or a variant, in a scope of its own. */
  walk: (how: Omit<OpenHow, "fetch" | "misses">, wanted: number, withEvents?: boolean) => Promise<Landing[]>;
}

/** The base page to compare the current one with, named by `NKEY_BASE` (the merge base, or the commit before a push to the main line):
 * the same page when none is named, the commit is not in this checkout or the page did not change. */
async function pagesToCompare(): Promise<{ changed: boolean; basePage: { page?: { script: string; html: string } } }> {
  const baseRef = process.env.NKEY_BASE;
  if (!baseRef) { log("press-n base: none given, so the page is compared with itself"); return { changed: false, basePage: {} }; }
  if (await sameSourceAs(baseRef)) { log(`press-n base: ${baseRef}, the page is the same as it`); return { changed: false, basePage: {} }; }
  const [current, older] = await Promise.all([currentPage(), pageAt(baseRef)]);
  if (!older) { warn("n-key time layer", `the base ${baseRef} is not in this checkout, so the page is compared with itself`); return { changed: false, basePage: {} }; }
  const changed = !samePage(older, current);
  log(`press-n base: ${baseRef}, ${changed ? "the page differs from it" : "the page is the same as it"}`);
  return { changed, basePage: changed ? { page: older } : {} };
}

/** Seeds the board, records the walk of `landings` landings on the real server, and with `writes` makes a change event of a real write
 * for each landing; the base page is built too when `base` is asked for (the time layer compares with it). */
export async function startLane(t: { after(fn: () => unknown): void }, want: { landings: number; writes?: boolean; base?: boolean }): Promise<Lane> {
  // The pages are built while the board is seeded: the board's work is in git and in this process, the bundling in esbuild's.
  const [board, compared] = await Promise.all([startLiveBoard(t), want.base ? pagesToCompare() : undefined]);
  lap(`board seeded (${Object.keys(board.store.snapshot().items).length} items)`);
  assert.ok(Object.keys(board.store.snapshot().items).length >= 1500, "the board has about 1,600 items");
  const changed = compared?.changed ?? false, basePage = compared?.basePage ?? {};

  // The first walk, on the real server: its answers are the tape every other window is answered from.
  const tape = new Tape();
  let targets: string[] = [], landed: number[] = [];
  {
    const scope = new Scope();
    try {
      const recorder = await Press.open(scope, board, { label: "recorder", fetch: tape.recorder() });
      const walk = await landings(recorder, want.landings);
      assert.equal(walk.length, want.landings, `n reached ${want.landings} other items`);
      targets = walk.map(l => l.item); landed = walk.map(l => l.press);
    } finally { await scope.close(); }
  }
  lap(`walk recorded (${tape.size} answers, ${(tape.bytes / 1e6).toFixed(1)} MB)`);
  // The premise of every number: a board as big as the live one, with a long unread list.
  const snapshotBytes = tape.sizeOf("/api/snapshot") ?? 0;
  assert.ok(snapshotBytes >= 12e6, `the snapshot is ${(snapshotBytes / 1e6).toFixed(1)} MB, as heavy as the live board's (about 15 MB)`);
  const events: Array<string | undefined> = [];
  if (want.writes) {
    (await writeEvents(board, landed.length)).forEach((data, k) => { events[landed[k]!] = data; });
    lap(`${landed.length} change events written`);
  }

  const open: Lane["open"] = (scope, how) => { const player = tape.player(); return Press.open(scope, board, { ...how, fetch: player.fetch, misses: player.misses }); };
  const currentLabel = changed ? "cand" : "base";
  return {
    board, tape, targets, events, changed, currentLabel, open,
    windows: () => [
      { label: "base", open: s => open(s, { label: "base", ...basePage }) },
      { label: "twin", open: s => open(s, { label: "twin", ...basePage }) },
      ...(changed ? [{ label: "cand", open: (s: Hooks) => open(s, { label: "cand" }) }] : []),
      { label: "slow", open: s => open(s, { label: "slow", reverts: SLOW_DRAW }), versus: currentLabel },
    ],
    walk: async (how, wanted, withEvents = false) => {
      const scope = new Scope();
      try {
        const win = await open(scope, how);
        const list = await landings(win, wanted, withEvents ? events : undefined);
        assert.equal(win.misses, 0, "every read the page asked for had an answer on the tape");
        return list;
      } finally { await scope.close(); }
    },
  };
}
