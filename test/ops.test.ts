import { test } from "node:test";
import assert from "node:assert/strict";
import { ops, OpError } from "../src/ops.ts";
import { rules } from "../src/rules.ts";
import type { Ops, Result } from "../src/ops.ts";
import { Store } from "../src/store.ts";
import type { Txn } from "../src/store.ts";
import { board, at, later, author } from "./helpers.ts";

test("every operation refuses empty author, missing target and whitespace text without changing memory, disk or history", async t => {
  const { store, op, dir } = await board(t);
  const calls: Array<{ name: keyof Ops; args: Record<string, unknown>; text: string; missing?: string }> = [
    { name: "createItem", args: { key: "new", parent: "area", parentWhy: "Child", title: "New", priority: "P2" }, text: "title" },
    { name: "appendLog", args: { id: "a", text: "Progress" }, text: "text", missing: "id" },
    { name: "updateItem", args: { id: "a", rev: 1, title: "Changed" }, text: "title", missing: "id" },
    { name: "setStatus", args: { id: "a", status: "done", log: "Complete" }, text: "log", missing: "id" },
    { name: "moveItem", args: { id: "a", parent: "other", parentWhy: "Transfer" }, text: "parentWhy", missing: "id" },
    { name: "setAsk", args: { id: "a", text: "Approve" }, text: "text", missing: "id" },
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
  const { store, op, dir } = await board(t);
  const create = { author, key: "new", parent: "area", parentWhy: "Child", title: "New", priority: "P1" as const };
  const card = { author, key: "new-card", item: "a", question: "Choose?", background: "Why", options: [{ key: "A", text: "A" }] };
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.createItem({ ...create, key: "../escape" }), /key.*use/],
    [() => op.createItem({ ...create, key: "a" }), /key.*new/],
    [() => op.createItem({ ...create, key: "choice" }), /key.*new/],
    [() => op.createItem({ ...create, priority: undefined }), /priority.*requires/],
    [() => op.createItem({ ...create, parent: undefined }), /agent and group.*requires/],
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
    [() => op.setAsk({ author, id: "a", text: "Ask", url: "invalid" }), /ask.url.*fix/],
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
  const { store, op } = await board(t);
  async function committed(call: () => Promise<Result>, message: string, files: string[]) {
    const before = (await store.log()).length, result = await call(), log = await store.log({ limit: 1 });
    assert.equal((await store.log()).length, before + 1);
    assert.equal(result.commit, log[0]!.commit); assert.equal(log[0]!.author, author); assert.equal(log[0]!.message, message);
    assert.deepEqual(log[0]!.files.slice().sort(), files.sort());
    return result;
  }
  await committed(() => op.createItem({ author, key: "new", parent: "area", parentWhy: "Delivers proof", title: "New", head: "Stable", priority: "P2", links: [], agent: "Child session", short: "N", order: 4, data: "4 cases" }), "create_item new", ["items/new.yaml", "items/area.yaml"]);
  assert.deepEqual(store.snapshot().items.area!.deps.at(-1), { id: "new", why: "Delivers proof" });
  assert.equal(store.snapshot().items.new!.created, later); assert.equal(store.snapshot().items.new!.status, "todo");
  await committed(() => op.appendLog({ author, id: "new", text: "Evidence" }), "append_log new", ["items/new.yaml"]);
  assert.deepEqual(store.snapshot().items.new!.log[0], { at: later, by: author, text: "Evidence" });
  await committed(() => op.updateItem({ author, id: "new", rev: 2, head: "Revised", reason: "Scope settled", title: "Revised title", deps: [{ card: "choice", why: "Needs ruling" }], links: [{ label: "PR", url: "https://github.com/Ming-Research/Whitefoot/pull/1" }], priority: "P0", data: null, agent: null, short: null, order: 2 }), "update_item new", ["items/new.yaml"]);
  const revised = store.snapshot().items.new!;
  assert.equal(revised.head, "Revised"); assert.equal(revised.title, "Revised title"); assert.equal(revised.order, 2); assert.equal(revised.priority, "P0");
  assert.equal(revised.data, undefined); assert.equal(revised.agent, undefined); assert.equal(revised.short, undefined);
  assert.deepEqual(revised.log.at(-1), { at: later, by: author, text: "改了 head：Scope settled" });
  await committed(() => op.setStatus({ author, id: "new", status: "blocked", log: "Waits on choice" }), "set_status new blocked", ["items/new.yaml"]);
  assert.equal(store.snapshot().items.new!.status, "blocked");
  await committed(() => op.setAsk({ author, id: "new", text: "Approve", url: "https://example.com/approve", chat: true }), "set_ask new", ["items/new.yaml"]);
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
  assert.match(store.snapshot().items.new!.log.at(-1)!.text, /area.*other.*New home/);
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
  const { store, op } = await board(t);
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
  const { store, op } = await board(t), second = ops(store, () => later);
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
  const { store, op } = await board(t), original = store.commit.bind(store);
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
  const { store, op } = await board(t);
  await op.createItem({ author, key: "new-area", title: "New area", priority: "P1", status: "wip", group: "Whitefoot", agent: author });
  assert.equal(store.snapshot().items["new-area"]!.created, later); assert.equal(store.snapshot().items["new-area"]!.updated, later);
  assert.equal(store.snapshot().items["new-area"]!.group, "Whitefoot"); assert.equal(store.snapshot().items["new-area"]!.agent, author);
  await op.moveItem({ author, id: "a", parent: "area", parentWhy: "Updated relationship" });
  assert.deepEqual(store.snapshot().items.area!.deps.filter(d => "id" in d && d.id === "a"), [{ id: "a", why: "Updated relationship" }]);
  assert.ok(store.snapshot().items.area!.deps.some(d => "id" in d && d.id === "b"));
});

