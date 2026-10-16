import { test } from "node:test";
import assert from "node:assert/strict";
import { OpError } from "../src/ops.ts";
import { rules } from "../src/rules.ts";
import { Store } from "../src/store.ts";
import { board, later, author } from "./helpers.ts";

// The fixture: Whitefoot's `area` (root, P1) owns `a` and `b`; `b` also waits on `a` and on a's card; `other` is Firn's.
const structural = /^(跨项目拥有|同项目有条目在等它|被多个条目拥有)/;

test("an item moves with everything it owns; number, history, notes and cards stay with it", async t => {
  const { store, op, dir } = await board(t);
  const before = store.snapshot(), count = (await store.log()).length;
  const result = await op.moveItemProject({ author, id: "area", project: "Firn" });
  const after = store.snapshot(), log = await store.log({ limit: 1 });
  assert.equal(result.commit, after.head);
  assert.equal((await store.log()).length, count + 1, "one commit");
  assert.equal(log[0]!.message, "move_item_project area Firn");
  assert.equal(log[0]!.author, author);
  assert.deepEqual(log[0]!.files.slice().sort(), ["items/a.yaml", "items/area.yaml", "items/b.yaml"], "the item and what it owns, nothing else");
  for (const id of ["area", "a", "b"]) {
    const was = before.items[id]!, now = after.items[id]!;
    assert.equal(now.group, "Firn");
    assert.equal(now.num, was.num, "the number never changes");
    assert.deepEqual({ ...now, group: was.group, updated: was.updated, rev: was.rev, log: was.log }, was, "only the project and the log change");
    assert.deepEqual(now.log.slice(0, -1), was.log);
    assert.equal(now.log.at(-1)!.at, later);
    assert.equal(now.log.at(-1)!.by, author);
  }
  assert.equal(after.items.area!.log.at(-1)!.text, "换项目：从 Whitefoot 换到 Firn");
  assert.equal(after.items.a!.log.at(-1)!.text, "换项目：从 Whitefoot 换到 Firn（随「解释器工作」）");
  assert.deepEqual(after.decisions, before.decisions, "cards belong to their item and are not rewritten");
  assert.deepEqual(after.notes, before.notes);
  const r = rules(after);
  assert.deepEqual(r.cardsOf("a"), rules(before).cardsOf("a"));
  assert.equal(r.parentOf("a"), "area", "ownership inside the moved part is untouched");
  assert.equal(r.priorityOf("area"), "P1", "a root keeps its priority");
  for (const id of ["area", "a", "b"]) assert.deepEqual(r.checks(id), rules(before).checks(id), "the move adds no check");
  const history = await store.log({ kind: "item", id: "a" });
  assert.ok(history.length >= 2 && history[0]!.commit === result.commit, "the item's history continues in the same file");
  assert.deepEqual(await store.show("item", "a", history[1]!.commit), before.items.a, "the revision before the move is still readable");
  assert.deepEqual((await Store.open(dir)).snapshot(), after);
});

test("an owner left behind keeps a shared row in the same place", async t => {
  const { store, op } = await board(t);
  const before = store.snapshot();
  await assert.rejects(op.moveItemProject({ author, id: "a", project: "Firn", priority: "P0" }), /priority: a 有未完成的条目依赖它/);
  assert.deepEqual(store.snapshot(), before, "a refusal changes nothing");
  await op.moveItemProject({ author, id: "a", project: "Firn" });
  const after = store.snapshot(), r = rules(after);
  assert.equal(after.items.a!.group, "Firn");
  assert.deepEqual(after.items.area!.plan.map(row => row.id), before.items.area!.plan.map(row => row.id), "rows keep their order");
  assert.deepEqual(after.items.area!.plan.find(row => row.id === "a"), { id: "a", item: "a", own: false, after: [] });
  assert.deepEqual(after.items.area!.plan.find(row => row.id === "b"), before.items.area!.plan.find(row => row.id === "b"));
  assert.equal(after.items.area!.log.at(-1)!.text, "「中文检查」换到了项目 Firn；计划不再拥有，改成依赖");
  assert.equal(r.parentOf("a"), undefined);
  assert.equal(r.isRoot("a"), false);
  assert.equal(r.priorityOf("a"), "P1", "its priority now comes from the items waiting on it");
  for (const id of ["a", "area", "b"]) assert.deepEqual(r.checks(id).filter(c => structural.test(c.text)), [], "no cross-project ownership is left");
});

test("a descendant at any depth and in any state moves along", async t => {
  const { store, op } = await board(t);
  await op.createItem({ author, key: "p", group: author, title: "Release", priority: "P0", accept: "Release passes" });
  await op.createItem({ author, key: "c", owner: "p", title: "Part", accept: "Part passes" });
  await op.createItem({ author, key: "g", owner: "c", title: "Grandpart", accept: "Grandpart passes" });
  await op.setStatus({ author, id: "g", status: "cancelled", log: "Not needed" });
  await op.moveItemProject({ author, id: "p", project: "Firn" });
  const s = store.snapshot();
  assert.deepEqual(["p", "c", "g"].map(id => s.items[id]!.group), ["Firn", "Firn", "Firn"]);
  assert.equal(s.items.g!.status, "cancelled");
  assert.match(s.items.g!.log.at(-1)!.text, /随「Release」/);
});

