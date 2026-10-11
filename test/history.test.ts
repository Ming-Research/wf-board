import { test } from "node:test";
import assert from "node:assert/strict";
import { board, author, later } from "./helpers.ts";
import { unreadSteps, stepDiff, piecesOf } from "../src/history.ts";
import { ownerOps } from "../src/owner-ops.ts";

test("cursor range, single-document grouping, author boundaries and endpoint diff", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  const a = await op.appendLog({ author, id: "a", text: "first new entry" });
  const b = await op.appendLog({ author, id: "a", text: "second new entry" });
  const c = await op.appendLog({ author, id: "b", text: "different document" });
  const own = ownerOps(store);
  await own.createNote({ target: "it:a", kind: "comment", text: "owner action" });
  const d = await op.appendLog({ author, id: "b", text: "after owner" });
  // Store history also retains authors from before project identity replaced sessions.
  const previous = store.snapshot().items.b!;
  const e = await store.commit({ author: "other", message: "Historical session append", puts: [{ kind: "item", id: "b", expectRev: previous.rev, doc: { ...previous, updated: later, log: [...previous.log, { by: "other", at: later, text: "other author" }] } }] });
  const steps = await unreadSteps(store, cursor);
  assert.deepEqual(steps.map(s => s.commits), [[a.commit, b.commit], [c.commit], [d.commit], [e.commit]]);
  assert.equal(steps[0]!.id, b.commit); assert.equal(steps[0]!.docs[0]!.summary, "+2 log");
  assert.equal(steps[0]!.author, author); assert.ok(Number.isFinite(Date.parse(steps[0]!.at)));
  const diff = await stepDiff(store, steps[0]!, "item", "a");
  assert.deepEqual(diff.before, await store.show("item", "a", cursor));
  assert.deepEqual(diff.after, await store.show("item", "a", b.commit));
  assert.match(diff.diff, /\+.*first new entry/); assert.match(diff.diff, /\+.*second new entry/);
  assert.ok(!(await unreadSteps(store, e.commit)).length);
  assert.ok((await unreadSteps(store, undefined)).length > steps.length);
  assert.ok((await unreadSteps(store, undefined)).every(s => s.author !== "owner"));
  await assert.rejects(stepDiff(store, steps[0]!, "note", "missing"), /not in this step/);
});

test("multi-document writes are separate steps and deletion keeps its before document", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  await op.createItem({ author, key: "child", parent: "a", parentWhy: "needs child", title: "new child", priority: "P1", parentOwnWork: { key: "a-own", title: "a own work" } });
  await op.appendLog({ author, id: "a", text: "following write" });
  const note = store.snapshot().notes["note-1"]!;
  const deleted = await store.commit({ author, message: "delete synthetic note", deletes: [{ kind: "note", id: "note-1", expectRev: note.rev }] });
  const steps = await unreadSteps(store, cursor);
  assert.equal(steps.length, 3); assert.equal(steps[0]!.docs.length, 3); // child, own-work sub-item, parent
  const diff = await stepDiff(store, steps.find(s => s.id === deleted.commit)!, "note", "note-1");
  assert.deepEqual(diff.before, note); assert.equal(diff.after, null); assert.match(diff.diff, /-text: .*中文意见/);
});

test("commits that change no item, card or note are not steps", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  const a = await op.appendLog({ author, id: "a", text: "before settings" });
  await store.commit({ author, message: "retitle board", board: { ...store.snapshot().board, title: "Renamed board" } });
  store.setOwner({ archived: { other: later } });
  await store.flushOwner(author);
  const b = await op.appendLog({ author, id: "a", text: "after settings" });
  const steps = await unreadSteps(store, cursor);
  assert.deepEqual(steps.map(s => s.commits), [[a.commit], [b.commit]]);
});

test("unread steps are reused until HEAD or the cursor moves", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  await op.appendLog({ author, id: "a", text: "one" });
  const first = unreadSteps(store, cursor);
  assert.equal(unreadSteps(store, cursor), first, "same HEAD and cursor reuse the computation");
  await first;
  await op.appendLog({ author, id: "b", text: "two" });
  const moved = await unreadSteps(store, cursor);
  assert.equal(moved.length, (await first).length + 1, "a new commit is seen");
  assert.notEqual(unreadSteps(store, undefined), unreadSteps(store, cursor));
  assert.equal(moved[0]!.parent, cursor, "a step's before state is the commit preceding it");
});

test("a new commit reads only the documents of the step it creates or extends", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  await op.appendLog({ author, id: "a", text: "one" });
  await op.appendLog({ author, id: "b", text: "two" });
  await unreadSteps(store, cursor);
  const shown: string[] = [];
  const show = store.show.bind(store);
  t.mock.method(store, "show", (kind: Parameters<typeof store.show>[0], id: string, at: string) => { shown.push(kind + ":" + id); return show(kind, id, at); });
  await op.appendLog({ author, id: "a", text: "three" });
  const steps = await unreadSteps(store, cursor);
  assert.equal(steps.length, 3);
  assert.deepEqual([...new Set(shown)], ["item:a"], "earlier steps come from the cache: " + shown.join(" "));
  assert.equal(steps[0]!.docs[0]!.pieces.log, 1, "cached steps keep their counts");
});

