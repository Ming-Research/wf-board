import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { board, later, author } from "./helpers.ts";
import { rules } from "../src/rules.ts";
import { ownerOps } from "../src/owner-ops.ts";

test("setDraft replaces and clears duplicate choices in one commit with authoritative results", async t => {
  const { store } = await board(t), own = ownerOps(store, () => later);
  const first = await own.createNote({ target: "q:choice", kind: "choice", text: "选 A", choice: "A" });
  const extra = await own.createNote({ target: "q:choice", kind: "choice", text: "duplicate A", choice: "A" });
  const unrelated = await own.createNote({ target: "it:other", kind: "approve", text: "Other draft" });
  const preserved = store.snapshot().notes;
  const changes: Array<Parameters<Parameters<typeof store.onChange>[0]>[0]> = [];
  t.after(store.onChange(change => changes.push(change)));
  const commit = t.mock.method(store, "commit", store.commit.bind(store));
  const result = await own.setDraft({ target: "q:choice", kind: "choice", on: true, text: "选 B", choice: "B" });
  assert.equal(commit.mock.callCount(), 1);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0]!.changed.map(n => [n.id, n.after === null]), [[first.id, false], [extra.id, true]]);
  assert.deepEqual(result, { note: { id: first.id, doc: store.snapshot().notes[first.id] }, deleted: [extra.id], commit: store.snapshot().head });
  assert.equal(result.note!.doc.choice, "B");
  assert.equal(result.note!.doc.rev, preserved[first.id]!.rev + 1);
  for (const id of [unrelated.id, "note-1", "note-2"]) assert.deepEqual(store.snapshot().notes[id], preserved[id]);
  const head = store.snapshot().head;
  assert.deepEqual(await own.setDraft({ target: "q:choice", kind: "choice", on: true, text: "选 B", choice: "B" }), { ...result, deleted: [] });
  assert.equal(store.snapshot().head, head);
  const duplicate = await own.createNote({ target: "q:choice", kind: "choice", text: "duplicate B", choice: "B" });
  const beforeClear = commit.mock.callCount(), beforeEvents = changes.length;
  const cleared = await own.setDraft({ target: "q:choice", kind: "choice", on: false, text: "" });
  assert.equal(commit.mock.callCount(), beforeClear + 1);
  assert.equal(changes.length, beforeEvents + 1);
  assert.deepEqual(cleared, { note: null, deleted: [first.id, duplicate.id], commit: store.snapshot().head });
  assert.equal(store.snapshot().notes[first.id], undefined);
  assert.equal(store.snapshot().notes[duplicate.id], undefined);
  const afterClear = commit.mock.callCount();
  assert.deepEqual(await own.setDraft({ target: "q:choice", kind: "choice", on: false, text: "" }), { note: null, deleted: [], commit: cleared.commit });
  assert.equal(commit.mock.callCount(), afterClear);
});

test("setDraft validates runtime inputs and choices before mutating any draft", async t => {
  const { store } = await board(t), own = ownerOps(store, () => later);
  const first = await own.createNote({ target: "q:choice", kind: "choice", text: "选 A", choice: "A" });
  const before = store.snapshot();
  const invalid = [
    { target: "q:choice", kind: "choice", on: true, text: "选 C", choice: "C" },
    { target: "q:ruled", kind: "choice", on: true, text: "选 A", choice: "A" },
    { target: "it:a", kind: "choice", on: true, text: "选 A", choice: "A" },
    { target: "it:missing", kind: "approve", on: true, text: "yes" },
    { target: "q:choice", kind: "choice", on: "true", text: "选 B", choice: "B" },
    { target: "q:choice", kind: "choice", on: false, text: 0 },
    { target: "it:a", kind: "comment", on: true, text: "hello" },
    { target: "it:a", kind: "approve", on: true, text: "yes", unexpected: true },
  ];
  for (const input of invalid) {
    await assert.rejects(own.setDraft(input as Parameters<typeof own.setDraft>[0]));
    assert.deepEqual(store.snapshot(), before);
  }
  const card = before.decisions.choice!;
  await store.commit({ author, message: "Rule card while draft remains", puts: [{ kind: "decision", id: "choice", expectRev: card.rev, doc: { ...card, status: "ruled", ruling: "A", ruledAt: later } }] });
  assert.deepEqual((await own.setDraft({ target: "q:choice", kind: "choice", on: false, text: "" })).deleted, [first.id]);
});

test("setDraft preserves sent and done answers and follows each control's availability", async t => {
  const { store, op } = await board(t), own = ownerOps(store, () => later);
  for (const kind of ["approve", "done", "choice"] as const) {
    const target = kind === "choice" ? "q:choice" : "it:a";
    const draft = await own.createNote({ target, kind, text: "answer", ...(kind === "choice" ? { choice: "A" } : {}) });
    await own.send();
    const snapshot = store.snapshot();
    await assert.rejects(own.setDraft({ target, kind, on: true, text: "new answer", ...(kind === "choice" ? { choice: "B" } : {}) }), /already sent/);
    assert.deepEqual(store.snapshot(), snapshot);
    await op.replyNote({ author, id: draft.id, reply: "handled" });
    if (kind === "choice") {
      const handled = store.snapshot();
      await assert.rejects(own.setDraft({ target, kind, on: true, text: "new answer", choice: "B" }), /already sent/);
      assert.deepEqual(store.snapshot(), handled);
    } else {
      const replacement = await own.setDraft({ target, kind, on: true, text: "new request answer" });
      assert.equal(replacement.note!.doc.state, "draft");
      assert.equal(store.snapshot().notes[draft.id]!.state, "done");
      await own.setDraft({ target, kind, on: false, text: "" });
    }
  }
  const explain = await own.setDraft({ target: "q:choice", kind: "explain", on: true, text: "Explain again" });
  assert.equal(explain.note!.doc.state, "draft");
  assert.equal(store.snapshot().notes["note-2"]!.state, "done");
});

