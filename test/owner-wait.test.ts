import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rules } from "../src/rules.ts";
import type { Snapshot } from "../src/model.ts";
import { board, author, later, at } from "./helpers.ts";
import { ownerOps, NotFoundError } from "../src/owner-ops.ts";
import { createHttpServer } from "../src/http.ts";
import { createMcpServer } from "../src/mcp.ts";
import { unreadSteps } from "../src/history.ts";
import { changes } from "../src/query.ts";

const doc = (fields: object) => ({ title: "t", updated: at, rev: 1, log: [], plan: [{ id: "accept", accept: true, text: "验收通过", state: "todo" }], group: "P", links: [], ...fields });
const card = (item: string, fields: object = {}) => ({ item, question: "Q?", background: "b", options: [{ key: "A", text: "a" }], status: "open", updated: at, rev: 1, ...fields });
function owned(): Pick<Snapshot, "board" | "items" | "decisions" | "notes" | "owner"> {
  return {
    board: { title: "T", projects: [{ name: "P" }] }, owner: {}, notes: {},
    items: {
      root: doc({ group: "P", ask: { text: "Merge it" }, plan: [{ id: "kid", item: "kid", own: true }, { id: "accept", accept: true, text: "验收通过", state: "todo" }] }),
      kid: doc({  }),
      plainOnly: doc({ group: "P",  }),
    },
    decisions: {
      blocks: card("kid", { blocks: "#398 合并停着" }), plain: card("kid"), ruled: card("kid", { blocks: "x", status: "ruled" }), onlyPlain: card("plainOnly"),
    },
  } as never;
}

test("rules: a waiting card with blocks is blocking, an ask always is, and the two counts split the subtree", () => {
  const s = owned(), r = rules(s);
  assert.equal(r.cardBlocking("blocks"), true);
  assert.equal(r.cardBlocking("plain"), false, "a waiting card without blocks does not block");
  assert.equal(r.cardWaiting("plain"), true);
  assert.equal(r.cardBlocking("ruled"), false, "a ruled card with blocks no longer blocks");
  assert.equal(r.ownerBlocking("kid"), true);
  assert.equal(r.ownerBlocking("plainOnly"), false, "an item with only a non-blocking card is not blocking");
  assert.equal(r.needsOwner("plainOnly"), true);
  assert.equal(r.ownerBlocking("root"), true, "an ask alone blocks");
  assert.equal(r.blockingBelow("root"), 2, "the root's ask plus the blocking card below");
  assert.equal(r.nonBlockingBelow("root"), 1);
  assert.equal(r.blockingBelow("kid"), 1);
  assert.equal(r.blockingBelow("plainOnly"), 0);
  assert.equal(r.nonBlockingBelow("plainOnly"), 1);
  // A sent choice answers the card, so it neither waits nor blocks.
  s.notes = { c: { target: "q:blocks", kind: "choice", choice: "A", text: "A", at, state: "sent", rev: 1 } } as never;
  const answered = rules(s);
  assert.equal(answered.cardBlocking("blocks"), false);
  assert.equal(answered.blockingBelow("root"), 1);
});

