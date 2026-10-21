import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Difficulty, Item, PROCESS_WRITERS, difficultyText } from "../src/model.ts";
import { OpError } from "../src/ops.ts";
import { rules } from "../src/rules.ts";
import { brief, context, list } from "../src/query.ts";
import { unreadSteps, piecesOf } from "../src/history.ts";
import { describeChanges } from "../src/query.ts";
import { createMcpServer } from "../src/mcp.ts";
import { board, author, at, architect, architectSession, asArchitect, retiredAny, rx } from "./helpers.ts";

const refuses = (call: Promise<unknown>, message: RegExp) => assert.rejects(call, e => { assert.ok(e instanceof OpError, String(e)); assert.match(e.message, message); return true; });

/** The synthetic board (it has the architect's project); its fixture items are already rated 2. */
async function withArchitect(t: Parameters<typeof board>[0]) {
  const b = await board(t);
  /** A new unrated work item of Whitefoot: only the architect creates items, and this one gives no difficulty. */
  const unrated = (key: string, extra: object = {}) => b.op.createItem({ ...asArchitect, key, group: author, title: `未评级 ${key}`, accept: "通过", ...extra });
  return { ...b, unrated };
}
const missing = (b: { store: { snapshot(): Parameters<typeof rules>[0] } }, id: string) => rules(b.store.snapshot()).checks(id).filter(c => c.label === "缺难度");

test("a difficulty is an integer 1–5, shown as 「难度 N」; the level 「架构师做」 is gone", () => {
  for (const ok of [1, 2, 3, 4, 5]) assert.equal(Difficulty.safeParse(ok).success, true, String(ok));
  for (const bad of [0, 6, 2.5, -1, "3", "architect", "Architect", "架构师做", null, true]) assert.equal(Difficulty.safeParse(bad).success, false, String(bad));
  assert.equal(difficultyText(3), "难度 3");
});

test("a record cannot carry a difficulty, in the schema and by conversion to a record", async t => {
  const base = { title: "r", group: "Whitefoot", record: true, updated: at, rev: 1 };
  assert.equal(Item.safeParse({ ...base, difficulty: 2 }).success, false);
  assert.equal(Item.safeParse(base).success, true);
  const { store, op } = await withArchitect(t);
  await op.setDifficulty({ ...asArchitect, id: "a", difficulty: 3, reason: "评一次" });
  await op.updateItem({ author, id: "a", rev: store.snapshot().items.a!.rev, record: true });
  const a = store.snapshot().items.a!;
  assert.equal(a.difficulty, undefined, "the record keeps no difficulty");
  assert.match(a.log.at(-1)!.text, /改为记录条目.*原难度：3/, "the conversion says what it dropped");
  await refuses(op.setDifficulty({ ...asArchitect, id: "a", difficulty: 2, reason: "记录没有" }), /a record has no difficulty/);
});

test("only Architect from the session 架构师 sets a difficulty, on an item of any project, and a refusal changes nothing", async t => {
  const { store, op } = await withArchitect(t);
  const before = store.snapshot(), count = (await store.log()).length;
  const refusal = rx`only ${PROCESS_WRITERS} may set an item's difficulty`;
  // A project author, a project author borrowing the architect's session or the retired PM's, and the architect's project from
  // another session or from none are all refused.
  for (const who of [{ author }, { author: "Firn" }, { author, session: architectSession }, { author, session: "PM" }, { author: architect }, { author: architect, session: "另一个会话" }, { author: architect, session: "PM" }]) {
    await refuses(op.setDifficulty({ ...who, id: "a", difficulty: 3, reason: "r" }), refusal);
    await refuses(op.setDifficultyMany({ ...who, items: [{ id: "a", difficulty: 3, reason: "r" }] }), refusal);
  }
  // The retired coordinator and the retired PM are refused as retired, whatever session they write from.
  for (const who of [{ author: "总管" }, { author: "PM" }, { author: "PM", session: "PM" }, { author: "PM", session: architectSession }]) await refuses(op.setDifficulty({ ...who, id: "a", difficulty: 3, reason: "r" }), retiredAny);
  assert.deepEqual(store.snapshot(), before); assert.equal((await store.log()).length, count, "a refusal makes no commit");
  // The architect's own project is not the items' project: ownership does not apply.
  await op.setDifficulty({ ...asArchitect, id: "a", difficulty: 4, reason: "Whitefoot 的条目" });
  await op.setDifficulty({ ...asArchitect, id: "other", difficulty: 5, reason: "Firn 的条目" });
  assert.equal(store.snapshot().items.a!.difficulty, 4); assert.equal(store.snapshot().items.other!.difficulty, 5);
  // The architect rates many at once as well.
  await op.setDifficultyMany({ ...asArchitect, items: [{ id: "a", difficulty: 5, reason: "评多个" }, { id: "other", difficulty: 1, reason: "评多个" }] });
  assert.equal(store.snapshot().items.a!.difficulty, 5); assert.equal(store.snapshot().items.other!.difficulty, 1);
});

