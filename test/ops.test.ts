import { test } from "node:test";
import assert from "node:assert/strict";
import { ops, OpError } from "../src/ops.ts";
import { rules } from "../src/rules.ts";
import type { Ops, Result } from "../src/ops.ts";
import { Store } from "../src/store.ts";
import type { Txn } from "../src/store.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { board, at, later, author } from "./helpers.ts";

test("every operation refuses empty author, missing target and whitespace text without changing memory, disk or history", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  const calls: Array<{ name: keyof Ops; args: Record<string, unknown>; text: string; missing?: string }> = [
    { name: "createItem", args: { key: "new", parent: "area", parentWhy: "Child", title: "New" }, text: "title" },
    { name: "appendLog", args: { id: "a", text: "Progress" }, text: "text", missing: "id" },
    { name: "updateItem", args: { id: "a", rev: 1, title: "Changed" }, text: "title", missing: "id" },
    { name: "setStatus", args: { id: "a", status: "done", log: "Complete" }, text: "log", missing: "id" },
    { name: "moveItem", args: { id: "a", parent: "other", parentWhy: "Transfer" }, text: "parentWhy", missing: "id" },
    { name: "clearAsk", args: { id: "a", log: "Approved" }, text: "log", missing: "id" },
    { name: "writeCard", args: { key: "new-card", item: "a", question: "Choose?", background: "Why", options: [{ key: "A", text: "A" }] }, text: "background", missing: "item" },
    { name: "ruleCard", args: { key: "choice", choice: "A", ruling: "Chosen" }, text: "ruling", missing: "key" },
    { name: "replyNote", args: { id: "note-1", reply: "Answer" }, text: "reply", missing: "id" },
  ];
  for (const c of calls) {
    const call = op[c.name] as (a: Record<string, unknown>) => Promise<Result>;
    for (const [field, value] of [["author", " \t "], [c.text, " \n "], ...(c.missing ? [[c.missing, "missing"]] : [])]) {
      const before = store.snapshot();
      await assert.rejects(call({ author, ...c.args, [field!]: value }), e => { assert.ok(e instanceof OpError); assert.ok(e.message.includes(field!)); return true; }, `${c.name} ${field}`);
      assert.deepEqual(store.snapshot(), before);
      assert.deepEqual((await Store.open(dir)).snapshot(), before);
    }
  }
});

test("creation, revision, dependency, status, movement and card checks name a fix and leave the board unchanged", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  const create = { author, key: "new", parent: "area", parentWhy: "Child", title: "New" };
  const card = { author, key: "new-card", item: "a", question: "Choose?", background: "Why", options: [{ key: "A", text: "A" }] };
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.createItem({ ...create, key: "../escape" }), /key.*use/],
    [() => op.createItem({ ...create, key: "a" }), /key.*new/],
    [() => op.createItem({ ...create, key: "choice" }), /key.*new/],
    [() => op.createItem({ ...create, parent: undefined, priority: "P1" }), /group.*requires/],
    [() => op.createItem({ ...create, parent: "missing" }), /parent.*existing/],
    [() => op.createItem({ ...create, parentWhy: undefined }), /parentWhy.*explain/],
    [() => op.createItem({ ...create, deps: [{ id: "missing", why: "Needed" }] }), /依赖的.*不存在/],
    [() => op.createItem({ ...create, deps: [{ card: "missing", why: "Needed" }] }), /依赖的.*不存在/],
    [() => op.createItem({ ...create, deps: [{ id: "a", why: " " }] }), /依赖没写为什么/],
    [() => op.updateItem({ author, id: "a", rev: 0, title: "Bad" }), /rev.*positive/],
    [() => op.updateItem({ author, id: "a", rev: 1, head: "Changed" }), /reason.*head/],
    [() => op.updateItem({ author, id: "a", rev: 1, deps: [{ card: "missing", why: "Needed" }] }), /依赖的.*不存在/],
    [() => op.updateItem({ author, id: "a", rev: 1, links: [{ label: "Invalid", url: "invalid" }] }), /links.*fix/],
    [() => op.setStatus({ author, id: "area", status: "done", log: "Done" }), /status.*derived.*sub-item/],
    [() => op.setStatus({ author, id: "other", status: "blocked", log: "Wait" }), /status.*open dependency or an ask/],
    [() => op.moveItem({ author, id: "a", parent: "a", parentWhy: "Self" }), /parent.*cycle/],
    [() => op.moveItem({ author, id: "area", parent: "a", parentWhy: "Descendant" }), /parent.*cycle/],
    [() => op.moveItem({ author, id: "a", parent: "missing", parentWhy: "Unknown" }), /parent.*existing/],
    [() => op.moveItem({ author, id: "a", parent: "other", parentWhy: undefined! }), /parentWhy.*explain/],
    [() => op.writeCard({ ...card, key: "a" }), /key.*new/],
    [() => op.writeCard({ ...card, key: "choice" }), /key.*new/],
    [() => op.writeCard({ ...card, options: [] }), /options.*fix/],
    [() => op.writeCard({ ...card, options: [{ key: "A", text: "A" }, { key: "A", text: "B" }] }), /options.key.*unique/],
    [() => op.writeCard({ ...card, options: [{ key: "A", text: "A", recommended: true }, { key: "B", text: "B", recommended: true }] }), /recommended.*at most one/],
    [() => op.writeCard({ ...card, confidence: { score: 6, reason: "Evidence" } }), /confidence.score.*fix/],
    [() => op.writeCard({ ...card, key: "ruled", rev: 1 }), /status.*open card/],
    [() => op.ruleCard({ author, key: "ruled", ruling: "Again" }), /status.*open card/],
    [() => op.ruleCard({ author, key: "choice", choice: "C", ruling: "Bad option" }), /choice.*option key/],
    [() => op.appendLog({ author: "bad\nname", id: "a", text: "Bad author" }), /author.*newlines/],
  ];
  for (const [call, message] of cases) {
    const before = store.snapshot();
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError); assert.match(e.message, message); return true; });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
  }
});

test("each operation records its effects, author and single atomic commit", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  async function committed(call: () => Promise<Result>, message: string, files: string[]) {
    const before = (await store.log()).length, result = await call(), log = await store.log({ limit: 1 });
    assert.equal((await store.log()).length, before + 1);
    assert.equal(result.commit, log[0]!.commit); assert.equal(log[0]!.author, author); assert.equal(log[0]!.message, message);
    assert.deepEqual(log[0]!.files.slice().sort(), files.sort());
    return result;
  }
  await committed(() => op.createItem({ author, key: "new", parent: "area", parentWhy: "Delivers proof", title: "New", head: "Stable", links: [], order: 4, data: "4 cases" }), "create_item new", ["items/new.yaml", "items/area.yaml"]);
  assert.deepEqual(store.snapshot().items.area!.deps.at(-1), { id: "new", why: "Delivers proof" });
  assert.equal(store.snapshot().items.new!.created, later); assert.equal(store.snapshot().items.new!.status, "todo");
  await committed(() => op.appendLog({ author, id: "new", text: "Evidence" }), "append_log new", ["items/new.yaml"]);
  assert.deepEqual(store.snapshot().items.new!.log[0], { at: later, by: author, text: "Evidence" });
  await committed(() => op.updateItem({ author, id: "new", rev: 2, head: "Revised", reason: "Scope settled", title: "Revised title", deps: [{ card: "choice", why: "Needs ruling" }], links: [{ label: "PR", url: "https://github.com/Ming-Research/Whitefoot/pull/1" }], data: null, order: 2 }), "update_item new", ["items/new.yaml"]);
  const revised = store.snapshot().items.new!;
  assert.equal(revised.head, "Revised"); assert.equal(revised.title, "Revised title"); assert.equal(revised.order, 2);
  assert.equal(revised.data, undefined); assert.equal(Object.hasOwn(revised, "agent"), false);
  assert.deepEqual(revised.log.at(-1), { at: later, by: author, text: "改了 head：Scope settled" });
  await committed(() => op.setStatus({ author, id: "new", status: "blocked", log: "Waits on choice" }), "set_status new blocked", ["items/new.yaml"]);
  assert.equal(store.snapshot().items.new!.status, "blocked");
  const legacyAskItem = store.snapshot().items.new!;
  await store.commit({ author: "Fixture", message: "Legacy ask", puts: [{ kind: "item", id: "new", expectRev: legacyAskItem.rev, doc: { ...legacyAskItem, ask: { text: "Approve", url: "https://example.com/approve", chat: true } } }] });
  await committed(() => op.setStatus({ author, id: "new", status: "done", log: "Finished" }), "set_status new done", ["items/new.yaml"]);
  assert.equal(store.snapshot().items.new!.ask!.text, "Approve"); assert.equal(store.snapshot().items.new!.deps.length, 1);
  await committed(() => op.setStatus({ author, id: "new", status: "cancelled", log: "Superseded" }), "set_status new cancelled", ["items/new.yaml"]);
  assert.equal(store.snapshot().items.new!.ask!.chat, true);
  await committed(() => op.clearAsk({ author, id: "new", log: "Owner approved" }), "clear_ask new", ["items/new.yaml"]);
  assert.equal(store.snapshot().items.new!.ask, undefined); assert.equal(store.snapshot().items.new!.log.at(-1)!.text, "Owner approved");
  await committed(() => op.moveItem({ author, id: "new", parent: "other", parentWhy: "New home", parentOwnWork: { key: "other-own", title: "Other own work" } }), "move_item new", ["items/new.yaml", "items/area.yaml", "items/other.yaml", "items/other-own.yaml"]);
  assert.equal(store.snapshot().items.new!.parent, "other");
  assert.ok(!store.snapshot().items.area!.deps.some(d => "id" in d && d.id === "new"));
  assert.deepEqual(store.snapshot().items.other!.deps, [{ id: "new", why: "New home" }, { id: "other-own", why: "它自己的工作" }]);
  assert.match(store.snapshot().items.new!.log.at(-1)!.text, /解释器工作.*其他项目.*New home/);
  await committed(() => op.writeCard({ author, key: "new-card", item: "new", question: "Choose?", background: "Evidence", options: [{ key: "A", text: "A", recommended: true }], confidence: { score: 3, reason: "Exploratory" } }), "write_card new-card", ["decisions/new-card.yaml"]);
  const originalAt = store.snapshot().decisions["new-card"]!.at;
  await committed(() => op.writeCard({ author, key: "new-card", rev: 1, item: "new", question: "Choose revised?", background: "More evidence", options: [{ key: "B", text: "B" }] }), "write_card new-card", ["decisions/new-card.yaml"]);
  assert.equal(store.snapshot().decisions["new-card"]!.at, originalAt);
  await committed(() => op.ruleCard({ author, key: "new-card", choice: "B", ruling: "Owner picked B" }), "rule_card new-card", ["decisions/new-card.yaml"]);
  assert.equal(store.snapshot().decisions["new-card"]!.choice, "B"); assert.equal(store.snapshot().decisions["new-card"]!.ruledAt, later);
  await committed(() => op.replyNote({ author, id: "note-1", reply: "Answer" }), "reply_note note-1", ["notes/note-1.yaml"]);
  assert.deepEqual(store.snapshot().notes["note-1"], { target: "it:a", kind: "comment", text: "中文意见 Whitefoot #341", at, sentAt: at, state: "done", reply: "Answer", repliedAt: later, repliedBy: author, rev: 2 });
});

