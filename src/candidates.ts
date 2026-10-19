// The items an engineer could be started on, and how many engineers are working in each pool: read from the whole board, so
// nobody has to collect them or count sessions itself. The board lists candidates in a default order and does not choose
// among them, and it holds no limit: the architect compares the working count with the owner's numbers and chooses. The same read
// lists, apart from the candidates, the work set aside that an engineer could be started on once its reason ended: paused work and
// work whose head writes when to start it. docs/design.md, section 6, "The candidates read", gives the reasons for each rule.

import { openDispatches, holderOf } from "./dispatch.ts";
import { whenText } from "./head-sections.ts";
import type { Difficulty, Dispatch, Item, Snapshot } from "./model.ts";
import { isReviewStep, waitsOnRun } from "./rules.ts";
import type { Rules } from "./rules.ts";
import { cut, lastChange, spanText } from "./whole-view.ts";

/** The two pools of engineers. The board holds no limit on either: the owner gives the architect the numbers, and the architect compares them with the working count. */
export const POOLS = [
  { pool: "1", text: "1 级", covers: (level: number) => level === 1 },
  { pool: "2+", text: "2 级以上", covers: (level: number) => level >= 2 },
] as const;
export type Pool = (typeof POOLS)[number]["pool"];
/** More candidates than this under one parent are listed as the parent and a count. */
export const GROUP_OVER = 3;
/** The most rows listed for a pool, and under one parent: the rest are counted, and `under` lists a parent's. */
export const ROWS_LISTED = 10;
export const UNDER_LISTED = 10;
/** The most rows listed for the work set aside in a pool: each project with some has a row before any has a second. */
export const ASIDE_ROWS = 10;
/** The most characters of a pause reason and of a 何时 sentence a row shows. */
const REASON_CHARS = 40, WHEN_CHARS = 60;

export interface Candidate { id: string; num?: number; project: string; title: string; difficulty: Difficulty; waiters: number }
/** Work held back by a pause marker, on the item itself (`carrier` is its id) or on one above it. `by` is the project that wrote the pause, when the log still holds it. */
export interface AsidePaused { kind: "paused"; id: string; num?: number; project: string; title: string; difficulty: Difficulty; carrier: string; by?: string; at: number; reason: string }
/** Work that cannot be started and whose head writes when to: `when` is the first sentence of its 何时 section, `since` the time of its last change. */
export interface AsideWaiting { kind: "condition"; id: string; num?: number; project: string; title: string; difficulty: Difficulty; parent?: string; since: number; when: string }
export type AsideItem = AsidePaused | AsideWaiting;
/** Several set-aside items under one pause marker (`paused-group`) or one parent (`condition-group`): the carrier or the parent and how many (of every level), in place of the items. */
export type AsideGroup = { kind: "paused-group"; key: string; num?: number; project: string; title: string; count: number; by?: string; at: number; reason: string }
  | { kind: "condition-group"; key: string; num?: number; project: string; title: string; count: number };
export type AsideRow = AsideItem | AsideGroup;
export interface Aside {
  /** The pool's items set aside, by reason; the rows stand for these. */
  paused: number;
  waiting: number;
  /** The same items by project, in the configured order of the projects. */
  projects: Array<{ project: string; count: number }>;
  /** At most ASIDE_ROWS rows. */
  listed: AsideRow[];
  /** Items of the pool that `listed` does not cover. */
  more: number;
}
/** Several candidates under one parent: the parent and how many (of every level), in place of the items. */
export interface CandidateGroup { parent: string; num?: number; project: string; title: string; count: number }
export interface PoolView {
  pool: Pool;
  /** Engineers holding an item and not waiting. */
  working: number;
  /** The first rows in the default order, at most ROWS_LISTED. */
  listed: Array<Candidate | CandidateGroup>;
  /** The candidates of the pool, listed or not. A group row counts a parent's candidates of every level, so the pool's own count is this and not read from the rows. */
  total: number;
  /** Candidates of the pool that `listed` does not cover. */
  more: number;
  /** The work of the pool set aside, which is not counted in `total`. */
  aside: Aside;
}
export interface Candidates { now: number; pools: PoolView[] }

