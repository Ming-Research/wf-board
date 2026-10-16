// Pure snapshot-derived rules shared by the server and the owner's page.
// The plan is the single source for ownership, status, priority and progress.
import type { Decision, Item, PlanStep, PlanRow, PlanRowInput, ItemTarget, ItemTargetInput, Note, Priority, Project, Snapshot, Status } from "./model.ts";
import { planRowId, tagsRequired } from "./model.ts";

/** Project list order is page order; only the coordinator may place a project after another. */
export function projectOrderAfter(projects: readonly Project[], name: string, after: string, author: string): Project[] {
  if (author !== "总管") throw new Error("after: only the coordinator project 总管 may reorder projects");
  if (after === name) throw new Error("after: a project cannot follow itself");
  const project = projects.find(p => p.name === name);
  if (!project) throw new Error(`project ${name}: choose a configured project with projects`);
  const remaining = projects.filter(p => p.name !== name), index = remaining.findIndex(p => p.name === after);
  if (index < 0) throw new Error(`after ${after}: choose a configured project with projects`);
  return [...remaining.slice(0, index + 1), project, ...remaining.slice(index + 1)];
}

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

function sameRow(a: PlanRow, b: PlanRow): boolean {
  const { after: aa, ...av } = a, { after: ba, ...bv } = b;
  const ar: Record<string, unknown> = av, br: Record<string, unknown> = bv;
  const ak = Object.keys(ar), bk = Object.keys(br);
  return ak.length === bk.length && ak.every(key => ar[key] === br[key]) &&
    (aa === undefined ? ba === undefined : ba !== undefined && aa.length === ba.length && aa.every((id, i) => id === ba[i]));
}
/** Current added or changed lines; moving an unchanged line does not highlight it. */
export function changedItemPlan(before: readonly PlanRow[] = [], after: readonly PlanRow[] = []): PlanRow[] {
  const previous = new Map(before.map(row => [row.id, row]));
  return after.filter(row => { const old = previous.get(row.id); return !old || !sameRow(old, row); });
}
/** Order and removals are progress changes too, even without a surviving changed line. */
export function planChanged(before: readonly PlanRow[] = [], after: readonly PlanRow[] = []): boolean {
  return before.length !== after.length || before.some((row, i) => !sameRow(row, after[i]!));
}
/** Retain earlier transition dates, stamp only entry into the current state. */
export function stampPlanRow(input: PlanRowInput, previous: PlanRow | undefined, at: string): PlanRow {
  if (!("text" in input)) return { ...structuredClone(input), id: planRowId(input) };
  const step: PlanStep = structuredClone(input), old = previous && "text" in previous ? previous : undefined;
  for (const field of ["doneAt", "since", "droppedAt"] as const) if (old?.[field] !== undefined) step[field] = old[field];
  const date = input.state === "done" ? "doneAt" : input.state === "doing" ? "since" : input.state === "dropped" ? "droppedAt" : undefined;
  if (date && (old?.state !== input.state || !step[date])) step[date] = at;
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

/** A title longer than this many characters (spaces not counted) gets a check. */
export const TITLE_MAX_CHARS = 20;
/** The visible tag of a check whose own label is not set. */
export const CHECK_LABEL = "需核对";
/** A WIP item with its own doing step quiet for STALLED_AFTER_MS of active time carries this label instead. */
export const STALLED_LABEL = "无人推进";
/** An open item with a todo step that says what it waits on in text the board cannot read carries this label. */
export const WAITS_TEXT_LABEL = "在等文字";
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
  /** Top items grouped in configured project order, after filtering. */
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
  /** Nearest explicit pause on this item or its same-project ownership chain. */
  pausedBy(id: string): string | undefined;
  /** Effective pause on open work; done and cancelled always win. */
  isPaused(id: string): boolean;
  /** Open work directly owned by a record has no root or stored-priority role. */
  isBacklog(id: string): boolean;
  /** No open work item points at it, and it is not open record-owned work. */
  isRoot(id: string): boolean;
  /** A root's stored priority, otherwise the highest of open work dependents. */
  priorityOf(id: string): Priority | "";
  depsOf(id: string): Array<{ kind: "item" | "card"; id: string; own?: boolean; open: boolean; missing: boolean }>;
  dependents(id: string): Array<{ id: string; own?: boolean }>;
  cardDependents(key: string): Array<{ id: string; own?: boolean }>;
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
  onCycle(id: string): boolean;
  checks(id: string): Check[];
  /** Stalled wip leaves in the item's subtree, the item itself included. */
  stalledBelow(id: string): number;
  stepDays(step: PlanStep): number;
  stepLine(step: PlanStep): string;
  planRows(id: string): DerivedPlanRow[];
  planGroups(id: string): Array<{ start: number; end: number; level: number }>;
  planRatio(id: string): { done: number; total: number };
  compareSiblings(a: string, b: string): number;
}

type Dependency = ReturnType<Rules["depsOf"]>[number];
export interface DerivedPlanRow {
  row: PlanRow;
  state: "resolved" | "progress" | "waiting" | "open";
  ready: boolean;
  level: number;
  glyph: string;
  dropped: boolean;
  excluded: boolean;
}
const PRIORITIES: Priority[] = ["P0", "P1", "P2"];
const rankOfPriority = (priority: Priority | "" | undefined): number => priority ? PRIORITIES.indexOf(priority) : 3;
// These are the page's actual ANSWER prefixes (approve is 同意, not 批准).
const ANSWER = { approve: "同意：", done: "已完成：" };

