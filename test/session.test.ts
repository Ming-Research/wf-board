// Which session last wrote to an item: recorded as a commit trailer, derived into the snapshot's activity, shown by
// context and brief, and rebuilt from history on restart (docs/design.md, history). It observes writers; it assigns nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { Store } from "../src/store.ts";
import { board, author, later } from "./helpers.ts";

async function connect(t: { after(fn: () => Promise<void>): void }) {
  const fixture = await board(t), server = createMcpServer({ store: fixture.store, ops: fixture.op, now: () => later });
  const client = new Client({ name: "Session test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>).map(c => c.text).join("\n");
  async function call(name: string, args: Record<string, unknown> = {}) { const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, text(r)); return text(r); }
  return { ...fixture, client, call, text };
}
const lastPush = (context: string) => /^last push: (.*)$/m.exec(context)?.[1];

test("a write with a session is attributed, a write without one keeps it, and a later session replaces it", async t => {
  const { call, store } = await connect(t);
  assert.equal(lastPush(await call("context", { id: "a" })), undefined, "no attribution before any session wrote");
  await call("append_log", { author, session: "firn: SCAN work", id: "a", text: "one" });
  assert.match(lastPush(await call("context", { id: "a" }))!, /^firn: SCAN work · \d{4}-\d\d-\d\dT\d\d:\d\dZ$/);
  const first = store.snapshot().activity!.sessions!.a!;
  await call("append_log", { author, id: "a", text: "two, from an older client" });
  assert.deepEqual(store.snapshot().activity!.sessions!.a, first, "a write without session leaves the attribution");
  await call("append_log", { author, session: "second session", id: "a", text: "three" });
  assert.match(lastPush(await call("context", { id: "a" }))!, /^second session · /);
  assert.equal(store.snapshot().activity!.sessions!.b, undefined, "only the written item is attributed");
});

test("the trailer stays out of the commit message, and attribution is rebuilt from history after a restart", async t => {
  const { call, store, dir } = await connect(t);
  await call("append_log", { author, session: "S1", id: "a", text: "one" });
  await call("set_plan", { author, session: "S2", id: "b", row: { id: "w", text: "work", state: "doing" } });
  const [newest] = await store.log({ limit: 1 });
  assert.equal(newest!.session, "S2");
  assert.equal(newest!.message, "set_plan b", "the trailer is not part of the message");
  const live = store.snapshot().activity!;
  const reopened = await Store.open(dir);
  assert.deepEqual(reopened.snapshot().activity!.sessions, live.sessions);
  assert.equal(live.sessions!.a!.name, "S1");
  assert.equal(live.sessions!.b!.name, "S2");
  assert.deepEqual(reopened.snapshot().activity, live);
});

test("brief marks current work with its last writer", async t => {
  const { call } = await connect(t);
  await call("set_plan", { author, session: "S2", id: "a", row: { id: "w", text: "work", state: "doing" } });
  const brief = JSON.parse(await call("brief", { project: "Whitefoot" }));
  const row = brief.wip.find((r: { id: string }) => r.id === "a");
  assert.match(row.lastPush, /^S2 · \d{4}-\d\d-\d\dT\d\d:\d\dZ$/);
});

test("a session name must be 1 to 80 printable characters", async t => {
  const { client, text, store } = await connect(t);
  await client.callTool({ name: "append_log", arguments: { author, session: "valid", id: "a", text: "accepted" } }).then(r => assert.ok(!r.isError, text(r)));
  const before = store.snapshot().head;
  for (const session of ["", "   ", "x".repeat(81), "two\nlines"]) {
    const r = await client.callTool({ name: "append_log", arguments: { author, session, id: "a", text: "refused" } });
    assert.equal(r.isError, true, JSON.stringify(session));
    assert.match(text(r), /session/);
  }
  assert.equal(store.snapshot().head, before);
  // Surrounding spaces are trimmed, and a name that itself reads like a trailer is still the whole name.
  for (const [given, stored] of [["  padded  ", "padded"], ["Session: X", "Session: X"]]) {
    await client.callTool({ name: "append_log", arguments: { author, session: given, id: "a", text: "named" } }).then(r => assert.ok(!r.isError, text(r)));
    assert.equal(store.snapshot().activity?.sessions?.a?.name, stored);
  }
});

test("the server instructions carry a short generic reading guide", async t => {
  const { client } = await connect(t), instructions = client.getInstructions()!;
  const guide = instructions.slice(instructions.indexOf("Reading the board:"));
  assert.ok(guide.length > 0 && guide.split("\n").length <= 12);
  assert.match(guide, /session/);
  assert.doesNotMatch(guide, /Firn|Whitefoot|Halo|Snowghost|\bwf\b/);
});