test("stale item/card revisions summarize intervening changes and never overwrite", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  await op.appendLog({ author, id: "a", text: "Concurrent evidence" });
  const before = store.snapshot();
  await assert.rejects(op.updateItem({ author, id: "a", rev: 1, title: "Stale" }), /rev 1: current rev 2; \+1 log.*redo.*rev 2/);
  assert.deepEqual(store.snapshot(), before);
  const args = { author, key: "choice", item: "a", question: "Changed?", background: "Changed", options: [{ key: "A", text: "A" }] };
  await op.writeCard({ ...args, rev: 1 });
  const cardBefore = store.snapshot();
  await assert.rejects(op.writeCard({ ...args, rev: 1 }), /current rev 2.*question changed.*background changed/);
  assert.deepEqual(store.snapshot(), cardBefore);
});

test("concurrent appends across Ops instances and a genuine store conflict lose no entries", async t => {
  const { store, op } = await board(t, { sharedProjects: true }), second = ops(store, () => later);
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? op : second).appendLog({ author, id: "a", text: `Concurrent ${i}` })));
  assert.deepEqual(store.snapshot().items.a!.log.slice(7).map(e => e.text).sort(), Array.from({ length: 10 }, (_, i) => `Concurrent ${i}`).sort());
  const original = store.commit.bind(store);
  let raced = false;
  t.mock.method(store, "commit", async (txn: Txn) => {
    if (!raced) {
      raced = true;
      const current = store.snapshot().items.a!;
      await original({ author: "Direct writer", message: "Concurrent direct append", puts: [{ kind: "item", id: "a", expectRev: current.rev, doc: { ...current, log: [...current.log, { at: later, text: "Direct evidence" }] } }] });
    }
    return original(txn);
  });
  await op.appendLog({ author, id: "a", text: "Retried evidence" });
  assert.ok(raced); assert.deepEqual(store.snapshot().items.a!.log.slice(-2).map(e => e.text), ["Direct evidence", "Retried evidence"]);
});

test("an update racing a Store write returns an OpError with current revision and actual changes", async t => {
  const { store, op } = await board(t, { sharedProjects: true }), original = store.commit.bind(store);
  let raced = false;
  t.mock.method(store, "commit", async (txn: Txn) => {
    if (!raced) {
      raced = true;
      const current = store.snapshot().items.a!;
      await original({ author: "Direct writer", message: "Intervening title", puts: [{ kind: "item", id: "a", expectRev: 1, doc: { ...current, title: "Intervening title" } }] });
    }
    return original(txn);
  });
  await assert.rejects(op.updateItem({ author, id: "a", rev: 1, title: "Would overwrite" }), e => {
    assert.ok(e instanceof OpError); assert.match(e.message, /current rev 2; title changed.*redo.*rev 2/); return true;
  });
  assert.equal(store.snapshot().items.a!.title, "Intervening title");
  assert.equal((await store.log({ kind: "item", id: "a" })).length, 2);
  await op.appendLog({ author, id: "a", text: "Queue recovered" });
  assert.equal(store.snapshot().items.a!.log.at(-1)!.text, "Queue recovered");
});

test("new areas stamp required metadata and same-parent moves replace the dependency why once", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  await op.createItem({ author, key: "new-area", title: "New area", priority: "P1", status: "wip", group: "Whitefoot" });
  assert.equal(store.snapshot().items["new-area"]!.created, later); assert.equal(store.snapshot().items["new-area"]!.updated, later);
  assert.equal(store.snapshot().items["new-area"]!.group, "Whitefoot"); assert.equal(rules(store.snapshot()).projectOf("new-area"), author);
  await op.moveItem({ author, id: "a", parent: "area", parentWhy: "Updated relationship" });
  assert.deepEqual(store.snapshot().items.area!.deps.filter(d => "id" in d && d.id === "a"), [{ id: "a", why: "Updated relationship" }]);
  assert.ok(store.snapshot().items.area!.deps.some(d => "id" in d && d.id === "b"));
});

test("asks and open cards allow blocked status; wip remains allowed; closed deps do not block", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  await op.setStatus({ author, id: "b", status: "wip", log: "Working alongside dependencies" });
  const legacyAskItem = store.snapshot().items.other!;
  await store.commit({ author: "Fixture", message: "Legacy ask", puts: [{ kind: "item", id: "other", expectRev: legacyAskItem.rev, doc: { ...legacyAskItem, ask: { text: "Owner approves" } } }] });
  await op.setStatus({ author, id: "other", status: "blocked", log: "Waits on owner" });
  await assert.rejects(op.createItem({ author, key: "blocked-split", parent: "other", parentWhy: "Work", title: "Split", parentOwnWork: { key: "blocked-own", title: "Own" } }), /blocked-own.*卡住了，但没写在等什么/);
  await op.setStatus({ author, id: "other", status: "todo", log: "Schedule own work before splitting" });
  await op.createItem({ author, key: "card-waiter", parent: "other", parentWhy: "Ruling", title: "Waiter", deps: [{ card: "choice", why: "Ruling" }], parentOwnWork: { key: "other-own", title: "other own work" } });
  await op.setStatus({ author, id: "card-waiter", status: "blocked", log: "Waits on card" });
  await op.ruleCard({ author, key: "choice", ruling: "Settled without an option" });
  const before = store.snapshot();
  await assert.rejects(op.setStatus({ author, id: "card-waiter", status: "blocked", log: "Stale blocker" }), /open dependency or an ask/);
  assert.deepEqual(store.snapshot(), before);
});

test("a leaf's first sub-item moves its own work and status into a sub-item in the same commit, and a root parent keeps its priority", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  const blockedSplit = { author, key: "kid", parent: "b", parentWhy: "Evidence", title: "Kid", parentOwnWork: { key: "b-own", title: "Own" } };
  await assert.rejects(op.createItem(blockedSplit), /b-own.*卡住了，但没写在等什么/);
  await op.setStatus({ author, id: "b", status: "wip", log: "Working alongside dependencies" });
  const before = store.snapshot().items.b!; // WIP leaf
  const head = store.snapshot().head;
  await assert.rejects(op.createItem({ author, key: "kid", parent: "b", parentWhy: "Evidence", title: "Kid" }), /parentOwnWork: b is a leaf \(wip\)/);
  assert.equal(store.snapshot().head, head);
  const result = await op.createItem({ author, key: "kid", parent: "b", parentWhy: "Evidence", title: "Kid", parentOwnWork: { key: "b-own", title: "b 自己的工作" } });
  const s = store.snapshot(), b = s.items.b!, own = s.items["b-own"]!;
  assert.equal(b.status, undefined); assert.equal(b.priority, undefined); // b is not a root: area lists it
  assert.equal(own.status, before.status); assert.equal(own.priority, undefined); assert.equal(own.parent, "b");
  assert.deepEqual(b.deps.slice(-2), [{ id: "kid", why: "Evidence" }, { id: "b-own", why: "它自己的工作" }]);
  assert.equal(rules(s).statusOf("b"), "wip"); // derived from b-own, as before the split
  assert.equal((await store.log({ limit: 1 }))[0]!.commit, result.commit);
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files.sort(), ["items/b-own.yaml", "items/b.yaml", "items/kid.yaml"]);
  await assert.rejects(op.createItem({ author, key: "kid2", parent: "b", parentWhy: "More", title: "Kid 2", parentOwnWork: { key: "b-own2", title: "x" } }), /already has sub-items/);
});


test("R2 moves require and atomically preserve both leaf transitions", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  await op.setStatus({ author, id: "other", status: "wip", log: "Own work" });
  const move = { author, id: "a", parent: "other", parentWhy: "Transfer" };
  const before = store.snapshot();
  await assert.rejects(op.moveItem(move), /parentOwnWork/);
  assert.deepEqual(store.snapshot(), before);
  await op.moveItem({ ...move, parentOwnWork: { key: "own", title: "Original work" } });
  let s = store.snapshot();
  assert.equal(s.items.own!.status, "wip"); assert.equal(s.items.own!.priority, undefined);
  assert.equal(s.items.other!.status, undefined); assert.equal(s.items.other!.priority, "P1"); // a root keeps its priority
  assert.equal(rules(s).statusOf("other"), "wip");
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files.sort(), ["items/a.yaml", "items/area.yaml", "items/other.yaml", "items/own.yaml"]);
  const last = { author, id: "b", parent: "other", parentWhy: "Last child" };
  await assert.rejects(op.moveItem(last), /sourceStatus/);
  await op.moveItem({ ...last, sourceStatus: "done", sourcePriority: "P2" }); // area is a root, so its priority may be set
  s = store.snapshot();
  assert.equal(s.items.area!.status, "done"); assert.equal(s.items.area!.priority, "P2");
  assert.match(s.items.area!.log.at(-1)!.text, /阻塞证据.*完成.*P2/);
  assert.deepEqual((await Store.open(dir)).snapshot(), s);
});

test("R4 concurrent replies refuse replacement unless explicitly requested", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  const results = await Promise.allSettled([
    op.replyNote({ author, id: "note-1", reply: "First answer" }),
    ops(store, () => later).replyNote({ author, id: "note-1", reply: "Second answer" }),
  ]);
  assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected"]);
  assert.match(String((results[1] as PromiseRejectedResult).reason), /Whitefoot.*2026-10-11T02:03:04Z/);
  assert.equal(store.snapshot().notes["note-1"]!.reply, "First answer");
  await op.replyNote({ author, id: "note-1", reply: "Correction", replace: true });
  assert.equal(store.snapshot().notes["note-1"]!.reply, "Correction");
  assert.equal((await store.log({ kind: "note", id: "note-1" })).length, 3);
});

