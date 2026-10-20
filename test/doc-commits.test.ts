// The list of the newest commits of each item, card and note file (item history-read-slow): `log` names the commits of one
// document from the list and asks git for those commits alone, where the path-limited walk looks through the whole history for the
// rest of a document that has fewer commits than asked for. The oracle is git's own path-limited walk, run here as a command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import { Store } from "../src/store.ts";
import type { DocKind } from "../src/store.ts";
import { DOC_COMMITS_KEPT, StartupCache } from "../src/startup-cache.ts";
import { appendCommits } from "./helpers.ts";
import { at, item, put, git, setup, cacheFile } from "./startup-board.ts";

interface Internals { git(args: string[], author?: string): Promise<string>; startupCacheContents(): StartupCache }
const internals = (store: Store) => store as unknown as Internals;
const folder = { item: "items", decision: "decisions", note: "notes", glossary: "glossaries", message: "messages" } as const;
const card = { item: "a", question: "Q", options: [{ key: "A", text: "A" }], status: "open", updated: at };

/** A board with an item written four times, an item written once, an item written and deleted, a card and a note. */
async function written(t: Parameters<typeof setup>[0]) {
  const { store, dir } = await setup(t);
  await store.commit({ author: "a", message: "Create", puts: [put("a", item("A")), put("b", item("B")), put("c", item("C")), { kind: "decision", id: "q", expectRev: null, doc: card }] });
  await store.commit({ author: "a", session: "s1", message: "Note", puts: [{ kind: "note", id: "n", expectRev: null, doc: { target: "q:q", kind: "comment", text: "N", at, state: "draft" } }] });
  for (const head of ["two", "three", "four"]) {
    const current = store.snapshot().items.a!;
    await store.commit({ author: "a", session: "s2", message: `Edit ${head}`, puts: [put("a", { ...current, head, updated: at }, current.rev)] });
  }
  await store.commit({ author: "a", message: "Delete c", deletes: [{ kind: "item", id: "c", expectRev: store.snapshot().items.c!.rev }] });
  return { store, dir };
}

const DOCS: Array<[DocKind, string]> = [["item", "a"], ["item", "b"], ["item", "c"], ["decision", "q"], ["note", "n"], ["item", "never-written"], ["note", "never-written"]];
const LIMITS = [0, 1, 3, 20];

/** Every document at every limit: the commits `log` names are the ones git's path-limited walk finds, and the whole record agrees with the one the walk gives. */
async function agrees(store: Store, dir: string, label: string) {
  for (const [kind, id] of DOCS) {
    const all = (await git(dir, "log", "--format=%H", "HEAD", "--", `${folder[kind]}/${id}.yaml`)).split("\n").filter(Boolean);
    for (const limit of LIMITS) assert.deepEqual((await store.log({ kind, id, limit })).map(c => c.commit), all.slice(0, limit), `${label}: ${kind} ${id}, limit ${limit}`);
    // A ref that is not the hash of the head sends the read to git's walk through the same parser: the record of each commit is the same either way.
    assert.deepEqual(await store.log({ kind, id, limit: 20 }), await store.log({ kind, id, limit: 20, at: "HEAD" }), `${label}: ${kind} ${id}: the record of each commit`);
  }
}

test("the commits of a document come from the list and are the ones git's own walk finds, with and without a startup cache", async t => {
  const { store, dir } = await written(t);
  await agrees(store, dir, "live");
  await store.saveStartupCache();
  const cached = StartupCache.parse(JSON.parse(await readFile(await cacheFile(dir), "utf8")));
  assert.equal(cached.docCommits["items/a.yaml"]!.length, 4, "an item created and edited three times has 4 commits: the note and the other documents' commits are not among them");
  assert.deepEqual(Object.keys(cached.docCommits).sort(), ["decisions/q.yaml", "items/a.yaml", "items/b.yaml", "items/c.yaml", "notes/n.yaml"], "only item, card and note files");
  // A start that continues from the cache, and one that scans the whole history, list the same commits.
  const resumed = await Store.open(dir);
  await agrees(resumed, dir, "with the cache");
  await rm(await cacheFile(dir));
  const scanned = await Store.open(dir);
  await agrees(scanned, dir, "scanned");
  assert.deepEqual(internals(scanned).startupCacheContents().docCommits, internals(resumed).startupCacheContents().docCommits);
  assert.deepEqual(internals(scanned).startupCacheContents().docCommits, cached.docCommits);
});