test("a root without a stored priority must be given one; a non-root refuses it", async t => {
  const { store, op } = await board(t);
  await op.createItem({ author, key: "backlog", title: "Backlog", group: author, record: true });
  await op.createItem({ author, key: "idea", owner: "backlog", title: "Idea", accept: "Idea passes" });
  assert.equal(rules(store.snapshot()).isBacklog("idea"), true);
  const before = store.snapshot();
  await assert.rejects(op.moveItemProject({ author, id: "idea", project: "Firn" }), /priority: idea becomes a root of Firn; give priority/);
  assert.deepEqual(store.snapshot(), before);
  await op.moveItemProject({ author, id: "idea", project: "Firn", priority: "P2" });
  const s = store.snapshot(), r = rules(s);
  assert.equal(s.items.idea!.priority, "P2");
  assert.equal(r.isRoot("idea"), true);
  assert.equal(r.priorityOf("idea"), "P2");
  assert.deepEqual(s.items.backlog!.plan.find(row => row.id === "idea"), { id: "idea", item: "idea", own: false });
});

test("a closed item moves without a priority", async t => {
  const { store, op } = await board(t);
  await op.setPlan({ author, id: "a", rows: [{ id: "accept", accept: true, text: "独立验收通过", state: "done" }] });
  assert.equal(rules(store.snapshot()).statusOf("a"), "done");
  await op.moveItemProject({ author, id: "a", project: "Firn" });
  assert.equal(store.snapshot().items.a!.group, "Firn");
  assert.equal(store.snapshot().items.a!.priority, undefined);
});

test("refusals name the fix and leave the board and the log untouched", async t => {
  const { store, op, dir } = await board(t);
  await op.setTag({ author: "总管", name: "只在白脚", meaning: "只给 Whitefoot 的条目", projects: ["Whitefoot"] });
  await op.setTags({ author, id: "b", tags: ["只在白脚"] });
  await op.setPlan({ author: "Firn", id: "other", row: { item: "a", own: false } });
  const before = store.snapshot(), count = (await store.log()).length;
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.moveItemProject({ author, id: "a", project: "Nowhere" }), /project Nowhere.*configured project/],
    [() => op.moveItemProject({ author, id: "a", project: "Whitefoot" }), /project: a is already in Whitefoot/],
    [() => op.moveItemProject({ author, id: "missing", project: "Firn" }), /id missing.*existing item/],
    [() => op.moveItemProject({ author: "Firn", id: "a", project: "Firn" }), /item a belongs to project Whitefoot; file a request into Whitefoot/],
    [() => op.moveItemProject({ author: "总管", id: "a", project: "Firn" }), /item a belongs to project Whitefoot; file a request into Whitefoot/],
    // A tag of the moved part that the new project may not use.
    [() => op.moveItemProject({ author, id: "b", project: "Firn" }), /item b: tags 只在白脚: applies only to Whitefoot, not Firn/],
    [() => op.moveItemProject({ author, id: "area", project: "Firn" }), /item b: tags 只在白脚: applies only to Whitefoot, not Firn/],
    // other (Firn) waits on a through a shared row: a would arrive there owned by nothing.
    [() => op.moveItemProject({ author, id: "a", project: "Firn" }), /project: other in Firn still wait on a.*同项目有条目在等它，却没有条目拥有它/],
  ];
  for (const [call, message] of cases) {
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError); assert.match(e.message, message); return true; });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count, "a refusal makes no commit");
  }
});

test("a waiter in the new project is fine when the item arrives owned", async t => {
  const { store, op } = await board(t);
  await op.setPlan({ author: "Firn", id: "other", row: { item: "a", own: false } });
  await op.moveItemProject({ author, id: "area", project: "Firn" });
  const r = rules(store.snapshot());
  assert.equal(r.parentOf("a"), "area");
  assert.deepEqual(r.checks("a").filter(c => structural.test(c.text)), []);
});

test("a stored cross-project owned row blocks the move with its own name", async t => {
  const { store, op } = await board(t);
  const b = store.snapshot().items.b!;
  await store.commit({ author: "Fixture", message: "Stored violation", puts: [{ kind: "item", id: "b", expectRev: b.rev, doc: { ...b, group: "Firn", updated: later } }] });
  const before = store.snapshot();
  await assert.rejects(op.moveItemProject({ author, id: "area", project: "总管" }), /item b: owned by area but belongs to project Firn, not Whitefoot; fix its 跨项目拥有 first/);
  assert.deepEqual(store.snapshot(), before);
});

test("a paused chain is not left by open work without 总管, and an explicit pause travels", async t => {
  const { store, op } = await board(t);
  await op.setPause({ author: "总管", id: "area", paused: true, reason: "Owner chose to wait" });
  const before = store.snapshot();
  await assert.rejects(op.moveItemProject({ author, id: "a", project: "Firn" }), /paused.*only the owner or 总管 can resume/);
  assert.deepEqual(store.snapshot(), before);
  await op.moveItemProject({ author, id: "area", project: "Firn" });
  const r = rules(store.snapshot());
  assert.deepEqual(["area", "a", "b"].map(id => r.statusOf(id)), ["paused", "paused", "paused"], "the marker moves with the item and its parts stay under it");
});
