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
import { CredentialsFile, hashToken } from "../src/credentials.ts";
import { board, asArchitect, author, rx } from "./helpers.ts";

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
  await op.reportState({ ...asArchitect, id: "a", state: "running", startedAt: "2026-10-18T08:30:00Z", turns: 1, cost: 0.5, note: "第 1 轮" });
  assert.deepEqual(report(store), { state: "running", since: "2026-10-18T09:00:00Z", at: "2026-10-18T09:00:00Z", started: "2026-10-18T08:30:00Z", note: "第 1 轮", turns: 1, cost: 0.5 });
  // The same state with new figures: a change, so `at` moves; the work still waits for the same thing, so `since` does not.
  setClock("2026-10-18T09:20:00Z");
  await op.reportState({ ...asArchitect, id: "a", state: "running", turns: 2, cost: 1.25, note: "第 2 轮" });
  assert.deepEqual(report(store), { state: "running", since: "2026-10-18T09:00:00Z", at: "2026-10-18T09:20:00Z", started: "2026-10-18T08:30:00Z", note: "第 2 轮", turns: 2, cost: 1.25 });
  // A new state starts a new `since`; a wait that names other cards counts as a new wait.
  setClock("2026-10-18T09:40:00Z");
  await op.reportState({ ...asArchitect, id: "a", state: "ask", to: "owner", cards: ["c1"] });
  assert.equal(report(store)!.since, "2026-10-18T09:40:00Z");
  setClock("2026-10-18T09:50:00Z");
  await op.reportState({ ...asArchitect, id: "a", state: "ask", to: "owner", cards: ["c1", "c2"] });
  assert.equal(report(store)!.since, "2026-10-18T09:50:00Z");
  assert.deepEqual(report(store)!.cards, ["c1", "c2"]);
  // The report is a field of the item and the item still parses.
  assert.ok(Item.safeParse(store.snapshot().items.a).success);
});

test("figures and the start are kept when a report leaves them out, and a cost is kept in thousandths", async t => {
  const { store, op, setClock } = await clocked(t);
  await op.reportState({ ...asArchitect, id: "a", state: "ci", note: "Ming-Research/wf-board#98 的 CI", turns: 3, cost: 1.23456, startedAt: "2026-10-18T08:30:00Z" });
  assert.equal(report(store)!.cost, 1.235);
  setClock("2026-10-18T09:10:00Z");
  await op.reportState({ ...asArchitect, id: "a", state: "items", items: ["b"] });
  const r = report(store)!;
  assert.deepEqual([r.turns, r.cost, r.started], [3, 1.235, "2026-10-18T08:30:00Z"], "figures and start carry over");
  assert.equal(r.note, undefined, "a note belongs to its report and does not carry over");
  // A start time a moment ahead of the board's clock is cut back to the time the work entered its state.
  await op.reportState({ ...asArchitect, id: "a", state: "run", startedAt: "2026-10-18T09:10:00.900Z" });
  assert.equal(report(store)!.started, "2026-10-18T09:10:00Z");
});

test("a report that changes nothing writes no commit, and a note with line breaks is made one line", async t => {
  const { store, op, setClock } = await clocked(t);
  await op.reportState({ ...asArchitect, id: "a", state: "exception", note: "两轮出错\n第二行  多空格", turns: 2, cost: 3 });
  assert.equal(report(store)!.note, "两轮出错 第二行 多空格");
  const head = store.snapshot().head, rev = store.snapshot().items.a!.rev;
  setClock("2026-10-18T10:00:00Z");
  await op.reportState({ ...asArchitect, id: "a", state: "exception", note: "两轮出错 第二行 多空格", turns: 2, cost: 3 });
  assert.equal(store.snapshot().head, head, "no commit");
  assert.equal(store.snapshot().items.a!.rev, rev);
  assert.equal(report(store)!.at, "2026-10-18T09:00:00Z", "`at` is the time of the last change");
});

