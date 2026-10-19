// The runner's heartbeat (report_heartbeat, item board-runner-fits): the board keeps the time of the last call, tells the architect once
// when none comes for the limit, and the next call ends the silence. docs/design.md, section 8, The runner's heartbeat, gives the reasons.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ops, OpError } from "../src/ops.ts";
import { createMcpServer } from "../src/mcp.ts";
import { RunnerHeartbeat, RUNNER_SILENT_MS } from "../src/runner-heartbeat.ts";
import { Wake, WAKE_KINDS, lineOf } from "../src/wake.ts";
import { ARCHITECT_SESSION, PROCESS_WRITERS } from "../src/model.ts";
import { board, author, asArchitect, rx } from "./helpers.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z"), MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const refused = (pattern: RegExp) => (error: unknown) => error instanceof OpError && pattern.test(error.message);
const runner = { author, session: "执行程序" };

/** A heartbeat on a clock the test sets, with what it told. */
function watched(options: { file?: string; limitMs?: number } = {}) {
  let clock = T0;
  const told: Array<{ lastBeat: string; limitMs: number }> = [];
  const heartbeat = new RunnerHeartbeat({ ...options, now: () => clock, tell: (lastBeat, limitMs) => { told.push({ lastBeat, limitMs }); } });
  return { heartbeat, told, at: (ms: number) => { clock = ms; } };
}
/** A scratch directory for the local file, removed with the test. */
async function scratch(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-heartbeat-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "state", "runner-heartbeat.json");
}

test("the limit is ten minutes", () => {
  assert.equal(RUNNER_SILENT_MS, 10 * MIN);
});

test("nothing is told before the first heartbeat, however long the board has run", t => {
  t.mock.method(console, "warn", () => {});
  const { heartbeat, told, at } = watched();
  at(T0 + 5 * 60 * MIN);
  heartbeat.check();
  assert.deepEqual(told, [], "a runner that never promised a heartbeat is not missed");
});

test("a silence of the limit is told once, with the last heartbeat; a later heartbeat ends it and a later silence is told again", t => {
  const warn = t.mock.method(console, "warn", () => {});
  const { heartbeat, told, at } = watched();
  heartbeat.beat();
  at(T0 + 9 * MIN + 59_000);
  heartbeat.check();
  assert.deepEqual(told, [], "just under the limit");
  at(T0 + 10 * MIN);
  heartbeat.check();
  assert.deepEqual(told, [{ lastBeat: iso(T0), limitMs: 10 * MIN }], "at the limit");
  assert.equal(warn.mock.callCount(), 1, "and the service log says so");
  // The same silence is not told again, however many rounds pass.
  for (let k = 11; k < 100; k += 7) { at(T0 + k * MIN); heartbeat.check(); }
  assert.equal(told.length, 1);
  // The runner comes back; ten minutes of silence after that are a new silence.
  at(T0 + 100 * MIN);
  heartbeat.beat();
  at(T0 + 109 * MIN);
  heartbeat.check();
  assert.equal(told.length, 1, "a heartbeat ends the silence");
  at(T0 + 110 * MIN);
  heartbeat.check();
  assert.deepEqual(told.at(-1), { lastBeat: iso(T0 + 100 * MIN), limitMs: 10 * MIN });
  assert.equal(told.length, 2);
});

test("a heartbeat that keeps coming keeps the board quiet", t => {
  t.mock.method(console, "warn", () => {});
  const { heartbeat, told, at } = watched();
  for (let k = 0; k <= 200; k++) { at(T0 + k * MIN); heartbeat.beat(); if (k % 3 === 0) heartbeat.check(); }
  at(T0 + 209 * MIN);
  heartbeat.check();
  assert.deepEqual(told, []);
});

