import { test } from "node:test";
import assert from "node:assert/strict";
import { OpError } from "../src/ops.ts";
import { rules } from "../src/rules.ts";
import type { Ops, Result } from "../src/ops.ts";
import { Store } from "../src/store.ts";
import { ARCHITECT_WRITER, PROCESS_WRITERS } from "../src/model.ts";
import { board, at, later, author, architect, asArchitect, asPM, retired, retiredExactly, rx, conf, opt, goalNumbers } from "./helpers.ts";

test("Architect pause and resume are atomic, server-stamped and preserve every plan row", async t => {
  const { store, op, dir } = await board(t);
  await op.clearAsk({ author, id: "a", log: "Owner already approved" });
  await op.setPlan({ author, id: "a", row: { id: "work", text: "Implementation", state: "doing" } });
  const before = store.snapshot(), plans = Object.fromEntries(Object.entries(before.items).map(([id, it]) => [id, it.plan]));
  const statuses = Object.fromEntries(["area", "a", "b"].map(id => [id, rules(before).statusOf(id)]));
  const count = (await store.log()).length;
  const result = await op.setPause({ ...asArchitect, id: "area", paused: true, reason: "  Owner paused the project  " });
  const paused = store.snapshot();
  assert.equal((await store.log()).length, count + 1);
  assert.equal(result.commit, paused.head);
  assert.deepEqual(paused.items.area!.paused, { reason: "Owner paused the project", at: later });
  assert.deepEqual(paused.items.area!.log.at(-1), { at: later, by: architect, text: "暂停：Owner paused the project" });
  for (const id of ["area", "a", "b"]) assert.equal(rules(paused).statusOf(id), "paused");
  assert.deepEqual(Object.fromEntries(Object.entries(paused.items).map(([id, it]) => [id, it.plan])), plans);
  assert.deepEqual((await Store.open(dir)).snapshot().items.area!.paused, paused.items.area!.paused);
  await op.setPause({ ...asArchitect, id: "a", paused: false });
  assert.equal(store.snapshot().head, paused.head, "resuming an inherited pause changes nothing");
  await op.setPause({ ...asArchitect, id: "area", paused: true, reason: "Owner paused the project" });
  assert.equal(store.snapshot().head, paused.head, "repeating the same pause adds no commit or log");
  await op.setPause({ ...asArchitect, id: "area", paused: false });
  const resumed = store.snapshot();
  assert.equal((await store.log()).length, count + 2);
  assert.equal(resumed.items.area!.paused, undefined);
  assert.deepEqual(resumed.items.area!.log.at(-1), { at: later, by: architect, text: "恢复" });
  for (const id of ["area", "a", "b"]) assert.equal(rules(resumed).statusOf(id), statuses[id]);
  assert.deepEqual(Object.fromEntries(Object.entries(resumed.items).map(([id, it]) => [id, it.plan])), plans);
});

test("pause refusals preserve memory, disk and commits for authors, missing reason and closed or record targets", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, group: author, key: "record-pause", title: "Record", record: true });
  await op.createItem({ ...asArchitect, group: author, key: "done-pause", title: "Done", accept: "Done accepted" });
  await op.setPlan({ author, id: "done-pause", rows: [{ id: "accept", accept: true, text: "Done accepted", state: "done" }] });
  await op.createItem({ ...asArchitect, group: author, key: "cancel-pause", title: "Cancelled", accept: "Cancelled accepted" });
  await op.setStatus({ ...asArchitect, id: "cancel-pause", status: "cancelled", log: "No longer needed" });
  const cases: Array<[Parameters<Ops["setPause"]>[0], RegExp]> = [
    [{ author, id: "a", paused: true, reason: "No permission" }, rx`author: only ${PROCESS_WRITERS} may pause or resume`],
    [{ author, id: "a", paused: false }, rx`author: only ${PROCESS_WRITERS} may pause or resume`],
    [{ ...asArchitect, id: "a", paused: true }, /reason.*required/],
    [{ ...asArchitect, id: "a", paused: true, reason: "   " }, /reason.*(nonempty|required)/],
    [{ ...asArchitect, id: "record-pause", paused: true, reason: "Record" }, /record cannot be paused/],
    [{ ...asArchitect, id: "record-pause", paused: false }, /record cannot be paused/],
    [{ ...asArchitect, id: "done-pause", paused: true, reason: "Done" }, /done or cancelled/],
    [{ ...asArchitect, id: "cancel-pause", paused: true, reason: "Cancelled" }, /done or cancelled/],
    [{ ...asArchitect, id: "done-pause", paused: false }, /done or cancelled/],
    [{ ...asArchitect, id: "cancel-pause", paused: false }, /done or cancelled/],
  ];
  const before = store.snapshot(), count = (await store.log()).length;
  for (const [input, refusal] of cases) {
    await assert.rejects(op.setPause(input), refusal);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
});

