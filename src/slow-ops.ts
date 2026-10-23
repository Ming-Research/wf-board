import type { Wake } from "./wake.ts";

/** What the board is timed on (docs/design.md, section 4, Time limits): every page request and every MCP tool call is one
 * operation of a class, and the class sets how long it may take. The numbers are starting values. */
export const TIME_LIMITS_MS = { read: 1000, write: 2000, history: 10_000 } as const;
export type OperationClass = keyof typeof TIME_LIMITS_MS;
/** Operations that keep a limit of their own, lower than their class's: the owner's mark-read key waits on this one. */
export const OPERATION_LIMITS_MS: Readonly<Record<string, number>> = { "POST /api/read": 300 };
/** How long after telling the architect of an operation that operation is only logged. */
export const TELL_AGAIN_MS = 60 * 60_000;
/** From this time on, a write's log line carries where its time went (src/write-trace.ts): a quarter of the write class's limit,
 * so the writes that queued a slow one are in the log too. A starting value, like the limits. An operation that keeps a limit of its
 * own (OPERATION_LIMITS_MS) carries them from that limit on, so its slow lines name their steps too. */
export const STEPS_FROM_MS = 500;
/** Whether an operation's time is split into steps (src/write-trace.ts): a write, and an operation with a limit of its own. */
export const tracesSteps = (operation: Operation): boolean => operation.cls === "write" || OPERATION_LIMITS_MS[operation.name] !== undefined;

/** What is timed: `name` is the operation's identity, which the one-hour rule and the push go by; `cls` its class, or none for
 * an operation held to no limit; `label` what its log line says in place of the name, when that tells more. */
export interface Operation { name: string; cls?: OperationClass; label?: string }

/** The path of a request URL, parsed as the router parses it, so a path is classed as the one it is served as (`/api/./notes`
 * is `/api/notes` to both); none for a URL that does not parse, which the router fails. */
export function pathnameOf(url: string | undefined): string | undefined {
  try { return new URL(url ?? "/", "http://localhost").pathname; } catch { return undefined; }
}

/** A route the page server serves. `cls` is none for the long-lived ones, the event stream and the MCP transport (a tool call is
 * timed as its tool). A `prefix` route is every path that starts with `path`, and `name` stands for them all. */
export interface PageRoute { method: string; path: string; cls: OperationClass | null; prefix?: true; name?: string }
/** The one list of the routes the board serves, which the router in src/http.ts consults before it serves anything: a request
 * that matches no row is refused with 404, so a route cannot be served without a class. */
export const PAGE_ROUTES: readonly PageRoute[] = [
  { method: "GET", path: "/", cls: "read" }, { method: "GET", path: "/app.js", cls: "read" }, { method: "GET", path: "/mermaid.js", cls: "read" }, { method: "GET", path: "/health", cls: "read" }, { method: "GET", path: "/api/snapshot", cls: "read" },
  { method: "GET", path: "/api/unread", cls: "history" }, { method: "GET", path: "/api/step", cls: "history" },
  { method: "POST", path: "/api/notes", cls: "write" }, { method: "POST", path: "/api/draft", cls: "write" }, { method: "POST", path: "/api/send", cls: "write" },
  { method: "POST", path: "/api/read", cls: "write" }, { method: "POST", path: "/api/wake", cls: "write" },
  { method: "DELETE", path: "/api/notes/", prefix: true, name: "DELETE /api/notes/:id", cls: "write" },
  { method: "GET", path: "/api/events", cls: null }, { method: "GET", path: "/mcp", cls: null }, { method: "POST", path: "/mcp", cls: null }, { method: "DELETE", path: "/mcp", cls: null },
];
const EXACT_ROUTES = new Map(PAGE_ROUTES.filter(r => !r.prefix).map(r => [`${r.method} ${r.path}`, r] as const));
const PREFIX_ROUTES = PAGE_ROUTES.filter(r => r.prefix);
/** The row a request matches, or none when the board serves no such route. */
export function pageRoute(method: string, path: string): PageRoute | undefined {
  return EXACT_ROUTES.get(`${method} ${path}`) ?? PREFIX_ROUTES.find(r => r.method === method && path.startsWith(r.path));
}

/** The operation a page request is. The name carries no query and no id, and a path the board does not serve has one name,
 * so the names stay a small fixed set; the log line keeps the path the request had. */
export function pageOperation(method: string, path: string | undefined): Operation {
  if (path === undefined) return { name: `${method} (unknown route)`, label: `${method} (unreadable path)`, cls: "read" };
  const label = `${method} ${path}`, route = pageRoute(method, path);
  if (route === undefined) return { name: `${method} (unknown route)`, label, cls: "read" };
  const name = route.name ?? label;
  return { name, ...(name === label ? {} : { label }), ...(route.cls === null ? {} : { cls: route.cls }) };
}

/** The tools that read the board's history, which costs git work; every other tool is a read or, when it changes the board, a write. */
const HISTORY_TOOLS: ReadonlySet<string> = new Set(["changes", "history", "diff"]);
export function toolClass(tool: string, write: boolean): OperationClass {
  return write ? "write" : HISTORY_TOOLS.has(tool) ? "history" : "read";
}

