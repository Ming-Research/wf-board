import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { board, author, later, server, wakeSocket } from "./helpers.ts";
import { Item } from "../src/model.ts";
import { Wake, WAKE_KINDS, CONTROL_FRAMES } from "../src/wake.ts";
import { ARCHITECT_SESSION } from "../src/model.ts";
import type { WakeFrame } from "../src/wake.ts";
import { macNotify, notifyArgs, NOTIFY_SCRIPT } from "../src/notify.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createHttpServer } from "../src/http.ts";
import { ownerOps } from "../src/owner-ops.ts";

const T0 = Date.parse("2026-10-16T00:00:00Z"), HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const noteFields = (note: string, project = "Whitefoot") => ({ note, target: "it:a", kind: "comment", title: "中文检查", project });
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
  const first = wake.push("note", noteFields("n1")), second = wake.push("note", noteFields("n2"));
  assert.deepEqual([first.n, second.n], [1, 2]);
  assert.deepEqual(first, { n: 1, at: iso(T0), event: "note", ...noteFields("n1") });
  assert.deepEqual(got, [first, second]);
  assert.throws(() => wake.push("note", { ...noteFields("n3"), extra: 1 }), /fields/);
  const { title: _title, ...missing } = noteFields("n3");
  assert.throws(() => wake.push("note", missing), /fields/);
  assert.throws(() => wake.push("request" as never, {}), /Unknown wake kind/);
  assert.equal(wake.latest(), 2, "a refused push takes no number");
});

test("since returns what follows a number, and flags a gap when the log no longer holds the number after it, or the number is ahead", () => {
  const wake = new Wake({ now: () => T0, retain: 3 });
  for (let i = 1; i <= 5; i++) wake.push("note", noteFields("n" + i));
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
  for (let i = 1; i <= 5; i++) first.push("note", noteFields("n" + i));
  assert.deepEqual((await lines(file)).filter(l => l.event).map(l => l.n), [3, 4, 5]);
  const second = new Wake({ file, now: () => T0, retain: 3 });
  assert.equal(second.latest(), 5); assert.equal(second.oldest(), 3);
  assert.equal(second.push("note", noteFields("n6")).n, 6);
  assert.deepEqual(second.since(0).frames.map(f => f.n), [4, 5, 6]);
  // The byte limit alone also drops the oldest, but always keeps the newest.
  const small = new Wake({ now: () => T0, retainBytes: 300 });
  for (let i = 1; i <= 6; i++) small.push("note", noteFields("n" + i));
  assert.ok(small.since(0).frames.length < 6 && small.since(0).frames.at(-1)!.n === 6);
  // The limit counts bytes, not characters: Chinese text is three bytes a character, and the doc's 2 MiB is bytes.
  const chinese = { ...noteFields("n"), title: "中".repeat(100) }, wide = new Wake({ now: () => T0 }), one = wide.push("note", chinese);
  const bytes = Buffer.byteLength(JSON.stringify(one)), characters = JSON.stringify(one).length;
  assert.ok(bytes > 1.5 * characters);
  const counted = new Wake({ now: () => T0, retainBytes: Math.floor(2.5 * bytes) });
  for (let i = 0; i < 5; i++) counted.push("note", chinese);
  assert.deepEqual(counted.since(0).frames.map(f => f.n), [4, 5], "two events fit in 2.5 events' bytes, though four would by characters");
  // An event that alone is over the limit is kept.
  const tiny = new Wake({ now: () => T0, retainBytes: 1 });
  tiny.push("note", noteFields("n1")); tiny.push("note", noteFields("n2"));
  assert.deepEqual(tiny.since(0).frames.map(f => f.n), [2]);
});

test("a receipt answers everything pushed before it, and writes nothing when it changes nothing", async t => {
  const file = join(await scratch(t), "wake.jsonl"), wake = new Wake({ file, now: () => T0 });
  wake.receipt();
  assert.equal(wake.receiptedUpTo(), 0); assert.equal((await lines(file).catch(() => [])).length, 0, "nothing to answer, nothing written");
  wake.push("note", noteFields("n1")); wake.push("note", noteFields("n2"));
  wake.receipt();
  assert.equal(wake.receiptedUpTo(), 2);
  const size = (await lines(file)).length;
  wake.receipt(); wake.receipt();
  assert.equal((await lines(file)).length, size, "repeated calls with nothing new write nothing");
  wake.push("note", noteFields("n3"));
  assert.equal(wake.receiptedUpTo(), 2, "an event pushed after the call is not answered by it");
  assert.equal(new Wake({ file, now: () => T0 }).receiptedUpTo(), 2, "a restart keeps the receipt");
});

