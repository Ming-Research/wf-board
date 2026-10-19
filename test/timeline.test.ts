// The timeline of an agent (src/timeline.ts): the segments a list of state starts, one dispatch record and the item's pause spans and end make; the
// store's index of state starts (written live, applied as deltas by the page, replayed after a restart); and the `timeline` tool. The page's
// line is tested in test/dom/runner-table.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.ts";
import type { Change } from "../src/store.ts";
import { ops } from "../src/ops.ts";
import { createMcpServer } from "../src/mcp.ts";
import { applyActivityDelta } from "../src/rules.ts";
import type { Item, RunnerState, StateStart } from "../src/model.ts";
import {
  STATE_STARTS_MAX, TIMELINE_AGENTS, TIMELINE_CHARS, LONG_SEGMENT_MS, SEGMENT_TEXT, clockText, drawLength, endOf, lineOf, lineOfAgent, lineOfDispatch, linesOfItem, listedAgents, longestWaits, startOfReport, timelineText, totalsText, withStateStart,
} from "../src/timeline.ts";
import type { AgentLine, LineInput } from "../src/timeline.ts";
import { spanText } from "../src/whole-view.ts";
import { board, asArchitect, author } from "./helpers.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const T = (min: number) => new Date(T0 + min * 60_000).toISOString();
const ms = (min: number) => T0 + min * 60_000;
const start = (min: number, state: RunnerState, extra: Partial<StateStart> = {}): StateStart => ({ at: T(min), state, ...extra });
const shape = (l: AgentLine) => l.segments.map(s => [s.kind, (s.from - T0) / 60_000, (s.to - T0) / 60_000]);
/** A dispatch record from `started` minutes, ended at `ended` minutes or still open. */
const session = (started: number, ended?: number, extra: object = {}) => ({
  agentId: "s1", agent: "s", role: "工程师", level: 2, started: T(started), ...(ended === undefined ? {} : { finish: { ended: T(ended), result: "一次通过" } }), ...extra,
}) as unknown as LineInput["dispatch"];

// --- the segments ----------------------------------------------------------------------------------------------------

test("an agent's line begins with a turn of work at its session's start, then each reported state is a segment of its kind, and the totals add up to the line", () => {
  const starts = [start(0, "running"), start(30, "ci"), start(90, "running"), start(100, "ask", { to: "owner", cards: ["k1"] }), start(600, "running"), start(610, "ready"), start(620, "done")];
  const line = lineOf({ starts, dispatch: session(0), now: ms(700) });
  assert.deepEqual(shape(line), [["work", 0, 30], ["ci", 30, 90], ["work", 90, 100], ["owner", 100, 600], ["work", 600, 610], ["merge", 610, 620], ["closing", 620, 700]]);
  assert.deepEqual(line.segments[3]!.cards, ["k1"], "an ask says the cards it waits for");
  assert.deepEqual([line.from, line.to], [ms(0), ms(700)]);
  const min = (kind: keyof AgentLine["totals"]) => line.totals[kind] / 60_000;
  assert.deepEqual([min("work"), min("ci"), min("owner"), min("merge"), min("closing"), min("architect")], [50, 60, 500, 10, 80, 0]);
  assert.equal(Object.values(line.totals).reduce((a, b) => a + b, 0), line.to - line.from, "the kinds add up to the whole line");
  assert.equal(line.ended, undefined);
  assert.deepEqual([line.agentId, line.agent, line.role, line.level], ["s1", "s", "工程师", 2]);
});

test("every state a report can be in has a kind, an ask is told by whom it asks, and the wait for an event keeps its words", () => {
  const states: Array<[StateStart, string]> = [
    [start(1, "running"), "work"], [start(1, "ci"), "ci"], [start(1, "ask", { to: "owner", cards: ["c"] }), "owner"], [start(1, "ask", { to: "architect" }), "architect"],
    [start(1, "items", { items: ["x"] }), "items"], [start(1, "run"), "run"], [start(1, "wait", { what: "执行程序重启", until: T(60) }), "wait"], [start(1, "ready"), "merge"],
    [start(1, "exception"), "person"], [start(1, "done"), "closing"],
  ];
  for (const [s, kind] of states) assert.equal(lineOf({ starts: [s], dispatch: session(0), now: ms(10) }).segments.at(-1)!.kind, kind, `${s.state} ${s.to ?? ""}`);
  const wait = lineOf({ starts: [start(1, "wait", { what: "执行程序重启", until: T(60) })], dispatch: session(0), now: ms(10) }).segments.at(-1)!;
  assert.deepEqual([wait.what, wait.until], ["执行程序重启", T(60)]);
});

