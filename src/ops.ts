import { z } from "zod";
import { Key, Item, Decision, Note } from "./model.ts";
import type { Dep, Link, Option, Priority, Snapshot, Status } from "./model.ts";
import { Store, ConflictError, ValidationError } from "./store.ts";
import type { Put } from "./store.ts";
import { rules } from "./rules.ts";
import { describeChanges } from "./query.ts";

export class OpError extends Error {}
export interface Result { commit: string; id: string; rev: number; summary: string }
export interface Ops {
  createItem(a: { author: string; key: string; parent?: string; title: string; head?: string; priority?: Priority; status?: Status; deps?: Dep[]; parentWhy?: string; parentOwnWork?: { key: string; title: string }; links?: Link[]; data?: string; agent?: string; group?: string; short?: string; order?: number }): Promise<Result>;
  appendLog(a: { author: string; id: string; text: string }): Promise<Result>;
  updateItem(a: { author: string; id: string; rev: number; title?: string; head?: string; reason?: string; deps?: Dep[]; links?: Link[]; priority?: Priority; data?: string | null; order?: number; agent?: string | null; short?: string | null }): Promise<Result>;
  setStatus(a: { author: string; id: string; status: Status; log: string }): Promise<Result>;
  moveItem(a: { author: string; id: string; parent: string; parentWhy: string }): Promise<Result>;
  setAsk(a: { author: string; id: string; text: string; url?: string; chat?: boolean }): Promise<Result>;
  clearAsk(a: { author: string; id: string; log: string }): Promise<Result>;
  writeCard(a: { author: string; key: string; rev?: number; item: string; question: string; background: string; options: Option[]; confidence?: { score: number; reason: string } }): Promise<Result>;
  ruleCard(a: { author: string; key: string; choice?: string; ruling: string }): Promise<Result>;
  replyNote(a: { author: string; id: string; reply: string }): Promise<Result>;
}

// Shared across Ops instances: validation and multi-document writes are one
// operation. Store.commit still checks revisions against other store callers.
const queues = new WeakMap<Store, Promise<unknown>>();
function nonempty(value: unknown, path = "input"): void {
  if (typeof value === "string" && !value.trim()) throw new OpError(`${path}: provide nonempty text after trimming`);
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) nonempty(child, `${path}.${key}`);
}
function parse<T>(schema: z.ZodType<T>, doc: unknown): T {
  const parsed = schema.safeParse(doc);
  if (!parsed.success) throw new OpError(parsed.error.issues.map(i => `${i.path.join(".") || "input"}: fix ${i.message}`).join("; "));
  return parsed.data;
}
function requireItem(s: Snapshot, id: string, field = "id"): Item {
  const it = Object.hasOwn(s.items, id) ? s.items[id] : undefined;
  if (!it) throw new OpError(`${field} ${id}: choose an existing item`);
  return it;
}
function requireCard(s: Snapshot, key: string): Decision {
  const card = Object.hasOwn(s.decisions, key) ? s.decisions[key] : undefined;
  if (!card) throw new OpError(`key ${key}: choose an existing decision card`);
  return card;
}
function newKey(s: Snapshot, key: string): void {
  if (!Key.safeParse(key).success) throw new OpError("key: use 1–200 letters, digits, dots, underscores or hyphens, starting with a letter or digit");
  if (Object.hasOwn(s.items, key) || Object.hasOwn(s.decisions, key)) throw new OpError(`key ${key}: already used; choose a new item or decision key`);
}
function depsExist(s: Snapshot, deps: Dep[]): void {
  for (const [i, dep] of deps.entries()) {
    const exists = "id" in dep ? Object.hasOwn(s.items, dep.id) : Object.hasOwn(s.decisions, dep.card);
    if (!exists) throw new OpError(`deps.${i}: choose an existing item (id) or decision (card)`);
    if (!dep.why.trim()) throw new OpError(`deps.${i}.why: explain what this dependency is needed for`);
  }
}

