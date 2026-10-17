import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Decision, Note } from "./model.ts";
import { isArchitectSession } from "./model.ts";
import { STALLED_LABEL, affectedItems, changeSeeds } from "./rules.ts";
import type { Snapshot } from "./model.ts";
import { WebSocketServer, WebSocket } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Credentials, Resolved } from "./credentials.ts";
import { ConflictError } from "./store.ts";
import type { Store } from "./store.ts";
import { OpError } from "./ops.ts";
import type { Ops } from "./ops.ts";
import { NotFoundError } from "./owner-ops.ts";
import type { OwnerOps } from "./owner-ops.ts";
import { unreadSteps, stepDiff } from "./history.ts";
import { Wake } from "./wake.ts";
import type { AgentStream } from "./wake.ts";
import { holderOf, holders } from "./dispatch.ts";
import { timedWake } from "./timed-wake.ts";
import type { GithubWatch } from "./watch.ts";
import { SlowOps, pageOperation, pageRoute, pathnameOf, requestParams } from "./slow-ops.ts";
import type { UsageWatch } from "./usage-watch.ts";
import { Budget, BudgetError, REQUEST_LIMITS, withBudget } from "./budget.ts";
import type { BudgetLimits } from "./budget.ts";
import { pageVersion, stampPage } from "./page-version.ts";

/** The most a push through POST /api/wake may carry, as JSON: a deploy's list of changes is far below it. */
const MAX_EXTERNAL_PUSH = 16 * 1024;

/** Once the server is closing, a request still running has this long to finish before its connection is closed (design section 4, "Stopping"). */
export const SHUTDOWN_GRACE_MS = 2000;

