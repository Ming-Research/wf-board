// Messages between agents (docs/design.md, Messages): who may receive one, what it may say, where it is kept, and how it
// reaches its recipient.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { agentSocket, asArchitect, board, later, server, wakeSocket } from "./helpers.ts";
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

test("a message is one commit of one file, kept across a restart, and starts no active time", async t => {
  const { dir, store, op } = await board(t);
  const writes = store.snapshot().activity?.writes.length ?? 0;
  const sent = await op.sendMessage({ ...eng, to: "架构师", text: "b 的 PR 可以看了，等你验收", item: "b" });
  assert.match(sent.id, /^20261011T020304Z-[0-9a-f]{4}$/, "named by the time it was sent");
  assert.deepEqual(store.snapshot().messages![sent.id], { from: "b-worker", project: "Whitefoot", to: "架构师", text: "b 的 PR 可以看了，等你验收", item: "b", at: later, rev: 1 });
  const [commit] = await store.log({ limit: 1 });
  assert.deepEqual([commit!.files, commit!.author, commit!.session], [[`messages/${sent.id}.yaml`], "Whitefoot", "b-worker"]);
  assert.equal(store.snapshot().activity?.writes.length ?? 0, writes, "a message is no work on the board");
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
  assert.deepEqual([store.snapshot().messages![id]!.text, store.snapshot().messages![id]!.to], [full, "架构师"]);
});

test("a message goes to the architect, to a session with an open dispatch of any role, or to a long-lived credential's session", async t => {
  const { store } = await board(t);
  const op = ops(store, () => later, { sessions: () => ["观察者", "资源管理"] });
  await op.dispatchStart({ ...asArchitect, id: "b", role: "审查", level: 2, model: "Sonnet", agent: "b-review", agentId: "agent-r" });
  for (const to of ["架构师", "观察者", "资源管理", "b-review"]) await op.sendMessage({ ...eng, to, text: "看 b" });
  assert.deepEqual(Object.values(store.snapshot().messages!).map(m => m.to).sort(), ["b-review", "架构师", "观察者", "资源管理"].sort());
  await op.dispatchFinish({ ...asArchitect, id: "b", agentId: "agent-r", result: "一次通过", usage, cost: 1, rounds: 1 });
  await assert.rejects(op.sendMessage({ ...eng, to: "b-review", text: "看 b" }), refusedWith(/^to b-review: no session the board can reach has that name; send to one of: 架构师, 观察者, 资源管理$/), "a dispatch that ended reaches no one");
});

test("a message waits in its recipient's stream until a board call or its socket takes it, once; one to the architect goes to the PM's stream", async t => {
  const wake = new Wake({ now: () => Date.parse(later) });
  const { url, store, op } = await server(t, { wake });
  await op.dispatchStart({ ...asArchitect, id: "b", role: "工程师", level: 2, model: "Sonnet", agent: "b-worker", agentId: "agent-1" });
  const pm = await wakeSocket(t, url);
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
  // To the architect: the PM's own stream, and no agent's.
  await op.sendMessage({ ...eng, to: "架构师", text: "b 好了", item: "b" });
  await until(() => pm.frames.some(f => f.event === "message"), "the message to the architect");
  assert.deepEqual(pm.events().filter(f => f.event === "message").map(f => [f.from, f.to, f.text]), [["b-worker", "架构师", "b 好了"]]);
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

test("the page is sent the newest PAGE_MESSAGES messages; the board keeps them all", async t => {
  const { store } = await board(t);
  const s = store.snapshot();
  const at = (i: number) => new Date(Date.parse("2026-10-11T00:00:00Z") + i * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const id = (i: number) => `${at(i).replace(/[-:]/g, "")}-0000`;
  const many = Object.fromEntries(Array.from({ length: PAGE_MESSAGES + 1 }, (_, i) => [id(i), { from: "a", project: "Whitefoot", to: "架构师", text: String(i), at: at(i), rev: 1 }]));
  const sent = pageSnapshot({ ...s, messages: many });
  assert.deepEqual(Object.keys(sent.messages!).sort(), Array.from({ length: PAGE_MESSAGES }, (_, i) => id(i + 1)), "the oldest is left out");
  assert.equal(sent.items, s.items, "everything else is the board as it is");
  const few = { ...s, messages: { [id(0)]: many[id(0)]! } };
  assert.equal(pageSnapshot(few), few, "a board with few messages is sent as it is");
});
