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
  const archives = Rows.parse(source.archived);
  const meta = Array.isArray(source.meta) ? (Rows.parse(source.meta).find(r => r.id === "meta") ?? Rows.parse(source.meta)[0])?.data ?? {} : RawObject.parse(source.meta);
  const itemMap = new Map(items.map(row => [row.id, row.data]));
  const decisionIds = new Set(decisions.map(row => row.id));
  const readMap = new Map(reads.map(row => [row.id, row.data]));
  const issues: string[] = [];
  function equal(label: string, actual: unknown, expected: unknown): void {
    if (!isDeepStrictEqual(actual, expected)) issues.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  function optional(value: unknown): unknown { return value === "" ? undefined : value; }
  function fields(raw: Raw, names: string[]): Raw {
    return Object.fromEntries(names.filter(k => optional(raw[k]) !== undefined).map(k => [k, raw[k]]));
  }
  function date(value: unknown): string | undefined {
    if (typeof value !== "string" || !value) return undefined;
    const iso = new Date(value).toISOString();
    return /\.\d+/.test(value) ? iso : iso.replace(".000Z", "Z");
  }
  function newest(values: unknown[]): string | undefined {
    return values.map(date).filter((v): v is string => !!v).sort((a,b) => Date.parse(a) - Date.parse(b)).at(-1);
  }
  const exportTime = date(source.exportedAt)!;
  const readTime = (id: string) => newest([readMap.get(`it:${id}`)?.at, readMap.get("all")?.at, meta.freshSince]);
  const after = (a: unknown, b: unknown) => !!a && (!b || Date.parse(String(a)) > Date.parse(String(b)));
  const parent = (raw: Raw) => optional(raw.parent) ?? optional(raw.area);
  const parents = new Set(items.map(r => parent(r.data)).filter(Boolean));
  const archived = Object.fromEntries(archives.map(r => [r.id, date(r.data.at)]));
  equal("board metadata", converted.board, fields(meta, ["title", "eyebrow", "goal"]));
  equal("owner archive state", converted.owner, { archived });
  // Build expected documents directly from the source contract, independently
  // of the converter and of the output being checked. Whole-document equality
  // also rejects added fields, duplicates, wrong ordering and invented records.
  const expected: { items: Record<string, Raw>; decisions: Record<string, Raw>; notes: Record<string, Raw> } = { items: {}, decisions: {}, notes: {} };
  const dependency = (target: string, why: unknown) => !itemMap.has(target) && decisionIds.has(target) ? { card: target, why } : { id: target, why };
  for (const { id, data: raw } of items) {
    const doc = fields(raw, ["title", "agent", "group", "order", "status", "priority", "data", "links"]);
    doc.title ??= `（缺标题）${id}`;
    if (parent(raw)) doc.parent = parent(raw);
    const head = optional(raw.head ?? raw.text);
    if (head !== undefined) doc.head = head;
    if (parents.has(id)) { delete doc.status; delete doc.priority; }
    doc.links ??= [];
    const logs = raw.log === undefined ? [] : z.array(RawObject).parse(raw.log);
    doc.log = logs.map(entry => ({ at: date(entry.at), ...fields(entry, ["by"]), text: entry.text }));
    const depRows = raw.deps === undefined ? [] : z.array(z.unknown()).parse(raw.deps);
    const deps = depRows.map(d => {
      if (typeof d === "string") return dependency(d, "（迁移时补：原依赖没有记录理由）");
      const e = RawObject.parse(d);
      return e.card !== undefined ? { card: e.card, why: e.why } : dependency(String(e.id), e.why);
    });
    for (const child of items) {
      if (parent(child.data) !== id || ["done", "cancelled"].includes(String(parents.has(child.id) ? undefined : child.data.status))) continue;
      if (!deps.some(d => "id" in d && d.id === child.id)) deps.push({ id: child.id, why: `子条目：${optional(child.data.title) ?? `（缺标题）${child.id}`}` });
    }
    doc.deps = deps;
    doc.updated = newest([raw.updated, ...logs.map(l => l.at)]) ?? archived[id] ?? readTime(id) ?? exportTime;
    const created = date(raw.created) ?? logs.map(l => date(l.at)!).sort((a,b) => Date.parse(a) - Date.parse(b))[0];
    if (created) doc.created = created;
    if (raw.ask) doc.ask = { text: raw.ask, ...fields({ url: raw.askUrl, chat: raw.askChat }, ["url", "chat"]) };
    doc.rev = 1;
    expected.items[id] = doc;
    equal(`item ${id}`, converted.current.items[id], doc);
  }
  for (const { id, data: raw } of decisions) {
    const doc = fields(raw, ["item", "question", "background", "options", "status", "ruling", "order", "choice"]);
    doc.item ||= items.find(row => Array.isArray(row.data.qs) && row.data.qs.includes(id))?.id;
    if (typeof raw.confidence === "string" && raw.confidence) {
      const score = /^\s*([1-5])\s*\/\s*5\s*[。:：]?\s*([\s\S]*)$/.exec(raw.confidence);
      doc.confidence = score ? { score: Number(score[1]), reason: score[2] } : { reason: raw.confidence };
    } else if (raw.confidence !== undefined && raw.confidence !== "") doc.confidence = raw.confidence;
    const at = date(raw.at), ruledAt = date(raw.ruledAt);
    if (at) doc.at = at;
    if (ruledAt) doc.ruledAt = ruledAt;
    const ruling = notes.filter(n => n.data.target === `q:${id}` && ["choice", "approve"].includes(String(n.data.kind)))
      .sort((a,b) => Date.parse(String(b.data.at)) - Date.parse(String(a.data.at)))[0]?.data;
    if (raw.status !== "open" && ruling) {
      doc.ruledAt ??= date(ruling.at);
      if (doc.choice === undefined && typeof ruling.choice === "string" && z.array(RawObject).parse(raw.options).some(o => o.key === ruling.choice)) doc.choice = ruling.choice;
    }
    doc.updated = date(raw.updated) ?? doc.ruledAt ?? doc.at ?? exportTime;
    doc.rev = 1;
    expected.decisions[id] = doc;
    equal(`decision ${id}`, converted.current.decisions[id], doc);
  }
  function live(target: unknown): boolean {
    return typeof target === "string" && (target.startsWith("it:") && itemMap.has(target.slice(3)) || target.startsWith("q:") && decisionIds.has(target.slice(2)));
  }
  const orphanNotes: unknown[] = [];
  for (const row of notes) {
    const { id, data: raw } = row;
    if (!live(raw.target)) { orphanNotes.push(row); continue; }
    const doc = fields(raw, ["target", "kind", "choice", "state", "reply", "repliedBy", "anchor"]);
    doc.kind ||= "comment"; doc.text = raw.text; doc.at = date(raw.at); doc.rev = 1;
    if (doc.anchor === null) delete doc.anchor;
    else if (doc.anchor && RawObject.parse(doc.anchor).kind === "log") doc.anchor = { ...RawObject.parse(doc.anchor), at: date(RawObject.parse(doc.anchor).at) };
    if (raw.sentAt) doc.sentAt = date(raw.sentAt);
    if (raw.repliedAt || doc.reply) doc.repliedAt = date(raw.repliedAt) ?? doc.at;
    expected.notes[id] = doc;
    equal(`note ${id}`, converted.current.notes[id], doc);
  }
  equal("orphan notes verbatim", converted.orphans.notes, orphanNotes);
  equal("orphan reads verbatim", converted.orphans.reads, reads.filter(row => row.id !== "all" && !live(row.id)));
  for (const collection of ["items", "decisions", "notes"] as const) equal(`current ${collection} ids`, Object.keys(converted.current[collection]).sort(), Object.keys(expected[collection]).sort());

  const readState = structuredClone(expected);
  for (const { id } of items) {
    const doc = readState.items[id]!, cutoff = readTime(id), read = readMap.get(`it:${id}`);
    const changed = after(doc.updated, cutoff);
    const authoritative = read?.snap !== undefined && cutoff !== undefined && !after(cutoff, read.at);
    if (!changed && !authoritative) continue;
    if (!read) { delete readState.items[id]; continue; }
    const snap = authoritative ? RawObject.parse(read.snap) : {};
    for (const field of ["title", "data", "status", "priority"]) if (Object.hasOwn(snap, field)) {
      if (optional(snap[field]) === undefined) delete doc[field]; else doc[field] = snap[field];
    }
    if (snap.head !== undefined || snap.text !== undefined) doc.head = snap.head ?? snap.text;
    if (snap.deps !== undefined) doc.deps = z.array(z.string()).parse(snap.deps).map(sig => {
      const [target, ...reason] = sig.split("\u0001");
      return dependency(target!, reason.join("\u0001"));
    });
    const logs = z.array(RawObject).parse(doc.log).filter(l => !after(l.at, cutoff));
    doc.log = logs;
    doc.title ??= `（缺标题）${id}`;
    if (changed) doc.updated = cutoff;
  }
  for (const { id, data: raw } of decisions) {
    const card = expected.decisions[id]!, home = String(card.item), read = readMap.get(`it:${home}`), cutoff = readTime(home);
    const snap = read?.snap === undefined ? {} : RawObject.parse(read.snap);
    const knownCards = Array.isArray(snap.qs) ? snap.qs : undefined;
    const currentCards = itemMap.get(home)?.qs;
    const added = knownCards && !knownCards.includes(id) && Array.isArray(currentCards) && currentCards.includes(id) && !after(cutoff, read?.at);
    const evidence = notes.filter(n => n.data.target === `q:${id}`).map(n => date(n.data.at)!).sort((a,b) => Date.parse(a) - Date.parse(b))[0];
    const earliest = [date(raw.updated), evidence].filter((t): t is string => !!t).sort((a,b) => Date.parse(a) - Date.parse(b))[0];
    const dated = date(raw.at) ?? (knownCards?.includes(id) ? undefined : earliest ?? exportTime);
    if (after(dated, cutoff) || added) delete readState.decisions[id];
  }
  for (const doc of Object.values(readState.notes)) {
    const cutoff = newest([readMap.get(String(doc.target))?.at, readMap.get("all")?.at]);
    if (doc.reply && after(doc.repliedAt, cutoff)) {
      delete doc.reply; delete doc.repliedAt; delete doc.repliedBy; doc.state = "sent";
    }
  }
  for (const collection of ["items", "decisions", "notes"] as const) equal(`as-read ${collection}`, converted.asRead[collection], readState[collection]);

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
