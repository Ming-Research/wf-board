import { test } from "node:test";
import assert from "node:assert/strict";
import { board, author } from "./helpers.ts";
import { unreadSteps, stepDiff } from "../src/history.ts";
import { ownerOps } from "../src/owner-ops.ts";

test("cursor range, single-document grouping, author boundaries and endpoint diff", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  const a = await op.appendLog({ author, id: "a", text: "first new entry" });
  const b = await op.appendLog({ author, id: "a", text: "second new entry" });
  const c = await op.appendLog({ author, id: "b", text: "different document" });
  const own = ownerOps(store);
  await own.createNote({ target: "it:a", kind: "comment", text: "owner action" });
  const d = await op.appendLog({ author, id: "b", text: "after owner" });
  const e = await op.appendLog({ author: "other", id: "b", text: "other author" });
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
