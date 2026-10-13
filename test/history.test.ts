import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { board, author, later } from "./helpers.ts";
import { unreadSteps, stepDiff, piecesOf, commitsSince } from "../src/history.ts";
import type { Step } from "../src/history.ts";
import { describeChanges } from "../src/query.ts";
import { ops } from "../src/ops.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { Store } from "../src/store.ts";
import type { ItemTarget } from "../src/model.ts";

test("cursor range, single-document grouping, author boundaries and endpoint diff", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  const a = await op.setSteps({ author, id: "a", step: { id: "first", state: "todo", text: "first new entry" } });
  const b = await op.setSteps({ author, id: "a", step: { id: "second", state: "todo", text: "second new entry" } });
  const c = await op.setSteps({ author, id: "b", step: { id: "progress", state: "todo", text: "different document" } });
  const own = ownerOps(store);
  await own.createNote({ target: "it:a", kind: "comment", text: "owner action" });
  const d = await op.setSteps({ author, id: "b", step: { id: "progress", state: "todo", text: "after owner" } });
  // Store history also retains authors from before project identity replaced sessions.
  const previous = store.snapshot().items.b!;
  const e = await store.commit({ author: "other", message: "Historical session title change", puts: [{ kind: "item", id: "b", expectRev: previous.rev, doc: { ...previous, updated: later, title: "other author" } }] });
  const steps = await unreadSteps(store, cursor);
  assert.deepEqual(steps.map(s => s.commits), [[a.commit, b.commit], [c.commit], [d.commit], [e.commit]]);
  assert.equal(steps[0]!.id, b.commit); assert.equal(steps[0]!.docs[0]!.summary, "steps changed");
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
  await op.setSteps({ author, id: "a", step: { id: "progress", state: "todo", text: "following write" } });
  const note = store.snapshot().notes["note-1"]!;
  const deleted = await store.commit({ author, message: "delete synthetic note", deletes: [{ kind: "note", id: "note-1", expectRev: note.rev }] });
  const steps = await unreadSteps(store, cursor);
  assert.equal(steps.length, 3); assert.equal(steps[0]!.docs.length, 3); // child, own-work sub-item, parent
  const diff = await stepDiff(store, steps.find(s => s.id === deleted.commit)!, "note", "note-1");
  assert.deepEqual(diff.before, note); assert.equal(diff.after, null); assert.match(diff.diff, /-text: .*中文意见/);
});

test("commits that change no item, card or note are not steps", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  const a = await op.setSteps({ author, id: "a", step: { id: "progress", state: "todo", text: "before settings" } });
  await store.commit({ author, message: "retitle board", board: { ...store.snapshot().board, title: "Renamed board" } });
  store.setOwner({ archived: { other: later } });
  await store.flushOwner(author);
  const b = await op.setSteps({ author, id: "a", step: { id: "progress", state: "todo", text: "after settings" } });
  const steps = await unreadSteps(store, cursor);
  assert.deepEqual(steps.map(s => s.commits), [[a.commit], [b.commit]]);
});

test("unread steps are reused until HEAD or the cursor moves", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  await op.setSteps({ author, id: "a", step: { id: "progress", state: "todo", text: "one" } });
  const first = unreadSteps(store, cursor);
  assert.equal(unreadSteps(store, cursor), first, "same HEAD and cursor reuse the computation");
  await first;
  await op.setSteps({ author, id: "b", step: { id: "progress", state: "todo", text: "two" } });
  const moved = await unreadSteps(store, cursor);
  assert.equal(moved.length, (await first).length + 1, "a new commit is seen");
  assert.notEqual(unreadSteps(store, undefined), unreadSteps(store, cursor));
  assert.equal(moved[0]!.parent, cursor, "a step's before state is the commit preceding it");
});

test("a new commit reads only the documents of the step it creates or extends", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  await op.setSteps({ author, id: "a", step: { id: "progress", state: "todo", text: "one" } });
  await op.setSteps({ author, id: "b", step: { id: "progress", state: "todo", text: "two" } });
  await unreadSteps(store, cursor);
  const shown: string[] = [];
  const show = store.show.bind(store);
  t.mock.method(store, "show", (kind: Parameters<typeof store.show>[0], id: string, at: string) => { shown.push(kind + ":" + id); return show(kind, id, at); });
  await op.setSteps({ author, id: "a", step: { id: "progress", state: "todo", text: "three" } });
  const steps = await unreadSteps(store, cursor);
  assert.equal(steps.length, 3);
  assert.deepEqual([...new Set(shown)], ["item:a"], "earlier steps come from the cache: " + shown.join(" "));
  assert.equal(steps[0]!.docs[0]!.pieces.progress, 1, "cached steps keep their counts");
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
  assert.match(parent.summary, /deps changed/);
  assert.doesNotMatch(parent.summary, /log/);
});

