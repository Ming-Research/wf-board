import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { parse } from "yaml";
import { Item } from "../src/model.ts";
import { Store, ConflictError, ValidationError, type ChangedDoc } from "../src/store.ts";

const exec = promisify(execFile);
const at = "2026-10-11T01:02:03Z";
const item = (title = "An item", head = "A head") => ({ title, group: "P", head, plan: [{ id: "accept", text: "Accepted", state: "todo" as const, accept: true as const }], priority: "P1" as const, updated: at });
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store: await Store.open(dir, { init: true, board: { title: "Board" } }) };
}
async function git(dir: string, ...args: string[]): Promise<string> { return (await exec("git", args, { cwd: dir })).stdout.trim(); }
const put = (id: string, doc: unknown, expectRev: number | null = null) => ({ kind: "item" as const, id, doc, expectRev });

test("published snapshots are reused until a write and remain deeply immutable", async t => {
  const { store } = await setup(t);
  await store.commit({ author: "a", message: "Create", puts: [put("a", item())] });
  const before = store.snapshot();
  assert.strictEqual(store.snapshot(), before, "unchanged reads do not clone every item again");
  assert.throws(() => { before.items.a!.plan[0]!.after = []; }, TypeError);
  assert.throws(() => { before.activity!.writes.push(at); }, TypeError);
  await store.commit({ author: "a", message: "Update", puts: [put("a", item("Changed"), 1)] });
  const after = store.snapshot();
  assert.notStrictEqual(after, before);
  assert.strictEqual(store.snapshot(), after);
  assert.equal(after.items.a!.title, "Changed");
  assert.equal(before.items.a!.title, "An item", "publishing later state cannot mutate an earlier snapshot");
  assert.equal(after.activity!.writes.length, before.activity!.writes.length + 1);
});

test("published snapshots refresh on owner-only changes and preserve a failed owner's previous state", async t => {
  const { store } = await setup(t);
  const before = store.snapshot();
  store.setOwner({ cursor: before.head });
  const read = store.snapshot();
  assert.notStrictEqual(read, before);
  assert.equal(read.head, before.head);
  assert.equal(read.owner.cursor, before.head);
  assert.equal(before.owner.cursor, undefined);
  assert.strictEqual(store.snapshot(), read);
  assert.throws(() => { read.owner.cursor = "0".repeat(40); }, TypeError);
  const internals = store as unknown as { writeOwner(): void };
  t.mock.method(internals, "writeOwner", () => { throw new Error("owner save failed"); });
  assert.throws(() => store.setOwner({}), /owner save failed/);
  assert.strictEqual(store.snapshot(), read, "failed persistence restores the same published owner state");
});

test("reloading activity invalidates a previously published snapshot without a new commit", async t => {
  const { store } = await setup(t);
  const before = store.snapshot();
  assert.strictEqual(store.snapshot(), before);
  t.mock.method(store, "log", async () => [{ commit: before.head, parents: [], at, author: "a", message: "Historical work", files: ["items/old.yaml"] }]);
  await (store as unknown as { loadActivity(): Promise<void> }).loadActivity();
  const after = store.snapshot();
  assert.notStrictEqual(after, before);
  assert.equal(after.head, before.head);
  assert.deepEqual(after.activity, { writes: [at], items: { old: at } });
  assert.equal(before.activity?.items.old, undefined);
  assert.strictEqual(store.snapshot(), after);
});

test("historical document cache stays bounded, evicts FIFO and rereads unchanged evidence", async t => {
  const { store } = await setup(t);
  const internals = store as unknown as {
    readAt(path: string, commit: string): Promise<unknown | null>;
    historicalDocuments: Map<string, Promise<unknown | null>>;
    blobs: { read(key: string): Promise<Buffer | null> };
  };
  internals.historicalDocuments.clear();
  const reads = new Map<string, number>();
  t.mock.method(internals.blobs, "read", async (key: string) => {
    reads.set(key, (reads.get(key) ?? 0) + 1);
    return Buffer.from(`evidence: ${key}\n`);
  });
  const firstKey = "commit:items/first.yaml";
  const first = await internals.readAt("items/first.yaml", "commit");
  for (let i = 0; i < 4095; i++) await internals.readAt(`items/a${i}.yaml`, "commit");
  assert.equal(internals.historicalDocuments.size, 4096);
  assert.deepEqual(await internals.readAt("items/first.yaml", "commit"), first);
  assert.equal(reads.get(firstKey), 1, "a hit reuses its parsed document");
  await internals.readAt("items/overflow.yaml", "commit");
  assert.equal(internals.historicalDocuments.size, 4096, "the cache cannot grow with history");
  assert.equal(internals.historicalDocuments.has(firstKey), false, "hits do not change FIFO order");
  assert.equal(internals.historicalDocuments.has("commit:items/a0.yaml"), true);
  assert.deepEqual(await internals.readAt("items/first.yaml", "commit"), first, "eviction changes no historical evidence");
  assert.equal(reads.get(firstKey), 2, "an evicted document is reread");
  assert.equal(internals.historicalDocuments.size, 4096);
  assert.equal(internals.historicalDocuments.has("commit:items/a0.yaml"), false);
});

test("pending historical reads share entries and a rejected evicted read cannot delete its replacement", async t => {
  const { store } = await setup(t);
  const internals = store as unknown as {
    readAt(path: string, commit: string): Promise<unknown | null>;
    historicalDocuments: Map<string, Promise<unknown | null>>;
    blobs: { read(key: string): Promise<Buffer | null> };
  };
  internals.historicalDocuments.clear();
  const pending: Array<{ resolve(value: Buffer | null): void; reject(error: Error): void }> = [];
  t.mock.method(internals.blobs, "read", () => new Promise<Buffer | null>((resolve, reject) => pending.push({ resolve, reject })));
  const first = internals.readAt("items/first.yaml", "commit");
  const firstAgain = internals.readAt("items/first.yaml", "commit");
  assert.equal(pending.length, 1, "concurrent readers share the same pending blob");
  const overflow = Array.from({ length: 4096 }, (_, i) => internals.readAt(`items/a${i}.yaml`, "commit"));
  assert.equal(internals.historicalDocuments.size, 4096, "pending reads also obey the bound");
  const retry = internals.readAt("items/first.yaml", "commit");
  const replacement = internals.historicalDocuments.get("commit:items/first.yaml");
  const failures = [assert.rejects(first, /old read failed/), assert.rejects(firstAgain, /old read failed/)];
  pending[0]!.reject(new Error("old read failed"));
  await Promise.all(failures);
  assert.equal(internals.historicalDocuments.get("commit:items/first.yaml"), replacement, "old rejection leaves the replacement cached");
  const retryAgain = internals.readAt("items/first.yaml", "commit");
  assert.equal(pending.length, 4098, "the replacement is shared rather than started again");
  for (const read of pending.slice(1)) read.resolve(Buffer.from("evidence: unchanged\n"));
  await Promise.all(overflow);
  assert.deepEqual(await retryAgain, await retry);
  assert.equal(internals.historicalDocuments.size, 4096);
});

test("normalized comparison cache retains at most four snapshots and rereads evicted commits", async t => {
  const { store } = await setup(t);
  const internals = store as unknown as {
    compared: Map<string, Promise<unknown>>;
    resolveCommit(ref: string): Promise<string>;
    git(args: string[]): Promise<string>;
    readAt(path: string, commit: string): Promise<unknown | null>;
  };
  const board = structuredClone(store.snapshot().board);
  const reads = new Map<string, number>();
  t.mock.method(internals, "resolveCommit", async (ref: string) => ref);
  t.mock.method(internals, "git", async (args: string[]) => {
    assert.deepEqual(args.slice(0, 3), ["ls-tree", "-r", "--name-only"]);
    return "board.yaml\n";
  });
  t.mock.method(internals, "readAt", async (path: string, commit: string) => {
    assert.equal(path, "board.yaml");
    reads.set(commit, (reads.get(commit) ?? 0) + 1);
    return board;
  });
  const first = await store.comparisonSnapshot("first");
  for (const commit of ["second", "third", "fourth"]) await store.comparisonSnapshot(commit);
  assert.equal(internals.compared.size, 4);
  assert.strictEqual(await store.comparisonSnapshot("first"), first);
  assert.equal(reads.get("first"), 1);
  await store.comparisonSnapshot("fifth");
  assert.equal(internals.compared.size, 4, "whole boards cannot accumulate for every history commit");
  assert.equal(internals.compared.has("first"), false, "snapshot hits preserve FIFO order");
  assert.deepEqual(await store.comparisonSnapshot("first"), first);
  assert.equal(reads.get("first"), 2);
  assert.equal(internals.compared.size, 4);
  assert.equal(internals.compared.has("second"), false);
});

