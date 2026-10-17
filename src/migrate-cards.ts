/**
 * One-time migration of decision cards into the shape of docs/design.md, section 5: only a blocking card is a row of its
 * item's plan, an option is a name and a detail (the old option text becomes the detail), confidence and ruling are
 * fields of the card, the old background moves to `legacy`, and an old card gets its place in the head: a section at the
 * end of the item's head, a line of its own for each card the head does not place.
 * A pure function over the raw documents (the current schemas refuse the old cards); migrate-cards-cli.ts reads them and
 * Store.commitCardMigration writes the result in one commit. Deleted once it has run on the live board.
 */
import { rules, placedCards } from "./rules.ts";
import type { Snapshot } from "./model.ts";

type Raw = Record<string, unknown>;

export interface CardMigrationInput { board: unknown; items: Record<string, Raw>; decisions: Record<string, Raw>; notes: Record<string, Raw> }

export interface CardMigrationReport {
  cardsOpen: number;
  cardsRuled: number;
  /** Open blocking cards that had no row; each got a row before its item's first acceptance step, which now waits for the card. */
  openCardsPlaced: string[];
  /** Open cards that did not say what they block but had a row: each blocks the step after its row, named here, and keeps the row. */
  openCardsBlocking: Array<{ card: string; blocks: string }>;
  /** Rows in an item's plan for a card that belongs to another item. */
  foreignRowsDropped: number;
  afterListsEdited: number;
  /** Rows that followed a dropped row without an `after`; they get `after: []`, as they were ready before. */
  successorsReleased: number;
  /** Open cards whose owner pick was already sent; they close with that pick. */
  closedFromNote: string[];
  /** Cards that kept their old background in `legacy`. */
  legacyKept: number;
  /** Items whose head got a section for the cards it did not place, and the cards in those sections. */
  headsExtended: number;
  cardsPlaced: number;
  /** The section the first such item got, as written. */
  headSample?: string;
  ruledWithoutChoice: number;
  itemsChanged: number;
  /** Items whose status, priority or ready rows differ between the board before and after (the same current rules on both). */
  derivedChanges: string[];
  errors: string[];
}

export interface CardMigration {
  /** Only the items that change. */
  items: Record<string, Raw>;
  /** Every card. */
  decisions: Record<string, Raw>;
  report: CardMigrationReport;
}

const OLD_FIELDS = new Set(["num", "item", "question", "background", "options", "confidence", "status", "blocks", "choice", "ruling", "ruledAt", "order", "at", "updated", "rev"]);
const MIGRATOR = "wf-board";

/** The title of the section that places the cards a head did not. */
export const OLD_DECISIONS_TITLE = "**以前的决定**";

/** The head with a section of cards, one marker line each, before its 参考 sections (a card inside a folded one would hide). */
function withCardSection(head: string, keys: string[]): { head: string; section: string } {
  const lines = head.replace(/\r/g, "").split("\n");
  let fenced = false, at = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i]!)) fenced = !fenced;
    if (!fenced && /^\*\*参考：/.test(lines[i]!)) { at = i; break; }
  }
  const before = lines.slice(0, at), after = lines.slice(at);
  while (before.length && !before.at(-1)!.trim()) before.pop();
  const section = [OLD_DECISIONS_TITLE, "", ...keys.flatMap((key, i) => i ? ["", `[[q:${key}]]`] : [`[[q:${key}]]`])].join("\n");
  return { head: [...before, ...(before.length ? [""] : []), section, ...(after.length ? ["", ...after] : [])].join("\n"), section };
}

const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const byString = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function optionLine(card: Raw): string {
  const options = Array.isArray(card.options) ? card.options as Raw[] : [], choice = text(card.choice);
  if (choice === undefined) return "主人用文字裁决（原文在那张卡上）";
  const option = options.find(o => o.key === choice);
  return `选 ${choice}${option ? `：${String(option.text || option.detail).split("\n").find(l => l.trim())?.trim() ?? ""}` : ""}`;
}