test("a status that became derived and changes the owner cannot see are not unread", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  await op.createItem({ author, key: "kid", parent: "a", parentWhy: "split", title: "kid", priority: "P1", parentOwnWork: { key: "a-own", title: "a own" } });
  const { rev, ...doc } = store.snapshot().items.other!;
  await store.commit({ author, message: "touch time only", puts: [{ kind: "item", id: "other", doc: { ...doc, updated: "2026-10-11T09:09:09Z" }, expectRev: rev }] });
  const steps = await unreadSteps(store, cursor);
  assert.equal(steps.length, 1, "the time-only commit is not a step");
  const parent = steps[0]!.docs.find(d => d.id === "a")!;
  assert.doesNotMatch(parent.summary, /status|priority/);
  assert.match(parent.summary, /\+1 log/);
});

test("pieces count each new log entry, each new reply and one other change, as the old page counted", () => {
  const item = (log: Array<{ at: string; text: string }>, head = "h") => ({ title: "t", head, log, updated: later, deps: [], links: [], rev: 1 });
  const e = (n: number) => ({ at: `2026-10-11T0${n}:00:00Z`, text: `entry ${n}` });
  assert.deepEqual(piecesOf(null, item([e(1), e(2), e(3)]), "item", "new item"), { log: 3, reply: 0, other: 0 }, "a new item counts through its entries");
  assert.deepEqual(piecesOf(null, item([]), "item", "new item"), { log: 0, reply: 0, other: 1 });
  assert.deepEqual(piecesOf(item([e(1)]), item([e(1), e(2), e(3)], "changed"), "item", "head changed, +2 log"), { log: 2, reply: 0, other: 1 });
  assert.deepEqual(piecesOf(item([e(1)]), item([e(1)]), "item", "metadata changed"), { log: 0, reply: 0, other: 0 });
  assert.deepEqual(piecesOf({}, {}, "note", "state changed, new reply"), { log: 0, reply: 1, other: 0 });
  assert.deepEqual(piecesOf({}, {}, "note", "state changed"), { log: 0, reply: 0, other: 0 });
  assert.deepEqual(piecesOf(null, {}, "decision", "new card"), { log: 0, reply: 0, other: 1 });
  assert.deepEqual(piecesOf(item([e(1), e(2)]), item([e(1)]), "item", "log changed"), { log: 0, reply: 0, other: 1 }, "a removed entry is a change");
  assert.deepEqual(piecesOf(item([{ ...e(1), by: "A" } as never]), item([{ ...e(1), by: "B" } as never]), "item", "log changed").other, 1, "an entry's author rewritten in place is a change");
  assert.deepEqual(piecesOf({}, {}, "note", "text changed"), { log: 0, reply: 0, other: 1 }, "an edited note is a change");
  assert.deepEqual(piecesOf({}, {}, "note", "reply cleared, state changed"), { log: 0, reply: 0, other: 1 }, "a cleared reply is a change");
});


test("document read marks exclude only marked documents and disappear from stop counts", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  const first = await op.appendLog({ author, id: "a", text: "earlier unread item" });
  const second = await op.appendLog({ author, id: "b", text: "selected later item" });
  const unmarked = await unreadSteps(store, cursor);
  const marked = await unreadSteps(store, cursor, { "item:b": second.commit });
  assert.deepEqual(marked.map(s => s.id), [first.commit], "the later document is read without reading the earlier item");
  assert.equal(unmarked.length, 2, "read marks do not mutate the cached unmarked steps");
  const multi = await op.createItem({ author, key: "kid", parent: "a", parentWhy: "split", title: "kid", priority: "P1", parentOwnWork: { key: "a-own", title: "a own" } });
  const partial = await unreadSteps(store, cursor, { "item:a": multi.commit });
  assert.deepEqual(partial.find(s => s.id === multi.commit)!.docs.map(d => d.id).sort(), ["a-own", "kid"], "other documents in a shared commit remain unread");
});

test("a marked document's later same-author change starts a fresh baseline", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  const first = await op.appendLog({ author, id: "a", text: "already read" });
  const second = await op.appendLog({ author, id: "a", text: "new after the mark" });
  const steps = await unreadSteps(store, cursor, { "item:a": first.commit });
  assert.deepEqual(steps[0]!.commits, [second.commit], "a mark splits consecutive changes at the read boundary");
  assert.equal(steps[0]!.parent, first.commit);
  assert.equal(steps[0]!.docs[0]!.pieces.log, 1, "the read log entry does not return in the count");
  assert.equal(steps[0]!.docs[0]!.summary, "+1 log");
});

test("unread history scans stay constant as valid document marks accumulate", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  const marks: Record<string, string> = {};
  for (const id of ["a", "b", "area"]) marks[`item:${id}`] = (await op.appendLog({ author, id, text: `read ${id}` })).commit;
  const latest = await op.appendLog({ author, id: "a", text: "unread after marks" });
  const log = store.log.bind(store);
  let scans = 0;
  t.mock.method(store, "log", async (options: Parameters<typeof store.log>[0]) => { scans++; return log(options); });
  await unreadSteps(store, cursor, { "item:a": marks["item:a"]! });
  const oneMarkScans = scans; scans = 0;
  const steps = await unreadSteps(store, cursor, marks);
  assert.deepEqual(steps.map(step => step.id), [latest.commit]);
  assert.equal(scans, oneMarkScans, "adding valid marks must not add history scans");
  assert.equal(scans, 1, "one bounded commit range supplies every mark comparison");
});
