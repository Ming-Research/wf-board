// Messages between agents (docs/design.md, Messages): who may receive one, what it may say, where it is kept, and how it
// reaches its recipient.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { agentSocket, asArchitect, board, later, server } from "./helpers.ts";
import { MESSAGE_TEXT_LIMIT } from "../src/model.ts";
import { OpError, ops } from "../src/ops.ts";
import type { Ops } from "../src/ops.ts";
import { Store } from "../src/store.ts";
import { FOOTER_HEAD, Wake } from "../src/wake.ts";
import { createMcpServer } from "../src/mcp.ts";
import { PAGE_MESSAGES, pageSnapshot } from "../src/http.ts";

const eng = { author: "Whitefoot", session: "b-worker" };
const refusedWith = (pattern: RegExp) => (error: unknown) => error instanceof OpError && pattern.test(error.message);
const usage = { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 };
/** Poll for what the server does after a write; its listeners run after the write's promise settles. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(done(), `timed out waiting for ${what}`);
}
/** One tool call over a fresh MCP connection, as an agent makes it: the text of its answer. */
async function tool(t: { after(fn: () => void | Promise<void>): void }, store: Store, op: Ops, wake: Wake | undefined, name: string, args: Record<string, unknown>): Promise<string> {
  const mcp = createMcpServer({ store, ops: op, wake }), client = new Client({ name: "Messages", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await mcp.close(); });
  const result = await client.callTool({ name, arguments: args });
  return (result.content as Array<{ text: string }>).map(c => c.text).join("\n");
}

test("a message is one commit that adds it to its day's file, kept across a restart, and starts no active time", async t => {
  const { dir, store } = await board(t);
  let clock = later;
  const op = ops(store, () => clock);
  const writes = store.snapshot().activity?.writes.length ?? 0;
  const sent = await op.sendMessage({ ...eng, to: "架构师", text: "b 的 PR 可以看了，等你验收", item: "b" });
  assert.match(sent.id, /^20261011T020304Z-[0-9a-f]{4}$/, "named by the time it was sent");
  const first = { id: sent.id, from: "b-worker", project: "Whitefoot", to: "架构师", text: "b 的 PR 可以看了，等你验收", item: "b", at: later };
  assert.deepEqual(store.snapshot().messages, { "2026-10-11": { messages: [first], rev: 1 } });
  const [commit] = await store.log({ limit: 1 });
  assert.deepEqual([commit!.files, commit!.author, commit!.session], [["messages/2026-10-11.yaml"], "Whitefoot", "b-worker"]);
  assert.equal(store.snapshot().activity?.writes.length ?? 0, writes, "a message is no work on the board");
  // Two in the same second get two ids; they join the end of the day's file. The next UTC day starts a file of its own.
  const again = await op.sendMessage({ ...eng, to: "架构师", text: "再看一下" });
  const third = await op.sendMessage({ ...eng, to: "架构师", text: "又一条" });
  clock = "2026-10-12T00:00:01Z";
  const nextDay = await op.sendMessage({ ...eng, to: "架构师", text: "第二天" });
  const days = store.snapshot().messages!;
  assert.deepEqual(Object.keys(days).sort(), ["2026-10-11", "2026-10-12"]);
  assert.deepEqual(days["2026-10-11"]!.messages.map(m => m.id), [sent.id, again.id, third.id]);
  assert.equal(new Set([sent.id, again.id, third.id]).size, 3);
  assert.deepEqual([days["2026-10-11"]!.rev, days["2026-10-12"]!.messages.map(m => m.id)], [3, [nextDay.id]]);
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files, ["messages/2026-10-12.yaml"]);
  const reopened = await Store.open(dir);
  assert.deepEqual(reopened.snapshot().messages, store.snapshot().messages);
  assert.equal(reopened.snapshot().activity?.writes.length ?? 0, writes, "nor when the history is read again");
});

