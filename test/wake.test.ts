import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { agentSocket, board, author, later, server, asArchitect } from "./helpers.ts";
import { AgentStream, Wake, WAKE_KINDS, CONTROL_FRAMES, agentFileName } from "../src/wake.ts";
import { ARCHITECT_SESSION } from "../src/model.ts";
import type { WakeFrame } from "../src/wake.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createHttpServer } from "../src/http.ts";
import { architectTimedWake } from "../src/timed-wake.ts";
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
  const stream = new AgentStream("eng", { now: () => T0 }), got: WakeFrame[] = [];
  stream.onPush(frame => got.push(frame));
  const first = stream.push("note", noteFields("n1")), second = stream.push("note", noteFields("n2"));
  assert.deepEqual([first.n, second.n], [1, 2]);
  const { line, ...bare } = first;
  assert.deepEqual(bare, { n: 1, at: iso(T0), event: "note", ...noteFields("n1") });
  assert.match(String(line), /^#1 主人的留言 · /, "the frame also carries the one line the agent is shown");
  assert.deepEqual(got, [first, second]);
  assert.throws(() => stream.push("note", { ...noteFields("n3"), extra: 1 }), /fields/);
  const { title: _title, ...missing } = noteFields("n3");
  assert.throws(() => stream.push("note", missing), /fields/);
  assert.throws(() => stream.push("request" as never, {}), /Unknown wake kind/);
  assert.equal(stream.latest(), 2, "a refused push takes no number");
});

test("since returns what follows a number, and flags a gap when the log no longer holds the number after it, or the number is ahead", () => {
  const stream = new AgentStream("eng", { now: () => T0, retain: 3 });
  for (let i = 1; i <= 5; i++) stream.push("note", noteFields("n" + i));
  assert.equal(stream.oldest(), 3, "the oldest two went past the limit of 3");
  const numbers = (after: number) => { const r = stream.since(after); return { n: r.frames.map(f => f.n), gap: r.gap }; };
  assert.deepEqual(numbers(5), { n: [], gap: false });
  assert.deepEqual(numbers(4), { n: [5], gap: false });
  assert.deepEqual(numbers(2), { n: [3, 4, 5], gap: false }, "number 2 is the one just before the oldest kept: nothing is missing");
  assert.deepEqual(numbers(1), { n: [3, 4, 5], gap: true }, "event 2 was dropped");
  assert.deepEqual(numbers(0), { n: [3, 4, 5], gap: true });
  assert.deepEqual(numbers(9), { n: [], gap: true }, "ahead of the stream: the log was reset");
});

test("past the count and byte limits the oldest events go, the file shrinks with them, and numbering goes on after a restart", async t => {
  const file = join(await scratch(t), "wake.jsonl"), first = new AgentStream("eng", { file, now: () => T0, retain: 3 });
  for (let i = 1; i <= 5; i++) first.push("note", noteFields("n" + i));
  assert.deepEqual((await lines(file)).filter(l => l.event).map(l => l.n), [3, 4, 5]);
  const second = new AgentStream("eng", { file, now: () => T0, retain: 3 });
  assert.equal(second.latest(), 5); assert.equal(second.oldest(), 3);
  assert.equal(second.push("note", noteFields("n6")).n, 6);
  assert.deepEqual(second.since(0).frames.map(f => f.n), [4, 5, 6]);
  // The byte limit alone also drops the oldest, but always keeps the newest.
  const small = new AgentStream("eng", { now: () => T0, retainBytes: 300 });
  for (let i = 1; i <= 6; i++) small.push("note", noteFields("n" + i));
  assert.ok(small.since(0).frames.length < 6 && small.since(0).frames.at(-1)!.n === 6);
  // The limit counts bytes, not characters: Chinese text is three bytes a character, and the doc's 2 MiB is bytes.
  const chinese = { ...noteFields("n"), title: "中".repeat(100) }, wide = new AgentStream("eng", { now: () => T0 }), one = wide.push("note", chinese);
  const bytes = Buffer.byteLength(JSON.stringify(one)), characters = JSON.stringify(one).length;
  assert.ok(bytes > 1.5 * characters);
  const counted = new AgentStream("eng", { now: () => T0, retainBytes: Math.floor(2.5 * bytes) });
  for (let i = 0; i < 5; i++) counted.push("note", chinese);
  assert.deepEqual(counted.since(0).frames.map(f => f.n), [4, 5], "two events fit in 2.5 events' bytes, though four would by characters");
  // An event that alone is over the limit is kept.
  const tiny = new AgentStream("eng", { now: () => T0, retainBytes: 1 });
  tiny.push("note", noteFields("n1")); tiny.push("note", noteFields("n2"));
  assert.deepEqual(tiny.since(0).frames.map(f => f.n), [2]);
});

