import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { request } from "node:http";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { agentSocket, board, author, later, server, wakeSocket, asArchitect } from "./helpers.ts";
import { Item } from "../src/model.ts";
import { Wake, WAKE_KINDS, CONTROL_FRAMES, agentFileName } from "../src/wake.ts";
import { ARCHITECT_SESSION } from "../src/model.ts";
import type { WakeFrame } from "../src/wake.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createHttpServer } from "../src/http.ts";
import { architectTimedWake, timedWake } from "../src/timed-wake.ts";
import { ownerOps } from "../src/owner-ops.ts";

const T0 = Date.parse("2026-10-16T00:00:00Z"), HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const noteFields = (note: string, project = "Whitefoot") => ({ note, target: "it:a", kind: "comment", title: "中文检查", project });
/** An event the PM's stream carries (stalled work), for tests of what a numbered stream does whatever it carries. */
const stallFields = (text: string) => ({ item: "a", project: "Whitefoot", title: "中文检查", text });
async function scratch(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-wake-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const lines = async (file: string) => (await readFile(file, "utf8")).split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
/** Poll for what a background task produces; the timers under test are mocked, setTimeout is not. */
async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  let value = await read();
  for (let i = 0; i < 400 && !done(value); i++) { await new Promise(resolve => setTimeout(resolve, 10)); value = await read(); }
  assert.ok(done(value), `timed out waiting for ${what}`);
  return value;
}

test("push numbers events from 1, keeps them, and refuses a kind or a field set the table does not list", () => {
  const wake = new Wake({ now: () => T0 }), got: WakeFrame[] = [];
  wake.onPush(frame => got.push(frame));
  const first = wake.push("stalled", stallFields("n1")), second = wake.push("stalled", stallFields("n2"));
  assert.deepEqual([first.n, second.n], [1, 2]);
  assert.deepEqual(first, { n: 1, at: iso(T0), event: "stalled", ...stallFields("n1") });
  assert.deepEqual(got, [first, second]);
  assert.throws(() => wake.push("stalled", { ...stallFields("n3"), extra: 1 }), /fields/);
  const { title: _title, ...missing } = stallFields("n3");
  assert.throws(() => wake.push("stalled", missing), /fields/);
  assert.throws(() => wake.push("request" as never, {}), /Unknown wake kind/);
  assert.equal(wake.latest(), 2, "a refused push takes no number");
});

test("since returns what follows a number, and flags a gap when the log no longer holds the number after it, or the number is ahead", () => {
  const wake = new Wake({ now: () => T0, retain: 3 });
  for (let i = 1; i <= 5; i++) wake.push("stalled", stallFields("n" + i));
  assert.equal(wake.oldest(), 3, "the oldest two went past the limit of 3");
  const numbers = (after: number) => { const r = wake.since(after); return { n: r.frames.map(f => f.n), gap: r.gap }; };
  assert.deepEqual(numbers(5), { n: [], gap: false });
  assert.deepEqual(numbers(4), { n: [5], gap: false });
  assert.deepEqual(numbers(2), { n: [3, 4, 5], gap: false }, "number 2 is the one just before the oldest kept: nothing is missing");
  assert.deepEqual(numbers(1), { n: [3, 4, 5], gap: true }, "event 2 was dropped");
  assert.deepEqual(numbers(0), { n: [3, 4, 5], gap: true });
  assert.deepEqual(numbers(9), { n: [], gap: true }, "ahead of the stream: the log was reset");
});

test("past the count and byte limits the oldest events go, the file shrinks with them, and numbering goes on after a restart", async t => {
  const file = join(await scratch(t), "wake.jsonl"), first = new Wake({ file, now: () => T0, retain: 3 });
  for (let i = 1; i <= 5; i++) first.push("stalled", stallFields("n" + i));
  assert.deepEqual((await lines(file)).filter(l => l.event).map(l => l.n), [3, 4, 5]);
  const second = new Wake({ file, now: () => T0, retain: 3 });
  assert.equal(second.latest(), 5); assert.equal(second.oldest(), 3);
  assert.equal(second.push("stalled", stallFields("n6")).n, 6);
  assert.deepEqual(second.since(0).frames.map(f => f.n), [4, 5, 6]);
  // The byte limit alone also drops the oldest, but always keeps the newest.
  const small = new Wake({ now: () => T0, retainBytes: 300 });
  for (let i = 1; i <= 6; i++) small.push("stalled", stallFields("n" + i));
  assert.ok(small.since(0).frames.length < 6 && small.since(0).frames.at(-1)!.n === 6);
  // The limit counts bytes, not characters: Chinese text is three bytes a character, and the doc's 2 MiB is bytes.
  const chinese = { ...stallFields("n"), title: "中".repeat(100) }, wide = new Wake({ now: () => T0 }), one = wide.push("stalled", chinese);
  const bytes = Buffer.byteLength(JSON.stringify(one)), characters = JSON.stringify(one).length;
  assert.ok(bytes > 1.5 * characters);
  const counted = new Wake({ now: () => T0, retainBytes: Math.floor(2.5 * bytes) });
  for (let i = 0; i < 5; i++) counted.push("stalled", chinese);
  assert.deepEqual(counted.since(0).frames.map(f => f.n), [4, 5], "two events fit in 2.5 events' bytes, though four would by characters");
  // An event that alone is over the limit is kept.
  const tiny = new Wake({ now: () => T0, retainBytes: 1 });
  tiny.push("stalled", stallFields("n1")); tiny.push("stalled", stallFields("n2"));
  assert.deepEqual(tiny.since(0).frames.map(f => f.n), [2]);
});

test("a receipt answers everything pushed before it, and writes nothing when it changes nothing", async t => {
  const file = join(await scratch(t), "wake.jsonl"), wake = new Wake({ file, now: () => T0 });
  wake.receipt();
  assert.equal(wake.receiptedUpTo(), 0); assert.equal((await lines(file).catch(() => [])).length, 0, "nothing to answer, nothing written");
  wake.push("stalled", stallFields("n1")); wake.push("stalled", stallFields("n2"));
  wake.receipt();
  assert.equal(wake.receiptedUpTo(), 2);
  const size = (await lines(file)).length;
  wake.receipt(); wake.receipt();
  assert.equal((await lines(file)).length, size, "repeated calls with nothing new write nothing");
  wake.push("stalled", stallFields("n3"));
  assert.equal(wake.receiptedUpTo(), 2, "an event pushed after the call is not answered by it");
  assert.equal(new Wake({ file, now: () => T0 }).receiptedUpTo(), 2, "a restart keeps the receipt");
});

