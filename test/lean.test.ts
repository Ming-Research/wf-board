// What the board's tools return and refuse, kept short and self-explaining (docs/design.md, section 6, Lean replies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { board, author } from "./helpers.ts";

async function connected(t: Parameters<typeof board>[0]) {
  const { store, op } = await board(t, { sharedProjects: true }), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Lean replies", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct); t.after(async () => { await client.close(); await server.close(); });
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as Array<{ type: string; text: string }>).map(c => c.text).join("\n");
  return { store, op, client, text };
}

test("every tool, given a parameter it does not have, answers with its parameter table and an example call that passes validation", async t => {
  const { client, text } = await connected(t), tools = (await client.listTools()).tools;
  assert.ok(tools.length > 40, "the loop below must cover the board's tools");
  for (const tool of tools) {
    const reply = await client.callTool({ name: tool.name, arguments: { not_a_parameter: 1 } });
    assert.equal(reply.isError, true, tool.name);
    const body = text(reply);
    assert.match(body, /arguments not accepted/, tool.name);
    assert.match(body, /unknown parameter "not_a_parameter"/, tool.name);
    for (const parameter of Object.keys(tool.inputSchema.properties ?? {})) assert.ok(body.includes(parameter), `${tool.name}: the table names ${parameter}`);
    const example = /^Example: (\S+) (.*)$/m.exec(body);
    assert.ok(example && example[1] === tool.name, `${tool.name}: an example call`);
    // The example gets past validation; a write is then refused only because the example names no author.
    const again = await client.callTool({ name: tool.name, arguments: JSON.parse(example[2]!) });
    assert.doesNotMatch(text(again), /arguments not accepted/, `${tool.name}: ${example[2]}`);
  }
});

test("a missing required parameter and a wrong type are named in plain words, with the table", async t => {
  const { client, text } = await connected(t);
  const missing = text(await client.callTool({ name: "rule_card", arguments: { author } }));
  assert.match(missing, /missing required parameter "key"/);
  assert.match(missing, /^ {2}key \(string, required\)/m);
  const wrong = text(await client.callTool({ name: "context", arguments: { id: "a", log: "some" } }));
  assert.match(wrong, /"log"/); assert.match(wrong, /arguments not accepted/);
  const direction = text(await client.callTool({ name: "graph", arguments: { id: "a", direction: "sideways" } }));
  assert.match(direction, /"direction" must be one of: up, down, both/);
});

test("names the tools do not have but agents write are read as the name they have, and the reply says so", async t => {
  const { client, text, store } = await connected(t);
  const byKey = await client.callTool({ name: "context", arguments: { key: "a" } });
  assert.equal(byKey.isError, undefined, text(byKey)); assert.match(text(byKey), /^a · /m); assert.match(text(byKey), /^note: key read as id$/m);
  const logged = await client.callTool({ name: "append_log", arguments: { author, key: "a", text: "written under the name key" } });
  assert.equal(logged.isError, undefined, text(logged)); assert.match(text(logged), /^note: key read as id$/m);
  assert.equal(store.snapshot().items.a!.log.at(-1)!.text, "written under the name key");
  // Where the tool names the card key and the caller wrote id.
  const card = await client.callTool({ name: "withdraw_card", arguments: { author, id: "choice", log: "No longer needed" } });
  assert.equal(card.isError, undefined, text(card)); assert.match(text(card), /^note: id read as key$/m);
  // A filter written beside the tool's filters is moved into them; project is the group.
  const notes = await client.callTool({ name: "notes", arguments: { limit: 1, state: ["sent"] } });
  assert.equal(notes.isError, undefined, text(notes)); assert.match(text(notes), /^note: limit read as filters\.limit; state read as filters\.state$/m);
  assert.equal(text(notes).split("\n").filter(line => line.startsWith("note-")).length, 1);
  const found = await client.callTool({ name: "search", arguments: { query: "中文", project: author } });
  assert.equal(found.isError, undefined, text(found)); assert.match(text(found), /^note: project read as filters\.group$/m);
  // A name that is not an alias is still refused, and a name given together with the right one is not guessed at.
  const both = await client.callTool({ name: "context", arguments: { id: "a", key: "b" } });
  assert.equal(both.isError, true); assert.match(text(both), /unknown parameter "key"/);
});
