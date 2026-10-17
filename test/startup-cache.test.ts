import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { stringify } from "yaml";
import { Store } from "../src/store.ts";
import type { CommitInfo } from "../src/store.ts";
import type { StartupStep } from "../src/log.ts";
import { StartupCache } from "../src/startup-cache.ts";

const exec = promisify(execFile);
const at = "2026-10-11T01:02:03Z";
const item = (title = "An item") => ({ title, group: "P", head: "A head", plan: [{ id: "accept", text: "Accepted", state: "todo" as const, accept: true as const }], updated: at });
const owns = (id: string) => ({ id, item: id, own: true });
const put = (id: string, doc: unknown, expectRev: number | null = null) => ({ kind: "item" as const, id, doc, expectRev });
async function git(dir: string, ...args: string[]): Promise<string> { return (await exec("git", args, { cwd: dir })).stdout.trim(); }
async function setup(t: { after(fn: () => Promise<void>): void }, opts: { cacheDelayMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store: await Store.open(dir, { init: true, board: { title: "Board" }, ...opts }) };
}
const cacheFile = async (dir: string) => join(dir, await git(dir, "rev-parse", "--git-path", "wf-board-startup-cache.json"));
const readCache = async (dir: string) => StartupCache.parse(JSON.parse(await readFile(await cacheFile(dir), "utf8")));
type Activity = NonNullable<ReturnType<Store["snapshot"]>["activity"]>;
interface Internals {
  git(args: string[], author?: string): Promise<string>;
  startupCacheContents(): StartupCache;
  loadActivity(): Promise<void>;
  loadPauses(activity: Activity, commits: CommitInfo[], prior: Record<string, unknown> | null, range: string): Promise<void>;
}
const internals = (store: Store) => store as unknown as Internals;

/** Open a board, recording the startup steps the store reports. */
async function open(dir: string, opts: Parameters<typeof Store.open>[1] = {}) {
  const steps: Array<{ step: string; detail?: string }> = [];
  const startup: StartupStep = (step, _ms, detail) => steps.push(detail === undefined ? { step } : { step, detail });
  return { store: await Store.open(dir, { ...opts, startup }), steps };
}
const refused = (steps: Array<{ step: string; detail?: string }>) => steps.find(s => s.step === "startup cache refused")?.detail;

/** A board's startup state as a cache would hold it: what two starts must agree on, field by field. */
const derived = (store: Store) => internals(store).startupCacheContents();

/** Commits with distinct, rising git times, so a commit a replay misses changes the result. */
function committer(store: Store) {
  let minute = 0;
  return async (txn: Parameters<Store["commit"]>[0]) => {
    const previous = process.env.GIT_AUTHOR_DATE;
    process.env.GIT_AUTHOR_DATE = `2026-10-12T02:${String(++minute).padStart(2, "0")}:00Z`;
    try { return await store.commit(txn); }
    finally { if (previous === undefined) delete process.env.GIT_AUTHOR_DATE; else process.env.GIT_AUTHOR_DATE = previous; }
  };
}
const stamp = (minute: number, ms: string) => `2026-10-12T02:${String(minute).padStart(2, "0")}:00.${ms}Z`;

/**
 * A history with what the activity index and the pause replay derive from: ownership, a pause set, nested and lifted,
 * a retarget under a pause, cards moved and deleted, notes on a deleted card, sessions, and an owner-only commit. The
 * startup cache is saved at several points; each is returned with the commit it is of.
 */