test("each change logs from what to what and why, the first rating from 未评, and an unchanged value writes nothing", async t => {
  const { store, op, unrated } = await withArchitect(t);
  await unrated("u");
  const entries = () => store.snapshot().items.u!.log.map(l => l.text).filter(text => text.startsWith("难度"));
  await op.setDifficulty({ ...asArchitect, id: "u", difficulty: 2, reason: "改写已定，照做" });
  await op.setDifficulty({ ...asArchitect, id: "u", difficulty: 3, reason: "涉及并发" });
  await op.setDifficulty({ ...asArchitect, id: "u", difficulty: 5, reason: "要查并发和内存" });
  assert.deepEqual(entries(), ["难度：未评 → 2，理由：改写已定，照做", "难度：2 → 3，理由：涉及并发", "难度：3 → 5，理由：要查并发和内存"]);
  assert.equal(store.snapshot().items.u!.log.at(-1)!.by, architect, "the log names who wrote");
  const count = (await store.log()).length;
  const same = await op.setDifficulty({ ...asArchitect, id: "u", difficulty: 5, reason: "再说一遍" });
  assert.equal((await store.log()).length, count, "the same value is a no-op"); assert.equal(entries().length, 3);
  assert.equal(same.rev, store.snapshot().items.u!.rev);
});

test("set_difficulty refuses a bad value, a missing or blank reason, a record and an unknown item", async t => {
  const { store, op, unrated } = await withArchitect(t);
  await unrated("u"); await op.createItem({ ...asArchitect, key: "rec", group: author, record: true, title: "记录" });
  const before = store.snapshot();
  for (const bad of [0, 6, 2.5, "3", "Architect", "architect"]) await refuses(op.setDifficulty({ ...asArchitect, id: "u", difficulty: bad as never, reason: "r" }), /difficulty: give an integer 1–5$/);
  await refuses(op.setDifficulty({ ...asArchitect, id: "u", difficulty: 2 } as never), /reason: say why/);
  await refuses(op.setDifficulty({ ...asArchitect, id: "u", difficulty: 2, reason: "  " }), /nonempty/);
  await refuses(op.setDifficulty({ ...asArchitect, id: "rec", difficulty: 2, reason: "r" }), /a record has no difficulty/);
  await refuses(op.setDifficulty({ ...asArchitect, id: "nope", difficulty: 2, reason: "r" }), /choose an existing item/);
  assert.deepEqual(store.snapshot(), before);
});

test("set_difficulty_many rates many items in one commit with a log entry each, all or nothing", async t => {
  const { store, op, unrated } = await withArchitect(t);
  await unrated("u1"); await unrated("u2"); await unrated("u3");
  const count = (await store.log()).length, before = store.snapshot();
  await refuses(op.setDifficultyMany({ ...asArchitect, items: [{ id: "u1", difficulty: 2, reason: "r" }, { id: "u2", difficulty: 9 as never, reason: "r" }] }), /items\.1 \(u2\): difficulty: give an integer 1–5/);
  await refuses(op.setDifficultyMany({ ...asArchitect, items: [{ id: "u1", difficulty: 2, reason: "r" }, { id: "u2", difficulty: 2 }] }), /items\.1 \(u2\): reason: say why/);
  await refuses(op.setDifficultyMany({ ...asArchitect, items: [{ id: "u1", difficulty: 2, reason: "r" }, { id: "u1", difficulty: 3, reason: "r" }] }), /items\.1\.id u1: name each item once/);
  await refuses(op.setDifficultyMany({ ...asArchitect, items: [{ id: "u1", difficulty: 2, reason: "r" }, { id: "nope", difficulty: 2, reason: "r" }] }), /items\.1 \(nope\): .*existing item/);
  await refuses(op.setDifficultyMany({ ...asArchitect, items: [] }), /at least one/);
  assert.deepEqual(store.snapshot(), before); assert.equal((await store.log()).length, count, "a refusal makes no commit");
  const res = await op.setDifficultyMany({ ...asArchitect, reason: "照计划行补评", items: [{ id: "u1", difficulty: 1 }, { id: "u2", difficulty: 5, reason: "讨论" }, { id: "u3", difficulty: 3 }, { id: "a", difficulty: 2 }] });
  assert.equal((await store.log()).length, count + 1, "one commit for every item"); assert.equal(res.rev, undefined);
  const [commit] = await store.log({ limit: 1 });
  assert.deepEqual(commit!.files.sort(), ["items/u1.yaml", "items/u2.yaml", "items/u3.yaml"], "a already had 2, so it writes nothing");
  const last = (id: string) => store.snapshot().items[id]!.log.at(-1)!.text;
  assert.equal(last("u1"), "难度：未评 → 1，理由：照计划行补评", "an entry without a reason takes the default");
  assert.equal(last("u2"), "难度：未评 → 5，理由：讨论", "an entry's own reason wins");
  assert.equal(last("u3"), "难度：未评 → 3，理由：照计划行补评");
  await op.setDifficultyMany({ ...asArchitect, reason: "x", items: [{ id: "u1", difficulty: 1 }] });
  assert.equal((await store.log()).length, count + 1, "all unchanged writes no commit");
});