const poolOf = (level: number): Pool => POOLS.find(p => p.covers(level))!.pool;

/** The candidates in the default order: the startable items nobody holds. `startable` is the one definition of what can start; an
 * item with an open engineer dispatch is held even when its session is gone (the architect takes it over; it is not started again). */
function candidateIds(s: Snapshot, r: Rules): string[] {
  return Object.keys(s.items).filter(id => r.startable(id) && holderOf(s, id) === undefined).sort(r.compareCandidates);
}

function row(s: Snapshot, r: Rules, id: string): Candidate {
  const it = s.items[id]!, waiters = r.openDependents(id);
  return { id, ...(it.num === undefined ? {} : { num: it.num }), project: r.projectOf(id), title: it.title, difficulty: it.difficulty!, waiters };
}

/** Who wrote the pause on `it`: the project of the log entry written with it, found by the time the marker carries. */
function pauseAuthor(it: Item): string | undefined {
  const entries = it.log.filter(e => e.text.startsWith("暂停："));
  return (entries.filter(e => e.at === it.paused?.at).at(-1) ?? entries.at(-1))?.by;
}

/** The first sentence of a 何时 text, cut to what a row shows. */
const firstSentence = (text: string): string => cut(/^.*?[。！？]/.exec(text)?.[0] ?? text, WHEN_CHARS);

/**
 * The work set aside, in the order a row list reads: by project in the configured order, paused work before work with a condition,
 * and within each the longest-waiting first (the oldest pause, the longest since the last change). Only an item an engineer could be
 * started on if its reason ended: open, rated, with no open sub-item (a parent is its sub-items' business) and held by nobody.
 * Paused is a pause marker on the item or above it; with a condition is an item that is todo or idle but not startable (nobody
 * needs it: it waits in a backlog) and whose head has a 何时 section. A startable item with a 何时 section is a candidate.
 */
function asideItems(s: Snapshot, r: Rules): AsideItem[] {
  const out: AsideItem[] = [];
  for (const id of Object.keys(s.items)) {
    const it = s.items[id]!;
    if (!r.isOpenWork(id) || it.difficulty === undefined || holderOf(s, id) !== undefined || r.children(id).some(child => r.isOpenWork(child))) continue;
    const base = { id, ...(it.num === undefined ? {} : { num: it.num }), project: r.projectOf(id), title: it.title, difficulty: it.difficulty };
    if (r.isPaused(id)) {
      const carrier = r.pausedBy(id) ?? id, marked = s.items[carrier], marker = marked?.paused;
      const by = marked ? pauseAuthor(marked) : undefined;
      out.push({ kind: "paused", ...base, carrier, ...(by === undefined ? {} : { by }), at: marker ? Date.parse(marker.at) : lastChange(s, carrier), reason: marker?.reason ?? "" });
    } else if (!r.startable(id) && (r.statusOf(id) === "todo" || r.statusOf(id) === "idle")) {
      const when = whenText(it.head ?? "");
      const parent = r.parentOf(id);
      if (when !== undefined) out.push({ kind: "condition", ...base, ...(parent === undefined ? {} : { parent }), since: lastChange(s, id), when: firstSentence(when) });
    }
  }
  const project = new Map(s.board.projects.map((p, i) => [p.name, i]));
  const age = (x: AsideItem) => x.kind === "paused" ? x.at : x.since;
  return out.sort((a, b) => (project.get(a.project) ?? 1e9) - (project.get(b.project) ?? 1e9) || Number(a.kind === "condition") - Number(b.kind === "condition") || age(a) - age(b) || (a.id < b.id ? -1 : 1));
}

/** What a group of set-aside items is named by: the item that carries their pause, or their parent; none for an item with no parent. */
const groupKey = (x: AsideItem): string | undefined => x.kind === "paused" ? `p:${x.carrier}` : x.parent === undefined ? undefined : `c:${x.parent}`;

