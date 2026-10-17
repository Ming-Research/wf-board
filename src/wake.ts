import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Liveness } from "./liveness.ts";
import { isArchitectSession } from "./model.ts";

/** Where a kind of push goes: the PM's stream; the stream of the session holding the item that `holder` names (an item key
 * among the fields), and the PM's when no session holds it; or the stream of the session that `session` names (the PM's when
 * that is the PM's session) (docs/design.md, The wake streams). */
export type WakeRoute = "pm" | { holder: string } | { session: string };

/** Every kind of push, in one place: `label` names it in a line and in the no-receipt alert, `fields` are the frame's fields
 * besides n, at and event, `to` says whose stream it goes to, `external` marks a kind another process may ask for through
 * POST /api/wake (the deploy job, which runs beside the daemon and cannot call push), and `answeredByCall` marks a kind the
 * session it goes to answers by calling the board, so a tool result does not carry it. push() refuses another kind or field
 * set, and the design doc's frame table is checked against this table. A new kind is one entry here and one row there. */
export const WAKE_KINDS = {
  note: { label: "主人的留言", fields: ["note", "target", "kind", "title", "project"], to: "pm" },
  stalled: { label: "无人推进", fields: ["item", "project", "title", "text"], to: "pm" },
  timed: { label: "定时唤醒", fields: ["since", "changed", "working", "architect", "actions"], to: "pm" },
  "main-red": { label: "主线红了", fields: ["repo", "project", "branch", "commit", "failed", "url"], to: "pm" },
  "pr-red": { label: "PR 检查红了", fields: ["repo", "number", "project", "title", "commit", "failed", "url", "items"], to: "pm" },
  "pr-ready": { label: "PR 可以合入", fields: ["repo", "number", "project", "title", "base", "commit", "url", "items"], to: "pm" },
  "pr-orphan": { label: "PR 没挂在条目上", fields: ["repo", "number", "project", "title", "url", "draft"], to: "pm" },
  "slow-op": { label: "操作太慢", fields: ["op", "ms", "limitMs", "params"], to: "pm" },
  "backup-behind": { label: "备份落后", fields: ["commits", "lastSuccess", "reason"], to: "pm" },
  "actions-usage": { label: "Actions 用量", fields: ["org", "reason", "level", "month", "day", "used", "included", "today", "budget", "text"], to: "pm" },
  deployed: { label: "部署成功", fields: ["version", "previous", "changes", "restarted"], to: "pm", external: true },
  deployFailed: { label: "部署失败", fields: ["version", "running", "reason"], to: "pm", external: true },
  "item-done": { label: "子条目做完", fields: ["item", "project", "title", "parent"], to: { holder: "parent" } },
  "ask-alive": { label: "问一句", fields: ["item", "project", "title", "since"], to: { holder: "item" }, answeredByCall: true },
  "no-answer": { label: "没回应", fields: ["session", "item", "project", "title", "since"], to: "pm" },
  message: { label: "消息", fields: ["message", "from", "project", "to", "item", "text"], to: { session: "to" } },
} as const satisfies Record<string, { label: string; fields: readonly string[]; to: WakeRoute; external?: true; answeredByCall?: true }>;
export type WakeKind = keyof typeof WAKE_KINDS;
/** Frames the server sends on its own, without a number: the first on every connection, and the one that says events were dropped. */
export const CONTROL_FRAMES = { connected: ["latest"], gap: ["oldest", "latest"] } as const;

export type WakeFrame = { n: number; at: string; event: WakeKind } & Record<string, unknown>;
/** Whether a push is one its recipient has to be given: not a kind it answers by calling the board (`answeredByCall`). */
const mustBeGiven = (frame: WakeFrame): boolean => !("answeredByCall" in WAKE_KINDS[frame.event]);

