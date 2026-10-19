// The look (src/look.ts): every open work item of the board is a line of the answer or inside a count on a line, the budget of
// lines holds, a paused subtree is one line, `expand` opens what it names, and a session's second look marks what changed. The
// structure tests build the board in memory; the marks go through the tool, on a board with a repository, because they follow
// the writes. A board of the live board's size checks the count and the time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.ts";
import { ops } from "../src/ops.ts";
import { rules } from "../src/rules.ts";
import { createMcpServer } from "../src/mcp.ts";
import { Board, Decision, Item } from "../src/model.ts";
import type { Snapshot } from "../src/model.ts";
import { DEFAULT_ROWS, LookMemory, MEMORY_SESSIONS, MIN_ROWS, look, lookLines, lookText } from "../src/look.ts";
import type { LookOptions, Previous } from "../src/look.ts";
import { generateBoard } from "./e2e/board-gen.ts";
import type { Generated } from "./e2e/board-gen.ts";
import { asArchitect } from "./helpers.ts";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const NOW = Date.parse("2026-10-18T12:00:00Z");

// ---- a board in memory ----

const ACCEPT = { id: "accept", text: "验收", state: "todo", accept: true } as const;
const DONE = { state: "done", doneAt: "2026-10-17T00:00:00Z" } as const;
type Spec = { id: string; group?: string; plan?: unknown[] } & Record<string, unknown>;
/** The rows of a plan that owns these items, each free to start without waiting for the one before. */
const owns = (...ids: string[]) => ids.map(item => ({ id: item, item, own: true, after: [] as string[] }));
/** A work item gets an acceptance step unless its plan has one; a rated item raises no 缺难度 flag. Each title is its key. */
function board(specs: Spec[], projects = ["Whitefoot", "Firn", "Architect"]): Snapshot {
  const items: Record<string, Item> = {};
  for (const { id, plan = [], ...rest } of specs) {
    const record = rest.record === true, hasAccept = plan.some(row => (row as { accept?: boolean }).accept === true);
    items[id] = Item.parse({ title: id, group: "Whitefoot", updated: "2026-10-18T00:00:00Z", rev: 1, ...(record ? {} : { difficulty: 2 }), ...rest, plan: [...plan, ...(record || hasAccept ? [] : [ACCEPT])] });
  }
  return { board: Board.parse({ title: "t", projects: projects.map(name => ({ name })) }), items, decisions: {}, notes: {}, glossaries: {}, owner: {}, head: "0".repeat(40) };
}
const report = (state: string, minutesAgo: number, more: Record<string, unknown> = {}) => {
  const since = iso(NOW - minutesAgo * MIN);
  return { runner: { state, since, at: since, started: since, ...more } };
};
/** A step in progress: what makes the item's status "wip". */
const doing = [{ id: "s1", text: "做", state: "doing", since: "2026-10-18T09:00:00Z" }];

/**
 * Every kind of open work in the structure the tool reads, with the ones it does not count:
 * Whitefoot: root owns a (reported running), dep, b (waits on dep), c (not started), d (half done), p (with p1 and p2), shelf (paused,
 * with shelf-1 and shelf-2 under it), when (head with a 何时 section), fin (done) and gone (cancelled, owning lifted); bk is a record
 * holding the backlog bk-1 (reported running) and bk-2; x1 and x2 own each other, so no root reaches them. Firn: f-root owns f1 and f2
 * (reported to wait for the architect).
 */