test("the limit can be set shorter, and the alert names it in minutes", () => {
  const told: string[] = [];
  let clock = T0;
  const wake = new Wake({ now: () => clock, overdueMs: 10 * 60_000 });
  wake.onTell(notice => told.push(notice.title));
  wake.push("note", noteFields("n1"));
  clock += 10 * 60_000; wake.checkOverdue();
  assert.deepEqual(told, ["架构师 10 分钟没响应"]);
});

test("a log file that cannot be written costs the numbers' continuity, never the push", async t => {
  const dir = await scratch(t), errors: unknown[][] = [], original = console.error;
  await writeFile(join(dir, "plain-file"), "x");
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const stream = new AgentStream("eng", { file: join(dir, "plain-file", "wake.jsonl"), now: () => T0 });
    assert.equal(stream.push("note", noteFields("n1")).n, 1);
    stream.deliver(1);
    assert.equal(stream.deliveredUpTo(), 1);
  } finally { console.error = original; }
  assert.ok(errors.length >= 1 && errors.every(e => e[0] === "wake log not written"));
});

test("a sent note is pushed to the architect's stream with a number whatever project its item is in, a draft is not, a second send pushes nothing", async t => {
  const { url, api, store } = await server(t);
  const star = await agentSocket(t, url, ARCHITECT_SESSION);
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
  assert.equal(star.events().length, 3, "explain requests and a choice on a card are notes of the architect's stream too");
});

