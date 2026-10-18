// The runner's beat for a turn it is running (report_live): kept in memory and nowhere else, stamped from the board's clock, refused
// for the writers and the arguments the rules name, and sent to the open pages as the event `live`. What the beats feed, the agent
// list's runner block, is tested in test/runner-rows.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ops, OpError } from "../src/ops.ts";
import { createMcpServer } from "../src/mcp.ts";
import { LiveStore } from "../src/live.ts";
import type { LiveEntry } from "../src/live.ts";
import { PROCESS_WRITERS } from "../src/model.ts";
import { board, server, asArchitect, asPM, author, rx } from "./helpers.ts";

// A board whose clock the test sets, so a beat's stamps can be told from the moment it arrived.
async function clocked(t: Parameters<typeof board>[0], now = "2026-10-18T09:00:00Z") {
  const fixture = await board(t);
  let clock = now;
  return { ...fixture, op: ops(fixture.store, () => clock), setClock: (value: string) => { clock = value; } };
}
const refused = (pattern: RegExp) => (error: unknown) => error instanceof OpError && pattern.test(error.message);
const runner = { author, session: "执行程序" };

test("a beat is kept in memory with the times counted back from the moment it arrived, and the next beat for the same turn replaces it", async t => {
  const { store, op, setClock } = await clocked(t);
  const head = store.snapshot().head;
  const said = await op.reportLive({ ...runner, id: "a", role: "工程师", turn: 2, turnSeconds: 740, idleSeconds: 12, action: "改 web/app.ts" });
  assert.match(said, /^live 工程师 a turn 2 · kept in memory only, no commit$/);
  assert.deepEqual(op.live.all(), [{ role: "工程师", item: "a", turn: 2, turnStartedAt: "2026-10-18T08:47:40Z", lastActionAt: "2026-10-18T08:59:48Z", action: "改 web/app.ts", at: "2026-10-18T09:00:00Z" }]);
  assert.equal(store.snapshot().head, head, "no commit");
  assert.equal(store.snapshot().items.a!.runner, undefined, "and nothing on the item");
  // The same role and item again: the newest beat is the only one; what the new beat leaves out is not carried over.
  setClock("2026-10-18T09:00:30Z");
  await op.reportLive({ ...runner, id: "a", role: "工程师", turn: 2, turnSeconds: 770 });
  assert.deepEqual(op.live.all().map(e => [e.role, e.item, e.turnStartedAt, e.lastActionAt, e.action, e.at]), [["工程师", "a", "2026-10-18T08:47:40Z", undefined, undefined, "2026-10-18T09:00:30Z"]]);
  // The architect's turn that answers a question on the same item is a beat of its own.
  await op.reportLive({ ...runner, id: "a", role: "架构师", turn: 3, turnSeconds: 5 });
  assert.deepEqual(op.live.all().map(e => `${e.role}:${e.item}:${e.turn}`).sort(), ["工程师:a:2", "架构师:a:3"]);
  assert.equal(store.snapshot().head, head);
});

test("a beat that does not say what a beat must is refused in the rule's own words, and nothing is kept", async t => {
  const { op } = await clocked(t);
  const ok = { ...runner, id: "a", role: "工程师" as const, turn: 1, turnSeconds: 1 };
  const cases: Array<[Parameters<typeof op.reportLive>[0], RegExp]> = [
    [{ ...ok, role: "审查" as "工程师" }, /role: give 工程师 or 架构师/],
    [{ ...ok, turn: 0 }, /turn: give a whole number, 1 or more/],
    [{ ...ok, turn: 1.5 }, /turn: give a whole number/],
    [{ ...ok, turnSeconds: -1 }, /turnSeconds: give a whole number, 0 or more/],
    [{ ...ok, idleSeconds: -3 }, /idleSeconds: give a whole number, 0 or more/],
    [{ ...ok, action: "x".repeat(81) }, /action: give one nonempty line of at most 80 characters/],
    [{ ...ok, action: "  \n " }, /action: give one nonempty line/],
    [{ ...ok, id: "missing" }, /choose an existing item/],
    [{ ...ok, id: "other" }, /item other belongs to project Firn/],
  ];
  for (const [args, message] of cases) await assert.rejects(() => op.reportLive(args), refused(message), JSON.stringify(args));
  assert.deepEqual(op.live.all(), []);
  await op.createItem({ ...asArchitect, key: "rec", title: "记录", group: "Whitefoot", record: true });
  await assert.rejects(() => op.reportLive({ ...ok, id: "rec" }), refused(/a record has no work to report on/));
  // Eighty characters are fine, and line breaks inside the action become spaces.
  await op.reportLive({ ...ok, action: "字".repeat(80) });
  await op.reportLive({ ...ok, role: "架构师", action: "读\n条目  a" });
  assert.equal(op.live.all().find(e => e.role === "架构师")!.action, "读 条目 a");
});

