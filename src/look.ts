// The look: every open work item of the board in one answer, from the roots down. The tree is the owner's: each project's top
// items, each with the items it owns, one line for an item. The answer has a budget of lines, which it spends by opening the
// subtrees that need a reader first; what it does not open is counted on its line. What the reader saw last is remembered for each
// session, in the daemon's memory only. docs/design.md, section 6, "The look", gives the reasons for each rule.

import { checkKey, checkLabel } from "./rules.ts";
import type { Rules } from "./rules.ts";
import { reportText, spanText, wholeView } from "./whole-view.ts";
import type { Bucket } from "./whole-view.ts";
import type { Snapshot } from "./model.ts";

/** The lines an answer may take unless the caller says otherwise, and what the caller may ask for. */
export const DEFAULT_ROWS = 80, MIN_ROWS = 10, MAX_ROWS = 400;
/** How many sessions' last looks are kept: the architect has a handful of sessions, each of the board's size in signatures. */
export const MEMORY_SESSIONS = 16;
/** The longest title, pause reason and runner text a line carries; the rest is cut. */
const TITLE_CHARS = 22, REASON_CHARS = 40, WHAT_CHARS = 44;

/** The statuses an open work item can have, in the order a count lists them. */
export const OPEN_STATUSES = ["wip", "blocked", "idle", "todo", "paused"] as const;
export type OpenStatus = (typeof OPEN_STATUSES)[number];
/** The words the page's legend uses for the statuses. */
export const STATUS_TEXT: Readonly<Record<OpenStatus, string>> = { wip: "进行中", blocked: "卡住", idle: "停滞", todo: "未开始", paused: "暂停" };

/** What lies in a set of open work items: how many, in which status, and how many call for a reader. */
export interface Tally {
  items: number;
  by: Record<OpenStatus, number>;
  unattended: number;
  overdue: number;
  working: number;
  /** Items that carry a check flag. */
  checked: number;
  /** Pause markers: an item that carries its own. */
  folds: number;
  /** Items changed or new since the session's last look. */
  changed: number;
  added: number;
  /** Open items in a pool (a record's items) below, which `items` does not hold. */
  pool: number;
}
const zero = (): Tally => ({ items: 0, by: { wip: 0, blocked: 0, idle: 0, todo: 0, paused: 0 }, unattended: 0, overdue: 0, working: 0, checked: 0, folds: 0, changed: 0, added: 0, pool: 0 });
function addInto(to: Tally, from: Tally): void {
  to.items += from.items; to.unattended += from.unattended; to.overdue += from.overdue; to.working += from.working; to.checked += from.checked;
  to.folds += from.folds; to.changed += from.changed; to.added += from.added; to.pool += from.pool;
  for (const status of OPEN_STATUSES) to.by[status] += from.by[status];
}

/**
 * One line of the tree. A `project` is the root of the lines of one project; an `item` is an open work item; a `pool` is a record
 * that holds work (the backlog of a project), whose items are counted apart because nobody has started them on purpose.
 */
export interface LookNode {
  kind: "project" | "item" | "pool";
  /** The item's key, or the project's name. */
  id: string;
  project: string;
  title: string;
  num: number | undefined;
  depth: number;
  /** The place in a walk of the whole tree, which breaks ties between nodes of equal priority. */
  order: number;
  parent: LookNode | undefined;
  kids: LookNode[];
  /** An item no root reaches (its owners form a cycle), listed on its project anyway so that it is not lost. */
  stray: boolean;
  status: OpenStatus | undefined;
  /** What the work does or waits for, since when, and the whole view's kind of it, when it has one. */
  what: string | undefined;
  since: number | undefined;
  bucket: Bucket | undefined;
  fresh: boolean;
  limit: number | undefined;
  turns: number | undefined;
  runner: boolean;
  checks: string[];
  /** The pause that holds the item: the item that carries the marker (this one, or one above), its reason and when it began. */
  pause: { source: string; reason: string; at: number } | undefined;
  mark: "changed" | "new" | undefined;
  /** This node alone (zero for a project or a pool), and what lies below it. */
  own: Tally;
  sub: Tally;
}

/** What a session saw at its last look: the time, and a signature for each open item that changes when the item is written, its status moves or its checks change. */
export interface Previous { at: number; sigs: ReadonlyMap<string, string> }