async function history(store: Store, dir: string) {
  const commit = committer(store);
  const points: Array<{ name: string; head: string; text: string; pause: boolean }> = [];
  async function save(name: string) {
    await store.saveStartupCache();
    const text = await readFile(await cacheFile(dir), "utf8");
    points.push({ name, head: store.snapshot().head, text, pause: StartupCache.parse(JSON.parse(text)).pause !== null });
  }
  async function pause(id: string, time: string, enabled: boolean, session: string) {
    const current = store.snapshot().items[id]!, doc = structuredClone(current);
    doc.updated = time;
    if (enabled) doc.paused = { reason: "Owner chose to wait", at: time }; else delete doc.paused;
    await commit({ author: "总管", session, message: enabled ? "Pause" : "Resume", puts: [put(id, doc, current.rev)] });
  }
  await save("empty board");
  await commit({ author: "Fixture", session: "s-a", message: "Nested work", puts: [
    put("root", { ...item("Root"), plan: [owns("child"), owns("kid"), ...item().plan] }),
    put("child", { ...item("Child"), plan: [owns("leaf"), ...item().plan] }), put("leaf", item("Leaf")), put("kid", item("Kid")), put("other", item("Other")),
  ] });
  await save("work, no pause yet");
  await pause("root", stamp(2, "125"), true, "s-a");
  await pause("child", stamp(3, "250"), true, "s-a");
  await commit({ author: "Fixture", session: "s-b", message: "Card and notes", puts: [
    { kind: "decision", id: "card", expectRev: null, doc: { item: "root", question: "Q", options: [{ key: "A", text: "A" }], status: "open", updated: at } },
    { kind: "note", id: "note-q", expectRev: null, doc: { target: "q:card", kind: "comment", text: "N", at, state: "draft" } },
    { kind: "note", id: "note-it", expectRev: null, doc: { target: "it:child", kind: "comment", text: "N", at, state: "draft" } },
  ] });
  await save("paused, card and notes");
  await pause("root", stamp(5, "375"), false, "s-a");
  const card = store.snapshot().decisions.card!, note = store.snapshot().notes["note-q"]!;
  await commit({ author: "Fixture", session: "s-b", message: "Move card, edit note", puts: [
    { kind: "decision", id: "card", expectRev: card.rev, doc: { ...card, item: "other" } },
    { kind: "note", id: "note-q", expectRev: note.rev, doc: { ...note, text: "Changed" } },
  ] });
  await commit({ author: "Fixture", message: "Delete card", deletes: [{ kind: "decision", id: "card", expectRev: store.snapshot().decisions.card!.rev }] });
  await save("card deleted, its note still there");
  await pause("root", stamp(8, "125"), true, "s-a");
  await commit({ author: "Fixture", session: "s-c", message: "Delete orphan card note", deletes: [{ kind: "note", id: "note-q", expectRev: store.snapshot().notes["note-q"]!.rev }] });
  store.setOwner({ readMarks: { "item:root": store.snapshot().head } });
  assert.ok(await store.flushOwner("owner"), "an owner-only commit lies between the content commits");
  const root = store.snapshot().items.root!;
  await commit({ author: "总管", session: "s-c", message: "Retarget the owner", puts: [put("root", { ...root, updated: stamp(10, "500"), plan: [owns("other"), owns("kid"), ...item().plan] }, root.rev)] });
  await save("retargeted under a pause");
  const leaf = store.snapshot().items.leaf!;
  await commit({ author: "Fixture", session: "s-c", message: "Touch a leaf", puts: [put("leaf", { ...leaf, head: "Changed" }, leaf.rev)] });
  await save("head");
  return points;
}

