// What stands under an item: the decision cards on the items it owns, the pull requests its open parts name and the sessions at work
// on them. `context` lists the cards of the owned items, and the replies of `set_pause` and of the cancelling `set_status` list all three,
// so that whoever sets work aside sees what it holds first. docs/design.md, section 6, "Lean replies", gives the reasons.

import { worksOnItem } from "./dispatch.ts";
import { cardKind } from "./model.ts";
import type { Snapshot } from "./model.ts";
import { changesSection } from "./rules.ts";
import type { Rules } from "./rules.ts";
import { knownRepos, prKey, pullsIn } from "./query.ts";

/** The most cards one answer lists before it counts the rest. */
export const UNDER_CARDS_MAX = 20;

/** A decision card that is open or ruled (a withdrawn card holds nothing), with the item it stands on. */
export interface UnderCard { item: string; title: string; key: string; status: string; kind: string; question: string; blocks?: string; choice?: string; ruledAt?: string }

/** The items an item owns, at any depth: what is under it, the item itself first. */
export function subtreeIds(s: Pick<Snapshot, "items">, r: Pick<Rules, "children">, id: string): string[] {
  const out = [id], seen = new Set(out);
  for (const at of out) for (const child of r.children(at)) if (!seen.has(child) && Object.hasOwn(s.items, child)) { seen.add(child); out.push(child); }
  return out;
}

/** The open and ruled cards on the owned items below `id`, or with `self` on the item too, in the order of the items. */
export function cardsUnder(s: Pick<Snapshot, "items" | "decisions">, r: Pick<Rules, "children" | "cardsOf">, id: string, self: boolean): UnderCard[] {
  const out: UnderCard[] = [];
  for (const at of subtreeIds(s, r, id).slice(self ? 0 : 1)) {
    for (const key of r.cardsOf(at)) {
      const card = s.decisions[key];
      if (!card || card.status === "withdrawn") continue;
      out.push({ item: at, title: s.items[at]!.title, key, status: card.status, kind: cardKind(card), question: card.question, ...(card.blocks ? { blocks: card.blocks } : {}), ...(card.choice ? { choice: card.choice } : {}), ...(card.ruledAt ? { ruledAt: card.ruledAt } : {}) });
    }
  }
  return out;
}

/** A card on one line: its key, status, kind and question, what it blocks, and for a ruled card the option chosen. */
export function cardLine(c: UnderCard): string {
  const question = c.question.replace(/\s+/g, " ").trim();
  return `${c.key} · ${c.status} · ${c.kind} · ${question}${c.blocks ? ` · blocks: ${c.blocks}` : ""}${c.choice ? ` · chosen ${c.choice}` : c.ruledAt ? ` · ruled ${c.ruledAt}` : ""}`;
}

/** The lines that list cards, grouped by the item they stand on; `limit` cards, then a count of the rest. */
export function cardLines(cards: readonly UnderCard[], limit = UNDER_CARDS_MAX): string[] {
  const out: string[] = [];
  let last: string | undefined;
  for (const c of cards.slice(0, limit)) {
    if (c.item !== last) { out.push(`  ${c.item} · ${c.title.replace(/\s+/g, " ").trim()}`); last = c.item; }
    out.push(`    ${cardLine(c)}`);
  }
  if (cards.length > limit) out.push(`  … ${cards.length - limit} more cards (context of each item has them)`);
  return out;
}

/**
 * The pull requests the open items of the subtree name in their 改动 section, with the item that names each, leaving out those a done
 * step of that item names (the merge row of a merged pull request is marked done, src/watch.ts): what is still open as far as the board knows.
 */
export function prsUnder(s: Snapshot, r: Pick<Rules, "children" | "isOpenWork">, id: string): Array<{ repo: string; number: number; item: string }> {
  const repos = knownRepos(s), out = new Map<string, { repo: string; number: number; item: string }>();
  for (const at of subtreeIds(s, r, id)) {
    const it = s.items[at]!;
    if (!r.isOpenWork(at)) continue;
    const merged = new Set(it.plan.flatMap(row => "text" in row && row.state === "done" ? pullsIn(s, row.text, repos).map(prKey) : []));
    for (const pr of pullsIn(s, changesSection(it.head), repos)) if (!merged.has(prKey(pr)) && !out.has(prKey(pr))) out.set(prKey(pr), { ...pr, item: at });
  }
  return [...out.values()];
}

/** The sessions at work on the subtree: the dispatches with no finish, an engineer's or a review's (`worksOnItem`: an architect's turn is no session at work). */
export function dispatchesUnder(s: Pick<Snapshot, "items">, r: Pick<Rules, "children">, id: string): Array<{ item: string; agent: string; role: string; level: number; started: string }> {
  const out: Array<{ item: string; agent: string; role: string; level: number; started: string }> = [];
  for (const at of subtreeIds(s, r, id)) {
    for (const d of s.items[at]!.dispatches ?? []) if (!d.finish && worksOnItem(d)) out.push({ item: at, agent: d.agent, role: d.role, level: d.level, started: d.started });
  }
  return out;
}

/** What a reply to a pause or a cancel tells about the item and the items it owns: the cards, the pull requests and the sessions at work. */
export function underText(s: Snapshot, r: Pick<Rules, "children" | "cardsOf" | "isOpenWork">, id: string): string {
  const cards = cardsUnder(s, r, id, true), prs = prsUnder(s, r, id), sessions = dispatchesUnder(s, r, id), parts = subtreeIds(s, r, id).length - 1;
  const open = cards.filter(c => c.status === "open"), ruled = cards.filter(c => c.status !== "open");
  const lines = [`under ${id}${parts ? ` (and the ${parts} item${parts === 1 ? "" : "s"} it owns)` : ""}:`];
  lines.push(`open cards: ${open.length || "none"}`, ...cardLines(open));
  lines.push(`ruled cards: ${ruled.length || "none"}`, ...cardLines(ruled));
  lines.push(`pull requests named in 改动, merge row not done: ${prs.length ? prs.map(p => `${p.repo}#${p.number} (${p.item})`).join(", ") : "none"}`);
  lines.push(`sessions at work: ${sessions.length ? sessions.map(d => `${d.agent} (${d.role}, level ${d.level}, on ${d.item}, since ${d.started})`).join("; ") : "none"}`);
  return lines.join("\n");
}
