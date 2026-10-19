// The timeline of a piece of work (src/timeline.ts): the segments a list of state starts, dispatch records, pause spans and an end make; the
// store's index of state starts (written live, applied as deltas by the page, replayed after a restart); and the `timeline` tool. The page's
// line is tested in test/dom/runner-table.test.ts.
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
import type { Dispatch, Item, RunnerState, StateStart } from "../src/model.ts";
import {
  STATE_STARTS_MAX, LONG_SEGMENT_MS, drawLength, endOf, longestWaits, startOfReport, timelineOf, timelineOfItem, timelineText, longestWaitsText, withStateStart,
} from "../src/timeline.ts";
import type { Segment, Timeline } from "../src/timeline.ts";
import { board, asArchitect, author } from "./helpers.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const T = (min: number) => new Date(T0 + min * 60_000).toISOString();
const ms = (min: number) => T0 + min * 60_000;
const start = (min: number, state: RunnerState, extra: Partial<StateStart> = {}): StateStart => ({ at: T(min), state, ...extra });
const shape = (t: Timeline) => t.segments.map(s => [s.kind, (s.from - T0) / 60_000, (s.to - T0) / 60_000, ...(s.down ? ["down"] : [])]);
const sent = (started: number, ended?: number, role: Dispatch["role"] = "工程师") => ({ role, started: T(started), ...(ended === undefined ? {} : { finish: { ended: T(ended) } }) }) as unknown as Pick<Dispatch, "role" | "started" | "finish">;

// --- the segments ----------------------------------------------------------------------------------------------------

test("each state start makes a segment of the kind its state makes, and the totals add up to the life", () => {
  const starts = [start(0, "running"), start(30, "ci"), start(90, "running"), start(100, "ask", { to: "owner", cards: ["k1"] }), start(600, "running"), start(610, "ready"), start(620, "done")];
  const t = timelineOf({ starts, now: ms(700) });
  assert.deepEqual(shape(t), [["work", 0, 30], ["ci", 30, 90], ["work", 90, 100], ["owner", 100, 600], ["work", 600, 610], ["merge", 610, 620], ["closing", 620, 700]]);
  assert.deepEqual(t.segments[3]!.cards, ["k1"], "an ask says the cards it waits for");
  assert.deepEqual([t.from, t.to], [ms(0), ms(700)]);
  const min = (kind: keyof Timeline["totals"]) => t.totals[kind] / 60_000;
  assert.deepEqual([min("work"), min("ci"), min("owner"), min("merge"), min("closing"), min("architect")], [50, 60, 500, 10, 80, 0]);
  assert.equal(Object.values(t.totals).reduce((a, b) => a + b, 0), t.to - t.from, "the kinds add up to the whole line");
  assert.equal(t.down, 0);
  assert.equal(t.ended, undefined);
});

test("every state a report can be in has a kind, an ask is told by whom it asks, and the wait for an event keeps its words", () => {
  const states: Array<[StateStart, string]> = [
    [start(0, "running"), "work"], [start(0, "ci"), "ci"], [start(0, "ask", { to: "owner", cards: ["c"] }), "owner"], [start(0, "ask", { to: "architect" }), "architect"],
    [start(0, "items", { items: ["x"] }), "items"], [start(0, "run"), "run"], [start(0, "wait", { what: "执行程序重启", until: T(60) }), "wait"], [start(0, "ready"), "merge"],
    [start(0, "exception"), "person"], [start(0, "done"), "closing"],
  ];
  for (const [s, kind] of states) assert.equal(timelineOf({ starts: [s], now: ms(10) }).segments[0]!.kind, kind, `${s.state} ${s.to ?? ""}`);
  const wait = timelineOf({ starts: [start(0, "wait", { what: "执行程序重启", until: T(60) })], now: ms(10) }).segments[0]!;
  assert.deepEqual([wait.what, wait.until], ["执行程序重启", T(60)]);
});

test("a pause cuts whatever the state was into one stretch, an open pause runs to the end, and nothing of what it waited for is told", () => {
  const starts = [start(0, "running"), start(30, "ci"), start(90, "running"), start(100, "ask", { to: "owner", cards: ["k1"] })];
  const cut = timelineOf({ starts, pauses: [{ start: T(40), end: T(95) }], now: ms(200) });
  assert.deepEqual(shape(cut), [["work", 0, 30], ["ci", 30, 40], ["paused", 40, 95], ["work", 95, 100], ["owner", 100, 200]]);
  assert.equal(cut.segments[2]!.cards, undefined);
  assert.equal(cut.totals.paused / 60_000, 55);
  const open = timelineOf({ starts, pauses: [{ start: T(120) }], now: ms(200) });
  assert.deepEqual(shape(open).slice(-2), [["owner", 100, 120], ["paused", 120, 200]], "an open pause lasts to the end of the line");
  const two = timelineOf({ starts, pauses: [{ start: T(10), end: T(20) }, { start: T(15), end: T(35) }], now: ms(200) });
  assert.deepEqual(shape(two).slice(0, 3), [["work", 0, 10], ["paused", 10, 35], ["ci", 35, 90]], "pauses that overlap are one");
});

