// What the runner says about a turn it is running now: the turn's number, how long it has run, how long since its last action and what
// that action was. It lives in the daemon's memory only: no commit, no data file, gone when the daemon stops and filled again by the
// runner's next beat. The agent list reads it beside the runner's report on the item (src/runner-rows.ts). docs/design.md, section 8,
// "The live view of a turn", gives the reasons for each rule.

/** Whose turn it is: an engineer's, or the architect's turn the runner starts to answer an engineer's question. */
export const LIVE_ROLES = ["工程师", "架构师"] as const;
export type LiveRole = (typeof LIVE_ROLES)[number];
/** The most characters of the one-line action a beat carries. */
export const LIVE_ACTION_MAX = 80;
/** The runner beats about every 30 seconds; a turn whose last beat is older than this has missed three and is shown as silent. */
export const LIVE_FRESH_MS = 90_000;
/** A beat older than this is dropped when the next one is stored, so the memory holds only what a day of work leaves. */
const LIVE_KEEP_MS = 24 * 3600_000;

/**
 * The latest beat for one turn. The times are the board's: the runner sends durations and the board counts back from the moment
 * the beat arrives, so the runner's clock decides nothing. `item` is the engineer's item, also for the architect's turn that
 * answers its question.
 */
export interface LiveEntry {
  role: LiveRole;
  item: string;
  /** The turn's number: the item's turn count for an engineer, the architect session's for the architect. */
  turn: number;
  turnStartedAt: string;
  lastActionAt?: string;
  action?: string;
  /** When the board received the beat. */
  at: string;
}

/** The beats, one per (role, item), the newest kept; a listener hears the whole list after every beat. */
export class LiveStore {
  private entries = new Map<string, LiveEntry>();
  private listeners = new Set<(entries: LiveEntry[]) => void>();

  put(entry: LiveEntry): void {
    this.entries.set(`${entry.role}:${entry.item}`, entry);
    const oldest = Date.parse(entry.at) - LIVE_KEEP_MS;
    for (const [key, held] of this.entries) if (Date.parse(held.at) < oldest) this.entries.delete(key);
    const all = this.all();
    for (const listener of this.listeners) listener(all);
  }

  all(): LiveEntry[] { return [...this.entries.values()]; }

  /** Calls `listener` with the whole list after every beat; the returned function stops it. */
  onChange(listener: (entries: LiveEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