test("a cache saved at any point of the history plus the replay after it derives what the scan derives", async t => {
  const { store, dir } = await setup(t);
  const points = await history(store, dir);
  assert.deepEqual(points.map(p => p.pause), [false, false, true, true, true, true], "the cache points cover a history with no pause yet and one with pauses set, some ended and some open");
  const finalHead = store.snapshot().head;
  await rm(await cacheFile(dir));
  const scan = await open(dir);
  assert.equal(refused(scan.steps), "no startup cache file");
  const expected = scan.store.snapshot().activity!;
  // The oracle for the scan itself: the intervals and last changes the history above produces, worked out by hand.
  assert.deepEqual(expected.pauses, {
    root: [{ start: stamp(2, "125"), end: stamp(5, "375") }, { start: stamp(8, "125") }],
    kid: [{ start: stamp(2, "125"), end: stamp(5, "375") }, { start: stamp(8, "125") }],
    child: [{ start: stamp(2, "125") }], leaf: [{ start: stamp(2, "125") }],
    other: [{ start: stamp(10, "500") }],
  });
  assert.equal(expected.sessions!.leaf!.name, "s-c");
  assert.equal(expected.sessions!.child!.name, "s-b", "the note on the child came from s-b, after s-a's pause of it");
  assert.equal(expected.items.other, "2026-10-12T02:09:00.000Z", "deleting the note of the deleted card still reaches the item the card was last on");
  // The agent index by hand, from each session's commits: the last two items, newest first, ties by item id. s-b's commits
  // reached root through the card and its note, and other through the card's move; the commit with no session names no one.
  const touch = (item: string, minute: number) => ({ item, at: stamp(minute, "000") });
  assert.deepEqual(expected.agents, {
    "s-a": [touch("root", 8), touch("child", 3)],
    "s-b": [touch("other", 6), touch("root", 6)],
    "s-c": [touch("leaf", 11), touch("root", 10)],
  });
  for (const point of points) {
    await writeFile(await cacheFile(dir), point.text);
    const start = await open(dir);
    assert.equal(refused(start.steps), undefined, `${point.name}: the cache is trusted`);
    assert.ok(start.steps.some(s => s.step === "read startup cache" && s.detail === `of ${point.head.slice(0, 12)}`), `${point.name}: the replay continues from the cache's commit`);
    assert.deepEqual(start.store.snapshot(), scan.store.snapshot(), `${point.name}: the whole snapshot`);
    assert.deepEqual(derived(start.store), derived(scan.store), `${point.name}: activity, card placements and pause projections`);
  }
  assert.equal(points.at(-1)!.head, finalHead);
  // The comparison can fail: a cache that lost an entry no later commit touches replays to a different result.
  const tampered = JSON.parse(points[1]!.text);
  delete tampered.activity.items.kid;
  await writeFile(await cacheFile(dir), JSON.stringify(tampered));
  const wrong = await open(dir);
  assert.equal(refused(wrong.steps), undefined, "the tampered cache is of the current format, so it is trusted");
  assert.notDeepEqual(wrong.store.snapshot().activity, expected);
  // The same for the agent index: a session no later commit touches keeps what the cache said.
  const ghost = JSON.parse(points[1]!.text);
  ghost.activity.agents.ghost = [{ item: "leaf", at: stamp(1, "000") }];
  await writeFile(await cacheFile(dir), JSON.stringify(ghost));
  const stale = await open(dir);
  assert.equal(refused(stale.steps), undefined);
  assert.notDeepEqual(stale.store.snapshot().activity!.agents, expected.agents);
});