test("R7 prospective validation rejects newly introduced checks on affected items", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  const before = store.snapshot();
  await assert.rejects(op.createItem({ author, key: "stuck", title: "Stuck", parent: "area", parentWhy: "Work", status: "blocked" }), /stuck.*卡住了，但没写在等什么/);
  await assert.rejects(op.updateItem({ author, id: "area", rev: 1, deps: [{ id: "b", why: "Keep b" }] }), /a.*上级没有把它列在依赖里/);
  assert.deepEqual(store.snapshot(), before);
  const legacyAskItem = store.snapshot().items.other!;
  await store.commit({ author: "Fixture", message: "Legacy ask", puts: [{ kind: "item", id: "other", expectRev: legacyAskItem.rev, doc: { ...legacyAskItem, ask: { text: "Approve" } } }] });
  await op.setStatus({ author, id: "other", status: "blocked", log: "Wait" });
  const blocked = store.snapshot();
  await assert.rejects(op.clearAsk({ author, id: "other", log: "Remove" }), /other.*卡住了，但没写在等什么/);
  assert.deepEqual(store.snapshot(), blocked);
  // Existing imported warnings must not prevent unrelated progress.
  await store.commit({ author, message: "Imported warning", puts: [{ kind: "item", id: "legacy", expectRev: null, doc: { title: "Legacy", group: "Whitefoot", status: "blocked", priority: "P2", updated: at } }] });
  await op.appendLog({ author, id: "legacy", text: "Still investigating" });
});


test("R7 missing targets and reasons quote checks and the affected item; cards also validate their item", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  for (const [deps, pattern] of [
    [[{ id: "missing", why: "Need it" }], /a.*依赖的条目不存在：missing/],
    [[{ card: "missing", why: "Need it" }], /a.*依赖的决策卡不存在：missing/],
    [[{ id: "b", why: "  " }], /a.*依赖没写为什么/],
  ] as const) await assert.rejects(op.updateItem({ author, id: "a", rev: 1, deps: [...deps] }), pattern);
  await op.writeCard({ author, key: "blocker", item: "other", question: "Q", background: "B", options: [{ key: "A", text: "A" }] });
  await op.setStatus({ author, id: "other", status: "blocked", log: "Needs owner decision" });
  const before = store.snapshot();
  await assert.rejects(op.ruleCard({ author, key: "blocker", ruling: "Done" }), /other.*卡住了，但没写在等什么/);
  await assert.rejects(op.writeCard({ author, key: "blocker", rev: 1, item: "a", question: "Q", background: "B", options: [{ key: "A", text: "A" }] }), /other.*卡住了，但没写在等什么/);
  assert.deepEqual(store.snapshot(), before);
});

// Each refusal has otherwise valid arguments; compare a reopened store too.
for (const [name, args] of [
  ["createItem", { key: "new", title: "New", parent: "area", parentWhy: "Need" }],
  ["createItem", { key: "new", title: "New", group: "Whitefoot", priority: "P1" }],
  ["appendLog", { id: "a", text: "Writer" }],
  ["updateItem", { id: "a", rev: 1, title: "Writer" }],
  ["setStatus", { id: "a", status: "done", log: "Writer" }],
  ["clearAsk", { id: "a", log: "Writer" }],
  ["moveItem", { id: "a", parent: "area", parentWhy: "Move" }],
  ["writeCard", { key: "new-card", item: "a", question: "Q?", background: "Why", options: [{ key: "A", text: "A" }] }],
  ["ruleCard", { key: "choice", ruling: "Writer" }],
  ["replyNote", { id: "note-1", reply: "Writer" }],
  ["replyNote", { id: "note-2", reply: "Writer", replace: true }],
  ["closeNote", { id: "note-1", log: "Writer" }],
  ["closeNote", { id: "note-2", log: "Writer" }],
  ["triageRequest", { id: "req", log: "Writer" }],
] as const) test(`project enforcement ${name} ${JSON.stringify(args)}`, async t => {
  const { store, op, dir } = await board(t);
  await store.commit({ author: "Fixture", message: "Request", puts: [{ kind: "item", id: "req", expectRev: null, doc: { title: "Request", group: "Whitefoot", status: "todo", priority: "P1", updated: at, request: { by: "Firn", at } } }] });
  const before = store.snapshot();
  const call = op[name] as (a: Record<string, unknown>) => Promise<unknown>;
  for (const writer of ["Firn", "Outsider"]) {
    await assert.rejects(() => call({ author: writer, ...args }), e => {
      assert.ok(e instanceof OpError);
      assert.match(e.message, /item .* belongs to project Whitefoot; file a request into Whitefoot with create_request instead/);
      if (writer === "Outsider") assert.match(e.message, /author.*configured project.*Whitefoot.*Firn.*call projects.*repo.*repository/);
      return true;
    });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
  }
  await call({ author: "Whitefoot", ...args });
  assert.notEqual(store.snapshot().head, before.head, "the owning project succeeds");
});

test("project enforcement checks destination and previous card owner", async t => {
  const {store,op} = await board(t), before = store.snapshot();
  await assert.rejects(op.moveItem({author,id:"a",parent:"other",parentWhy:"Move",parentOwnWork:{key:"own",title:"Own"}}), /project Firn/);
  // Firn owns the destination but not the source: only the source check can refuse this.
  await assert.rejects(op.moveItem({author:"Firn",id:"a",parent:"other",parentWhy:"Move",parentOwnWork:{key:"own",title:"Own"}}), /item a belongs to project Whitefoot/);
  await assert.rejects(op.writeCard({author:"Firn",key:"choice",rev:1,item:"other",question:"Q",background:"B",options:[{key:"A",text:"A"}]}), /project Whitefoot/);
  assert.deepEqual(store.snapshot(),before);
});

test("project requests atomically link the filing project, triage both ways, move and decline", async t => {
  const {store,op} = await board(t);
  const request = {author,project:"Firn",key:"req",title:"Need feature",head:"Witness",why:"Blocks compiler",from:"a"};
  const before = (await store.log()).length;
  await op.createRequest(request);
  assert.equal((await store.log()).length,before+1);
  assert.deepEqual(store.snapshot().items.req!.request,{by:author,at:later});
  assert.deepEqual(store.snapshot().items.a!.deps.at(-1),{id:"req",why:request.why});
  assert.equal(store.snapshot().items.req!.log[0]!.text,`${author} 提出：${request.why}`);
  const unchanged = store.snapshot();
  await assert.rejects(op.createRequest({...request,key:"bad",from:"other"}),/project Firn/);
  await assert.rejects(op.createRequest({...request,key:"bad",project:"Missing"}),/project.*Missing/);
  await assert.rejects(op.triageRequest({author,id:"req",log:"Mine"}),/project Firn/);
  await assert.rejects(op.triageRequest({author:"Firn",id:"req",parent:"area",parentWhy:"Wrong project",log:"Place"}),/project/);
  assert.deepEqual(store.snapshot(),unchanged);
  await op.triageRequest({author:"Firn",id:"req",parent:"other",parentWhy:"Need",parentOwnWork:{key:"own",title:"Own"},log:"Scheduled"});
  const s = store.snapshot();
  assert.equal(s.items.req!.request,undefined); assert.equal(s.items.req!.parent,"other"); assert.equal(s.items.req!.priority,undefined);
  assert.equal(s.items.req!.log.at(-1)!.text,"Scheduled"); assert.equal(s.items.own!.status,"todo");
  assert.equal(s.items.req!.log.at(-2)!.text,"分拣：放到「其他项目」下：Need");
  assert.ok(s.items.other!.deps.some(d => "id" in d && d.id === "req" && d.why === "Need"));
  await assert.rejects(op.triageRequest({author:"Firn",id:"req",log:"Again"}),/request/);
  await op.createRequest({...request,key:"area-req"});
  await op.triageRequest({author:"Firn",id:"area-req",log:"Own area"});
  assert.equal(store.snapshot().items["area-req"]!.parent,undefined); assert.equal(store.snapshot().items["area-req"]!.request,undefined);
  await op.createRequest({...request,key:"move-req"});
  await op.moveItem({author:"Firn",id:"move-req",parent:"other",parentWhy:"Placement"});
  assert.equal(store.snapshot().items["move-req"]!.request,undefined);
  assert.equal(store.snapshot().items["move-req"]!.log.at(-1)!.text,"分拣：放到「其他项目」下：Placement");
  await op.createRequest({...request,key:"declined"});
  await op.setStatus({author:"Firn",id:"declined",status:"cancelled",log:"Not needed"});
  assert.equal(store.snapshot().items.declined!.request,undefined); assert.equal(store.snapshot().items.declined!.status,"cancelled");
});

test("project closeNote handles sent card/item notes atomically and refuses drafts", async t => {
  const {store,op} = await board(t);
  for (const target of ["it:a","q:choice"]) {
    const id = target === "it:a" ? "close-item" : "close-card";
    await store.commit({author:"Fixture",message:"Note",puts:[{kind:"note",id,expectRev:null,doc:{target,kind:"done",text:"Done",state:"draft",at}}]});
    const before = store.snapshot();
    await assert.rejects(op.closeNote({author,id,log:"Handled"}),/draft/); assert.deepEqual(store.snapshot(),before);
    await store.commit({author:"Fixture",message:"Send",puts:[{kind:"note",id,expectRev:1,doc:{...before.notes[id],state:"sent",sentAt:at}}]});
    const count = (await store.log()).length;
    await op.closeNote({author,id,log:"Handled"});
    assert.equal((await store.log()).length,count+1);
    assert.deepEqual(store.snapshot().notes[id],{...before.notes[id],rev:3,state:"done",sentAt:at,repliedBy:author,repliedAt:later});
    assert.equal(store.snapshot().items.a!.log.at(-1)!.text,"关闭评论：Handled");
    await op.closeNote({author,id,log:"Recorded follow-up"});
    assert.equal(store.snapshot().notes[id]!.state,"done");
    assert.equal(store.snapshot().items.a!.log.at(-1)!.text,"关闭评论：Recorded follow-up");
  }
});

test("project creation accepts any author and repo updates require the project or coordinator", async t => {
  const { store, op, dir } = await board(t);
  await op.createProject({ author: "Unconfigured caller", name: "New project", repo: "Org/New" });
  assert.deepEqual(store.snapshot().board.projects.at(-1), { name: "New project", repo: "Org/New" });
  await assert.rejects(op.createProject({ author: "Unconfigured caller", name: "New project" }), /already/);
  await op.createProject({ author: "Unconfigured caller", name: "No repository" });
  assert.deepEqual(store.snapshot().board.projects.at(-1), { name: "No repository" });
  const before = store.snapshot();
  for (const writer of ["Firn", "Outsider"]) {
    await assert.rejects(op.updateProject({ author: writer, name: "Whitefoot", repo: "Org/Changed" }), e => {
      assert.ok(e instanceof OpError); assert.match(e.message, /project Whitefoot/);
      if (writer === "Outsider") assert.match(e.message, /configured project.*call projects.*repo.*repository/);
      return true;
    });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
  }
  await op.updateProject({ author: "No repository", name: "No repository", repo: "Org/First" });
  assert.deepEqual(store.snapshot().board.projects.at(-1), { name: "No repository", repo: "Org/First" });
  await op.updateProject({ author: "Whitefoot", name: "Whitefoot", repo: "Org/Changed" });
  assert.equal(store.snapshot().board.projects[0]!.repo, "Org/Changed");
  assert.equal((await store.log({ limit: 1 }))[0]!.message, "update_project Whitefoot");
  await op.updateProject({ author: "总管", name: "Whitefoot", repo: "Org/Coordinated" });
  assert.equal(store.snapshot().board.projects[0]!.repo, "Org/Coordinated");
  assert.equal((await store.log({ limit: 1 }))[0]!.author, "总管");
  const unchanged = store.snapshot();
  await assert.rejects(op.updateProject({ author: "Whitefoot", name: "Missing", repo: "Org/Missing" }), /project Missing.*configured/);
  assert.deepEqual(store.snapshot(), unchanged);
  await op.createItem({ author: "New project", key: "new-area", title: "Area", group: "New project", priority: "P2" });
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
});