test("缺难度 is raised for open unrated work and clears when it is rated 1–5", async t => {
  const b = await withArchitect(t); const { op, unrated } = b;
  await unrated("u");
  assert.equal(missing(b, "u").length, 1);
  assert.match(missing(b, "u")[0]!.text, /set_difficulty/);
  assert.doesNotMatch(missing(b, "u")[0]!.text, /架构师/, "no level other than 1–5 is offered, and no one writer is named");
  assert.equal(missing(b, "a").length, 0, "a rated item has none");
  await op.setDifficulty({ ...asArchitect, id: "u", difficulty: 3, reason: "r" });
  assert.equal(missing(b, "u").length, 0);
  // Raising the check never refuses a write: an unrated item is created and edited like any other.
  await unrated("w"); await op.appendLog({ author, id: "w", text: "进展" });
  assert.equal(missing(b, "w").length, 1);
});

test("缺难度 is raised only for work an unpaused root needs, and not for a record or a closed item", async t => {
  const b = await withArchitect(t); const { store, op, unrated } = b;
  await op.createItem({ ...asArchitect, key: "rec", group: author, record: true, title: "待选池" });
  await unrated("backlog", { owner: "rec", group: undefined });
  await unrated("under", { owner: "backlog", group: undefined });
  await unrated("done"); await op.setPlan({ author, id: "done", row: { id: "acc", accept: true, text: "通过", state: "done" } });
  await unrated("gone"); await op.setStatus({ ...asArchitect, id: "gone", status: "cancelled", log: "不要了" });
  await unrated("own"); await unrated("child", { owner: "own", group: undefined });
  await op.setPause({ ...asArchitect, id: "own", paused: true, reason: "先放一放" });
  assert.equal(rules(store.snapshot()).statusOf("child"), "paused", "the child is paused by inheritance");
  for (const id of ["rec", "backlog", "under", "done", "gone", "own", "child"]) assert.equal(missing(b, id).length, 0, id);
  assert.equal(rules(store.snapshot()).isNeeded("own"), false);
  // The exemptions end with their cause.
  await op.setPause({ ...asArchitect, id: "own", paused: false });
  // The root's next step is its unfinished child, so only the child asks for a rating.
  assert.equal(missing(b, "own").length, 0, "a root whose next step is an unfinished sub-item asks for none"); assert.equal(missing(b, "child").length, 1);
});

test("work that only a paused root needs raises no 缺难度, and work a second, unpaused root needs does", async t => {
  const b = await withArchitect(t); const { store, op, unrated } = b;
  // The dependency is another project's, so a shared row to it needs no owner.
  await op.createItem({ ...asArchitect, key: "dep", group: "Firn", title: "别的项目的依赖", accept: "通过" });
  await unrated("paused-root"); await unrated("live-root");
  await op.setPlan({ author, id: "paused-root", row: { item: "dep", own: false, after: [] } });
  assert.equal(missing(b, "dep").length, 1, "an unpaused root waits on it");
  await op.setPause({ ...asArchitect, id: "paused-root", paused: true, reason: "先放一放" });
  assert.equal(missing(b, "dep").length, 0, "only a paused root needs it now");
  assert.equal(rules(store.snapshot()).isNeeded("dep"), false);
  await op.setPlan({ author, id: "live-root", row: { item: "dep", own: false, after: [] } });
  assert.equal(missing(b, "dep").length, 1, "a second root, unpaused, needs it again");
  assert.equal(rules(store.snapshot()).isNeeded("dep"), true);
});