test("a cache that is missing, damaged, of another shape or of another history is refused and the scan runs", async t => {
  const { store, dir } = await setup(t);
  const points = await history(store, dir);
  const text = points.at(-1)!.text, good = JSON.parse(text) as Record<string, any>;
  await rm(await cacheFile(dir));
  const expected = derived((await open(dir)).store);
  const cases: Array<[string, string | null, string]> = [
    ["no file", null, "no startup cache file"],
    ["cut off", text.slice(0, text.length / 2), "startup cache malformed"],
    ["not JSON", "not json", "startup cache malformed"],
    ["another version", JSON.stringify({ ...good, version: good.version + 1 }), "startup cache malformed"],
    // Literal versions: the bump that came with the agent index must not be undone without this failing.
    ["the file the version before the agent index wrote", JSON.stringify({ ...good, version: 1, activity: (({ agents: _, ...rest }) => rest)(good.activity) }), "startup cache malformed"],
    ["version 1 with every field of this version", JSON.stringify({ ...good, version: 1 }), "startup cache malformed"],
    ["an activity field missing", JSON.stringify({ ...good, activity: (({ sessions: _, ...rest }) => rest)(good.activity) }), "startup cache malformed"],
    ["the agent index missing", JSON.stringify({ ...good, activity: (({ agents: _, ...rest }) => rest)(good.activity) }), "startup cache malformed"],
    ["an activity field it does not know", JSON.stringify({ ...good, activity: { ...good.activity, touched: {} } }), "startup cache malformed"],
    ["a top-level field it does not know", JSON.stringify({ ...good, extra: 1 }), "startup cache malformed"],
    ["a commit the repository lacks", JSON.stringify({ ...good, head: "f".repeat(40) }), "startup cache is not of an ancestor of the head"],
    ["no pause recorded though an item is paused", JSON.stringify({ ...good, pause: null }), "startup cache has no pause history but items are paused"],
  ];
  for (const [name, content, why] of cases) {
    const file = await cacheFile(dir);
    if (content === null) await rm(file, { force: true }); else await writeFile(file, content);
    const start = await open(dir);
    assert.equal(refused(start.steps), why, name);
    assert.deepEqual(derived(start.store), expected, `${name}: the scan derives what it always derived`);
    const rewritten = await readCache(dir);
    assert.equal(rewritten.head, start.store.snapshot().head, `${name}: the scan writes the cache again`);
  }
  // A history rewound behind the cache's commit, and one that went another way from it, both lose the cache.
  const lastCache = await readFile(await cacheFile(dir), "utf8");
  await git(dir, "reset", "--hard", points[2]!.head);
  const rewound = await open(dir);
  assert.equal(refused(rewound.steps), "startup cache is not of an ancestor of the head");
  assert.equal((await readCache(dir)).head, points[2]!.head);
  const branch = await committer(rewound.store)({ author: "Fixture", message: "Another way", puts: [put("elsewhere", item())] });
  await writeFile(await cacheFile(dir), lastCache);
  const diverged = await open(dir);
  assert.equal(refused(diverged.steps), "startup cache is not of an ancestor of the head");
  assert.equal(diverged.store.snapshot().head, branch.commit);
  const fresh = await readCache(dir);
  assert.equal(fresh.head, branch.commit);
  assert.ok(Object.hasOwn(fresh.activity.items, "elsewhere"));
});

test("a restart replays the commits written after the cache and none before it", async t => {
  const { store, dir } = await setup(t);
  await store.commit({ author: "Fixture", message: "Work", puts: [put("root", item())] });
  await store.saveStartupCache();
  const second = await store.commit({ author: "Fixture", message: "More work", puts: [put("second", item())] });
  const start = await open(dir);
  const git = start.steps.find(s => s.step === "read git log");
  assert.equal(git?.detail, "1 commits after the cache");
  assert.equal(start.store.snapshot().head, second.commit);
  assert.deepEqual(derived(start.store), derived(store));
});

test("a start reports each step with its time", async t => {
  const { dir } = await setup(t);
  await rm(await cacheFile(dir));
  const scan = await open(dir);
  assert.deepEqual(scan.steps.map(s => s.step), ["read documents", "check board", "number documents", "startup cache refused", "read git log", "replay activity", "replay pauses", "write startup cache"]);
  const cached = await open(dir);
  assert.deepEqual(cached.steps.map(s => s.step), ["read documents", "check board", "number documents", "read startup cache", "read git log", "replay activity", "replay pauses", "write startup cache"]);
  assert.equal(cached.steps.find(s => s.step === "read git log")!.detail, "0 commits after the cache");
});