test("with no receipt for the limit the owner is told once, a receipt starts the count again, and a restart keeps all of it", async t => {
  const file = join(await scratch(t), "wake.jsonl"), told: Array<[string, string]> = [];
  let clock = T0;
  const open = () => { const wake = new Wake({ file, now: () => clock }); wake.onTell(notice => told.push([notice.title, notice.message])); return wake; };
  const a = open();
  a.push("stalled", stallFields("n1")); a.push("stalled", stallFields("n2"));
  a.receipt();
  a.push("stalled", stallFields("n3"));
  clock = T0 + HOUR - 1; a.checkReceipts();
  assert.deepEqual(told, [], "the oldest event without a receipt is not yet an hour old");
  clock = T0 + HOUR; a.checkReceipts();
  assert.deepEqual(told, [["PM 1 小时没响应", "最早没回执的是 #3：无人推进：中文检查"]]);
  clock += HOUR; a.checkReceipts(); a.checkReceipts();
  assert.equal(told.length, 1, "one alert per silence, not one per tick");
  const b = open();
  b.checkReceipts();
  assert.equal(told.length, 1, "the restart remembers it already told the owner");
  b.receipt();
  b.push("stalled", stallFields("n4"));
  clock += HOUR - 1; b.checkReceipts();
  assert.equal(told.length, 1);
  clock += 1; b.checkReceipts();
  assert.equal(told.length, 2, "after a receipt the count started again, from the new event");
  assert.match(told[1]![1], /#4：/);
  // Events the architect has answered never alert, however old.
  const c = open(); c.receipt(); clock += 10 * HOUR; c.checkReceipts();
  assert.equal(told.length, 2);
  assert.equal(open().latest(), 4);
  assert.deepEqual(open().since(0).frames.map(f => f.n), [1, 2, 3, 4]);
});

test("the limit can be set shorter, and the alert names it in minutes", () => {
  const told: string[] = [];
  let clock = T0;
  const wake = new Wake({ now: () => clock, receiptLimitMs: 10 * 60_000 });
  wake.onTell(notice => told.push(notice.title));
  wake.push("timed", { since: iso(T0), changed: [], working: 0, architect: 0, pm: 0, review: [], finished: [] });
  clock += 10 * 60_000; wake.checkReceipts();
  assert.deepEqual(told, ["PM 10 分钟没响应"]);
});

test("a log file that cannot be written costs the numbers' continuity, never the push", async t => {
  const dir = await scratch(t), errors: unknown[][] = [], original = console.error;
  await writeFile(join(dir, "plain-file"), "x");
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const wake = new Wake({ file: join(dir, "plain-file", "wake.jsonl"), now: () => T0 });
    assert.equal(wake.push("stalled", stallFields("n1")).n, 1);
    wake.receipt();
    assert.equal(wake.receiptedUpTo(), 1);
  } finally { console.error = original; }
  assert.ok(errors.length >= 1 && errors.every(e => e[0] === "wake log not written"));
});

