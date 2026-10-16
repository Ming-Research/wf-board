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
  await assert.rejects(op.moveItemProject({ author, id: "idea", project: "Firn" }), /priority: idea becomes a root of Firn with no stored priority; give priority/);
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
    [() => op.moveItemProject({ author, id: "a", project: "Firn" }), /project: 同项目有条目在等它，却没有条目拥有它: other in Firn wait on a through shared rows.*This call cannot name a new owner for a: have Firn drop those rows with set_plan first, move a, then let the item that needs it own it/],
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

test("a stored cross-project owned row blocks the move, named the same for the item and for what it owns", async t => {
  const { store, op } = await board(t);
  const b = store.snapshot().items.b!;
  // b, owned by area of Whitefoot, belongs to Firn.
  await store.commit({ author: "Fixture", message: "Stored violation", puts: [{ kind: "item", id: "b", expectRev: b.rev, doc: { ...b, group: "Firn", updated: later } }] });
  let before = store.snapshot();
  await assert.rejects(op.moveItemProject({ author, id: "area", project: "总管" }), /item b: owned by area of project Whitefoot but belongs to project Firn \(跨项目拥有\); fix that with set_plan first/);
  assert.deepEqual(store.snapshot(), before);
  await store.commit({ author: "Fixture", message: "Restore", puts: [{ kind: "item", id: "b", expectRev: store.snapshot().items.b!.rev, doc: { ...b, updated: later } }] });
  // area, of Whitefoot, is owned by other of Firn.
  const other = store.snapshot().items.other!;
  await store.commit({ author: "Fixture", message: "Stored violation", puts: [{ kind: "item", id: "other", expectRev: other.rev, doc: { ...other, plan: [{ id: "area", item: "area", own: true }, ...other.plan], updated: later } }] });
  before = store.snapshot();
  await assert.rejects(op.moveItemProject({ author, id: "area", project: "总管" }), /item area: owned by other of project Firn but belongs to project Whitefoot \(跨项目拥有\); fix that with set_plan first/);
  assert.deepEqual(store.snapshot(), before);
});

test("the ways out of a waiter's refusal work", async t => {
  const { store, op } = await board(t);
  await op.setPlan({ author: "Firn", id: "other", row: { item: "a", own: false } });
  await assert.rejects(op.moveItemProject({ author, id: "a", project: "Firn" }), /other in Firn wait on a/);
  // Drop the row, move, then let the item that needs it own it.
  await op.setPlan({ author: "Firn", id: "other", remove: "a" });
  await op.moveItemProject({ author, id: "a", project: "Firn" });
  await op.setPlan({ author: "Firn", id: "other", row: { item: "a", own: true } });
  const r = rules(store.snapshot());
  assert.equal(r.parentOf("a"), "other");
  assert.deepEqual(r.checks("a").filter(c => structural.test(c.text)), []);
});

test("a moved item that waits on an unowned top item of the new project is refused with both ways out, and each works", async t => {
  for (const way of ["own", "drop"] as const) {
    const { store, op } = await board(t);
    // a waits on Firn's other, a top item nothing owns.
    await op.setPlan({ author, id: "a", row: { item: "other", own: false } });
    const before = store.snapshot(), count = (await store.log()).length;
    await assert.rejects(op.moveItemProject({ author, id: "a", project: "Firn" }), e => {
      assert.ok(e instanceof OpError);
      assert.match(e.message, /project: 同项目有条目在等它，却没有条目拥有它: a will wait on other through a shared row while no item of Firn owns other\. Have an item of Firn own other first, or drop the row to other from that item's plan with set_plan first/);
      return true;
    });
    assert.deepEqual(store.snapshot(), before);
    assert.equal((await store.log()).length, count, "a refusal makes no commit");
    if (way === "own") {
      await op.createItem({ author: "Firn", key: "holder", group: "Firn", title: "Holder", priority: "P2", accept: "Holder passes" });
      await op.moveItem({ author: "Firn", id: "other", owner: "holder" });
    } else await op.setPlan({ author, id: "a", remove: "other" });
    await op.moveItemProject({ author, id: "a", project: "Firn" });
    const r = rules(store.snapshot());
    assert.equal(r.groupOf("a"), "Firn");
    for (const id of ["a", "other"]) assert.deepEqual(r.checks(id).filter(c => structural.test(c.text)), [], `${way}: no structural check on ${id}`);
  }
});

test("a closed item moves although an open item of the new project waits on it", async t => {
  const { store, op } = await board(t);
  await op.setPlan({ author, id: "a", rows: [{ id: "accept", accept: true, text: "独立验收通过", state: "done" }] });
  await op.setPlan({ author: "Firn", id: "other", row: { item: "a", own: false } });
  await op.moveItemProject({ author, id: "a", project: "Firn" });
  const r = rules(store.snapshot());
  assert.equal(r.groupOf("a"), "Firn");
  assert.deepEqual(r.checks("a").filter(c => structural.test(c.text)), []);
});

test("an item left behind may keep waiting on a part that moved away", async t => {
  const { store, op } = await board(t);
  await op.createItem({ author, key: "x", group: author, title: "Waiter", priority: "P2", accept: "Waiter passes", plan: [{ item: "a", own: false }] });
  const before = store.snapshot();
  await op.moveItemProject({ author, id: "area", project: "Firn" });
  const after = store.snapshot(), r = rules(after);
  assert.equal(after.items.x!.group, "Whitefoot");
  assert.deepEqual(after.items.x!.plan, before.items.x!.plan, "the waiter's row is untouched");
  assert.equal(r.groupOf("a"), "Firn");
  assert.equal(r.parentOf("a"), "area", "a is not a collecting item, and nothing asks for one");
  assert.deepEqual(r.checks("x").filter(c => structural.test(c.text)), []);
  assert.deepEqual(r.checks("a").filter(c => structural.test(c.text)), []);
});

test("a given priority replaces the stored one and the log says so; the same one adds nothing", async t => {
  const { store, op } = await board(t);
  await op.moveItemProject({ author, id: "area", project: "Firn", priority: "P1" });
  assert.equal(store.snapshot().items.area!.priority, "P1");
  assert.deepEqual(store.snapshot().items.area!.log.map(l => l.text).filter(text => text.startsWith("优先级")), [], "an unchanged priority writes no priority line");
  await op.moveItemProject({ author: "Firn", id: "area", project: "Whitefoot", priority: "P0" });
  const area = store.snapshot().items.area!;
  assert.equal(area.priority, "P0");
  assert.equal(area.log.at(-1)!.text, "优先级：P1 改为 P0");
  assert.equal(area.log.at(-2)!.text, "换项目：从 Firn 换到 Whitefoot");
  await op.moveItemProject({ author: "Whitefoot", id: "area", project: "Firn" });
  assert.equal(store.snapshot().items.area!.priority, "P0", "without priority the stored one stays");
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
