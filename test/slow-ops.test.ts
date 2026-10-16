import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { board, author, wakeSocket } from "./helpers.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { createHttpServer } from "../src/http.ts";
import { createMcpServer } from "../src/mcp.ts";
import { Wake } from "../src/wake.ts";
import { OPERATION_LIMITS_MS, SlowOps, TELL_AGAIN_MS, TIME_LIMITS_MS, pageOperation, requestParams, summarize, toolClass } from "../src/slow-ops.ts";
import type { OperationClass } from "../src/slow-ops.ts";

const T0 = Date.parse("2026-10-16T00:00:00Z");
/** Runs `fn` with the service log captured: what it printed on info and on warn. */
async function logged<T>(fn: () => Promise<T> | T): Promise<{ result: T; info: string[]; warn: string[] }> {
  const info: string[] = [], warn: string[] = [];
  const { info: i, warn: w } = console;
  console.info = (...parts: unknown[]) => { info.push(parts.join(" ")); };
  console.warn = (...parts: unknown[]) => { warn.push(parts.join(" ")); };
  try { return { result: await fn(), info, warn }; } finally { console.info = i; console.warn = w; }
}
const slowFrames = (wake: Wake) => wake.since(0).frames.filter(f => f.event === "slow-op");
/** A SlowOps over a Wake whose clock `time` moves. */
function rig(limitsMs?: Partial<Record<OperationClass, number>>) {
  const time = { now: T0 }, wake = new Wake({ now: () => time.now }), slow = new SlowOps({ wake, now: () => time.now, limitsMs });
  return { time, wake, slow };
}

test("the class limits are the starting values, and mark-read keeps its own lower one", () => {
  assert.deepEqual(TIME_LIMITS_MS, { read: 1000, write: 2000, history: 10_000 });
  assert.deepEqual(OPERATION_LIMITS_MS, { "POST /api/read": 300 });
});

test("an operation over its class limit is told to the architect with its name, time, limit and parameters; one at the limit is not", async t => {
  const { wake, slow } = rig();
  const { info, warn } = await logged(() => {
    slow.record({ name: "tool context", cls: "read", ms: 1000, result: "ok", params: () => "id=a" });
    assert.deepEqual(slowFrames(wake), [], "exactly at the limit is within it");
    slow.record({ name: "tool context", cls: "read", ms: 1001, result: "ok", params: () => "id=a log=all" });
  });
  const [frame] = slowFrames(wake);
  assert.deepEqual(frame, { n: 1, at: "2026-10-16T00:00:00.000Z", event: "slow-op", op: "tool context", ms: 1001, limitMs: 1000, params: "id=a log=all" });
  assert.deepEqual(info, ["tool context ok 1000 ms", "tool context ok 1001 ms"], "every operation is logged with its time, slow or not");
  assert.deepEqual(warn, ["slow tool context: 1001 ms, limit 1000 ms (id=a log=all)"]);
});

test("each class has its own limit, and an operation with a limit of its own uses that", async t => {
  const { wake, slow } = rig();
  await logged(() => {
    slow.record({ name: "tool diff", cls: "history", ms: 10_000, result: "ok" });
    slow.record({ name: "tool set_plan", cls: "write", ms: 2000, result: "ok" });
    slow.record({ name: "GET /api/snapshot", cls: "read", ms: 1000, result: "200" });
    slow.record({ name: "POST /api/read", cls: "write", ms: 300, result: "200" });
    assert.deepEqual(slowFrames(wake), [], "none is over its own limit");
    slow.record({ name: "tool diff", cls: "history", ms: 10_001, result: "ok" });
    slow.record({ name: "tool set_plan", cls: "write", ms: 2001, result: "ok" });
    slow.record({ name: "GET /api/snapshot", cls: "read", ms: 1001, result: "200" });
    // Under the write class's 2000 ms, yet over the 300 ms the mark-read key has.
    slow.record({ name: "POST /api/read", cls: "write", ms: 301, result: "200" });
  });
  assert.deepEqual(slowFrames(wake).map(f => [f.op, f.ms, f.limitMs]), [["tool diff", 10_001, 10_000], ["tool set_plan", 2001, 2000], ["GET /api/snapshot", 1001, 1000], ["POST /api/read", 301, 300]]);
});

