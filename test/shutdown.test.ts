import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { board } from "./helpers.ts";
import { Store } from "../src/store.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { createHttpServer } from "../src/http.ts";
import { createMcpServer } from "../src/mcp.ts";

// What the daemon does on SIGTERM (design section 4, "Stopping"): the server stops accepting connections, answers every
// request that arrives afterwards with 503, lets the requests already running finish, and closes what is left when the
// grace is over. A request is made to arrive "after" by sending its head in two parts around the start of the shutdown:
// a connection that holds half a request is not idle, so the server keeps it open.

type Scope = Parameters<typeof board>[0];
const git = promisify(execFile);

/** The daemon's HTTP server over a fresh board, listening on a free port. The test starts the shutdown itself. */
async function listening(t: Scope, extra: { shutdownGraceMs?: number; createMcp?: () => McpServer } = {}) {
  const { store, op } = await board(t);
  const http = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: "web", createMcp: extra.createMcp ?? (() => createMcpServer({ store, ops: op })), shutdownGraceMs: extra.shutdownGraceMs });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(async () => { http.closeAllConnections(); if (http.listening) await new Promise<void>(resolve => http.close(() => resolve())); });
  const address = http.address(); assert.ok(address && typeof address !== "string");
  return { http, store, port: address.port, url: `http://127.0.0.1:${address.port}` };
}

/** Starts the shutdown. Resolves with the milliseconds until the server reports itself closed, which needs every connection gone. */
function shutdown(http: Server): Promise<number> {
  const started = Date.now();
  const closed = new Promise<number>((resolve, reject) => {
    const give = setTimeout(() => reject(new Error("the server was not closed 8 s after the shutdown began")), 8000);
    http.close(error => { clearTimeout(give); if (error) reject(error); else resolve(Date.now() - started); });
  });
  closed.catch(() => {});
  return closed;
}

/** A client that writes HTTP/1.1 by hand, so a test chooses when each part of a request reaches the server. */
function rawClient(t: Scope, port: number) {
  const socket = connect(port, "127.0.0.1");
  t.after(() => { socket.destroy(); });
  socket.on("error", () => {});
  let received = "", closedAt: number | undefined;
  socket.setEncoding("utf8");
  socket.on("data", chunk => { received += chunk; });
  socket.on("close", () => { closedAt = Date.now(); });
  return {
    write: (text: string) => { socket.write(text); },
    get closed() { return closedAt !== undefined; },
    /** Whether the server closed the connection within `ms`. */
    async closesWithin(ms: number) { for (let waited = 0; waited < ms && closedAt === undefined; waited += 10) await sleep(10); return closedAt !== undefined; },
    /** The first response: its status, its head in lower case and its body (the routes answer with a Content-Length). */
    async response() {
      for (let waited = 0; waited < 3000; waited += 10) {
        const end = received.indexOf("\r\n\r\n");
        if (end >= 0) {
          const head = received.slice(0, end).toLowerCase(), length = Number(/content-length: (\d+)/.exec(head)?.[1] ?? 0);
          if (received.length >= end + 4 + length) return { status: Number(head.split(" ")[1]), head, body: received.slice(end + 4, end + 4 + length) };
        }
        if (closedAt !== undefined) break;
        await sleep(10);
      }
      throw new Error("no complete response; received " + JSON.stringify(received.slice(0, 200)));
    },
  };
}

/** A promise that stays pending until `open` is called. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { opened, open };
}

/** A request head without the blank line that ends it, so the server holds the request open until the test sends the rest. */
const head = (port: number, ...lines: string[]) => lines.map((line, n) => n === 0 ? line + `\r\nHost: 127.0.0.1:${port}\r\n` : line + "\r\n").join("");
const post = (port: number, path: string, body: string, ...more: string[]) => ({ head: head(port, `POST ${path} HTTP/1.1`, "Content-Type: application/json", ...more, `Content-Length: ${Buffer.byteLength(body)}`), body });

