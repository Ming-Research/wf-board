import { z } from "zod";
import { Key, Item, Decision, Note, Board } from "./model.ts";
import type { Dep, Link, Option, Priority, Snapshot, Status } from "./model.ts";
import { Store, ConflictError, ValidationError } from "./store.ts";
import type { Put } from "./store.ts";
import { rules } from "./rules.ts";
import { describeChanges } from "./query.ts";

export class OpError extends Error {}
export interface Result { commit: string; id: string; rev?: number; summary: string }
export interface Ops {
  createProject(a: { author: string; name: string; repo?: string }): Promise<Result>;
  claimProject(a: { author: string; project: string; replace?: string[]; reason?: string }): Promise<Result>;
  createRequest(a: { author: string; project: string; key: string; title: string; head: string; priority: Priority; why: string; from?: string }): Promise<Result>;
  triageRequest(a: { author: string; id: string; parent?: string; parentWhy?: string; parentOwnWork?: { key: string; title: string }; priority?: Priority; log: string }): Promise<Result>;
  closeNote(a: { author: string; id: string; log: string }): Promise<Result>;
  createItem(a: { author: string; key: string; parent?: string; title: string; head?: string; priority?: Priority; status?: Status; deps?: Dep[]; parentWhy?: string; parentOwnWork?: { key: string; title: string }; links?: Link[]; data?: string; group?: string; order?: number }): Promise<Result>;
  appendLog(a: { author: string; id: string; text: string }): Promise<Result>;
  updateItem(a: { author: string; id: string; rev: number; title?: string; head?: string; reason?: string; deps?: Dep[]; links?: Link[]; priority?: Priority; data?: string | null; order?: number }): Promise<Result>;
  setStatus(a: { author: string; id: string; status: Status; log: string }): Promise<Result>;
  moveItem(a: { author: string; id: string; parent: string; parentWhy: string; parentOwnWork?: { key: string; title: string }; sourceStatus?: Status; sourcePriority?: Priority }): Promise<Result>;
  setAsk(a: { author: string; id: string; text: string; url?: string; chat?: boolean }): Promise<Result>;
  clearAsk(a: { author: string; id: string; log: string }): Promise<Result>;
  writeCard(a: { author: string; key: string; rev?: number; item: string; question: string; background: string; options: Option[]; confidence?: { score?: number; reason: string } }): Promise<Result>;
  ruleCard(a: { author: string; key: string; choice?: string; ruling: string }): Promise<Result>;
  replyNote(a: { author: string; id: string; reply: string; replace?: boolean }): Promise<Result>;
}