test("the line is the session's span cut from the item's starts: the time before it and between two sessions is on no line", () => {
  const starts = [start(0, "running"), start(30, "ci"), start(100, "running"), start(130, "ask", { to: "owner", cards: ["k"] }), start(300, "running"), start(330, "ready")];
  const now = ms(400), at = (min: number) => min * 60_000 + T0;
  const first = lineOf({ starts, dispatch: session(0, 50), now });
  assert.deepEqual(shape(first), [["work", 0, 30], ["ci", 30, 50]], "the first session ends in the middle of the wait for CI");
  assert.deepEqual(first.ended, { at: at(50), result: "一次通过" });
  const second = lineOf({ starts, dispatch: session(100, 310), now });
  assert.deepEqual(shape(second), [["work", 100, 130], ["owner", 130, 300], ["work", 300, 310]], "the start at the session's own start is its first turn, not a segment");
  const third = lineOf({ starts, dispatch: session(320), now });
  assert.deepEqual(shape(third), [["work", 320, 330], ["merge", 330, 400]], "a session still open runs to now, and a start before it is not its own");
  assert.deepEqual([third.to, third.ended], [now, undefined]);
});

test("a session the runner reported nothing in has no line; a report a little before the session began is its own; a state reported as it began is its first turn", () => {
  const old = lineOf({ starts: [start(100, "running")], dispatch: session(0, 50), now: ms(200) });
  assert.deepEqual([old.segments, Object.values(old.totals).every(x => x === 0), old.ended?.at], [[], true, ms(50)], "no start in the session's span: no segments, the session still ended");
  for (const none of [undefined, []]) assert.deepEqual(lineOf({ starts: none, dispatch: session(0), now: ms(5) }).segments, []);
  assert.deepEqual(shape(lineOf({ starts: [start(-3, "running")], dispatch: session(0), now: ms(20) })), [["work", 0, 20]], "a report within the runner's grace before the start counts");
  assert.deepEqual(lineOf({ starts: [start(-30, "running")], dispatch: session(0), now: ms(20) }).segments, [], "one far before it does not");
  assert.deepEqual(shape(lineOf({ starts: [start(0, "running"), start(0, "ci")], dispatch: session(0), now: ms(20) })), [["work", 0, 20]], "a state at the very start is the first turn, whatever it says");
  assert.deepEqual(shape(lineOf({ starts: [start(5, "running"), start(5, "ci"), start(9, "ready")], dispatch: session(0), now: ms(20) })), [["work", 0, 5], ["ci", 5, 9], ["merge", 9, 20]], "states in one minute leave the earlier one no length");
  assert.deepEqual(shape(lineOf({ starts: [start(30, "ci"), start(0, "running")], dispatch: session(0), now: ms(40) })), [["work", 0, 30], ["ci", 30, 40]], "the starts are put in order");
  assert.deepEqual(shape(lineOf({ starts: [start(0, "running"), start(2, "running"), start(9, "ready")], dispatch: session(0), now: ms(20) })), [["work", 0, 9], ["merge", 9, 20]], "the same state again joins the segment before it");
});

test("a pause cuts whatever the state was into one stretch, an open pause runs to the end, and nothing of what it waited for is told", () => {
  const starts = [start(0, "running"), start(30, "ci"), start(90, "running"), start(100, "ask", { to: "owner", cards: ["k1"] })];
  const cut = lineOf({ starts, dispatch: session(0), pauses: [{ start: T(40), end: T(95) }], now: ms(200) });
  assert.deepEqual(shape(cut), [["work", 0, 30], ["ci", 30, 40], ["paused", 40, 95], ["work", 95, 100], ["owner", 100, 200]]);
  assert.equal(cut.segments[2]!.cards, undefined);
  assert.equal(cut.totals.paused / 60_000, 55);
  const open = lineOf({ starts, dispatch: session(0), pauses: [{ start: T(120) }], now: ms(200) });
  assert.deepEqual(shape(open).slice(-2), [["owner", 100, 120], ["paused", 120, 200]], "an open pause lasts to the end of the line");
  const two = lineOf({ starts, dispatch: session(0), pauses: [{ start: T(10), end: T(20) }, { start: T(15), end: T(35) }], now: ms(200) });
  assert.deepEqual(shape(two).slice(0, 3), [["work", 0, 10], ["paused", 10, 35], ["ci", 35, 90]], "pauses that overlap are one");
});