test("a message to a name the board cannot reach, or one that is too long, not one line or about no item, is refused and writes nothing", async t => {
  const { store, op } = await board(t);
  const head = store.snapshot().head;
  await assert.rejects(op.sendMessage({ ...eng, to: "nobody", text: "看 a" }), refusedWith(/^to nobody: no session the board can reach has that name; send to one of: 架构师$/));
  await assert.rejects(op.sendMessage({ ...eng, to: "架构师", text: "长".repeat(MESSAGE_TEXT_LIMIT + 1) }), refusedWith(/^text: 151 characters, at most 150; a message is only a doorbell: write the content on the item/));
  await assert.rejects(op.sendMessage({ ...eng, to: "架构师", text: "第一行\n第二行" }), refusedWith(/^text: write one line/));
  await assert.rejects(op.sendMessage({ ...eng, to: "架构师", text: "  " }), refusedWith(/^input\.text: provide nonempty text/));
  await assert.rejects(op.sendMessage({ ...eng, to: "架构师", text: "看看", item: "missing" }), refusedWith(/^item missing: not on the board/));
  await assert.rejects(op.sendMessage({ author: "Whitefoot", to: "架构师", text: "看看" }), refusedWith(/^session: a message says who sent it/));
  assert.equal(store.snapshot().head, head, "nothing was written");
  assert.deepEqual(store.snapshot().messages, {});
  // The limit counts characters, a Chinese character as one: 150 of them is the most, and taken whole.
  const full = "满".repeat(MESSAGE_TEXT_LIMIT);
  const { id } = await op.sendMessage({ ...eng, to: " 架构师 ", text: full });
  const kept = store.snapshot().messages!["2026-10-11"]!.messages.find(m => m.id === id)!;
  assert.deepEqual([kept.text, kept.to], [full, "架构师"]);
});

test("a message goes to the architect, to a session with an open dispatch of an engineer or a review, or to a long-lived credential's session, and not to an architect's turn", async t => {
  const { store } = await board(t);
  const op = ops(store, () => later, { sessions: () => ["观察者", "资源管理"] });
  await op.dispatchStart({ ...asArchitect, id: "b", role: "审查", level: 2, model: "Sonnet", agent: "b-review", agentId: "agent-r" });
  for (const to of ["架构师", "观察者", "资源管理", "b-review"]) await op.sendMessage({ ...eng, to, text: "看 b" });
  assert.deepEqual(Object.values(store.snapshot().messages!).flatMap(day => day.messages).map(m => m.to).sort(), ["b-review", "架构师", "观察者", "资源管理"].sort());
  await op.dispatchFinish({ ...asArchitect, id: "b", agentId: "agent-r", result: "一次通过", usage, cost: 1, rounds: 1 });
  await assert.rejects(op.sendMessage({ ...eng, to: "b-review", text: "看 b" }), refusedWith(/^to b-review: no session the board can reach has that name; send to one of: 架构师, 观察者, 资源管理$/), "a dispatch that ended reaches no one");
  await assert.rejects(op.sendMessage({ ...eng, to: "PM", text: "看 b" }), refusedWith(/^to PM: no session the board can reach has that name; send to one of: 架构师, 观察者, 资源管理$/), "the retired PM is reached no more");
  // An architect's turn, open on the item, is no session that works on it and reads no stream of its own: the list of names that work leaves it out.
  await op.dispatchStart({ ...asArchitect, id: "b", role: "架构师", level: 5, model: "Fable", agent: "架构师轮次", agentId: "turn-1" });
  await assert.rejects(op.sendMessage({ ...eng, to: "架构师轮次", text: "看 b" }), refusedWith(/^to 架构师轮次: no session the board can reach has that name; send to one of: 架构师, 观察者, 资源管理$/), "an open turn is reached no more than an ended review");
});

test("a message waits in its recipient's stream until a board call or its socket takes it, once; one to the architect goes to the architect's own stream", async t => {
  const wake = new Wake({ now: () => Date.parse(later) });
  const { url, store, op } = await server(t, { wake });
  await op.dispatchStart({ ...asArchitect, id: "b", role: "工程师", level: 2, model: "Sonnet", agent: "b-worker", agentId: "agent-1" });
  const architect = await agentSocket(t, url, "架构师");
  // No process is connected: the message waits in the stream.
  const first = await op.sendMessage({ ...asArchitect, to: "b-worker", text: "先看 a 的卡", item: "a" });
  await until(() => wake.hasAgent("b-worker") && wake.agent("b-worker").latest() === 1, "the first message's push");
  const [frame] = wake.agent("b-worker").pending().frames;
  assert.deepEqual({ ...frame, at: undefined }, { n: 1, at: undefined, event: "message", message: first.id, from: "架构师", project: "Architect", to: "b-worker", item: "a", text: "先看 a 的卡", line: "#1 消息 · 架构师（Architect） · it:a：先看 a 的卡" });
  // Its next board call carries it, and only that call.
  const plain = await tool(t, store, op, undefined, "projects", { session: "b-worker" });
  assert.equal(await tool(t, store, op, wake, "projects", { session: "b-worker" }), `${plain}\n\n${FOOTER_HEAD}\n${frame!.line}`);
  assert.equal(await tool(t, store, op, wake, "projects", { session: "b-worker" }), plain, "delivered once");
  // A second message reaches the socket the wait script opens; after its ack it is not given again, by socket or by a call.
  await op.sendMessage({ ...asArchitect, to: "b-worker", text: "再看 b", item: "b" });
  await until(() => wake.agent("b-worker").latest() === 2, "the second message's push");
  const socket = await agentSocket(t, url, "b-worker");
  assert.deepEqual(socket.events().map(f => [f.n, f.text]), [[2, "再看 b"]], "the first, delivered, is not replayed");
  socket.socket.send(JSON.stringify({ ack: 2 })); await socket.sync();
  assert.deepEqual((await agentSocket(t, url, "b-worker")).events(), []);
  assert.equal(await tool(t, store, op, wake, "projects", { session: "b-worker" }), plain);
  // To the architect: its own agent stream, and not another agent's.
  await op.sendMessage({ ...eng, to: "架构师", text: "b 好了", item: "b" });
  await until(() => architect.frames.some(f => f.event === "message"), "the message to the architect");
  assert.deepEqual(architect.events().filter(f => f.event === "message").map(f => [f.from, f.to, f.text]), [["b-worker", "架构师", "b 好了"]]);
  assert.equal(wake.agent("b-worker").latest(), 2);
});

