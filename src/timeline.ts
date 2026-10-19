// The timeline of a piece of work: the states it went through, as segments with a kind, a start and a length. The runner's reports are
// commits, so the store derives each item's list of state starts from the history (`activity.states`, advanced by `withStateStart`
// on every write and by the history replay alike); this file turns that list, the item's dispatch records, its pause spans and its
// end into segments. The `timeline` tool prints the result and the page draws it, both from this one function, like src/whole-view.ts.
// docs/design.md, section 7, "Agent list", gives the reasons for each rule.

import { RUNNER_STATES } from "./model.ts";
import type { Dispatch, Item, RunnerState, Snapshot, StateStart } from "./model.ts";
import type { Rules } from "./rules.ts";
import { spanText } from "./whole-view.ts";

/** The most state starts the index keeps for one item, the newest; a runner that reports without end cannot make an item grow without bound. */
export const STATE_STARTS_MAX = 500;

/**
 * The state start a stored or historical runner report makes, or null when it is no report. Read leniently: a report written by an
 * older version of the board may lack a field the schema has now. The one place a start is made, for the live write and the
 * history replay alike, so a restart gives what the writes gave.
 */
export function startOfReport(raw: unknown): StateStart | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== "string" || !(RUNNER_STATES as readonly string[]).includes(r.state)) return null;
  if (typeof r.since !== "string" || !Number.isFinite(Date.parse(r.since))) return null;
  const keys = (value: unknown): readonly string[] | undefined => Array.isArray(value) && value.length && value.every(x => typeof x === "string") ? value as string[] : undefined;
  const to = r.to === "owner" || r.to === "architect" ? r.to : undefined, cards = keys(r.cards), items = keys(r.items);
  const what = typeof r.what === "string" ? r.what : undefined, until = typeof r.until === "string" && Number.isFinite(Date.parse(r.until)) ? r.until : undefined;
  return {
    at: r.since, state: r.state as RunnerState,
    ...(to === undefined ? {} : { to }), ...(cards === undefined ? {} : { cards }), ...(items === undefined ? {} : { items }),
    ...(what === undefined ? {} : { what }), ...(until === undefined ? {} : { until }),
  };
}

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));
function sameStart(a: StateStart, b: StateStart): boolean {
  return a.at === b.at && a.state === b.state && a.to === b.to && a.what === b.what && a.until === b.until && sameList(a.cards, b.cards) && sameList(a.items, b.items);
}

/**
 * The list of state starts after one more report: the list itself when the report only repeats the last start (a new turn's figures
 * move the report's `at` and leave its `since`), else a new list with the start added, at most STATE_STARTS_MAX of the newest.
 */
export function withStateStart(list: readonly StateStart[] | undefined, start: StateStart): readonly StateStart[] {
  const last = list?.at(-1);
  if (list && last && sameStart(last, start)) return list;
  const next = [...(list ?? []), start];
  return next.length > STATE_STARTS_MAX ? next.slice(next.length - STATE_STARTS_MAX) : next;
}

/** What a segment is: the kinds a reported state makes, then `paused`. */
export const SEGMENT_KINDS = ["work", "ci", "owner", "architect", "items", "run", "wait", "merge", "person", "closing", "paused"] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];
export const SEGMENT_TEXT: Readonly<Record<SegmentKind, string>> = {
  work: "干活", ci: "等 CI", owner: "等主人", architect: "等架构师", items: "等条目", run: "等 14900K", wait: "等事件", merge: "等合入", person: "要人看", closing: "待收尾", paused: "暂停",
};
/** The kinds in which the work waits for something outside the engineer: the segments a session put down (`down`) is marked on. */
export const WAITING_KINDS: ReadonlySet<SegmentKind> = new Set<SegmentKind>(["ci", "owner", "architect", "items", "run", "wait", "merge"]);
/** The kinds the longest-wait list counts: the waits, and the work stopped for a person to look at. */
const STALLED_KINDS: ReadonlySet<SegmentKind> = new Set<SegmentKind>([...WAITING_KINDS, "person"]);

export function kindOf(start: Pick<StateStart, "state" | "to">): SegmentKind {
  switch (start.state) {
    case "running": return "work";
    case "ci": return "ci";
    case "ask": return start.to === "owner" ? "owner" : "architect";
    case "items": return "items";
    case "run": return "run";
    case "wait": return "wait";
    case "ready": return "merge";
    case "exception": return "person";
    case "done": return "closing";
  }
}

