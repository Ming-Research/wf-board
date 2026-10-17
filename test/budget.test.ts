import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { board, author, server, wakeSocket, appendCommits } from "./helpers.ts";
import { Store } from "../src/store.ts";
import { ops } from "../src/ops.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createHttpServer } from "../src/http.ts";
import { Wake } from "../src/wake.ts";
import * as q from "../src/query.ts";
import { Budget, BudgetError, REQUEST_LIMITS, withBudget } from "../src/budget.ts";
import type { BudgetLimits } from "../src/budget.ts";
import { ReadCache } from "../src/read-cache.ts";

/** A budget says why it stopped a request on the warning log; the tests that stop one keep that out of their output. */
const quiet = (t: TestContext) => t.mock.method(console, "warn", () => {});
const heap = (used: number, limit = 4000) => () => ({ used, limit });
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>).map(c => c.text).join("\n");
const raises = (resource: BudgetError["resource"]) => (error: unknown) => error instanceof BudgetError && error.resource === resource;

test("a budget stops a request at the bytes its range allows, the boards it may rebuild and its share of the heap, and says which", t => {
  quiet(t);
  const limits: BudgetLimits = { bytes: 100, bytesPerCommit: 10, boards: 1, heapShare: 0.75 };
  const bytes = new Budget("tool changes", limits, heap(0));
  bytes.readBytes(100);
  assert.throws(() => bytes.readBytes(1), error => raises("bytes")(error) && /^History budget exceeded: this tool changes read 0\.0 MB of board history, over the 0\.0 MB one request may read for this range\. Narrow the range/.test((error as Error).message));
  const ranged = new Budget("tool changes", limits, heap(0));
  ranged.allowRange(5);
  ranged.readBytes(150);
  assert.throws(() => ranged.readBytes(1), raises("bytes"), "a range of 5 commits allows 50 bytes more, no more");
  const boards = new Budget("GET /api/unread", limits, heap(0));
  boards.board();
  assert.throws(() => boards.board(), error => raises("boards")(error) && /would rebuild 2 whole old boards/.test((error as Error).message));
  new Budget("x", limits, heap(3000)).readBytes(1);
  assert.throws(() => new Budget("x", limits, heap(3001)).readBytes(1), error => raises("heap")(error) && /over 75% of its/.test((error as Error).message));
  assert.throws(() => new Budget("x", limits, heap(3001)).board(), raises("heap"));
});

test("with requireBudget a read of history that runs under no budget fails, a read under one is served, and a write needs none", async t => {
  quiet(t);
  const { dir, store: seed, op: seedOps } = await board(t);
  await seedOps.appendLog({ author, id: "a", text: "A second commit" });
  const store = await Store.open(dir, { requireBudget: true }), head = store.snapshot().head, parent = (await withBudget(new Budget("t"), () => store.log({ limit: 1 })))[0]!.parents[0]!;
  assert.equal(seed.snapshot().head, head);
  const reads: Record<string, () => Promise<unknown>> = {
    log: () => store.log(), show: () => store.show("item", "a", head), diff: () => store.diff("item", "a", parent, head), commitAt: () => store.commitAt(Date.now()),
    comparisonSnapshot: () => store.comparisonSnapshot(head), showCompared: () => store.showCompared("item", "a", head), comparisonDocuments: () => store.comparisonDocuments("item", "a", parent, head),
  };
  for (const [name, read] of Object.entries(reads)) await assert.rejects(read(), raises("none"), name);
  await withBudget(new Budget("t"), async () => { for (const read of Object.values(reads)) await read(); });
  // A second read of what the cache holds needs a budget to be asked under as well.
  for (const name of ["show", "diff"]) await assert.rejects(reads[name]!(), raises("none"), `${name} from the cache`);
  // A write runs under a budget of its own: a timer or the shutdown has none to give it.
  await ops(store).appendLog({ author, id: "a", text: "A write outside any budget" });
});

