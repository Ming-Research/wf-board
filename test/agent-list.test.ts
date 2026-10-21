// The agent list as one value (src/agent-list.ts) that the page draws and the look tool prints: the review session the runner holds is no
// other session and is not counted, the heading's number is the rows listed, the line about the free slots, and the tool's block.
// docs/design.md, section 7, Agent list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.ts";
import { ops } from "../src/ops.ts";
import { createMcpServer } from "../src/mcp.ts";
import { RunnerPools } from "../src/runner-pools.ts";
import { agentRows, runnerHolds, runnerHoldsReview } from "../src/agents.ts";
import { agentList, agentListLines, poolsLine } from "../src/agent-list.ts";
import type { PoolsEntry } from "../src/runner-pools.ts";
import type { HeldItem } from "../src/runner-rows.ts";
import type { Dispatch, Item, RunnerReport, Snapshot } from "../src/model.ts";
import { asArchitect, conf, opt } from "./helpers.ts";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const dispatch = (agent: string, started: string, fields: Partial<Dispatch> = {}) => ({ agentId: `${agent}-${started}`, agent, role: "工程师", level: 2, model: "Sonnet", effort: "xhigh", started, ...fields }) as unknown as Dispatch;
const review = (key: string, started: string, fields: Partial<Dispatch> = {}) => dispatch(`${key}-review`, started, { role: "审查", level: 3, ...fields });
// A job as the runner leaves it: the dispatch and the report begin together.
const job = (key: string, report: Partial<RunnerReport> & Pick<RunnerReport, "state">, started = ago(60), fields: Partial<Item> = {}) =>
  [key, { title: `title of ${key}`, group: "p", plan: [], dispatches: [dispatch(key, started)], runner: { since: started, at: started, started, ...report }, ...fields } as unknown as Item] as const;
// An item the runner holds nothing of.
const plain = (key: string, dispatches: Dispatch[]) => [key, { title: `title of ${key}`, group: "p", plan: [], dispatches } as unknown as Item] as const;
const snap = (...items: Array<readonly [string, Item]>) => ({ items: Object.fromEntries(items) }) as unknown as Pick<Snapshot, "items">;
const listed = (s: Pick<Snapshot, "items">): HeldItem[] => Object.entries(s.items).map(([id, it]) => ({ ...it, id }));
const open = { isOpenWork: () => true, isPaused: () => false };

// The board of the owner's 10-19 case: three jobs the runner holds, the review of one of them left open until the work ends, and a session started by hand.
const board = () => snap(
  job("a", { state: "ci" }, ago(60), { dispatches: [dispatch("a", ago(60)), review("a", ago(30))] }),
  job("b", { state: "running", since: ago(12), at: ago(12) }, ago(40)),
  plain("c", [review("c", ago(20))]),
  plain("h", [dispatch("hand", ago(10))]),
);

test("a review session left open on an item whose engineer the runner holds is the runner's, and is no other session", () => {
  const s = board();
  assert.equal(runnerHolds(s.items.a, s.items.a!.dispatches![0]!), true, "the engineer is held");
  assert.equal(runnerHoldsReview(s.items.a, s.items.a!.dispatches![1]!), true, "and so is the review of its pull request");
  assert.equal(runnerHoldsReview(s.items.c, s.items.c!.dispatches![0]!), false, "a review on an item the runner holds nothing of is a session of its own");
  assert.equal(runnerHoldsReview(s.items.a, review("a", ago(30), { finish: { ended: ago(5) } } as unknown as Partial<Dispatch>)), false, "an ended review holds nothing");
  assert.deepEqual(agentRows(s, NOW, listed(s)).map(r => r.name), ["hand", "c-review"], "the held review is not a row; the session by hand and the free review are");
});

test("a report left from an earlier job does not make a review the runner's", () => {
  // The report began an hour ago; the engineer was started five minutes ago, so the runner does not hold it, nor the review of its work.
  const s = snap(job("e", { state: "ci" }, ago(60), { dispatches: [dispatch("e", ago(5)), review("e", ago(3))] }));
  assert.equal(runnerHolds(s.items.e, s.items.e!.dispatches![0]!), false);
  assert.equal(runnerHoldsReview(s.items.e, s.items.e!.dispatches![1]!), false);
  assert.deepEqual(agentRows(s, NOW, listed(s)).map(r => r.name), ["e-review", "e"], "both are rows, the newer first");
});