/**
 * The work set aside that falls in one pool, as rows. More than GROUP_OVER items (of any level) under one pause marker, or under one
 * parent for those with a condition, are one row of the item and the count, at the place of the first of them, like the groups of
 * candidates. At most ASIDE_ROWS rows are listed, taken a project at a time so that a project with a few items is not crowded out by one
 * with hundreds.
 */
function asideOf(s: Snapshot, all: AsideItem[], covers: (level: number) => boolean): Aside {
  const perKey = new Map<string, number>();
  for (const x of all) { const k = groupKey(x); if (k !== undefined) perKey.set(k, (perKey.get(k) ?? 0) + 1); }
  const mine = all.filter(x => covers(x.difficulty));
  const units: Array<{ row: AsideRow; items: number }> = [], grouped = new Set<string>();
  for (const x of mine) {
    const key = groupKey(x);
    if (key === undefined || perKey.get(key)! <= GROUP_OVER) { units.push({ row: x, items: 1 }); continue; }
    if (grouped.has(key)) continue;
    grouped.add(key);
    const items = mine.filter(y => groupKey(y) === key).length, count = perKey.get(key)!;
    if (x.kind === "paused") {
      const carrier = s.items[x.carrier]!;
      units.push({ row: { kind: "paused-group", key: x.carrier, ...(carrier.num === undefined ? {} : { num: carrier.num }), project: x.project, title: carrier.title, count, ...(x.by === undefined ? {} : { by: x.by }), at: x.at, reason: x.reason }, items });
    } else {
      const parent = s.items[x.parent!]!;
      units.push({ row: { kind: "condition-group", key: x.parent!, ...(parent.num === undefined ? {} : { num: parent.num }), project: x.project, title: parent.title, count }, items });
    }
  }
  // The first row of every project, then the second of every project, until the rows are used up; listed in the order of `units`.
  const byProject = new Map<string, Array<{ row: AsideRow; items: number }>>();
  for (const u of units) byProject.set(u.row.project, [...byProject.get(u.row.project) ?? [], u]);
  const picked = new Set<{ row: AsideRow; items: number }>();
  for (let round = 0; picked.size < ASIDE_ROWS; round++) {
    const next = [...byProject.values()].flatMap(list => list[round] ?? []);
    if (!next.length) break;
    for (const u of next.slice(0, ASIDE_ROWS - picked.size)) picked.add(u);
  }
  const shown = units.filter(u => picked.has(u));
  const projects = new Map<string, number>();
  for (const x of mine) projects.set(x.project, (projects.get(x.project) ?? 0) + 1);
  return {
    paused: mine.filter(x => x.kind === "paused").length, waiting: mine.filter(x => x.kind === "condition").length,
    projects: [...projects].map(([project, count]) => ({ project, count })),
    listed: shown.map(u => u.row), more: mine.length - shown.reduce((n, u) => n + u.items, 0),
  };
}

/** Whether any item in the subtree of `id` is held by a session other than `agent`. */
function heldElsewhere(s: Snapshot, r: Rules, id: string, agent: string, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const holder = holderOf(s, id);
  return (holder !== undefined && holder !== agent) || r.children(id).some(child => heldElsewhere(s, r, child, agent, seen));
}

/**
 * Whether the engineer holding `id` is waiting on something the board shows, so its slot is free for another. Waiting: the
 * item is blocked (it waits on another item, a card or the owner), paused or finished; every step it has in progress is the
 * review step or waits on a 14900K run (a wait for CI leaves it working); or it has no step in progress and a sub-item on
 * its way is being worked by another session. A fresh engineer, which has marked no step yet, is working.
 */
function waiting(s: Snapshot, r: Rules, id: string, agent: string): boolean {
  const status = r.statusOf(id);
  if (status !== "wip" && status !== "todo" && status !== "idle") return true;
  const rows = r.planRows(id);
  const doing = rows.flatMap(entry => "text" in entry.row && entry.row.state === "doing" ? [entry.row] : []);
  if (doing.length) return doing.every(step => isReviewStep(step) || waitsOnRun(step));
  return rows.some(entry => entry.ready && entry.state === "progress" && "item" in entry.row && heldElsewhere(s, r, entry.row.item, agent));
}

