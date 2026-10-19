// The agent list at the top of the page: which of the sessions the board dispatched wrote to it lately, the items each
// touched last, and what that suggests about it. Everything here is read from the board's own data (the activity index and
// the items), never from the machine the board runs on. docs/design.md, section "Agent list", gives the reasons for each rule.

import { openDispatches, worksOnItem } from "./dispatch.ts";
import { AGENT_TOUCHES, isArchitectSession } from "./model.ts";
import type { AgentTouch, Dispatch, Item, Snapshot } from "./model.ts";

/** How long after its last activity a session stays in the list. */
export const AGENT_WINDOW_MS = 6 * 3600_000;
/** A session with a step in progress and no `waits` that has written nothing for this long is shown as maybe stopped. */
export const AGENT_STALE_MS = 30 * 60_000;
/** A session waiting for longer than this is marked amber: Claude Code stops an idle session about an hour in. */
export const AGENT_WAIT_LONG_MS = 60 * 60_000;
/** How far apart a dispatch and the runner's report on its item may start and still be the same job: the runner records the dispatch and reports in the same breath. */
export const RUNNER_START_GRACE_MS = 5 * 60_000;
/** A write counts as made after a dispatch ended only when it is later than this past the recorded end, which may be to the minute. */
const FINISH_GRACE_MS = 60_000;

/**
 * The index entry after a write by one session: the items the write touched come first (by id, so the result does not
 * depend on the order the store met them in), then the entries it already had, without repeats, at most AGENT_TOUCHES.
 * The one place the index is advanced, for the history rebuild and for live writes alike.
 */
export function touchAgent(list: readonly AgentTouch[] | undefined, touched: Iterable<string>, at: string): AgentTouch[] {
  const fresh = [...new Set(touched)].sort();
  const next: AgentTouch[] = fresh.map(item => ({ item, at }));
  for (const old of list ?? []) if (!fresh.includes(old.item)) next.push(old);
  return next.slice(0, AGENT_TOUCHES);
}

/** What the row says about the session. `none`: no step in progress on its items, so no state word (a reviewer, say). */
export type AgentState = "waiting" | "working" | "maybe-stopped" | "none";
export interface AgentRow {
  name: string;
  /** The last thing it did: a write to the board, or (when later) the start of a dispatch record naming it. */
  lastAt: string;
  /** What `lastAt` is: it wrote, or it was started and has written nothing since. */
  lastKind: "wrote" | "started";
  /** The level and role of the newest dispatch record naming it. */
  level: number;
  role: Dispatch["role"];
  state: AgentState;
  /** The `waits` text of the step it waits on, when `state` is `waiting`. */
  waits?: string;
  /** Waiting for longer than AGENT_WAIT_LONG_MS. */
  amber: boolean;
  /** Running now, which is what the page unfolds: the session has an unfinished dispatch and is alive (`liveDispatches`,
   * an engineer or a review), whatever the state word says. The steps on the items it touched do not decide: they may be another
   * session's. A session whose dispatches have all ended is not running. The rest are folded into one line. */
  running: boolean;
  /** At most AGENT_TOUCHES items, newest first. */
  touched: AgentTouch[];
}

interface Started { item: string; dispatch: Dispatch }

/**
 * The unfinished dispatches on an item whose session is still active at `now`: it wrote to the board, or was started,
 * within AGENT_WINDOW_MS, the agent list's window. A dispatch left open by a session that died is not counted for
 * longer. Item status reads this: a live session counts as working on the item whether or not it marked a row (docs/design.md, Status).
 */
export function liveDispatches(s: Pick<Snapshot, "items"> & { activity?: Snapshot["activity"] }, item: string, now: number): Dispatch[] {
  return openDispatches(s, item).filter(d => {
    const wrote = s.activity?.agents?.[d.agent]?.[0]?.at;
    return now - Math.max(Date.parse(d.started), wrote ? Date.parse(wrote) : -Infinity) <= AGENT_WINDOW_MS;
  });
}

/**
 * Whether the runner holds the work of a dispatch: it is an engineer's, not ended, and the item carries a runner report that began
 * with it. A report left from an earlier job does not make a session started later (one started by hand, say) the runner's. The runner's block of
 * the list draws these sessions (src/runner-rows.ts), so the rows read from the board's own writes leave them out.
 */
export function runnerHolds(it: Pick<Item, "runner"> | undefined, d: Dispatch): boolean {
  const report = it?.runner;
  return !!report && d.role === "工程师" && d.finish === undefined && Math.abs(Date.parse(d.started) - Date.parse(report.started)) <= RUNNER_START_GRACE_MS;
}