test("缺难度 follows the whole chain from an unpaused root, two levels down, by owned rows and by shared rows", async t => {
  const b = await withArchitect(t); const { store, op, unrated } = b;
  const rate = (id: string) => op.setDifficulty({ ...asArchitect, id, difficulty: 2, reason: "评中间一层" });
  const pause = (id: string, paused: boolean) => op.setPause({ ...asArchitect, id, paused, ...(paused ? { reason: "先放一放" } : {}) });
  // Every item is made as a root, leaf first, and the chain is joined afterwards: the keys and the creation order both run
  // against the chain, so a walk that visits items once in that order would stop after one level.
  const root = (key: string, group = author) => op.createItem({ ...asArchitect, key, group, title: `链上的 ${key}`, accept: "通过" });
  for (const key of ["x-own-leaf", "y-own-mid", "z-own-root", "x-leaf", "y-mid", "z-top"]) await root(key, key === "y-mid" ? "Firn" : author);
  for (const key of ["z-own-root", "y-own-mid", "z-top", "y-mid"]) await rate(key);
  // Owned chain: root → mid (rated) → leaf (not rated).
  await op.moveItem({ author, id: "x-own-leaf", owner: "y-own-mid" }); await op.moveItem({ author, id: "y-own-mid", owner: "z-own-root" });
  assert.equal(missing(b, "x-own-leaf").length, 1, "the leaf asks for a difficulty two levels below a root");
  assert.equal(missing(b, "y-own-mid").length, 0, "the rated middle asks for none");
  // Shared chain across projects (a shared row inside one project needs an owner): the pause is not inherited by ownership, so only the walk from the roots can decide.
  await op.setPlan({ author: "Firn", id: "y-mid", row: { item: "x-leaf", own: false, after: [] } });
  await op.setPlan({ author, id: "z-top", row: { item: "y-mid", own: false, after: [] } });
  assert.equal(rules(store.snapshot()).isRoot("y-mid"), false); assert.equal(rules(store.snapshot()).isRoot("x-leaf"), false);
  assert.equal(missing(b, "x-leaf").length, 1);
  for (const [top, mid, leaf] of [["z-own-root", "y-own-mid", "x-own-leaf"], ["z-top", "y-mid", "x-leaf"]] as const) {
    await pause(top, true);
    assert.equal(missing(b, leaf).length, 0, `${leaf}: the root is paused`); assert.equal(rules(store.snapshot()).isNeeded(leaf), false);
    await pause(top, false);
    assert.equal(missing(b, leaf).length, 1, `${leaf}: the root is back`);
    await pause(mid, true);
    assert.equal(missing(b, leaf).length, 0, `${leaf}: the middle item is paused`); assert.equal(rules(store.snapshot()).isNeeded(leaf), false);
    await pause(mid, false);
    assert.equal(missing(b, leaf).length, 1, `${leaf}: the middle item is back`);
  }
});

test("a root and the work under it raise 缺难度, and pausing the root stops that", async t => {
  const b = await withArchitect(t); const { store, op } = b;
  await op.createItem({ ...asArchitect, key: "bare", group: author, title: "根", accept: "通过" });
  await op.createItem({ ...asArchitect, key: "bare-kid", owner: "bare", title: "底下", accept: "通过" });
  const r = rules(store.snapshot());
  assert.equal(r.isRoot("bare"), true);
  assert.deepEqual([r.isNeeded("bare"), r.isNeeded("bare-kid")], [true, true]);
  assert.deepEqual([missing(b, "bare").length, missing(b, "bare-kid").length], [0, 1], "bare's next step is bare-kid, so only bare-kid asks");
  await op.setPause({ ...asArchitect, id: "bare", paused: true, reason: "先放一放" });
  assert.deepEqual([missing(b, "bare").length, missing(b, "bare-kid").length], [0, 0]);
});

test("缺难度 waits while the next step is an unfinished sub-item, and comes back when that sub-item is done", async t => {
  const b = await withArchitect(t); const { store, op, unrated } = b;
  // A study: the root's next step is the owned sub-item, which the study agent does before any rating is due.
  await unrated("study-root"); await unrated("study", { owner: "study-root", group: undefined });
  assert.equal(missing(b, "study-root").length, 0, "the next step is the sub-item, not an own step");
  assert.equal(missing(b, "study").length, 1, "the sub-item itself asks for its rating");
  // The study is under way: the root is in progress, and neither asks for a rating.
  await op.setPlan({ author, id: "study", row: { id: "build", text: "做调研", state: "doing" } });
  assert.equal(rules(store.snapshot()).statusOf("study-root"), "wip");
  assert.equal(missing(b, "study-root").length, 0, "an in-progress root under a study asks for none");
  assert.equal(missing(b, "study").length, 0, "the study is being done, so its rating is not the next thing");
  await op.setPlan({ author, id: "study", row: { id: "build", text: "做调研", state: "done" } });
  await op.setPlan({ author, id: "study", row: { id: "acc", accept: true, text: "通过", state: "done" } });
  // The finished study is part of the root's plan, so the root is part way and nobody holds it.
  assert.equal(rules(store.snapshot()).statusOf("study-root"), "idle");
  assert.equal(missing(b, "study-root").length, 1, "once the sub-item is done, the root's own step is next and it asks");
});

test("缺难度 is not raised for an item in progress, even with a ready todo step beside its doing step", async t => {
  const b = await withArchitect(t); const { store, op, unrated } = b;
  await unrated("busy");
  // The doing step and the parallel todo step are both ready; the todo step waits on nothing, so only the item's state keeps the check off.
  await op.setPlan({ author, id: "busy", row: { id: "step", text: "在做的一步", state: "doing", after: [] } });
  await op.setPlan({ author, id: "busy", row: { id: "other", text: "并行的一步", state: "todo", after: [] } });
  assert.equal(rules(store.snapshot()).statusOf("busy"), "wip");
  assert.equal(missing(b, "busy").length, 0, "an item in progress is being done, not waiting for a rating");
});