/** A stretch of the line, in ms of the board's clock. `down`: the work waits and no engineer session is open (the session was put down). */
export interface Segment {
  kind: SegmentKind;
  from: number;
  to: number;
  down?: true;
  cards?: readonly string[];
  items?: readonly string[];
  what?: string;
  until?: string;
}
export interface Timeline {
  from: number;
  /** The end of the line: the end of the work, else now. */
  to: number;
  segments: Segment[];
  /** Milliseconds spent in each kind of segment; `down` is the part of the waits spent with no session open, which the kinds count too. */
  totals: Record<SegmentKind, number>;
  down: number;
  /** Set when the work is over: done, or cancelled. */
  ended?: { kind: "done" | "cancelled"; at: number };
}

export interface TimelineInput {
  starts: readonly StateStart[] | undefined;
  /** The item's dispatch records: only the engineers' count. */
  dispatches?: ReadonlyArray<Pick<Dispatch, "role" | "started" | "finish">> | undefined;
  /** The spans the item was paused, an inherited pause included (`activity.pauses`). */
  pauses?: ReadonlyArray<{ start: string; end?: string }> | undefined;
  /** When the work began if that is earlier than its first report (the report's `started`). */
  began?: string | undefined;
  ended?: Timeline["ended"] | undefined;
  now: number;
}

type Span = readonly [number, number];
/** The spans sorted, with overlapping and touching ones joined. */
function joined(spans: Span[]): Span[] {
  const out: Array<[number, number]> = [];
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
  }
  return out;
}
/** The segments cut at the edges of `spans`; the pieces inside a span go through `inside`. */
function overlay(segments: Segment[], spans: Span[], inside: (piece: Segment) => Segment): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    let at = seg.from;
    for (const [s, e] of spans) {
      if (e <= at) continue;
      if (s >= seg.to) break;
      const a = Math.max(s, at), b = Math.min(e, seg.to);
      if (!(b > a)) continue;
      if (a > at) out.push({ ...seg, from: at, to: a });
      out.push(inside({ ...seg, from: a, to: b }));
      at = b;
    }
    if (at < seg.to) out.push({ ...seg, from: at, to: seg.to });
  }
  return out;
}

/** Neighbouring segments that are the same thing (a stretch cut by a gap that changed nothing for it) joined into one. */
function coalesced(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const last = out.at(-1);
    if (last && last.to === seg.from && last.kind === seg.kind && !last.down === !seg.down && last.what === seg.what && last.until === seg.until && sameList(last.cards, seg.cards) && sameList(last.items, seg.items)) last.to = seg.to;
    else out.push({ ...seg });
  }
  return out;
}

/**
 * The line of one piece of work at `now`: a segment for each stretch it spent in a state, the work's kind where the runner reported it,
 * `paused` where the item was paused (what it waited for then is not told), and the waits marked `down` where no engineer session was
 * open: between a session's end and the next one's start, which is how a session put down while it waits shows. Empty when the runner
 * never reported on it.
 */