test("the end of the work ends a session still open there; a session that ended earlier keeps its own end; a start after the end makes nothing", () => {
  const starts = [start(0, "running"), start(60, "ci"), start(700, "running")], over = { at: ms(650), text: "活做完了" };
  const open = lineOf({ starts, dispatch: session(0), over, now: ms(900) });
  assert.deepEqual(shape(open), [["work", 0, 60], ["ci", 60, 650]]);
  assert.deepEqual([open.to, open.ended], [ms(650), { at: ms(650), result: "活做完了" }]);
  const own = lineOf({ starts, dispatch: session(0, 120), over, now: ms(900) });
  assert.deepEqual([shape(own).at(-1), own.ended], [["ci", 60, 120], { at: ms(120), result: "一次通过" }]);
  const early = lineOf({ starts, dispatch: session(0), over, now: ms(100) });
  assert.deepEqual([early.to, early.ended], [ms(100), undefined], "an end of the work after now is not known yet");
});

test("a review and an architect's turn are one stretch of work from start to end, whatever the runner reported while they ran, and the engineer's line does not change", () => {
  const starts = [start(0, "running"), start(30, "ci"), start(60, "ask", { to: "architect" }), start(90, "running")];
  const review = lineOf({ starts, dispatch: session(40, 80, { role: "审查", agentId: "r1" }), now: ms(200) });
  assert.deepEqual(shape(review), [["work", 40, 80]], "the states of the item, which are the engineer's, are not the review's");
  assert.deepEqual([review.totals.work / 60_000, review.totals.ci, review.totals.architect, review.ended?.at], [40, 0, 0, ms(80)]);
  const turn = lineOf({ starts, dispatch: session(65, 70, { role: "架构师", agentId: "a1" }), now: ms(200) });
  assert.deepEqual(shape(turn), [["work", 65, 70]], "an architect's turn is one answer, not a wait for the architect");
  const none = lineOf({ starts: undefined, dispatch: session(0, 10, { role: "审查" }), pauses: [{ start: T(2), end: T(5) }], now: ms(20) });
  assert.deepEqual(shape(none), [["work", 0, 10]], "a review needs no report of the runner to have a line, and a pause does not cut it");
  assert.deepEqual(shape(lineOf({ starts, dispatch: session(120, undefined, { role: "审查" }), now: ms(200) })), [["work", 120, 200]], "a review still open runs to now");
  assert.deepEqual(shape(lineOf({ starts, dispatch: session(0), now: ms(200) })), [["work", 0, 30], ["ci", 30, 60], ["architect", 60, 90], ["work", 90, 200]], "the engineer's line has all the states");
});

const dispatchesOf = (sessions: object[]) => sessions.map(x => ({ model: "m", level: 2, ...x })) as unknown as Item["dispatches"];

test("a session with no finish ends where the next of its role on the item began, a session of another role does not end it, and the end of the work ends it if that came first", () => {
  const sessions = dispatchesOf([
    { agentId: "e1", agent: "dead", role: "工程师", started: T(0) },
    { agentId: "r1", agent: "rev", role: "审查", started: T(50), finish: { ended: T(70), result: "一次通过" } },
    { agentId: "e2", agent: "second", role: "工程师", started: T(100) },
  ]);
  const states = { i: [start(0, "running"), start(20, "ci"), start(100, "running"), start(130, "ask", { to: "owner", cards: ["k"] })] };
  const withPlan = (plan: Item["plan"]) => ({ items: { i: item({ dispatches: sessions, plan }) }, activity: { writes: [], items: {}, states } });
  const wip = { statusOf: () => "wip" as const }, s = withPlan([]);
  const [dead, rev, second] = linesOfItem(s, wip, "i", ms(400));
  assert.deepEqual(shape(dead!), [["work", 0, 20], ["ci", 20, 100]], "the dead session's wait stops where the next engineer began, not where the review did, and it takes no state of the next");
  assert.deepEqual(dead!.ended, { at: ms(100), result: "后一次派活开始了，这次没有收尾记录" });
  assert.deepEqual(shape(rev!), [["work", 50, 70]]);
  assert.deepEqual([shape(second!), second!.ended], [[["work", 100, 130], ["owner", 130, 400]], undefined], "the next session is still running and owns the later states");
  const names = (lines: Array<{ line: AgentLine }>) => lines.map(x => x.line.agent);
  const listed = listedAgents(s, wip, ms(400));
  assert.deepEqual([names(listed.running), names(listed.recent)], [["second"], ["dead", "rev"]], "the dead one is no longer running; the ones that ended are newest first, whatever ended them");
  assert.deepEqual(names(listedAgents(s, wip, ms(100 + 24 * 60 + 1)).recent), [], "an end more than 24 hours back is not listed");
  assert.deepEqual(lineOfAgent(s, wip, "i", "e1", ms(400))!.ended?.at, ms(100));
  // The work over at 250, after the next session began: it ends that one, and the dead one still ended at 100.
  const done = { statusOf: () => "done" as const }, over = withPlan([{ id: "w", text: "work", state: "done", doneAt: T(250) }] as unknown as Item["plan"]);
  const after = listedAgents(over, done, ms(400));
  assert.deepEqual([names(after.running), names(after.recent)], [[], ["second", "dead", "rev"]], "a session ended by the end of the work is listed as one that ended");
  assert.deepEqual(after.recent[0]!.line.ended, { at: ms(250), result: "活做完了" });
  // The work over at 90, before the next session began: the dead session ends there, and the next has nothing of its own after that.
  const early = withPlan([{ id: "w", text: "work", state: "done", doneAt: T(90) }] as unknown as Item["plan"]);
  assert.deepEqual(lineOfDispatch(early, done, "i", early.items.i.dispatches![0]!, ms(400)).ended, { at: ms(90), result: "活做完了" });
  assert.equal(lineOfDispatch(early, done, "i", early.items.i.dispatches![2]!, ms(400)).segments.length, 0, "a session that began after the work was over has no line");
});

