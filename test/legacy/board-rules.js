// Verbatim oracle from ~/dev/agents_config/status-board.html (owner-authored).
// Source ranges: 511-531, 575-747, 810, 820-834, 847-860, 1349 (2026-10-11).
// Only this wrapper and its no-filter adapter are new; copied functions below
// are deliberately kept independent of src/rules.ts.
export function legacyRules(state) {
  // tops() consults the page's archive filter. The oracle uses its default off.
  const showsArchived = () => false;
  // Derived values depend only on `state`, which changes only in the snapshot handlers; renderAll clears this cache first.
  let memo = {};
  function invalidate() { memo = {}; }
  function cached(name, make) { return name in memo ? memo[name] : (memo[name] = make()); }
  // An item's place in the tree: its parent, or for an item written with an area instead, that top-level item.
  function up(it) { return it.parent || it.area || ""; }
  function upItem(it) { const p = up(it); return p ? index().byId.get(p) : null; }
  function index() {
    return cached("index", () => {
      const byId = new Map(state.items.map(i => [i.id, i]));
      const children = new Map();
      state.items.forEach(i => { const p = up(i); if (!children.has(p)) children.set(p, []); children.get(p).push(i); });
      children.forEach(list => list.sort((a, b) => (a.order || 0) - (b.order || 0)));
      const notesBy = new Map();
      state.notes.forEach(n => { if (!notesBy.has(n.target)) notesBy.set(n.target, []); notesBy.get(n.target).push(n); });
      const decById = new Map(state.decisions.map(d => [d.id, d]));
      return { byId, children, notesBy, decById };
    });
  }
  function notesOf(key) { return index().notesBy.get(key) || []; }
  function perKey(name, key, make) { const m = cached(name, () => new Map()); if (!m.has(key)) m.set(key, make()); return m.get(key); }
  // The owner archives an item by hand; it hides with its sub-items until something new happens on it.
  function latestOf(it) {
    const t = [String(it.updated || "")];
    (Array.isArray(it.log) ? it.log : []).forEach(e => t.push(String((e && e.at) || "")));
    notesOf("it:" + it.id).filter(n => n.reply).forEach(n => t.push(String(n.repliedAt || n.sentAt || n.at || "")));
    return t.sort().pop() || "";
  }
  function isArchived(it) { const r = state.archived[it.id]; return !!r && perKey("archived", it.id, () => !(latestOf(it) > String(r.at || ""))); }
  // inArchive under another name, for itemNode, whose parameter of that name shadows it.
  function archivedPath(it) { return inArchive(it); }
  function inArchive(it) { const seen = {}; for (let x = it; x && !seen[x.id]; x = upItem(x)) { seen[x.id] = true; if (isArchived(x)) return true; } return false; }
  // A parent's status is computed from its sub-items alone, cancelled ones left out: in progress when any is, else blocked
  // when any is, else done when all are done, else todo (partly done but nobody working on it); cancelled when all are.
  function statusOf(it, seen) {
    if (!seen) return perKey("status", it.id, () => statusOf(it, {}));
    if (seen[it.id]) return it.status || "todo";
    seen[it.id] = true;
    const all = (index().children.get(it.id) || []).map(k => statusOf(k, seen));
    if (!all.length) return it.status || "todo";
    const subs = all.filter(x => x !== "cancelled");
    if (!subs.length) return "cancelled";
    if (subs.includes("wip")) return "wip";
    if (subs.includes("blocked")) return "blocked";
    if (subs.every(x => x === "done")) return "done";
    return "todo";
  }
  // A leaf carries its own priority; a parent's is the highest among the leaves below it that are neither done nor cancelled
  // (among the done ones once none is open, among all once every one is cancelled). P0 is the highest.
  function leavesOf(it, seen) {
    seen = seen || {};
    if (seen[it.id]) return [];
    seen[it.id] = true;
    const subs = index().children.get(it.id) || [];
    return subs.length ? subs.flatMap(k => leavesOf(k, seen)) : [it];
  }
  function priorityOf(it) {
    return perKey("prio", it.id, () => {
      const valid = l => /^P[012]$/.test(l.priority || "");
      const leaves = leavesOf(it).filter(valid);
      const live = leaves.filter(l => statusOf(l) !== "cancelled");
      const open = live.filter(l => statusOf(l) !== "done");
      const pick = (open.length ? open : live.length ? live : leaves).map(l => l.priority).sort();
      return pick[0] || "";
    });
  }
  function visible(it) { return !isArchived(it); }
  // Siblings show by effective priority (P0 first, unset last), then open before done or cancelled, then by their order field.
  const PRIO_RANK = { P0: 0, P1: 1, P2: 2 };
  function byPriority(a, b) {
    const pa = PRIO_RANK[effPriorityOf(a)] ?? 3, pb = PRIO_RANK[effPriorityOf(b)] ?? 3;
    if (pa !== pb) return pa - pb;
    const ca = /^(done|cancelled)$/.test(statusOf(a)) ? 1 : 0, cb = /^(done|cancelled)$/.test(statusOf(b)) ? 1 : 0;
    return ca - cb || (a.order || 0) - (b.order || 0);
  }
  function kids(id, all) { const list = index().children.get(id || "") || []; return (all ? list.slice() : list.filter(visible)).sort(byPriority); }
  function openQ(q) { const d = index().decById.get(q); return !!(d && d.status === "open"); }
  // Once the owner has sent an approval or a choice, the item no longer waits on the owner, even before its session updates it.
  function answered(it) { return notesOf("it:" + it.id).some(n => ANSWER[n.kind] && (n.state === "sent" || n.state === "done") && n.text === ANSWER[n.kind].prefix + it.ask); }
  function askPending(it) { return !!it.ask && !answered(it); }
  function waitsQ(d) { return d.status === "open" && !notesOf("q:" + d.id).some(n => n.kind === "choice" && (n.state === "sent" || n.state === "done")); }
  function needsOwner(it) { return askPending(it) || (it.qs || []).some(q => { const d = index().decById.get(q); return !!(d && waitsQ(d)); }); }
  // Dependencies. Each entry of deps names an item this one depends on directly and why it needs it. An item's parent
  // is one of the items depending on it directly, so a parent lists its sub-items in deps. The board derives who depends
  // on each item, the priority an item inherits from the open work outside its ancestors that depends on it, and the
  // places where statuses, deps and the tree disagree.
  const ended = it => /^(done|cancelled)$/.test(statusOf(it));
  // The top-level item an item belongs to (its line of work), the project group that names, and the session responsible
  // for an item: its own agent, else its nearest ancestor's.
  function lineOf(it) { const a = ancestors(it); return a.length ? a[a.length - 1] : it; }
  function groupOf(it) { return lineOf(it).group || ""; }
  function agentFor(it) { if (!it) return ""; if (it.agent) return it.agent; const a = ancestors(it).find(x => x.agent); return a ? a.agent : ""; }
  function isLeaf(it) { return !(index().children.get(it.id) || []).length; }
  function ancestors(it) { const out = []; const seen = { [it.id]: true }; for (let p = upItem(it); p && !seen[p.id]; p = upItem(p)) { seen[p.id] = true; out.push(p); } return out; }
  function waitedBy() {
    return cached("waitedBy", () => {
      const m = new Map();
      state.items.forEach(w => depIds(w).forEach(d => { if (!m.has(d)) m.set(d, []); if (!m.get(d).includes(w)) m.get(d).push(w); }));
      return m;
    });
  }
  // deps entries are {id, why}; a bare id string, the older form, is an entry without why.
  function depEntries(it) { return (it.deps || []).map(x => typeof x === "string" ? { id: x, why: "" } : { id: (x && x.id) || "", why: (x && x.why) || "" }).filter(e => e.id); }
  function depIds(it) { return depEntries(it).map(e => e.id); }
  function whyOf(w, id) { const e = depEntries(w).find(x => x.id === id); return e ? e.why : ""; }
  function depsOf(it) { return depIds(it).map(id => index().byId.get(id)).filter(Boolean); }
  function openDeps(it) { return depsOf(it).filter(d => !ended(d)); }
  // Archived work no longer asks for anything, so it raises no priority and counts as no waiter.
  function openWaiters(it) { return (waitedBy().get(it.id) || []).filter(w => !ended(w) && !inArchive(w)); }
  // The same, leaving out the item's own subtree and ancestors: a parent depends on its sub-items as their parent,
  // which is the tree, not a wait on other work.
  function outDeps(it) { return openDeps(it).filter(d => !ancestors(d).includes(it)); }
  function outWaiters(it) { const up = ancestors(it); return openWaiters(it).filter(w => !up.includes(w)); }

  // An open leaf carries at least the effective priority of every open item waiting on it or on one of its ancestors;
  // a parent shows the highest effective priority among its open leaves. Ranks only fall, so the loop ends.
  const PRIO_NAME = ["P0", "P1", "P2"];
  function effective() {
    return cached("effective", () => {
      const rank = new Map(), why = new Map();
      const leaves = state.items.filter(isLeaf);
      leaves.forEach(l => rank.set(l.id, PRIO_RANK[l.priority] ?? 3));
      const rankOf = it => {
        if (isLeaf(it)) return rank.get(it.id);
        const open = leavesOf(it).filter(l => !ended(l));
        return open.length ? Math.min(...open.map(l => rank.get(l.id))) : PRIO_RANK[priorityOf(it)] ?? 3;
      };
      for (let changed = true; changed;) {
        changed = false;
        leaves.forEach(l => {
          if (ended(l) || inArchive(l)) return;
          let r = rank.get(l.id), by = null;
          [l].concat(ancestors(l)).forEach(a => outWaiters(a).forEach(w => { const wr = rankOf(w); if (wr < r) { r = wr; by = w; } }));
          if (by) { rank.set(l.id, r); why.set(l.id, by); changed = true; }
        });
      }
      return { rank, why, rankOf };
    });
  }
  function effPriorityOf(it) { return perKey("eff", it.id, () => PRIO_NAME[effective().rankOf(it)] || ""); }
  // The open item whose wait raised this one above its written priority, or null.
  function raisedBy(it) {
    const e = effPriorityOf(it);
    if (!e || e === priorityOf(it)) return null;
    const leaf = (isLeaf(it) ? [it] : leavesOf(it)).find(l => !ended(l) && effective().why.has(l.id) && effPriorityOf(l) === e);
    return leaf ? effective().why.get(leaf.id) : null;
  }

  // Items on a cycle of waits (a parent waits on its sub-items, an item on its deps); Tarjan's algorithm.
  function onCycle() {
    return cached("cycle", () => {
      const next = it => (index().children.get(it.id) || []).concat(depsOf(it));
      const idx = new Map(), low = new Map(), stack = [], on = new Set(), out = new Set();
      let n = 0;
      const visit = v => {
        idx.set(v.id, n); low.set(v.id, n); n++; stack.push(v); on.add(v.id);
        next(v).forEach(w => {
          if (!idx.has(w.id)) { visit(w); low.set(v.id, Math.min(low.get(v.id), low.get(w.id))); }
          else if (on.has(w.id)) low.set(v.id, Math.min(low.get(v.id), idx.get(w.id)));
        });
        if (low.get(v.id) === idx.get(v.id)) {
          const comp = [];
          let w;
          do { w = stack.pop(); on.delete(w.id); comp.push(w); } while (w !== v);
          if (comp.length > 1 || depIds(v).includes(v.id)) comp.forEach(c => out.add(c.id));
        }
      };
      state.items.forEach(v => { if (!idx.has(v.id)) visit(v); });
      return out;
    });
  }
  // What the owner or the responsible session should check on an item: statuses that disagree with its deps,
  // deps that are missing, cancelled, circular or without why, and an open sub-item its parent does not depend on.
  function checksOf(it) {
    return perKey("checks", it.id, () => {
      const out = [];
      if (inArchive(it)) return out;
      const st = statusOf(it), leaf = isLeaf(it), p = upItem(it);
      depEntries(it).forEach(e => {
        const d = index().byId.get(e.id);
        if (!d) out.push({ text: "依赖的条目不存在：" + e.id });
        else if (statusOf(d) === "cancelled") out.push({ text: "依赖的条目已取消", target: d });
        else if (!e.why && !ended(it)) out.push({ text: "依赖没写为什么：", target: d });
      });
      if (onCycle().has(it.id)) out.push({ text: "依赖成环" });
      if (!up(it) && !it.agent) out.push({ text: "顶层条目没有负责会话（agent）" });
      if (up(it) && !p) out.push({ text: "上级条目不存在：" + up(it) });
      if (p && !ended(it) && !depIds(p).includes(it.id)) out.push({ text: "上级没有把它列在依赖里（上级必须是直接依赖它的条目）：", target: p });
      if (leaf && st === "blocked" && depIds(it).length && !openDeps(it).length) out.push({ text: "可解除阻塞：等的都已完成" });
      if (leaf && st === "blocked" && !depIds(it).length && !needsOwner(it)) out.push({ text: "卡住了，但没写在等什么" });
      if (leaf && st === "wip" && openDeps(it).length) out.push({ text: "标为进行中，但还在等别的", target: openDeps(it)[0] });
      return out;
    });
  }
  const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
  // Top-level items, in their project group's order (the order of the group's first item), then their own order.
  function tops() {
    return cached("tops", () => {
      const list = (index().children.get("") || []).filter(t => visible(t) || showsArchived(t.group)).slice().sort(byOrder);
      const rank = new Map(); list.forEach(t => { const g = t.group || ""; if (!rank.has(g)) rank.set(g, rank.size); });
      return list.sort((a, b) => rank.get(a.group || "") - rank.get(b.group || "") || byOrder(a, b));
    });
  }
  function boardOrder() { return cached("boardOrder", boardOrderNow); }
  function boardOrderNow() {
    const out = [];
    const walk = list => list.forEach(i => { out.push(i); walk(kids(i.id)); });
    walk(tops());
    return out;
  }
  // An open decision sits under one item: the one its `item` field names, else the first item in board order that lists it.
  function homeOf(d) {
    if (d.item && index().byId.has(d.item)) return d.item;
    const first = cached("qsHome", () => { const m = new Map(); boardOrder().forEach(i => (i.qs || []).forEach(q => { if (!m.has(q)) m.set(q, i.id); })); return m; });
    return first.get(d.id) || null;
  }
  function ruledUnder(it) {
    const by = cached("ruledCards", () => { const m = new Map(); state.decisions.filter(d => d.status !== "open").forEach(d => { const h = homeOf(d); if (h) { if (!m.has(h)) m.set(h, []); m.get(h).push(d); } }); m.forEach(l => l.sort(byOrder)); return m; });
    return (by.get(it.id) || []).slice();
  }
  function cardsUnder(it) {
    const by = cached("cards", () => { const m = new Map(); state.decisions.filter(d => d.status === "open").forEach(d => { const h = homeOf(d); if (h) { if (!m.has(h)) m.set(h, []); m.get(h).push(d); } }); m.forEach(l => l.sort(byOrder)); return m; });
    return (by.get(it.id) || []).slice();
  }
  const ANSWER = { approve: { label: "同意", queued: "已同意，待发", sent: "已发送同意", prefix: "同意：" }, done: { label: "完成", queued: "已标完成，待发", sent: "已发送完成", prefix: "已完成：" } };
  return { index, up, upItem, ancestors, statusOf, leavesOf, priorityOf,
    byPriority, answered, askPending, waitsQ, needsOwner, lineOf, groupOf,
    agentFor, isLeaf, waitedBy, depEntries, depIds, whyOf, depsOf, openDeps,
    openWaiters, outDeps, outWaiters, effective, effPriorityOf, raisedBy,
    onCycle, checksOf, latestOf, isArchived, inArchive, homeOf, cardsUnder,
    ruledUnder, tops };
}