test("owner pieces count step changes, replies and heads, while every kind of log edit is invisible", () => {
  const item = (log: Array<{ at: string; text: string; by?: string }>, head = "h", steps: Array<{id: string; text: string; state: "todo"}> = []) => ({ title: "t", head, steps, log, updated: later, deps: [], links: [], rev: 1 });
  const e = (n: number) => ({ at: `2026-10-11T0${n}:00:00Z`, text: `entry ${n}` });
  const step = (id: string, text = id) => ({id, text, state: "todo" as const});
  const zero = {progress: 0, reply: 0, other: 0};
  assert.deepEqual(piecesOf(null, item([e(1), e(2), e(3)]), "item", "new item"), { ...zero, other: 1 }, "a new item counts once regardless of logs");
  assert.deepEqual(piecesOf(item([e(1)]), item([e(1), e(2), e(3)], "changed"), "item", "head changed, +2 log"), { ...zero, other: 1 });
  assert.deepEqual(piecesOf(item([e(1)]), item([e(1)]), "item", "metadata changed"), zero);
  for (const logs of [[e(1), e(2)], [], [{...e(1), text: "head changed, steps changed"}], [{...e(1), by: "another author"}]]) {
    const before = item([e(1)]), after = item(logs);
    assert.deepEqual(piecesOf(before, after, "item", describeChanges(before, after, "item")), zero, "append, removal, rewrite and author-only edits stay invisible");
  }
  assert.deepEqual(piecesOf(item([]), item([], "h", [step("a"), step("b")]), "item", "steps changed"), {...zero, progress: 2});
  assert.deepEqual(piecesOf(item([], "h", [step("a"), step("b")]), item([], "h", [step("b"), step("a")]), "item", "steps changed"), {...zero, progress: 1}, "reordering is still a progress change");
  assert.deepEqual(piecesOf(item([], "h", [step("a"), step("b")]), item([], "h", [step("b")]), "item", "steps changed"), {...zero, progress: 1}, "removal is still a progress change");
  assert.deepEqual(piecesOf(item([], "h", [step("a"), step("b")]), item([], "h", [step("a", "updated"), step("b")]), "item", "steps changed"), {...zero, progress: 1}, "an update counts only its stable id");
  assert.deepEqual(piecesOf(null, item([], "h", [step("a")]), "item", "new item"), {...zero, progress: 1, other: 1});
  assert.deepEqual(piecesOf({}, {}, "note", "state changed, new reply"), {...zero, reply: 1});
  assert.deepEqual(piecesOf({}, {}, "note", "state changed"), zero);
  assert.deepEqual(piecesOf(null, {}, "decision", "new card"), {...zero, other: 1});
  assert.deepEqual(piecesOf({}, {}, "note", "text changed"), {...zero, other: 1});
  assert.deepEqual(piecesOf({}, {}, "note", "reply cleared, state changed"), {...zero, other: 1});
});

const targetRow = (id: string, current = "12 倍 Chromium"): ItemTarget => ({id, goal: "样式计算 " + id, target: "≤ 1 倍 Chromium", current, baseline: "Chromium 同机同页", date: later});

test("goal numbers count as progress, including edits, dates, removals and reordering, never other changes", () => {
  const item = (targets: ItemTarget[] = []) => ({title: "Goal", targets, steps: [], log: [], updated: later, deps: [], links: [], rev: 1});
  const a = targetRow("a"), b = targetRow("b"), zero = {progress: 0, reply: 0, other: 0};
  assert.deepEqual(piecesOf(item(), item([a, b]), "item", "targets changed"), {...zero, progress: 2});
  assert.deepEqual(piecesOf(item([a, b]), item([a, b]), "item", "metadata changed"), zero);
  assert.deepEqual(piecesOf(item([a, b]), item([b, a]), "item", "targets changed"), {...zero, progress: 1}, "reorder leaves one progress piece");
  assert.deepEqual(piecesOf(item([a, b]), item([b]), "item", "targets changed"), {...zero, progress: 1}, "removal leaves one progress piece");
  assert.deepEqual(piecesOf(item([a]), item(), "item", "targets changed"), {...zero, progress: 1}, "removing the last target remains progress");
  for (const field of ["goal", "target", "current", "baseline", "date"] as const) {
    const next = {...a, [field]: field === "date" ? "2026-10-12T12:00:00Z" : "Changed"};
    assert.deepEqual(piecesOf(item([a, b]), item([next, b]), "item", "targets changed"), {...zero, progress: 1}, field + " changes only its stable row");
  }
  const before = item(), after = {...item([a, b]), steps: [{id: "s", text: "Step", state: "todo" as const}]};
  assert.deepEqual(piecesOf(before, after, "item", "steps changed, targets changed"), {...zero, progress: 3}, "step and target pieces add up");
  assert.deepEqual(piecesOf(null, item([a]), "item", "new item"), {...zero, progress: 1, other: 1});
  assert.deepEqual(piecesOf(item([a]), {...item([b]), head: "Changed head"}, "item", "head changed, targets changed"), {...zero, progress: 1, other: 1});
});