test("cancelling work and converting it to a record cannot clear an owner pause", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, group: author, key: "pause-cancel", title: "Work", accept: "Check", plan: [{ id: "doing", text: "Implementation", state: "doing" }] });
  await op.setPause({ ...asArchitect, id: "pause-cancel", paused: true, reason: "Parked" });
  const paused = store.snapshot().items["pause-cancel"]!, plan = paused.plan, marker = paused.paused;
  await op.setStatus({ ...asArchitect, id: "pause-cancel", status: "cancelled", log: "No longer needed" });
  assert.equal(rules(store.snapshot()).statusOf("pause-cancel"), "cancelled");
  assert.deepEqual(store.snapshot().items["pause-cancel"]!.paused, marker, "cancellation does not clear the owner's pause");
  assert.deepEqual(store.snapshot().items["pause-cancel"]!.plan, plan);
  await op.setStatus({ ...asArchitect, id: "pause-cancel", status: "open", log: "Needed again" });
  assert.equal(rules(store.snapshot()).statusOf("pause-cancel"), "paused", "reopening cannot silently resume the owner's pause");
  await op.setPause({ ...asArchitect, id: "pause-cancel", paused: false });
  assert.equal(rules(store.snapshot()).statusOf("pause-cancel"), "wip");
  assert.deepEqual(store.snapshot().items["pause-cancel"]!.plan, plan);
  await op.setPause({ ...asArchitect, id: "a", paused: true, reason: "Parked" });
  const before = store.snapshot(), count = (await store.log()).length;
  await assert.rejects(op.updateItem({ author, id: "a", rev: before.items.a!.rev, record: true }), rx`paused.*中文检查.*only the owner or ${PROCESS_WRITERS} can resume`);
  assert.deepEqual(store.snapshot(), before);
  assert.equal((await store.log()).length, count);
  await op.setPause({ ...asArchitect, id: "a", paused: false });
  await op.updateItem({ author, id: "a", rev: store.snapshot().items.a!.rev, record: true });
  assert.equal(store.snapshot().items.a!.paused, undefined);
  assert.equal(store.snapshot().items.a!.record, true);
});

test("only Architect can clear a retained pause after work completes or is cancelled", async t => {
  const { store, op } = await board(t);
  for (const state of ["done", "cancelled"] as const) {
    const id = `pause-closed-${state}`;
    await op.createItem({ ...asArchitect, group: author, key: id, title: "Closed work", accept: "Check" });
    await op.setPause({ ...asArchitect, id, paused: true, reason: "Owner paused" });
    if (state === "done") await op.setPlan({ author, id, rows: [{ id: "accept", accept: true, text: "Check", state: "done" }] });
    else await op.setStatus({ ...asArchitect, id, status: "cancelled", log: "Not needed" });
    const before = store.snapshot(), plan = before.items[id]!.plan;
    assert.equal(rules(before).statusOf(id), state);
    assert.ok(before.items[id]!.paused, "ordinary closure retains the owner's marker");
    await assert.rejects(op.setPause({ author, id, paused: false }), rx`only ${PROCESS_WRITERS} may pause or resume an item`);
    assert.deepEqual(store.snapshot(), before);
    await op.setPause({ ...asArchitect, id, paused: false });
    assert.equal(store.snapshot().items[id]!.paused, undefined);
    assert.equal(rules(store.snapshot()).statusOf(id), state);
    assert.deepEqual(store.snapshot().items[id]!.plan, plan);
  }
});


test("other projects still refuse cross-project writes without changing memory, disk or HEAD", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  const before = store.snapshot(), count = (await store.log()).length;
  const calls = [
    () => op.setPlan({ author: "Firn", id: "a", row: { id: "accept", accept: true, text: "Changed acceptance", state: "todo" } }),
    () => op.updateItem({ author: "Firn", id: "a", rev: before.items.a!.rev, head: "Changed head", reason: "Foreign" }),
    () => op.moveItem({ author: "Firn", id: "a", owner: "other" }),
    () => op.appendLog({ author: "Firn", id: "a", text: "Foreign log" }),
    () => op.writeCard({ confidence: conf, author: "Firn", key: "foreign-card", item: "a", question: "Q?", options: [opt("A")] }),
    () => op.ruleCard({ author: "Firn", key: "choice", choice: "A" }),
    () => op.withdrawCard({ author: "Firn", key: "choice", log: "Not needed" }),
    () => op.replyNote({ author: "Firn", id: "note-1", reply: "Answer" }),
    () => op.closeNote({ author: "Firn", id: "note-1", log: "Handled" }),
  ];
  for (const call of calls) {
    await assert.rejects(call(), /item [ab] belongs to project Whitefoot; report what you need from it to the PM, who creates work another project needs in the project that delivers it/);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal(store.snapshot().head, before.head);
    assert.equal((await store.log()).length, count);
  }
});