test("a card ruled on the page or with rule_card is pushed to the session holding its item, as one line naming the card and the pick or the owner's words; nobody holding it, the owner's pick goes to the architect and a ruling a session recorded to no one, and a withdrawn card and a rewritten open card push nothing", async t => {
  const { url, api, op } = await server(t);
  const card = { author, item: "b", kind: "design" as const, confidence: { reason: "判断" }, options: [{ text: "先做", detail: "先做它" }, { text: "后做", detail: "后做它" }] };
  await op.dispatchStart({ ...asArchitect, id: "b", role: "工程师", level: 2, model: "Sonnet", agent: "b-worker", agentId: "agent-b" });
  const worker = await agentSocket(t, url, "b-worker"), star = await agentSocket(t, url, ARCHITECT_SESSION);
  const pushed = () => worker.events().map(({ at, line, ...frame }) => (assert.match(String(at), /^\d{4}-\d\d-\d\dT/), [frame, line]));
  // The owner picks an option on the page: the card becomes ruled in the commit that sends the note.
  await api("/api/notes", { target: "q:choice", kind: "choice", text: "选 B", choice: "B" });
  await api("/api/send", {});
  await worker.sync(); await star.sync();
  assert.deepEqual(pushed(), [[
    { n: 1, event: "card-ruled", card: "choice", item: "b", project: "Whitefoot", title: "中文方案？", choice: "B", option: "另一选项", ruling: null },
    "#1 卡裁了 · it:b（Whitefoot） · q:choice · 选 B「另一选项」 · 中文方案？",
  ]], "the holder is told which card and which option");
  assert.deepEqual(star.events(), [], "the architect gets nothing for a plain pick: its note is handled by the ruling, and the holder acts");
  // A decision made in chat and recorded with rule_card: the owner's words, with or without an option.
  await op.writeCard({ ...card, key: "words", question: "先做哪个？" });
  await op.writeCard({ ...card, key: "both", question: "两个都说了？" });
  await op.ruleCard({ author, key: "words", ruling: "主人说先做" });
  await op.ruleCard({ author, key: "both", choice: "A", ruling: "按第一个做" });
  await worker.sync();
  assert.deepEqual(pushed().slice(1), [
    [{ n: 2, event: "card-ruled", card: "words", item: "b", project: "Whitefoot", title: "先做哪个？", choice: null, option: null, ruling: "主人说先做" }, "#2 卡裁了 · it:b（Whitefoot） · q:words · 原话：主人说先做 · 先做哪个？"],
    [{ n: 3, event: "card-ruled", card: "both", item: "b", project: "Whitefoot", title: "两个都说了？", choice: "A", option: "先做", ruling: "按第一个做" }, "#3 卡裁了 · it:b（Whitefoot） · q:both · 选 A「先做」 · 原话：按第一个做 · 两个都说了？"],
  ]);
  assert.equal(star.events().length, 0, "a ruling recorded by a session is told to the holder alone");
  // A card that is withdrawn, or written again while open, is not ruled.
  await op.writeCard({ ...card, key: "drop", question: "不要了？" });
  await op.writeCard({ ...card, key: "drop", rev: 1, question: "改一下？" });
  await op.withdrawCard({ author, key: "drop", log: "不需要了" });
  // Nobody holds item `a`: the owner's pick goes to the architect as the ruling, with the words as a note when there are some.
  await op.writeCard({ ...card, key: "lonely", item: "a", question: "没人拿着？" });
  await api("/api/notes", { target: "q:lonely", kind: "choice", text: "选 A", choice: "A" });
  await api("/api/send", {});
  await op.writeCard({ ...card, key: "worded", item: "a", question: "没人拿着，还附了话？" });
  const worded = await api("/api/notes", { target: "q:worded", kind: "choice", text: "选 B，先补测试", choice: "B" });
  await api("/api/send", {});
  await op.writeCard({ ...card, key: "quiet", item: "a", question: "没人拿着，口头裁？" });
  await op.ruleCard({ author, key: "quiet", ruling: "口头" });
  // An item whose engineer dispatch has ended is held by no one either.
  await op.dispatchFinish({ ...asArchitect, id: "b", agentId: "agent-b", result: "一次通过", usage: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 }, cost: 0.1, reports: 0, kickbacks: 0 });
  await op.writeCard({ ...card, key: "late", question: "晚了？" });
  await op.ruleCard({ author, key: "late", choice: "B" });
  await worker.sync(); await star.sync();
  assert.equal(pushed().length, 3, "no more than the three rulings of a held item");
  assert.deepEqual(star.events().map(({ at, line, ...frame }) => (assert.match(String(at), /^\d{4}-\d\d-\d\dT/), [frame, line])), [
    [{ n: 1, event: "card-ruled", card: "lonely", item: "a", project: "Whitefoot", title: "没人拿着？", choice: "A", option: "先做", ruling: null }, "#1 卡裁了 · it:a（Whitefoot） · q:lonely · 选 A「先做」 · 没人拿着？"],
    [{ n: 2, event: "note", note: worded.data.id, target: "q:worded", kind: "choice", title: "没人拿着，还附了话？", project: "Whitefoot" }, "#2 主人的留言 · q:worded（Whitefoot）· choice · 没人拿着，还附了话？"],
    [{ n: 3, event: "card-ruled", card: "worded", item: "a", project: "Whitefoot", title: "没人拿着，还附了话？", choice: "B", option: "后做", ruling: null }, "#3 卡裁了 · it:a（Whitefoot） · q:worded · 选 B「后做」 · 没人拿着，还附了话？"],
  ], "the architect is told of the pick that nobody holds, and of the words a pick carries; the quiet ruling and the ended dispatch's ruling reach no one");
});

test("only the kinds in the table are pushed: not a blocking card, an ask or a format check", async t => {
  const { url, store, op } = await server(t);
  const star = await agentSocket(t, url, ARCHITECT_SESSION);
  await op.writeCard({ author, key: "hard", item: "a", kind: "design", question: "合并吗？", confidence: { reason: "判断" }, options: [{ text: "是", detail: "合并" }], blocks: "合并停着" });
  const other = store.snapshot().items.other!;
  await store.commit({ author, message: "set ask", puts: [{ kind: "item", id: "other", expectRev: other.rev, doc: { ...other, ask: { text: "请合并" } } }] });
  await store.commit({ author, message: "Block item", puts: [{ kind: "item", id: "c", expectRev: null, doc: { title: "卡住的条目", group: "Whitefoot", plan: [{ id: "missing", item: "missing", own: false, after: [] }, { id: "accept", text: "某项检查通过", state: "todo", accept: true }], updated: later, head: "**完成条件**：某项检查通过" } }] });
  await star.sync();
  assert.deepEqual(star.events(), []);
});