test("a read is charged to its request's budget, a whole old board counts once and is kept, and a heap over the line stops the read", async t => {
  quiet(t);
  const { dir, op } = await board(t);
  await op.appendLog({ author, id: "a", text: "A second commit" });
  const store = await Store.open(dir), head = store.snapshot().head, parent = (await store.log({ limit: 1 }))[0]!.parents[0]!;
  const limits = (change: Partial<BudgetLimits>): BudgetLimits => ({ ...REQUEST_LIMITS, ...change });
  await assert.rejects(withBudget(new Budget("t", limits({ bytes: 1, bytesPerCommit: 0 })), () => store.log()), raises("bytes"));
  await assert.rejects(withBudget(new Budget("t", limits({ bytes: 1 })), () => store.show("item", "b", parent)), raises("bytes"));
  await withBudget(new Budget("t", limits({ boards: 1 })), async () => {
    const first = await store.comparisonSnapshot(head);
    assert.equal(await store.comparisonSnapshot(head), first, "asked again, the kept board is returned and costs nothing");
    await assert.rejects(store.comparisonSnapshot(parent), raises("boards"));
  });
  const board1 = await store.comparisonSnapshot(head);
  assert.notEqual(await store.comparisonSnapshot(parent), board1, "one whole old board is kept: the other one replaced it");
  assert.notEqual(await store.comparisonSnapshot(head), board1);
  await assert.rejects(withBudget(new Budget("t", REQUEST_LIMITS, heap(4000, 4000)), () => store.comparisonSnapshot(parent)), raises("heap"));
});