/** The most characters one line of a push holds (docs/design.md, The wake streams, Size): what an agent's context takes per push. */
export const LINE_LIMIT = 200;
/** The most characters of a message's line before its text: number, label, sender and item. With the text (model
 * MESSAGE_TEXT_LIMIT, 150) and the colon between them the line stays within LINE_LIMIT; the text is never cut. */
export const MESSAGE_PREFIX_LIMIT = 49;
/** The most lines a tool result carries pushes in; the rest are counted by kind and wait for the next call. */
export const FOOTER_LINES = 5;
/** The first line of the pushes a tool result carries, so they are not read as part of the tool's own answer. */
export const FOOTER_HEAD = "【看板推送】";

/** Cut text to `limit` characters (code points, so a Chinese character is one), ending with … when it was cut. */
function cut(text: string, limit: number): string {
  const chars = [...text];
  return chars.length <= limit ? text : chars.slice(0, limit - 1).join("") + "…";
}
const str = (v: unknown) => typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
const short = (v: unknown) => str(v).slice(0, 7);
/** The number of entries a capped list stands for: its entries, plus the count in a trailing `{more}`. */
const count = (v: unknown) => Array.isArray(v) ? v.reduce((n: number, e) => n + (e && typeof e === "object" && typeof (e as { more?: unknown }).more === "number" ? (e as { more: number }).more : 1), 0) : 0;
const it = (item: unknown, project: unknown) => `it:${str(item)}（${str(project)}）`;
const pr = (f: Record<string, unknown>) => `${str(f.repo)}#${str(f.number)}`;
/** A time given as an ISO string, to the minute. */
const minute = (v: unknown) => `${str(v).slice(0, 16)}Z`;

/** What each kind says after its label: the subject first (an item or PR with its project), then a few words. Details are
 * read from the board when needed, so a line carries no list and no body text. */
const SAYS: { [K in WakeKind]: (f: Record<string, unknown>) => string } = {
  note: f => `${str(f.target)}（${str(f.project)}）· ${str(f.kind)} · ${str(f.title)}`,
  stalled: f => `${it(f.item, f.project)} · ${str(f.title)}`,
  timed: f => `变了 ${count(f.changed)} 条，在做 ${count(f.working)} 条，Architect 项目开着 ${count(f.architect)} 条`,
  "main-red": f => `${str(f.repo)} ${str(f.branch)} ${short(f.commit)} · ${count(f.failed)} 项检查失败`,
  "pr-red": f => `${pr(f)} · ${count(f.failed)} 项检查失败 · ${str(f.title)}`,
  "pr-ready": f => `${pr(f)} · ${str(f.title)}`,
  "pr-orphan": f => `${pr(f)}${f.draft ? "（草稿）" : ""} · ${str(f.title)}`,
  "slow-op": f => `${str(f.op)} 用了 ${str(f.ms)} 毫秒，限 ${str(f.limitMs)}`,
  "backup-behind": f => `远端缺 ${str(f.commits)} 个提交`,
  "actions-usage": f => `${str(f.org)} · ${str(f.text)}`,
  deployed: f => `${short(f.version)}，${count(f.changes)} 个改动${f.restarted ? "，重启了" : ""}`,
  deployFailed: f => `${short(f.version) || "版本不明"} · ${str(f.reason)}`,
  "item-done": f => `${it(f.item, f.project)} · ${str(f.title)} · 等它的：it:${str(f.parent)}`,
  "ask-alive": f => `${it(f.item, f.project)} · 最后一次动静 ${minute(f.since)}，调一次看板就算在`,
  "no-answer": f => `${it(f.item, f.project)} · 会话 ${str(f.session)} · 最后一次动静 ${minute(f.since)} · ${str(f.title)}`,
  message: f => `${str(f.from)}（${str(f.project)}）${f.item ? ` · it:${str(f.item)}` : ""}`,
};

