import { test } from "node:test";
import assert from "node:assert/strict";
import { OpError } from "../src/ops.ts";
import { rules } from "../src/rules.ts";
import { Store } from "../src/store.ts";
import { PROCESS_WRITERS } from "../src/model.ts";
import { board, later, author, asArchitect, retiredExactly, retiredPM, rx } from "./helpers.ts";

// The fixture: Whitefoot's `area` (root) owns `a` and `b`; `b` also waits on `a` and on a's card; `other` is Firn's.
const structural = /^(跨项目拥有|同项目有条目在等它|被多个条目拥有)/;

test("an item moves with everything it owns; number, history, notes and cards stay with it", async t => {
  const { store, op, dir } = await board(t);
  const before = store.snapshot(), count = (await store.log()).length;
  const result = await op.moveItemProject({ ...asArchitect, id: "area", project: "Firn" });
  const after = store.snapshot(), log = await store.log({ limit: 1 });
  assert.equal(result.commit, after.head);
  assert.equal((await store.log()).length, count + 1, "one commit");
  assert.equal(log[0]!.message, "move_item_project area Firn");
  assert.equal(log[0]!.author, asArchitect.author);
  assert.deepEqual(log[0]!.files.slice().sort(), ["items/a.yaml", "items/area.yaml", "items/b.yaml"], "the item and what it owns, nothing else");
  for (const id of ["area", "a", "b"]) {
    const was = before.items[id]!, now = after.items[id]!;
    assert.equal(now.group, "Firn");
    assert.equal(now.num, was.num, "the number never changes");
    assert.deepEqual({ ...now, group: was.group, updated: was.updated, rev: was.rev, log: was.log }, was, "only the project and the log change");
    assert.deepEqual(now.log.slice(0, -1), was.log);
    assert.equal(now.log.at(-1)!.at, later);
    assert.equal(now.log.at(-1)!.by, asArchitect.author);
  }
  assert.equal(after.items.area!.log.at(-1)!.text, "换项目：从 Whitefoot 换到 Firn");
  assert.equal(after.items.a!.log.at(-1)!.text, "换项目：从 Whitefoot 换到 Firn（随「解释器工作」）");
  assert.deepEqual(after.decisions, before.decisions, "cards belong to their item and are not rewritten");
  assert.deepEqual(after.notes, before.notes);
  const r = rules(after);
  assert.deepEqual(r.cardsOf("a"), rules(before).cardsOf("a"));
  assert.equal(r.parentOf("a"), "area", "ownership inside the moved part is untouched");
  for (const id of ["area", "a", "b"]) assert.deepEqual(r.checks(id), rules(before).checks(id), "the move adds no check");
  const history = await store.log({ kind: "item", id: "a" });
  assert.ok(history.length >= 2 && history[0]!.commit === result.commit, "the item's history continues in the same file");
  assert.deepEqual(await store.show("item", "a", history[1]!.commit), before.items.a, "the revision before the move is still readable");
  assert.deepEqual((await Store.open(dir)).snapshot(), after);
});

test("an owner left behind keeps a shared row in the same place", async t => {
  const { store, op } = await board(t);
  const before = store.snapshot();
  await op.moveItemProject({ ...asArchitect, id: "a", project: "Firn" });
  const after = store.snapshot(), r = rules(after);
  assert.equal(after.items.a!.group, "Firn");
  assert.deepEqual(after.items.area!.plan.map(row => row.id), before.items.area!.plan.map(row => row.id), "rows keep their order");
  assert.deepEqual(after.items.area!.plan.find(row => row.id === "a"), { id: "a", item: "a", own: false, after: [] });
  assert.deepEqual(after.items.area!.plan.find(row => row.id === "b"), before.items.area!.plan.find(row => row.id === "b"));
  assert.equal(after.items.area!.log.at(-1)!.text, "「中文检查」换到了项目 Firn；计划不再拥有，改成依赖");
  assert.equal(r.parentOf("a"), undefined);
  assert.equal(r.isRoot("a"), false);
  for (const id of ["a", "area", "b"]) assert.deepEqual(r.checks(id).filter(c => structural.test(c.text)), [], "no cross-project ownership is left");
});

test("a descendant at any depth and in any state moves along", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, key: "p", group: author, title: "Release", accept: "Release passes" });
  await op.createItem({ ...asArchitect, key: "c", owner: "p", title: "Part", accept: "Part passes" });
  await op.createItem({ ...asArchitect, key: "g", owner: "c", title: "Grandpart", accept: "Grandpart passes" });
  await op.setStatus({ ...asArchitect, id: "g", status: "cancelled", log: "Not needed" });
  await op.moveItemProject({ ...asArchitect, id: "p", project: "Firn" });
  const s = store.snapshot();
  assert.deepEqual(["p", "c", "g"].map(id => s.items[id]!.group), ["Firn", "Firn", "Firn"]);
  assert.equal(s.items.g!.status, "cancelled");
  assert.match(s.items.g!.log.at(-1)!.text, /随「Release」/);
});