export function createHttpServer(deps: { store: Store; ops: Ops; ownerOps: OwnerOps; webDir: string; createMcp: (credential?: Resolved) => McpServer; credentials?: Credentials; now?: () => number; checkIntervalMs?: number; maxStreamBytes?: number; wake?: Wake; timedWakeMs?: number; watch?: GithubWatch; usage?: UsageWatch; shutdownGraceMs?: number; slow?: SlowOps; budget?: BudgetLimits }): http.Server {
  const { store, ownerOps } = deps, now = deps.now ?? Date.now;
  // Times every page request (docs/design.md, section 4, Time limits). Without one given, requests are logged with their time and never told.
  const slow = deps.slow ?? new SlowOps({ now });
  // What one request may read of the history (src/budget.ts); every request gets a budget of its own.
  const limits = deps.budget ?? REQUEST_LIMITS;
  // Set by `close`: from then on every new request is refused, so no client starts a session in a process that is about to exit.
  let closing = false;
  // The numbered streams of pushes, the PM's receipts and the owner's notifications (src/wake.ts).
  const wake = deps.wake ?? new Wake({ now });
  // A push routed to an item's holder goes to the session holding it now (docs/design.md, The wake streams).
  wake.routeBy(item => holderOf(store.snapshot(), item));
  // Each wake socket, with the agent stream it reads; none for the PM's stream at /wake.
  const connections = new Set<{ socket: WebSocket; alive: boolean; stream?: AgentStream }>();
  const streams = new Set<ServerResponse>();
  const maxStreamBytes = deps.maxStreamBytes ?? 4 * 1024 * 1024;
  const ws = new WebSocketServer({ noServer: true });
  function security(req: IncomingMessage): boolean {
    const port = req.socket.localPort;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host ?? "")) return false;
    if ((req.method === "POST" || req.method === "DELETE" || req.headers.upgrade) && req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) return false;
    return true;
  }
  function json(res: ServerResponse, status: number, data: unknown, headers: http.OutgoingHttpHeaders = {}) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(data));
  }
  // The page files are read from disk on each request, so a rebuilt page needs no restart (design section 4, Deploying).
  const pageFile = (name: string) => readFile(join(deps.webDir, name));
  const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
  const optionalPageFile = (name: string) => pageFile(name).catch((error: unknown) => { if (missing(error)) return undefined; throw error; });
  /** The page as it is on disk now: index.html, and the version its files make. The version is undefined while the bundle is
   * missing (a build under way), which leaves the page without one: it does not reload itself. The diagram library is part of the
   * version when it is built; a page served without it draws no diagrams. */
  async function currentPage(): Promise<{ html: Buffer; version: string | undefined }> {
    const html = await pageFile("index.html");
    try { return { html, version: pageVersion(html, await pageFile("dist/app.js"), await optionalPageFile("dist/mermaid.js")) }; }
    catch (error) { if (missing(error)) return { html, version: undefined }; throw error; }
  }
  // The version the open pages were last told: by a deploy that ended, or when the first page connected. A deploy that ends tells them
  // again only when the version differs (design section 4, Deploying).
  let announced: string | undefined;
  const pageEvent = (version: string) => "event: page\ndata: " + JSON.stringify({ version }) + "\n\n";
  // The reads run one after another, in the order asked: a page that connects is told what was on disk when it joined, and no
  // announcement made after that read passes it.
  let reading: Promise<unknown> = Promise.resolve();
  /** Reads the page now and returns its version, or undefined. `announce`: tell every open page when it differs from the last told;
   * a page that connects only reads, and the pages already open wait for the deploy that ends. */
  function readPage(announce: boolean): Promise<string | undefined> {
    const run = reading.then(async () => {
      let version: string | undefined;
      try { version = (await currentPage()).version; } catch (error) { console.error(error); return undefined; }
      if (version === undefined) return undefined;
      if (announce && version !== announced) { announced = version; writeStreams(pageEvent(version)); }
      else announced ??= version;
      return version;
    });
    reading = run;
    return run;
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
    // What the board serves is the list in src/slow-ops.ts, which classes every route for the time limits: a branch below that the list lacks is never reached.
    if (!pageRoute(method ?? "", path)) { json(res, 404, { error: "Unknown route" }); return; }
    if (path === "/mcp" && ["POST", "GET", "DELETE"].includes(method ?? "")) {
      // The MCP endpoint keeps no session (docs/design.md, section 4): every request stands alone, so a restart of the board loses
      // nothing a client holds. It has no stream to open and nothing to close, which is what 405 tells a client.
      if (method !== "POST") { json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "This MCP endpoint keeps no session: POST every request" }, id: null }, { Allow: "POST" }); return; }
      const input = await body(req);
      const port = req.socket.localPort;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      // Who is writing is told by the credential in the request (src/credentials.ts); a request without one can only read.
      const credential = deps.credentials?.resolve(req.headers.authorization, store.snapshot());
      const mcp = deps.createMcp(credential);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, enableJsonResponse: true, enableDnsRebindingProtection: true,
        allowedHosts: hosts, allowedOrigins: hosts.map(h => `http://${h}`),
      });
      await mcp.connect(transport);
      try { await transport.handleRequest(req, res, input); }
      finally { await mcp.close(); }
      return;
    }
    if (method === "GET") {
      if (path === "/") {
        // The page learns which version it is from the mark in its own text; the event stream later says which version is current.
        const { html, version } = await currentPage();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }); res.end(stampPage(html.toString("utf8"), version)); return;
      }
      if (path === "/app.js") {
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" }); res.end(await pageFile("dist/app.js")); return;
      }
      if (path === "/mermaid.js") {
        // The diagram library the page loads when it first shows a mermaid block. It is several MB, so the browser keeps it and asks again
        // with the tag of its copy: an unchanged library costs a 304, a rebuilt one is fetched whole.
        const library = await optionalPageFile("dist/mermaid.js");
        if (!library) { json(res, 404, { error: "The diagram library is not built" }); return; }
        const tag = `"${createHash("sha256").update(library).digest("hex").slice(0, 16)}"`;
        if (req.headers["if-none-match"] === tag) { res.writeHead(304, { ETag: tag, "Cache-Control": "no-cache" }); res.end(); return; }
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache", ETag: tag }); res.end(library); return;
      }
      if (path === "/health") { json(res, 200, { ok: true, head: store.snapshot().head, pendingPush: await store.unpushed(), ...(deps.watch ? { github: deps.watch.status() } : {}), ...(deps.usage ? { usage: deps.usage.status() } : {}) }); return; }
      if (path === "/api/snapshot") { json(res, 200, store.snapshot()); return; }
      if (path === "/api/events") {
        // Read before the headers go out, so joining the stream and the first write happen in one step. Only this stream is told.
        const version = await readPage(false);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": connected\n\n" + (version === undefined ? "" : pageEvent(version))); streams.add(res);
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
      // A push from the deploy job, which runs beside the daemon: only the kinds the wake table marks external, with exactly their fields.
      if (path === "/api/wake") {
        const { event, ...fields } = args<Record<string, unknown>>(await body(req));
        if (!Wake.isExternal(event)) throw new OpError(`Wake event ${JSON.stringify(event)} cannot be pushed through the API`);
        if (JSON.stringify(fields).length > MAX_EXTERNAL_PUSH) throw new OpError(`Wake event ${event} exceeds ${MAX_EXTERNAL_PUSH} bytes`);
        let frame;
        try { frame = wake.push(event, fields); } catch (error) { throw new OpError(error instanceof Error ? error.message : String(error)); }
        json(res, 200, { n: frame.n }); return;
      }
    }
    if (method === "DELETE" && path.startsWith("/api/notes/")) { await ownerOps.deleteNote({ id: decodeURIComponent(path.slice(11)) }); json(res, 200, { ok: true }); return; }
    json(res, 404, { error: "Unknown route" });
  }
  const server = http.createServer((req, res) => {
    // Ends when the response has gone out or the connection closed before that (a page that gave up waiting is timed too).
    const ended = slow.start(pageOperation(req.method ?? "", pathnameOf(req.url)));
    res.on("close", () => ended(res.writableFinished ? String(res.statusCode) : "closed", () => requestParams(req.url, req.headers["content-length"])));
    // A connection that was running a request when the server began to close is idle now: close it, rather than keep it for the grace.
    res.on("finish", () => { if (closing) server.closeIdleConnections(); });
    if (closing) { json(res, 503, { error: "The board is shutting down; try again" }, { Connection: "close", "Retry-After": "2" }); return; }
    void withBudget(new Budget(`${req.method} ${pathnameOf(req.url) ?? "request"}`, limits), () => route(req, res)).catch(error => {
      // A budget has said why it stopped the request on the warning log already.
      if (!(error instanceof BudgetError)) console.error(error);
      if (res.headersSent) { res.destroy(); return; }
      json(res, error instanceof NotFoundError ? 404 : error instanceof ConflictError ? 409 : error instanceof OpError ? 400 : error instanceof BudgetError ? 413 : 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.on("upgrade", (req, socket, head) => {
    if (closing) { socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 2\r\n\r\n"); return; }
    if (!security(req)) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/wake/")) { agentUpgrade(req, socket, head, url); return; }
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
  /**
   * An agent's stream, `/wake/<session name>` (docs/design.md, The wake streams): the board keeps how far it was delivered, so the
   * client sends no number. It gets `connected`, `gap` when undelivered events were dropped, every undelivered event, then live
   * ones; it answers `{"ack": n}` once it has printed the events up to n, and they are not sent again.
   */
  function agentUpgrade(req: IncomingMessage, raw: Duplex, head: Buffer, url: URL) {
    let name: string;
    try { name = decodeURIComponent(url.pathname.slice(6)).trim(); } catch { name = ""; }
    // The PM's stream is /wake; a name with a slash, none, or a long one is not a session name.
    if (!name || name.length > 80 || name.includes("/") || /\p{Cc}/u.test(name) || isArchitectSession(name) || url.search) { raw.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
    ws.handleUpgrade(req, raw, head, socket => {
      const stream = wake.agent(name), connection = { socket, alive: true, stream };
      socket.on("pong", () => { connection.alive = true; });
      socket.on("error", console.error);
      socket.on("close", () => connections.delete(connection));
      socket.on("message", data => {
        let ack: unknown;
        try { ack = (JSON.parse(data.toString()) as { ack?: unknown }).ack; } catch { return; }
        if (typeof ack === "number") stream.deliver(ack);
      });
      // Replay and subscription happen in one synchronous step, so no event falls between them or is sent twice.
      socket.send(JSON.stringify({ event: "connected", latest: stream.latest() }));
      const { frames, gap } = stream.pending();
      if (gap) socket.send(JSON.stringify({ event: "gap", oldest: stream.oldest(), latest: stream.latest() }));
      for (const frame of frames) socket.send(JSON.stringify(frame));
      connections.add(connection);
    });
  }
  /** A page that stops reading would let its unsent events pile up in memory: past the limit its stream is cut. */
  function writeStreams(data: string) {
    for (const stream of streams) {
      if (stream.writableLength > maxStreamBytes) { streams.delete(stream); stream.destroy(); continue; }
      stream.write(data);
    }
  }
  // The owner's notices go to each open page as they happen. A page that connects later gets only what follows its connection.
  const unsubscribeTold = wake.onTell(told => writeStreams("event: owner\ndata: " + JSON.stringify(told) + "\n\n"));
  // A deploy that has ended (built, and the daemon answering) may have changed the page without a restart: the open pages are told if it did.
  const unsubscribeDeploys = wake.onPush(frame => { if (frame.event === "deployed" || frame.event === "deployFailed") void readPage(true); });
  /** Whether a socket reads this agent's stream now: a stream in use is never dropped, or the socket would keep the old one. */
  const connected = (name: string) => [...connections].some(c => c.stream?.name === name);
  /** Send a frame to the sockets reading one stream: the PM's (`stream` undefined) or an agent's. */
  function sendTo(stream: AgentStream | undefined, frame: object) {
    const data = JSON.stringify(frame);
    for (const connection of connections) {
      if (connection.stream !== stream) continue;
      if (connection.socket.bufferedAmount > maxStreamBytes) connection.socket.terminate();
      else if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(data);
    }
  }
  const unsubscribe = wake.onPush(frame => sendTo(undefined, frame));
  const unsubscribeAgents = wake.onAgentPush((stream, frame) => sendTo(stream, frame));
  // The items flagged 无人推进 now; one that appears and was not in it pushes one "stalled" event. Seeded at start without
  // pushing, so a restart does not announce every standing stall. Other checks are format flags the writer sees; none is pushed.
  let flagged = new Set<string>();
  // The items done now; one that becomes done pushes "item-done" for each open item waiting on it (an owner or a shared
  // dependent), to the session holding that item, else to the PM. Seeded at start like `flagged`, so a restart announces nothing.
  let finished = new Set<string>();
  // The snapshot the last scan read: a change is compared with it to find the items whose checks it can change.
  let scanned: Snapshot | undefined;
  /** `only`: rescan these items and keep every other item's state (rules affectedItems: a write changes no other item's
   * checks; elapsed active time alone is the timer's full scan). */
  function scanChecks(announce: boolean, s = store.snapshot(), only?: Iterable<string>) {
    const r = store.derived.rules(s, now()), next = only ? new Set(flagged) : new Set<string>(), done = only ? new Set(finished) : new Set<string>();
    for (const id of only ?? Object.keys(s.items)) {
      next.delete(id); done.delete(id);
      if (Object.hasOwn(s.items, id) && r.statusOf(id) === "done") {
        done.add(id);
        if (announce && !finished.has(id)) for (const { id: parent } of r.dependents(id)) {
          if (!r.isOpenWork(parent)) continue;
          wake.push("item-done", { item: id, project: r.projectOf(id), title: s.items[id]!.title, parent });
        }
      }
      if (!Object.hasOwn(s.items, id) || !r.isOpenWork(id)) continue;
      const stalled = r.checks(id).find(c => c.label === STALLED_LABEL);
      if (!stalled) continue;
      next.add(id);
      if (announce && !flagged.has(id)) wake.push("stalled", { item: id, project: r.projectOf(id), title: s.items[id]!.title, text: stalled.text });
    }
    flagged = next; finished = done; scanned = s;
  }
  scanChecks(false);
  const off = store.onChange(change => {
    const s = store.snapshot(), r = store.derived.rules(s, now());
    for (const doc of change.changed) {
      // A card that stops work is for the owner, who is told in the open board pages; the architect finds it with its other work.
      if (doc.kind === "decision") {
        const card = doc.after as Decision | null, was = doc.before as Decision | null;
        if (card?.status === "open" && card.blocks && (was?.status !== "open" || was.blocks !== card.blocks)) wake.tell(`挡事的卡 · ${r.projectOf(card.item)}`, `${card.question}（挡住：${card.blocks}）`, { kind: "card", key: doc.id });
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
      const s = store.snapshot(), fields = await withBudget(new Budget("timed wake", limits), () => timedWake(store, s, store.derived.rules(s, now()), last, started, deps.usage?.line()));
      wake.push("timed", { ...fields });
      wake.markTimed({ at: new Date(now()).toISOString(), head: s.head });
    } catch (error) { console.error(error); }
    finally { timing = false; }
  }
  // Stalls appear with active time alone, and the time limits run out without a write, so re-evaluate on a timer.
  const checker = setInterval(() => { scanChecks(true); wake.checkReceipts(); const held = holders(store.snapshot()); wake.prune(name => held.has(name) || connected(name)); void timed(); }, deps.checkIntervalMs ?? 60_000);
  checker.unref();
  // The look at GitHub (src/watch.ts) runs on its own timer, every five minutes.
  deps.watch?.start();
  // The look at the Actions billing (src/usage-watch.ts) runs on its own timer, every half hour.
  deps.usage?.start();
  // Stopping (design section 4): no new request is served; what is running gets the grace to finish; then every connection is closed.
  const close = server.close.bind(server);
  server.close = callback => {
    if (closing) return close(callback);
    closing = true;
    clearInterval(heartbeat); clearInterval(checker); deps.watch?.stop(); deps.usage?.stop(); off(); unsubscribe(); unsubscribeAgents(); unsubscribeDeploys(); unsubscribeTold();
    // The long-lived streams end now, so their clients start to reconnect and are refused. A tool call running on an MCP
    // request is not one of them: it answers on its own request.
    for (const stream of streams) stream.end();
    for (const connection of connections) connection.socket.terminate();
    ws.close();
    const cut = setTimeout(() => server.closeAllConnections(), deps.shutdownGraceMs ?? SHUTDOWN_GRACE_MS);
    return close(error => {
      clearTimeout(cut);
      callback?.(error);
    });
  };
  return server;
}