// --- the index ----------------------------------------------------------------------------------------------------------

test("a report makes a start from what it says, read leniently, and nothing else makes one", () => {
  const full = { state: "ask", since: T(0), at: T(5), started: T(0), to: "owner", cards: ["c1", "c2"], note: "x", turns: 3, cost: 1.5 };
  assert.deepEqual(startOfReport(full), { at: T(0), state: "ask", to: "owner", cards: ["c1", "c2"] }, "the figures and the note are not part of a start");
  assert.deepEqual(startOfReport({ state: "wait", since: T(0), what: "w", until: T(9) }), { at: T(0), state: "wait", what: "w", until: T(9) });
  assert.deepEqual(startOfReport({ state: "items", since: T(0), items: ["a"] }), { at: T(0), state: "items", items: ["a"] });
  assert.deepEqual(startOfReport({ state: "ci", since: T(0), cards: [], items: [1], until: "never" }), { at: T(0), state: "ci" }, "a field of the wrong shape is left out");
  for (const bad of [undefined, null, "x", [], {}, { state: "stuck", since: T(0) }, { state: "ci" }, { state: "ci", since: "yesterday" }]) assert.equal(startOfReport(bad), null, JSON.stringify(bad));
});

test("a start the same as the last is not added, the list keeps the newest STATE_STARTS_MAX, and the list is never changed in place", () => {
  const a = start(0, "running"), b = start(5, "ci");
  const one = withStateStart(undefined, a);
  assert.deepEqual(one, [a]);
  assert.equal(withStateStart(one, { ...a }), one, "a report that repeats the last start leaves the same list");
  const two = withStateStart(one, b);
  assert.deepEqual([one.length, two.length], [1, 2]);
  assert.notEqual(withStateStart(two, a), two, "the same state again after another is a new start");
  assert.equal(withStateStart(two, { ...b, cards: ["c"] }).length, 3, "what it waits for is part of the start");
  let list: readonly StateStart[] | undefined;
  for (let i = 0; i < STATE_STARTS_MAX + 5; i++) list = withStateStart(list, start(i, i % 2 ? "ci" : "running"));
  assert.equal(list!.length, STATE_STARTS_MAX);
  assert.equal(list![0]!.at, T(5), "the oldest are the ones dropped");
  assert.equal(list!.at(-1)!.at, T(STATE_STARTS_MAX + 4));
});

/** A board whose clock the test sets. */
async function clocked(t: Parameters<typeof board>[0], now = "2026-10-19T09:00:00Z") {
  const fixture = await board(t);
  let clock = now;
  return { ...fixture, op: ops(fixture.store, () => clock), setClock: (value: string) => { clock = value; } };
}
const states = (store: Store) => store.snapshot().activity?.states;