test("target writes produce compact progress summaries and honor document read marks", async t => {
  const {store, op} = await board(t), cursor = store.snapshot().head;
  const {date: _date, ...firstRow} = targetRow("goal");
  const first = await op.setTargets({author, id: "a", target: firstRow});
  const firstStops = await unreadSteps(store, cursor);
  assert.equal(firstStops[0]!.docs[0]!.summary, "targets changed");
  assert.deepEqual(firstStops[0]!.docs[0]!.pieces, {progress: 1, reply: 0, other: 0});
  const next = await op.setTargets({author, id: "a", target: {...firstRow, current: "6 倍 Chromium"}});
  const marked = await unreadSteps(store, cursor, {"item:a": first.commit});
  assert.deepEqual(marked[0]!.commits, [next.commit]);
  assert.deepEqual(marked[0]!.docs[0]!.pieces, {progress: 1, reply: 0, other: 0});
  const diff = await stepDiff(store, marked[0]!, "item", "a");
  assert.equal((diff.before as {targets: ItemTarget[]}).targets[0]!.current, "12 倍 Chromium");
  assert.equal((diff.after as {targets: ItemTarget[]}).targets[0]!.current, "6 倍 Chromium");
});

test("log-only writes never become unread stops or extend a progress stop across a read mark", async t => {
  const {store, op} = await board(t), cursor = store.snapshot().head;
  const leadingLog = await op.appendLog({author, id: "a", text: "Internal detail before progress"});
  assert.deepEqual(await unreadSteps(store, cursor), []);
  const first = await op.setSteps({author, id: "a", step: {id: "work", text: "First result", state: "todo"}});
  const original = await unreadSteps(store, cursor);
  assert.equal(original[0]!.id, first.commit);
  assert.equal(original[0]!.parent, leadingLog.commit, "the before state is just before the visible write");
  const trailingLog = await op.appendLog({author, id: "a", text: "Internal detail after progress"});
  assert.deepEqual(await unreadSteps(store, cursor), original, "a later log cannot change the stop id, pieces or baseline");
  const marks = {"item:a": first.commit};
  assert.deepEqual(await unreadSteps(store, cursor, marks), [], "reading progress also leaves later logs with nothing to read");
  const second = await op.setSteps({author, id: "a", step: {id: "work", text: "Second result", state: "todo"}});
  const changed = await unreadSteps(store, cursor, marks);
  assert.deepEqual(changed.map(step => step.commits), [[second.commit]]);
  assert.equal(changed[0]!.parent, trailingLog.commit);
  assert.deepEqual(changed[0]!.docs[0]!.pieces, {progress: 1, reply: 0, other: 0});
  const item = store.snapshot().items.a!;
  await store.commit({author, message: "Rewrite internal logs", puts: [{kind: "item", id: "a", expectRev: item.rev, doc: {...item, log: []}}]});
  assert.deepEqual(await unreadSteps(store, cursor, marks), changed, "removing logs is invisible too");
  const finalMarks = {"item:a": second.commit};
  assert.deepEqual(await unreadSteps(store, cursor, finalMarks), []);
  const removed = await op.setSteps({author, id: "a", remove: "work"});
  assert.deepEqual((await unreadSteps(store, cursor, finalMarks)).map(step => [step.id, step.docs[0]!.pieces]), [[removed.commit, {progress: 1, reply: 0, other: 0}]], "removing progress is still a visible list change");
});

test("a mixed head and log write reports only the head as owner news", async t => {
  const {store, op} = await board(t), cursor = store.snapshot().head;
  await op.updateItem({author, id: "a", rev: store.snapshot().items.a!.rev, head: "Visible revised head", reason: "Internal reason"});
  const steps = await unreadSteps(store, cursor);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.docs[0]!.summary, "head changed");
  assert.deepEqual(steps[0]!.docs[0]!.pieces, {progress: 0, reply: 0, other: 1});
});