test("the heading's number is the rows the list draws: the runner's rows and the other sessions running, with the held review in neither count", () => {
  const s = board(), list = agentList(s, open, listed(s), [], NOW);
  assert.deepEqual(list.runner.map(x => x.item), ["b", "a"], "the work the runner holds, the turn running first");
  assert.deepEqual(list.running.map(r => r.name), ["hand", "c-review"]);
  assert.deepEqual(list.others, []);
  assert.equal(list.count, 4);
  assert.equal(list.count, list.runner.length + list.running.length, "the heading counts the rows drawn open and no other");
  // The same holds when sessions sit behind the fold: one that wrote after its dispatch ended is a row of the fold line and counts in no heading.
  const folded = Object.assign(snap(...Object.entries(s.items).map(([k, it]) => [k, it] as const), plain("d", [dispatch("back", ago(200), { finish: { ended: ago(100) } } as unknown as Partial<Dispatch>)])), { activity: { agents: { back: [{ item: "d", at: ago(5) }] } } });
  const again = agentList(folded as unknown as Snapshot, open, listed(folded), [], NOW);
  assert.deepEqual(again.others.map(r => r.name), ["back"]);
  assert.equal(again.count, again.runner.length + again.running.length);
  assert.equal(again.count, 4, "the session behind the fold is not counted");
});

test("the slots line names each pool's free slots and how long the queue has had nothing to start; a report not repeated is shown as the last one", () => {
  const entry = (secondsAgo: number): PoolsEntry => ({ at: new Date(NOW - secondsAgo * 1000).toISOString(), pools: [
    { pool: "1", label: "1 级", slots: 10, running: 3, dryForSeconds: 4 * 3600 },
    { pool: "upper", label: "2 级以上", slots: 6, running: 6 },
  ] });
  assert.deepEqual(poolsLine(entry(30), NOW), { text: "名额：1 级 空着 7 个（共 10），派活队列里没有能开工的活已 4 小时；2 级以上 满 6/6", stale: false, idle: true });
  const stale = poolsLine(entry(600), NOW)!;
  assert.equal(stale.text, "名额（执行程序 10 分钟没报，下面是它上次报的）：1 级 空着 7 个（共 10），派活队列里没有能开工的活已 4 小时 10 分；2 级以上 满 6/6");
  assert.equal(stale.stale, true);
  const brief = poolsLine({ at: ago(0), pools: [{ pool: "1", label: "1 级", slots: 10, running: 3, dryForSeconds: 1800 }, { pool: "upper", label: "2 级以上", slots: 6, running: 0 }] }, NOW)!;
  assert.equal(brief.idle, false, "under the hour is not idle");
  assert.equal(brief.text, "名额：1 级 空着 7 个（共 10），派活队列里没有能开工的活已 30 分钟；2 级以上 空着 6 个（共 6）");
  assert.equal(poolsLine(undefined, NOW), undefined, "no report, no line");
  assert.equal(poolsLine({ at: ago(0), pools: [] }, NOW), undefined);
});

test("the tool's lines are the heading's number, the slots, a line for each piece of work the runner holds and each other session running", () => {
  const s = board(), list = agentList(s, open, listed(s), [], NOW);
  const entry: PoolsEntry = { at: new Date(NOW - 30_000).toISOString(), pools: [
    { pool: "1", label: "1 级", slots: 10, running: 3, dryForSeconds: 4 * 3600 },
    { pool: "upper", label: "2 级以上", slots: 6, running: 6 },
  ] };
  assert.deepEqual(agentListLines(list, entry, NOW, id => `title of ${id}`, () => undefined), [
    "代理 4（执行程序手上 2 件，其他在跑的会话 2 个）",
    "名额：1 级 空着 7 个（共 10），派活队列里没有能开工的活已 4 小时；2 级以上 满 6/6（空过 1 小时）",
    "  b · title of b · 2 级 · 在跑 · 12 分钟 · 还没报这一轮的动作",
    "  a · title of a · 2 级 · 等 CI · 1 小时",
    "  hand · 2 级 · 10 分钟前起 · h",
    "  c-review · 审查 3 级 · 20 分钟前起 · c",
  ]);
  assert.deepEqual(agentListLines(list, undefined, NOW, id => `title of ${id}`, () => undefined).slice(0, 2), ["代理 4（执行程序手上 2 件，其他在跑的会话 2 个）", "  b · title of b · 2 级 · 在跑 · 12 分钟 · 还没报这一轮的动作"], "without a report the line about the slots is left out");
});