// Shared across Ops instances: validation and multi-document writes are one
// operation. Store.commit still checks revisions against other store callers.
const queues = new WeakMap<Store, Promise<unknown>>();
function nonempty(value: unknown, path = "input"): void {
  if (/\.deps\.\d+\.why$/.test(path)) return; // dependency reasons are checked by the shared board rules
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

interface Work { id: string; kind: Put["kind"] | "board"; message: string; puts: Put[]; board?: Board }
function requireProject(s: Snapshot, name: string) {
  const project = s.board.projects.find(p => p.name === name);
  if (!project) throw new OpError(`project ${name}: choose a configured project with projects`);
  return project;
}
function member(s: Snapshot, project: string, author: string, id: string): void {
  const agents = s.board.projects.find(p => p.name === project)?.agents ?? [];
  if (!agents.includes(author)) throw new OpError(`item ${id} belongs to project ${project} (agents: ${agents.join(", ")}); file a request into ${project} with create_request instead`);
}
function ownedItem(s: Snapshot, id: string, author: string, field = "id"): Item {
  const it = requireItem(s, id, field);
  member(s, rules(s).projectOf(id), author, id);
  return it;
}
function ownedNote(s: Snapshot, id: string, author: string): { note: Note; item: string } {
  const note = Object.hasOwn(s.notes, id) ? s.notes[id] : undefined;
  if (!note) throw new OpError(`id ${id}: choose an existing note`);
  const item = note.target.startsWith("it:") ? note.target.slice(3) : requireCard(s, note.target.slice(2)).item;
  ownedItem(s, item, author);
  return { note, item };
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
  function run(a: { author: string }, make: (s: Snapshot, at: string) => Promise<Work> | Work, overwrite = false): Promise<Result> {
    const task = (queues.get(store) ?? Promise.resolve()).then(async () => {
      nonempty(a);
      if (typeof a.author !== "string" || !a.author.trim() || /[<>\r\n\0]/.test(a.author)) throw new OpError("author: provide your session name without <, >, newlines or NUL");
      for (;;) {
        const s = store.snapshot();
        const work = await make(s, now());
        // Validate the prospective board, including indirect effects on children,
        // dependents and items whose owner actions a card/note write changes.
        const next = structuredClone(s);
        if (work.board) next.board = parse(Board, work.board);
        for (const put of work.puts) {
          if (put.kind === "item") next.items[put.id] = parse(Item, put.doc);
          else if (put.kind === "decision") next.decisions[put.id] = parse(Decision, put.doc);
          else next.notes[put.id] = parse(Note, put.doc);
        }
        const beforeRules = rules(s), afterRules = rules(next);
        const required = /^(卡住了，但没写在等什么|上级没有把它列在依赖里|依赖的条目不存在|依赖的决策卡不存在|依赖没写为什么)/;
        for (const id of Object.keys(next.items)) {
          const oldChecks = new Set(beforeRules.checks(id).map(c => JSON.stringify(c)));
          for (const check of afterRules.checks(id)) {
            if (required.test(check.text) && !oldChecks.has(JSON.stringify(check))) throw new OpError(`item ${id}: "${check.text}"${check.target ? ` ${check.target.id}` : ""}`);
          }
        }
        try {
          const result = await store.commit({ author: a.author, message: work.message, puts: work.puts, board: work.board });
          return { commit: result.commit, id: work.id, ...(work.kind === "board" ? {} : { rev: result.revs[`${work.kind}:${work.id}`]! }), summary: work.message };
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
    return run(a, async (s, at) => ({ id: a.id, kind: "item", message: `${name} ${a.id}${suffix}`, puts: [itemPut(a.id, await change(ownedItem(s, a.id, a.author), s, at))] }), overwrite);
  }
  function addChild(s: Snapshot, at: string, author: string, parentId: string, childId: string, why: string, ownWork: { key: string; title: string } | undefined, priority: Priority | undefined, puts: Put[]): void {
    const parent = requireItem(s, parentId, "parent");
    let deps = [...parent.deps.filter(d => !("id" in d && d.id === childId)), { id: childId, why }];
    const next: Item = { ...parent, updated: at };
    if (rules(s).isLeaf(parentId)) {
      if (!ownWork) throw new OpError(`parentOwnWork: ${parentId} is a leaf (${parent.status ?? "todo"} ${parent.priority ?? ""}); with a first sub-item its status becomes derived. Give parentOwnWork {key, title} for a sub-item that takes over its own work, status and priority, in the same commit`);
      newKey(s, ownWork.key);
      if (ownWork.key === childId) throw new OpError("parentOwnWork.key: choose a key other than the new item's");
      const own = parse(Item, { title: ownWork.title, parent: parentId, status: parent.status ?? "todo", priority: parent.priority ?? priority, created: at, updated: at, rev: 1,
        log: [entry(author, at, `接过 ${parentId} 自己的工作（原状态 ${parent.status ?? "todo"}，优先级 ${parent.priority ?? "未设"}）。`)] });
      puts.push({ kind: "item", id: ownWork.key, doc: own, expectRev: null });
      deps = [...deps, { id: ownWork.key, why: "它自己的工作" }];
      delete next.status; delete next.priority;
      next.log = [...parent.log, entry(author, at, `加了子条目 ${childId}；自己的工作移到 ${ownWork.key}。`)];
    } else if (ownWork) throw new OpError(`parentOwnWork: ${parentId} already has sub-items; omit parentOwnWork`);
    puts.push(itemPut(parentId, { ...next, deps }));
  }
  return {
    createProject: a => run(a, s => {
      if (s.board.projects.some(p => p.name === a.name)) throw new OpError(`project ${a.name}: already exists`);
      const board = parse(Board, { ...s.board, projects: [...s.board.projects, { name: a.name, agents: [a.author], ...(a.repo === undefined ? {} : { repo: a.repo }) }] });
      return { id: a.name, kind: "board", board, puts: [], message: `create_project ${a.name} ${a.author}` };
    }),
    claimProject: a => run(a, s => {
      const project = requireProject(s, a.project);
      if (project.agents.includes(a.author)) throw new OpError(`project ${a.project}: ${a.author} already listed`);
      if (a.replace !== undefined && !a.reason?.trim()) throw new OpError("reason: explain the replacement");
      for (const agent of a.replace ?? []) if (!project.agents.includes(agent)) throw new OpError(`replace ${agent}: must be listed in project ${a.project}`);
      const updated = { ...project, agents: [...project.agents.filter(n => !a.replace?.includes(n)), a.author] };
      const board = { ...s.board, projects: s.board.projects.map(p => p.name === a.project ? updated : p) };
      return { id: a.project, kind: "board", board, puts: [], message: `claim_project ${a.project} ${a.author}` + (a.reason ? `\n\n${a.reason}` : "") };
    }),
    createRequest: a => run(a, (s, at) => {
      requireProject(s, a.project); newKey(s, a.key);
      if (!a.priority) throw new OpError("priority: new request requires P0, P1 or P2");
      const doc = parse(Item, { title: a.title, group: a.project, head: a.head, priority: a.priority, status: "todo", request: { by: a.author, at }, created: at, updated: at, rev: 1, log: [entry(a.author, at, `${a.author} 提出：${a.why}`)] });
      const puts: Put[] = [{ kind: "item", id: a.key, doc, expectRev: null }];
      if (a.from) {
        const from = ownedItem(s, a.from, a.author, "from");
        puts.push(itemPut(a.from, { ...from, updated: at, deps: [...from.deps, { id: a.key, why: a.why }] }));
      }
      return { id: a.key, kind: "item", puts, message: `create_request ${a.key}` };
    }),
    triageRequest: a => run(a, (s, at) => {
      const it = ownedItem(s, a.id, a.author), r = rules(s);
      if (!it.request || !r.isRequest(a.id)) throw new OpError(`item ${a.id}: not an open request`);
      const doc = { ...it, updated: at, priority: a.priority ?? it.priority, log: [...it.log] };
      delete doc.request;
      const puts: Put[] = [];
      if (a.parent) {
        ownedItem(s, a.parent, a.author, "parent");
        if (r.projectOf(a.parent) !== r.projectOf(a.id)) throw new OpError("parent: triage a request within its project");
        if (a.parent === a.id || r.ancestors(a.parent).includes(a.id)) throw new OpError("parent: no cycle");
        if (!a.parentWhy?.trim()) throw new OpError("parentWhy: explain what the parent needs this request for");
        doc.parent = a.parent;
        doc.log.push(entry(a.author, at, `分拣：放到 ${a.parent}：${a.parentWhy}`));
        addChild(s, at, a.author, a.parent, a.id, a.parentWhy, a.parentOwnWork, doc.priority, puts);
      } else if (a.parentOwnWork || a.parentWhy) throw new OpError("parent: required with parentWhy or parentOwnWork");
      doc.log.push(entry(a.author, at, a.log));
      puts.push(itemPut(a.id, doc));
      return { id: a.id, kind: "item", puts, message: `triage_request ${a.id}` };
    }),
    closeNote: a => run(a, (s, at) => {
      const { note, item } = ownedNote(s, a.id, a.author);
      if (note.state === "draft") throw new OpError(`note ${a.id}: cannot close a draft note`);
      const it = requireItem(s, item);
      return { id: a.id, kind: "note", message: `close_note ${a.id}`, puts: [
        { kind: "note", id: a.id, expectRev: note.rev, doc: { ...note, state: "done", repliedAt: at, repliedBy: a.author } },
        itemPut(item, { ...it, updated: at, log: [...it.log, entry(a.author, at, `关闭评论：${a.log}`)] }),
      ] };
    }),
    createItem: a => run(a, (s, at) => {
      newKey(s, a.key);
      if (!a.priority) throw new OpError("priority: new leaf requires P0, P1 or P2");
      if (a.parent) ownedItem(s, a.parent, a.author, "parent");
      else {
        if (!a.group) throw new OpError("group: a new area requires its project");
        requireProject(s, a.group); member(s, a.group, a.author, a.key);
      }
      const { author: _author, key: _key, parentWhy: _why, parentOwnWork: _own, ...fields } = a;
      const doc = parse(Item, { ...fields, status: a.status ?? "todo", created: at, updated: at, rev: 1 });
      const puts: Put[] = [{ kind: "item", id: a.key, doc, expectRev: null }];
      if (a.parent) {
        requireItem(s, a.parent, "parent");
        if (!a.parentWhy?.trim()) throw new OpError("parentWhy: explain what the parent needs this child for");
        addChild(s, at, a.author, a.parent, a.key, a.parentWhy, a.parentOwnWork, a.priority, puts);
      }
      return { id: a.key, kind: "item", message: `create_item ${a.key}`, puts };
    }),
    appendLog: a => edit(a, "append_log", (it, _s, at) => ({ ...it, updated: at, log: [...it.log, entry(a.author, at, a.text)] })),
    updateItem: a => edit(a, "update_item", async (it, s, at) => {
      await revision("item", a.id, a.rev, it);
      const changedHead = a.head !== undefined && a.head !== it.head;
      if (changedHead && !a.reason?.trim()) throw new OpError("reason: explain why head changed");
      const doc = { ...it, updated: at };
      for (const key of ["title", "head", "deps", "links", "priority", "data", "order"] as const) {
        const value = a[key];
        if (value === null) delete doc[key];
        else if (value !== undefined) Object.assign(doc, { [key]: value });
      }
      const validated = parse(Item, doc);
      if (changedHead) validated.log.push(entry(a.author, at, `改了 head：${a.reason}`));
      return validated;
    }, true),
    setStatus: a => edit(a, `set_status`, (it, s, at) => {
      const r = rules(s);
      if (!r.isLeaf(a.id)) throw new OpError(`status: ${a.id}'s status is derived from its sub-items (${r.children(a.id).sort(r.compareSiblings).map(c => `${c} ${r.statusOf(c)}`).join(", ")}); put its own work in a sub-item and set that leaf's status`);
      if (a.status === "blocked" && !r.depsOf(a.id).some(d => d.open) && !r.needsOwner(a.id)) throw new OpError(`item ${a.id}: "${r.depsOf(a.id).length ? "可解除阻塞：等的都已完成" : "卡住了，但没写在等什么"}"; status blocked: add at least one open dependency or an ask`);
      const doc = { ...it, updated: at, status: a.status, log: [...it.log, entry(a.author, at, a.log)] };
      if (a.status === "cancelled") delete doc.request;
      return doc;
    }, false, ` ${a.status}`),
    moveItem: a => run(a, (s, at) => {
      const it = ownedItem(s, a.id, a.author);
      ownedItem(s, a.parent, a.author, "parent");
      if (it.request && rules(s).projectOf(a.id) !== rules(s).projectOf(a.parent)) throw new OpError("parent: triage a request within its project");
      if (!a.parentWhy?.trim()) throw new OpError("parentWhy: explain what the new parent needs this child for");
      if (a.id === a.parent || rules(s).ancestors(a.parent).includes(a.id)) throw new OpError("parent: choose a parent other than this item or its descendants (no cycle)");
      const old = it.parent;
      const doc = { ...it, parent: a.parent, updated: at, log: [...it.log, entry(a.author, at, it.request ? `分拣：放到 ${a.parent}：${a.parentWhy}` : `从 ${old ?? "（顶层）"} 移到 ${a.parent}：${a.parentWhy}`)] };
      delete doc.request;
      const puts = [itemPut(a.id, doc)];
      if (old && old !== a.parent) {
        const previous = requireItem(s, old, "parent");
        const next = { ...previous, updated: at, deps: previous.deps.filter(d => !("id" in d && d.id === a.id)) };
        if (rules(s).children(old).length === 1) {
          if (!a.sourceStatus || !a.sourcePriority) throw new OpError(`sourceStatus and sourcePriority: ${old} loses its last sub-item; specify its leaf status and priority`);
          next.status = a.sourceStatus; next.priority = a.sourcePriority;
          next.log = [...previous.log, entry(a.author, at, `最后一个子条目 ${a.id} 移走；恢复为叶条目，状态 ${a.sourceStatus}，优先级 ${a.sourcePriority}。`)];
        }
        puts.push(itemPut(old, next));
      }
      addChild(s, at, a.author, a.parent, a.id, a.parentWhy, a.parentOwnWork, it.priority, puts);
      return { id: a.id, kind: "item", message: `move_item ${a.id}`, puts };
    }),
    setAsk: a => edit(a, "set_ask", (it, _s, at) => ({ ...it, updated: at, ask: { text: a.text, ...(a.url !== undefined ? { url: a.url } : {}), ...(a.chat !== undefined ? { chat: a.chat } : {}) } })),
    clearAsk: a => edit(a, "clear_ask", (it, _s, at) => {
      const doc = { ...it, updated: at, log: [...it.log, entry(a.author, at, a.log)] };
      delete doc.ask;
      return doc;
    }),
    writeCard: a => run(a, async (s, at) => {
      ownedItem(s, a.item, a.author, "item");
      let previous: Decision | undefined;
      if (a.rev !== undefined) {
        previous = requireCard(s, a.key);
        ownedItem(s, previous.item, a.author);
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
      ownedItem(s, card.item, a.author);
      if (card.status !== "open") throw new OpError("status: only an open card can be ruled");
      if (a.choice !== undefined && !card.options.some(o => o.key === a.choice)) throw new OpError("choice: use an option key from this card, or omit choice for a prose ruling");
      const doc = parse(Decision, { ...card, status: "ruled", choice: a.choice, ruling: a.ruling, ruledAt: at, updated: at });
      return { id: a.key, kind: "decision", message: `rule_card ${a.key}`, puts: [{ kind: "decision", id: a.key, doc, expectRev: card.rev }] };
    }),
    replyNote: a => run(a, (s, at) => {
      const { note } = ownedNote(s, a.id, a.author);
      if (note.reply !== undefined && a.replace !== true) throw new OpError(`note ${a.id}: already replied by ${note.repliedBy ?? "unknown author"} at ${note.repliedAt ?? "unknown time"}; use replace: true for a deliberate replacement`);
      const doc = parse(Note, { ...note, reply: a.reply, repliedAt: at, repliedBy: a.author, state: "done" });
      return { id: a.id, kind: "note", message: `reply_note ${a.id}`, puts: [{ kind: "note", id: a.id, doc, expectRev: note.rev }] };
    }),
  };
}