test("总管 reorders and creates projects after an existing project in one commit, while omitted after preserves defaults", async t => {
  const { store, op, dir } = await board(t);
  const names = () => store.snapshot().board.projects.map(p => p.name);
  const initial = store.snapshot();
  let count = (await store.log()).length;
  await op.updateProject({ author: "总管", name: "Whitefoot", after: "Firn" });
  assert.deepEqual(names(), ["Firn", "Whitefoot", "总管"]);
  assert.deepEqual(store.snapshot().items, initial.items);
  assert.equal((await store.log()).length, ++count);
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files, ["board.yaml"]);
  await op.updateProject({ author: "总管", name: "总管", repo: "Org/Coordinator", after: "Firn" });
  assert.deepEqual(names(), ["Firn", "总管", "Whitefoot"]);
  assert.equal(store.snapshot().board.projects[1]!.repo, "Org/Coordinator");
  assert.equal((await store.log()).length, ++count);
  await op.createProject({ author: "总管", name: "Inserted", repo: "Org/Inserted", after: "Firn" });
  assert.deepEqual(names(), ["Firn", "Inserted", "总管", "Whitefoot"]);
  assert.deepEqual(store.snapshot().board.projects[1], { name: "Inserted", repo: "Org/Inserted" });
  assert.equal((await store.log()).length, ++count);
  await op.createProject({ author: "Any caller", name: "Last" });
  assert.deepEqual(names(), ["Firn", "Inserted", "总管", "Whitefoot", "Last"]);
  assert.equal((await store.log()).length, ++count);
  await op.updateProject({ author: "Whitefoot", name: "Whitefoot", repo: "Org/Changed" });
  assert.deepEqual(names(), ["Firn", "Inserted", "总管", "Whitefoot", "Last"]);
  assert.equal((await store.log()).length, ++count);
  await op.updateProject({ author: "总管", name: "Firn", after: "Last" });
  assert.deepEqual(names(), ["Inserted", "总管", "Whitefoot", "Last", "Firn"]);
  assert.equal((await store.log()).length, ++count);
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
});

test("project after rejects noncoordinators, unknown projects and self placement atomically", async t => {
  const { store, op, dir } = await board(t), before = store.snapshot(), count = (await store.log()).length;
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.updateProject({ author: "Whitefoot", name: "Whitefoot", after: "Firn" }), /after: only.*总管/],
    [() => op.updateProject({ author: "Whitefoot", name: "Whitefoot", repo: "Org/Changed", after: "Firn" }), /after: only.*总管/],
    [() => op.updateProject({ author: "Firn", name: "Whitefoot", repo: "Org/Changed", after: "Firn" }), /only that project or 总管 may update its repo/],
    [() => op.createProject({ author: "Whitefoot", name: "New", after: "Firn" }), /after: only.*总管/],
    [() => op.createProject({ author: "Any caller", name: "New", after: "Firn" }), /after: only.*总管/],
    [() => op.updateProject({ author: "总管", name: "Whitefoot", repo: "Org/Changed", after: "Missing" }), /after Missing.*configured/],
    [() => op.createProject({ author: "总管", name: "New", after: "Missing" }), /after Missing.*configured/],
    [() => op.updateProject({ author: "总管", name: "Missing", after: "Firn" }), /project Missing.*configured/],
    [() => op.updateProject({ author: "总管", name: "Whitefoot", after: "Whitefoot" }), /after.*cannot follow itself/],
    [() => op.createProject({ author: "总管", name: "New", after: "New" }), /after.*cannot follow itself/],
    [() => op.updateProject({ author: "Whitefoot", name: "Whitefoot" }), /repo.*provide/],
    [() => op.updateProject({ author: "Whitefoot", name: "Whitefoot", after: "Firn", migrated: true }), /migrated: only.*总管/],
    [() => op.updateProject({ author: "总管", name: "Whitefoot", after: "Firn", migrated: false }), /migration cannot be undone/],
  ];
  for (const [call, message] of cases) {
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError); assert.match(e.message, message); return true; });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
});

test("project repo, migration and after placement share one commit", async t => {
  const { store, op, dir } = await board(t, { unmigrated: true }), count = (await store.log()).length;
  const before = store.snapshot();
  await assert.rejects(op.updateProject({ author: "总管", name: "Whitefoot", repo: "Org/Changed", migrated: true, after: "Missing" }), /after Missing.*configured/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
  assert.equal((await store.log()).length, count);
  await op.updateProject({ author: "总管", name: "Whitefoot", repo: "Org/Changed", migrated: true, after: "总管" });
  assert.deepEqual(store.snapshot().board.projects.map(p => p.name), ["Firn", "总管", "Whitefoot"]);
  assert.deepEqual(store.snapshot().board.projects[2], { name: "Whitefoot", repo: "Org/Changed", migrated: true });
  assert.equal(store.snapshot().items.a!.priority, undefined);
  assert.equal(store.snapshot().items.b!.priority, undefined);
  assert.match(store.snapshot().items.a!.log.at(-1)!.text, /迁移到依赖结构/);
  assert.equal((await store.log()).length, count + 1);
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files.sort(), ["board.yaml", "items/a.yaml", "items/b.yaml"]);
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
});

test("unconfigured request authors are refused before creating an inbox item", async t => {
  const { store, op, dir } = await board(t), before = store.snapshot();
  await assert.rejects(op.createRequest({ author: "Outsider", project: "Firn", key: "unknown-request", title: "Request", head: "Evidence", priority: "P1", why: "Need" }), /author.*configured project.*Whitefoot.*Firn.*call projects.*repo.*repository/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
});

test("only a root, an item nothing depends on, takes a stored priority when created, updated, filed or triaged", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  async function refused(call: () => Promise<unknown>, message: RegExp) {
    const before = store.snapshot();
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError); assert.match(e.message, message); return true; });
    assert.deepEqual(store.snapshot(), before);
  }
  await refused(() => op.createItem({ author, key: "kid", parent: "area", parentWhy: "Part", title: "Kid", priority: "P0" }), /^priority: kid 有未完成的条目依赖它，它的优先级来自这些条目（area）/);
  await op.createItem({ author, key: "kid", parent: "area", parentWhy: "Part", title: "Kid" });
  assert.equal(store.snapshot().items.kid!.priority, undefined); assert.equal(rules(store.snapshot()).priorityOf("kid"), "P1");
  await refused(() => op.createItem({ author, key: "goal", title: "Goal", group: "Whitefoot" }), /^priority: 新的根条目/);
  await op.createItem({ author, key: "goal", title: "Goal", group: "Whitefoot", priority: "P2" });
  assert.equal(rules(store.snapshot()).priorityOf("goal"), "P2");
  await refused(() => op.updateItem({ author, id: "a", rev: 1, priority: "P2" }), /^priority: a 有未完成的条目依赖它，它的优先级来自这些条目（area、b）/);
  await op.updateItem({ author, id: "area", rev: 2, priority: "P0" });
  assert.equal(rules(store.snapshot()).priorityOf("kid"), "P0");
  const request = { author, project: "Firn", title: "Need", head: "Witness", why: "Blocks" };
  await refused(() => op.createRequest({ ...request, key: "linked", from: "a", priority: "P2" }), /^priority: linked 有未完成的条目依赖它，它的优先级来自这些条目（a）/);
  await op.createRequest({ ...request, key: "linked", from: "a" });
  assert.equal(store.snapshot().items.linked!.priority, undefined); assert.equal(rules(store.snapshot()).priorityOf("linked"), "P0");
  await refused(() => op.createRequest({ ...request, key: "loose" }), /^priority: 没有 from 的请求是根条目/);
  await op.createRequest({ ...request, key: "loose", priority: "P2" });
  await op.createRequest({ ...request, key: "placed", priority: "P2" });
  await refused(() => op.triageRequest({ author: "Firn", id: "linked", priority: "P1", log: "Own area" }), /^priority: linked 有未完成的条目依赖它，它的优先级来自这些条目（a）/);
  await refused(() => op.triageRequest({ author: "Firn", id: "placed", parent: "other", parentWhy: "Part", parentOwnWork: { key: "other-own", title: "Own" }, priority: "P1", log: "Placed" }), /^priority: placed 有未完成的条目依赖它，它的优先级来自这些条目（other）/);
  await op.triageRequest({ author: "Firn", id: "loose", priority: "P1", log: "Own area" });
  assert.equal(store.snapshot().items.loose!.priority, "P1");
  await op.triageRequest({ author: "Firn", id: "linked", log: "Own area" });
  assert.equal(rules(store.snapshot()).priorityOf("linked"), "P0");
});

test("a source losing its last sub-item takes a priority only when it is a root", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  await op.createItem({ author, key: "mid", parent: "area", parentWhy: "Part", title: "Mid" });
  await op.createItem({ author, key: "kid", parent: "mid", parentWhy: "Part", title: "Kid", parentOwnWork: { key: "mid-own", title: "Mid own" } });
  await op.moveItem({ author, id: "mid-own", parent: "other", parentWhy: "Elsewhere", parentOwnWork: { key: "other-own", title: "Other own" } });
  assert.equal(store.snapshot().items["other-own"]!.priority, undefined); assert.equal(store.snapshot().items.other!.priority, "P1");
  const before = store.snapshot();
  await assert.rejects(op.moveItem({ author, id: "kid", parent: "area", parentWhy: "Up", sourceStatus: "todo", sourcePriority: "P2" }), /priority: mid 有未完成的条目依赖它，它的优先级来自这些条目（area）/);
  assert.deepEqual(store.snapshot(), before);
  await op.moveItem({ author, id: "kid", parent: "area", parentWhy: "Up", sourceStatus: "todo" });
  const s = store.snapshot();
  assert.equal(s.items.mid!.status, "todo"); assert.equal(s.items.mid!.priority, undefined); assert.equal(rules(s).priorityOf("mid"), "P1");
  assert.equal(s.items.mid!.log.at(-1)!.text, "最后一个子条目「Kid」移走；恢复为叶条目，状态 未开始。");
});

