import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { request, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { board, author } from "./helpers.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { createHttpServer } from "../src/http.ts";
import { createMcpServer } from "../src/mcp.ts";

async function server(t: Parameters<typeof board>[0]) {
  const fixture = await board(t), { store, op } = fixture;
  const http = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: join(import.meta.dirname, "../web"), createMcp: () => createMcpServer({ store, ops: op }) });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(() => new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve())));
  const address = http.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  async function api(path: string, data?: unknown, method = "POST") {
    const response = await fetch(url + path, data === undefined ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  }
  return { ...fixture, http, url, api, port: address.port };
}

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
  const written = await op.appendLog({ author, id: "a", text: "HTTP event witness" });
  const chunk = await event; const text = new TextDecoder().decode(chunk.value);
  assert.match(text, /event: change/);
  const data = JSON.parse(text.match(/data: (.+)/)![1]!);
  assert.equal(data.commit, written.commit); assert.equal(data.author, author);
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
  assert.equal((await api("/api/archive", { id: "a", on: "true" })).status, 400);
  assert.equal((await api("/api/archive", { id: "a", on: true })).status, 200); assert.ok(store.snapshot().owner.archived.a);
  assert.equal((await api("/api/read", { through: written.commit })).status, 200);
  assert.equal((await api("/api/unread")).data.steps.length, 0);
  const log = await op.appendLog({ author, id: "b", text: "unread after read" });
  const steps = (await api("/api/unread")).data.steps; assert.equal(steps[0].id, log.commit);
  const diff = await api(`/api/step?id=${log.commit}&kind=item&doc=b`); assert.match(diff.data.diff, /unread after read/);
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
  const socket = new WebSocket(url.replace("http:", "ws:") + "/wake?session=*", { origin: "http://evil.example" });
  socket.on("error", () => {}); t.after(() => socket.terminate());
  const [, response] = await once(socket, "unexpected-response");
  assert.equal(response.statusCode, 403);
  response.resume();
  assert.equal(await hostStatus(`localhost:${port + 1}`), 403);
});

test("wake delivers only sent notes to their project and wildcard, exactly once", async t => {
  const { url, api } = await server(t);
  const sockets = ["Whitefoot", "Firn", "*", "unrelated"].map(session => new WebSocket(url.replace("http:", "ws:") + "/wake?session=" + encodeURIComponent(session)));
  t.after(() => { sockets.forEach(s => s.terminate()); });
  await Promise.all(sockets.map(s => once(s, "open")));
  const frames: Array<Array<{note: string; target: string; kind: string; project: string; title: string}>> = sockets.map(() => []);
  sockets.forEach((s,i) => s.on("message", data => frames[i]!.push(JSON.parse(data.toString()))));
  const one = await api("/api/notes", { target: "it:a", kind: "comment", text: "one" });
  const two = await api("/api/notes", { target: "q:choice", kind: "explain", text: "two" });
  const three = await api("/api/notes", { target: "it:other", kind: "comment", text: "three" });
  await api("/api/send", {});
  // Ping/pong is a wire-order barrier after every send, avoiding timing sleeps.
  for (const socket of sockets) { const pong = once(socket, "pong"); socket.ping(); await pong; }
  assert.deepEqual(frames.map(f => f.map(n => n.note)), [[one.data.id, two.data.id], [three.data.id], [one.data.id, two.data.id, three.data.id], []]);
  assert.deepEqual(frames[0]![1], { event: "note", project: "Whitefoot", note: two.data.id, target: "q:choice", kind: "explain", title: "中文方案？" });
  await api("/api/send", {});
  for (const socket of sockets) { const pong = once(socket, "pong"); socket.ping(); await pong; }
  assert.deepEqual(frames.map(f => f.length), [2, 1, 3, 0]);
});

