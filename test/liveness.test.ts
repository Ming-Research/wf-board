// Whether the sessions holding items are still there (docs/design.md, The wake streams, Liveness): when the board asks, when it
// tells the PM, what counts as a sign of life, and what a restart keeps.
import { once } from "node:events";
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { board, server, agentSocket, asArchitect, later } from "./helpers.ts";
import { ARCHITECT_SESSION } from "../src/model.ts";
import type { Snapshot } from "../src/model.ts";
import { ASK_AFTER_MS, TELL_AFTER_MS } from "../src/liveness.ts";
import { AGENT_STREAM_IDLE_MS, FOOTER_HEAD, FOOTER_LINES, Wake, WAKE_KINDS, lineOf } from "../src/wake.ts";
import type { Told } from "../src/wake.ts";
import { holders } from "../src/dispatch.ts";
import { createMcpServer } from "../src/mcp.ts";
import type { Resolved } from "../src/credentials.ts";

const T0 = Date.parse("2026-10-17T00:00:00Z"), MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
async function scratch(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-liveness-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const about = (item: string) => ({ project: "Whitefoot", title: "标题 " + item });

/** A board start: a wake over a clock the tests move, with the session `eng` holding `it1` and `it2`; `check` is one round of the minute
 * timer, `asks` what `eng` has been asked and `told` what the PM has been told. `restart` starts the board again over the same marks file. */
function rig(file?: string, clock = { now: T0 }) {
  const wake = new Wake({ now: () => clock.now, livenessFile: file });
  const held = new Map<string, string[]>([["eng", ["it1", "it2"]]]);
  wake.routeBy(item => [...held].find(([, items]) => items.includes(item))?.[0]);
  return {
    clock, wake, held, liveness: wake.liveness,
    at: (minutes: number) => { clock.now = T0 + minutes * MIN; },
    check: () => wake.liveness.check(held, about),
    asks: () => wake.agent("eng").since(0).frames.filter(f => f.event === "ask-alive"),
    told: () => wake.since(0).frames.filter(f => f.event === "no-answer"),
    restart: () => rig(file, clock),
  };
}

test("the times are 30 minutes to the ask and 30 more to the PM, and the kinds go where the design says", () => {
  assert.equal(ASK_AFTER_MS, 30 * MIN);
  assert.equal(TELL_AFTER_MS, 30 * MIN);
  assert.deepEqual(WAKE_KINDS["ask-alive"].to, { holder: "item" });
  assert.equal(WAKE_KINDS["no-answer"].to, "pm");
});

test("a silent holder is asked in its own stream after 30 minutes and the PM is told 30 minutes later, each once", () => {
  const r = rig();
  r.check();
  r.at(29); r.check();
  assert.equal(r.asks().length, 0, "29 minutes is not yet silence enough");
  r.at(30); r.check();
  assert.deepEqual(r.asks().map(f => [f.item, f.project, f.title, f.since]), [["it1", "Whitefoot", "标题 it1", iso(T0)]]);
  assert.deepEqual(r.wake.since(0).frames, [], "the ask is the holder's, not the PM's");
  for (const m of [31, 45, 59]) { r.at(m); r.check(); }
  assert.equal(r.told().length, 0, "the PM is told only 30 minutes after the ask");
  r.at(60); r.check();
  assert.deepEqual(r.told().map(f => [f.session, f.item, f.project, f.title, f.since]), [["eng", "it1", "Whitefoot", "标题 it1", iso(T0)]]);
  for (let m = 61; m <= 600; m += 30) { r.at(m); r.check(); }
  assert.equal(r.asks().length, 1, "one silence is asked once");
  assert.equal(r.told().length, 1, "and told once");
});

test("a sign ends the silence: the ask is answered, and the next silence is asked and told on its own", () => {
  const r = rig();
  r.check(); r.at(30); r.check();
  assert.equal(r.asks().length, 1);
  r.at(40); r.liveness.see("eng");
  r.at(69); r.check();
  assert.equal(r.told().length, 0, "the call answered the ask, so 30 minutes after it nobody is told");
  r.at(70); r.check();
  assert.equal(r.asks().length, 2, "30 minutes after the sign it is asked again");
  r.at(100); r.check();
  assert.equal(r.told().length, 1);
  r.at(110); r.liveness.see("eng");
  r.at(139); r.check();
  assert.equal(r.asks().length, 2);
  r.at(140); r.check();
  assert.deepEqual([r.asks().length, r.told().length], [3, 1], "after a told silence a sign starts everything over");
});

test("a sign before the ask moves the ask 30 minutes on", () => {
  const r = rig();
  r.check(); r.at(29); r.liveness.see("eng"); r.at(58); r.check();
  assert.equal(r.asks().length, 0);
  r.at(59); r.check();
  assert.equal(r.asks().length, 1);
});

test("a session holding nothing is not watched, and what the board knew of it is forgotten", () => {
  const r = rig();
  r.liveness.see("reviewer");
  r.at(300); r.check();
  assert.equal(r.wake.hasAgent("reviewer"), false, "a session that holds nothing is neither asked nor given a stream");
  assert.deepEqual(r.wake.since(0).frames, []);
  // eng gave its last sign at minute 0, stopped holding at minute 1 and holds again at minute 120: its old sign is gone, so
  // the silence starts at 120 and not at 0 (which would ask it at once).
  const r2 = rig();
  r2.liveness.see("eng");
  r2.at(1); r2.liveness.check(new Map(), about);
  r2.at(120); r2.check();
  r2.at(149); r2.check();
  assert.equal(r2.asks().length, 0);
  r2.at(150); r2.check();
  assert.equal(r2.asks().length, 1);
});

test("a silence before a restart counts after it: 20 minutes silent before, 10 more after, and it is asked", async t => {
  const file = join(await scratch(t), "liveness.json");
  const r = rig(file);
  r.check(); r.at(20); r.check();
  const second = r.restart();
  second.check(); r.at(29); second.check();
  assert.equal(second.asks().length, 0);
  r.at(30); second.check();
  assert.deepEqual(second.asks().map(f => f.since), [iso(T0)], "30 minutes silent in all, from the first round that saw the session");
});

test("the time the board was stopped is no silence: it is added back after a restart", async t => {
  const file = join(await scratch(t), "liveness.json");
  const r = rig(file);
  r.check(); r.at(10); r.check();
  r.at(190);
  const second = r.restart();
  second.check(); r.at(209); second.check();
  assert.equal(second.asks().length, 0, "silent for 10 minutes before the board stopped, 19 after it started: three hours stopped do not count");
  r.at(210); second.check();
  assert.deepEqual(second.asks().map(f => f.since), [iso(T0 + 180 * MIN)], "the silence began 180 minutes later than it did, by the time the board was stopped");
});

test("the asked and told marks survive a restart: a restart repeats nothing, and the time to answer an ask is not cut short by it", async t => {
  const file = join(await scratch(t), "liveness.json");
  const r = rig(file);
  r.check(); r.at(30); r.check();
  assert.equal(r.asks().length, 1);
  r.at(40);
  const second = r.restart();
  second.check(); r.at(69); second.check();
  assert.deepEqual([second.asks().length, second.told().length], [0, 0], "the restart does not ask again, and the 10 minutes it was stopped are not 10 of the 30 the session has to answer");
  r.at(70); second.check();
  assert.deepEqual(second.told().map(f => [f.session, f.since]), [["eng", iso(T0 + 10 * MIN)]], "30 minutes after the ask, by the clock of the board running; the silence began 10 minutes later than it did");
  r.at(500);
  const third = r.restart();
  third.check(); r.at(900); third.check();
  assert.deepEqual([third.asks().length, third.told().length], [0, 0], "a told silence stays told through a restart");
  third.liveness.see("eng");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).silences, { eng: { since: T0 + 900 * MIN } }, "a sign takes the ask and the tell out of the file at once");
  const fourth = r.restart();
  fourth.check(); r.at(931); fourth.check();
  assert.equal(fourth.asks().length, 1, "a new silence after the sign is asked");
});

