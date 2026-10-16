import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { board, author, appendCommits } from "./helpers.ts";
import { Store } from "../src/store.ts";
import { ops } from "../src/ops.ts";
import * as q from "../src/query.ts";

const at = "2026-10-11T01:02:03Z";
const doc = (title: string, fields: object = {}) => ({ title, group: "Whitefoot", difficulty: 2, plan: [{ id: "accept", accept: true, text: "passes", state: "todo" }], updated: at, ...fields });
const owns = (item: string) => ({ id: item, item, own: true, after: [] });
const card = (item: string, question: string) => ({ item, question, background: "Evidence", options: [{ key: "A", text: "A" }], status: "open", at, updated: at });
const note = (target: string, text: string) => ({ target, kind: "comment", text, at, sentAt: at, state: "sent" });
const put = (kind: "item" | "decision" | "note", id: string, document: object) => ({ kind, id, expectRev: null, doc: document });
const remove = (kind: "item" | "decision" | "note", id: string) => ({ kind, id, expectRev: 1 });

/** What a store's reads of history cost, counted where they happen: whole boards rebuilt, listings of git history, files read from git. */
function counted(t: TestContext, store: Store) {
  const rebuilt = t.mock.method(store, "comparisonSnapshot");
  const listed = t.mock.method(store, "log");
  const blobs = (store as unknown as { blobs: { read(spec: string): Promise<Buffer | null> } }).blobs;
  const reads = t.mock.method(blobs, "read");
  return {
    rebuilt: () => rebuilt.mock.callCount(),
    /** Listings of the whole history: neither bounded by a range (`since`) nor by one document (`kind` and `id`). */
    wholeListings: () => listed.mock.calls.filter(call => { const o = call.arguments[0] ?? {}; return o.since === undefined && o.kind === undefined; }).length,
    reads: () => reads.mock.callCount(),
  };
}

test("changes over a long history costs what its range costs: no whole board rebuilt, no full listing, few files read, placement and titles as written", async t => {
  const { dir, store: seed } = await board(t);
  // Before the range: a chain of three items with a card and a note on its leaf, and three notes the range deletes.
  await seed.commit({ author, message: "Chain and notes", puts: [
    put("item", "chain-x", doc("Chain root", { priority: "P1", plan: [owns("chain-y"), { id: "accept", accept: true, text: "passes", state: "todo" }] })),
    put("item", "chain-y", doc("Chain middle", { plan: [owns("chain-z"), { id: "accept", accept: true, text: "passes", state: "todo" }] })),
    put("item", "chain-z", doc("Chain leaf")),
    put("decision", "chain-card", card("chain-z", "Chain question?")),
    put("note", "chain-note", note("q:chain-card", "On the chain")),
    put("note", "gone-1", note("it:a", "Gone one")), put("note", "gone-2", note("q:choice", "Gone two")), put("note", "gone-3", note("it:other", "Gone three")),
  ] });
  // Three hundred earlier commits, each writing item b: what a rebuild per commit would pay for.
  const b = seed.snapshot().items.b!, start = Math.floor(Date.now() / 1000) + 60;
  await appendCommits(dir, Array.from({ length: 300 }, (_, k) => ({ at: start + k * 60, message: `append_log b`, session: "earlier", files: { "items/b.yaml": { ...b, rev: b.rev + 1 + k, updated: new Date((start + k * 60) * 1000).toISOString() } } })));
  const store = await Store.open(dir), op = ops(store), baseline = store.snapshot().head;
  // In the range: a top-level item written, three notes deleted, and the whole chain with its card and note deleted, root first.
  await op.appendLog({ author, id: "area", text: "Top item written" });
  for (const id of ["gone-1", "gone-2", "gone-3"]) await store.commit({ author, message: `delete ${id}`, deletes: [remove("note", id)] });
  for (const id of ["chain-x", "chain-y", "chain-z"]) await store.commit({ author, message: `delete ${id}`, deletes: [remove("item", id)] });
  await store.commit({ author, message: "delete chain-card", deletes: [remove("decision", "chain-card")] });
  await store.commit({ author, message: "delete chain-note", deletes: [remove("note", "chain-note")] });

  const cost = counted(t, store);
  const result = await q.changes(store, store.snapshot(), baseline);
  const documents = result.flatMap(g => g.documents).length;
  assert.equal(documents, 9);
  assert.equal(cost.rebuilt(), 0, "a deleted document is found by reading its own file, never by rebuilding a board");
  assert.equal(cost.wholeListings(), 0, "only the commits of the range are listed");
  assert.ok(cost.reads() <= 4 * documents, `${cost.reads()} files read for ${documents} documents`);
  const shape = result.map(g => [g.areaId, g.area, g.documents.map(d => `${d.kind}:${d.id}:${d.title}:${d.summary}`).sort()] as const).sort((x, y) => x[0] < y[0] ? -1 : 1);
  assert.deepEqual(shape, [
    ["area", "解释器工作", ["item:area:解释器工作:+1 log", "note:gone-1:中文检查:deleted note", "note:gone-2:中文方案？:deleted note"]],
    ["chain-x", "Chain root", ["card:chain-card:Chain question?:deleted card", "item:chain-x:Chain root:deleted item", "item:chain-y:Chain middle:deleted item", "item:chain-z:Chain leaf:deleted item", "note:chain-note:Chain question?:deleted note"]],
    ["other", "其他项目", ["note:gone-3:其他项目:deleted note"]],
  ]);
  // The filters see the same placement.
  assert.deepEqual((await q.changes(store, store.snapshot(), baseline, { under: "chain-x" })).map(g => g.areaId), ["chain-x"]);
  assert.deepEqual((await q.changes(store, store.snapshot(), baseline, { group: "Firn" })).map(g => [g.areaId, g.documents.map(d => d.id)]), [["other", ["gone-3"]]]);
});

test("an item whose owner was deleted before the range is grouped as the top of its own project, and a note keeps the item its card was last on", async t => {
  const { store } = await board(t);
  await store.commit({ author, message: "Owner, child and card", puts: [
    put("item", "old-root", doc("Old root", { priority: "P1", plan: [owns("old-child"), { id: "accept", accept: true, text: "passes", state: "todo" }] })),
    put("item", "old-child", doc("Old child", { group: "Firn" })),
    put("decision", "old-card", card("old-child", "Old question?")),
    put("note", "old-note", note("q:old-card", "On the old card")),
  ] });
  // Before the range: the owner and the card are deleted.
  await store.commit({ author, message: "Delete the owner and the card", deletes: [remove("item", "old-root"), remove("decision", "old-card")] });
  const baseline = store.snapshot().head;
  await store.commit({ author, message: "Delete the child", deletes: [remove("item", "old-child")] });
  await store.commit({ author, message: "Edit the note", puts: [{ kind: "note", id: "old-note", expectRev: 1, doc: note("q:old-card", "On the old card, edited") }] });
  const result = await q.changes(store, store.snapshot(), baseline);
  // The owner is out of reach, so the child is its own area, in its own project (Firn). The card's question is out of reach too,
  // so the note carries the title of the item the card was last on.
  assert.deepEqual(result.map(g => [g.areaId, g.area, g.documents.map(d => `${d.kind}:${d.id}:${d.title}`)]), [["old-child", "Old child", ["item:old-child:Old child", "note:old-note:Old child"]]]);
  assert.deepEqual((await q.changes(store, store.snapshot(), baseline, { group: "Firn" })).map(g => g.areaId), ["old-child"]);
  assert.deepEqual(await q.changes(store, store.snapshot(), baseline, { group: "Whitefoot" }), []);
});