async function mcp(t: Parameters<typeof board>[0]) {
  const fixture = await board(t), server = createMcpServer({ store: fixture.store, ops: fixture.op });
  const client = new Client({ name: "Owner wait", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>).map(c => c.text).join("\n");
  return { ...fixture, client, text };
}
const cardArgs = { author, key: "gate", item: "a", question: "合并吗？", background: "背景", options: [{ key: "A", text: "是", recommended: true }] };

test("write_card stores blocks, a revision can keep, replace or clear it, and context and brief show it", async t => {
  const { client, text, store } = await mcp(t);
  const created = await client.callTool({ name: "write_card", arguments: { ...cardArgs, blocks: "#398 合并停着" } });
  assert.equal(created.isError, undefined, text(created));
  assert.equal(store.snapshot().decisions.gate!.blocks, "#398 合并停着");
  assert.match(text(await client.callTool({ name: "context", arguments: { id: "gate" } })), /blocks: #398 合并停着/);
  assert.match(text(await client.callTool({ name: "context", arguments: { id: "a" } })), /blocks: #398 合并停着/);
  assert.match(text(await client.callTool({ name: "brief", arguments: { project: "Whitefoot" } })), /"blocks":"#398 合并停着"/);
  const kept = await client.callTool({ name: "write_card", arguments: { ...cardArgs, rev: 1, question: "合并吗？（改）" } });
  assert.equal(kept.isError, undefined, text(kept)); assert.equal(store.snapshot().decisions.gate!.blocks, "#398 合并停着", "omitted blocks keeps it");
  const cleared = await client.callTool({ name: "write_card", arguments: { ...cardArgs, rev: 2, blocks: null } });
  assert.equal(cleared.isError, undefined, text(cleared));
  assert.equal(store.snapshot().decisions.gate!.blocks, undefined, "null clears blocks");
  assert.doesNotMatch(text(await client.callTool({ name: "context", arguments: { id: "gate" } })), /blocks:/);
  const set = await client.callTool({ name: "write_card", arguments: { ...cardArgs, rev: 3, blocks: "新的停工" } });
  assert.equal(set.isError, undefined, text(set)); assert.equal(store.snapshot().decisions.gate!.blocks, "新的停工", "a revision can set it");
  const empty = await client.callTool({ name: "write_card", arguments: { ...cardArgs, rev: 4, blocks: "  " } });
  assert.equal(empty.isError, true, "blank blocks is refused");
  const tool = (await client.listTools()).tools.find(x => x.name === "write_card")!;
  assert.match((tool.inputSchema.properties!.blocks as { description: string }).description, /Set it only when named work/);
});

test("post_notice stores an unread notice from any project and refuses an unknown item or author", async t => {
  const { client, text, store } = await mcp(t);
  const ok = await client.callTool({ name: "post_notice", arguments: { author: "Firn", text: "规则改了，见 [[it:a]]。", item: "a" } });
  assert.equal(ok.isError, undefined, text(ok));
  const [id, n] = Object.entries(store.snapshot().notices)[0]!;
  assert.ok(id); assert.deepEqual({ ...n!, rev: 0 }, { text: "规则改了，见 [[it:a]]。", item: "a", author: "Firn", at: n!.at, rev: 0 });
  assert.equal(n!.read, undefined);
  assert.equal((await client.callTool({ name: "post_notice", arguments: { author: "Firn", text: "x", item: "missing" } })).isError, true);
  assert.equal((await client.callTool({ name: "post_notice", arguments: { author: "Nobody", text: "x" } })).isError, true);
  assert.equal(Object.keys(store.snapshot().notices).length, 1);
  const tool = (await client.listTools()).tools.find(x => x.name === "post_notice")!;
  assert.match(tool.description!, /not blocking.*blocks/s);
});

test("the owner marks one notice or all notices read, once, and unknown ids are refused", async t => {
  const { store, op } = await board(t), own = ownerOps(store, () => later);
  for (const text of ["一", "二", "三"]) await op.postNotice({ author, text });
  const [first, second, third] = Object.keys(store.snapshot().notices);
  assert.deepEqual((await own.readNotice({ id: first! })).marked, [first]);
  assert.equal(store.snapshot().notices[first!]!.read, later);
  assert.equal(store.snapshot().notices[second!]!.read, undefined, "other notices stay unread");
  const head = store.snapshot().head;
  assert.deepEqual((await own.readNotice({ id: first! })).marked, [], "an already read notice changes nothing");
  assert.equal(store.snapshot().head, head);
  assert.deepEqual((await own.readNotice({ all: true })).marked.sort(), [second, third].sort());
  assert.ok(Object.values(store.snapshot().notices).every(n => n.read === later));
  await assert.rejects(own.readNotice({ id: "nope" }), NotFoundError);
});

async function wakeServer(t: Parameters<typeof board>[0]) {
  const fixture = await board(t), { store, op } = fixture;
  const http = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: join(import.meta.dirname, "../web"), createMcp: () => createMcpServer({ store, ops: op }) });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(() => new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve())));
  const address = http.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const sockets = ["*", "Whitefoot", "Firn"].map(s => new WebSocket(url.replace("http:", "ws:") + "/wake?session=" + encodeURIComponent(s)));
  t.after(() => sockets.forEach(s => s.terminate()));
  await Promise.all(sockets.map(s => once(s, "open")));
  const frames: Array<Array<Record<string, unknown>>> = sockets.map(() => []);
  sockets.forEach((s, i) => s.on("message", d => frames[i]!.push(JSON.parse(d.toString()))));
  const settle = async () => { for (const s of sockets) { const pong = once(s, "pong"); s.ping(); await pong; } };
  return { ...fixture, url, frames, settle };
}