test("the last heartbeat is kept in a local file at most once a minute, and the next run reads it", async t => {
  const file = await scratch(t);
  t.mock.method(console, "warn", () => {});
  const first = watched({ file });
  first.heartbeat.beat();
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { last: T0 }, "the first heartbeat writes");
  first.at(T0 + 30_000);
  first.heartbeat.beat();
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { last: T0 }, "one within the minute does not");
  first.at(T0 + MIN);
  first.heartbeat.beat();
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { last: T0 + MIN }, "one a minute on does");
  // The board restarts, with its clock back at T0; the file says the runner was last heard at T0 + 1 minute.
  const second = watched({ file });
  second.at(T0 + 4 * MIN);
  second.heartbeat.check();
  assert.deepEqual(second.told, [], "the runner is watched after a restart: not yet silent for the limit");
});

test("after a restart the silence is counted from the start at the earliest, and a runner that stopped before it is told then", async t => {
  const file = await scratch(t);
  t.mock.method(console, "warn", () => {});
  // The run before kept a heartbeat three hours ago; the board starts now.
  const before = watched({ file });
  before.at(T0 - 180 * MIN);
  before.heartbeat.beat();
  const after = watched({ file });
  after.heartbeat.check();
  assert.deepEqual(after.told, [], "at the start the board has been stopped, not the runner");
  after.at(T0 + 9 * MIN);
  after.heartbeat.check();
  assert.deepEqual(after.told, [], "the runner has the limit from the start to send a heartbeat");
  after.at(T0 + 10 * MIN);
  after.heartbeat.check();
  assert.deepEqual(after.told, [{ lastBeat: iso(T0 - 180 * MIN), limitMs: 10 * MIN }], "then it is told, with the last heartbeat that was kept");
  // A heartbeat inside that time keeps the board quiet.
  const alive = watched({ file });
  alive.at(T0 + 5 * MIN);
  alive.heartbeat.beat();
  alive.at(T0 + 14 * MIN);
  alive.heartbeat.check();
  assert.deepEqual(alive.told, []);
});

test("a file that is not ours, or none, leaves the runner unwatched until its first heartbeat; a file that cannot be written costs nothing", async t => {
  const file = await scratch(t);
  t.mock.method(console, "warn", () => {}); t.mock.method(console, "error", () => {});
  const none = watched({ file });
  none.at(T0 + 60 * MIN);
  none.heartbeat.check();
  assert.deepEqual(none.told, []);
  await mkdir(join(file, ".."), { recursive: true });
  for (const text of ["not json", '{"last":"yesterday"}', "[]", '{"last":null}']) {
    await writeFile(file, text);
    const odd = watched({ file });
    odd.at(T0 + 60 * MIN);
    odd.heartbeat.check();
    assert.deepEqual(odd.told, [], text);
  }
  // The place of the file is a file itself: the write fails, the heartbeat is still kept in memory and still watched.
  await writeFile(join(file, "..", "blocker"), "x");
  const blocked = watched({ file: join(file, "..", "blocker", "runner-heartbeat.json") });
  blocked.heartbeat.beat();
  blocked.at(T0 + 10 * MIN);
  blocked.heartbeat.check();
  assert.equal(blocked.told.length, 1);
});

test("runner-stopped is a push to the architect, and the line says when and how long", () => {
  assert.equal(WAKE_KINDS["runner-stopped"].to, "architect");
  assert.deepEqual([...WAKE_KINDS["runner-stopped"].fields].sort(), ["lastBeat", "limitMs"]);
  const wake = new Wake({ now: () => T0 });
  wake.push("runner-stopped", { lastBeat: "2026-10-19T07:41:00.000Z", limitMs: 10 * MIN });
  const [frame] = wake.agent(ARCHITECT_SESSION).pending().frames;
  assert.equal(frame!.event, "runner-stopped");
  assert.equal(lineOf(frame!), "#1 执行程序停了 · 最后一次心跳 2026-10-19T07:41Z，10 分钟没有新的");
  assert.equal(frame!.line, lineOf(frame!), "and it is the line the frame carries");
  assert.throws(() => wake.push("runner-stopped", { lastBeat: "x" }), /takes the fields/);
});