export function timelineOf(input: TimelineInput): Timeline {
  const starts = [...input.starts ?? []].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const totals = Object.fromEntries(SEGMENT_KINDS.map(k => [k, 0])) as Record<SegmentKind, number>;
  if (!starts.length) return { from: input.now, to: input.now, segments: [], totals, down: 0 };
  const first = Date.parse(starts[0]!.at), began = input.began === undefined ? first : Math.min(first, Date.parse(input.began));
  const end = Math.max(input.ended?.at ?? input.now, began);
  let segments: Segment[] = [];
  starts.forEach((start, i) => {
    const from = i === 0 ? began : Date.parse(start.at), to = i + 1 < starts.length ? Date.parse(starts[i + 1]!.at) : end;
    if (!(to > from)) return;
    segments.push({
      kind: kindOf(start), from: Math.min(from, end), to: Math.min(to, end),
      ...(start.cards === undefined ? {} : { cards: start.cards }), ...(start.items === undefined ? {} : { items: start.items }),
      ...(start.what === undefined ? {} : { what: start.what }), ...(start.until === undefined ? {} : { until: start.until }),
    });
  });
  segments = segments.filter(seg => seg.to > seg.from);
  // A pause covers whatever the state was: the pieces inside it become one stretch of `paused`.
  const paused = joined((input.pauses ?? []).map(p => [Date.parse(p.start), p.end === undefined ? Infinity : Date.parse(p.end)] as const));
  segments = overlay(segments, paused, piece => ({ kind: "paused", from: piece.from, to: piece.to }));
  // The gaps between an engineer's session ending and the next one starting; the last session ended leaves a gap that does not close.
  const engineers = (input.dispatches ?? []).filter(d => d.role === "工程师").sort((a, b) => Date.parse(a.started) - Date.parse(b.started));
  const gaps = joined(engineers.flatMap((d, i): Span[] => d.finish ? [[Date.parse(d.finish.ended), i + 1 < engineers.length ? Date.parse(engineers[i + 1]!.started) : Infinity] as const] : []));
  segments = coalesced(overlay(segments, gaps, piece => WAITING_KINDS.has(piece.kind) ? { ...piece, down: true } : piece));
  let down = 0;
  for (const seg of segments) { totals[seg.kind] += seg.to - seg.from; if (seg.down) down += seg.to - seg.from; }
  return { from: began, to: end, segments, totals, down, ...(input.ended ? { ended: input.ended } : {}) };
}

/** When the work was over: the time its last plan row was done or dropped, or an item cancelled when it was last written. */
export function endOf(it: Item, r: Pick<Rules, "statusOf">, id: string): Timeline["ended"] | undefined {
  if (it.status === "cancelled") return { kind: "cancelled", at: Date.parse(it.updated) };
  if (r.statusOf(id) !== "done") return undefined;
  const dates = it.plan.flatMap(row => "state" in row ? [row.doneAt, row.droppedAt].flatMap(at => at === undefined ? [] : [Date.parse(at)]) : []);
  return { kind: "done", at: dates.length ? Math.max(...dates) : Date.parse(it.updated) };
}

/** The line of an item on the board, from its state starts, dispatch records, pause spans and end. */
export function timelineOfItem(s: Pick<Snapshot, "items"> & { activity?: Snapshot["activity"] }, r: Pick<Rules, "statusOf">, id: string, now: number): Timeline {
  const it = s.items[id];
  if (!it) return timelineOf({ starts: undefined, now });
  return timelineOf({ starts: s.activity?.states?.[id], dispatches: it.dispatches, pauses: s.activity?.pauses?.[id], began: it.runner?.started, ended: endOf(it, r, id), now });
}

// --- drawing --------------------------------------------------------------------------------------------------------

/** A segment longer than this is drawn shorter: only this much and a tenth of the rest, so a week-long wait does not push the day's work out of the bar. */
export const LONG_SEGMENT_MS = 3 * 3600_000;
/** How long a segment is drawn, in the unit of its length: its time up to LONG_SEGMENT_MS and a tenth of the rest. */
export function drawLength(ms: number): number {
  return ms <= LONG_SEGMENT_MS ? ms : LONG_SEGMENT_MS + (ms - LONG_SEGMENT_MS) / 10;
}

// --- the tool -------------------------------------------------------------------------------------------------------