/** Engineers with an open dispatch, one per session, by pool: those not waiting count as working. */
function workingBy(s: Snapshot, r: Rules): Map<Pool, number> {
  const engineers = new Map<string, { dispatch: Dispatch; working: boolean }>();
  for (const id of Object.keys(s.items)) {
    const dispatch = openDispatches(s, id).find(d => d.role === "工程师");
    if (!dispatch) continue;
    const known = engineers.get(dispatch.agent), working = !waiting(s, r, id, dispatch.agent);
    if (!known) engineers.set(dispatch.agent, { dispatch, working });
    else known.working ||= working;
  }
  const counts = new Map<Pool, number>(POOLS.map(p => [p.pool, 0]));
  for (const { dispatch, working } of engineers.values()) if (working) counts.set(poolOf(dispatch.level), counts.get(poolOf(dispatch.level))! + 1);
  return counts;
}

/**
 * The pools' working engineers and the candidates. Candidates from every project are put in one default order (`compareCandidates`);
 * more than GROUP_OVER of them under one parent, of any level, are listed as that parent and the count, at the place of the
 * best of them in each pool they fall in. The order is for reading; which candidate to start is decided by the architect, not by the board.
 */
export function candidates(s: Snapshot, r: Rules, now: number = Date.now()): Candidates {
  const working = workingBy(s, r), all = candidateIds(s, r), aside = asideItems(s, r);
  // A parent with more than GROUP_OVER candidates, of any level, is grouped; the counts of a pool do not read the groups.
  const perParent = new Map<string, number>();
  for (const id of all) { const p = r.parentOf(id); if (p !== undefined) perParent.set(p, (perParent.get(p) ?? 0) + 1); }
  const grouping = (p: string | undefined): p is string => p !== undefined && perParent.get(p)! > GROUP_OVER;
  return { now, pools: POOLS.map(({ pool, covers }) => {
    const mine = all.filter(id => covers(s.items[id]!.difficulty!));
    const rows: Array<{ row: Candidate | CandidateGroup; items: number }> = [], grouped = new Set<string>();
    for (const id of mine) {
      const p = r.parentOf(id);
      if (!grouping(p)) { rows.push({ row: row(s, r, id), items: 1 }); continue; }
      if (grouped.has(p)) continue;
      grouped.add(p);
      const parent = s.items[p]!;
      rows.push({ row: { parent: p, ...(parent.num === undefined ? {} : { num: parent.num }), project: r.projectOf(p), title: parent.title, count: perParent.get(p)! }, items: mine.filter(x => r.parentOf(x) === p).length });
    }
    const shown = rows.slice(0, ROWS_LISTED);
    return { pool, working: working.get(pool)!, listed: shown.map(x => x.row), total: mine.length, more: mine.length - shown.reduce((n, x) => n + x.items, 0), aside: asideOf(s, aside, covers) };
  }) };
}

/** A list of set-aside items cut to UNDER_LISTED rows, with the number left out. */
function cutRows<T>(items: T[]): { rows: T[]; more: number } { return { rows: items.slice(0, UNDER_LISTED), more: Math.max(0, items.length - UNDER_LISTED) }; }

/**
 * The candidates directly under one parent, in the default order, one row each, at most UNDER_LISTED; `more` counts the rest. And the
 * work set aside that the groups of the main answer stand for: the paused items whose pause marker is on `parent`, and the items with
 * a condition directly under it, each at most UNDER_LISTED.
 */
export function candidatesUnder(s: Snapshot, r: Rules, parent: string, now: number = Date.now()) {
  if (!s.items[parent]) throw new Error(`under ${parent}: choose an existing item`);
  const mine = candidateIds(s, r).filter(id => r.parentOf(id) === parent), aside = asideItems(s, r);
  return {
    now, parent, title: s.items[parent]!.title, rows: mine.slice(0, UNDER_LISTED).map(id => row(s, r, id)), more: Math.max(0, mine.length - UNDER_LISTED),
    paused: cutRows(aside.filter((x): x is AsidePaused => x.kind === "paused" && x.carrier === parent)),
    waiting: cutRows(aside.filter((x): x is AsideWaiting => x.kind === "condition" && x.parent === parent)),
  };
}

