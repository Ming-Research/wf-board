// Transient pre-plan definitions for conversion and normalized historical comparisons.
// Keep independent of current schemas/rules; remove only when old comparison baselines retire.
// Pure snapshot-derived rules shared by the server and the owner's page.
// Ported from ~/dev/agents_config/status-board.html, except in migrated projects:
// priority comes from dependents, and a parent listing its own cancelled sub-item
// is not flagged. The verbatim test oracle preserves the old rules independently
// of this implementation.
import type { Item, ItemStep, ItemStepInput, ItemTarget, ItemTargetInput, Note, Priority, Snapshot, Status } from "./legacy-model.ts";
import { legacyPriority, rankOfPriority } from "./plan-legacy-priority.ts";

/** Only an unsent note can still be edited or deleted by its author. */
export function draftEditable(note: Pick<Note, "state"> | undefined): boolean { return note?.state === "draft"; }
/** Shared text validity for owner note creation and draft edits. */
export function noteTextProblem(note: Pick<Note, "kind" | "text">): string | undefined {
  return note.kind === "comment" && !note.text.trim() ? "A comment needs text" : undefined;
}

/** The one rule that log entries never count as owner-unread: owner-facing item comparisons drop the log first. */
export function withoutLog<T extends object>(doc: T): Omit<T, "log"> { const { log: _log, ...rest } = doc as T & { log?: unknown }; return rest; }
/** A change summary naming only the log (as describeChanges words it) is never unread content. */
export const isLogChange = (change: string): boolean => /^(\+\d+ log|log changed)$/.test(change);

const STEP_FIELDS = ["id", "text", "state", "waits", "reason", "doneAt", "since", "droppedAt"] as const;
function sameStep(a: ItemStep, b: ItemStep): boolean { return STEP_FIELDS.every(field => a[field] === b[field]); }
/** Current added or changed lines; moving an unchanged line does not highlight it. */
export function changedItemSteps(before: readonly ItemStep[] = [], after: readonly ItemStep[] = []): ItemStep[] {
  const previous = new Map(before.map(step => [step.id, step]));
  return after.filter(step => { const old = previous.get(step.id); return !old || !sameStep(old, step); });
}
/** Order and removals are progress changes too, even without a surviving changed line. */
export function stepsChanged(before: readonly ItemStep[] = [], after: readonly ItemStep[] = []): boolean {
  return before.length !== after.length || before.some((step, i) => !sameStep(step, after[i]!));
}
/** Retain earlier transition dates, stamp only entry into the current state. */
export function stampItemStep(input: ItemStepInput, previous: ItemStep | undefined, at: string): ItemStep {
  const step: ItemStep = { ...input };
  for (const field of ["doneAt", "since", "droppedAt"] as const) if (previous?.[field] !== undefined) step[field] = previous[field];
  const date = input.state === "done" ? "doneAt" : input.state === "doing" ? "since" : input.state === "dropped" ? "droppedAt" : undefined;
  if (date && (previous?.state !== input.state || !step[date])) step[date] = at;
  return step;
}

const TARGET_FIELDS = ["id", "goal", "target", "current", "baseline", "date"] as const;
function sameTarget(a: ItemTarget, b: ItemTarget): boolean { return TARGET_FIELDS.every(field => a[field] === b[field]); }
/** Highlight added or changed goals by stable id, independently of list position. */
export function changedItemTargets(before: readonly ItemTarget[] = [], after: readonly ItemTarget[] = []): ItemTarget[] {
  const previous = new Map(before.map(target => [target.id, target]));
  return after.filter(target => { const old = previous.get(target.id); return !old || !sameTarget(old, target); });
}
/** A reorder or removal still counts as progress even when no current row changed. */
export function targetsChanged(before: readonly ItemTarget[] = [], after: readonly ItemTarget[] = []): boolean {
  return before.length !== after.length || before.some((target, i) => !sameTarget(target, after[i]!));
}
/** Stamp new goals or changed current values, retaining the date on other edits. */
export function stampItemTarget(input: ItemTargetInput, previous: ItemTarget | undefined, at: string): ItemTarget {
  return { ...input, date: previous?.current === input.current ? previous.date : at };
}
export function targetLine(target: ItemTarget): string {
  const compact = (text: string): string => text.replace(/\s+/g, " ").trim();
  return `${compact(target.goal)}: ${compact(target.current)} (vs ${compact(target.baseline)}) → ${compact(target.target)}, ${target.date.slice(0, 10)}`;
}

