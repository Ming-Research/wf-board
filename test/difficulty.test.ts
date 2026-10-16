import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Difficulty, Item, difficultyText, dispatchable } from "../src/model.ts";
import { OpError } from "../src/ops.ts";
import { rules } from "../src/rules.ts";
import { brief, context, list } from "../src/query.ts";
import { describeChanges } from "../src/query.ts";
import { createMcpServer } from "../src/mcp.ts";
import { board, author, at } from "./helpers.ts";

const architect = "Architect", coordinator = "总管";
const refuses = (call: Promise<unknown>, message: RegExp) => assert.rejects(call, e => { assert.ok(e instanceof OpError, String(e)); assert.match(e.message, message); return true; });

/** The synthetic board with the architect's project added; its fixture items are already rated 2. */
async function withArchitect(t: Parameters<typeof board>[0]) {
  const b = await board(t);
  await b.op.createProject({ author: coordinator, name: architect });
  /** A new unrated work item of Whitefoot; create_item takes no difficulty. */
  const unrated = (key: string, extra: object = {}) => b.op.createItem({ author, key, group: author, priority: "P2", title: `未评级 ${key}`, accept: "通过", ...extra });
  return { ...b, unrated };
}
const missing = (b: { store: { snapshot(): Parameters<typeof rules>[0] } }, id: string) => rules(b.store.snapshot()).checks(id).filter(c => c.label === "缺难度");

test("a difficulty is an integer 1–5 or architect, shown as 「难度 N」 or 「架构师做」, and only 1–5 can be dispatched", () => {
  for (const ok of [1, 2, 3, 4, 5, "architect"]) assert.equal(Difficulty.safeParse(ok).success, true, String(ok));
  for (const bad of [0, 6, 2.5, -1, "3", "Architect", "架构师做", null, true]) assert.equal(Difficulty.safeParse(bad).success, false, String(bad));
  assert.equal(difficultyText(3), "难度 3"); assert.equal(difficultyText("architect"), "架构师做");
  assert.deepEqual([1, 5, "architect", undefined].map(d => dispatchable(d as Difficulty | undefined)), [true, true, false, false]);
});

test("a record cannot carry a difficulty, in the schema and by conversion to a record", async t => {
  const base = { title: "r", group: "Whitefoot", record: true, updated: at, rev: 1 };
  assert.equal(Item.safeParse({ ...base, difficulty: 2 }).success, false);
  assert.equal(Item.safeParse(base).success, true);
  const { store, op } = await withArchitect(t);
  await op.setDifficulty({ author: architect, id: "a", difficulty: 3, reason: "评一次" });
  await op.updateItem({ author, id: "a", rev: store.snapshot().items.a!.rev, record: true });
  const a = store.snapshot().items.a!;
  assert.equal(a.difficulty, undefined, "the record keeps no difficulty");
  assert.match(a.log.at(-1)!.text, /改为记录条目.*原难度：3/, "the conversion says what it dropped");
  await refuses(op.setDifficulty({ author: architect, id: "a", difficulty: 2, reason: "记录没有" }), /a record has no difficulty/);
});

test("only the architect sets a difficulty, on an item of any project, and a refusal changes nothing", async t => {
  const { store, op } = await withArchitect(t);
  const before = store.snapshot(), count = (await store.log()).length;
  for (const who of [author, "Firn", coordinator]) {
    await refuses(op.setDifficulty({ author: who, id: "a", difficulty: 3, reason: "r" }), /only the architect, writing as Architect/);
    await refuses(op.setDifficultyMany({ author: who, items: [{ id: "a", difficulty: 3, reason: "r" }] }), /only the architect/);
  }
  assert.deepEqual(store.snapshot(), before); assert.equal((await store.log()).length, count, "a refusal makes no commit");
  // The architect's own project is not the items' project: ownership does not apply.
  await op.setDifficulty({ author: architect, id: "a", difficulty: 4, reason: "Whitefoot 的条目" });
  await op.setDifficulty({ author: architect, id: "other", difficulty: "architect", reason: "Firn 的条目" });
  assert.equal(store.snapshot().items.a!.difficulty, 4); assert.equal(store.snapshot().items.other!.difficulty, "architect");
});