test("Architect writes any project's items, cards and note replies under its own name", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  const lastAuthor = async () => (await store.log({ limit: 1 }))[0]!.author;
  const mine = async (call: () => Promise<Result>) => { await call(); assert.equal(await lastAuthor(), architect, "the commit names Architect, not the item's project"); };
  await mine(() => op.appendLog({ ...asArchitect, id: "a", text: "Architect evidence" }));
  assert.deepEqual(store.snapshot().items.a!.log.at(-1), { at: later, by: architect, text: "Architect evidence" });
  await mine(() => op.setPlan({ ...asArchitect, id: "a", row: { id: "work", text: "Implementation", state: "doing" } }));
  await mine(() => op.setTargets({ ...asArchitect, id: "a", target: goalNumbers }));
  await mine(() => op.updateItem({ ...asArchitect, id: "a", rev: store.snapshot().items.a!.rev, head: "Revised by Architect", reason: "Scope settled" }));
  assert.deepEqual(store.snapshot().items.a!.log.at(-1), { at: later, by: architect, text: "改了 head：Scope settled" });
  await mine(() => op.moveItem({ ...asArchitect, id: "a", owner: "other" }));
  assert.equal(rules(store.snapshot()).parentOf("a"), "other");
  await mine(() => op.writeCard({ confidence: conf, ...asArchitect, key: "architect-card", item: "a", question: "Choose?", options: [opt("A")] }));
  await mine(() => op.ruleCard({ ...asArchitect, key: "architect-card", choice: "A" }));
  await mine(() => op.replyNote({ ...asArchitect, id: "note-1", reply: "Answer" }));
  assert.equal(store.snapshot().notes["note-1"]!.repliedBy, architect);
  await store.commit({ author: "Fixture", message: "Another sent note", puts: [{ kind: "note", id: "note-3", expectRev: null, doc: { target: "it:a", kind: "comment", text: "又一条意见", at, sentAt: at, state: "sent" } }] });
  await mine(() => op.closeNote({ ...asArchitect, id: "note-3", log: "Handled" }));
  assert.equal(store.snapshot().notes["note-3"]!.repliedBy, architect);
  await mine(() => op.setStatus({ ...asArchitect, id: "b", status: "cancelled", log: "Superseded" }));
  await mine(() => op.setStatus({ ...asArchitect, id: "b", status: "open", log: "Resume" }));
  await mine(() => op.setPause({ ...asArchitect, id: "b", paused: true, reason: "Owner chose to wait" }));
  await mine(() => op.createItem({ ...asArchitect, key: "made-for-firn", group: "Firn", title: "Made for Firn", accept: "Pass" }));
  assert.equal(store.snapshot().items["made-for-firn"]!.group, "Firn", "the new item belongs to the project named by group, not to Architect");
  for (const id of ["a", "b"]) assert.equal(store.snapshot().items[id]!.group, author, "Architect's writes never move an item to another project");
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
});

test("only the PM or the architect creates items, cancels or reopens them, changes a title, moves them to another project, pauses or resumes, and only 架构师 changes the tag vocabulary", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  await op.createItem({ ...asArchitect, key: "own-item", group: architect, title: "Architect's own", accept: "Pass" });
  const before = store.snapshot(), count = (await store.log()).length, rev = before.items.a!.rev;
  const tag = { name: "新标签", meaning: "测试用" };
  const only = (what: string) => rx`^author: only ${what.startsWith("change the tag vocabulary") ? ARCHITECT_WRITER : PROCESS_WRITERS} may ${what}`;
  // The item's own project, another project, and the Architect project with no session, another session or a near miss.
  const writers = [{ author }, { author: "Firn" }, { author, session: "架构师" }, { author, session: "PM" }, { author: architect }, { author: architect, session: "engineer" }, { author: architect, session: "架构师x" }, { author: architect, session: "PMx" }, { author: architect, session: "PM" }, { author: "PM" }, { author: "PM", session: "架构师" }, { author: "PM", session: "PMx" }, { author: "PM", session: "engineer" }];
  const cases: Array<[() => Promise<unknown>, RegExp]> = [];
  for (const who of writers) cases.push(
    [() => op.createItem({ ...who, key: "made", group: who.author, title: "Made", accept: "Pass" }), only("create items")],
    [() => op.setStatus({ ...who, id: "b", status: "cancelled", log: "Drop" }), only("cancel or reopen an item")],
    [() => op.updateItem({ ...who, id: "a", rev, title: "Renamed" }), only("change an item's title")],
    [() => op.setPause({ ...who, id: "a", paused: true, reason: "Wait" }), only("pause or resume an item")],
    [() => op.setPause({ ...who, id: "a", paused: false }), only("pause or resume an item")],
    [() => op.setTag({ ...who, ...tag }), only("change the tag vocabulary")],
    [() => op.renameTag({ ...who, name: tag.name, to: "改名" }), only("change the tag vocabulary")],
    [() => op.removeTag({ ...who, name: tag.name }), only("change the tag vocabulary")],
    [() => op.moveItemProject({ ...who, id: "a", project: "Firn" }), only("move an item to another project")],
    [() => op.createProject({ ...who, name: "New", after: "Firn" }), rx`^after: only ${PROCESS_WRITERS} may reorder projects`],
    [() => op.updateProject({ ...who, name: "总管", repo: "Org/Changed" }), rx`^project 总管: only that project or ${ARCHITECT_WRITER} may update its repo$`],
  );
  // Even the Architect project's own item is out of reach of these operations without the session.
  for (const who of [{ author: architect }, { author: architect, session: "engineer" }]) cases.push(
    [() => op.setStatus({ ...who, id: "own-item", status: "cancelled", log: "Drop" }), only("cancel or reopen an item")],
    [() => op.updateItem({ ...who, id: "own-item", rev: before.items["own-item"]!.rev, title: "Renamed" }), only("change an item's title")],
    [() => op.moveItemProject({ ...who, id: "own-item", project: "Firn" }), only("move an item to another project")],
  );
  for (const [call, message] of cases) {
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError); assert.match(e.message, message); return true; });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
  // What the engineer writes stays open to the item's project: a head with the title unchanged, the log and plan progress.
  await op.updateItem({ author, id: "a", rev, title: before.items.a!.title, head: "改动一节由工程师写", reason: "Changes recorded" });
  await op.appendLog({ author, id: "a", text: "Evidence" });
  await op.setPlan({ author, id: "a", row: { id: "work", text: "Implementation", state: "doing" } });
  assert.equal(store.snapshot().items.a!.title, before.items.a!.title);
  assert.equal(store.snapshot().items.a!.head, "改动一节由工程师写");
});

