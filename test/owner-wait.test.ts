import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rules } from "../src/rules.ts";
import type { Snapshot } from "../src/model.ts";
import { board, author, at } from "./helpers.ts";
import { createMcpServer } from "../src/mcp.ts";

const doc = (fields: object) => ({ title: "t", updated: at, rev: 1, log: [], plan: [{ id: "accept", accept: true, text: "验收通过", state: "todo" }], group: "P", links: [], ...fields });
const card = (item: string, fields: object = {}) => ({ item, question: "Q?", options: [{ key: "A", text: "a" }], status: "open", updated: at, rev: 1, ...fields });
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
  // Ruling the card (the board does it when the owner sends the pick) ends the wait and the block; a sent note alone does not.
  s.notes = { c: { target: "q:blocks", kind: "choice", choice: "A", text: "A", at, state: "sent", rev: 1 } } as never;
  assert.equal(rules(s).cardBlocking("blocks"), true);
  s.decisions.blocks = { ...s.decisions.blocks!, status: "ruled", choice: "A" };
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
const cardArgs = { author, key: "gate", item: "a", question: "合并吗？", confidence: { score: 3, reason: "只凭判断" }, options: [{ text: "是", detail: "合并，之后的工作可以开始", recommended: true }] };

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

test("write_card replies with the option check of a card that has fewer than three options", async t => {
  const { client, text } = await mcp(t);
  const two = [{ text: "是", detail: "合并" }, { text: "否", detail: "不合并" }];
  const short = await client.callTool({ name: "write_card", arguments: { ...cardArgs, options: two } });
  assert.equal(short.isError, undefined, text(short));
  assert.match(text(short), /\ncheck: 决策卡只有 2 个选项，至少要给三个都走得通的做法$/, "the writer sees the check in the reply");
  const full = await client.callTool({ name: "write_card", arguments: { ...cardArgs, key: "full", options: [...two, { text: "以后", detail: "过几天再说" }] } });
  assert.equal(full.isError, undefined, text(full));
  assert.doesNotMatch(text(full), /check: /, "three options get no check");
});