test("asks and open cards allow blocked status; wip remains allowed; closed deps do not block", async t => {
  const { store, op } = await board(t);
  await op.setStatus({ author, id: "b", status: "wip", log: "Working alongside dependencies" });
  await op.setAsk({ author, id: "other", text: "Owner approves" });
  await op.setStatus({ author, id: "other", status: "blocked", log: "Waits on owner" });
  await assert.rejects(op.createItem({ author, key: "blocked-split", parent: "other", parentWhy: "Work", title: "Split", priority: "P2", parentOwnWork: { key: "blocked-own", title: "Own" } }), /blocked-own.*卡住了，但没写在等什么/);
  await op.setStatus({ author, id: "other", status: "todo", log: "Schedule own work before splitting" });
  await op.createItem({ author, key: "card-waiter", parent: "other", parentWhy: "Ruling", title: "Waiter", priority: "P2", deps: [{ card: "choice", why: "Ruling" }], parentOwnWork: { key: "other-own", title: "other own work" } });
  await op.setStatus({ author, id: "card-waiter", status: "blocked", log: "Waits on card" });
  await op.ruleCard({ author, key: "choice", ruling: "Settled without an option" });
  const before = store.snapshot();
  await assert.rejects(op.setStatus({ author, id: "card-waiter", status: "blocked", log: "Stale blocker" }), /open dependency or an ask/);
  assert.deepEqual(store.snapshot(), before);
});

test("a leaf's first sub-item moves its own work, status and priority into a sub-item in the same commit", async t => {
  const { store, op } = await board(t);
  const blockedSplit = { author, key: "kid", parent: "b", parentWhy: "Evidence", title: "Kid", priority: "P2" as const, parentOwnWork: { key: "b-own", title: "Own" } };
  await assert.rejects(op.createItem(blockedSplit), /b-own.*卡住了，但没写在等什么/);
  await op.setStatus({ author, id: "b", status: "wip", log: "Working alongside dependencies" });
  const before = store.snapshot().items.b!; // WIP P0 leaf
  const head = store.snapshot().head;
  await assert.rejects(op.createItem({ author, key: "kid", parent: "b", parentWhy: "Evidence", title: "Kid", priority: "P2" }), /parentOwnWork: b is a leaf \(wip P0\)/);
  assert.equal(store.snapshot().head, head);
  const result = await op.createItem({ author, key: "kid", parent: "b", parentWhy: "Evidence", title: "Kid", priority: "P2", parentOwnWork: { key: "b-own", title: "b 自己的工作" } });
  const s = store.snapshot(), b = s.items.b!, own = s.items["b-own"]!;
  assert.equal(b.status, undefined); assert.equal(b.priority, undefined);
  assert.equal(own.status, before.status); assert.equal(own.priority, before.priority); assert.equal(own.parent, "b");
  assert.deepEqual(b.deps.slice(-2), [{ id: "kid", why: "Evidence" }, { id: "b-own", why: "它自己的工作" }]);
  assert.equal(rules(s).statusOf("b"), "wip"); // derived from b-own, as before the split
  assert.equal((await store.log({ limit: 1 }))[0]!.commit, result.commit);
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files.sort(), ["items/b-own.yaml", "items/b.yaml", "items/kid.yaml"]);
  await assert.rejects(op.createItem({ author, key: "kid2", parent: "b", parentWhy: "More", title: "Kid 2", priority: "P2", parentOwnWork: { key: "b-own2", title: "x" } }), /already has sub-items/);
});