const isGroup = (x: Candidate | CandidateGroup): x is CandidateGroup => "parent" in x;
const numText = (x: { num?: number }) => x.num === undefined ? "" : ` · #${x.num}`;
function itemLine(x: Candidate): string {
  return `${x.id} · ${x.title} · 难度 ${x.difficulty} · ${x.project}${numText(x)}${x.waiters ? ` · 等它 ${x.waiters}` : ""}`;
}

/** The month and day of a time, in UTC: 「10-18」. */
const dateText = (at: number): string => new Date(at).toISOString().slice(5, 10);
/** Who paused, when, for how long and why. */
const pauseText = (x: { by?: string; at: number; reason: string }, now: number): string =>
  `${x.by ? `${x.by} ` : ""}${dateText(x.at)} · 停了 ${spanText(now - x.at)}${x.reason ? ` · ${cut(x.reason, REASON_CHARS)}` : ""}`;
function asideLine(x: AsideRow, now: number): string {
  switch (x.kind) {
    case "paused": return `${x.id} · ${x.title} · 难度 ${x.difficulty} · ${x.project}${numText(x)} · ${x.carrier === x.id ? "暂停" : `因 ${x.carrier} 暂停`} · ${pauseText(x, now)}`;
    case "paused-group": return `${x.key} · ${x.title} · ${x.project}${numText(x)} · 下面 ${x.count} 件暂停 · ${pauseText(x, now)} · candidates under=${x.key} 看逐条`;
    case "condition": return `${x.id} · ${x.title} · 难度 ${x.difficulty} · ${x.project}${numText(x)} · 何时：${x.when} · ${spanText(now - x.since)}没动`;
    case "condition-group": return `${x.key} · ${x.title} · ${x.project}${numText(x)} · 下面 ${x.count} 件带开工条件，candidates under=${x.key} 看逐条`;
  }
}

/** The text a tool answers with: a line per pool, then its rows, and then the work of the pool set aside, when there is any. */
export function candidatesText(view: Candidates): string {
  return view.pools.map(p => {
    const head = `${POOLS.find(x => x.pool === p.pool)!.text}：在干活 ${p.working}，候选 ${p.total}`;
    const rows = p.listed.map(x => isGroup(x) ? `  ${x.parent} · ${x.title} · ${x.project}${numText(x)} · 下面有 ${x.count} 条能开工，candidates under=${x.parent} 看逐条` : `  ${itemLine(x)}`);
    const a = p.aside;
    const aside = a.paused + a.waiting === 0 ? [] : [
      `  另有暂停 ${a.paused} 件、带开工条件 ${a.waiting} 件（${a.projects.map(x => `${x.project} ${x.count}`).join("、")}）：`,
      ...a.listed.map(x => `    ${asideLine(x, view.now)}`),
      ...(a.more ? [`    还有 ${a.more} 件没列出`] : []),
    ];
    return [head, ...rows, ...(p.more ? [`  还有 ${p.more} 条能开工没列出`] : []), ...aside].join("\n");
  }).join("\n");
}
export function candidatesUnderText(view: ReturnType<typeof candidatesUnder>): string {
  const part = (title: string, x: { rows: AsideItem[]; more: number }) => x.rows.length ? [`${title} ${x.rows.length + x.more} 件`, ...x.rows.map(y => `  ${asideLine(y, view.now)}`), ...(x.more ? [`  还有 ${x.more} 件没列出`] : [])] : [];
  return [`${view.parent} · ${view.title} 下面能开工的${view.rows.length || view.more ? "" : "：没有"}`, ...view.rows.map(x => `  ${itemLine(x)}`), ...(view.more ? [`  还有 ${view.more} 条没列出`] : []),
    ...part("暂停的", view.paused), ...part("带开工条件的", view.waiting)].join("\n");
}
