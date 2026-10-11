// Usage: node scripts/compare-legacy.ts <export.json>
// Read-only comparison: never writes board data. Freshness is intentionally
// absent, and card deps have no legacy equivalent. A card's new sole owner is
// its item (legacy homeOf fallback when omitted), so stale qs can disagree.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Item, Decision, Note } from "../src/model.ts";
import type { Snapshot } from "../src/model.ts";
import { legacyRules } from "../test/legacy/board-rules.js";
import type { LegacyItem, LegacyDecision, LegacyNote, LegacyState } from "../test/legacy/board-rules.js";
import { compare } from "../test/legacy/compare.ts";

export interface LegacyExport {
  exportedAt: string;
  meta: unknown;
  items: Array<{ id: string; data: Omit<LegacyItem, "id"> }>;
  decisions: Array<{ id: string; data: Omit<LegacyDecision, "id"> }>;
  notes: Array<{ id: string; data: Omit<LegacyNote, "id"> }>;
  reads: unknown[];
  archived: Array<{ id: string; data: { at: string } }>;
}

// The artifact accepted times without seconds (2026-10-08T08:30Z); the schema needs them.
const fixTime = (t: string | undefined) => t && /T\d{2}:\d{2}Z$/.test(t) ? t.replace(/Z$/, ":00Z") : t;

export function compareExport(data: LegacyExport) {
  const old: LegacyState = {
    items: data.items.map(({ id, data: fields }) => ({ ...fields, id })),
    decisions: data.decisions.map(({ id, data: fields }) => ({ ...fields, id })),
    notes: data.notes.map(({ id, data: fields }) => ({ ...fields, id })),
    archived: Object.fromEntries(data.archived.map(({ id, data: fields }) => [id, fields])),
  };
  const legacy = legacyRules(old);
  const snapshot: Pick<Snapshot, "items" | "decisions" | "notes" | "owner"> = {
    items: Object.fromEntries(old.items.map(it => [it.id, Item.parse({
      title: it.title || it.id, parent: it.parent || it.area || undefined,
      agent: it.agent || undefined, group: it.group || undefined, order: it.order,
      status: it.status, priority: it.priority, head: it.head || it.text || undefined,
      ask: it.ask ? { text: it.ask, url: it.askUrl || undefined, chat: it.askChat } : undefined,
      log: (it.log || []).map(e => ({ ...e, at: fixTime(e.at) })), deps: (it.deps || []).map(e => typeof e === "string" ? { id: e, why: "" } : { id: e.id, why: e.why || "" }),
      updated: fixTime(it.updated) || "1970-01-01T00:00:00Z", rev: 1,
    })])),
    decisions: Object.fromEntries(old.decisions.map(d => {
      const home = legacy.homeOf(d);
      if (!home) throw new Error(`Decision ${d.id} has no item or legacy qs home; the new model requires an item`);
      return [d.id, Decision.parse({
        item: home, question: d.question || d.id, background: d.background || "Legacy comparison",
        options: d.options?.length ? d.options : [{ key: "A", text: "Legacy comparison" }],
        status: d.status, order: d.order, updated: d.updated || d.at || "1970-01-01T00:00:00Z", rev: 1,
      })];
    })),
    notes: Object.fromEntries(old.notes.map(n => {
      const { id, ...fields } = n;
      // Old notes also stored a title, which is no longer part of the schema.
      return [id, Note.parse({ target: fields.target, kind: fields.kind || "comment", choice: fields.choice,
        text: fields.text, at: fields.at, state: fields.state, sentAt: fields.sentAt,
        reply: fields.reply || undefined, repliedAt: fields.repliedAt, rev: 1 })];
    })),
    owner: { archived: Object.fromEntries(Object.entries(old.archived).map(([id, r]) => [id, r.at])) },
  };
  return { items: old.items.length, comparisons: old.items.length * 8, disagreements: compare(old, snapshot) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const filename = process.argv[2];
    if (!filename || process.argv.length !== 3) throw new Error("Usage: node scripts/compare-legacy.ts <export.json>");
    const result = compareExport(JSON.parse(await readFile(filename, "utf8")) as LegacyExport);
    for (const d of result.disagreements) console.log(`${d.id} ${d.rule}: old=${JSON.stringify(d.old)} new=${JSON.stringify(d.new)}`);
    console.log(`${result.items} items, ${result.comparisons} comparisons, ${result.disagreements.length} disagreements`);
    if (result.disagreements.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