test("backlog work that moves to another project becomes a root of it", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, key: "backlog", title: "Backlog", group: author, record: true });
  await op.createItem({ ...asArchitect, key: "idea", owner: "backlog", title: "Idea", accept: "Idea passes" });
  assert.equal(rules(store.snapshot()).isBacklog("idea"), true);
  await op.moveItemProject({ ...asArchitect, id: "idea", project: "Firn" });
  const s = store.snapshot(), r = rules(s);
  assert.equal(r.isRoot("idea"), true);
  assert.deepEqual(s.items.backlog!.plan.find(row => row.id === "idea"), { id: "idea", item: "idea", own: false });
});

test("a closed item moves", async t => {
  const { store, op } = await board(t);
  await op.setPlan({ author, id: "a", rows: [{ id: "accept", accept: true, text: "独立验收通过", state: "done" }] });
  assert.equal(rules(store.snapshot()).statusOf("a"), "done");
  await op.moveItemProject({ ...asArchitect, id: "a", project: "Firn" });
  assert.equal(store.snapshot().items.a!.group, "Firn");
});

test("refusals name the fix and leave the board and the log untouched", async t => {
  const { store, op, dir } = await board(t);
  await op.setTag({ ...asArchitect, name: "只在白脚", meaning: "只给 Whitefoot 的条目", projects: ["Whitefoot"] });
  await op.setTags({ author, id: "b", tags: ["只在白脚"] });
  await op.setPlan({ author: "Firn", id: "other", row: { item: "a", own: false } });
  const before = store.snapshot(), count = (await store.log()).length;
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.moveItemProject({ ...asArchitect, id: "a", project: "Nowhere" }), /project Nowhere.*configured project/],
    [() => op.moveItemProject({ ...asArchitect, id: "a", project: "Whitefoot" }), /project: a is already in Whitefoot/],
    [() => op.moveItemProject({ ...asArchitect, id: "missing", project: "Firn" }), /id missing.*existing item/],
    // Only the architect moves items between projects: the item's own project, another project and the Architect project without its session, and the retired 总管 and PM.
    ...[{ author }, { author, session: "架构师" }, { author, session: "PM" }, { author: "Firn" }, { author: "Architect" }, { author: "Architect", session: "engineer" }, { author: "Architect", session: "PM" }].map(who =>
      [() => op.moveItemProject({ ...who, id: "a", project: "Firn" }), rx`^author: only ${PROCESS_WRITERS} may move an item to another project$`] as [() => Promise<unknown>, RegExp]),
    [() => op.moveItemProject({ author: "总管", id: "a", project: "Firn" }), retiredExactly],
    [() => op.moveItemProject({ author: "PM", id: "a", project: "Firn" }), retiredPM],
    [() => op.moveItemProject({ author: "PM", session: "engineer", id: "a", project: "Firn" }), retiredPM],
    // A tag of the moved part that the new project may not use.
    [() => op.moveItemProject({ ...asArchitect, id: "b", project: "Firn" }), /item b: tags 只在白脚: applies only to Whitefoot, not Firn/],
    [() => op.moveItemProject({ ...asArchitect, id: "area", project: "Firn" }), /item b: tags 只在白脚: applies only to Whitefoot, not Firn/],
    // other (Firn) waits on a through a shared row: a would arrive there owned by nothing.
    [() => op.moveItemProject({ ...asArchitect, id: "a", project: "Firn" }), /project: 同项目有条目在等它，却没有条目拥有它: other in Firn wait on a through shared rows.*This call cannot name a new owner for a: have Firn drop those rows with set_plan first, move a, then let the item that needs it own it/],
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
  await op.moveItemProject({ ...asArchitect, id: "area", project: "Firn" });
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
  await assert.rejects(op.moveItemProject({ ...asArchitect, id: "area", project: "总管" }), /item b: owned by area of project Whitefoot but belongs to project Firn \(跨项目拥有\); fix that with set_plan first/);
  assert.deepEqual(store.snapshot(), before);
  await store.commit({ author: "Fixture", message: "Restore", puts: [{ kind: "item", id: "b", expectRev: store.snapshot().items.b!.rev, doc: { ...b, updated: later } }] });
  // area, of Whitefoot, is owned by other of Firn.
  const other = store.snapshot().items.other!;
  await store.commit({ author: "Fixture", message: "Stored violation", puts: [{ kind: "item", id: "other", expectRev: other.rev, doc: { ...other, plan: [{ id: "area", item: "area", own: true }, ...other.plan], updated: later } }] });
  before = store.snapshot();
  await assert.rejects(op.moveItemProject({ ...asArchitect, id: "area", project: "总管" }), /item area: owned by other of project Firn but belongs to project Whitefoot \(跨项目拥有\); fix that with set_plan first/);
  assert.deepEqual(store.snapshot(), before);
});