/** A board with the work the architect's tools read, served over MCP: an item the runner holds with its review session open, and a card that blocks. */
async function served(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-agent-list-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = await Store.open(dir, { init: true, board: { title: "Synthetic board", projects: [{ name: "Whitefoot", repo: "Ming-Research/Whitefoot" }, { name: "Firn" }, { name: "Architect" }] } });
  const pools = new RunnerPools({ tell: () => {} });
  const op = ops(store, undefined, { pools });
  const server = createMcpServer({ store, ops: op, pools });
  const client = new Client({ name: "t", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>).map(c => c.text).join("\n");
  return { store, op, pools, text, call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: { ...args } }) };
}

test("look ends with the agent list of the whole board, whatever projects it is asked for, and carries the cards on each item's line", async t => {
  const b = await served(t);
  const { op } = b;
  await op.createItem({ ...asArchitect, key: "job", group: "Whitefoot", title: "the job", accept: "通过", difficulty: 2, difficultyReason: "测试用的评级" } as Parameters<typeof op.createItem>[0]);
  await op.createItem({ ...asArchitect, key: "sub", owner: "job", after: [], group: "Whitefoot", title: "a part", accept: "通过", difficulty: 2, difficultyReason: "测试用的评级" } as Parameters<typeof op.createItem>[0]);
  await op.dispatchStart({ ...asArchitect, id: "job", role: "工程师", level: 2, model: "Sonnet", agent: "job", agentId: "job-1" });
  await op.reportState({ author: "Whitefoot", session: "执行程序", id: "job", state: "ci", note: "等 CI" });
  await op.dispatchStart({ ...asArchitect, id: "job", role: "审查", level: 3, model: "Opus", agent: "job-review", agentId: "job-review-1" });
  await op.writeCard({ ...asArchitect, key: "q-block", item: "sub", kind: "design", question: "怎么做？", blocks: "实现", options: [opt("A", true), opt("B"), opt("C")], confidence: conf });
  await op.writeCard({ ...asArchitect, key: "q-plain", item: "sub", kind: "design", question: "还有一问？", options: [opt("A", true), opt("B"), opt("C")], confidence: conf });
  await op.reportHeartbeat({ author: "Whitefoot", session: "执行程序", pools: [{ pool: "1", label: "1 级", slots: 10, running: 1, dryForSeconds: 7200 }] });
  const all = b.text(await b.call("look", { rows: 60 }));
  const lines = all.split("\n");
  const at = lines.findIndex(line => line.startsWith("代理 "));
  assert.ok(at > 0, all);
  assert.equal(lines[at], "代理 1（执行程序手上 1 件，其他在跑的会话 0 个）", "the held review session is not another session");
  assert.match(lines[at + 1]!, /^名额：1 级 空着 9 个（共 10），派活队列里没有能开工的活已 2 小时（空过 1 小时）$/);
  assert.match(lines[at + 2]!, /^  job · the job · 2 级 · 等 CI · /);
  assert.equal(lines.length, at + 3, "nothing else follows");
  assert.equal(all.includes("job-review"), false, "the review session is on no line");
  // The cards the owner's page shows on a row: the purple one counts what blocks, the red one what blocks nothing; the sub-item's count is in its parent's line too.
  assert.match(lines.find(line => line.includes("sub · a part"))!, /卡：挡事 1 · 不挡事 1/);
  assert.match(lines.find(line => line.includes("job · the job"))!, /卡：挡事 1 · 不挡事 1/);
  // A look at one project lists the same agents: the list is the board's, as the page draws it.
  const firn = b.text(await b.call("look", { projects: ["Firn"], rows: 20 }));
  assert.match(firn, /\n代理 1（执行程序手上 1 件，其他在跑的会话 0 个）\n/);
});