test("R2 moves require and atomically preserve both leaf transitions", async t => {
  const { store, op, dir } = await board(t);
  await op.setStatus({ author, id: "other", status: "wip", log: "Own work" });
  const move = { author, id: "a", parent: "other", parentWhy: "Transfer" };
  const before = store.snapshot();
  await assert.rejects(op.moveItem(move), /parentOwnWork/);
  assert.deepEqual(store.snapshot(), before);
  await op.moveItem({ ...move, parentOwnWork: { key: "own", title: "Original work" } });
  let s = store.snapshot();
  assert.equal(s.items.own!.status, "wip"); assert.equal(s.items.own!.priority, "P1");
  assert.equal(s.items.other!.status, undefined); assert.equal(s.items.other!.priority, undefined);
  assert.equal(rules(s).statusOf("other"), "wip");
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files.sort(), ["items/a.yaml", "items/area.yaml", "items/other.yaml", "items/own.yaml"]);
  const last = { author, id: "b", parent: "other", parentWhy: "Last child" };
  await assert.rejects(op.moveItem(last), /sourceStatus.*sourcePriority/);
  await assert.rejects(op.moveItem({ ...last, sourceStatus: "todo" }), /sourcePriority/);
  await op.moveItem({ ...last, sourceStatus: "done", sourcePriority: "P2" });
  s = store.snapshot();
  assert.equal(s.items.area!.status, "done"); assert.equal(s.items.area!.priority, "P2");
  assert.match(s.items.area!.log.at(-1)!.text, /done.*P2/);
  assert.deepEqual((await Store.open(dir)).snapshot(), s);
});

test("R4 concurrent replies refuse replacement unless explicitly requested", async t => {
  const { store, op } = await board(t);
  const results = await Promise.allSettled([
    op.replyNote({ author: "First", id: "note-1", reply: "First answer" }),
    ops(store, () => later).replyNote({ author: "Second", id: "note-1", reply: "Second answer" }),
  ]);
  assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected"]);
  assert.match(String((results[1] as PromiseRejectedResult).reason), /First.*2026-10-11T02:03:04Z/);
  assert.equal(store.snapshot().notes["note-1"]!.reply, "First answer");
  await op.replyNote({ author: "Second", id: "note-1", reply: "Correction", replace: true });
  assert.equal(store.snapshot().notes["note-1"]!.reply, "Correction");
  assert.equal((await store.log({ kind: "note", id: "note-1" })).length, 3);
});

test("R7 prospective validation rejects newly introduced checks on affected items", async t => {
  const { store, op } = await board(t);
  const before = store.snapshot();
  await assert.rejects(op.createItem({ author, key: "stuck", title: "Stuck", parent: "area", parentWhy: "Work", priority: "P2", status: "blocked" }), /stuck.*卡住了，但没写在等什么/);
  await assert.rejects(op.updateItem({ author, id: "area", rev: 1, deps: [{ id: "b", why: "Keep b" }] }), /a.*上级没有把它列在依赖里/);
  assert.deepEqual(store.snapshot(), before);
  await op.setAsk({ author, id: "other", text: "Approve" });
  await op.setStatus({ author, id: "other", status: "blocked", log: "Wait" });
  const blocked = store.snapshot();
  await assert.rejects(op.clearAsk({ author, id: "other", log: "Remove" }), /other.*卡住了，但没写在等什么/);
  assert.deepEqual(store.snapshot(), blocked);
  // Existing imported warnings must not prevent unrelated progress.
  await store.commit({ author, message: "Imported warning", puts: [{ kind: "item", id: "legacy", expectRev: null, doc: { title: "Legacy", status: "blocked", priority: "P2", updated: at } }] });
  await op.appendLog({ author, id: "legacy", text: "Still investigating" });
});


test("R7 missing targets and reasons quote checks and the affected item; cards also validate their item", async t => {
  const { store, op } = await board(t);
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
