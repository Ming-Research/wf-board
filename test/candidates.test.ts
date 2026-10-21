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
import { splitHead, whenText } from "../src/head-sections.ts";
import { candidates, candidatesText, candidatesUnder, candidatesUnderText, POOLS, GROUP_OVER, ASIDE_ROWS } from "../src/candidates.ts";
import type { CandidateGroup, Candidate } from "../src/candidates.ts";
import { generateBoard } from "./e2e/board-gen.ts";
import { seedBoard } from "./e2e/seed.ts";
import { asArchitect } from "./helpers.ts";

const STALE = "2026-10-01T00:00Z";
const DAY = 24 * 3600 * 1000;
/** Time added to a read of the time since an item last changed: the commits that wrote it are stamped by the real clock, a little after the test took its `base`. */
const SLACK = 3600 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
/** The month and day of a time, as a row writes it. */
const day = (ms: number) => iso(ms).slice(5, 10);

/** A board with no items, so a test sees only what it creates. Items are created in the order written: their numbers follow it. */
async function empty(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-cand-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = await Store.open(dir, { init: true, board: { title: "Synthetic board", projects: [{ name: "Whitefoot", repo: "Ming-Research/Whitefoot" }, { name: "Firn" }, { name: "Architect" }, { name: "PM" }] } });
  // The board's clock is the real one unless a write is made `at` a time: pauses are stamped with it.
  let clock: number | undefined;
  const op = ops(store, () => iso(clock ?? Date.now()));
  const at = async <T>(time: number, fn: () => Promise<T>): Promise<T> => { const was = clock; clock = time; try { return await fn(); } finally { clock = was; } };
  let agents = 0;
  /** A work item of Whitefoot, rated 2 unless told otherwise; a top item nobody waits on is a root. */
  const item = (key: string, extra: Record<string, unknown> = {}) => op.createItem({ ...asArchitect, key, group: "Whitefoot", title: key, accept: "通过", difficulty: 2, difficultyReason: "测试用的评级", ...extra } as Parameters<typeof op.createItem>[0]);
  /** An item under `owner` that starts at once (the rows before it are not waited for). */
  const child = (key: string, owner: string, extra: Record<string, unknown> = {}) => item(key, { owner, after: [], ...extra });
  const root = (key: string, extra: Record<string, unknown> = {}) => item(key, extra);
  /** An engineer dispatch on an item; a stale one is open but its session has long been silent. */
  const engineer = async (id: string, level: number, startedAt?: string) => {
    agents++;
    await op.dispatchStart({ ...asArchitect, id, role: "工程师", level, model: "Sonnet", agent: `eng-${agents}`, agentId: `agent-${agents}`, ...(startedAt ? { startedAt } : {}) });
    return `eng-${agents}`;
  };
  const snapshot = () => store.snapshot();
  /** The answer as read at `now`: the real present unless told. */
  const view = (now?: number) => { const s = snapshot(); return candidates(s, rules(s), now); };
  const pool = (name: string) => view().pools.find(p => p.pool === name)!;
  /** A record that owns backlog work, and an item of that work. */
  const backlog = (key: string, extra: Record<string, unknown> = {}) => item(key, { owner: "rec", ...extra });
  const record = () => op.createItem({ ...asArchitect, key: "rec", group: "Whitefoot", title: "待选", record: true } as Parameters<typeof op.createItem>[0]);
  const pause = (id: string, reason: string, time?: number) => at(time ?? Date.now(), () => op.setPause({ ...asArchitect, id, paused: true, reason }));
  return { store, op, item, child, root, engineer, snapshot, view, pool, at, backlog, record, pause };
}
const ids = (rows: Array<Candidate | CandidateGroup>) => rows.map(x => "id" in x ? x.id : x.parent);

