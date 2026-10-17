import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.ts";
import { ops } from "../src/ops.ts";
import { rules, isReviewStep, REVIEW_STEP } from "../src/rules.ts";
import { brief } from "../src/query.ts";
import { createMcpServer } from "../src/mcp.ts";
import { nextWork, nextWorkText, nextUnder, POOLS, GROUP_OVER } from "../src/next.ts";
import type { NextGroup, NextItem } from "../src/next.ts";
import { generateBoard } from "./e2e/board-gen.ts";
import { seedBoard } from "./e2e/seed.ts";
import { asArchitect, asPM } from "./helpers.ts";

const NOW = () => new Date().toISOString();
const STALE = "2026-10-01T00:00Z";

/** A board with no items, so a test sees only what it creates. Items are created in the order written: their numbers follow it. */
async function empty(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-next-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = await Store.open(dir, { init: true, board: { title: "Synthetic board", projects: [{ name: "Whitefoot", repo: "Ming-Research/Whitefoot" }, { name: "Firn" }, { name: "Architect" }, { name: "PM" }] } });
  const op = ops(store, NOW);
  let agents = 0;
  /** A work item of Whitefoot, rated 2 unless told otherwise; a top item needs a priority, so it is a root. */
  const item = (key: string, extra: Record<string, unknown> = {}) => op.createItem({ ...asArchitect, key, group: "Whitefoot", title: key, accept: "通过", difficulty: 2, ...extra } as Parameters<typeof op.createItem>[0]);
  /** An item under `owner` that starts at once (the rows before it are not waited for). */
  const child = (key: string, owner: string, extra: Record<string, unknown> = {}) => item(key, { owner, after: [], ...extra });
  const root = (key: string, priority: "P0" | "P1" | "P2", extra: Record<string, unknown> = {}) => item(key, { priority, ...extra });
  /** An engineer dispatch on an item; a stale one is open but its session has long been silent. */
  const engineer = async (id: string, level: number, startedAt?: string) => {
    agents++;
    await op.dispatchStart({ ...asPM, id, role: "工程师", level, model: "Sonnet", agent: `eng-${agents}`, agentId: `agent-${agents}`, ...(startedAt ? { startedAt } : {}) });
    return `eng-${agents}`;
  };
  const snapshot = () => store.snapshot();
  const view = () => { const s = snapshot(); return nextWork(s, rules(s)); };
  const pool = (name: string) => view().pools.find(p => p.pool === name)!;
  return { store, op, item, child, root, engineer, snapshot, view, pool };
}
const ids = (rows: Array<NextItem | NextGroup>) => rows.map(x => "id" in x ? x.id : x.parent);

test("items of every project are ranked by priority, then by the open items waiting on them, then by item number", async t => {
  const b = await empty(t);
  // y1 is the oldest and has two waiters, yet a P1 item comes after every P0 item.
  await b.root("r1", "P1"); await b.child("y1", "r1");
  // x3 is made before x1, so the item number and the key order disagree.
  await b.root("r0", "P0"); await b.child("x3", "r0"); await b.child("x1", "r0"); await b.child("x2", "r0");
  // The waiters of y1 hang under the P1 root, so y1 stays P1: a waiter under r0 would make it P0.
  for (const [key, owner, on] of [["d1", "r0", "x2"], ["d2", "r0", "x2"], ["e1", "r1", "y1"], ["e2", "r1", "y1"]] as const) await b.child(key, owner, { plan: [{ item: on, own: false }] });
  const s = b.snapshot(), r = rules(s);
  // The owner holds a row for each item it owns, and every row that points at an item counts.
  assert.deepEqual([r.openDependents("x2"), r.openDependents("x1"), r.openDependents("y1")], [3, 1, 3]);
  assert.deepEqual(["y1", "x1", "x3", "x2"].sort(r.compareNext), ["x2", "x3", "x1", "y1"], "x2 (most waiters) first, then x3 before x1 by number, then the P1 item");
  assert.deepEqual(ids(b.pool("2+").next), ["x2", "x3", "x1"], "the first three rows");
  assert.equal(b.pool("2+").more, 1, "y1 is startable and not listed");
  const row = b.pool("2+").next[0] as NextItem;
  assert.deepEqual({ project: row.project, priority: row.priority, difficulty: row.difficulty, waiters: row.waiters }, { project: "Whitefoot", priority: "P0", difficulty: 2, waiters: 3 });
});

test("a waiter that is paused or finished does not count, and an item in another project ranks with the rest", async t => {
  const b = await empty(t);
  await b.root("r", "P1"); await b.child("x1", "r"); await b.child("x2", "r");
  await b.item("f1", { group: "Firn", priority: "P1" });
  await b.child("w1", "r", { plan: [{ item: "x2", own: false }] });
  await b.child("w2", "r", { plan: [{ item: "x2", own: false }] });
  await b.op.setPause({ ...asArchitect, id: "w2", paused: true, reason: "先放一放" });
  const s = b.snapshot(), r = rules(s);
  assert.equal(r.openDependents("x2"), 2, "the owner and w1 count, the paused w2 does not");
  assert.deepEqual(ids(b.pool("2+").next), ["x2", "x1", "f1"], "x2 has the most waiters; f1 of Firn is newest");
  assert.equal((b.pool("2+").next[2] as NextItem).project, "Firn");
});