test("an operation with no class is logged and never told, however long it ran", async t => {
  const { wake, slow } = rig();
  const { info, warn } = await logged(() => slow.record({ name: "GET /api/events", ms: 3_600_000, result: "200" }));
  assert.deepEqual(info, ["GET /api/events 200 3600000 ms"]);
  assert.deepEqual([warn, slowFrames(wake)], [[], []]);
});

test("the same operation is told once an hour, later ones only logged, and again when the hour has passed", async t => {
  const { time, wake, slow } = rig();
  const { warn } = await logged(() => {
    slow.record({ name: "tool brief", cls: "read", ms: 1500, result: "ok" });
    time.now += 10 * 60_000;
    slow.record({ name: "tool brief", cls: "read", ms: 4000, result: "ok" });
    // Another operation is its own, whatever the first did.
    slow.record({ name: "tool context", cls: "read", ms: 1500, result: "ok" });
    time.now += TELL_AGAIN_MS - 10 * 60_000 - 1;
    slow.record({ name: "tool brief", cls: "read", ms: 1500, result: "ok" });
    assert.deepEqual(slowFrames(wake).map(f => f.op), ["tool brief", "tool context"], "one millisecond short of the hour");
    time.now += 1;
    slow.record({ name: "tool brief", cls: "read", ms: 1600, result: "ok" });
  });
  assert.deepEqual(slowFrames(wake).map(f => [f.op, f.ms]), [["tool brief", 1500], ["tool context", 1500], ["tool brief", 1600]]);
  assert.equal(warn.length, 5, "every slow call is in the log, told or not");
  assert.match(warn[1]!, /^slow tool brief: 4000 ms, limit 1000 ms; the architect was told 10 min ago$/);
  assert.doesNotMatch(warn[0]!, /was told/);
});

test("a restart does not tell again within the hour what the kept pushes already told", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-slow-")), file = join(dir, "wake.jsonl");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const time = { now: T0 }, wake = new Wake({ now: () => time.now, file });
  await logged(() => new SlowOps({ wake, now: () => time.now }).record({ name: "tool brief", cls: "read", ms: 1500, result: "ok" }));
  assert.equal(slowFrames(wake).length, 1);
  // The daemon starts again: a new Wake reads the file, a new SlowOps starts from what it holds.
  time.now += 20 * 60_000;
  const reloaded = new Wake({ now: () => time.now, file }), after = new SlowOps({ wake: reloaded, now: () => time.now });
  await logged(() => after.record({ name: "tool brief", cls: "read", ms: 1500, result: "ok" }));
  assert.equal(slowFrames(reloaded).length, 1, "told 20 minutes ago: not again");
  time.now += 40 * 60_000;
  await logged(() => after.record({ name: "tool brief", cls: "read", ms: 1500, result: "ok" }));
  assert.equal(slowFrames(reloaded).length, 2, "an hour after the first");
});

test("without a wake, a slow operation is logged and nothing else happens", async t => {
  const slow = new SlowOps();
  const { warn } = await logged(() => slow.record({ name: "tool brief", cls: "read", ms: 1500, result: "ok", params: () => "id=a" }));
  assert.deepEqual(warn, ["slow tool brief: 1500 ms, limit 1000 ms (id=a)"]);
});

test("a failing parameter summary does not lose the push", async t => {
  const { wake, slow } = rig();
  await logged(() => slow.record({ name: "tool brief", cls: "read", ms: 1500, result: "ok", params: () => { throw new Error("boom"); } }));
  assert.equal(slowFrames(wake)[0]!.params, "");
});

test("start times from the call to the end, in real time", async t => {
  const { wake, slow } = rig({ read: 30 });
  await logged(async () => {
    const quick = slow.start("tool quick", "read");
    quick("ok");
    const slowOne = slow.start("tool slow", "read");
    await sleep(120);
    slowOne("ok", () => "id=a");
  });
  const frames = slowFrames(wake);
  assert.deepEqual(frames.map(f => f.op), ["tool slow"]);
  assert.ok((frames[0]!.ms as number) >= 100 && (frames[0]!.ms as number) < 1000, `measured ${String(frames[0]!.ms)} ms for a 120 ms wait`);
  assert.equal(frames[0]!.limitMs, 30);
});