/** The one line an agent is given for a push: its number, label and what it is about, at most LINE_LIMIT characters. */
export function lineOf(frame: WakeFrame): string {
  const head = `#${frame.n} ${WAKE_KINDS[frame.event].label} · ${SAYS[frame.event](frame)}`;
  // A message's text is what it says: only what comes before it may be cut.
  if (frame.event === "message") return `${cut(head, MESSAGE_PREFIX_LIMIT)}：${str(frame.text)}`;
  return cut(head, LINE_LIMIT);
}

/** A notice the owner is told: its title and message, and the card or item it is about, which a click opens. */
export interface Told { title: string; message: string; target?: { kind: "card" | "item"; key: string } }

/** The card or item a frame is about, for a click to open: a stalled item, the item of a session that gave no answer, or the item
 * or card a note is on. Other frames have none. */
function targetOf(frame: WakeFrame): Told["target"] {
  if ((frame.event === "stalled" || frame.event === "no-answer") && typeof frame.item === "string") return { kind: "item", key: frame.item };
  if (frame.event === "note" && typeof frame.target === "string") {
    if (frame.target.startsWith("it:")) return { kind: "item", key: frame.target.slice(3) };
    if (frame.target.startsWith("q:")) return { kind: "card", key: frame.target.slice(2) };
  }
  return undefined;
}
export interface TimedMark { at: string; head: string }

interface LogOptions {
  /** Where events and their state are kept so numbers continue across a restart; without it they live in memory only. */
  file?: string;
  now?: () => number;
  /** Most events kept, and most bytes of them; the oldest go first. */
  retain?: number;
  retainBytes?: number;
}

/** Check a push against the table: a known kind with exactly its fields. */
function checked(event: WakeKind, fields: Record<string, unknown>): void {
  const spec = WAKE_KINDS[event] as { fields: readonly string[] } | undefined;
  if (!spec) throw new Error(`Unknown wake kind ${String(event)}`);
  const given = Object.keys(fields).sort().join(","), wanted = [...spec.fields].sort().join(",");
  if (given !== wanted) throw new Error(`Wake ${event} takes the fields ${wanted}, not ${given}`);
}

/**
 * One numbered, kept stream of pushes: the events, their numbers and the file that keeps them. The PM's stream (Wake) and
 * each agent's (AgentStream) add what they keep besides: a line of the file that is not an event goes to `loadState`, and
 * `stateLines` writes that state back when the file is rewritten.
 */
abstract class NumberedLog {
  protected readonly file?: string;
  protected readonly now: () => number;
  private readonly retain: number;
  private readonly retainBytes: number;
  protected frames: Array<{ frame: WakeFrame; bytes: number }> = [];
  private total = 0;
  protected counter = 0;
  private listeners = new Set<(frame: WakeFrame) => void>();