test("live writes, the deltas the page applies, a restart that replays the history and a start from the cache give the same state starts", async t => {
  const { dir, store, op, setClock } = await clocked(t);
  const changes: Change[] = [];
  store.onChange(change => changes.push(change));
  let page = store.snapshot().activity, head = store.snapshot().head;
  const report = (id: string, state: RunnerState, at: string, extra: object = {}) => { setClock(at); return op.reportState({ ...asArchitect, id, state, ...extra } as Parameters<typeof op.reportState>[0]); };
  await report("a", "running", "2026-10-19T09:00:00Z", { startedAt: "2026-10-19T08:30:00Z", turns: 1 });
  await report("a", "running", "2026-10-19T09:10:00Z", { turns: 2, note: "第 2 轮" });
  await op.appendLog({ author, id: "a", text: "a log line is no report" });
  await report("a", "ci", "2026-10-19T09:20:00Z");
  await report("b", "running", "2026-10-19T09:20:00Z");
  await report("a", "ask", "2026-10-19T09:40:00Z", { to: "owner", cards: ["c1"] });
  await report("a", "ask", "2026-10-19T09:50:00Z", { to: "owner", cards: ["c1", "c2"] });
  const live = states(store)!;
  assert.deepEqual(live.a!.map(x => [x.at, x.state, x.cards]), [
    ["2026-10-19T09:00:00Z", "running", undefined], ["2026-10-19T09:20:00Z", "ci", undefined], ["2026-10-19T09:40:00Z", "ask", ["c1"]], ["2026-10-19T09:50:00Z", "ask", ["c1", "c2"]],
  ], "a repeated state and a log line add no start; another wait adds one");
  assert.deepEqual(live.b!.map(x => x.state), ["running"]);
  assert.deepEqual(changes.map(c => Object.keys(c.activity.states ?? {})), [["a"], [], [], ["a"], ["b"], ["a"], ["a"]], "a delta names only the items whose list changed");
  for (const change of changes) { assert.equal(change.activity.from, head); page = applyActivityDelta(page, change.activity); head = change.commit; }
  assert.deepEqual(page?.states, live, "deltas applied in order give the store's index");
  // The cache the seed wrote is older than the reports: a start replays the commits after it.
  assert.deepEqual(states(await Store.open(dir)), live, "the cache of an older head and the replay of the commits after it");
  await store.saveStartupCache();
  assert.deepEqual(states(await Store.open(dir)), live, "the cache of the head itself");
  await report("a", "ready", "2026-10-19T10:00:00Z");
  assert.deepEqual(states(await Store.open(dir)), states(store), "the cache, then one more report replayed");
  await rm(join(dir, ".git", "wf-board-startup-cache.json"));
  const scanned = await Store.open(dir);
  assert.deepEqual(states(scanned), states(store), "no cache: the whole history is replayed");
  assert.deepEqual(states(scanned)!.a!.at(-1), { at: "2026-10-19T10:00:00Z", state: "ready" });
});

// --- the lines of an item ------------------------------------------------------------------------------------------------

const item = (fields: object = {}): Item => ({ title: "t", group: "p", plan: [], log: [], links: [], rev: 1, updated: T(500), ...fields }) as unknown as Item;

test("an item is over when its last plan row is done or dropped, or when it was cancelled", () => {
  const done = item({ plan: [{ id: "w", text: "work", state: "done", doneAt: T(300) }, { id: "x", text: "x", state: "dropped", droppedAt: T(400), reason: "r" }, { id: "accept", text: "ok", accept: true, state: "done", doneAt: T(350) }] });
  assert.deepEqual(endOf(done, { statusOf: () => "done" }, "i"), { kind: "done", at: ms(400) });
  assert.equal(endOf(done, { statusOf: () => "wip" }, "i"), undefined, "an item not done has no end");
  assert.deepEqual(endOf(item({ status: "cancelled" }), { statusOf: () => "cancelled" }, "i"), { kind: "cancelled", at: ms(500) });
  assert.deepEqual(endOf(item({ plan: [] }), { statusOf: () => "done" }, "i"), { kind: "done", at: ms(500) }, "without a dated row, the item's last write");
});

test("an item has a line for each agent it went through, oldest first, read from its starts, pauses and end; a session the runner did not run has none", () => {
  const sessions = [
    { agentId: "s2", agent: "second", role: "审查", level: 3, model: "m", started: T(110) },
    { agentId: "s1", agent: "first", role: "工程师", level: 2, model: "m", started: T(0), finish: { ended: T(100), result: "返工后通过" } },
    { agentId: "s0", agent: "before the runner", role: "工程师", level: 2, model: "m", started: T(-900), finish: { ended: T(-800), result: "一次通过" } },
  ];
  const it = item({
    dispatches: sessions as unknown as Item["dispatches"],
    plan: [{ id: "w", text: "work", state: "done", doneAt: T(125) }, { id: "accept", text: "ok", accept: true, state: "done", doneAt: T(125) }],
  });
  const s = { items: { i: it }, activity: { writes: [], items: {}, states: { i: [start(0, "running"), start(60, "ci"), start(111, "running"), start(120, "done")] }, pauses: { i: [{ start: T(20), end: T(30) }] } } };
  const lines = linesOfItem(s, { statusOf: () => "done" }, "i", ms(900));
  assert.deepEqual(lines.map(l => [l.agent, l.role]), [["first", "工程师"], ["second", "审查"]], "the oldest first; a review is an agent too; the session before the runner has no line");
  assert.deepEqual(shape(lines[0]!), [["work", 0, 20], ["paused", 20, 30], ["work", 30, 60], ["ci", 60, 100]], "the first session ends with its dispatch");
  assert.deepEqual(lines[0]!.ended, { at: ms(100), result: "返工后通过" });
  assert.deepEqual(shape(lines[1]!), [["work", 110, 125]], "the review is work from its start; it is still open when the work ends, and ends with it");
  assert.deepEqual(lines[1]!.ended, { at: ms(125), result: "活做完了" });
  assert.deepEqual(linesOfItem(s, { statusOf: () => "wip" }, "nobody", ms(900)), [], "an item the board does not have has no lines");
  assert.equal(lineOfAgent(s, { statusOf: () => "done" }, "i", "s1", ms(900))!.agent, "first");
  assert.equal(lineOfAgent(s, { statusOf: () => "done" }, "i", "none", ms(900)), undefined);
  assert.equal(lineOfAgent(s, { statusOf: () => "done" }, "nobody", "s1", ms(900)), undefined);
});