test("YAML round trip preserves troublesome strings and schema key order", async t => {
  const { dir, store } = await setup(t);
  const strings = ["one\ntwo\n", "one\ntwo", "one\ntwo\n\n\n", "  first\nsecond", "\tfirst\n\tsecond", "one\r\ntwo\r\n", "---\n...\n# comment\n- list\nkey: value\n|\n>", "x".repeat(10000), "中文\n🦶😀", "no", "yes", "true", "false", "1e3", "2026-10-11", "null", "~", "\n", "\n\n", "a\n  ", "a\0b\nc"];
  await store.commit({ author: "Round trip", message: "Write all strings", puts: strings.map((s, i) => put(`s${i}`, item(s, s))) });
  for (const [i, s] of strings.entries()) {
    const expected = Item.parse({ ...item(s, s), rev: 1 });
    const text = await readFile(join(dir, `items/s${i}.yaml`), "utf8");
    assert.deepEqual(parse(text, { version: "1.2", schema: "core" }), expected);
    assert.ok(text.indexOf("title:") < text.indexOf("head:"));
    assert.ok(text.indexOf("updated:") < text.indexOf("rev:"));
    assert.equal(text.includes("parent:"), false);
    if (i === 0) assert.match(text, /head: \|\n/);
    if (i === 7) assert.ok(text.includes("x".repeat(10000)));
  }
  const owner = { readMarks: Object.fromEntries(["null", "1e3", "2026-10-11", "yes", "no"].map(id => [`item:${id}`, store.snapshot().head])) };
  store.setOwner(owner);
  assert.deepEqual(parse(await readFile(join(dir, "state/owner.yaml"), "utf8"), { version: "1.2", schema: "core" }), owner);
  const reopened = await Store.open(dir);
  assert.deepEqual(reopened.snapshot(), store.snapshot());
  assert.throws(() => { store.snapshot().items.s0!.title = "mutate"; }, TypeError);
});

test("create/update/delete increments revs and emits one immutable event per commit", async t => {
  const { dir, store } = await setup(t);
  const events: unknown[] = [];
  const unsubscribe = store.onChange(c => events.push(c));
  store.onChange(() => { throw new Error("broken subscriber"); });
  const first = await store.commit({ author: "雪 鬼", message: "Create", puts: [put("a", item())] });
  assert.equal(first.revs.a, 1);
  assert.equal(await git(dir, "show", "-s", "--format=%ae"), "session@wf-board.invalid");
  assert.equal(await git(dir, "show", "-s", "--format=%cn"), "wf-board");
  const second = await store.commit({ author: "A Session", message: "Update", puts: [put("a", item("Changed"), 1)] });
  assert.equal(second.revs.a, 2);
  assert.notEqual(second.commit, first.commit);
  await store.commit({ author: "A Session", message: "Delete", deletes: [{ kind: "item", id: "a", expectRev: 2 }] });
  assert.equal(store.snapshot().items.a, undefined);
  await assert.rejects(readFile(join(dir, "items/a.yaml")), { code: "ENOENT" });
  assert.equal(events.length, 3);
  const event = events[1] as { changed: { before: Item; after: Item }[] };
  assert.equal(event.changed[0]!.before.rev, 1);
  assert.equal(event.changed[0]!.after.rev, 2);
  assert.ok(Object.isFrozen(event.changed[0]!.after));
  unsubscribe();
  await store.commit({ author: "a", message: "Create again", puts: [put("a", item())] });
  assert.equal(events.length, 3);
});

test("expectRev conflicts preserve bytes, HEAD, index and memory across the whole transaction", async t => {
  const { dir, store } = await setup(t);
  await store.commit({ author: "a", message: "Create", puts: [put("a", item())] });
  const snapshot = store.snapshot();
  const bytes = await readFile(join(dir, "items/a.yaml"));
  const operation = store.commit({ author: "a", message: "Bad update", puts: [put("b", item()), put("a", item("Bad"), 9)] });
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ConflictError);
    assert.equal(error.kind, "item"); assert.equal(error.id, "a");
    assert.equal(error.expectedRev, 9); assert.equal(error.currentRev, 1);
    assert.deepEqual(error.currentDoc, snapshot.items.a);
    return true;
  });
  assert.deepEqual(await readFile(join(dir, "items/a.yaml")), bytes);
  assert.equal(await git(dir, "rev-parse", "HEAD"), snapshot.head);
  assert.equal(await git(dir, "status", "--porcelain"), "");
  assert.deepEqual(store.snapshot(), snapshot);
  await assert.rejects(readFile(join(dir, "items/b.yaml")), { code: "ENOENT" });
  await assert.rejects(store.commit({ author: "a", message: "Duplicate create", puts: [put("a", item())] }), ConflictError);
});

test("validation aggregates invalid documents before touching files or git", async t => {
  const { dir, store } = await setup(t);
  await store.commit({ author: "a", message: "Create", puts: [put("a", item())] });
  const snapshot = store.snapshot();
  const bytes = await readFile(join(dir, "items/a.yaml"));
  await assert.rejects(store.commit({ author: "a", message: "Invalid", puts: [put("a", item("Changed"), 1), put("b", {}), put("c", { ...item(), status: "bad" })] }), (error: unknown) => {
    assert.ok(error instanceof ValidationError);
    assert.match(error.message, /items\/b.yaml/); assert.match(error.message, /items\/c.yaml/);
    return true;
  });
  assert.deepEqual(await readFile(join(dir, "items/a.yaml")), bytes);
  assert.equal(await git(dir, "rev-parse", "HEAD"), snapshot.head);
  assert.equal(await git(dir, "status", "--porcelain"), "");
  assert.deepEqual(store.snapshot(), snapshot);
  await assert.rejects(store.commit({ author: "a", message: "Unsafe path", puts: [put("../escape", item())] }), ValidationError);
});

