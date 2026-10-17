import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { request, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { agentSocket, board, author, later, server, wakeSocket } from "./helpers.ts";
import { Item } from "../src/model.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { createHttpServer } from "../src/http.ts";
import { createMcpServer } from "../src/mcp.ts";
import { applyActivityDelta } from "../src/rules.ts";
import { Wake } from "../src/wake.ts";

test("snapshot, static page, health, SSE and owner HTTP lifecycle", async t => {
  const { store, op, api, url } = await server(t);
  const snapshot = await api("/api/snapshot"); assert.equal(snapshot.status, 200); assert.deepEqual(snapshot.data, store.snapshot());
  assert.equal((await api("/health")).data.pendingPush, 0);
  assert.match(await (await fetch(url)).text(), /src="\/app.js"/);
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(url + "/api/events", { signal: controller.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body!.getReader(); await reader.read();
  const event = reader.read();
  const prior = store.snapshot();
  const written = await op.appendLog({ author, id: "a", text: "HTTP event witness" });
  const chunk = await event; const text = new TextDecoder().decode(chunk.value);
  assert.match(text, /event: change/);
  const data = JSON.parse(text.match(/data: (.+)/)![1]!);
  assert.equal(data.commit, written.commit); assert.equal(data.author, author);
  // The event carries the activity's change, not the whole growing history; applied to the snapshot before, it gives the current one.
  assert.equal(data.activity.from, prior.head);
  assert.equal(data.activity.writes, undefined, "the event does not carry the accumulated write timestamps");
  assert.deepEqual(applyActivityDelta(prior.activity, data.activity), store.snapshot().activity, "live updates keep the same active-time history as the snapshot");
  assert.deepEqual(data.changed, [{ kind: "item", id: "a", after: store.snapshot().items.a }]);
  controller.abort();
  const note = await api("/api/notes", { target: "q:choice", kind: "choice", text: "选 A", choice: "A" }); assert.equal(note.status, 200);
  const draft = await api("/api/notes", { target: "it:a", kind: "comment", text: "delete this" });
  assert.equal((await api("/api/notes/" + draft.data.id, {}, "DELETE")).status, 200);
  assert.equal(store.snapshot().notes[draft.data.id], undefined);
  const sent = await api("/api/send", {}); assert.deepEqual(sent.data.sent, [{ id: note.data.id, target: "q:choice", kind: "choice", project: "Whitefoot" }]);
  assert.equal((await api("/api/notes/" + note.data.id, {}, "DELETE")).status, 400);
  assert.equal((await api("/api/notes/missing", {}, "DELETE")).status, 404);
  assert.equal((await api("/api/notes", { target: "it:missing", kind: "comment", text: "bad" })).status, 404);
  assert.equal((await api("/api/archive", { id: "a", on: true })).status, 404);
  const completed = await op.setPlan({ author, id: "a", rows: [{ id: "accept", accept: true, text: "验收通过", state: "done" }] });
  assert.equal((await api("/api/read", { through: completed.commit })).status, 200);
  assert.equal((await api("/api/unread")).data.steps.length, 0);
  const progress = await op.setPlan({ author, id: "b", row: { id: "progress", state: "todo", text: "unread after read" } });
  const steps = (await api("/api/unread")).data.steps; assert.equal(steps[0].id, progress.commit);
  const diff = await api(`/api/step?id=${progress.commit}&kind=item&doc=b`); assert.match(diff.data.diff, /unread after read/);
  assert.equal((await api("/api/step?id=missing&kind=item&doc=b")).status, 404);
  assert.equal((await api("/api/read", { through: "f".repeat(40) })).status, 400);
});

test("exact Host and same-Origin enforced for writes and WebSocket upgrades", async t => {
  const { url, port } = await server(t);
  // fetch drops a custom Host header, so the Host checks use http.request.
  const hostStatus = (host: string) => new Promise<number>((resolve, reject) => {
    const req = request(url + "/health", { headers: { Host: host } }, res => { res.resume(); resolve(res.statusCode!); }); req.on("error", reject); req.end();
  });
  assert.equal(await hostStatus("evil.example"), 403);
  assert.equal((await fetch(url + "/api/send", { method: "POST", headers: { Origin: "http://evil.example" } })).status, 403);
  assert.equal((await fetch(url + "/api/notes/missing", { method: "DELETE", headers: { Origin: "null" } })).status, 403);
  assert.equal((await fetch(url + "/api/send", { method: "POST", headers: { Origin: url } })).status, 200);
  assert.equal(await hostStatus(`localhost:${port}`), 200);
  const socket = new WebSocket(url.replace("http:", "ws:") + "/wake", { origin: "http://evil.example" });
  socket.on("error", () => {}); t.after(() => socket.terminate());
  const [, response] = await once(socket, "unexpected-response");
  assert.equal(response.statusCode, 403);
  response.resume();
  assert.equal(await hostStatus(`localhost:${port + 1}`), 403);
});

test("POST /api/send with ids wakes only for those notes and refuses a non-draft id with 400", async t => {
  const { url, api } = await server(t);
  const { events, sync } = await agentSocket(t, url, "架构师");
  const one = await api("/api/notes", { target: "it:a", kind: "comment", text: "one" });
  const two = await api("/api/notes", { target: "it:other", kind: "comment", text: "two" });
  const sent = await api("/api/send", { ids: [two.data.id] });
  assert.equal(sent.status, 200); assert.deepEqual(sent.data.sent.map((n: {id: string}) => n.id), [two.data.id]);
  await sync();
  assert.deepEqual(events().map(f => f.note), [two.data.id]);
  assert.equal((await api("/api/send", { ids: [two.data.id] })).status, 400);
  assert.equal((await api("/api/send", { ids: ["missing"] })).status, 404);
  assert.deepEqual((await api("/api/send", {})).data.sent.map((n: {id: string}) => n.id), [one.data.id]);
});

test("POST /api/send with no body at all is the batch send", async t => {
  const { url, api } = await server(t);
  const one = await api("/api/notes", { target: "it:a", kind: "comment", text: "one" });
  const response = await fetch(url + "/api/send", { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(((await response.json()) as {sent: Array<{id: string}>}).sent.map(n => n.id), [one.data.id]);
});

test("the MCP endpoint keeps no session: a client initializes, lists tools and calls one, and no stream or close is offered", async t => {
  const { url } = await server(t);
  const transport = new StreamableHTTPClientTransport(new URL(url + "/mcp"));
  const client = new Client({ name: "HTTP test", version: "1" }); t.after(() => client.close());
  await client.connect(transport);
  assert.equal(transport.sessionId, undefined, "no session id is issued");
  const tools = await client.listTools(); assert.ok(tools.tools.some(t => t.name === "context"));
  const result = await client.callTool({ name: "context", arguments: { id: "a" } }); assert.ok(!result.isError);
  for (const method of ["GET", "DELETE"]) {
    const response = await fetch(url + "/mcp", { method, headers: { Accept: "text/event-stream" } });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "POST");
  }
});

test("a request names no session, so one that carries a stale session id is answered like any other", async t => {
  const { url } = await server(t);
  const call = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const response = await fetch(url + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": "a-session-of-an-earlier-process" }, body: JSON.stringify(call) });
  assert.equal(response.status, 200);
  assert.ok(((await response.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.some(tool => tool.name === "context"));
});

test("JSON body decoding preserves Chinese codepoints split across request chunks", async t => {
  const {store,op} = await board(t);
  const http = createHttpServer({store,ops:op,ownerOps:ownerOps(store),webDir:"web",createMcp:() => createMcpServer({store,ops:op})});
  t.after(() => { http.close(); });
  // Feed a real IncomingMessage directly to the HTTP handler, so this byte
  // decoding regression can run even in a sandbox that prohibits listen().
  const socket = new Socket(); t.after(() => socket.destroy());
  Object.defineProperty(socket,"localPort",{value:7417});
  const req = new IncomingMessage(socket); req.method = "POST"; req.url = "/api/notes"; req.headers = {host:"127.0.0.1:7417"};
  const res = new ServerResponse(req);
  const response = new Promise<{status:number;data:{id:string}}>(resolve => {
    res.writeHead = status => {res.statusCode = status; return res;};
    res.end = ((data: string) => {resolve({status:res.statusCode,data:JSON.parse(data)});res.emit("finish");return res;}) as typeof res.end;
  });
  const payload = Buffer.from(JSON.stringify({target:"it:a",kind:"comment",text:"中文意见"}));
  const boundary = payload.indexOf(Buffer.from("中")) + 1;
  http.emit("request",req,res);
  req.push(payload.subarray(0,boundary)); await setImmediate(); req.push(payload.subarray(boundary)); req.push(null);
  const created = await response; assert.equal(created.status,200);
  assert.equal(store.snapshot().notes[created.data.id]!.text,"中文意见");
});

test("atomic draft HTTP route returns committed notes and deletions without a listener", async t => {
  const { store, op } = await board(t), owner = ownerOps(store);
  const http = createHttpServer({ store, ops: op, ownerOps: owner, webDir: "web", createMcp: () => createMcpServer({ store, ops: op }) });
  t.after(() => { http.close(); });
  async function api(data: unknown) {
    const socket = new Socket(); t.after(() => socket.destroy()); Object.defineProperty(socket, "localPort", { value: 7417 });
    const req = new IncomingMessage(socket); req.method = "POST"; req.url = "/api/draft"; req.headers = { host: "127.0.0.1:7417" };
    const res = new ServerResponse(req);
    const response = new Promise<{ status: number; data: Record<string, unknown> }>(resolve => {
      res.writeHead = status => { res.statusCode = status; return res; };
      res.end = ((body: string) => { resolve({ status: res.statusCode, data: JSON.parse(body) }); return res; }) as typeof res.end;
    });
    http.emit("request", req, res); req.push(Buffer.from(JSON.stringify(data))); req.push(null);
    return response;
  }
  const made = await api({ target: "q:choice", kind: "choice", on: true, text: "选 A", choice: "A" });
  assert.equal(made.status, 200);
  const note = made.data.note as { id: string; doc: unknown };
  assert.deepEqual(note.doc, store.snapshot().notes[note.id]);
  assert.equal(made.data.commit, store.snapshot().head);
  assert.deepEqual(made.data.deleted, []);
  const extra = await owner.createNote({ target: "q:choice", kind: "choice", text: "duplicate A", choice: "A" });
  const replacement = await api({ target: "q:choice", kind: "choice", on: true, text: "选 B", choice: "B" });
  assert.equal(replacement.status, 200);
  assert.deepEqual(replacement.data.note, { id: note.id, doc: store.snapshot().notes[note.id] });
  assert.deepEqual(replacement.data.deleted, [extra.id]);
  const before = store.snapshot();
  assert.equal((await api({ target: "q:choice", kind: "choice", on: "false", text: "" })).status, 400);
  assert.deepEqual(store.snapshot(), before);
  assert.equal((await api({ target: "it:missing", kind: "approve", on: true, text: "yes" })).status, 404);
  assert.deepEqual(store.snapshot(), before);
  const cleared = await api({ target: "q:choice", kind: "choice", on: false, text: "" });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.data, { note: null, deleted: [note.id], commit: store.snapshot().head });
});

test("HTTP document reads leave earlier documents unread and hide read step diffs", async t => {
  const { store, op } = await board(t);
  const http = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: "web", createMcp: () => createMcpServer({ store, ops: op }) });
  t.after(() => { http.close(); });
  async function api(path: string, data?: unknown) {
    const socket = new Socket(); t.after(() => socket.destroy()); Object.defineProperty(socket, "localPort", { value: 7417 });
    const req = new IncomingMessage(socket); req.method = data === undefined ? "GET" : "POST"; req.url = path; req.headers = { host: "127.0.0.1:7417" };
    const res = new ServerResponse(req);
    const response = new Promise<{ status: number; data: { steps?: Array<{id: string}> } }>(resolve => {
      res.writeHead = status => { res.statusCode = status; return res; };
      res.end = ((body: string) => { resolve({ status: res.statusCode, data: JSON.parse(body) }); return res; }) as typeof res.end;
    });
    http.emit("request", req, res); if (data !== undefined) req.push(Buffer.from(JSON.stringify(data))); req.push(null);
    return response;
  }
  await api("/api/read", {through: store.snapshot().head});
  const a = await op.setPlan({ author, id: "a", row: { id: "progress", state: "todo", text: "earlier unread" } });
  const card = store.snapshot().decisions.choice!;
  const b = await store.commit({author, message: "update card", puts: [{kind: "decision", id: "choice", expectRev: card.rev, doc: {...card, question: "new question"}}]});
  assert.equal((await api("/api/read", {doc: "decision:choice", through: b.commit})).status, 200);
  assert.deepEqual((await api("/api/unread")).data.steps!.map(s => s.id), [a.commit]);
  assert.equal((await api(`/api/step?id=${b.commit}&kind=decision&doc=choice`)).status, 404);
  assert.equal((await api("/api/read", {doc: "decision:missing"})).status, 400);
  assert.equal((await api("/api/read", {doc: "decision:choice", through: "bad"})).status, 400);
});

test("draft text edit HTTP shape updates an exact note and reports stale or sent revisions", async t => {
  const {store, op} = await board(t), owner = ownerOps(store);
  const http = createHttpServer({store, ops: op, ownerOps: owner, webDir: "web", createMcp: () => createMcpServer({store, ops: op})});
  t.after(() => { http.close(); });
  async function api(data: unknown) {
    const socket = new Socket(); t.after(() => socket.destroy()); Object.defineProperty(socket, "localPort", {value: 7417});
    const req = new IncomingMessage(socket); req.method = "POST"; req.url = "/api/draft"; req.headers = {host: "127.0.0.1:7417"};
    const res = new ServerResponse(req);
    const response = new Promise<{status: number; data: Record<string, unknown>}>(resolve => {
      res.writeHead = status => { res.statusCode = status; return res; };
      res.end = ((body: string) => { resolve({status: res.statusCode, data: JSON.parse(body)}); return res; }) as typeof res.end;
    });
    http.emit("request", req, res); req.push(Buffer.from(JSON.stringify(data))); req.push(null); return response;
  }
  const {id} = await owner.createNote({target: "it:a", kind: "comment", text: "Original"});
  const before = store.snapshot().notes[id]!;
  const edited = await api({id, rev: before.rev, text: "Edited"});
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.data, {note: {id, doc: {...before, text: "Edited", rev: before.rev + 1}}, deleted: [], commit: store.snapshot().head});
  assert.equal((await api({id, rev: before.rev, text: "Stale"})).status, 409);
  assert.equal((await api({id, rev: before.rev + 1, text: " \n "})).status, 400);
  assert.equal((await api({id, rev: before.rev + 1, text: "Wrong shape", target: "it:a"})).status, 400);
  assert.equal((await api({id: "missing", rev: 1, text: "Absent"})).status, 404);
  await owner.send();
  assert.equal((await api({id, rev: store.snapshot().notes[id]!.rev, text: "Too late"})).status, 400);
  assert.equal(store.snapshot().notes[id]!.text, "Edited");
});

// A root with a missing shared row carries a (format) check in the plan model; its next step waits on that row, so it is blocked and carries no 缺难度.
const blockedItem = (id: string, rev: number | null = null) => ({ kind: "item" as const, id, expectRev: rev, doc: { title: "卡住的条目", group: "Whitefoot", priority: "P1", plan: [{ id: "missing", item: "missing", own: false, after: [] }, { id: "accept", text: "某项检查通过", state: "todo", accept: true }], updated: later, head: "**完成条件**：某项检查通过" } });
test("after a write the check scan rederives only the items the write can reach", async t => {
  const { url, store, op } = await server(t);
  const star = await wakeSocket(t, url);
  const checked: string[] = [], shared = store.derived.rules.bind(store.derived);
  t.mock.method(store.derived, "rules", (s: Parameters<typeof shared>[0], now?: number) => {
    const r = shared(s, now);
    return { ...r, checks: (id: string) => { if (s === store.snapshot()) checked.push(id); return r.checks(id); } };
  });
  await op.appendLog({ author: "Firn", id: "other", text: "Progress elsewhere" });
  await star.sync();
  assert.ok(checked.includes("other"), "the written item is checked again");
  assert.deepEqual(checked.filter(id => ["area", "a", "b"].includes(id)), [], "items the write cannot reach are not");
  // A write that makes a check appear scans the new item, and a check that is not 无人推进 (this item carries the missing row) is pushed to no one.
  await store.commit({ author, message: "Block item", puts: [blockedItem("c")] });
  await star.sync();
  assert.ok(checked.includes("c"));
  assert.ok(shared(store.snapshot()).checks("c").some(c => c.text.startsWith("依赖的条目不存在")), "the missing row is still reported");
  assert.equal(shared(store.snapshot()).checks("c").some(c => c.label === "缺难度"), false, "its next step waits on the missing row, so the rating is not what holds it");
  assert.deepEqual(star.events(), []);
});

test("the page has no pause endpoint; pausing goes through set_pause only", async t => {
  const { store, api } = await server(t);
  const checkpoint = store.snapshot();
  assert.equal((await api("/api/pause", { id: "area", paused: true, reason: "x" })).status, 404);
  assert.deepEqual(store.snapshot(), checkpoint);
});

test("an owner notice reaches each open page as an owner event, and a page that connects later gets only what follows it", async t => {
  const wake = new Wake({ now: () => Date.parse("2026-10-16T10:00:00Z") });
  const { url } = await server(t, { wake });
  // Told before the page connects: the page must not get it.
  wake.tell("之前的通知", "不该补发", { kind: "card", key: "choice" });
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(url + "/api/events", { signal: controller.signal });
  const reader = response.body!.getReader(); await reader.read();
  wake.tell("PM 一小时没响应", "最早没回执的是 #3", { kind: "item", key: "a" });
  const chunk = await reader.read(); const text = new TextDecoder().decode(chunk.value);
  assert.match(text, /^event: owner\n/, "the first event after connecting is the notice told after it");
  assert.deepEqual(JSON.parse(text.match(/data: (.+)/)![1]!), { title: "PM 一小时没响应", message: "最早没回执的是 #3", target: { kind: "item", key: "a" } });
});