test("pages are classed by route: reads, history, writes; the streams and the MCP transport have no limit; other paths share one name", () => {
  const cls = (method: string, path: string) => pageOperation(method, path);
  for (const path of ["/", "/app.js", "/health", "/api/snapshot"]) assert.deepEqual(cls("GET", path), { name: `GET ${path}`, cls: "read" }, path);
  for (const path of ["/api/unread", "/api/step"]) assert.deepEqual(cls("GET", path), { name: `GET ${path}`, cls: "history" }, path);
  for (const path of ["/api/notes", "/api/draft", "/api/send", "/api/read", "/api/wake"]) assert.deepEqual(cls("POST", path), { name: `POST ${path}`, cls: "write" }, path);
  assert.deepEqual(cls("DELETE", "/api/notes/qfs61so04uwd3lw1491o"), { name: "DELETE /api/notes/:id", cls: "write" });
  for (const [method, path] of [["GET", "/api/events"], ["GET", "/mcp"], ["POST", "/mcp"], ["DELETE", "/mcp"]] as const) assert.deepEqual(cls(method, path), { name: `${method} ${path}` }, `${method} ${path}`);
  assert.deepEqual(cls("GET", "/wp-login.php"), { name: "GET (unknown route)", cls: "read" });
  assert.deepEqual(cls("GET", "/__proto__"), { name: "GET (unknown route)", cls: "read" });
});

test("tools are classed: the history readers by name, writes by their flag, the rest reads", () => {
  assert.deepEqual(["changes", "history", "diff"].map(n => toolClass(n, false)), ["history", "history", "history"]);
  assert.equal(toolClass("set_plan", true), "write");
  assert.equal(toolClass("context", false), "read");
});

test("a parameter summary shows the names of things and the sizes of text, never the text", () => {
  const body = "SECRET-BODY ".repeat(200);
  const text = summarize({ id: "slow-op-alerts", author: "wf-board", session: "slow-op-alerts", head: body, log: "an entry", text: "short text", limit: 5, paused: true, rows: [1, 2, 3], filters: { under: "board-perf", status: ["todo"], deep: { group: "x" } }, skipped: undefined, none: null });
  assert.equal(text, "id=slow-op-alerts author(8 chars) session=slow-op-alerts head(2400 chars) log(8 chars) text(10 chars) limit=5 paused=true rows[3] filters{under=board-perf status[1] deep{…}}");
  assert.doesNotMatch(summarize({ query: "x".repeat(500), head: body }), /SECRET/);
  assert.ok(summarize({ query: "x".repeat(500) }).length < 80, "a long name is cut");
  assert.equal(summarize({ id: "a\nb  c" }), "id=a b c");
  assert.equal(summarize("not an object"), "");
  assert.equal(summarize(["a"]), "");
  assert.ok(summarize(Object.fromEntries(Array.from({ length: 200 }, (_, i) => ["key" + i, i]))).length <= 301, "the whole line is bounded");
});

test("a request's parameters are its query and the size of its body", () => {
  assert.equal(requestParams("/api/step?id=" + "a".repeat(40) + "&kind=item&doc=b", undefined), `id=${"a".repeat(40)} kind=item doc=b`);
  assert.equal(requestParams("/api/notes", "812"), "bodyBytes=812");
  assert.equal(requestParams("/api/notes", "0"), "");
  assert.equal(requestParams("http://[bad", undefined), "");
  assert.equal(requestParams(undefined, undefined), "");
});

test("the slow-op frame is exactly op, ms, limitMs and params, and is not one another process may push", () => {
  const wake = new Wake({ now: () => T0 });
  assert.throws(() => wake.push("slow-op", { op: "x", ms: 1, limitMs: 1 }), /fields/);
  assert.equal(Wake.isExternal("slow-op"), false);
});

// The page API and the tools time their operations at their one entry each.

