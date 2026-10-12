// LEGACY PRIORITY: priority as the board computed it before a project sets
// `migrated: true` in board.yaml (docs/design.md section 5). A leaf stores its
// priority, a parent shows its highest open leaf's, and an open waiter raises
// the leaves under what it waits on, recording the raise for the struck
// original priority on the page. Remove this module, and every line marked
// "LEGACY PRIORITY" in src/ and web/, once every project is migrated.
import type { Item, Priority, Status } from "./model.ts";

export interface LegacyContext {
  item(id: string): Item | undefined;
  kids(id: string): string[];
  isLeaf(id: string): boolean;
  statusOf(id: string): Status;
  ended(id: string): boolean;
  inArchive(id: string): boolean;
  ancestors(id: string): string[];
  /** Items with a dependency on this one. */
  waiters(id: string): string[];
  migrated(id: string): boolean;
  cached<T>(name: string, key: string, make: () => T): T;
}

const RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };
export const rankOfPriority = (p: Priority | "" | undefined): number => p ? RANK[p] : 3;

export function legacyPriority(c: LegacyContext) {
  function leavesOf(id: string): string[] {
    return c.cached("leaves", id, () => {
      const seen = new Set<string>();
      function walk(key: string): string[] {
        if (seen.has(key) || !c.item(key)) return [];
        seen.add(key);
        return c.kids(key).length ? c.kids(key).flatMap(walk) : [key];
      }
      return walk(id);
    });
  }
  /** The priority written on the item or, for a parent, on its leaves: open first, then live, then any. */
  function writtenPriorityOf(id: string): Priority | "" {
    return c.cached("writtenPriority", id, () => {
      const leaves = leavesOf(id).filter(l => c.item(l)?.priority);
      const live = leaves.filter(l => c.statusOf(l) !== "cancelled"), open = live.filter(l => !c.ended(l));
      return (open.length ? open : live.length ? live : leaves).map(l => c.item(l)!.priority!).sort()[0] || "";
    });
  }
  function parentRank(id: string, rank: Map<string, number>): number {
    const open = leavesOf(id).filter(l => !c.ended(l));
    return open.length ? Math.min(...open.map(l => rank.get(l) ?? 3)) : rankOfPriority(writtenPriorityOf(id));
  }
  /**
   * One relaxation of a leaf against the open waiters on it and its ancestors.
   * An unmigrated waiter is the recorded raise; a migrated one raises without
   * a record, so the page shows only the higher priority. Returns whether the rank fell.
   */
  function relax(l: string, rank: Map<string, number>, why: Map<string, string>, rankOf: (id: string) => number): boolean {
    if (c.ended(l) || c.inArchive(l)) return false;
    const before = rank.get(l)!, written = rankOfPriority(c.item(l)?.priority);
    let r = before;
    for (const a of [l, ...c.ancestors(l)]) for (const w of c.waiters(a)) {
      if (c.ended(w) || c.ancestors(a).includes(w) || !c.migrated(w) && c.inArchive(w)) continue;
      const wr = rankOf(w);
      if (wr < r) { r = wr; if (c.migrated(w)) why.delete(l); else why.set(l, w); }
      else if (wr === r && r < written && !c.migrated(w) && !why.has(l)) why.set(l, w);
    }
    if (r === before) return false;
    rank.set(l, r);
    return true;
  }
  function raisedBy(id: string, priorityOf: (id: string) => Priority | "", why: Map<string, string>): string | null {
    const p = priorityOf(id);
    if (!p || p === writtenPriorityOf(id)) return null;
    const leaf = (c.isLeaf(id) ? [id] : leavesOf(id)).find(l => !c.ended(l) && why.has(l) && priorityOf(l) === p);
    return leaf ? why.get(leaf)! : null;
  }
  return { writtenPriorityOf, parentRank, relax, raisedBy };
}