test("a sent note is pushed to the architect's stream with a number whatever project its item is in, a draft is not, a second send pushes nothing, and the PM's stream gets none of it", async t => {
  const { url, api, store } = await server(t);
  const star = await agentSocket(t, url, ARCHITECT_SESSION), pm = await wakeSocket(t, url);
  assert.deepEqual(star.frames, [{ event: "connected", latest: 0 }]);
  const one = await api("/api/notes", { target: "it:a", kind: "comment", text: "one" });
  const two = await api("/api/notes", { target: "q:choice", kind: "explain", text: "two" });
  const three = await api("/api/notes", { target: "it:other", kind: "comment", text: "three" });
  await star.sync();
  assert.deepEqual(star.events(), [], "drafts are not pushed");
  await api("/api/send", {}); await star.sync();
  const seen = star.events().map(({ at, line, ...frame }) => (assert.match(String(at), /^\d{4}-\d\d-\d\dT/), assert.match(String(line), /^#\d 主人的留言 · /), frame));
  assert.deepEqual(seen, [
    { n: 1, event: "note", ...noteFields(one.data.id) },
    { n: 2, event: "note", note: two.data.id, target: "q:choice", kind: "explain", title: "中文方案？", project: "Whitefoot" },
    { n: 3, event: "note", note: three.data.id, target: "it:other", kind: "comment", title: "其他项目", project: "Firn" },
  ]);
  await api("/api/send", {}); await star.sync();
  assert.equal(star.events().length, 3);
  // A later write to a note that is still sent (here a text edit) is not a note becoming sent.
  const note = store.snapshot().notes[one.data.id]!;
  await store.commit({ author: "owner", message: "edit a sent note", puts: [{ kind: "note", id: one.data.id, expectRev: note.rev, doc: { ...note, text: "edited" } }] });
  await star.sync();
  assert.equal(star.events().length, 3);
  await pm.sync();
  assert.deepEqual(pm.events(), [], "none of the owner's notes goes to the PM's stream: explain requests and a choice on a card included");
});

test("only the kinds in the table are pushed: not a blocking card, an ask or a format check", async t => {
  const { url, store, op } = await server(t);
  const star = await wakeSocket(t, url);
  await op.writeCard({ author, key: "hard", item: "a", question: "合并吗？", confidence: { reason: "判断" }, options: [{ text: "是", detail: "合并" }], blocks: "合并停着" });
  const other = store.snapshot().items.other!;
  await store.commit({ author, message: "set ask", puts: [{ kind: "item", id: "other", expectRev: other.rev, doc: { ...other, ask: { text: "请合并" } } }] });
  await store.commit({ author, message: "Block item", puts: [{ kind: "item", id: "c", expectRev: null, doc: { title: "卡住的条目", group: "Whitefoot", plan: [{ id: "missing", item: "missing", own: false, after: [] }, { id: "accept", text: "某项检查通过", state: "todo", accept: true }], updated: later, head: "**完成条件**：某项检查通过" } }] });
  await star.sync();
  assert.deepEqual(star.events(), []);
});

test("a client of the PM's stream that comes back with its last number gets what followed, a gap frame when the log no longer holds it, and a bad number is refused", async t => {
  const wake = new Wake({ retain: 2 });
  const { url } = await server(t, { wake });
  for (const text of ["one", "two", "three"]) wake.push("stalled", stallFields(text));
  assert.equal(wake.latest(), 3);
  const live = await wakeSocket(t, url), resumed = await wakeSocket(t, url, 2), behind = await wakeSocket(t, url, 0), ahead = await wakeSocket(t, url, 99), current = await wakeSocket(t, url, 3);
  assert.deepEqual(live.frames, [{ event: "connected", latest: 3 }], "without a number the client takes events from now on");
  assert.deepEqual(resumed.frames.map(f => f.n ?? f.event), ["connected", 3]);
  assert.deepEqual(behind.frames.map(f => f.n ?? f.event), ["connected", "gap", 2, 3], "the gap frame comes before the events that are left");
  assert.deepEqual(behind.frames[1], { event: "gap", oldest: 2, latest: 3 });
  assert.deepEqual(ahead.frames, [{ event: "connected", latest: 3 }, { event: "gap", oldest: 2, latest: 3 }]);
  assert.deepEqual(current.frames, [{ event: "connected", latest: 3 }]);
  // A live event reaches every connected client, once, after the replay.
  wake.push("stalled", stallFields("four"));
  for (const client of [live, resumed, behind, ahead, current]) await client.sync();
  assert.deepEqual([live, resumed, behind, ahead, current].map(c => c.events().map(f => f.n)), [[4], [3, 4], [2, 3, 4], [4], [4]]);
  // The client rule the doc gives: drop an event numbered at or below the one remembered; a gap frame sets it to oldest − 1.
  const handled = (frames: Array<Record<string, unknown>>, after: number) => {
    let seen = after; const taken: number[] = [];
    for (const frame of frames) {
      if (frame.event === "gap") seen = (frame.oldest as number) - 1;
      else if (typeof frame.n === "number" && frame.n > seen) { taken.push(frame.n); seen = frame.n; }
    }
    return taken;
  };
  assert.deepEqual([handled(resumed.frames, 2), handled(behind.frames, 0), handled(ahead.frames, 99), handled(current.frames, 3)], [[3, 4], [2, 3, 4], [4], [4]], "no event lost to a repeat check, whichever way the number was wrong");
  const bad = new WebSocket(url.replace("http:", "ws:") + "/wake?after=x");
  bad.on("error", () => {}); t.after(() => bad.terminate());
  const [, response] = await once(bad, "unexpected-response");
  assert.equal(response.statusCode, 400); response.resume();
  const other = new WebSocket(url.replace("http:", "ws:") + "/other");
  other.on("error", () => {}); t.after(() => other.terminate());
  const [, notFound] = await once(other, "unexpected-response");
  assert.equal(notFound.statusCode, 404); notFound.resume();
});

test("active time alone (one hour) pushes one stalled event on the timer, and a restart announces nothing", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const start = Date.parse("2026-10-11T03:00:00Z");
  let clock = start + HOUR - 1;
  const { url, store, op } = await server(t, { now: () => clock, checkIntervalMs: 1000, prepare: ({ store }) => {
    const s = structuredClone(store.snapshot());
    s.items.w = Item.parse({ title: "没人推进的叶子", group: "Whitefoot", plan: [{ id: "work", text: "当前工作", state: "doing", since: new Date(start).toISOString() }, { id: "accept", text: "某项检查通过", state: "todo", accept: true }], updated: new Date(start).toISOString(), log: [], rev: 1, head: "**完成条件**：某项检查通过" });
    s.activity = { writes: Array.from({ length: 2 }, (_, i) => new Date(start + i * 30 * 60 * 1000).toISOString()), items: {} };
    store.snapshot = () => structuredClone(s);
  } });
  const star = await wakeSocket(t, url);
  t.mock.timers.tick(1000); await star.sync();
  assert.deepEqual(star.events().filter(f => f.item === "w"), [], "1 hour of active time not yet reached");
  clock++;
  t.mock.timers.tick(1000); await star.sync();
  const stalled = star.events().filter(f => f.item === "w");
  assert.equal(stalled.length, 1);
  assert.deepEqual(stalled[0], { n: 1, at: iso(clock), event: "stalled", item: "w", project: "Whitefoot", title: "没人推进的叶子", text: "进行中但 1 小时（活跃时间）没有动静" });
  t.mock.timers.tick(5000); await star.sync();
  assert.equal(star.events().filter(f => f.item === "w").length, 1, "later timer ticks do not repeat it");
  // A restarted server over the same state seeds from it silently, including the standing stalled check.
  const again = await restart(t, store, op, { now: () => clock, checkIntervalMs: 1000 });
  // From number 0: whatever the restarted server pushed while starting would be replayed here.
  const restarted = await wakeSocket(t, again.url, 0);
  t.mock.timers.tick(5000); await restarted.sync();
  assert.deepEqual(restarted.events(), [], "standing stalls are not announced after a restart");
});

async function restart(t: Parameters<typeof board>[0], store: Awaited<ReturnType<typeof board>>["store"], op: Awaited<ReturnType<typeof board>>["op"], extra: { now?: () => number; checkIntervalMs?: number; wake?: Wake; timedWakeMs?: number }) {
  const http = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: "web", createMcp: () => createMcpServer({ store, ops: op, wake: extra.wake }), ...extra });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  const address = http.address(); assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}` };
}

test("the timed wake lists what changed since the last one without the architect's and the PM's own writes, and counts the items being worked on and the open ones of the Architect and PM projects; the last one's time survives a restart", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const dir = await scratch(t), file = join(dir, "wake.jsonl"), half = 30 * 60_000;
  let clock = T0;
  const wake = new Wake({ file, now: () => clock });
  const { url, store, op, api } = await server(t, { now: () => clock, checkIntervalMs: 1000, wake, timedWakeMs: half });
  // One item of the Architect project (the fixture board has it), one of the PM project with a step being worked on, and an item with a step being worked on.
  // Both are rated, so neither carries 缺难度 and the flags stay empty.
  const doc = (title: string, group: string, plan: object[]) => ({ title, group, difficulty: 2, plan: [...plan, { id: "accept", text: "某项检查通过", state: "todo", accept: true }], updated: later, head: "**完成条件**：某项检查通过" });
  await store.commit({ author, message: "Seed", puts: [
    { kind: "item", id: "arch", expectRev: null, doc: doc("架构师的条目", "Architect", [{ id: "step", text: "一步", state: "todo" }]) },
    { kind: "item", id: "pmwork", expectRev: null, doc: doc("PM 的条目", "PM", [{ id: "step", text: "当前工作", state: "doing", since: iso(T0) }]) },
    { kind: "item", id: "work", expectRev: null, doc: doc("在做的条目", "Whitefoot", [{ id: "step", text: "当前工作", state: "doing", since: iso(T0) }]) },
    // A live session holds this one, though no step is marked; and the parent is wip only because the item it owns is.
    { kind: "item", id: "held", expectRev: null, doc: { ...doc("会话拿着的条目", "Whitefoot", [{ id: "step", text: "还没标", state: "todo" }]), dispatches: [{ agentId: "h1", agent: "held-eng", role: "工程师", level: 2, model: "Sonnet", started: iso(T0) }] } },
    { kind: "item", id: "parent", expectRev: null, doc: doc("只因下级在做的条目", "Whitefoot", [{ id: "work", item: "work", own: true }]) },
  ] });
  wake.markTimed({ at: iso(T0), head: store.snapshot().head });
  // After the mark: an engineer writes b and other; the architect writes a and b; the owner comments on the card of a.
  await op.appendLog({ author, session: "工程师", id: "b", text: "progress" });
  await op.appendLog({ author: "Firn", session: "工程师", id: "other", text: "progress" });
  await op.appendLog({ author, session: ARCHITECT_SESSION, id: "a", text: "reviewed" });
  await op.appendLog({ author, session: ARCHITECT_SESSION, id: "b", text: "reviewed" });
  await op.appendLog({ author, session: "PM", id: "area", text: "patrolled" });
  await api("/api/notes", { target: "q:choice", kind: "comment", text: "owner says" });
  const star = await wakeSocket(t, url);
  clock = T0 + half - 1; t.mock.timers.tick(1000); await star.sync(); await setImmediate();
  const timedFrames = () => star.events().filter(f => f.event === "timed");
  assert.deepEqual(timedFrames(), [], "not due yet");
  clock = T0 + half; t.mock.timers.tick(1000);
  await until(() => timedFrames().length, n => n === 1, "the timed wake");
  const frame = timedFrames()[0]!;
  assert.deepEqual({ at: frame.at, event: frame.event, since: frame.since }, { at: iso(clock), event: "timed", since: iso(T0) });
  const names = (list: unknown) => (list as Array<{ item: string }>).map(e => e.item).sort();
  assert.deepEqual(names(frame.changed), ["b", "other"], "b is listed for the owner's comment on its card and for the engineer, other for the engineer; the architect's and the PM's own writes are not why (area, written only by the PM, is not listed)");
  const by = Object.fromEntries((frame.changed as Array<{ item: string; by: string[] }>).map(e => [e.item, e.by]));
  assert.deepEqual(by, { b: ["owner", "工程师"], other: ["工程师"] });
  assert.equal(frame.working, 2, "the items someone holds, outside the Architect and PM projects: a step being done, or a live session; not a parent in progress only through its part");
  assert.equal(frame.pm, 1, "the PM project's open items, and not among the working ones though a step is being done");
  assert.ok(Number.isInteger(frame.architect) && (frame.architect as number) >= 1, "the Architect project's open items, counted");
  assert.equal("dispatch" in frame, false, "the timed wake carries no offers: the PM compares the candidates with its own limits");
  for (const column of ["working", "architect", "pm"]) assert.equal(typeof frame[column], "number", `${column} is a count, not the list that repeats from one wake to the next`);
  assert.deepEqual(wake.lastTimed, { at: iso(clock), head: store.snapshot().head });
  assert.deepEqual((await lines(file)).filter(l => l.timed).at(-1), { timed: wake.lastTimed });
  t.mock.timers.tick(5000); await setImmediate();
  assert.equal(timedFrames().length, 1, "the next one is a half hour after this one");
  // A restart keeps the mark: the next wake counts from it, not from the restart.
  await op.appendLog({ author, session: "工程师", id: "b", text: "after the wake" });
  const mark = wake.lastTimed!;
  clock += 10 * 60_000;
  const reopened = new Wake({ file, now: () => clock });
  assert.deepEqual(reopened.lastTimed, mark); assert.equal(reopened.latest(), frame.n);
  const again = await restart(t, store, op, { now: () => clock, checkIntervalMs: 1000, wake: reopened, timedWakeMs: half });
  const resumed = await wakeSocket(t, again.url, frame.n as number);
  t.mock.timers.tick(1000); await setImmediate(); await resumed.sync();
  assert.deepEqual(resumed.events(), [], "ten minutes after the last wake, restart or not, nothing is due");
  clock = Date.parse(mark.at) + half; t.mock.timers.tick(1000);
  await until(() => resumed.events().length, n => n === 1, "the timed wake after the restart");
  const next = resumed.events()[0]!;
  assert.equal(next.n, (frame.n as number) + 1); assert.equal(next.since, mark.at);
  assert.deepEqual(names(next.changed), ["b"], "only what changed after the last wake");
});

test("the architect's timed wake comes every hour with the items changed since the last one, without the architect's own writes but with the PM's, and a count of the items being worked on; the PM's stream gets none of it, and the mark survives a restart", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const dir = await scratch(t), architectFile = join(dir, agentFileName(ARCHITECT_SESSION));
  let clock = T0;
  const wake = new Wake({ dir, now: () => clock });
  const { url, store, op, api } = await server(t, { now: () => clock, checkIntervalMs: 1000, wake, timedWakeMs: 1e12 });
  const doc = (title: string, group: string, plan: object[], extra: object = {}) => ({ title, group, difficulty: 2, plan: [...plan, { id: "accept", text: "某项检查通过", state: "todo", accept: true }], updated: later, head: "**完成条件**：某项检查通过", ...extra });
  await store.commit({ author, message: "Seed", puts: [
    { kind: "item", id: "arch", expectRev: null, doc: doc("架构师的条目", "Architect", [{ id: "step", text: "一步", state: "doing", since: iso(T0) }]) },
    { kind: "item", id: "work", expectRev: null, doc: doc("在做的条目", "Whitefoot", [{ id: "step", text: "当前工作", state: "doing", since: iso(T0) }]) },
    { kind: "item", id: "held", expectRev: null, doc: doc("会话拿着的条目", "Whitefoot", [{ id: "step", text: "还没标", state: "todo" }], { dispatches: [{ agentId: "h1", agent: "held-eng", role: "工程师", level: 2, model: "Sonnet", started: iso(T0) }] }) },
  ] });
  wake.agent(ARCHITECT_SESSION).markTimed({ at: iso(T0), head: store.snapshot().head });
  // After the mark: an engineer writes b and other; the architect writes a and b; the PM writes area; the owner comments on a card.
  await op.appendLog({ author, session: "工程师", id: "b", text: "progress" });
  await op.appendLog({ author: "Firn", session: "工程师", id: "other", text: "progress" });
  await op.appendLog({ author, session: ARCHITECT_SESSION, id: "a", text: "reviewed" });
  await op.appendLog({ author, session: ARCHITECT_SESSION, id: "b", text: "reviewed" });
  await op.appendLog({ author, session: "PM", id: "area", text: "patrolled" });
  await api("/api/notes", { target: "q:choice", kind: "comment", text: "owner says" });
  const star = await agentSocket(t, url, ARCHITECT_SESSION), pm = await wakeSocket(t, url);
  clock = T0 + HOUR - 1; t.mock.timers.tick(1000); await star.sync(); await setImmediate();
  assert.deepEqual(star.events(), [], "not due yet: the architect's wake is an hour by default, not the PM's half hour");
  clock = T0 + HOUR; t.mock.timers.tick(1000);
  await until(() => star.events().length, n => n === 1, "the architect's timed wake");
  const frame = star.events()[0]!;
  assert.deepEqual({ n: frame.n, at: frame.at, event: frame.event, since: frame.since }, { n: 1, at: iso(clock), event: "timed-architect", since: iso(T0) });
  assert.deepEqual(Object.keys(frame).sort(), ["at", "changed", "event", "line", "n", "since", "working"], "changes and a count, none of the PM's lists or counts");
  const by = Object.fromEntries((frame.changed as Array<{ item: string; by: string[] }>).map(e => [e.item, e.by]));
  assert.deepEqual(by, { area: ["PM"], b: ["owner", "工程师"], other: ["工程师"] }, "the PM's write is listed; the architect's own writes are not why a or b is, and a is left out");
  assert.equal(frame.working, 2, "the items someone holds outside the Architect and PM projects: a step being done, or a live session");
  assert.deepEqual(wake.agent(ARCHITECT_SESSION).lastTimed, { at: iso(clock), head: store.snapshot().head });
  assert.deepEqual((await lines(architectFile)).filter(l => l.timed).at(-1), { timed: wake.agent(ARCHITECT_SESSION).lastTimed });
  t.mock.timers.tick(5000); await setImmediate();
  assert.equal(star.events().length, 1, "the next one is an hour after this one");
  await pm.sync();
  assert.deepEqual(pm.events(), [], "the PM's stream carries none of it, and its own timed wake (set far off here) is not the architect's");
  // A restart keeps the mark: the next wake counts from it, not from the restart.
  star.socket.send(JSON.stringify({ ack: 1 })); await star.sync();
  await op.appendLog({ author, session: "工程师", id: "b", text: "after the wake" });
  const mark = wake.agent(ARCHITECT_SESSION).lastTimed!;
  clock += 10 * 60_000;
  const reopened = new Wake({ dir, now: () => clock });
  assert.deepEqual(reopened.agent(ARCHITECT_SESSION).lastTimed, mark); assert.equal(reopened.agent(ARCHITECT_SESSION).latest(), 1);
  const again = await restart(t, store, op, { now: () => clock, checkIntervalMs: 1000, wake: reopened, timedWakeMs: 1e12 });
  const resumed = await agentSocket(t, again.url, ARCHITECT_SESSION);
  t.mock.timers.tick(1000); await setImmediate(); await resumed.sync();
  assert.deepEqual(resumed.events(), [], "ten minutes after the last wake, restart or not, nothing is due");
  clock = Date.parse(mark.at) + HOUR; t.mock.timers.tick(1000);
  await until(() => resumed.events().length, n => n === 1, "the architect's timed wake after the restart");
  const next = resumed.events()[0]!;
  assert.equal(next.n, 2); assert.equal(next.since, mark.at);
  assert.deepEqual((next.changed as Array<{ item: string }>).map(e => e.item), ["b"], "only what changed after the last wake");
});

test("the architect's timed wake lists at most 20 items and counts the rest, and leaves out an item only the architect wrote", async t => {
  const { store } = await board(t);
  const mark = { at: iso(T0), head: store.snapshot().head };
  const doc = (title: string) => ({ title, group: "Whitefoot", difficulty: 2, plan: [{ id: "accept", text: "某项检查通过", state: "todo", accept: true }], updated: later, head: "**完成条件**：某项检查通过" });
  const put = (id: string) => ({ kind: "item" as const, id, expectRev: null, doc: doc(id) });
  await store.commit({ author, session: "工程师", message: "Seed", puts: Array.from({ length: 25 }, (_, i) => put(`bulk${i}`)) });
  await store.commit({ author, session: ARCHITECT_SESSION, message: "Mine", puts: [put("mine")] });
  const s = store.snapshot(), fields = await architectTimedWake(store, s, store.derived.rules(s, T0), mark, iso(T0));
  assert.equal(fields.changed.length, 21, "the list stops at 20 entries and a count");
  assert.deepEqual(fields.changed.at(-1), { more: 5 }, "25 items were written by the engineer, 20 are listed, the rest are counted; the architect's own is not among them");
});

test("an hour with a push to the architect undelivered tells the owner once, a delivery starts the count again, the alert and the last timed wake survive a restart, and no other agent's stream is watched so", async t => {
  const dir = await scratch(t), told: Array<[string, string]> = [];
  let clock = T0;
  // Made before the first assertion on `told`: a closure made after `assert.deepEqual(told, ...)` sees `told` narrowed to that value's type.
  const record = (notice: { title: string; message: string }) => { told.push([notice.title, notice.message]); };
  const open = () => { const wake = new Wake({ dir, now: () => clock }); wake.onTell(record); return wake; };
  const a = open(), stream = a.agent(ARCHITECT_SESSION);
  a.push("note", noteFields("n1")); a.push("note", noteFields("n2"));
  stream.deliver(1);
  clock = T0 + HOUR - 1; a.checkReceipts();
  assert.deepEqual(told, [], "the oldest push not delivered, #2, is not yet an hour old");
  clock = T0 + HOUR; a.checkReceipts();
  assert.deepEqual(told, [["架构师 1 小时没响应", "最早没送到的是 #2：主人的留言：中文检查"]], "a delivered push is not the oldest");
  clock += HOUR; a.checkReceipts(); a.checkReceipts();
  assert.equal(told.length, 1, "one alert per silence, not one per tick");
  stream.markTimed({ at: iso(clock), head: "abc" });
  const b = open();
  b.checkReceipts();
  assert.equal(told.length, 1, "the restart remembers it already told the owner");
  assert.deepEqual(b.agent(ARCHITECT_SESSION).lastTimed, { at: iso(clock), head: "abc" }, "and the time of the last timed wake");
  b.agent(ARCHITECT_SESSION).deliver(2);
  b.push("note", noteFields("n3"));
  clock += HOUR - 1; b.checkReceipts();
  assert.equal(told.length, 1);
  clock += 1; b.checkReceipts();
  assert.equal(told.length, 2, "after a delivery the count started again, from the new push");
  assert.match(told[1]![1], /最早没送到的是 #3：/);
  // Only the architect's stream is watched for it; a session holding an item is watched by the liveness check.
  const other = new Wake({ now: () => clock });
  other.onTell(record);
  other.agent("eng").push("item-done", { item: "a", project: "Whitefoot", title: "t", parent: "p" });
  clock += 10 * HOUR; other.checkReceipts();
  assert.equal(told.length, 2);
});

async function mcpClient(t: Parameters<typeof board>[0], wake: Wake) {
  const fixture = await board(t), mcp = createMcpServer({ store: fixture.store, ops: fixture.op, wake });
  const client = new Client({ name: "Wake", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await mcp.close(); });
  return { ...fixture, client };
}

test("a call carrying the architect's or the PM's session, read or write, is the receipt for what was pushed to the PM's stream before it; another session's, or none, is not", async t => {
  const wake = new Wake({ now: () => T0 });
  const { client } = await mcpClient(t, wake);
  wake.push("stalled", stallFields("n1")); wake.push("stalled", stallFields("n2"));
  await client.callTool({ name: "projects", arguments: { session: "别的会话" } });
  await client.callTool({ name: "projects", arguments: {} });
  assert.equal(wake.receiptedUpTo(), 0);
  await client.callTool({ name: "projects", arguments: { session: ARCHITECT_SESSION } });
  assert.equal(wake.receiptedUpTo(), 2, "a read answers both; the architect keeps answering the PM's stream while no PM runs");
  wake.push("stalled", stallFields("n3"));
  await client.callTool({ name: "append_log", arguments: { author: "Architect", session: ARCHITECT_SESSION, id: "a", text: "x" } });
  assert.equal(wake.receiptedUpTo(), 3, "a write answers too, even when the board refuses it");
  wake.push("stalled", stallFields("n4"));
  const refused = await client.callTool({ name: "projects", arguments: { session: ARCHITECT_SESSION, unknown: 1 } });
  assert.equal(refused.isError, true);
  assert.equal(wake.receiptedUpTo(), 3, "a call the schema refuses is not a receipt");
  await client.callTool({ name: "projects", arguments: { session: `  ${ARCHITECT_SESSION}  ` } });
  assert.equal(wake.receiptedUpTo(), 4, "a session name padded with spaces counts, as it does for the permission rule");
  wake.push("stalled", stallFields("n5"));
  await client.callTool({ name: "projects", arguments: { session: "PMx" } });
  await client.callTool({ name: "projects", arguments: { session: "pm" } });
  assert.equal(wake.receiptedUpTo(), 4, "a near miss of the PM's session is not a receipt");
  await client.callTool({ name: "projects", arguments: { session: "PM" } });
  assert.equal(wake.receiptedUpTo(), 5, "a read from the session PM answers");
  wake.push("stalled", stallFields("n6"));
  await client.callTool({ name: "append_log", arguments: { author: "PM", session: "PM", id: "a", text: "x" } });
  assert.equal(wake.receiptedUpTo(), 6, "a write from the session PM answers too");
  wake.push("stalled", stallFields("n7"));
  await client.callTool({ name: "projects", arguments: { session: "  PM  " } });
  assert.equal(wake.receiptedUpTo(), 7, "a padded PM session counts");
});

test("a call over a connection with a PM or architect credential is the receipt, by role, whatever session the call names; another role's is not", async t => {
  const fixture = await board(t);
  const who = (role: "PM" | "架构师" | "观察者" | "工程师", session: string) => ({ ok: true as const, who: { author: role === "PM" ? "PM" : "Architect", session, access: { role, project: role === "PM" ? "PM" : "Architect", roots: [] } } });
  const receiptOf = async (credential: ReturnType<typeof who>, session?: string) => {
    const wake = new Wake({ now: () => T0 });
    wake.push("stalled", stallFields("n1"));
    const mcp = createMcpServer({ store: fixture.store, ops: fixture.op, wake, credential });
    const client = new Client({ name: "Credential receipt", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
    await mcp.connect(st); await client.connect(ct);
    await client.callTool({ name: "projects", arguments: session === undefined ? {} : { session } });
    await client.close(); await mcp.close();
    return wake.receiptedUpTo();
  };
  assert.equal(await receiptOf(who("PM", "PM")), 1, "the PM's credential answers");
  assert.equal(await receiptOf(who("PM", "pm-2"), "别的名字"), 1, "by its role, not by the name the call gives");
  assert.equal(await receiptOf(who("架构师", "架构师")), 1, "the architect's credential still answers");
  assert.equal(await receiptOf(who("观察者", "观察者")), 0, "the observer's does not");
  assert.equal(await receiptOf(who("工程师", "PM")), 0, "a credential of another role does not, even under the session name PM");
});

test("every tool takes an optional session, and post_notice is gone", async t => {
  const { client } = await mcpClient(t, new Wake());
  const tools = (await client.listTools()).tools;
  assert.ok(tools.length > 20);
  for (const tool of tools) {
    assert.ok(tool.inputSchema.properties && "session" in tool.inputSchema.properties, `${tool.name} takes a session`);
    assert.ok(!(tool.inputSchema.required ?? []).includes("session"), `${tool.name}: the session is optional`);
  }
  assert.ok(!tools.some(tool => tool.name === "post_notice"));
});

test("with no receipt for the limit the server's timer tells the owner once for the PM's stream, and with no delivery for the architect's; a call from the architect starts both counts again", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = T0;
  const told: Array<[string, string]> = [];
  const wake = new Wake({ now: () => clock, receiptLimitMs: 10 * 60_000 });
  wake.onTell(notice => told.push([notice.title, notice.message]));
  const { url, api } = await server(t, { now: () => clock, checkIntervalMs: 1000, wake, timedWakeMs: 1e12, architectTimedWakeMs: 1e12 });
  await api("/api/notes", { target: "it:a", kind: "comment", text: "one" }); await api("/api/send", {});
  wake.push("stalled", stallFields("one"));
  assert.deepEqual([wake.agent(ARCHITECT_SESSION).latest(), wake.latest()], [1, 1], "the note is the architect's, the stalled item the PM's");
  clock = T0 + 10 * 60_000 - 1; t.mock.timers.tick(1000);
  assert.deepEqual(told, []);
  clock++; t.mock.timers.tick(1000);
  assert.deepEqual(told, [["PM 10 分钟没响应", "最早没回执的是 #1：无人推进：中文检查"], ["架构师 10 分钟没响应", "最早没送到的是 #1：主人的留言：中文检查"]]);
  t.mock.timers.tick(5000);
  assert.equal(told.length, 2, "not repeated while the silence lasts");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "Receipts", version: "1" }), transport = new StreamableHTTPClientTransport(new URL(url + "/mcp"));
  await client.connect(transport); t.after(() => client.close());
  // The PM's call through the real MCP route answers its own stream and delivers nothing to the architect.
  await client.callTool({ name: "projects", arguments: { session: "PM" } });
  assert.deepEqual([wake.receiptedUpTo(), wake.agent(ARCHITECT_SESSION).deliveredUpTo()], [1, 0]);
  await api("/api/notes", { target: "it:a", kind: "comment", text: "two" }); await api("/api/send", {});
  clock += 10 * 60_000; t.mock.timers.tick(1000);
  assert.equal(told.length, 2, "the PM's call did not start the architect's count again: its silence is already told");
  // The architect's call answers the PM's stream and is given its own pushes, which delivers them.
  wake.push("stalled", stallFields("two"));
  const result = await client.callTool({ name: "projects", arguments: { session: ARCHITECT_SESSION } });
  assert.match((result.content as Array<{ text: string }>).map(c => c.text).join("\n"), /【看板推送】\n#1 主人的留言 .*\n#2 主人的留言 /);
  assert.deepEqual([wake.receiptedUpTo(), wake.agent(ARCHITECT_SESSION).deliveredUpTo()], [2, 2]);
  await api("/api/notes", { target: "it:a", kind: "comment", text: "three" }); await api("/api/send", {});
  clock += 10 * 60_000; t.mock.timers.tick(1000);
  assert.equal(told.length, 3); assert.equal(told[2]![0], "架构师 10 分钟没响应"); assert.match(told[2]![1], /#3：/);
});

test("a card that stops work tells the owner once; a card without blocks, a revision that keeps blocks and a ruled card do not", async t => {
  const told: Array<[string, string]> = [];
  const wake = new Wake();
  wake.onTell(notice => told.push([notice.title, notice.message]));
  const targets: unknown[] = [];
  wake.onTell(notice => targets.push(notice.target));
  const { op } = await server(t, { wake });
  const card = { author, key: "gate", item: "a", question: "合并吗？", confidence: { reason: "判断" }, options: [{ text: "是", detail: "合并" }] };
  await op.writeCard(card);
  assert.deepEqual(told, [], "a card without blocks tells no one");
  await op.writeCard({ ...card, key: "hard", blocks: "#398 合并停着" });
  assert.deepEqual(told, [["挡事的卡 · Whitefoot", "合并吗？（挡住：#398 合并停着）"]]);
  assert.deepEqual(targets, [{ kind: "card", key: "hard" }], "the notice opens the card that stopped work");
  await op.writeCard({ ...card, key: "hard", rev: 1, blocks: "#398 合并停着", question: "改写" });
  assert.equal(told.length, 1, "revising without changing blocks says nothing new");
  await op.writeCard({ ...card, key: "gate", rev: 1, blocks: "现在停了" });
  assert.equal(told.length, 2, "a card that gains blocks tells");
  assert.equal(told[1]![1], "合并吗？（挡住：现在停了）");
  await op.writeCard({ ...card, key: "gate", rev: 2, blocks: "停的是另一件事" });
  assert.equal(told.length, 3, "changed blocks tell again");
  await op.ruleCard({ author, key: "hard", choice: "A" });
  assert.equal(told.length, 3, "ruling a card says nothing");
});

// docs/design.md (The wake streams) gives the frames; this keeps it and src/wake.ts's table from drifting apart.
test("the design doc's frame table lists exactly the kinds in the table and the control frames, with their fields", async () => {
  const doc = await readFile(join(import.meta.dirname, "../docs/design.md"), "utf8");
  const start = doc.indexOf("### The wake stream"), end = doc.indexOf("**Why not MCP push.**");
  assert.ok(start >= 0 && end > start, "docs/design.md must hold the headings '### The wake stream' and then '**Why not MCP push.**'");
  const forms = new Map<string, string[]>();
  for (const [, body] of doc.slice(start, end).matchAll(/`\{([^`]*)\}`/g)) {
    const fields = body!.split(", "), event = fields.map(f => /^event:"([\w-]+)"$/.exec(f)?.[1]).find(Boolean);
    if (event) forms.set(event, fields.filter(f => !f.startsWith("event:")).sort());
  }
  const expected = new Map<string, string[]>([
    ...Object.entries(WAKE_KINDS).map(([kind, spec]) => [kind, ["at", "n", ...spec.fields].sort()] as [string, string[]]),
    ...Object.entries(CONTROL_FRAMES).map(([frame, fields]) => [frame, [...fields].sort()] as [string, string[]]),
  ]);
  assert.deepEqual([...forms.keys()].sort(), [...expected.keys()].sort());
  for (const [event, fields] of expected) assert.deepEqual(forms.get(event), fields, `${event}: the doc's fields differ from the table`);
});