/** A Rules object belongs to one immutable snapshot. Create another after a write.
 * Array/object results are defensive copies; item() returns the snapshot's item.
 * Missing items have no metadata; tree queries still include dangling children.
 */
export const STALLED_AFTER_MS = 60 * 60 * 1000;
export const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

type ActivityInput = Pick<Snapshot, "items" | "decisions" | "notes"> & Partial<Pick<Snapshot, "activity" | "notices" | "glossaries">>;
/** One source of activity times: the times it gives, and the item they reset (none for board-wide writes). */
interface Contribution { id: string | undefined; times: number[]; target?: string }
const parsedTimes = (values: ReadonlyArray<string | undefined>): number[] => values.flatMap(at => { const time = at ? Date.parse(at) : NaN; return Number.isFinite(time) ? [time] : []; });
function insertSorted(list: number[], value: number): void {
  let low = 0, high = list.length;
  while (low < high) { const middle = (low + high) >> 1; if (list[middle]! <= value) low = middle + 1; else high = middle; }
  list.splice(low, 0, value);
}
function removeSorted(list: number[], value: number): void {
  let low = 0, high = list.length;
  while (low < high) { const middle = (low + high) >> 1; if (list[middle]! < value) low = middle + 1; else high = middle; }
  if (list[low] !== value) throw new Error("activity index: removing a time it does not hold");
  list.splice(low, 1);
}
const isSorted = (list: readonly string[]): boolean => list.every((value, i) => i === 0 || list[i - 1]! <= value);
/** What `b` holds that `a` does not, and the reverse, counting repeats. */
function stringDelta(a: readonly string[], b: readonly string[]): { added: string[]; removed: string[] } {
  const added: string[] = [], removed: string[] = [];
  if (isSorted(a) && isSorted(b)) {
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (j >= b.length || i < a.length && a[i]! < b[j]!) removed.push(a[i++]!);
      else if (i >= a.length || b[j]! < a[i]!) added.push(b[j++]!);
      else { i++; j++; }
    }
    return { added, removed };
  }
  const counts = new Map<string, number>();
  for (const value of a) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of b) { const n = counts.get(value) ?? 0; if (n > 0) counts.set(value, n - 1); else added.push(value); }
  for (const [value, n] of counts) for (let k = 0; k < n; k++) removed.push(value);
  return { added, removed };
}

/**
 * The parsed times the stalled check reads, kept across writes instead of
 * rescanning every log, write and note for each Rules object. It holds every
 * finite time from the same sources as the from-scratch scan in `rules`
 * (content writes, the per-item last changes, document times), and filters by
 * `now` only when asked, so one index serves any time. `advance` diffs a later
 * (or any other) snapshot by document identity and returns a new index; an
 * index never changes after it is made, so rules built on it stay valid.
 * Equivalence with the from-scratch scan is tested in test/derived.test.ts.
 */