const fixture = (): Snapshot => board([
  { id: "root", plan: owns("a", "dep", "b", "c", "d", "p", "shelf", "when", "fin", "gone") },
  { id: "a", plan: doing, ...report("running", 8, { turns: 3 }) },
  { id: "dep" },
  { id: "b", plan: [{ id: "dep", item: "dep", own: false }] },
  { id: "c" },
  { id: "d", plan: [{ id: "s1", text: "第一步", ...DONE }, { id: "s2", text: "第二步", state: "todo" }] },
  { id: "p", plan: owns("p1", "p2") },
  { id: "p1" }, { id: "p2" },
  { id: "shelf", paused: { reason: "等主人定方向", at: iso(NOW - 3 * DAY) }, plan: owns("shelf-1", "shelf-2") },
  { id: "shelf-1" }, { id: "shelf-2" },
  { id: "when", head: "**问题**：x\n\n**何时**：等 CI 迁移完以后再做。" },
  { id: "fin", plan: [{ ...ACCEPT, ...DONE }] },
  { id: "gone", status: "cancelled", plan: owns("lifted") },
  { id: "lifted" },
  { id: "bk", record: true, plan: owns("bk-1", "bk-2") },
  { id: "bk-1", ...report("running", 20, { turns: 1 }) }, { id: "bk-2" },
  { id: "x1", plan: owns("x2") }, { id: "x2", plan: owns("x1") },
  { id: "f-root", group: "Firn", plan: owns("f1", "f2") },
  { id: "f1", group: "Firn" },
  { id: "f2", group: "Firn", ...report("ask", 30, { to: "architect" }) },
]);
/** The open work items of the fixture, by hand: the oracle for the counts. The record bk, the done fin and the cancelled gone are not among them. */
const OPEN = ["root", "a", "dep", "b", "c", "d", "p", "p1", "p2", "shelf", "shelf-1", "shelf-2", "when", "lifted", "x1", "x2", "bk-1", "bk-2", "f-root", "f1", "f2"];

const view = (s: Snapshot, o: LookOptions = {}, previous?: Previous) => look(s, rules(s, NOW), NOW, o, previous);

/**
 * What the lines of an answer account for: the item lines (a line whose first field is an item's key) and the counts of items
 * hidden below a line (`下面 N 件`, and `待选池 N 件` of a pool not listed). The lines are read as text, as the caller reads them.
 */
function account(text: string, keys: ReadonlySet<string>): { rows: string[]; hidden: number; lines: number } {
  const rows: string[] = [];
  let hidden = 0;
  const lines = text.split("\n");
  for (const line of lines.slice(1)) {
    if (!/^[ *+]/.test(line)) continue;
    const first = line.slice(1).trimStart().split(" · ")[0]!;
    if (keys.has(first)) rows.push(first);
    for (const m of line.matchAll(/下面 (\d+) 件/g)) hidden += Number(m[1]);
    for (const m of line.matchAll(/待选池 (\d+) 件/g)) hidden += Number(m[1]);
  }
  return { rows, hidden, lines: lines.length };
}
/** The line of an item, or of a pool by its record's key: the mark column, the indent (two columns for each level) and then the key. */
const line = (text: string, key: string) => text.split("\n").find(l => l.slice(1).trimStart().startsWith(`${key} · `));

test("every open work item is a line or inside a count, whatever the budget, and the answer never has more lines than the budget", () => {
  const s = fixture(), keys = new Set(Object.keys(s.items));
  for (const rows of [MIN_ROWS, 12, 15, 20, 30, DEFAULT_ROWS]) {
    const text = lookText(view(s, { rows })), got = account(text, keys);
    assert.equal(got.rows.length + got.hidden, OPEN.length, `rows ${rows}: ${got.rows.length} lines and ${got.hidden} counted\n${text}`);
    assert.equal(new Set(got.rows).size, got.rows.length, `rows ${rows}: no item is listed twice`);
    for (const id of got.rows) assert.ok(OPEN.includes(id), `${id} is open work`);
    assert.ok(got.lines <= rows, `rows ${rows}: ${got.lines} lines`);
  }
  // With room for everything, every open item has a line of its own except the two under the pause, which its line counts.
  const all = account(lookText(view(s)), keys);
  assert.deepEqual([...all.rows].sort(), OPEN.filter(id => !["shelf-1", "shelf-2"].includes(id)).sort());
  assert.equal(all.hidden, 2);
});