/** The last look of each session, newest last; the daemon keeps one for all its requests. */
export class LookMemory {
  private seen = new Map<string, Previous>();
  get(session: string): Previous | undefined { return this.seen.get(session); }
  set(session: string, last: Previous): void {
    this.seen.delete(session);
    this.seen.set(session, last);
    while (this.seen.size > MEMORY_SESSIONS) this.seen.delete(this.seen.keys().next().value!);
  }
}

const cut = (text: string, max: number): string => { const chars = [...text.replace(/\s+/g, " ").trim()]; return chars.length <= max ? chars.join("") : `${chars.slice(0, max).join("")}…`; };

interface Built {
  /** The projects with something open, in the configured order. */
  projects: LookNode[];
  byId: Map<string, LookNode>;
  sigs: Map<string, string>;
}

/**
 * The tree of the board's open work. Every item is visited once, from the roots (`areas`) down along ownership: an open item is a
 * node under the node that owns it, a record that holds work is a pool, and a finished item is passed through so that the open items
 * it owns hang on the node above. An item no root reaches is visited last and hangs on its project. So each open work item is a
 * node, and the lines and counts of the answer cover all of them.
 */
function build(s: Snapshot, r: Rules, now: number, previous: Previous | undefined): Built {
  const rows = new Map(wholeView(s, r, now).rows.map(row => [row.id, row]));
  const order = new Map(s.board.projects.map((p, i) => [p.name, i]));
  const projects = new Map<string, LookNode>(), byId = new Map<string, LookNode>(), sigs = new Map<string, string>(), seen = new Set<string>();
  let counter = 0;
  const make = (kind: LookNode["kind"], id: string, project: string, title: string, num: number | undefined, parent: LookNode | undefined): LookNode => ({
    kind, id, project, title, num, depth: parent ? parent.depth + 1 : 0, order: counter++, parent, kids: [], stray: false, status: undefined, what: undefined, since: undefined,
    bucket: undefined, fresh: false, limit: undefined, turns: undefined, runner: false, checks: [], pause: undefined, mark: undefined, own: zero(), sub: zero(),
  });
  const projectNode = (name: string): LookNode => {
    let node = projects.get(name);
    if (!node) { node = make("project", name, name, name, undefined, undefined); projects.set(name, node); }
    return node;
  };
  function itemNode(id: string, host: LookNode, stray: boolean): LookNode {
    const it = s.items[id]!, status = r.statusOf(id) as OpenStatus, row = rows.get(id), checks = r.checks(id);
    const node = make("item", id, host.project, it.title, it.num, host);
    node.stray = stray; node.status = status; node.checks = [...new Set(checks.map(checkLabel))];
    if (row) {
      node.what = row.what; node.since = row.since; node.bucket = row.bucket; node.fresh = row.fresh === true; node.limit = row.limit; node.turns = row.turns; node.runner = row.from === "runner";
    }
    if (status === "paused") {
      const source = r.pausedBy(id) ?? id, marker = s.items[source]?.paused;
      node.pause = { source, reason: marker?.reason ?? "", at: marker ? Date.parse(marker.at) : Date.parse(it.updated) };
    }
    const sig = `${it.rev}|${status}|${checks.map(checkKey).sort().join(",")}`;
    sigs.set(id, sig);
    if (previous) { const was = previous.sigs.get(id); node.mark = was === undefined ? "new" : was !== sig ? "changed" : undefined; }
    const own = node.own;
    own.items = 1; own.by[status] = 1;
    if (node.bucket === "unattended") own.unattended = 1; else if (node.bucket === "overdue") own.overdue = 1; else if (node.bucket === "working") own.working = 1;
    if (checks.length) own.checked = 1;
    if (node.pause?.source === id) own.folds = 1;
    if (node.mark === "changed") own.changed = 1; else if (node.mark === "new") own.added = 1;
    byId.set(id, node);
    return node;
  }
  function visit(id: string, host: LookNode, stray = false): void {
    if (seen.has(id)) return;
    seen.add(id);
    const it = r.item(id);
    if (!it) return;
    if (it.record) {
      // A record in a pool is only a heading: what it holds belongs to the pool.
      if (host.kind === "pool") { for (const child of r.children(id)) visit(child, host, stray); return; }
      const pool = make("pool", id, host.project, it.title, it.num, host);
      for (const child of r.children(id)) visit(child, pool, stray);
      if (pool.kids.length) { host.kids.push(pool); byId.set(id, pool); }
      return;
    }
    if (!r.isOpenWork(id)) { for (const child of r.children(id)) visit(child, host, stray); return; }
    const node = itemNode(id, host, stray);
    host.kids.push(node);
    for (const child of r.children(id)) visit(child, node);
  }
  for (const id of r.areas()) visit(id, projectNode(r.projectOf(id)));
  // What no root reached: an ownership cycle. It hangs on its project.
  for (const id of Object.keys(s.items)) if (!seen.has(id)) visit(id, projectNode(r.projectOf(id)), true);
  // A pool counts apart: what is in it is not in its parent's `items`, only in `pool`.
  function settle(node: LookNode): Tally {
    const sub = zero();
    for (const kid of node.kids) {
      const total = settle(kid);
      if (kid.kind === "pool") sub.pool += total.items + total.pool; else addInto(sub, total);
    }
    node.sub = sub;
    const total = zero();
    addInto(total, node.own); addInto(total, sub);
    return total;
  }
  const list = [...projects.values()].filter(p => p.kids.length);
  for (const project of list) settle(project);
  list.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || (a.id < b.id ? -1 : 1));
  return { projects: list, byId, sigs };
}

