import { ARCHITECT, ARCHITECT_SESSION } from "./model.ts";
import type { Snapshot } from "./model.ts";
import type { Rules } from "./rules.ts";
import { itemOfFile, writersByItem } from "./query.ts";
import type { Store } from "./store.ts";
import type { TimedMark } from "./wake.ts";

/** At most this many entries in each list; the rest are counted, never silently left out. */
export const TIMED_LIST_LIMIT = 60;

export interface ChangedItem { item: string; project: string; title: string; status: string; by: string[] }
export interface WorkingItem { item: string; project: string; title: string; status: string; flags: string[] }
export interface TimedFields {
  since: string;
  changed: Array<ChangedItem | { more: number }>;
  working: Array<WorkingItem | { more: number }>;
  architect: Array<WorkingItem | { more: number }>;
  /** The Actions usage line (src/usage-watch.ts); empty where no usage watch runs. */
  actions: string;
}

function capped<T>(rows: T[]): Array<T | { more: number }> {
  return rows.length > TIMED_LIST_LIMIT ? [...rows.slice(0, TIMED_LIST_LIMIT), { more: rows.length - TIMED_LIST_LIMIT }] : rows;
}

/** What one timed wake carries: the items changed since the last one (not those only the architect itself wrote, which it
 * already knows), the items being worked on, and every open item of the Architect project, each with its status, and the Actions
 * usage line. `since` is the last timed wake's mark; without one, the daemon's start. */
export async function timedWake(store: Store, s: Snapshot, r: Rules, since: TimedMark | undefined, started: string, actions = ""): Promise<TimedFields> {
  const from = since?.at ?? started;
  const commits = await store.log({ since: since?.head ?? from, at: s.head }).catch(() => store.log({ since: from, at: s.head }));
  // The log is newest first, so items come out most recently changed first.
  const writers = writersByItem(commits, file => { const id = itemOfFile(s, file); return id !== undefined && Object.hasOwn(s.items, id) ? id : undefined; }, commit => commit.session === ARCHITECT_SESSION);
  const status = (id: string) => r.statusOf(id) ?? "record";
  const flags = (id: string) => r.checks(id).map(c => c.label ?? "需核对");
  const changed = [...writers].map(([item, by]): ChangedItem => ({ item, project: r.projectOf(item), title: s.items[item]!.title, status: status(item), by: [...by] }));
  const open = Object.keys(s.items).filter(id => r.isOpenWork(id));
  const entry = (item: string): WorkingItem => ({ item, project: r.projectOf(item), title: s.items[item]!.title, status: status(item), flags: flags(item) });
  return {
    since: from,
    changed: capped(changed),
    working: capped(open.filter(id => r.projectOf(id) !== ARCHITECT && r.statusOf(id) === "wip" && r.held(id)).map(entry)),
    architect: capped(open.filter(id => r.projectOf(id) === ARCHITECT).map(entry)),
    actions,
  };
}