test("a report that does not say what the state needs is refused in the rule's own words, and nothing is written", async t => {
  const { store, op } = await clocked(t);
  const before = store.snapshot().head;
  const cases: Array<[Parameters<typeof op.reportState>[0], RegExp]> = [
    [{ ...asArchitect, id: "a", state: "ask" }, /to: a report of state ask says whom the work asks/],
    [{ ...asArchitect, id: "a", state: "ask", to: "owner" }, /cards: an ask to the owner names the cards/],
    [{ ...asArchitect, id: "a", state: "ask", to: "architect", cards: ["c"] }, /cards: only an ask to the owner names cards/],
    [{ ...asArchitect, id: "a", state: "ci", to: "owner" }, /to, cards: only a report of state ask carries them/],
    [{ ...asArchitect, id: "a", state: "items" }, /items: a report of state items names the items/],
    [{ ...asArchitect, id: "a", state: "ready", items: ["b"] }, /items: only a report of state items carries them/],
    [{ ...asArchitect, id: "a", state: "running", cost: -1 }, /cost: give the cost so far/],
    [{ ...asArchitect, id: "a", state: "running", startedAt: "yesterday" }, /startedAt: give a UTC time/],
    [{ ...asArchitect, id: "a", state: "running", note: "x".repeat(121) }, /note/],
    [{ ...asArchitect, id: "missing", state: "running" }, /choose an existing item/],
  ];
  for (const [args, message] of cases) await assert.rejects(() => op.reportState(args), refused(message), JSON.stringify(args));
  assert.equal(store.snapshot().head, before);
  assert.equal(report(store), undefined);
});

test("a wait carries the event it waits for and the time it ends, and since stays only while both stay the same", async t => {
  const { store, op, setClock } = await clocked(t);
  await op.reportState({ ...asArchitect, id: "a", state: "wait", what: "24 小时的日志\n看有没有超时", until: "2026-10-19T23:55Z", startedAt: "2026-10-18T08:30:00Z", turns: 2, cost: 1 });
  // The event is one line, the time is kept in full, and nothing else of the wait is invented.
  assert.deepEqual(report(store), { state: "wait", since: "2026-10-18T09:00:00Z", at: "2026-10-18T09:00:00Z", started: "2026-10-18T08:30:00Z", what: "24 小时的日志 看有没有超时", until: "2026-10-19T23:55:00Z", turns: 2, cost: 1 });
  assert.ok(Item.safeParse(store.snapshot().items.a).success);
  // The same wait with new figures: `at` moves, `since` does not.
  setClock("2026-10-18T10:00:00Z");
  await op.reportState({ ...asArchitect, id: "a", state: "wait", what: "24 小时的日志 看有没有超时", until: "2026-10-19T23:55:00Z", turns: 3, cost: 1.5 });
  assert.deepEqual([report(store)!.since, report(store)!.at], ["2026-10-18T09:00:00Z", "2026-10-18T10:00:00Z"]);
  // Another wake time is another wait; so is another event; so is the same event with no time.
  setClock("2026-10-18T11:00:00Z");
  await op.reportState({ ...asArchitect, id: "a", state: "wait", what: "24 小时的日志 看有没有超时", until: "2026-10-20T00:10Z" });
  assert.equal(report(store)!.since, "2026-10-18T11:00:00Z");
  setClock("2026-10-18T12:00:00Z");
  await op.reportState({ ...asArchitect, id: "a", state: "wait", what: "执行程序重启", until: "2026-10-20T00:10Z" });
  assert.equal(report(store)!.since, "2026-10-18T12:00:00Z");
  setClock("2026-10-18T13:00:00Z");
  await op.reportState({ ...asArchitect, id: "a", state: "wait", what: "执行程序重启" });
  assert.deepEqual([report(store)!.since, report(store)!.until, report(store)!.what], ["2026-10-18T13:00:00Z", undefined, "执行程序重启"], "the time of an earlier wait is not carried over");
  // A wake time that has already gone by is accepted: the lists show the wait overdue.
  setClock("2026-10-18T14:00:00Z");
  await op.reportState({ ...asArchitect, id: "a", state: "wait", what: "到点叫醒", until: "2026-10-18T07:00Z" });
  assert.equal(report(store)!.until, "2026-10-18T07:00:00Z");
  // Leaving the wait takes its fields with it.
  setClock("2026-10-18T15:00:00Z");
  await op.reportState({ ...asArchitect, id: "a", state: "running", note: "第 4 轮" });
  assert.equal(report(store)!.what, undefined);
  assert.equal(report(store)!.until, undefined);
});

