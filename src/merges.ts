// Which item delivered a merge to the main line: the pull request a commit names, and the item whose 改动 section names that
// pull request. The deploy pushes and the red-main-line push go to the session holding that item (docs/design.md, The wake streams).

import { holderOf } from "./dispatch.ts";
import type { Snapshot } from "./model.ts";
import { knownRepos, prKey, pullsIn } from "./query.ts";
import { changesSection } from "./rules.ts";

/** The pull request numbers a main-line commit subject names: a merge commit ("Merge pull request #7 from …") or a squash
 * commit ("… (#7)"). */
export function pullNumbers(subject: string): number[] {
  const merge = /^Merge pull request #(\d+)\b/.exec(subject);
  if (merge) return [Number(merge[1])];
  const squash = /\(#(\d+)\)\s*$/.exec(subject);
  return squash ? [Number(squash[1])] : [];
}

/** A pull request and the item whose 改动 section names it. */
export interface Delivery { pr: number; item: string }

/** The items that deliver the pull requests the commit subjects name in `repo` (`Owner/Name`): every item whose 改动 section
 * names one, done or not, since the session holding it stays until the PM finishes it. In the board's item order, a pull
 * request first. */
export function deliveries(s: Snapshot, repo: string, subjects: readonly string[]): Delivery[] {
  const numbers = [...new Set(subjects.flatMap(pullNumbers))];
  if (!numbers.length) return [];
  const repos = knownRepos(s), wanted = new Set(numbers.map(number => prKey({ repo, number }))), found = new Map<number, string[]>();
  for (const [item, doc] of Object.entries(s.items)) {
    for (const pull of pullsIn(s, changesSection(doc.head), repos)) if (wanted.has(prKey(pull))) found.set(pull.number, [...(found.get(pull.number) ?? []), item]);
  }
  return numbers.flatMap(pr => (found.get(pr) ?? []).map(item => ({ pr, item })));
}

/** The deliveries whose item a session holds, else all of them: the ones to tell, and when nobody holds any, the first to name
 * in the push that goes to the PM. */
export function tellFirst(s: Snapshot, found: readonly Delivery[]): Delivery[] {
  const held = found.filter(d => holderOf(s, d.item) !== undefined);
  return held.length ? held : found.slice(0, 1);
}