test("an item left without an open dependent is a root: it is flagged without a priority and update_item may set one", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  await op.createItem({ author, key: "tool", title: "Tool", group: "Whitefoot", priority: "P2" });
  const made = await op.createItem({ author, key: "goal", title: "Goal", group: "Whitefoot", priority: "P1", deps: [{ id: "tool", why: "Needs the tool" }] });
  // Adding the dep made tool a non-root, so the same commit dropped its stored priority.
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files.sort(), ["items/goal.yaml", "items/tool.yaml"]); assert.equal((await store.log({ limit: 1 }))[0]!.commit, made.commit);
  assert.equal(store.snapshot().items.tool!.priority, undefined); assert.equal(rules(store.snapshot()).priorityOf("tool"), "P1");
  await assert.rejects(op.updateItem({ author, id: "tool", rev: 2, priority: "P0" }), /priority: tool 有未完成的条目依赖它，它的优先级来自这些条目（goal）/);
  await op.setStatus({ author, id: "goal", status: "done", log: "Shipped" });
  let r = rules(store.snapshot());
  assert.equal(r.isRoot("tool"), true); assert.equal(r.priorityOf("tool"), ""); assert.ok(r.checks("tool").some(c => c.text === "没有未完成的条目依赖它，却没写优先级"));
  await op.updateItem({ author, id: "tool", rev: 2, priority: "P0" });
  r = rules(store.snapshot()); assert.equal(r.priorityOf("tool"), "P0"); assert.deepEqual(r.checks("tool").filter(c => c.text === "没有未完成的条目依赖它，却没写优先级"), []);
  await op.setStatus({ author, id: "goal", status: "todo", log: "Reopened" });
  assert.equal(store.snapshot().items.tool!.priority, undefined); assert.equal(rules(store.snapshot()).priorityOf("tool"), "P1");
});

test("a write that makes an item a non-root drops its stored priority, so removing the dependency later leaves it flagged without one", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  await op.createRequest({ author: "Firn", project: "Whitefoot", key: "req", title: "Need", head: "Witness", priority: "P0", why: "Blocks" });
  await op.triageRequest({ author, id: "req", parent: "area", parentWhy: "Part", log: "Placed" });
  assert.equal(store.snapshot().items.req!.priority, undefined); assert.equal(rules(store.snapshot()).priorityOf("req"), "P1");
  await op.createItem({ author, key: "spare", title: "Spare", group: "Whitefoot", priority: "P0" });
  await op.moveItem({ author, id: "spare", parent: "area", parentWhy: "Part" });
  assert.equal(store.snapshot().items.spare!.priority, undefined); assert.equal(rules(store.snapshot()).priorityOf("spare"), "P1");
  await op.createItem({ author, key: "lib", title: "Lib", group: "Whitefoot", priority: "P2" });
  const user = store.snapshot().items.other!;
  await op.updateItem({ author, id: "other", rev: user.rev, deps: [{ id: "lib", why: "Uses lib" }] });
  assert.equal(store.snapshot().items.lib!.priority, undefined); assert.equal(rules(store.snapshot()).priorityOf("lib"), "P1");
  await op.updateItem({ author, id: "other", rev: user.rev + 1, deps: [] });
  const r = rules(store.snapshot());
  assert.equal(r.isRoot("lib"), true); assert.equal(r.priorityOf("lib"), ""); assert.ok(r.checks("lib").some(c => c.text === "没有未完成的条目依赖它，却没写优先级"));
});

test("LEGACY PRIORITY: an unmigrated project keeps the old write rules and refuses no priority", async t => {
  const { store, op } = await board(t, { sharedProjects: true, unmigrated: true });
  await assert.rejects(op.createItem({ author, key: "kid", parent: "area", parentWhy: "Part", title: "Kid" }), /priority: new leaf requires P0, P1 or P2/);
  await op.createItem({ author, key: "kid", parent: "area", parentWhy: "Part", title: "Kid", priority: "P0" });
  assert.equal(store.snapshot().items.kid!.priority, "P0");
  await op.updateItem({ author, id: "a", rev: 1, priority: "P2" });
  assert.equal(store.snapshot().items.a!.priority, "P2");
  await assert.rejects(op.createRequest({ author: "Firn", project: "Whitefoot", key: "loose", title: "Need", head: "Witness", why: "Blocks" }), /priority: new request requires P0, P1 or P2/);
  await op.createRequest({ author, project: "Whitefoot", key: "linked", title: "Need", head: "Witness", why: "Blocks", priority: "P1", from: "b" });
  assert.equal(store.snapshot().items.linked!.priority, "P1");
  await op.triageRequest({ author, id: "linked", parent: "area", parentWhy: "Part", priority: "P0", log: "Placed" });
  assert.equal(store.snapshot().items.linked!.priority, "P0"); // no drop under a parent
  await op.createItem({ author, key: "split", parent: "kid", parentWhy: "Part", title: "Split", priority: "P2", parentOwnWork: { key: "kid-own", title: "Own" } });
  assert.equal(store.snapshot().items["kid-own"]!.priority, "P0"); assert.equal(store.snapshot().items.kid!.priority, undefined);
  await op.createItem({ author, key: "lib", title: "Lib", group: "Whitefoot", priority: "P2" });
  await op.updateItem({ author, id: "other", rev: store.snapshot().items.other!.rev, deps: [{ id: "lib", why: "Uses lib" }] });
  assert.equal(store.snapshot().items.lib!.priority, "P2"); // no drop when a dep is added
  await op.moveItem({ author, id: "kid-own", parent: "area", parentWhy: "Up" });
  await assert.rejects(op.moveItem({ author, id: "split", parent: "area", parentWhy: "Up", sourceStatus: "todo" }), /sourceStatus and sourcePriority/);
  await op.moveItem({ author, id: "split", parent: "area", parentWhy: "Up", sourceStatus: "todo", sourcePriority: "P1" });
  assert.equal(store.snapshot().items.kid!.priority, "P1");
  const r = rules(store.snapshot());
  for (const id of Object.keys(store.snapshot().items)) assert.ok(!r.checks(id).some(c => /完成条件|优先级/.test(c.text)), id);
});

test("create_request follows the receiving project, and a migrated item's priority is dropped when an unmigrated item comes to depend on it", async t => {
  const { store, op } = await board(t, { sharedProjects: false, unmigrated: true });
  await store.commit({ author: "Fixture", message: "Migrate Firn", board: { ...store.snapshot().board, projects: store.snapshot().board.projects.map(p => p.name === "Firn" ? { ...p, migrated: true } : p) } });
  await assert.rejects(op.createRequest({ author, project: "Firn", key: "to-firn", title: "Need", head: "Witness", why: "Blocks", priority: "P1", from: "a" }), /priority: to-firn 有未完成的条目依赖它/);
  await op.createRequest({ author, project: "Firn", key: "to-firn", title: "Need", head: "Witness", why: "Blocks", from: "a" });
  assert.equal(store.snapshot().items["to-firn"]!.priority, undefined); assert.equal(rules(store.snapshot()).priorityOf("to-firn"), "P0"); // a's effective P0, raised by b
  await assert.rejects(op.createRequest({ author: "Firn", project: "Whitefoot", key: "to-wf", title: "Need", head: "Witness", why: "Blocks", from: "other" }), /priority: new request requires/);
  await op.updateItem({ author, id: "a", rev: store.snapshot().items.a!.rev, deps: [{ id: "other", why: "Uses Firn's area" }] });
  assert.equal(store.snapshot().items.other!.priority, undefined); assert.equal(rules(store.snapshot()).priorityOf("other"), "P0");
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files.sort(), ["items/a.yaml", "items/other.yaml"]);
});

test("board.yaml without migrated reads as unmigrated, and migrated: true round-trips", async t => {
  const { dir, store } = await board(t, { unmigrated: true });
  assert.doesNotMatch(await readFile(join(dir, "board.yaml"), "utf8"), /migrated/);
  assert.equal(rules((await Store.open(dir)).snapshot()).migrated("a"), false);
  await store.commit({ author: "Fixture", message: "Migrate", board: { ...store.snapshot().board, projects: store.snapshot().board.projects.map(p => p.name === "Whitefoot" ? { ...p, migrated: true } : p) } });
  assert.match(await readFile(join(dir, "board.yaml"), "utf8"), /migrated: true/);
  const reopened = rules((await Store.open(dir)).snapshot());
  assert.equal(reopened.migrated("a"), true); assert.equal(reopened.migrated("other"), false);
});

const MIGRATED = (p: string) => `迁移到依赖结构：优先级改由依赖它的条目决定，原来写的 ${p} 不再使用`;
test("migrating a project is a 总管 operation that drops every non-root's stored priority with a log entry, in one commit", async t => {
  const { store, op } = await board(t, { unmigrated: true });
  async function refused(call: () => Promise<unknown>, message: RegExp) {
    const before = store.snapshot();
    await assert.rejects(call(), message);
    assert.deepEqual(store.snapshot(), before);
  }
  await refused(() => op.updateProject({ author, name: "Whitefoot", migrated: true }), /migrated: only the coordinator project 总管 may migrate project Whitefoot/);
  await refused(() => op.updateProject({ author: "总管", name: "Whitefoot", migrated: false }), /migrated: a migration cannot be undone/);
  const result = await op.updateProject({ author: "总管", name: "Whitefoot", migrated: true });
  const s = store.snapshot(), r = rules(s);
  assert.deepEqual(s.board.projects.map(p => [p.name, p.migrated]), [["Whitefoot", true], ["Firn", undefined], ["总管", undefined]]);
  assert.equal(s.items.a!.priority, undefined); assert.equal(s.items.b!.priority, undefined);
  assert.deepEqual(s.items.a!.log.at(-1), { at: later, by: "总管", text: MIGRATED("P1") }); assert.deepEqual(s.items.b!.log.at(-1), { at: later, by: "总管", text: MIGRATED("P0") });
  assert.equal(s.items.area!.priority, "P1"); assert.equal(s.items.other!.priority, "P1"); // a root, and another project, keep theirs
  assert.deepEqual(result.dropped, [{ id: "a", priority: "P1" }, { id: "b", priority: "P0" }]);
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files.sort(), ["board.yaml", "items/a.yaml", "items/b.yaml"]);
  assert.equal(r.priorityOf("b"), "P1"); // now from area
  await refused(() => op.updateProject({ author: "总管", name: "Whitefoot", migrated: true }), /migrated: project Whitefoot is already migrated/);
  await op.updateProject({ author, name: "Whitefoot", repo: "Ming-Research/Whitefoot-next" }); // the repository rule is unchanged
  assert.equal(store.snapshot().board.projects[0]!.migrated, true);
});