test("the PM (author PM, session PM) does what the process needs in any project, and neither the tag vocabulary nor a project's repository", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  const padded = { ...asPM, session: "  PM  " };
  await op.createItem({ ...asPM, key: "pm-made", group: author, title: "Made by the PM", accept: "Pass" });
  await op.createItem({ ...padded, key: "pm-padded", group: "Firn", title: "Made under a padded name", accept: "Pass" });
  assert.equal(store.snapshot().items["pm-made"]!.group, author, "the PM creates in another project's name");
  assert.equal((await store.log({ limit: 1 }))[0]!.session, "PM", "the commit records the trimmed session");
  await op.updateItem({ ...asPM, id: "pm-made", rev: store.snapshot().items["pm-made"]!.rev, title: "Retitled by the PM" });
  await op.setDifficulty({ ...asPM, id: "pm-made", difficulty: 3, reason: "PM rates" });
  await op.setPause({ ...asPM, id: "pm-made", paused: true, reason: "Wait" });
  await op.setPause({ ...asPM, id: "pm-made", paused: false });
  await op.setStatus({ ...asPM, id: "pm-made", status: "cancelled", log: "Not needed" });
  await op.updateItem({ ...asPM, id: "pm-made", rev: store.snapshot().items["pm-made"]!.rev, record: true });
  await op.moveItemProject({ ...asPM, id: "pm-padded", project: "Whitefoot" });
  await op.updateProject({ ...asPM, name: "Firn", after: "Whitefoot" });
  await op.createProject({ ...asPM, name: "Placed", after: "Whitefoot" });
  const names = store.snapshot().board.projects.map(p => p.name), first = names.indexOf("Whitefoot");
  assert.deepEqual(names.slice(first + 1, first + 3), ["Placed", "Firn"], "the PM places projects in the page order");
  assert.equal(store.snapshot().items["pm-made"]!.title, "Retitled by the PM");
  assert.equal(store.snapshot().items["pm-padded"]!.group, "Whitefoot");
  // What stays the architect's alone: the tag vocabulary, and a repository or mainline of a project that is not the writer's.
  const before = store.snapshot(), count = (await store.log()).length;
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.setTag({ ...asPM, name: "新标签", meaning: "测试用" }), rx`^author: only ${ARCHITECT_WRITER} may change the tag vocabulary`],
    [() => op.renameTag({ ...asPM, name: "新标签", to: "改名" }), rx`^author: only ${ARCHITECT_WRITER} may change the tag vocabulary`],
    [() => op.removeTag({ ...asPM, name: "新标签" }), rx`^author: only ${ARCHITECT_WRITER} may change the tag vocabulary`],
    [() => op.updateProject({ ...asPM, name: "Whitefoot", repo: "Org/Changed" }), rx`^project Whitefoot: only that project or ${ARCHITECT_WRITER} may update its repo$`],
  ];
  for (const [call, message] of cases) {
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError); assert.match(e.message, message); return true; });
    assert.deepEqual(store.snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
});