test("a wait with no engineer session open is marked down, work is not, and a review is no engineer", () => {
  const starts = [start(0, "running"), start(30, "ci"), start(90, "running")];
  const t = timelineOf({ starts, dispatches: [sent(0, 20), sent(50, 60, "审查"), sent(80)], now: ms(100) });
  assert.deepEqual(shape(t), [["work", 0, 30], ["ci", 30, 80, "down"], ["ci", 80, 90], ["work", 90, 100]], "the gap is 20 to 80; the review's end at 60 opens none; work in a gap is not marked");
  assert.equal(t.down / 60_000, 50, "the part of the waits with no session open");
  assert.equal(t.totals.ci / 60_000, 60, "the kind counts the down part too");
  // The session that ended last leaves a gap that does not close.
  const open = timelineOf({ starts: [start(0, "running"), start(30, "ci")], dispatches: [sent(0, 20)], now: ms(100) });
  assert.deepEqual(shape(open), [["work", 0, 30], ["ci", 30, 100, "down"]]);
  // A session still open leaves no gap.
  assert.deepEqual(shape(timelineOf({ starts: [start(0, "running"), start(30, "ci")], dispatches: [sent(0)], now: ms(100) })), [["work", 0, 30], ["ci", 30, 100]]);
  // The stretch of one wait that a gap cuts apart is two segments of the same kind, one down.
  assert.deepEqual(shape(timelineOf({ starts: [start(0, "ci")], dispatches: [sent(0, 10), sent(20)], now: ms(30) })), [["ci", 0, 10], ["ci", 10, 20, "down"], ["ci", 20, 30]]);
});

test("a pause over a wait leaves no down mark on the paused stretch", () => {
  const t = timelineOf({ starts: [start(0, "ci")], pauses: [{ start: T(10), end: T(20) }], dispatches: [sent(0, 5)], now: ms(30) });
  assert.deepEqual(shape(t), [["ci", 0, 5], ["ci", 5, 10, "down"], ["paused", 10, 20], ["ci", 20, 30, "down"]]);
});

test("the end of the work ends the line there; a start after the end makes nothing", () => {
  const starts = [start(0, "running"), start(60, "ci"), start(700, "running")];
  const done = timelineOf({ starts, ended: { kind: "done", at: ms(650) }, now: ms(900) });
  assert.deepEqual(shape(done), [["work", 0, 60], ["ci", 60, 650]]);
  assert.deepEqual([done.to, done.ended], [ms(650), { kind: "done", at: ms(650) }]);
  const cancelled = timelineOf({ starts: starts.slice(0, 2), ended: { kind: "cancelled", at: ms(120) }, now: ms(900) });
  assert.deepEqual(shape(cancelled), [["work", 0, 60], ["ci", 60, 120]]);
  assert.equal(cancelled.ended!.kind, "cancelled");
});

