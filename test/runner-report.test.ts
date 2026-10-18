// The runner's report on an item (report_state): what the board stamps, what it refuses and who may write it. What the report
// feeds, the whole view, is tested in test/whole-view.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ops, OpError } from "../src/ops.ts";
import { createMcpServer } from "../src/mcp.ts";
import { unreadSteps } from "../src/history.ts";
import { Item, RunnerReport, ACCESS, PARTS, PROCESS_WRITERS } from "../src/model.ts";
import { board, asArchitect, asPM, author, rx } from "./helpers.ts";

// A board whose clock the test sets, so `since` and `at` can be told apart.
async function clocked(t: Parameters<typeof board>[0], now = "2026-10-18T09:00:00Z") {
  const fixture = await board(t);
  let clock = now;
  return { ...fixture, op: ops(fixture.store, () => clock), setClock: (value: string) => { clock = value; } };
}
const refused = (pattern: RegExp) => (error: unknown) => error instanceof OpError && pattern.test(error.message);
const report = (store: Awaited<ReturnType<typeof clocked>>["store"], id = "a") => store.snapshot().items[id]!.runner;

test("a report is stamped with since and at, and since stays while the state and what it waits for stay", async t => {
  const { store, op, setClock } = await clocked(t);
  await op.reportState({ ...asPM, id: "a", state: "running", startedAt: "2026-10-18T08:30:00Z", turns: 1, cost: 0.5, note: "第 1 轮" });
  assert.deepEqual(report(store), { state: "running", since: "2026-10-18T09:00:00Z", at: "2026-10-18T09:00:00Z", started: "2026-10-18T08:30:00Z", note: "第 1 轮", turns: 1, cost: 0.5 });
  // The same state with new figures: a change, so `at` moves; the work still waits for the same thing, so `since` does not.
  setClock("2026-10-18T09:20:00Z");
  await op.reportState({ ...asPM, id: "a", state: "running", turns: 2, cost: 1.25, note: "第 2 轮" });
  assert.deepEqual(report(store), { state: "running", since: "2026-10-18T09:00:00Z", at: "2026-10-18T09:20:00Z", started: "2026-10-18T08:30:00Z", note: "第 2 轮", turns: 2, cost: 1.25 });
  // A new state starts a new `since`; a wait that names other cards counts as a new wait.
  setClock("2026-10-18T09:40:00Z");
  await op.reportState({ ...asPM, id: "a", state: "ask", to: "owner", cards: ["c1"] });
  assert.equal(report(store)!.since, "2026-10-18T09:40:00Z");
  setClock("2026-10-18T09:50:00Z");
  await op.reportState({ ...asPM, id: "a", state: "ask", to: "owner", cards: ["c1", "c2"] });
  assert.equal(report(store)!.since, "2026-10-18T09:50:00Z");
  assert.deepEqual(report(store)!.cards, ["c1", "c2"]);
  // The report is a field of the item and the item still parses.
  assert.ok(Item.safeParse(store.snapshot().items.a).success);
});

test("figures and the start are kept when a report leaves them out, and a cost is kept in thousandths", async t => {
  const { store, op, setClock } = await clocked(t);
  await op.reportState({ ...asPM, id: "a", state: "ci", note: "Ming-Research/wf-board#98 的 CI", turns: 3, cost: 1.23456, startedAt: "2026-10-18T08:30:00Z" });
  assert.equal(report(store)!.cost, 1.235);
  setClock("2026-10-18T09:10:00Z");
  await op.reportState({ ...asPM, id: "a", state: "items", items: ["b"] });
  const r = report(store)!;
  assert.deepEqual([r.turns, r.cost, r.started], [3, 1.235, "2026-10-18T08:30:00Z"], "figures and start carry over");
  assert.equal(r.note, undefined, "a note belongs to its report and does not carry over");
  // A start time a moment ahead of the board's clock is cut back to the time the work entered its state.
  await op.reportState({ ...asPM, id: "a", state: "run", startedAt: "2026-10-18T09:10:00.900Z" });
  assert.equal(report(store)!.started, "2026-10-18T09:10:00Z");
});

test("a report that changes nothing writes no commit, and a note with line breaks is made one line", async t => {
  const { store, op, setClock } = await clocked(t);
  await op.reportState({ ...asPM, id: "a", state: "exception", note: "两轮出错\n第二行  多空格", turns: 2, cost: 3 });
  assert.equal(report(store)!.note, "两轮出错 第二行 多空格");
  const head = store.snapshot().head, rev = store.snapshot().items.a!.rev;
  setClock("2026-10-18T10:00:00Z");
  await op.reportState({ ...asPM, id: "a", state: "exception", note: "两轮出错 第二行 多空格", turns: 2, cost: 3 });
  assert.equal(store.snapshot().head, head, "no commit");
  assert.equal(store.snapshot().items.a!.rev, rev);
  assert.equal(report(store)!.at, "2026-10-18T09:00:00Z", "`at` is the time of the last change");
});