test("a session that stops holding its item loses its silence, so holding again starts one from nothing", async t => {
  const file = join(await scratch(t), "liveness.json");
  const r = rig(file);
  r.check(); r.at(30); r.check();
  assert.ok(JSON.parse(await readFile(file, "utf8")).silences.eng.asked);
  r.at(31); r.liveness.check(new Map(), about);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).silences, {});
  r.at(100); r.check();
  r.at(129); r.check();
  assert.deepEqual([r.asks().length, r.told().length], [1, 0], "no immediate tell from the earlier ask");
  r.at(130); r.check();
  assert.equal(r.asks().length, 2);
});

test("a marks file that cannot be read starts every silence at the start", async t => {
  const file = join(await scratch(t), "liveness.json");
  await writeFile(file, "not json");
  const r = rig(file);
  r.check(); r.at(29); r.check();
  assert.equal(r.asks().length, 0);
  r.at(30); r.check();
  assert.equal(r.asks().length, 1);
});

test("a tool result does not carry an ask but counts it delivered; other pushes are shown around it", () => {
  const wake = new Wake({ now: () => T0 }), stream = wake.agent("eng");
  const ask = { item: "it1", project: "Whitefoot", title: "t", since: iso(T0) };
  const done = (c: string) => ({ item: c, project: "Whitefoot", title: "子条目", parent: "p" });
  stream.push("ask-alive", ask);
  assert.equal(wake.footer("eng"), "", "an ask alone shows nothing");
  assert.equal(stream.deliveredUpTo(), 1);
  stream.push("item-done", done("c1")); stream.push("ask-alive", ask); stream.push("item-done", done("c2"));
  assert.equal(wake.footer("eng"), [FOOTER_HEAD, lineOf(stream.since(1).frames[0]!), lineOf(stream.since(3).frames[0]!)].join("\n"));
  assert.equal(stream.deliveredUpTo(), 4);
  for (let i = 0; i < FOOTER_LINES + 1; i++) stream.push("item-done", done("d" + i));
  stream.push("ask-alive", ask);
  const first = wake.footer("eng").split("\n");
  assert.equal(first.length, 1 + FOOTER_LINES + 1);
  assert.equal(first.at(-1), "另有 1 条没送到（子条目做完 1）：再调一次看板，或挂等待脚本取");
  assert.equal(stream.deliveredUpTo(), 4 + FOOTER_LINES, "the one not shown, and the ask after it, wait");
  assert.deepEqual(wake.footer("eng").split("\n").length, 2, "the next call shows the one left and passes the ask");
  assert.equal(stream.pending().frames.length, 0);
});

