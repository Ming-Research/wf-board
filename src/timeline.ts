// The timeline of an agent: what one session did from its start to its end, as segments with a kind, a start and a length. An agent is one
// dispatch record. The runner's reports are commits, so the store derives each item's list of state starts from the history
// (`activity.states`, advanced by `withStateStart` on every write and by the history replay alike); this file cuts that list to the span of
// one dispatch, with the item's pause spans, into segments. The `timeline` tool prints the result and the page draws it, both from this one
// function, like src/whole-view.ts. docs/design.md, section 7, "Agent list", gives the reasons for each rule.

import { RUNNER_START_GRACE_MS } from "./agents.ts";
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

/** What a segment is: `work` (a turn of the agent runs), the things it waits for, and `paused` (the item was paused). */
export const SEGMENT_KINDS = ["work", "ci", "owner", "architect", "items", "run", "wait", "merge", "person", "closing", "paused"] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];
export const SEGMENT_TEXT: Readonly<Record<SegmentKind, string>> = {
  work: "干活", ci: "等 CI", owner: "等主人", architect: "等架构师", items: "等条目", run: "等 14900K", wait: "等事件", merge: "等合入", person: "要人看", closing: "待收尾", paused: "暂停",
};
/** The kinds the longest-wait list counts: the waits for something outside the agent, and the work stopped for a person to look at. */
const STALLED_KINDS: ReadonlySet<SegmentKind> = new Set<SegmentKind>(["ci", "owner", "architect", "items", "run", "wait", "merge", "person"]);

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

/** A stretch of an agent's line, in ms of the board's clock. */
export interface Segment {
  kind: SegmentKind;
  from: number;
  to: number;
  cards?: readonly string[];
  items?: readonly string[];
  what?: string;
  until?: string;
}
/** The line of one agent: one dispatch, from its start to its end (else to now), cut into segments. */
export interface AgentLine {
  agentId: string;
  agent: string;
  role: Dispatch["role"];
  level: number;
  from: number;
  /** The end of the line: when the session ended or the work was over, else now. */
  to: number;
  segments: Segment[];
  /** Milliseconds spent in each kind of segment. */
  totals: Record<SegmentKind, number>;
  /** Set when the session is over: the result its dispatch ended with, or that the work ended before it did. */
  ended?: { at: number; result: string };
}

export interface LineInput {
  /** The item's state starts (`activity.states`), whichever agent they fell to. */
  starts: readonly StateStart[] | undefined;
  dispatch: Pick<Dispatch, "agentId" | "agent" | "role" | "level" | "started" | "finish">;
  /** The spans the item was paused, an inherited pause included (`activity.pauses`). */
  pauses?: ReadonlyArray<{ start: string; end?: string }> | undefined;
  /** When the work was over, if it was: a session still open then ends there. */
  over?: { at: number; text: string } | undefined;
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

/** Neighbouring segments that are the same thing (a state reported again a moment after the session began) joined into one. */
function coalesced(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const last = out.at(-1);
    if (last && last.to === seg.from && last.kind === seg.kind && last.what === seg.what && last.until === seg.until && sameList(last.cards, seg.cards) && sameList(last.items, seg.items)) last.to = seg.to;
    else out.push({ ...seg });
  }
  return out;
}

const zeroTotals = () => Object.fromEntries(SEGMENT_KINDS.map(k => [k, 0])) as Record<SegmentKind, number>;

/**
 * The line of one agent at `now`: the session begins with a turn, so it is `work` until the first state the runner reports after its
 * start; from there each reported state is a segment of the kind it makes, until the session's end (its dispatch finished, or the work
 * was over, else now). `paused` replaces the stretches the item was paused in (what it waited for then is not told). The time before
 * the session began and between two sessions is on no line. No segments when the runner reported nothing from the start of the session
 * (RUNNER_START_GRACE_MS before it) to its end: a session the runner did not run has no line.
 */
