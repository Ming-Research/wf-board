// The writes of standing items (docs/design.md, section 5, Item plans, Standing items): creating one, marking an item standing and
// ordinary again, and what no write may build around one. The rules they rest on are in test/standing.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { OpError } from "../src/ops.ts";
import { rules } from "../src/rules.ts";
import { PROCESS_WRITERS } from "../src/model.ts";
import { Store } from "../src/store.ts";
import { board, author, asArchitect, rx } from "./helpers.ts";

/** Every call is refused with an `OpError` that matches, and nothing of the board or its data repository changes. */
async function refusedAll(store: Store, dir: string, cases: Array<[() => Promise<unknown>, RegExp]>): Promise<void> {
  const before = store.snapshot(), count = (await store.log()).length;
  for (const [call, message] of cases) {
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError, String(e)); assert.match(e.message, message); return true; });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
}

test("a standing item is created with no acceptance step and no difficulty, only by the architect", async t => {
  const { store, op, dir } = await board(t);
  const create = { ...asArchitect, key: "rules", group: author, title: "Keep the rules", standing: true };
  await refusedAll(store, dir, [
    [() => op.createItem({ ...create, accept: "Passes" }), /accept: required for work, refused for records and standing items/],
    [() => op.createItem({ ...create, difficulty: 2 }), /difficulty: a standing item has no difficulty/],
    [() => op.createItem({ ...create, record: true }), /standing: a record cannot be standing/],
    [() => op.createItem({ ...create, plan: [{ id: "accept", accept: true, text: "Passes", state: "todo" }] }), /plan: a standing item takes no acceptance step/],
    [() => op.createItem({ author, key: "rules", group: author, title: "Keep the rules", standing: true }), rx`author: only ${PROCESS_WRITERS} may create items`],
    [() => op.createItem({ ...create, group: undefined, owner: "area" }), /拥有一个常设条目.*rules.*a standing item never completes/],
  ]);
  await op.createItem(create);
  const made = store.snapshot().items.rules!;
  assert.equal(made.standing, true);
  assert.deepEqual(made.plan, []);
  assert.equal(made.difficulty, undefined);
  const r = rules(store.snapshot());
  assert.equal(r.statusOf("rules"), "wip");
  assert.deepEqual(r.checks("rules"), [], "nothing is asked of it: no acceptance step, no rating");
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
  // Under a standing item, ordinary work and another standing item are both welcome.
  await op.createItem({ ...asArchitect, key: "kid", owner: "rules", title: "Check the rules", accept: "Checked" });
  await op.createItem({ ...asArchitect, key: "nested", owner: "rules", title: "Nested promise", standing: true });
  assert.equal(rules(store.snapshot()).parentOf("nested"), "rules");
  assert.deepEqual(rules(store.snapshot()).checks("nested"), []);
});

test("update_item marks an item standing and ordinary again, logging what it takes away, and keeps record and standing apart", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "perf", group: author, title: "Hold the budget", accept: "Budget holds", difficulty: 2 });
  await op.createItem({ ...asArchitect, key: "log", group: author, title: "A log", record: true });
  const rev = store.snapshot().items.perf!.rev, recordRev = store.snapshot().items.log!.rev;
  await refusedAll(store, dir, [
    [() => op.updateItem({ author, id: "perf", rev, standing: true }), rx`author: only ${PROCESS_WRITERS} may mark an item standing or ordinary`],
    [() => op.updateItem({ ...asArchitect, id: "perf", rev, standing: true, accept: "Kept" }), /accept: refused for a standing item/],
    [() => op.updateItem({ ...asArchitect, id: "perf", rev, standing: true, record: true }), /an item is a record or standing, not both/],
    [() => op.updateItem({ ...asArchitect, id: "log", rev: recordRev, standing: true }), /an item is a record or standing, not both/],
  ]);
  await op.updateItem({ ...asArchitect, id: "perf", rev, standing: true });
  const marked = store.snapshot().items.perf!;
  assert.equal(marked.standing, true);
  assert.deepEqual(marked.plan, [], "the acceptance step is taken away");
  assert.equal(marked.difficulty, undefined, "and so is the rating");
  assert.match(marked.log.at(-1)!.text, /改为常设条目：一直进行中，不再有验收和难度；原验收：Budget holds；原难度：2/);
  assert.equal(rules(store.snapshot()).statusOf("perf"), "wip");
  await refusedAll(store, dir, [
    [() => op.updateItem({ ...asArchitect, id: "perf", rev: marked.rev, record: true }), /an item is a record or standing, not both/],
    [() => op.updateItem({ ...asArchitect, id: "perf", rev: marked.rev, standing: false }), /accept: required when changing a standing item to ordinary work/],
    [() => op.updateItem({ ...asArchitect, id: "perf", rev: marked.rev, accept: "Kept" }), /accept: only with a change from record or standing to work/],
    [() => op.setDifficulty({ ...asArchitect, id: "perf", difficulty: 2, reason: "Rate it" }), /difficulty: a standing item has no difficulty/],
    [() => op.setPlan({ ...asArchitect, id: "perf", row: { id: "accept", accept: true, text: "Kept", state: "todo" } }), /a standing item takes no acceptance step/],
  ]);
  // Marking it again changes nothing that matters: the same mode, the same plan.
  await op.updateItem({ ...asArchitect, id: "perf", rev: marked.rev, standing: true });
  assert.deepEqual(store.snapshot().items.perf!.plan, []);
  // Back to ordinary work: the acceptance step returns with the text given, the rating is asked for again.
  const standingRev = store.snapshot().items.perf!.rev;
  await op.updateItem({ ...asArchitect, id: "perf", rev: standingRev, standing: false, accept: "Budget holds again" });
  const back = store.snapshot().items.perf!;
  assert.equal(back.standing, undefined);
  assert.deepEqual(back.plan.filter(row => "accept" in row && row.accept).map(row => "text" in row ? row.text : ""), ["Budget holds again"]);
  assert.match(back.log.at(-1)!.text, /改为普通条目：状态由计划推导/);
  const r = rules(store.snapshot());
  assert.equal(r.statusOf("perf"), "todo");
  assert.deepEqual(r.checks("perf").map(c => c.id), ["difficulty-missing"]);
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
});