// POST /api/wake is how the deploy job, which runs beside the daemon, asks for a push (docs/design.md, The wake streams).
const deployed = { event: "deployed", version: "a".repeat(40), previous: "b".repeat(40), changes: ["abc1234 Merge pull request #1 from Ming-Research/thing", { more: 2 }], restarted: true, repo: "Ming-Research/Whitefoot" };
const deployFailed = { event: "deployFailed", version: "a".repeat(40), running: null, reason: "the daemon was not healthy", changes: ["abc1234 Merge pull request #1 from Ming-Research/thing"], repo: "Ming-Research/Whitefoot" };

test("only the deploy kinds are marked as ones another process may push, each with the fields of its request", () => {
  const external = Object.entries(WAKE_KINDS).filter(([, spec]) => "external" in spec).map(([kind]) => kind);
  assert.deepEqual(external, ["deployed", "deployFailed"]);
  assert.deepEqual(Wake.externalFields("deployed"), ["version", "previous", "changes", "restarted", "repo"]);
  assert.deepEqual(Wake.externalFields("deployFailed"), ["version", "running", "reason", "changes", "repo"]);
  for (const kind of Object.keys(WAKE_KINDS)) assert.equal(Wake.externalFields(kind) !== undefined, external.includes(kind), kind);
  for (const other of ["bogus", "toString", "__proto__", "constructor", "", 5, null, undefined, {}]) assert.equal(Wake.externalFields(other), undefined, String(other));
});