test("a stream left with only an ask nobody read is dropped when it goes unused, one left with another push is kept", () => {
  let clock = T0;
  const wake = new Wake({ now: () => clock });
  wake.agent("dead").push("ask-alive", { item: "it1", project: "Whitefoot", title: "t", since: iso(T0) });
  wake.agent("away").push("item-done", { item: "c", project: "Whitefoot", title: "t", parent: "p" });
  clock += AGENT_STREAM_IDLE_MS - 1; wake.prune(() => false);
  assert.deepEqual(["dead", "away"].filter(name => wake.hasAgent(name)), ["dead", "away"], "not before it is unused for a week");
  clock += 2; wake.prune(() => false);
  assert.deepEqual(["dead", "away"].filter(name => wake.hasAgent(name)), ["away"]);
});

test("a gap is still told when only asks are pending", () => {
  const wake = new Wake({ now: () => T0 }), stream = wake.agent("eng");
  for (let i = 0; i < 201; i++) stream.push("ask-alive", { item: "it1", project: "Whitefoot", title: "t", since: iso(T0) });
  assert.equal(wake.footer("eng"), `${FOOTER_HEAD}\n有推送没送到就被丢了（看板只留 #2 及以后的）：去看板读最近的变化`);
  assert.equal(stream.deliveredUpTo(), 201);
  assert.equal(wake.footer("eng"), "");
});

test("the lines of the two kinds name the item, the time of the last sign and, for the PM, the session", () => {
  const ask = new Wake({ now: () => T0 }).agent("eng").push("ask-alive", { item: "it1", project: "Whitefoot", title: "t", since: iso(T0) });
  assert.equal(lineOf(ask), "#1 问一句 · it:it1（Whitefoot） · 最后一次动静 2026-10-17T00:00Z，调一次看板就算在");
  const none = new Wake({ now: () => T0 }).push("no-answer", { session: "eng", item: "it1", project: "Whitefoot", title: "做某事", since: iso(T0) });
  assert.equal(lineOf(none), "#1 没回应 · it:it1（Whitefoot） · 会话 eng · 最后一次动静 2026-10-17T00:00Z · 做某事");
});

