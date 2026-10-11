// Pure snapshot-derived rules shared by the server and the owner's page.
// Ported from ~/dev/agents_config/status-board.html; the verbatim test oracle
// preserves the old rules independently of this implementation.
import type { Item, Note, Priority, Snapshot, Status } from "./model.ts";

export interface Check {
  text: string;
  target?: { kind: "item" | "card"; id: string };
}

export interface Rules {
  item(id: string): Item | undefined;
  parentOf(id: string): string | undefined;
  children(id: string): string[];
  areas(): string[];
  ancestors(id: string): string[];
  lineOf(id: string): string;
  groupOf(id: string): string;
  agentFor(id: string): string;
  isLeaf(id: string): boolean;
  statusOf(id: string): Status;
  priorityOf(id: string): Priority | "";
  effectivePriorityOf(id: string): Priority | "";
  raisedBy(id: string): string | null;
  depsOf(id: string): Array<{ kind: "item" | "card"; id: string; why: string; open: boolean; missing: boolean }>;
  dependents(id: string): Array<{ id: string; why: string }>;
  cardDependents(key: string): Array<{ id: string; why: string }>;
  cardsOf(id: string): string[];
  needsOwner(id: string): boolean;
  isArchived(id: string): boolean;
  inArchive(id: string): boolean;
  onCycle(id: string): boolean;
  checks(id: string): Check[];
  compareSiblings(a: string, b: string): number;
}

type Dependency = ReturnType<Rules["depsOf"]>[number];
const RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };
const PRIORITIES: Priority[] = ["P0", "P1", "P2"];
// These are the page's actual ANSWER prefixes (approve is 同意, not 批准).
const ANSWER = { approve: "同意：", done: "已完成：" };
const rankOfPriority = (p: Priority | "" | undefined): number => p ? RANK[p] : 3;

/** A Rules object belongs to one immutable snapshot. Create another after a write.
 * Array/object results are defensive copies; item() returns the snapshot's item.
 * Missing items have no metadata; tree queries still include dangling children.
 */
