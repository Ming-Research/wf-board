import { z } from "zod";
import { Board, Decision, Dep, Item, Key, Note, OwnerState } from "./model.ts";
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
const Row = z.object({ id: z.string(), data: ObjectData }).strict();
const Export = z.object({
  exportedAt: z.string(), meta: z.union([ObjectData, z.array(Row)]),
  items: z.array(Row), decisions: z.array(Row), notes: z.array(Row), reads: z.array(Row), archived: z.array(Row),
}).strict();

function object(value: unknown): Raw { return ObjectData.parse(value); }
function string(value: unknown): string | undefined { return typeof value === "string" && value !== "" ? value : undefined; }
function time(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  const text = z.string().parse(value);
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

// An unfamiliar nonempty source field needs an explicit mapping, never silent
// schema stripping. The original export remains provenance for cleanups.
function known(raw: Raw, fields: string[], path: string): void {
  for (const [field, value] of Object.entries(raw)) {
    if (!fields.includes(field) && value !== undefined && value !== "" && value !== null && !(Array.isArray(value) && !value.length)) throw new Error(`${path}.${field}: unsupported nonempty migration content`);
  }
}

export function convertExport(exportJson: unknown): Converted {
  const input = Export.parse(exportJson);
  const exportedAt = time(input.exportedAt)!;
  const meta = Array.isArray(input.meta) ? input.meta.find(r => r.id === "meta")?.data ?? input.meta[0]?.data ?? {} : input.meta;
  known(meta, ["title", "eyebrow", "goal", "updated", "revision", "freshSince"], "meta");
  if (Array.isArray(input.meta) && input.meta.length > 1) throw new Error("meta: unsupported additional metadata rows");
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
  for (const [id, raw] of Object.entries(archives)) known(raw, ["at"], `archived.${id}`);
  for (const [id, raw] of Object.entries(reads)) {
    if (id !== "all" && !exists(id)) continue;
    known(raw, ["at", "snap"], `reads.${id}`);
    if (raw.snap !== undefined) known(object(raw.snap), ["title", "text", "head", "data", "status", "priority", "deps", "qs"], `reads.${id}.snap`);
  }
  const current: Converted["current"] = { items: {}, decisions: {}, notes: {} };
  const orphans: Converted["orphans"] = { notes: [], reads: [] };
  const owner: Converted["owner"] = { archived: {} };
  const parents: Record<string, string | undefined> = {};
  for (const [id, raw] of Object.entries(items)) {
    known(raw, ["title", "parent", "area", "agent", "group", "short", "order", "status", "priority", "data", "links", "head", "text", "qs", "deps", "log", "updated", "created", "ask", "askUrl", "askChat"], `items.${id}`);
    for (const field of ["parent", "area", "askUrl"]) if (raw[field] !== undefined) z.string().parse(raw[field]);
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
    const doc: Raw = optionalFields(raw, ["title", "agent", "group", "order", "status", "priority", "data", "links"]);
    // Area short names labelled dependency rows; the owner reads projects, not areas, so they are dropped.
    if (raw.short !== undefined && raw.short !== "") report("Drop area short name", id);
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
      known(entry, ["id", "card", "why"], `items.${id}.deps`);
      Dep.parse(entry); // validate the union before translating id to card
      if (typeof dep === "string") report("Give bare dependency a migration reason", id);
      if (typeof entry.id === "string" && !Object.hasOwn(items, entry.id) && Object.hasOwn(decisions, entry.id)) {
        report("Convert decision dependency id to card", id);
        return { card: entry.id, why: entry.why };
      }
      return entry;
    });
    const log = (raw.log === undefined ? [] : z.array(ObjectData).parse(raw.log)).map(entry => {
      known(entry, ["at", "by", "text"], `items.${id}.log`);
      const at = time(entry.at);
      if (at !== entry.at) report("Normalize log time", id);
      return { at, ...optionalFields(entry, ["by"]), text: z.string().parse(entry.text) };
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
    if (raw.created !== undefined && raw.created !== "") doc.created = time(raw.created);
    else if (log.length) {
      doc.created = log.map(entry => entry.at!).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      report("Set created from oldest log time", id);
    }
    if (raw.ask !== undefined && typeof raw.ask !== "string") throw new Error(`items.${id}.ask: expected legacy request text`);
    const ask = string(raw.ask);
    if (!ask && (string(raw.askUrl) || raw.askChat === true)) throw new Error(`items.${id}.ask: cannot preserve askUrl/askChat without request text`);
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
    known(raw, ["item", "question", "background", "options", "status", "ruling", "order", "confidence", "at", "updated", "choice", "ruledAt"], `decisions.${id}`);
    const doc = optionalFields(raw, ["item", "question", "background", "options", "status", "ruling", "order", "choice"]);
    if (raw.ruledAt !== undefined && raw.ruledAt !== "") doc.ruledAt = time(raw.ruledAt);
    if (raw.item !== undefined && raw.item !== "") Key.parse(raw.item);
    if (!doc.item) {
      doc.item = Object.entries(items).find(([, item]) => Array.isArray(item.qs) && item.qs.includes(id))?.[0];
      report("Resolve missing card item from legacy qs", id);
    }
    if (typeof raw.confidence === "string") {
      const match = raw.confidence.match(/^\s*([1-5])\s*\/\s*5\s*[。:：]?\s*([\s\S]*)$/);
      if (match) { doc.confidence = { score: Number(match[1]), reason: match[2] }; report("Parse confidence score and reason", id); }
      else if (raw.confidence) { doc.confidence = { reason: raw.confidence }; report("Keep confidence text without score", id); }
    } else if (raw.confidence !== undefined) doc.confidence = raw.confidence;
    if (raw.at !== undefined && raw.at !== "") doc.at = time(raw.at);
    const rulingNote = Object.values(notes).filter(note => note.target === `q:${id}` && (note.kind === "choice" || note.kind === "approve"))
      .sort((a, b) => Date.parse(z.string().parse(b.at)) - Date.parse(z.string().parse(a.at)))[0];
    if (raw.status !== "open" && rulingNote) {
      doc.ruledAt ??= time(rulingNote.at);
      const options = z.array(ObjectData).parse(raw.options);
      if (doc.choice === undefined && typeof rulingNote.choice === "string" && options.some(option => option.key === rulingNote.choice)) doc.choice = rulingNote.choice;
      report("Derive ruledAt and choice from latest ruling note", id);
    }
    doc.updated = time(raw.updated) ?? doc.ruledAt ?? doc.at ?? exportedAt;
    doc.rev = 1;
    current.decisions[id] = Decision.parse(doc);
  }
  for (const [id, raw] of Object.entries(notes)) {
    if (!exists(raw.target)) continue;
    Key.parse(id);
    known(raw, ["target", "title", "kind", "choice", "text", "at", "state", "sentAt", "reply", "repliedAt", "repliedBy", "anchor"], `notes.${id}`);
    const doc = optionalFields(raw, ["target", "kind", "choice", "state", "reply", "repliedBy", "anchor"]);
    doc.text = raw.text;
    doc.at = time(raw.at);
    if (!doc.kind) { doc.kind = "comment"; report("Default missing note kind to comment", id); }
    if (raw.title !== undefined) report("Drop note title (derived from target)", id);
    if (raw.anchor === null) { delete doc.anchor; report("Drop null note anchor", id); }
    else if (doc.anchor && object(doc.anchor).kind === "log") doc.anchor = { ...object(doc.anchor), at: time(object(doc.anchor).at) };
    if (raw.sentAt !== undefined && raw.sentAt !== "") doc.sentAt = time(raw.sentAt);
    if (doc.reply) {
      doc.repliedAt = time(raw.repliedAt) ?? doc.at;
      if (!raw.repliedAt) report("Set reply time from note time", id);
    } else if (raw.repliedAt !== undefined && raw.repliedAt !== "") doc.repliedAt = time(raw.repliedAt);
    doc.rev = 1;
    current.notes[id] = Note.parse(doc);
  }
  const asRead = structuredClone(current);
  for (const [id, item] of Object.entries(current.items)) {
    const readAt = itemRead(id);
    const read = reads[`it:${id}`];
    const snapshotApplies = read?.snap !== undefined && readAt !== undefined && !later(readAt, time(read.at));
    const changed = later(item.updated, readAt);
    if (!changed && !snapshotApplies) continue;
    if (!read) { delete asRead.items[id]; report("Exclude new item from as-read state", id); continue; }
    if (!readAt) throw new Error(`Read ${id} lacks an at time`);
    const old: Raw = structuredClone(item);
    if (snapshotApplies) {
      const snap = object(read.snap);
      for (const field of ["title", "data", "status", "priority"]) if (Object.hasOwn(snap, field)) {
        if (snap[field] === "" || snap[field] === undefined) delete old[field];
        else old[field] = snap[field];
      }
      if (snap.head !== undefined || snap.text !== undefined) old.head = z.string().parse(snap.head ?? snap.text);
      if (snap.deps !== undefined) old.deps = z.array(z.string()).parse(snap.deps).map(signature => {
        const split = signature.indexOf("\u0001");
        if (split < 1) throw new Error(`Read ${id} has invalid dependency signature`);
        const target = signature.slice(0, split), why = signature.slice(split + 1);
        return !Object.hasOwn(items, target) && Object.hasOwn(decisions, target) ? { card: target, why } : { id: target, why };
      });
    }
    // A snapshot's stored status/priority are retained even for a current
    // parent: they are historical evidence, not its current derived values.
    old.log = item.log.filter(entry => !later(entry.at, readAt));
    old.title ??= `（缺标题）${id}`;
    if (changed) old.updated = readAt;
    asRead.items[id] = Item.parse(old);
    report("Reconstruct changed item as read", id);
  }
  for (const [id, card] of Object.entries(current.decisions)) {
    const readAt = itemRead(card.item);
    const snap = reads[`it:${card.item}`]?.snap === undefined ? undefined : object(reads[`it:${card.item}`]!.snap);
    const seen = Array.isArray(snap?.qs) ? z.array(z.string()).parse(snap.qs) : undefined;
    const currentQs = items[card.item]?.qs;
    const addedSinceSnapshot = seen !== undefined && !seen.includes(id) && Array.isArray(currentQs) && currentQs.includes(id);
    // qs proves an undated card already existed at that read. Otherwise date
    // it from the earliest update/note evidence, or the export checkpoint.
    const noteTimes = Object.values(notes).filter(n => n.target === `q:${id}`).map(n => time(n.at)!).sort((a, b) => Date.parse(a) - Date.parse(b));
    const evidence = [time(decisions[id]!.updated), ...noteTimes].filter((t): t is string => t !== undefined).sort((a,b) => Date.parse(a) - Date.parse(b))[0];
    const dated = card.at ?? (seen?.includes(id) ? undefined : evidence ?? exportedAt);
    if ((dated && later(dated, readAt)) || (addedSinceSnapshot && (!readAt || !later(readAt, time(reads[`it:${card.item}`]?.at))))) {
      delete asRead.decisions[id]; report("Exclude new card from as-read state", id);
    }
  }
  for (const [id, note] of Object.entries(asRead.notes)) {
    const readAt = latest(time(reads[note.target]?.at), allRead);
    if (note.reply && note.repliedAt && later(note.repliedAt, readAt)) {
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
  // The changes since the read land one document per commit, oldest first, so the owner reads them as separate
  // steps in time order; a document the read state already matches makes no commit.
  const timeOf = (kind: DocKind, doc: Item | Decision | Note | undefined) => !doc ? "" : kind === "note" ? (doc as Note).repliedAt ?? (doc as Note).sentAt ?? (doc as Note).at : (doc as Item | Decision).updated;
  const changes: Array<{ kind: DocKind; id: string; at: string }> = [];
  for (const [kind, collection] of [["item", "items"], ["decision", "decisions"], ["note", "notes"]] as const) {
    for (const id of new Set([...Object.keys(converted.asRead[collection]), ...Object.keys(converted.current[collection])]))
      changes.push({ kind, id, at: timeOf(kind, converted.current[collection][id] ?? converted.asRead[collection][id]) });
  }
  changes.sort((x, y) => x.at.localeCompare(y.at) || x.kind.localeCompare(y.kind) || x.id.localeCompare(y.id));
  let currentCommit = asReadCommit;
  for (const { kind, id } of changes) {
    const collection = ({ item: "items", decision: "decisions", note: "notes" } as const)[kind];
    const existing = store.snapshot()[collection][id], doc = converted.current[collection][id];
    const txn = doc ? { puts: [{ kind, id, doc, expectRev: existing ? existing.rev : null }] } : { deletes: [{ kind, id, expectRev: existing!.rev }] };
    currentCommit = (await store.commit({ author: "migration", message: `Import ${kind} ${id} as changed since the owner's last read`, ...txn })).commit;
  }
  store.setOwner({ cursor: asReadCommit, archived: converted.owner.archived });
  return { asReadCommit, currentCommit };
}
