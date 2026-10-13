import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { randomInt } from "node:crypto";
import { Key, Item, PlanRowInput, PlanInput, ItemTargetInput, ItemTargetsInput, StepId, Decision, Note, Notice, Board, Glossary, GlossaryId, Term, Tag, TagName, tagApplies, boardTags } from "./model.ts";
import type { PlanRow, ItemTarget, Link, Option, Priority, Snapshot } from "./model.ts";
import { Store, ConflictError, ValidationError } from "./store.ts";
import type { Put } from "./store.ts";
import { rules, stampPlanRow, stampItemTarget, projectOrderAfter } from "./rules.ts";
import { describeChanges } from "./query.ts";

export class OpError extends Error {}
/** `dropped`: items whose stored priority the write removed because they are non-roots. */
export interface Result { commit: string; id: string; rev?: number; summary: string; dropped?: Array<{ id: string; priority: Priority }> }
export interface Ops {
  createProject(a: { author: string; name: string; repo?: string; after?: string }): Promise<Result>;
  updateProject(a: { author: string; name: string; repo?: string; after?: string }): Promise<Result>;
  createRequest(a: { author: string; project: string; key: string; title: string; head: string; accept: string; priority?: Priority; why: string; from?: string; after?: string[]; tags?: string[] }): Promise<Result>;
  triageRequest(a: { author: string; id: string; owner?: string; after?: string[]; priority?: Priority; log: string }): Promise<Result>;
  closeNote(a: { author: string; id: string; log: string }): Promise<Result>;
  createItem(a: { author: string; key: string; owner?: string; after?: string[]; title: string; head?: string; accept?: string; record?: boolean; priority?: Priority; plan?: PlanRowInput[]; links?: Link[]; data?: string; group?: string; order?: number; children?: string[]; tags?: string[] }): Promise<Result>;
  appendLog(a: { author: string; id: string; text: string }): Promise<Result>;
  setPlan(a: { author: string; id: string; rows?: PlanRowInput[]; row?: PlanRowInput; remove?: string }): Promise<Result>;
  setTargets(a: { author: string; id: string; targets?: ItemTargetInput[]; target?: ItemTargetInput; remove?: string }): Promise<Result>;
  updateItem(a: { author: string; id: string; rev: number; title?: string; head?: string; record?: boolean; accept?: string; reason?: string; links?: Link[]; priority?: Priority; data?: string | null; order?: number }): Promise<Result>;
  setStatus(a: { author: string; id: string; status: "cancelled" | "open"; log: string }): Promise<Result>;
  setTags(a: { author: string; id: string; tags: string[] }): Promise<Result>;
  setTag(a: { author: string; name: string; meaning: string; projects?: string[] | null }): Promise<Result>;
  renameTag(a: { author: string; name: string; to: string }): Promise<Result>;
  removeTag(a: { author: string; name: string; replace?: string }): Promise<Result>;
  setPause(a: { author: string; id: string; paused: boolean; reason?: string }): Promise<Result>;
  moveItem(a: { author: string; id: string; owner?: string; after?: string[]; priority?: Priority }): Promise<Result>;
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
  if (typeof value === "string" && !value.trim()) throw new OpError(`${path}: provide nonempty text after trimming`);
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) nonempty(child, `${path}.${key}`);
}
function parse<T>(schema: z.ZodType<T>, doc: unknown): T {
  const parsed = schema.safeParse(doc);
  if (!parsed.success) {
    const messages = (issues: readonly { path: readonly PropertyKey[]; message: string; errors?: readonly (readonly { path: readonly PropertyKey[]; message: string }[])[] }[]): string[] => issues.flatMap(i => i.errors ? i.errors.flatMap(group => messages(group)) : [`${i.path.map(String).join(".") || "input"}: fix ${i.message}`]);
    throw new OpError(messages(parsed.error.issues).join("; "));
  }
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
/** For every project only a root, an item no open item depends on, stores a priority; any other item's comes from its dependents. */
function derivedPriority(id: string, from: string[]): OpError {
  return new OpError(`priority: ${id} 有未完成的条目依赖它，它的优先级来自这些条目（${from.join("、")}），不能自己设；只有没有未完成条目依赖的根条目才写优先级`);
}
const openDependents = (r: ReturnType<typeof rules>, id: string): string[] => r.dependents(id).map(d => d.id).filter(d => r.statusOf(d) !== "done" && r.statusOf(d) !== "cancelled");

/** The tags an item of `project` may carry, as a sentence for an error message. */
function allowedTags(s: Snapshot, project: string): string {
  const names = boardTags(s.board).filter(t => tagApplies(t, project)).map(t => t.name);
  return names.length ? `tags allowed for ${project}: ${names.join(", ")}` : `no tag is approved for ${project} yet; 总管 adds one after the owner approves it on a decision card`;
}
/**
 * Validates the tags a write gives an item of `project`: unique, in the vocabulary and applicable to the project.
 * `required`: at least one is needed whenever the vocabulary has a tag applicable to the project; before that none can be given.
 */
function checkedTags(s: Snapshot, project: string, tags: readonly string[] | undefined, required: boolean): string[] | undefined {
  const given = tags ?? [];
  if (new Set(given).size !== given.length) throw new OpError("tags: name each tag once");
  for (const name of given) {
    const tag = boardTags(s.board).find(t => t.name === name);
    if (!tag) throw new OpError(`tags ${name}: not in the tag vocabulary; ${allowedTags(s, project)}`);
    if (!tagApplies(tag, project)) throw new OpError(`tags ${name}: applies only to ${tag.projects!.join(", ")}, not ${project}; ${allowedTags(s, project)}`);
  }
  if (!given.length && required && boardTags(s.board).some(t => tagApplies(t, project))) throw new OpError(`tags: give at least one; ${allowedTags(s, project)}`);
  return given.length ? [...given] : undefined;
}
function only总管(author: string): void {
  if (author !== "总管") throw new OpError("author: only 总管 may change the tag vocabulary, and only after the owner approves the change on a decision card");
}

function newKey(s: Snapshot, key: string): void {
  if (!Key.safeParse(key).success) throw new OpError("key: use 1–200 letters, digits, dots, underscores or hyphens, starting with a letter or digit");
  if (Object.hasOwn(s.items, key) || Object.hasOwn(s.decisions, key)) throw new OpError(`key ${key}: already used; choose a new item or decision key`);
}

interface Work { moved?: string[]; id: string; kind: Put["kind"] | "board"; message: string; puts: Put[]; board?: Board; dropped?: Result["dropped"] }
/** Required checks depend on plan structure and open status, not logs or display
 * metadata. Follow status changes backwards through both graphs, then include
 * the targets whose ownership requirement can change when a waiter opens.
 * Both graphs matter when rows or card/note targets are removed or replaced.
 * Sound only while every check matched by `required` in `run` reads just the
 * inputs compared here; widen this when such a check reads another field.
 */
function requiredCheckItems(before: Snapshot, after: Snapshot, work: Work, oldRules: ReturnType<typeof rules>, newRules: ReturnType<typeof rules>): Set<string> {
  if (work.board) return new Set(Object.keys(after.items));
  const affected = new Set<string>();
  const itemInputs = (it: Item | undefined) => it && { group: it.group, record: it.record, status: it.status, paused: it.paused, plan: it.plan, ask: it.ask };
  const noteInputs = (note: Note | undefined) => note && { target: note.target, kind: note.kind, state: note.state, text: note.text, answerText: note.answerText };
  const card = (key: string) => {
    for (const s of [before, after]) { const owner = s.decisions[key]?.item; if (owner) affected.add(owner); }
    for (const r of [oldRules, newRules]) for (const waiter of r.cardDependents(key)) affected.add(waiter.id);
  };
  for (const put of work.puts) {
    if (put.kind === "item") {
      if (!isDeepStrictEqual(itemInputs(before.items[put.id]), itemInputs(after.items[put.id]))) affected.add(put.id);
    } else if (put.kind === "decision") {
      if (!isDeepStrictEqual(before.decisions[put.id], after.decisions[put.id])) card(put.id);
    } else if (put.kind === "note" && !isDeepStrictEqual(noteInputs(before.notes[put.id]), noteInputs(after.notes[put.id]))) {
      for (const s of [before, after]) {
        const target = s.notes[put.id]?.target;
        if (target?.startsWith("it:")) affected.add(target.slice(3));
        else if (target?.startsWith("q:")) card(target.slice(2));
      }
    }
  }
  // Ownership changes and pause markers can change every descendant's effective
  // pause without writing that descendant. Follow both ownership trees first.
  for (const id of affected) for (const r of [oldRules, newRules]) for (const child of r.children(id)) affected.add(child);
  // Set iteration visits newly added members too, giving a transitive closure.
  for (const id of affected) for (const r of [oldRules, newRules]) for (const waiter of r.dependents(id)) affected.add(waiter.id);
  const checked = new Set(affected);
  for (const id of affected) for (const s of [before, after]) for (const row of s.items[id]?.plan ?? []) if ("item" in row) checked.add(row.item);
  return checked;
}
/** The document this operation already wrote for an item, else the snapshot's. */
function docOf(s: Snapshot, puts: Put[], id: string, field = "id"): Item {
  return (puts.find(p => p.kind === "item" && p.id === id)?.doc as Item | undefined) ?? requireItem(s, id, field);
}
/** An item's title for a log line the owner reads: this operation's own write if any, else the snapshot's; the key only for an item that does not exist. */
function titleOf(s: Snapshot, puts: Put[], id: string): string {
  return ((puts.find(p => p.kind === "item" && p.id === id)?.doc as Item | undefined) ?? s.items[id])?.title ?? id;
}
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
      for (const key of ["parent", "parentWhy", "parentOwnWork", "parent_why", "parent_own_work", "new_parent", "sourceStatus", "sourcePriority", "source_status", "source_priority", "deps", "steps", "step", "migrated", "provisional"]) if (Object.hasOwn(a, key)) throw new OpError(`${key}: removed by item plans`);
      if (typeof a.author !== "string" || !a.author.trim() || /[<>\r\n\0]/.test(a.author)) throw new OpError("author: provide your project name without <, >, newlines or NUL");
      for (;;) {
        const s = store.snapshot(), at = now();
        const work = await make(s, at);
        if (!anyAuthor) requireAuthor(s, a.author);
        // Validate the prospective board, including indirect effects on children,
        // dependents and items whose owner actions a card/note write changes.
        // snapshot() freezes every document. Only these collection slots change;
        // copying all existing plans and logs is unnecessary for a prospective write.
        const next: Snapshot = { ...s, items: { ...s.items }, decisions: { ...s.decisions }, notes: { ...s.notes }, notices: { ...s.notices }, glossaries: { ...s.glossaries } };
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
        // For every project a stored priority never outlives rootness: the write drops it from every non-root it writes or makes a non-root, and says so in that item's log.
        const written = new Set(work.puts.filter(p => p.kind === "item").map(p => p.id)), dropped = [...work.dropped ?? []];
        // Every supported ownership attachment triages a pending request, not
        // only move_item. Keep the inbox marker and the plan change atomic.
        for (const owner of [...written]) {
          const ownerDoc = next.items[owner]!;
          for (const row of ownerDoc.plan) {
            if (!("item" in row && row.own) || beforeRules.parentOf(row.item) === owner) continue;
            const target = next.items[row.item];
            if (!target?.request || !beforeRules.isRequest(row.item)) continue;
            requireOwnership(s, target.group, a.author, row.item);
            const doc = { ...target, updated: at, log: [...target.log, { at, by: a.author, text: `分拣：放到「${ownerDoc.title}」的计划` }] };
            delete doc.request;
            next.items[row.item] = doc;
            putDoc(work.puts, { kind: "item", id: row.item, doc, expectRev: target.rev });
            written.add(row.item);
          }
        }
        afterRules = rules(next);
        for (const [id, it] of Object.entries(next.items)) {
          if (!it.priority || afterRules.isRoot(id) || !(written.has(id) || beforeRules.isRoot(id))) continue;
          const doc = { ...it, ...(written.has(id) ? {} : { updated: at }), log: [...it.log, { at, by: a.author, text: `不再是根：优先级改由依赖它的条目决定，原来写的 ${it.priority} 不再使用` }] };
          delete doc.priority;
          dropped.push({ id, priority: it.priority });
          next.items[id] = doc;
          const put = work.puts.find(p => p.kind === "item" && p.id === id);
          if (put) put.doc = doc; else work.puts.push({ kind: "item", id, doc, expectRev: it.rev });
        }
        afterRules = rules(next);
        const checked = requiredCheckItems(s, next, work, beforeRules, afterRules);
        // Pause permission covers open work resumed through any indirect effect,
        // including unwritten descendants. Closing work is allowed when its
        // explicit marker stays intact; reopening will restore that pause.
        if (a.author !== "总管") for (const id of checked) {
          const clearedMarker = s.items[id]?.paused && !next.items[id]?.paused;
          const resumedWork = beforeRules.isPaused(id) && afterRules.isOpenWork(id) && !afterRules.isPaused(id);
          if (!clearedMarker && !resumedWork) continue;
          const source = clearedMarker ? id : beforeRules.pausedBy(id)!;
          throw new OpError(`paused: 「${s.items[id]!.title}」 (${id}) is paused by 「${s.items[source]!.title}」 (${source}); only the owner or 总管 can resume it`);
        }
        for (const id of written) {
          const old = s.items[id], current = next.items[id]!;
          for (const row of current.plan ?? []) {
            if (!("item" in row && row.own)) continue;
            if (next.items[row.item] && current.group !== next.items[row.item]!.group) throw new OpError(`owner: 跨项目拥有 ${row.item}; use a shared row`);
            const existing = Object.keys(s.items).find(owner => s.items[owner]!.plan.some(previous => "item" in previous && previous.own && previous.item === row.item));
            if (existing && existing !== id && !work.moved?.includes(row.item)) throw new OpError(`owner: 被多个条目拥有 ${row.item}; current owner ${existing}; use move_item`);
          }
          for (const row of old?.plan ?? []) {
            if (!("item" in row && row.own) || work.moved?.includes(row.item) || !beforeRules.isOpenWork(row.item)) continue;
            if (!current.plan?.some(r => "item" in r && r.item === row.item && r.own)) throw new OpError(`plan ${id}: ${row.item} is open; use move_item or cancel it before removing its owned row`);
          }
        }
        const required = /^(依赖的条目不存在|依赖的决策卡不存在|依赖成环|被多个条目拥有|跨项目拥有|同项目有条目在等它，却没有条目拥有它|没有计划：至少要有一个验收步骤)/;
        for (const id of Object.keys(next.items)) {
          if (!checked.has(id)) continue;
          const oldChecks = new Set(beforeRules.checks(id).map(c => JSON.stringify(c)));
          for (const check of afterRules.checks(id)) {
            if (required.test(check.text) && !oldChecks.has(JSON.stringify(check))) {
              const fix = check.text.startsWith("依赖的") ? "use set_plan to remove or replace the missing row"
                : check.text.startsWith("依赖成环") ? "use set_plan or move_item to remove the item-row cycle"
                : check.text.startsWith("没有计划") ? "use set_plan to add at least one acceptance step where its check happens"
                : check.text.startsWith("跨项目拥有") ? "use a shared row instead of ownership"
                : "use move_item to place the item under exactly one same-project owner";
              throw new OpError(`item ${id}: "${check.text}"${check.target ? ` ${check.target.id}` : ""}; ${fix}`);
            }
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
  function acceptId(rows: readonly { id?: string; item?: string; card?: string }[]): string {
    const ids = new Set(rows.map(row => row.id ?? row.item ?? row.card));
    let id = "accept", suffix = 1; while (ids.has(id)) id = `accept-${suffix++}`; return id;
  }
  function rowId(row: PlanRowInput): string { return "item" in row ? row.item : "card" in row ? row.card : row.id; }
  function stamped(inputs: PlanRowInput[], previous: PlanRow[], at: string): PlanRow[] {
    const old = new Map(previous.map(row => [row.id, row]));
    return parse(PlanInput, inputs).map(row => stampPlanRow(row, old.get(rowId(row)), at));
  }
  function insert(plan: PlanRow[], row: PlanRow): PlanRow[] {
    const i = plan.findIndex(r => r.id === row.id), at = plan.findIndex(r => "accept" in r && r.accept);
    if (i >= 0) return plan.map((r, n) => n === i ? row : r);
    const result = plan.slice(); result.splice(at < 0 ? result.length : at, 0, row); return result;
  }
  function removeRow(plan: PlanRow[], id: string): PlanRow[] {
    const named = plan.filter(r => r.after?.includes(id)).map(r => r.id);
    if (named.length) throw new OpError(`remove ${id}: later rows ${named.join(", ")} name it in after; rewrite them first`);
    return plan.filter(row => row.id !== id);
  }
  function priorityAllowed(s: Snapshot, id: string): void {
    const r = rules(s);
    if (r.isBacklog(id)) throw new OpError(`priority: ${id} is record-owned work and cannot store priority; priority derives from open shared dependents`);
    if (!r.isRoot(id)) throw derivedPriority(id, openDependents(r, id));
  }
  function attach(s: Snapshot, puts: Put[], at: string, author: string, owner: string, id: string, after?: string[]): void {
    ownedItem(s, owner, author, "owner"); const doc = docOf(s, puts, owner);
    if (rules(s).projectOf(owner) !== docOf(s, puts, id).group) throw new OpError("owner: ownership must stay within the same project");
    putDoc(puts, itemPut(owner, { ...doc, plan: insert(doc.plan ?? [], { id, item: id, own: true, ...(after === undefined ? {} : { after }) }), updated: at,
      log: [...doc.log, entry(author, at, `计划拥有「${titleOf(s, puts, id)}」`)] }));
  }
  function transfer(s: Snapshot, puts: Put[], at: string, author: string, id: string, owner?: string, after?: string[]): void {
    const old = rules(s).parentOf(id);
    if (old && old !== owner) {
      ownedItem(s, old, author, "owner"); const doc = docOf(s, puts, old);
      putDoc(puts, itemPut(old, { ...doc, plan: removeRow(doc.plan ?? [], id), updated: at, log: [...doc.log, entry(author, at, `计划不再拥有「${titleOf(s, puts, id)}」；${owner ? `移到「${titleOf(s, puts, owner)}」` : "移到顶层"}`)] }));
    }
    if (owner) attach(s, puts, at, author, owner, id, after);
    else if (after !== undefined) throw new OpError("after: requires owner");
    const doc = docOf(s, puts, id), moved = { ...doc, updated: at, log: [...doc.log, entry(author, at, doc.request && owner ? `分拣：放到「${titleOf(s, puts, owner)}」的计划` : `${old ? `从「${titleOf(s, puts, old)}」` : "从顶层"}${owner ? `移到「${titleOf(s, puts, owner)}」的计划` : "移到顶层"}`)] };
    delete moved.request;
    putDoc(puts, itemPut(id, moved));
  }
  return {
    createProject: a => run(a, s => {
      if (s.board.projects.some(p => p.name === a.name)) throw new OpError(`project ${a.name}: already exists`);
      const projects = [...s.board.projects, { name: a.name, ...(a.repo === undefined ? {} : { repo: a.repo }) }];
      const board = parse(Board, { ...s.board, projects: projectOrder(projects, a) });
      return { id: a.name, kind: "board", board, puts: [], message: `create_project ${a.name} ${a.author}${a.after === undefined ? "" : ` after ${a.after}`}` };
    }, false, true),
    updateProject: a => run(a, s => {
      const project = requireProject(s, a.name);
      requireAuthor(s, a.author, `project ${a.name}: `);
      if (a.repo !== undefined && a.author !== a.name && a.author !== "总管") throw new OpError(`project ${a.name}: only that project or 总管 may update its repo`);
      if (a.repo === undefined && a.after === undefined) throw new OpError("repo: provide repo or after");
      const projects = s.board.projects.map(p => p.name === a.name ? { ...project, ...(a.repo === undefined ? {} : { repo: a.repo }) } : p);
      return { id: a.name, kind: "board", board: parse(Board, { ...s.board, projects: projectOrder(projects, a) }), puts: [], message: `update_project ${a.name}` };
    }),
    createRequest: a => run(a, (s, at) => {
      requireAuthor(s, a.author); requireProject(s, a.project); newKey(s, a.key);
      if (a.from && a.priority) throw derivedPriority(a.key, [a.from]);
      if (!a.from && !a.priority) throw new OpError("priority: a request without from requires a root priority");
      if (!a.from && a.after !== undefined) throw new OpError("after: requires from");
      const tags = checkedTags(s, a.project, a.tags, true);
      const doc = parse(Item, { title: a.title, group: a.project, ...(tags ? { tags } : {}), head: a.head, priority: a.priority, plan: [{ id: "accept", accept: true, text: a.accept, state: "todo" }], request: { by: a.author, at }, created: at, updated: at, rev: 1, log: [entry(a.author, at, `${a.author} 提出：${a.why}`)] });
      const puts: Put[] = [{ kind: "item", id: a.key, doc, expectRev: null }];
      if (a.from) { const from = ownedItem(s, a.from, a.author, "from"); puts.push(itemPut(a.from, { ...from, updated: at, plan: insert(from.plan ?? [], { id: a.key, item: a.key, own: false, ...(a.after === undefined ? {} : { after: a.after }) }) })); }
      return { id: a.key, kind: "item", puts, message: `create_request ${a.key}` };
    }),
    triageRequest: a => run(a, (s, at) => {
      const it = ownedItem(s, a.id, a.author), r = rules(s);
      if (!it.request || !r.isRequest(a.id)) throw new OpError(`item ${a.id}: not an open request`);
      if (a.priority && (a.owner || !r.isRoot(a.id))) throw derivedPriority(a.id, openDependents(r, a.id));
      const doc = { ...it, updated: at, ...(a.priority ? { priority: a.priority } : {}) }; if (!a.owner) delete doc.request;
      const puts = [itemPut(a.id, doc)];
      if (a.owner) transfer(s, puts, at, a.author, a.id, a.owner, a.after);
      else if (a.after !== undefined) throw new OpError("after: requires owner");
      const placed=docOf(s,puts,a.id);
      putDoc(puts,itemPut(a.id,{...placed,log:[...placed.log,entry(a.author,at,a.log)]}));
      return { id: a.id, kind: "item", puts, moved: [a.id], message: `triage_request ${a.id}` };
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
      if (Object.hasOwn(a, "status")) throw new OpError("status: create_item has no status argument");
      newKey(s, a.key);
      const owner = a.owner ? ownedItem(s, a.owner, a.author, "owner") : undefined;
      const group = a.group ?? owner?.group;
      if (!group) throw new OpError("group: a new top item requires its project");
      requireProject(s, group); requireOwnership(s, group, a.author, a.key);
      if (a.owner && a.priority) throw derivedPriority(a.key, [a.owner]);
      if (!a.owner && !a.priority && !a.record) throw new OpError("priority: a new root requires a priority");
      if (a.record ? a.accept !== undefined : !a.accept) throw new OpError("accept: required for work, refused for records");
      if (!a.owner && a.after !== undefined) throw new OpError("after: requires owner");
      const inputs = [...a.plan ?? []];
      const children = a.children ?? [];
      if (new Set(children).size !== children.length) throw new OpError("children: name each item once");
      for (const id of children) { ownedItem(s, id, a.author, "children"); if (inputs.some(row => rowId(row) === id)) throw new OpError(`children ${id}: already named in plan`); inputs.push({ item: id, own: true }); }
      if (!a.record) inputs.push({ id: acceptId(inputs), accept: true, text: a.accept!, state: "todo" });
      const tags = checkedTags(s, group, a.tags, true);
      const doc = parse(Item, { title: a.title, ...(tags ? { tags } : {}), head: a.head, record: a.record, priority: a.priority, links: a.links, data: a.data, group, order: a.order, plan: stamped(inputs, [], at), created: at, updated: at, rev: 1 });
      const puts: Put[] = [{ kind: "item", id: a.key, doc, expectRev: null }];
      for (const id of children) {
        const old = rules(s).parentOf(id);
        if (old) { const previous = docOf(s, puts, old); putDoc(puts, itemPut(old, { ...previous, plan: removeRow(previous.plan ?? [], id), updated: at, log: [...previous.log, entry(a.author, at, `「${titleOf(s, puts, id)}」移到「${a.title}」的计划`)] })); }
        const child = docOf(s, puts, id), moved = { ...child, updated: at, log: [...child.log, entry(a.author, at, child.request ? `分拣：放到「${a.title}」的计划` : `移到「${a.title}」的计划`)] }; delete moved.request; putDoc(puts, itemPut(id, moved));
      }
      if (a.owner) attach(s, puts, at, a.author, a.owner, a.key, a.after);
      return { id: a.key, kind: "item", puts, moved: children, message: `create_item ${a.key}` };
    }),
    appendLog: a => edit(a, "append_log", (it, _s, at) => ({ ...it, updated: at, log: [...it.log, entry(a.author, at, a.text)] })),
    setPlan: a => edit(a, "set_plan", (it, _s, at) => {
      if ([a.rows, a.row, a.remove].filter(value => value !== undefined).length !== 1) throw new OpError("set_plan: provide exactly one of rows, row or remove");
      const previous = it.plan ?? [];
      let plan: PlanRow[];
      if (a.remove !== undefined) {
        if (!previous.some(row => row.id === a.remove)) throw new OpError(`remove ${a.remove}: choose an existing row`);
        plan = removeRow(previous, a.remove);
      } else if (a.rows !== undefined) {
        const removed = previous.filter(row => !a.rows!.some(input => rowId(input) === row.id));
        for (const row of removed) { const named = a.rows.filter(input => input.after?.includes(row.id)); if (named.length) throw new OpError(`remove ${row.id}: later rows ${named.map(rowId).join(", ")} name it in after`); }
        plan = stamped(a.rows, previous, at);
      } else { const row = parse(PlanRowInput, a.row); plan = insert(previous, stampPlanRow(row, previous.find(r => r.id === rowId(row)), at)); }
      if (isDeepStrictEqual(plan, previous) && !(a.rows !== undefined && it.provisional)) return it;
      const doc = { ...it, plan, updated: at };
      if (a.rows !== undefined && it.provisional) { delete doc.provisional; doc.log = [...it.log, entry(a.author, at, "重写了计划")]; }
      return doc;
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
    setTags: a => edit(a, "set_tags", (it, s, at) => {
      if (!Array.isArray(a.tags) || !a.tags.length) throw new OpError(`tags: give the item's whole tag list, at least one tag; ${allowedTags(s, it.group)}`);
      const tags = checkedTags(s, it.group, a.tags, true)!;
      return isDeepStrictEqual(tags, it.tags) ? it : { ...it, tags, updated: at };
    }),
    setTag: a => run(a, s => {
      only总管(a.author);
      const known = boardTags(s.board).find(t => t.name === a.name);
      const projects = a.projects === undefined ? known?.projects : a.projects ?? undefined;
      for (const name of projects ?? []) requireProject(s, name);
      const tag = parse(Tag, { name: a.name, meaning: a.meaning, ...(projects ? { projects } : {}) });
      const stranded = Object.entries(s.items).filter(([, it]) => it.tags?.includes(a.name) && !tagApplies(tag, it.group)).map(([id]) => id);
      if (stranded.length) throw new OpError(`projects: items of projects outside the list still carry ${a.name}: ${stranded.join(", ")}; retag them first`);
      const tags = known ? boardTags(s.board).map(t => t.name === a.name ? tag : t) : [...boardTags(s.board), tag];
      return { id: a.name, kind: "board", board: parse(Board, { ...s.board, tags }), puts: [], message: `set_tag ${a.name}` };
    }, false, true),
    renameTag: a => run(a, (s, at) => {
      only总管(a.author);
      if (!boardTags(s.board).some(t => t.name === a.name)) throw new OpError(`name ${a.name}: not in the tag vocabulary; call tags to list it`);
      parse(TagName, a.to);
      if (boardTags(s.board).some(t => t.name === a.to)) throw new OpError(`to ${a.to}: already a tag; choose an unused name, or remove ${a.name} with replace`);
      const puts = Object.entries(s.items).filter(([, it]) => it.tags?.includes(a.name)).map(([id, it]) =>
        itemPut(id, { ...it, tags: it.tags!.map(t => t === a.name ? a.to : t), updated: at, log: [...it.log, entry(a.author, at, `标签改名：${a.name} → ${a.to}`)] }));
      const tags = boardTags(s.board).map(t => t.name === a.name ? { ...t, name: a.to } : t);
      return { id: a.to, kind: "board", board: parse(Board, { ...s.board, tags }), puts, message: `rename_tag ${a.name} ${a.to}` };
    }, false, true),
    removeTag: a => run(a, (s, at) => {
      only总管(a.author);
      if (!boardTags(s.board).some(t => t.name === a.name)) throw new OpError(`name ${a.name}: not in the tag vocabulary; call tags to list it`);
      const carrying = Object.entries(s.items).filter(([, it]) => it.tags?.includes(a.name));
      let replace: Tag | undefined;
      if (a.replace !== undefined) {
        replace = boardTags(s.board).find(t => t.name === a.replace);
        if (!replace || replace.name === a.name) throw new OpError(`replace ${a.replace}: choose another tag in the vocabulary`);
        const wrong = carrying.filter(([, it]) => !tagApplies(replace!, it.group)).map(([id]) => id);
        if (wrong.length) throw new OpError(`replace ${a.replace}: does not apply to the projects of ${wrong.join(", ")}`);
      } else if (carrying.length) throw new OpError(`name ${a.name}: ${carrying.length} items still carry it (${carrying.slice(0, 10).map(([id]) => id).join(", ")}${carrying.length > 10 ? ", …" : ""}); retag them, or give replace`);
      const puts = carrying.map(([id, it]) => {
        const rest = it.tags!.filter(t => t !== a.name);
        return itemPut(id, { ...it, tags: rest.includes(replace!.name) ? rest : [...rest, replace!.name], updated: at, log: [...it.log, entry(a.author, at, `标签 ${a.name} 已删除，换成 ${replace!.name}`)] });
      });
      return { id: a.name, kind: "board", board: parse(Board, { ...s.board, tags: boardTags(s.board).filter(t => t.name !== a.name) }), puts, message: `remove_tag ${a.name}${a.replace === undefined ? "" : ` → ${a.replace}`}` };
    }, false, true),
    updateItem: a => run(a, async (s, at) => {
      const it = ownedItem(s, a.id, a.author); await revision("item", a.id, a.rev, it);
      const changedHead = a.head !== undefined && a.head !== it.head;
      if (changedHead && !a.reason?.trim()) throw new OpError("reason: explain why head changed");
      if (a.priority !== undefined) priorityAllowed(s, a.id);
      if (a.order !== undefined && rules(s).parentOf(a.id)) throw new OpError("order: only top items carry order; order owned items in the plan");
      const doc = { ...it, updated: at, log: [...it.log] };
      for (const key of ["title", "head", "links", "priority", "data", "order", "record"] as const) { const value = a[key]; if (value === null) delete doc[key]; else if (value !== undefined) Object.assign(doc, { [key]: value }); }
      if (a.record === true && !it.record) {
        delete doc.paused;
        if (a.accept !== undefined) throw new OpError("accept: refused for a record");
        const accepts = (it.plan ?? []).filter(row => "accept" in row && row.accept);
        doc.plan = (it.plan ?? []).filter(row => !("accept" in row && row.accept)); delete doc.status;
        doc.log.push(entry(a.author, at, `改为记录条目：不再有状态；原验收：${accepts.map(row => "text" in row ? row.text : "").join("；")}`));
      } else if (a.record === false && it.record) {
        if (!a.accept) throw new OpError("accept: required when changing a record to work");
        doc.plan = [...it.plan ?? [], stampPlanRow({ id: acceptId(it.plan ?? []), accept: true, text: a.accept, state: "todo" }, undefined, at)];
        doc.log.push(entry(a.author, at, "改为工作条目：状态由计划推导"));
      } else if (a.accept !== undefined) throw new OpError("accept: only with a change from record to work; edit acceptance with set_plan");
      if (changedHead) doc.log.push(entry(a.author, at, `改了 head：${a.reason}`));
      return { id: a.id, kind: "item", message: `update_item ${a.id}`, puts: [itemPut(a.id, doc)] };
    }, true),
    setStatus: a => edit(a, "set_status", (it, s, at) => {
      if (it.record) throw new OpError("status: a record has no status");
      if (a.status !== "cancelled" && a.status !== "open") throw new OpError("status: only cancelled or open; all other statuses are derived from the plan");
      if (a.status === "open" && it.status !== "cancelled") throw new OpError("status: only a cancelled item can be reopened");
      const open = rules(s).children(a.id).filter(id => rules(s).isOpenWork(id));
      if (a.status === "cancelled" && open.length) throw new OpError(`status: owned items are still open: ${open.join(", ")}; cancel or move each part first`);
      const doc = { ...it, updated: at, log: [...it.log, entry(a.author, at, a.log)] };
      if (a.status === "cancelled") { doc.status = "cancelled"; delete doc.request; } else delete doc.status;
      return doc;
    }, false, ` ${a.status}`),
    setPause: a => run(a, (s, at) => {
      if (a.author !== "总管") throw new OpError("author: only 总管 may pause or resume an item, at the owner's request");
      if (typeof a.paused !== "boolean") throw new OpError("paused: provide true to pause or false to resume");
      const it = requireItem(s, a.id);
      if (it.record) throw new OpError("paused: a record cannot be paused or resumed");
      const closed = ["done", "cancelled"].includes(rules(s).statusOf(a.id) ?? "");
      if (closed && (a.paused || !it.paused)) throw new OpError("paused: done or cancelled items cannot be paused or resumed unless clearing an existing owner pause");
      if (a.paused && (typeof a.reason !== "string" || !a.reason.trim())) throw new OpError("reason: required when pausing an item");
      if (a.reason !== undefined && typeof a.reason !== "string") throw new OpError("reason: provide text");
      const reason = a.reason?.trim();
      const unchanged = a.paused ? it.paused?.reason === reason : !it.paused;
      const doc = unchanged ? it : { ...it, updated: at, log: [...it.log, entry(a.author, at, a.paused ? `暂停：${reason}` : "恢复")] };
      if (!unchanged) {
        if (a.paused) doc.paused = { reason: reason!, at }; else delete doc.paused;
      }
      return { id: a.id, kind: "item", message: `set_pause ${a.id} ${a.paused ? "paused" : "open"}`, puts: [itemPut(a.id, doc)] };
    }, false, true),
    moveItem: a => run(a, (s, at) => {
      ownedItem(s, a.id, a.author);
      if (a.owner && a.priority) throw new OpError("priority: refused with owner");
      const puts: Put[] = []; transfer(s, puts, at, a.author, a.id, a.owner, a.after);
      if (!a.owner) {
        const next = { ...s, items: { ...s.items } }; for (const put of puts) next.items[put.id] = put.doc as Item;
        const r = rules(next);
        if (r.isRoot(a.id) && !a.priority) throw new OpError("priority: moving to a root requires a priority");
        if (a.priority) { priorityAllowed(next, a.id); const doc = docOf(s, puts, a.id); putDoc(puts, itemPut(a.id, { ...doc, priority: a.priority })); }
      }
      return { id: a.id, kind: "item", puts, moved: [a.id], message: `move_item ${a.id}` };
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