test("documents are read once; only a board that looks retired or does not load is read again", async t => {
  const { dir } = await setup(t);
  assert.ok(!(await open(dir)).steps.some(s => s.step === "read documents again"));
  await mkdir(join(dir, "items"), { recursive: true });
  await writeFile(join(dir, "items", "broken.yaml"), "title: no group\n");
  const steps: string[] = [];
  await assert.rejects(Store.open(dir, { startup: step => steps.push(step) }), /items\/broken\.yaml/);
  assert.ok(steps.includes("read documents again"));
  await rm(join(dir, "items", "broken.yaml"));
  // An item of a retired format that the current schema would also accept (no plan, not a record) still counts as retired.
  await writeFile(join(dir, "items", "old.yaml"), stringify({ title: "Old", group: "P", status: "cancelled", updated: at, rev: 1 }));
  await git(dir, "add", "items/old.yaml");
  await git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "A retired item", "--author", "x <x@wf-board.invalid>");
  const retired: string[] = [];
  await assert.rejects(Store.open(dir, { startup: step => retired.push(step) }), /Legacy item plans require an owner-approved dry run/);
  assert.ok(retired.includes("read documents again"));
});

test("a commit schedules one cache write after the delay, and the write is of the head then", async t => {
  const { store, dir } = await setup(t, { cacheDelayMs: 30 });
  const file = await cacheFile(dir);
  assert.equal((await readCache(dir)).head, store.snapshot().head, "a scan wrote the cache at once");
  await store.commit({ author: "Fixture", message: "One", puts: [put("one", item())] });
  const two = await store.commit({ author: "Fixture", message: "Two", puts: [put("two", item())] });
  for (let waited = 0; (await readCache(dir)).head !== two.commit; waited += 20) {
    assert.ok(waited < 5000, "the cache write did not happen");
    await sleep(20);
  }
  assert.deepEqual(derived(store), await readCache(dir));
  assert.ok(file);
});

test("a cache that cannot be written only warns", async t => {
  const { store, dir } = await setup(t);
  const file = await cacheFile(dir);
  await rm(file, { force: true });
  await mkdir(file);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...parts: unknown[]) => { warnings.push(parts.join(" ")); });
  const root = store.snapshot().head;
  const result = await store.commit({ author: "Fixture", message: "Work", puts: [put("root", item())] });
  await store.saveStartupCache();
  assert.equal(store.snapshot().head, result.commit);
  assert.notEqual(result.commit, root);
  assert.equal(await git(dir, "rev-parse", "HEAD"), result.commit);
  assert.ok(warnings.some(message => message.includes("Cannot save startup cache")));
  await rm(file, { recursive: true });
  assert.deepEqual((await open(dir)).store.snapshot().activity!.items, { root: store.snapshot().activity!.items.root });
});

test("pause replay with no commits and no earlier pause asks git nothing", async t => {
  const { store } = await setup(t);
  const calls = t.mock.method(internals(store), "git", async () => { throw new Error("Nothing to replay must not query git"); });
  const activity: Activity = { writes: [], items: {} };
  await internals(store).loadPauses(activity, [], null, "HEAD");
  assert.deepEqual(activity, { writes: [], items: {} });
  assert.equal(calls.mock.callCount(), 0);
});

test("a current cache of a never-paused history needs no pickaxe, also after a restart", async t => {
  const { store, dir } = await setup(t);
  await store.commit({ author: "Fixture", message: "Ordinary work", puts: [put("root", item())] });
  await store.saveStartupCache();
  const scans: string[][] = [];
  const original = (Store.prototype as unknown as Internals).git;
  t.mock.method(Store.prototype as unknown as Internals, "git", function (this: Store, args: string[], author?: string) {
    if (args.includes("-G")) scans.push(args);
    return original.call(this, args, author);
  });
  await internals(store).loadActivity();
  const restarted = await open(dir);
  assert.equal(scans.length, 0, "a never-paused history up to a current cache is not searched again");
  assert.equal(restarted.store.snapshot().activity?.pauses, undefined);
  assert.equal(await git(dir, "status", "--porcelain"), "", "the disposable cache is not board content");
});

