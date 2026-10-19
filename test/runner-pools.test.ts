// The runner's pools of slots (src/runner-pools.ts): the report is checked, kept in memory, and the owner is told once when a pool has had
// a free slot and nothing to start for an hour. docs/design.md, section 8, The runner's heartbeat, gives the reasons.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ops, OpError } from "../src/ops.ts";
import { createMcpServer } from "../src/mcp.ts";
import { RunnerHeartbeat } from "../src/runner-heartbeat.ts";
import { RunnerPools, checkedPools, dryMs, freeSlots, IDLE_TELL_MS, POOLS_MAX } from "../src/runner-pools.ts";
import type { PoolReport } from "../src/runner-pools.ts";
import { board, author } from "./helpers.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z"), MIN = 60_000, HOUR = 60 * MIN;
const runner = { author, session: "执行程序" };
const pool = (extra: Partial<PoolReport> = {}): PoolReport => ({ pool: "1", label: "1 级", slots: 10, running: 2, ...extra });
const upper = (extra: Partial<PoolReport> = {}): PoolReport => ({ pool: "upper", label: "2 级以上", slots: 6, running: 0, ...extra });

/** The pools on a clock the test sets, with the notices they gave the owner. */
function watched() {
  let clock = T0;
  const told: Array<{ title: string; message: string }> = [];
  const pools = new RunnerPools({ now: () => clock, tell: (title, message) => { told.push({ title, message }); } });
  return { pools, told, at: (ms: number) => { clock = ms; } };
}

test("the owner is told after an hour", () => {
  assert.equal(IDLE_TELL_MS, HOUR);
});

test("free slots are the slots not taken, and the time the queue has had nothing counts forward from the report's arrival", () => {
  assert.equal(freeSlots({ slots: 10, running: 3 }), 7);
  assert.equal(freeSlots({ slots: 2, running: 5 }), 0, "never below none");
  const { pools, at } = watched();
  const entry = pools.put([pool({ dryForSeconds: 600 }), pool({ pool: "full", slots: 2, running: 2, dryForSeconds: 600 }), upper()]);
  assert.equal(entry.at, new Date(T0).toISOString(), "the board's clock stamps the report");
  assert.equal(dryMs(entry, entry.pools[0]!, T0), 10 * MIN, "the runner's figure at the arrival");
  assert.equal(dryMs(entry, entry.pools[0]!, T0 + 5 * MIN), 15 * MIN, "and the time since the arrival added");
  assert.equal(dryMs(entry, entry.pools[1]!, T0), undefined, "a pool with no free slot is not dry");
  assert.equal(dryMs(entry, entry.pools[2]!, T0), undefined, "a pool the queue has something for is not dry");
  at(T0 + HOUR);
  assert.equal(pools.get(), entry, "the last report stays until the next");
});

test("nothing is told for a stretch under the hour, for a pool with no free slot, or for a pool the queue has something to start for", t => {
  t.mock.method(console, "warn", () => {});
  const { pools, told } = watched();
  pools.put([pool({ dryForSeconds: 3599 })]);
  pools.put([pool({ running: 10, dryForSeconds: 7200 })]);
  pools.put([pool()]);
  assert.deepEqual(told, []);
});

test("the owner is told once when a pool has had a free slot and nothing to start for an hour; the stretch ends when the pool is full or the queue has something, and the next stretch is told again", t => {
  t.mock.method(console, "warn", () => {});
  const { pools, told } = watched();
  pools.put([pool({ dryForSeconds: HOUR / 1000 })]);
  assert.equal(told.length, 1);
  assert.equal(told[0]!.title, "名额空着 · 1 级");
  assert.match(told[0]!.message, /^1 级空着 8 个，派活队列里没有能开工的活已 1 小时$/);
  pools.put([pool({ dryForSeconds: HOUR / 1000 + 60 })]);
  pools.put([pool({ dryForSeconds: HOUR / 1000 + 120 })]);
  assert.equal(told.length, 1, "the same stretch is told once");
  pools.put([pool()]);
  pools.put([pool({ dryForSeconds: HOUR / 1000 })]);
  assert.equal(told.length, 2, "the queue had something to start in between: a new stretch");
  pools.put([pool({ running: 10, dryForSeconds: 9000 })]);
  pools.put([pool({ dryForSeconds: HOUR / 1000 })]);
  assert.equal(told.length, 3, "all the slots were taken in between: a new stretch");
  pools.put([]);
  pools.put([pool({ dryForSeconds: HOUR / 1000 })]);
  assert.equal(told.length, 4, "a report that does not name the pool ends its stretch too");
});

test("each pool is told apart, and a notice for one does not hold back the other", t => {
  t.mock.method(console, "warn", () => {});
  const { pools, told } = watched();
  pools.put([pool({ dryForSeconds: 4000 }), upper()]);
  assert.deepEqual(told.map(x => x.title), ["名额空着 · 1 级"]);
  pools.put([pool({ dryForSeconds: 4060 }), upper({ dryForSeconds: 3700 })]);
  assert.deepEqual(told.map(x => x.title), ["名额空着 · 1 级", "名额空着 · 2 级以上"]);
  assert.match(told[1]!.message, /^2 级以上空着 6 个，派活队列里没有能开工的活已 1 小时 1 分$/);
});

test("a listener hears every report kept, and a notice that fails is logged and costs the report nothing", t => {
  const warn = t.mock.method(console, "warn", () => {});
  const error = t.mock.method(console, "error", () => {});
  const pools = new RunnerPools({ now: () => T0, tell: () => { throw new Error("no page"); } });
  const heard: number[] = [];
  const off = pools.onChange(entry => { heard.push(entry.pools.length); });
  pools.put([pool({ dryForSeconds: 4000 })]);
  pools.put([pool(), upper()]);
  off();
  pools.put([]);
  assert.deepEqual(heard, [1, 2], "until the listener is removed");
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(error.mock.callCount(), 1, "the failed notice is logged");
  assert.deepEqual(pools.get()?.pools, [], "and the reports were kept");
});