test("the items the tree cannot reach are not lost: done and cancelled items are passed through, a cycle hangs on its project, a record is a pool", () => {
  const s = fixture(), text = lookText(view(s));
  // `lifted` is owned by a cancelled item: it hangs on root, which is below the project.
  assert.match(line(text, "lifted")!, /^ {4}lifted · lifted · 未开始/);
  assert.equal(line(text, "gone"), undefined);
  assert.equal(line(text, "fin"), undefined);
  // The cycle: x1 is listed on the project and x2 below it, x1 marked as not on the tree.
  assert.match(line(text, "x1")!, /^ {2}x1 · x1 · .* · 没挂在树上/);
  assert.match(line(text, "x2")!, /^ {4}x2 /);
  // The pool is a line of its own with its items below it, counted apart from the project's, and the project says so.
  assert.match(text, /^ {2}待选池 · bk · bk · 共 2 件：/m);
  assert.match(line(text, "bk-1")!, /^ {4}bk-1 /);
  assert.match(text, /^ Whitefoot · 共 \d+ 件：.*；待选池另 2 件$/m);
  assert.match(text.split("\n")[0]!, /没做完 21 件（待选池 2 件在内）/);
  assert.equal(account(text, new Set(Object.keys(s.items))).rows.includes("bk"), false, "a record is not an item");
});

test("a pause marker folds its subtree into one line with the reason and how long, and expand opens it", () => {
  const s = fixture(), keys = new Set(Object.keys(s.items));
  const text = lookText(view(s));
  assert.match(line(text, "shelf")!, /^ {4}shelf · shelf · 暂停 3 天：等主人定方向/);
  assert.match(line(text, "shelf")!, /下面 2 件：暂停 2/);
  assert.equal(line(text, "shelf-1"), undefined, "the items under the pause have no line");
  // A subtree whose pause comes from above is opened one level by expand, and its items say where the pause is.
  const opened = lookText(view(s, { expand: ["shelf"] }));
  assert.match(line(opened, "shelf-1")!, /^ {6}shelf-1 · shelf-1 · 暂停（随 shelf）/);
  assert.match(line(opened, "shelf-2")!, /暂停（随 shelf）/);
  const got = account(opened, keys);
  assert.equal(got.rows.length + got.hidden, OPEN.length);
});

test("expand opens the children of every item it names at once, with the items above them", () => {
  const s = fixture(), keys = new Set(Object.keys(s.items));
  // The smallest budget leaves p, the pool and the cycle's head closed...
  const plain = lookText(view(s, { rows: MIN_ROWS }));
  assert.equal(line(plain, "p1"), undefined);
  assert.equal(line(plain, "bk-1"), undefined);
  // ...and expand names them: root has to open to reach p, and the pool and the cycle's head are opened beside it.
  const text = lookText(view(s, { rows: 30, expand: ["p", "bk", "x1"] }));
  for (const id of ["root", "p", "p1", "p2", "bk-1", "bk-2", "x2"]) assert.ok(line(text, id), `${id} has a line`);
  assert.match(line(text, "p1")!, /^ {6}p1 /, "p1 is under p, which is under root");
  const got = account(text, keys);
  assert.equal(got.rows.length + got.hidden, OPEN.length);
  assert.ok(got.lines <= 30);
});

test("what expand names that does not fit is said, and the lines stay within the budget", () => {
  const specs: Spec[] = [{ id: "big", plan: owns(...Array.from({ length: 12 }, (_, i) => `k${i}`)) }, ...Array.from({ length: 12 }, (_, i) => ({ id: `k${i}` }))];
  const s = board(specs), text = lookText(view(s, { rows: MIN_ROWS, expand: ["big"] }));
  // The header, the line for what could not be done and the project leave less than the 12 lines big needs.
  assert.match(text.split("\n")[1]!, /^没展开：big（要 12 行，只剩 \d+ 行），调大 rows$/);
  assert.equal(line(text, "k0"), undefined);
  assert.ok(text.split("\n").length <= MIN_ROWS);
  assert.ok(line(lookText(view(s, { rows: 30, expand: ["big"] })), "k11"), "with the room it opens");
  // A leaf has nothing to open.
  assert.match(lookText(view(s, { expand: ["k0"] })).split("\n")[1]!, /^没有孩子可展开：k0$/);
});