export interface LookOptions {
  /** Project names; none or an empty list means every project. */
  projects?: readonly string[] | undefined;
  /** The most lines the answer takes. */
  rows?: number | undefined;
  /** Items (or pools, or projects) to open whatever their priority, with the nodes above them. */
  expand?: readonly string[] | undefined;
}

export interface LookView {
  now: number;
  /** The most lines the answer takes, and the limit asked for when the projects alone needed more. */
  limit: number;
  asked: number;
  names: readonly string[] | undefined;
  /** The projects shown, in the configured order. */
  projects: LookNode[];
  expanded: Set<LookNode>;
  /** The expansions asked for that did not happen, in a sentence; none when all did. */
  unmet: string | undefined;
  /** What the session saw last: none without a session, `first` for a session with no earlier look. */
  track: "none" | "first" | { at: number; changed: number; added: number; finished: number };
  /** What the session has seen of every open item after this look: what its next look is compared with. */
  sigs: Map<string, string>;
}

/** Higher is opened first: an item nobody holds or that waits too long, then work being done, then a check flag, then a pause. */
function priority(node: LookNode): number {
  const t = node.sub;
  return (t.unattended + t.overdue > 0 ? 8 : 0) + (t.working > 0 ? 4 : 0) + (t.checked > 0 ? 2 : 0) + (t.folds > 0 ? 1 : 0);
}
/** A paused item is one line however much lies below it; `expand` opens it. */
const opensByItself = (node: LookNode): boolean => node.kids.length > 0 && node.pause === undefined;

function rootOf(node: LookNode): LookNode { let n = node; while (n.parent) n = n.parent; return n; }

/**
 * The answer's structure at `now`. Each project is a line; the rest of the budget opens nodes, first those `expand` names (with
 * the nodes above them, in the order asked, as many as fit), then the one with the highest priority (`priority`) among the nodes
 * whose parent is open, the shallower and then the earlier first, until none fits. An item that is not open is counted on its
 * parent's line. `previous` is what the session saw last, which marks the items changed or new since.
 */