test("git failure restores updates, deletions, creations and pending owner state", async t => {
  const { dir, store } = await setup(t);
  await store.commit({ author: "a", message: "Create", puts: [put("a", item()), put("delete", item())] });
  store.setOwner({ cursor: store.snapshot().head });
  const snapshot = store.snapshot();
  const original = await readFile(join(dir, "items/a.yaml"));
  await writeFile(join(dir, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(store.commit({ author: "a", message: "Rejected", puts: [put("a", item("Bad"), 1), put("new", item())], deletes: [{ kind: "item", id: "delete", expectRev: 1 }] }));
  assert.equal(await git(dir, "rev-parse", "HEAD"), snapshot.head);
  assert.equal(await git(dir, "diff", "--cached", "--name-only"), "");
  assert.deepEqual(await readFile(join(dir, "items/a.yaml")), original);
  assert.ok(await readFile(join(dir, "items/delete.yaml")));
  await assert.rejects(readFile(join(dir, "items/new.yaml")), { code: "ENOENT" });
  assert.deepEqual(store.snapshot(), snapshot);
  assert.deepEqual(parse(await readFile(join(dir, "state/owner.yaml"), "utf8")), snapshot.owner);
  await rm(join(dir, ".git/hooks/pre-commit"));
  await store.commit({ author: "a", message: "Queue recovered", puts: [put("a", item("Good"), 1)] });
  assert.equal(store.snapshot().items.a!.title, "Good");
  assert.deepEqual(parse(await git(dir, "show", "HEAD:state/owner.yaml")), snapshot.owner);
});

test("post-commit metadata failure rolls back HEAD, files, index and memory without emitting a Change", async t => {
  const { dir, store } = await setup(t);
  await store.commit({ author: "a", message: "Create", puts: [put("a", item())] });
  const snapshot = store.snapshot();
  const bytes = await readFile(join(dir, "items/a.yaml"));
  let emitted = false;
  store.onChange(() => { emitted = true; });
  const internals = store as unknown as { git(args: string[], author?: string): Promise<string> };
  const originalGit = internals.git.bind(store);
  let failed = false;
  t.mock.method(internals, "git", async (args: string[], author?: string) => {
    if (!failed && args.includes("--format=%H%x00%aI")) { failed = true; throw new Error("Metadata unavailable"); }
    return originalGit(args, author);
  });
  await assert.rejects(store.commit({ author: "a", message: "Rollback committed change", puts: [put("a", item("Bad"), 1), put("new", item())] }), /Metadata unavailable/);
  assert.ok(failed); assert.equal(emitted, false);
  assert.equal(await git(dir, "rev-parse", "HEAD"), snapshot.head);
  assert.equal(await git(dir, "status", "--porcelain"), "");
  assert.deepEqual(await readFile(join(dir, "items/a.yaml")), bytes);
  assert.deepEqual(store.snapshot(), snapshot);
});

test("concurrent commits serialize, retain distinct writes and reject stale overwrites", async t => {
  const { store } = await setup(t);
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.commit({ author: "a", message: `Create ${i}`, puts: [put(`a${i}`, item(`${i}`))] })));
  assert.equal(Object.keys(store.snapshot().items).length, 8);
  const results = await Promise.allSettled([store.commit({ author: "a", message: "First", puts: [put("a0", item("First"), 1)] }), store.commit({ author: "a", message: "Second", puts: [put("a0", item("Second"), 1)] })]);
  assert.equal(results[0]!.status, "fulfilled"); assert.equal(results[1]!.status, "rejected");
  assert.equal(store.snapshot().items.a0!.title, "First");
  assert.equal(store.snapshot().items.a0!.rev, 2);
  assert.equal((await store.log()).length, 10);
});

test("revision map distinguishes documents with the same id across kinds", async t => {
  const { store } = await setup(t);
  const card = { item: "shared", question: "Choose", background: "Why", options: [{ key: "A", text: "A" }], status: "open", updated: at };
  await store.commit({ author: "a", message: "Create both", puts: [put("shared", item()), { kind: "decision", id: "shared", doc: card, expectRev: null }] });
  await store.commit({ author: "a", message: "Update card", puts: [{ kind: "decision", id: "shared", doc: { ...card, question: "Changed" }, expectRev: 1 }] });
  const result = await store.commit({ author: "a", message: "Update both", puts: [put("shared", item("Changed"), 1), { kind: "decision", id: "shared", doc: { ...card, question: "Again" }, expectRev: 2 }] });
  assert.deepEqual(result.revs, { "item:shared": 2, "decision:shared": 3 });
});

test("no-op keeps HEAD/revs and leaves pending owner for the next actual commit", async t => {
  const { dir, store } = await setup(t);
  await store.commit({ author: "a", message: "Create", puts: [put("a", item())] });
  const head = store.snapshot().head;
  store.setOwner({ cursor: head });
  const result = await store.commit({ author: "a", message: "No-op", board: { title: "Board" }, puts: [put("a", { ...item(), rev: 900 }, 1)] });
  assert.equal(result.commit, head); assert.equal(result.revs.a, 1);
  assert.equal(await git(dir, "rev-parse", "HEAD"), head);
  assert.equal((await store.log()).length, 2);
  const changed = await store.commit({ author: "a", message: "Actual", puts: [put("a", item("Changed"), 1)] });
  assert.deepEqual(parse(await git(dir, "show", `${changed.commit}:state/owner.yaml`)), store.snapshot().owner);
  assert.equal(await store.flushOwner("a"), null);
});

test("owner state persists immediately, survives reopen, and flushes once at shutdown", async t => {
  const { dir, store } = await setup(t);
  const state = { cursor: store.snapshot().head };
  store.setOwner(state);
  assert.deepEqual(parse(await readFile(join(dir, "state/owner.yaml"), "utf8")), state);
  assert.equal((await store.log()).length, 1);
  const reopened = await Store.open(dir);
  assert.deepEqual(reopened.snapshot().owner, state);
  const flushed = await reopened.flushOwner("owner");
  assert.ok(flushed); assert.equal((await reopened.log()).length, 2);
  assert.equal(await reopened.flushOwner("owner"), null);
});

test("default owner state is staged on first persistence; absent optional fields and prototype-named keys round trip", async t => {
  const { dir, store } = await setup(t);
  let ownerBefore: unknown = "unset";
  store.onChange(c => { ownerBefore = c.changed.find(doc => doc.kind === "owner")?.before; });
  store.setOwner({});
  await store.commit({ author: "a", message: "First owner file", puts: [put("constructor", { ...item(), head: undefined }), put("toString", item())] });
  assert.deepEqual(parse(await git(dir, "show", "HEAD:state/owner.yaml")), {});
  assert.equal(ownerBefore, null);
  assert.equal(Object.hasOwn(store.snapshot().items.constructor!, "head"), false);
  assert.equal(store.snapshot().items["toString"]!.rev, 1);
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
  assert.equal(await store.flushOwner("owner"), null);
});

test("preexisting staged files cannot enter a board transaction", async t => {
  const { dir, store } = await setup(t);
  await writeFile(join(dir, "unrelated.txt"), "Keep this out of the board commit");
  await git(dir, "add", "unrelated.txt");
  const snapshot = store.snapshot();
  await assert.rejects(store.commit({ author: "a", message: "Create", puts: [put("a", item())] }), /staged index/);
  assert.deepEqual(store.snapshot(), snapshot);
  assert.equal(await git(dir, "rev-parse", "HEAD"), snapshot.head);
  assert.equal(await git(dir, "diff", "--cached", "--name-only"), "unrelated.txt");
  await assert.rejects(readFile(join(dir, "items/a.yaml")), { code: "ENOENT" });
});

async function pauseCommit(dir: string) {
  const marker = join(dir, "hook-ready");
  const release = join(dir, "hook-release");
  await writeFile(join(dir, ".git/hooks/pre-commit"), `#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(marker)}, "ready");\nconst deadline = Date.now() + 5000;\nwhile (!fs.existsSync(${JSON.stringify(release)})) { if (Date.now() > deadline) process.exit(1); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }\n`, { mode: 0o755 });
  return {
    async ready() {
      for (let attempt = 0; attempt < 300; attempt++) {
        try { await readFile(marker); return; } catch { await setTimeout(10); }
      }
      throw new Error("Commit hook did not become ready");
    },
    async resume() { await writeFile(release, "continue"); },
  };
}

test("setOwner during a commit keeps the staged state and persists the newer state for the next commit", async t => {
  const { dir, store } = await setup(t);
  const original = { cursor: store.snapshot().head };
  store.setOwner(original);
  const hook = await pauseCommit(dir);
  const commit = store.commit({ author: "a", message: "Slow commit", puts: [put("a", item())] });
  await hook.ready();
  const newer = { cursor: original.cursor, readMarks: { "item:a": original.cursor } };
  store.setOwner(newer);
  assert.deepEqual(store.snapshot().owner, newer);
  await hook.resume();
  await commit;
  assert.deepEqual(parse(await git(dir, "show", "HEAD:state/owner.yaml")), original);
  assert.deepEqual(parse(await readFile(join(dir, "state/owner.yaml"), "utf8")), newer);
  assert.deepEqual(store.snapshot().owner, newer);
  await rm(join(dir, ".git/hooks/pre-commit"));
  assert.ok(await store.flushOwner("owner"));
  assert.deepEqual(parse(await git(dir, "show", "HEAD:state/owner.yaml")), newer);
});

