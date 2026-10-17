import { hasReviewer, holderOf } from "./dispatch.ts";
import { ARCHITECT, PM_AUTHOR, answersPushes } from "./model.ts";
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
  /** What the Actions usage watch says when it needs handling (the billing cannot be read, or has a sku the account does not know); empty otherwise (src/usage-watch.ts). */
  actions: string;
}

function capped<T>(rows: T[]): Array<T | { more: number }> {
  return rows.length > TIMED_LIST_LIMIT ? [...rows.slice(0, TIMED_LIST_LIMIT), { more: rows.length - TIMED_LIST_LIMIT }] : rows;
}

/** What one timed wake carries: the items changed since the last one (not those only the PM or the architect itself wrote,
 * which it already knows) and how many items are being worked on and open in the Architect and PM projects. The lists of those
 * items are not repeated: `list` gives them when wanted. `since` is the last timed wake's mark; without one, the daemon's start. */
export async function timedWake(store: Store, s: Snapshot, r: Rules, since: TimedMark | undefined, started: string, dispatch: Offer[] = [], actions = ""): Promise<TimedFields> {
  const from = since?.at ?? started;
  const commits = await store.log({ since: since?.head ?? from, at: s.head }).catch(() => store.log({ since: from, at: s.head }));
  // The log is newest first, so items come out most recently changed first.
  const writers = writersByItem(commits, file => { const id = itemOfFile(s, file); return id !== undefined && Object.hasOwn(s.items, id) ? id : undefined; }, commit => answersPushes({ session: commit.session }) || isPriorityClearing(commit.message));
  const status = (id: string) => r.statusOf(id) ?? "record";
  const changed = [...writers].map(([item, by]): ChangedItem => ({ item, project: r.projectOf(item), title: s.items[item]!.title, status: status(item), by: [...by] }));
  const open = Object.keys(s.items).filter(id => r.isOpenWork(id));
  return {
    since: from,
    changed: capped(changed),
    working: open.filter(id => r.projectOf(id) !== ARCHITECT && r.projectOf(id) !== PM_AUTHOR && r.statusOf(id) === "wip" && r.workedOn(id)).length,
    architect: open.filter(id => r.projectOf(id) === ARCHITECT).length,
    pm: open.filter(id => r.projectOf(id) === PM_AUTHOR).length,
    review: capped(open.filter(id => reviewRequested(s.items[id]) !== undefined && !hasReviewer(s, id))),
    finished: capped(Object.keys(s.items).filter(id => r.statusOf(id) === "done" && holderOf(s, id) !== undefined)),
    dispatch,
    actions,
  };
}