// --- drawing and reading ------------------------------------------------------------------------------------------------

test("a segment is drawn as long as it took up to three hours, and a tenth of the rest beyond", () => {
  assert.equal(drawLength(0), 0);
  assert.equal(drawLength(60_000), 60_000);
  assert.equal(drawLength(LONG_SEGMENT_MS), LONG_SEGMENT_MS);
  assert.equal(drawLength(LONG_SEGMENT_MS + 10 * 3600_000), LONG_SEGMENT_MS + 3600_000);
  assert.ok(drawLength(5 * 24 * 3600_000) < drawLength(LONG_SEGMENT_MS) * 5, "a wait of five days is not drawn five days long");
  assert.ok(drawLength(4 * 3600_000) > drawLength(3 * 3600_000), "a longer wait is still drawn longer");
});

test("the longest waits are the whole waits of the running agents, longest first, work and a pause never counted", () => {
  const line = (item: string, starts: StateStart[], now: number, extra: Partial<LineInput> = {}) => ({ item, line: lineOf({ starts, dispatch: session(0, undefined, { agent: `eng-${item}` }), now: ms(now), ...extra }) });
  const a = line("a", [start(0, "running"), start(10, "ci"), start(100, "running"), start(110, "ask", { to: "architect" })], 400);
  const b = line("b", [start(0, "running"), start(5, "ask", { to: "owner", cards: ["k"] })], 300);
  const c = line("c", [start(0, "running")], 5000);
  const waits = longestWaits([a, b, c], 10);
  assert.deepEqual(waits.map(w => [w.item, w.agent, w.kind, (w.to - w.from) / 60_000, w.ongoing, w.waits]), [["b", "eng-b", "owner", 295, true, "卡 k"], ["a", "eng-a", "architect", 290, true, ""], ["a", "eng-a", "ci", 90, false, ""]]);
  assert.equal(waits.some(w => w.item === "c"), false, "work is not a wait");
  assert.equal(longestWaits([a, b, c], 1).length, 1);
  const paused = line("p", [start(0, "running"), start(1, "ci")], 100, { pauses: [{ start: T(30), end: T(40) }] });
  assert.deepEqual(longestWaits([paused], 10).map(w => (w.to - w.from) / 60_000), [60, 29], "a pause ends a wait: two waits, and the pause itself is none");
  const over = line("d", [start(0, "running"), start(1, "ci")], 100, { over: { at: ms(60), text: "活做完了" } });
  assert.equal(longestWaits([over], 10)[0]!.ongoing, false, "a wait that ended with the work does not go on");
  const ended = { item: "e", line: lineOf({ starts: [start(0, "running"), start(1, "ci")], dispatch: session(0, 30), now: ms(100) }) };
  assert.deepEqual(longestWaits([ended], 10).map(w => [(w.to - w.from) / 60_000, w.ongoing]), [[29, false]], "a wait that ended with its session does not go on");
});