test("POST /api/wake makes the deploy pushes: to the session holding the item that delivers a pull request the commits name, else for a failure to the PM, and says how many", async t => {
  const wake = new Wake({ now: () => T0 });
  const { url, api, store, op } = await server(t, { wake });
  const pm = await wakeSocket(t, url);
  // Pull request 1 of Whitefoot is delivered by item `a`, which the board's fixture has with its own 改动 section.
  const a = store.snapshot().items.a!;
  await store.commit({ author, message: "name the pull request", puts: [{ kind: "item", id: "a", expectRev: a.rev, doc: { ...a, head: `${a.head}\n\n**改动**\n\nMing-Research/Whitefoot#1` } }] });
  // Nobody holds it yet: a deploy that happened is told to nobody, one that failed to the PM.
  assert.deepEqual(await api("/api/wake", deployed), { status: 200, data: { pushed: 0 } });
  assert.deepEqual(await api("/api/wake", deployFailed), { status: 200, data: { pushed: 1 } });
  await pm.sync();
  assert.deepEqual(pm.events().map(({ n, at, ...f }) => f), [{ event: "deployFailed", version: "a".repeat(40), running: null, reason: "the daemon was not healthy", item: "a", project: "Whitefoot", title: "中文检查", pr: 1 }]);
  // An engineer holds it: both go to its stream, and the PM gets nothing more.
  await op.dispatchStart({ ...asArchitect, id: "a", role: "工程师", level: 2, model: "Sonnet", agent: "a-worker", agentId: "agent-a" });
  assert.deepEqual(await api("/api/wake", deployed), { status: 200, data: { pushed: 1 } });
  assert.deepEqual(await api("/api/wake", deployFailed), { status: 200, data: { pushed: 1 } });
  await pm.sync();
  assert.equal(pm.events().length, 1, "the PM hears of neither once an engineer holds the item");
  const frames = wake.agent("a-worker").pending().frames;
  assert.deepEqual(frames.map(f => [f.event, f.item, f.pr]), [["deployed", "a", 1], ["deployFailed", "a", 1]]);
  assert.deepEqual({ version: frames[0]!.version, restarted: frames[0]!.restarted }, { version: "a".repeat(40), restarted: true });
  // A deploy that names no pull request an item delivers, or whose repository is not told: the same.
  assert.deepEqual(await api("/api/wake", { ...deployed, changes: ["abc1234 Merge pull request #99 from x"] }), { status: 200, data: { pushed: 0 } });
  assert.deepEqual(await api("/api/wake", { ...deployed, repo: null }), { status: 200, data: { pushed: 0 } });
  assert.deepEqual(await api("/api/wake", { ...deployFailed, repo: null }), { status: 200, data: { pushed: 1 } });
  await pm.sync();
  assert.deepEqual(pm.events().map(f => [f.event, f.item]), [["deployFailed", "a"], ["deployFailed", null]]);
});