test("a request that reaches the server after the shutdown began gets 503 and its connection closes", async t => {
  const { http, port, url, store } = await listening(t, { shutdownGraceMs: 5000 });
  // A live MCP session, so that a request carrying its id finds a session to answer.
  const mcp = new Client({ name: "Live", version: "1" }); mcp.onerror = () => {};
  const transport = new StreamableHTTPClientTransport(new URL(url + "/mcp"));
  t.after(() => mcp.close().catch(() => {}));
  await mcp.connect(transport);
  const session = `mcp-session-id: ${transport.sessionId}`;
  const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Late", version: "1" } } });
  const requests: Array<{ name: string; head: string; body?: string }> = [
    { name: "page data", head: head(port, "GET /api/snapshot HTTP/1.1") },
    { name: "health", head: head(port, "GET /health HTTP/1.1") },
    { name: "owner write", ...post(port, "/api/notes", JSON.stringify({ target: "it:a", kind: "comment", text: "too late" })) },
    { name: "MCP initialize", ...post(port, "/mcp", initialize, "Accept: application/json, text/event-stream") },
    { name: "MCP stream of a live session", head: head(port, "GET /mcp HTTP/1.1", "Accept: text/event-stream", session) },
    { name: "MCP close of a live session", head: head(port, "DELETE /mcp HTTP/1.1", session) },
    { name: "wake stream", head: head(port, "GET /wake HTTP/1.1", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13") },
  ];
  const clients = requests.map(request => { const client = rawClient(t, port); client.write(request.head); return client; });
  await sleep(100);   // the server has read the half of each request
  const closed = shutdown(http);
  await sleep(50);
  requests.forEach((request, n) => clients[n]!.write("\r\n" + (request.body ?? "")));
  for (const [n, request] of requests.entries()) {
    const response = await clients[n]!.response();
    assert.equal(response.status, 503, request.name);
    assert.match(response.head, /connection: close/, request.name);
    assert.match(response.head, /retry-after: 2/, request.name);
    assert.ok(await clients[n]!.closesWithin(1000), `${request.name}: the connection is closed after the 503`);
  }
  assert.ok(await closed < 3000, "with nothing left running the server closes long before the grace is over");
  assert.deepEqual(Object.values(store.snapshot().notes).filter(note => note.text === "too late"), [], "the refused write was not made");
});

test("a request already running when the shutdown began runs to completion, then its connection closes", async t => {
  const { http, port, store } = await listening(t, { shutdownGraceMs: 5000 });
  const request = post(port, "/api/notes", JSON.stringify({ target: "it:a", kind: "comment", text: "finished during shutdown" }));
  const running = rawClient(t, port);
  // The body is half sent: the handler is waiting for the rest.
  running.write(request.head + "\r\n" + request.body.slice(0, 20));
  await sleep(100);
  const closed = shutdown(http);
  await sleep(300);
  assert.equal(running.closed, false, "the running request is not cut");
  const finished = Date.now();
  running.write(request.body.slice(20));
  const response = await running.response();
  assert.equal(response.status, 200);
  assert.ok(Object.values(store.snapshot().notes).some(note => note.text === "finished during shutdown"), "the write was made");
  assert.ok(await running.closesWithin(1000), "the connection closes with the response and does not wait for the grace");
  await closed;
  assert.ok(Date.now() - finished < 2000, "the server closes with its last request, not when the grace is over");
});

test("a request still running when the grace is over is cut with its connection", async t => {
  const { http, port } = await listening(t, { shutdownGraceMs: 400 });
  const request = post(port, "/api/notes", JSON.stringify({ target: "it:a", kind: "comment", text: "never finished" }));
  const stuck = rawClient(t, port);
  stuck.write(request.head + "\r\n" + request.body.slice(0, 20));
  await sleep(100);
  const closed = shutdown(http);
  await sleep(200);
  assert.equal(stuck.closed, false, "it is still allowed to run before the grace is over");
  const took = await closed;
  assert.ok(await stuck.closesWithin(500), "the server closed its connection");
  assert.ok(took >= 380 && took < 3000, `closed at ${took} ms, after the 400 ms grace`);
});

test("the grace for a running request is 2 seconds when none is given", async t => {
  const { http, port } = await listening(t);
  const request = post(port, "/api/notes", JSON.stringify({ target: "it:a", kind: "comment", text: "never finished" }));
  const stuck = rawClient(t, port);
  stuck.write(request.head + "\r\n" + request.body.slice(0, 20));
  await sleep(100);
  const closed = shutdown(http);
  await sleep(1500);
  assert.equal(stuck.closed, false, "still allowed to run 1.5 s into the shutdown");
  const took = await closed;
  assert.ok(await stuck.closesWithin(500), "the server closed its connection");
  assert.ok(took >= 1900 && took < 4000, `closed at ${took} ms`);
});

test("an MCP tool call running when the shutdown began finishes, and the session's idle stream does not hold the server", async t => {
  const started = gate(), release = gate();
  const slow = () => {
    const mcp = new McpServer({ name: "Slow", version: "1" });
    mcp.registerTool("slow", { description: "Waits until the test lets it go" }, async () => { started.open(); await release.opened; return { content: [{ type: "text" as const, text: "done" }] }; });
    return mcp;
  };
  const { http, url } = await listening(t, { shutdownGraceMs: 5000, createMcp: slow });
  const client = new Client({ name: "Caller", version: "1" }); client.onerror = () => {};
  t.after(() => client.close().catch(() => {}));
  await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));   // opens the session's stream, too
  const call = client.callTool({ name: "slow", arguments: {} }, undefined, { timeout: 5000 });
  await started.opened;
  const closed = shutdown(http);
  let done = false;
  void closed.then(() => { done = true; });
  await sleep(300);
  assert.equal(done, false, "the server waits for the running call");
  const released = Date.now();
  release.open();
  const result = await call;
  assert.deepEqual(result.content, [{ type: "text", text: "done" }], "the call returned its result");
  await closed;
  assert.ok(Date.now() - released < 2000, "the server closed when the call finished: the session's idle stream was already closed");
});