test("a missing cache recovers completed pause intervals, and the cache it writes tells that a pause was set", async t => {
  const { store, dir } = await setup(t);
  await store.commit({ author: "Fixture", message: "Work", puts: [put("root", item())] });
  const unpausedHead = store.snapshot().head;
  const pausedAt = "2026-10-11T07:00:00.125Z", resumedAt = "2026-10-11T07:10:00.250Z";
  let root = store.snapshot().items.root!;
  await store.commit({ author: "总管", message: "Pause", puts: [put("root", { ...root, paused: { reason: "Deferred", at: pausedAt }, updated: pausedAt }, root.rev)] });
  root = store.snapshot().items.root!;
  const resumed = structuredClone(root); delete resumed.paused; resumed.updated = resumedAt;
  await store.commit({ author: "总管", message: "Resume", puts: [put("root", resumed, root.rev)] });
  await rm(await cacheFile(dir));
  const reopened = await open(dir);
  assert.deepEqual(reopened.store.snapshot().activity!.pauses, { root: [{ start: pausedAt, end: resumedAt }] }, "no current paused field does not mean there was never a pause");
  const cache = await readCache(dir);
  assert.equal(cache.head, reopened.store.snapshot().head);
  assert.notEqual(cache.pause, null);
  await git(dir, "reset", "--hard", unpausedHead);
  const rewound = await open(dir);
  assert.equal(rewound.store.snapshot().activity?.pauses, undefined);
  assert.equal((await readCache(dir)).pause, null);
});

test("pickaxe covers only the commits after the cache, and a cache without pauses is refused while an item is paused", async t => {
  const { store, dir } = await setup(t);
  await store.commit({ author: "Fixture", message: "Work", puts: [put("root", item())] });
  const knownHead = store.snapshot().head;
  await store.saveStartupCache();
  const root = store.snapshot().items.root!, pausedAt = "2026-10-11T08:00:00.125Z";
  await store.commit({ author: "总管", message: "Pause", puts: [put("root", { ...root, paused: { reason: "Deferred", at: pausedAt }, updated: pausedAt }, root.rev)] });
  const pausedRoot = store.snapshot().items.root!, resumed = structuredClone(pausedRoot); delete resumed.paused;
  resumed.updated = "2026-10-11T08:10:00.250Z";
  await store.commit({ author: "总管", message: "Resume", puts: [put("root", resumed, pausedRoot.rev)] });
  const scans: string[][] = [];
  const original = internals(store).git.bind(store);
  t.mock.method(internals(store), "git", async (args: string[], author?: string) => { if (args.includes("-G")) scans.push(args); return original(args, author); });
  await internals(store).loadActivity();
  assert.equal(scans.length, 1);
  assert.ok(scans[0]!.includes(`${knownHead}..${store.snapshot().head}`));
  assert.deepEqual(store.snapshot().activity!.pauses!.root, [{ start: pausedAt, end: resumed.updated }]);
  const latest = store.snapshot().items.root!;
  await store.commit({ author: "总管", message: "Pause again", puts: [put("root", { ...latest, paused: { reason: "Deferred", at: "2026-10-11T08:20:00.125Z" } }, latest.rev)] });
  const negative = StartupCache.parse(JSON.parse(await readFile(await cacheFile(dir), "utf8")));
  await writeFile(await cacheFile(dir), JSON.stringify({ ...negative, head: store.snapshot().head, pause: null }));
  await internals(store).loadActivity();
  assert.equal(scans.length, 2, "current pauses contradict a cache that records none, so the history is searched whole");
  assert.equal(scans[1]![scans[1]!.indexOf("-G") + 2], store.snapshot().head);
  assert.equal(store.snapshot().activity!.pauses!.root!.length, 2);
});