test("缺难度 waits while the next step waits on another item, and while the next step's text says it waits", async t => {
  const b = await withArchitect(t); const { store, op, unrated } = b;
  await unrated("dep"); await unrated("waiter");
  // Put the shared row to dep first, so the acceptance step after it is not ready and the item is blocked.
  await store.commit({ author, message: "Seed a waiter", puts: [{ kind: "item", id: "waiter", expectRev: store.snapshot().items.waiter!.rev, doc: { title: "等别的条目的", group: author, plan: [{ id: "dep", item: "dep", own: false, after: [] }, { id: "accept", accept: true, text: "通过", state: "todo" }], updated: at, head: "**完成条件**：通过" } }] });
  assert.equal(rules(store.snapshot()).statusOf("waiter"), "blocked");
  assert.equal(missing(b, "waiter").length, 0, "the next step waits on dep, so the rating is not what holds it");
  assert.equal(missing(b, "dep").length, 1, "dep itself asks, as an unpaused root needs it");
  // A todo step whose waits text says it waits is no next step either.
  await unrated("texty");
  await op.setPlan({ author, id: "texty", row: { id: "acc", accept: true, text: "通过", state: "todo", waits: "等 Firn 的结果" } });
  assert.equal(missing(b, "texty").length, 0, "its next step's text says it waits, so the item is not startable apart from the rating");
});

test("backlog work is needed once a needed item other than its record holds a row for it, and what hangs under it with it", async t => {
  const b = await withArchitect(t); const { store, op, unrated } = b;
  await op.createItem({ ...asArchitect, key: "rec", group: author, record: true, title: "待选池" });
  await unrated("backlog", { owner: "rec", group: undefined });
  await op.createItem({ ...asArchitect, key: "under", owner: "backlog", title: "待选下面的", accept: "通过" });
  await unrated("root");
  const needed = () => ["backlog", "under"].map(id => rules(store.snapshot()).isNeeded(id));
  assert.deepEqual(needed(), [false, false], "only its record holds it");
  await op.setPlan({ author, id: "root", row: { item: "backlog", own: false, after: [] } });
  assert.deepEqual(needed(), [true, true], "a root also waits on it, and what hangs under it follows");
  assert.deepEqual([missing(b, "backlog").length, missing(b, "under").length], [0, 1], "backlog's next step is under, so only under asks");
  await op.setPause({ ...asArchitect, id: "root", paused: true, reason: "先放一放" });
  assert.deepEqual(needed(), [false, false], "the root that held it is paused");
});

test("brief lists as startable only rated items, and carries the difficulty on its rows", async t => {
  const b = await withArchitect(t); const { store, op, unrated } = b;
  await unrated("u"); await unrated("one"); await unrated("five");
  await op.setDifficultyMany({ ...asArchitect, items: [{ id: "one", difficulty: 1, reason: "r" }, { id: "five", difficulty: 5, reason: "r" }] });
  const s = store.snapshot(), r = rules(s), todo = brief(s, r, author).todo;
  assert.ok(todo.some(row => row.id === "five" && row.difficulty === 5), "a rated item is listed with its difficulty");
  assert.ok(todo.some(row => row.id === "one" && row.difficulty === 1), "so is the lowest level");
  assert.ok(!todo.some(row => row.id === "u"), "an unrated item is not startable");
  const checks = brief(s, r, author).checks;
  const labels = (id: string) => checks.find(row => row.id === id)?.checks.map(c => c.label);
  assert.ok(checks.some(row => row.id === "u" && !("difficulty" in row)), "the checks list names the unrated item, without a difficulty");
  assert.ok(labels("u")!.includes("缺难度"));
});

