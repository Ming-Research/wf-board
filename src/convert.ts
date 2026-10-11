import { z } from "zod";
import { Board, Decision, Item, Key, Note, OwnerState } from "./model.ts";
import { Store } from "./store.ts";
import type { DocKind, Put, Del } from "./store.ts";

export interface Converted {
  board: Board;
  asRead: { items: Record<string, Item>; decisions: Record<string, Decision>; notes: Record<string, Note> };
  current: { items: Record<string, Item>; decisions: Record<string, Decision>; notes: Record<string, Note> };
  owner: { archived: Record<string, string> };
  orphans: { notes: unknown[]; reads: unknown[] };
  report: string[];
}

type Raw = Record<string, unknown>;
const ObjectData = z.record(z.string(), z.unknown());
const Row = z.object({ id: z.string(), data: ObjectData });
const Export = z.object({
  exportedAt: z.string(), meta: z.union([ObjectData, z.array(Row)]),
  items: z.array(Row), decisions: z.array(Row), notes: z.array(Row), reads: z.array(Row), archived: z.array(Row),
});

function object(value: unknown): Raw { return ObjectData.parse(value); }
function string(value: unknown): string | undefined { return typeof value === "string" && value !== "" ? value : undefined; }
function time(value: unknown): string | undefined {
  const text = string(value);
  if (text === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !Number.isFinite(Date.parse(text))) throw new Error(`Invalid migration time: ${text}`);
  const iso = new Date(text).toISOString();
  return /\.\d+/.test(text) ? iso : iso.replace(".000Z", "Z");
}
function latest(...times: (string | undefined)[]): string | undefined {
  return times.filter((t): t is string => t !== undefined).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}
function later(a: string, b: string | undefined): boolean { return b === undefined || Date.parse(a) > Date.parse(b); }
function optionalFields(raw: Raw, fields: string[]): Raw {
  return Object.fromEntries(fields.filter(k => raw[k] !== undefined && raw[k] !== "").map(k => [k, raw[k]]));
}