test("Architect from another session writes only the Architect project's items, and a padded session name still counts", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  await op.createItem({ ...asArchitect, key: "own-item", group: architect, title: "Architect's own", accept: "Pass" });
  const engineer = { author: architect, session: "engineer" };
  // An engineer working in the Architect project is an ordinary project author there.
  // The same holds for the PM's project: author PM from another session is not the PM.
  await op.appendLog({ ...engineer, id: "own-item", text: "Engineer evidence" });
  await op.setPlan({ ...engineer, id: "own-item", row: { id: "work", text: "Implementation", state: "doing" } });
  assert.deepEqual(store.snapshot().items["own-item"]!.log.at(-1), { at: later, by: architect, text: "Engineer evidence" });
  const before = store.snapshot(), count = (await store.log()).length;
  for (const who of [engineer, { author: architect }, { author: "PM", session: "engineer" }, { author: "PM" }]) {
    await assert.rejects(op.appendLog({ ...who, id: "a", text: "Foreign" }), rx`item a belongs to project Whitefoot; report what you need from it to the PM, who creates work another project needs in the project that delivers it; only ${PROCESS_WRITERS} write other projects' items`);
    await assert.rejects(op.writeCard({ confidence: conf, ...who, key: "foreign-card", item: "a", question: "Q?", options: [opt("A")] }), /item a belongs to project Whitefoot/);
    await assert.rejects(op.replyNote({ ...who, id: "note-1", reply: "Answer" }), /item a belongs to project Whitefoot/);
    await assert.rejects(op.moveItem({ ...who, id: "a", owner: "other" }), /item a belongs to project Whitefoot/);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
  await op.appendLog({ author: architect, session: "  架构师  ", id: "a", text: "Padded session" });
  assert.deepEqual(store.snapshot().items.a!.log.at(-1), { at: later, by: architect, text: "Padded session" });
  assert.equal((await store.log({ limit: 1 }))[0]!.session, "架构师", "the commit records the trimmed session");
});

test("a cancelled item turns into a record only by Architect, so a project cannot reopen it through record mode", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  for (const [key, group] of [["dropped", author], ["dropped-own", architect]] as const) {
    await op.createItem({ ...asArchitect, key, group, title: "Dropped work", accept: "Pass" });
    await op.setStatus({ ...asArchitect, id: key, status: "cancelled", log: "Not needed" });
  }
  const before = store.snapshot(), count = (await store.log()).length;
  // The item's own project, with or without the session name, never gets past the gate.
  const attempts: Array<[string, { author: string; session?: string }]> = [["dropped", { author }], ["dropped", { author, session: "架构师" }], ["dropped-own", { author: architect }], ["dropped-own", { author: architect, session: "engineer" }]];
  for (const [id, who] of attempts) {
    await assert.rejects(op.updateItem({ ...who, id, rev: before.items[id]!.rev, record: true }), rx`author: only ${PROCESS_WRITERS} may turn a cancelled item into a record`);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
  // This gate comes after the ownership check: another project's author hears whose item it is.
  await assert.rejects(op.updateItem({ author: "Firn", id: "dropped", rev: before.items.dropped!.rev, record: true }), /item dropped belongs to project Whitefoot/);
  assert.deepEqual(store.snapshot(), before);
  // Work that is not cancelled still becomes a record by its project, and Architect may convert the cancelled one.
  await op.updateItem({ author, id: "a", rev: before.items.a!.rev, record: true });
  assert.equal(store.snapshot().items.a!.record, true);
  await op.updateItem({ ...asArchitect, id: "dropped", rev: before.items.dropped!.rev, record: true });
  assert.equal(store.snapshot().items.dropped!.record, true);
  assert.equal(store.snapshot().items.dropped!.status, undefined);
});

test("Architect's reach across projects keeps the same-project ownership rules", async t => {
  const { store, op, dir } = await board(t);
  const before = store.snapshot(), count = (await store.log()).length;
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.createItem({ ...asArchitect, key: "x", owner: "area", group: "Firn", title: "X", accept: "Pass" }), /owner: ownership must stay within the same project/],
    [() => op.moveItem({ ...asArchitect, id: "a", owner: "other" }), /owner: ownership must stay within the same project/],
    [() => op.setPlan({ ...asArchitect, id: "other", row: { item: "a", own: true } }), /跨项目拥有 a; use a shared row/],
    [() => op.createItem({ ...asArchitect, key: "x", group: "Firn", title: "X", accept: "Pass", children: ["a"] }), /跨项目拥有 a; use a shared row/],
  ];
  for (const [call, message] of cases) {
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError); assert.match(e.message, message); return true; });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
});

