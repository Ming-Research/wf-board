// What the PM is told it can hand out: for each pool of engineer slots that has a free slot and candidates, how many slots and how
// many candidates. Which candidate to start is the architect's choice, so the offer names none (docs/design.md, The wake streams).
// The dispatch push and the timed wake's reminder are made from it; the slots and the candidates are src/candidates.ts' answer.

import { candidates } from "./candidates.ts";
import type { Snapshot } from "./model.ts";
import type { Rules } from "./rules.ts";

/** A pool, its free slots and its candidates. */
export interface Offer { pool: string; free: number; limit: number; candidates: number }

/** Every pool's free slots and candidates, whether or not there is something to hand out. A group of candidates under one parent
 * counts as the items in it. */
export function poolCounts(s: Snapshot, r: Rules): Offer[] {
  return candidates(s, r).pools.map(({ pool, free, limit, listed, more }) => ({
    pool, free, limit, candidates: more + listed.reduce((n, x) => n + ("parent" in x ? x.count : 1), 0),
  }));
}

/** The pools with a free slot and at least one candidate: what the PM can hand out now. */
export const offersOf = (counts: readonly Offer[]): Offer[] => counts.filter(c => c.free > 0 && c.candidates > 0);
export const offers = (s: Snapshot, r: Rules): Offer[] => offersOf(poolCounts(s, r));

/** What the PM was last told, per pool: the free slots and candidates at the last push, lowered whenever a look finds fewer. */
export type Told = Map<string, { free: number; candidates: number }>;
export const toldNow = (counts: readonly Offer[]): Told => new Map(counts.map(c => [c.pool, { free: c.free, candidates: c.candidates }]));

/** What to push after a look, and what the PM then counts as told. A pool is pushed when it has something to hand out and more
 * free slots or more candidates than it was last told; the PM's own starts, which only lower them, push nothing and lower what
 * was told, so only a slot that really frees afterwards, or a candidate that really appears, pushes again. */
export function toPush(counts: readonly Offer[], told: Told): { push: Offer[]; told: Told } {
  const push: Offer[] = [], next: Told = new Map();
  for (const c of counts) {
    const was = told.get(c.pool) ?? { free: 0, candidates: 0 };
    if (c.free > 0 && c.candidates > 0 && (c.free > was.free || c.candidates > was.candidates)) { push.push(c); next.set(c.pool, { free: c.free, candidates: c.candidates }); }
    else next.set(c.pool, { free: Math.min(was.free, c.free), candidates: Math.min(was.candidates, c.candidates) });
  }
  return { push, told: next };
}