test("candidates are listed by the open items waiting on them, then by item number, whatever root they hang under", async t => {
  const b = await empty(t);
  // Two roots: the order below ignores which one an item hangs under.
  await b.root("low"); await b.child("z1", "low");
  await b.root("high");
  // a4 is made after z1, so the item number and the key order disagree.
  await b.child("a4", "high"); await b.child("t2", "high"); await b.child("t3", "high");
  for (const [key, on] of [["d1", "t3"], ["d2", "t3"], ["d3", "t2"]] as const) await b.child(key, "high", { plan: [{ item: on, own: false }] });
  const s = b.snapshot(), r = rules(s);
  // Only the shared rows count: the owner holds an owned row for every item it owns, which tells the items apart by nothing.
  assert.deepEqual([r.openDependents("t3"), r.openDependents("t2"), r.openDependents("z1")], [2, 1, 0]);
  assert.deepEqual(["a4", "z1", "t2", "t3"].sort(r.compareCandidates), ["t3", "t2", "z1", "a4"], "t3 (two waiters), t2 (one), then z1 before a4 by number, whatever the root under it");
  assert.deepEqual(ids(b.pool("2+").listed), ["t3", "t2", "z1", "a4"], "listed in that order");
  assert.equal(b.pool("2+").more, 0);
  const row = b.pool("2+").listed[0] as Candidate;
  assert.deepEqual({ project: row.project, difficulty: row.difficulty, waiters: row.waiters }, { project: "Whitefoot", difficulty: 2, waiters: 2 });
  assert.equal("priority" in row, false, "a row carries no priority");
});

test("a paused waiter does not count, and candidates of every project are ordered together", async t => {
  const b = await empty(t);
  await b.root("r"); await b.child("x1", "r"); await b.child("x2", "r");
  await b.child("w1", "r", { plan: [{ item: "x2", own: false }] });
  await b.child("w2", "r", { plan: [{ item: "x2", own: false }] });
  await b.op.setPause({ ...asArchitect, id: "w2", paused: true, reason: "先放一放" });
  // The Firn item is made last and has two waiters of its own project, so it comes before both Whitefoot items.
  await b.root("fr", { group: "Firn" }); await b.child("f1", "fr", { group: "Firn" });
  for (const k of ["fd1", "fd2"]) await b.child(k, "fr", { group: "Firn", plan: [{ item: "f1", own: false }] });
  const s = b.snapshot(), r = rules(s);
  assert.deepEqual([r.openDependents("x2"), r.openDependents("f1")], [1, 2], "the paused waiter is not counted");
  assert.deepEqual(ids(b.pool("2+").listed), ["f1", "x2", "x1"], "two waiters, one waiter, none");
  assert.equal((b.pool("2+").listed[0] as Candidate).project, "Firn");
});

test("more than three candidates under one parent are listed as the parent and a count; three are listed one by one", async t => {
  const b = await empty(t);
  await b.root("r");
  await b.child("g", "r"); for (const k of ["g1", "g2", "g3", "g4"]) await b.child(k, "g");
  await b.child("h", "r"); for (const k of ["h1", "h2", "h3"]) await b.child(k, "h");
  assert.equal(GROUP_OVER, 3);
  const [first, ...rest] = b.pool("2+").listed;
  assert.deepEqual(first, { parent: "g", num: b.snapshot().items.g!.num, project: "Whitefoot", title: "g", count: 4 }, "four under g: one row for g, at the place of its best item");
  assert.deepEqual(ids(rest), ["h1", "h2", "h3"], "three under h are items");
  assert.equal(b.pool("2+").more, 0, "seven candidates; the rows listed stand for 4 + 1 + 1 + 1");
  const under = candidatesUnder(b.snapshot(), rules(b.snapshot()), "g");
  assert.deepEqual(under.rows.map(x => x.id), ["g1", "g2", "g3", "g4"], "under=g gives them one by one");
  assert.throws(() => candidatesUnder(b.snapshot(), rules(b.snapshot()), "nope"), /choose an existing item/);
});

