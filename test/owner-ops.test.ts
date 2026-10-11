import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { board, later, author } from "./helpers.ts";
import { rules } from "../src/rules.ts";
import { ownerOps } from "../src/owner-ops.ts";

test("draft notes validate targets and choices, delete only drafts, send atomically with inherited agents", async t => {
  const { store, op } = await board(t), own = ownerOps(store, () => later);
  const one = await own.createNote({ target: "it:a", kind: "comment", text: "hello", anchor: { kind: "note", id: "note-1" } });
  assert.match(one.id, /^[a-z0-9]{20}$/); assert.equal(store.snapshot().notes[one.id]!.state, "draft");
  assert.equal((await store.log())[0]!.author, "owner");
  await own.deleteNote({ id: one.id }); assert.equal(store.snapshot().notes[one.id], undefined);
  await assert.rejects(own.createNote({ target: "it:missing", kind: "comment", text: "hello" }), /Unknown target/);
  await assert.rejects(own.createNote({ target: "q:choice", kind: "choice", text: "", choice: "wrong" }), /option/);
  await assert.rejects(own.createNote({ target: "it:a", kind: "comment", text: " " }), /needs text/);
  const a = await own.createNote({ target: "it:a", kind: "approve", text: "同意：批准中文检查" });
  const b = await own.createNote({ target: "q:choice", kind: "choice", choice: "A", text: "选 A" });
  const c = await own.createNote({ target: "it:other", kind: "explain", text: "explain" });
  const before = (await store.log()).length;
  const sent = await own.send();
  assert.deepEqual(sent.sent, [{ id: a.id, target: "it:a", kind: "approve", agents: [author] }, { id: b.id, target: "q:choice", kind: "choice", agents: [author] }, { id: c.id, target: "it:other", kind: "explain", agents: ["Other session"] }]);
  assert.equal((await store.log()).length, before + 1);
  for (const { id } of sent.sent) { assert.equal(store.snapshot().notes[id]!.state, "sent"); assert.equal(store.snapshot().notes[id]!.sentAt, later); }
  await assert.rejects(own.deleteNote({ id: a.id }), /Only draft/);
  await op.replyNote({ author, id: a.id, reply: "recorded" });
  await assert.rejects(own.deleteNote({ id: a.id }), /Only draft/);
  const head = store.snapshot().head; assert.deepEqual(await own.send(), { sent: [] }); assert.equal(store.snapshot().head, head);
});

test("send reports the agents responsible when a concurrent replacement claim commits first", async t => {
  const { store, op } = await board(t), own = ownerOps(store, () => later);
  const note = await own.createNote({ target: "it:a", kind: "comment", text: "Deliver after handover" });
  let signalReached!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { signalReached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const commit = store.commit.bind(store);
  t.mock.method(store, "commit", async (txn: Parameters<typeof store.commit>[0]) => {
    if (txn.message.startsWith("send ")) { signalReached(); await resume; }
    return commit(txn);
  });
  let deliveredTo: string[] | undefined;
  t.after(store.onChange(change => {
    if (change.message.startsWith("send ")) deliveredTo = rules(store.snapshot()).agentsFor("a");
  }));
  const sending = own.send();
  await reached;
  try { await op.claimProject({ author: "Replacement", project: "Whitefoot", replace: [author], reason: "Session departed" }); }
  finally { release(); }
  const result = await sending;
  assert.deepEqual(deliveredTo, ["Replacement"]);
  assert.deepEqual(result.sent, [{ id: note.id, target: "it:a", kind: "comment", agents: deliveredTo }]);
});

test("read advances monotonically; unknown, off-history and merged sibling commits are refused", async t => {
  const { store, op, dir } = await board(t), own = ownerOps(store), seed = store.snapshot().head;
  const a = await op.appendLog({ author, id: "a", text: "first" });
  const b = await op.appendLog({ author, id: "a", text: "second" });
  await own.read({ through: a.commit }); await own.read({ through: b.commit });
  await assert.rejects(own.read({ through: a.commit }), /advance/);
  await assert.rejects(own.read({ through: "f".repeat(40) }), /history/);
  const git = promisify(execFile);
  const tree = (await git("git", ["rev-parse", `${seed}^{tree}`], { cwd: dir })).stdout.trim();
  const env = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const sibling = (await git("git", ["commit-tree", tree, "-p", seed, "-m", "sibling"], { cwd: dir, env })).stdout.trim();
  await assert.rejects(own.read({ through: sibling }), /history/);
  const headTree = (await git("git", ["rev-parse", `${b.commit}^{tree}`], { cwd: dir })).stdout.trim();
  const merged = (await git("git", ["commit-tree", headTree, "-p", b.commit, "-p", sibling, "-m", "merge witness"], { cwd: dir, env })).stdout.trim();
  await git("git", ["update-ref", "HEAD", merged], { cwd: dir });
  await assert.rejects(own.read({ through: sibling }), /advance/);
  await own.read({ through: merged }); assert.equal(store.snapshot().owner.cursor, merged);
});

test("archive and cursor create no commits and ride with the next data write", async t => {
  const { store, op } = await board(t), own = ownerOps(store, () => later), head = store.snapshot().head;
  own.archive({ id: "a", on: true }); await own.read({ through: head });
  assert.equal(store.snapshot().head, head); assert.equal(store.snapshot().owner.archived.a, later);
  let ownerChange: unknown;
  const off = store.onChange(c => { ownerChange = c.changed.find(d => d.kind === "owner")?.after; }); t.after(off);
  await op.appendLog({ author, id: "b", text: "rides with this commit" });
  assert.deepEqual(ownerChange, { archived: { a: later }, cursor: head });
  own.archive({ id: "a", on: false }); assert.equal(store.snapshot().owner.archived.a, undefined);
  await assert.rejects(async () => own.archive({ id: "missing", on: true }), /Unknown item/);
});

// Migration permits clocks ahead of the daemon; archiving still covers what was shown.
test("archive includes future item, log and reply timestamps", async t => {
  const {store} = await board(t), own = ownerOps(store, () => later);
  const item = store.snapshot().items.a!;
  await store.commit({author, message:"future clock witness", puts:[{kind:"item",id:"a",expectRev:item.rev,doc:{...item,updated:"2030-01-01T00:00:00Z",log:[...item.log,{at:"2030-02-01T00:00:00Z",text:"future log"}]}}]});
  const note = store.snapshot().notes["note-1"]!;
  await store.commit({author,message:"future reply witness",puts:[{kind:"note",id:"note-1",expectRev:note.rev,doc:{...note,state:"done",reply:"future reply",repliedAt:"2030-03-01T00:00:00Z"}}]});
  own.archive({id:"a",on:true});
  assert.equal(store.snapshot().owner.archived.a,"2030-03-01T00:00:00Z");
  assert.equal(rules(store.snapshot()).isArchived("a"),true);
});