test("the budget opens the subtree with something nobody holds before the one that is only being worked on", () => {
  // Two projects of the same shape: four items under a root. In Firn all four are reported; in Whitefoot one is held by nobody.
  // Ten lines are the header, the two project lines and seven more: both projects (2) and one root (4) fit, and a second root does not.
  const four = (group: string, root: string, first: string) => [
    { id: root, group, plan: owns(...[1, 2, 3, 4].map(i => `${first}${i}`)) },
    ...[1, 2, 3, 4].map(i => ({ id: `${first}${i}`, group, ...(group === "Firn" || i > 1 ? report("ci", 5) : {}) })),
  ];
  const s = board([...four("Firn", "quiet-root", "q"), ...four("Whitefoot", "loose-root", "l")], ["Firn", "Whitefoot"]);
  const text = lookText(view(s, { rows: MIN_ROWS }));
  for (const id of ["l1", "l2", "l3", "l4"]) assert.ok(line(text, id), `${id} is listed: the project with the item nobody holds is opened first\n${text}`);
  assert.equal(line(text, "q1"), undefined);
  assert.match(line(text, "quiet-root")!, /下面 4 件/);
  assert.match(line(text, "l1")!, /没人管/);
  // Where there is room for both, both open.
  const roomy = lookText(view(s, { rows: 30 }));
  assert.ok(line(roomy, "q1") && line(roomy, "l1"));
});

test("a project left out of projects is not shown or counted, and a name that is not a project is refused", () => {
  const s = fixture(), keys = new Set(Object.keys(s.items));
  const firn = lookText(view(s, { projects: ["Firn"] })), got = account(firn, keys);
  assert.equal(got.rows.length + got.hidden, 3);
  assert.match(firn.split("\n")[0]!, /^看 · Firn · 没做完 3 件/);
  assert.equal(line(firn, "root"), undefined);
  assert.throws(() => view(s, { projects: ["Nowhere"] }), /projects Nowhere: choose configured project names \(Whitefoot, Firn, Architect\)/);
  assert.throws(() => view(s, { expand: ["fin"] }), /expand fin: not an open work item/);
  assert.throws(() => view(s, { expand: ["nothing"] }), /expand nothing: not an open work item/);
  assert.throws(() => view(s, { projects: ["Firn"], expand: ["root"] }), /expand root: it is in project Whitefoot, which projects leaves out/);
  assert.equal(lookText(view(s, { projects: ["Architect"] })), "看 · Architect · 没有没做完的工作。");
});

test("a line says the status, what the runner reports with its turn, how long, and what nobody holds", () => {
  const text = lookText(view(fixture()));
  assert.match(line(text, "a")!, /^ {4}a · a · 进行中 · 跑一轮，第 3 轮 · 8 分钟/);
  assert.match(line(text, "b")!, /^ {4}b · b · 卡住 · 等条目 dep/);
  assert.match(line(text, "c")!, /^ {4}c · c · 未开始 · 没人管/);
  assert.match(line(text, "d")!, /^ {4}d · d · 停滞 · 没人管（做了一半：1\/3 行）/);
  assert.match(line(text, "f2")!, /^ {4}f2 · f2 · 未开始 · 问架构师 · 30 分钟/);
  assert.match(line(text, "bk-1")!, /跑一轮，第 1 轮 · 20 分钟/);
  // The first line sums what needs a reader: nobody holds c, d, dep, p1, p2 and the rest, and one item is being worked on.
  assert.match(text.split("\n")[0]!, /没人管 \d+ · 等太久 0 · 在做 1 /);
});

// ---- the marks, over the tool, on a board with a repository ----

