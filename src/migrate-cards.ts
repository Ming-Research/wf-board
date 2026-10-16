/**
 * One-time migration of decision cards into the shape of docs/design.md, section 5: every card is a row of its item's
 * plan, a card keeps only its question and option names, and the old long texts move to `legacy`.
 * A pure function over the raw documents (the current schemas refuse the old cards); migrate-cards-cli.ts reads them and
 * Store.commitCardMigration writes the result in one commit. Deleted once it has run on the live board.
 */
import { rules } from "./rules.ts";
import type { Snapshot } from "./model.ts";

type Raw = Record<string, unknown>;

export interface CardMigrationInput { board: unknown; items: Record<string, Raw>; decisions: Record<string, Raw>; notes: Record<string, Raw> }

export interface CardMigrationReport {
  cardsOpen: number;
  cardsRuled: number;
  /** Ruled cards that had no row in their item's plan and got one at the end of it. */
  rowsAppended: number;
  /** Open cards that had no row; each got a row before its item's first acceptance step, which now waits for the card. */
  openCardsPlaced: string[];
  /** Rows in an item's plan for a card that belongs to another item. */
  foreignRowsDropped: number;
  afterListsEdited: number;
  /** Rows that followed a dropped row without an `after`; they get `after: []`, as they were ready before. */
  successorsReleased: number;
  /** Open cards whose owner pick was already sent; they close with that pick. */
  closedFromNote: string[];
  legacyKept: number;
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

const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const byString = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function optionLine(card: Raw): string {
  const options = Array.isArray(card.options) ? card.options as Raw[] : [], choice = text(card.choice);
  if (choice === undefined) return "主人用文字裁决（原文在那张卡上）";
  const option = options.find(o => o.key === choice);
  return `选 ${choice}${option ? `：${String(option.text).split("\n")[0]!.trim()}` : ""}`;
}

export function migrateCards(input: CardMigrationInput, at: string): CardMigration {
  const errors: string[] = [];
  const report: CardMigrationReport = { cardsOpen: 0, cardsRuled: 0, rowsAppended: 0, openCardsPlaced: [], foreignRowsDropped: 0, afterListsEdited: 0, successorsReleased: 0,
    closedFromNote: [], legacyKept: 0, ruledWithoutChoice: 0, itemsChanged: 0, derivedChanges: [], errors };
  const decisions: Record<string, Raw> = {};
  for (const [key, old] of Object.entries(input.decisions).sort(([a], [b]) => byString(a, b))) {
    for (const field of Object.keys(old)) if (!OLD_FIELDS.has(field)) errors.push(`card ${key}: unexpected field ${field}`);
    if (typeof old.item !== "string" || !Object.hasOwn(input.items, old.item)) { errors.push(`card ${key}: its item ${String(old.item)} does not exist`); continue; }
    if (old.status !== "open" && old.status !== "ruled") { errors.push(`card ${key}: status ${String(old.status)} has no place in the new card`); continue; }
    const { background, confidence, ruling, order: _order, ...rest } = old;
    const legacy: Raw = { ...(background === undefined ? {} : { background }), ...(confidence === undefined ? {} : { confidence }), ...(ruling === undefined ? {} : { ruling }) };
    const card: Raw = { ...rest, ...(Object.keys(legacy).length ? { legacy } : {}) };
    if (Object.keys(legacy).length) report.legacyKept++;
    if (card.status === "open") {
      const options = Array.isArray(card.options) ? card.options as Raw[] : [];
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
    // Cards without a row: the open ones are placed before the acceptance step, the ruled ones go at the end.
    const missing = (cardsOf.get(id) ?? []).filter(key => !next.some(row => row.card === key))
      .sort((a, b) => byString(String(decisions[a]!.at ?? decisions[a]!.updated), String(decisions[b]!.at ?? decisions[b]!.updated)) || byString(a, b));
    for (const key of missing) if (next.some(row => row.id === key)) errors.push(`item ${id}: the plan already has a row with the id ${key}, the key of a card of this item`);
    for (const key of missing.filter(k => decisions[k]!.status === "open")) {
      const stop = next.findIndex(row => row.accept === true), row = { id: key, card: key, after: [] };
      if (stop < 0) next.push(row);
      else {
        next.splice(stop, 0, row);
        const waiter = next[stop + 1]!;
        next[stop + 1] = { ...waiter, after: [...Array.isArray(waiter.after) ? waiter.after as string[] : stop > 0 ? [String(next[stop - 1]!.id)] : [], key] };
      }
      report.openCardsPlaced.push(key);
    }
    for (const key of missing.filter(k => decisions[k]!.status === "ruled")) { next.push({ id: key, card: key }); report.rowsAppended++; }
    const log = Array.isArray(item.log) ? item.log as Raw[] : [];
    const entries = droppedLines.length ? [{ at, by: MIGRATOR, text: `迁移：计划里别的条目的决策卡已移除，它们都已裁决。\n${droppedLines.join("\n")}` }] : [];
    if (!same(plan, next) || entries.length) { items[id] = { ...item, plan: next, log: [...log, ...entries] }; report.itemsChanged++; }
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