  constructor(options: LogOptions, retain: number, retainBytes: number) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.retain = options.retain ?? retain;
    this.retainBytes = options.retainBytes ?? retainBytes;
  }

  protected iso(): string { return new Date(this.now()).toISOString(); }

  /** Read the file. A file that cannot be read costs the numbers' continuity across a restart, never the board. */
  protected loadFile(): void {
    try { if (this.file && existsSync(this.file)) this.load(this.file); }
    catch (error) { console.error("wake log unreadable; starting empty", error); }
  }

  private load(file: string): void {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (typeof record.event === "string" && typeof record.n === "number") {
        this.frames.push({ frame: record as WakeFrame, bytes: Buffer.byteLength(line) });
        this.total += Buffer.byteLength(line);
        this.counter = Math.max(this.counter, record.n);
      } else if (typeof record.latest === "number") this.counter = Math.max(this.counter, record.latest);
      else this.loadState(record);
    }
    this.trim();
  }
  protected abstract loadState(record: Record<string, unknown>): void;
  protected abstract stateLines(): unknown[];
  /** Lines a rewritten file starts with, before everything else. */
  protected headLines(): unknown[] { return []; }

  protected append(record: unknown): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(record) + "\n");
    } catch (error) { console.error("wake log not written", error); }
  }

  /** Drop the oldest events past the limits, and rewrite the file when it holds more than it needs. */
  private trim(): void {
    const before = this.frames.length;
    while (this.frames.length > 1 && (this.frames.length > this.retain || this.total > this.retainBytes)) this.total -= this.frames.shift()!.bytes;
    if (this.file && before !== this.frames.length) this.rewrite(this.file);
  }

  private rewrite(file: string): void {
    const lines: unknown[] = [...this.headLines(), { latest: this.counter }, ...this.frames.map(f => f.frame), ...this.stateLines()];
    const temporary = file + ".tmp";
    try {
      writeFileSync(temporary, lines.map(l => JSON.stringify(l) + "\n").join(""));
      renameSync(temporary, file);
    } catch (error) { console.error("wake log not rewritten", error); }
  }

  /** The number of the newest event, 0 before the first. */
  latest(): number { return this.counter; }
  /** The number of the oldest event still kept, or the next number when none is. */
  oldest(): number { return this.frames[0]?.frame.n ?? this.counter + 1; }

  /** Number, keep and send one event; `extra` adds fields the frame carries on this stream only. */
  protected add(event: WakeKind, fields: Record<string, unknown>, extra?: (frame: WakeFrame) => Record<string, unknown>): WakeFrame {
    const numbered = { n: ++this.counter, at: this.iso(), event, ...fields } as WakeFrame;
    const frame = extra ? { ...numbered, ...extra(numbered) } as WakeFrame : numbered;
    const line = JSON.stringify(frame);
    this.frames.push({ frame, bytes: Buffer.byteLength(line) }); this.total += Buffer.byteLength(line);
    this.append(frame);
    this.trim();
    for (const listener of this.listeners) { try { listener(frame); } catch (error) { console.error(error); } }
    return frame;
  }

  /** The kept events numbered above `after`, and whether some between `after` and them were dropped (or `after` is ahead of
   * the stream, which a client that outlived a reset of the log would send). */
  since(after: number): { frames: WakeFrame[]; gap: boolean } {
    const gap = after > this.counter || (after < this.counter && after + 1 < this.oldest());
    return { frames: this.frames.filter(f => f.frame.n > after).map(f => f.frame), gap };
  }

  onPush(fn: (frame: WakeFrame) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}

/**
 * The stream of one agent other than the PM (docs/design.md, The wake streams): a session holding an item, a reviewer, the
 * observer. The board keeps how far it has been delivered: an event is delivered when the agent's wait script says it printed
 * it (an `ack` on its connection) or when a tool result carried it. A delivered event is never sent again.
 */
export class AgentStream extends NumberedLog {
  readonly name: string;
  private delivered = 0;
  /** When the stream last had a push or a delivery, for dropping a stream nobody uses. */
  private touched = 0;

  constructor(name: string, options: LogOptions = {}) {
    super(options, 200, 256 * 1024);
    this.name = name;
    this.loadFile();
    // A stream read from its file was last used at its newest record; a new one, now.
    const last = this.frames.at(-1)?.frame.at;
    if (last) this.touched = Math.max(this.touched, Date.parse(last));
    if (!this.touched) this.touched = this.now();
  }

  /** A new file starts with whose stream it is, since the file is named by a hash of the name. */
  protected append(record: unknown): void {
    if (this.file && !existsSync(this.file)) super.append({ name: this.name });
    super.append(record);
  }
  protected loadState(record: Record<string, unknown>): void {
    if (typeof record.delivered === "number") {
      this.delivered = Math.max(this.delivered, record.delivered);
      if (typeof record.at === "string") this.touched = Math.max(this.touched, Date.parse(record.at));
    }
  }
  protected headLines(): unknown[] { return [{ name: this.name }]; }
  protected stateLines(): unknown[] { return this.delivered ? [{ delivered: this.delivered, at: new Date(this.touched).toISOString() }] : []; }