test("more than three startable items under one parent are listed as the parent and a count; three are listed one by one", async t => {
  const b = await empty(t);
  await b.root("r", "P0");
  await b.child("g", "r"); for (const k of ["g1", "g2", "g3", "g4"]) await b.child(k, "g");
  await b.child("h", "r"); for (const k of ["h1", "h2", "h3"]) await b.child(k, "h");
  assert.equal(GROUP_OVER, 3);
  const [first, ...rest] = b.pool("2+").next;
  assert.deepEqual(first, { parent: "g", num: b.snapshot().items.g!.num, project: "Whitefoot", title: "g", count: 4 }, "four under g: one row for g, at the place of its best item");
  assert.deepEqual(ids(rest), ["h1", "h2"], "three under h are items; the pool shows three rows");
  assert.equal(b.pool("2+").more, 1, "seven startable items; the rows listed stand for 4 + 1 + 1");
  const under = nextUnder(b.snapshot(), rules(b.snapshot()), "g");
  assert.deepEqual(under.rows.map(x => x.id), ["g1", "g2", "g3", "g4"], "under=g gives them one by one");
  assert.throws(() => nextUnder(b.snapshot(), rules(b.snapshot()), "nope"), /choose an existing item/);
});

test("the pools take items by level and count the engineers that are working, not those that wait", async t => {
  const b = await empty(t);
  await b.root("r", "P0");
  await b.child("low", "r", { difficulty: 1 }); await b.child("mid", "r", { difficulty: 3 }); await b.child("high", "r", { difficulty: 5 });
  assert.deepEqual(POOLS.map(p => [p.pool, p.limit]), [["1", 10], ["2+", 6]]);
  assert.deepEqual(ids(b.pool("1").next), ["low"], "level 1 is the first pool");
  assert.deepEqual(ids(b.pool("2+").next), ["mid", "high"], "levels 3 and 5 are the second");
  // Engineers of level 3. working: a step in progress that waits on nothing.
  await b.child("w1", "r", { difficulty: 3, plan: [{ id: "go", text: "干活", state: "doing" }] }); await b.engineer("w1", 3);
  // waiting on CI: the step in progress writes waits.
  await b.child("w2", "r", { difficulty: 3, plan: [{ id: "ci", text: "等 CI", state: "doing", waits: "CI" }] }); await b.engineer("w2", 3);
  // waiting on a review: the review step is in progress.
  await b.child("w3", "r", { difficulty: 3, plan: [{ id: REVIEW_STEP, text: "审查（2 级）", state: "doing" }] }); await b.engineer("w3", 3);
  // blocked: its only next row is an item that is paused.
  await b.child("dep", "r"); await b.op.setPause({ ...asArchitect, id: "dep", paused: true, reason: "先放一放" });
  await b.child("w4", "r", { difficulty: 3, plan: [{ item: "dep", own: false }] }); await b.engineer("w4", 3);
  // waiting on a sub-item that another session works; that session is working.
  await b.child("w5", "r", { difficulty: 3 }); await b.child("c5", "w5", { difficulty: 3, plan: [{ id: "go", text: "干活", state: "doing" }] });
  await b.engineer("w5", 3); await b.engineer("c5", 3);
  // fresh: it has marked no step yet, so it counts.
  await b.child("w6", "r", { difficulty: 3 }); await b.engineer("w6", 3);
  // Level 1: one working, one waiting.
  await b.child("l1", "r", { difficulty: 1, plan: [{ id: "go", text: "干活", state: "doing" }] }); await b.engineer("l1", 1);
  await b.child("l2", "r", { difficulty: 1, plan: [{ id: "ci", text: "等 CI", state: "doing", waits: "CI" }] }); await b.engineer("l2", 1);
  const two = b.pool("2+"), one = b.pool("1");
  assert.deepEqual([two.limit, two.working, two.free], [6, 3, 3], "w1, c5 and w6 work; w2 w3 w4 w5 wait");
  assert.deepEqual([one.limit, one.working, one.free], [10, 1, 9]);
  assert.deepEqual(ids(two.next), ["mid", "high"], "a held item is never offered again");
});

test("a pool with no free slot lists nothing and counts what could start; free is never below zero", async t => {
  const b = await empty(t);
  await b.root("r", "P0");
  for (let k = 1; k <= 7; k++) { await b.child(`w${k}`, "r", { plan: [{ id: "go", text: "干活", state: "doing" }] }); await b.engineer(`w${k}`, 2); }
  await b.child("p", "r"); await b.child("q", "r");
  const two = b.pool("2+");
  assert.deepEqual([two.working, two.free, two.next, two.more], [7, 0, [], 2], "seven working over the limit of six: no slot, no rows, two to start");
  const text = nextWorkText(b.view());
  assert.match(text, /2 级以上：上限 6，在干活 7，空 0/);
  assert.match(text, /还有 2 条能开工没列出/);
});