test("a wait that does not say what it waits for, and a field that is not a wait's, are refused in the rule's own words, and nothing is written", async t => {
  const { store, op } = await clocked(t);
  const before = store.snapshot().head;
  const cases: Array<[Parameters<typeof op.reportState>[0], RegExp]> = [
    [{ ...asArchitect, id: "a", state: "wait" }, /what: a report of state wait says what the work waits for/],
    [{ ...asArchitect, id: "a", state: "wait", until: "2026-10-19T23:55Z" }, /what: a report of state wait says what the work waits for/],
    [{ ...asArchitect, id: "a", state: "wait", what: " \n " }, /what: provide nonempty text after trimming/],
    [{ ...asArchitect, id: "a", state: "wait", what: "x".repeat(121) }, /what/],
    [{ ...asArchitect, id: "a", state: "wait", what: "重启", until: "tomorrow" }, /until: give a UTC time/],
    [{ ...asArchitect, id: "a", state: "ci", what: "重启" }, /what, until: only a report of state wait carries them/],
    [{ ...asArchitect, id: "a", state: "ask", to: "architect", until: "2026-10-19T23:55Z" }, /what, until: only a report of state wait carries them/],
    [{ ...asArchitect, id: "a", state: "items", items: ["b"], what: "重启" }, /what, until: only a report of state wait carries them/],
    [{ ...asArchitect, id: "a", state: "wait", what: "重启", items: ["b"] }, /items: only a report of state items carries them/],
    [{ ...asArchitect, id: "a", state: "wait", what: "重启", to: "architect" }, /to, cards: only a report of state ask carries them/],
  ];
  for (const [args, message] of cases) await assert.rejects(() => op.reportState(args), refused(message), JSON.stringify(args));
  assert.equal(store.snapshot().head, before);
  assert.equal(report(store), undefined);
  // The schema says the same for a report edited by hand.
  const base = { since: "2026-10-18T09:00:00Z", at: "2026-10-18T09:00:00Z", started: "2026-10-18T09:00:00Z" };
  assert.equal(RunnerReport.safeParse({ ...base, state: "wait", what: "重启" }).success, true);
  assert.equal(RunnerReport.safeParse({ ...base, state: "wait", what: "重启", until: "2026-10-19T23:55:00Z" }).success, true);
  assert.equal(RunnerReport.safeParse({ ...base, state: "wait" }).success, false, "a wait names its event");
  assert.equal(RunnerReport.safeParse({ ...base, state: "ci", what: "重启" }).success, false);
});

test("a wait reported over MCP is kept with its event and time, and a wait without its event comes back as an error", async t => {
  const { store, op } = await clocked(t);
  const server = createMcpServer({ store, ops: op, now: () => "2026-10-18T09:00:00Z" });
  const client = new Client({ name: "t", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>).map(c => c.text).join("\n");
  const tool = (await client.listTools()).tools.find(x => x.name === "report_state")!;
  assert.deepEqual(Object.keys(tool.inputSchema.properties as object).filter(name => ["what", "until"].includes(name)).sort(), ["until", "what"]);
  const ok = await client.callTool({ name: "report_state", arguments: { ...asArchitect, id: "a", state: "wait", what: "上线后 24 小时的日志", until: "2026-10-19T23:55Z" } });
  assert.equal(ok.isError, undefined, text(ok));
  assert.match(text(ok), /^report_state a wait · rev \d+ · commit [0-9a-f]{40}/);
  assert.deepEqual([report(store)!.state, report(store)!.what, report(store)!.until], ["wait", "上线后 24 小时的日志", "2026-10-19T23:55:00Z"]);
  const bad = await client.callTool({ name: "report_state", arguments: { ...asArchitect, id: "a", state: "wait" } });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /what: a report of state wait says what the work waits for/);
  const worse = await client.callTool({ name: "report_state", arguments: { ...asArchitect, id: "a", state: "wait", what: "重启", until: "tomorrow" } });
  assert.equal(worse.isError, true, "a time that is not a UTC time is refused before it is written");
});