  /** Number and keep a push to this agent. Its frame also carries `line`, the one line the agent is shown. */
  push(event: WakeKind, fields: Record<string, unknown>): WakeFrame {
    checked(event, fields);
    this.touched = this.now();
    return this.add(event, fields, frame => ({ line: lineOf(frame) }));
  }

  /** The number of the newest event delivered, 0 before any. */
  deliveredUpTo(): number { return this.delivered; }
  /** The kept events not yet delivered, and whether some undelivered ones were dropped before they could be. */
  pending(): { frames: WakeFrame[]; gap: boolean } {
    return { frames: this.frames.filter(f => f.frame.n > this.delivered).map(f => f.frame), gap: this.delivered + 1 < this.oldest() && this.delivered < this.counter };
  }
  /** The events up to `n` have reached the agent. A number at or below what is delivered, or above the newest, changes nothing. */
  deliver(n: number): void {
    if (!Number.isSafeInteger(n) || n <= this.delivered || n > this.counter) return;
    this.delivered = n; this.touched = this.now();
    this.append({ delivered: n, at: this.iso() });
  }
  /** Milliseconds since the stream last had a push or a delivery. */
  idleFor(): number { return this.now() - this.touched; }
  /** Remove the file; the stream is forgotten. */
  remove(): void {
    if (!this.file) return;
    try { rmSync(this.file, { force: true }); } catch (error) { console.error("wake log not removed", error); }
  }
}

export interface WakeOptions extends LogOptions {
  /** Where the agents' streams are kept, one file each; without it they live in memory only. */
  dir?: string;
  /** Where the marks of the liveness checks are kept (src/liveness.ts); without it they live in memory only. */
  livenessFile?: string;
  receiptLimitMs?: number;
}

/** The file of an agent's stream: a hash of the session name, so any name of up to 80 characters is a short file name and two
 * names that differ only in case (the same file on a case-insensitive disk) are two files. The name is the file's first line,
 * `{"name": ...}` and nothing else, in a new file and in a rewritten one. */
export const agentFileName = (name: string): string => createHash("sha256").update(name).digest("hex").slice(0, 32) + ".jsonl";
/** The session name an agent's stream file holds, or none. */
function nameIn(file: string): string | undefined {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    // Only a record holding the name alone: an event, whatever fields its kind carries, is never taken for it.
    if (record && typeof record === "object" && Object.keys(record).length === 1 && typeof record.name === "string") return record.name;
  }
  return undefined;
}

/** A stream unused this long, with nothing undelivered and no item held, is dropped. */
export const AGENT_STREAM_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The board's pushes: the PM's numbered, kept stream with the receipts that answer it (this class), and one stream for each
 * other agent (AgentStream), with the routing between them. The owner's notifications go out from here too.
 */
export class Wake extends NumberedLog {
  readonly receiptLimitMs: number;
  private readonly dir?: string;
  /** Whether the sessions holding items are still there: a call, or an alive frame from its wait script, is a sign (`liveness.see`), and the server's
   * minute timer runs `liveness.check`, which pushes the ask and the "no answer" through this object. */
  readonly liveness: Liveness;
  private receipted = 0;
  private alerted = false;
  private marked?: TimedMark;
  private tellListeners = new Set<(told: Told) => void>();
  private agents = new Map<string, AgentStream>();
  private agentListeners = new Set<(stream: AgentStream, frame: WakeFrame) => void>();
  /** The session holding an item, for the kinds routed to a holder; none until routeBy is called. */
  private holder: (item: string) => string | undefined = () => undefined;