test("every section of brief carries the difficulty, and only an item a root needs is startable", async t => {
  const b = await withArchitect(t); const { store, op, unrated } = b;
  // wip: a doing step. paused: an explicit pause. progress: a blocked item (its card has three options and its place in the head,
  // so the item carries no check and is not listed under checks instead) and a record cannot carry one.
  await unrated("working"); await op.setPlan({ author, id: "working", row: { id: "go", text: "进行", state: "doing" } });
  await unrated("held"); await op.setPause({ ...asArchitect, id: "held", paused: true, reason: "先放一放" });
  await unrated("waits", { head: "选哪个在这里问。\n\n[[q:wait-card]]" }); await op.writeCard({ author, key: "wait-card", item: "waits", kind: "design", question: "选哪个？", confidence: { reason: "判断" }, options: [{ text: "甲", detail: "做甲" }, { text: "乙", detail: "做乙" }, { text: "丙", detail: "做丙" }], blocks: "停着" });
  await op.setPlan({ author, id: "waits", row: { card: "wait-card", after: [] } });
  await unrated("todo-one"); await unrated("paused-need"); await unrated("live-need");
  for (const key of ["only-paused-needs", "needed-by-live"]) await op.createItem({ ...asArchitect, key, group: "Firn", title: key, accept: "通过" });
  await op.setPlan({ author, id: "paused-need", row: { item: "only-paused-needs", own: false, after: [] } });
  await op.setPlan({ author, id: "live-need", row: { item: "needed-by-live", own: false, after: [] } });
  await op.setPause({ ...asArchitect, id: "paused-need", paused: true, reason: "先放一放" });
  await op.setDifficultyMany({ ...asArchitect, reason: "r", items: ["working", "held", "waits", "todo-one", "only-paused-needs", "needed-by-live"].map(id => ({ id, difficulty: 3 as const })) });
  const s = store.snapshot(), r = rules(s), result = brief(s, r, author);
  const has = (rows: Array<{ id: string; difficulty?: unknown }>, id: string) => rows.find(row => row.id === id)?.difficulty;
  assert.equal(has(result.wip, "working"), 3, "wip");
  assert.equal(has(result.paused, "held"), 3, "paused");
  assert.equal(has(result.todo, "todo-one"), 3, "todo");
  assert.equal(has(result.outgoing, "needed-by-live"), 3, "outgoing: another project's work an open item waits on");
  assert.equal(has(result.progress, "waits"), 3, "progress: a blocked item");
  assert.equal(has(result.checks, "todo-one"), 3, "checks: a rated item whose only check is another one");
  const firn = brief(s, r, "Firn").todo.map(row => row.id);
  assert.ok(firn.includes("needed-by-live"), "work an unpaused root waits on is startable");
  assert.ok(!firn.includes("only-paused-needs"), "work only a paused root needs is not startable");
  assert.equal(rules(s).isNeeded("todo-one"), true);
});

test("context and list rows show the difficulty after the tags, and nothing for an unrated item", async t => {
  const b = await withArchitect(t); const { store, op, unrated } = b;
  await unrated("u");
  await op.setDifficulty({ ...asArchitect, id: "a", difficulty: 4, reason: "r" });
  await op.setDifficulty({ ...asArchitect, id: "b", difficulty: 5, reason: "r" });
  const s = store.snapshot(), r = rules(s);
  const ctx = (id: string) => context(s, r, id) as unknown as { difficulty?: unknown };
  assert.equal(ctx("a").difficulty, 4); assert.equal(ctx("b").difficulty, 5); assert.equal("difficulty" in ctx("u"), false);
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
  assert.equal(refused.error, true); assert.match(refused.text, rx`only ${PROCESS_WRITERS}`);
  assert.equal((await call("set_difficulty", { ...asArchitect, id: "u", difficulty: 7, reason: "r" })).error, true, "the schema refuses 7");
  const set = await call("set_difficulty", { ...asArchitect, id: "u", difficulty: 3, reason: "要查并发" });
  assert.equal(set.error, false); assert.match(set.text, /^set_difficulty u · rev \d+ · commit [0-9a-f]{40}\nu · TODO · 未评级 u · 难度 3 · Whitefoot › u/);
  assert.doesNotMatch((await call("context", { id: "u" })).text, /check: 缺难度/);
  assert.match((await call("context", { id: "u" })).text.split("\n")[0]!, / · 难度 3 · Whitefoot/);
  assert.match((await call("list", { filters: { group: author } })).text, /未评级 u · 难度 3 · Whitefoot/);
  assert.equal((await call("set_difficulty", { ...asArchitect, id: "u", difficulty: "architect", reason: "已取消的一级" })).error, true, "the schema refuses the retired level");
  assert.doesNotMatch((await client.listTools()).tools.map(x => x.description).join("\n"), /架构师做|"architect"/, "no tool description offers the retired level");
  const many = await call("set_difficulty_many", { ...asArchitect, reason: "补评", items: [{ id: "a", difficulty: 1 }, { id: "b", difficulty: 5, reason: "难" }] });
  assert.equal(many.error, false); assert.match(many.text, /^set_difficulty 2 items · commit [0-9a-f]{40}$/);
  assert.deepEqual([store.snapshot().items.a!.difficulty, store.snapshot().items.b!.difficulty], [1, 5]);
  const brief = JSON.parse((await call("brief", { project: author })).text);
  assert.ok(JSON.stringify(brief).includes('"difficulty":1'), "brief rows carry the difficulty");
  assert.equal(brief.todo.find((row: { id: string }) => row.id === "u")?.difficulty, 3, "a rated item with a ready step is in todo, with its difficulty");
});