test("each change logs from what to what and why, the first rating from 未评, and an unchanged value writes nothing", async t => {
  const { store, op, unrated } = await withArchitect(t);
  await unrated("u");
  const entries = () => store.snapshot().items.u!.log.map(l => l.text).filter(text => text.startsWith("难度"));
  await op.setDifficulty({ author: architect, session: "架构师", id: "u", difficulty: 2, reason: "改写已定，照做" });
  await op.setDifficulty({ author: architect, id: "u", difficulty: 3, reason: "涉及并发" });
  await op.setDifficulty({ author: architect, id: "u", difficulty: "architect", reason: "改由架构师做" });
  assert.deepEqual(entries(), ["难度：未评 → 2，理由：改写已定，照做", "难度：2 → 3，理由：涉及并发", "难度：3 → 架构师做，理由：改由架构师做"]);
  assert.equal(store.snapshot().items.u!.log.at(-1)!.by, architect, "the log names who wrote");
  const count = (await store.log()).length;
  const same = await op.setDifficulty({ author: architect, id: "u", difficulty: "architect", reason: "再说一遍" });
  assert.equal((await store.log()).length, count, "the same value is a no-op"); assert.equal(entries().length, 3);
  assert.equal(same.rev, store.snapshot().items.u!.rev);
});

test("set_difficulty refuses a bad value, a missing or blank reason, a record and an unknown item", async t => {
  const { store, op, unrated } = await withArchitect(t);
  await unrated("u"); await op.createItem({ author, key: "rec", group: author, record: true, title: "记录" });
  const before = store.snapshot();
  for (const bad of [0, 6, 2.5, "3", "Architect"]) await refuses(op.setDifficulty({ author: architect, id: "u", difficulty: bad as never, reason: "r" }), /give an integer 1–5, or "architect"/);
  await refuses(op.setDifficulty({ author: architect, id: "u", difficulty: 2 } as never), /reason: say why/);
  await refuses(op.setDifficulty({ author: architect, id: "u", difficulty: 2, reason: "  " }), /nonempty/);
  await refuses(op.setDifficulty({ author: architect, id: "rec", difficulty: 2, reason: "r" }), /a record has no difficulty/);
  await refuses(op.setDifficulty({ author: architect, id: "nope", difficulty: 2, reason: "r" }), /choose an existing item/);
  assert.deepEqual(store.snapshot(), before);
});

test("set_difficulty_many rates many items in one commit with a log entry each, all or nothing", async t => {
  const { store, op, unrated } = await withArchitect(t);
  await unrated("u1"); await unrated("u2"); await unrated("u3");
  const count = (await store.log()).length, before = store.snapshot();
  await refuses(op.setDifficultyMany({ author: architect, items: [{ id: "u1", difficulty: 2, reason: "r" }, { id: "u2", difficulty: 9 as never, reason: "r" }] }), /items\.1 \(u2\): difficulty: give an integer 1–5/);
  await refuses(op.setDifficultyMany({ author: architect, items: [{ id: "u1", difficulty: 2, reason: "r" }, { id: "u2", difficulty: 2 }] }), /items\.1 \(u2\): reason: say why/);
  await refuses(op.setDifficultyMany({ author: architect, items: [{ id: "u1", difficulty: 2, reason: "r" }, { id: "u1", difficulty: 3, reason: "r" }] }), /items\.1\.id u1: name each item once/);
  await refuses(op.setDifficultyMany({ author: architect, items: [{ id: "u1", difficulty: 2, reason: "r" }, { id: "nope", difficulty: 2, reason: "r" }] }), /items\.1 \(nope\): .*existing item/);
  await refuses(op.setDifficultyMany({ author: architect, items: [] }), /at least one/);
  assert.deepEqual(store.snapshot(), before); assert.equal((await store.log()).length, count, "a refusal makes no commit");
  const res = await op.setDifficultyMany({ author: architect, reason: "照计划行补评", items: [{ id: "u1", difficulty: 1 }, { id: "u2", difficulty: "architect", reason: "讨论" }, { id: "u3", difficulty: 3 }, { id: "a", difficulty: 2 }] });
  assert.equal((await store.log()).length, count + 1, "one commit for every item"); assert.equal(res.rev, undefined);
  const [commit] = await store.log({ limit: 1 });
  assert.deepEqual(commit!.files.sort(), ["items/u1.yaml", "items/u2.yaml", "items/u3.yaml"], "a already had 2, so it writes nothing");
  const last = (id: string) => store.snapshot().items[id]!.log.at(-1)!.text;
  assert.equal(last("u1"), "难度：未评 → 1，理由：照计划行补评", "an entry without a reason takes the default");
  assert.equal(last("u2"), "难度：未评 → 架构师做，理由：讨论", "an entry's own reason wins");
  assert.equal(last("u3"), "难度：未评 → 3，理由：照计划行补评");
  await op.setDifficultyMany({ author: architect, reason: "x", items: [{ id: "u1", difficulty: 1 }] });
  assert.equal((await store.log()).length, count + 1, "all unchanged writes no commit");
});