test("a no-answer the PM leaves unanswered for an hour tells the owner, and a click opens its item", () => {
  let clock = T0;
  const wake = new Wake({ now: () => clock }), notices: Told[] = [];
  wake.onTell(told => notices.push(told));
  wake.push("no-answer", { session: "eng", item: "it1", project: "Whitefoot", title: "做某事", since: iso(T0) });
  clock += wake.receiptLimitMs; wake.checkReceipts();
  assert.deepEqual(notices, [{ title: "架构师 1 小时没响应", message: "最早没回执的是 #1：没回应：做某事", target: { kind: "item", key: "it1" } }]);
});

test("a tool call is a sign of life for the session it is made as: the credential's, else the name the call gives, never the PM's", async t => {
  const { store, op } = await board(t), wake = new Wake({ now: () => T0 });
  const see = t.mock.method(wake.liveness, "see");
  const call = async (args: Record<string, unknown>, credential?: Resolved) => {
    const mcp = createMcpServer({ store, ops: op, wake, credential }), client = new Client({ name: "Sign", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
    await mcp.connect(st); await client.connect(ct);
    t.after(async () => { await client.close(); await mcp.close(); });
    return client.callTool({ name: "projects", arguments: args });
  };
  const seen = () => see.mock.calls.map(c => c.arguments[0]);
  await call({ session: "eng" });
  await call({ session: " eng-2 " });
  await call({});
  await call({ session: ARCHITECT_SESSION });
  assert.deepEqual(seen(), ["eng", "eng-2"], "a read counts, the name is trimmed, no name and the PM count for no one");
  const credential: Resolved = { ok: true, who: { author: "Whitefoot", session: "cred-eng", access: { role: "工程师", project: "Whitefoot", roots: ["a"] } } };
  await call({ session: "eng" }, credential);
  const architect: Resolved = { ok: true, who: { author: "Architect", session: ARCHITECT_SESSION, access: { role: "架构师", project: "Architect", roots: [] } } };
  await call({ session: "eng" }, architect);
  assert.deepEqual(seen(), ["eng", "eng-2", "cred-eng"], "the credential's session, not the one the call names; the PM's credential is no one's sign");
});

test("holders maps each session to the items it holds, in item order, by the one reading of holding", () => {
  const d = (agent: string, started: string, extra: object = {}) => ({ role: "工程师", agent, agentId: agent + started, level: 2, model: "m", started, ...extra });
  const s = { items: {
    x: { dispatches: [d("eng", "2026-10-16T01:00:00Z")] },
    y: { dispatches: [d("other", "2026-10-16T01:00:00Z"), d("eng", "2026-10-16T02:00:00Z")] },
    z: { dispatches: [d("eng", "2026-10-16T01:00:00Z", { finish: {} })] },
    w: { dispatches: [{ ...d("rev", "2026-10-16T01:00:00Z"), role: "审查" }] },
    v: { dispatches: [d("late", "2026-10-16T01:00:00Z")] },
  } } as unknown as Pick<Snapshot, "items">;
  assert.deepEqual([...holders(s)], [["eng", ["x", "y"]], ["late", ["v"]]]);
  assert.deepEqual([...holders(s, item => item !== "x")], [["eng", ["y"]], ["late", ["v"]]], "only the items the filter accepts");
  assert.deepEqual([...holders(s, () => false)], []);
});

/** Make `item` ready as `prepare` says, dispatch an engineer on it, and let two hours pass without a sign from it: what the
 * session was asked, what the PM was told, and the item's status. */
type Op = Awaited<ReturnType<typeof server>>["op"];
async function twoSilentHours(t: TestContext, item: string, prepare: (op: Op) => Promise<unknown>, start = T0) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const clock = { now: start }, wake = new Wake({ now: () => clock.now });
  const { op, store } = await server(t, { wake, now: () => clock.now, checkIntervalMs: 1000, timedWakeMs: 1e12 });
  await prepare(op);
  await op.dispatchStart({ ...asArchitect, id: item, role: "工程师", level: 2, model: "Sonnet", agent: "eng", agentId: "agent-1" });
  const tick = async () => { t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); };
  await tick();
  for (let i = 0; i < 4; i++) { clock.now += 30 * MIN; await tick(); }
  return {
    status: store.derived.rules(store.snapshot(), clock.now).statusOf(item),
    asked: wake.agent("eng").since(0).frames.filter(f => f.event === "ask-alive").length,
    told: wake.since(0).frames.filter(f => f.event === "no-answer").length,
  };
}
const acceptRow = (state: "todo" | "doing" | "done") => ({ id: "accept", accept: true as const, text: "独立验收通过", state });

