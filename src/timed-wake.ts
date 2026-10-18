import { ARCHITECT, isArchitectSession } from "./model.ts";
import type { Snapshot } from "./model.ts";
import type { Rules } from "./rules.ts";
import { isPriorityClearing } from "./migrate-priority.ts";
import { itemOfFile, writersByItem } from "./query.ts";
import type { Store } from "./store.ts";
import type { TimedMark } from "./wake.ts";

/** At most this many changed items are listed; the rest are counted, never silently left out. */
export const TIMED_LIST_LIMIT = 20;

export interface ChangedItem { item: string; project: string; title: string; status: string; by: string[] }
function capped<T>(rows: T[]): Array<T | { more: number }> {
  return rows.length > TIMED_LIST_LIMIT ? [...rows.slice(0, TIMED_LIST_LIMIT), { more: rows.length - TIMED_LIST_LIMIT }] : rows;
}

/** The items changed since the last timed wake, newest first, capped, and the time the count started from. A commit that `own`
 * says is the reader's own is left out, so an item only the reader wrote is not listed; so is the commit that cleared the retired
 * priority, which is bookkeeping. */
async function changedSince(store: Store, s: Snapshot, r: Rules, since: TimedMark | undefined, started: string, own: (session: string | undefined) => boolean): Promise<{ from: string; changed: Array<ChangedItem | { more: number }> }> {
  const from = since?.at ?? started;
  const commits = await store.log({ since: since?.head ?? from, at: s.head }).catch(() => store.log({ since: from, at: s.head }));
  // The log is newest first, so items come out most recently changed first.
  const writers = writersByItem(commits, file => { const id = itemOfFile(s, file); return id !== undefined && Object.hasOwn(s.items, id) ? id : undefined; }, commit => own(commit.session) || isPriorityClearing(commit.message));
  const status = (id: string) => r.statusOf(id) ?? "record";
  return { from, changed: capped([...writers].map(([item, by]): ChangedItem => ({ item, project: r.projectOf(item), title: s.items[item]!.title, status: status(item), by: [...by] }))) };
}
/** How many open items outside the Architect project are being worked on. */
const workingOn = (r: Rules, open: string[]) => open.filter(id => r.projectOf(id) !== ARCHITECT && r.statusOf(id) === "wip" && r.workedOn(id)).length;

export interface ArchitectTimedFields {
  since: string;
  /** The items changed since the last timed wake to the architect, newest first; at most 20, then `{more: n}`. */
  changed: Array<ChangedItem | { more: number }>;
  /** How many open items outside the Architect project are being worked on. */
  working: number;
}

/** What the architect's timed wake carries: the items changed since the last one (not those only the architect itself wrote,
 * which it already knows) and how many items are being worked on. Nothing that repeats from one wake
 * to the next. `since` is the last timed wake's mark on the architect's stream; without one, the daemon's start. */
export async function architectTimedWake(store: Store, s: Snapshot, r: Rules, since: TimedMark | undefined, started: string): Promise<ArchitectTimedFields> {
  const { from, changed } = await changedSince(store, s, r, since, started, isArchitectSession);
  return { since: from, changed, working: workingOn(r, Object.keys(s.items).filter(id => r.isOpenWork(id))) };
}