test("with no receipt for the limit the owner is told once, a receipt starts the count again, and a restart keeps all of it", async t => {
  const file = join(await scratch(t), "wake.jsonl"), told: Array<[string, string]> = [];
  let clock = T0;
  const open = () => new Wake({ file, now: () => clock, notify: (title, message) => { told.push([title, message]); } });
  const a = open();
  a.push("note", noteFields("n1")); a.push("note", noteFields("n2"));
  a.receipt();
  a.push("note", noteFields("n3"));
  clock = T0 + HOUR - 1; a.checkReceipts();
  assert.deepEqual(told, [], "the oldest event without a receipt is not yet an hour old");
  clock = T0 + HOUR; a.checkReceipts();
  assert.deepEqual(told, [["架构师 1 小时没响应", "最早没回执的是 #3：主人的留言：中文检查"]]);
  clock += HOUR; a.checkReceipts(); a.checkReceipts();
  assert.equal(told.length, 1, "one alert per silence, not one per tick");
  const b = open();
  b.checkReceipts();
  assert.equal(told.length, 1, "the restart remembers it already told the owner");
  b.receipt();
  b.push("note", noteFields("n4"));
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
  const wake = new Wake({ now: () => clock, receiptLimitMs: 10 * 60_000, notify: title => { told.push(title); } });
  wake.push("timed", { since: iso(T0), changed: [], working: [], architect: [] });
  clock += 10 * 60_000; wake.checkReceipts();
  assert.deepEqual(told, ["架构师 10 分钟没响应"]);
});

test("a failing notifier is logged, never thrown into the write that caused the alert", async () => {
  const errors: unknown[][] = [], original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    new Wake({ now: () => T0, notify: () => { throw new Error("no display"); } }).tell("t", "m");
    new Wake({ now: () => T0, notify: () => Promise.reject(new Error("no display")) }).tell("t", "m");
    await setImmediate();
  } finally { console.error = original; }
  assert.equal(errors.length, 2);
});

test("a log file that cannot be written costs the numbers' continuity, never the push", async t => {
  const dir = await scratch(t), errors: unknown[][] = [], original = console.error;
  await writeFile(join(dir, "plain-file"), "x");
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const wake = new Wake({ file: join(dir, "plain-file", "wake.jsonl"), now: () => T0 });
    assert.equal(wake.push("note", noteFields("n1")).n, 1);
    wake.receipt();
    assert.equal(wake.receiptedUpTo(), 1);
  } finally { console.error = original; }
  assert.ok(errors.length >= 1 && errors.every(e => e[0] === "wake log not written"));
});

test("a sent note is pushed with a number whatever project its item is in, a draft is not, and a second send pushes nothing", async t => {
  const { url, api, store } = await server(t);
  const star = await wakeSocket(t, url);
  assert.deepEqual(star.frames, [{ event: "connected", latest: 0 }]);
  const one = await api("/api/notes", { target: "it:a", kind: "comment", text: "one" });
  const two = await api("/api/notes", { target: "q:choice", kind: "explain", text: "two" });
  const three = await api("/api/notes", { target: "it:other", kind: "comment", text: "three" });
  await star.sync();
  assert.deepEqual(star.events(), [], "drafts are not pushed");
  await api("/api/send", {}); await star.sync();
  const seen = star.events().map(({ at, ...frame }) => (assert.match(String(at), /^\d{4}-\d\d-\d\dT/), frame));
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
});

test("only the kinds in the table are pushed: not a new request, a blocking card, an ask or a format check", async t => {
  const { url, store, op } = await server(t);
  const star = await wakeSocket(t, url);
  await op.createRequest({ author: "Firn", project: "Whitefoot", key: "incoming", title: "Visitor request", head: "Please", accept: "Passes", priority: "P0", why: "Need it" });
  await op.writeCard({ author, key: "hard", item: "a", question: "合并吗？", background: "背景", options: [{ key: "A", text: "是" }], blocks: "合并停着" });
  const other = store.snapshot().items.other!;
  await store.commit({ author, message: "set ask", puts: [{ kind: "item", id: "other", expectRev: other.rev, doc: { ...other, ask: { text: "请合并" } } }] });
  await store.commit({ author, message: "Block item", puts: [{ kind: "item", id: "c", expectRev: null, doc: { title: "卡住的条目", group: "Whitefoot", priority: "P1", plan: [{ id: "missing", item: "missing", own: false, after: [] }, { id: "accept", text: "某项检查通过", state: "todo", accept: true }], updated: later, head: "**完成条件**：某项检查通过" } }] });
  await star.sync();
  assert.deepEqual(star.events(), []);
});