test("a first rating is not unread for the owner, a changed level is, and a log-only write never is", async t => {
  const { store, op, unrated } = await withArchitect(t);
  await unrated("u");
  const head = () => store.snapshot().head;
  const steps = async (since: string) => (await unreadSteps(store, since)).filter(step => step.docs.some(d => d.id === "u"));
  let cursor = head();
  await op.setDifficulty({ ...asArchitect, id: "u", difficulty: 2, reason: "第一次评级" });
  assert.deepEqual(await steps(cursor), [], "none to a level is bookkeeping, not news");
  cursor = head();
  await op.appendLog({ author, id: "u", text: "只改日志" });
  assert.deepEqual(await steps(cursor), [], "a log line is never news");
  cursor = head();
  await op.setDifficulty({ ...asArchitect, id: "u", difficulty: 4, reason: "改级" });
  const changed = await steps(cursor);
  assert.equal(changed.length, 1, "changing a level that exists is news");
  assert.equal(changed[0]!.docs[0]!.summary, "difficulty changed"); assert.deepEqual(changed[0]!.docs[0]!.pieces, { progress: 0, reply: 0, other: 1 });
  // Several writes in one stretch: the first rating still is not news, the change after it is.
  await unrated("v"); cursor = head();
  await op.setDifficulty({ ...asArchitect, id: "v", difficulty: 1, reason: "r" });
  await op.setDifficulty({ ...asArchitect, id: "v", difficulty: 5, reason: "r" });
  const stretch = (await unreadSteps(store, cursor)).filter(step => step.docs.some(d => d.id === "v"));
  assert.equal(stretch.length, 1); assert.deepEqual(stretch[0]!.commits.length, 1, "only the second write, whose baseline is the rated item");
  // One commit that rates for the first time and edits the plan: only the plan edit counts.
  await unrated("w"); cursor = head();
  const w = store.snapshot().items.w!;
  await store.commit({ author: "Architect", message: "rate and edit plan", puts: [{ kind: "item", id: "w", expectRev: w.rev, doc: { ...w, difficulty: 3, plan: w.plan.map(row => "text" in row ? { ...row, text: "改了" } : row), updated: "2026-10-16T00:00:00Z" } }] });
  const combined = (await unreadSteps(store, cursor)).filter(step => step.docs.some(d => d.id === "w"));
  assert.equal(combined.length, 1); assert.equal(combined[0]!.docs[0]!.summary, "plan changed"); assert.deepEqual(combined[0]!.docs[0]!.pieces, { progress: 1, reply: 0, other: 0 });
});

test("piecesOf leaves a first rating and the cleared retired level out and keeps every other change of the item", () => {
  const base = { title: "t", group: "g", plan: [], log: [], links: [], rev: 1, updated: "2026-10-16T00:00:00Z" };
  const pieces = (before: object | null, after: object | null) => piecesOf(before, after, "item", "difficulty changed");
  assert.deepEqual(pieces(base, { ...base, difficulty: 2 }), { progress: 0, reply: 0, other: 0 }, "first rating");
  assert.deepEqual(pieces({ ...base, difficulty: 2 }, { ...base, difficulty: 3 }).other, 1, "a changed level");
  assert.deepEqual(pieces({ ...base, difficulty: 2 }, { ...base, difficulty: 5 }).other, 1);
  // The migration that cleared the retired level 「架构师做」 is bookkeeping too, and still shows another change beside it.
  assert.deepEqual(pieces({ ...base, difficulty: "architect" }, base), { progress: 0, reply: 0, other: 0 }, "the retired level cleared");
  assert.deepEqual(pieces({ ...base, difficulty: "architect" }, { ...base, head: "新" }).other, 1, "a clearing beside another visible change still shows that change");
  assert.deepEqual(pieces({ ...base, difficulty: 2 }, base).other, 1, "any other level taken away is a change");
  assert.deepEqual(pieces(base, { ...base, difficulty: 2, head: "新" }).other, 1, "a first rating beside another visible change still shows that change");
  assert.deepEqual(pieces(null, { ...base, difficulty: 2 }).other, 1, "a new item is new, rated or not");
});

