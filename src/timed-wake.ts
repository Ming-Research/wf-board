import { hasReviewer, holderOf } from "./dispatch.ts";
import { ARCHITECT, PM_AUTHOR, answersPushes, isArchitectSession } from "./model.ts";
import type { Snapshot } from "./model.ts";
import type { Offer } from "./offers.ts";
import { reviewRequested } from "./rules.ts";
import type { Rules } from "./rules.ts";
import { isPriorityClearing } from "./migrate-priority.ts";
import { itemOfFile, writersByItem } from "./query.ts";
import type { Store } from "./store.ts";
import type { TimedMark } from "./wake.ts";

/** At most this many changed items are listed; the rest are counted, never silently left out. */
export const TIMED_LIST_LIMIT = 20;

export interface ChangedItem { item: string; project: string; title: string; status: string; by: string[] }
export interface TimedFields {
  since: string;
  /** The items changed since the last timed wake, newest first. */
  changed: Array<ChangedItem | { more: number }>;
  /** How many open items are being worked on outside the Architect and PM projects, and how many are open in each of those two. */
  working: number;
  architect: number;
  pm: number;
  /** The items whose review step is in progress with no reviewer on them, and the done items a session still holds: what the PM was told once and may not have taken up. Item keys; at most 20, then `{more: n}`. */
  review: Array<string | { more: number }>;
  finished: Array<string | { more: number }>;
  /** The pools that have a free slot and candidates, as the PM was last told: a reminder when that push went unhandled. */
  dispatch: Offer[];
}

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
/** How many open items outside the Architect and PM projects are being worked on. */
const workingOn = (r: Rules, open: string[]) => open.filter(id => r.projectOf(id) !== ARCHITECT && r.projectOf(id) !== PM_AUTHOR && r.statusOf(id) === "wip" && r.workedOn(id)).length;

/** What one timed wake carries: the items changed since the last one (not those only the PM or the architect itself wrote,
 * which it already knows) and how many items are being worked on and open in the Architect and PM projects. The lists of those
 * items are not repeated: `list` gives them when wanted. `since` is the last timed wake's mark; without one, the daemon's start. */
export async function timedWake(store: Store, s: Snapshot, r: Rules, since: TimedMark | undefined, started: string, dispatch: Offer[] = []): Promise<TimedFields> {
  const { from, changed } = await changedSince(store, s, r, since, started, session => answersPushes({ session }));
  const open = Object.keys(s.items).filter(id => r.isOpenWork(id));
  return {
    since: from,
    changed,
    working: workingOn(r, open),
    architect: open.filter(id => r.projectOf(id) === ARCHITECT).length,
    pm: open.filter(id => r.projectOf(id) === PM_AUTHOR).length,
    review: capped(open.filter(id => reviewRequested(s.items[id]) !== undefined && !hasReviewer(s, id))),
    finished: capped(Object.keys(s.items).filter(id => r.statusOf(id) === "done" && holderOf(s, id) !== undefined)),
    dispatch,
  };
}

export interface ArchitectTimedFields {
  since: string;
  /** The items changed since the last timed wake to the architect, newest first; at most 20, then `{more: n}`. */
  changed: Array<ChangedItem | { more: number }>;
  /** How many open items outside the Architect and PM projects are being worked on. */
  working: number;
}

/** What the architect's timed wake carries: the items changed since the last one (not those only the architect itself wrote,
 * which it already knows; the PM's writes are listed) and how many items are being worked on. Nothing that repeats from one wake
 * to the next. `since` is the last timed wake's mark on the architect's stream; without one, the daemon's start. */
export async function architectTimedWake(store: Store, s: Snapshot, r: Rules, since: TimedMark | undefined, started: string): Promise<ArchitectTimedFields> {
  const { from, changed } = await changedSince(store, s, r, since, started, isArchitectSession);
  return { since: from, changed, working: workingOn(r, Object.keys(s.items).filter(id => r.isOpenWork(id))) };
}