const NOT_ROOT = (p: string) => `不再是根：优先级改由依赖它的条目决定，原来写的 ${p} 不再使用`;
test("a write that drops a stored priority logs it on that item, across projects, and returns the dropped items", async t => {
  const { store, op } = await board(t);
  await op.createItem({ author, key: "lib", title: "Lib", group: "Whitefoot", priority: "P2" });
  const result = await op.updateItem({ author: "Firn", id: "other", rev: 1, deps: [{ id: "lib", why: "Uses lib" }] });
  assert.deepEqual(result.dropped, [{ id: "lib", priority: "P2" }]);
  assert.deepEqual(store.snapshot().items.lib!.log.at(-1), { at: later, by: "Firn", text: NOT_ROOT("P2") });
  const plain = await op.appendLog({ author, id: "lib", text: "Progress" });
  assert.equal(plain.dropped, undefined);
});

test("LEGACY PRIORITY: unmigrated writes log no drop and offer none of the restructuring forms", async t => {
  const { store, op } = await board(t, { sharedProjects: true, unmigrated: true });
  await op.createItem({ author, key: "lib", title: "Lib", group: "Whitefoot", priority: "P2" });
  const result = await op.updateItem({ author, id: "other", rev: 1, deps: [{ id: "lib", why: "Uses lib" }] });
  assert.equal(result.dropped, undefined); assert.equal(store.snapshot().items.lib!.priority, "P2"); assert.deepEqual(store.snapshot().items.lib!.log, []);
  const before = store.snapshot();
  await assert.rejects(op.moveItem({ author, id: "b", priority: "P0" }), /new_parent: required; only a migrated project's item can become a root/);
  await assert.rejects(op.createItem({ author, key: "box", title: "Box", group: "Whitefoot", priority: "P1", children: [{ id: "b", why: "Part" }] }), /children: only a migrated project/);
  await op.createItem({ author, key: "empty", title: "Empty", group: "Whitefoot", priority: "P2" });
  await assert.rejects(op.moveItem({ author, id: "b", parent: "empty", parentWhy: "Part" }), /parentOwnWork: empty is a leaf \(todo P2\)/);
  assert.deepEqual(Object.keys(store.snapshot().items).sort(), [...Object.keys(before.items), "empty"].sort());
});

test("move_item without new_parent makes a migrated item a root of its project, with a priority, when nothing else open depends on it", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  async function refused(call: () => Promise<unknown>, message: RegExp) {
    const before = store.snapshot();
    await assert.rejects(call(), message);
    assert.deepEqual(store.snapshot(), before);
  }
  await refused(() => op.moveItem({ author, id: "b" }), /priority: 移成根条目要写 P0、P1 或 P2/);
  await refused(() => op.moveItem({ author, id: "a", priority: "P0" }), /new_parent: a 还有未完成的条目依赖它（b），移出上级后也不是根条目/);
  await refused(() => op.moveItem({ author, id: "other", priority: "P0" }), /new_parent: other is already top-level/);
  await refused(() => op.moveItem({ author, id: "b", parent: "other", parentWhy: "Part", priority: "P0", parentOwnWork: { key: "o", title: "O" } }), /priority: only when moving to the top level/);
  const result = await op.moveItem({ author, id: "b", priority: "P0" });
  const s = store.snapshot(), b = s.items.b!, r = rules(s);
  assert.equal(b.parent, undefined); assert.equal(b.group, "Whitefoot"); assert.equal(b.priority, "P0");
  assert.deepEqual(b.deps, [{ id: "a", why: "需要检查" }, { card: "choice", why: "需要决策" }]); // its own dependencies stay
  assert.equal(b.log.at(-1)!.text, "从「解释器工作」下移出，成为根条目，优先级 P0。");
  assert.ok(!s.items.area!.deps.some(d => "id" in d && d.id === "b")); assert.equal(r.isRoot("b"), true); assert.equal(r.priorityOf("a"), "P0");
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files.sort(), ["items/area.yaml", "items/b.yaml"]); assert.equal(result.id, "b");
  // The old parent follows the last-child rules.
  await refused(() => op.moveItem({ author, id: "a", priority: "P1" }), /new_parent: a 还有未完成的条目依赖它（b）/);
  await op.setStatus({ author, id: "b", status: "todo", log: "Unblocked" });
  await op.updateItem({ author, id: "b", rev: store.snapshot().items.b!.rev, deps: [] });
  await refused(() => op.moveItem({ author, id: "a", priority: "P1" }), /sourceStatus: area loses its last sub-item/);
  await op.moveItem({ author, id: "a", priority: "P1", sourceStatus: "todo" });
  assert.equal(store.snapshot().items.area!.status, "todo"); assert.equal(store.snapshot().items.a!.priority, "P1");
});

test("move_item logs name the old and new parents and the sub-items by title, never by key", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  await op.createItem({ author, key: "loose", title: "独立条目", group: "Whitefoot", priority: "P1" });
  await op.moveItem({ author, id: "loose", parent: "area", parentWhy: "Part" });
  assert.equal(store.snapshot().items.loose!.log.at(-2)!.text, "从顶层移到「解释器工作」下：Part");
  await op.moveItem({ author, id: "a", parent: "other", parentWhy: "Transfer", parentOwnWork: { key: "other-own", title: "其他项目自己的工作" } });
  const s = store.snapshot();
  assert.equal(s.items.a!.log.at(-1)!.text, "从「解释器工作」下移到「其他项目」下：Transfer");
  assert.equal(s.items.other!.log.at(-1)!.text, "加了子条目「中文检查」；它自己的工作移到新的子条目「其他项目自己的工作」。");
  assert.equal(s.items["other-own"]!.log.at(-1)!.text, "接过「其他项目」自己的工作（原状态 未开始）");
});

test("a legacy parent's own-work sub-item logs the parent's title, status and priority in plain words", async t => {
  const { store, op } = await board(t, { sharedProjects: true, unmigrated: true });
  await op.setStatus({ author, id: "other", status: "wip", log: "Started" });
  await op.createItem({ author, key: "kid", parent: "other", parentWhy: "Part", title: "Kid", priority: "P2", parentOwnWork: { key: "other-own", title: "Own" } });
  assert.equal(store.snapshot().items["other-own"]!.log.at(-1)!.text, "接过「其他项目」自己的工作（原状态 进行中，优先级 P1）");
});

test("a source losing its last sub-items logs their titles and its restored status in plain words", async t => {
  const migrated = await board(t, { sharedProjects: true });
  await migrated.op.createItem({ author, key: "group", title: "Group", group: "Whitefoot", priority: "P1", children: [{ id: "a", why: "x" }, { id: "b", why: "y" }], sourceStatus: "wip" });
  assert.equal(migrated.store.snapshot().items.area!.log.at(-1)!.text, "最后一个子条目「中文检查」、「阻塞证据」移走；恢复为叶条目，状态 进行中。");
  const legacy = await board(t, { sharedProjects: true, unmigrated: true });
  await legacy.op.moveItem({ author, id: "a", parent: "other", parentWhy: "x", parentOwnWork: { key: "other-own", title: "Own" } });
  await legacy.op.moveItem({ author, id: "b", parent: "other", parentWhy: "y", sourceStatus: "wip", sourcePriority: "P2" });
  assert.equal(legacy.store.snapshot().items.area!.log.at(-1)!.text, "最后一个子条目「阻塞证据」移走；恢复为叶条目，状态 进行中，优先级 P2。");
});

test("create_item with children moves existing items under a new parent in one commit, with no own-work stub", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  async function refused(call: () => Promise<unknown>, message: RegExp) {
    const before = store.snapshot();
    await assert.rejects(call(), message);
    assert.deepEqual(store.snapshot(), before);
  }
  const make = { author, key: "group", title: "Group", parent: "area", parentWhy: "Part" };
  await refused(() => op.createItem({ ...make, children: [{ id: "a", why: "x" }, { id: "a", why: "y" }] }), /children: name each item once/);
  await refused(() => op.createItem({ ...make, status: "wip", children: [{ id: "a", why: "x" }] }), /^Error: status: an item created with work children takes its status from them; omit status$/);
  await refused(() => op.createItem({ ...make, children: [{ id: "area", why: "x" }] }), /children: area contains the new item's parent area/);
  await refused(() => op.createItem({ ...make, children: [{ id: "missing", why: "x" }] }), /children missing: choose an existing item/);
  await refused(() => op.createItem({ author, key: "box", title: "Box", group: "Whitefoot", priority: "P1", children: [{ id: "a", why: "x" }, { id: "b", why: "y" }] }), /sourceStatus: area loses its last sub-item/);
  const result = await op.createItem({ ...make, children: [{ id: "a", why: "Checks" }, { id: "b", why: "Evidence" }] });
  const s = store.snapshot(), r = rules(s);
  assert.deepEqual(s.items.group!.deps, [{ id: "a", why: "Checks" }, { id: "b", why: "Evidence" }]); assert.equal(s.items.group!.status, undefined);
  assert.equal(s.items.a!.parent, "group"); assert.equal(s.items.b!.parent, "group"); assert.equal(s.items.a!.log.at(-1)!.text, "从「解释器工作」下移到「Group」下：Checks");
  assert.deepEqual(s.items.area!.deps, [{ id: "group", why: "Part" }]); assert.equal(r.statusOf("group"), "blocked");
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files.sort(), ["items/a.yaml", "items/area.yaml", "items/b.yaml", "items/group.yaml"]); assert.equal(result.id, "group");
  // A new root takes an old parent's last children; the emptied parent follows the source rules, and a child's stored priority is dropped with a log.
  await op.createItem({ author, key: "lib", title: "Lib", group: "Whitefoot", priority: "P2" });
  const boxed = await op.createItem({ author, key: "box", title: "Box", group: "Whitefoot", priority: "P0", children: [{ id: "group", why: "All of it" }, { id: "lib", why: "Uses lib" }], sourceStatus: "done" });
  const after = store.snapshot();
  assert.equal(after.items.area!.status, "done"); assert.equal(after.items.area!.priority, "P1"); assert.equal(after.items.lib!.priority, undefined);
  assert.deepEqual(after.items.lib!.log.at(-1), { at: later, by: author, text: NOT_ROOT("P2") }); assert.deepEqual(boxed.dropped, [{ id: "lib", priority: "P2" }]);
  await refused(() => op.createItem({ author: "Firn", key: "theirs", title: "Theirs", group: "Firn", priority: "P1", children: [{ id: "a", why: "x" }] }), /item a belongs to project Whitefoot/);
});

