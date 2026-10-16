import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Notify } from "./notify.ts";

/** Every kind of push the architect's channel carries, in one place: `label` names it in the no-receipt alert, `fields` are
 * the frame's fields besides n, at and event, and `external` marks a kind another process may ask for through POST /api/wake
 * (the deploy job, which runs beside the daemon and cannot call push). push() refuses another kind or field set, and the
 * design doc's frame table is checked against this table. A new kind is one entry here and one row there. */
export const WAKE_KINDS = {
  note: { label: "主人的留言", fields: ["note", "target", "kind", "title", "project"] },
  stalled: { label: "无人推进", fields: ["item", "project", "title", "text"] },
  timed: { label: "定时唤醒", fields: ["since", "changed", "working", "architect"] },
  "main-red": { label: "主线红了", fields: ["repo", "project", "branch", "commit", "failed", "url"] },
  "pr-red": { label: "PR 检查红了", fields: ["repo", "number", "project", "title", "commit", "failed", "url", "items"] },
  "pr-ready": { label: "PR 可以合入", fields: ["repo", "number", "project", "title", "base", "commit", "url", "items"] },
  "pr-orphan": { label: "PR 没挂在条目上", fields: ["repo", "number", "project", "title", "url", "draft"] },
  deployed: { label: "部署成功", fields: ["version", "previous", "changes", "restarted"], external: true },
  deployFailed: { label: "部署失败", fields: ["version", "running", "reason"], external: true },
} as const satisfies Record<string, { label: string; fields: readonly string[]; external?: true }>;
export type WakeKind = keyof typeof WAKE_KINDS;
/** Frames the server sends on its own, without a number: the first on every connection, and the one that says events were dropped. */
export const CONTROL_FRAMES = { connected: ["latest"], gap: ["oldest", "latest"] } as const;

export type WakeFrame = { n: number; at: string; event: WakeKind } & Record<string, unknown>;

/** A notice the owner is told: its title and message, and the card or item it is about, which a click opens. */
export interface Told { title: string; message: string; target?: { kind: "card" | "item"; key: string } }

/** The card or item a frame is about, for a click to open: a stalled item, or the item or card a note is on. Other frames have none. */
function targetOf(frame: WakeFrame): Told["target"] {
  if (frame.event === "stalled" && typeof frame.item === "string") return { kind: "item", key: frame.item };
  if (frame.event === "note" && typeof frame.target === "string") {
    if (frame.target.startsWith("it:")) return { kind: "item", key: frame.target.slice(3) };
    if (frame.target.startsWith("q:")) return { kind: "card", key: frame.target.slice(2) };
  }
  return undefined;
}
export interface TimedMark { at: string; head: string }
export interface WakeOptions {
  /** Where events, receipts and alerts are kept so numbers continue across a restart; without it they live in memory only. */
  file?: string;
  now?: () => number;
  /** How the owner is told: a blocking card, and no receipt for `receiptLimitMs`. */
  notify?: Notify;
  /** Most events kept, and most bytes of them; the oldest go first. */
  retain?: number;
  retainBytes?: number;
  receiptLimitMs?: number;
}

/** The numbered, kept stream of pushes to the architect, and the receipts that answer them. */
export class Wake {
  readonly receiptLimitMs: number;
  private readonly file?: string;
  private readonly now: () => number;
  private readonly notify: Notify;
  private readonly retain: number;
  private readonly retainBytes: number;
  private frames: Array<{ frame: WakeFrame; bytes: number }> = [];
  private total = 0;
  private counter = 0;
  private receipted = 0;
  private alerted = false;
  private marked?: TimedMark;
  private listeners = new Set<(frame: WakeFrame) => void>();
  private tellListeners = new Set<(told: Told) => void>();

  constructor(options: WakeOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.notify = options.notify ?? (() => {});
    this.retain = options.retain ?? 1000;
    this.retainBytes = options.retainBytes ?? 2 * 1024 * 1024;
    this.receiptLimitMs = options.receiptLimitMs ?? 60 * 60 * 1000;
    // A file that cannot be read or written costs the numbers' continuity across a restart, never the board.
    try { if (this.file && existsSync(this.file)) this.load(this.file); }
    catch (error) { console.error("wake log unreadable; starting empty", error); }
  }

  private iso(): string { return new Date(this.now()).toISOString(); }

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
      else if (typeof record.ack === "number") { this.receipted = Math.max(this.receipted, record.ack); this.alerted = false; }
      else if (record.alert === true) this.alerted = true;
      else if (record.timed && typeof record.timed === "object") this.marked = record.timed as TimedMark;
    }
    this.trim();
  }

  private append(record: unknown): void {
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
    const lines: unknown[] = [{ latest: this.counter }, ...this.frames.map(f => f.frame)];
    if (this.receipted) lines.push({ ack: this.receipted });
    if (this.alerted) lines.push({ alert: true });
    if (this.marked) lines.push({ timed: this.marked });
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
  /** The number of the newest event the architect has answered, 0 before any. */
  receiptedUpTo(): number { return this.receipted; }
  get lastTimed(): TimedMark | undefined { return this.marked; }

  /** Number, keep and send one event. The fields must be exactly those the kind lists. */
  push(event: WakeKind, fields: Record<string, unknown>): WakeFrame {
    const spec = WAKE_KINDS[event] as { fields: readonly string[] } | undefined;
    if (!spec) throw new Error(`Unknown wake kind ${String(event)}`);
    const given = Object.keys(fields).sort().join(","), wanted = [...spec.fields].sort().join(",");
    if (given !== wanted) throw new Error(`Wake ${event} takes the fields ${wanted}, not ${given}`);
    const frame = { n: ++this.counter, at: this.iso(), event, ...fields } as WakeFrame;
    const line = JSON.stringify(frame);
    this.frames.push({ frame, bytes: Buffer.byteLength(line) }); this.total += Buffer.byteLength(line);
    this.append(frame);
    this.trim();
    for (const listener of this.listeners) { try { listener(frame); } catch (error) { console.error(error); } }
    return frame;
  }

  /** Whether `event` is a kind another process may push: one the table marks external, and no other. */
  static isExternal(event: unknown): event is WakeKind {
    return typeof event === "string" && Object.hasOwn(WAKE_KINDS, event) && "external" in WAKE_KINDS[event as WakeKind];
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

  /** Record when the last timed wake was made and at which commit, so the next one counts changes from there even after a restart. */
  markTimed(mark: TimedMark): void { this.marked = mark; this.append({ timed: mark }); }

  /** A call from the architect's session: everything pushed before it is answered. Writes only when that changes something. */
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

  /** Tell the owner, and tell every listener (the open pages). A failure is logged and never reaches the write that caused it. */
  tell(title: string, message: string, target?: Told["target"]): void {
    try { void Promise.resolve(this.notify(title, message)).catch(error => console.error("notify failed", error)); }
    catch (error) { console.error("notify failed", error); }
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