/** The visible tag of a check whose own label is not set. */
export const CHECK_LABEL = "需核对";
/** The wip leaf quiet for STALLED_AFTER_MS of active time carries this label instead. */
export const STALLED_LABEL = "无人推进";
export const checkLabel = (c: Pick<Check, "label">): string => c.label ?? CHECK_LABEL;
export interface Check {
  text: string;
  /** Short visible tag; absent means CHECK_LABEL. The text is the full explanation (tooltip). */
  label?: string;
  target?: { kind: "item" | "card"; id: string };
}

export interface Rules {
  item(id: string): Item | undefined;
  parentOf(id: string): string | undefined;
  children(id: string): string[];
  /** Filter before ranking groups, as the legacy archive controls do. */
  areas(include?: (id: string) => boolean): string[];
  ancestors(id: string): string[];
  lineOf(id: string): string;
  groupOf(id: string): string;
  projectOf(id: string): string;
  isRequest(id: string): boolean;
  /** An existing work item whose status is neither done nor cancelled. Records are not open work. */
  isOpenWork(id: string): boolean;
  inbox(project: string): string[];
  isLeaf(id: string): boolean;
  /** No non-record children contribute work status. */
  isStatusLeaf(id: string): boolean;
  statusOf(id: string): Status | undefined;
  /** Its project sets `migrated: true` in board.yaml, so priority comes from dependents. */
  migrated(id: string): boolean;
  /** No open item depends on it through an item dependency; in a migrated project only a root's stored priority counts. */
  isRoot(id: string): boolean;
  /**
   * The priority shown. Migrated: a root's stored priority, raised by the open items
   * depending on it, transitively. Unmigrated: the legacy effective priority,
   * raised by open migrated dependents too.
   */
  priorityOf(id: string): Priority | "";
  /** LEGACY PRIORITY: the priority written on an unmigrated item or its leaves. */
  writtenPriorityOf(id: string): Priority | "";
  /** LEGACY PRIORITY: the unmigrated waiter whose wait raised this unmigrated item, for the struck original priority. */
  raisedBy(id: string): string | null;
  depsOf(id: string): Array<{ kind: "item" | "card"; id: string; why: string; open: boolean; missing: boolean }>;
  dependents(id: string): Array<{ id: string; why: string }>;
  cardDependents(key: string): Array<{ id: string; why: string }>;
  cardsOf(id: string): string[];
  askPending(id: string): boolean;
  cardWaiting(key: string): boolean;
  /** A waiting card that names the work stopped until the owner rules (its `blocks`). */
  cardBlocking(key: string): boolean;
  needsOwner(id: string): boolean;
  /** An owner action is pending (an ask, always blocking) or a card of the item is blocking. */
  ownerBlocking(id: string): boolean;
  /** Blocking waits in the item's subtree, the item included: pending asks plus blocking cards. */
  blockingBelow(id: string): number;
  /** Waiting cards without `blocks` in the item's subtree, the item included. */
  nonBlockingBelow(id: string): number;
  isArchived(id: string): boolean;
  inArchive(id: string): boolean;
  onCycle(id: string): boolean;
  checks(id: string): Check[];
  /** Stalled wip leaves in the item's subtree, the item itself included. */
  stalledBelow(id: string): number;
  stepDays(step: ItemStep): number;
  stepsRatio(id: string): { done: number; total: number };
  stepLine(step: ItemStep): string;
  compareSiblings(a: string, b: string): number;
}

type Dependency = ReturnType<Rules["depsOf"]>[number];
const PRIORITIES: Priority[] = ["P0", "P1", "P2"];
// These are the page's actual ANSWER prefixes (approve is 同意, not 批准).
const ANSWER = { approve: "同意：", done: "已完成：" };
// A head states its completion condition under a heading or bold label naming it.
const DONE_WHEN = /^#{1,6}[ \t].*(完成条件|怎样算完成)|\*\*[^*\n]*(完成条件|怎样算完成)[^*\n]*\*\*/m;

/** A Rules object belongs to one immutable snapshot. Create another after a write.
 * Array/object results are defensive copies; item() returns the snapshot's item.
 * Missing items have no metadata; tree queries still include dangling children.
 */
export const STALLED_AFTER_MS = 2 * 60 * 60 * 1000;
export const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