test("create_item adopts an item together with its own sub-item, and refuses a child already named in deps", async t => {
  for (const order of [["area", "a"], ["a", "area"]]) await t.test(order.join(" then "), async t => {
    const { store, op } = await board(t, { sharedProjects: true });
    await assert.rejects(op.createItem({ author, key: "flat", title: "Flat", group: "Whitefoot", priority: "P1", deps: [{ id: "a", why: "d" }], children: [{ id: "a", why: "c" }] }), /children: a is already in deps/);
    await op.createItem({ author, key: "flat", title: "Flat", group: "Whitefoot", priority: "P1", children: order.map(id => ({ id, why: "Flatten " + id })) });
    const s = store.snapshot();
    assert.equal(s.items.area!.parent, "flat"); assert.equal(s.items.a!.parent, "flat");
    assert.ok(!s.items.area!.deps.some(d => "id" in d && d.id === "a"), "the adopted parent no longer lists the adopted child");
    assert.deepEqual(s.items.flat!.deps.map(d => "id" in d ? d.id : ""), order);
  });
});

test("move_item into a migrated leaf without work of its own needs no own-work sub-item; a leaf with work still does", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  await op.createItem({ author, key: "empty", title: "Empty", group: "Whitefoot", priority: "P2" });
  await op.createItem({ author, key: "busy", title: "Busy", group: "Whitefoot", priority: "P2" });
  await op.setStatus({ author, id: "busy", status: "wip", log: "Started" });
  await op.createItem({ author, key: "noted", title: "Noted", group: "Whitefoot", priority: "P2" });
  await op.appendLog({ author, id: "noted", text: "Some work" });
  const before = store.snapshot();
  for (const id of ["busy", "noted"]) await assert.rejects(op.moveItem({ author, id: "b", parent: id, parentWhy: "Part" }), new RegExp(`parentOwnWork: ${id} is a leaf`));
  assert.deepEqual(store.snapshot(), before);
  await op.moveItem({ author, id: "b", parent: "empty", parentWhy: "Part" });
  const s = store.snapshot(), r = rules(s);
  assert.equal(s.items.empty!.status, undefined); assert.equal(s.items.empty!.priority, "P2"); assert.equal(r.statusOf("empty"), "blocked");
  assert.equal(s.items.empty!.log.at(-1)!.text, "加了子条目「阻塞证据」；它自己没有工作，不另建自己的工作条目。");
  assert.deepEqual(Object.keys(s.items).sort(), Object.keys(before.items).sort()); // no own-work stub
  await op.createRequest({ author: "Firn", project: "Whitefoot", key: "req", title: "Need", head: "Witness", why: "Blocks", priority: "P1" });
  await op.createRequest({ author: "Firn", project: "Whitefoot", key: "req2", title: "Need", head: "Witness", why: "Blocks", priority: "P1" });
  await op.triageRequest({ author, id: "req2", log: "Own area" }); // a second log entry is work of its own
  await assert.rejects(op.moveItem({ author, id: "a", parent: "req2", parentWhy: "Part", sourceStatus: "todo" }), /parentOwnWork: req2 is a leaf/);
  await op.moveItem({ author, id: "a", parent: "req", parentWhy: "Part", sourceStatus: "todo" }); // only its creation entry: no work of its own
  assert.equal(store.snapshot().items.req!.status, undefined);
});

test("set_term adds and replaces a term in the author's own glossary and delete_term removes it, one commit each, surviving reopen", async t => {
  const { store, op, dir } = await board(t);
  async function committed(call: () => Promise<Result>, by: string, message: string, file: string) {
    const result = await call(), log = await store.log({ limit: 1 });
    assert.equal(result.commit, log[0]!.commit); assert.equal(log[0]!.author, by); assert.equal(log[0]!.message, message);
    assert.deepEqual(log[0]!.files, [file]);
  }
  await committed(() => op.setTerm({ author, term: "孪生对照", definition: "同一构建的第二份副本，一起跑来显示噪声。" }), author, "set_term 孪生对照", "glossaries/Whitefoot.yaml");
  await committed(() => op.setTerm({ author, term: "否决线", definition: "旧的说法" }), author, "set_term 否决线", "glossaries/Whitefoot.yaml");
  await committed(() => op.setTerm({ author: "总管", term: "否决线", definition: "总管的说法" }), "总管", "set_term 否决线", "glossaries/总管.yaml");
  await committed(() => op.setTerm({ author, term: "否决线", definition: "性能比较里判定变慢的界线。" }), author, "set_term 否决线", "glossaries/Whitefoot.yaml");
  const entry = (term: string, definition: string, by = author) => ({ term, definition, updated: later, by });
  assert.deepEqual(store.snapshot().glossaries, {
    Whitefoot: { terms: [entry("孪生对照", "同一构建的第二份副本，一起跑来显示噪声。"), entry("否决线", "性能比较里判定变慢的界线。")], rev: 3 },
    总管: { terms: [entry("否决线", "总管的说法", "总管")], rev: 1 },
  }, "a replaced term keeps its place, and another project's same term stays in its own glossary");
  assert.match(await readFile(join(dir, "glossaries/Whitefoot.yaml"), "utf8"), /term: 否决线\n {4}definition: 性能比较里判定变慢的界线。/);
  await committed(() => op.deleteTerm({ author, term: "孪生对照" }), author, "delete_term 孪生对照", "glossaries/Whitefoot.yaml");
  assert.deepEqual(store.snapshot().glossaries.Whitefoot!.terms.map(t => t.term), ["否决线"]);
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
});

test("glossary writes refuse an unconfigured author, an empty or badly spaced term, an empty definition and an unknown term, changing nothing", async t => {
  const { store, op, dir } = await board(t);
  await op.setTerm({ author, term: "否决线", definition: "性能比较里判定变慢的界线。" });
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.setTerm({ author: "Snowghost", term: "否决线", definition: "别的项目" }), /author Snowghost: choose a configured project/],
    [() => op.deleteTerm({ author: "Snowghost", term: "否决线" }), /author Snowghost: choose a configured project/],
    [() => op.setTerm({ author, term: " ", definition: "定义" }), /term: provide nonempty text/],
    [() => op.setTerm({ author, term: "术语", definition: " \n " }), /definition: provide nonempty text/],
    [() => op.setTerm({ author, term: "两\n行", definition: "定义" }), /term: write the term on one line/],
    [() => op.setTerm({ author, term: "否决线 ", definition: "定义" }), /term: write the term on one line/],
    [() => op.deleteTerm({ author: "Firn", term: "否决线" }), /term 否决线: not in Firn's glossary/],
  ];
  for (const [call, message] of cases) {
    const before = store.snapshot();
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError); assert.match(e.message, message); return true; });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
  }
  await assert.rejects(store.commit({ author, message: "Duplicate", puts: [{ kind: "glossary", id: author, expectRev: 1, doc: { terms: [...store.snapshot().glossaries.Whitefoot!.terms, ...store.snapshot().glossaries.Whitefoot!.terms] } }] }), /Terms must be unique/);
});

test("records create and update without status, refuse set_status, and restore work as todo", async t => {
  const { store, op } = await board(t);
  await op.createItem({ author, key: "record", parent: "area", title: "Merge queue", record: true, head: "Queue", parentWhy: "Holds the queue" });
  assert.equal(store.snapshot().items.record!.record, true);
  assert.equal(store.snapshot().items.record!.status, undefined);
  await assert.rejects(op.setStatus({ author, id: "record", status: "done", log: "Not work" }), /record has no status/);
  await assert.rejects(op.createItem({ author, key: "bad-record", group: author, title: "Invalid", priority: "P1", record: true, status: "todo" }), /record has no status/i);
  await op.appendLog({ author, id: "record", text: "Queue entry" });
  await op.updateItem({ author, id: "record", rev: store.snapshot().items.record!.rev, record: false });
  assert.equal(store.snapshot().items.record!.status, "todo");
  await op.setStatus({ author, id: "record", status: "wip", log: "Start work" });
  await op.updateItem({ author, id: "record", rev: store.snapshot().items.record!.rev, record: true });
  assert.equal(store.snapshot().items.record!.status, undefined);
  assert.equal(store.snapshot().items.record!.head, "Queue");
  const log = store.snapshot().items.record!.log;
  assert.equal(log.length, 4);
  assert.deepEqual(log.filter(e => e.by === author && /^改为/.test(e.text)).map(e => e.text), ["改为工作条目：状态为待做", "改为记录条目：不再有状态"]);
});

test("record: true refuses an item with work children or another project's item and logs only real conversions", async t => {
  const { store, op } = await board(t);
  await op.createItem({ author, key: "leaf", parent: "area", title: "Leaf", parentWhy: "Part of area" });
  await op.createItem({ author, key: "kid", parent: "leaf", title: "Kid", parentWhy: "Needed", parentOwnWork: { key: "leaf-own", title: "Leaf own" } });
  const before = store.snapshot();
  await assert.rejects(op.updateItem({ author, id: "leaf", rev: before.items.leaf!.rev, record: true }), /record: leaf has work sub-items/);
  assert.deepEqual(store.snapshot(), before);
  await assert.rejects(op.updateItem({ author: "Firn", id: "leaf-own", rev: before.items["leaf-own"]!.rev, record: true }), /Firn|project|own/i);
  assert.deepEqual(store.snapshot(), before);
  const rev = store.snapshot().items.kid!.rev;
  await op.updateItem({ author, id: "kid", rev, record: false });
  assert.equal(store.snapshot().items.kid!.log.length, before.items.kid!.log.length, "record: false on a work item changes nothing and logs nothing");
});

test("record children preserve a work leaf's status and records can parent work without own-work stubs", async t => {
  const { store, op } = await board(t);
  await op.createItem({ author, key: "record", parent: "a", title: "Queue", record: true, parentWhy: "Holds the queue" });
  assert.equal(store.snapshot().items.a!.status, "todo");
  await op.setStatus({ author, id: "a", status: "wip", log: "Start" });
  assert.equal(rules(store.snapshot()).statusOf("area"), "wip");
  await op.appendLog({ author, id: "record", text: "Prior queue entry" });
  await op.createItem({ author, key: "work", parent: "record", title: "Work", parentWhy: "Tracks work" });
  assert.equal(store.snapshot().items.record!.status, undefined);
  assert.deepEqual(rules(store.snapshot()).children("record"), ["work"]);
  await op.moveItem({ author, id: "work", parent: "area", parentWhy: "Delivers work" });
  assert.equal(store.snapshot().items.record!.status, undefined, "losing its last child does not assign a record a status");
});