test("create_item rates the new item, logs the reason it was given as the first rating, and refuses a bad value, a missing reason, a record and any other writer", async t => {
  const { store, op } = await withArchitect(t);
  // Only the architect creates items, in any project, so the same call rates an item of any project.
  const create = { key: "n1", group: author, title: "新条目", accept: "通过" };
  await op.createItem({ ...asArchitect, ...create, difficulty: 3, difficultyReason: "要定一个新的判据，不止改一处" });
  const n1 = store.snapshot().items.n1!;
  assert.equal(n1.difficulty, 3); assert.deepEqual(n1.log.map(l => l.text), ["难度：未评 → 3，理由：要定一个新的判据，不止改一处"], "the log says the reason the caller gave, nothing written for it");
  assert.equal(rules(store.snapshot()).checks("n1").filter(c => c.label === "缺难度").length, 0, "rated at birth, no check");
  await op.createItem({ ...asArchitect, ...create, key: "n2", difficulty: 1, difficultyReason: "  只改一行  " });
  assert.deepEqual(store.snapshot().items.n2!.log.map(l => l.text), ["难度：未评 → 1，理由：只改一行"], "the reason is logged without the blanks around it");
  await op.createItem({ ...asArchitect, ...create, key: "n3" });
  assert.equal(store.snapshot().items.n3!.difficulty, undefined, "no difficulty given, none stored"); assert.deepEqual(store.snapshot().items.n3!.log, [], "and no rating logged");
  const before = store.snapshot(), count = (await store.log()).length;
  const reason = "有理由";
  await refuses(op.createItem({ author, key: "x1", group: author, title: "别人建的", accept: "通过", difficulty: 2, difficultyReason: reason }), rx`only ${PROCESS_WRITERS} may create items`);
  await refuses(op.createItem({ ...asArchitect, ...create, key: "x2", difficulty: 9 as never, difficultyReason: reason }), /difficulty: give an integer 1–5$/);
  await refuses(op.createItem({ ...asArchitect, ...create, key: "x4", difficulty: "architect" as never, difficultyReason: reason }), /difficulty: give an integer 1–5$/);
  await refuses(op.createItem({ ...asArchitect, key: "x3", group: author, record: true, title: "记录", difficulty: 2, difficultyReason: reason }), /a record has no difficulty/);
  // A rating with no reason, a blank one or one that is not text is refused, as set_difficulty refuses it, and the message says what to add.
  for (const bad of [undefined, "", "   ", 3 as never, null as never]) await refuses(op.createItem({ ...asArchitect, ...create, key: "x5", difficulty: 2, ...(bad === undefined ? {} : { difficultyReason: bad }) }), /difficultyReason: say why the difficulty is this, for the log$/);
  await refuses(op.createItem({ ...asArchitect, ...create, key: "x6", difficultyReason: reason }), /difficultyReason: given without a difficulty; give both or neither$/);
  assert.deepEqual(store.snapshot(), before); assert.equal((await store.log()).length, count, "a refusal makes no commit");
});

test("the MCP create_item takes difficulty and brief says what its todo lists", async t => {
  const { store, op } = await withArchitect(t);
  const server = createMcpServer({ store, ops: op, now: () => "2026-10-12T00:00:00Z" });
  const client = new Client({ name: "Difficulty create", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  assert.ok("difficulty" in tools.find(x => x.name === "create_item")!.inputSchema.properties!);
  assert.ok("difficultyReason" in tools.find(x => x.name === "create_item")!.inputSchema.properties!, "the reason has a parameter of its own");
  assert.match(tools.find(x => x.name === "create_item")!.description!, /A difficulty requires difficultyReason/, "the tool says a rating needs its reason");
  assert.match(tools.find(x => x.name === "brief")!.description!, /next tasks \(only items rated 1–5/);
  for (const name of ["create_item", "set_difficulty"]) assert.match(tools.find(x => x.name === name)!.description!, /engineer\b.*own subtree/, `${name} says where an engineer may use it`);
  assert.match(tools.find(x => x.name === "set_difficulty")!.description!, /never that item itself/, "set_difficulty says the root is not the engineer's to rate");
  assert.match((tools.find(x => x.name === "reply_note")!.inputSchema.properties!.replace as { description: string }).description, rx`Only author ${PROCESS_WRITERS} replaces a reply it did not write; everyone else replaces only their own`, "reply_note says whose reply replace may overwrite");
  const call = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({ name, arguments: args }); return { error: r.isError === true, text: (r.content as Array<{ text: string }>).map(c => c.text).join("\n") }; };
  const made = await call("create_item", { ...asArchitect, key: "m1", group: author, title: "经工具建的", accept: "通过", difficulty: 2, difficultyReason: "改一个参数，没有新决定" });
  assert.equal(made.error, false); assert.match(made.text, /经工具建的 · 难度 2 · Whitefoot/);
  assert.deepEqual(store.snapshot().items.m1!.log.map(l => l.text), ["难度：未评 → 2，理由：改一个参数，没有新决定"], "the reason that came through the tool is the one logged");
  const unexplained = await call("create_item", { ...asArchitect, key: "m3", group: author, title: "没写理由的", accept: "通过", difficulty: 2 });
  assert.equal(unexplained.error, true); assert.match(unexplained.text, /difficultyReason: say why the difficulty is this, for the log/);
  assert.equal(store.snapshot().items.m3, undefined, "the refused call created nothing");
  const refused = await call("create_item", { author, key: "m2", group: author, title: "别人建的", accept: "通过", difficulty: 2, difficultyReason: "有理由" });
  assert.equal(refused.error, true); assert.match(refused.text, rx`only ${PROCESS_WRITERS} may create items`);
});