export function ops(store: Store, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z")): Ops {
  async function stale(kind: "item" | "decision", id: string, rev: number, current: Item | Decision): Promise<never> {
    let before: unknown = null;
    for (const commit of await store.log({ kind, id })) {
      const doc = await store.show(kind, id, commit.commit) as Item | Decision | null;
      if (doc?.rev === rev) { before = doc; break; }
    }
    throw new OpError(`rev ${rev}: current rev ${current.rev}; ${before ? describeChanges(before, current, kind) : "previous revision unavailable; " + currentTitle(current)}. Read context and redo with current rev ${current.rev}`);
  }
  function currentTitle(doc: Item | Decision): string { return ("title" in doc ? doc.title : doc.question).replace(/\s+/g, " ").slice(0, 100); }
  async function revision(kind: "item" | "decision", id: string, rev: number, doc: Item | Decision): Promise<void> {
    if (!Number.isSafeInteger(rev) || rev < 1) throw new OpError("rev: provide the positive integer revision read from context");
    if (rev !== doc.rev) await stale(kind, id, rev, doc);
  }
  function run(a: { author: string }, make: (s: Snapshot, at: string) => Promise<{ id: string; kind: Put["kind"]; message: string; puts: Put[] }> | { id: string; kind: Put["kind"]; message: string; puts: Put[] }, overwrite = false): Promise<Result> {
    const task = (queues.get(store) ?? Promise.resolve()).then(async () => {
      nonempty(a);
      if (typeof a.author !== "string" || !a.author.trim() || /[<>\r\n\0]/.test(a.author)) throw new OpError("author: provide your session name without <, >, newlines or NUL");
      for (;;) {
        const s = store.snapshot();
        const work = await make(s, now());
        try {
          const result = await store.commit({ author: a.author, message: work.message, puts: work.puts });
          return { commit: result.commit, id: work.id, rev: result.revs[`${work.kind}:${work.id}`]!, summary: work.message };
        } catch (error) {
          if (error instanceof ConflictError) {
            if (!overwrite) continue;
            if (error.currentDoc && error.kind !== "note") await stale(error.kind, error.id, error.expectedRev!, error.currentDoc as Item | Decision);
            throw new OpError(`rev: ${error.message}; read context and redo`);
          }
          if (error instanceof ValidationError) throw new OpError(`${error.message}; fix the named fields`);
          throw error;
        }
      }
    });
    queues.set(store, task.catch(() => {}));
    return task;
  }
  const itemPut = (id: string, doc: Item): Put => ({ kind: "item", id, doc: parse(Item, doc), expectRev: doc.rev });
  const entry = (author: string, at: string, text: string) => ({ at, by: author, text });
  function edit(a: { author: string; id: string }, name: string, change: (it: Item, s: Snapshot, at: string) => Item | Promise<Item>, overwrite = false, suffix = ""): Promise<Result> {
    return run(a, async (s, at) => ({ id: a.id, kind: "item", message: `${name} ${a.id}${suffix}`, puts: [itemPut(a.id, await change(requireItem(s, a.id), s, at))] }), overwrite);
  }
  return {
    createItem: a => run(a, (s, at) => {
      newKey(s, a.key);
      if (!a.priority) throw new OpError("priority: new leaf requires P0, P1 or P2");
      if (!a.parent && (!a.agent || !a.group)) throw new OpError("agent and group: a new area requires its responsible session and project group");
      const { author: _author, key: _key, parentWhy: _why, parentOwnWork: _own, ...fields } = a;
      const doc = parse(Item, { ...fields, status: a.status ?? "todo", created: at, updated: at, rev: 1 });
      depsExist(s, doc.deps);
      const puts: Put[] = [{ kind: "item", id: a.key, doc, expectRev: null }];
      if (a.parent) {
        const parent = requireItem(s, a.parent, "parent");
        if (!a.parentWhy?.trim()) throw new OpError("parentWhy: explain what the parent needs this child for");
        let deps = [...parent.deps.filter(d => !("id" in d && d.id === a.key)), { id: a.key, why: a.parentWhy }];
        const next: Item = { ...parent, updated: at };
        // A leaf that gets its first sub-item becomes a parent, whose status and priority
        // are derived; its own work moves into a sub-item so nothing it said is lost.
        if (rules(s).isLeaf(a.parent)) {
          if (!a.parentOwnWork) throw new OpError(`parentOwnWork: ${a.parent} is a leaf (${parent.status ?? "todo"} ${parent.priority ?? ""}); with a first sub-item its status becomes derived. Give parentOwnWork {key, title} for a sub-item that takes over its own work, status and priority, in the same commit`);
          newKey(s, a.parentOwnWork.key);
          if (a.parentOwnWork.key === a.key) throw new OpError("parentOwnWork.key: choose a key other than the new item's");
          const own = parse(Item, { title: a.parentOwnWork.title, parent: a.parent, status: parent.status ?? "todo", priority: parent.priority ?? a.priority, created: at, updated: at, rev: 1,
            log: [entry(a.author, at, `接过 ${a.parent} 自己的工作（原状态 ${parent.status ?? "todo"}，优先级 ${parent.priority ?? "未设"}）。`)] });
          puts.push({ kind: "item", id: a.parentOwnWork.key, doc: own, expectRev: null });
          deps = [...deps, { id: a.parentOwnWork.key, why: "它自己的工作" }];
          delete next.status; delete next.priority;
          next.log = [...parent.log, entry(a.author, at, `加了子条目 ${a.key}；自己的工作移到 ${a.parentOwnWork.key}。`)];
        } else if (a.parentOwnWork) throw new OpError(`parentOwnWork: ${a.parent} already has sub-items; omit parentOwnWork`);
        puts.push(itemPut(a.parent, { ...next, deps }));
      }
      return { id: a.key, kind: "item", message: `create_item ${a.key}`, puts };
    }),
    appendLog: a => edit(a, "append_log", (it, _s, at) => ({ ...it, updated: at, log: [...it.log, entry(a.author, at, a.text)] })),
    updateItem: a => edit(a, "update_item", async (it, s, at) => {
      await revision("item", a.id, a.rev, it);
      const changedHead = a.head !== undefined && a.head !== it.head;
      if (changedHead && !a.reason?.trim()) throw new OpError("reason: explain why head changed");
      const doc = { ...it, updated: at };
      for (const key of ["title", "head", "deps", "links", "priority", "data", "order", "agent", "short"] as const) {
        const value = a[key];
        if (value === null) delete doc[key];
        else if (value !== undefined) Object.assign(doc, { [key]: value });
      }
      const validated = parse(Item, doc);
      depsExist(s, validated.deps);
      if (changedHead) validated.log.push(entry(a.author, at, `改了 head：${a.reason}`));
      return validated;
    }, true),
    setStatus: a => edit(a, `set_status`, (it, s, at) => {
      const r = rules(s);
      if (!r.isLeaf(a.id)) throw new OpError(`status: ${a.id}'s status is derived from its sub-items (${r.children(a.id).sort(r.compareSiblings).map(c => `${c} ${r.statusOf(c)}`).join(", ")}); put its own work in a sub-item and set that leaf's status`);
      if (a.status === "blocked" && !r.depsOf(a.id).some(d => d.open) && !it.ask) throw new OpError("status blocked: add at least one open dependency or an ask");
      return { ...it, updated: at, status: a.status, log: [...it.log, entry(a.author, at, a.log)] };
    }, false, ` ${a.status}`),
    moveItem: a => run(a, (s, at) => {
      const it = requireItem(s, a.id), parent = requireItem(s, a.parent, "parent");
      if (!a.parentWhy?.trim()) throw new OpError("parentWhy: explain what the new parent needs this child for");
      if (a.id === a.parent || rules(s).ancestors(a.parent).includes(a.id)) throw new OpError("parent: choose a parent other than this item or its descendants (no cycle)");
      const old = it.parent;
      const puts = [itemPut(a.id, { ...it, parent: a.parent, updated: at, log: [...it.log, entry(a.author, at, `从 ${old ?? "（顶层）"} 移到 ${a.parent}：${a.parentWhy}`)] })];
      if (old && old !== a.parent) {
        const previous = requireItem(s, old, "parent");
        puts.push(itemPut(old, { ...previous, updated: at, deps: previous.deps.filter(d => !("id" in d && d.id === a.id)) }));
      }
      puts.push(itemPut(a.parent, { ...parent, updated: at, deps: [...parent.deps.filter(d => !("id" in d && d.id === a.id)), { id: a.id, why: a.parentWhy }] }));
      return { id: a.id, kind: "item", message: `move_item ${a.id}`, puts };
    }),
    setAsk: a => edit(a, "set_ask", (it, _s, at) => ({ ...it, updated: at, ask: { text: a.text, ...(a.url !== undefined ? { url: a.url } : {}), ...(a.chat !== undefined ? { chat: a.chat } : {}) } })),
    clearAsk: a => edit(a, "clear_ask", (it, _s, at) => {
      const doc = { ...it, updated: at, log: [...it.log, entry(a.author, at, a.log)] };
      delete doc.ask;
      return doc;
    }),
    writeCard: a => run(a, async (s, at) => {
      requireItem(s, a.item, "item");
      let previous: Decision | undefined;
      if (a.rev !== undefined) {
        previous = requireCard(s, a.key);
        await revision("decision", a.key, a.rev, previous);
        if (previous.status !== "open") throw new OpError("status: only an open card can be revised; create a new card");
      } else newKey(s, a.key);
      const { author: _author, key: _key, rev: _rev, ...fields } = a;
      const doc = parse(Decision, { ...previous, ...fields, status: "open", at: previous?.at ?? at, updated: at, rev: previous?.rev ?? 1 });
      if (doc.options.filter(o => o.recommended).length > 1) throw new OpError("options.recommended: recommend at most one option");
      if (new Set(doc.options.map(o => o.key)).size !== doc.options.length) throw new OpError("options.key: give each option a unique key");
      return { id: a.key, kind: "decision", message: `write_card ${a.key}`, puts: [{ kind: "decision", id: a.key, doc, expectRev: previous?.rev ?? null }] };
    }, a.rev !== undefined),
    ruleCard: a => run(a, (s, at) => {
      const card = requireCard(s, a.key);
      if (card.status !== "open") throw new OpError("status: only an open card can be ruled");
      if (a.choice !== undefined && !card.options.some(o => o.key === a.choice)) throw new OpError("choice: use an option key from this card, or omit choice for a prose ruling");
      const doc = parse(Decision, { ...card, status: "ruled", choice: a.choice, ruling: a.ruling, ruledAt: at, updated: at });
      return { id: a.key, kind: "decision", message: `rule_card ${a.key}`, puts: [{ kind: "decision", id: a.key, doc, expectRev: card.rev }] };
    }),
    replyNote: a => run(a, (s, at) => {
      const note = Object.hasOwn(s.notes, a.id) ? s.notes[a.id] : undefined;
      if (!note) throw new OpError(`id ${a.id}: choose an existing note`);
      const doc = parse(Note, { ...note, reply: a.reply, repliedAt: at, repliedBy: a.author, state: "done" });
      return { id: a.id, kind: "note", message: `reply_note ${a.id}`, puts: [{ kind: "note", id: a.id, doc, expectRev: note.rev }] };
    }),
  };
}