test("setOwner of defaults during the first commit still creates a pending owner file", async t => {
  const { dir, store } = await setup(t);
  const hook = await pauseCommit(dir);
  const commit = store.commit({ author: "a", message: "Slow first commit", puts: [put("a", item())] });
  await hook.ready();
  store.setOwner({});
  await hook.resume(); await commit;
  assert.deepEqual(parse(await readFile(join(dir, "state/owner.yaml"), "utf8")), {});
  await rm(join(dir, ".git/hooks/pre-commit"));
  const reopened = await Store.open(dir);
  assert.ok(await reopened.flushOwner("owner"));
  assert.deepEqual(parse(await git(dir, "show", "HEAD:state/owner.yaml")), {});
});

test("open reports every invalid file, including YAML syntax and filename errors", async t => {
  const { dir } = await setup(t);
  await writeFile(join(dir, "items/bad.yaml"), "title: 42\nrev: 0\n");
  await writeFile(join(dir, "notes/bad.yaml"), "text: [unterminated\n");
  await writeFile(join(dir, "decisions/$bad.yaml"), "{}\n");
  await assert.rejects(Store.open(dir), (error: unknown) => {
    assert.ok(error instanceof ValidationError);
    for (const path of ["items/bad.yaml", "notes/bad.yaml", "decisions/$bad.yaml"]) assert.ok(error.message.includes(path));
    return true;
  });
});

test("log/diff/show reproduce commits, author, multiline messages, paths and deletion history", async t => {
  const { store } = await setup(t);
  const initial = store.snapshot().head;
  const first = await store.commit({ author: "History Session", message: "Create\n\nDetailed message", puts: [put("a", item())] });
  const second = await store.commit({ author: "History Session", message: "Update", puts: [put("a", item("Updated"), 1)] });
  await store.commit({ author: "History Session", message: "Delete", deletes: [{ kind: "item", id: "a", expectRev: 2 }] });
  const log = await store.log({ kind: "item", id: "a", since: initial });
  assert.equal(log.length, 3);
  assert.deepEqual(log[2]!.files, ["items/a.yaml"]);
  assert.equal(log[2]!.message, "Create\n\nDetailed message");
  assert.equal(log[2]!.author, "History Session");
  assert.match(log[2]!.at, /Z$/);
  assert.equal((await store.log({ since: first.commit, limit: 1 }))[0]!.commit, store.snapshot().head);
  assert.equal((await store.log({ since: "2000-01-01T00:00:00Z" })).length, 4);
  assert.equal((await store.log({ since: "2999-01-01T00:00:00Z" })).length, 0);
  assert.deepEqual(await store.show("item", "a", first.commit), Item.parse({ ...item(), rev: 1 }));
  assert.equal(await store.show("item", "a", initial), null);
  assert.equal(await store.show("item", "a", "HEAD"), null);
  const diff = await store.diff("item", "a", first.commit, second.commit);
  assert.match(diff, /\+title: Updated/); assert.match(diff, /\+rev: 2/);
  await assert.rejects(store.show("item", "a", "does-not-exist"));
  assert.equal(await store.push(), false);
});

test("show returns a past document as written, including a field the current schema dropped", async t => {
  const { dir, store } = await setup(t);
  const first = await store.commit({ author: "History Session", message: "Create", puts: [put("a", item())] });
  // An older schema's field, written outside the store as a past schema's writer would have.
  const path = join(dir, "items/a.yaml");
  await writeFile(path, (await readFile(path, "utf8")) + "short: Old label\n");
  await git(dir, "commit", "-qam", "Old schema field", "--author", "Old <old@wf-board.invalid>");
  const old = await git(dir, "rev-parse", "HEAD");
  await git(dir, "revert", "--no-edit", "HEAD");
  const reopened = await Store.open(dir);
  assert.deepEqual(await reopened.show("item", "a", old), { ...Item.parse({ ...item(), rev: 1 }), short: "Old label" });
  assert.deepEqual(await reopened.show("item", "a", first.commit), Item.parse({ ...item(), rev: 1 }));
});

test("push sends an ahead branch to origin and skips an up-to-date branch", async t => {
  const { dir, store } = await setup(t);
  const remote = join(dir, "remote.git");
  await mkdir(remote);
  await git(remote, "init", "--bare", "-b", "main");
  await git(dir, "remote", "add", "origin", remote);
  assert.equal(await store.push(), true);
  assert.equal(await store.push(), false);
  await store.commit({ author: "a", message: "Ahead", puts: [put("a", item())] });
  assert.equal(await store.push(), true);
  assert.equal(await git(remote, "rev-parse", "main"), store.snapshot().head);
  const other = join(dir, "other-clone");
  await git(dir, "clone", remote, other);
  await git(other, "-c", "user.name=Other", "-c", "user.email=other@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Origin advanced elsewhere");
  await git(other, "push", "origin", "main");
  const localHead = store.snapshot().head;
  assert.equal(await store.push(), false);
  assert.equal(await git(dir, "rev-parse", "HEAD"), localHead);
});