test("a report is checked: a list of at most eight pools with distinct keys, whole numbers and short texts; nothing else is kept", () => {
  assert.deepEqual(checkedPools([pool({ dryForSeconds: 5 })]), [{ pool: "1", label: "1 级", slots: 10, running: 2, dryForSeconds: 5 }]);
  assert.deepEqual(checkedPools([]), []);
  assert.deepEqual(checkedPools([{ pool: " 1 ", label: " 1 级 ", slots: 0, running: 0 }]), [{ pool: "1", label: "1 级", slots: 0, running: 0 }], "texts are trimmed");
  const bad: Array<[unknown, RegExp]> = [
    ["x", /^pools: give a list of pools$/],
    [Array.from({ length: POOLS_MAX + 1 }, (_, i) => pool({ pool: `p${i}` })), /at most 8 pools/],
    [[null], /pools\.0: give an object/],
    [[[]], /pools\.0: give an object/],
    [[{ ...pool(), extra: 1 }], /pools\.0: unknown extra/],
    [[pool({ pool: "" })], /pools\.0\.pool: give text of 1 to 20 characters/],
    [[pool({ label: "x".repeat(21) })], /pools\.0\.label: give text of 1 to 20 characters/],
    [[pool({ slots: -1 })], /pools\.0\.slots: give a whole number, 0 or more/],
    [[pool({ running: 1.5 })], /pools\.0\.running: give a whole number/],
    [[pool({ dryForSeconds: -3 })], /pools\.0\.dryForSeconds: give a whole number/],
    [[{ pool: "1", label: "1 级", slots: "10", running: 0 }], /pools\.0\.slots: give a whole number/],
    [[pool(), pool()], /pools\.1\.pool: 1 is given twice/],
  ];
  for (const [value, pattern] of bad) assert.throws(() => checkedPools(value), pattern);
});

test("a heartbeat with pools keeps them, a plain one leaves them as they were, and a report that does not hold is refused before the beat is kept", async t => {
  const { store } = await board(t);
  let clock = T0;
  const told: string[] = [];
  const heartbeat = new RunnerHeartbeat({ now: () => clock, tell: lastBeat => { told.push(lastBeat); } });
  const pools = new RunnerPools({ now: () => clock, tell: () => {} });
  const op = ops(store, () => "2026-10-19T08:00:00Z", { heartbeat, pools });
  const head = store.snapshot().head;
  assert.equal(pools.get(), undefined, "nothing is known before the first report");
  assert.match(await op.reportHeartbeat({ ...runner, pools: [pool({ dryForSeconds: 30 }), upper()] }), /^heartbeat 2026-10-19T08:00:00\.000Z · 2 pools · kept in memory and a local file, no commit$/);
  assert.deepEqual(pools.get()?.pools, [pool({ dryForSeconds: 30 }), upper()]);
  clock = T0 + MIN;
  assert.match(await op.reportHeartbeat(runner), /^heartbeat 2026-10-19T08:01:00\.000Z · kept in memory and a local file, no commit$/);
  assert.equal(pools.get()?.pools.length, 2, "a plain heartbeat leaves the pools as they were");
  assert.equal(store.snapshot().head, head, "neither makes a commit");
  // A report that does not hold is refused whole: the beat is not kept either, so a runner that only ever sends bad pools is missed.
  const fresh = new RunnerHeartbeat({ now: () => clock, tell: lastBeat => { told.push(lastBeat); } });
  const strict = ops(store, () => "2026-10-19T08:00:00Z", { heartbeat: fresh, pools });
  for (const bad of [[pool({ slots: -1 })], [pool(), pool()], "x" as unknown as PoolReport[]]) {
    await assert.rejects(() => strict.reportHeartbeat({ ...runner, pools: bad }), (error: unknown) => error instanceof OpError && /pools/.test(error.message));
  }
  assert.equal(pools.get()?.pools.length, 2, "and the pools kept stay");
  clock = T0 + 60 * MIN;
  fresh.check();
  assert.deepEqual(told, [], "no heartbeat was kept by those calls, so none is missed");
});

test("the tool takes pools as a list of objects with exactly their fields, and answers how many it kept", async t => {
  const { store } = await board(t);
  const pools = new RunnerPools({ now: () => T0, tell: () => {} });
  const op = ops(store, () => "2026-10-19T08:00:00Z", { pools });
  const server = createMcpServer({ store, ops: op, pools });
  const client = new Client({ name: "t", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>).map(c => c.text).join("\n");
  const tool = (await client.listTools()).tools.find(x => x.name === "report_heartbeat");
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.inputSchema.properties!).sort(), ["author", "pools", "session"]);
  assert.match(tool.description!, /pools \(optional\)/);
  const ok = await client.callTool({ name: "report_heartbeat", arguments: { ...runner, pools: [pool({ dryForSeconds: 7200 })] } });
  assert.equal(ok.isError, undefined, text(ok));
  assert.match(text(ok), /· 1 pools · kept in memory and a local file, no commit/);
  assert.equal(pools.get()?.pools[0]?.dryForSeconds, 7200);
  for (const bad of [[{ ...pool(), extra: 1 }], [pool({ slots: -1 })], [{ pool: "1", label: "1 级", slots: 1 }]]) {
    const refused = await client.callTool({ name: "report_heartbeat", arguments: { ...runner, pools: bad } });
    assert.equal(refused.isError, true, JSON.stringify(bad));
  }
  assert.equal(pools.get()?.pools.length, 1, "a refused call kept nothing");
});