test("a record has no work to report on", async t => {
  const { op } = await clocked(t);
  await op.createItem({ ...asArchitect, key: "rec", title: "记录", group: "Whitefoot", record: true });
  await assert.rejects(() => op.reportState({ ...asArchitect, id: "rec", state: "running" }), refused(/a record has no work to report on/));
  // The schema says the same for a record edited by hand.
  assert.equal(RunnerReport.safeParse({ state: "running", since: "2026-10-18T09:00:00Z", at: "2026-10-18T09:00:00Z", started: "2026-10-18T09:00:00Z" }).success, true);
  assert.equal(RunnerReport.safeParse({ state: "running", since: "2026-10-18T09:00:00Z", at: "2026-10-18T08:00:00Z", started: "2026-10-18T09:00:00Z" }).success, false, "time does not run backwards");
});

test("only the architect and the runner write a report; every other role and writer is refused", async t => {
  const { store, op } = await clocked(t);
  // Without a credential: the writer's names decide.
  await op.reportState({ ...asArchitect, id: "other", state: "ci" });
  assert.equal(report(store, "other")!.state, "ci");
  await assert.rejects(() => op.reportState({ author, session: "someone", id: "a", state: "running" }), refused(rx`only ${PROCESS_WRITERS}, or the runner from the session 执行程序, may report the runner's state`));
  // Over a credential the role's parts decide, whatever the call says about itself.
  for (const role of ["工程师", "审查", "观察者", "资源管理"] as const) {
    await assert.rejects(() => op.reportState({ ...asArchitect, access: { role, project: "Whitefoot", roots: ["a"] }, id: "a", state: "running" }), refused(/item\.runner: a .* credential may not write this part/), role);
  }
  await op.reportState({ ...asArchitect, access: { role: "架构师", project: "Architect", roots: [] }, id: "a", state: "ci" });
  assert.equal(report(store, "a")!.state, "ci");
  // The table: the part exists and only the architect's role holds it.
  assert.ok(PARTS.includes("item.runner"));
  assert.deepEqual((["架构师", "观察者", "工程师", "审查", "资源管理"] as const).filter(role => ACCESS[role]["item.runner"] === "board"), ["架构师"]);
});