test("inHistory accepts HEAD and its ancestors only; unpushed counts commits origin lacks", async t => {
  const { dir, store } = await setup(t);
  const first = store.snapshot().head;
  await store.commit({ author: "a", message: "Second", puts: [put("a", item())] });
  const second = store.snapshot().head;
  assert.equal(await store.inHistory(first), first);
  assert.equal(await store.inHistory(second.slice(0, 12)), second);
  assert.equal(await store.inHistory("f".repeat(40)), null);
  await git(dir, "branch", "side", first);
  await git(dir, "checkout", "-q", "side");
  await git(dir, "-c", "user.name=O", "-c", "user.email=o@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "Off the history");
  const side = await git(dir, "rev-parse", "HEAD");
  await git(dir, "checkout", "-q", "main");
  assert.equal(await store.inHistory(side), null);
  assert.equal(await store.unpushed(), 0, "no remote");
  const remote = await mkdtemp(join(tmpdir(), "wf-board-remote-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await git(remote, "init", "-q", "--bare", "-b", "main");
  await git(dir, "remote", "add", "origin", remote);
  assert.equal(await store.unpushed(), 2, "never pushed: every commit");
  await store.push();
  assert.equal(await store.unpushed(), 0);
  await store.commit({ author: "a", message: "Third", puts: [put("b", item())] });
  assert.equal(await store.unpushed(), 1);
});

test("init starts a board in an existing git repository without one, and refuses a non-empty plain directory", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-existing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await git(dir, "init", "-q", "-b", "main");
  await mkdir(join(dir, "import"));
  await writeFile(join(dir, "import/export.json"), "{}\n");
  await git(dir, "add", "import");
  await git(dir, "-c", "user.name=O", "-c", "user.email=o@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Provenance");
  const store = await Store.open(dir, { init: true, board: { title: "Board" } });
  assert.equal(store.snapshot().board.title, "Board");
  assert.equal(await git(dir, "rev-list", "--count", "HEAD"), "2");
  assert.equal(await readFile(join(dir, "import/export.json"), "utf8"), "{}\n");
  const plain = await mkdtemp(join(tmpdir(), "wf-board-plain-"));
  t.after(() => rm(plain, { recursive: true, force: true }));
  await writeFile(join(plain, "stray.txt"), "x");
  await assert.rejects(Store.open(plain, { init: true, board: { title: "Board" } }), /neither empty nor a git repository/);
});


test("R1 case aliases are refused before disk writes, including aliases in a single transaction", async t => {
  const { store, dir } = await setup(t);
  const documents = {
    item: item(),
    decision: { item: "A", question: "Q", background: "B", options: [{ key: "A", text: "A" }], status: "open", updated: at },
    note: { target: "it:A", kind: "comment", text: "N", at, state: "sent" },
  } as const;
  for (const kind of ["item", "decision", "note"] as const) {
    await store.commit({ author: "test", message: "Upper", puts: [{ kind, id: "A", doc: documents[kind], expectRev: null }] });
    const before = store.snapshot();
    await assert.rejects(store.commit({ author: "test", message: "Alias", puts: [{ kind, id: "a", doc: documents[kind], expectRev: null }] }), /ID a conflicts with A/);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    await assert.rejects(store.commit({ author: "test", message: "Batch aliases", puts: ["B", "b"].map(id => ({ kind, id, doc: documents[kind], expectRev: null })) }), /B.*b|b.*B/);
    assert.deepEqual(store.snapshot(), before);
  }
});

test("project schema defaults, uniqueness and nonempty configuration", async () => {
  const { Board } = await import("../src/model.ts");
  assert.deepEqual(Board.parse({ title: "Old board" }).projects, []);
  for (const projects of [[{ name: "P", agents: [] }], [{ name: "P", agents: ["a", "b"], repo: "Org/P" }]]) {
    const parsed = Board.safeParse({ title: "Board", projects });
    assert.equal(parsed.success, false, "past project agents are refused as unknown fields");
    if (!parsed.success) assert.ok(parsed.error.issues.some(i => i.code === "unrecognized_keys" && i.keys.includes("agents")));
  }
  assert.deepEqual(Board.parse({ title: "Board", projects: [{ name: "P", repo: "Org/P" }, { name: "Q" }] }).projects, [{ name: "P", repo: "Org/P" }, { name: "Q" }]);
  for (const projects of [[{ name: "P" }, { name: "P" }], [{ name: "" }], [{ name: "P", repo: "" }]]) assert.equal(Board.safeParse({ title: "Board", projects }).success, false);
});

test("history queries honor an explicit upper revision and reject an unknown bound", async t => {
  const { store } = await setup(t), initial = store.snapshot().head;
  const first = await store.commit({ author: "History Session", message: "First", puts: [put("a", item())] });
  const second = await store.commit({ author: "History Session", message: "Second", puts: [put("a", item("Changed"), 1)] });
  assert.deepEqual((await store.log({ since: initial, at: first.commit })).map(c => c.commit), [first.commit]);
  assert.equal((await store.log({ at: first.commit }))[0]!.commit, first.commit);
  assert.deepEqual((await store.log({ since: "2000-01-01T00:00:00Z", at: first.commit })).map(c => c.commit), [first.commit, initial]);
  assert.equal(await store.inHistory(second.commit, first.commit), null);
  assert.equal(await store.inHistory(initial, first.commit), initial);
  await assert.rejects(store.log({ at: "not-a-revision" }));
  assert.equal(await store.inHistory(initial, "not-a-revision"), null);
  assert.equal((await store.log())[0]!.commit, second.commit, "the default still follows HEAD");
});

test("startup renames coordinator identity once without changing free text", async t => {
  const { store, dir } = await setup(t);
  const prose = "跨项目、跨项目依赖和前缀跨项目后缀都保留。\n第二行。";
  const seed = await store.commit({ author: "跨项目", message: "Seed legacy coordinator", board: {
    title: prose, eyebrow: prose, goal: prose, projects: [{ name: "跨项目", repo: "Org/Board" }, { name: "Other" }],
  }, puts: [
    put("area", { ...item(prose, prose), group: "跨项目", data: prose, ask: { text: prose }, log: [{ at, by: "跨项目", text: prose }, { at, by: "前缀跨项目后缀", text: prose }] }),
    put("request", { ...item(prose, prose), group: "Other", request: { by: "跨项目", at }, log: [{ at, by: "跨项目", text: prose }] }),
    { kind: "decision", id: "card", expectRev: null, doc: { item: "area", question: prose, background: prose, options: [{ key: "A", text: prose }], status: "ruled", ruling: prose, updated: at } },
    { kind: "note", id: "reply", expectRev: null, doc: { target: "q:card", kind: "comment", text: prose, reply: prose, repliedBy: "跨项目", repliedAt: at, at, state: "done" } },
    { kind: "notice", id: "news", expectRev: null, doc: { text: prose, author: "跨项目", at } },
    { kind: "glossary", id: "跨项目", expectRev: null, doc: { terms: [{ term: "跨项目依赖", definition: prose, by: "跨项目", updated: at }] } },
    { kind: "glossary", id: "Other", expectRev: null, doc: { terms: [{ term: "跨项目", definition: prose, by: "跨项目", updated: at }] } },
  ] });
  const before = store.snapshot();
  const migrated = await Store.open(dir), after = migrated.snapshot();
  const expected = structuredClone(before);
  expected.board.projects[0]!.name = "总管";
  expected.items.area!.group = "总管";
  expected.items.area!.log[0]!.by = "总管";
  expected.items.area!.rev++;
  expected.items.request!.request!.by = "总管";
  expected.items.request!.log[0]!.by = "总管";
  expected.items.request!.rev++;
  expected.notes.reply!.repliedBy = "总管";
  expected.notes.reply!.rev++;
  expected.notices.news!.author = "总管";
  expected.notices.news!.rev++;
  expected.glossaries["总管"] = expected.glossaries["跨项目"]!;
  delete expected.glossaries["跨项目"];
  expected.glossaries["总管"]!.terms[0]!.by = "总管";
  expected.glossaries.Other!.terms[0]!.by = "总管";
  expected.glossaries.Other!.rev++;
  expected.head = after.head;
  expected.activity = after.activity;
  assert.deepEqual(after, expected, "all prose and unrelated identity strings remain byte-for-byte identical");
  const commits = await migrated.log({ since: seed.commit });
  assert.equal(commits.length, 1);
  assert.equal(commits[0]!.author, "总管");
  assert.equal(commits[0]!.message, "Rename coordinator project 跨项目 to 总管");
  assert.ok(commits[0]!.files.includes("glossaries/跨项目.yaml"));
  assert.ok(commits[0]!.files.includes("glossaries/总管.yaml"));
  await assert.rejects(readFile(join(dir, "glossaries/跨项目.yaml")), { code: "ENOENT" });
  assert.equal((await migrated.show("item", "area", seed.commit) as { group: string }).group, "跨项目", "history is not rewritten");
  assert.deepEqual((await Store.open(dir)).snapshot(), after, "reopening performs no second migration");
  assert.equal(await git(dir, "rev-parse", "HEAD"), after.head);
});

test("startup coordinator rename refuses destination project and glossary collisions without changing data", async t => {
  for (const collision of ["project", "glossary"] as const) {
    const { store, dir } = await setup(t);
    await store.commit({ author: "Fixture", message: "Conflicting coordinator", board: { title: "Board", projects: [{ name: "跨项目" }, ...(collision === "project" ? [{ name: "总管" }] : [])] }, puts: collision === "glossary" ? [{ kind: "glossary", id: "总管", expectRev: null, doc: { terms: [] } }] : [] });
    const before = store.snapshot(), bytes = await readFile(join(dir, "board.yaml"));
    await assert.rejects(Store.open(dir), /Cannot rename coordinator project 跨项目 to 总管: destination project or glossary already exists/);
    assert.equal(await git(dir, "rev-parse", "HEAD"), before.head);
    assert.deepEqual(await readFile(join(dir, "board.yaml")), bytes);
    assert.equal(await git(dir, "status", "--porcelain"), "");
  }
});

test("activity retains every content revision and deletion across restart, but excludes owner reading writes", async t => {
  const { store, dir } = await setup(t);
  const initialCount = store.snapshot().activity!.writes.length;
  // This file's tests run serially. Give each witness a distinct git time so
  // missing a reset fails even when all commits finish in the same second.
  async function content(txn: Parameters<typeof store.commit>[0], date: string) {
    const previous = process.env.GIT_AUTHOR_DATE;
    process.env.GIT_AUTHOR_DATE = date.replace(/\.000Z$/, "Z");
    try { return await store.commit(txn); }
    finally {
      if (previous === undefined) delete process.env.GIT_AUTHOR_DATE;
      else process.env.GIT_AUTHOR_DATE = previous;
    }
  }
  const createdAt = "2026-10-12T01:00:00.000Z", noteAt = "2026-10-12T01:10:00.000Z", moveAt = "2026-10-12T01:20:00.000Z";
  const deleteAt = "2026-10-12T01:30:00.000Z", deleteNoteAt = "2026-10-12T01:40:00.000Z";
  await content({ author: "Fixture", message: "Create activity witnesses", puts: [put("constructor", item()), put("b", item()),
    { kind: "decision", id: "card", expectRev: null, doc: { item: "constructor", question: "Q", background: "B", options: [{ key: "A", text: "A" }], status: "open", updated: at } },
    { kind: "note", id: "note", expectRev: null, doc: { target: "q:card", kind: "comment", text: "N", at, state: "draft" } },
  ] }, createdAt);
  const note = store.snapshot().notes.note!;
  await content({ author: "Fixture", message: "Replace note without changing its field timestamp", puts: [{ kind: "note", id: "note", expectRev: note.rev, doc: { ...note, text: "Changed" } }] }, noteAt);
  assert.equal(store.snapshot().activity!.items.constructor, noteAt, "a note edit resets its item even when the note's timestamp is unchanged");
  assert.equal(store.snapshot().notes.note!.at, at);
  const card = store.snapshot().decisions.card!;
  await content({ author: "Fixture", message: "Move card", puts: [{ kind: "decision", id: "card", expectRev: card.rev, doc: { ...card, item: "b" } }] }, moveAt);
  assert.equal(store.snapshot().activity!.items.constructor, moveAt, "moving a card resets its old item");
  assert.equal(store.snapshot().activity!.items.b, moveAt, "moving a card resets its new item");
  await content({ author: "Fixture", message: "Delete card", deletes: [{ kind: "decision", id: "card", expectRev: 2 }] }, deleteAt);
  assert.equal(store.snapshot().activity!.items.b, deleteAt);
  await content({ author: "Fixture", message: "Delete orphan card note", deletes: [{ kind: "note", id: "note", expectRev: 2 }] }, deleteNoteAt);
  const beforeRead = store.snapshot().activity!;
  assert.equal(beforeRead.writes.length, initialCount + 5, "overwritten/deleted content leaves all write timestamps");
  const history = await store.log();
  assert.equal(beforeRead.items.b, history[0]!.at, "a later note deletion resets its deleted card's last owner");
  assert.equal(beforeRead.items.b, deleteNoteAt);
  assert.ok(Object.hasOwn(beforeRead.items, "constructor"), "legal prototype-named keys have own last-change entries");
  store.setOwner({ readMarks: { "item:constructor": store.snapshot().head } });
  await store.flushOwner("owner");
  assert.deepEqual(store.snapshot().activity, beforeRead);
  const reopened = await Store.open(dir);
  assert.deepEqual(reopened.snapshot().activity, beforeRead, "the activity index can be recovered solely from git history");
});

test("effective pause intervals survive resume and restart with sub-second owner times and independent child pauses", async t => {
  const { store, dir } = await setup(t);
  const owns = (id: string) => ({ id, item: id, own: true });
  await store.commit({ author: "Fixture", message: "Nested work", puts: [
    put("root", { ...item("Root"), plan: [owns("child"), ...item().plan] }),
    put("child", { ...item("Child"), plan: [owns("leaf"), ...item().plan] }), put("leaf", item("Leaf")),
  ] });
  const pausedAt = "2026-10-11T02:00:00.125Z", childAt = "2026-10-11T02:05:00.250Z";
  const rootResume = "2026-10-11T02:10:00.375Z", childResume = "2026-10-11T02:20:00.500Z";
  async function pause(id: string, time: string, enabled: boolean) {
    const current = store.snapshot().items[id]!, doc = structuredClone(current);
    doc.updated = time;
    if (enabled) doc.paused = { reason: "Owner chose to wait", at: time }; else delete doc.paused;
    await store.commit({ author: "总管", message: enabled ? "Pause" : "Resume", puts: [put(id, doc, current.rev)] });
  }
  await pause("root", pausedAt, true);
  const open = { root: [{ start: pausedAt }], child: [{ start: pausedAt }], leaf: [{ start: pausedAt }] };
  assert.deepEqual(store.snapshot().activity!.pauses, open, "every inherited clock stops at the owner action's time");
  await pause("child", childAt, true);
  assert.deepEqual(store.snapshot().activity!.pauses, open, "a nearer pause source does not split an already paused interval");
  await pause("root", rootResume, false);
  assert.deepEqual(store.snapshot().activity!.pauses, { ...open, root: [{ start: pausedAt, end: rootResume }] });
  assert.deepEqual((await Store.open(dir)).snapshot().activity!.pauses, store.snapshot().activity!.pauses, "restart recovers still-open inherited pauses");
  await pause("child", childResume, false);
  const expected = { root: [{ start: pausedAt, end: rootResume }], child: [{ start: pausedAt, end: childResume }], leaf: [{ start: pausedAt, end: childResume }] };
  assert.deepEqual(store.snapshot().activity!.pauses, expected);
  assert.deepEqual((await Store.open(dir)).snapshot().activity!.pauses, expected, "the last resume cannot erase historical paused time");
});

test("moving under and out of an already paused owner freezes only the inherited interval after the move", async t => {
  const { store, dir } = await setup(t);
  const owns = (id: string) => ({ id, item: id, own: true });
  await store.commit({ author: "Fixture", message: "Two owners", puts: [
    put("active", { ...item("Active"), plan: [owns("child"), ...item().plan] }), put("paused", item("Paused")),
    put("child", { ...item("Child"), plan: [owns("leaf"), ...item().plan] }), put("leaf", item("Leaf")),
  ] });
  const pauseAt = "2026-10-11T03:00:00.125Z", movedInAt = "2026-10-11T03:10:00.250Z", movedOutAt = "2026-10-11T03:20:00.375Z";
  const owner = store.snapshot().items.paused!;
  await store.commit({ author: "总管", message: "Pause second owner", puts: [put("paused", { ...owner, paused: { reason: "Deferred", at: pauseAt }, updated: pauseAt }, owner.rev)] });
  async function move(from: string, to: string, time: string) {
    const source = store.snapshot().items[from]!, target = store.snapshot().items[to]!;
    await store.commit({ author: "Fixture", message: "Move work", puts: [
      put(from, { ...source, updated: time, plan: source.plan.filter(row => !("item" in row && row.item === "child")) }, source.rev),
      put(to, { ...target, updated: time, plan: [owns("child"), ...target.plan] }, target.rev),
    ] });
  }
  await move("active", "paused", movedInAt);
  assert.deepEqual(store.snapshot().activity!.pauses!.child, [{ start: movedInAt }], "moving into an old pause does not backdate the child's clock");
  assert.deepEqual(store.snapshot().activity!.pauses!.leaf, [{ start: movedInAt }]);
  await move("paused", "active", movedOutAt);
  const expected = { paused: [{ start: pauseAt }], child: [{ start: movedInAt, end: movedOutAt }], leaf: [{ start: movedInAt, end: movedOutAt }] };
  assert.deepEqual(store.snapshot().activity!.pauses, expected);
  assert.deepEqual((await Store.open(dir)).snapshot().activity!.pauses, expected);
});

test("pause replay reads only native items from the first pause onward and never normalizes historical snapshots", async t => {
  const { store } = await setup(t);
  await store.commit({ author: "Fixture", message: "Old native work", puts: [put("root", item())] });
  const beforePause = store.snapshot().head;
  const internals = store as unknown as {
    readAt(path: string, commit: string): Promise<unknown | null>;
    comparisonSnapshot(commit: string): Promise<unknown>;
    loadActivity(): Promise<void>;
  };
  const originalRead = internals.readAt.bind(store), reads: Array<{ path: string; commit: string }> = [];
  t.mock.method(internals, "readAt", async (path: string, commit: string) => { reads.push({ path, commit }); return originalRead(path, commit); });
  t.mock.method(internals, "comparisonSnapshot", async () => { throw new Error("Whole historical snapshots must not be normalized for pause clocks"); });
  await internals.loadActivity();
  assert.deepEqual(reads, [], "boards without a pause need no historical item bodies");
  const pausedAt = "2026-10-11T04:00:00.125Z", resumeAt = "2026-10-11T04:10:00.250Z";
  let root = store.snapshot().items.root!;
  const pauseCommit = await store.commit({ author: "总管", message: "First pause", puts: [put("root", { ...root, paused: { reason: "Deferred", at: pausedAt }, updated: pausedAt }, root.rev)] });
  root = store.snapshot().items.root!;
  const resumed = structuredClone(root); delete resumed.paused; resumed.updated = resumeAt;
  const resumeCommit = await store.commit({ author: "总管", message: "Resume", puts: [put("root", resumed, root.rev)] });
  reads.length = 0;
  await internals.loadActivity();
  assert.deepEqual(store.snapshot().activity!.pauses, { root: [{ start: pausedAt, end: resumeAt }] });
  assert.deepEqual(reads, [{ path: "items/root.yaml", commit: pauseCommit.commit }, { path: "items/root.yaml", commit: resumeCommit.commit }]);
  // deepEqual above narrows `reads` to never[]; widen it back for the check.
  assert.equal((reads as Array<{ path: string; commit: string }>).some(read => read.commit === beforePause), false);
});

test("a failed pause resume cannot alter historical intervals or published state", async t => {
  const { store } = await setup(t);
  const pausedAt = "2026-10-11T05:00:00.125Z";
  await store.commit({ author: "总管", message: "Initially paused work", puts: [put("root", { ...item(), paused: { reason: "Deferred", at: pausedAt }, updated: pausedAt })] });
  const before = store.snapshot(), root = before.items.root!, resumed = structuredClone(root);
  delete resumed.paused; resumed.updated = "2026-10-11T05:10:00.250Z";
  const internals = store as unknown as { git(args: string[], author?: string): Promise<string> };
  const originalGit = internals.git.bind(store);
  t.mock.method(internals, "git", async (args: string[], author?: string) => {
    if (args.includes("commit")) throw new Error("Synthetic commit failure");
    return originalGit(args, author);
  });
  await assert.rejects(store.commit({ author: "总管", message: "Failed resume", puts: [put("root", resumed, root.rev)] }), /Synthetic commit failure/);
  assert.strictEqual(store.snapshot(), before);
  assert.deepEqual(store.snapshot().activity!.pauses, { root: [{ start: pausedAt }] });
});

test("pause replay tolerates historical schema changes and logs unreadable item blobs", async t => {
  const { store } = await setup(t);
  await store.commit({ author: "Fixture", message: "Ownership", puts: [
    put("root", { ...item(), plan: [{ id: "child", item: "child", own: true }, ...item().plan] }),
    put("child", item()), put("unreadable", item()),
  ] });
  const pausedAt = "2026-10-11T06:00:00.125Z", resumedAt = "2026-10-11T06:10:00.250Z";
  let root = store.snapshot().items.root!;
  const paused = await store.commit({ author: "总管", message: "Pause", puts: [put("root", { ...root, paused: { reason: "Deferred", at: pausedAt }, updated: pausedAt }, root.rev)] });
  root = store.snapshot().items.root!;
  const resumed = structuredClone(root); delete resumed.paused; resumed.updated = resumedAt;
  await store.commit({ author: "总管", message: "Resume", puts: [put("root", resumed, root.rev)] });
  const internals = store as unknown as { readAt(path: string, commit: string): Promise<unknown | null>; loadActivity(): Promise<void> };
  const original = internals.readAt.bind(store), warnings: string[] = [];
  t.mock.method(console, "warn", (...parts: unknown[]) => { warnings.push(parts.join(" ")); });
  t.mock.method(internals, "readAt", async (path: string, commit: string) => {
    if (commit === paused.commit && path === "items/unreadable.yaml") throw new Error("Malformed historical YAML");
    const raw = await original(path, commit);
    if (commit !== paused.commit || !raw || typeof raw !== "object") return raw;
    if (path === "items/root.yaml") return { ...raw, futureField: { ignored: true } };
    if (path === "items/child.yaml") return { ...raw, plan: { malformed: true } };
    return raw;
  });
  await internals.loadActivity();
  assert.deepEqual(store.snapshot().activity!.pauses, {
    root: [{ start: pausedAt, end: resumedAt }], child: [{ start: pausedAt, end: resumedAt }],
  }, "readable ownership and pause timestamps survive unknown fields and malformed plans");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Skipping unreadable pause history item .*:items\/unreadable\.yaml/);
});

test("pause history marker skips repeat pickaxe scans on never-paused boards and survives restart", async t => {
  const { store, dir } = await setup(t);
  await store.commit({ author: "Fixture", message: "Ordinary work", puts: [put("root", item())] });
  const internals = store as unknown as { git(args: string[], author?: string): Promise<string>; loadActivity(): Promise<void> };
  const original = internals.git.bind(store), scans: string[][] = [];
  t.mock.method(internals, "git", async (args: string[], author?: string) => {
    if (args.includes("-G")) scans.push(args);
    return original(args, author);
  });
  await internals.loadActivity();
  assert.equal(scans.length, 0, "a known never-paused history needs no pickaxe");
  const restarted = await Store.open(dir);
  const reopened = restarted as unknown as typeof internals;
  const originalReopened = reopened.git.bind(restarted);
  t.mock.method(reopened, "git", async (args: string[], author?: string) => {
    assert.ok(!args.includes("-G"), "the on-disk marker must survive restart");
    return originalReopened(args, author);
  });
  await reopened.loadActivity();
  assert.equal(restarted.snapshot().activity?.pauses, undefined);
  assert.equal(await git(dir, "status", "--porcelain"), "", "the disposable index is not board content");
});

test("missing pause history markers recover completed intervals and rewinds invalidate cached heads", async t => {
  const { store, dir } = await setup(t);
  await store.commit({ author: "Fixture", message: "Work", puts: [put("root", item())] });
  const unpausedHead = store.snapshot().head;
  const pausedAt = "2026-10-11T07:00:00.125Z", resumedAt = "2026-10-11T07:10:00.250Z";
  let root = store.snapshot().items.root!;
  await store.commit({ author: "总管", message: "Pause", puts: [put("root", { ...root, paused: { reason: "Deferred", at: pausedAt }, updated: pausedAt }, root.rev)] });
  root = store.snapshot().items.root!;
  const resumed = structuredClone(root); delete resumed.paused; resumed.updated = resumedAt;
  await store.commit({ author: "总管", message: "Resume", puts: [put("root", resumed, root.rev)] });
  const markerPath = join(dir, await git(dir, "rev-parse", "--git-path", "wf-board-pause-history.yaml"));
  await rm(markerPath, { force: true });
  const reopened = await Store.open(dir);
  assert.deepEqual(reopened.snapshot().activity!.pauses, { root: [{ start: pausedAt, end: resumedAt }] }, "no current paused field does not mean there was never a pause");
  const marker = parse(await readFile(markerPath, "utf8")) as { first: string | null; head: string };
  assert.ok(marker.first);
  assert.equal(marker.head, reopened.snapshot().head);
  await git(dir, "reset", "--hard", unpausedHead);
  const rewound = await Store.open(dir);
  assert.equal(rewound.snapshot().activity?.pauses, undefined);
  assert.equal((parse(await readFile(markerPath, "utf8")) as { first: string | null }).first, null);
});

test("pause history rescans only an unindexed suffix and distrusts a negative marker with current pauses", async t => {
  const { store, dir } = await setup(t);
  await store.commit({ author: "Fixture", message: "Work", puts: [put("root", item())] });
  const knownHead = store.snapshot().head;
  const markerPath = join(dir, await git(dir, "rev-parse", "--git-path", "wf-board-pause-history.yaml"));
  const previousMarker = `version: 1\nhead: ${knownHead}\nfirst: null\n`;
  const root = store.snapshot().items.root!, pausedAt = "2026-10-11T08:00:00.125Z";
  await store.commit({ author: "总管", message: "Pause", puts: [put("root", { ...root, paused: { reason: "Deferred", at: pausedAt }, updated: pausedAt }, root.rev)] });
  const pausedRoot = store.snapshot().items.root!, resumed = structuredClone(pausedRoot); delete resumed.paused;
  resumed.updated = "2026-10-11T08:10:00.250Z";
  await store.commit({ author: "总管", message: "Resume", puts: [put("root", resumed, pausedRoot.rev)] });
  await writeFile(markerPath, previousMarker);
  const internals = store as unknown as { git(args: string[], author?: string): Promise<string>; loadActivity(): Promise<void> };
  const original = internals.git.bind(store), scans: string[][] = [];
  t.mock.method(internals, "git", async (args: string[], author?: string) => { if (args.includes("-G")) scans.push(args); return original(args, author); });
  await internals.loadActivity();
  assert.equal(scans.length, 1);
  assert.ok(scans[0]!.includes(`${knownHead}..${store.snapshot().head}`));
  assert.deepEqual(store.snapshot().activity!.pauses!.root, [{ start: pausedAt, end: resumed.updated }]);
  const latest = store.snapshot().items.root!;
  await store.commit({ author: "总管", message: "Pause again", puts: [put("root", { ...latest, paused: { reason: "Deferred", at: "2026-10-11T08:20:00.125Z" } }, latest.rev)] });
  await writeFile(markerPath, `version: 1\nhead: ${store.snapshot().head}\nfirst: null\n`);
  await internals.loadActivity();
  assert.equal(scans.length, 2, "current pauses contradict a negative cache and force recovery");
  assert.equal(store.snapshot().activity!.pauses!.root.length, 2);
});

test("an unwritable disposable pause marker cannot turn a committed pause into a failure", async t => {
  const { store, dir } = await setup(t);
  await store.commit({ author: "Fixture", message: "Work", puts: [put("root", item())] });
  const markerPath = join(dir, await git(dir, "rev-parse", "--git-path", "wf-board-pause-history.yaml"));
  await rm(markerPath, { force: true });
  await mkdir(markerPath);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...parts: unknown[]) => { warnings.push(parts.join(" ")); });
  const root = store.snapshot().items.root!, pausedAt = "2026-10-11T09:00:00.125Z";
  const result = await store.commit({ author: "总管", message: "Pause", puts: [put("root", { ...root, paused: { reason: "Deferred", at: pausedAt }, updated: pausedAt }, root.rev)] });
  assert.equal(store.snapshot().head, result.commit);
  assert.equal(await git(dir, "rev-parse", "HEAD"), result.commit);
  assert.deepEqual(store.snapshot().activity!.pauses!.root, [{ start: pausedAt }]);
  assert.ok(warnings.some(message => message.includes("Cannot save pause history cache")));
  await rm(markerPath, { recursive: true });
  assert.deepEqual((await Store.open(dir)).snapshot().activity!.pauses!.root, [{ start: pausedAt }]);
});