export function lineOf(input: LineInput): AgentLine {
  const d = input.dispatch, from = Date.parse(d.started), totals = zeroTotals();
  const finished = d.finish ? Date.parse(d.finish.ended) : undefined;
  const over = finished === undefined && input.over && input.over.at <= input.now ? input.over : undefined;
  const to = Math.max(from, finished ?? over?.at ?? input.now);
  const ended = finished !== undefined ? { at: finished, result: d.finish!.result } : over ? { at: Math.max(from, over.at), result: over.text } : undefined;
  const line: AgentLine = { agentId: d.agentId, agent: d.agent, role: d.role, level: d.level, from, to, segments: [], totals, ...(ended ? { ended } : {}) };
  const at = (start: StateStart) => Date.parse(start.at);
  const starts = [...input.starts ?? []].sort((a, b) => at(a) - at(b));
  if (!(to > from) || !starts.some(start => at(start) >= from - RUNNER_START_GRACE_MS && at(start) <= to)) return line;
  const inside = starts.filter(start => at(start) > from && at(start) <= to);
  let segments: Segment[] = [{ kind: "work", from, to: inside[0] ? at(inside[0]) : to }];
  inside.forEach((start, i) => {
    segments.push({
      kind: kindOf(start), from: at(start), to: i + 1 < inside.length ? at(inside[i + 1]!) : to,
      ...(start.cards === undefined ? {} : { cards: start.cards }), ...(start.items === undefined ? {} : { items: start.items }),
      ...(start.what === undefined ? {} : { what: start.what }), ...(start.until === undefined ? {} : { until: start.until }),
    });
  });
  segments = segments.filter(seg => seg.to > seg.from);
  // A pause covers whatever the state was: the pieces inside it become one stretch of `paused`.
  const paused = joined((input.pauses ?? []).map(p => [Date.parse(p.start), p.end === undefined ? Infinity : Date.parse(p.end)] as const));
  line.segments = coalesced(overlay(segments, paused, piece => ({ kind: "paused", from: piece.from, to: piece.to })));
  for (const seg of line.segments) totals[seg.kind] += seg.to - seg.from;
  return line;
}

/** When the work was over: the time its last plan row was done or dropped, or an item cancelled when it was last written. */
export function endOf(it: Item, r: Pick<Rules, "statusOf">, id: string): { kind: "done" | "cancelled"; at: number } | undefined {
  if (it.status === "cancelled") return { kind: "cancelled", at: Date.parse(it.updated) };
  if (r.statusOf(id) !== "done") return undefined;
  const dates = it.plan.flatMap(row => "state" in row ? [row.doneAt, row.droppedAt].flatMap(at => at === undefined ? [] : [Date.parse(at)]) : []);
  return { kind: "done", at: dates.length ? Math.max(...dates) : Date.parse(it.updated) };
}