test("POST /api/wake refuses every other kind, every other field set and every bad body, and sends nothing", async t => {
  const { url, api, port } = await server(t);
  const star = await wakeSocket(t, url);
  const { event, ...fields } = deployed;
  const refused = async (what: string, body: unknown) => {
    const response = await api("/api/wake", body);
    assert.equal(response.status, 400, `${what}: ${JSON.stringify(response.data)}`);
    assert.equal(typeof response.data.error, "string", what);
  };
  // The board's own kinds, with exactly their own fields: the daemon is their only source.
  await refused("note", { event: "note", ...noteFields("n1") });
  await refused("stalled", { event: "stalled", item: "a", project: "Whitefoot", title: "t", text: "x" });
  await refused("timed", { event: "timed", since: "s", changed: [], working: 0, architect: 0, pm: 0, review: [], finished: [] });
  await refused("timed-architect", { event: "timed-architect", since: "s", changed: [], working: 0 });
  for (const other of ["bogus", "toString", "__proto__", "constructor", "", 5, null, ["deployed"]]) await refused(`event ${JSON.stringify(other)}`, { event: other, ...fields });
  await refused("no event", fields);
  await refused("a missing field", { event, version: fields.version, previous: fields.previous, changes: fields.changes, restarted: fields.restarted });
  await refused("an extra field", { ...deployed, extra: 1 });
  await refused("the frame's fields in place of the request's", { event, version: "v", restarted: true, item: "a", project: "Whitefoot", title: "t", pr: 1 });
  await refused("another kind's fields", { ...deployFailed, event });
  await refused("oversize", { ...deployFailed, reason: "x".repeat(20 * 1024) });
  for (const body of [[], null, "deployed", 5]) await refused(`body ${JSON.stringify(body)}`, body);
  const raw = await fetch(url + "/api/wake", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(raw.status, 400);
  // Only a program on this machine may ask: the same Host and Origin rules as every other write.
  const foreign = await fetch(url + "/api/wake", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example" }, body: JSON.stringify(deployFailed) });
  assert.equal(foreign.status, 403);
  const hostStatus = (host: string) => new Promise<number>((resolve, reject) => {
    const req = request(url + "/api/wake", { method: "POST", headers: { Host: host, "Content-Type": "application/json" } }, res => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject); req.end(JSON.stringify(deployFailed));
  });
  assert.equal(await hostStatus("evil.example"), 403);
  assert.equal(await hostStatus(`localhost:${port}`), 200, "the control: the same request with the right Host is taken");
  assert.equal((await fetch(url + "/api/wake")).status, 404, "it only takes a POST");
  await star.sync();
  assert.deepEqual(star.events().map(f => f.n), [1], "only the control request was sent (a failed deploy no item explains goes to the PM)");
});

test("a kept file that holds a kind the table no longer has loses that event and keeps its number", async t => {
  const file = join(await scratch(t), "wake.jsonl");
  const first = new Wake({ file, now: () => T0 });
  first.push("stalled", stallFields("n1"));
  // The earlier table pushed these kinds; a board started over their file must neither fail on them nor reuse their numbers.
  await writeFile(file, [...(await lines(file)), { n: 2, at: iso(T0), event: "pr-ready", repo: "o/r", number: 1 }, { n: 3, at: iso(T0), event: "stalled", ...stallFields("n3") }].map(l => JSON.stringify(l) + "\n").join(""));
  const again = new Wake({ file, now: () => T0 });
  assert.deepEqual(again.since(0).frames.map(f => [f.n, f.event]), [[1, "stalled"], [3, "stalled"]]);
  assert.equal(again.latest(), 3);
  assert.equal(again.push("stalled", stallFields("n4")).n, 4);
  assert.doesNotThrow(() => again.checkReceipts());
});

test("a told notice goes to each listener with its card or item; a listener added later gets none of the earlier ones", () => {
  const told: string[] = [];
  const wake = new Wake({ now: () => Date.parse("2026-10-16T10:00:00Z") });
  wake.tell("挡事的卡 · Whitefoot", "问题", { kind: "card", key: "choice" });
  const off = wake.onTell(notice => told.push(JSON.stringify(notice)));
  wake.tell("PM 一小时没响应", "最早没回执的是 #3", { kind: "item", key: "a" });
  off();
  wake.tell("之后", "没人听");
  assert.deepEqual(told, [JSON.stringify({ title: "PM 一小时没响应", message: "最早没回执的是 #3", target: { kind: "item", key: "a" } })]);
});

test("a listener that throws is logged; the listeners after it still get the notice, and tell does not throw", () => {
  const errors: unknown[][] = [], original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  const got: string[] = [];
  try {
    const wake = new Wake({ now: () => T0 });
    wake.onTell(() => { throw new Error("listener broke"); });
    wake.onTell(notice => got.push(notice.title));
    wake.tell("挡事的卡 · Whitefoot", "问题");
  } finally { console.error = original; }
  assert.deepEqual(got, ["挡事的卡 · Whitefoot"], "the listener after the one that threw still gets the notice");
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]![0]), /owner notice listener failed/);
});