test("pause replay tracks historical ownership targets even when a row ID is reused", async t => {
  const { store } = await setup(t);
  const pausedAt = "2026-10-11T10:00:00.125Z", movedAt = "2026-10-11T10:10:00.250Z";
  await store.commit({ author: "Fixture", message: "Paused owner", puts: [
    put("root", { ...item(), paused: { reason: "Deferred", at: pausedAt }, updated: pausedAt,
      plan: [{ id: "first", item: "first", own: true }, ...item().plan] }),
    put("first", item()), put("second", item()),
  ] });
  const root = store.snapshot().items.root!;
  await store.commit({ author: "总管", message: "Retarget part", puts: [put("root", { ...root, updated: movedAt,
    plan: [{ id: "second", item: "second", own: true }, ...item().plan] }, root.rev)] });
  const internals = store as unknown as { readAt(path: string, commit: string): Promise<unknown | null>; loadActivity(): Promise<void> };
  const original = internals.readAt.bind(store);
  t.mock.method(internals, "readAt", async (path: string, commit: string) => {
    const raw = await original(path, commit);
    if (path !== "items/root.yaml" || !raw || typeof raw !== "object") return raw;
    const fields = raw as Item;
    return { ...fields, plan: fields.plan.map(row => "item" in row ? { ...row, id: "historical-part" } : row) };
  });
  await internals.loadActivity();
  const expected = { root: [{ start: pausedAt }], first: [{ start: pausedAt, end: movedAt }], second: [{ start: movedAt }] };
  assert.deepEqual(store.snapshot().activity!.pauses, expected);
});

