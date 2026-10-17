// The agent list at the top of the page: which sessions wrote to the board lately, the items each touched last, and
// what that suggests about it. Everything here is read from the board's own data (the activity index and the items),
// never from the machine the board runs on. docs/design.md, section "Agent list", gives the reasons for each rule.

import { openDispatches } from "./dispatch.ts";
import { AGENT_TOUCHES, ARCHITECT_SESSION } from "./model.ts";
import type { AgentTouch, Dispatch, Item, Snapshot } from "./model.ts";

/** How long after its last activity a session stays in the list. */
export const AGENT_WINDOW_MS = 6 * 3600_000;
/** A session with a step in progress and no `waits` that has written nothing for this long is shown as maybe stopped. */
export const AGENT_STALE_MS = 30 * 60_000;
/** A session waiting for longer than this is marked amber: Claude Code stops an idle session about an hour in. */
export const AGENT_WAIT_LONG_MS = 60 * 60_000;
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
  /** The level and role of the newest dispatch record naming it; else the difficulty of the newest item it touched that has a step in progress. */
  level?: number;
  role?: Dispatch["role"];
  state: AgentState;
  /** The `waits` text of the step it waits on, when `state` is `waiting`. */
  waits?: string;
  /** Waiting for longer than AGENT_WAIT_LONG_MS. */
  amber: boolean;
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

/** The steps in progress on an item: its own steps, which are what a session works on. */
const doingSteps = (it: Item | undefined) => (it?.plan ?? []).flatMap(row => "state" in row && row.state === "doing" ? [row] : []);

/**
 * The rows of the list at `now`, newest activity first. A session is listed when it wrote to the board or was
 * started by a dispatch record within AGENT_WINDOW_MS, except the architect's own, and except one whose newest
 * dispatch record has ended with no write since (the name is reused by the next session on the item).
 */
export function agentRows(s: Pick<Snapshot, "items"> & { activity?: Snapshot["activity"] }, now: number): AgentRow[] {
  const started = new Map<string, Started[]>();
  for (const [item, it] of Object.entries(s.items)) for (const dispatch of it.dispatches ?? []) {
    const list = started.get(dispatch.agent);
    if (list) list.push({ item, dispatch }); else started.set(dispatch.agent, [{ item, dispatch }]);
  }
  const names = new Set([...Object.keys(s.activity?.agents ?? {}), ...started.keys()]);
  const rows: AgentRow[] = [];
  for (const name of names) {
    if (name === ARCHITECT_SESSION) continue;
    const wrote = s.activity?.agents?.[name] ?? [];
    const dispatches = started.get(name) ?? [];
    const newest = dispatches.reduce<Started | undefined>((a, b) => !a || Date.parse(b.dispatch.started) > Date.parse(a.dispatch.started) ? b : a, undefined);
    const lastWrite = wrote[0] ? Date.parse(wrote[0].at) : -Infinity;
    const lastStart = newest ? Date.parse(newest.dispatch.started) : -Infinity;
    const finish = newest?.dispatch.finish;
    if (finish && !(lastWrite > Date.parse(finish.ended) + FINISH_GRACE_MS)) continue;
    const last = Math.max(lastWrite, lastStart);
    if (!(now - last <= AGENT_WINDOW_MS)) continue;
    // The items it touched: what it wrote to, and what a dispatch record started it on; the later time of an item wins.
    const byItem = new Map<string, string>();
    const see = (item: string, at: string) => { const known = byItem.get(item); if (known === undefined || Date.parse(at) > Date.parse(known)) byItem.set(item, at); };
    for (const t of wrote) see(t.item, t.at);
    for (const d of dispatches) see(d.item, d.dispatch.started);
    const touched = [...byItem].map(([item, at]) => ({ item, at })).sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.item < b.item ? -1 : a.item > b.item ? 1 : 0)).slice(0, AGENT_TOUCHES);
    // A reviewer holds no step: the steps on the item it reviews are the engineer's, so it gets no state word.
    const steps = newest?.dispatch.role === "审查" ? [] : touched.flatMap(t => doingSteps(s.items[t.item]).map(step => ({ step, item: t.item })));
    const waiting = steps.find(x => x.step.waits !== undefined);
    const row: AgentRow = { name, lastAt: new Date(last).toISOString(), lastKind: lastStart > lastWrite ? "started" : "wrote", state: "none", amber: false, touched };
    if (waiting) { row.state = "waiting"; row.waits = waiting.step.waits!; row.amber = now - last > AGENT_WAIT_LONG_MS; }
    else if (steps.length) row.state = now - last > AGENT_STALE_MS ? "maybe-stopped" : "working";
    if (newest) { row.level = newest.dispatch.level; row.role = newest.dispatch.role; }
    else {
      const rated = steps.map(x => s.items[x.item]?.difficulty).find((d): d is number => typeof d === "number");
      if (rated !== undefined) row.level = rated;
    }
    rows.push(row);
  }
  return rows.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