test("the writers are those of the runner's report: the PM, the architect and the runner; every other role and writer is refused", async t => {
  const { op } = await clocked(t);
  const beat = { id: "a", role: "工程师" as const, turn: 1, turnSeconds: 1 };
  await op.reportLive({ ...asPM, ...beat });
  await op.reportLive({ ...asArchitect, ...beat });
  await op.reportLive({ ...runner, ...beat });
  await op.reportLive({ ...runner, session: "  执行程序  ", ...beat });
  const again = op.live.all().length;
  for (const session of ["执行程序x", "x执行程序", "engineer", undefined]) {
    await assert.rejects(() => op.reportLive({ author, ...(session === undefined ? {} : { session }), ...beat }), refused(rx`only ${PROCESS_WRITERS}, or the runner from the session 执行程序, may report a turn's live state`), String(session));
  }
  for (const role of ["工程师", "审查", "观察者", "资源管理"] as const) {
    await assert.rejects(() => op.reportLive({ ...asPM, access: { role, project: "Whitefoot", roots: ["a"] }, ...beat }), refused(/item\.runner: a .* credential may not write this part/), role);
  }
  await op.reportLive({ ...asPM, access: { role: "PM", project: "PM", roots: [] }, ...beat });
  assert.equal(op.live.all().length, again, "refused beats kept nothing");
});

test("the tool beats over MCP, takes the identity of a connection the same way report_state does, and a refusal reaches the caller as an error", async t => {
  const { store, op } = await clocked(t);
  const server = createMcpServer({ store, ops: op, now: () => "2026-10-18T09:00:00Z" });
  const client = new Client({ name: "t", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>).map(c => c.text).join("\n");
  assert.ok((await client.listTools()).tools.some(tool => tool.name === "report_live"));
  const ok = await client.callTool({ name: "report_live", arguments: { ...runner, id: "a", role: "工程师", turn: 4, turnSeconds: 60, idleSeconds: 3, action: "跑 git push" } });
  assert.equal(ok.isError, undefined, text(ok));
  assert.match(text(ok), /^live 工程师 a turn 4 · kept in memory only, no commit/);
  assert.equal(op.live.all()[0]!.action, "跑 git push");
  const bad = await client.callTool({ name: "report_live", arguments: { ...runner, id: "a", role: "工程师", turn: 0, turnSeconds: 1 } });
  assert.equal(bad.isError, true);
  const other = await client.callTool({ name: "report_live", arguments: { author, session: "someone", id: "a", role: "工程师", turn: 1, turnSeconds: 1 } });
  assert.equal(other.isError, true);
  assert.match(text(other), /may report a turn's live state/);
});

test("a beat older than a day is dropped when the next one is kept, and a listener hears the whole list after each beat", () => {
  const live = new LiveStore(), heard: LiveEntry[][] = [];
  const stop = live.onChange(all => heard.push(all));
  const entry = (item: string, at: string): LiveEntry => ({ role: "工程师", item, turn: 1, turnStartedAt: at, at });
  live.put(entry("old", "2026-10-17T07:00:00Z"));
  live.put(entry("new", "2026-10-18T09:00:00Z"));
  assert.deepEqual(live.all().map(e => e.item), ["new"]);
  assert.deepEqual(heard.map(all => all.map(e => e.item)), [["old"], ["new"]]);
  stop();
  live.put(entry("later", "2026-10-18T09:00:30Z"));
  assert.equal(heard.length, 2, "a stopped listener hears nothing");
});

test("an open page is told the beats when its stream opens and after each beat", async t => {
  const { op, url } = await server(t);
  await op.reportLive({ ...runner, id: "a", role: "工程师", turn: 1, turnSeconds: 10, action: "读 src/ops.ts" });
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(url + "/api/events", { signal: controller.signal });
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  const frame = (text: string) => JSON.parse(text.match(/event: live\ndata: (.+)/)![1]!) as LiveEntry[];
  assert.deepEqual(frame(first).map(e => [e.role, e.item, e.turn, e.action]), [["工程师", "a", 1, "读 src/ops.ts"]], "the beats held when the stream opened");
  const next = reader.read();
  await op.reportLive({ ...runner, id: "a", role: "架构师", turn: 5, turnSeconds: 1 });
  const second = frame(decoder.decode((await next).value));
  assert.deepEqual(second.map(e => `${e.role}:${e.item}`).sort(), ["工程师:a", "架构师:a"], "the whole list follows a beat");
});