test("a done or cancelled item cannot become standing; a standing item can be cancelled, reopened and paused", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "fin", group: author, title: "Finished work", accept: "Done", difficulty: 2 });
  await op.setPlan({ author, id: "fin", row: { id: "accept", accept: true, text: "Done", state: "done" } });
  await op.createItem({ ...asArchitect, key: "gone", group: author, title: "Dropped work", accept: "Never", difficulty: 2 });
  await op.setStatus({ ...asArchitect, id: "gone", status: "cancelled", log: "Dropped" });
  assert.equal(rules(store.snapshot()).statusOf("fin"), "done");
  await refusedAll(store, dir, [
    [() => op.updateItem({ ...asArchitect, id: "fin", rev: store.snapshot().items.fin!.rev, standing: true }), /a done or cancelled item cannot become standing/],
    [() => op.updateItem({ ...asArchitect, id: "gone", rev: store.snapshot().items.gone!.rev, standing: true }), /a done or cancelled item cannot become standing/],
  ]);
  await op.createItem({ ...asArchitect, key: "rules", group: author, title: "Keep the rules", standing: true });
  const status = () => rules(store.snapshot()).statusOf("rules");
  assert.equal(status(), "wip");
  await op.setPause({ ...asArchitect, id: "rules", paused: true, reason: "Owner chose to wait" });
  assert.equal(status(), "paused");
  await op.setPause({ ...asArchitect, id: "rules", paused: false });
  assert.equal(status(), "wip");
  await op.setStatus({ ...asArchitect, id: "rules", status: "cancelled", log: "No longer promised" });
  assert.equal(status(), "cancelled");
  await op.setStatus({ ...asArchitect, id: "rules", status: "open", log: "Promised again" });
  assert.equal(status(), "wip", "reopened, it is in progress again, whatever its plan");
});

test("no write builds an ordinary item's row for a standing item, and a standing item's rows are free", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  await op.createItem({ ...asArchitect, key: "rules", group: author, title: "Keep the rules", standing: true });
  await op.createItem({ ...asArchitect, key: "perf", group: author, title: "Hold the budget", standing: true });
  const state = () => store.snapshot();
  await refusedAll(store, dir, [
    // An ordinary item that waits for it, owns it, or is moved under it by a write on the other side.
    [() => op.setPlan({ ...asArchitect, id: "other", row: { item: "rules", own: false } }), /等着一个常设条目.*rules.*a standing item never completes, so nothing waits for it or owns it/],
    [() => op.setPlan({ ...asArchitect, id: "other", row: { item: "rules", own: true } }), /拥有一个常设条目.*rules.*place the standing item at the top/],
    [() => op.moveItem({ ...asArchitect, id: "rules", owner: "area" }), /拥有一个常设条目.*rules/],
    // An ordinary item that already owns or waits for another one cannot be made standing: the row would never be resolved.
    [() => op.updateItem({ ...asArchitect, id: "a", rev: state().items.a!.rev, standing: true }), /(拥有|等着)一个常设条目.*a standing item never completes/],
    [() => op.updateItem({ ...asArchitect, id: "b", rev: state().items.b!.rev, standing: true }), /(拥有|等着)一个常设条目.*a standing item never completes/],
  ]);
  // A standing item's row for another standing item is resolved and draws as ∞, and its status does not move.
  await op.moveItem({ ...asArchitect, id: "perf", owner: "rules" });
  const r = rules(state());
  assert.equal(r.parentOf("perf"), "rules");
  assert.deepEqual(r.planRows("rules").map(row => [row.glyph, row.state, row.excluded]), [["∞", "resolved", true]]);
  assert.equal(r.statusOf("rules"), "wip");
  assert.equal(r.statusOf("perf"), "wip");
  assert.deepEqual(r.checks("rules"), []);
  assert.deepEqual((await Store.open(dir)).snapshot(), state());
});