export class ActivityIndex {
  /** Every time, ascending, repeats kept. */
  private readonly all: number[];
  /** Each item's times, ascending. */
  private readonly perItem: Map<string, number[]>;
  /** Each source's contribution: "a:" activity item entries, "i:" items, "d:" cards, "n:" notes, "x:" notices, "g:" glossaries. */
  private readonly sources: Map<string, Contribution>;
  /** Notes by the card they target, re-resolved when that card changes or goes. */
  private readonly cardNotes: Map<string, Set<string>>;
  /** The parts of the snapshot this index reflects, compared by identity. */
  private readonly seen: ActivityInput;
  private constructor(all: number[], perItem: Map<string, number[]>, sources: Map<string, Contribution>, cardNotes: Map<string, Set<string>>, seen: ActivityInput) {
    this.all = all; this.perItem = perItem; this.sources = sources; this.cardNotes = cardNotes; this.seen = seen;
  }
  static build(s: ActivityInput): ActivityIndex {
    const index = new ActivityIndex([], new Map(), new Map(), new Map(), { items: {}, decisions: {}, notes: {}, notices: {}, glossaries: {}, activity: { writes: [], items: {} } });
    return index.advance(s);
  }
  /** Whether this index was made for exactly these documents. */
  reflects(s: ActivityInput): boolean {
    const seen = this.seen;
    return seen.items === s.items && seen.decisions === s.decisions && seen.notes === s.notes && seen.activity === s.activity
      && seen.notices === s.notices && seen.glossaries === s.glossaries;
  }
  /** The index of `s`, sharing what did not change. */
  advance(s: ActivityInput): ActivityIndex {
    if (this.reflects(s)) return this;
    const all = this.all.slice(), perItem = new Map(this.perItem), sources = new Map(this.sources), cardNotes = new Map(this.cardNotes);
    const ownItems = new Set<string>(), ownCards = new Set<string>();
    const itemTimes = (id: string): number[] => {
      if (!ownItems.has(id)) { ownItems.add(id); perItem.set(id, (perItem.get(id) ?? []).slice()); }
      return perItem.get(id)!;
    };
    const cardSet = (key: string): Set<string> => {
      if (!ownCards.has(key)) { ownCards.add(key); cardNotes.set(key, new Set(cardNotes.get(key))); }
      return cardNotes.get(key)!;
    };
    const replace = (key: string, next: Contribution | undefined): void => {
      const old = sources.get(key);
      if (old) {
        for (const time of old.times) { removeSorted(all, time); if (old.id) removeSorted(itemTimes(old.id), time); }
        if (old.target) cardSet(old.target).delete(key.slice(2));
        sources.delete(key);
      }
      if (next && (next.times.length || next.target)) {
        for (const time of next.times) { insertSorted(all, time); if (next.id) insertSorted(itemTimes(next.id), time); }
        if (next.target) cardSet(next.target).add(key.slice(2));
        sources.set(key, next);
      }
    };
    const note = (key: string, n: Note | undefined): Contribution | undefined => {
      if (!n) return undefined;
      const card = n.target.startsWith("q:") ? n.target.slice(2) : undefined;
      const id = card === undefined ? n.target.slice(3) : Object.hasOwn(s.decisions, card) ? s.decisions[card]!.item : undefined;
      return { id: id || undefined, times: parsedTimes([n.at, n.sentAt, n.repliedAt]), ...(card === undefined ? {} : { target: card }) };
    };
    // Every key whose document is a different object in `s` than in what this index saw.
    function changedKeys<T>(before: Readonly<Record<string, T>> | undefined, after: Readonly<Record<string, T>> | undefined): string[] {
      const a = before ?? {}, b = after ?? {};
      if (a === b) return [];
      const keys: string[] = [];
      for (const key of Object.keys(b)) if (!Object.hasOwn(a, key) || a[key] !== b[key]) keys.push(key);
      for (const key of Object.keys(a)) if (!Object.hasOwn(b, key)) keys.push(key);
      return keys;
    }
    const get = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined => record && Object.hasOwn(record, key) ? record[key] : undefined;
    const seen = this.seen, before = seen.activity, after = s.activity;
    if (before !== after) {
      const { added, removed } = stringDelta(before?.writes ?? [], after?.writes ?? []);
      for (const time of parsedTimes(removed)) removeSorted(all, time);
      for (const time of parsedTimes(added)) insertSorted(all, time);
      for (const id of changedKeys(before?.items, after?.items)) {
        const at = get(after?.items, id);
        replace("a:" + id, at === undefined ? undefined : { id, times: parsedTimes([at]) });
      }
    }
    for (const id of changedKeys(seen.items, s.items)) {
      const it = get(s.items, id);
      replace("i:" + id, it && { id, times: parsedTimes([it.created, it.updated, ...it.log.map(entry => entry.at)]) });
    }
    const cards = changedKeys(seen.decisions, s.decisions);
    for (const key of cards) {
      const card = get(s.decisions, key);
      replace("d:" + key, card && { id: card.item || undefined, times: parsedTimes([card.at, card.updated, card.ruledAt]) });
    }
    const notes = new Set(changedKeys(seen.notes, s.notes));
    // A note on a card resets the card's item: a card that moved or went re-resolves its notes.
    for (const key of cards) for (const n of cardNotes.get(key) ?? []) notes.add(n);
    for (const key of notes) replace("n:" + key, note(key, get(s.notes, key)));
    for (const key of changedKeys(seen.notices, s.notices)) {
      const notice = get(s.notices, key);
      replace("x:" + key, notice && { id: undefined, times: parsedTimes([notice.at, notice.read]) });
    }
    for (const key of changedKeys(seen.glossaries, s.glossaries)) {
      const glossary = get(s.glossaries, key);
      replace("g:" + key, glossary && { id: undefined, times: parsedTimes(glossary.terms.map(term => term.updated)) });
    }
    for (const id of ownItems) if (!perItem.get(id)!.length) perItem.delete(id);
    for (const key of ownCards) if (!cardNotes.get(key)!.size) cardNotes.delete(key);
    return new ActivityIndex(all, perItem, sources, cardNotes, { items: s.items, decisions: s.decisions, notes: s.notes, notices: s.notices, glossaries: s.glossaries, activity: s.activity });
  }
  /** The union of active windows up to `now`: what the from-scratch scan in `rules` gives. */
  intervals(now: number): Array<[number, number]> {
    const intervals: Array<[number, number]> = [];
    for (const at of this.all) {
      if (at > now) break;
      const end = Math.min(now, at + ACTIVE_WINDOW_MS), previous = intervals.at(-1);
      if (previous && previous[1] >= at) previous[1] = Math.max(previous[1], end);
      else intervals.push([at, end]);
    }
    return intervals;
  }
  /** The item's last change at or before `now`, or -Infinity. */
  changedAt(id: string, now: number): number {
    const times = this.perItem.get(id);
    if (!times) return -Infinity;
    for (let i = times.length - 1; i >= 0; i--) if (times[i]! <= now) return times[i]!;
    return -Infinity;
  }
}

/** `list` with `value` inserted at its sorted place: the same array as pushing it and sorting. */
export function withSorted(list: readonly string[], value: string): string[] {
  let low = 0, high = list.length;
  while (low < high) { const middle = (low + high) >> 1; if (list[middle]! <= value) low = middle + 1; else high = middle; }
  return [...list.slice(0, low), value, ...list.slice(low)];
}
/** How one commit changed Snapshot["activity"]: the content write's time (absent for an owner-only commit), the items
 * whose last change moved, and each item whose pause spans changed with its whole new list. `from` is the head before
 * the commit: the delta applies only to the snapshot at that head. */