test("Architect without the session cannot resume paused work in its own project either", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "arch-parent", group: architect, title: "Paused release", accept: "Release passes" });
  await op.createItem({ ...asArchitect, key: "arch-child", owner: "arch-parent", title: "Paused implementation", accept: "Implementation passes", plan: [{ id: "work", text: "Implementation", state: "doing" }] });
  await op.createItem({ ...asArchitect, key: "arch-other", group: architect, title: "Active release", accept: "Active release passes" });
  await op.createItem({ ...asArchitect, key: "arch-marked", group: architect, title: "Marked work", accept: "Marked passes" });
  await op.setPause({ ...asArchitect, id: "arch-parent", paused: true, reason: "Owner chose to wait" });
  await op.setPause({ ...asArchitect, id: "arch-marked", paused: true, reason: "Owner chose to wait" });
  const before = store.snapshot(), count = (await store.log()).length;
  const resume = rx`only the owner or ${PROCESS_WRITERS} can resume`;
  for (const who of [{ author: architect }, { author: architect, session: "engineer" }]) {
    // Moving open work out of a paused chain, and converting a paused item to a record (which clears its marker).
    await assert.rejects(op.moveItem({ ...who, id: "arch-child", owner: "arch-other" }), resume);
    await assert.rejects(op.updateItem({ ...who, id: "arch-marked", rev: before.items["arch-marked"]!.rev, record: true }), resume);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
  await op.moveItem({ ...asArchitect, id: "arch-child", owner: "arch-other" });
  assert.equal(rules(store.snapshot()).statusOf("arch-child"), "wip");
});

test("every write under the retired author 总管 is refused and changes nothing", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  const before = store.snapshot(), count = (await store.log()).length, retired = "总管";
  assert.ok(before.board.projects.some(p => p.name === retired), "the retired project is still configured, so only the retirement refuses");
  const calls: Record<keyof Ops, () => Promise<unknown>> = {
    createProject: () => op.createProject({ author: retired, name: "New" }),
    updateProject: () => op.updateProject({ author: retired, name: "Whitefoot", repo: "Org/Changed" }),
    closeNote: () => op.closeNote({ author: retired, id: "note-1", log: "Handled" }),
    createItem: () => op.createItem({ author: retired, key: "x", group: retired, title: "X", accept: "Pass" }),
    appendLog: () => op.appendLog({ author: retired, id: "a", text: "Log" }),
    markMerged: () => op.markMerged({ author: retired, id: "a", row: "work", merged: [], log: "Merged" }),
    journalEntry: () => op.journalEntry({ author: retired, text: "Entry" }),
    dispatchStart: () => op.dispatchStart({ author: retired, id: "a", role: "工程师", level: 1, model: "Haiku", agent: "worker", agentId: "agent-0001" }),
    dispatchFinish: () => op.dispatchFinish({ author: retired, id: "a", agentId: "agent-0001", result: "一次通过", usage: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 }, cost: 0, reports: 0, kickbacks: 0 }),
    reportState: () => op.reportState({ author: retired, id: "a", state: "running" }),
    setPlan: () => op.setPlan({ author: retired, id: "a", row: { id: "work", text: "Work", state: "doing" } }),
    setTargets: () => op.setTargets({ author: retired, id: "a", target: goalNumbers }),
    updateItem: () => op.updateItem({ author: retired, id: "a", rev: before.items.a!.rev, title: "Renamed" }),
    setStatus: () => op.setStatus({ author: retired, id: "b", status: "cancelled", log: "Drop" }),
    setTags: () => op.setTags({ author: retired, id: "a", tags: ["健全性"] }),
    setTagsMany: () => op.setTagsMany({ author: retired, items: [{ id: "a", tags: ["健全性"] }] }),
    setDifficulty: () => op.setDifficulty({ author: retired, id: "a", difficulty: 2, reason: "Rated" }),
    setDifficultyMany: () => op.setDifficultyMany({ author: retired, items: [{ id: "a", difficulty: 2, reason: "Rated" }] }),
    setTag: () => op.setTag({ author: retired, name: "新标签", meaning: "测试用" }),
    renameTag: () => op.renameTag({ author: retired, name: "健全性", to: "改名" }),
    removeTag: () => op.removeTag({ author: retired, name: "健全性" }),
    setPause: () => op.setPause({ author: retired, id: "a", paused: true, reason: "Wait" }),
    moveItem: () => op.moveItem({ author: retired, id: "a", owner: "other" }),
    moveItemProject: () => op.moveItemProject({ author: retired, id: "a", project: "Firn" }),
    clearAsk: () => op.clearAsk({ author: retired, id: "a", log: "Settled" }),
    writeCard: () => op.writeCard({ confidence: conf, author: retired, key: "new-card", item: "a", question: "Q?", options: [opt("A")] }),
    ruleCard: () => op.ruleCard({ author: retired, key: "choice", choice: "A" }),
    withdrawCard: () => op.withdrawCard({ author: retired, key: "choice", log: "Not needed" }),
    replyNote: () => op.replyNote({ author: retired, id: "note-1", reply: "Answer" }),
    setTerm: () => op.setTerm({ author: retired, term: "术语", definition: "定义" }),
    deleteTerm: () => op.deleteTerm({ author: retired, term: "术语" }),
    sendMessage: () => op.sendMessage({ author: retired, session: "s", to: "架构师", text: "看 a" }),
  };
  for (const [name, call] of Object.entries(calls)) {
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError, name); assert.match(e.message, retiredExactly, name); return true; });
    assert.deepEqual(store.snapshot(), before, name);
    assert.deepEqual((await Store.open(dir)).snapshot(), before, name);
    assert.equal((await store.log()).length, count, name);
  }
});