type Board = Pick<Snapshot, "items"> & { activity?: Snapshot["activity"] };
/** The line of a dispatch of an item on the board, from the item's state starts, pause spans and end. */
export function lineOfDispatch(s: Board, r: Pick<Rules, "statusOf">, id: string, dispatch: Dispatch, now: number): AgentLine {
  const it = s.items[id]!, end = endOf(it, r, id);
  return lineOf({ starts: s.activity?.states?.[id], dispatch, pauses: s.activity?.pauses?.[id], over: end && { at: end.at, text: end.kind === "done" ? "活做完了" : "活取消了" }, now });
}
/** The lines of the agents an item went through, oldest first; a session with no line (the runner reported nothing in it) is left out. */
export function linesOfItem(s: Board, r: Pick<Rules, "statusOf">, id: string, now: number): AgentLine[] {
  const it = s.items[id];
  return (it?.dispatches ?? []).slice().sort((a, b) => Date.parse(a.started) - Date.parse(b.started)).map(d => lineOfDispatch(s, r, id, d, now)).filter(line => line.segments.length);
}
/** The line of one agent: the dispatch of `item` with this session id, or undefined when the item has no such dispatch. */
export function lineOfAgent(s: Board, r: Pick<Rules, "statusOf">, id: string, agentId: string, now: number): AgentLine | undefined {
  const d = s.items[id]?.dispatches?.find(x => x.agentId === agentId);
  return d && lineOfDispatch(s, r, id, d, now);
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

/** The most segments of one line the tool lists, and the most agents of one item; a longer line lists the newest and counts the rest. */
export const TIMELINE_ROWS = 30, TIMELINE_AGENTS = 12;
/** The default and the most rows of the longest-wait list. */
export const LONGEST_DEFAULT = 10, LONGEST_MAX = 40;
/** How far back the agents that have ended are listed, and how many of them. */
export const RECENT_MS = 24 * 3600_000, RECENT_MAX = 10;

/** One wait: a segment of a waiting kind, and whether it goes on now. */
export interface LongWait { item: string; agent: string; kind: SegmentKind; from: number; to: number; ongoing: boolean; waits: string }

/** The longest waits over the given lines, longest first: every segment in a waiting kind (or stopped for a person). A wait that goes on counts up to the end of its line. */
export function longestWaits(lines: ReadonlyArray<{ item: string; line: AgentLine }>, limit: number): LongWait[] {
  const out: LongWait[] = [];
  for (const { item, line } of lines) {
    for (const seg of line.segments) {
      if (STALLED_KINDS.has(seg.kind)) out.push({ item, agent: line.agent, kind: seg.kind, from: seg.from, to: seg.to, ongoing: seg.to === line.to && !line.ended, waits: waitsFor(seg) });
    }
  }
  return out.sort((a, b) => (b.to - b.from) - (a.to - a.from) || (a.item < b.item ? -1 : a.item > b.item ? 1 : a.from - b.from)).slice(0, limit);
}

const cut = (text: string, max: number): string => { const chars = [...text.replace(/\s+/g, " ").trim()]; return chars.length <= max ? chars.join("") : `${chars.slice(0, max).join("")}…`; };
const whoText = (line: AgentLine): string => `${line.agent}（${line.role}，难度 ${line.level}）`;
/** The totals of a line by kind, as the tool and the page hover say them. */
export function totalsText(line: AgentLine): string {
  return SEGMENT_KINDS.filter(k => line.totals[k] > 0).map(k => `${SEGMENT_TEXT[k]} ${spanText(line.totals[k])}`).join(" · ");
}
function lineBlock(line: AgentLine): string[] {
  const head = `${whoText(line)} · 共 ${spanText(line.to - line.from)}（${clockText(line.from)} 起，${line.ended ? `结束于 ${clockText(line.ended.at)}，${line.ended.result}` : "还在跑"}）`;
  const rows = line.segments.slice(-TIMELINE_ROWS).map(seg => {
    const waits = waitsFor(seg);
    return `  ${clockText(seg.from)} · ${SEGMENT_TEXT[seg.kind]} · ${spanText(seg.to - seg.from)}${waits ? ` · ${waits}` : ""}${seg.to === line.to && !line.ended ? " · 还在这里" : ""}`;
  });
  const more = line.segments.length > TIMELINE_ROWS ? [`  … 前面还有 ${line.segments.length - TIMELINE_ROWS} 段没列出`] : [];
  return [head, `合计：${totalsText(line)}`, ...more, ...rows];
}

/** The lines of the agents an item went through as the tool's text, newest TIMELINE_AGENTS of them, each with its newest TIMELINE_ROWS segments. */
export function timelineText(id: string, title: string, lines: readonly AgentLine[]): string {
  if (!lines.length) return `${id} · ${cut(title, 24)} · 执行程序没有在这件活的会话里报过状态，没有代理的线。`;
  const shown = lines.slice(-TIMELINE_AGENTS), before = lines.length - shown.length;
  return [`${id} · ${cut(title, 24)} · 经过 ${lines.length} 个代理${before ? `（前 ${before} 个没列出）` : ""}`, ...shown.flatMap(line => lineBlock(line))].join("\n");
}

/** One agent of the board-wide answer: the item it works on (or worked on), its line and the item's title. */
export interface ListedLine { item: string; title: string; line: AgentLine }

/**
 * The tool's answer without an item: the agents running, the agents that ended in the last RECENT_MS (the newest RECENT_MAX), and the longest
 * waits among the running ones. A running agent is a session with no end on an item still open.
 */
export function agentsText(running: readonly ListedLine[], recent: readonly ListedLine[], waits: readonly LongWait[], titles: (id: string) => string, now: number): string {
  const row = ({ item, title, line }: ListedLine) => {
    const last = line.segments.at(-1)!, waiting = waitsFor(last);
    return `  ${item} · ${cut(title, 24)} · ${whoText(line)} · ${line.ended ? `结束于 ${clockText(line.ended.at)}，${line.ended.result}` : `现在${SEGMENT_TEXT[last.kind]} ${spanText(line.to - last.from)}`} · 共 ${spanText(line.to - line.from)}（${totalsText(line)}）${waiting && !line.ended ? ` · ${waiting}` : ""}`;
  };
  const longest = waits.length
    ? waits.map(w => `  ${w.item} · ${cut(titles(w.item), 24)} · ${w.agent} · ${SEGMENT_TEXT[w.kind]} · ${spanText(w.to - w.from)} · ${clockText(w.from)} 起${w.ongoing ? "，还在等" : `，到 ${clockText(w.to)}`}${w.waits ? ` · ${w.waits}` : ""}`)
    : ["  没有"];
  return [
    `在跑的代理 ${running.length} 个（${clockText(now)} 的数）`, ...running.map(row),
    `最近 ${RECENT_MS / 3600_000} 小时里收尾的代理 ${recent.length} 个（最多列 ${RECENT_MAX} 个）`, ...recent.map(row),
    `在跑的代理里最长的 ${waits.length} 个等待段`, ...longest,
  ].join("\n");
}