export interface ActivityDelta { from: string; write?: string; items: Record<string, string>; pauses: Record<string, Array<{ start: string; end?: string }>>; sessions: Record<string, { name: string; at: string }> }
/** The activity after `delta`, equal to the store's (docs/design.md, live updates); unchanged activity stays the same object. */
export function applyActivityDelta(activity: Snapshot["activity"], delta: ActivityDelta): Snapshot["activity"] {
  if (delta.write === undefined && !Object.keys(delta.items).length && !Object.keys(delta.pauses).length && !Object.keys(delta.sessions ?? {}).length) return activity;
  const base = activity ?? { writes: [], items: {} };
  const pauses = base.pauses || Object.keys(delta.pauses).length ? { ...base.pauses, ...delta.pauses } : undefined;
  const sessions = base.sessions || Object.keys(delta.sessions ?? {}).length ? { ...base.sessions, ...delta.sessions } : undefined;
  return { writes: delta.write === undefined ? base.writes : withSorted(base.writes, delta.write), items: { ...base.items, ...delta.items }, ...(pauses ? { pauses } : {}), ...(sessions ? { sessions } : {}) };
}

/** Everything derived the page paints for an item (web/app.ts): its row, its plan rows and those of its owned items,
 * and the labels of what it waits on and what waits on it. The page repaints an item when this changes. */
export function presentationSignature(r: Rules, decisions: Readonly<Record<string, Decision>>, id: string): string {
  const it = r.item(id);
  const label = (kind: string, key: string): unknown[] => {
    if (kind === "card") return [decisions[key]?.question, decisions[key]?.status, decisions[key]?.blocks];
    const owner = r.parentOf(key);
    return [r.item(key)?.title, r.groupOf(key), r.statusOf(key), r.priorityOf(key), owner, owner ? r.item(owner)?.title : null, r.planRatio(key)];
  };
  const deps = r.depsOf(id).map(d => [d, ...label(d.kind, d.id)]);
  const waiters = r.dependents(id).map(d => [d, ...label("item", d.id)]);
  return JSON.stringify([r.groupOf(id), r.statusOf(id), r.priorityOf(id), r.checks(id), it?.tags ?? [], it?.difficulty ?? null, r.stalledBelow(id), r.pausedBy(id), r.item(r.pausedBy(id) || "")?.paused, it?.paused, deps, waiters,
    r.planRows(id).map(row => [row, "text" in row.row ? r.stepLine(row.row) : null, "item" in row.row && row.row.own ? r.planRows(row.row.item).map(child => [child, "text" in child.row ? r.stepLine(child.row) : "item" in child.row ? label("item", child.row.item) : label("card", child.row.card)]) : null])]);
}

/**
 * The items whose page presentation a live update can change, from the items
 * it touched directly (`seeds`): what a full pass over every item would find
 * changed, without deriving every item. A derived value moves only along plan
 * edges (rows and their reverse), so the walk examines the neighbours of every
 * item whose derived summary changed, and stops at items whose summary did
 * not. The result adds every examined item's ancestors, whose subtree counts,
 * filters and owned-row lines read it. Elapsed time alone (active time, doing
 * days) is not a change here: the page re-signs everything on its minute timer.
 */
export function affectedItems(before: Rules, after: Rules, seeds: Iterable<string>): Set<string> {
  const summary = (r: Rules, id: string): string => {
    const it = r.item(id);
    if (!it) return "";
    const parent = r.parentOf(id), pausedBy = r.pausedBy(id);
    return JSON.stringify([it.title, r.groupOf(id), r.statusOf(id), r.isOpenWork(id), r.isPaused(id), pausedBy, pausedBy ? r.item(pausedBy)?.paused : null,
      r.priorityOf(id), parent, parent ? r.item(parent)?.title : null, r.onCycle(id), r.planRatio(id), r.isRequest(id), r.checks(id)]);
  };
  const neighbours = (id: string): string[] => [before, after].flatMap(r => [...r.depsOf(id).filter(d => d.kind === "item").map(d => d.id), ...r.dependents(id).map(d => d.id)]);
  const examined = new Set<string>(), queue: string[] = [];
  for (const id of seeds) if (!examined.has(id)) { examined.add(id); queue.push(id); }
  while (queue.length) {
    for (const next of neighbours(queue.pop()!)) {
      if (examined.has(next)) continue;
      examined.add(next);
      if (summary(before, next) !== summary(after, next)) queue.push(next);
    }
  }
  const out = new Set(examined);
  for (const id of examined) for (const r of [before, after]) for (const a of r.ancestors(id)) out.add(a);
  return out;
}
/** The items a live change touches directly, or null when it changes what every item reads (the board, the owner's
 * state, a glossary). Card and note changes reach the card's item and every plan waiting on the card; `activity`, the
 * change's activity delta, adds the items whose clock or pause spans it moved. */
