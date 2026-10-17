// The items an engineer could be started on, and how many engineers may work: read from the whole board, so the PM does
// not collect them or count sessions itself. The board lists candidates in a default order and does not choose among them:
// the architect does. docs/design.md, section 6, "The candidates read", gives the reasons for each rule.

import { openDispatches, holderOf } from "./dispatch.ts";
import type { Difficulty, Dispatch, Priority, Snapshot } from "./model.ts";
import { isReviewStep } from "./rules.ts";
import type { Rules } from "./rules.ts";

/** The two pools of engineers working at the same time, and the most each holds (set by the owner). */
export const POOLS = [
  { pool: "1", limit: 10, text: "1 级", covers: (level: number) => level === 1 },
  { pool: "2+", limit: 6, text: "2 级以上", covers: (level: number) => level >= 2 },
] as const;
export type Pool = (typeof POOLS)[number]["pool"];
/** More candidates than this under one parent are listed as the parent and a count. */
export const GROUP_OVER = 3;
/** The most rows listed for a pool while a slot is free, and under one parent: the rest are counted, and `under` lists a parent's. */
export const ROWS_LISTED = 10;
export const UNDER_LISTED = 10;

export interface Candidate { id: string; num?: number; project: string; title: string; difficulty: Difficulty; priority: Priority | ""; waiters: number }
/** Several candidates under one parent: the parent and how many (of every level), in place of the items. */
export interface CandidateGroup { parent: string; num?: number; project: string; title: string; count: number }
export interface PoolView {
  pool: Pool;
  limit: number;
  /** Engineers holding an item and not waiting. */
  working: number;
  /** `limit - working`, never below 0. */
  free: number;
  /** The first rows in the default order, at most ROWS_LISTED, while a slot is free; none when no slot is free. */
  listed: Array<Candidate | CandidateGroup>;
  /** Candidates of the pool that `listed` does not cover. */
  more: number;
}
export interface Candidates { pools: PoolView[] }

const poolOf = (level: number): Pool => POOLS.find(p => p.covers(level))!.pool;

/** The candidates in the default order: the startable items nobody holds. `startable` is the one definition of what can start; an
 * item with an open engineer dispatch is held even when its session is gone (the PM takes it over; it is not started again). */
function candidateIds(s: Snapshot, r: Rules): string[] {
  return Object.keys(s.items).filter(id => r.startable(id) && holderOf(s, id) === undefined).sort(r.compareCandidates);
}

function row(s: Snapshot, r: Rules, id: string): Candidate {
  const it = s.items[id]!, waiters = r.openDependents(id);
  return { id, ...(it.num === undefined ? {} : { num: it.num }), project: r.projectOf(id), title: it.title, difficulty: it.difficulty!, priority: r.priorityOf(id), waiters };
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
 * item is blocked (it waits on another item, a card or the owner), paused or finished; every step it has in progress writes
 * `waits` (what the rules say is for a wait outside the board: CI, a 14900K run) or is the review step; or it has no
 * step in progress and a sub-item on its way is being worked by another session. A fresh engineer, which has marked
 * no step yet, is working.
 */
function waiting(s: Snapshot, r: Rules, id: string, agent: string): boolean {
  const status = r.statusOf(id);
  if (status !== "wip" && status !== "todo" && status !== "idle") return true;
  const rows = r.planRows(id);
  const doing = rows.flatMap(entry => "text" in entry.row && entry.row.state === "doing" ? [entry.row] : []);
  if (doing.length) return doing.every(step => step.waits !== undefined || isReviewStep(step));
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
 * The pools' slots and the candidates. Candidates from every project are put in one default order (`compareCandidates`);
 * more than GROUP_OVER of them under one parent, of any level, are listed as that parent and the count, at the place of the
 * best of them in each pool they fall in. The order is for reading; which candidate to start is decided by the architect, not by the board.
 */
export function candidates(s: Snapshot, r: Rules): Candidates {
  const working = workingBy(s, r), all = candidateIds(s, r);
  // A parent with more than GROUP_OVER candidates, of any level, is grouped; the slots and the counts of a pool do not read the groups.
  const perParent = new Map<string, number>();
  for (const id of all) { const p = r.parentOf(id); if (p !== undefined) perParent.set(p, (perParent.get(p) ?? 0) + 1); }
  const grouping = (p: string | undefined): p is string => p !== undefined && perParent.get(p)! > GROUP_OVER;
  return { pools: POOLS.map(({ pool, limit, covers }) => {
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
    const free = Math.max(0, limit - working.get(pool)!), shown = free ? rows.slice(0, ROWS_LISTED) : [];
    return { pool, limit, working: working.get(pool)!, free, listed: shown.map(x => x.row), more: mine.length - shown.reduce((n, x) => n + x.items, 0) };
  }) };
}

/** The candidates directly under one parent, in the default order, one row each, at most UNDER_LISTED; `more` counts the rest. */
export function candidatesUnder(s: Snapshot, r: Rules, parent: string): { parent: string; title: string; rows: Candidate[]; more: number } {
  if (!s.items[parent]) throw new Error(`under ${parent}: choose an existing item`);
  const mine = candidateIds(s, r).filter(id => r.parentOf(id) === parent);
  return { parent, title: s.items[parent]!.title, rows: mine.slice(0, UNDER_LISTED).map(id => row(s, r, id)), more: Math.max(0, mine.length - UNDER_LISTED) };
}

const isGroup = (x: Candidate | CandidateGroup): x is CandidateGroup => "parent" in x;
const numText = (x: { num?: number }) => x.num === undefined ? "" : ` · #${x.num}`;
function itemLine(x: Candidate): string {
  return `${x.id} · ${x.priority || "无优先级"} · ${x.title} · 难度 ${x.difficulty} · ${x.project}${numText(x)}${x.waiters ? ` · 等它 ${x.waiters}` : ""}`;
}

/** The text a tool answers with: a line per pool, then its rows. */
export function candidatesText(view: Candidates): string {
  return view.pools.map(p => {
    const head = `${POOLS.find(x => x.pool === p.pool)!.text}：上限 ${p.limit}，在干活 ${p.working}，空 ${p.free}${p.more || p.listed.length ? "" : "；没有能开工的"}`;
    const rows = p.listed.map(x => isGroup(x) ? `  ${x.parent} · ${x.title} · ${x.project}${numText(x)} · 下面有 ${x.count} 条能开工，candidates under=${x.parent} 看逐条` : `  ${itemLine(x)}`);
    return [head, ...rows, ...(p.more ? [`  还有 ${p.more} 条能开工没列出`] : [])].join("\n");
  }).join("\n");
}
export function candidatesUnderText(view: ReturnType<typeof candidatesUnder>): string {
  return [`${view.parent} · ${view.title} 下面能开工的${view.rows.length || view.more ? "" : "：没有"}`, ...view.rows.map(x => `  ${itemLine(x)}`), ...(view.more ? [`  还有 ${view.more} 条没列出`] : [])].join("\n");
}