test("candidates of different levels under one parent are grouped together, and the group counts them all", async t => {
  const b = await empty(t);
  await b.root("r"); await b.child("m", "r");
  for (const [k, level] of [["m1", 1], ["m2", 1], ["m3", 2], ["m4", 2]] as const) await b.child(k, "m", { difficulty: level });
  const group = (name: string) => b.pool(name).listed;
  assert.deepEqual(group("1").map(x => "parent" in x ? [x.parent, x.count] : x.id), [["m", 4]], "four under m in all: one row in the level 1 pool, with the count of all four");
  assert.deepEqual(group("2+").map(x => "parent" in x ? [x.parent, x.count] : x.id), [["m", 4]], "and the same row in the other pool");
  assert.deepEqual([b.pool("1").more, b.pool("2+").more], [0, 0], "what a pool lists is counted, not read from the group");
  assert.deepEqual([b.pool("1").total, b.pool("2+").total], [2, 2], "the group says 4, each pool has 2 of them");
  const under = candidatesUnder(b.snapshot(), rules(b.snapshot()), "m");
  assert.deepEqual(under.rows.map(x => [x.id, x.difficulty]), [["m1", 1], ["m2", 1], ["m3", 2], ["m4", 2]], "under=m lists all four, as many as the row says");
});

test("the pools take items by level and count the engineers that are working, not those that wait", async t => {
  const b = await empty(t);
  await b.root("r");
  await b.child("low", "r", { difficulty: 1 }); await b.child("mid", "r", { difficulty: 3 }); await b.child("high", "r", { difficulty: 5 });
  assert.deepEqual(POOLS.map(p => p.pool), ["1", "2+"]);
  assert.deepEqual(ids(b.pool("1").listed), ["low"], "level 1 is the first pool");
  assert.deepEqual(ids(b.pool("2+").listed), ["mid", "high"], "levels 3 and 5 are the second");
  // Engineers of level 3. working: a step in progress that waits on nothing.
  await b.child("w1", "r", { difficulty: 3, plan: [{ id: "go", text: "干活", state: "doing" }] }); await b.engineer("w1", 3);
  // waiting on CI: the step in progress writes waits, and the engineer is still working.
  await b.child("w2", "r", { difficulty: 3, plan: [{ id: "ci", text: "等 CI", state: "doing", waits: "wf-board#72 的 CI" }] }); await b.engineer("w2", 3);
  // waiting on a 14900K run: the machine is named in waits, and the engineer is idle.
  await b.child("w8", "r", { difficulty: 3, plan: [{ id: "run", text: "等跑完", state: "doing", waits: "14900K 排队中" }] }); await b.engineer("w8", 3);
  // waiting on a review: the review step is in progress.
  await b.child("w3", "r", { difficulty: 3, plan: [{ id: REVIEW_STEP, text: "审查（2 级）", state: "doing" }] }); await b.engineer("w3", 3);
  // waiting on a second round of the review: the step of that round is in progress.
  await b.child("w9", "r", { difficulty: 3, plan: [{ id: "review-2", text: "审查（第 2 轮）", state: "doing" }] }); await b.engineer("w9", 3);
  // blocked: its only open row is an item that is paused.
  await b.child("dep", "r"); await b.op.setPause({ ...asArchitect, id: "dep", paused: true, reason: "先放一放" });
  await b.child("w4", "r", { difficulty: 3, plan: [{ item: "dep", own: false }] }); await b.engineer("w4", 3);
  // blocked on a card: its only open row is a decision the owner has not ruled.
  await b.child("w7", "r", { difficulty: 3 });
  await b.op.writeCard({ author: "Whitefoot", key: "w7-card", item: "w7", kind: "design", question: "选哪个？", confidence: { reason: "判断" }, options: [{ text: "甲", detail: "做甲" }, { text: "乙", detail: "做乙" }, { text: "丙", detail: "做丙" }], blocks: "停着" });
  await b.op.setPlan({ author: "Whitefoot", id: "w7", row: { card: "w7-card", after: [] } }); await b.engineer("w7", 3);
  // waiting on a sub-item that another session works; that session is working.
  await b.child("w5", "r", { difficulty: 3 }); await b.child("c5", "w5", { difficulty: 3, plan: [{ id: "go", text: "干活", state: "doing" }] });
  await b.engineer("w5", 3); await b.engineer("c5", 3);
  // fresh: it has marked no step yet, so it counts.
  await b.child("w6", "r", { difficulty: 3 }); await b.engineer("w6", 3);
  // Level 1: one working, one waiting for a run.
  await b.child("l1", "r", { difficulty: 1, plan: [{ id: "go", text: "干活", state: "doing" }] }); await b.engineer("l1", 1);
  await b.child("l2", "r", { difficulty: 1, plan: [{ id: "run", text: "等跑完", state: "doing", waits: "14900K 上的测量" }] }); await b.engineer("l2", 1);
  const two = b.pool("2+"), one = b.pool("1");
  assert.equal(two.working, 4, "w1, w2 (CI), c5 and w6 work; w3 w4 w5 w7 w8 w9 wait");
  assert.equal(one.working, 1);
  assert.deepEqual(ids(two.listed), ["mid", "high"], "a held item is not a candidate");
});