export function changeSeeds(before: Pick<Snapshot, "decisions" | "notes">, after: Pick<Snapshot, "decisions" | "notes">, beforeRules: Rules, afterRules: Rules, changed: ReadonlyArray<{ kind: string; id: string }>, activity?: ActivityDelta): Set<string> | null {
  // Items whose last change or pause spans moved, including a note on a card deleted earlier, which only the store places.
  const seeds = new Set<string>([...Object.keys(activity?.items ?? {}), ...Object.keys(activity?.pauses ?? {})]);
  const card = (key: string) => {
    for (const s of [before, after]) { const owner = Object.hasOwn(s.decisions, key) ? s.decisions[key]!.item : undefined; if (owner) seeds.add(owner); }
    for (const r of [beforeRules, afterRules]) for (const waiter of r.cardDependents(key)) seeds.add(waiter.id);
  };
  for (const doc of changed) {
    if (doc.kind === "item") seeds.add(doc.id);
    else if (doc.kind === "decision") card(doc.id);
    else if (doc.kind === "note") {
      for (const s of [before, after]) {
        const target = Object.hasOwn(s.notes, doc.id) ? s.notes[doc.id]!.target : undefined;
        if (target?.startsWith("it:")) seeds.add(target.slice(3));
        else if (target?.startsWith("q:")) card(target.slice(2));
      }
    } else if (doc.kind !== "notice") return null;
  }
  return seeds;
}

/** Rules objects shared by every reader of one snapshot. A Rules object reads
 * `now` only for elapsed time (active time, doing days); readers within the
 * same minute share the one built at the first read of that minute, so its
 * results are exactly `rules(s, t)` for that first read's time `t`. The
 * activity index is advanced from the newest one instead of rebuilt. */
export class DerivedCache {
  private latest?: ActivityIndex;
  private readonly byState = new WeakMap<object, { bucket: number; rules: Rules }>();
  /** The activity index of `s`, advanced from the newest index this cache made. */
  activity(s: ActivityInput): ActivityIndex {
    this.latest = this.latest ? this.latest.advance(s) : ActivityIndex.build(s);
    return this.latest;
  }
  rules(s: RulesInput, now = Date.now()): Rules {
    const bucket = Math.floor(now / 60_000), hit = this.byState.get(s);
    if (hit?.bucket === bucket) return hit.rules;
    const made = rules(s, now, { activity: () => this.activity(s) });
    this.byState.set(s, { bucket, rules: made });
    return made;
  }
  /** Rules for a prospective state derived from `base`, not kept: its activity index is advanced from base's without replacing it. */
  candidate(base: ActivityInput, s: RulesInput, now = Date.now()): Rules {
    return rules(s, now, { activity: () => (this.latest?.reflects(base) ? this.latest : this.activity(base)).advance(s) });
  }
}