export function look(s: Snapshot, r: Rules, now: number, o: LookOptions = {}, previous?: Previous, tracked = previous !== undefined): LookView {
  const built = build(s, r, now, previous);
  const names = o.projects?.length ? [...new Set(o.projects)] : undefined;
  if (names) {
    const known = s.board.projects.map(p => p.name), bad = names.filter(name => !known.includes(name));
    if (bad.length) throw new Error(`projects ${bad.join(", ")}: choose configured project names (${known.join(", ")})`);
  }
  const picked = built.projects.filter(p => !names || names.includes(p.id));
  // One line is kept for the sentence on what could not be opened; the automatic opening gets it back when there is none.
  const reserve = o.expand?.length ? 1 : 0;
  const asked = o.rows ?? DEFAULT_ROWS, base = 1 + picked.length, limit = Math.max(asked, base + reserve);
  const targets: LookNode[] = [];
  for (const id of o.expand ?? []) {
    const node = built.byId.get(id) ?? picked.find(p => p.id === id);
    if (!node) throw new Error(`expand ${id}: not an open work item, a pool or a project of this look; it is done, cancelled, in another project or does not exist`);
    if (!picked.includes(rootOf(node))) throw new Error(`expand ${id}: it is in project ${node.project}, which projects leaves out`);
    targets.push(node);
  }
  const expanded = new Set<LookNode>();
  let free = limit - base - reserve;
  const unfit: string[] = [], bare: string[] = [];
  for (const target of targets) {
    const chain: LookNode[] = [];
    for (let n: LookNode | undefined = target; n; n = n.parent) chain.unshift(n);
    for (const n of chain) {
      if (expanded.has(n)) continue;
      if (!n.kids.length) { if (n === target) bare.push(n.id); continue; }
      if (n.kids.length > free) { unfit.push(`${n.id}（要 ${n.kids.length} 行，只剩 ${Math.max(0, free)} 行）`); break; }
      expanded.add(n); free -= n.kids.length;
    }
  }
  const unmet = unfit.length || bare.length
    ? [...(unfit.length ? [`没展开：${unfit.join("、")}，调大 rows`] : []), ...(bare.length ? [`没有孩子可展开：${bare.join("、")}`] : [])].join("；")
    : undefined;
  if (unmet === undefined) free += reserve;
  const frontier: LookNode[] = [];
  const gather = (node: LookNode): void => { if (expanded.has(node)) for (const kid of node.kids) gather(kid); else if (node.kids.length) frontier.push(node); };
  for (const project of picked) gather(project);
  for (;;) {
    let best: LookNode | undefined;
    for (const node of frontier) {
      if (!opensByItself(node) || node.kids.length > free) continue;
      if (!best || priority(node) > priority(best) || (priority(node) === priority(best) && (node.depth < best.depth || (node.depth === best.depth && node.order < best.order)))) best = node;
    }
    if (!best) break;
    frontier.splice(frontier.indexOf(best), 1);
    expanded.add(best); free -= best.kids.length;
    for (const kid of best.kids) if (kid.kids.length) frontier.push(kid);
  }
  let track: LookView["track"] = tracked ? "first" : "none";
  if (previous) {
    let changed = 0, added = 0, finished = 0;
    const count = (node: LookNode): void => { if (node.mark === "changed") changed++; else if (node.mark === "new") added++; for (const kid of node.kids) count(kid); };
    for (const project of picked) count(project);
    for (const id of previous.sigs.keys()) {
      if (built.sigs.has(id)) continue;
      const group = s.items[id]?.group;
      if (group === undefined || !names || names.includes(group)) finished++;
    }
    track = { at: previous.at, changed, added, finished };
  }
  // What the session saw: the items of the projects looked at as they are now, the others as they were when it last saw them (as they are now when it never did), so that a look at one project does not hide a change in another.
  const sigs = new Map<string, string>();
  for (const [id, sig] of built.sigs) sigs.set(id, !names || names.includes(built.byId.get(id)!.project) ? sig : previous?.sigs.get(id) ?? sig);
  return { now, limit, asked, names, projects: picked, expanded, unmet, track, sigs };
}

/** The counts of statuses a line gives, `进行中 2 · 未开始 3`, and then the items that call for a reader and the ones that changed. */
function counts(t: Tally): string {
  const by = OPEN_STATUSES.filter(status => t.by[status]).map(status => `${STATUS_TEXT[status]} ${t.by[status]}`).join(" · ");
  const attention = [t.unattended ? `没人管 ${t.unattended}` : "", t.overdue ? `等太久 ${t.overdue}` : ""].filter(Boolean).join(" · ");
  const change = [t.changed ? `上次看后变了 ${t.changed} 件` : "", t.added ? `新出现 ${t.added} 件` : ""].filter(Boolean).join(" · ");
  return [by, attention, change].filter(Boolean).join("；");
}
/** What a line says of the nodes below it that it does not list: `下面 N 件` for the items and `待选池 N 件` for the pools'. */
function below(t: Tally): string {
  const items = t.items ? `下面 ${t.items} 件：${counts(t)}` : "";
  return [items, t.pool ? `待选池 ${t.pool} 件` : ""].filter(Boolean).join(" · ");
}