async function connected(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-look-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = await Store.open(dir, { init: true, board: { title: "Synthetic board", projects: [{ name: "Whitefoot", repo: "Ming-Research/Whitefoot" }, { name: "Firn" }] } });
  const op = ops(store, () => iso(Date.now()));
  const item = (key: string, extra: Record<string, unknown> = {}) => op.createItem({ ...asArchitect, key, group: "Whitefoot", title: key, accept: "通过", difficulty: 2, ...extra } as Parameters<typeof op.createItem>[0]);
  const server = createMcpServer({ store, ops: op, looks: new LookMemory() });
  const client = new Client({ name: "t", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "look", arguments: args });
    return { error: r.isError === true, text: (r.content as Array<{ text: string }>)[0]!.text };
  };
  return { op, item, call };
}

test("a session's second look marks what changed, what is new and what finished since, including what moved without being written", async t => {
  const b = await connected(t);
  await b.item("alpha"); await b.item("beta"); await b.item("untouched"); await b.item("holder"); await b.item("dep", { owner: "holder", after: [] });
  await b.item("waiter", { plan: [{ item: "dep", own: false }] });
  const first = await b.call({ session: "s1" });
  assert.equal(first.error, false);
  assert.match(first.text.split("\n")[0]!, /这个会话头一次看（看板重启后也一样），不标变化/);
  assert.doesNotMatch(first.text, /^[*+]/m, "the first look marks nothing");
  assert.match(line(first.text, "waiter")!, /卡住/);
  // alpha is written, beta is cancelled, gamma is new, and dep is done, which moves waiter out of blocked without writing it
  // and holder (it owns dep) from not started to part way.
  await b.op.appendLog({ ...asArchitect, id: "alpha", text: "写了一条" });
  await b.op.setStatus({ ...asArchitect, id: "beta", status: "cancelled", log: "不做了" });
  await b.item("gamma");
  await b.op.setPlan({ ...asArchitect, id: "dep", row: { id: "accept", text: "通过", state: "done", accept: true } });
  const second = await b.call({ session: "s1" });
  assert.match(second.text.split("\n")[0]!, /上次看在 .*前：变了 3 件 · 新出现 1 件 · 收尾 2 件（做完、取消）/);
  assert.match(line(second.text, "alpha")!, /^\*/, "alpha was written");
  assert.match(line(second.text, "waiter")!, /^\*/, "waiter was not written, and its status moved");
  assert.doesNotMatch(line(second.text, "waiter")!, /卡住/);
  assert.match(line(second.text, "gamma")!, /^\+/, "gamma is new");
  assert.equal(line(second.text, "beta"), undefined, "beta is cancelled");
  assert.match(line(second.text, "untouched")!, /^ /, "an item that changed in no way is not marked");
  // The next look compares with the second: nothing changed.
  const third = await b.call({ session: "s1" });
  assert.match(third.text.split("\n")[0]!, /变了 0 件 · 新出现 0 件 · 收尾 0 件/);
  assert.doesNotMatch(third.text, /^[*+]/m);
  // Another session has seen nothing, and a call with no session is remembered by nobody.
  assert.match((await b.call({ session: "s2" })).text.split("\n")[0]!, /头一次看/);
  assert.match((await b.call({})).text.split("\n")[0]!, /没带 session，不标上次看以后的变化/);
  assert.match((await b.call({})).text.split("\n")[0]!, /没带 session/, "and again");
});

test("a look at one project does not hide a change in another: it is marked when that project is looked at", async t => {
  const b = await connected(t);
  await b.item("w-one"); await b.item("f-one", { group: "Firn" });
  await b.call({ session: "s1", projects: ["Whitefoot"] });
  await b.op.appendLog({ ...asArchitect, id: "f-one", text: "Firn 的改动" });
  const narrow = await b.call({ session: "s1", projects: ["Whitefoot"] });
  assert.match(narrow.text.split("\n")[0]!, /变了 0 件 · 新出现 0 件 · 收尾 0 件/, "the Firn item is not in this look");
  const all = await b.call({ session: "s1" });
  assert.match(all.text.split("\n")[0]!, /变了 1 件 · 新出现 0 件/);
  assert.match(line(all.text, "f-one")!, /^\*/);
});