test("moving inherited paused work out requires an authorized resume first", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "pause-parent", group: author, title: "Paused release", accept: "Release passes" });
  await op.createItem({ ...asArchitect, key: "pause-child", owner: "pause-parent", title: "Paused implementation", accept: "Implementation passes", plan: [{ id: "work", text: "Implementation", state: "doing" }] });
  await op.createItem({ ...asArchitect, key: "resume-owner", group: author, title: "Active release", accept: "Active release passes" });
  await op.setPause({ ...asArchitect, id: "pause-parent", paused: true, reason: "Owner chose to wait" });
  const before = store.snapshot(), count = (await store.log()).length;
  await assert.rejects(op.moveItem({ author, id: "pause-child", owner: "resume-owner" }), rx`paused.*Paused implementation.*pause-child.*Paused release.*pause-parent.*only the owner or ${PROCESS_WRITERS} can resume`);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
  assert.equal((await store.log()).length, count);
  await op.setPause({ ...asArchitect, id: "pause-parent", paused: false });
  await op.moveItem({ author, id: "pause-child", owner: "resume-owner" });
  assert.equal(rules(store.snapshot()).statusOf("pause-child"), "wip");
  assert.deepEqual(store.snapshot().items["pause-child"]!.plan, before.items["pause-child"]!.plan);
  await op.setPause({ ...asArchitect, id: "pause-parent", paused: true, reason: "Owner chose to wait" });
  await op.moveItem({ author, id: "pause-child", owner: "pause-parent" });
  assert.equal(rules(store.snapshot()).statusOf("pause-child"), "paused", "moving into a paused chain remains allowed");
});

test("removing a paused parent's owning row cannot resume open child work", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "pause-parent", group: author, title: "Paused release", accept: "Release passes" });
  await op.createItem({ ...asArchitect, key: "pause-child", owner: "pause-parent", title: "Paused implementation", accept: "Implementation passes" });
  await op.setPause({ ...asArchitect, id: "pause-parent", paused: true, reason: "Owner chose to wait" });
  const before = store.snapshot(), count = (await store.log()).length;
  await assert.rejects(op.setPlan({ author, id: "pause-parent", remove: "pause-child" }), rx`paused.*Paused implementation.*Paused release.*pause-parent.*only the owner or ${PROCESS_WRITERS} can resume`);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
  assert.equal((await store.log()).length, count);
});

test("Architect plans still require moving or cancelling their open owned children before removal", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "architect-parent", group: author, title: "Architect release", accept: "Release passes" });
  await op.createItem({ ...asArchitect, key: "architect-child", owner: "architect-parent", title: "Architect work", accept: "Work passes" });
  await op.setPause({ ...asArchitect, id: "architect-parent", paused: true, reason: "Owner chose to wait" });
  const before = store.snapshot(), count = (await store.log()).length;
  await assert.rejects(op.setPlan({ ...asArchitect, id: "architect-parent", remove: "architect-child" }), /architect-child is open; use move_item or cancel it before removing its owned row/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
  assert.equal((await store.log()).length, count);
  await op.moveItem({ ...asArchitect, id: "architect-child" });
  assert.equal(rules(store.snapshot()).parentOf("architect-child"), undefined);
  assert.equal(rules(store.snapshot()).statusOf("architect-child"), "todo", "the Architect's own move may resume its work");
});

test("an inherited pause does not prevent converting work to a record while preserving descendant pause", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "record-descendant", owner: "a", title: "Descendant work", accept: "Result passes" });
  await op.setPause({ ...asArchitect, id: "area", paused: true, reason: "Owner chose to wait" });
  const before = store.snapshot(), count = (await store.log()).length;
  assert.equal(before.items.a!.paused, undefined);
  await op.updateItem({ author, id: "a", rev: before.items.a!.rev, record: true });
  const after = store.snapshot();
  assert.equal(after.items.a!.record, true);
  assert.equal(rules(after).statusOf("a"), undefined, "a record has no open work status to resume");
  assert.deepEqual(after.items.area!.paused, before.items.area!.paused);
  assert.equal(rules(after).statusOf("record-descendant"), "paused");
  assert.deepEqual(after.items["record-descendant"], before.items["record-descendant"]);
  assert.equal((await store.log()).length, count + 1);
  assert.deepEqual((await Store.open(dir)).snapshot(), after);
});