const two = (n: number): string => String(n).padStart(2, "0");
/** A time as the lists write it, in UTC: 「10-19 07:39Z」. */
export function clockText(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}Z`;
}
/** What a segment waits for, in a line: the cards, the items, or the event. */
export function waitsFor(seg: Pick<Segment, "cards" | "items" | "what" | "until">): string {
  const parts = [seg.cards?.length ? `卡 ${seg.cards.join("、")}` : "", seg.items?.length ? `条目 ${seg.items.join("、")}` : "", seg.what ? seg.what + (seg.until ? `（到 ${clockText(Date.parse(seg.until))}）` : "") : ""];
  return parts.filter(Boolean).join(" · ");
}
/** The name of a segment as the lists say it. */
export function segmentLabel(seg: Pick<Segment, "kind" | "down">): string {
  return SEGMENT_TEXT[seg.kind] + (seg.down ? "（放下等待）" : "");
}

/** The most segments of one line the tool lists; a longer line lists the newest and counts the rest. */
export const TIMELINE_ROWS = 60;
/** The default and the most rows of the longest-wait list. */
export const LONGEST_DEFAULT = 10, LONGEST_MAX = 40;

/** One wait: the segment, joined with the ones next to it that wait for the same thing, and whether it goes on now. */
export interface LongWait { id: string; kind: SegmentKind; from: number; to: number; ongoing: boolean; down: boolean; waits: string }

/**
 * The longest waits over the given lines, longest first: every stretch in a waiting kind (or stopped for a person), the pieces a pause or a
 * session put down cut apart left whole where they wait for the same thing. A wait that goes on counts up to the end of its line.
 */
export function longestWaits(lines: ReadonlyArray<{ id: string; timeline: Timeline }>, limit: number): LongWait[] {
  const out: LongWait[] = [];
  for (const { id, timeline } of lines) {
    const goesOn = (to: number) => to === timeline.to && !timeline.ended;
    let open: LongWait | undefined, openKey = "";
    for (const seg of timeline.segments) {
      if (!STALLED_KINDS.has(seg.kind)) { open = undefined; continue; }
      const key = `${seg.kind}\0${waitsFor(seg)}`;
      if (open && openKey === key && open.to === seg.from) { open.to = seg.to; open.down ||= !!seg.down; open.ongoing = goesOn(seg.to); continue; }
      openKey = key;
      open = { id, kind: seg.kind, from: seg.from, to: seg.to, ongoing: goesOn(seg.to), down: !!seg.down, waits: waitsFor(seg) };
      out.push(open);
    }
  }
  return out.sort((a, b) => (b.to - b.from) - (a.to - a.from) || (a.id < b.id ? -1 : a.id > b.id ? 1 : a.from - b.from)).slice(0, limit);
}

const cut = (text: string, max: number): string => { const chars = [...text.replace(/\s+/g, " ").trim()]; return chars.length <= max ? chars.join("") : `${chars.slice(0, max).join("")}…`; };

/** One item's line as the tool's text: the span, the totals by kind and the segments, newest TIMELINE_ROWS of them. */
export function timelineText(id: string, title: string, t: Timeline): string {
  if (!t.segments.length) return `${id} · ${cut(title, 24)} · 执行程序没有报告过这件活的状态，没有线。`;
  const span = t.to - t.from, kinds = SEGMENT_KINDS.filter(k => t.totals[k] > 0);
  const head = `${id} · ${cut(title, 24)} · 共 ${spanText(span)}（${clockText(t.from)} 起，${t.ended ? `${t.ended.kind === "done" ? "做完于" : "取消于"} ${clockText(t.ended.at)}` : "还没完"}）`;
  const totals = kinds.map(k => `${SEGMENT_TEXT[k]} ${spanText(t.totals[k])}`).join(" · ") + (t.down ? `；其中放下等待 ${spanText(t.down)}` : "");
  const rows = t.segments.slice(-TIMELINE_ROWS).map(seg => {
    const waits = waitsFor(seg);
    return `  ${clockText(seg.from)} · ${segmentLabel(seg)} · ${spanText(seg.to - seg.from)}${waits ? ` · ${waits}` : ""}${seg.to === t.to && !t.ended ? " · 还在这里" : ""}`;
  });
  const more = t.segments.length > TIMELINE_ROWS ? [`  … 前面还有 ${t.segments.length - TIMELINE_ROWS} 段没列出`] : [];
  return [head, `合计：${totals}`, ...more, ...rows].join("\n");
}

/** The longest waits among the lines as the tool's text; `titles` gives an item's title. */
export function longestWaitsText(waits: readonly LongWait[], titles: (id: string) => string, lines: number, now: number): string {
  if (!waits.length) return `没有在跑的活有等待段（看了 ${lines} 件在跑的活）。`;
  const rows = waits.map(w => `  ${w.id} · ${cut(titles(w.id), 24)} · ${SEGMENT_TEXT[w.kind]}${w.down ? "（含放下等待）" : ""} · ${spanText(w.to - w.from)} · ${clockText(w.from)} 起${w.ongoing ? "，还在等" : `，到 ${clockText(w.to)}`}${w.waits ? ` · ${w.waits}` : ""}`);
  return [`在跑的活里最长的 ${waits.length} 个等待段（看了 ${lines} 件；${clockText(now)} 的数）`, ...rows].join("\n");
}