test("the heartbeat reaches the architect's stream through the board's own parts, and a heartbeat after it ends the silence", async t => {
  t.mock.method(console, "warn", () => {});
  let clock = T0;
  const wake = new Wake({ now: () => clock });
  const heartbeat = new RunnerHeartbeat({ now: () => clock, tell: (lastBeat, limitMs) => { wake.push("runner-stopped", { lastBeat, limitMs }); } });
  const { store } = await board(t);
  const op = ops(store, () => "2026-10-19T08:00:00Z", { heartbeat });
  await op.reportHeartbeat(runner);
  clock = T0 + 10 * MIN;
  heartbeat.check();
  const events = () => wake.agent(ARCHITECT_SESSION).pending().frames.map(f => f.event);
  assert.deepEqual(events(), ["runner-stopped"]);
  await op.reportHeartbeat(runner);
  clock = T0 + 15 * MIN;
  heartbeat.check();
  assert.deepEqual(events(), ["runner-stopped"], "a heartbeat after the push ended the silence");
  clock = T0 + 20 * MIN;
  heartbeat.check();
  assert.deepEqual(events(), ["runner-stopped", "runner-stopped"], "and a later silence is told again");
});

test("the writers are those of the runner's report: the architect and the runner; every other role and writer is refused and keeps nothing", async t => {
  const { store } = await board(t);
  const { heartbeat, told, at } = watched();
  const op = ops(store, () => "2026-10-19T08:00:00Z", { heartbeat });
  const head = store.snapshot().head;
  for (const session of ["执行程序x", "x执行程序", "engineer", undefined]) {
    await assert.rejects(() => op.reportHeartbeat({ author, ...(session === undefined ? {} : { session }) }), refused(rx`only ${PROCESS_WRITERS}, or the runner from the session 执行程序, may report the runner's heartbeat`), String(session));
  }
  for (const role of ["工程师", "审查", "观察者", "资源管理"] as const) {
    await assert.rejects(() => op.reportHeartbeat({ ...asArchitect, access: { role, project: "Whitefoot", roots: ["a"] } }), refused(/item\.runner: a .* credential may not write this part/), role);
  }
  await assert.rejects(() => op.reportHeartbeat({ author: "Nobody", session: "执行程序" }), refused(/author Nobody: choose a configured project/));
  await assert.rejects(() => op.reportHeartbeat({ author: "总管", session: "执行程序" }), refused(/retired/));
  // None of those was kept: a heartbeat watch that has kept none tells nothing, however late.
  at(T0 + 60 * MIN);
  heartbeat.check();
  assert.deepEqual(told, []);
  // The architect, the runner, the runner with spaces around its name, and a credential of the architect's role are kept; none commits.
  await op.reportHeartbeat({ ...asArchitect });
  await op.reportHeartbeat({ ...runner });
  await op.reportHeartbeat({ ...runner, session: "  执行程序  " });
  await op.reportHeartbeat({ ...asArchitect, access: { role: "架构师", project: "Architect", roots: [] } });
  assert.equal(store.snapshot().head, head, "no commit");
  at(T0 + 70 * MIN);
  heartbeat.check();
  assert.deepEqual(told, [{ lastBeat: iso(T0 + 60 * MIN), limitMs: 10 * MIN }], "the accepted calls were kept");
});

test("the tool over MCP answers the time kept and takes the identity of a connection the same way report_state does", async t => {
  const { store } = await board(t);
  const { heartbeat } = watched();
  const op = ops(store, () => "2026-10-19T08:00:00Z", { heartbeat });
  const server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "t", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>).map(c => c.text).join("\n");
  const tool = (await client.listTools()).tools.find(x => x.name === "report_heartbeat");
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.inputSchema.properties!).sort(), ["author", "session"], "no other argument");
  assert.match(tool.description!, /10 minutes/);
  const ok = await client.callTool({ name: "report_heartbeat", arguments: runner });
  assert.equal(ok.isError, undefined, text(ok));
  assert.match(text(ok), /^heartbeat 2026-10-19T08:00:00\.000Z · kept in memory and a local file, no commit/);
  const other = await client.callTool({ name: "report_heartbeat", arguments: { author, session: "someone" } });
  assert.equal(other.isError, true);
  assert.match(text(other), /may report the runner's heartbeat/);
  const extra = await client.callTool({ name: "report_heartbeat", arguments: { ...runner, id: "a" } });
  assert.equal(extra.isError, true, "an argument the tool does not take is refused");
});