test("a pool with more engineers working than any limit still lists its candidates, and the answer names no limit or free slot", async t => {
  const b = await empty(t);
  await b.root("r");
  for (let k = 1; k <= 7; k++) { await b.child(`w${k}`, "r", { plan: [{ id: "go", text: "干活", state: "doing" }] }); await b.engineer(`w${k}`, 2); }
  await b.child("p", "r"); await b.child("q", "r");
  const two = b.pool("2+");
  assert.deepEqual([two.working, two.listed.length, two.more, two.total], [7, 2, 0, 2], "seven working and two candidates, both listed: the board holds no limit to stop the list");
  const text = candidatesText(b.view());
  assert.match(text, /2 级以上：在干活 7，候选 2\n  p · p · 难度 2 · Whitefoot · #\d+\n  q · q · 难度 2 · Whitefoot · #\d+$/);
  assert.doesNotMatch(text, /上限|空 \d/, "the board does not say how many slots there are or how many are free");
});

test("an item is a candidate only when a root needs it, it can start, it is rated, and nothing holds it", async t => {
  const b = await empty(t);
  await b.root("r");
  await b.child("ok", "r");
  // Not rated.
  await b.child("unrated", "r", { difficulty: undefined, difficultyReason: undefined });
  // Paused, and what hangs under a paused root.
  await b.child("paused", "r"); await b.op.setPause({ ...asArchitect, id: "paused", paused: true, reason: "先放一放" });
  await b.root("rp"); await b.child("under-paused", "rp"); await b.op.setPause({ ...asArchitect, id: "rp", paused: true, reason: "先放一放" });
  // Someone is on it, or its step waits on another item.
  await b.child("busy", "r", { plan: [{ id: "go", text: "干活", state: "doing" }] });
  await b.child("blocked", "r", { plan: [{ item: "ok", own: false }] });
  // An open dispatch whose session went quiet long ago: the item still has a holder.
  await b.child("stale", "r"); await b.engineer("stale", 2, STALE);
  const s = b.snapshot(), r = rules(s);
  assert.equal(r.statusOf("stale"), "todo", "no live session, so the board shows it as todo");
  assert.equal(r.startable("stale"), true, "and startable by the rules of status alone");
  assert.deepEqual(ids(b.pool("2+").listed), ["ok"], "only ok");
  assert.equal(b.pool("2+").working, 1, "the stopped session keeps its slot until its dispatch is closed");
  assert.equal(b.pool("2+").more, 0);
});

test("a backlog item (owned by a record) is not a candidate", async t => {
  const b = await empty(t);
  await b.op.createItem({ ...asArchitect, key: "rec", group: "Whitefoot", title: "待选", record: true } as Parameters<typeof b.op.createItem>[0]);
  await b.item("later", { owner: "rec" });
  await b.root("r"); await b.child("ok", "r");
  const r = rules(b.snapshot());
  assert.equal(r.isBacklog("later"), true);
  assert.deepEqual(ids(b.pool("2+").listed), ["ok"]);
});

test("the review step is the plan step of the stage review, in any round", () => {
  const step = (id: string) => ({ id, text: "t", state: "doing" as const });
  assert.equal(isReviewStep(step("review")), true);
  assert.equal(isReviewStep(step("review-2")), true, "a later round is the same stage");
  assert.equal(isReviewStep(step("review-12")), true);
  assert.equal(isReviewStep(step("review-1")), false, "round 1 is written without a number");
  assert.equal(isReviewStep({ ...step("review"), accept: true }), false, "an acceptance step is not a stage, whatever its id");
  assert.equal(isReviewStep(step("code-review")), false);
  assert.equal(isReviewStep({ id: "review", item: "review", own: false }), false, "an item row is not a step");
});

test("brief.todo follows the same order", async t => {
  const b = await empty(t);
  await b.root("r"); await b.child("x1", "r"); await b.child("x2", "r"); await b.child("w", "r", { plan: [{ item: "x2", own: false }] });
  const s = b.snapshot();
  assert.deepEqual(brief(s, rules(s), "Whitefoot").todo.map(x => x.id), ["x2", "x1"], "the item with a waiter first");
});

test("candidates answers a few lines, under= answers one parent's items, and an unknown parent is an error", async t => {
  const b = await empty(t);
  await b.root("r"); await b.child("g", "r"); for (const k of ["g1", "g2", "g3", "g4"]) await b.child(k, "g");
  await b.child("solo", "r", { difficulty: 1 });
  const server = createMcpServer({ store: b.store, ops: b.op });
  const client = new Client({ name: "t", version: "1" }); const [c, sv] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sv), client.connect(c)]); t.after(() => client.close());
  const text = async (args: Record<string, unknown>) => ((await client.callTool({ name: "candidates", arguments: args })).content as Array<{ text: string }>)[0]!.text;
  const all = await text({});
  assert.match(all, /^1 级：在干活 0，候选 1\n  solo · solo · 难度 1 · Whitefoot · #\d+\n2 级以上：在干活 0，候选 4\n  g · g · Whitefoot · #\d+ · 下面有 4 条能开工，candidates under=g 看逐条$/);
  assert.match(await text({ under: "g" }), /^g · g 下面能开工的\n  g1 · g1 · 难度 2 · Whitefoot · #\d+\n  g2 /);
  const bad = await client.callTool({ name: "candidates", arguments: { under: "nope" } });
  assert.equal(bad.isError, true);
});