test("a page request that runs over its limit is told to the architect; one within it is not; the same one again within the hour is only logged", async t => {
  const wake = new Wake(), slow = new SlowOps({ wake, limitsMs: { write: 150 } });
  // The ownerOps of a board whose notes write is slow: a deliberately slow operation behind the real entry.
  const { url, api } = await slowWrites(t, wake, slow, 300);
  const socket = await wakeSocket(t, url);
  const logs = await logged(async () => {
    assert.equal((await api("/api/snapshot")).status, 200);
    await socket.sync();
    assert.deepEqual(socket.events(), [], "a read within its limit tells no one");
    assert.equal((await api("/api/notes", { target: "it:a", kind: "comment", text: "a body that must not be told" })).status, 200);
    await socket.sync();
    const [frame] = socket.events();
    assert.equal(frame!.event, "slow-op");
    assert.equal(frame!.op, "POST /api/notes");
    assert.equal(frame!.limitMs, 150);
    assert.ok((frame!.ms as number) >= 300, `took ${String(frame!.ms)} ms, the operation sleeps 300`);
    assert.match(frame!.params as string, /^bodyBytes=\d+$/);
    assert.doesNotMatch(JSON.stringify(frame), /must not be told/);
    assert.equal((await api("/api/notes", { target: "it:a", kind: "comment", text: "again" })).status, 200);
    await socket.sync();
    assert.equal(socket.events().length, 1, "told once; the second is only logged");
  });
  assert.ok(logs.info.some(line => /^GET \/api\/snapshot 200 \d+ ms$/.test(line)), logs.info.join("\n"));
  assert.ok(logs.info.some(line => /^POST \/api\/notes 200 \d+ ms$/.test(line)));
  assert.equal(logs.warn.length, 2);
  assert.match(logs.warn[1]!, /the architect was told 0 min ago/);
});

test("a request whose connection closes before the answer is timed as closed, and is over its limit when it ran past it", async t => {
  const wake = new Wake(), slow = new SlowOps({ wake, limitsMs: { write: 100 } });
  const { url, store } = await slowWrites(t, wake, slow, 400);
  const socket = await wakeSocket(t, url);
  const { info } = await logged(async () => {
    const controller = new AbortController();
    const pending = fetch(url + "/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: "it:a", kind: "comment", text: "x" }), signal: controller.signal }).catch(() => undefined);
    await sleep(200);
    controller.abort(); await pending;
    // The server finishes the write the page gave up on; the test ends after it, not under it.
    for (let i = 0; i < 200 && !Object.values(store.snapshot().notes).some(n => n.text === "x"); i++) await sleep(25);
    assert.ok(Object.values(store.snapshot().notes).some(n => n.text === "x"), "the write the page abandoned still happened");
    await socket.sync();
  });
  assert.ok(info.some(line => /^POST \/api\/notes closed \d+ ms$/.test(line)), info.join("\n"));
  const events = socket.events();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.op, "POST /api/notes");
  assert.ok((events[0]!.ms as number) >= 150 && (events[0]!.ms as number) < 400, `${String(events[0]!.ms)} ms: the time it ran before the page gave up, not the time to finish`);
});

test("the event stream and the MCP transport are logged with their time and never told, whatever their length", async t => {
  const wake = new Wake(), slow = new SlowOps({ wake, limitsMs: { read: 1, write: 1, history: 1 } });
  const { url } = await slowWrites(t, wake, slow, 0);
  const { info } = await logged(async () => {
    const controller = new AbortController();
    const response = await fetch(url + "/api/events", { signal: controller.signal });
    await response.body!.getReader().read();
    await sleep(50);
    controller.abort();
    await sleep(50);
    const refused = await fetch(url + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(refused.status, 400);
    await sleep(20);
  });
  assert.ok(info.some(line => /^GET \/api\/events closed \d+ ms$/.test(line)), info.join("\n"));
  assert.ok(info.some(line => /^POST \/mcp 400 \d+ ms$/.test(line)));
  assert.deepEqual(slowFrames(wake), []);
});

/** The page server over a board whose owner writes take `delay` milliseconds, with the given Wake and SlowOps. */
async function slowWrites(t: Parameters<typeof board>[0], wake: Wake, slow: SlowOps, delay: number) {
  const fixture = await board(t), { store, op } = fixture, real = ownerOps(store);
  const slowed = { ...real, createNote: async (...a: Parameters<typeof real.createNote>) => { await sleep(delay); return real.createNote(...a); } } as typeof real;
  const http = createHttpServer({ store, ops: op, ownerOps: slowed, webDir: join(import.meta.dirname, "../web"), wake, slow, createMcp: () => createMcpServer({ store, ops: op, wake, slow }) });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(() => new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve())));
  const address = http.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  async function api(path: string, data?: unknown) {
    const response = await fetch(url + path, data === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  }
  return { ...fixture, http, url, api };
}