test("a session holding an item in progress is asked after 30 minutes and the PM told after 30 more", async t => {
  const result = await twoSilentHours(t, "a", op => op.setPlan({ ...asArchitect, id: "a", row: acceptRow("doing") }));
  assert.deepEqual(result, { status: "wip", asked: 1, told: 1 });
});

test("a session holding an item whose work is done and whose pull request waits for the merge is asked and told: a live session makes it in progress", async t => {
  const result = await twoSilentHours(t, "a", async op => {
    // The fixture's item carries an unanswered ask to the owner, which would make it blocked.
    await op.clearAsk({ ...asArchitect, id: "a", log: "测试" });
    await op.setPlan({ ...asArchitect, id: "a", row: acceptRow("done") });
    await op.setPlan({ ...asArchitect, id: "a", row: { id: "merge", text: "合入 wf-board#1", state: "todo" } });
    // The dispatch is stamped with the fixture's clock, and a session is live for six hours from it: count from there.
  }, Date.parse(later));
  assert.deepEqual(result, { status: "wip", asked: 1, told: 1 });
});

for (const [name, item, status, prepare] of [
  ["paused", "a", "paused", async (op: Op) => { await op.setPlan({ ...asArchitect, id: "a", row: acceptRow("doing") }); await op.setPause({ ...asArchitect, id: "a", paused: true, reason: "测试" }); }],
  ["blocked", "b", "blocked", async () => {}],
  ["done", "a", "done", async (op: Op) => { await op.setPlan({ ...asArchitect, id: "a", row: acceptRow("done") }); }],
  ["cancelled", "a", "cancelled", async (op: Op) => { await op.setStatus({ ...asArchitect, id: "a", status: "cancelled", log: "测试" }); }],
] as const) {
  test(`a session holding a ${name} item is neither asked nor told`, async t => {
    assert.deepEqual(await twoSilentHours(t, item, prepare), { status, asked: 0, told: 0 });
  });
}

test("on the server an alive frame from the wait script is a sign, its connection and its end are not; a silent holder is asked, then the PM is told, with the item's project and title", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const clock = { now: T0 }, wake = new Wake({ now: () => clock.now });
  const { url, op } = await server(t, { wake, now: () => clock.now, checkIntervalMs: 1000, timedWakeMs: 1e12 });
  await op.setPlan({ ...asArchitect, id: "a", row: acceptRow("doing") });
  await op.dispatchStart({ ...asArchitect, id: "a", role: "工程师", level: 2, model: "Sonnet", agent: "eng", agentId: "agent-1" });
  const tick = async () => { t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); };
  const asked = () => wake.agent("eng").since(0).frames.filter(f => f.event === "ask-alive");
  const told = () => wake.since(0).frames.filter(f => f.event === "no-answer");
  const script = await agentSocket(t, url, "eng");
  const send = async (message: string) => { script.socket.send(message); await script.sync(); };
  await tick();
  for (let i = 0; i < 6; i++) { clock.now += 20 * MIN; await send(JSON.stringify({ alive: true })); await tick(); }
  assert.equal(asked().length, 0, "two hours of alive frames, never asked");
  clock.now += 29 * MIN;
  for (const message of [JSON.stringify({ alive: false }), JSON.stringify({ alive: "yes" }), JSON.stringify({ ack: 0 }), "not json"]) await send(message);
  await tick();
  assert.equal(asked().length, 0, "29 minutes after the last frame");
  clock.now += 2 * MIN; await tick();
  assert.deepEqual(asked().map(f => [f.item, f.project, f.title]), [["a", "Whitefoot", "中文检查"]], "30 minutes after the last frame, with the script still connected and other messages sent");
  script.socket.close(); await once(script.socket, "close");
  clock.now += 29 * MIN; await tick();
  assert.equal(told().length, 0);
  clock.now += 1 * MIN; await tick();
  assert.deepEqual(told().map(f => [f.session, f.item, f.project, f.title]), [["eng", "a", "Whitefoot", "中文检查"]], "30 minutes after the ask, whether the connection ended or not");
});