test("a record-only change is unread even when both versions have no stored status", async t => {
  const { store } = await board(t);
  await store.commit({ author, message: "Create synthetic record", puts: [{ kind: "item", id: "record", expectRev: null,
    doc: { title: "队列记录", group: author, record: true, priority: "P1", head: "## 完成条件\n保留队列记录。", updated: later } }] });
  const cursor = store.snapshot().head, before = store.snapshot().items.record!;
  await store.commit({ author, message: "Change record to work", puts: [{ kind: "item", id: "record", expectRev: before.rev,
    doc: { ...before, record: false } }] });
  const steps = await unreadSteps(store, cursor);
  assert.equal(steps.length, 1, "the record label changing to a work status is visible");
  assert.equal(steps[0]!.docs[0]!.summary, "changed to work item");
  assert.deepEqual(steps[0]!.docs[0]!.pieces, { progress: 0, reply: 0, other: 1 });
  const diff = await stepDiff(store, steps[0]!, "item", "record");
  assert.equal((diff.before as { record: boolean; status?: string }).record, true);
  assert.equal((diff.after as { record: boolean; status?: string }).record, false);
  assert.equal((diff.before as { status?: string }).status, undefined);
  assert.equal((diff.after as { status?: string }).status, undefined);
});


test("document read marks exclude only marked documents and disappear from stop counts", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  const first = await op.setSteps({ author, id: "a", step: { id: "progress", state: "todo", text: "earlier unread item" } });
  const second = await op.setSteps({ author, id: "b", step: { id: "progress", state: "todo", text: "selected later item" } });
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
  const first = await op.setSteps({ author, id: "a", step: { id: "progress", state: "todo", text: "already read" } });
  const second = await op.setSteps({ author, id: "a", step: { id: "progress", state: "todo", text: "new after the mark" } });
  const steps = await unreadSteps(store, cursor, { "item:a": first.commit });
  assert.deepEqual(steps[0]!.commits, [second.commit], "a mark splits consecutive changes at the read boundary");
  assert.equal(steps[0]!.parent, first.commit);
  assert.equal(steps[0]!.docs[0]!.pieces.progress, 1, "the read step version does not return in the count");
  assert.equal(steps[0]!.docs[0]!.summary, "steps changed");
});

test("unread history scans stay constant as valid document marks accumulate", async t => {
  const { store, op } = await board(t), cursor = store.snapshot().head;
  const marks: Record<string, string> = {};
  for (const id of ["a", "b", "area"]) marks[`item:${id}`] = (await op.setSteps({ author, id, step: {id: "progress", state: "todo", text: `read ${id}`} })).commit;
  const latest = await op.setSteps({ author, id: "a", step: { id: "progress", state: "todo", text: "unread after marks" } });
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

// A from-scratch reference: one git log over the cursor range, ancestry asked of git, and
// every document read anew. Visibility follows the owner-approved steps/log rule independently
// of production caches and step-comparison helpers. Results and errors must match.
function referenceSummary(before: unknown, after: unknown, kind: Parameters<typeof piecesOf>[2]) {
  const copy = (doc: unknown) => {
    if (kind !== "item" || doc === null) return doc;
    const result = { ...doc as Record<string, unknown> };
    delete result.log;
    return result;
  };
  return describeChanges(copy(before), copy(after), kind);
}
// The reference counts fields directly rather than using the production pieces function.
function referencePieces(before: unknown, after: unknown, kind: Parameters<typeof piecesOf>[2]): Step["docs"][number]["pieces"] {
  const summary = referenceSummary(before, after, kind), zero = {progress: 0, reply: 0, other: 0};
  if (kind === "decision") return {...zero, other: Number(summary !== "metadata changed")};
  if (kind === "note") {
    const parts = summary === "metadata changed" ? [] : summary.split(", ");
    return {...zero, reply: Number(parts.includes("new reply") || parts.includes("reply changed")), other: Number(before === null || after === null || parts.some(part => !["new reply", "reply changed", "state changed", "sentAt changed"].includes(part)))};
  }
  const old = before as {steps?: Array<{id: string}>; targets?: Array<{id: string}>} | null, next = after as typeof old;
  let count = 0;
  for (const field of ["steps", "targets"] as const) {
    const previous = old?.[field] ?? [], current = next?.[field] ?? [];
    let changed = 0;
    for (const row of current) if (!isDeepStrictEqual(row, previous.find(other => other.id === row.id))) changed++;
    if (!isDeepStrictEqual(previous, current)) count += Math.max(1, changed);
  }
  const rest = (doc: unknown) => {
    if (doc === null) return null;
    const result = {...doc as Record<string, unknown>}; delete result.log; delete result.steps; delete result.targets;
    return result;
  };
  return {...zero, progress: count, other: Number(describeChanges(rest(before), rest(after), "item") !== "metadata changed")};
}
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
      return [{ kind, id: m[2]!, summary: "", pieces: { progress: 0, reply: 0, other: 0 } }];
    });
    if (!docs.length) { previous = undefined; continue; }
    const single = docs.length === 1 && commit.files.every(f => f === "state/owner.yaml" || /^(items|decisions|notes)\//.test(f));
    const unreadDocs: Step["docs"] = [];
    for (const doc of docs) {
      if (position <= (markPositions.get(`${doc.kind}:${doc.id}`) ?? -1)) continue;
      const old = commit.parents[0] ? await store.show(doc.kind, doc.id, commit.parents[0]) : null;
      const next = await store.show(doc.kind, doc.id, commit.commit);
      const pieces = referencePieces(old, next, doc.kind);
      if (Object.values(pieces).some(count => count > 0)) unreadDocs.push(doc);
    }
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
    doc.summary = referenceSummary(before, after, doc.kind);
    doc.pieces = referencePieces(before, after, doc.kind);
  }
  for (const step of steps) step.docs = step.docs.filter(doc => doc.pieces.progress + doc.pieces.reply + doc.pieces.other > 0);
  return steps.filter(step => step.docs.length);
}
const outcome = (steps: Promise<Step[]>) => steps.then(value => ({ value }), (error: Error) => ({ error: error.message }));

