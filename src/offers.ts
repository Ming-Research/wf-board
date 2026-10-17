// What the PM is told it can hand out: for each pool of engineer slots that has a free slot and candidates, how many slots and how
// many candidates. Which candidate to start is the architect's choice, so the offer names none (docs/design.md, The wake streams).
// The dispatch push and the timed wake's reminder are made from it; the slots and the candidates are src/candidates.ts' answer.

import { candidates } from "./candidates.ts";
import type { Snapshot } from "./model.ts";
import type { Rules } from "./rules.ts";

/** A pool with a free slot and candidates to start in it. */
export interface Offer { pool: string; free: number; limit: number; candidates: number }

/** The offers, one per pool that has a free slot and at least one candidate. A group of candidates under one parent counts as
 * the items in it. */
export function offers(s: Snapshot, r: Rules): Offer[] {
  const out: Offer[] = [];
  for (const { pool, free, limit, listed, more } of candidates(s, r).pools) {
    const count = more + listed.reduce((n, x) => n + ("parent" in x ? x.count : 1), 0);
    if (free > 0 && count > 0) out.push({ pool, free, limit, candidates: count });
  }
  return out;
}
