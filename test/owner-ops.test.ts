import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { board, later, author } from "./helpers.ts";
import { rules } from "../src/rules.ts";
import { brief, context } from "../src/query.ts";
import { formatContext } from "../src/mcp.ts";
import { unreadSteps } from "../src/history.ts";
import { OwnerState } from "../src/model.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { Store } from "../src/store.ts";

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
  await store.commit({ author, message: "Rule card while draft remains", puts: [{ kind: "decision", id: "choice", expectRev: card.rev, doc: { ...card, status: "ruled", choice: "A", ruledAt: later } }] });
  assert.deepEqual((await own.setDraft({ target: "q:choice", kind: "choice", on: false, text: "" })).deleted, [first.id]);
});

test("setDraft preserves sent and done answers and follows each control's availability", async t => {
  const { store, op } = await board(t), own = ownerOps(store, () => later);
  for (const kind of ["approve", "done", "choice"] as const) {
    const target = kind === "choice" ? "q:choice" : "it:a";
    const draft = await own.createNote({ target, kind, text: "answer", ...(kind === "choice" ? { choice: "A" } : {}) });
    await own.send();
    const snapshot = store.snapshot();
    // A sent pick closes its card, so a second pick is refused for the card; the other answers are refused as sent.
    await assert.rejects(own.setDraft({ target, kind, on: true, text: "new answer", ...(kind === "choice" ? { choice: "B" } : {}) }), kind === "choice" ? /open decision card/ : /already sent/);
    assert.deepEqual(store.snapshot(), snapshot);
    await op.replyNote({ author, id: draft.id, reply: "handled" });
    if (kind === "choice") {
      const handled = store.snapshot();
      await assert.rejects(own.setDraft({ target, kind, on: true, text: "new answer", choice: "B" }), /open decision card/);
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
  // The plain pick rules its card in this commit and is handled by that; the others wait for a reply.
  for (const { id } of sent.sent) { assert.equal(store.snapshot().notes[id]!.state, id === b.id ? "done" : "sent"); assert.equal(store.snapshot().notes[id]!.sentAt, later); }
  await assert.rejects(own.deleteNote({ id: a.id }), /Only draft/);
  await op.replyNote({ author, id: a.id, reply: "recorded" });
  await assert.rejects(own.deleteNote({ id: a.id }), /Only draft/);
  const head = store.snapshot().head; assert.deepEqual(await own.send(), { sent: [] }); assert.equal(store.snapshot().head, head);
});

test("send with ids sends only those drafts and refuses unknown or non-draft ids without sending anything", async t => {
  const { store } = await board(t), own = ownerOps(store, () => later);
  const a = await own.createNote({ target: "it:a", kind: "comment", text: "first" });
  const b = await own.createNote({ target: "q:choice", kind: "choice", choice: "A", text: "选 A" });
  const c = await own.createNote({ target: "it:other", kind: "comment", text: "third" });
  const seen: string[] = [];
  t.after(store.onChange(change => { if (change.message.startsWith("send ")) seen.push(change.message); }));
  const sent = await own.send({ ids: [c.id, a.id] });
  assert.deepEqual(sent.sent, [{ id: a.id, target: "it:a", kind: "comment", project: "Whitefoot" }, { id: c.id, target: "it:other", kind: "comment", project: "Firn" }]);
  assert.deepEqual(seen, ["send 2 notes"]);
  for (const id of [a.id, c.id]) { assert.equal(store.snapshot().notes[id]!.state, "sent"); assert.equal(store.snapshot().notes[id]!.sentAt, later); }
  assert.equal(store.snapshot().notes[b.id]!.state, "draft"); assert.equal(store.snapshot().notes[b.id]!.sentAt, undefined);
  const head = store.snapshot().head;
  await assert.rejects(own.send({ ids: [b.id, a.id] }), /Only draft notes can be sent: /);
  await assert.rejects(own.send({ ids: [b.id, "missing"] }), /Unknown note missing/);
  await assert.rejects(own.send({ ids: "x" as unknown as string[] }), /list of note ids/);
  assert.equal(store.snapshot().head, head); assert.equal(store.snapshot().notes[b.id]!.state, "draft");
  assert.deepEqual(await own.send({ ids: [] }), { sent: [] }); assert.equal(store.snapshot().head, head);
  assert.deepEqual((await own.send({})).sent.map(n => n.id), [b.id]);
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
  try { const item = store.snapshot().items.a!; await store.commit({ author: "owner", message: "Change project to Firn", puts: [{ kind: "item", id: "a", expectRev: item.rev, doc: { ...item, group: "Firn" } }] }); }
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
  // Publish the externally constructed fixture history before reading it.
  const reopened = await Store.open(dir), mergedOwner = ownerOps(reopened);
  await assert.rejects(mergedOwner.read({ through: sibling }), /advance/);
  await mergedOwner.read({ through: merged }); assert.equal(reopened.snapshot().owner.cursor, merged);
});

test("cursor reads create no commits and ride with the next data write", async t => {
  const { store, op } = await board(t), own = ownerOps(store, () => later);
  const head = store.snapshot().head;
  await own.read({ through: head });
  assert.equal(store.snapshot().head, head);
  let ownerChange: unknown;
  const off = store.onChange(c => { ownerChange = c.changed.find(d => d.kind === "owner")?.after; }); t.after(off);
  await op.appendLog({ author, id: "b", text: "rides with this commit" });
  assert.deepEqual(ownerChange, { cursor: head });
});

test("document reads persist with the next data write and compact the completed prefix", async t => {
  const { store, op } = await board(t), own = ownerOps(store), cursor = store.snapshot().head;
  await own.read({ through: cursor });
  const a = await op.setPlan({ author, id: "a", row: { id: "progress", state: "todo", text: "first unread" } });
  const b = await op.setPlan({ author, id: "b", row: { id: "progress", state: "todo", text: "later selected" } });
  await own.read({ doc: "item:b" });
  assert.equal(store.snapshot().owner.readMarks?.["item:b"], b.commit);
  assert.equal(store.snapshot().owner.cursor, cursor, "the earlier unread item blocks compaction");
  assert.equal(store.snapshot().head, b.commit, "a read creates no data commit");
  let saved: unknown;
  t.after(store.onChange(change => { saved = change.changed.find(d => d.kind === "owner")?.after; }));
  const next = await op.setPlan({ author, id: "a", row: { id: "progress", state: "todo", text: "next write saves the marks" } });
  assert.deepEqual((saved as {readMarks?: unknown})?.readMarks, { "item:b": b.commit });
  await own.read({ doc: "item:a", through: a.commit });
  assert.equal(store.snapshot().owner.cursor, b.commit, "reading the prefix advances across the later marked item");
  assert.equal(store.snapshot().owner.readMarks, undefined, "marks covered by the cursor are removed");
  assert.deepEqual((await unreadSteps(store, store.snapshot().owner.cursor, store.snapshot().owner.readMarks)).map(s => s.id), [next.commit], "the later unseen update remains unread");
});

test("a read mark of a document nobody wrote is refused without a walk of the history, and a deleted document can still be marked", async t => {
  const { store } = await board(t), own = ownerOps(store);
  const spawned = t.mock.method(store as unknown as { git(args: string[]): Promise<string> }, "git");
  await assert.rejects(own.read({ doc: "item:missing" }), /Unknown read document item:missing/);
  await assert.rejects(own.read({ doc: "note:missing" }), /Unknown read document note:missing/);
  assert.equal(spawned.mock.calls.length, 0, "the list of commits decides it, and git is not asked");
  await store.commit({ author, message: "Delete", deletes: [{ kind: "item", id: "other", expectRev: store.snapshot().items.other!.rev }] });
  await own.read({ doc: "item:other" });
});

test("cursor reads prune marks while invalid and backward document marks are refused", async t => {
  const { store, op } = await board(t), own = ownerOps(store), cursor = store.snapshot().head;
  await own.read({ through: cursor });
  const a = await op.setPlan({ author, id: "a", row: { id: "progress", state: "todo", text: "earlier" } });
  const b = await op.setPlan({ author, id: "b", row: { id: "progress", state: "todo", text: "later" } });
  await own.read({ doc: "item:b", through: b.commit });
  const state = store.snapshot().owner;
  assert.equal(state.readMarks?.["item:b"], b.commit, "the document mark is recorded independently of the cursor");
  for (const input of [{}, {doc: 5}, {doc: "item:b", through: 9}, {doc: "it:b"}, {doc: "item:../b"}, {doc: "item:missing"}, {doc: "item:b", through: "f".repeat(40)}, {doc: "item:b", through: b.commit.slice(0, 8)}, {doc: "item:b", extra: true}, {doc: "item:b", through: a.commit}]) {
    await assert.rejects(own.read(input as Parameters<typeof own.read>[0]), /document|history|commit|advance|Unrecognized/i);
    assert.deepEqual(store.snapshot().owner, state, "rejected input leaves read state intact");
  }
  assert.equal(OwnerState.safeParse({readMarks: {"it:b": b.commit}}).success, false);
  assert.equal(OwnerState.safeParse({readMarks: {"item:b": "short"}}).success, false);
  await own.read({ through: b.commit });
  assert.equal(store.snapshot().owner.readMarks, undefined);
});

test("document reads can name a deleted historical document", async t => {
  const { store, op } = await board(t), own = ownerOps(store), cursor = store.snapshot().head;
  await own.read({ through: cursor });
  await op.setPlan({ author, id: "a", row: { id: "progress", state: "todo", text: "earlier stays unread" } });
  const note = store.snapshot().notes["note-1"]!;
  const deleted = await store.commit({ author, message: "delete historic note", deletes: [{kind: "note", id: "note-1", expectRev: note.rev}] });
  await own.read({ doc: "note:note-1" });
  assert.equal(store.snapshot().owner.readMarks?.["note:note-1"], deleted.commit);
});


test("read compaction never advances over a data change committed during its history reads", async t => {
  const { store, op } = await board(t), own = ownerOps(store), cursor = store.snapshot().head;
  await own.read({ through: cursor });
  const shown = await op.setPlan({ author, id: "b", row: { id: "progress", state: "todo", text: "displayed document" } });
  const log = store.log.bind(store);
  let historyReads = 0, unseen: string | undefined;
  t.mock.method(store, "log", async (options: Parameters<typeof store.log>[0] = {}) => {
    // Another session writes while the read is reading history for the first time.
    if (++historyReads === 1) {
      unseen = (await op.setPlan({ author, id: "a", row: { id: "progress", state: "todo", text: "arrived during compaction" } })).commit;
    }
    return log(options);
  });
  await own.read({ doc: "item:b", through: shown.commit });
  assert.ok(unseen, "the data write interleaves while the read is reading history");
  assert.equal(store.snapshot().owner.cursor, shown.commit, "compaction stops before the unseen data write");
  const steps = await unreadSteps(store, store.snapshot().owner.cursor, store.snapshot().owner.readMarks);
  assert.deepEqual(steps.map(step => step.id), [unseen]);
  assert.equal(steps[0]!.docs[0]!.id, "a");
});

test("read compaction excludes a git commit whose snapshot is not published yet", async t => {
  const { store, op } = await board(t), own = ownerOps(store), cursor = store.snapshot().head;
  await own.read({ through: cursor });
  const shown = await op.setPlan({ author, id: "b", row: { id: "progress", state: "todo", text: "displayed document" } });
  const internals = store as unknown as { git(args: string[], author?: string): Promise<string> };
  const git = internals.git.bind(store), log = store.log.bind(store);
  let release!: () => void, paused!: () => void;
  const resume = new Promise<void>(resolve => { release = resolve; });
  const committed = new Promise<void>(resolve => { paused = resolve; });
  t.mock.method(internals, "git", async (args: string[], author?: string) => {
    const output = await git(args, author);
    if (args.includes("commit")) { paused(); await resume; }
    return output;
  });
  let historyReads = 0, pending: ReturnType<typeof op.setPlan> | undefined, gitHead: string | undefined;
  t.mock.method(store, "log", async (options: Parameters<typeof store.log>[0] = {}) => {
    const result = await log(options);
    // The read's first history range has been read; pause a real data transaction
    // after git commits, before Store.apply publishes its snapshot.
    if (++historyReads === 1) {
      pending = op.setPlan({ author, id: "a", row: { id: "progress", state: "todo", text: "committed but unpublished" } });
      await committed;
      gitHead = (await git(["rev-parse", "HEAD"])).trim();
      assert.notEqual(gitHead, shown.commit);
      assert.equal(store.snapshot().head, shown.commit, "git HEAD advances before snapshot publication");
    }
    return result;
  });
  try {
    await own.read({ doc: "item:b", through: shown.commit });
    assert.ok(pending, "the real data transaction reached its unpublished interval");
    assert.equal(store.snapshot().owner.cursor, shown.commit, "compaction cannot cross the captured snapshot head");
  } finally { release(); await pending; }
  const s = store.snapshot();
  assert.deepEqual((await unreadSteps(store, s.owner.cursor, s.owner.readMarks)).map(step => step.id), [gitHead]);
});

test("once the unread list is known, reads walk no history, and a new head walks only its new commits", async t => {
  const { store, op } = await board(t), own = ownerOps(store), cursor = store.snapshot().head;
  await own.read({ through: cursor });
  await op.setPlan({ author, id: "a", row: { id: "progress", state: "todo", text: "earlier unread" } });
  const b = await op.setPlan({ author, id: "b", row: { id: "progress", state: "todo", text: "read first" } });
  // The page asks for the unread list before the owner presses r.
  const s = store.snapshot();
  await unreadSteps(store, s.owner.cursor, s.owner.readMarks, s.head);
  const log = store.log.bind(store);
  const walks: Array<{ since?: string; at?: string }> = [];
  t.mock.method(store, "log", async (options: Parameters<typeof store.log>[0] = {}) => { walks.push({ since: options.since, at: options.at }); return log(options); });
  await own.read({ doc: "item:b", through: b.commit });
  assert.equal(store.snapshot().owner.readMarks?.["item:b"], b.commit, "the earlier unread item keeps the mark ahead of the cursor");
  await own.read({ doc: "item:a" });
  assert.equal(store.snapshot().owner.cursor, b.commit, "reading the rest compacts the cursor to the head");
  assert.deepEqual(walks, [], "a read reuses the history the unread list was computed from");
  const next = await op.setPlan({ author, id: "b", row: { id: "progress", state: "todo", text: "written after the reads" } });
  await own.read({ doc: "item:a" });
  assert.deepEqual(walks, [{ since: b.commit, at: next.commit }], "a new head costs one walk over the commits after the last one known");
  walks.length = 0;
  await own.read({ through: next.commit });
  assert.deepEqual(walks, [], "a cursor read walks no history either");
  assert.equal(store.snapshot().owner.cursor, next.commit);
  assert.deepEqual(await unreadSteps(store, next.commit), [], "everything through the head is read");
});

test("a write another session commits during a read neither restarts the read nor is read by it", async t => {
  const { store, op } = await board(t), own = ownerOps(store), cursor = store.snapshot().head;
  await own.read({ through: cursor });
  const first = await op.setPlan({ author, id: "b", row: { id: "progress", state: "todo", text: "read through here" } });
  const second = await op.setPlan({ author, id: "b", row: { id: "progress", state: "todo", text: "same author and document, so one step until a mark splits it" } });
  // The later half is two commits: a stop of one commit is described by its commit alone, which the walk has done already.
  const third = await op.setPlan({ author, id: "b", row: { id: "progress", state: "todo", text: "and a third, so the later half has endpoints of its own" } });
  const s = store.snapshot();
  await unreadSteps(store, s.owner.cursor, s.owner.readMarks, s.head);
  const log = store.log.bind(store), show = store.show.bind(store);
  const walks: Array<string | undefined> = [];
  t.mock.method(store, "log", async (options: Parameters<typeof store.log>[0] = {}) => { walks.push(options.at); return log(options); });
  let concurrent: string | undefined;
  t.mock.method(store, "show", async (...args: Parameters<typeof store.show>) => {
    // Reading through the first commit splits the step, and the read describes the later half for the first time:
    // another session's write lands right then, after the read captured the board.
    if (!concurrent) {
      const item = store.snapshot().items.a!;
      concurrent = (await store.commit({ author: "Firn", message: "concurrent write", puts: [{ kind: "item", id: "a", expectRev: item.rev, doc: { ...item, title: "written during the read" } }] })).commit;
    }
    return show(...args);
  });
  await own.read({ doc: "item:b", through: first.commit });
  assert.ok(concurrent, "the write landed while the read was in progress");
  assert.deepEqual(walks.filter(at => at !== s.head), [], "the read never recomputes at the newer head, so it did not start over");
  assert.deepEqual(walks, [], "nor does it walk the history it already knows");
  const owner = store.snapshot().owner;
  assert.equal(owner.cursor, first.commit, "compaction stops before the still-unread later half of the step");
  assert.equal(owner.readMarks, undefined, "the mark the cursor covers is removed");
  assert.deepEqual((await unreadSteps(store, owner.cursor, owner.readMarks)).map(step => step.commits), [[second.commit, third.commit], [concurrent]], "the change written during the read stays unread");
});

test("editDraft changes the exact unsent note while preserving its identity and metadata", async t => {
  const {store} = await board(t), own = ownerOps(store, () => later);
  for (const kind of ["comment", "choice", "approve", "done", "explain"] as const) {
    const created = await own.createNote({target: kind === "choice" ? "q:choice" : "it:a", kind, text: "Original", ...(kind === "choice" ? {choice: "A"} : {}), anchor: {kind: "note", id: "note-1"}});
    const before = store.snapshot().notes[created.id]!;
    const result = await own.editDraft({id: created.id, rev: before.rev, text: "Edited\ntext"});
    const after = store.snapshot().notes[created.id]!;
    assert.deepEqual(after, {...before, text: "Edited\ntext", rev: before.rev + 1, ...(kind === "approve" || kind === "done" ? {answerText: "Original"} : {})});
    assert.deepEqual(result, {note: {id: created.id, doc: after}, deleted: [], commit: store.snapshot().head});
    assert.equal(Object.keys(store.snapshot().notes).filter(id => id === created.id).length, 1);
    if (kind === "approve" || kind === "done") {
      const selected = await own.setDraft({target: "it:a", kind, on: true, text: "New control action"});
      assert.equal(selected.note!.doc.answerText, undefined, "explicitly selecting an action replaces its original identity");
    }
  }
});

test("editDraft refuses stale, sent, handled, empty-comment and non-edit input without writes", async t => {
  const {store, op} = await board(t), own = ownerOps(store, () => later);
  const {id} = await own.createNote({target: "it:a", kind: "comment", text: "Original"});
  await own.editDraft({id, rev: 1, text: "Newer"});
  const before = store.snapshot();
  await assert.rejects(own.editDraft({id, rev: 1, text: "Stale"}), /expected rev 1, current rev 2/);
  for (const input of [{id, rev: 2, text: " \n\t"}, {id, rev: 2, text: "Changed", target: "it:other"}, {id, rev: 2, text: "Changed", answerText: "Forged"}, {id, rev: 0, text: "Changed"}, {id, rev: 2, text: 4}]) {
    await assert.rejects(own.editDraft(input as Parameters<typeof own.editDraft>[0]));
    assert.deepEqual(store.snapshot(), before);
  }
  await assert.rejects(own.createNote({target: "it:a", kind: "approve", text: "Changed", answerText: "Forged"} as Parameters<typeof own.createNote>[0]));
  await own.send();
  const sent = store.snapshot();
  await assert.rejects(own.editDraft({id, rev: sent.notes[id]!.rev, text: "Too late"}), /Only draft notes/);
  assert.deepEqual(store.snapshot(), sent);
  await op.replyNote({author, id, reply: "Handled"});
  const handled = store.snapshot();
  await assert.rejects(own.editDraft({id, rev: handled.notes[id]!.rev, text: "Too late"}), /Only draft notes/);
  assert.deepEqual(store.snapshot(), handled);
});

test("an edit racing send fails its original revision once and never rewrites the sent note", async t => {
  const {store} = await board(t), own = ownerOps(store, () => later);
  const {id} = await own.createNote({target: "it:a", kind: "comment", text: "Original"});
  const commit = store.commit.bind(store);
  let attempts = 0;
  t.mock.method(store, "commit", async (txn: Parameters<typeof store.commit>[0]) => {
    attempts++;
    const note = store.snapshot().notes[id]!;
    await commit({author: "owner", message: "Concurrent send", puts: [{kind: "note", id, expectRev: note.rev, doc: {...note, state: "sent", sentAt: later}}]});
    return commit(txn);
  });
  await assert.rejects(own.editDraft({id, rev: 1, text: "Edited"}), /expected rev 1, current rev 2/);
  assert.equal(attempts, 1);
  assert.equal(store.snapshot().notes[id]!.state, "sent");
  assert.equal(store.snapshot().notes[id]!.text, "Original");
});

test("editing approve and done text preserves only the exact original ask identity", async t => {
  for (const kind of ["approve", "done"] as const) await t.test(kind, async t => {
    const {store} = await board(t), own = ownerOps(store, () => later), ask = store.snapshot().items.a!.ask!.text;
    const prefix = kind === "approve" ? "同意：" : "已完成：";
    const {id} = await own.createNote({target: "it:a", kind, text: prefix + ask});
    await own.editDraft({id, rev: 1, text: "Additional conditions"});
    await own.editDraft({id, rev: 2, text: "Revised conditions"});
    assert.equal(store.snapshot().notes[id]!.answerText, prefix + ask);
    await own.send();
    assert.equal(rules(store.snapshot()).askPending("a"), false);
    const s = store.snapshot(), r = rules(s);
    assert.equal(brief(s, r, author).notes.find(n => n.id === id)!.answerText, prefix + ask);
    assert.ok(formatContext(context(s, r, "a")).includes("original action: " + prefix + ask));
    const item = store.snapshot().items.a!;
    await store.commit({author, message: "Ask changed", puts: [{kind: "item", id: "a", expectRev: item.rev, doc: {...item, ask: {text: "Another ask"}}}]});
    assert.equal(rules(store.snapshot()).askPending("a"), true);
    const malformed = await own.createNote({target: "it:a", kind, text: "An unrelated original answer"});
    await own.editDraft({id: malformed.id, rev: 1, text: prefix + "Another ask"});
    await own.send();
    assert.equal(rules(store.snapshot()).askPending("a"), true, "editing displayed text does not manufacture an approval");
  });
});


test("document reads compact across internal logs without making them unread again", async t => {
  const {store, op} = await board(t), own = ownerOps(store), cursor = store.snapshot().head;
  await own.read({through: cursor});
  const progress = await op.setPlan({author, id: "a", row: {id: "work", text: "Owner-visible progress", state: "todo"}});
  const detail = await op.appendLog({author, id: "a", text: "Internal log after the displayed result"});
  await own.read({doc: "item:a", through: progress.commit});
  const owner = store.snapshot().owner;
  assert.equal(owner.cursor, detail.commit, "compaction can cross an invisible log commit");
  assert.deepEqual(await unreadSteps(store, owner.cursor, owner.readMarks), []);
  await op.appendLog({author, id: "a", text: "More internal detail"});
  assert.deepEqual(await unreadSteps(store, owner.cursor, owner.readMarks), [], "further logs leave the item read");
  const next = await op.setPlan({author, id: "a", row: {id: "work", text: "A later result", state: "todo"}});
  assert.deepEqual((await unreadSteps(store, owner.cursor, owner.readMarks)).map(step => step.id), [next.commit]);
});


test("owner reading schema rejects removed archive state", () => {
  assert.deepEqual(OwnerState.parse({}), {});
  assert.equal(OwnerState.safeParse({ archived: {} }).success, false);
});

test("sending a pick closes its card in the same commit with the chosen option and the send time", async t => {
  const { store } = await board(t), sentAt = "2026-10-12T05:06:07.000Z", own = ownerOps(store, () => sentAt);
  const pick = await own.createNote({ target: "q:choice", kind: "choice", text: "选 B", choice: "B" });
  const comment = await own.createNote({ target: "it:a", kind: "comment", text: "Also this" });
  const before = store.snapshot(), changes: Array<Parameters<Parameters<typeof store.onChange>[0]>[0]> = [];
  t.after(store.onChange(change => changes.push(change)));
  await own.send();
  const after = store.snapshot();
  assert.equal(changes.length, 1, "one commit holds the notes and the card");
  assert.deepEqual(changes[0]!.changed.map(c => `${c.kind}:${c.id}`).sort(), [`decision:choice`, `note:${comment.id}`, `note:${pick.id}`].sort());
  assert.deepEqual({ status: after.decisions.choice!.status, choice: after.decisions.choice!.choice, ruledAt: after.decisions.choice!.ruledAt, updated: after.decisions.choice!.updated }, { status: "ruled", choice: "B", ruledAt: sentAt, updated: sentAt });
  assert.deepEqual(after.decisions.choice!.options, before.decisions.choice!.options, "the options stay as written");
  assert.equal(after.notes[pick.id]!.sentAt, sentAt);
  // The pick says nothing but the option, and the ruling handles it: nobody has to close it, and it is not waiting for anyone.
  assert.equal(after.notes[pick.id]!.state, "done", "a plain pick is handled by the ruling in the same commit");
  assert.equal(after.notes[comment.id]!.state, "sent", "a comment sent with it still waits for the architect");
  assert.equal(after.notes[pick.id]!.reply, undefined, "the board writes no reply for it");
  assert.equal(rules(after).cardWaiting("choice"), false, "the card no longer waits");
  assert.equal(rules(after).planRows("b").find(row => row.row.id === "choice")!.state, "resolved", "its plan row is done");
});

test("a pick with the owner's words rules its card but stays sent for the architect to read", async t => {
  const { store } = await board(t), own = ownerOps(store, () => later);
  const worded = await own.createNote({ target: "q:choice", kind: "choice", text: "选 B，但先把测试补上", choice: "B" });
  await own.send();
  const after = store.snapshot();
  assert.deepEqual({ status: after.decisions.choice!.status, choice: after.decisions.choice!.choice }, { status: "ruled", choice: "B" }, "the pick rules the card whatever its text");
  assert.equal(after.notes[worded.id]!.state, "sent", "the words are not handled by the ruling");
  assert.equal(after.notes[worded.id]!.text, "选 B，但先把测试补上");
});

test("a pick whose text was emptied has no words either and is handled by the ruling", async t => {
  const { store } = await board(t), own = ownerOps(store, () => later);
  const empty = await own.createNote({ target: "q:choice", kind: "choice", text: "", choice: "A" });
  await own.send();
  assert.equal(store.snapshot().notes[empty.id]!.state, "done");
  assert.equal(store.snapshot().decisions.choice!.status, "ruled");
});

test("a pick on a card that is no longer open is still sent and leaves the card as it was", async t => {
  const { store } = await board(t), own = ownerOps(store, () => later);
  const pick = await own.createNote({ target: "q:choice", kind: "choice", text: "选 A", choice: "A" });
  const card = store.snapshot().decisions.choice!;
  // The architect ruled it in chat after the owner chose on the page but before sending.
  await store.commit({ author, message: "Rule in chat", puts: [{ kind: "decision", id: "choice", expectRev: card.rev, doc: { ...card, status: "ruled", choice: "B", ruledAt: "2026-10-11T03:00:00Z" } }] });
  const ruled = store.snapshot().decisions.choice!;
  assert.deepEqual((await own.send()).sent.map(n => n.id), [pick.id]);
  assert.deepEqual(store.snapshot().decisions.choice, ruled);
  assert.equal(store.snapshot().notes[pick.id]!.state, "sent");
});

test("comments and explain requests on an open card do not close it", async t => {
  const { store } = await board(t), own = ownerOps(store, () => later);
  await own.createNote({ target: "q:choice", kind: "comment", text: "Question" });
  await own.send();
  assert.equal(store.snapshot().decisions.choice!.status, "open");
});