test("the incremental unread list equals the from-scratch computation through writes, reads and concurrent writes", async t => {
  const { store, op } = await board(t), own = ownerOps(store, () => later), seed = store.snapshot().head;
  // A visible title change from any session, as history from before project ownership holds.
  const write = (by: string, id: string, text: string) => {
    const it = store.snapshot().items[id]!;
    return store.commit({ author: by, message: `title ${id}`, puts: [{ kind: "item", id, expectRev: it.rev, doc: { ...it, title: text } }] });
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
  const a1 = await op.setSteps({ author, id: "a", step: { id: "progress", state: "todo", text: "one" } });
  await op.setSteps({ author, id: "a", step: { id: "progress", state: "todo", text: "two: same author and document, one step" } });
  await same("coalesced step writes");
  const {date: _date, ...goal} = targetRow("speed");
  await op.setTargets({author, id: "a", target: goal});
  await op.setTargets({author, id: "a", target: {...goal, current: "6 倍 Chromium"}});
  await same("coalesced target writes beside steps");
  await op.setTargets({author, id: "a", remove: goal.id});
  await same("target removal remains progress in the incremental cache");
  await write("Firn", "a", "another author on the same document");
  await store.commit({ author, message: "retitle board", board: { ...store.snapshot().board, title: "Renamed board" } });
  await own.createNote({ target: "it:a", kind: "comment", text: "owner action" });
  await op.setSteps({ author, id: "b", step: { id: "progress", state: "todo", text: "after the owner" } });
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
  await Promise.all([own.read({ doc: "item:a" }), write("Firn", "other", "concurrent"), op.setSteps({ author, id: "b", step: { id: "progress", state: "todo", text: "concurrent too" } }), own.read({ doc: "item:child" })]);
  await same("reads interleaved with concurrent writes");
  const b1 = await op.setSteps({ author, id: "b", step: { id: "progress", state: "todo", text: "first half" } });
  await op.setSteps({ author, id: "b", step: { id: "progress", state: "todo", text: "second half" } });
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
  for (const [index, id] of ["a", "b", "a"].entries()) linear.push((await op.setSteps({ author, id, step: {id: "progress", state: "todo", text: `result ${index} on ${id}`} })).commit);
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
  const top = (await ops(reopened, () => later).setSteps({ author, id: "b", step: { id: "progress", state: "todo", text: "after the merge" } })).commit;
  const all = [...linear, sibling, merged, top];
  await pairs(reopened, all, "merged");
  for (const cursor of [undefined, ...all]) {
    assert.deepEqual(await outcome(unreadSteps(reopened, cursor, {}, top)), await outcome(fromScratch(reopened, cursor, {}, top)), `merged: from ${cursor}`);
  }
});