export function convertExport(exportJson: unknown): Converted {
  const input = Export.parse(exportJson);
  const exportedAt = time(input.exportedAt)!;
  const meta = Array.isArray(input.meta) ? input.meta.find(r => r.id === "meta")?.data ?? input.meta[0]?.data ?? {} : input.meta;
  const board = Board.parse(optionalFields(meta, ["title", "eyebrow", "goal"]));
  const counts = new Map<string, { count: number; examples: Set<string> }>();
  function report(action: string, id: string, count = 1): void {
    const entry = counts.get(action) ?? { count: 0, examples: new Set<string>() };
    entry.count += count;
    if (entry.examples.size < 4) entry.examples.add(id);
    counts.set(action, entry);
  }
  function records(rows: z.infer<typeof Row>[], keys = true): Record<string, Raw> {
    const result: Record<string, Raw> = Object.create(null);
    for (const row of rows) {
      if (keys) Key.parse(row.id);
      if (Object.hasOwn(result, row.id)) throw new Error(`Duplicate export id: ${row.id}`);
      result[row.id] = row.data;
    }
    return result;
  }
  const items = records(input.items);
  const decisions = records(input.decisions);
  // Orphan records are provenance, not filenames; don't impose new key rules on them.
  const notes = records(input.notes, false);
  const reads = records(input.reads, false);
  const archives = records(input.archived);
  const current: Converted["current"] = { items: {}, decisions: {}, notes: {} };
  const orphans: Converted["orphans"] = { notes: [], reads: [] };
  const owner: Converted["owner"] = { archived: {} };
  const parents: Record<string, string | undefined> = {};
  for (const [id, raw] of Object.entries(items)) {
    // As the old page read it: up(it) = it.parent || it.area, so an empty parent falls back to area.
    parents[id] = string(raw.parent) ?? string(raw.area);
    if (raw.area !== undefined) report("Fold area into parent (a nonempty parent wins, else area)", id);
  }
  const hasChildren = new Set(Object.values(parents).filter((p): p is string => p !== undefined));
  function exists(target: unknown): boolean {
    if (typeof target !== "string") return false;
    return target.startsWith("it:") ? Object.hasOwn(items, target.slice(3)) : target.startsWith("q:") && Object.hasOwn(decisions, target.slice(2));
  }
  for (const row of input.notes) if (!exists(row.data.target)) { orphans.notes.push(structuredClone(row)); report("Preserve orphan notes verbatim", row.id); }
  for (const row of input.reads) if (row.id !== "all" && !exists(row.id)) { orphans.reads.push(structuredClone(row)); report("Preserve orphan reads verbatim", row.id); }
  for (const [id, raw] of Object.entries(archives)) owner.archived[id] = time(raw.at)!;
  OwnerState.parse(owner);
  const allRead = time(reads.all?.at);
  const floor = time(meta.freshSince);
  function itemRead(id: string): string | undefined { return latest(time(reads[`it:${id}`]?.at), allRead, floor); }
  // Refuses a parent cycle, which would otherwise hang every walk up the tree.
  function rootGroup(id: string): string | undefined {
    const seen = new Set<string>();
    let key: string | undefined = id;
    while (key !== undefined) {
      if (seen.has(key)) throw new Error(`Parent cycle at ${key}`);
      seen.add(key);
      if (!parents[key]) return string(items[key]?.group);
      key = parents[key];
    }
    return undefined;
  }

  for (const id of Object.keys(items)) rootGroup(id);
  for (const [id, raw] of Object.entries(items)) {
    const doc: Raw = optionalFields(raw, ["title", "agent", "group", "short", "order", "status", "priority", "data", "links"]);
    if (parents[id]) doc.parent = parents[id];
    if (doc.title === undefined) { doc.title = `（缺标题）${id}`; report("Fill a missing item title with a placeholder", id); }
    for (const [field, value] of Object.entries(raw)) if (value === "") report(`Drop empty item ${field}`, id);
    if (raw.head !== undefined) {
      if (raw.head !== "") doc.head = raw.head;
      if (raw.text !== undefined) report("Keep head when both head and text exist", id);
    } else if (raw.text !== undefined) { if (raw.text !== "") doc.head = raw.text; report("Rename text to head", id); }
    if (hasChildren.has(id)) {
      for (const field of ["status", "priority"]) if (doc[field] !== undefined) { delete doc[field]; report(`Remove parent ${field}`, id); }
    }
    if (raw.qs !== undefined) report("Drop item qs (card item owns its location)", id);
    doc.deps = (raw.deps === undefined ? [] : z.array(z.unknown()).parse(raw.deps)).map(dep => {
      const entry = typeof dep === "string" ? { id: dep, why: "（迁移时补：原依赖没有记录理由）" } : object(dep);
      if (typeof dep === "string") report("Give bare dependency a migration reason", id);
      if (typeof entry.id === "string" && !Object.hasOwn(items, entry.id) && Object.hasOwn(decisions, entry.id)) {
        report("Convert decision dependency id to card", id);
        return { card: entry.id, why: entry.why };
      }
      return entry;
    });
    const log = (raw.log === undefined ? [] : z.array(ObjectData).parse(raw.log)).map(entry => {
      if (entry.by !== undefined) report("Remove migrated log author", id);
      const at = time(entry.at);
      if (at !== entry.at) report("Normalize log time", id);
      return { at, text: z.string().parse(entry.text) };
    });
    doc.log = log;
    const newest = latest(...log.map(entry => entry.at));
    let updated = time(raw.updated);
    if (newest && (!updated || later(newest, updated))) { updated = newest; report("Set updated from newest log time", id); }
    if (!updated) {
      updated = owner.archived[id] ?? itemRead(id);
      if (updated) report("Set missing updated from archive/read time", id);
    }
    if (!updated) { updated = exportedAt; report("Set missing updated from exportedAt", id); }
    doc.updated = updated;
    if (log.length) {
      doc.created = log.map(entry => entry.at!).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      report("Set created from oldest log time", id);
    }
    const ask = string(raw.ask);
    if (ask) {
      doc.ask = { text: ask, ...optionalFields({ url: raw.askUrl, chat: raw.askChat }, ["url", "chat"]) };
      report("Convert ask to structured request", id);
    }
    doc.rev = 1;
    current.items[id] = Item.parse(doc);
  }
  for (const [id, child] of Object.entries(current.items)) {
    if (!child.parent || child.status === "done" || child.status === "cancelled") continue;
    const parent = Object.hasOwn(current.items, child.parent) ? current.items[child.parent] : undefined;
    if (!parent) throw new Error(`Item ${id} has missing parent ${child.parent}`);
    if (!parent.deps.some(dep => "id" in dep && dep.id === id)) {
      parent.deps.push({ id, why: `子条目：${child.title}` });
      report("Add unfinished child to parent dependencies", child.parent);
    }
  }
  for (const [id, raw] of Object.entries(decisions)) {
    const doc = optionalFields(raw, ["item", "question", "background", "options", "status", "ruling", "order"]);
    if (!doc.item) {
      doc.item = Object.entries(items).find(([, item]) => Array.isArray(item.qs) && item.qs.includes(id))?.[0];
      report("Resolve missing card item from legacy qs", id);
    }
    if (typeof raw.confidence === "string") {
      const match = raw.confidence.match(/^\s*([1-5])\s*\/\s*5\s*[。:：]?\s*([\s\S]*)$/);
      if (match) { doc.confidence = { score: Number(match[1]), reason: match[2] }; report("Parse confidence score and reason", id); }
      else report("Drop confidence without a parsable score", id);
    } else if (raw.confidence !== undefined) doc.confidence = raw.confidence;
    if (raw.at) doc.at = time(raw.at);
    const rulingNote = Object.values(notes).filter(note => note.target === `q:${id}` && (note.kind === "choice" || note.kind === "approve"))
      .sort((a, b) => Date.parse(z.string().parse(b.at)) - Date.parse(z.string().parse(a.at)))[0];
    if (raw.status !== "open" && rulingNote) {
      doc.ruledAt = time(rulingNote.at);
      const options = z.array(ObjectData).parse(raw.options);
      if (typeof rulingNote.choice === "string" && options.some(option => option.key === rulingNote.choice)) doc.choice = rulingNote.choice;
      report("Derive ruledAt and choice from latest ruling note", id);
    }
    doc.updated = doc.ruledAt ?? doc.at ?? exportedAt;
    doc.rev = 1;
    current.decisions[id] = Decision.parse(doc);
  }
  for (const [id, raw] of Object.entries(notes)) {
    if (!exists(raw.target)) continue;
    Key.parse(id);
    const doc = optionalFields(raw, ["target", "kind", "choice", "state", "reply", "repliedBy", "anchor"]);
    doc.text = raw.text;
    doc.at = time(raw.at);
    if (!doc.kind) { doc.kind = "comment"; report("Default missing note kind to comment", id); }
    if (raw.title !== undefined) report("Drop note title (derived from target)", id);
    if (raw.anchor === null) { delete doc.anchor; report("Drop null note anchor", id); }
    else if (doc.anchor && object(doc.anchor).kind === "log") doc.anchor = { ...object(doc.anchor), at: time(object(doc.anchor).at) };
    if (raw.sentAt) doc.sentAt = time(raw.sentAt);
    if (doc.reply) {
      doc.repliedAt = time(raw.repliedAt) ?? doc.at;
      if (!raw.repliedAt) report("Set reply time from note time", id);
    } else {
      if (raw.repliedAt) report("Drop repliedAt without reply", id);
      delete doc.repliedBy;
    }
    doc.rev = 1;
    current.notes[id] = Note.parse(doc);
  }
  const asRead = structuredClone(current);
  for (const [id, item] of Object.entries(current.items)) {
    const readAt = itemRead(id);
    if (!later(item.updated, readAt)) continue;
    const read = reads[`it:${id}`];
    if (!read) { delete asRead.items[id]; report("Exclude new item from as-read state", id); continue; }
    if (!readAt) throw new Error(`Read ${id} lacks an at time`);
    const old: Raw = structuredClone(item);
    if (read.snap !== undefined) {
      const snap = object(read.snap);
      for (const field of ["title", "data", "status"]) if (Object.hasOwn(snap, field)) {
        if (snap[field] === "" || snap[field] === undefined) delete old[field];
        else old[field] = snap[field];
      }
      if (snap.head !== undefined || snap.text !== undefined) old.head = z.string().parse(snap.head ?? snap.text);
    }
    if (hasChildren.has(id)) delete old.status;
    old.log = item.log.filter(entry => !later(entry.at, readAt));
    const oldLog = old.log as Item["log"];
    if (oldLog.length) old.created = oldLog.map(entry => entry.at).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    else delete old.created;
    old.updated = readAt;
    asRead.items[id] = Item.parse(old);
    report("Reconstruct changed item as read", id);
  }
  for (const [id, note] of Object.entries(asRead.notes)) {
    const readAt = latest(time(reads[note.target]?.at), allRead);
    if (note.repliedAt && later(note.repliedAt, readAt)) {
      delete note.reply; delete note.repliedAt; delete note.repliedBy;
      note.state = "sent";
      report("Hide unread reply in as-read state", id);
    }
  }
  report("Set every document rev to 1", "all", Object.keys(current.items).length + Object.keys(current.decisions).length + Object.keys(current.notes).length);
  return { board, asRead, current, owner, orphans, report: Array.from(counts, ([action, info]) => `${action}: ${info.count} (examples: ${[...info.examples].join(", ")})`) };
}