test("the ways out of a waiter's refusal work", async t => {
  const { store, op } = await board(t);
  await op.setPlan({ author: "Firn", id: "other", row: { item: "a", own: false } });
  await assert.rejects(op.moveItemProject({ ...asArchitect, id: "a", project: "Firn" }), /other in Firn wait on a/);
  // Drop the row, move, then let the item that needs it own it.
  await op.setPlan({ author: "Firn", id: "other", remove: "a" });
  await op.moveItemProject({ ...asArchitect, id: "a", project: "Firn" });
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
    await assert.rejects(op.moveItemProject({ ...asArchitect, id: "a", project: "Firn" }), e => {
      assert.ok(e instanceof OpError);
      assert.match(e.message, /project: 同项目有条目在等它，却没有条目拥有它: a will wait on other through a shared row while no item of Firn owns other\. Have an item of Firn own other first, or drop the row to other from that item's plan with set_plan first/);
      return true;
    });
    assert.deepEqual(store.snapshot(), before);
    assert.equal((await store.log()).length, count, "a refusal makes no commit");
    if (way === "own") {
      await op.createItem({ ...asArchitect, key: "holder", group: "Firn", title: "Holder", accept: "Holder passes" });
      await op.moveItem({ author: "Firn", id: "other", owner: "holder" });
    } else await op.setPlan({ author, id: "a", remove: "other" });
    await op.moveItemProject({ ...asArchitect, id: "a", project: "Firn" });
    const r = rules(store.snapshot());
    assert.equal(r.groupOf("a"), "Firn");
    for (const id of ["a", "other"]) assert.deepEqual(r.checks(id).filter(c => structural.test(c.text)), [], `${way}: no structural check on ${id}`);
  }
});

test("a closed item moves although an open item of the new project waits on it", async t => {
  const { store, op } = await board(t);
  await op.setPlan({ author, id: "a", rows: [{ id: "accept", accept: true, text: "独立验收通过", state: "done" }] });
  await op.setPlan({ author: "Firn", id: "other", row: { item: "a", own: false } });
  await op.moveItemProject({ ...asArchitect, id: "a", project: "Firn" });
  const r = rules(store.snapshot());
  assert.equal(r.groupOf("a"), "Firn");
  assert.deepEqual(r.checks("a").filter(c => structural.test(c.text)), []);
});

test("an item left behind may keep waiting on a part that moved away", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, key: "x", group: author, title: "Waiter", accept: "Waiter passes", plan: [{ item: "a", own: false }] });
  const before = store.snapshot();
  await op.moveItemProject({ ...asArchitect, id: "area", project: "Firn" });
  const after = store.snapshot(), r = rules(after);
  assert.equal(after.items.x!.group, "Whitefoot");
  assert.deepEqual(after.items.x!.plan, before.items.x!.plan, "the waiter's row is untouched");
  assert.equal(r.groupOf("a"), "Firn");
  assert.equal(r.parentOf("a"), "area", "a is not a collecting item, and nothing asks for one");
  assert.deepEqual(r.checks("x").filter(c => structural.test(c.text)), []);
  assert.deepEqual(r.checks("a").filter(c => structural.test(c.text)), []);
});

test("Architect moves open work out of a paused chain, and an explicit pause travels with the item", async t => {
  const moved = await board(t);
  await moved.op.setPause({ ...asArchitect, id: "area", paused: true, reason: "Owner chose to wait" });
  assert.equal(rules(moved.store.snapshot()).statusOf("a"), "paused", "a is paused through area");
  // The rule that keeps project authors from leaving a pause never applies: only Architect moves between projects, and it can resume.
  await moved.op.moveItemProject({ ...asArchitect, id: "a", project: "Firn" });
  assert.notEqual(rules(moved.store.snapshot()).statusOf("a"), "paused", "a left the paused chain");
  const whole = await board(t);
  await whole.op.setPause({ ...asArchitect, id: "area", paused: true, reason: "Owner chose to wait" });
  await whole.op.moveItemProject({ ...asArchitect, id: "area", project: "Firn" });
  const r = rules(whole.store.snapshot());
  assert.deepEqual(["area", "a", "b"].map(id => r.statusOf(id)), ["paused", "paused", "paused"], "the marker moves with the item and its parts stay under it");
});
