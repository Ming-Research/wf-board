import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, formatChanges } from "../src/mcp.ts";
import { board, author } from "./helpers.ts";

test("SDK client discovers exactly twenty described tools, reads/writes fresh state and receives tool errors", async t => {
  const { store, op } = await board(t), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Test agent", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(t => t.name).sort(), ["search", "context", "graph", "overview", "list", "notes", "prs", "changes", "history", "diff", "create_item", "append_log", "update_item", "set_status", "move_item", "set_ask", "clear_ask", "write_card", "rule_card", "reply_note"].sort());
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 30);
    for (const [key, value] of Object.entries(tool.inputSchema.properties ?? {})) assert.ok((value as { description?: string }).description, `${tool.name}.${key} describes its parameter`);
  }
  assert.match(client.getInstructions()!, /append_log.*set_status.*why.*stamps times/);
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as Array<{ type: string; text: string }>).filter(c => c.type === "text").map(c => c.text).join("\n");
  const read = await client.callTool({ name: "context", arguments: { id: "a" } });
  assert.equal(read.isError, undefined); assert.match(text(read), /a · TODO P0 · 中文检查 · Whitefoot › area/);
  assert.match(text(read), /priority: P1 · effective P0 · raised by b/);
  assert.match(text(read), /5 shown; 2 earlier/);
  const write = await client.callTool({ name: "append_log", arguments: { author, id: "a", text: "MCP evidence" } });
  assert.equal(write.isError, undefined); assert.match(text(write), /append_log a · rev 2 · commit [a-f0-9]{40}/);
  assert.match(text(await client.callTool({ name: "context", arguments: { id: "a" } })), /MCP evidence/);
  const before = store.snapshot();
  const refused = await client.callTool({ name: "set_status", arguments: { author, id: "area", status: "done", log: "Not a leaf" } });
  assert.equal(refused.isError, true); assert.match(text(refused), /status.*derived.*sub-item/); assert.deepEqual(store.snapshot(), before);
  const unknown = await client.callTool({ name: "context", arguments: { id: "missing" } });
  assert.equal(unknown.isError, true); assert.match(text(unknown), /Unknown id/);
  const stale = await client.callTool({ name: "update_item", arguments: { author, id: "a", rev: 1, title: "Stale" } });
  assert.equal(stale.isError, true); assert.match(text(stale), /current rev 2.*\+1 log/);
  const extra = await client.callTool({ name: "update_item", arguments: { author, id: "a", rev: 2, status: "done" } });
  assert.equal(extra.isError, true); assert.deepEqual(store.snapshot(), before);
  const search = await client.callTool({ name: "search", arguments: { query: "中文", filters: { kind: ["note"], limit: 1 } } });
  assert.match(text(search), /«中文»/);
});

test("cached rules refresh when owner state changes without a new commit", async t => {
  const { store, op } = await board(t), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Archive test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const before = store.snapshot().head;
  const initial = await client.callTool({ name: "list", arguments: { filters: { hasChecks: true } } });
  assert.ok(initial.content);
  await op.setStatus({ author, id: "b", status: "wip", log: "Work alongside blockers" });
  const unarchived = await client.callTool({ name: "list", arguments: { filters: { hasChecks: true } } });
  assert.match(JSON.stringify(unarchived.content), /b · WIP/);
  const head = store.snapshot().head;
  assert.notEqual(before, head);
  store.setOwner({ archived: { b: "2999-01-01T00:00:00Z" } });
  assert.equal(store.snapshot().head, head);
  const archived = await client.callTool({ name: "list", arguments: { filters: { hasChecks: true } } });
  assert.match(JSON.stringify(archived.content), /No items/);
});

test("changes output stops at the limit and says how many documents it left out", () => {
  const doc = (id: string) => ({ kind: "item" as const, id, title: id, summary: "new item", commits: [{ commit: "a".repeat(40), at: "2026-10-11T00:00:00Z", author: "migration", message: "Import", files: [] }] });
  const groups = [{ areaId: "x", area: "X", documents: [doc("a"), doc("b")] }, { areaId: "y", area: "Y", documents: [doc("c")] }] as unknown as Parameters<typeof formatChanges>[0];
  const text = formatChanges(groups, 2);
  assert.match(text, /item:a/); assert.match(text, /item:b/); assert.doesNotMatch(text, /item:c/);
  assert.match(text, /… 1 more changed documents/);
  assert.doesNotMatch(formatChanges(groups), /more changed documents/);
});

test("writes answer with the state they produced; refusals and context name the sub-items behind a derived status", async t => {
  const { store, op } = await board(t), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Test agent", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as Array<{ type: string; text: string }>).map(c => c.text).join("\n");
  // area's sub-items: a (todo) and b (blocked) → area BLOCK. Finishing b's blocker does not change area; finishing a and b does.
  const done = text(await client.callTool({ name: "set_status", arguments: { author, id: "a", status: "done", log: "Finished" } }));
  assert.match(done, /^a · DONE /m);
  assert.doesNotMatch(done, /ancestor area/); // still BLOCK because of b
  const unblocked = text(await client.callTool({ name: "set_status", arguments: { author, id: "b", status: "done", log: "Finished too" } }));
  assert.match(unblocked, /^ancestor area now DONE \S* \(was BLOCK \S*\)$/m);
  const refused = text(await client.callTool({ name: "set_status", arguments: { author, id: "area", status: "todo", log: "Not a leaf" } }));
  assert.match(refused, /area's status is derived from its sub-items \(.*a done.*b done.*\)|area's status is derived from its sub-items \(.*b done.*a done.*\)/);
  assert.match(text(await client.callTool({ name: "context", arguments: { id: "area" } })), /^status and priority derived from 2 sub-items: .*a DONE/m);
  const prs = text(await client.callTool({ name: "search", arguments: { query: "Whitefoot#341" } }));
  assert.equal(prs.split("\n").filter(l => l.includes("without repository")).length, 1);
  assert.match(prs, /also a bare #341 without repository \(may be another repository's PR\) in: .*item:b/);
});