test("converting the first record child to work atomically preserves the parent's own work", async t => {
  const { store, op } = await board(t);
  await op.setStatus({author, id: "a", status: "wip", log: "Parent is working"});
  await op.createItem({author, key: "record", parent: "a", parentWhy: "Tracks results", title: "Record", record: true});
  const before = store.snapshot();
  await assert.rejects(op.updateItem({author, id: "record", rev: before.items.record!.rev, record: false}), /parentOwnWork/);
  assert.deepEqual(store.snapshot(), before);
  await op.updateItem({author, id: "record", rev: before.items.record!.rev, record: false, parentOwnWork: {key: "a-own", title: "Parent work"}});
  const after = store.snapshot();
  assert.equal(after.items.record!.status, "todo");
  assert.equal(after.items["a-own"]!.status, "wip");
  assert.equal(after.items.a!.status, undefined);
  assert.equal(after.items.a!.head, before.items.a!.head);
  assert.deepEqual(after.items.a!.log.slice(0, -1), before.items.a!.log);
  assert.equal(rules(after).statusOf("a"), "wip");
});

test("adopting only record children retains a new work item's initial status", async t => {
  const {store, op} = await board(t);
  await op.createItem({author, key: "record", group: author, title: "Queue", priority: "P1", record: true});
  await op.createItem({author, key: "work", group: author, title: "Work", priority: "P1", status: "wip", children: [{id: "record", why: "Keeps progress"}]});
  assert.equal(store.snapshot().items.work!.status, "wip");
  assert.equal(rules(store.snapshot()).statusOf("work"), "wip");
});

test("an imported record with a missing parent can become work while retaining the hierarchy check", async t => {
  const {store, op} = await board(t);
  await store.commit({author: "Fixture", message: "Imported orphan record", puts: [{kind: "item", id: "orphan-record", expectRev: null, doc: {title: "Orphan record", group: author, parent: "absent", record: true, priority: "P1", updated: at}}]});
  await op.updateItem({author, id: "orphan-record", rev: store.snapshot().items["orphan-record"]!.rev, record: false});
  assert.equal(store.snapshot().items["orphan-record"]!.status, "todo");
  assert.ok(rules(store.snapshot()).checks("orphan-record").some(c => c.text === "上级条目不存在：absent"));
});


test("steps upsert, replace and remove keep stable order and make one commit per call", async t => {
  const { store, op } = await board(t);
  const baseline = store.snapshot().head, before = store.snapshot().items.a!;
  await op.setSteps({ author, id: "a", step: { id: "check", text: "Checks pass #341", state: "doing", waits: "CI" } });
  await op.setSteps({ author, id: "a", step: { id: "review", text: "Review complete", state: "todo" } });
  await op.setSteps({ author, id: "a", step: { id: "check", text: "Checks pass", state: "done" } });
  assert.deepEqual(store.snapshot().items.a!.steps!.map(step => step.id), ["check", "review"]);
  assert.equal(store.snapshot().items.a!.steps![0]!.doneAt, later);
  assert.equal(store.snapshot().items.a!.steps![0]!.since, later, "done retains previous doing timestamp");
  await op.setSteps({ author, id: "a", steps: [
    { id: "review", text: "Review complete", state: "doing" },
    { id: "check", text: "Checks pass", state: "done" },
    { id: "publish", text: "Owner merges", state: "todo" },
  ] });
  assert.deepEqual(store.snapshot().items.a!.steps!.map(step => step.id), ["review", "check", "publish"]);
  await op.setSteps({ author, id: "a", remove: "review" });
  assert.deepEqual(store.snapshot().items.a!.steps!.map(step => step.id), ["check", "publish"]);
  await op.setSteps({ author, id: "a", steps: [] });
  assert.deepEqual(store.snapshot().items.a!.steps, []);
  const current = store.snapshot().items.a!;
  assert.equal(current.status, before.status); assert.equal(current.head, before.head); assert.deepEqual(current.log, before.log);
  const commits = await store.log({ since: baseline });
  assert.equal(commits.length, 6); assert.ok(commits.every(commit => commit.message === "set_steps a"));
});

test("steps stamp each state transition, preserve same-state dates and retain date history", async t => {
  const { store } = await board(t);
  let clock = "2026-10-12T00:00:00Z";
  const op = ops(store, () => clock), step = { id: "build", text: "Build passes", state: "todo" as const };
  const write = async (state: "todo" | "doing" | "done" | "dropped", text = step.text) => {
    await op.setSteps({ author, id: "a", step: { ...step, text, state, ...(state === "dropped" ? { reason: "Superseded" } : {}) } });
    return store.snapshot().items.a!.steps![0]!;
  };
  assert.deepEqual(await write("todo"), step);
  const firstDoing = await write("doing"); assert.equal(firstDoing.since, clock);
  clock = "2026-10-13T00:00:00Z";
  assert.equal((await write("doing", "Build and check pass")).since, firstDoing.since);
  const done = await write("done"); assert.equal(done.doneAt, clock); assert.equal(done.since, firstDoing.since);
  clock = "2026-10-14T00:00:00Z";
  await op.setSteps({ author, id: "a", steps: [{ ...step, state: "done" }] });
  assert.equal(store.snapshot().items.a!.steps![0]!.doneAt, done.doneAt, "replacement preserves same-state dates by stable id");
  const secondDoing = await write("doing"); assert.equal(secondDoing.since, clock); assert.equal(secondDoing.doneAt, done.doneAt);
  clock = "2026-10-15T00:00:00Z";
  const dropped = await write("dropped"); assert.equal(dropped.droppedAt, clock);
  clock = "2026-10-16T00:00:00Z";
  assert.equal((await write("dropped", "Build omitted")).droppedAt, dropped.droppedAt);
  const todo = await write("todo");
  assert.equal(todo.since, secondDoing.since); assert.equal(todo.doneAt, done.doneAt); assert.equal(todo.droppedAt, dropped.droppedAt);
  const redone = await write("done"); assert.equal(redone.doneAt, clock, "entering done again stamps a new completion date");
  await op.setSteps({ author, id: "a", steps: [{ id: "initial-done", text: "Done from birth", state: "done" }, { id: "initial-drop", text: "Not needed", state: "dropped", reason: "Replaced" }] });
  assert.equal(store.snapshot().items.a!.steps![0]!.doneAt, clock); assert.equal(store.snapshot().items.a!.steps![1]!.droppedAt, clock);
});

test("a set_steps call that leaves the steps identical changes nothing, not even updated, and writes no commit", async t => {
  const { store } = await board(t);
  let clock = "2026-10-12T00:00:00Z";
  const op = ops(store, () => clock), step = { id: "build", text: "Build passes", state: "todo" as const };
  await op.setSteps({ author, id: "a", step });
  const before = store.snapshot(), commits = (await store.log()).length;
  clock = "2026-10-13T00:00:00Z";
  for (const args of [{ step }, { steps: [step] }]) {
    const result = await op.setSteps({ author, id: "a", ...args });
    assert.equal(result.commit, before.head);
    assert.deepEqual(store.snapshot(), before);
    assert.equal((await store.log()).length, commits);
  }
  await op.setSteps({ author, id: "a", step: { ...step, text: "Build and tests pass" } });
  assert.equal((await store.log()).length, commits + 1, "a real change still writes one commit");
});

test("steps refuse missing dropped reasons, invalid or duplicate ids, dates and ambiguous operations atomically", async t => {
  const { store, op } = await board(t), before = store.snapshot();
  const valid = { id: "step", text: "Delivers result", state: "todo" as const };
  const cases: Array<[Parameters<Ops["setSteps"]>[0], RegExp]> = [
    [{ author, id: "a", step: { ...valid, state: "dropped" } }, /reason/],
    [{ author, id: "a", step: { ...valid, state: "dropped", reason: "  " } }, /reason/],
    [{ author, id: "a", step: { ...valid, id: "../bad" } }, /id/],
    [{ author, id: "a", step: { ...valid, id: "a".repeat(41) } }, /id/],
    [{ author, id: "a", steps: [valid, valid] }, /unique/],
    [{ author, id: "a", remove: "missing" }, /existing step/],
    [{ author, id: "a" }, /exactly one/],
    [{ author, id: "a", step: valid, steps: [] }, /exactly one/],
    [{ author, id: "a", step: { ...valid, since: later } } as Parameters<Ops["setSteps"]>[0], /Unrecognized key/],
  ];
  for (const [args, error] of cases) { await assert.rejects(op.setSteps(args), error); assert.deepEqual(store.snapshot(), before); }
});

test("steps enforce project ownership and support records without deriving work status", async t => {
  const { store, op } = await board(t);
  const before = store.snapshot();
  await assert.rejects(op.setSteps({ author: "Firn", id: "a", step: { id: "foreign", text: "Change", state: "todo" } }), /belongs to project Whitefoot/);
  assert.deepEqual(store.snapshot(), before);
  await op.createItem({ author, key: "record-with-steps", title: "Merge queue", record: true, group: author, priority: "P1" });
  await op.setSteps({ author, id: "record-with-steps", step: { id: "first", text: "First approved merge", state: "done" } });
  const s = store.snapshot(); assert.equal(s.items["record-with-steps"]!.steps![0]!.doneAt, later);
  assert.equal(s.items["record-with-steps"]!.status, undefined); assert.equal(rules(s).statusOf("record-with-steps"), undefined);
});

test("revision-free step writes retry real conflicts and retain concurrent steps, head and logs", async t => {
  const { store, op } = await board(t), original = store.commit.bind(store);
  let raced = false;
  t.mock.method(store, "commit", async (txn: Txn) => {
    if (!raced) {
      raced = true; const current = store.snapshot().items.a!;
      await original({ author, message: "Concurrent progress", puts: [{ kind: "item", id: "a", expectRev: current.rev,
        doc: { ...current, head: "Concurrent stable head", steps: [{ id: "other", text: "Other work", state: "doing", since: at }], log: [...current.log, { at, by: author, text: "Concurrent detail" }] } }] });
    }
    return original(txn);
  });
  await op.setSteps({ author, id: "a", step: { id: "mine", text: "My work", state: "todo" } });
  assert.ok(raced);
  const it = store.snapshot().items.a!;
  assert.deepEqual(it.steps!.map(step => step.id), ["other", "mine"]);
  assert.equal(it.head, "Concurrent stable head"); assert.equal(it.log.at(-1)!.text, "Concurrent detail");
});


test("moving work into a todo parent with steps preserves its own progress and requires an own-work child", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  await op.setSteps({ author, id: "other", step: { id: "own", text: "Parent own result", state: "todo" } });
  const before = store.snapshot();
  await assert.rejects(op.moveItem({ author, id: "a", parent: "other", parentWhy: "Needs its result" }), /parentOwnWork/);
  assert.deepEqual(store.snapshot(), before);
  await op.moveItem({ author, id: "a", parent: "other", parentWhy: "Needs its result", parentOwnWork: { key: "other-own-steps", title: "Parent own work" } });
  const s = store.snapshot();
  assert.deepEqual(s.items.other!.steps, before.items.other!.steps, "step ownership stays with its original item");
  assert.equal(s.items["other-own-steps"]!.status, "todo");
  assert.equal(s.items.a!.parent, "other");
});