test("缺难度 is raised for open unrated work and clears when it is rated 1–5 or 架构师做", async t => {
  const b = await withArchitect(t); const { op, unrated } = b;
  await unrated("u");
  assert.equal(missing(b, "u").length, 1);
  assert.match(missing(b, "u")[0]!.text, /set_difficulty/);
  assert.equal(missing(b, "a").length, 0, "a rated item has none");
  await op.setDifficulty({ author: architect, id: "u", difficulty: 3, reason: "r" });
  assert.equal(missing(b, "u").length, 0);
  await unrated("v"); await op.setDifficulty({ author: architect, id: "v", difficulty: "architect", reason: "讨论" });
  assert.equal(missing(b, "v").length, 0, "架构师做 counts as rated");
  // Raising the check never refuses a write: an unrated item is created and edited like any other.
  await unrated("w"); await op.appendLog({ author, id: "w", text: "进展" });
  assert.equal(missing(b, "w").length, 1);
});

test("缺难度 is not raised for a record, a closed item, an untriaged request, a backlog item or paused work", async t => {
  const b = await withArchitect(t); const { store, op, unrated } = b;
  await op.createItem({ author, key: "rec", group: author, record: true, title: "待选池" });
  await unrated("backlog", { owner: "rec", group: undefined, priority: undefined });
  await unrated("done"); await op.setPlan({ author, id: "done", row: { id: "accept", accept: true, text: "通过", state: "done" } });
  await unrated("gone"); await op.setStatus({ author, id: "gone", status: "cancelled", log: "不要了" });
  await op.createRequest({ author, project: "Firn", key: "req", title: "请求", head: "h", accept: "通过", priority: "P1", why: "w" });
  await unrated("own"); await unrated("under", { owner: "own", group: undefined, priority: undefined });
  await op.setPause({ author: coordinator, id: "own", paused: true, reason: "先放一放" });
  assert.equal(rules(store.snapshot()).statusOf("under"), "paused", "the child is paused by inheritance");
  for (const id of ["rec", "backlog", "done", "gone", "req", "own", "under"]) assert.equal(missing(b, id).length, 0, id);
  // The exemptions end with their cause.
  await op.setPause({ author: coordinator, id: "own", paused: false });
  assert.equal(missing(b, "own").length, 1); assert.equal(missing(b, "under").length, 1);
  await op.triageRequest({ author: "Firn", id: "req", log: "收下" });
  assert.equal(missing(b, "req").length, 1, "a triaged request is work and gets the check");
});

test("brief lists as startable only items rated 1–5, and carries the difficulty on its rows", async t => {
  const b = await withArchitect(t); const { store, op, unrated } = b;
  await unrated("u"); await unrated("one"); await unrated("five"); await unrated("mine");
  await op.setDifficultyMany({ author: architect, items: [{ id: "one", difficulty: 1, reason: "r" }, { id: "five", difficulty: 5, reason: "r" }, { id: "mine", difficulty: "architect", reason: "讨论" }] });
  const s = store.snapshot(), r = rules(s), todo = brief(s, r, author).todo;
  assert.ok(todo.some(row => row.id === "five" && row.difficulty === 5), "a rated item is listed with its difficulty");
  assert.ok(todo.some(row => row.id === "one" && row.difficulty === 1), "so is the lowest level");
  assert.ok(!todo.some(row => row.id === "u"), "an unrated item is not startable");
  assert.ok(!todo.some(row => row.id === "mine"), "an item the architect does itself is not startable");
  const checks = brief(s, r, author).checks;
  const labels = (id: string) => checks.find(row => row.id === id)?.checks.map(c => c.label);
  assert.ok(checks.some(row => row.id === "u" && !("difficulty" in row)), "the checks list names the unrated item, without a difficulty");
  assert.ok(labels("u")!.includes("缺难度"));
  assert.ok(!labels("mine")!.includes("缺难度"), "an architect-rated item raises no 缺难度");
  assert.equal(checks.find(row => row.id === "mine")!.difficulty, "architect", "the checks list carries a difficulty it has");
  const progress = brief(s, r, author).progress;
  assert.ok(progress.every(row => !("difficulty" in row) || row.difficulty !== undefined));
});