test("a report that does not say what the state needs is refused in the rule's own words, and nothing is written", async t => {
  const { store, op } = await clocked(t);
  const before = store.snapshot().head;
  const cases: Array<[Parameters<typeof op.reportState>[0], RegExp]> = [
    [{ ...asPM, id: "a", state: "ask" }, /to: a report of state ask says whom the work asks/],
    [{ ...asPM, id: "a", state: "ask", to: "owner" }, /cards: an ask to the owner names the cards/],
    [{ ...asPM, id: "a", state: "ask", to: "architect", cards: ["c"] }, /cards: only an ask to the owner names cards/],
    [{ ...asPM, id: "a", state: "ci", to: "owner" }, /to, cards: only a report of state ask carries them/],
    [{ ...asPM, id: "a", state: "items" }, /items: a report of state items names the items/],
    [{ ...asPM, id: "a", state: "ready", items: ["b"] }, /items: only a report of state items carries them/],
    [{ ...asPM, id: "a", state: "running", cost: -1 }, /cost: give the cost so far/],
    [{ ...asPM, id: "a", state: "running", startedAt: "yesterday" }, /startedAt: give a UTC time/],
    [{ ...asPM, id: "a", state: "running", note: "x".repeat(121) }, /note/],
    [{ ...asPM, id: "missing", state: "running" }, /choose an existing item/],
  ];
  for (const [args, message] of cases) await assert.rejects(() => op.reportState(args), refused(message), JSON.stringify(args));
  assert.equal(store.snapshot().head, before);
  assert.equal(report(store), undefined);
});

test("a record has no work to report on", async t => {
  const { op } = await clocked(t);
  await op.createItem({ ...asArchitect, key: "rec", title: "记录", group: "Whitefoot", record: true });
  await assert.rejects(() => op.reportState({ ...asPM, id: "rec", state: "running" }), refused(/a record has no work to report on/));
  // The schema says the same for a record edited by hand.
  assert.equal(RunnerReport.safeParse({ state: "running", since: "2026-10-18T09:00:00Z", at: "2026-10-18T09:00:00Z", started: "2026-10-18T09:00:00Z" }).success, true);
  assert.equal(RunnerReport.safeParse({ state: "running", since: "2026-10-18T09:00:00Z", at: "2026-10-18T08:00:00Z", started: "2026-10-18T09:00:00Z" }).success, false, "time does not run backwards");
});

test("only the PM and the architect write a report, on any project's item; every other role and writer is refused", async t => {
  const { store, op } = await clocked(t);
  // Without a credential: the writer's names decide.
  await op.reportState({ ...asPM, id: "other", state: "running" });
  await op.reportState({ ...asArchitect, id: "other", state: "ci" });
  assert.equal(report(store, "other")!.state, "ci");
  await assert.rejects(() => op.reportState({ author, session: "someone", id: "a", state: "running" }), refused(rx`only ${PROCESS_WRITERS} may report the runner's state`));
  // Over a credential the role's parts decide, whatever the call says about itself.
  for (const role of ["工程师", "审查", "观察者", "资源管理"] as const) {
    await assert.rejects(() => op.reportState({ ...asPM, access: { role, project: "Whitefoot", roots: ["a"] }, id: "a", state: "running" }), refused(/item\.runner: a .* credential may not write this part/), role);
  }
  await op.reportState({ ...asPM, access: { role: "PM", project: "PM", roots: [] }, id: "a", state: "running" });
  await op.reportState({ ...asArchitect, access: { role: "架构师", project: "Architect", roots: [] }, id: "a", state: "ci" });
  assert.equal(report(store, "a")!.state, "ci");
  // The table: the part exists and only the two roles of the process hold it.
  assert.ok(PARTS.includes("item.runner"));
  assert.deepEqual((["PM", "架构师", "观察者", "工程师", "审查", "资源管理"] as const).filter(role => ACCESS[role]["item.runner"] === "board"), ["PM", "架构师"]);
});

test("a report is never news to the owner, while a head change on the same item is", async t => {
  const { store, op } = await clocked(t);
  const before = store.snapshot().head;
  await op.reportState({ ...asPM, id: "a", state: "running", turns: 1, cost: 0.1 });
  await op.reportState({ ...asPM, id: "a", state: "ci", turns: 1, cost: 0.1, note: "CI" });
  const touched = async (cursor: string) => (await unreadSteps(store, cursor)).some(step => step.docs.some(doc => doc.id === "a"));
  assert.equal(await touched(before), false);
  const it = store.snapshot().items.a!;
  await op.updateItem({ author, id: "a", rev: it.rev, head: "新的 head", reason: "对照" });
  assert.equal(await touched(before), true);
});

test("the tool reports over MCP and answers with the item's row; a refusal reaches the caller as an error", async t => {
  const { store, op } = await clocked(t);
  const server = createMcpServer({ store, ops: op, now: () => "2026-10-18T09:00:00Z" });
  const client = new Client({ name: "t", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>).map(c => c.text).join("\n");
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some(tool => tool.name === "report_state") && tools.some(tool => tool.name === "whole_view"));
  const ok = await client.callTool({ name: "report_state", arguments: { ...asPM, id: "a", state: "ask", to: "architect", note: "问架构师" } });
  assert.equal(ok.isError, undefined, text(ok));
  assert.match(text(ok), /^report_state a ask · rev \d+ · commit [0-9a-f]{40}/);
  assert.equal(report(store)!.to, "architect");
  const bad = await client.callTool({ name: "report_state", arguments: { ...asPM, id: "a", state: "ask" } });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /to: a report of state ask says whom the work asks/);
});