test("send_message sends as the call's session; messages lists them newest first, by recipient, sender, item and time", async t => {
  const { store } = await board(t);
  let clock = "2026-10-11T02:00:00Z";
  const op = ops(store, () => clock, { sessions: () => ["观察者"] });
  const send = (session: string, args: Record<string, unknown>) => tool(t, store, op, undefined, "send_message", { author: "Whitefoot", session, ...args });
  assert.match(await send("eng-a", { to: "架构师", text: "看 a", item: "a" }), /^send_message 20261011T020000Z-[0-9a-f]{4} to 架构师 · commit [0-9a-f]{40}$/);
  clock = "2026-10-11T02:10:00Z";
  await send("eng-b", { to: "观察者", text: "规则有个问题，见 b 的日志", item: "b" });
  clock = "2026-10-11T02:20:00Z";
  await send("eng-a", { to: "观察者", text: "没事了" });
  assert.match(await send("eng-a", { to: "nobody", text: "x" }), /^to nobody: no session the board can reach has that name; send to one of: 架构师, 观察者$/);
  const list = (filters?: Record<string, unknown>) => tool(t, store, op, undefined, "messages", filters ? { filters } : {});
  assert.equal(await list(), [
    "2026-10-11T02:20:00Z · eng-a（Whitefoot）→ 观察者：没事了",
    "2026-10-11T02:10:00Z · eng-b（Whitefoot）→ 观察者 · it:b：规则有个问题，见 b 的日志",
    "2026-10-11T02:00:00Z · eng-a（Whitefoot）→ 架构师 · it:a：看 a",
  ].join("\n"));
  assert.equal(await list({ to: "观察者", from: "eng-a" }), "2026-10-11T02:20:00Z · eng-a（Whitefoot）→ 观察者：没事了");
  assert.equal(await list({ item: "a" }), "2026-10-11T02:00:00Z · eng-a（Whitefoot）→ 架构师 · it:a：看 a");
  assert.match(await list({ since: "2026-10-11T02:10Z", until: "2026-10-11T02:20Z" }), /^2026-10-11T02:10:00Z · eng-b/, "since inclusive, until exclusive");
  assert.equal((await list({ since: "2026-10-11T02:10Z", until: "2026-10-11T02:20Z" })).split("\n").length, 1);
  assert.equal((await list({ limit: 2 })).split("\n").length, 2);
  assert.equal(await list({ to: "nobody" }), "No messages.");
});

test("the page is sent the days holding the newest PAGE_MESSAGES messages; the board keeps them all", async t => {
  const { store } = await board(t);
  const s = store.snapshot();
  // Five days of 60 messages: the newest 200 lie in the last four days, so the first is left out.
  const day = (d: number, n: number) => ({ messages: Array.from({ length: n }, (_, i) => ({ id: `2026101${d}T0000${String(i).padStart(2, "0")}Z-0000`, from: "a", project: "Whitefoot", to: "架构师", text: String(i), at: `2026-10-1${d}T00:00:${String(i).padStart(2, "0")}Z` })), rev: 1 });
  const days = Object.fromEntries([1, 2, 3, 4, 5].map(d => [`2026-10-1${d}`, day(d, 60)]));
  const sent = pageSnapshot({ ...s, messages: days });
  assert.deepEqual(Object.keys(sent.messages!).sort(), ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"], "the oldest day is left out");
  assert.equal(sent.items, s.items, "everything else is the board as it is");
  const few = { ...s, messages: { "2026-10-11": day(1, 60), "2026-10-12": day(2, 60) } };
  assert.equal(pageSnapshot(few), few, "a board with fewer messages is sent as it is");
});