/** Items alike in count, history of any length: a git history written with fast-import, whose files stay valid documents. */
async function bulkBoard(t: { after(fn: () => Promise<void>): void }, items: number, commits: number) {
  const { dir, store } = await setup(t);
  await store.commit({ author: "Fixture", message: "Seed", puts: [
    put("i0", { ...item("Item 0"), plan: [owns("i1"), owns("i2"), ...item().plan] }),
    ...Array.from({ length: items - 1 }, (_, i) => put(`i${i + 1}`, item(`Item ${i + 1}`))),
    ...Array.from({ length: 20 }, (_, i) => ({ kind: "decision" as const, id: `card${i}`, expectRev: null, doc: { item: `i${i + 1}`, question: "Q", options: [{ key: "A", text: "A" }], status: "open", updated: at } })),
    ...Array.from({ length: 30 }, (_, i) => ({ kind: "note" as const, id: `n${i}`, expectRev: null, doc: { target: `q:card${i % 20}`, kind: "comment", text: "N", at, state: "draft" } })),
  ] });
  const s = store.snapshot(), current: Record<string, unknown> = {};
  for (const [id, doc] of Object.entries(s.items)) current[`items/${id}.yaml`] = doc;
  for (const [id, doc] of Object.entries(s.decisions)) current[`decisions/${id}.yaml`] = doc;
  for (const [id, doc] of Object.entries(s.notes)) current[`notes/${id}.yaml`] = doc;
  const base = Math.floor(Date.now() / 1000) + 60, parts: Buffer[] = [];
  const text = (value: string) => Buffer.from(value);
  for (let k = 1; k <= commits; k++) {
    const when = base + k * 60, time = new Date(when * 1000).toISOString();
    const changed: string[] = [];
    const edit = (path: string, change: (doc: Record<string, unknown>) => Record<string, unknown>) => {
      const doc = change({ ...(current[path] as Record<string, unknown>) });
      current[path] = doc; changed.push(path);
    };
    if (k === 10) edit("items/i0.yaml", doc => ({ ...doc, updated: time, paused: { reason: "Owner chose to wait", at: time } }));
    else if (k === 20) edit("items/i0.yaml", doc => { const { paused: _, ...rest } = doc; return { ...rest, updated: time }; });
    else edit(`items/i${1 + (k % (items - 1))}.yaml`, doc => ({ ...doc, updated: time }));
    if (k % 10 === 0) {
      edit(`decisions/card${k % 20}.yaml`, doc => ({ ...doc, updated: time }));
      edit(`notes/n${k % 30}.yaml`, doc => ({ ...doc, text: `Note at ${time}` }));
    }
    const message = `Write ${k}\n\nSession: s${k % 7}`;
    parts.push(text(`commit refs/heads/main\nauthor Fixture <fixture@wf-board.invalid> ${when} +0000\ncommitter wf-board <wf-board@wf-board.invalid> ${when} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${k === 1 ? "from refs/heads/main^0\n" : ""}`));
    for (const path of changed) {
      const body = Buffer.from(stringify(current[path], { version: "1.2", schema: "core", lineWidth: 0, blockQuote: "literal" }));
      parts.push(text(`M 100644 inline ${path}\ndata ${body.length}\n`), body, text("\n"));
    }
  }
  const child = spawn("git", ["fast-import", "--quiet"], { cwd: dir, stdio: ["pipe", "inherit", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(`git fast-import exited with ${code}: ${stderr}`))); });
  child.stdin.end(Buffer.concat(parts));
  await done;
  await git(dir, "reset", "--hard", "-q", "HEAD");
  return dir;
}

/** The daemon as a process on `dir`, stopped with the test: how long it says it took to listen, and the lines it printed. */
async function daemon(t: { after(fn: () => Promise<void>): void }, dir: string) {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  probe.close(); await once(probe, "close");
  const child = spawn(process.execPath, [join(import.meta.dirname, "../src/main.ts")], { env: { ...process.env, WF_BOARD_DATA: dir, WF_BOARD_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  let buffer = "";
  const listening = new Promise<number>((resolve, reject) => {
    const read = (chunk: Buffer) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); lines.push(line);
        const told = /startup listening: (\d+) ms/.exec(line);
        if (told) resolve(Number(told[1]));
      }
    };
    child.stdout.on("data", read); child.stderr.on("data", read);
    child.on("exit", code => reject(new Error(`the daemon exited with ${code}:\n${lines.join("\n")}`)));
  });
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); } };
  t.after(stop);
  return { port, lines, listening, stop };
}