test("the text of an item says each agent's span, its totals and each segment with what it waited for; a long answer folds the earliest segments and says how many", () => {
  const starts = [start(0, "running"), start(30, "ci"), start(90, "ask", { to: "owner", cards: ["k1", "k2"] }), start(200, "wait", { what: "执行程序重启", until: T(300) })];
  const text = timelineText("i", "一件活", [lineOf({ starts, dispatch: session(0), now: ms(400) })]);
  assert.equal(text, [
    "i · 一件活 · 经过 1 个代理",
    "s（工程师，难度 2） · 共 6 小时 40 分（10-19 08:00Z 起，还在跑）",
    "合计：干活 30 分钟 · 等 CI 1 小时 · 等主人 1 小时 50 分 · 等事件 3 小时 20 分",
    "  10-19 08:00Z · 干活 · 30 分钟",
    "  10-19 08:30Z · 等 CI · 1 小时",
    "  10-19 09:30Z · 等主人 · 1 小时 50 分 · 卡 k1、k2",
    "  10-19 11:20Z · 等事件 · 3 小时 20 分 · 执行程序重启（到 10-19 13:00Z） · 还在这里",
  ].join("\n"));
  const over = timelineText("i", "x", [lineOf({ starts, dispatch: session(0, 40), now: ms(900) })]).split("\n");
  assert.equal(over[1], "s（工程师，难度 2） · 共 40 分钟（10-19 08:00Z 起，结束于 10-19 08:40Z，一次通过）");
  assert.ok(!over.some(l => l.includes("还在这里")), "an agent that ended is not still anywhere");
  assert.match(timelineText("i", "一件活", []), /没有代理的线/);
  // A long answer is folded from the earliest segment on, as few as bring it under the cap, and says how many.
  const many = Array.from({ length: 300 }, (_, i) => start(i * 10, i % 2 ? "ci" : "running"));
  const full = lineOf({ starts: many, dispatch: session(0), now: ms(3100) }), rows = timelineText("i", "x", [full]).split("\n");
  assert.equal(full.segments.length, 300);
  const listed = rows.filter(l => /^ {2}\d\d-\d\d /.test(l)), folded = 300 - listed.length;
  assert.ok([...rows.join("\n")].length <= TIMELINE_CHARS && folded > 2 && folded < 300, `${[...rows.join("\n")].length} characters, ${folded} folded`);
  assert.ok([...timelineText("i", "x", [lineOf({ starts: many.slice(0, 200), dispatch: session(0), now: ms(3100) })])].length <= TIMELINE_CHARS, "a line shorter than the whole is cut as well");
  assert.match(rows[0]!, new RegExp(`（共 300 段，为了不超过 ${TIMELINE_CHARS} 字，最早的 ${folded} 段折起来了）$`), "the first line says how many of how many");
  const sum = (kind: string) => full.segments.slice(0, folded).filter(seg => seg.kind === kind).reduce((n, seg) => n + seg.to - seg.from, 0);
  assert.deepEqual(rows.filter(l => l.startsWith("  … 最早的")), [`  … 最早的 ${folded} 段折成一行：干活 ${spanText(sum("work"))} · 等 CI ${spanText(sum("ci"))}`], "the folded segments are one line of totals by kind");
  const first = full.segments[folded]!, last = full.segments.at(-1)!;
  assert.equal(listed[0], `  ${clockText(first.from)} · ${SEGMENT_TEXT[first.kind]} · ${spanText(first.to - first.from)}`, "the segments listed are the newest ones, from the first not folded");
  assert.equal(listed.at(-1), `  ${clockText(last.from)} · ${SEGMENT_TEXT[last.kind]} · ${spanText(last.to - last.from)} · 还在这里`);
  assert.ok(rows.includes(`合计：${totalsText(full)}`), "the totals still count the folded segments");
  assert.ok(!timelineText("i", "x", [lineOf({ starts: many.slice(0, 20), dispatch: session(0), now: ms(300) })]).includes("折起来了"), "a short answer folds nothing");
  const crowd = Array.from({ length: TIMELINE_AGENTS + 2 }, (_, i) => lineOf({ starts: [start(i * 10, "running")], dispatch: session(i * 10, i * 10 + 5, { agentId: `s${i}`, agent: `a${i}` }), now: ms(900) }));
  const head = timelineText("i", "x", crowd).split("\n");
  assert.equal(head[0], `i · x · 经过 ${TIMELINE_AGENTS + 2} 个代理（前 2 个没列出）`);
  assert.ok(!head.some(l => l.startsWith("a0（")) && head.some(l => l.startsWith(`a${TIMELINE_AGENTS + 1}（`)), "the newest agents are the ones listed");
});

// --- the tool ----------------------------------------------------------------------------------------------------------