test("on a board of the live board's shape the answer stays short", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-cand-gen-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const { store } = await seedBoard(dir, generateBoard(1));
  const s = store.snapshot(), r = rules(s), text = candidatesText(candidates(s, r));
  const items = Object.keys(s.items).length;
  assert.ok(items > 100, `a board of ${items} items`);
  assert.ok(text.length <= 1500, `the answer is ${text.length} characters`);
  // The rows brief lists as todo are the same candidates, with their plans.
  const projects = s.board.projects.map(p => p.name);
  const briefTodo = projects.reduce((n, p) => n + JSON.stringify(brief(s, r, p).todo).length, 0);
  assert.ok(text.length < briefTodo || briefTodo === 0, `candidates ${text.length} characters, brief todo lists ${briefTodo}`);
});

test("on a board filled to the limits the whole answer, with the part for the work set aside, stays within its size", async t => {
  const b = await empty(t), base = Date.now();
  // Four projects, each with in both pools three candidates, two paused items and one item with a condition: more than the rows
  // of a pool hold, with the longest titles items have (20 characters), a reason and a 何时 sentence that are cut, and keys of 30.
  const projects = ["Whitefoot", "Firn", "Architect", "PM"], title = "标题".repeat(10), reason = "暂停的理由很长".repeat(8), when = `${"开工的条件很长".repeat(12)}。`;
  for (const group of projects) {
    const rec = `${group}-backlog-of-late-work`;
    await b.op.createItem({ ...asArchitect, key: rec, group, title: "待选", record: true } as Parameters<typeof b.op.createItem>[0]);
    for (const difficulty of [1, 2]) {
      const key = (what: string, k: number) => `${group}-${what}-of-level-${difficulty}-${k}`;
      for (let k = 1; k <= 3; k++) await b.item(key("candidate", k), { group, title, difficulty });
      for (let k = 1; k <= 2; k++) { await b.item(key("paused", k), { group, title, difficulty }); await b.pause(key("paused", k), reason, base - (k + 5) * DAY); }
      await b.item(key("later", 1), { group, title, difficulty, owner: rec, head: `**何时**：${when}` });
    }
  }
  const s = b.snapshot(), text = candidatesText(candidates(s, rules(s), base + DAY));
  // Both pools list the most rows (a header, ten rows and the count left out), so this is the longest the part can be.
  assert.equal(asideLines(text).length, 2 * (1 + ASIDE_ROWS + 1), "the rows of both pools are full");
  // Read as 4837 characters, 3206 of them the part for the work set aside; docs/design.md, section 6, The candidates read.
  assert.ok(text.length <= 5000, `the answer is ${text.length} characters`);
});

