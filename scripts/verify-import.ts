// This oracle reads the legacy fields directly. It uses only the converter's
// public result, never its helpers or transformation report.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { convertExport } from "../src/convert.ts";
import type { Converted } from "../src/convert.ts";

type Raw = Record<string, unknown>;
const RawObject = z.record(z.string(), z.unknown());
const RawRow = z.object({ id: z.string(), data: RawObject });
const Rows = z.array(RawRow);

export function verifyConverted(exportJson: unknown, converted: Converted): string[] {
  const source = RawObject.parse(exportJson);
  const items = Rows.parse(source.items);
  const decisions = Rows.parse(source.decisions);
  const notes = Rows.parse(source.notes);
  const reads = Rows.parse(source.reads);
  const itemMap = new Map(items.map(row => [row.id, row.data]));
  const decisionIds = new Set(decisions.map(row => row.id));
  const issues: string[] = [];
  function equal(label: string, actual: unknown, expected: unknown): void {
    if (!isDeepStrictEqual(actual, expected)) issues.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  function optional(value: unknown): unknown { return value === "" ? undefined : value; }
  function parent(raw: Raw): unknown { return raw.parent === "" ? undefined : optional(raw.parent) ?? optional(raw.area); }
  const parentIds = new Set(items.map(row => parent(row.data)).filter(p => p !== undefined));
  // Prose, PR references included, must survive exactly as written.
  function prose(value: unknown, _id: string): unknown { return value; }
  function instant(value: unknown): number | undefined { return typeof value === "string" ? Date.parse(value) : undefined; }
  for (const { id, data: raw } of items) {
    const out = converted.current.items[id];
    if (!out) { issues.push(`Missing item ${id}`); continue; }
    equal(`item ${id} title`, out.title, raw.title === undefined || raw.title === "" ? `（缺标题）${id}` : raw.title);
    equal(`item ${id} head/text`, out.head, prose(optional(raw.head ?? raw.text), id));
    equal(`item ${id} data`, out.data, prose(optional(raw.data), id));
    equal(`item ${id} parent`, out.parent, parent(raw));
    for (const field of ["links", "order", "agent", "group", "short"] as const) equal(`item ${id} ${field}`, out[field], field === "links" ? raw[field] ?? [] : optional(raw[field]));
    if (!parentIds.has(id)) {
      equal(`item ${id} status`, out.status, optional(raw.status));
      equal(`item ${id} priority`, out.priority, optional(raw.priority));
    } else {
      equal(`parent ${id} status removed`, out.status, undefined);
      equal(`parent ${id} priority removed`, out.priority, undefined);
    }
    const logs = raw.log === undefined ? [] : z.array(RawObject).parse(raw.log);
    equal(`item ${id} log length`, out.log.length, logs.length);
    logs.forEach((entry, index) => {
      equal(`item ${id} log ${index} text`, out.log[index]?.text, prose(entry.text, id));
      equal(`item ${id} log ${index} time`, instant(out.log[index]?.at), instant(entry.at));
    });
    const deps = raw.deps === undefined ? [] : z.array(z.unknown()).parse(raw.deps);
    for (const dep of deps) {
      const original = typeof dep === "string" ? { id: dep } : RawObject.parse(dep);
      const target = original.id ?? original.card;
      const outDep = out.deps.find(d => ("id" in d ? d.id : d.card) === target);
      if (!outDep) issues.push(`item ${id} missing dependency ${String(target)}`);
      else if (original.why !== undefined) equal(`item ${id} dependency ${String(target)} why`, outDep.why, original.why);
    }
    if (raw.ask) {
      equal(`item ${id} ask text`, out.ask?.text, prose(raw.ask, id));
      equal(`item ${id} ask URL`, out.ask?.url, optional(raw.askUrl));
      equal(`item ${id} ask chat`, out.ask?.chat, raw.askChat);
    }
  }
  for (const { id, data: raw } of decisions) {
    const out = converted.current.decisions[id];
    if (!out) { issues.push(`Missing decision ${id}`); continue; }
    for (const field of ["question", "background", "options", "status", "ruling"] as const) equal(`decision ${id} ${field}`, out[field], optional(raw[field]));
    const originalItem = raw.item ?? items.find(row => Array.isArray(row.data.qs) && row.data.qs.includes(id))?.id;
    equal(`decision ${id} item`, out.item, originalItem);
  }
  function live(target: unknown): boolean {
    return typeof target === "string" && (target.startsWith("it:") && itemMap.has(target.slice(3)) || target.startsWith("q:") && decisionIds.has(target.slice(2)));
  }
  const orphanNotes: unknown[] = [];
  for (const row of notes) {
    const { id, data: raw } = row;
    if (!live(raw.target)) { orphanNotes.push(row); continue; }
    const out = converted.current.notes[id];
    if (!out) { issues.push(`Missing note ${id}`); continue; }
    for (const field of ["target", "text", "choice", "state", "reply"] as const) equal(`note ${id} ${field}`, out[field], field === "text" ? raw[field] : optional(raw[field]));
    equal(`note ${id} kind`, out.kind, raw.kind ?? "comment");
    equal(`note ${id} time`, instant(out.at), instant(raw.at));
    equal(`note ${id} sentAt`, instant(out.sentAt), instant(raw.sentAt));
  }
  equal("orphan notes verbatim", converted.orphans.notes, orphanNotes);
  equal("orphan reads verbatim", converted.orphans.reads, reads.filter(row => row.id !== "all" && !live(row.id)));
  equal("current item count", Object.keys(converted.current.items).length, items.length);
  equal("current decision count", Object.keys(converted.current.decisions).length, decisions.length);
  equal("current note count", Object.keys(converted.current.notes).length, notes.length - orphanNotes.length);
  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const path = process.argv[2];
    if (!path || process.argv.length !== 3) throw new Error("Usage: node scripts/verify-import.ts <export.json>");
    const source: unknown = JSON.parse(await readFile(path, "utf8"));
    const converted = convertExport(source);
    const issues = verifyConverted(source, converted);
    const { items, decisions, notes } = converted.current;
    console.log(`Verified ${Object.keys(items).length} items, ${Object.keys(decisions).length} decisions, ${Object.keys(notes).length} notes; preserved ${converted.orphans.notes.length} orphan notes and ${converted.orphans.reads.length} orphan reads.`);
    if (issues.length) {
      for (const issue of issues) console.error(issue);
      process.exitCode = 1;
    } else console.log("All preservation checks passed.");
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