test("the tool answers for one item with the line of each agent it went through, and for none with the agents running, the ones that ended lately and the longest waits", async t => {
  const { store, op, setClock } = await clocked(t);
  const at = "2026-10-19T12:00:00Z";
  const server = createMcpServer({ store, ops: op, now: () => at });
  const client = new Client({ name: "t", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (args: Record<string, unknown>) => { const r = await client.callTool({ name: "timeline", arguments: args }); return { error: r.isError === true, text: (r.content as Array<{ text: string }>)[0]!.text }; };
  const report = (id: string, state: RunnerState, when: string, extra: object = {}) => { setClock(when); return op.reportState({ ...asArchitect, id, state, ...extra } as Parameters<typeof op.reportState>[0]); };
  const begin = (id: string, agent: string, when: string) => { setClock(when); return op.dispatchStart({ ...asArchitect, id, role: "工程师", level: 2, model: "Sonnet", agent, agentId: `${agent}-id`, startedAt: when }); };
  // Item a: one session from 09:00 that works, waits for CI, then waits for the architect. Item b: a session from 10:00 to 10:30 that ended, then one from 11:00.
  await begin("a", "eng-a", "2026-10-19T09:00:00Z");
  await report("a", "running", "2026-10-19T09:00:00Z", { startedAt: "2026-10-19T09:00:00Z" });
  await report("a", "ci", "2026-10-19T09:30:00Z");
  await report("a", "ask", "2026-10-19T10:00:00Z", { to: "architect" });
  await begin("b", "eng-b0", "2026-10-19T10:00:00Z");
  await report("b", "running", "2026-10-19T10:00:00Z", { startedAt: "2026-10-19T10:00:00Z" });
  await report("b", "ci", "2026-10-19T10:20:00Z");
  setClock("2026-10-19T10:30:00Z");
  await op.dispatchFinish({ ...asArchitect, id: "b", agentId: "eng-b0-id", result: "一次通过", usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, cost: 0, reports: 0, kickbacks: 0, endedAt: "2026-10-19T10:30:00Z" });
  await begin("b", "eng-b", "2026-10-19T11:00:00Z");
  await report("b", "running", "2026-10-19T11:00:00Z");
  const one = await call({ id: "a" });
  assert.equal(one.error, false);
  assert.equal(one.text, [
    "a · 中文检查 · 经过 1 个代理",
    "eng-a（工程师，难度 2） · 共 3 小时（10-19 09:00Z 起，还在跑）",
    "合计：干活 30 分钟 · 等 CI 30 分钟 · 等架构师 2 小时",
    "  10-19 09:00Z · 干活 · 30 分钟",
    "  10-19 09:30Z · 等 CI · 30 分钟",
    "  10-19 10:00Z · 等架构师 · 2 小时 · 还在这里",
  ].join("\n"));
  const two = (await call({ id: "b" })).text.split("\n");
  assert.match(two[0]!, / · 经过 2 个代理$/);
  assert.equal(two[1], "eng-b0（工程师，难度 2） · 共 30 分钟（10-19 10:00Z 起，结束于 10-19 10:30Z，一次通过）", "the session that ended keeps its own line");
  assert.equal(two[2], "合计：干活 20 分钟 · 等 CI 10 分钟");
  assert.ok(two.includes("eng-b（工程师，难度 2） · 共 1 小时（10-19 11:00Z 起，还在跑）"), "and the one running now has its own; the hour between them is on neither");
  const all = await call({});
  assert.equal(all.error, false);
  const rows = all.text.split("\n");
  assert.equal(rows[0], "在跑的代理 2 个（10-19 12:00Z 的数）");
  assert.match(rows[1]!, /^ {2}a · 中文检查 · eng-a（工程师，难度 2） · 现在等架构师 2 小时 · 共 3 小时（干活 30 分钟 · 等 CI 30 分钟 · 等架构师 2 小时）$/);
  assert.match(rows[2]!, /^ {2}b · .* · eng-b（工程师，难度 2） · 现在干活 1 小时 · 共 1 小时（干活 1 小时）$/);
  assert.equal(rows[3], "最近 24 小时里收尾的代理 1 个（最多列 10 个）");
  assert.match(rows[4]!, /^ {2}b · .* · eng-b0（工程师，难度 2） · 结束于 10-19 10:30Z，一次通过 · 共 30 分钟（干活 20 分钟 · 等 CI 10 分钟）$/);
  assert.equal(rows[5], "在跑的代理里最长的 2 个等待段");
  assert.match(rows[6]!, /^ {2}a · 中文检查 · eng-a · 等架构师 · 2 小时 · 10-19 10:00Z 起，还在等$/);
  assert.match(rows[7]!, /^ {2}a · 中文检查 · eng-a · 等 CI · 30 分钟 · 10-19 09:30Z 起，到 10-19 10:00Z$/);
  assert.equal(rows.length, 8, "the waits are those of the agents running: the one that ended lately has none listed");
  assert.match((await call({ limit: 1 })).text, /在跑的代理里最长的 1 个等待段/);
  const bad = await call({ id: "nothing" });
  assert.equal(bad.error, true);
  assert.match(bad.text, /choose an existing item/);
  assert.equal((await call({ limit: 0 })).error, true, "a limit under 1 is refused");
});