/** The lines of a candidates answer that belong to the work set aside: its header and its rows. */
const asideLines = (text: string) => text.split("\n").filter(line => line.startsWith("  另有") || line.startsWith("    "));

test("paused work and work with a start condition are listed after the candidates, which are as they were", async t => {
  const b = await empty(t), base = Date.now();
  await b.record(); await b.root("r"); await b.child("ok", "r");
  // A candidate whose head has a 何时 section is still a candidate: only what cannot be started is set aside.
  await b.child("cand", "r", { head: "**何时**：下次改到它时。" });
  const before = candidatesText(b.view());
  // Paused on the item itself, 7 days before the read below, and through its parent, 2 days before it.
  await b.child("own", "r"); await b.pause("own", "原则 6：先不做", base - 7 * DAY);
  await b.child("par", "r"); await b.child("kid", "par"); await b.pause("par", "等主人定方向", base - 2 * DAY);
  // In a backlog: with a 何时 section it is listed, without one it is not.
  await b.backlog("later", { head: "**问题**：慢。\n\n**何时**：有程序需要它时。其余另说。" }); await b.backlog("quiet", { head: "**问题**：慢。" });
  const now = base + 3 * DAY + SLACK, text = candidatesText(b.view(now));
  assert.deepEqual(ids(b.pool("2+").listed), ["ok", "cand"], "the candidates are as they were");
  assert.equal(b.pool("2+").total, 2, "and the number of candidates counts none of the work set aside");
  assert.equal(text.split("\n").filter(line => !line.startsWith("    ") && !line.startsWith("  另有")).join("\n"), before, "the part with the candidates reads as before");
  const num = (id: string) => b.snapshot().items[id]!.num;
  assert.deepEqual(asideLines(text), [
    "  另有暂停 2 件、带开工条件 1 件（Whitefoot 3）：",
    `    own · own · 难度 2 · Whitefoot · #${num("own")} · 暂停 · Architect ${day(base - 7 * DAY)} · 停了 10 天 · 原则 6：先不做`,
    `    kid · kid · 难度 2 · Whitefoot · #${num("kid")} · 因 par 暂停 · Architect ${day(base - 2 * DAY)} · 停了 5 天 · 等主人定方向`,
    `    later · later · 难度 2 · Whitefoot · #${num("later")} · 何时：有程序需要它时。 · 3 天没动`,
  ], "paused first, the longest paused first; then the item with a condition; the parent, the item without a 何时 and the candidates are not rows");
  assert.equal(text.split("2 级以上")[0]!.includes("另有"), false, "nothing in the other pool, and its text has no part for it");
});

test("what is not an item an engineer could be started on is not listed as set aside", async t => {
  const b = await empty(t);
  await b.record(); await b.root("r");
  // Held: an open engineer dispatch is on it, even a quiet one.
  await b.child("held", "r"); await b.engineer("held", 2, STALE); await b.pause("held", "先放一放");
  // Not rated: nobody could be started on it, whatever the pool.
  await b.child("unrated", "r", { difficulty: undefined, difficultyReason: undefined }); await b.pause("unrated", "先放一放");
  // A parent with open sub-items is its sub-items' business: only the sub-item is a row.
  await b.child("parent", "r"); await b.child("sub", "parent"); await b.pause("parent", "先放一放");
  // Blocked on another item, with a 何时 section: the plan says what it waits on, not the condition.
  await b.child("dep", "r"); await b.child("blocked", "r", { head: "**何时**：下次。", plan: [{ item: "dep", own: false }] });
  // A 何时 title inside a code block is code, and the word in a sentence is no title.
  await b.backlog("fenced", { head: "**问题**：x\n\n```\n**何时**：不是标题\n```\n" }); await b.backlog("plain", { head: "**问题**：不知道何时做。" });
  const rows = asideLines(candidatesText(b.view())).slice(1).map(line => line.trim().split(" · ")[0]);
  assert.deepEqual(rows, ["sub"], "only the sub-item of the paused parent");
});