test("setDraft conflict retries revalidate before atomically replacing and deleting", async t => {
  const { store } = await board(t), own = ownerOps(store, () => later);
  const first = await own.createNote({ target: "q:choice", kind: "choice", text: "选 A", choice: "A" });
  const duplicate = await own.createNote({ target: "q:choice", kind: "choice", text: "another A", choice: "A" });
  const survivor = store.snapshot().notes[first.id]!;
  const commit = store.commit.bind(store);
  let interrupted = false;
  t.mock.method(store, "commit", async (txn: Parameters<typeof store.commit>[0]) => {
    if (!interrupted) {
      interrupted = true;
      const note = store.snapshot().notes[duplicate.id]!;
      await commit({ author: "owner", message: "Concurrent send", puts: [{ kind: "note", id: duplicate.id, expectRev: note.rev, doc: { ...note, state: "sent", sentAt: later } }] });
    }
    return commit(txn);
  });
  const changes: string[] = [];
  t.after(store.onChange(change => changes.push(change.message)));
  await assert.rejects(own.setDraft({ target: "q:choice", kind: "choice", on: true, text: "选 B", choice: "B" }), /already sent/);
  assert.deepEqual(changes, ["Concurrent send"]);
  assert.deepEqual(store.snapshot().notes[first.id], survivor);
  assert.equal(store.snapshot().notes[duplicate.id]!.state, "sent");
  await assert.rejects(own.setDraft({ target: "q:choice", kind: "choice", on: false, text: "" }), /already sent/);
  assert.deepEqual(store.snapshot().notes[first.id], survivor);
});

test("setDraft duplicate cleanup guards an unchanged retained draft against concurrent sending", async t => {
  const { store } = await board(t), own = ownerOps(store, () => later);
  const first = await own.createNote({ target: "q:choice", kind: "choice", text: "选 A", choice: "A" });
  const duplicate = await own.createNote({ target: "q:choice", kind: "choice", text: "another A", choice: "A" });
  const untouched = store.snapshot().notes[duplicate.id];
  const commit = store.commit.bind(store);
  let interrupted = false;
  t.mock.method(store, "commit", async (txn: Parameters<typeof store.commit>[0]) => {
    if (!interrupted) {
      interrupted = true;
      const note = store.snapshot().notes[first.id]!;
      await commit({ author: "owner", message: "Concurrent retained send", puts: [{ kind: "note", id: first.id, expectRev: note.rev, doc: { ...note, state: "sent", sentAt: later } }] });
    }
    return commit(txn);
  });
  await assert.rejects(own.setDraft({ target: "q:choice", kind: "choice", on: true, text: "选 A", choice: "A" }), /already sent/);
  assert.equal(store.snapshot().notes[first.id]!.state, "sent");
  assert.deepEqual(store.snapshot().notes[duplicate.id], untouched);
});

test("draft notes validate targets and choices, delete only drafts, send atomically with target projects", async t => {
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
  assert.deepEqual(sent.sent, [{ id: a.id, target: "it:a", kind: "approve", project: "Whitefoot" }, { id: b.id, target: "q:choice", kind: "choice", project: "Whitefoot" }, { id: c.id, target: "it:other", kind: "explain", project: "Firn" }]);
  assert.equal((await store.log()).length, before + 1);
  for (const { id } of sent.sent) { assert.equal(store.snapshot().notes[id]!.state, "sent"); assert.equal(store.snapshot().notes[id]!.sentAt, later); }
  await assert.rejects(own.deleteNote({ id: a.id }), /Only draft/);
  await op.replyNote({ author, id: a.id, reply: "recorded" });
  await assert.rejects(own.deleteNote({ id: a.id }), /Only draft/);
  const head = store.snapshot().head; assert.deepEqual(await own.send(), { sent: [] }); assert.equal(store.snapshot().head, head);
});

test("send reports the committed target project after a concurrent owner change", async t => {
  const { store } = await board(t), own = ownerOps(store, () => later);
  const note = await own.createNote({ target: "it:a", kind: "comment", text: "Deliver after handover" });
  let signalReached!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { signalReached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const commit = store.commit.bind(store);
  t.mock.method(store, "commit", async (txn: Parameters<typeof store.commit>[0]) => {
    if (txn.message.startsWith("send ")) { signalReached(); await resume; }
    return commit(txn);
  });
  let deliveredTo: string | undefined;
  t.after(store.onChange(change => {
    if (change.message.startsWith("send ")) deliveredTo = rules(store.snapshot()).projectOf("a");
  }));
  const sending = own.send();
  await reached;
  try { const area = store.snapshot().items.area!; await store.commit({ author: "owner", message: "Move area to Firn", puts: [{ kind: "item", id: "area", expectRev: area.rev, doc: { ...area, group: "Firn" } }] }); }
  finally { release(); }
  const result = await sending;
  assert.equal(deliveredTo, "Firn");
  assert.deepEqual(result.sent, [{ id: note.id, target: "it:a", kind: "comment", project: deliveredTo }]);
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
