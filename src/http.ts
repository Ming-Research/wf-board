import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Decision, Note } from "./model.ts";
import { STALLED_LABEL, affectedItems, changeSeeds } from "./rules.ts";
import type { Snapshot } from "./model.ts";
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
import { Wake } from "./wake.ts";
import { timedWake } from "./timed-wake.ts";
import type { GithubWatch } from "./watch.ts";

export function createHttpServer(deps: { store: Store; ops: Ops; ownerOps: OwnerOps; webDir: string; createMcp: () => McpServer; now?: () => number; checkIntervalMs?: number; maxMcpSessions?: number; maxStreamBytes?: number; wake?: Wake; timedWakeMs?: number; watch?: GithubWatch }): http.Server {
  const { store, ownerOps } = deps, now = deps.now ?? Date.now;
  // The numbered stream of pushes to the architect, the receipts for it and the owner's notifications (src/wake.ts).
  const wake = deps.wake ?? new Wake({ now });
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; mcp: McpServer }>();
  const connections = new Set<{ socket: WebSocket; alive: boolean }>();
  const streams = new Set<ServerResponse>();
  // Headless API sessions often vanish without closing their MCP session; each kept one holds a whole server object, so
  // the map is bounded: the least recently used session is closed past the limit (its client re-initializes on a 404).
  const maxSessions = deps.maxMcpSessions ?? 64, maxStreamBytes = deps.maxStreamBytes ?? 4 * 1024 * 1024;
  function touch(id: string, entry: { transport: StreamableHTTPServerTransport; mcp: McpServer }) {
    sessions.delete(id); sessions.set(id, entry);
    while (sessions.size > maxSessions) {
      const [oldId, old] = sessions.entries().next().value!;
      sessions.delete(oldId);
      void old.transport.close().catch(console.error);
    }
  }
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
  async function body(req: IncomingMessage, empty?: unknown): Promise<unknown> {
    let data = "";
    req.setEncoding("utf8");
    for await (const chunk of req) {
      data += chunk.toString();
      if (data.length > 1024 * 1024) throw new OpError("Request body exceeds 1 MiB");
    }
    if (empty !== undefined && !data.trim()) return empty;
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
        touch(id, session);
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
        onsessioninitialized: sessionId => { touch(sessionId, { transport, mcp }); },
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
      if (path === "/health") { json(res, 200, { ok: true, head: store.snapshot().head, pendingPush: await store.unpushed(), ...(deps.watch ? { github: deps.watch.status() } : {}) }); return; }
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
      if (path === "/api/draft") {
        const input = args<Record<string, unknown>>(await body(req));
        json(res, 200, await (Object.hasOwn(input, "id") ? ownerOps.editDraft(args(input)) : ownerOps.setDraft(args(input)))); return;
      }
      if (path === "/api/send") {
        const result = await ownerOps.send(args(await body(req, {})));
        json(res, 200, result); return;
      }
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
    if (url.pathname !== "/wake") { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
    // `after`: the number of the last event the client has. Without it the client takes events from now on.
    const param = url.searchParams.get("after");
    if (param !== null && !/^\d{1,15}$/.test(param)) { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
    ws.handleUpgrade(req, socket, head, socket => {
      const connection = { socket, alive: true };
      socket.on("pong", () => { connection.alive = true; });
      socket.on("error", console.error);
      socket.on("close", () => connections.delete(connection));
      // Replay and subscription happen in one synchronous step, so no event falls between them or is sent twice.
      socket.send(JSON.stringify({ event: "connected", latest: wake.latest() }));
      if (param !== null) {
        const { frames, gap } = wake.since(Number(param));
        if (gap) socket.send(JSON.stringify({ event: "gap", oldest: wake.oldest(), latest: wake.latest() }));
        for (const frame of frames) socket.send(JSON.stringify(frame));
      }
      connections.add(connection);
    });
  });
  /** A page that stops reading would let its unsent events pile up in memory: past the limit its stream is cut. */
  function writeStreams(data: string) {
    for (const stream of streams) {
      if (stream.writableLength > maxStreamBytes) { streams.delete(stream); stream.destroy(); continue; }
      stream.write(data);
    }
  }
  const unsubscribe = wake.onPush(frame => {
    const data = JSON.stringify(frame);
    for (const connection of connections) if (connection.socket.bufferedAmount > maxStreamBytes) connection.socket.terminate();
    else if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(data);
  });
  // The items flagged 无人推进 now; one that appears and was not in it pushes one "stalled" event. Seeded at start without
  // pushing, so a restart does not announce every standing stall. Other checks are format flags the writer sees; none is pushed.
  let flagged = new Set<string>();
  // The snapshot the last scan read: a change is compared with it to find the items whose checks it can change.
  let scanned: Snapshot | undefined;
  /** `only`: rescan these items and keep every other item's state (rules affectedItems: a write changes no other item's
   * checks; elapsed active time alone is the timer's full scan). */
  function scanChecks(announce: boolean, s = store.snapshot(), only?: Iterable<string>) {
    const r = store.derived.rules(s, now()), next = only ? new Set(flagged) : new Set<string>();
    for (const id of only ?? Object.keys(s.items)) {
      next.delete(id);
      if (!Object.hasOwn(s.items, id) || !r.isOpenWork(id)) continue;
      const stalled = r.checks(id).find(c => c.label === STALLED_LABEL);
      if (!stalled) continue;
      next.add(id);
      if (announce && !flagged.has(id)) wake.push("stalled", { item: id, project: r.projectOf(id), title: s.items[id]!.title, text: stalled.text });
    }
    flagged = next; scanned = s;
  }
  scanChecks(false);
  const off = store.onChange(change => {
    const s = store.snapshot(), r = store.derived.rules(s, now());
    for (const doc of change.changed) {
      // A card that stops work is for the owner, who is told on the Mac; the architect finds it with its other work.
      if (doc.kind === "decision") {
        const card = doc.after as Decision | null, was = doc.before as Decision | null;
        if (card?.status === "open" && card.blocks && (was?.status !== "open" || was.blocks !== card.blocks)) wake.tell(`挡事的卡 · ${r.projectOf(card.item)}`, `${card.question}（挡住：${card.blocks}）`);
      }
      if (doc.kind === "note" && (doc.after as Note | null)?.state === "sent" && (doc.before as Note | null)?.state !== "sent") {
        const n = doc.after as Note, card = n.target.startsWith("q:") ? s.decisions[n.target.slice(2)] : undefined;
        const item = card?.item ?? n.target.slice(3);
        wake.push("note", { note: doc.id, target: n.target, kind: n.kind, title: card?.question ?? s.items[item]?.title ?? n.target, project: r.projectOf(item) });
      }
    }
    // Only the items this change can reach, when the last scan read the snapshot this change was made against.
    const before = scanned && scanned.head === change.activity.from ? store.derived.rules(scanned, now()) : undefined;
    const seeds = before && changeSeeds(scanned!, s, before, r, change.changed, change.activity);
    scanChecks(true, s, before && seeds ? affectedItems(before, r, seeds) : undefined);
    // The activity index travels as its change, not whole: the page applies it to the snapshot it holds (web/app.ts).
    const data = `event: change\ndata: ${JSON.stringify({ commit: change.commit, author: change.author, message: change.message, activity: change.activity, changed: change.changed.map(({ kind, id, after }) => ({ kind, id, after })) })}\n\n`;
    writeStreams(data);
  });
  const heartbeat = setInterval(() => {
    writeStreams(": ping\n\n");
    for (const connection of connections) {
      if (!connection.alive) { connection.socket.terminate(); continue; }
      connection.alive = false; connection.socket.ping();
    }
  }, 25_000);
  heartbeat.unref();
  // The timed wake: once `timedWakeMs` has passed since the last one (kept across restarts), or since the start when there is none.
  const timedMs = deps.timedWakeMs ?? 30 * 60_000, started = new Date(now()).toISOString();
  let timing = false;
  async function timed() {
    const last = wake.lastTimed;
    if (timing || now() < Date.parse(last?.at ?? started) + timedMs) return;
    timing = true;
    try {
      const s = store.snapshot(), fields = await timedWake(store, s, store.derived.rules(s, now()), last, started);
      wake.push("timed", { ...fields });
      wake.markTimed({ at: new Date(now()).toISOString(), head: s.head });
    } catch (error) { console.error(error); }
    finally { timing = false; }
  }
  // Stalls appear with active time alone, and the time limits run out without a write, so re-evaluate on a timer.
  const checker = setInterval(() => { scanChecks(true); wake.checkReceipts(); void timed(); }, deps.checkIntervalMs ?? 60_000);
  checker.unref();
  // The look at GitHub (src/watch.ts) runs on its own timer, every five minutes.
  deps.watch?.start();
  // Close long-lived transports before http.close waits for their sockets.
  const close = server.close.bind(server);
  server.close = callback => {
    clearInterval(heartbeat); clearInterval(checker); deps.watch?.stop(); off(); unsubscribe();
    for (const stream of streams) stream.end();
    for (const connection of connections) connection.socket.terminate();
    for (const { mcp } of sessions.values()) void mcp.close().catch(console.error);
    ws.close();
    return close(callback);
  };
  return server;
}