/** What a plan row is called in a sentence: a step's text, an item's title, a card's question, first line only. */
function stepName(row: Raw, input: CardMigrationInput): string {
  const named = typeof row.text === "string" ? row.text : typeof row.item === "string" ? input.items[row.item]?.title : typeof row.card === "string" ? input.decisions[row.card]?.question : undefined;
  const line = (typeof named === "string" ? named : "").split("\n")[0]!.replace(/[*`]/g, "").trim();
  return line || "本条目后面的工作";
}

export function migrateCards(input: CardMigrationInput, at: string): CardMigration {
  const errors: string[] = [];
  const report: CardMigrationReport = { cardsOpen: 0, cardsRuled: 0, openCardsPlaced: [], openCardsBlocking: [], foreignRowsDropped: 0, afterListsEdited: 0, successorsReleased: 0,
    closedFromNote: [], legacyKept: 0, headsExtended: 0, cardsPlaced: 0, ruledWithoutChoice: 0, itemsChanged: 0, derivedChanges: [], errors };
  const decisions: Record<string, Raw> = {};
  for (const [key, old] of Object.entries(input.decisions).sort(([a], [b]) => byString(a, b))) {
    for (const field of Object.keys(old)) if (!OLD_FIELDS.has(field)) errors.push(`card ${key}: unexpected field ${field}`);
    if (typeof old.item !== "string" || !Object.hasOwn(input.items, old.item)) { errors.push(`card ${key}: its item ${String(old.item)} does not exist`); continue; }
    if (old.status !== "open" && old.status !== "ruled") { errors.push(`card ${key}: status ${String(old.status)} has no place in the new card`); continue; }
    // The old option text is the detail and the name stays empty; confidence and ruling keep their fields; the background is
    // the one old text left over, in `legacy`.
    const { background, order: _order, options: oldOptions, ...rest } = old;
    const options = (Array.isArray(oldOptions) ? oldOptions as Raw[] : []).map(({ text: detail, ...option }): Raw => ({ ...option, text: "", ...(detail === undefined || detail === "" ? {} : { detail }) }));
    const card: Raw = { ...rest, options, ...(background === undefined ? {} : { legacy: { background } }) };
    if (background !== undefined) report.legacyKept++;
    if (card.status === "open") {
      const sent = Object.values(input.notes).filter(n => n.target === `q:${key}` && n.kind === "choice" && n.state === "sent" && typeof n.sentAt === "string" && options.some(o => o.key === n.choice))
        .sort((a, b) => byString(String(a.sentAt), String(b.sentAt)))[0];
      if (sent) {
        card.status = "ruled"; card.choice = sent.choice; card.ruledAt = sent.sentAt;
        if (String(card.updated) < String(sent.sentAt)) card.updated = sent.sentAt;
        report.closedFromNote.push(key);
      }
    }
    if (card.status === "open") report.cardsOpen++; else { report.cardsRuled++; if (card.choice === undefined) report.ruledWithoutChoice++; }
    decisions[key] = card;
  }

  const cardsOf = new Map<string, string[]>();
  for (const [key, card] of Object.entries(decisions)) cardsOf.set(card.item as string, [...cardsOf.get(card.item as string) ?? [], key]);
  const items: Record<string, Raw> = {};
  for (const [id, item] of Object.entries(input.items).sort(([a], [b]) => byString(a, b))) {
    const plan = Array.isArray(item.plan) ? item.plan as Raw[] : [];
    // Rows for cards of other items: the card was ruled, so the row was resolved; drop it and keep what was chosen in the log.
    const dropped = new Set<string>(), droppedLines: string[] = [];
    for (const row of plan) {
      const key = text(row.card);
      if (key === undefined) continue;
      const card = decisions[key];
      if (!card) { if (!Object.hasOwn(input.decisions, key)) errors.push(`item ${id}: row ${String(row.id)} names the card ${key}, which does not exist`); continue; }
      if (card.item === id) continue;
      if (card.status !== "ruled") { errors.push(`item ${id}: row ${String(row.id)} waits on the open card ${key} of item ${String(card.item)}; place it by hand`); continue; }
      dropped.add(String(row.id));
      droppedLines.push(`[[q:${key}]]（属于 [[it:${String(card.item)}]]）：${optionLine(card)}`);
    }
    const next: Raw[] = [];
    let before: Raw | undefined;
    for (const row of plan) {
      if (dropped.has(String(row.id))) { report.foreignRowsDropped++; before = row; continue; }
      const after = Array.isArray(row.after) ? row.after as string[] : undefined;
      if (after === undefined && before !== undefined && dropped.has(String(before.id))) { next.push({ ...row, after: [] }); report.successorsReleased++; }
      else if (after?.some(target => dropped.has(target))) { next.push({ ...row, after: after.filter(target => !dropped.has(target)) }); report.afterListsEdited++; }
      else next.push(row);
      before = row;
    }
    // Only a card that blocks has a row. In the old plans a card's row made the step after it wait, so an open card that has a
    // row but no `blocks` becomes a blocking card that names that step and keeps its row: no item changes status. An open
    // blocking card without a row is placed before the acceptance step, which now waits for it. A closed card keeps the row
    // it has and gets none.
    for (const key of (cardsOf.get(id) ?? []).filter(k => decisions[k]!.status === "open" && decisions[k]!.blocks === undefined)) {
      const at = next.findIndex(row => row.card === key);
      if (at < 0) continue;
      const rowId = String(next[at]!.id), later = next.slice(at + 1), waiting = later.find(row => Array.isArray(row.after) && row.after.includes(rowId)) ?? later[0];
      const blocks = waiting === undefined ? "本条目后面的工作" : stepName(waiting, input);
      decisions[key]!.blocks = blocks;
      report.openCardsBlocking.push({ card: key, blocks });
    }
    const missing = (cardsOf.get(id) ?? []).filter(key => decisions[key]!.status === "open" && decisions[key]!.blocks !== undefined && !next.some(row => row.card === key))
      .sort((a, b) => byString(String(decisions[a]!.at ?? decisions[a]!.updated), String(decisions[b]!.at ?? decisions[b]!.updated)) || byString(a, b));
    for (const key of missing) if (next.some(row => row.id === key)) errors.push(`item ${id}: the plan already has a row with the id ${key}, the key of a card of this item`);
    for (const key of missing) {
      const stop = next.findIndex(row => row.accept === true), row = { id: key, card: key, after: [] };
      if (stop < 0) next.push(row);
      else {
        next.splice(stop, 0, row);
        const waiter = next[stop + 1]!;
        next[stop + 1] = { ...waiter, after: [...Array.isArray(waiter.after) ? waiter.after as string[] : stop > 0 ? [String(next[stop - 1]!.id)] : [], key] };
      }
      report.openCardsPlaced.push(key);
    }
    // The head places each card of the item on a line of its own; the cards it does not place (all the old ones) get a section.
    const head = typeof item.head === "string" ? item.head : "";
    const unplaced = (cardsOf.get(id) ?? []).filter(key => !placedCards(head).includes(key))
      .sort((a, b) => byString(String(decisions[a]!.at ?? decisions[a]!.updated), String(decisions[b]!.at ?? decisions[b]!.updated)) || byString(a, b));
    const extended = unplaced.length ? withCardSection(head, unplaced) : undefined;
    if (extended) { report.headsExtended++; report.cardsPlaced += unplaced.length; report.headSample ??= extended.section; }
    const log = Array.isArray(item.log) ? item.log as Raw[] : [];
    const entries = droppedLines.length ? [{ at, by: MIGRATOR, text: `迁移：计划里别的条目的决策卡已移除，它们都已裁决。\n${droppedLines.join("\n")}` }] : [];
    if (!same(plan, next) || entries.length || extended) { items[id] = { ...item, plan: next, ...(extended ? { head: extended.head } : {}), log: [...log, ...entries] }; report.itemsChanged++; }
  }

  // The same rules on the board before and after: a plan row that moved must not change what is ready, nor any status or priority.
  if (!errors.length) {
    const snapshot = (i: Record<string, Raw>, d: Record<string, Raw>): Snapshot => ({ board: input.board, items: i, decisions: d, notes: input.notes, owner: {}, glossaries: {}, head: "" }) as unknown as Snapshot;
    const was = rules(snapshot(input.items, input.decisions)), now = rules(snapshot({ ...input.items, ...items }, decisions));
    for (const id of Object.keys(input.items)) {
      const ready = (r: typeof was, known?: Set<string>): string => r.planRows(id).filter(row => row.ready && (!known || known.has(row.row.id))).map(row => row.row.id).join(",");
      const known = new Set(was.planRows(id).map(row => row.row.id));
      if (was.statusOf(id) !== now.statusOf(id)) report.derivedChanges.push(`${id}: status ${was.statusOf(id)} → ${now.statusOf(id)}`);
      if (was.priorityOf(id) !== now.priorityOf(id)) report.derivedChanges.push(`${id}: priority ${String(was.priorityOf(id))} → ${String(now.priorityOf(id))}`);
      if (ready(was, known) !== ready(now, known)) report.derivedChanges.push(`${id}: ready rows ${ready(was, known)} → ${ready(now, known)}`);
    }
  }
  return { items, decisions, report };
}