test("context and list rows show the difficulty after the tags, and nothing for an unrated item", async t => {
  const b = await withArchitect(t); const { store, op, unrated } = b;
  await unrated("u");
  await op.setDifficulty({ author: architect, id: "a", difficulty: 4, reason: "r" });
  await op.setDifficulty({ author: architect, id: "b", difficulty: "architect", reason: "r" });
  const s = store.snapshot(), r = rules(s);
  const ctx = (id: string) => context(s, r, id) as unknown as { difficulty?: unknown };
  assert.equal(ctx("a").difficulty, 4); assert.equal(ctx("b").difficulty, "architect"); assert.equal("difficulty" in ctx("u"), false);
  const rows = list(s, r, { group: author });
  assert.equal(rows.find(row => row.id === "a")!.difficulty, 4);
  assert.equal(rows.find(row => row.id === "u")!.difficulty, undefined);
});

test("a difficulty change is a real change in describeChanges", () => {
  assert.equal(describeChanges({ num: 1 }, { difficulty: 2, num: 2 }, "item"), "difficulty changed");
  assert.equal(describeChanges({ difficulty: 2 }, { difficulty: 3 }, "item"), "difficulty changed");
  assert.equal(describeChanges({ difficulty: 2 }, { difficulty: 2 }, "item"), "metadata changed");
});

test("MCP: the tools answer with the row, refuse other authors, and the texts show the difficulty", async t => {
  const { store, op, unrated } = await withArchitect(t);
  await unrated("u");
  const server = createMcpServer({ store, ops: op, now: () => "2026-10-12T00:00:00Z" });
  const client = new Client({ name: "Difficulty test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({ name, arguments: args }); return { error: r.isError === true, text: (r.content as Array<{ text: string }>).map(c => c.text).join("\n") }; };
  const tools = (await client.listTools()).tools.map(x => x.name);
  assert.ok(tools.includes("set_difficulty") && tools.includes("set_difficulty_many"));
  assert.match((await call("context", { id: "u" })).text, /check: 缺难度/);
  const refused = await call("set_difficulty", { author, id: "u", difficulty: 3, reason: "r" });
  assert.equal(refused.error, true); assert.match(refused.text, /only the architect/);
  assert.equal((await call("set_difficulty", { author: architect, id: "u", difficulty: 7, reason: "r" })).error, true, "the schema refuses 7");
  const set = await call("set_difficulty", { author: architect, session: "架构师", id: "u", difficulty: 3, reason: "要查并发" });
  assert.equal(set.error, false); assert.match(set.text, /^set_difficulty u · rev \d+ · commit [0-9a-f]{40}\nu · TODO P2 · 未评级 u · 难度 3 · Whitefoot › u/);
  assert.doesNotMatch((await call("context", { id: "u" })).text, /check: 缺难度/);
  assert.match((await call("context", { id: "u" })).text.split("\n")[0]!, / · 难度 3 · Whitefoot/);
  assert.match((await call("list", { filters: { group: author } })).text, /未评级 u · 难度 3 · Whitefoot/);
  const arch = await call("set_difficulty", { author: architect, id: "u", difficulty: "architect", reason: "改由架构师做" });
  assert.match(arch.text, /未评级 u · 架构师做 · Whitefoot/);
  const many = await call("set_difficulty_many", { author: architect, reason: "补评", items: [{ id: "a", difficulty: 1 }, { id: "b", difficulty: 5, reason: "难" }] });
  assert.equal(many.error, false); assert.match(many.text, /^set_difficulty 2 items · commit [0-9a-f]{40}$/);
  assert.deepEqual([store.snapshot().items.a!.difficulty, store.snapshot().items.b!.difficulty], [1, 5]);
  const brief = JSON.parse((await call("brief", { project: author })).text);
  assert.ok(JSON.stringify(brief).includes('"difficulty":1'), "brief rows carry the difficulty");
  assert.equal(brief.todo.some((row: { id: string }) => row.id === "u"), false, "an architect-rated item is not in todo");
});