test("stateful MCP client initializes, lists tools, reuses session and closes it", async t => {
  const { url } = await server(t);
  const transport = new StreamableHTTPClientTransport(new URL(url + "/mcp"));
  const client = new Client({ name: "HTTP test", version: "1" }); t.after(() => client.close());
  await client.connect(transport);
  const id = transport.sessionId; assert.ok(id);
  const tools = await client.listTools(); assert.ok(tools.tools.some(t => t.name === "context"));
  assert.equal(transport.sessionId, id);
  const result = await client.callTool({ name: "context", arguments: { id: "a" } }); assert.ok(!result.isError);
  await transport.terminateSession();
  assert.equal((await fetch(url + "/mcp", { headers: { "mcp-session-id": id, Accept: "text/event-stream" } })).status, 404);
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

test("project wake routing reaches matching project sockets and the coordinator exactly once", async t => {
  const {url,api,store,op} = await server(t);
  const sockets=["Whitefoot","Whitefoot","Firn","*","outsider"].map(session=>new WebSocket(url.replace("http:","ws:")+"/wake?session="+encodeURIComponent(session)));
  t.after(()=>sockets.forEach(s=>s.terminate())); await Promise.all(sockets.map(s=>once(s,"open")));
  const frames: Array<Array<Record<string,unknown>>> = sockets.map(()=>[]);
  sockets.forEach((s,i)=>s.on("message",data=>frames[i]!.push(JSON.parse(data.toString()))));
  const made=await op.createRequest({author:"Firn",project:"Whitefoot",key:"incoming",title:"Visitor request",head:"Please add feature",priority:"P0",why:"Need it"});
  await op.appendLog({author,id:made.id,text:"Seen"});
  const note=await api("/api/notes",{target:"it:a",kind:"comment",text:"One note"}); await api("/api/send",{});
  for (const socket of sockets) { const pong=once(socket,"pong"); socket.ping(); await pong; }
  assert.deepEqual(frames.map(f=>f.length),[2,2,0,2,0]);
  assert.deepEqual(frames[0]![0],{event:"request",item:"incoming",title:"Visitor request",project:"Whitefoot",by:"Firn"});
  assert.deepEqual(frames[0]![1],{event:"note",note:note.data.id,target:"it:a",kind:"comment",title:"中文检查",project:"Whitefoot"});
});

// Exercise the real HTTP handler and upgrade routing without binding a port.
// Only the WebSocket handshake/wire transport is replaced; network tests above
// remain the integration gate for hosts that permit loopback listeners.
test("project HTTP handlers route committed requests and sent notes without a listener", async t => {
  const {WebSocketServer} = await import("ws");
  const {EventEmitter} = await import("node:events");
  const {store,op} = await board(t);
  const owner = ownerOps(store);
  const http = createHttpServer({store,ops:op,ownerOps:owner,webDir:"web",createMcp:()=>createMcpServer({store,ops:op})});
  t.after(()=>{http.close();});
  const frames: Array<Array<Record<string,unknown>>> = [];
  t.mock.method(WebSocketServer.prototype,"handleUpgrade", (...args: Parameters<InstanceType<typeof WebSocketServer>["handleUpgrade"]>) => {
    const received: Array<Record<string,unknown>> = []; frames.push(received);
    const ws = Object.assign(new EventEmitter(),{readyState:WebSocket.OPEN,send:(data:string)=>received.push(JSON.parse(data)),terminate(){},ping(){}});
    args[3](ws as unknown as WebSocket,args[0]);
  });
  function request(path:string,method="POST") {
    const socket=new Socket(); t.after(()=>socket.destroy()); Object.defineProperty(socket,"localPort",{value:7417});
    const req=new IncomingMessage(socket); req.method=method; req.url=path; req.headers={host:"127.0.0.1:7417"}; return req;
  }
  for (const name of ["Whitefoot","Whitefoot","Firn","*","outsider"]) { const req=request("/wake?session="+encodeURIComponent(name),"GET"); http.emit("upgrade",req,req.socket,Buffer.alloc(0)); }
  async function api(path:string,data:unknown) {
    const req=request(path), res=new ServerResponse(req);
    const done = new Promise<{status:number;data:Record<string,unknown>}>(resolve=>{
      res.writeHead=status=>{res.statusCode=status;return res;};
      res.end=((body:string)=>{resolve({status:res.statusCode,data:JSON.parse(body)});return res;}) as typeof res.end;
    });
    http.emit("request",req,res); req.push(Buffer.from(JSON.stringify(data)));req.push(null); return done;
  }
  const {id}=await op.createRequest({author:"Firn",project:"Whitefoot",key:"incoming",title:"Visitor request",head:"Need a feature",priority:"P0",why:"Need it"});
  await op.appendLog({author,id,text:"Seen"});
  const note=await owner.createNote({target:"q:choice",kind:"explain",text:"Explain"});
  assert.deepEqual(frames.map(f=>f.length),[1,1,0,1,0]);
  const sent=await api("/api/send",{});
  assert.deepEqual(sent.data.sent,[{id:note.id,target:"q:choice",kind:"explain",project:"Whitefoot"}]);
  await api("/api/send",{});
  assert.deepEqual(frames.map(f=>f.length),[2,2,0,2,0]);
  assert.deepEqual(frames[0]![0],{event:"request",item:id,title:"Visitor request",project:"Whitefoot",by:"Firn"});
  assert.deepEqual(frames[0]![1],{event:"note",note:note.id,target:"q:choice",kind:"explain",title:"中文方案？",project:"Whitefoot"});
  await op.createRequest({author,project:"Firn",key:"external",title:"External",head:"Witness",priority:"P2",why:"Need",from:"a"});
  assert.deepEqual(frames.map(f=>f.length),[2,2,1,3,0]);
});