test("live pause indexing projects legacy items, omitted record plans and malformed rows before deriving inheritance", async t => {
  const { store } = await setup(t);
  type Activity = NonNullable<ReturnType<Store["snapshot"]>["activity"]>;
  const internals = store as unknown as { notePauses(activity: Activity, before: Record<string, unknown>, after: Record<string, unknown>, changed: ChangedDoc[], at: string): void };
  const pausedAt = "2026-10-11T11:00:00.125Z", resumedAt = "2026-10-11T11:10:00.250Z";
  const root = { group: "P", unknownFutureField: true, plan: [null, 3, "future row", [],
    { id: "historical-part", item: "child", own: true }, { item: "unowned", own: "invalid" }] };
  const before: Record<string, unknown> = { root, child: { group: "P", status: "wip", steps: [] },
    record: { group: "P", record: true }, unowned: { group: "P", plan: { malformed: true } },
    legacy: { group: "P", status: "todo", parent: "root", deps: [] }, invalid: null, array: [], scalar: 7 };
  const paused = { ...root, paused: { reason: "Deferred", at: pausedAt } }, after = { ...before, root: paused };
  const activity: Activity = { writes: [], items: {} };
  internals.notePauses(activity, before, after, [{ kind: "item", id: "root", before: root, after: paused }], pausedAt);
  assert.deepEqual(activity.pauses, { root: [{ start: pausedAt }], child: [{ start: pausedAt }] },
    "only readable owned rows pass pause; retired parent/deps do not invent ownership");
  internals.notePauses(activity, after, before, [{ kind: "item", id: "root", before: paused, after: root }], resumedAt);
  assert.deepEqual(activity.pauses, { root: [{ start: pausedAt, end: resumedAt }], child: [{ start: pausedAt, end: resumedAt }] },
    "missing historical updated uses the commit timestamp when closing intervals");
});