test("an item nobody works on is offered only when a root needs it, it is rated, and nothing holds it", async t => {
  const b = await empty(t);
  await b.root("r", "P1");
  await b.child("ok", "r");
  // Not rated.
  await b.child("unrated", "r", { difficulty: undefined });
  // Paused, and what hangs under a paused root.
  await b.child("paused", "r"); await b.op.setPause({ ...asArchitect, id: "paused", paused: true, reason: "先放一放" });
  await b.root("rp", "P0"); await b.child("under-paused", "rp"); await b.op.setPause({ ...asArchitect, id: "rp", paused: true, reason: "先放一放" });
  // Someone is on it, or its step waits on another item.
  await b.child("busy", "r", { plan: [{ id: "go", text: "干活", state: "doing" }] });
  await b.child("blocked", "r", { plan: [{ item: "ok", own: false }] });
  // An open dispatch whose session went quiet long ago: the item still has a holder.
  await b.child("stale", "r"); await b.engineer("stale", 2, STALE);
  const s = b.snapshot(), r = rules(s);
  assert.equal(r.statusOf("stale"), "todo", "no live session, so the board shows it as todo");
  assert.equal(r.startable("stale"), true, "and startable by the rules of status alone");
  assert.deepEqual(ids(b.pool("2+").next), ["ok"], "only ok");
  assert.equal(b.pool("2+").more, 0);
});

test("a backlog item (owned by a record) is not offered", async t => {
  const b = await empty(t);
  await b.op.createItem({ ...asArchitect, key: "rec", group: "Whitefoot", title: "待选", record: true } as Parameters<typeof b.op.createItem>[0]);
  await b.item("later", { owner: "rec" });
  await b.root("r", "P1"); await b.child("ok", "r");
  const r = rules(b.snapshot());
  assert.equal(r.isBacklog("later"), true);
  assert.deepEqual(ids(b.pool("2+").next), ["ok"]);
});

test("the review step is the plan step whose id is review", () => {
  const step = (id: string) => ({ id, text: "t", state: "doing" as const });
  assert.equal(isReviewStep(step("review")), true);
  assert.equal(isReviewStep(step("code-review")), false);
  assert.equal(isReviewStep({ item: "review", own: false }), false, "an item row is not a step");
});

test("brief.todo follows the same order", async t => {
  const b = await empty(t);
  await b.root("r", "P0"); await b.child("x1", "r"); await b.child("x2", "r"); await b.child("w", "r", { plan: [{ item: "x2", own: false }] });
  const s = b.snapshot();
  assert.deepEqual(brief(s, rules(s), "Whitefoot").todo.map(x => x.id), ["x2", "x1"], "the item with a waiter first");
});

test("next_work answers a few lines, under= answers one parent's items, and an unknown parent is an error", async t => {
  const b = await empty(t);
  await b.root("r", "P0"); await b.child("g", "r"); for (const k of ["g1", "g2", "g3", "g4"]) await b.child(k, "g");
  await b.child("solo", "r", { difficulty: 1 });
  const server = createMcpServer({ store: b.store, ops: b.op });
  const client = new Client({ name: "t", version: "1" }); const [c, sv] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sv), client.connect(c)]); t.after(() => client.close());
  const text = async (args: object) => ((await client.callTool({ name: "next_work", arguments: args })).content as Array<{ text: string }>)[0]!.text;
  const all = await text({});
  assert.match(all, /^1 级：上限 10，在干活 0，空 10\n  solo · P0 · solo · 难度 1 · Whitefoot · #\d+ · 等它 1\n2 级以上：上限 6，在干活 0，空 6\n  g · g · Whitefoot · #\d+ · 下面有 4 条能开工，next_work under=g 看逐条$/);
  assert.match(await text({ under: "g" }), /^g · g 下面能开工的\n  g1 · P0 · g1 · 难度 2 · Whitefoot · #\d+ · 等它 1\n  g2 /);
  const bad = await client.callTool({ name: "next_work", arguments: { under: "nope" } });
  assert.equal(bad.isError, true);
});

test("on a board of the live board's shape the answer stays short", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-next-gen-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const { store } = await seedBoard(dir, generateBoard(1));
  const s = store.snapshot(), r = rules(s), text = nextWorkText(nextWork(s, r));
  const items = Object.keys(s.items).length;
  assert.ok(items > 100, `a board of ${items} items`);
  assert.ok(text.length <= 800, `the answer is ${text.length} characters`);
  // The rows brief lists as todo are the same startable items, which that answer does not repeat.
  const projects = s.board.projects.map(p => p.name);
  const briefTodo = projects.reduce((n, p) => n + JSON.stringify(brief(s, r, p).todo).length, 0);
  assert.ok(text.length < briefTodo || briefTodo === 0, `next_work ${text.length} characters, brief todo lists ${briefTodo}`);
});