  constructor(options: WakeOptions = {}) {
    super(options, 1000, 2 * 1024 * 1024);
    this.dir = options.dir;
    this.receiptLimitMs = options.receiptLimitMs ?? 60 * 60 * 1000;
    this.liveness = new Liveness({ wake: this, now: this.now, file: options.livenessFile });
    this.loadFile();
    // The agents' streams are read at start, so what is undelivered reaches a tool result before any wait script connects.
    try {
      if (this.dir && existsSync(this.dir)) for (const file of readdirSync(this.dir)) {
        if (!file.endsWith(".jsonl")) continue;
        const name = nameIn(join(this.dir, file));
        if (name !== undefined && agentFileName(name) === file) this.agent(name);
        else console.error(`agent wake log ${file} names no session it is the file of; left alone`);
      }
    } catch (error) { console.error("agent wake logs unreadable", error); }
  }

  protected loadState(record: Record<string, unknown>): void {
    if (typeof record.ack === "number") { this.receipted = Math.max(this.receipted, record.ack); this.alerted = false; }
    else if (record.alert === true) this.alerted = true;
    else if (record.timed && typeof record.timed === "object") this.marked = record.timed as TimedMark;
  }
  protected stateLines(): unknown[] {
    const lines: unknown[] = [];
    if (this.receipted) lines.push({ ack: this.receipted });
    if (this.alerted) lines.push({ alert: true });
    if (this.marked) lines.push({ timed: this.marked });
    return lines;
  }

  /** The number of the newest event the PM has answered, 0 before any. */
  receiptedUpTo(): number { return this.receipted; }
  get lastTimed(): TimedMark | undefined { return this.marked; }

  /** How a holder-routed push finds its session: the session holding an item, or none. */
  routeBy(holder: (item: string) => string | undefined): void { this.holder = holder; }

  /** The stream of an agent other than the PM, made on first use. Its file is written only once something happens on it. */
  agent(name: string): AgentStream {
    let stream = this.agents.get(name);
    if (!stream) {
      stream = new AgentStream(name, { file: this.dir ? join(this.dir, agentFileName(name)) : undefined, now: this.now });
      const made = stream;
      stream.onPush(frame => { for (const listener of this.agentListeners) { try { listener(made, frame); } catch (error) { console.error(error); } } });
      this.agents.set(name, stream);
    }
    return stream;
  }
  /** Whether an agent has a stream, without making one. */
  hasAgent(name: string): boolean { return this.agents.has(name); }
  /** Every push to any agent's stream, with the stream it went to. */
  onAgentPush(fn: (stream: AgentStream, frame: WakeFrame) => void): () => void {
    this.agentListeners.add(fn);
    return () => { this.agentListeners.delete(fn); };
  }

  /** Number, keep and send one event to the stream its kind routes it to: the PM's; the stream of the session holding the
   * item the route names (the PM's when nobody holds it); or the stream of the session the route names. The fields must be
   * exactly those the kind lists. */
  push(event: WakeKind, fields: Record<string, unknown>): WakeFrame {
    checked(event, fields);
    const to = WAKE_KINDS[event].to as WakeRoute;
    if (to !== "pm") {
      const named = "session" in to ? fields[to.session] : fields[to.holder];
      const name = typeof named !== "string" ? undefined : "session" in to ? named : this.holder(named);
      if (name !== undefined && !isArchitectSession(name)) return this.agent(name).push(event, fields);
    }
    return this.add(event, fields);
  }

  /** Whether `event` is a kind another process may push: one the table marks external, and no other. */
  static isExternal(event: unknown): event is WakeKind {
    return typeof event === "string" && Object.hasOwn(WAKE_KINDS, event) && "external" in WAKE_KINDS[event as WakeKind];
  }