test("the runner reports from its own session as the author of the item's project, does no other part of the process, and takes no pushes", async t => {
  const { store, op } = await clocked(t);
  const runner = { author, session: "执行程序" };
  await op.reportState({ ...runner, id: "a", state: "ci", note: "Ming-Research/wf-board#100 的 CI", turns: 1, cost: 0.5 });
  assert.equal(report(store)!.state, "ci");
  assert.equal((await store.log({ limit: 1 }))[0]!.session, "执行程序", "the commit records the runner's session");
  await op.reportState({ ...runner, session: "  执行程序  ", id: "a", state: "running" });
  assert.equal(report(store)!.state, "running", "spaces around the name are ignored");
  // Ownership is as for any project's writer: the runner names the item's project as its author.
  await assert.rejects(() => op.reportState({ ...runner, id: "other", state: "running" }), refused(/item other belongs to project Firn/));
  // A near miss, another session or none is not the runner.
  const before = store.snapshot();
  for (const session of ["执行程序x", "x执行程序", "执行 程序", "engineer", undefined]) {
    await assert.rejects(() => op.reportState({ author, ...(session === undefined ? {} : { session }), id: "a", state: "ci" }), refused(rx`only ${PROCESS_WRITERS}, or the runner from the session 执行程序, may report the runner's state`));
  }
  assert.deepEqual(store.snapshot(), before);
  // Nothing else of the process: creating, rating, pausing, cancelling and retitling stay the architect's.
  const it = store.snapshot().items.a!;
  const only = rx`author: only ${PROCESS_WRITERS} may`;
  await assert.rejects(() => op.createItem({ ...runner, key: "made", group: author, title: "Made", accept: "ok" }), refused(only));
  await assert.rejects(() => op.setDifficulty({ ...runner, id: "a", difficulty: 3, reason: "r" }), refused(only));
  await assert.rejects(() => op.setPause({ ...runner, id: "a", paused: true, reason: "r" }), refused(only));
  await assert.rejects(() => op.setStatus({ ...runner, id: "a", status: "cancelled", log: "l" }), refused(only));
  await assert.rejects(() => op.updateItem({ ...runner, id: "a", rev: it.rev, title: "Renamed" }), refused(only));
  assert.deepEqual(store.snapshot(), before);
  // Over a credential the role's parts decide, whatever session the call names.
  await assert.rejects(() => op.reportState({ ...runner, access: { role: "工程师", project: "Whitefoot", roots: ["a"] }, id: "a", state: "running" }), refused(/item\.runner: a 工程师 credential may not write this part/));
  // The session name is the runner's alone: no dispatch and no credential file entry carries it.
  await assert.rejects(() => op.dispatchStart({ ...asArchitect, id: "a", role: "工程师", level: 2, model: "Sonnet", agent: "执行程序", agentId: "agent-9" }), refused(/agent 执行程序: that is the runner's session name/));
  assert.ok(!CredentialsFile.safeParse({ credentials: [{ session: "执行程序", role: "观察者", project: "Architect", roots: [], hash: hashToken("x") }] }).success, "no credential file entry under the runner's name");
});

test("the runner starts and ends a dispatch on its project's item without a credential, which an engineer's credential does not", async t => {
  const { store, op } = await clocked(t);
  const runner = { author, session: "执行程序" };
  const usage = { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 };
  // Without a credential these two check the item's project only (section 6 of docs/design.md); the credential's role is asked of the table.
  await op.dispatchStart({ ...runner, id: "a", role: "工程师", level: 2, model: "Sonnet", agent: "a-worker", agentId: "agent-1" });
  assert.equal(store.snapshot().items.a!.dispatches?.[0]?.agent, "a-worker");
  await op.dispatchFinish({ ...runner, id: "a", agentId: "agent-1", result: "一次通过", usage, cost: 1, reports: 0, kickbacks: 0 });
  assert.ok(store.snapshot().items.a!.dispatches?.[0]?.finish);
  const engineer = { ...runner, access: { role: "工程师" as const, project: "Whitefoot", roots: ["a"] } };
  await assert.rejects(() => op.dispatchStart({ ...engineer, id: "a", role: "工程师", level: 2, model: "Sonnet", agent: "b-worker", agentId: "agent-2" }), refused(/dispatch\.start: a 工程师 credential may not write this part/));
  await assert.rejects(() => op.dispatchFinish({ ...engineer, id: "a", agentId: "agent-1", result: "一次通过", usage, cost: 1, reports: 0, kickbacks: 0, replace: true }), refused(/dispatch\.finish: a 工程师 credential may not write this part/));
  // Another project's item is out of reach of the project's author, the runner included.
  await assert.rejects(() => op.dispatchStart({ ...runner, id: "other", role: "工程师", level: 2, model: "Sonnet", agent: "c-worker", agentId: "agent-3" }), refused(/item other belongs to project Firn/));
});

test("a report is never news to the owner, while a head change on the same item is", async t => {
  const { store, op } = await clocked(t);
  const before = store.snapshot().head;
  await op.reportState({ ...asArchitect, id: "a", state: "running", turns: 1, cost: 0.1 });
  await op.reportState({ ...asArchitect, id: "a", state: "ci", turns: 1, cost: 0.1, note: "CI" });
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
  const ok = await client.callTool({ name: "report_state", arguments: { ...asArchitect, id: "a", state: "ask", to: "architect", note: "问架构师" } });
  assert.equal(ok.isError, undefined, text(ok));
  assert.match(text(ok), /^report_state a ask · rev \d+ · commit [0-9a-f]{40}/);
  assert.equal(report(store)!.to, "architect");
  const bad = await client.callTool({ name: "report_state", arguments: { ...asArchitect, id: "a", state: "ask" } });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /to: a report of state ask says whom the work asks/);
});
