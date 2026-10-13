import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { board, author, later } from "./helpers.ts";
import { unreadSteps, stepDiff, piecesOf, commitsSince } from "../src/history.ts";
import type { Step } from "../src/history.ts";
import { describeChanges } from "../src/query.ts";
import { ops } from "../src/ops.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { Store } from "../src/store.ts";

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
  await op.createItem({ author, key: "child", parent: "a", parentWhy: "needs child", title: "new child", parentOwnWork: { key: "a-own", title: "a own work" } });
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
  await op.createItem({ author, key: "kid", parent: "a", parentWhy: "split", title: "kid", parentOwnWork: { key: "a-own", title: "a own" } });
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
  const multi = await op.createItem({ author, key: "kid", parent: "a", parentWhy: "split", title: "kid", parentOwnWork: { key: "a-own", title: "a own" } });
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
  assert.equal(scans, 1, "one bounded commit range supplies every mark comparison");
  scans = 0;
  const steps = await unreadSteps(store, cursor, marks);
  assert.deepEqual(steps.map(step => step.id), [latest.commit]);
  assert.equal(scans, 0, "more valid marks over the same range reuse it: adding marks adds no history scan");
});

// The unread list as the server computed it before it kept the history incrementally: one `git log` over the cursor's
// range, ancestry asked of git, and every document change read from git again. The incremental computation must give
// exactly this, errors included.
async function fromScratch(store: Store, cursor: string | undefined, readMarks: Record<string, string>, head: string): Promise<Step[]> {
  if (cursor && !(await store.inHistory(cursor, head))) throw new Error(`Read cursor ${cursor} is not in board history`);
  const commits = (await store.log({ since: cursor, at: head })).reverse();
  const positions = new Map(commits.map((commit, index) => [commit.commit, index]));
  const markPositions = new Map<string, number>();
  for (const [doc, mark] of Object.entries(readMarks)) {
    const position = positions.get(mark);
    if (position !== undefined) markPositions.set(doc, position);
    else if (mark !== cursor && (!cursor || !(await store.inHistory(mark, cursor)))) throw new Error(`Read mark ${mark} is not in board history`);
  }
  const steps: Step[] = [];
  let previous: Step | undefined;
  for (const [position, commit] of commits.entries()) {
    if (commit.author === "owner") { previous = undefined; continue; }
    const docs: Step["docs"] = commit.files.flatMap(file => {
      const m = /^(items|decisions|notes)\/(.+)\.yaml$/.exec(file);
      if (!m) return [];
      const kind = ({ items: "item", decisions: "decision", notes: "note" } as const)[m[1] as "items" | "decisions" | "notes"];
      return [{ kind, id: m[2]!, summary: "", pieces: { log: 0, reply: 0, other: 0 } }];
    });
    if (!docs.length) { previous = undefined; continue; }
    const single = docs.length === 1 && commit.files.every(f => f === "state/owner.yaml" || /^(items|decisions|notes)\//.test(f));
    const unreadDocs = docs.filter(doc => position > (markPositions.get(`${doc.kind}:${doc.id}`) ?? -1));
    if (!unreadDocs.length) { previous = undefined; continue; }
    if (single && previous?.docs.length === 1 && previous.author === commit.author && previous.docs[0]!.kind === docs[0]!.kind && previous.docs[0]!.id === docs[0]!.id) {
      previous.commits.push(commit.commit); previous.id = commit.commit; previous.at = commit.at;
    } else {
      previous = { id: commit.commit, commits: [commit.commit], parent: commit.parents[0] ?? null, author: commit.author, at: commit.at, docs: unreadDocs };
      steps.push(previous);
    }
    if (!single) previous = undefined;
  }
  for (const step of steps) for (const doc of step.docs) {
    const before = step.parent ? await store.show(doc.kind, doc.id, step.parent) : null, after = await store.show(doc.kind, doc.id, step.id);
    doc.summary = describeChanges(before, after, doc.kind);
    doc.pieces = piecesOf(before, after, doc.kind, doc.summary);
  }
  for (const step of steps) step.docs = step.docs.filter(doc => doc.pieces.log + doc.pieces.reply + doc.pieces.other > 0);
  return steps.filter(step => step.docs.length);
}
const outcome = (steps: Promise<Step[]>) => steps.then(value => ({ value }), (error: Error) => ({ error: error.message }));

test("the incremental unread list equals the from-scratch computation through writes, reads and concurrent writes", async t => {
  const { store, op } = await board(t), own = ownerOps(store, () => later), seed = store.snapshot().head;
  // A log entry from any session, as history from before project ownership holds.
  const write = (by: string, id: string, text: string) => {
    const it = store.snapshot().items[id]!;
    return store.commit({ author: by, message: `log ${id}`, puts: [{ kind: "item", id, expectRev: it.rev, doc: { ...it, log: [...it.log, { at: later, by, text }] } }] });
  };
  const heads = [seed];
  async function same(label: string) {
    const s = store.snapshot(), marks = s.owner.readMarks ?? {};
    if (heads.at(-1) !== s.head) heads.push(s.head);
    // The owner's own state, the whole history, every earlier head as a cursor (a slice of the cached run), and the
    // owner's state at every earlier head (a head behind the run's last commit, or before the cursor: an error).
    const cases: Array<[string | undefined, Record<string, string>, string]> = [[s.owner.cursor, marks, s.head], [undefined, {}, s.head]];
    for (const h of heads) cases.push([h, {}, s.head], [s.owner.cursor, marks, h]);
    for (const [cursor, readMarks, head] of cases) {
      assert.deepEqual(await outcome(unreadSteps(store, cursor, readMarks, head)), await outcome(fromScratch(store, cursor, readMarks, head)), `${label}: from ${cursor} with ${JSON.stringify(readMarks)} at ${head}`);
    }
  }
  await own.read({ through: seed });
  await same("cursor at the seed");
  const a1 = await op.appendLog({ author, id: "a", text: "one" });
  await op.appendLog({ author, id: "a", text: "two: same author and document, one step" });
  await same("coalesced appends");
  await write("Firn", "a", "another author on the same document");
  await store.commit({ author, message: "retitle board", board: { ...store.snapshot().board, title: "Renamed board" } });
  await own.createNote({ target: "it:a", kind: "comment", text: "owner action" });
  await op.appendLog({ author, id: "b", text: "after the owner" });
  await same("authors, board settings and owner actions break steps");
  const multi = await op.createItem({ author, key: "child", parent: "a", parentWhy: "split", title: "child", parentOwnWork: { key: "a-own", title: "a own" } });
  const note = store.snapshot().notes["note-1"]!;
  await store.commit({ author, message: "delete note", deletes: [{ kind: "note", id: "note-1", expectRev: note.rev }] });
  const { rev, ...other } = store.snapshot().items.other!;
  await store.commit({ author, message: "touch time only", puts: [{ kind: "item", id: "other", doc: { ...other, updated: "2026-10-11T09:09:09Z" }, expectRev: rev }] });
  await same("shared commits, deletions and changes the owner cannot see");
  await own.read({ doc: "item:a", through: a1.commit });
  await same("a mark splits a coalesced step");
  await own.read({ doc: "item:b" });
  await same("a read without a bound takes the document's latest step");
  // Reads and other sessions' writes at once, landing in whatever order they do.
  await Promise.all([own.read({ doc: "item:a" }), write("Firn", "other", "concurrent"), op.appendLog({ author, id: "b", text: "concurrent too" }), own.read({ doc: "item:child" })]);
  await same("reads interleaved with concurrent writes");
  const b1 = await op.appendLog({ author, id: "b", text: "first half" });
  await op.appendLog({ author, id: "b", text: "second half" });
  await same("a new coalesced step");
  // A write that lands while a read describes the later half of the step it splits.
  const show = store.show.bind(store);
  let landed: string | undefined;
  const mocked = t.mock.method(store, "show", async (...args: Parameters<typeof store.show>) => {
    if (!landed) landed = (await write("Firn", "area", "landed during a read")).commit;
    return show(...args);
  });
  await own.read({ doc: "item:b", through: b1.commit });
  mocked.mock.restore();
  assert.ok(landed, "the write landed inside the read");
  await same("a write landing inside a read");
  await own.read({ through: multi.commit });
  await same("the cursor moves into the history");
  await own.read({ through: store.snapshot().head });
  await same("everything read");
});

test("a merged history the cached run cannot hold is read from git and gives the same unread list", async t => {
  const { store, op, dir } = await board(t), seed = store.snapshot().head;
  const linear = [seed];
  for (const id of ["a", "b", "a"]) linear.push((await op.appendLog({ author, id, text: `entry on ${id}` })).commit);
  const pairs = async (s: Store, commits: string[], label: string) => {
    for (const head of commits) for (const since of [undefined, ...commits]) {
      assert.deepEqual(await commitsSince(s, since, head), (await s.log({ since, at: head })).reverse(), `${label}: ${since}..${head}`);
    }
  };
  await pairs(store, linear, "linear");
  // A merge, as a data repository edited outside the daemon may hold.
  const git = promisify(execFile);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const tree = (await git("git", ["rev-parse", `${seed}^{tree}`], { cwd: dir })).stdout.trim();
  const sibling = (await git("git", ["commit-tree", tree, "-p", seed, "-m", "sibling"], { cwd: dir, env })).stdout.trim();
  const headTree = (await git("git", ["rev-parse", `${linear.at(-1)!}^{tree}`], { cwd: dir })).stdout.trim();
  const merged = (await git("git", ["commit-tree", headTree, "-p", linear.at(-1)!, "-p", sibling, "-m", "merge witness"], { cwd: dir, env })).stdout.trim();
  await git("git", ["update-ref", "HEAD", merged], { cwd: dir });
  const reopened = await Store.open(dir);
  const top = (await ops(reopened, () => later).appendLog({ author, id: "b", text: "after the merge" })).commit;
  const all = [...linear, sibling, merged, top];
  await pairs(reopened, all, "merged");
  for (const cursor of [undefined, ...all]) {
    assert.deepEqual(await outcome(unreadSteps(reopened, cursor, {}, top)), await outcome(fromScratch(reopened, cursor, {}, top)), `merged: from ${cursor}`);
  }
});