test("the memory keeps the last looks of a bounded number of sessions, the newest last", () => {
  const memory = new LookMemory();
  for (let i = 0; i <= MEMORY_SESSIONS; i++) memory.set(`s${i}`, { at: i, sigs: new Map() });
  assert.equal(memory.get("s0"), undefined, "the oldest was dropped");
  assert.equal(memory.get(`s${MEMORY_SESSIONS}`)?.at, MEMORY_SESSIONS);
  // A session that looks again is the newest, so it outlives one that has not looked.
  memory.set("s1", { at: 99, sigs: new Map() });
  memory.set("late", { at: 100, sigs: new Map() });
  assert.ok(memory.get("s1"));
  assert.equal(memory.get("s2"), undefined);
});

test("the tool refuses a budget under the least and an item that is not open work, and answers within the least", async t => {
  const b = await connected(t);
  await b.item("one");
  const small = await b.call({ rows: MIN_ROWS - 1 });
  assert.equal(small.error, true);
  assert.match(small.text, /rows/);
  const missing = await b.call({ expand: ["nothing"] });
  assert.equal(missing.error, true);
  assert.match(missing.text, /expand nothing: not an open work item/);
  const least = await b.call({ rows: MIN_ROWS });
  assert.equal(least.error, false);
  assert.match(least.text, /^看 · 全部项目 · 没做完 1 件/);
});

// ---- a board of the live board's size ----

function memoryBoard(gen: Generated): Snapshot {
  const items: Record<string, Item> = {}, decisions: Record<string, Decision> = {};
  for (const batch of gen.batches) for (const put of batch.puts) {
    if (put.kind === "item") items[put.id] = Item.parse({ ...(put.doc as object), rev: (items[put.id]?.rev ?? 0) + 1 });
    else if (put.kind === "decision") decisions[put.id] = Decision.parse({ ...(put.doc as object), rev: (decisions[put.id]?.rev ?? 0) + 1 });
  }
  return { board: Board.parse(gen.board), items, decisions, notes: {}, glossaries: {}, owner: {}, head: "0".repeat(40) };
}

test("on a board of the live board's size every open item is a line or in a count, within the lines asked and in time", () => {
  const s = memoryBoard(generateBoard(1, 12));
  assert.ok(Object.keys(s.items).length > 1500, `a board of ${Object.keys(s.items).length} items`);
  // A third of the open, unpaused items get a report, so the tree has lines of several kinds.
  const r0 = rules(s, NOW), states = ["running", "ci", "ask", "items", "run", "ready", "exception", "done"] as const;
  let seen = 0;
  for (const id of Object.keys(s.items)) {
    if (!r0.isOpenWork(id) || r0.isPaused(id) || r0.isBacklog(id) || seen++ % 3 !== 0) continue;
    const state = states[Math.floor(seen / 3) % states.length]!, since = iso(NOW - (seen * 37 % 600) * MIN);
    s.items[id] = Item.parse({ ...s.items[id], runner: { state, since, at: since, started: since, ...(state === "ask" ? { to: "architect" } : state === "items" ? { items: ["x"] } : {}) } });
  }
  const keys = new Set(Object.keys(s.items)), r = rules(s, NOW);
  // The oracle: the items that are neither records nor done nor cancelled.
  const open = Object.keys(s.items).filter(id => r.isOpenWork(id)).length;
  assert.ok(open > 300, `${open} open items`);
  for (const rows of [DEFAULT_ROWS, 200]) {
    const started = performance.now(), text = lookText(look(s, rules(s, NOW), NOW, { rows }));
    const took = performance.now() - started, got = account(text, keys);
    console.info(`look of ${Object.keys(s.items).length} items, ${rows} rows: ${Math.round(took)} ms, ${text.length} characters, ${got.rows.length} item lines + ${got.hidden} counted`);
    assert.ok(took < 2000, `the look took ${Math.round(took)} ms`);
    assert.ok(got.lines <= rows, `${got.lines} lines for ${rows}`);
    assert.equal(got.rows.length + got.hidden, open, "every open item is a line or inside a count");
    assert.equal(new Set(got.rows).size, got.rows.length);
  }
  assert.ok(lookLines(look(s, r, NOW)).length <= DEFAULT_ROWS);
});
