// The whole view (src/whole-view.ts): every open work item in one of five kinds. A small board holds one item of each situation
// and the tests check the kind of each; a board of the live board's size checks the answer's length and the time it takes.
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
import { wholeView, wholeViewText, spanText, limitOf, reportText, BUCKETS, BUCKET_ROWS, WAIT_LIMITS_MS } from "../src/whole-view.ts";
import type { Bucket, WholeView } from "../src/whole-view.ts";
import { generateBoard } from "./e2e/board-gen.ts";
import type { Generated } from "./e2e/board-gen.ts";
import { asArchitect } from "./helpers.ts";

const MIN = 60_000, HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * A board with no items. Commit times (which the board reads as the time of an item's last change) are real, so the test works
 * from the real present: `base`, and a view is taken at `base` plus the time the test wants to have passed.
 */
async function empty(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-whole-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = await Store.open(dir, { init: true, board: { title: "Synthetic board", projects: [{ name: "Whitefoot", repo: "Ming-Research/Whitefoot" }, { name: "Firn" }, { name: "Architect" }, { name: "PM" }] } });
  const base = Date.now();
  let clock = base;
  const op = ops(store, () => iso(clock));
  /** Runs `fn` with the board's clock at `at`: what it writes is stamped then. */
  const at = async <T>(time: number, fn: () => Promise<T>): Promise<T> => { const was = clock; clock = time; try { return await fn(); } finally { clock = was; } };
  const item = (key: string, extra: Record<string, unknown> = {}) => op.createItem({ ...asArchitect, key, group: "Whitefoot", title: key, accept: "通过", difficulty: 2, difficultyReason: "测试用的评级", ...extra } as Parameters<typeof op.createItem>[0]);
  const child = (key: string, owner: string, extra: Record<string, unknown> = {}) => item(key, { owner, after: [], ...extra });
  /** The runner's report on `id`, written at `time`. */
  const report = (id: string, time: number, args: Record<string, unknown>) => at(time, () => op.reportState({ ...asArchitect, id, ...args } as Parameters<typeof op.reportState>[0]));
  const session = (id: string, agent: string, startedAt: number) => op.dispatchStart({ ...asArchitect, id, role: "工程师", level: 2, model: "Sonnet", agent, agentId: `${agent}-id`, startedAt: iso(startedAt) });
  /** The view at `now`, and the kind of each item in it. */
  const view = (now = base) => { const s = store.snapshot(), v = wholeView(s, rules(s, now), now); return { v, kind: Object.fromEntries(v.rows.map(x => [x.id, x.bucket])) as Record<string, Bucket>, s }; };
  return { store, op, base, at, item, child, report, session, view };
}

test("a report the runner writes itself, from its own session as the item's project, decides the item's kind like the architect's does", async t => {
  const b = await empty(t), { base } = b;
  await b.item("held"); await b.session("held", "held-eng", base - 15 * MIN);
  await b.item("asking");
  // The runner has no credential: the author is the item's project, the session its own name.
  await b.at(base - 30 * MIN, () => b.op.reportState({ author: "Whitefoot", session: "执行程序", id: "asking", state: "ask", to: "architect", turns: 2, cost: 1 }));
  await b.at(base - 5 * MIN, () => b.op.reportState({ author: "Whitefoot", session: "执行程序", id: "held", state: "ci", note: "Ming-Research/wf-board#100 的 CI" }));
  const { v } = b.view(base), row = (id: string) => v.rows.find(x => x.id === id)!;
  assert.deepEqual([row("asking").bucket, row("asking").from], ["waiting", "runner"], "the report, not the plan, puts it among the waiting");
  assert.deepEqual([row("held").bucket, row("held").from], ["waiting", "runner"], "and the report decides before a live session does");
  assert.equal(row("held").what, "等 CI：Ming-Research/wf-board#100 的 CI");
});

test("each open work item falls into the one kind its situation gives, and what the runner reports decides before the plan does", async t => {
  const b = await empty(t), { base } = b;
  // The runner's reports, each with the time it entered its state.
  for (const key of ["ci-late", "ci-ok", "running", "ask-owner", "ask-owner-late", "ask-arch", "ask-arch-late", "waits-items", "stopped", "ready", "done-late", "run-late"]) await b.item(key);
  await b.report("ci-late", base - 2 * HOUR, { state: "ci", note: "Ming-Research/wf-board#98 的 CI" });
  await b.report("ci-ok", base - 10 * MIN, { state: "ci" });
  await b.report("running", base - 20 * MIN, { state: "running", turns: 4, cost: 2.5, startedAt: iso(base - 3 * HOUR), note: "第 4 轮" });
  await b.report("ask-owner", base - HOUR, { state: "ask", to: "owner", cards: ["c1", "c2"] });
  await b.report("ask-owner-late", base - 13 * HOUR, { state: "ask", to: "owner", cards: ["c3"] });
  await b.report("ask-arch", base - 30 * MIN, { state: "ask", to: "architect" });
  await b.report("ask-arch-late", base - 2 * HOUR, { state: "ask", to: "architect" });
  await b.report("waits-items", base - 2 * HOUR, { state: "items", items: ["running", "ci-ok"] });
  await b.report("stopped", base - MIN, { state: "exception", note: "连着两轮出错" });
  await b.report("ready", base - 5 * MIN, { state: "ready", note: "Ming-Research/wf-board#98 合入核对" });
  await b.report("done-late", base - HOUR, { state: "done" });
  await b.report("run-late", base - 5 * HOUR, { state: "run", note: "bench.yml" });
  // A live session with no report; a blocked item (it waits on an open item); a half-done and a fresh item nobody holds.
  await b.item("session"); await b.session("session", "worker-1", base - 15 * MIN);
  await b.item("holder"); await b.child("dep", "holder");
  await b.item("blocked", { plan: [{ item: "dep", own: false }] });
  await b.item("half", { plan: [{ id: "s1", text: "第一步", state: "done" }, { id: "s2", text: "第二步", state: "todo" }] });
  await b.item("fresh");
  // A pause holds back an item and what it owns, whatever is reported on them; a report on a record's backlog item does not count either.
  await b.item("shelf"); await b.child("shelf-1", "shelf"); await b.child("shelf-2", "shelf");
  await b.op.setPause({ ...asArchitect, id: "shelf", paused: true, reason: "等主人定方向" });
  await b.report("shelf-1", base - 5 * MIN, { state: "running" });
  await b.item("bk", { record: true, accept: undefined, difficulty: undefined, difficultyReason: undefined }); await b.child("bk-1", "bk");
  // A parent with open sub-items is its sub-items' business; one a session works on itself is a row of its own.
  await b.item("parent"); await b.child("kid", "parent");
  await b.item("parent-held"); await b.child("kid-2", "parent-held"); await b.session("parent-held", "worker-2", base - 5 * MIN);
  // Cancelled work is not open.
  await b.item("gone"); await b.op.setStatus({ ...asArchitect, id: "gone", status: "cancelled", log: "不做了" });

  const { v, kind } = b.view(base);
  assert.deepEqual(kind, {
    "ci-late": "overdue", "ask-owner-late": "overdue", "ask-arch-late": "overdue", stopped: "overdue", "done-late": "overdue", "run-late": "overdue",
    running: "working", session: "working", "parent-held": "working",
    "ci-ok": "waiting", "ask-owner": "waiting", "ask-arch": "waiting", "waits-items": "waiting", ready: "waiting", blocked: "waiting",
    half: "unattended", fresh: "unattended", dep: "unattended", kid: "unattended", "kid-2": "unattended",
  }, "kinds");
  assert.deepEqual(v.parked.map(p => [p.id, p.count, p.reason]), [["shelf", 2, "等主人定方向"]], "one row for the pause, counting what stands under it");
  // Counts: every row is in exactly one kind, the pause's items are counted as parked, the backlog is counted apart.
  const c = v.projects.find(p => p.project === "Whitefoot")!;
  assert.deepEqual(c.byBucket, { overdue: 6, unattended: 5, working: 3, waiting: 6, parked: 2 });
  assert.equal(c.remaining, 22, "6 + 5 + 3 + 6 + 2");
  assert.equal(c.backlog, 1);
  // Which row came from where.
  const row = (id: string) => v.rows.find(x => x.id === id)!;
  assert.equal(row("running").from, "runner"); assert.equal(row("session").from, "session"); assert.equal(row("blocked").from, "plan");
  assert.equal(row("half").fresh, undefined); assert.equal(row("fresh").fresh, true);
  assert.equal(row("ci-late").what, "等 CI：Ming-Research/wf-board#98 的 CI");
  assert.equal(row("ask-owner").what, "问主人（卡 c1、c2）");
  assert.equal(row("waits-items").what, "等条目 running、ci-ok");
  assert.equal(row("blocked").what, "等条目 dep");
  assert.equal(row("half").what, "做了一半：1/3 行");
  // The limit shown for an overdue row is the limit of its state.
  assert.equal(row("ci-late").limit, WAIT_LIMITS_MS.ci);
  assert.equal(row("ask-owner-late").limit, WAIT_LIMITS_MS.ownerAsk);
  assert.equal(row("stopped").limit, 0);
});

test("a backlog item the runner reports on is listed with the working; a backlog item nobody reports on stays counted apart", async t => {
  const b = await empty(t), { base } = b;
  // Two items under a record's backlog: one an engineer has taken up and the runner reports, one nobody has started.
  await b.item("pool", { record: true, accept: undefined, difficulty: undefined, difficultyReason: undefined });
  await b.child("taken", "pool"); await b.child("waiting-pool", "pool");
  await b.report("taken", base - 50 * MIN, { state: "running", turns: 1, cost: 0.5, startedAt: iso(base - 50 * MIN), note: "第 1 轮" });
  const { v, kind } = b.view(base), row = (id: string) => v.rows.find(x => x.id === id);
  assert.equal(kind.taken, "working", "the report puts the backlog item among the working");
  assert.equal(row("taken")?.from, "runner");
  assert.equal(row("waiting-pool"), undefined, "no report: not listed");
  const c = v.projects.find(p => p.project === "Whitefoot")!;
  assert.equal(c.backlog, 1, "the item nobody reports on is still counted as backlog");
  assert.equal(c.remaining, 1, "only the reported item is open work outside the backlog count");
});

test("a kind lists its rows in the order the reader needs them: the most overrun first, half done before not started, the longest first", async t => {
  const b = await empty(t), { base } = b;
  for (const key of ["late-1", "late-2", "late-3", "w-old", "w-new"]) await b.item(key);
  await b.report("late-1", base - 3 * HOUR, { state: "ci" });      // 1.5 hours over its limit
  await b.report("late-2", base - 6 * HOUR, { state: "ci" });      // 4.5 hours over
  await b.report("late-3", base - 14 * HOUR, { state: "ask", to: "owner", cards: ["c"] }); // 2 hours over
  await b.report("w-old", base - 50 * MIN, { state: "ci" });
  await b.report("w-new", base - 5 * MIN, { state: "ci" });
  await b.item("z-fresh"); await b.item("a-fresh");
  await b.item("half-new", { plan: [{ id: "s1", text: "一", state: "done" }] });
  const { v } = b.view(base);
  assert.deepEqual(v.rows.filter(x => x.bucket === "overdue").map(x => x.id), ["late-2", "late-3", "late-1"]);
  assert.deepEqual(v.rows.filter(x => x.bucket === "waiting").map(x => x.id), ["w-old", "w-new"], "waiting the longest first");
  assert.deepEqual(v.rows.filter(x => x.bucket === "unattended").map(x => x.id).slice(0, 1), ["half-new"], "half done before not started");
  assert.deepEqual(BUCKETS, ["overdue", "unattended", "working", "waiting", "parked"]);
  assert.deepEqual(v.rows.map(x => x.bucket), [...v.rows.map(x => x.bucket)].sort((a, c) => BUCKETS.indexOf(a) - BUCKETS.indexOf(c)), "the rows come kind by kind");
});

test("the item left half done and untouched for days is unattended, and each thing that takes it up moves it out", async t => {
  const b = await empty(t), { base } = b;
  await b.item("wf-dir-move", { plan: [{ id: "s1", text: "改目录", state: "done" }, { id: "s2", text: "改引用", state: "todo" }] });
  // A session started three days ago and never ended counts for nothing now: it is far outside the window of a live session.
  await b.session("wf-dir-move", "gone-worker", base - 72 * HOUR);
  const after = base + 73 * HOUR;
  assert.equal(b.view(after).kind["wf-dir-move"], "unattended");
  assert.match(wholeViewText(b.view(after).v), /没人管 1（做了一半 1 · 没开始 0）\n  wf-dir-move · Whitefoot · wf-dir-move · 做了一半：1\/3 行 · 3 天/);
  // Each of these takes it out of the kind: a live session makes it working, a report gives it the report's kind, a pause parks it.
  await b.session("wf-dir-move", "fresh-worker", after - 10 * MIN);
  assert.equal(b.view(after).kind["wf-dir-move"], "working");
  await b.report("wf-dir-move", after - 10 * MIN, { state: "ci" });
  assert.equal(b.view(after).kind["wf-dir-move"], "waiting", "the report decides before the session does");
  await b.op.setPause({ ...asArchitect, id: "wf-dir-move", paused: true, reason: "先放一放" });
  const parked = b.view(after);
  assert.equal(parked.kind["wf-dir-move"], undefined);
  assert.deepEqual(parked.v.parked.map(p => p.id), ["wf-dir-move"]);
  await b.op.setPause({ ...asArchitect, id: "wf-dir-move", paused: false });
  assert.equal(b.view(after).kind["wf-dir-move"], "waiting");
  // An item that waits on another item, with nothing reported, is waiting; left for longer than the plan limit it is overdue.
  await b.item("wait-holder"); await b.child("wait-dep", "wait-holder"); await b.item("waiter", { plan: [{ item: "wait-dep", own: false }] });
  assert.equal(b.view(base + HOUR).kind.waiter, "waiting");
  assert.equal(b.view(base + WAIT_LIMITS_MS.plan + HOUR).kind.waiter, "overdue");
});

test("the text lists a few rows of each kind and counts the rest; bucket and project widen and narrow it", async t => {
  const b = await empty(t), { base } = b;
  for (let i = 1; i <= 12; i++) await b.item(`fresh-${String(i).padStart(2, "0")}`);
  await b.item("other-project", { group: "Firn" });
  await b.report("fresh-01", base - 5 * MIN, { state: "running", turns: 2, cost: 1.5, startedAt: iso(base - HOUR) });
  const { v } = b.view(base);
  const text = wholeViewText(v);
  assert.match(text, /^全貌 · 没做完的工作 13 件：等太久 0 · 没人管 12 · 在做 1 · 在等 0 · 搁着 0$/m);
  const notStarted = (answer: string) => answer.split("\n").filter(line => /^  fresh-\d\d · Whitefoot · fresh-\d\d · 没开始/.test(line));
  assert.equal(notStarted(text).length, BUCKET_ROWS.unattended, "a default answer lists the rows its kind allows");
  assert.match(text, /^  … 还有 4 件没列出（bucket: unattended 列全；没开始的也可用 candidates 看）$/m);
  assert.match(text, /^  fresh-01 · Whitefoot · fresh-01 · 跑一轮 · 5 分钟 · 共 1 小时，2 轮 \$1\.50 · #\d+$/m);
  assert.match(text, /^各项目还剩：\n  Whitefoot 12 件（没人管 11 · 在做 1）\n  Firn 1 件（没人管 1）$/m);
  // One kind in full; one project only.
  const full = wholeViewText(v, { bucket: "unattended" });
  assert.equal(notStarted(full).length, 11, "all eleven of Whitefoot, and the twelfth item is Firn's");
  assert.doesNotMatch(full, /^在做 |^各项目还剩/m, "no other kind and no project lines");
  const firn = wholeViewText(v, { project: "Firn" });
  assert.match(firn, /^全貌 · Firn · 没做完的工作 1 件：/);
  assert.doesNotMatch(firn, /fresh-/);
  assert.equal(wholeViewText(v, { project: "Architect" }), "Architect：没有没做完的工作。");
  assert.equal(wholeViewText({ ...v, rows: [], parked: [], projects: [] }), "没有没做完的工作。");
});

test("spans read as a person says them, and each state has a limit", () => {
  assert.deepEqual([0, 59_000, 12 * MIN, 3 * HOUR + 20 * MIN, 47 * HOUR, 49 * HOUR, 4 * 24 * HOUR + 5 * HOUR].map(spanText), ["不到 1 分钟", "不到 1 分钟", "12 分钟", "3 小时 20 分", "47 小时", "2 天", "4 天"]);
  const since = "2026-10-18T09:00:00Z";
  assert.equal(limitOf({ state: "ask", to: "owner", since }), WAIT_LIMITS_MS.ownerAsk);
  assert.equal(limitOf({ state: "ask", to: "architect", since }), WAIT_LIMITS_MS.architectAsk);
  for (const state of ["running", "ci", "items", "run", "wait", "ready", "exception", "done"] as const) assert.equal(limitOf({ state, since }), WAIT_LIMITS_MS[state], state);
});

test("a wait with a wake time lasts until an hour after it, counted from since, and never less than nothing", () => {
  const since = "2026-10-18T09:00:00Z";
  assert.equal(WAIT_LIMITS_MS.wait, 24 * HOUR, "a wait nobody dates lasts a day, like a wait for items");
  assert.equal(limitOf({ state: "wait", since }), 24 * HOUR);
  // Woken in 22 hours: on time for 23 hours from the start of the wait.
  assert.equal(limitOf({ state: "wait", since, until: "2026-10-19T07:00:00Z" }), 23 * HOUR);
  // Woken in 10 minutes: an hour and ten minutes, so a short wait is not marked before its time has come and gone.
  assert.equal(limitOf({ state: "wait", since, until: "2026-10-18T09:10:00Z" }), 70 * MIN);
  // A wake time less than an hour behind `since` still leaves the rest of the hour; one further behind is overdue at once.
  assert.equal(limitOf({ state: "wait", since, until: "2026-10-18T08:30:00Z" }), 30 * MIN);
  assert.equal(limitOf({ state: "wait", since, until: "2026-10-18T07:00:00Z" }), 0);
  // The words: the event, and the time when there is one.
  const report = { state: "wait", since, at: since, started: since, what: "上线后 24 小时的日志" } as const;
  assert.equal(reportText(report), "等：上线后 24 小时的日志");
  assert.equal(reportText({ ...report, until: "2026-10-19T23:55:00Z" }), "等：上线后 24 小时的日志（到 10-19 23:55Z）");
  assert.equal(reportText({ ...report, note: "第 3 轮" }), "等：上线后 24 小时的日志：第 3 轮");
});

test("a wait for an event is among the waiting in its words, and overdue an hour after its wake time or, with none, after a day", async t => {
  const b = await empty(t);
  // On a whole second, so that the edge of a limit is hit exactly: the board stamps `since` in whole seconds.
  const t0 = b.base - b.base % 1000;
  for (const key of ["dated", "undated", "woken-long-ago"]) await b.item(key);
  // Both waits began 2 hours ago; one is to be woken in 22 hours, the other has no time.
  const until = iso(t0 + 22 * HOUR);
  await b.report("dated", t0 - 2 * HOUR, { state: "wait", what: "上线后 24 小时的日志", until });
  await b.report("undated", t0 - 2 * HOUR, { state: "wait", what: "执行程序重启" });
  // A wake time that had gone by more than an hour before the wait was reported: overdue as soon as it is there.
  await b.report("woken-long-ago", t0 - HOUR, { state: "wait", what: "到点叫醒", until: iso(t0 - 5 * HOUR) });
  const waiting = (now: number) => { const { v, kind } = b.view(now); return { v, kind, row: (id: string) => v.rows.find(x => x.id === id)! }; };
  const now = waiting(t0);
  assert.deepEqual([now.kind.dated, now.kind.undated, now.kind["woken-long-ago"]], ["waiting", "waiting", "overdue"]);
  assert.equal(now.row("dated").what, `等：上线后 24 小时的日志（到 ${until.slice(5, 10)} ${until.slice(11, 16)}Z）`);
  assert.equal(now.row("undated").what, "等：执行程序重启");
  assert.equal(now.row("woken-long-ago").limit, 0, "its limit is nothing");
  // The wake time and an hour more: on time to the minute before the hour is out, overdue after it, with the limit counted from the start.
  const edge = t0 + 22 * HOUR + HOUR;
  assert.equal(waiting(edge - MIN).kind.dated, "waiting");
  assert.equal(waiting(edge).kind.dated, "waiting", "exactly at the limit is still on time");
  const late = waiting(edge + MIN);
  assert.equal(late.kind.dated, "overdue");
  assert.equal(late.row("dated").limit, 25 * HOUR, "an hour after the wake time, counted from the start of the wait");
  // With no wake time the day is counted from the start of the wait.
  assert.equal(waiting(t0 - 2 * HOUR + 24 * HOUR).kind.undated, "waiting");
  assert.equal(waiting(t0 - 2 * HOUR + 24 * HOUR + MIN).kind.undated, "overdue");
  assert.equal(waiting(t0 - 2 * HOUR + 24 * HOUR + MIN).row("undated").limit, WAIT_LIMITS_MS.wait);
  // The text of the answer lists the wait among the waiting.
  assert.match(wholeViewText(now.v), /^在等 2\n(  .*\n)*  undated · Whitefoot · undated · 等：执行程序重启 · 2 小时 · 共 2 小时/m);
});

test("whole_view answers over MCP, narrows by project and kind, and refuses a kind it does not have", async t => {
  const b = await empty(t), { base } = b;
  await b.item("w1"); await b.report("w1", base - 5 * MIN, { state: "ci" });
  const server = createMcpServer({ store: b.store, ops: b.op, now: () => iso(base) });
  const client = new Client({ name: "t", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  const text = async (args: Record<string, unknown>) => { const r = await client.callTool({ name: "whole_view", arguments: args }); return { error: r.isError === true, text: (r.content as Array<{ text: string }>)[0]!.text }; };
  const all = await text({});
  assert.equal(all.error, false);
  assert.match(all.text, /^全貌 · 没做完的工作 1 件：等太久 0 · 没人管 0 · 在做 0 · 在等 1 · 搁着 0\n在等 1\n  w1 · Whitefoot · w1 · 等 CI · 5 分钟/);
  assert.match((await text({ project: "Whitefoot", bucket: "waiting" })).text, /^全貌 · Whitefoot · 没做完的工作 1 件/);
  const bad = await text({ bucket: "stuck" });
  assert.equal(bad.error, true);
  assert.match(bad.text, /bucket/);
});

// ---- a board of the live board's size ----

/** A generated board as a snapshot in memory, without a repository: what the tool's cost depends on is the items. */
function memoryBoard(gen: Generated): Snapshot {
  const items: Record<string, Item> = {}, decisions: Record<string, Decision> = {};
  for (const batch of gen.batches) for (const put of batch.puts) {
    if (put.kind === "item") items[put.id] = Item.parse({ ...(put.doc as object), rev: (items[put.id]?.rev ?? 0) + 1 });
    else if (put.kind === "decision") decisions[put.id] = Decision.parse({ ...(put.doc as object), rev: (decisions[put.id]?.rev ?? 0) + 1 });
  }
  return { board: Board.parse(gen.board), items, decisions, notes: {}, glossaries: {}, owner: {}, head: "0".repeat(40) };
}

test("on a board of the live board's size the answer is short and quick, and every open item is counted once", () => {
  // The generator at 12 times its default: about 1,900 items, more than the live board's 1,600.
  const s = memoryBoard(generateBoard(1, 12));
  const items = Object.keys(s.items).length;
  assert.ok(items > 1500, `a board of ${items} items`);
  const now = Date.parse("2026-10-18T12:00:00Z");
  // Give a third of the open, unpaused items outside a backlog a report, in turn each state, started a while ago, so each kind has rows.
  const r0 = rules(s, now), states = ["running", "ci", "ask", "items", "run", "ready", "exception", "done"] as const;
  let seen = 0;
  for (const id of Object.keys(s.items)) {
    if (!r0.isOpenWork(id) || r0.isPaused(id) || r0.isBacklog(id) || seen++ % 3 !== 0) continue;
    const state = states[Math.floor(seen / 3) % states.length]!, since = iso(now - (seen * 37 % 600) * MIN);
    s.items[id] = Item.parse({ ...s.items[id], runner: { state, since, at: since, started: since, ...(state === "ask" ? { to: "architect" } : state === "items" ? { items: ["x"] } : {}) } });
  }
  const started = performance.now();
  const r = rules(s, now), view: WholeView = wholeView(s, r, now), text = wholeViewText(view);
  const took = performance.now() - started;
  console.info(`whole view of ${items} items: ${Math.round(took)} ms, ${text.length} characters, ${view.rows.length} rows + ${view.parked.length} pauses`);
  assert.ok(took < 2000, `the view took ${Math.round(took)} ms`);
  assert.ok(text.length <= 6000, `the answer is ${text.length} characters`);
  // The oracle for the count: an open work item that is not in a backlog and has no open sub-item, or that carries a report.
  let expected = 0, backlog = 0;
  for (const id of Object.keys(s.items)) {
    if (!r.isOpenWork(id)) continue;
    if (r.isBacklog(id) && !s.items[id]!.runner) { backlog++; continue; }
    if (s.items[id]!.runner || !r.children(id).some(child => r.isOpenWork(child))) expected++;
  }
  assert.equal(view.projects.reduce((sum, p) => sum + p.remaining, 0), expected);
  assert.equal(view.projects.reduce((sum, p) => sum + p.backlog, 0), backlog);
  assert.equal(view.rows.length + view.projects.reduce((sum, p) => sum + p.byBucket.parked, 0), expected, "every counted item is a row or stands under a pause");
  assert.ok(view.rows.length > 20 && view.parked.length > 0, "the board has rows of several kinds");
});