test("an agent's socket that connects after undelivered pushes were dropped gets a gap frame before the ones that are left, and what it acks is not sent again", async t => {
  const wake = new Wake({ now: () => T0 });
  const { url } = await server(t, { wake });
  for (let i = 1; i <= 205; i++) wake.agent("eng").push("item-done", { item: "c" + i, project: "Whitefoot", title: "t", parent: "p" });
  const eng = await agentSocket(t, url, "eng");
  assert.deepEqual(eng.frames.slice(0, 2), [{ event: "connected", latest: 205 }, { event: "gap", oldest: 6, latest: 205 }], "the gap frame comes before the events that are left");
  assert.deepEqual([eng.events().length, eng.events()[0]!.n, eng.events().at(-1)!.n], [200, 6, 205]);
  eng.socket.send(JSON.stringify({ ack: 205 })); await eng.sync();
  const back = await agentSocket(t, url, "eng");
  assert.deepEqual(back.frames, [{ event: "connected", latest: 205 }], "delivered, so neither the pushes nor the gap are sent again");
  const live = wake.agent("eng").push("item-done", { item: "c206", project: "Whitefoot", title: "t", parent: "p" });
  await back.sync();
  assert.deepEqual(back.events(), [live]);
});

async function restart(t: Parameters<typeof board>[0], store: Awaited<ReturnType<typeof board>>["store"], op: Awaited<ReturnType<typeof board>>["op"], extra: { now?: () => number; checkIntervalMs?: number; wake?: Wake; architectTimedWakeMs?: number }) {
  const http = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: "web", createMcp: () => createMcpServer({ store, ops: op, wake: extra.wake }), ...extra });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  const address = http.address(); assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}` };
}

test("the architect's timed wake comes every hour with the items changed since the last one, without the architect's own writes but with every other session's, and a count of the items being worked on; the mark survives a restart", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const dir = await scratch(t), architectFile = join(dir, agentFileName(ARCHITECT_SESSION));
  let clock = T0;
  const wake = new Wake({ dir, now: () => clock });
  const { url, store, op, api } = await server(t, { now: () => clock, checkIntervalMs: 1000, wake });
  const doc = (title: string, group: string, plan: object[], extra: object = {}) => ({ title, group, difficulty: 2, plan: [...plan, { id: "accept", text: "某项检查通过", state: "todo", accept: true }], updated: later, head: "**完成条件**：某项检查通过", ...extra });
  await store.commit({ author, message: "Seed", puts: [
    { kind: "item", id: "arch", expectRev: null, doc: doc("架构师的条目", "Architect", [{ id: "step", text: "一步", state: "doing", since: iso(T0) }]) },
    { kind: "item", id: "work", expectRev: null, doc: doc("在做的条目", "Whitefoot", [{ id: "step", text: "当前工作", state: "doing", since: iso(T0) }]) },
    { kind: "item", id: "held", expectRev: null, doc: doc("会话拿着的条目", "Whitefoot", [{ id: "step", text: "还没标", state: "todo" }], { dispatches: [{ agentId: "h1", agent: "held-eng", role: "工程师", level: 2, model: "Sonnet", started: iso(T0) }] }) },
  ] });
  wake.agent(ARCHITECT_SESSION).markTimed({ at: iso(T0), head: store.snapshot().head });
  // After the mark: an engineer writes b and other; the architect writes a and b; another session writes area; the owner comments on a card.
  await op.appendLog({ author, session: "工程师", id: "b", text: "progress" });
  await op.appendLog({ author: "Firn", session: "工程师", id: "other", text: "progress" });
  await op.appendLog({ author, session: ARCHITECT_SESSION, id: "a", text: "reviewed" });
  await op.appendLog({ author, session: ARCHITECT_SESSION, id: "b", text: "reviewed" });
  await op.appendLog({ author, session: "巡查", id: "area", text: "patrolled" });
  // A turn the runner started to answer an engineer is not the conversation: the conversation's architect did not write this and is told.
  await op.appendLog({ author: "Architect", session: "架构师轮次", id: "work", text: "answered the engineer" });
  // The same for any other architect name: an observing architect's write is listed.
  await op.appendLog({ author: "Architect", session: "架构师·观察", id: "arch", text: "noted a rule problem" });
  await api("/api/notes", { target: "q:choice", kind: "comment", text: "owner says" });
  const star = await agentSocket(t, url, ARCHITECT_SESSION);
  clock = T0 + HOUR - 1; t.mock.timers.tick(1000); await star.sync(); await setImmediate();
  assert.deepEqual(star.events(), [], "not due yet: the architect's wake is an hour by default");
  clock = T0 + HOUR; t.mock.timers.tick(1000);
  await until(() => star.events().length, n => n === 1, "the architect's timed wake");
  const frame = star.events()[0]!;
  assert.deepEqual({ n: frame.n, at: frame.at, event: frame.event, since: frame.since }, { n: 1, at: iso(clock), event: "timed-architect", since: iso(T0) });
  assert.deepEqual(Object.keys(frame).sort(), ["at", "changed", "event", "line", "n", "since", "working"], "changes and a count, nothing else");
  const by = Object.fromEntries((frame.changed as Array<{ item: string; by: string[] }>).map(e => [e.item, e.by]));
  assert.deepEqual(by, { arch: ["架构师·观察"], area: ["巡查"], b: ["owner", "工程师"], other: ["工程师"], work: ["架构师轮次"] }, "another session's write and those of the architect's other names are listed; the architect's own writes are not why a or b is, and a is left out");
  assert.equal(frame.working, 2, "the items someone holds outside the Architect project: a step being done, or a live session");
  assert.deepEqual(wake.agent(ARCHITECT_SESSION).lastTimed, { at: iso(clock), head: store.snapshot().head });
  assert.deepEqual((await lines(architectFile)).filter(l => l.timed).at(-1), { timed: wake.agent(ARCHITECT_SESSION).lastTimed });
  t.mock.timers.tick(5000); await setImmediate();
  assert.equal(star.events().length, 1, "the next one is an hour after this one");
  // A restart keeps the mark: the next wake counts from it, not from the restart.
  star.socket.send(JSON.stringify({ ack: 1 })); await star.sync();
  await op.appendLog({ author, session: "工程师", id: "b", text: "after the wake" });
  const mark = wake.agent(ARCHITECT_SESSION).lastTimed!;
  clock += 10 * 60_000;
  const reopened = new Wake({ dir, now: () => clock });
  assert.deepEqual(reopened.agent(ARCHITECT_SESSION).lastTimed, mark); assert.equal(reopened.agent(ARCHITECT_SESSION).latest(), 1);
  const again = await restart(t, store, op, { now: () => clock, checkIntervalMs: 1000, wake: reopened });
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
  clock = T0 + HOUR - 1; a.checkOverdue();
  assert.deepEqual(told, [], "the oldest push not delivered, #2, is not yet an hour old");
  clock = T0 + HOUR; a.checkOverdue();
  assert.deepEqual(told, [["架构师 1 小时没响应", "最早没送到的是 #2：主人的留言：中文检查"]], "a delivered push is not the oldest");
  clock += HOUR; a.checkOverdue(); a.checkOverdue();
  assert.equal(told.length, 1, "one alert per silence, not one per tick");
  stream.markTimed({ at: iso(clock), head: "abc" });
  const b = open();
  b.checkOverdue();
  assert.equal(told.length, 1, "the restart remembers it already told the owner");
  assert.deepEqual(b.agent(ARCHITECT_SESSION).lastTimed, { at: iso(clock), head: "abc" }, "and the time of the last timed wake");
  b.agent(ARCHITECT_SESSION).deliver(2);
  b.push("note", noteFields("n3"));
  clock += HOUR - 1; b.checkOverdue();
  assert.equal(told.length, 1);
  clock += 1; b.checkOverdue();
  assert.equal(told.length, 2, "after a delivery the count started again, from the new push");
  assert.match(told[1]![1], /最早没送到的是 #3：/);
  // Only the architect's stream is watched for it; a session holding an item is watched by the liveness check.
  const other = new Wake({ now: () => clock });
  other.onTell(record);
  other.agent("eng").push("item-done", { item: "a", project: "Whitefoot", title: "t", parent: "p" });
  clock += 10 * HOUR; other.checkOverdue();
  assert.equal(told.length, 2);
});

async function mcpClient(t: Parameters<typeof board>[0], wake: Wake) {
  const fixture = await board(t), mcp = createMcpServer({ store: fixture.store, ops: fixture.op, wake });
  const client = new Client({ name: "Wake", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await mcp.close(); });
  return { ...fixture, client };
}

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

test("with no delivery for the limit the server's timer tells the owner once for the architect's stream; a call from the architect starts the count again", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = T0;
  const told: Array<[string, string]> = [];
  const wake = new Wake({ now: () => clock, overdueMs: 10 * 60_000 });
  wake.onTell(notice => told.push([notice.title, notice.message]));
  const { url, api } = await server(t, { now: () => clock, checkIntervalMs: 1000, wake, architectTimedWakeMs: 1e12 });
  await api("/api/notes", { target: "it:a", kind: "comment", text: "one" }); await api("/api/send", {});
  assert.equal(wake.agent(ARCHITECT_SESSION).latest(), 1);
  clock = T0 + 10 * 60_000 - 1; t.mock.timers.tick(1000);
  assert.deepEqual(told, []);
  clock++; t.mock.timers.tick(1000);
  assert.deepEqual(told, [["架构师 10 分钟没响应", "最早没送到的是 #1：主人的留言：中文检查"]]);
  t.mock.timers.tick(5000);
  assert.equal(told.length, 1, "not repeated while the silence lasts");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "Deliveries", version: "1" }), transport = new StreamableHTTPClientTransport(new URL(url + "/mcp"));
  await client.connect(transport); t.after(() => client.close());
  // A call of another session, the retired name PM included, delivers nothing to the architect's stream.
  await client.callTool({ name: "projects", arguments: { session: "PM" } });
  assert.equal(wake.agent(ARCHITECT_SESSION).deliveredUpTo(), 0);
  await api("/api/notes", { target: "it:a", kind: "comment", text: "two" }); await api("/api/send", {});
  clock += 10 * 60_000; t.mock.timers.tick(1000);
  assert.equal(told.length, 1, "the other call did not start the count again: the silence is already told");
  // The architect's call is given its own pushes, which delivers them.
  const result = await client.callTool({ name: "projects", arguments: { session: ARCHITECT_SESSION } });
  assert.match((result.content as Array<{ text: string }>).map(c => c.text).join("\n"), /【看板推送】\n#1 主人的留言 .*\n#2 主人的留言 /);
  assert.equal(wake.agent(ARCHITECT_SESSION).deliveredUpTo(), 2);
  await api("/api/notes", { target: "it:a", kind: "comment", text: "three" }); await api("/api/send", {});
  clock += 10 * 60_000; t.mock.timers.tick(1000);
  assert.equal(told.length, 2); assert.equal(told[1]![0], "架构师 10 分钟没响应"); assert.match(told[1]![1], /#3：/);
});

test("a card that stops work tells the owner once; a card without blocks, a revision that keeps blocks and a ruled card do not", async t => {
  const told: Array<[string, string]> = [];
  const wake = new Wake();
  wake.onTell(notice => told.push([notice.title, notice.message]));
  const targets: unknown[] = [];
  wake.onTell(notice => targets.push(notice.target));
  const { op } = await server(t, { wake });
  const card = { author, key: "gate", item: "a", kind: "design" as const, question: "合并吗？", confidence: { reason: "判断" }, options: [{ text: "是", detail: "合并" }] };
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

test("POST /api/wake makes the deploy pushes: to the session holding the item that delivers a pull request the commits name, else for a failure to the architect, and says how many", async t => {
  const wake = new Wake({ now: () => T0 });
  const { url, api, store, op } = await server(t, { wake });
  const star = await agentSocket(t, url, ARCHITECT_SESSION);
  // Pull request 1 of Whitefoot is delivered by item `a`, which the board's fixture has with its own 改动 section.
  const a = store.snapshot().items.a!;
  await store.commit({ author, message: "name the pull request", puts: [{ kind: "item", id: "a", expectRev: a.rev, doc: { ...a, head: `${a.head}\n\n**改动**\n\nMing-Research/Whitefoot#1` } }] });
  // Nobody holds it yet: a deploy that happened is told to nobody, one that failed to the architect.
  assert.deepEqual(await api("/api/wake", deployed), { status: 200, data: { pushed: 0 } });
  assert.deepEqual(await api("/api/wake", deployFailed), { status: 200, data: { pushed: 1 } });
  await star.sync();
  assert.deepEqual(star.events().map(({ n, at, line, ...f }) => f), [{ event: "deployFailed", version: "a".repeat(40), running: null, reason: "the daemon was not healthy", item: "a", project: "Whitefoot", title: "中文检查", pr: 1 }]);
  // An engineer holds it: both go to its stream, and the architect gets nothing more.
  await op.dispatchStart({ ...asArchitect, id: "a", role: "工程师", level: 2, model: "Sonnet", agent: "a-worker", agentId: "agent-a" });
  assert.deepEqual(await api("/api/wake", deployed), { status: 200, data: { pushed: 1 } });
  assert.deepEqual(await api("/api/wake", deployFailed), { status: 200, data: { pushed: 1 } });
  await star.sync();
  assert.equal(star.events().length, 1, "the architect hears of neither once an engineer holds the item");
  const frames = wake.agent("a-worker").pending().frames;
  assert.deepEqual(frames.map(f => [f.event, f.item, f.pr]), [["deployed", "a", 1], ["deployFailed", "a", 1]]);
  assert.deepEqual({ version: frames[0]!.version, restarted: frames[0]!.restarted }, { version: "a".repeat(40), restarted: true });
  // A deploy that names no pull request an item delivers, or whose repository is not told: the same.
  assert.deepEqual(await api("/api/wake", { ...deployed, changes: ["abc1234 Merge pull request #99 from x"] }), { status: 200, data: { pushed: 0 } });
  assert.deepEqual(await api("/api/wake", { ...deployed, repo: null }), { status: 200, data: { pushed: 0 } });
  assert.deepEqual(await api("/api/wake", { ...deployFailed, repo: null }), { status: 200, data: { pushed: 1 } });
  await star.sync();
  assert.deepEqual(star.events().map(f => [f.event, f.item]), [["deployFailed", "a"], ["deployFailed", null]]);
});

