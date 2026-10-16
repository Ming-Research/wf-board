import type { Wake } from "./wake.ts";

/** What the board is timed on (docs/design.md, section 4, Time limits): every page request and every MCP tool call is one
 * operation of a class, and the class sets how long it may take. The numbers are starting values. */
export const TIME_LIMITS_MS = { read: 1000, write: 2000, history: 10_000 } as const;
export type OperationClass = keyof typeof TIME_LIMITS_MS;
/** Operations that keep a limit of their own, lower than their class's: the owner's mark-read key waits on this one. */
export const OPERATION_LIMITS_MS: Readonly<Record<string, number>> = { "POST /api/read": 300 };
/** How long after telling the architect of an operation that operation is only logged. */
export const TELL_AGAIN_MS = 60 * 60_000;

/** The class of a page request, or none for the long-lived ones: the event stream and the MCP transport, whose tool calls
 * are timed by the tool instead. `name` is the operation's identity in the log and in the push; it carries no query and no
 * id, and a path the board does not serve has one name, so it cannot grow without bound. */
export function pageOperation(method: string, path: string): { name: string; cls?: OperationClass } {
  const route = `${method} ${path}`, known = PAGE_ROUTES.get(route);
  if (known !== undefined) return known === null ? { name: route } : { name: route, cls: known };
  if (method === "DELETE" && path.startsWith("/api/notes/")) return { name: "DELETE /api/notes/:id", cls: "write" };
  return { name: `${method} (unknown route)`, cls: "read" };
}
const PAGE_ROUTES = new Map<string, OperationClass | null>([
  ["GET /", "read"], ["GET /app.js", "read"], ["GET /health", "read"], ["GET /api/snapshot", "read"],
  ["GET /api/unread", "history"], ["GET /api/step", "history"],
  ["POST /api/notes", "write"], ["POST /api/draft", "write"], ["POST /api/send", "write"], ["POST /api/read", "write"], ["POST /api/wake", "write"],
  ["GET /api/events", null], ["GET /mcp", null], ["POST /mcp", null], ["DELETE /mcp", null],
]);

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

export interface Timing {
  /** The operation's identity: the same operation always has the same name. */
  name: string;
  /** Its class, or none when it is not held to a limit. */
  cls?: OperationClass;
  /** How long it took, in milliseconds. */
  ms: number;
  /** How it ended: a status code, `ok`, `error` or `closed`. */
  result: string;
  /** Its parameters as one line, asked for only when the operation was slow. */
  params?: () => string;
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
    for (const frame of this.wake?.since(0).frames ?? []) if (frame.event === "slow-op" && typeof frame.op === "string") this.told.set(frame.op, Date.parse(frame.at));
  }

  /** Starts timing an operation; the returned function ends it with how it ended and, for the log of a slow one, its parameters. */
  start(name: string, cls?: OperationClass): (result: string, params?: () => string) => void {
    const from = performance.now();
    return (result, params) => this.record({ name, cls, ms: performance.now() - from, result, params });
  }

  record({ name, cls, ms: exact, result, params }: Timing): void {
    const ms = Math.round(exact);
    console.info(`${name} ${result} ${ms} ms`);
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
    console.warn(`slow ${name}: ${ms} ms, limit ${limit} ms${detail ? ` (${detail})` : ""}${earlier}`);
  }
}
