import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { randomInt } from "node:crypto";
import { Key, Item, ItemStepInput, ItemStepsInput, ItemTargetInput, ItemTargetsInput, StepId, Decision, Note, Notice, Board, Glossary, GlossaryId, Term } from "./model.ts";
import type { Dep, ItemTarget, Link, Option, Priority, Snapshot, Status } from "./model.ts";
import { Store, ConflictError, ValidationError } from "./store.ts";
import type { Put } from "./store.ts";
import { rules, stampItemStep, stampItemTarget, projectOrderAfter } from "./rules.ts";
import { describeChanges } from "./query.ts";

export class OpError extends Error {}
/** `dropped`: items whose stored priority the write removed because they are migrated non-roots. */
export interface Result { commit: string; id: string; rev?: number; summary: string; dropped?: Array<{ id: string; priority: Priority }> }
type Source = { sourceStatus?: Status; sourcePriority?: Priority };
export interface Ops {
  createProject(a: { author: string; name: string; repo?: string; after?: string }): Promise<Result>;
  updateProject(a: { author: string; name: string; repo?: string; migrated?: boolean; after?: string }): Promise<Result>;
  createRequest(a: { author: string; project: string; key: string; title: string; head: string; priority?: Priority; why: string; from?: string }): Promise<Result>;
  triageRequest(a: { author: string; id: string; parent?: string; parentWhy?: string; parentOwnWork?: { key: string; title: string }; priority?: Priority; log: string }): Promise<Result>;
  closeNote(a: { author: string; id: string; log: string }): Promise<Result>;
  createItem(a: { author: string; key: string; parent?: string; title: string; head?: string; record?: boolean; priority?: Priority; status?: Status; deps?: Dep[]; parentWhy?: string; parentOwnWork?: { key: string; title: string }; links?: Link[]; data?: string; group?: string; order?: number; children?: Array<{ id: string; why: string }> } & Source): Promise<Result>;
  appendLog(a: { author: string; id: string; text: string }): Promise<Result>;
  setSteps(a: { author: string; id: string; steps?: ItemStepInput[]; step?: ItemStepInput; remove?: string }): Promise<Result>;
  setTargets(a: { author: string; id: string; targets?: ItemTargetInput[]; target?: ItemTargetInput; remove?: string }): Promise<Result>;
  updateItem(a: { author: string; id: string; rev: number; title?: string; head?: string; record?: boolean; parentOwnWork?: { key: string; title: string }; reason?: string; deps?: Dep[]; links?: Link[]; priority?: Priority; data?: string | null; order?: number }): Promise<Result>;
  setStatus(a: { author: string; id: string; status: Status; log: string }): Promise<Result>;
  moveItem(a: { author: string; id: string; parent?: string; parentWhy?: string; parentOwnWork?: { key: string; title: string }; priority?: Priority } & Source): Promise<Result>;
  clearAsk(a: { author: string; id: string; log: string }): Promise<Result>;
  writeCard(a: { author: string; key: string; rev?: number; item: string; question: string; background: string; options: Option[]; confidence?: { score?: number; reason: string }; blocks?: string | null }): Promise<Result>;
  postNotice(a: { author: string; text: string; item?: string }): Promise<Result>;
  ruleCard(a: { author: string; key: string; choice?: string; ruling: string }): Promise<Result>;
  replyNote(a: { author: string; id: string; reply: string; replace?: boolean }): Promise<Result>;
  setTerm(a: { author: string; term: string; definition: string }): Promise<Result>;
  deleteTerm(a: { author: string; term: string }): Promise<Result>;
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
/** In a migrated project only a root, an item no open item depends on, stores a priority; any other item's comes from its dependents. */
function derivedPriority(id: string, from: string[]): OpError {
  return new OpError(`priority: ${id} 有未完成的条目依赖它，它的优先级来自这些条目（${from.join("、")}），不能自己设；只有没有未完成条目依赖的根条目才写优先级`);
}
const openDependents = (r: ReturnType<typeof rules>, id: string): string[] => r.dependents(id).map(d => d.id).filter(d => r.statusOf(d) !== "done" && r.statusOf(d) !== "cancelled");
const migratedProject = (s: Snapshot, name: string | undefined): boolean => !!s.board.projects.find(p => p.name === name)?.migrated;
function newKey(s: Snapshot, key: string): void {
  if (!Key.safeParse(key).success) throw new OpError("key: use 1–200 letters, digits, dots, underscores or hyphens, starting with a letter or digit");
  if (Object.hasOwn(s.items, key) || Object.hasOwn(s.decisions, key)) throw new OpError(`key ${key}: already used; choose a new item or decision key`);
}

interface Work { id: string; kind: Put["kind"] | "board"; message: string; puts: Put[]; board?: Board; dropped?: Result["dropped"] }
/** A leaf with no work of its own: still todo, no steps or targets, and only its optional create_request log. */
const noOwnWork = (it: Item): boolean => (it.status ?? "todo") === "todo" &&
  !it.steps?.length && !it.targets?.length &&
  (!it.log.length || it.log.length === 1 && it.log[0]!.at === it.created && it.log[0]!.text.startsWith(`${it.log[0]!.by} 提出：`));
/** The document this operation already wrote for an item, else the snapshot's. */
function docOf(s: Snapshot, puts: Put[], id: string, field = "id"): Item {
  return (puts.find(p => p.kind === "item" && p.id === id)?.doc as Item | undefined) ?? requireItem(s, id, field);
}
/** An item's title for a log line the owner reads: this operation's own write if any, else the snapshot's; the key only for an item that does not exist. */
function titleOf(s: Snapshot, puts: Put[], id: string): string {
  return ((puts.find(p => p.kind === "item" && p.id === id)?.doc as Item | undefined) ?? s.items[id])?.title ?? id;
}
const STATUS_ZH: Record<Status, string> = { todo: "未开始", wip: "进行中", blocked: "卡住", done: "完成", cancelled: "取消" };
function putDoc(puts: Put[], put: Put): void {
  const i = puts.findIndex(p => p.kind === put.kind && p.id === put.id);
  if (i < 0) puts.push(put); else puts[i] = { ...put, expectRev: puts[i]!.expectRev };
}
function requireProject(s: Snapshot, name: string) {
  const project = s.board.projects.find(p => p.name === name);
  if (!project) throw new OpError(`project ${name}: choose a configured project with projects`);
  return project;
}
function projectOrder(projects: Board["projects"], a: { author: string; name: string; after?: string }): Board["projects"] {
  if (a.after === undefined) return projects;
  try { return projectOrderAfter(projects, a.name, a.after, a.author); }
  catch (error) { throw new OpError((error as Error).message); }
}
function requireAuthor(s: Snapshot, author: string, prefix = ""): void {
  if (!s.board.projects.some(p => p.name === author)) throw new OpError(`${prefix}author ${author}: choose a configured project (${s.board.projects.map(p => p.name).join(", ")}); call projects and use the project whose repo matches your repository`);
}
function requireOwnership(s: Snapshot, project: string, author: string, id: string): void {
  const refusal = `item ${id} belongs to project ${project}; file a request into ${project} with create_request instead`;
  requireAuthor(s, author, author === project ? "" : `${refusal}. `);
  if (author !== project) throw new OpError(refusal);
}
/** The author's own glossary, the only one it may change; an empty one when it has none yet. */
function ownGlossary(s: Snapshot, author: string): Glossary {
  requireAuthor(s, author);
  if (!GlossaryId.safeParse(author).success) throw new OpError(`author ${author}: a project whose name contains a slash or starts with a dot cannot keep a glossary file`);
  return s.glossaries[author] ?? { terms: [], rev: 1 };
}
function ownedItem(s: Snapshot, id: string, author: string, field = "id"): Item {
  const it = requireItem(s, id, field);
  requireOwnership(s, rules(s).projectOf(id), author, id);
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
  function run(a: { author: string }, make: (s: Snapshot, at: string) => Promise<Work> | Work, overwrite = false, anyAuthor = false): Promise<Result> {
    const task = (queues.get(store) ?? Promise.resolve()).then(async () => {
      nonempty(a);
      if (typeof a.author !== "string" || !a.author.trim() || /[<>\r\n\0]/.test(a.author)) throw new OpError("author: provide your project name without <, >, newlines or NUL");
      for (;;) {
        const s = store.snapshot(), at = now();
        const work = await make(s, at);
        if (!anyAuthor) requireAuthor(s, a.author);
        // Validate the prospective board, including indirect effects on children,
        // dependents and items whose owner actions a card/note write changes.
        const next = structuredClone(s);
        if (work.board) next.board = parse(Board, work.board);
        for (const put of work.puts) {
          if (put.kind === "item") next.items[put.id] = parse(Item, put.doc);
          else if (put.kind === "decision") next.decisions[put.id] = parse(Decision, put.doc);
          else if (put.kind === "notice") next.notices[put.id] = parse(Notice, put.doc);
          else if (put.kind === "glossary") next.glossaries[put.id] = parse(Glossary, put.doc);
          else next.notes[put.id] = parse(Note, put.doc);
        }
        const beforeRules = rules(s);
        let afterRules = rules(next);
        // In a migrated project a stored priority never outlives rootness: the write drops it from every non-root it writes or makes a non-root, and says so in that item's log.
        const written = new Set(work.puts.filter(p => p.kind === "item").map(p => p.id)), dropped = [...work.dropped ?? []];
        for (const [id, it] of Object.entries(next.items)) {
          if (!it.priority || !afterRules.migrated(id) || afterRules.isRoot(id) || !(written.has(id) || beforeRules.isRoot(id))) continue;
          const doc = { ...it, ...(written.has(id) ? {} : { updated: at }), log: [...it.log, { at, by: a.author, text: `不再是根：优先级改由依赖它的条目决定，原来写的 ${it.priority} 不再使用` }] };
          delete doc.priority;
          dropped.push({ id, priority: it.priority });
          next.items[id] = doc;
          const put = work.puts.find(p => p.kind === "item" && p.id === id);
          if (put) put.doc = doc; else work.puts.push({ kind: "item", id, doc, expectRev: it.rev });
        }
        afterRules = rules(next);
        const required = /^(卡住了，但没写在等什么|上级没有把它列在依赖里|依赖的条目不存在|依赖的决策卡不存在|依赖没写为什么)/;
        for (const id of Object.keys(next.items)) {
          const oldChecks = new Set(beforeRules.checks(id).map(c => JSON.stringify(c)));
          for (const check of afterRules.checks(id)) {
            if (required.test(check.text) && !oldChecks.has(JSON.stringify(check))) throw new OpError(`item ${id}: "${check.text}"${check.target ? ` ${check.target.id}` : ""}`);
          }
        }
        try {
          const result = await store.commit({ author: a.author, message: work.message, puts: work.puts, board: work.board });
          return { commit: result.commit, id: work.id, ...(work.kind === "board" ? {} : { rev: result.revs[`${work.kind}:${work.id}`]! }), summary: work.message, ...(dropped.length ? { dropped } : {}) };
        } catch (error) {
          if (error instanceof ConflictError) {
            if (!overwrite) continue;
            if (error.currentDoc && (error.kind === "item" || error.kind === "decision")) await stale(error.kind, error.id, error.expectedRev!, error.currentDoc as Item | Decision);
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
  // `emptyLeaf`: a migrated leaf parent without work of its own (noOwnWork) may take the child without an own-work sub-item (move_item).
  function addChild(s: Snapshot, at: string, author: string, parentId: string, childId: string, why: string, ownWork: { key: string; title: string } | undefined, priority: Priority | undefined, puts: Put[], emptyLeaf = false): void {
    const parent = docOf(s, puts, parentId, "parent"), migrated = rules(s).migrated(parentId);
    let deps = [...parent.deps.filter(d => !("id" in d && d.id === childId)), { id: childId, why }];
    const next: Item = { ...parent, updated: at };
    if (docOf(s, puts, childId).record) {
      if (ownWork) throw new OpError("parentOwnWork: adding a record does not move work status; omit parentOwnWork");
    } else if (parent.record) {
      if (ownWork) throw new OpError("parentOwnWork: a record has no work status to move; omit parentOwnWork");
    } else if (rules(s).isStatusLeaf(parentId) && !ownWork && emptyLeaf && migrated && noOwnWork(parent)) {
      delete next.status;
      if (!rules(s).isRoot(parentId)) delete next.priority;
      next.log = [...parent.log, entry(author, at, `加了子条目「${titleOf(s, puts, childId)}」；它自己没有工作，不另建自己的工作条目。`)];
    } else if (rules(s).isStatusLeaf(parentId)) {
      if (!ownWork) throw new OpError(migrated
        ? `parentOwnWork: ${parentId} is a leaf (${parent.status ?? "todo"}); with a first sub-item its status becomes derived. Give parentOwnWork {key, title} for a sub-item that takes over its own work and status, in the same commit`
        : `parentOwnWork: ${parentId} is a leaf (${parent.status ?? "todo"} ${parent.priority ?? ""}); with a first sub-item its status becomes derived. Give parentOwnWork {key, title} for a sub-item that takes over its own work, status and priority, in the same commit`); // LEGACY PRIORITY
      newKey(s, ownWork.key);
      if (ownWork.key === childId) throw new OpError("parentOwnWork.key: choose a key other than the new item's");
      // Migrated: the own-work sub-item is not a root, so its priority comes from the parent; a root parent keeps its own.
      const own = parse(Item, migrated
        ? { title: ownWork.title, parent: parentId, status: parent.status ?? "todo", created: at, updated: at, rev: 1,
          log: [entry(author, at, `接过「${parent.title}」自己的工作（原状态 ${STATUS_ZH[parent.status ?? "todo"]}）`)] }
        : { title: ownWork.title, parent: parentId, status: parent.status ?? "todo", priority: parent.priority ?? priority, created: at, updated: at, rev: 1, // LEGACY PRIORITY
          log: [entry(author, at, `接过「${parent.title}」自己的工作（原状态 ${STATUS_ZH[parent.status ?? "todo"]}，优先级 ${parent.priority ?? "未设"}）`)] });
      puts.push({ kind: "item", id: ownWork.key, doc: own, expectRev: null });
      deps = [...deps, { id: ownWork.key, why: "它自己的工作" }];
      delete next.status;
      if (!migrated || !rules(s).isRoot(parentId)) delete next.priority;
      next.log = [...parent.log, entry(author, at, `加了子条目「${titleOf(s, puts, childId)}」；它自己的工作移到新的子条目「${ownWork.title}」。`)];
    } else if (ownWork) throw new OpError(`parentOwnWork: ${parentId} already has sub-items; omit parentOwnWork`);
    putDoc(puts, itemPut(parentId, { ...next, deps }));
  }
  // Takes `ids` out of their current parents' deps. A parent left without sub-items becomes a leaf under the
  // source rules (sourceStatus, and sourcePriority as each project's rules allow); `keep` gains a sub-item in the same write, so it stays a parent.
  function detach(s: Snapshot, at: string, author: string, ids: string[], source: Source, puts: Put[], keep?: string): void {
    const r = rules(s), byParent = new Map<string, string[]>();
    for (const id of ids) { const old = s.items[id]!.parent; if (old) byParent.set(old, [...byParent.get(old) ?? [], id]); }
    for (const [old, moving] of byParent) {
      const previous = docOf(s, puts, old, "parent"), names = moving.map(id => `「${titleOf(s, puts, id)}」`).join("、"), emptied = old !== keep && moving.some(c => !s.items[c]?.record) && r.children(old).every(c => s.items[c]?.record || moving.includes(c));
      const next = { ...previous, updated: at, deps: previous.deps.filter(d => !("id" in d && moving.includes(d.id))) };
      if (emptied && previous.record) {
        delete next.status;
      } else if (emptied && !r.migrated(old)) { // LEGACY PRIORITY
        if (!source.sourceStatus || !source.sourcePriority) throw new OpError(`sourceStatus and sourcePriority: ${old} loses its last sub-item; specify its leaf status and priority`);
        next.status = source.sourceStatus; next.priority = source.sourcePriority;
        next.log = [...previous.log, entry(author, at, `最后一个子条目${names}移走；恢复为叶条目，状态 ${STATUS_ZH[source.sourceStatus]}，优先级 ${source.sourcePriority}。`)];
      } else if (emptied) {
        if (!source.sourceStatus) throw new OpError(`sourceStatus: ${old} loses its last sub-item; specify its leaf status`);
        if (source.sourcePriority && !r.isRoot(old)) throw derivedPriority(old, openDependents(r, old));
        next.status = source.sourceStatus;
        if (source.sourcePriority) next.priority = source.sourcePriority;
        next.log = [...previous.log, entry(author, at, `最后一个子条目${names}移走；恢复为叶条目，状态 ${STATUS_ZH[source.sourceStatus]}${source.sourcePriority ? `，优先级 ${source.sourcePriority}` : ""}。`)];
      }
      putDoc(puts, itemPut(old, next));
    }
  }
  // move_item without new_parent: a migrated item leaves its parent and becomes a root area of its own project.
  function toRoot(s: Snapshot, at: string, a: Parameters<Ops["moveItem"]>[0], it: Item): Work {
    const r = rules(s), old = it.parent;
    if (!r.migrated(a.id)) throw new OpError("new_parent: required; only a migrated project's item can become a root with move_item");
    if (!old) throw new OpError(`new_parent: ${a.id} is already top-level`);
    if (a.parentWhy || a.parentOwnWork) throw new OpError("new_parent: required with parentWhy or parentOwnWork");
    const others = openDependents(r, a.id).filter(d => d !== old);
    if (others.length) throw new OpError(`new_parent: ${a.id} 还有未完成的条目依赖它（${others.join("、")}），移出上级后也不是根条目；给它一个新上级，或先去掉这些依赖`);
    if (!a.priority) throw new OpError("priority: 移成根条目要写 P0、P1 或 P2");
    const doc = { ...it, group: r.projectOf(a.id), priority: a.priority, updated: at, log: [...it.log, entry(a.author, at, `从「${titleOf(s, [], old)}」下移出，成为根条目，优先级 ${a.priority}。`)] };
    delete doc.parent;
    const puts = [itemPut(a.id, doc)];
    detach(s, at, a.author, [a.id], a, puts);
    return { id: a.id, kind: "item", message: `move_item ${a.id}`, puts };
  }
  return {
    createProject: a => run(a, s => {
      if (s.board.projects.some(p => p.name === a.name)) throw new OpError(`project ${a.name}: already exists`);
      const projects = [...s.board.projects, { name: a.name, ...(a.repo === undefined ? {} : { repo: a.repo }) }];
      const board = parse(Board, { ...s.board, projects: projectOrder(projects, a) });
      return { id: a.name, kind: "board", board, puts: [], message: `create_project ${a.name} ${a.author}${a.after === undefined ? "" : ` after ${a.after}`}` };
    }, false, true),
    updateProject: a => run(a, (s, at) => {
      const project = requireProject(s, a.name);
      requireAuthor(s, a.author, `project ${a.name}: `);
      if (a.repo !== undefined || a.migrated === undefined && a.after === undefined) {
        if (a.author !== a.name && a.author !== "总管") throw new OpError(`project ${a.name}: only that project or 总管 may update its repo`);
        if (typeof a.repo !== "string") throw new OpError("repo: provide the repository identifier");
      }
      if (a.migrated !== undefined) {
        if (a.author !== "总管") throw new OpError(`migrated: only the coordinator project 总管 may migrate project ${a.name}`);
        if (a.migrated !== true) throw new OpError("migrated: a migration cannot be undone; only true is accepted");
        if (project.migrated) throw new OpError(`migrated: project ${a.name} is already migrated`);
      }
      const projects = s.board.projects.map(p => p.name === a.name ? { ...project, ...(a.repo === undefined ? {} : { repo: a.repo }), ...(a.migrated ? { migrated: true } : {}) } : p);
      const board = parse(Board, { ...s.board, projects: projectOrder(projects, a) });
      // Migrating keeps only roots' stored priorities, so none can return when a non-root later becomes a root.
      const puts: Put[] = [], dropped: Result["dropped"] = [];
      if (a.migrated) {
        const r = rules({ ...s, board });
        for (const [id, it] of Object.entries(s.items)) {
          if (r.projectOf(id) !== a.name || !it.priority || r.isRoot(id)) continue;
          const doc = { ...it, updated: at, log: [...it.log, entry(a.author, at, `迁移到依赖结构：优先级改由依赖它的条目决定，原来写的 ${it.priority} 不再使用`)] };
          delete doc.priority;
          puts.push(itemPut(id, doc)); dropped.push({ id, priority: it.priority });
        }
      }
      return { id: a.name, kind: "board", board, puts, dropped, message: `update_project ${a.name}${a.migrated ? " migrated" : ""}${a.after === undefined ? "" : ` after ${a.after}`}` };
    }),
    createRequest: a => run(a, (s, at) => {
      requireAuthor(s, a.author);
      requireProject(s, a.project); newKey(s, a.key);
      if (!migratedProject(s, a.project)) { if (!a.priority) throw new OpError("priority: new request requires P0, P1 or P2"); } // LEGACY PRIORITY
      else if (a.from && a.priority) throw derivedPriority(a.key, [a.from]);
      else if (!a.from && !a.priority) throw new OpError("priority: 没有 from 的请求是根条目，要写 P0、P1 或 P2");
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
      if (r.migrated(a.id) && a.priority && (a.parent || !r.isRoot(a.id))) throw derivedPriority(a.id, [...openDependents(r, a.id), ...(a.parent ? [a.parent] : [])]);
      const doc = { ...it, updated: at, priority: a.priority ?? it.priority, log: [...it.log] };
      delete doc.request;
      const puts: Put[] = [];
      if (a.parent) {
        ownedItem(s, a.parent, a.author, "parent");
        if (r.projectOf(a.parent) !== r.projectOf(a.id)) throw new OpError("parent: triage a request within its project");
        if (a.parent === a.id || r.ancestors(a.parent).includes(a.id)) throw new OpError("parent: no cycle");
        if (!a.parentWhy?.trim()) throw new OpError("parentWhy: explain what the parent needs this request for");
        doc.parent = a.parent;
        doc.log.push(entry(a.author, at, `分拣：放到「${titleOf(s, [], a.parent)}」下：${a.parentWhy}`));
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
      // The parent or group comes first: its project decides which priority rules apply.
      if (a.parent) ownedItem(s, a.parent, a.author, "parent");
      else {
        if (!a.group) throw new OpError("group: a new area requires its project");
        requireProject(s, a.group); requireOwnership(s, a.group, a.author, a.key);
      }
      if (!(a.parent ? rules(s).migrated(a.parent) : migratedProject(s, a.group))) { if (!a.priority) throw new OpError("priority: new leaf requires P0, P1 or P2"); } // LEGACY PRIORITY
      else if (a.parent && a.priority) throw derivedPriority(a.key, [a.parent]);
      else if (!a.parent && !a.priority) throw new OpError("priority: 新的根条目（没有上级）要写 P0、P1 或 P2");
      const { author: _author, key: _key, parentWhy: _why, parentOwnWork: _own, children = [], sourceStatus: _status, sourcePriority: _priority, ...fields } = a;
      const doc = parse(Item, { ...fields, status: a.record ? a.status : a.status ?? "todo", created: at, updated: at, rev: 1 });
      const puts: Put[] = [{ kind: "item", id: a.key, doc, expectRev: null }];
      if (a.parent) {
        requireItem(s, a.parent, "parent");
        if (!a.parentWhy?.trim()) throw new OpError("parentWhy: explain what the parent needs this child for");
      }
      // Existing items become sub-items of the new one, which is a parent from birth with no own-work stub.
      if (children.length) {
        const r = rules(s);
        if (!(a.parent ? r.migrated(a.parent) : migratedProject(s, a.group))) throw new OpError("children: only a migrated project's new item takes existing items as sub-items");
        const hasWorkChildren = children.some(c => !s.items[c.id]?.record);
        if (a.status && hasWorkChildren) throw new OpError("status: an item created with work children takes its status from them; omit status");
        if (new Set(children.map(c => c.id)).size !== children.length) throw new OpError("children: name each item once");
        for (const c of children) if (doc.deps.some(d => "id" in d && d.id === c.id)) throw new OpError(`children: ${c.id} is already in deps; name it once, as a child`);
        for (const c of children) {
          ownedItem(s, c.id, a.author, "children");
          if (a.parent && (c.id === a.parent || r.ancestors(a.parent).includes(c.id))) throw new OpError(`children: ${c.id} contains the new item's parent ${a.parent} (no cycle)`);
        }
        detach(s, at, a.author, children.map(c => c.id), a, puts, a.parent);
        for (const c of children) {
          // A child may also be the old parent of another adopted child, already rewritten by detach.
          const it = docOf(s, puts, c.id), moved = { ...it, parent: a.key, updated: at, log: [...it.log, entry(a.author, at, it.request ? `分拣：放到「${a.title}」下：${c.why}` : it.parent ? `从「${titleOf(s, puts, it.parent)}」下移到「${a.title}」下：${c.why}` : `从顶层移到「${a.title}」下：${c.why}`)] };
          delete moved.request;
          putDoc(puts, itemPut(c.id, moved));
        }
        if (hasWorkChildren) delete doc.status;
        doc.deps = [...doc.deps, ...children.map(c => ({ id: c.id, why: c.why }))];
      } else if (a.sourceStatus || a.sourcePriority) throw new OpError("sourceStatus: only with children");
      if (a.parent) addChild(s, at, a.author, a.parent, a.key, a.parentWhy!, a.parentOwnWork, a.priority, puts);
      return { id: a.key, kind: "item", message: `create_item ${a.key}`, puts };
    }),
    appendLog: a => edit(a, "append_log", (it, _s, at) => ({ ...it, updated: at, log: [...it.log, entry(a.author, at, a.text)] })),
    setSteps: a => edit(a, "set_steps", (it, _s, at) => {
      if ([a.steps, a.step, a.remove].filter(value => value !== undefined).length !== 1) throw new OpError("set_steps: provide exactly one of steps, step or remove");
      const previous = it.steps ?? [];
      let steps: Item["steps"];
      if (a.remove !== undefined) {
        const id = parse(StepId, a.remove);
        if (!previous.some(step => step.id === id)) throw new OpError(`remove ${id}: choose an existing step id`);
        steps = previous.filter(step => step.id !== id);
      } else if (a.steps !== undefined) {
        const inputs = parse(ItemStepsInput, a.steps);
        const byId = new Map(previous.map(step => [step.id, step]));
        steps = inputs.map(input => stampItemStep(input, byId.get(input.id), at));
      } else {
        const input = parse(ItemStepInput, a.step), i = previous.findIndex(step => step.id === input.id);
        steps = previous.slice();
        const updated = stampItemStep(input, previous[i], at);
        if (i < 0) steps.push(updated); else steps[i] = updated;
      }
      // Identical steps leave the item untouched, even `updated`, so the store writes no commit.
      return isDeepStrictEqual(steps, previous) ? it : { ...it, steps, updated: at };
    }),
    setTargets: a => edit(a, "set_targets", (it, _s, at) => {
      if ([a.targets, a.target, a.remove].filter(value => value !== undefined).length !== 1) throw new OpError("set_targets: provide exactly one of targets, target or remove");
      const previous = it.targets ?? [];
      let targets: ItemTarget[];
      if (a.remove !== undefined) {
        const id = parse(StepId, a.remove);
        if (!previous.some(target => target.id === id)) throw new OpError(`remove ${id}: choose an existing target id`);
        targets = previous.filter(target => target.id !== id);
      } else if (a.targets !== undefined) {
        const inputs = parse(ItemTargetsInput, a.targets);
        const byId = new Map(previous.map(target => [target.id, target]));
        targets = inputs.map(input => stampItemTarget(input, byId.get(input.id), at));
      } else {
        const input = parse(ItemTargetInput, a.target), i = previous.findIndex(target => target.id === input.id);
        targets = previous.slice();
        const updated = stampItemTarget(input, previous[i], at);
        if (i < 0) targets.push(updated); else targets[i] = updated;
      }
      return isDeepStrictEqual(targets, previous) ? it : { ...it, targets, updated: at };
    }),
    updateItem: a => run(a, async (s, at) => {
      const it = ownedItem(s, a.id, a.author);
      await revision("item", a.id, a.rev, it);
      const changedHead = a.head !== undefined && a.head !== it.head;
      if (changedHead && !a.reason?.trim()) throw new OpError("reason: explain why head changed");
      if (a.priority !== undefined && rules(s).migrated(a.id) && !rules(s).isRoot(a.id)) throw derivedPriority(a.id, openDependents(rules(s), a.id));
      const doc = { ...it, updated: at };
      for (const key of ["title", "head", "deps", "links", "priority", "data", "order", "record"] as const) {
        const value = a[key];
        if (value === null) delete doc[key];
        else if (value !== undefined) Object.assign(doc, { [key]: value });
      }
      const becameRecord = a.record === true && !it.record, becameWork = a.record === false && !!it.record;
      if (becameRecord && !rules(s).isStatusLeaf(a.id)) throw new OpError(`record: ${a.id} has work sub-items; a record has no status, so move them away or keep it a work item`);
      if (doc.record) delete doc.status;
      else if (it.record && rules(s).isStatusLeaf(a.id)) doc.status = "todo";
      const validated = parse(Item, doc);
      if (changedHead) validated.log.push(entry(a.author, at, `改了 head：${a.reason}`));
      if (becameRecord) validated.log.push(entry(a.author, at, "改为记录条目：不再有状态"));
      if (becameWork) validated.log.push(entry(a.author, at, "改为工作条目：状态为待做"));
      const puts: Put[] = [itemPut(a.id, validated)], r = rules(s);
      const splitParent = !!it.record && !validated.record && !!it.parent && !!r.item(it.parent) && !r.item(it.parent)!.record && r.isStatusLeaf(it.parent);
      if (a.parentOwnWork && !splitParent) throw new OpError("parentOwnWork: only when record: false introduces the first work child of a work-status leaf");
      if (splitParent) {
        const parent = s.items[it.parent!]!, dependency = parent.deps.find(d => "id" in d && d.id === a.id);
        addChild(s, at, a.author, it.parent!, a.id, dependency?.why ?? "", a.parentOwnWork, validated.priority, puts);
      }
      return { id: a.id, kind: "item", message: `update_item ${a.id}`, puts };
    }, true),
    setStatus: a => edit(a, `set_status`, (it, s, at) => {
      const r = rules(s);
      if (it.record) throw new OpError("status: a record has no status; use update_item with record: false to make it work");
      if (!r.isStatusLeaf(a.id)) throw new OpError(`status: ${a.id}'s status is derived from its sub-items (${r.children(a.id).sort(r.compareSiblings).map(c => `${c} ${r.statusOf(c)}`).join(", ")}); put its own work in a sub-item and set that leaf's status`);
      if (a.status === "blocked" && !r.depsOf(a.id).some(d => d.open) && !r.needsOwner(a.id)) throw new OpError(`item ${a.id}: "${r.depsOf(a.id).length ? "可解除阻塞：等的都已完成" : "卡住了，但没写在等什么"}"; status blocked: add at least one open dependency or an ask`);
      const doc = { ...it, updated: at, status: a.status, log: [...it.log, entry(a.author, at, a.log)] };
      if (a.status === "cancelled") delete doc.request;
      return doc;
    }, false, ` ${a.status}`),
    moveItem: a => run(a, (s, at) => {
      const it = ownedItem(s, a.id, a.author), r = rules(s), old = it.parent;
      if (a.parent === undefined) return toRoot(s, at, a, it);
      if (a.priority) throw new OpError("priority: only when moving to the top level without new_parent");
      ownedItem(s, a.parent, a.author, "parent");
      if (it.request && r.projectOf(a.id) !== r.projectOf(a.parent)) throw new OpError("parent: triage a request within its project");
      if (!a.parentWhy?.trim()) throw new OpError("parentWhy: explain what the new parent needs this child for");
      if (a.id === a.parent || r.ancestors(a.parent).includes(a.id)) throw new OpError("parent: choose a parent other than this item or its descendants (no cycle)");
      const doc = { ...it, parent: a.parent, updated: at, log: [...it.log, entry(a.author, at, it.request ? `分拣：放到「${titleOf(s, [], a.parent)}」下：${a.parentWhy}` : old ? `从「${titleOf(s, [], old)}」下移到「${titleOf(s, [], a.parent)}」下：${a.parentWhy}` : `从顶层移到「${titleOf(s, [], a.parent)}」下：${a.parentWhy}`)] };
      delete doc.request;
      const puts = [itemPut(a.id, doc)];
      detach(s, at, a.author, [a.id], a, puts, a.parent);
      addChild(s, at, a.author, a.parent, a.id, a.parentWhy, a.parentOwnWork, it.priority, puts, true);
      return { id: a.id, kind: "item", message: `move_item ${a.id}`, puts };
    }),
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
      const { author: _author, key: _key, rev: _rev, blocks, ...fields } = a;
      // blocks: text sets it, null clears it, omitted keeps the revised card's.
      const merged: Record<string, unknown> = { ...previous, ...fields, status: "open", at: previous?.at ?? at, updated: at, rev: previous?.rev ?? 1 };
      if (blocks === null) delete merged.blocks; else if (blocks !== undefined) merged.blocks = blocks;
      const doc = parse(Decision, merged);
      if (doc.options.filter(o => o.recommended).length > 1) throw new OpError("options.recommended: recommend at most one option");
      if (new Set(doc.options.map(o => o.key)).size !== doc.options.length) throw new OpError("options.key: give each option a unique key");
      return { id: a.key, kind: "decision", message: `write_card ${a.key}`, puts: [{ kind: "decision", id: a.key, doc, expectRev: previous?.rev ?? null }] };
    }, a.rev !== undefined),
    postNotice: a => run(a, (s, at) => {
      if (a.item !== undefined) requireItem(s, a.item, "item");
      let id: string;
      do { id = Array.from({ length: 20 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[randomInt(36)]).join(""); } while (Object.hasOwn(s.notices, id));
      const doc = parse(Notice, { text: a.text, ...(a.item !== undefined ? { item: a.item } : {}), author: a.author, at, rev: 1 });
      return { id, kind: "notice", message: `post_notice ${id}`, puts: [{ kind: "notice", id, doc, expectRev: null }] };
    }),
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
    setTerm: a => run(a, (s, at) => {
      const glossary = ownGlossary(s, a.author);
      if (!Term.shape.term.safeParse(a.term).success) throw new OpError("term: write the term on one line without leading or trailing spaces");
      // A replaced term keeps its place, so the glossary's diff shows only the changed definition.
      const entry = { term: a.term, definition: a.definition, updated: at, by: a.author };
      const terms = glossary.terms.some(t => t.term === a.term) ? glossary.terms.map(t => t.term === a.term ? entry : t) : [...glossary.terms, entry];
      return { id: a.author, kind: "glossary", message: `set_term ${a.term}`, puts: [{ kind: "glossary", id: a.author, doc: parse(Glossary, { ...glossary, terms }), expectRev: s.glossaries[a.author]?.rev ?? null }] };
    }),
    deleteTerm: a => run(a, s => {
      const glossary = ownGlossary(s, a.author);
      if (!glossary.terms.some(t => t.term === a.term)) throw new OpError(`term ${a.term}: not in ${a.author}'s glossary; call glossary to see its terms`);
      return { id: a.author, kind: "glossary", message: `delete_term ${a.term}`, puts: [{ kind: "glossary", id: a.author, doc: { ...glossary, terms: glossary.terms.filter(t => t.term !== a.term) }, expectRev: glossary.rev }] };
    }),
  };
}