function nodeLine(node: LookNode, open: boolean, now: number): string {
  if (node.kind === "project") {
    return ` ${node.id} · ${open ? `共 ${node.sub.items} 件${node.sub.items ? `：${counts(node.sub)}` : ""}${node.sub.pool ? `；待选池另 ${node.sub.pool} 件` : ""}` : below(node.sub)}`;
  }
  const indent = " ".repeat(2 * node.depth - 1);
  if (node.kind === "pool") {
    return ` ${indent}待选池 · ${node.id} · ${cut(node.title, TITLE_CHARS)} · ${open ? `共 ${node.sub.items} 件：${counts(node.sub)}` : below(node.sub)}`;
  }
  const mark = node.mark === "changed" ? "*" : node.mark === "new" ? "+" : " ";
  const parts = [node.id, cut(node.title, TITLE_CHARS)];
  if (node.pause) {
    parts.push(node.pause.source === node.id ? `暂停 ${spanText(now - node.pause.at)}${node.pause.reason ? `：${cut(node.pause.reason, REASON_CHARS)}` : ""}` : `暂停（随 ${node.pause.source}）`);
  } else {
    parts.push(STATUS_TEXT[node.status!]);
    if (node.bucket === "unattended") parts.push(node.fresh || !node.what ? "没人管" : `没人管（${node.what}）`);
    else {
      const turn = node.runner && node.turns !== undefined && node.bucket === "working" && !node.what?.includes(`第 ${node.turns} 轮`) ? `第 ${node.turns} 轮` : "";
      const what = [node.what ? cut(node.what, WHAT_CHARS) : "", turn].filter(Boolean).join("，");
      if (what) parts.push(what);
      if (node.bucket === "overdue") parts.push(`等太久${node.limit ? `（门槛 ${spanText(node.limit)}）` : ""}`);
    }
    if (node.since !== undefined) parts.push(spanText(now - node.since));
  }
  if (node.checks.length) parts.push(`检查：${node.checks.join("、")}`);
  if (node.stray) parts.push("没挂在树上");
  if (!open && node.kids.length) parts.push(below(node.sub));
  if (node.num !== undefined) parts.push(`#${node.num}`);
  return `${mark}${indent}${parts.join(" · ")}`;
}

/** The lines of the answer: a header, the sentence on what could not be opened if there is one, then each project and what is open below it. */
export function lookLines(view: LookView): string[] {
  const { now } = view, body: string[] = [];
  const emit = (node: LookNode): void => { body.push(nodeLine(node, view.expanded.has(node), now)); if (view.expanded.has(node)) for (const kid of node.kids) emit(kid); };
  for (const project of view.projects) emit(project);
  const scope = view.names ? view.names.join("、") : "全部项目";
  if (!view.projects.length) return [`看 · ${scope} · 没有没做完的工作。`];
  const total = zero();
  for (const project of view.projects) addInto(total, project.sub);
  const lines = body.length + 1 + (view.unmet === undefined ? 0 : 1);
  const track = view.track === "none" ? "没带 session，不标上次看以后的变化"
    : view.track === "first" ? "这个会话头一次看（看板重启后也一样），不标变化"
    : `上次看在 ${spanText(now - view.track.at)}前：变了 ${view.track.changed} 件 · 新出现 ${view.track.added} 件 · 收尾 ${view.track.finished} 件（做完、取消）`;
  const header = `看 · ${scope} · 没做完 ${total.items + total.pool} 件（待选池 ${total.pool} 件在内）；没人管 ${total.unattended} · 等太久 ${total.overdue} · 在做 ${total.working} · 共 ${lines}/${view.limit} 行${view.limit > view.asked ? "（每个项目至少一行，上限提到这个数）" : ""} · ${track}`;
  return [header, ...(view.unmet === undefined ? [] : [view.unmet]), ...body];
}
export const lookText = (view: LookView): string => lookLines(view).join("\n");