test("a no-receipt notice opens the item or card its oldest unanswered event is about, and none when that event has no target", () => {
  let clock = T0;
  const targets: unknown[] = [];
  const wake = new Wake({ now: () => clock, receiptLimitMs: 60_000 });
  wake.onTell(notice => targets.push(notice.target));
  wake.push("note", { note: "n1", target: "q:choice", kind: "comment", title: "问题", project: "Whitefoot" });
  clock += 60_000; wake.checkReceipts();
  assert.deepEqual(targets, [{ kind: "card", key: "choice" }]);
  const second = new Wake({ now: () => clock, receiptLimitMs: 60_000 });
  const seconds: unknown[] = [];
  second.onTell(notice => seconds.push(notice.target));
  second.push("stalled", { item: "a", project: "Whitefoot", title: "中文检查", text: "无人推进" });
  clock += 60_000; second.checkReceipts();
  assert.deepEqual(seconds, [{ kind: "item", key: "a" }]);
  const fourth = new Wake({ now: () => clock, receiptLimitMs: 60_000 });
  const noted: unknown[] = [];
  fourth.onTell(notice => noted.push(notice.target));
  fourth.push("note", { note: "n2", target: "it:a", kind: "comment", title: "中文检查", project: "Whitefoot" });
  clock += 60_000; fourth.checkReceipts();
  assert.deepEqual(noted, [{ kind: "item", key: "a" }], "a note on an item opens that item");
  const third = new Wake({ now: () => clock, receiptLimitMs: 60_000 });
  const none: unknown[] = [];
  third.onTell(notice => none.push(notice.target));
  third.push("timed", { since: "2026-10-16T09:00:00Z", changed: [], working: 0, architect: 1, pm: 0, review: [], finished: [] });
  clock += 60_000; third.checkReceipts();
  assert.deepEqual(none, [undefined], "a timed event names no item or card, so the click opens the home view");
  // What the PM is to act on for an item opens that item.
  const pushes: Array<[Parameters<Wake["push"]>[0], Record<string, unknown>]> = [
    ["review", { item: "a", project: "Whitefoot", title: "中文检查", level: 3 }],
    ["finished", { item: "a", project: "Whitefoot", title: "中文检查", session: "a-worker" }],
  ];
  for (const [event, fields] of pushes) {
    const wake = new Wake({ now: () => clock, receiptLimitMs: 60_000 }), opened: unknown[] = [];
    wake.onTell(notice => opened.push(notice.target));
    wake.push(event, fields);
    clock += 60_000; wake.checkReceipts();
    assert.deepEqual(opened, [{ kind: "item", key: "a" }], event);
  }
});
