import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Item, Note } from "./model.ts";
import { rules } from "./rules.ts";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConflictError } from "./store.ts";
import type { Store } from "./store.ts";
import { OpError } from "./ops.ts";
import type { Ops } from "./ops.ts";
import { NotFoundError } from "./owner-ops.ts";
import type { OwnerOps } from "./owner-ops.ts";
import { unreadSteps, stepDiff } from "./history.ts";

export function createHttpServer(deps: { store: Store; ops: Ops; ownerOps: OwnerOps; webDir: string; createMcp: () => McpServer }): http.Server {
  const { store, ownerOps } = deps;
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; mcp: McpServer }>();
  const connections = new Set<{ socket: WebSocket; session: string; alive: boolean }>();
  const streams = new Set<ServerResponse>();
  const ws = new WebSocketServer({ noServer: true });
  function security(req: IncomingMessage): boolean {
    const port = req.socket.localPort;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host ?? "")) return false;
    if ((req.method === "POST" || req.method === "DELETE" || req.headers.upgrade) && req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) return false;
    return true;
  }
  function json(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  }
  async function body(req: IncomingMessage): Promise<unknown> {
    let data = "";
    req.setEncoding("utf8");
    for await (const chunk of req) {
      data += chunk.toString();
      if (data.length > 1024 * 1024) throw new OpError("Request body exceeds 1 MiB");
    }
    try { return JSON.parse(data); } catch { throw new OpError("Invalid JSON body"); }
  }
  function args<T>(value: unknown): T {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new OpError("Expected a JSON object");
    return value as T;
  }
  async function route(req: IncomingMessage, res: ServerResponse) {
    if (!security(req)) { json(res, 403, { error: "Host or Origin refused" }); return; }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`), path = url.pathname, method = req.method;
    if (path === "/mcp" && ["POST", "GET", "DELETE"].includes(method ?? "")) {
      const id = req.headers["mcp-session-id"];
      if (typeof id === "string") {
        const session = sessions.get(id);
        if (!session) { json(res, 404, { error: "Unknown MCP session" }); return; }
        await session.transport.handleRequest(req, res); return;
      }
      const input = method === "POST" ? await body(req) : undefined;
      if (!isInitializeRequest(input)) { json(res, 400, { error: "Initialize an MCP session first" }); return; }
      const port = req.socket.localPort;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      const mcp = deps.createMcp();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID, enableDnsRebindingProtection: true,
        allowedHosts: hosts, allowedOrigins: hosts.map(h => `http://${h}`),
        onsessioninitialized: sessionId => { sessions.set(sessionId, { transport, mcp }); },
      });
      await mcp.connect(transport);
      const onclose = transport.onclose;
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); onclose?.(); void mcp.close().catch(console.error); };
      try { await transport.handleRequest(req, res, input); }
      finally { if (!transport.sessionId) await mcp.close(); }
      return;
    }
    if (method === "GET") {
      if (path === "/" || path === "/app.js") {
        const data = await readFile(join(deps.webDir, path === "/" ? "index.html" : "dist/app.js"));
        res.writeHead(200, { "Content-Type": path === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8", "Cache-Control": "no-cache" }); res.end(data); return;
      }
      if (path === "/health") { json(res, 200, { ok: true, head: store.snapshot().head, pendingPush: await store.unpushed() }); return; }
      if (path === "/api/snapshot") { json(res, 200, store.snapshot()); return; }
      if (path === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": connected\n\n"); streams.add(res);
        res.on("close", () => streams.delete(res)); return;
      }
      if (path === "/api/unread") { const { head, owner: { cursor, readMarks } } = store.snapshot(); json(res, 200, { cursor, steps: await unreadSteps(store, cursor, readMarks, head) }); return; }
      if (path === "/api/step") {
        const { head, owner: { cursor, readMarks } } = store.snapshot();
        const step = (await unreadSteps(store, cursor, readMarks, head)).find(s => s.id === url.searchParams.get("id"));
        const kind = url.searchParams.get("kind") ?? "", id = url.searchParams.get("doc") ?? "";
        if (!step || !step.docs.some(d => d.kind === kind && d.id === id)) throw new NotFoundError("Unknown step or document");
        json(res, 200, await stepDiff(store, step, kind, id)); return;
      }
    }
    if (method === "POST") {
      if (path === "/api/notes") { const result = await ownerOps.createNote(args(await body(req))); json(res, 200, { id: result.id }); return; }
      if (path === "/api/draft") { json(res, 200, await ownerOps.setDraft(args(await body(req)))); return; }
      if (path === "/api/send") {
        const result = await ownerOps.send();
        json(res, 200, result); return;
      }
      if (path === "/api/archive") { ownerOps.archive(args(await body(req))); json(res, 200, { ok: true }); return; }
      if (path === "/api/read") { await ownerOps.read(args(await body(req))); json(res, 200, { ok: true }); return; }
    }
    if (method === "DELETE" && path.startsWith("/api/notes/")) { await ownerOps.deleteNote({ id: decodeURIComponent(path.slice(11)) }); json(res, 200, { ok: true }); return; }
    json(res, 404, { error: "Unknown route" });
  }
  const server = http.createServer((req, res) => {
    res.on("finish", () => console.info(`${req.method} ${(req.url ?? "/").split("?")[0]} ${res.statusCode}`));
    void route(req, res).catch(error => {
      console.error(error);
      if (res.headersSent) { res.destroy(); return; }
      json(res, error instanceof NotFoundError ? 404 : error instanceof ConflictError ? 409 : error instanceof OpError ? 400 : 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.on("upgrade", (req, socket, head) => {
    if (!security(req)) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/wake" || !url.searchParams.get("session")) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
    ws.handleUpgrade(req, socket, head, socket => {
      const connection = { socket, session: url.searchParams.get("session")!, alive: true };
      connections.add(connection);
      socket.on("pong", () => { connection.alive = true; });
      socket.on("error", console.error);
      socket.on("close", () => connections.delete(connection));
    });
  });
  function wake(event: { project: string } & Record<string, unknown>) {
    const data = JSON.stringify(event);
    for (const connection of connections) if ((connection.session === "*" || event.project === connection.session) && connection.socket.readyState === WebSocket.OPEN) connection.socket.send(data);
  }
  const off = store.onChange(change => {
    const s = store.snapshot(), r = rules(s);
    for (const doc of change.changed) {
      if (doc.kind === "item" && doc.before === null && (doc.after as Item | null)?.request) {
        const it = doc.after as Item;
        wake({event:"request",item:doc.id,title:it.title,project:r.projectOf(doc.id),by:it.request!.by});
      }
      if (doc.kind === "note" && (doc.after as Note | null)?.state === "sent" && (doc.before as Note | null)?.state !== "sent") {
        const n = doc.after as Note, card = n.target.startsWith("q:") ? s.decisions[n.target.slice(2)] : undefined;
        const item = card?.item ?? n.target.slice(3);
        wake({event:"note",note:doc.id,target:n.target,kind:n.kind,title:card?.question ?? s.items[item]?.title ?? n.target,project:r.projectOf(item)});
      }
    }
    const data = `event: change\ndata: ${JSON.stringify({ commit: change.commit, author: change.author, message: change.message, changed: change.changed.map(({ kind, id, after }) => ({ kind, id, after })) })}\n\n`;
    for (const stream of streams) stream.write(data);
  });
  const heartbeat = setInterval(() => {
    for (const stream of streams) stream.write(": ping\n\n");
    for (const connection of connections) {
      if (!connection.alive) { connection.socket.terminate(); continue; }
      connection.alive = false; connection.socket.ping();
    }
  }, 25_000);
  heartbeat.unref();
  // Close long-lived transports before http.close waits for their sockets.
  const close = server.close.bind(server);
  server.close = callback => {
    clearInterval(heartbeat); off();
    for (const stream of streams) stream.end();
    for (const connection of connections) connection.socket.terminate();
    for (const { mcp } of sessions.values()) void mcp.close().catch(console.error);
    ws.close();
    return close(callback);
  };
  return server;
}