export function rules(s: Pick<Snapshot, "items" | "decisions" | "notes" | "owner">): Rules {
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
  function areas(): string[] {
    return cached("areas", "", () => {
      const list = index().children.get("") || [], groups = new Map<string, number>();
      for (const id of list) { const g = item(id)?.group || ""; if (!groups.has(g)) groups.set(g, groups.size); }
      return list.slice().sort((a, b) => groups.get(item(a)?.group || "")! - groups.get(item(b)?.group || "")! || byOrder(a, b));
    });
  }
  function statusWalk(id: string, seen: Set<string>): Status {
    const it = item(id);
    if (seen.has(id)) return it?.status || "todo";
    seen.add(id);
    const all = kids(id).map(k => statusWalk(k, seen));
    if (!all.length) return it?.status || "todo";
    const live = all.filter(st => st !== "cancelled");
    if (!live.length) return "cancelled";
    if (live.includes("wip")) return "wip";
    if (live.includes("blocked")) return "blocked";
    return live.every(st => st === "done") ? "done" : "todo";
  }
  function statusOf(id: string): Status { return cached("status", id, () => statusWalk(id, new Set())); }
  function isLeaf(id: string): boolean { return !kids(id).length; }
  function ended(id: string): boolean { const st = statusOf(id); return st === "done" || st === "cancelled"; }
  function leavesOf(id: string): string[] {
    return cached("leaves", id, () => {
      const seen = new Set<string>();
      function walk(key: string): string[] {
        if (seen.has(key) || !item(key)) return [];
        seen.add(key);
        return kids(key).length ? kids(key).flatMap(walk) : [key];
      }
      return walk(id);
    });
  }
  function priorityOf(id: string): Priority | "" {
    return cached("priority", id, () => {
      const leaves = leavesOf(id).filter(l => item(l)?.priority);
      const live = leaves.filter(l => statusOf(l) !== "cancelled"), open = live.filter(l => !ended(l));
      return (open.length ? open : live.length ? live : leaves).map(l => item(l)!.priority!).sort()[0] || "";
    });
  }
  function depsOf(id: string): Dependency[] {
    return cached("deps", id, () => (item(id)?.deps || []).map(e => {
      if ("id" in e) return { kind: "item", id: e.id, why: e.why, missing: !item(e.id), open: !!item(e.id) && !ended(e.id) };
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
  function needsOwner(id: string): boolean {
    return cached("needsOwner", id, () => {
      const ask = item(id)?.ask;
      if (ask && !notesOf("it:" + id).some(n => (n.kind === "approve" || n.kind === "done") && n.state !== "draft" && n.text === ANSWER[n.kind] + ask.text)) return true;
      return cardsOf(id).some(key => index().decisions.get(key)?.status === "open" && !notesOf("q:" + key).some(n => n.kind === "choice" && n.state !== "draft"));
    });
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
  function outWaiters(id: string): string[] {
    return cached("outWaiters", id, () => (reverseDeps().items.get(id) || []).map(w => w.id).filter(w => !ended(w) && !inArchive(w) && !ancestors(id).includes(w)));
  }
  function effective() {
    return cached("effective", "", () => {
      const rank = new Map<string, number>(), why = new Map<string, string>();
      const leaves = [...index().items.keys()].filter(isLeaf);
      for (const l of leaves) rank.set(l, rankOfPriority(item(l)?.priority));
      const rankOf = (id: string): number => {
        if (isLeaf(id)) return rank.get(id) ?? 3;
        const open = leavesOf(id).filter(l => !ended(l));
        return open.length ? Math.min(...open.map(l => rank.get(l) ?? 3)) : rankOfPriority(priorityOf(id));
      };
      // Each rank can fall only three times; this converges even on cycles.
      for (let changed = true; changed;) {
        changed = false;
        for (const l of leaves) {
          if (ended(l) || inArchive(l)) continue;
          let r = rank.get(l)!, by: string | undefined;
          for (const a of [l, ...ancestors(l)]) for (const w of outWaiters(a)) {
            const wr = rankOf(w);
            if (wr < r) { r = wr; by = w; }
          }
          if (by !== undefined) { rank.set(l, r); why.set(l, by); changed = true; }
        }
      }
      return { rankOf, why };
    });
  }
  function effectivePriorityOf(id: string): Priority | "" { return cached("effectivePriority", id, () => PRIORITIES[effective().rankOf(id)] || ""); }
  function raisedBy(id: string): string | null {
    return cached("raisedBy", id, () => {
      const p = effectivePriorityOf(id);
      if (!p || p === priorityOf(id)) return null;
      const leaf = (isLeaf(id) ? [id] : leavesOf(id)).find(l => !ended(l) && effective().why.has(l) && effectivePriorityOf(l) === p);
      return leaf ? effective().why.get(leaf)! : null;
    });
  }
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
  function checks(id: string): Check[] {
    return cached("checks", id, () => {
      const it = item(id), out: Check[] = [];
      if (!it || inArchive(id)) return out;
      const st = statusOf(id), leaf = isLeaf(id), parent = parentOf(id), deps = depsOf(id);
      for (const e of deps) {
        const target = { kind: e.kind, id: e.id };
        if (e.missing) out.push({ text: (e.kind === "item" ? "依赖的条目不存在：" : "依赖的决策卡不存在：") + e.id });
        else if (e.kind === "item" && statusOf(e.id) === "cancelled") out.push({ text: "依赖的条目已取消", target });
        else if (!e.why && !ended(id)) out.push({ text: "依赖没写为什么：", target });
      }
      if (cycles().has(id)) out.push({ text: "依赖成环" });
      if (!it.parent && !it.agent) out.push({ text: "顶层条目没有负责会话（agent）" });
      if (it.parent && !parent) out.push({ text: "上级条目不存在：" + it.parent });
      if (parent && !ended(id) && !depsOf(parent).some(e => e.kind === "item" && e.id === id)) out.push({ text: "上级没有把它列在依赖里（上级必须是直接依赖它的条目）：", target: { kind: "item", id: parent } });
      const open = deps.filter(e => e.open);
      if (leaf && st === "blocked" && deps.length && !open.length) out.push({ text: "可解除阻塞：等的都已完成" });
      if (leaf && st === "blocked" && !deps.length && !needsOwner(id)) out.push({ text: "卡住了，但没写在等什么" });
      if (leaf && st === "wip" && open.length) out.push({ text: "标为进行中，但还在等别的", target: { kind: open[0]!.kind, id: open[0]!.id } });
      return out;
    });
  }
  return {
    item, parentOf, children: id => (index().children.get(id) || []).slice(), areas: () => areas().slice(),
    ancestors: id => ancestors(id).slice(), lineOf, groupOf: id => item(lineOf(id))?.group || "",
    agentFor: id => item(id)?.agent || item(ancestors(id).find(a => item(a)?.agent) || "")?.agent || "",
    isLeaf, statusOf, priorityOf, effectivePriorityOf, raisedBy,
    depsOf: id => depsOf(id).map(e => ({ ...e })),
    dependents: id => (reverseDeps().items.get(id) || []).map(e => ({ ...e })),
    cardDependents: key => (reverseDeps().cards.get(key) || []).map(e => ({ ...e })),
    cardsOf: id => cardsOf(id).slice(), needsOwner, isArchived, inArchive, onCycle: id => cycles().has(id),
    checks: id => checks(id).map(c => c.target ? { ...c, target: { ...c.target } } : { ...c }),
    compareSiblings: (a, b) => rankOfPriority(effectivePriorityOf(a)) - rankOfPriority(effectivePriorityOf(b)) || Number(ended(a)) - Number(ended(b)) || byOrder(a, b),
  };
}