  /**
   * The pushes a tool result carries for the agent `name` (docs/design.md, The wake streams, In a tool result): the oldest
   * undelivered ones, one line each, at most FOOTER_LINES, then a line counting the rest by kind. What is shown is delivered;
   * the rest waits for the next call or the wait script. A kind marked `answeredByCall` is not shown, since this very call
   * answers it, but counts as delivered. Empty when nothing is shown.
   */
  footer(name: string): string {
    const stream = this.agents.get(name);
    if (!stream) return "";
    const { frames, gap } = stream.pending();
    if (!frames.length) return "";
    const carried = frames.filter(mustBeGiven);
    if (!carried.length && !gap) { stream.deliver(frames.at(-1)!.n); return ""; }
    const shown = carried.slice(0, FOOTER_LINES), rest = carried.slice(FOOTER_LINES);
    const lines = [FOOTER_HEAD];
    if (gap) lines.push(`有推送没送到就被丢了（看板只留 #${stream.oldest()} 及以后的）：去看板读最近的变化`);
    lines.push(...shown.map(lineOf));
    if (rest.length) {
      const kinds = new Map<string, number>();
      for (const f of rest) kinds.set(WAKE_KINDS[f.event].label, (kinds.get(WAKE_KINDS[f.event].label) ?? 0) + 1);
      lines.push(`另有 ${rest.length} 条没送到（${[...kinds].map(([label, n]) => `${label} ${n}`).join("、")}）：再调一次看板，或挂等待脚本取`);
    }
    // Everything up to the last line shown is delivered, the answered kinds among it; with nothing left over, everything pending is.
    stream.deliver(rest.length ? shown.at(-1)!.n : frames.at(-1)!.n);
    return lines.join("\n");
  }

  /** Drop the streams nobody uses: everything delivered, unused for AGENT_STREAM_IDLE_MS, and not a session `keep` names (one
   * holding an item, or one whose wait script is connected). An ask left undelivered counts as delivered: it is answered by a
   * call, and a session that died with one pending would otherwise leave its stream for good. */
  prune(keep: (name: string) => boolean): void {
    for (const [name, stream] of this.agents) {
      if (keep(name) || stream.pending().frames.some(mustBeGiven) || stream.idleFor() < AGENT_STREAM_IDLE_MS) continue;
      stream.remove(); this.agents.delete(name);
    }
  }

  /** Record when the last timed wake was made and at which commit, so the next one counts changes from there even after a restart. */
  markTimed(mark: TimedMark): void { this.marked = mark; this.append({ timed: mark }); }

  /** A call from the PM's session: everything pushed to the PM before it is answered. Writes only when that changes something. */
  receipt(): void {
    if (this.counter === this.receipted && !this.alerted) return;
    this.receipted = this.counter; this.alerted = false;
    this.append({ ack: this.receipted, at: this.iso() });
  }

  /** When the oldest event without a receipt is `receiptLimitMs` old, tell the owner once; a receipt starts the count again. */
  checkReceipts(): void {
    if (this.alerted) return;
    const oldest = this.frames.find(f => f.frame.n > this.receipted)?.frame;
    if (!oldest || this.now() - Date.parse(oldest.at) < this.receiptLimitMs) return;
    this.alerted = true;
    this.append({ alert: true, at: this.iso() });
    const minutes = Math.round(this.receiptLimitMs / 60_000), span = minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
    this.tell(`架构师 ${span}没响应`, `最早没回执的是 #${oldest.n}：${WAKE_KINDS[oldest.event].label}${typeof oldest.title === "string" ? "：" + oldest.title : ""}`, targetOf(oldest));
  }

  /** Tell the owner: every listener (the open pages) gets the notice. A failing listener is logged and never reaches the write that caused the notice. */
  tell(title: string, message: string, target?: Told["target"]): void {
    const told: Told = target ? { title, message, target } : { title, message };
    for (const listener of this.tellListeners) {
      try { listener(told); }
      catch (error) { console.error("owner notice listener failed", error); }
    }
  }

  /** Each notice the owner is told from now on. A listener added later gets none of the earlier ones. */
  onTell(fn: (told: Told) => void): () => void {
    this.tellListeners.add(fn);
    return () => { this.tellListeners.delete(fn); };
  }
}