/** An item with its key: the page already holds the board's items so (`ViewItem` in web/app.ts). */
export type ListedItem = Pick<Item, "dispatches"> & { id: string };

/** The steps in progress on an item: its own steps, which are what a session works on. */
const doingSteps = (it: Item | undefined) => (it?.plan ?? []).flatMap(row => "state" in row && row.state === "doing" ? [row] : []);

/**
 * The rows of the list at `now`, newest activity first. A session is listed when a dispatch record names it and it wrote to the
 * board or was started by that record within AGENT_WINDOW_MS, except the architect's, and except one whose newest
 * dispatch record has ended with no write since (the name is reused by the next session on the item), and except one the runner holds.
 * A session no dispatch record names is no programmer the board sent out (the runner, the board itself, a hand-started session, a name
 * written by mistake) and is not listed; the architect's turns have records (they draw the architect's line, src/timeline.ts) but are the
 * runner's, drawn from its reports, so a record of that role names no row. The items come as a list with their keys, as the page holds them, not as the
 * snapshot's keyed object: the page redraws the list on every write, and listing the keys of a board this size again costs more than the
 * pass over the items.
 */
export function agentRows(s: Pick<Snapshot, "items"> & { activity?: Snapshot["activity"] }, now: number, items: Iterable<ListedItem>): AgentRow[] {
  const started = new Map<string, Started[]>();
  // The sessions with an unfinished dispatch that is alive, read from the same live dispatches item status reads.
  const alive = new Set<string>();
  for (const it of items) {
    const item = it.id;
    for (const dispatch of it.dispatches ?? []) {
      if (!worksOnItem(dispatch)) continue;
      const list = started.get(dispatch.agent);
      if (list) list.push({ item, dispatch }); else started.set(dispatch.agent, [{ item, dispatch }]);
    }
    if (it.dispatches?.length) for (const d of liveDispatches(s, item, now)) alive.add(d.agent);
  }
  const rows: AgentRow[] = [];
  for (const [name, dispatches] of started) {
    // The architect is not a row. The programs (the runner, the board itself) have no dispatch record, so they are not either; the architect's turns it starts have one, which `agentRows` does not read: the runner's work and the architect's turns are drawn from its reports.
    if (isArchitectSession(name)) continue;
    const wrote = s.activity?.agents?.[name] ?? [];
    const newest = dispatches.reduce((a, b) => Date.parse(b.dispatch.started) > Date.parse(a.dispatch.started) ? b : a);
    const lastWrite = wrote[0] ? Date.parse(wrote[0].at) : -Infinity;
    const lastStart = Date.parse(newest.dispatch.started);
    const finish = newest.dispatch.finish;
    const review = newest.dispatch.role === "审查";
    if (finish && !(lastWrite > Date.parse(finish.ended) + FINISH_GRACE_MS)) continue;
    if (runnerHolds(s.items[newest.item], newest.dispatch)) continue;
    const last = Math.max(lastWrite, lastStart);
    if (!(now - last <= AGENT_WINDOW_MS)) continue;
    // The items it touched: what it wrote to, and what a dispatch record started it on; the later time of an item wins.
    const byItem = new Map<string, string>();
    const see = (item: string, at: string) => { const known = byItem.get(item); if (known === undefined || Date.parse(at) > Date.parse(known)) byItem.set(item, at); };
    for (const t of wrote) see(t.item, t.at);
    for (const d of dispatches) see(d.item, d.dispatch.started);
    const touched = [...byItem].map(([item, at]) => ({ item, at })).sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.item < b.item ? -1 : a.item > b.item ? 1 : 0)).slice(0, AGENT_TOUCHES);
    // A reviewer holds no step: the steps on the item it reviews are the engineer's, so it gets no state word.
    const steps = review ? [] : touched.flatMap(t => doingSteps(s.items[t.item]).map(step => ({ step, item: t.item })));
    const waiting = steps.find(x => x.step.waits !== undefined);
    const row: AgentRow = { name, lastAt: new Date(last).toISOString(), lastKind: lastStart > lastWrite ? "started" : "wrote", level: newest.dispatch.level, role: newest.dispatch.role, state: "none", amber: false, running: false, touched };
    if (waiting) { row.state = "waiting"; row.waits = waiting.step.waits!; row.amber = now - last > AGENT_WAIT_LONG_MS; }
    else if (steps.length) row.state = now - last > AGENT_STALE_MS ? "maybe-stopped" : "working";
    row.running = alive.has(name);
    rows.push(row);
  }
  return rows.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