type RulesInput = Pick<Snapshot, "board" | "items" | "decisions" | "notes" | "owner"> & Partial<Pick<Snapshot, "activity" | "notices" | "glossaries">>;
/** `activity`, when given, must be the index of exactly `s` (ActivityIndex.build(s) or advanced to s); without it the times are scanned from `s`. */
export function rules(s: RulesInput, now = Date.now(), options: { activity?: ActivityIndex | (() => ActivityIndex) } = {}): Rules {
  function stepDays(step: PlanStep): number { return step.since ? Math.max(0, Math.floor((now - Date.parse(step.since)) / (24 * 60 * 60 * 1000))) : 0; }
  function stepLine(step: PlanStep): string {
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
      const owners = new Map<string, string[]>();
      const notes = new Map<string, Note[]>();
      const cards = new Map<string, string[]>();
      for (const [id, it] of items) {
        const owned = it.plan.filter(row => "item" in row && row.own).map(row => (row as Extract<PlanRow, { item: string }>).item);
        children.set(id, owned);
        for (const target of owned) { const list = owners.get(target) || []; list.push(id); owners.set(target, list); }
      }
      children.set("", [...items.keys()].filter(id => !owners.has(id)).sort(byOrder));
      for (const n of Object.values(s.notes)) {
        const list = notes.get(n.target) || [];
        list.push(n); notes.set(n.target, list);
      }
      for (const [key, d] of Object.entries(s.decisions)) {
        const list = cards.get(d.item) || [];
        list.push(key); cards.set(d.item, list);
      }
      for (const list of cards.values()) list.sort((a, b) => (s.decisions[a]?.order || 0) - (s.decisions[b]?.order || 0));
      return { items, children, owners, notes, cards, decisions: new Map(Object.entries(s.decisions)) };
    });
  }
  // Called while building the index too, so it must not call index().
  function byOrder(a: string, b: string): number { return (s.items[a]?.order || 0) - (s.items[b]?.order || 0); }
  const item = (id: string): Item | undefined => index().items.get(id);
  const kids = (id: string): string[] => index().children.get(id) || [];
  const notesOf = (target: string): Note[] => index().notes.get(target) || [];
  function parentOf(id: string): string | undefined {
    return index().owners.get(id)?.[0];
  }
  function ancestors(id: string): string[] {
    return cached("ancestors", id, () => {
      const out: string[] = [], seen = new Set([id]);
      for (let p = parentOf(id); p && !seen.has(p); p = parentOf(p)) { seen.add(p); out.push(p); }
      return out;
    });
  }
  function lineOf(id: string): string { return ancestors(id).at(-1) || id; }
  function pausedBy(id: string): string | undefined {
    return cached("pausedBy", id, () => {
      const seen = new Set<string>(), group = item(id)?.group;
      for (let current: string | undefined = id; current && !seen.has(current); current = parentOf(current)) {
        seen.add(current);
        const it = item(current);
        if (!it || it.group !== group) break;
        if (!it.record && it.paused) return current;
      }
      return undefined;
    });
  }
  function isPaused(id: string): boolean { return statusOf(id) === "paused"; }
  function groupOf(id: string): string { return item(id)?.group || ""; }
  function isRequest(id: string): boolean { return !!item(id)?.request && isOpenWork(id); }
  function areas(include?: (id: string) => boolean): string[] {
    function ordered(): string[] {
      const list = kids("").filter(id => !isRequest(id) && (!include || include(id))), groups = new Map(s.board.projects.map((p, i) => [p.name, i]));
      for (const id of list) { const g = item(id)?.group || ""; if (!groups.has(g)) groups.set(g, groups.size); }
      return list.sort((a, b) => groups.get(item(a)?.group || "")! - groups.get(item(b)?.group || "")! || byOrder(a, b));
    }
    return include ? ordered() : cached("areas", "", ordered);
  }
  function rowState(row: PlanRow, seen: Set<string>): Pick<DerivedPlanRow, "state" | "dropped" | "excluded"> & { paused?: boolean } {
    if ("text" in row) return {
      state: row.state === "doing" ? "progress" : row.state === "todo" ? "open" : "resolved",
      dropped: row.state === "dropped", excluded: row.state === "dropped",
    };
    if ("card" in row) return { state: !s.decisions[row.card] || s.decisions[row.card]?.status === "open" ? "waiting" : "resolved", dropped: false, excluded: false };
    const target = item(row.item);
    if (!target) return { state: "waiting", dropped: false, excluded: false };
    if (target.record) return { state: "resolved", dropped: false, excluded: row.own };
    const status = statusWalk(row.item, seen), dropped = row.own && status === "cancelled";
    const state = status === "done" || dropped ? "resolved" : !row.own || status === "blocked" || status === "paused" ? "waiting" : status === "wip" ? "progress" : "open";
    return { state, dropped, excluded: dropped, paused: status === "paused" };
  }
  function planRowsWalk(id: string, seen: Set<string>): DerivedPlanRow[] {
    const out: DerivedPlanRow[] = [], byId = new Map<string, DerivedPlanRow>();
    for (const row of item(id)?.plan ?? []) {
      const preceding = row.after === undefined ? out.slice(-1) : row.after.map(key => byId.get(key));
      const { paused, ...derived } = rowState(row, seen);
      const ready = derived.state !== "resolved" && preceding.every(p => p?.state === "resolved");
      const level = preceding.length ? 1 + Math.max(...preceding.map(p => p?.level ?? 0)) : 0;
      const glyph = paused ? "◌"
        : derived.dropped ? "✗" : { resolved: "✓", progress: "●", waiting: "⏸", open: "○" }[derived.state];
      const entry = { row, ...derived, ready, level, glyph };
      out.push(entry); byId.set(row.id, entry);
    }
    return out;
  }
  function planRows(id: string): DerivedPlanRow[] { return cached("planRows", id, () => planRowsWalk(id, new Set([id]))); }
  function planRatio(id: string): { done: number; total: number } {
    const rows = planRows(id).filter(row => !row.excluded);
    return { done: rows.filter(row => row.state === "resolved").length, total: rows.length };
  }
  function planGroups(id: string): Array<{ start: number; end: number; level: number }> {
    const rows = planRows(id), groups: Array<{ start: number; end: number; level: number }> = [];
    for (let start = 0; start < rows.length;) {
      const first = rows[start]!;
      let end = start + 1;
      while (end < rows.length && rows[end]!.level === first.level) end++;
      if (end - start >= 2) groups.push({ start, end, level: first.level });
      start = end;
    }
    return groups;
  }
  // Cycle members keep the path-sensitive guard; acyclic targets have the same
  // result in every caller and are evaluated once per immutable snapshot.
  const targetStatuses = new Map<string, Status | undefined>();
  function statusWalk(id: string, seen: Set<string>): Status | undefined {
    if (targetStatuses.has(id)) return targetStatuses.get(id);
    const it = item(id);
    if (!it || it.record) return undefined;
    if (it.status === "cancelled") return "cancelled";
    if (seen.has(id)) return "blocked";
    seen.add(id);
    const rows = planRowsWalk(id, seen);
    seen.delete(id);
    const frontier = rows.filter(row => row.ready);
    const status = rows.length && rows.every(row => row.state === "resolved") ? "done"
      : pausedBy(id) ? "paused"
      : !rows.length ? "todo"
      : rows.some(row => row.state === "progress") ? "wip"
      : askPending(id) || (frontier.length > 0 && frontier.every(row => row.state === "waiting")) ? "blocked" : "todo";
    if (!cycles().has(id)) targetStatuses.set(id, status);
    return status;
  }
  function statusOf(id: string): Status | undefined { return cached("status", id, () => statusWalk(id, new Set())); }
  function isLeaf(id: string): boolean { return !kids(id).some(k => item(k) && !item(k)!.record); }
  function isStatusLeaf(id: string): boolean { return isLeaf(id); }
  function ended(id: string): boolean { const st = statusOf(id); return st === "done" || st === "cancelled"; }
  function isOpenWork(id: string): boolean { return !!item(id) && statusOf(id) !== undefined && !ended(id); }
  function depsOf(id: string): Dependency[] {
    return cached("deps", id, () => planRows(id).flatMap(({ row, state }): Dependency[] => {
      if ("item" in row) return [{ kind: "item" as const, id: row.item, own: row.own, missing: !item(row.item), open: state !== "resolved" }];
      if ("card" in row) return [{ kind: "card" as const, id: row.card, missing: !s.decisions[row.card], open: state !== "resolved" }];
      return [];
    }));
  }
  function reverseDeps() {
    return cached("reverseDeps", "", () => {
      const items = new Map<string, Array<{ id: string; own?: boolean }>>(), cards = new Map<string, Array<{ id: string; own?: boolean }>>();
      for (const id of index().items.keys()) {
        for (const row of item(id)!.plan) {
          if ("text" in row) continue;
          const target = "item" in row ? row.item : row.card, m = "item" in row ? items : cards, list = m.get(target) || [];
          if (!list.some(w => w.id === id)) list.push("item" in row ? { id, own: row.own } : { id });
          m.set(target, list);
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
  const waiters = (id: string): string[] => (reverseDeps().items.get(id) || []).map(w => w.id);
  function isBacklog(id: string): boolean {
    return isOpenWork(id) && (index().owners.get(id) || []).some(owner => item(owner)?.record);
  }
  function isRoot(id: string): boolean { return !!item(id) && !isBacklog(id) && !waiters(id).some(isOpenWork); }
  // Only roots seed the least fixed point. Records and closed work pass none;
  // record-owned work receives priority from its other open dependents.
  function ranks() {
    return cached("ranks", "", () => {
      const ids = [...index().items.keys()], rank = new Map<string, number>();
      for (const id of ids) if (isRoot(id)) rank.set(id, rankOfPriority(item(id)!.priority));
      const rankOf = (id: string): number => rank.get(id) ?? 3;
      for (let changed = true; changed;) {
        changed = false;
        for (const id of ids) {
          const r = Math.min(rankOf(id), ...waiters(id).filter(waiter => isOpenWork(waiter) && !isPaused(waiter)).map(rankOf));
          if (r < rankOf(id)) { rank.set(id, r); changed = true; }
        }
      }
      return { rankOf };
    });
  }
  function priorityOf(id: string): Priority | "" { return cached("priority", id, () => PRIORITIES[ranks().rankOf(id)] || ""); }
  function cycles(): Set<string> {
    return cached("cycles", "", () => {
      const idx = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>(), out = new Set<string>();
      let n = 0;
      const next = (id: string): string[] => (item(id)?.plan ?? []).flatMap(row => "item" in row && item(row.item) ? [row.item] : []);
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
          if (component.length > 1 || next(v).includes(v)) for (const id of component) out.add(id);
        }
      }
      for (const id of index().items.keys()) if (!idx.has(id)) visit(id);
      return out;
    });
  }
  // Current document times cover imported/synthetic snapshots; history retains
  // overwritten revisions and deleted cards/notes, which current fields cannot.
  function activity(): { intervals: Array<[number, number]>; changedAt(id: string): number } {
    return cached("activity", "", () => {
      if (options.activity) {
        const index = typeof options.activity === "function" ? options.activity() : options.activity;
        return { intervals: index.intervals(now), changedAt: (id: string) => index.changedAt(id, now) };
      }
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
      return { intervals, changedAt: (id: string) => changed.get(id) ?? -Infinity };
    });
  }
  function stalled(id: string): boolean {
    if (isPaused(id)) return false;
    const { intervals, changedAt } = activity(), since = changedAt(id);
    if (!Number.isFinite(since)) return false;
    const pauses: Array<[number, number]> = [];
    const recorded = (s.activity?.pauses?.[id] ?? []).map(pause => [Date.parse(pause.start), pause.end ? Date.parse(pause.end) : now] as [number, number])
      .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start).sort((a, b) => a[0] - b[0]);
    for (const [start, end] of recorded) {
      const previous = pauses.at(-1);
      if (previous && previous[1] >= start) previous[1] = Math.max(previous[1], end);
      else pauses.push([start, end]);
    }
    return intervals.reduce((total, [start, end]) => {
      const from = Math.max(start, since);
      const paused = pauses.reduce((sum, [pauseStart, pauseEnd]) => sum + Math.max(0, Math.min(end, pauseEnd) - Math.max(from, pauseStart)), 0);
      return total + Math.max(0, end - from) - paused;
    }, 0) >= STALLED_AFTER_MS;
  }
  function checks(id: string): Check[] {
    return cached("checks", id, () => {
      const it = item(id), out: Check[] = [];
      if (!it) return out;
      const st = statusOf(id), parent = parentOf(id), deps = depsOf(id), rows = planRows(id);
      for (const e of deps) {
        const target = { kind: e.kind, id: e.id };
        if (e.missing) out.push({ text: (e.kind === "item" ? "依赖的条目不存在：" : "依赖的决策卡不存在：") + e.id });
        else if (e.kind === "item" && !e.own && statusOf(e.id) === "cancelled") out.push({ text: "依赖的条目已取消", target });
      }
      if (cycles().has(id)) out.push({ text: "依赖成环" });
      if (!s.board.projects.some(project => project.name === it.group)) out.push({ text: "项目没有配置：" + it.group });
      if ((index().owners.get(id)?.length ?? 0) > 1) out.push({ text: "被多个条目拥有" });
      for (const owner of index().owners.get(id) || []) if (groupOf(owner) !== it.group) out.push({ text: "跨项目拥有", target: { kind: "item", id: owner } });
      if (!parent && isOpenWork(id) && (reverseDeps().items.get(id) || []).some(e => !e.own && isOpenWork(e.id) && groupOf(e.id) === it.group)) out.push({ text: "同项目有条目在等它，却没有条目拥有它" });
      if (!it.record && !rows.some(({ row }) => "text" in row && row.accept)) out.push({ text: "没有计划：至少要有一个验收步骤" });
      // Titles of closed items are not revised, so only open items and records are checked.
      const titleLength = [...it.title.replace(/\s/g, "")].length;
      if (titleLength > TITLE_MAX_CHARS && (it.record || !ended(id))) out.push({ text: `标题超过 ${TITLE_MAX_CHARS} 个字（现在 ${titleLength} 个）` });
      // Only once the vocabulary offers the item's project a tag: before that nothing could clear the check.
      if (!it.tags?.length && tagsRequired(s.board.tags, it.group)) out.push({ text: "缺标签：用 set_tags 从标签词表里给它选至少一个标签", label: "缺标签" });
      if (it.provisional) out.push({ text: "计划待重写", label: "待重写" });
      if (st === "paused") for (const waiter of reverseDeps().items.get(id) || []) {
        if (!waiter.own && isOpenWork(waiter.id) && !isPaused(waiter.id)) out.push({ text: `暂停了，但 ${item(waiter.id)!.title} 在等它`, label: "暂停冲突", target: { kind: "item", id: waiter.id } });
      }
      if (!it.record) {
        const acceptance = rows.filter(({ row }) => "text" in row && row.accept), others = rows.filter(({ row }) => !("text" in row && row.accept));
        if (acceptance.some(({ row }) => "text" in row && row.text === "（转换时没找到完成条件，待补）")) out.push({ text: "验收步骤待补" });
        if (acceptance.some(row => row.state !== "resolved") && others.every(row => row.state === "resolved")) out.push({ text: "只差验收：其它行都已完成" });
        if (isOpenWork(id) && parent && ended(parent)) out.push({ text: "拥有它的条目已关闭", target: { kind: "item", id: parent } });
        if (st === "wip" && it.plan.some(row => "text" in row && row.state === "doing") && stalled(id)) out.push({ text: "进行中但 1 小时（活跃时间）没有动静", label: STALLED_LABEL });
        // A todo step's waits text is invisible to the derived status, so the item looks startable: one check per item lists the rows by id.
        const waiting = it.plan.flatMap(row => "text" in row && row.state === "todo" && row.waits ? [row.id] : []);
        if (isOpenWork(id) && !isPaused(id) && !isBacklog(id) && waiting.length) out.push({ text: `在等的事写在文字里，看板看不出，所以这些行看着能开工。改法：等别的条目就用共享依赖；等主人就出卡；等 CI、14900K 这类看板外的事，把这一行标成进行中；暂时不做就挪进待选。写了在等的行：${waiting.join("、")}`, label: WAITS_TEXT_LABEL });
        if (isOpenWork(id) && isRoot(id) && !it.priority) out.push({ text: "没有未完成的条目依赖它，却没写优先级" });
        // Open work gets a difficulty before it is dispatched. An untriaged request, a backlog item and paused work are
        // not about to be, so they are not asked for one yet.
        if (it.difficulty === undefined && isOpenWork(id) && !isRequest(id) && !isBacklog(id) && !isPaused(id)) out.push({ text: "缺难度：只有架构师能评，用 set_difficulty 评 1–5 级，或标「架构师做」；没评级的条目不算可以开工", label: "缺难度" });
      }
      return out;
    });
  }
  return {
    stepDays, stepLine, planRatio,
    planRows: id => planRows(id).map(entry => ({ ...entry, row: structuredClone(entry.row) })),
    planGroups: id => planGroups(id).map(group => ({ ...group })),
    stalledBelow: id => cached("stalledBelow", id, () => subtreeCount(id, v => Number(checks(v).some(c => c.label === STALLED_LABEL)))),
    item, parentOf, children: id => (index().children.get(id) || []).slice(), areas: include => areas(include).slice(),
    ancestors: id => ancestors(id).slice(), lineOf, groupOf, projectOf: groupOf,
    isRequest, isOpenWork, inbox: project => kids("").filter(id => groupOf(id) === project && isRequest(id)).sort((a,b) => Date.parse(item(a)!.request!.at) - Date.parse(item(b)!.request!.at) || a.localeCompare(b)),
    isLeaf, isStatusLeaf, statusOf, pausedBy, isPaused, isBacklog, isRoot, priorityOf,
    depsOf: id => depsOf(id).map(e => ({ ...e })),
    dependents: id => (reverseDeps().items.get(id) || []).map(e => ({ ...e })),
    cardDependents: key => (reverseDeps().cards.get(key) || []).map(e => ({ ...e })),
    cardsOf: id => cardsOf(id).slice(), askPending, cardWaiting, cardBlocking, ownerBlocking, needsOwner,
    blockingBelow: id => cached("blockingBelow", id, () => subtreeCount(id, blockingOwn)), nonBlockingBelow: id => cached("nonBlockingBelow", id, () => subtreeCount(id, nonBlockingOwn)), onCycle: id => cycles().has(id),
    checks: id => checks(id).map(c => c.target ? { ...c, target: { ...c.target } } : { ...c }),
    compareSiblings: (a, b) => rankOfPriority(priorityOf(a)) - rankOfPriority(priorityOf(b)) || Number(ended(a)) - Number(ended(b)) || byOrder(a, b),
  };
}