test("wake: a blocking card or an ask emits a blocking event once; a non-blocking card emits none", async t => {
  const { op, store, frames, settle, url } = await wakeServer(t);
  await op.writeCard({ ...cardArgs, key: "plain" }); await settle();
  assert.deepEqual(frames.map(f => f.length), [0, 0, 0], "a card without blocks wakes nothing");
  await op.writeCard({ ...cardArgs, key: "hard", blocks: "#398 合并停着" }); await settle();
  assert.deepEqual(frames[0], [{ event: "blocking", kind: "card", key: "hard", item: "a", project: "Whitefoot", text: "#398 合并停着", question: "合并吗？" }]);
  assert.deepEqual(frames.map(f => f.length), [1, 1, 0], "the wildcard and the owning project hear it");
  await op.writeCard({ ...cardArgs, key: "hard", rev: 1, blocks: "#398 合并停着", question: "改写" }); await settle();
  assert.equal(frames[0]!.length, 1, "revising without changing blocks wakes nothing");
  await op.writeCard({ ...cardArgs, key: "plain", rev: 1, blocks: "现在停了" }); await settle();
  assert.equal(frames[0]!.length, 2, "a card that gains blocks wakes");
  assert.equal(frames[0]![1]!.key, "plain");
  const other = store.snapshot().items.other!;
  await store.commit({ author, message: "set ask", puts: [{ kind: "item", id: "other", expectRev: other.rev, doc: { ...other, ask: { text: "请合并" } } }] }); await settle();
  assert.deepEqual(frames[2], [{ event: "blocking", kind: "ask", key: "other", item: "other", project: "Firn", text: "请合并" }]);
  // The owner's HTTP route marks a posted notice read.
  await op.postNotice({ author, text: "通知" });
  const id = Object.keys(store.snapshot().notices)[0]!;
  const res = await fetch(url + "/api/notice-read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { marked: [id] });
  assert.ok(store.snapshot().notices[id]!.read);
  assert.equal((await fetch(url + "/api/notice-read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "nope" }) })).status, 404);
});

test("posting a notice makes no unread step and no entry in changes", async t => {
  const { store, op } = await board(t), before = store.snapshot().head;
  const control = await op.setPlan({ author, id: "a", row: { id: "progress", state: "todo", text: "control change" } });
  assert.equal((await unreadSteps(store, before)).length, 1, "a real change after the cursor is unread");
  assert.ok((await changes(store, store.snapshot(), before)).length > 0);
  const mid = store.snapshot().head;
  assert.ok(control.commit);
  await op.postNotice({ author, text: "通知" });
  assert.notEqual(store.snapshot().head, mid, "the notice was committed");
  assert.equal((await unreadSteps(store, mid)).length, 0, "the notice adds no unread step");
  assert.deepEqual(await changes(store, store.snapshot(), mid), [], "the notice is not a change");
});