test("a 何时 section is read as `context` reads sections, and a row shows its first sentence cut to 60 characters", async t => {
  const b = await empty(t);
  await b.record(); await b.root("r");
  const heads: Record<string, string> = {
    colon: "**问题**：x\n\n**何时**：有程序需要时。后面的话不要。\n\n**做法**：y",
    heading: "# 问题\n\nx\n\n## 何时\n\n等有人提需求。\n\n## 做法\n\ny",
    alone: "**何时**\n\n第一行，\n接着第二行。别的不要。\n\n**改动**：z",
    long: `**何时**：${"很".repeat(70)}。`,
    inline: "**何时**：没有空行就接下一节。\n**做法**：y",
  };
  for (const [key, head] of Object.entries(heads)) await b.backlog(key, { head });
  const text = candidatesUnderText(candidatesUnder(b.snapshot(), rules(b.snapshot()), "rec"));
  const when = Object.fromEntries(text.split("\n").slice(2).map(line => [line.trim().split(" · ")[0], /何时：(.*?) · /.exec(line)?.[1]]));
  assert.deepEqual(when, {
    colon: "有程序需要时。", heading: "等有人提需求。", alone: "第一行， 接着第二行。",
    long: `${"很".repeat(60)}…`, inline: "没有空行就接下一节。",
  });
  // The section is the one `splitHead` finds, as in `context`: `**何时** …` (the text after the bold title with no colon) is no
  // title there, so no condition here; a title with no text under it is a section with nothing to show.
  assert.equal(splitHead("**何时** 下次改到时。\n").some(x => x.title === "何时"), false);
  assert.equal(whenText("**何时** 下次改到时。\n"), undefined);
  assert.equal(whenText("**何时**：\n\n**做法**：y"), undefined);
});

test("more than three under one pause or one parent are a row with the count, and a project with few items is not crowded out", async t => {
  const b = await empty(t), base = Date.now();
  await b.record(); await b.root("r");
  // Four sub-items under one paused parent: one row. Three under another: three rows.
  await b.child("pc", "r"); for (const k of ["a1", "a2", "a3", "a4"]) await b.child(k, "pc");
  await b.pause("pc", "等主人定方向", base - 5 * DAY);
  await b.child("pd", "r"); for (const k of ["d1", "d2", "d3"]) await b.child(k, "pd");
  await b.pause("pd", "先放一放", base - 4 * DAY);
  // Four with a condition under the record: one row.
  for (const k of ["w1", "w2", "w3", "w4"]) await b.backlog(k, { head: "**何时**：有人要时。" });
  const num = (id: string) => b.snapshot().items[id]!.num;
  const text = candidatesText(b.view(base + DAY));
  assert.deepEqual(asideLines(text), [
    "  另有暂停 7 件、带开工条件 4 件（Whitefoot 11）：",
    `    pc · pc · Whitefoot · #${num("pc")} · 下面 4 件暂停 · Architect ${day(base - 5 * DAY)} · 停了 6 天 · 等主人定方向 · candidates under=pc 看逐条`,
    ...["d1", "d2", "d3"].map(k => `    ${k} · ${k} · 难度 2 · Whitefoot · #${num(k)} · 因 pd 暂停 · Architect ${day(base - 4 * DAY)} · 停了 5 天 · 先放一放`),
    `    rec · 待选 · Whitefoot · #${num("rec")} · 下面 4 件带开工条件，candidates under=rec 看逐条`,
  ]);
  assert.equal(text.includes("没列出"), false, "the rows stand for all eleven items");
});