test("a write that fails after it changed files is rolled back whatever its budget has left, and the caller gets the error that failed it", async t => {
  quiet(t);
  const { dir, store: seed } = await board(t);
  const store = await Store.open(dir);
  // The owner file is in the head, and the failing write also changes it.
  store.setOwner({ cursor: seed.snapshot().head });
  await ops(store).appendLog({ author, id: "a", text: "Commits the owner file" });
  store.setOwner({ cursor: store.snapshot().head });
  await writeFile(join(dir, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const before = readFileSync(join(dir, "state/owner.yaml"));
  // A budget with nothing left to read: the rollback checks whether the owner file existed at the head, which must not be charged.
  const spent: BudgetLimits = { ...REQUEST_LIMITS, bytes: 0, bytesPerCommit: 0 };
  const failure = await withBudget(new Budget("t", spent), () => ops(store).appendLog({ author, id: "a", text: "Rejected" })).then(() => undefined, (error: unknown) => error);
  assert.ok(failure instanceof Error && !(failure instanceof BudgetError), `the write failed for its own reason, got ${String(failure)}`);
  assert.deepEqual(readFileSync(join(dir, "state/owner.yaml")), before, "the owner file is back as it was");
  const gitOut = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(gitOut("rev-parse", "HEAD").trim(), store.snapshot().head, "the head is where it was");
  assert.equal(gitOut("diff", "--cached", "--name-only"), "", "nothing stays staged");
});

test("only the module that keeps the data starts git: no other source file does", () => {
  const dir = join(import.meta.dirname, "../src"), source = (file: string) => readFileSync(join(dir, file), "utf8");
  const spawners = readdirSync(dir).filter(file => file.endsWith(".ts") && /child_process/.test(source(file))).sort();
  // store.ts runs git on the data; net-git.ts runs only the commands that reach a remote (push and fetch, whose output is capped and never
  // read as history); github.ts runs gh for GitHub's checks and billing, ci-source.ts gh for the token of its requests, and notify.ts the
  // owner's notification command: none of them reads the board's history.
  assert.deepEqual(spawners, ["ci-source.ts", "github.ts", "net-git.ts", "notify.ts", "store.ts"]);
  for (const file of ["ci-source.ts", "github.ts", "notify.ts"]) assert.doesNotMatch(source(file), /["'`]git["'`]/, `${file} must not run git`);
});

test("a request that asks for too much fails alone: its caller gets the error, and the next call and the health check are served", async t => {
  quiet(t);
  const { dir, op } = await board(t);
  await op.appendLog({ author, id: "a", text: "More history" });
  const store = await Store.open(dir), small: BudgetLimits = { ...REQUEST_LIMITS, bytes: 1, bytesPerCommit: 0 };
  const http = createHttpServer({ store, ops: ops(store), ownerOps: ownerOps(store), webDir: join(import.meta.dirname, "../web"), createMcp: () => createMcpServer({ store, ops: ops(store), budget: small }), budget: small });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const get = async (path: string) => { const response = await fetch(url + path); return { status: response.status, data: await response.json() as Record<string, unknown> }; };
  // A page request that reads history: refused, with what to do.
  const unread = await get("/api/unread");
  assert.equal(unread.status, 413);
  assert.match(String(unread.data.error), /History budget exceeded: this GET \/api\/unread read .* of board history/);
  // The same service answers the next requests.
  assert.equal((await get("/health")).status, 200);
  assert.equal((await get("/api/snapshot")).status, 200);
  assert.equal((await get("/health")).data.ok, true);
  // A tool call that reads history: an error result, and the next call on the same connection is served.
  const mcp = createMcpServer({ store, ops: ops(store), budget: small }), client = new Client({ name: "Budget test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await mcp.close(); });
  const refused = await client.callTool({ name: "changes", arguments: { since: "HEAD~1" } });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /History budget exceeded: this tool changes read .* Narrow the range/);
  for (const [name, args] of [["context", { id: "a" }], ["projects", {}]] as const) assert.ok(!(await client.callTool({ name, arguments: args })).isError, name);
  assert.equal((await client.callTool({ name: "changes", arguments: { since: "HEAD~1" } })).isError, true, "the budget is per call: a second call is stopped the same way");
  // With the ordinary limits the same range is answered.
  const ordinary = createMcpServer({ store, ops: ops(store) }), second = new Client({ name: "Budget test", version: "1" }), [st2, ct2] = InMemoryTransport.createLinkedPair();
  await ordinary.connect(st2); await second.connect(ct2);
  t.after(async () => { await second.close(); await ordinary.close(); });
  assert.match(text(await second.callTool({ name: "changes", arguments: { since: "HEAD~1", detail: true } })), /item:a/);
});

test("every entry opens a budget: with requireBudget the page routes and the tools that read history run", async t => {
  const { api, store, op } = await server(t, { requireBudget: true });
  await op.appendLog({ author, id: "a", text: "More history" });
  const unread = await api("/api/unread");
  assert.equal(unread.status, 200);
  const step = (unread.data as { steps: Array<{ id: string; docs: Array<{ kind: string; id: string }> }> }).steps.at(-1)!;
  assert.equal((await api(`/api/step?id=${step.id}&kind=${step.docs[0]!.kind}&doc=${encodeURIComponent(step.docs[0]!.id)}`)).status, 200);
  const mcp = createMcpServer({ store, ops: op }), client = new Client({ name: "Entries test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await mcp.close(); });
  const calls: Array<[string, Record<string, unknown>]> = [
    ["changes", { since: "HEAD~1" }], ["history", { id: "a" }], ["diff", { id: "a", from: "HEAD~1" }], ["diff", { id: "a", from: "2999-01-01T00:00:00Z" }],
    ["append_log", { author, id: "a", text: "A write" }],
  ];
  for (const [name, args] of calls) { const result = await client.callTool({ name, arguments: args }); assert.doesNotMatch(text(result), /ran under no budget/, name); }
});

test("the timed wake reads the history under a budget of its own", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const T0 = Date.parse("2026-10-16T00:00:00Z"), half = 30 * 60_000;
  let clock = T0;
  const wake = new Wake({ now: () => clock });
  const { url, store, op } = await server(t, { now: () => clock, checkIntervalMs: 1000, wake, timedWakeMs: half, requireBudget: true });
  wake.markTimed({ at: new Date(T0).toISOString(), head: store.snapshot().head });
  await op.appendLog({ author, session: "工程师", id: "b", text: "progress" });
  const star = await wakeSocket(t, url);
  clock = T0 + half; t.mock.timers.tick(1000);
  for (let i = 0; i < 400 && !star.events().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const frame = star.events()[0]!;
  assert.equal(frame.event, "timed");
  assert.deepEqual((frame.changed as Array<{ item: string }>).map(e => e.item), ["b"]);
});

test("a time reference is resolved by git going back from the head, to the commit the history listing would give", async t => {
  const { dir, op } = await board(t);
  await op.appendLog({ author, id: "b", text: "Before the others" });
  const seed = await Store.open(dir), b = seed.snapshot().items.b!, start = Math.floor(Date.now() / 1000) + 3600;
  await appendCommits(dir, Array.from({ length: 10 }, (_, k) => ({ at: start + k * 100, message: `append_log b ${k}`, files: { "items/b.yaml": { ...b, rev: b.rev + 1 + k, updated: new Date((start + k * 100) * 1000).toISOString() } } })));
  const store = await Store.open(dir), listing = await store.log();
  const times = [0, start * 1000 - 1, start * 1000, start * 1000 + 399_999, start * 1000 + 400_000, start * 1000 + 499_999, start * 1000 + 900_000, start * 1000 + 5_000_000];
  for (const at of times) assert.equal(await store.commitAt(at), listing.find(c => Date.parse(c.at) <= at)?.commit, `at ${at}`);
  assert.equal(await store.commitAt(0), undefined);
  const listed = t.mock.method(store, "log");
  const byTime = await q.diff(store, "item", "b", new Date((start + 150) * 1000).toISOString(), new Date((start + 450) * 1000).toISOString());
  assert.equal(byTime, await q.diff(store, "item", "b", listing[8]!.commit, listing[5]!.commit));
  assert.deepEqual(listed.mock.calls.filter(call => (call.arguments[0] ?? {}).kind === undefined), [], "no listing of the whole history");
  await assert.rejects(q.diff(store, "item", "b", "1999-01-01T00:00:00Z"), /no board revision existed yet/);
});

test("a version conflict reads back only as far as the revision it was written against, and not at all for one that never existed", async t => {
  const { store, op } = await board(t);
  for (let i = 0; i < 6; i++) await op.appendLog({ author, id: "a", text: `Step ${i}` });
  const current = store.snapshot().items.a!.rev, shown = t.mock.method(store, "show");
  const conflict = (rev: number) => op.updateItem({ author, id: "a", rev, head: "Another head", reason: "Conflict" });
  await assert.rejects(conflict(current + 5), /current rev .*previous revision unavailable/);
  assert.equal(shown.mock.callCount(), 0, "a revision above the current one never existed");
  await assert.rejects(conflict(current - 1), /\+1 log/);
  assert.equal(shown.mock.callCount(), 2, "the newest version, then the one wanted");
  shown.mock.resetCalls();
  await assert.rejects(conflict(current - 4), /\+4 log/);
  assert.equal(shown.mock.callCount(), 5);
});

test("ReadCache drops the oldest reads once they weigh more than the limit or number more than the entries, keeps no failed read, and lets no evicted read remove a retry", async () => {
  const loaded: string[] = [], load = (value: string) => async () => { loaded.push(value); return value; };
  const heavy = new ReadCache<string>(10, 100, value => value.length);
  await heavy.get("a", load("aaaa")); await heavy.get("b", load("bbbb")); await heavy.get("a", load("never"));
  assert.deepEqual(loaded, ["aaaa", "bbbb"], "8 of 10, both kept");
  await heavy.get("c", load("cccc"));
  await heavy.get("b", load("never")); await heavy.get("c", load("never"));
  assert.deepEqual(loaded, ["aaaa", "bbbb", "cccc"], "12 of 10: a, the oldest, was dropped");
  await heavy.get("a", load("aaaa2"));
  assert.deepEqual(loaded.slice(3), ["aaaa2"], "a is read again, and its 5 bring the weight to 13: b is dropped");
  await heavy.get("b", load("bbbb2"));
  assert.deepEqual(loaded.slice(4), ["bbbb2"]);
  const entries: string[] = [], loadEntry = (value: string) => async () => { entries.push(value); return value; };
  const one = new ReadCache<string>(Infinity, 1, () => 0);
  await one.get("x", loadEntry("x1")); await one.get("y", loadEntry("y1")); await one.get("x", loadEntry("x2"));
  assert.deepEqual(entries, ["x1", "y1", "x2"], "one entry: each new key replaces the last");
  const failing = new ReadCache<string>(Infinity, 10, () => 0);
  await assert.rejects(failing.get("f", async () => { throw new Error("no"); }), /no/);
  assert.equal(await failing.get("f", loadEntry("f2")), "f2", "a failed read is not kept");
  let rejectEarly!: (error: Error) => void;
  const early = new ReadCache<string>(Infinity, 1, () => 0), pending = early.get("k", () => new Promise<string>((_, reject) => { rejectEarly = reject; }));
  void pending.catch(() => {});
  await early.get("j", loadEntry("j1"));
  assert.equal(await early.get("k", loadEntry("k2")), "k2");
  rejectEarly(new Error("late"));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await early.get("k", loadEntry("k3")), "k2", "the evicted read failing late did not remove the newer read of the same key");
});