test("live pause indexing accepts conversion inputs with no plan and no pause without creating intervals", async t => {
  const { store } = await setup(t);
  type Activity = NonNullable<ReturnType<Store["snapshot"]>["activity"]>;
  const internals = store as unknown as { notePauses(activity: Activity, before: Record<string, unknown>, after: Record<string, unknown>, changed: ChangedDoc[], at: string): void };
  const legacy = { group: "P", status: "wip", steps: [], deps: [], parent: "" };
  const converted = { ...item(), group: "P", unknownField: "ignored", plan: [{ id: "record", item: "record", own: true }, ...item().plan] };
  const activity: Activity = { writes: [at], items: { work: at } };
  internals.notePauses(activity, { work: legacy, record: { group: "P", record: true } },
    { work: converted, record: { group: "P", record: true } }, [{ kind: "item", id: "work", before: legacy, after: converted }], at);
  assert.deepEqual(activity, { writes: [at], items: { work: at } });
});

test("startup leaves identity references alone when no legacy coordinator project is configured", async t => {
  const { store, dir } = await setup(t);
  await store.commit({ author: "Fixture", message: "Historical authors without legacy project", puts: [put("a", { ...item(), group: "Unconfigured", log: [{ at, by: "跨项目", text: "Historical author" }] })] });
  const before = store.snapshot();
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
  assert.equal(await git(dir, "rev-parse", "HEAD"), before.head);
});