export async function importExport(store: Store, exportJson: unknown): Promise<{ asReadCommit: string; currentCommit: string }> {
  // The Store contract coalesces no-ops: equal checkpoint states share a commit.
  // Two distinct commits for that case require an explicit empty-checkpoint API.
  const converted = convertExport(exportJson);
  async function write(documents: Converted["current"], message: string): Promise<string> {
    const snapshot = store.snapshot();
    const puts: Put[] = [];
    const deletes: Del[] = [];
    for (const [kind, collection] of [["item", "items"], ["decision", "decisions"], ["note", "notes"]] as const) {
      for (const [id, doc] of Object.entries(documents[collection])) puts.push({ kind, id, doc, expectRev: Object.hasOwn(snapshot[collection], id) ? snapshot[collection][id]!.rev : null });
      for (const [id, doc] of Object.entries(snapshot[collection])) if (!Object.hasOwn(documents[collection], id)) deletes.push({ kind: kind as DocKind, id, expectRev: doc.rev });
    }
    return (await store.commit({ author: "migration", message, board: converted.board, puts, deletes })).commit;
  }
  const asReadCommit = await write(converted.asRead, "Import the board as the owner last read it");
  const currentCommit = await write(converted.current, "Import the board's changes since the owner's last read");
  store.setOwner({ cursor: asReadCommit, archived: converted.owner.archived });
  return { asReadCommit, currentCommit };
}