test("a client that comes back with its last number gets what followed, a gap frame when the log no longer holds it, and a bad number is refused", async t => {
  const wake = new Wake({ retain: 2 });
  const { url, api } = await server(t, { wake });
  for (const text of ["one", "two", "three"]) await api("/api/notes", { target: "it:a", kind: "comment", text });
  await api("/api/send", {});
  assert.equal(wake.latest(), 3);
  const live = await wakeSocket(t, url), resumed = await wakeSocket(t, url, 2), behind = await wakeSocket(t, url, 0), ahead = await wakeSocket(t, url, 99), current = await wakeSocket(t, url, 3);
  assert.deepEqual(live.frames, [{ event: "connected", latest: 3 }], "without a number the client takes events from now on");
  assert.deepEqual(resumed.frames.map(f => f.n ?? f.event), ["connected", 3]);
  assert.deepEqual(behind.frames.map(f => f.n ?? f.event), ["connected", "gap", 2, 3], "the gap frame comes before the events that are left");
  assert.deepEqual(behind.frames[1], { event: "gap", oldest: 2, latest: 3 });
  assert.deepEqual(ahead.frames, [{ event: "connected", latest: 3 }, { event: "gap", oldest: 2, latest: 3 }]);
  assert.deepEqual(current.frames, [{ event: "connected", latest: 3 }]);
  // A live event reaches every connected client, once, after the replay.
  await api("/api/notes", { target: "it:a", kind: "comment", text: "four" }); await api("/api/send", {});
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
    s.items.w = Item.parse({ title: "没人推进的叶子", group: "Whitefoot", priority: "P1", plan: [{ id: "work", text: "当前工作", state: "doing", since: new Date(start).toISOString() }, { id: "accept", text: "某项检查通过", state: "todo", accept: true }], updated: new Date(start).toISOString(), log: [], rev: 1, head: "**完成条件**：某项检查通过" });
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

test("the timed wake lists what changed since the last one without the architect's own writes, the items being worked on and the Architect project's items; the last one's time survives a restart", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const dir = await scratch(t), file = join(dir, "wake.jsonl"), half = 30 * 60_000;
  let clock = T0;
  const wake = new Wake({ file, now: () => clock });
  const { url, store, op, api } = await server(t, { now: () => clock, checkIntervalMs: 1000, wake, timedWakeMs: half });
  // One item of the Architect project (the fixture board has it), and an item with a step being worked on.
  const doc = (title: string, group: string, plan: object[]) => ({ title, group, priority: "P1", plan: [...plan, { id: "accept", text: "某项检查通过", state: "todo", accept: true }], updated: later, head: "**完成条件**：某项检查通过" });
  await store.commit({ author, message: "Seed", puts: [
    { kind: "item", id: "arch", expectRev: null, doc: doc("架构师的条目", "Architect", [{ id: "step", text: "一步", state: "todo" }]) },
    { kind: "item", id: "work", expectRev: null, doc: doc("在做的条目", "Whitefoot", [{ id: "step", text: "当前工作", state: "doing", since: iso(T0) }]) },
  ] });
  wake.markTimed({ at: iso(T0), head: store.snapshot().head });
  // After the mark: an engineer writes b and other; the architect writes a and b; the owner comments on the card of a.
  await op.appendLog({ author, session: "工程师", id: "b", text: "progress" });
  await op.appendLog({ author: "Firn", session: "工程师", id: "other", text: "progress" });
  await op.appendLog({ author, session: ARCHITECT_SESSION, id: "a", text: "reviewed" });
  await op.appendLog({ author, session: ARCHITECT_SESSION, id: "b", text: "reviewed" });
  await api("/api/notes", { target: "q:choice", kind: "comment", text: "owner says" });
  const star = await wakeSocket(t, url);
  clock = T0 + half - 1; t.mock.timers.tick(1000); await star.sync(); await setImmediate();
  assert.deepEqual(star.events(), [], "not due yet");
  clock = T0 + half; t.mock.timers.tick(1000);
  await until(() => star.events().length, n => n === 1, "the timed wake");
  const frame = star.events()[0]!;
  assert.deepEqual({ n: frame.n, at: frame.at, event: frame.event, since: frame.since }, { n: 1, at: iso(clock), event: "timed", since: iso(T0) });
  const names = (list: unknown) => (list as Array<{ item: string }>).map(e => e.item).sort();
  assert.deepEqual(names(frame.changed), ["a", "b", "other"], "a is listed for the owner's comment, b and other for the engineer; the architect's own writes are not why");
  const by = Object.fromEntries((frame.changed as Array<{ item: string; by: string[] }>).map(e => [e.item, e.by]));
  assert.deepEqual(by, { a: ["owner"], b: ["工程师"], other: ["工程师"] });
  assert.deepEqual(names(frame.working), ["work"], "the item with a step being done, outside the Architect project");
  assert.deepEqual(frame.working, [{ item: "work", project: "Whitefoot", title: "在做的条目", status: "wip", flags: [] }]);
  assert.deepEqual(frame.architect, [{ item: "arch", project: "Architect", title: "架构师的条目", status: "todo", flags: [] }]);
  assert.deepEqual(wake.lastTimed, { at: iso(clock), head: store.snapshot().head });
  assert.deepEqual((await lines(file)).filter(l => l.timed).at(-1), { timed: wake.lastTimed });
  t.mock.timers.tick(5000); await setImmediate();
  assert.equal(star.events().length, 1, "the next one is a half hour after this one");
  // A restart keeps the mark: the next wake counts from it, not from the restart.
  await op.appendLog({ author, session: "工程师", id: "b", text: "after the wake" });
  const mark = wake.lastTimed!;
  clock += 10 * 60_000;
  const reopened = new Wake({ file, now: () => clock });
  assert.deepEqual(reopened.lastTimed, mark); assert.equal(reopened.latest(), 1);
  const again = await restart(t, store, op, { now: () => clock, checkIntervalMs: 1000, wake: reopened, timedWakeMs: half });
  const resumed = await wakeSocket(t, again.url, 1);
  t.mock.timers.tick(1000); await setImmediate(); await resumed.sync();
  assert.deepEqual(resumed.events(), [], "ten minutes after the last wake, restart or not, nothing is due");
  clock = Date.parse(mark.at) + half; t.mock.timers.tick(1000);
  await until(() => resumed.events().length, n => n === 1, "the timed wake after the restart");
  const next = resumed.events()[0]!;
  assert.equal(next.n, 2); assert.equal(next.since, mark.at);
  assert.deepEqual(names(next.changed), ["b"], "only what changed after the last wake");
});

async function mcpClient(t: Parameters<typeof board>[0], wake: Wake) {
  const fixture = await board(t), mcp = createMcpServer({ store: fixture.store, ops: fixture.op, wake });
  const client = new Client({ name: "Wake", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await mcp.close(); });
  return { ...fixture, client };
}

test("a call carrying the architect's session, read or write, is the receipt for what was pushed before it; another session's, or none, is not", async t => {
  const wake = new Wake({ now: () => T0 });
  const { client } = await mcpClient(t, wake);
  wake.push("note", noteFields("n1")); wake.push("note", noteFields("n2"));
  await client.callTool({ name: "projects", arguments: { session: "别的会话" } });
  await client.callTool({ name: "projects", arguments: {} });
  assert.equal(wake.receiptedUpTo(), 0);
  await client.callTool({ name: "projects", arguments: { session: ARCHITECT_SESSION } });
  assert.equal(wake.receiptedUpTo(), 2, "a read answers both");
  wake.push("note", noteFields("n3"));
  await client.callTool({ name: "append_log", arguments: { author: "Architect", session: ARCHITECT_SESSION, id: "a", text: "x" } });
  assert.equal(wake.receiptedUpTo(), 3, "a write answers too, even when the board refuses it");
  wake.push("note", noteFields("n4"));
  const refused = await client.callTool({ name: "projects", arguments: { session: ARCHITECT_SESSION, unknown: 1 } });
  assert.equal(refused.isError, true);
  assert.equal(wake.receiptedUpTo(), 3, "a call the schema refuses is not a receipt");
  await client.callTool({ name: "projects", arguments: { session: `  ${ARCHITECT_SESSION}  ` } });
  assert.equal(wake.receiptedUpTo(), 4, "a session name padded with spaces counts, as it does for the permission rule");
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

test("with no receipt for the limit the server's timer tells the owner once, and a call from the architect starts the count again", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = T0;
  const told: Array<[string, string]> = [];
  const wake = new Wake({ now: () => clock, receiptLimitMs: 10 * 60_000, notify: (title, message) => { told.push([title, message]); } });
  const { url, api } = await server(t, { now: () => clock, checkIntervalMs: 1000, wake, timedWakeMs: 1e12 });
  await api("/api/notes", { target: "it:a", kind: "comment", text: "one" }); await api("/api/send", {});
  assert.equal(wake.latest(), 1);
  clock = T0 + 10 * 60_000 - 1; t.mock.timers.tick(1000);
  assert.deepEqual(told, []);
  clock++; t.mock.timers.tick(1000);
  assert.deepEqual(told, [["架构师 10 分钟没响应", "最早没回执的是 #1：主人的留言：中文检查"]]);
  t.mock.timers.tick(5000);
  assert.equal(told.length, 1, "not repeated while the silence lasts");
  // The architect's call through the real MCP route is the receipt.
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "Architect", version: "1" }), transport = new StreamableHTTPClientTransport(new URL(url + "/mcp"));
  await client.connect(transport); t.after(() => client.close());
  await client.callTool({ name: "projects", arguments: { session: ARCHITECT_SESSION } });
  assert.equal(wake.receiptedUpTo(), 1);
  await api("/api/notes", { target: "it:a", kind: "comment", text: "two" }); await api("/api/send", {});
  clock += 10 * 60_000; t.mock.timers.tick(1000);
  assert.equal(told.length, 2); assert.match(told[1]![1], /#2：/);
});

test("a card that stops work tells the owner once; a card without blocks, a revision that keeps blocks and a ruled card do not", async t => {
  const told: Array<[string, string]> = [];
  const wake = new Wake({ notify: (title, message) => { told.push([title, message]); } });
  const targets: unknown[] = [];
  wake.onTell(notice => targets.push(notice.target));
  const { op } = await server(t, { wake });
  const card = { author, key: "gate", item: "a", question: "合并吗？", background: "背景", options: [{ key: "A", text: "是" }] };
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
  await op.ruleCard({ author, key: "hard", choice: "A", ruling: "好" });
  assert.equal(told.length, 3, "ruling a card says nothing");
});

/** An osascript stand-in: it appends its arguments, as JSON, to a log, and fails while a counter file says so. */
async function fakeOsascript(dir: string, failures = 0) {
  const command = join(dir, "osascript"), log = join(dir, "osascript.log"), count = join(dir, "osascript.count");
  await writeFile(command, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const seen = fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, "utf8")) : 0;
fs.writeFileSync(${JSON.stringify(count)}, String(seen + 1));
process.exit(seen < ${failures} ? 1 : 0);
`);
  await chmod(command, 0o755);
  return { command, calls: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map(l => JSON.parse(l) as string[]) };
}

test("the notification runs osascript with the script lines, then the title and the message as plain arguments", async t => {
  const fake = await fakeOsascript(await scratch(t));
  const message = '问题 "含引号" \\ 反斜杠\n第二行 -开头';
  await macNotify({ command: fake.command, retryMs: 0 })("挡事的卡 · Whitefoot", message);
  const [call, ...more] = await fake.calls();
  assert.deepEqual(more, []);
  assert.deepEqual(call, notifyArgs("挡事的卡 · Whitefoot", message));
  assert.deepEqual(call!.slice(0, NOTIFY_SCRIPT.length * 2), NOTIFY_SCRIPT.flatMap(line => ["-e", line]));
  assert.deepEqual(call!.slice(-3), ["--", "挡事的卡 · Whitefoot", message], "quotes, backslashes and the newline arrive whole as the last argument, not inside the script");
  assert.ok(NOTIFY_SCRIPT.every(line => !line.includes("挡事") && !line.includes("反斜杠")), "the script holds no text of the message");
  assert.equal(notifyArgs("t", "x".repeat(1000)).at(-1)!.length, 240, "a long message is cut");
});

test("a failed osascript run is tried again up to the attempts, then the error comes out", async t => {
  const dir = await scratch(t), fake = await fakeOsascript(dir, 2);
  await macNotify({ command: fake.command, attempts: 3, retryMs: 0 })("t", "m");
  assert.equal((await fake.calls()).length, 3, "two failures, then the one that worked");
  const stubborn = await fakeOsascript(await scratch(t), 5);
  await assert.rejects(macNotify({ command: stubborn.command, attempts: 2, retryMs: 0 })("t", "m"));
  assert.equal((await stubborn.calls()).length, 2);
  await assert.rejects(macNotify({ command: join(dir, "no-such-osascript"), attempts: 1 })("t", "m"));
});

test("a blocking card written through the server runs the notification command with the card's project, question and blocks", async t => {
  const fake = await fakeOsascript(await scratch(t));
  const wake = new Wake({ notify: macNotify({ command: fake.command, retryMs: 0 }) });
  const { op } = await server(t, { wake });
  await op.writeCard({ author, key: "gate", item: "a", question: "合并吗？", background: "背景", options: [{ key: "A", text: "是" }] });
  await op.writeCard({ author, key: "hard", item: "a", question: "批准权限吗？", background: "背景", options: [{ key: "A", text: "是" }], blocks: "发布停着" });
  const calls = await until(fake.calls, c => c.length > 0, "the notification command");
  assert.deepEqual(calls, [notifyArgs("挡事的卡 · Whitefoot", "批准权限吗？（挡住：发布停着）")], "one run, for the blocking card only");
});

// docs/design.md (The wake stream) gives the frames; this keeps it and src/wake.ts's table from drifting apart.
test("the design doc's frame table lists exactly the kinds in the table and the control frames, with their fields", async () => {
  const doc = await readFile(join(import.meta.dirname, "../docs/design.md"), "utf8");
  const start = doc.indexOf("### The wake stream"), end = doc.indexOf("**Why not MCP push.**");
  assert.ok(start >= 0 && end > start, "docs/design.md must hold the headings '### The wake stream' and then '**Why not MCP push.**'");
  const forms = new Map<string, string[]>();
  for (const [, body] of doc.slice(start, end).matchAll(/`\{([^`]*)\}`/g)) {
    const fields = body!.split(", "), event = fields.map(f => /^event:"(\w+)"$/.exec(f)?.[1]).find(Boolean);
    if (event) forms.set(event, fields.filter(f => !f.startsWith("event:")).sort());
  }
  const expected = new Map<string, string[]>([
    ...Object.entries(WAKE_KINDS).map(([kind, spec]) => [kind, ["at", "n", ...spec.fields].sort()] as [string, string[]]),
    ...Object.entries(CONTROL_FRAMES).map(([frame, fields]) => [frame, [...fields].sort()] as [string, string[]]),
  ]);
  assert.deepEqual([...forms.keys()].sort(), [...expected.keys()].sort());
  for (const [event, fields] of expected) assert.deepEqual(forms.get(event), fields, `${event}: the doc's fields differ from the table`);
});

test("a told notice goes to the server's notify and to each listener with its card or item; a listener added later gets none of the earlier ones", () => {
  const told: string[] = [];
  const notified: string[] = [];
  const wake = new Wake({ now: () => Date.parse("2026-10-16T10:00:00Z"), notify: title => { notified.push(title); } });
  wake.tell("挡事的卡 · Whitefoot", "问题", { kind: "card", key: "choice" });
  const off = wake.onTell(notice => told.push(JSON.stringify(notice)));
  wake.tell("架构师一小时没响应", "最早没回执的是 #3", { kind: "item", key: "a" });
  off();
  wake.tell("之后", "没人听");
  assert.deepEqual(notified, ["挡事的卡 · Whitefoot", "架构师一小时没响应", "之后"], "the script notice still goes out for every tell");
  assert.deepEqual(told, [JSON.stringify({ title: "架构师一小时没响应", message: "最早没回执的是 #3", target: { kind: "item", key: "a" } })]);
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
  third.push("timed", { since: "2026-10-16T09:00:00Z", changed: [], working: [], architect: "ok" });
  clock += 60_000; third.checkReceipts();
  assert.deepEqual(none, [undefined], "a timed event names no item or card, so the click opens the home view");
});