test("git is asked for the listed commits by name, and not at all for a document no commit ever changed", async t => {
  const { store } = await written(t);
  const spawned = t.mock.method(internals(store), "git");
  const four = await store.log({ kind: "item", id: "a", limit: 20 });
  assert.equal(four.length, 4);
  assert.equal(spawned.mock.calls.length, 1, "one git command");
  const args = spawned.mock.calls[0]!.arguments[0] as string[];
  assert.ok(args.includes("--no-walk=unsorted"), "it names the commits");
  assert.deepEqual(args.slice(args.indexOf("--no-walk=unsorted") + 1, args.indexOf("--")), four.map(c => c.commit), "newest first");
  assert.ok(!args.some(arg => arg.startsWith("--max-count")), "and does not walk the history for them");
  assert.equal(args.at(-1), "items/a.yaml");
  spawned.mock.resetCalls();
  assert.deepEqual(await store.log({ kind: "item", id: "never-written", limit: 20 }), []);
  assert.deepEqual(await store.log({ kind: "note", id: "b", limit: 20 }), [], "a note of the id of an item has its own file");
  assert.equal(spawned.mock.calls.length, 0, "an unknown document is decided without git");
  // A read at the head the store holds (the owner's read marks name it) is the list's too, and so is the unknown document there.
  const head = store.snapshot().head;
  spawned.mock.resetCalls();
  assert.deepEqual((await store.log({ kind: "item", id: "a", limit: 20, at: head })).map(c => c.commit), four.map(c => c.commit));
  assert.deepEqual(await store.log({ kind: "item", id: "never-written", limit: 1, at: head }), []);
  assert.equal(spawned.mock.calls.length, 1, "one git command, for the document that has commits");
  assert.ok((spawned.mock.calls[0]!.arguments[0] as string[]).includes("--no-walk=unsorted"), "named by the list");
  // The reads the list cannot answer still go to git's walk. A read at an older commit has fewer commits to show than the head has.
  const older = four[1]!.commit;
  for (const opts of [{ at: older }, { at: "HEAD" }, { since: "2026-01-01T00:00:00Z" }, { blobs: true as const }]) {
    spawned.mock.resetCalls();
    const got = await store.log({ kind: "item", id: "a", limit: 20, ...opts });
    assert.ok((spawned.mock.calls.at(-1)!.arguments[0] as string[]).some(arg => arg.startsWith("--max-count=20")), JSON.stringify(opts));
    if (opts.at === older) assert.deepEqual(got.map(c => c.commit), four.slice(1).map(c => c.commit), "the commits at that commit: the newest is not among them");
  }
  spawned.mock.resetCalls();
  await store.log({ kind: "glossary", id: "P", limit: 20 });
  assert.ok((spawned.mock.calls.at(-1)!.arguments[0] as string[]).some(arg => arg.startsWith("--max-count=20")), "a glossary has no list");
});

test("a commit that fails after git made it is not in the list", async t => {
  const { store, dir } = await written(t);
  const before = (await store.log({ kind: "item", id: "a", limit: 20 })).map(c => c.commit);
  const blobs = (store as unknown as { blobs: { object(spec: string): Promise<unknown> } }).blobs, original = blobs.object.bind(blobs);
  let failed = false;
  t.mock.method(blobs, "object", async (spec: string) => {
    if (!failed && /^[0-9a-f]{40}$/.test(spec)) { failed = true; throw new Error("Metadata unavailable"); }
    return original(spec);
  });
  const current = store.snapshot().items.a!;
  await assert.rejects(store.commit({ author: "a", message: "Rolled back", puts: [put("a", { ...current, head: "lost", updated: at }, current.rev), put("rolled-back", item())] }), /Metadata unavailable/);
  assert.ok(failed);
  assert.deepEqual((await store.log({ kind: "item", id: "a", limit: 20 })).map(c => c.commit), before);
  assert.deepEqual(await store.log({ kind: "item", id: "rolled-back", limit: 20 }), []);
  await agrees(store, dir, "after the rollback");
});

test("a document with more commits than the list keeps lists the newest, and a read for more goes to git", async t => {
  const { store, dir } = await setup(t);
  await store.commit({ author: "a", message: "Create", puts: [put("a", item("A"))] });
  const base = store.snapshot().items.a!, start = Date.parse(at) / 1000;
  const many = DOC_COMMITS_KEPT + 5;
  // Written with fast-import, which is quicker than one git commit for each; the store reads them at its start.
  await appendCommits(dir, Array.from({ length: many }, (_, k) => ({ at: start + 60 + k, message: `append_log a ${k}`, files: { "items/a.yaml": { ...base, rev: base.rev + 1 + k, head: `version ${k}`, updated: new Date((start + 60 + k) * 1000).toISOString() } } })));
  const reopened = await Store.open(dir);
  const spawned = t.mock.method(internals(reopened), "git");
  const walked = async (limit: number) => (await git(dir, "log", "--format=%H", `--max-count=${limit}`, "HEAD", "--", "items/a.yaml")).split("\n");
  const kept = await reopened.log({ kind: "item", id: "a", limit: DOC_COMMITS_KEPT });
  assert.equal(kept.length, DOC_COMMITS_KEPT);
  assert.deepEqual(kept.map(c => c.commit), await walked(DOC_COMMITS_KEPT));
  assert.ok((spawned.mock.calls.at(-1)!.arguments[0] as string[]).includes("--no-walk=unsorted"), "the most kept is answered from the list");
  const more = await reopened.log({ kind: "item", id: "a", limit: DOC_COMMITS_KEPT + 1 });
  assert.deepEqual(more.map(c => c.commit), await walked(DOC_COMMITS_KEPT + 1));
  assert.ok((spawned.mock.calls.at(-1)!.arguments[0] as string[]).some(arg => arg === `--max-count=${DOC_COMMITS_KEPT + 1}`), "one more than the list holds is asked of git's walk");
  // A commit after the start takes the newest place and pushes the oldest out.
  t.mock.restoreAll();
  const current = reopened.snapshot().items.a!;
  const result = await reopened.commit({ author: "a", message: "One more", puts: [put("a", { ...current, head: "last", updated: at }, current.rev)] });
  const after = await reopened.log({ kind: "item", id: "a", limit: DOC_COMMITS_KEPT });
  assert.equal(after[0]!.commit, result.commit);
  assert.deepEqual(after.map(c => c.commit), await walked(DOC_COMMITS_KEPT));
  assert.equal(internals(reopened).startupCacheContents().docCommits["items/a.yaml"]!.length, DOC_COMMITS_KEPT);
});