/** Parameter names whose string values name something (an item, a project, a commit, a filter) and are safe to show. Every other
 * string is a body or text a caller wrote, and shows only as its length. */
const PLAIN_KEYS: ReadonlySet<string> = new Set(["id", "doc", "project", "group", "under", "kind", "status", "limit", "since", "until", "from", "to", "session", "repo", "direction", "query", "name"]);
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) + "…" : text);

/** A one-line summary of a call's parameters that holds no body: numbers and booleans as they are, a string only under a
 * name in `PLAIN_KEYS` (cut at 60 characters), any other string as its length, an array as its count, and an object's own
 * parameters one level in. */
export function summarize(value: unknown, depth = 0): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "number" || typeof v === "boolean") parts.push(`${key}=${v}`);
    else if (typeof v === "string") parts.push(PLAIN_KEYS.has(key) ? `${key}=${clip(v.replace(/\s+/g, " "), 60)}` : `${key}(${v.length} chars)`);
    else if (Array.isArray(v)) parts.push(`${key}[${v.length}]`);
    else if (typeof v === "object" && v !== null) parts.push(depth < 1 ? `${key}{${summarize(v, depth + 1)}}` : `${key}{…}`);
  }
  return clip(parts.join(" "), 300);
}

/** The parameters of a page request: its query, and the size of its body. */
export function requestParams(url: string | undefined, contentLength: string | undefined): string {
  let query: Record<string, string> = {};
  try { query = Object.fromEntries(new URL(url ?? "/", "http://localhost").searchParams); } catch { /* a url that does not parse has no query */ }
  const bytes = Number(contentLength);
  return summarize({ ...query, ...(bytes > 0 ? { bodyBytes: bytes } : {}) });
}

export interface Timing extends Operation {
  /** How long it took, in milliseconds. */
  ms: number;
  /** How it ended: a status code, `ok`, `error` or `closed`. */
  result: string;
  /** Its parameters as one line, asked for only when the operation was slow. */
  params?: () => string;
  /** Where its time went, as one line (`WriteTrace.finish`), asked for only when it took `STEPS_FROM_MS`, or the limit of its own
   * (`OPERATION_LIMITS_MS`), or more. */
  steps?: () => string;
}
export interface SlowOpsOptions {
  /** Where a slow operation is told to the architect; without it a slow operation is only logged. */
  wake?: Wake;
  now?: () => number;
  /** The limit of each class, for tests; the limit an operation has of its own is not changed. */
  limitsMs?: Partial<Record<OperationClass, number>>;
}

/** Times the board's operations at their one entry each, logs a line for every one, and tells the architect of those over their
 * limit: one `slow-op` push per operation per hour, then only a log line. */
export class SlowOps {
  private readonly wake?: Wake;
  private readonly now: () => number;
  private readonly limits: Record<OperationClass, number>;
  private readonly told = new Map<string, number>();

  constructor(options: SlowOpsOptions = {}) {
    this.wake = options.wake;
    this.now = options.now ?? Date.now;
    this.limits = { ...TIME_LIMITS_MS, ...options.limitsMs };
    // What the kept pushes already told is not told again, so a restart does not repeat a push within the hour.
    for (const frame of this.wake?.kept() ?? []) if (frame.event === "slow-op" && typeof frame.op === "string") this.told.set(frame.op, Date.parse(frame.at));
  }

  /** Starts timing an operation; the returned function ends it with how it ended and, for the log of a slow one, its parameters
   * and, for the log of one that took long, where its time went. */
  start(operation: Operation): (result: string, params?: () => string, steps?: () => string) => void {
    const from = performance.now();
    return (result, params, steps) => this.record({ ...operation, ms: performance.now() - from, result, params, steps });
  }

  record({ name, cls, label = name, ms: exact, result, params, steps }: Timing): void {
    const ms = Math.round(exact);
    let where = "";
    if (ms >= (OPERATION_LIMITS_MS[name] ?? STEPS_FROM_MS)) try { where = steps?.() ?? ""; } catch { /* the steps are a convenience; the line is still worth writing */ }
    console.info(`${label} ${result} ${ms} ms${where ? `; ${where}` : ""}`);
    const limit = OPERATION_LIMITS_MS[name] ?? (cls === undefined ? undefined : this.limits[cls]);
    if (limit === undefined || ms <= limit) return;
    let detail = "";
    try { detail = params?.() ?? ""; } catch { /* the summary is a convenience; the line is still worth writing */ }
    const now = this.now(), last = this.told.get(name);
    const tell = this.wake !== undefined && (last === undefined || now - last >= TELL_AGAIN_MS);
    if (tell) {
      this.told.set(name, now);
      try { this.wake!.push("slow-op", { op: name, ms, limitMs: limit, params: detail }); }
      catch (error) { console.error("slow-op push failed", error); }
    }
    const earlier = !tell && last !== undefined ? `; the architect was told ${Math.round((now - last) / 60_000)} min ago` : "";
    console.warn(`slow ${label}: ${ms} ms, limit ${limit} ms${detail ? ` (${detail})` : ""}${earlier}`);
  }
}