test("a tool call that runs over its limit is told with the tool's name and a summary of its arguments, without their text", async t => {
  const wake = new Wake(), slow = new SlowOps({ wake, limitsMs: { write: 150 } });
  const { store, op } = await board(t);
  // A write that is slow: the real operation behind a delay, as a push holding the write queue would make it.
  const slowed = { ...op, appendLog: async (...a: Parameters<typeof op.appendLog>) => { await sleep(300); return op.appendLog(...a); } } as typeof op;
  const mcp = createMcpServer({ store, ops: slowed, wake, slow }), client = new Client({ name: "Slow test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await mcp.close(); });
  const { info } = await logged(async () => {
    assert.equal((await client.callTool({ name: "projects", arguments: {} })).isError, undefined);
    assert.deepEqual(slowFrames(wake), [], "a read within its limit is not told");
    const wrote = await client.callTool({ name: "append_log", arguments: { author, session: "slow-engineer", id: "a", text: "a log entry that must not be told" } });
    assert.equal(wrote.isError, undefined);
  });
  const [frame] = slowFrames(wake);
  assert.equal(frame!.op, "tool append_log");
  assert.equal(frame!.limitMs, 150);
  assert.ok((frame!.ms as number) >= 300, `took ${String(frame!.ms)} ms`);
  assert.equal(frame!.params, "author(9 chars) session=slow-engineer id=a text(33 chars)");
  assert.doesNotMatch(JSON.stringify(frame), /must not be told/);
  assert.ok(info.some(line => /^tool projects ok \d+ ms$/.test(line)), info.join("\n"));
  assert.ok(info.some(line => /^tool append_log ok \d+ ms$/.test(line)));
});

test("a tool that fails is timed as an error, and one over its limit is told all the same", async t => {
  const wake = new Wake(), slow = new SlowOps({ wake, limitsMs: { read: 50 } });
  const { store, op } = await board(t);
  const mcp = createMcpServer({ store, ops: op, wake, slow }), client = new Client({ name: "Slow error test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await mcp.close(); });
  const { info } = await logged(async () => {
    const refused = await client.callTool({ name: "context", arguments: { id: "no-such-item" } });
    assert.equal(refused.isError, true);
  });
  assert.ok(info.some(line => /^tool context error \d+ ms$/.test(line)), info.join("\n"));
  assert.deepEqual(slowFrames(wake), [], "an error within the limit is not told");
});

test("the history tools have the history limit, not the read limit", async t => {
  const wake = new Wake(), slow = new SlowOps({ wake, limitsMs: { read: 1, history: 60_000 } });
  const { store, op } = await board(t);
  const mcp = createMcpServer({ store, ops: op, wake, slow }), client = new Client({ name: "History class test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await mcp.close(); });
  await logged(async () => {
    const answered = await client.callTool({ name: "history", arguments: { id: "a" } });
    assert.equal(answered.isError, undefined);
  });
  assert.deepEqual(slowFrames(wake), [], "a read limit of 1 ms would have caught it, the history limit does not");
});

test("every tool that changes the board is a write, and only changes, history and diff are history", async t => {
  const { store, op } = await board(t);
  const mcp = createMcpServer({ store, ops: op }), client = new Client({ name: "Class test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await mcp.close(); });
  const tools = (await client.listTools()).tools;
  const classes = new Map(tools.map(tool => [tool.name, toolClass(tool.name, tool.annotations?.readOnlyHint === false)] as const));
  assert.deepEqual([...classes].filter(([, c]) => c === "history").map(([n]) => n).sort(), ["changes", "diff", "history"]);
  assert.ok(classes.size >= 30);
  assert.equal(classes.get("append_log"), "write");
  assert.equal(classes.get("set_plan"), "write");
  assert.equal(classes.get("brief"), "read");
  assert.ok([...classes.values()].every(c => ["read", "write", "history"].includes(c)));
});