test("the rows of the set-aside part are taken a project at a time, and the rest are counted", async t => {
  const b = await empty(t), base = Date.now();
  await b.root("r");
  // Twelve paused items of Whitefoot, the oldest pause first; one of Firn, paused last.
  for (let k = 1; k <= 12; k++) { await b.child(`w${k}`, "r"); await b.pause(`w${k}`, "先放一放", base - (13 - k) * DAY); }
  await b.root("fr", { group: "Firn" }); await b.child("f1", "fr", { group: "Firn" }); await b.pause("f1", "先放一放", base - DAY / 2);
  const lines = asideLines(candidatesText(b.view(base)));
  assert.equal(lines[0], "  另有暂停 13 件、带开工条件 0 件（Whitefoot 12、Firn 1）：", "counts by project, in the order of the projects");
  assert.deepEqual(lines.slice(1, -1).map(line => line.trim().split(" · ")[0]), ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9", "f1"], "Firn's only item is listed though Whitefoot has more than the rows; the oldest pauses of Whitefoot fill the rest");
  assert.equal(lines.at(-1), "    还有 3 件没列出");
});

test("under= lists the paused items whose pause is on the parent and the items with a condition directly under it", async t => {
  const b = await empty(t), base = Date.now();
  await b.record(); await b.root("r");
  await b.child("pc", "r"); for (let k = 1; k <= 13; k++) await b.child(`a${k}`, "pc");
  await b.pause("pc", "等主人定方向", base - 5 * DAY);
  for (const k of ["w1", "w2"]) await b.backlog(k, { head: `**何时**：${k} 的条件。` });
  const s = b.snapshot(), r = rules(s), num = (id: string) => s.items[id]!.num;
  const under = candidatesUnder(s, r, "pc", base);
  const text = candidatesUnderText(under);
  assert.equal(text.split("\n").filter(line => line.startsWith("  ") && !line.startsWith("  还有")).length, 10, "13 items under the pause, 10 rows listed, none of them a candidate");
  assert.match(text, new RegExp(`^pc · pc 下面能开工的：没有\\n暂停的 13 件\\n  a1 · a1 · 难度 2 · Whitefoot · #${num("a1")} · 因 pc 暂停 · Architect ${day(base - 5 * DAY)} · 停了 5 天 · 等主人定方向\\n  a10 `));
  assert.match(text, /\n {2}还有 3 件没列出$/);
  assert.equal(text.includes("带开工条件的"), false, "no part when there are none");
  const rec = candidatesUnderText(candidatesUnder(s, r, "rec", base + 2 * DAY + SLACK));
  assert.equal(rec, [`rec · 待选 下面能开工的：没有`, "带开工条件的 2 件", `  w1 · w1 · 难度 2 · Whitefoot · #${num("w1")} · 何时：w1 的条件。 · 2 天没动`, `  w2 · w2 · 难度 2 · Whitefoot · #${num("w2")} · 何时：w2 的条件。 · 2 天没动`].join("\n"));
});

test("the tool answers with the part for the work set aside, read at the server's clock", async t => {
  const b = await empty(t), base = Date.now();
  await b.root("r"); await b.child("p", "r"); await b.pause("p", "先放一放", base - 3 * DAY);
  const server = createMcpServer({ store: b.store, ops: b.op, now: () => iso(base) });
  const client = new Client({ name: "t", version: "1" }); const [c, sv] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sv), client.connect(c)]); t.after(() => client.close());
  const text = async (args: Record<string, unknown>) => ((await client.callTool({ name: "candidates", arguments: args })).content as Array<{ text: string }>)[0]!.text;
  assert.match(await text({}), new RegExp(`\\n {2}另有暂停 1 件、带开工条件 0 件（Whitefoot 1）：\\n {4}p · p · 难度 2 · Whitefoot · #\\d+ · 暂停 · Architect ${day(base - 3 * DAY)} · 停了 3 天 · 先放一放$`));
  assert.equal(await text({ under: "r" }), "r · r 下面能开工的：没有", "a parent that carries no pause has no paused part");
  assert.match(await text({ under: "p" }), /^p · p 下面能开工的：没有\n暂停的 1 件\n  p · p · 难度 2 /, "the item that carries a pause lists itself");
});
