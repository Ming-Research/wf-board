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
import { Store, ConflictError, ValidationError } from "../src/store.ts";

const exec = promisify(execFile);
const at = "2026-10-11T01:02:03Z";
const item = (title = "An item", head = "A head") => ({ title, head, status: "todo" as const, priority: "P1" as const, updated: at });
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store: await Store.open(dir, { init: true, board: { title: "Board" } }) };
}
async function git(dir: string, ...args: string[]): Promise<string> { return (await exec("git", args, { cwd: dir })).stdout.trim(); }
const put = (id: string, doc: unknown, expectRev: number | null = null) => ({ kind: "item" as const, id, doc, expectRev });

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
  const owner = { archived: { null: at, "1e3": at, "2026-10-11": at, yes: at, no: at } };
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
  store.setOwner({ cursor: store.snapshot().head, archived: { a: at } });
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
  store.setOwner({ cursor: head, archived: { a: at } });
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
  const state = { cursor: store.snapshot().head, archived: { a: at } };
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
  store.setOwner({ archived: {} });
  await store.commit({ author: "a", message: "First owner file", puts: [put("constructor", { ...item(), head: undefined }), put("toString", item())] });
  assert.deepEqual(parse(await git(dir, "show", "HEAD:state/owner.yaml")), { archived: {} });
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
  const original = { cursor: store.snapshot().head, archived: { a: at } };
  store.setOwner(original);
  const hook = await pauseCommit(dir);
  const commit = store.commit({ author: "a", message: "Slow commit", puts: [put("a", item())] });
  await hook.ready();
  const newer = { cursor: original.cursor, archived: { a: "2026-10-11T02:00:00Z" } };
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
  store.setOwner({ archived: {} });
  await hook.resume(); await commit;
  assert.deepEqual(parse(await readFile(join(dir, "state/owner.yaml"), "utf8")), { archived: {} });
  await rm(join(dir, ".git/hooks/pre-commit"));
  const reopened = await Store.open(dir);
  assert.ok(await reopened.flushOwner("owner"));
  assert.deepEqual(parse(await git(dir, "show", "HEAD:state/owner.yaml")), { archived: {} });
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