test("pause permission follows unwritten descendants when their record owner moves", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  await op.createItem({ ...asArchitect, key: "pause-record", owner: "area", title: "Work queue", record: true });
  await op.createItem({ ...asArchitect, key: "pause-descendant", owner: "pause-record", title: "Queued work", accept: "Queue result passes" });
  await op.setPause({ ...asArchitect, id: "area", paused: true, reason: "Owner chose to wait" });
  const before = store.snapshot(), count = (await store.log()).length;
  await assert.rejects(op.moveItem({ author, id: "pause-record", owner: "other" }), rx`paused.*Queued work.*解释器工作.*area.*only the owner or ${PROCESS_WRITERS} can resume`);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
  assert.equal((await store.log()).length, count);
  await op.setPause({ ...asArchitect, id: "area", paused: false });
  await op.moveItem({ author, id: "pause-record", owner: "other" });
  assert.equal(rules(store.snapshot()).statusOf("pause-descendant"), "todo");
  assert.deepEqual(store.snapshot().items["pause-descendant"], before.items["pause-descendant"], "the descendant's plan is never rewritten by the move");
});

test("cancelling or completing paused work preserves its retained pause in one commit", async t => {
  const { store, op, dir } = await board(t);
  for (const status of ["done", "cancelled"] as const) {
    const id = `paused-close-${status}`;
    await op.createItem({ ...asArchitect, key: id, group: author, title: "Paused work", accept: "Result passes" });
    await op.setPause({ ...asArchitect, id, paused: true, reason: "Owner chose to wait" });
    const before = store.snapshot(), count = (await store.log()).length;
    const result = status === "done"
      ? await op.setPlan({ author, id, rows: [{ id: "accept", accept: true, text: "Result passes", state: "done" }] })
      : await op.setStatus({ ...asArchitect, id, status: "cancelled", log: "Not needed" });
    const after = store.snapshot();
    assert.equal(rules(after).statusOf(id), status);
    assert.deepEqual(after.items[id]!.paused, before.items[id]!.paused);
    if (status === "cancelled") assert.deepEqual(after.items[id]!.plan, before.items[id]!.plan);
    assert.equal((await store.log()).length, count + 1);
    assert.equal(result.commit, after.head);
    assert.deepEqual((await Store.open(dir)).snapshot(), after);
  }
});

test("converting closed work to a record requires clearing its retained owner pause first", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "pause-closed-record", group: author, title: "Closed paused work", accept: "Result passes" });
  await op.setPause({ ...asArchitect, id: "pause-closed-record", paused: true, reason: "Owner chose to wait" });
  await op.setPlan({ author, id: "pause-closed-record", rows: [{ id: "accept", accept: true, text: "Result passes", state: "done" }] });
  const before = store.snapshot(), count = (await store.log()).length, item = before.items["pause-closed-record"]!;
  assert.equal(rules(before).isPaused("pause-closed-record"), false);
  await assert.rejects(op.updateItem({ author, id: "pause-closed-record", rev: item.rev, record: true }), rx`paused.*Closed paused work.*pause-closed-record.*only the owner or ${PROCESS_WRITERS} can resume`);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
  assert.equal((await store.log()).length, count);
  await op.setPause({ ...asArchitect, id: "pause-closed-record", paused: false });
  await op.updateItem({ author, id: "pause-closed-record", rev: store.snapshot().items["pause-closed-record"]!.rev, record: true });
  assert.equal(store.snapshot().items["pause-closed-record"]!.record, true);
  assert.equal(store.snapshot().items["pause-closed-record"]!.paused, undefined);
});

test("a project card ruling may complete an unwritten paused dependent without clearing its marker", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "pause-card-dependent", group: author, title: "Paused card dependent", accept: "Result passes" });
  await op.writeCard({ confidence: conf, author, key: "pause-card", item: "pause-card-dependent", question: "Proceed?", blocks: "The dependent waits", options: [opt("Yes")] });
  await op.setPlan({ author, id: "pause-card-dependent", row: { id: "accept", accept: true, text: "Result passes", state: "done" } });
  await op.setPause({ ...asArchitect, id: "pause-card-dependent", paused: true, reason: "Owner chose to wait" });
  const before = store.snapshot(), count = (await store.log()).length;
  const result = await op.ruleCard({ author, key: "pause-card", choice: "A" });
  const after = store.snapshot();
  assert.equal(rules(after).statusOf("pause-card-dependent"), "done");
  assert.deepEqual(after.items["pause-card-dependent"], before.items["pause-card-dependent"], "card resolution leaves the retained pause and entire unwritten item intact");
  assert.equal((await store.log()).length, count + 1);
  assert.equal(result.commit, after.head);
  assert.deepEqual((await Store.open(dir)).snapshot(), after);
});