test("POST /api/wake refuses every other kind, every other field set and every bad body, and sends nothing", async t => {
  const { url, api, port } = await server(t);
  const star = await agentSocket(t, url, ARCHITECT_SESSION);
  const { event, ...fields } = deployed;
  const refused = async (what: string, body: unknown) => {
    const response = await api("/api/wake", body);
    assert.equal(response.status, 400, `${what}: ${JSON.stringify(response.data)}`);
    assert.equal(typeof response.data.error, "string", what);
  };
  // The board's own kinds, with exactly their own fields: the daemon is their only source.
  await refused("note", { event: "note", ...noteFields("n1") });
  // The kinds that were pushed to the PM are gone from the table, so they are unknown kinds like any other name.
  await refused("stalled", { event: "stalled", item: "a", project: "Whitefoot", title: "t", text: "x" });
  await refused("pr-red", { event: "pr-red", repo: "o/r", number: 1, project: "p", title: "t", commit: "c", failed: [], url: "u", items: [] });
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
  assert.deepEqual(star.events().map(f => f.n), [1], "only the control request was sent (a failed deploy no item explains goes to the architect)");
});

test("a told notice goes to each listener with its card or item; a listener added later gets none of the earlier ones", () => {
  const told: string[] = [];
  const wake = new Wake({ now: () => Date.parse("2026-10-16T10:00:00Z") });
  wake.tell("挡事的卡 · Whitefoot", "问题", { kind: "card", key: "choice" });
  const off = wake.onTell(notice => told.push(JSON.stringify(notice)));
  wake.tell("架构师 一小时没响应", "最早没送到的是 #3", { kind: "item", key: "a" });
  off();
  wake.tell("之后", "没人听");
  assert.deepEqual(told, [JSON.stringify({ title: "架构师 一小时没响应", message: "最早没送到的是 #3", target: { kind: "item", key: "a" } })]);
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

test("an overdue notice opens the item or card its oldest undelivered push is about, and none when that push has no target", () => {
  let clock = T0;
  const targets: unknown[] = [];
  const overdue = (event: Parameters<Wake["push"]>[0], fields: Record<string, unknown>) => {
    const wake = new Wake({ now: () => clock, overdueMs: 60_000 });
    wake.onTell(notice => targets.push(notice.target));
    wake.push(event, fields);
    clock += 60_000; wake.checkOverdue();
  };
  overdue("note", { note: "n1", target: "q:choice", kind: "comment", title: "问题", project: "Whitefoot" });
  overdue("note", { note: "n2", target: "it:a", kind: "comment", title: "中文检查", project: "Whitefoot" });
  overdue("timed-architect", { since: "2026-10-16T09:00:00Z", changed: [], working: 0 });
  overdue("slow-op", { op: "tool brief", ms: 4000, limitMs: 1000, params: "" });
  assert.deepEqual(targets, [{ kind: "card", key: "choice" }, { kind: "item", key: "a" }, undefined, undefined], "a note on a card or an item opens it; a timed wake or a slow operation names none, so the click opens the home view");
});