// The daemon itself, in a process of its own: the part main.ts adds to the server (the owner's reading state, no push).
test("the daemon stopped by SIGTERM exits at once, saves the owner's reading state in a local commit and does not push; its first push comes after a delay from the start and is timed in the log", async t => {
  const data = await mkdtemp(join(tmpdir(), "wf-board-daemon-")), remote = await mkdtemp(join(tmpdir(), "wf-board-remote-"));
  t.after(() => Promise.all([data, remote].map(dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))));
  await git("git", ["init", "--bare", "-b", "main", remote]);
  // A board with one item and no GitHub repository, so the daemon asks nobody on the network.
  const seed = await Store.open(data, { init: true, board: { title: "Daemon test", projects: [{ name: "Test" }] } });
  const item = { title: "条目", group: "Test", priority: "P1", difficulty: 2, plan: [{ id: "accept", accept: true, text: "通过", state: "todo" }], updated: "2026-10-11T01:02:03Z" };
  await seed.commit({ author: "Test", message: "Seed", puts: [{ kind: "item", id: "x", expectRev: null, doc: item }] });
  await git("git", ["-C", data, "remote", "add", "origin", remote]);
  const local = async () => (await git("git", ["-C", data, "rev-parse", "HEAD"])).stdout.trim();
  const pushed = async () => (await git("git", ["-C", remote, "rev-parse", "--verify", "-q", "refs/heads/main"]).catch(() => ({ stdout: "" }))).stdout.trim();
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  // The first push is delayed by 4 s here (60 s by default), long enough to see that nothing is pushed before it.
  const daemon = spawn(process.execPath, [join(import.meta.dirname, "../src/main.ts")], { env: { ...process.env, WF_BOARD_DATA: data, WF_BOARD_PORT: String(port), WF_BOARD_FIRST_PUSH_MS: "4000" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  daemon.stdout.on("data", chunk => { log += chunk; }); daemon.stderr.on("data", chunk => { log += chunk; });
  const exited = once(daemon, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  t.after(() => { if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL"); });
  for (let waited = 0; ; waited += 100) {
    assert.ok(waited < 15_000, "the daemon did not answer within 15 s");
    if (await fetch(url + "/health").then(r => r.ok, () => false)) break;
    await sleep(100);
  }
  const seeded = await local();
  await sleep(1000);
  assert.equal(await pushed(), "", "nothing is pushed in the first seconds after the start");
  for (let waited = 0; await pushed() !== seeded; waited += 100) {
    assert.ok(waited < 15_000, "the daemon did not push its commits after the delay");
    await sleep(100);
  }
  // The daemon writes the push line after the push returns, so the remote can show the commits a moment before the line is there.
  for (let waited = 0; !/Z push of \d+ commits took \d+\.\d s$/m.test(log); waited += 100) {
    assert.ok(waited < 5000, `the push and its duration are in the log within 5 s of the remote showing the commits; log so far:\n${log}`);
    await sleep(100);
  }
  // A session with its stream open, as an agent has, and two local changes that only a push would send: a note, and the
  // owner reading it (owner state is saved to a file at once and joins a commit later).
  const mcp = new Client({ name: "Agent", version: "1" }); mcp.onerror = () => {};
  t.after(() => mcp.close().catch(() => {}));
  await mcp.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));
  const json = { method: "POST", headers: { "Content-Type": "application/json" } };
  assert.equal((await fetch(url + "/api/notes", { ...json, body: JSON.stringify({ target: "it:x", kind: "comment", text: "written before the stop" }) })).status, 200);
  const written = await local();
  assert.equal((await fetch(url + "/api/read", { ...json, body: JSON.stringify({ through: written }) })).status, 200);
  const stopped = Date.now();
  daemon.kill("SIGTERM");
  const [code, signal] = await Promise.race([exited, sleep(10_000).then(() => { throw new Error("the daemon was still running 10 s after SIGTERM"); })]);
  const took = Date.now() - stopped;
  assert.deepEqual([code, signal], [0, null], "it exits by itself and does not need a SIGKILL");
  assert.ok(took < 2000, `it exited ${took} ms after SIGTERM`);
  const subject = (await git("git", ["-C", data, "log", "-1", "--format=%s"])).stdout.trim();
  assert.equal(subject, "Save owner reading state", "the owner's reading state was saved in a local commit");
  assert.equal(await pushed(), seeded, "nothing was pushed while stopping");
});