test("the work began before its first report when the report says so; states in one second leave the earlier one no length; no starts, no line", () => {
  const early = timelineOf({ starts: [start(10, "running")], began: T(0), now: ms(20) });
  assert.deepEqual(shape(early), [["work", 0, 20]]);
  assert.equal(timelineOf({ starts: [start(10, "running")], began: T(15), now: ms(20) }).from, ms(10), "a start later than the first report changes nothing");
  assert.deepEqual(shape(timelineOf({ starts: [start(5, "running"), start(5, "ci"), start(9, "ready")], now: ms(20) })), [["ci", 5, 9], ["merge", 9, 20]]);
  assert.deepEqual(shape(timelineOf({ starts: [start(30, "ci"), start(0, "running")], now: ms(40) })), [["work", 0, 30], ["ci", 30, 40]], "the starts are put in order");
  for (const none of [undefined, []]) {
    const t = timelineOf({ starts: none, now: ms(5) });
    assert.deepEqual([t.segments, t.down, Object.values(t.totals).every(x => x === 0)], [[], 0, true]);
  }
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

// --- the item's line ----------------------------------------------------------------------------------------------------

const item = (fields: object = {}): Item => ({ title: "t", group: "p", plan: [], log: [], links: [], rev: 1, updated: T(500), ...fields }) as unknown as Item;

test("an item is over when its last plan row is done or dropped, or when it was cancelled", () => {
  const done = item({ plan: [{ id: "w", text: "work", state: "done", doneAt: T(300) }, { id: "x", text: "x", state: "dropped", droppedAt: T(400), reason: "r" }, { id: "accept", text: "ok", accept: true, state: "done", doneAt: T(350) }] });
  assert.deepEqual(endOf(done, { statusOf: () => "done" }, "i"), { kind: "done", at: ms(400) });
  assert.equal(endOf(done, { statusOf: () => "wip" }, "i"), undefined, "an item not done has no end");
  assert.deepEqual(endOf(item({ status: "cancelled" }), { statusOf: () => "cancelled" }, "i"), { kind: "cancelled", at: ms(500) });
  assert.deepEqual(endOf(item({ plan: [] }), { statusOf: () => "done" }, "i"), { kind: "done", at: ms(500) }, "without a dated row, the item's last write");
});

test("the line of an item reads its starts, dispatches, pauses and end from the board", () => {
  const it = item({
    runner: { state: "done", since: T(120), at: T(120), started: T(-5) },
    dispatches: [{ agentId: "s1", agent: "s", role: "工程师", level: 2, model: "m", started: T(0), finish: { ended: T(130) } }] as unknown as Item["dispatches"],
    plan: [{ id: "w", text: "work", state: "done", doneAt: T(125) }, { id: "accept", text: "ok", accept: true, state: "done", doneAt: T(125) }],
  });
  const s = { items: { i: it }, activity: { writes: [], items: {}, states: { i: [start(0, "running"), start(60, "ci"), start(120, "done")] }, pauses: { i: [{ start: T(20), end: T(30) }] } } };
  const t = timelineOfItem(s, { statusOf: () => "done" }, "i", ms(900));
  assert.deepEqual(shape(t), [["work", -5, 20], ["paused", 20, 30], ["work", 30, 60], ["ci", 60, 120], ["closing", 120, 125]]);
  assert.deepEqual(t.ended, { kind: "done", at: ms(125) });
  assert.deepEqual(timelineOfItem(s, { statusOf: () => "wip" }, "nobody", ms(900)).segments, [], "an item the board does not have has no line");
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

test("the longest waits are the whole waits, a wait cut by a gap or a pause kept whole where it is the same wait, work never counted", () => {
  const line = (id: string, starts: StateStart[], now: number, extra: Partial<Parameters<typeof timelineOf>[0]> = {}) => ({ id, timeline: timelineOf({ starts, now: ms(now), ...extra }) });
  const a = line("a", [start(0, "running"), start(10, "ci"), start(100, "running"), start(110, "ask", { to: "architect" })], 400, { dispatches: [sent(0, 50)] });
  const b = line("b", [start(0, "ask", { to: "owner", cards: ["k"] })], 300);
  const c = line("c", [start(0, "running")], 5000);
  const waits = longestWaits([a, b, c], 10);
  assert.deepEqual(waits.map(w => [w.id, w.kind, (w.to - w.from) / 60_000, w.ongoing, w.down]), [["b", "owner", 300, true, false], ["a", "architect", 290, true, true], ["a", "ci", 90, false, true]]);
  assert.equal(waits.some(w => w.id === "c"), false, "work is not a wait");
  assert.equal(longestWaits([a, b, c], 1).length, 1);
  assert.deepEqual(longestWaits([a], 10).filter(w => w.kind === "ci").map(w => (w.to - w.from) / 60_000), [90], "the wait the session's end cut in two is one wait");
  const paused = line("p", [start(0, "ci")], 100, { pauses: [{ start: T(30), end: T(40) }] });
  assert.deepEqual(longestWaits([paused], 10).map(w => (w.to - w.from) / 60_000).sort((x, y) => y - x), [60, 30], "a pause ends a wait: two waits");
  const over = timelineOf({ starts: [start(0, "ci")], ended: { kind: "done", at: ms(60) }, now: ms(100) });
  assert.equal(longestWaits([{ id: "d", timeline: over }], 10)[0]!.ongoing, false, "a wait that ended with the work does not go on");
});

test("the text of a line says its span, its totals and each segment with what it waited for; a long line lists the newest and counts the rest", () => {
  const starts = [start(0, "running"), start(30, "ci"), start(90, "ask", { to: "owner", cards: ["k1", "k2"] }), start(200, "wait", { what: "执行程序重启", until: T(300) })];
  const text = timelineText("i", "一件活", timelineOf({ starts, dispatches: [sent(0, 40)], now: ms(400) }));
  const lines = text.split("\n");
  assert.equal(lines[0], "i · 一件活 · 共 6 小时 40 分（10-19 08:00Z 起，还没完）");
  assert.equal(lines[1], "合计：干活 30 分钟 · 等 CI 1 小时 · 等主人 1 小时 50 分 · 等事件 3 小时 20 分；其中放下等待 6 小时");
  assert.ok(lines.some(l => l === "  10-19 08:00Z · 干活 · 30 分钟"), lines.join("\n"));
  assert.ok(lines.some(l => l === "  10-19 08:30Z · 等 CI · 10 分钟"), lines.join("\n"));
  assert.ok(lines.some(l => l === "  10-19 08:40Z · 等 CI（放下等待） · 50 分钟"));
  assert.ok(lines.some(l => l === "  10-19 09:30Z · 等主人（放下等待） · 1 小时 50 分 · 卡 k1、k2"));
  assert.ok(lines.some(l => l === "  10-19 11:20Z · 等事件（放下等待） · 3 小时 20 分 · 执行程序重启（到 10-19 13:00Z） · 还在这里"));
  assert.match(timelineText("i", "一件活", timelineOf({ starts: undefined, now: ms(1) })), /没有报告过这件活的状态/);
  const many = Array.from({ length: 80 }, (_, i) => start(i * 10, i % 2 ? "ci" : "running"));
  const long = timelineText("i", "x", timelineOf({ starts: many, now: ms(800) })).split("\n");
  assert.equal(long.filter(l => /^ {2}\d\d-\d\d /.test(l)).length, 60, "the newest 60 segments are listed");
  assert.ok(long.some(l => l === "  … 前面还有 20 段没列出"), long.slice(0, 5).join("\n"));
  const done = timelineText("i", "x", timelineOf({ starts: [start(0, "running")], ended: { kind: "cancelled", at: ms(30) }, now: ms(900) }));
  assert.match(done.split("\n")[0]!, /取消于 10-19 08:30Z/);
  const all = longestWaitsText(longestWaits([{ id: "a", timeline: timelineOf({ starts: [start(0, "ci")], now: ms(90) }) }], 5), () => "一件活", 3, ms(90));
  assert.equal(all.split("\n")[1], "  a · 一件活 · 等 CI · 1 小时 30 分 · 10-19 08:00Z 起，还在等");
});

// --- the tool ----------------------------------------------------------------------------------------------------------

test("the tool answers for one item with its line and for none with the longest waits of the work the runner has reported on", async t => {
  const { store, op, setClock } = await clocked(t);
  const at = "2026-10-19T12:00:00Z";
  const server = createMcpServer({ store, ops: op, now: () => at });
  const client = new Client({ name: "t", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (args: Record<string, unknown>) => { const r = await client.callTool({ name: "timeline", arguments: args }); return { error: r.isError === true, text: (r.content as Array<{ text: string }>)[0]!.text }; };
  const report = (id: string, state: RunnerState, when: string, extra: object = {}) => { setClock(when); return op.reportState({ ...asArchitect, id, state, ...extra } as Parameters<typeof op.reportState>[0]); };
  await report("a", "running", "2026-10-19T09:00:00Z");
  await report("a", "ci", "2026-10-19T09:30:00Z");
  await report("a", "ask", "2026-10-19T10:00:00Z", { to: "architect" });
  await report("b", "running", "2026-10-19T11:00:00Z");
  const one = await call({ id: "a" });
  assert.equal(one.error, false);
  assert.match(one.text, /^a · 中文检查 · 共 3 小时（10-19 09:00Z 起，还没完）\n合计：干活 30 分钟 · 等 CI 30 分钟 · 等架构师 2 小时\n/);
  assert.match(one.text, /  10-19 10:00Z · 等架构师 · 2 小时 · 还在这里$/);
  const all = await call({});
  assert.equal(all.error, false);
  assert.match(all.text, /^在跑的活里最长的 2 个等待段（看了 2 件；10-19 12:00Z 的数）\n  a · 中文检查 · 等架构师 · 2 小时 · 10-19 10:00Z 起，还在等\n  a · 中文检查 · 等 CI · 30 分钟 · 10-19 09:30Z 起，到 10-19 10:00Z$/);
  assert.match((await call({ limit: 1 })).text, /^在跑的活里最长的 1 个等待段/);
  const bad = await call({ id: "nothing" });
  assert.equal(bad.error, true);
  assert.match(bad.text, /choose an existing item/);
  assert.equal((await call({ limit: 0 })).error, true, "a limit under 1 is refused");
});