export function rules(s: Pick<Snapshot, "board" | "items" | "decisions" | "notes" | "owner"> & Partial<Pick<Snapshot, "activity" | "notices" | "glossaries">>, now = Date.now()): Rules {
  function stepDays(step: ItemStep): number { return step.since ? Math.max(0, Math.floor((now - Date.parse(step.since)) / (24 * 60 * 60 * 1000))) : 0; }
  function stepsRatio(id: string): { done: number; total: number } {
    const steps = (s.items[id]?.steps ?? []).filter(step => step.state !== "dropped");
    return { done: steps.filter(step => step.state === "done").length, total: steps.length };
  }
  function stepLine(step: ItemStep): string {
    if (step.state === "done") return `✓ ${step.text} (${step.doneAt!.slice(5, 10)})`;
    if (step.state === "doing") return `● ${step.text} — ${stepDays(step)} 天${step.waits ? `，等 ${step.waits}` : ""}`;
    if (step.state === "dropped") return `✗ ${step.text} — ${step.reason}`;
    return `○ ${step.text}`;
  }
  const memo = new Map<string, Map<string, unknown>>();
  function cached<T>(name: string, key: string, make: () => T): T {
    let values = memo.get(name);
    if (!values) { values = new Map(); memo.set(name, values); }
    if (!values.has(key)) values.set(key, make());
    return values.get(key) as T;
  }
  function index() {
    return cached("index", "", () => {
      const items = new Map(Object.entries(s.items));
      const children = new Map<string, string[]>();
      const notes = new Map<string, Note[]>();
      const cards = new Map<string, string[]>();
      for (const [id, it] of items) {
        const p = it.parent || "";
        const list = children.get(p) || [];
        list.push(id); children.set(p, list);
      }
      // Public children() is unsorted; legacy recursive traversal used order.
      const orderedChildren = new Map([...children].map(([p, ids]) => [p, ids.slice().sort(byOrder)]));
      for (const n of Object.values(s.notes)) {
        const list = notes.get(n.target) || [];
        list.push(n); notes.set(n.target, list);
      }
      for (const [key, d] of Object.entries(s.decisions)) {
        const list = cards.get(d.item) || [];
        list.push(key); cards.set(d.item, list);
      }
      for (const list of cards.values()) list.sort((a, b) => (s.decisions[a]?.order || 0) - (s.decisions[b]?.order || 0));
      return { items, children, orderedChildren, notes, cards, decisions: new Map(Object.entries(s.decisions)) };
    });
  }
  // Called while building the index too, so it must not call index().
  function byOrder(a: string, b: string): number { return (s.items[a]?.order || 0) - (s.items[b]?.order || 0); }
  const item = (id: string): Item | undefined => index().items.get(id);
  const kids = (id: string): string[] => index().orderedChildren.get(id) || [];
  const notesOf = (target: string): Note[] => index().notes.get(target) || [];
  function parentOf(id: string): string | undefined {
    const p = item(id)?.parent;
    return p && item(p) ? p : undefined;
  }
  function ancestors(id: string): string[] {
    return cached("ancestors", id, () => {
      const out: string[] = [], seen = new Set([id]);
      for (let p = parentOf(id); p && !seen.has(p); p = parentOf(p)) { seen.add(p); out.push(p); }
      return out;
    });
  }
  function lineOf(id: string): string { return ancestors(id).at(-1) || id; }
  function groupOf(id: string): string { return item(lineOf(id))?.group || ""; }
  function isRequest(id: string): boolean { return !!item(id)?.request && isOpenWork(id); }
  function areas(include?: (id: string) => boolean): string[] {
    function ordered(): string[] {
      const list = kids("").filter(id => !isRequest(id) && (!include || include(id))), groups = new Map<string, number>();
      for (const id of list) { const g = item(id)?.group || ""; if (!groups.has(g)) groups.set(g, groups.size); }
      return list.sort((a, b) => groups.get(item(a)?.group || "")! - groups.get(item(b)?.group || "")! || byOrder(a, b));
    }
    return include ? ordered() : cached("areas", "", ordered);
  }
  function statusWalk(id: string, seen: Set<string>): Status | undefined {
    const it = item(id);
    if (it?.record) return undefined;
    if (seen.has(id)) return it?.status || "todo";
    seen.add(id);
    const all = kids(id).map(k => statusWalk(k, seen)).filter((st): st is Status => st !== undefined);
    if (!all.length) return it?.status || "todo";
    const live = all.filter(st => st !== "cancelled");
    if (!live.length) return "cancelled";
    if (live.includes("wip")) return "wip";
    if (live.includes("blocked")) return "blocked";
    return live.every(st => st === "done") ? "done" : "todo";
  }
  function statusOf(id: string): Status | undefined { return cached("status", id, () => statusWalk(id, new Set())); }
  function isLeaf(id: string): boolean { return !kids(id).length; }
  function isStatusLeaf(id: string): boolean { return !kids(id).some(k => !item(k)?.record); }
  function ended(id: string): boolean { const st = statusOf(id); return st === "done" || st === "cancelled"; }
  function isOpenWork(id: string): boolean { return !!item(id) && statusOf(id) !== undefined && !ended(id); }
  function depsOf(id: string): Dependency[] {
    return cached("deps", id, () => (item(id)?.deps || []).map(e => {
      if ("id" in e) return { kind: "item", id: e.id, why: e.why, missing: !item(e.id), open: isOpenWork(e.id) };
      const d = index().decisions.get(e.card);
      return { kind: "card", id: e.card, why: e.why, missing: !d, open: d?.status === "open" };
    }));
  }
  function reverseDeps() {
    return cached("reverseDeps", "", () => {
      const items = new Map<string, Array<{ id: string; why: string }>>(), cards = new Map<string, Array<{ id: string; why: string }>>();
      for (const id of index().items.keys()) {
        for (const e of depsOf(id)) {
          const m = e.kind === "item" ? items : cards, list = m.get(e.id) || [];
          // Legacy waitedBy deduplicates a waiter, and whyOf takes its first why.
          if (!list.some(w => w.id === id)) list.push({ id, why: e.why });
          m.set(e.id, list);
        }
      }
      return { items, cards };
    });
  }
  function cardsOf(id: string): string[] { return index().cards.get(id) || []; }
  function askPending(id: string): boolean {
    const ask = item(id)?.ask;
    return !!ask && !notesOf("it:" + id).some(n => (n.kind === "approve" || n.kind === "done") && n.state !== "draft" && (n.answerText ?? n.text) === ANSWER[n.kind] + ask.text);
  }
  function cardWaiting(key: string): boolean {
    return index().decisions.get(key)?.status === "open" && !notesOf("q:" + key).some(n => n.kind === "choice" && n.state !== "draft");
  }
  function cardBlocking(key: string): boolean { return cardWaiting(key) && !!index().decisions.get(key)?.blocks; }
  function ownerBlocking(id: string): boolean { return askPending(id) || cardsOf(id).some(cardBlocking); }
  function subtreeCount(id: string, own: (id: string) => number): number {
    const seen = new Set<string>(), walk = (v: string): number => { if (seen.has(v)) return 0; seen.add(v); return own(v) + kids(v).reduce((n, k) => n + walk(k), 0); };
    return walk(id);
  }
  const blockingOwn = (id: string): number => Number(askPending(id)) + cardsOf(id).filter(cardBlocking).length;
  const nonBlockingOwn = (id: string): number => cardsOf(id).filter(k => cardWaiting(k) && !cardBlocking(k)).length;
  function needsOwner(id: string): boolean {
    return cached("needsOwner", id, () => askPending(id) || cardsOf(id).some(cardWaiting));
  }
  function isArchived(id: string): boolean {
    return cached("archived", id, () => {
      const it = item(id), at = Object.hasOwn(s.owner.archived, id) ? s.owner.archived[id] : undefined;
      if (!it || !at) return false;
      const times = [it.updated, ...it.log.map(e => e.at), ...notesOf("it:" + id).filter(n => n.reply).map(n => n.repliedAt || n.sentAt || n.at)];
      return !(times.sort().at(-1)! > at);
    });
  }
  function inArchive(id: string): boolean { return cached("inArchive", id, () => [id, ...ancestors(id)].some(isArchived)); }
  function migrated(id: string): boolean {
    return cached("migrated", id, () => !!s.board.projects.find(p => p.name === groupOf(id))?.migrated);
  }
  const waiters = (id: string): string[] => (reverseDeps().items.get(id) || []).map(w => w.id);
  function isRoot(id: string): boolean { return !!item(id) && !waiters(id).some(w => !ended(w)); }
  const legacy = legacyPriority({ item, kids, isLeaf, statusOf, ended, inArchive, ancestors, waiters, migrated, cached }); // LEGACY PRIORITY
  // One least fixpoint over both kinds of project. A migrated item starts at its
  // stored priority when it is a root and takes the highest of its open
  // dependents; an unmigrated leaf starts at its stored priority and is raised
  // by the legacy rule (legacy-priority.ts). Every rank only falls, from at most
  // 3, so the loop ends, cycles included; a closed item passes nothing on.
  function ranks() {
    return cached("ranks", "", () => {
      const ids = [...index().items.keys()], rank = new Map<string, number>(), why = new Map<string, string>();
      for (const id of ids) if (migrated(id) ? isRoot(id) : isLeaf(id)) rank.set(id, rankOfPriority(item(id)!.priority));
      const rankOf = (id: string): number => migrated(id) || isLeaf(id) ? rank.get(id) ?? 3 : legacy.parentRank(id, rank);
      for (let changed = true; changed;) {
        changed = false;
        for (const id of ids) {
          if (migrated(id)) {
            const r = Math.min(rank.get(id) ?? 3, ...waiters(id).filter(w => !ended(w)).map(rankOf));
            if (r < (rank.get(id) ?? 3)) { rank.set(id, r); changed = true; }
          } else if (isLeaf(id) && legacy.relax(id, rank, why, rankOf)) changed = true;
        }
      }
      return { rankOf, why };
    });
  }
  function priorityOf(id: string): Priority | "" { return cached("priority", id, () => PRIORITIES[ranks().rankOf(id)] || ""); }
  // LEGACY PRIORITY
  function raisedBy(id: string): string | null { return migrated(id) ? null : cached("raisedBy", id, () => legacy.raisedBy(id, priorityOf, ranks().why)); }
  function cycles(): Set<string> {
    return cached("cycles", "", () => {
      const idx = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>(), out = new Set<string>();
      let n = 0;
      const next = (id: string): string[] => kids(id).concat(depsOf(id).filter(e => e.kind === "item" && !e.missing).map(e => e.id));
      function visit(v: string): void {
        idx.set(v, n); low.set(v, n++); stack.push(v); on.add(v);
        for (const w of next(v)) {
          if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
          else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        }
        if (low.get(v) === idx.get(v)) {
          const component: string[] = [];
          let w: string;
          do { w = stack.pop()!; on.delete(w); component.push(w); } while (w !== v);
          if (component.length > 1 || depsOf(v).some(e => e.kind === "item" && e.id === v)) for (const id of component) out.add(id);
        }
      }
      for (const id of index().items.keys()) if (!idx.has(id)) visit(id);
      return out;
    });
  }
  // Current document times cover imported/synthetic snapshots; history retains
  // overwritten revisions and deleted cards/notes, which current fields cannot.
  function activity() {
    return cached("activity", "", () => {
      const writes: number[] = [], changed = new Map<string, number>();
      const add = (at: string | undefined, id?: string) => {
        const time = at ? Date.parse(at) : NaN;
        if (!Number.isFinite(time) || time > now) return;
        writes.push(time);
        if (id) changed.set(id, Math.max(changed.get(id) ?? -Infinity, time));
      };
      for (const at of s.activity?.writes ?? []) add(at);
      for (const [id, at] of Object.entries(s.activity?.items ?? {})) add(at, id);
      for (const [id, it] of Object.entries(s.items)) {
        add(it.created, id); add(it.updated, id);
        for (const entry of it.log) add(entry.at, id);
      }
      for (const card of Object.values(s.decisions)) { add(card.at, card.item); add(card.updated, card.item); add(card.ruledAt, card.item); }
      for (const note of Object.values(s.notes)) {
        const id = note.target.startsWith("it:") ? note.target.slice(3) : s.decisions[note.target.slice(2)]?.item;
        add(note.at, id); add(note.sentAt, id); add(note.repliedAt, id);
      }
      for (const notice of Object.values(s.notices ?? {})) { add(notice.at); add(notice.read); }
      for (const glossary of Object.values(s.glossaries ?? {})) for (const term of glossary.terms) add(term.updated);
      const intervals: Array<[number, number]> = [];
      for (const at of writes.sort((a, b) => a - b)) {
        const end = Math.min(now, at + ACTIVE_WINDOW_MS), previous = intervals.at(-1);
        if (previous && previous[1] >= at) previous[1] = Math.max(previous[1], end);
        else intervals.push([at, end]);
      }
      return { intervals, changed };
    });
  }
  function stalled(id: string): boolean {
    const { intervals, changed } = activity(), seen = new Set<string>();
    function latest(key: string): number {
      if (seen.has(key)) return -Infinity;
      seen.add(key);
      return Math.max(changed.get(key) ?? -Infinity, ...kids(key).map(latest));
    }
    const since = latest(id);
    if (!Number.isFinite(since)) return false;
    return intervals.reduce((total, [start, end]) => total + Math.max(0, end - Math.max(start, since)), 0) >= STALLED_AFTER_MS;
  }
  function checks(id: string): Check[] {
    return cached("checks", id, () => {
      const it = item(id), out: Check[] = [];
      if (!it || inArchive(id)) return out;
      const st = statusOf(id), leaf = isStatusLeaf(id), parent = parentOf(id), deps = depsOf(id);
      for (const e of deps) {
        const target = { kind: e.kind, id: e.id };
        if (e.missing) out.push({ text: (e.kind === "item" ? "依赖的条目不存在：" : "依赖的决策卡不存在：") + e.id });
        else if (st !== undefined && e.kind === "item" && statusOf(e.id) === "cancelled" && !(migrated(id) && parentOf(e.id) === id) && !ended(id)) out.push({ text: "依赖的条目已取消", target });
        else if (!e.why.trim() && !ended(id)) out.push({ text: "依赖没写为什么：", target });
      }
      if (cycles().has(id)) out.push({ text: "依赖成环" });
      if (!it.parent) {
        const project = s.board.projects.find(p => p.name === it.group);
        if (!project) out.push({ text: "项目没有配置：" + (it.group || "") });
      }
      if (it.parent && !parent) out.push({ text: "上级条目不存在：" + it.parent });
      if (parent && !ended(id) && !depsOf(parent).some(e => e.kind === "item" && e.id === id)) out.push({ text: "上级没有把它列在依赖里（上级必须是直接依赖它的条目）：", target: { kind: "item", id: parent } });
      const open = deps.filter(e => e.open);
      if (leaf && st === "blocked" && deps.length && !open.length) out.push({ text: "可解除阻塞：等的都已完成" });
      if (leaf && st === "blocked" && !deps.length && !needsOwner(id)) out.push({ text: "卡住了，但没写在等什么" });
      if (leaf && st === "wip" && stalled(id)) out.push({ text: "进行中但 2 小时（活跃时间）没有动静", label: STALLED_LABEL });
      if (leaf && st === "wip" && open.length) out.push({ text: "标为进行中，但还在等别的", target: { kind: open[0]!.kind, id: open[0]!.id } });
      if (st !== undefined && migrated(id) && !ended(id) && !DONE_WHEN.test(it.head || "")) out.push({ text: "正文没写完成条件" });
      if (st !== undefined && migrated(id) && !ended(id) && isRoot(id) && !it.priority) out.push({ text: "没有未完成的条目依赖它，却没写优先级" });
      return out;
    });
  }
  return {
    stepDays, stepsRatio, stepLine,
    stalledBelow: id => cached("stalledBelow", id, () => subtreeCount(id, v => Number(checks(v).some(c => c.label === STALLED_LABEL)))),
    item, parentOf, children: id => (index().children.get(id) || []).slice(), areas: include => areas(include).slice(),
    ancestors: id => ancestors(id).slice(), lineOf, groupOf, projectOf: groupOf,
    isRequest, isOpenWork, inbox: project => kids("").filter(id => groupOf(id) === project && isRequest(id)).sort((a,b) => Date.parse(item(a)!.request!.at) - Date.parse(item(b)!.request!.at) || a.localeCompare(b)),
    isLeaf, isStatusLeaf, statusOf, migrated, isRoot, priorityOf, writtenPriorityOf: legacy.writtenPriorityOf, raisedBy,
    depsOf: id => depsOf(id).map(e => ({ ...e })),
    dependents: id => (reverseDeps().items.get(id) || []).map(e => ({ ...e })),
    cardDependents: key => (reverseDeps().cards.get(key) || []).map(e => ({ ...e })),
    cardsOf: id => cardsOf(id).slice(), askPending, cardWaiting, cardBlocking, ownerBlocking, needsOwner,
    blockingBelow: id => cached("blockingBelow", id, () => subtreeCount(id, blockingOwn)), nonBlockingBelow: id => cached("nonBlockingBelow", id, () => subtreeCount(id, nonBlockingOwn)), isArchived, inArchive, onCycle: id => cycles().has(id),
    checks: id => checks(id).map(c => c.target ? { ...c, target: { ...c.target } } : { ...c }),
    compareSiblings: (a, b) => rankOfPriority(priorityOf(a)) - rankOfPriority(priorityOf(b)) || Number(ended(a)) - Number(ended(b)) || byOrder(a, b),
  };
}