test("the daemon's log carries the time on every line and the time of each start-up step", async t => {
  const { dir } = await setup(t);
  const started = await daemon(t, dir);
  await started.listening;
  const health = await (await fetch(`http://127.0.0.1:${started.port}/health`)).json() as { ok: boolean };
  assert.equal(health.ok, true);
  await started.stop();
  assert.ok(started.lines.length > 5);
  for (const line of started.lines) assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /, "every line starts with its time");
  for (const step of ["read documents", "check board", "number documents", "read startup cache", "read git log", "replay activity", "replay pauses", "write startup cache", "open store", "create wake, watch and server", "listening"]) {
    assert.ok(started.lines.some(line => line.includes(`startup ${step}:`)), `the log has the step ${step}`);
  }
});

test("start-up time does not grow with the history: the same documents under ten times the commits start within twice the time", async t => {
  const items = 200, short = 400, long = 4000, rounds = 5;
  const small = await bulkBoard(t, items, short), large = await bulkBoard(t, items, long);
  const time = async (dir: string) => { const from = performance.now(); await Store.open(dir); return performance.now() - from; };
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  // The control: with no cache the start scans the history, so the same measurement must tell the two boards apart.
  for (const dir of [small, large]) await rm(await cacheFile(dir), { force: true });
  const scanSmall = await time(small), scanLarge = await time(large);
  assert.ok(scanLarge / scanSmall > 2, `a scan of ten times the history takes more than twice as long (${scanLarge.toFixed(0)} ms against ${scanSmall.toFixed(0)} ms)`);
  // The scans wrote the caches. Interleave the starts so that a slow moment of the machine falls on both boards.
  const withSmall: number[] = [], withLarge: number[] = [];
  for (let round = 0; round < rounds; round++) { withSmall.push(await time(small)); withLarge.push(await time(large)); }
  const ratio = median(withLarge) / median(withSmall);
  t.diagnostic(`${items} items; ${short} and ${long} commits; scan ${scanSmall.toFixed(0)} ms and ${scanLarge.toFixed(0)} ms (ratio ${(scanLarge / scanSmall).toFixed(2)}); with the cache, median of ${rounds} starts ${median(withSmall).toFixed(0)} ms and ${median(withLarge).toFixed(0)} ms (ratio ${ratio.toFixed(2)}); all ${withSmall.map(x => x.toFixed(0))} and ${withLarge.map(x => x.toFixed(0))}`);
  assert.ok(ratio <= 2, `with the cache, ten times the commits start in ${ratio.toFixed(2)} times the time`);
  // The same through the daemon: the time it logs from the start of the process to listening.
  const daemonSmall: number[] = [], daemonLarge: number[] = [];
  for (let round = 0; round < 3; round++) {
    for (const [dir, into] of [[small, daemonSmall], [large, daemonLarge]] as const) {
      const started = await daemon(t, dir);
      into.push(await started.listening);
      await started.stop();
    }
  }
  const daemonRatio = median(daemonLarge) / median(daemonSmall);
  t.diagnostic(`daemon, process start to listening: ${daemonSmall} ms and ${daemonLarge} ms (median ratio ${daemonRatio.toFixed(2)})`);
  assert.ok(daemonRatio <= 2, `the daemon with ten times the commits is listening in ${daemonRatio.toFixed(2)} times the time`);
  const reread = await Store.open(large);
  assert.equal(Object.keys(reread.snapshot().items).length, items);
  assert.equal(reread.snapshot().activity!.writes.length, long + 1 + 1, "the seed, the initial commit and every imported commit are in the index");
});
