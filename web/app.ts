import { rules } from "../src/rules.ts";
import type { Snapshot, Item, Decision, Note, Board, OwnerState, LogEntry } from "../src/model.ts";
import type { Step } from "../src/history.ts";
import type { OwnerOps } from "../src/owner-ops.ts";
type ViewItem = Item & { id: string };
type ViewDecision = Decision & { id: string };
type ViewNote = Note & { id: string };
interface ViewState { meta: Board | null; items: ViewItem[]; decisions: ViewDecision[]; notes: ViewNote[] }
interface FreshStop { key: string; step: string; doc: Step["docs"][number]; kinds: string[]; sel: string; item: string | null; card?: string; notes?: string }

  const STATUS: Record<string,string> = { wip: "WIP", done: "DONE", todo: "TODO", blocked: "BLOCK", cancelled: "DROP" };
  const state: ViewState = { meta: null, items: [], decisions: [], notes: [] };
  let snapshot: Snapshot = { board: { title: "进度板", projects: [] }, items: {}, decisions: {}, notes: {}, owner: { archived: {} }, head: "" };
  let derived = rules(snapshot);
  let steps: Step[] = [];
  let shownStop: string | null = null;
  const pendingDiffs = new Map<string, Promise<void>>();
  const failedDiffs = new Set<string>();
  let freshNavigation = 0;
  const diffs = new Map<string, { before: unknown; after: unknown; diff: string }>();
  let sendMessage = "";
  let connected = false;
  let editing: string | null = null, sending = false;
  type DraftKind = "choice" | "approve" | "done" | "explain";
  interface DraftOverlay { on:boolean; choice?:string; state:"draft"; promise?:Promise<boolean> }
  const optimistic = new Map<string,DraftOverlay>();
  const noteEvents = new Map<string,number>();
  const noteTombstones = new Map<string,number>();
  const draftKey = (target:string,kind:DraftKind) => target + "|" + kind;
  const drafts: Record<string, string> = {};
  let notesOpen: Record<string, boolean> = {};
  try { notesOpen = JSON.parse(localStorage.getItem("board-notes") || "{}") || {}; } catch (e) { notesOpen = {}; }
  // Closed decisions show under their item only when opened from its chip, or while they carry new replies.
  let ruledOpen: Record<string, boolean> = {};
  try { ruledOpen = JSON.parse(localStorage.getItem("board-ruled") || "{}") || {}; } catch (e) { ruledOpen = {}; }
  function saveRuled() { try { localStorage.setItem("board-ruled", JSON.stringify(ruledOpen)); } catch (e) {} }
  function ruledShown(d: ViewDecision) { return Object.prototype.hasOwnProperty.call(ruledOpen, d.id) ? !!ruledOpen[d.id] : cardFresh(d); }
  let manual: Record<string, boolean> = {};
  try { manual = JSON.parse(localStorage.getItem("board-open") || "{}") || {}; } catch (e) { manual = {}; }
  function saveManual() { try { localStorage.setItem("board-open", JSON.stringify(manual)); } catch (e) {} }

  function esc(s: unknown) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }
  // Inline text: **bold**, `code`, [label](https://...). Escaped first, so stored text cannot inject markup.
  function inline(s: unknown) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t;
  }
  // Block text: blank lines split paragraphs, "- " and "1. " lines make lists, ``` fences make code, and a paragraph opening with **label**: shows the label as a subheading.
  function textLines(src: unknown) {
    // A **label**: written mid-paragraph after a sentence end starts its own paragraph, so a section label still reads as a subheading.
    return String(src == null ? "" : src).replace(/\r/g, "").replace(/([。；！？.!?])[ \t]*(\*\*[^*\n]{1,16}\*\*[ \t]*[：:])/g, "$1\n\n$2").split("\n");
  }
  function blocks(src: unknown) {
    const lines = textLines(src);
    const out: string[] = [];
    let para: string[] = [], list: {tag:string;items:Array<{text:string}>} | null = null, code: string[] | null = null;
    const flushPara = () => {
      if (!para.length) return;
      const m = para[0]!.match(/^\*\*([^*]+)\*\*\s*[：:]\s*(.*)$/);
      let lead = para.slice();
      if (m) { out.push('<div class="sub">' + inline(m[1]) + "</div>"); lead[0] = m[2]!; lead = lead.filter((l, i) => i > 0 || l); }
      if (lead.length) out.push("<p>" + lead.map(inline).join("<br>") + "</p>");
      para = [];
    };
    const flushList = () => { if (list) { out.push("<" + list.tag + ">" + list.items.map(t => "<li>" + inline(t.text) + "</li>").join("") + "</" + list.tag + ">"); list = null; } };
    // Markdown tables: consecutive lines starting with "|"; a second row of dashes makes the first a header and sets alignment.
    let table: string[] | null = null;
    const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
    const flushTable = () => {
      if (!table) return;
      const rows = table;
      table = null;
      const isSep = (r: string) => r.length && cells(r).every(c => /^:?-{2,}:?$/.test(c));
      const head = rows.length > 1 && isSep(rows[1]!) ? rows[0]! : null;
      const align = head ? cells(rows[1]!).map(c => c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : "left") : [];
      const body = head ? rows.slice(2) : rows;
      const td = (tag: string, c: string, i: number) => "<" + tag + (align[i] && align[i] !== "left" ? ' style="text-align:' + align[i] + '"' : "") + ">" + inline(c) + "</" + tag + ">";
      let h = '<div class="tablewrap"><table>';
      if (head) h += "<thead><tr>" + cells(head).map((c, i) => td("th", c, i)).join("") + "</tr></thead>";
      h += "<tbody>" + body.map(r => "<tr>" + cells(r).map((c, i) => td("td", c, i)).join("") + "</tr>").join("") + "</tbody></table></div>";
      out.push(h);
    };
    for (const line of lines) {
      if (!code && /^\s*\|/.test(line)) { flushPara(); flushList(); (table = table || []).push(line); continue; }
      flushTable();
      if (code) { if (/^\s*```/.test(line)) { out.push('<pre class="code"><code>' + esc(code.join("\n")) + "</code></pre>"); code = null; } else code.push(line); continue; }
      if (/^\s*```/.test(line)) { flushPara(); flushList(); code = []; continue; }
      const ul = line.match(/^\s*[-*]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const tag = ul ? "ul" : "ol";
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push({ text: (ul || ol)![1]! });
        continue;
      }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      flushList();
      para.push(line);
    }
    if (code) out.push('<pre class="code"><code>' + esc(code.join("\n")) + "</code></pre>");
    flushTable(); flushPara(); flushList();
    return out.join("");
  }
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, html?: string): HTMLElementTagNameMap[K] { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function plain(s: unknown) { return String(s == null ? "" : s).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`]/g, ""); }
  function day(iso: string | undefined) { return iso ? String(iso).slice(0, 16).replace("T", " ") : ""; }

  // Rendering indexes adapt the shared rules' ids into page view objects.
  let memo: Record<string, unknown> = {};
  function invalidate() { memo = {}; derived = rules(snapshot); }
  function cached<T>(name: string, make: () => T): T { return name in memo ? memo[name] as T : (memo[name] = make()) as T; }
  function index() {
    return cached("index", () => {
      const byId = new Map(state.items.map(i => [i.id, i]));
      const children = new Map<string, ViewItem[]>();
      for (const id of ["", ...byId.keys()]) children.set(id, (id ? derived.children(id) : derived.areas()).map(k => byId.get(k)!).filter(Boolean));
      const notesBy = new Map<string, ViewNote[]>();
      state.notes.forEach(n => { const list = notesBy.get(n.target) || []; list.push(n); notesBy.set(n.target, list); });
      return { byId, children, notesBy, decById: new Map(state.decisions.map(d => [d.id, d])) };
    });
  }
  function up(it: ViewItem) { return it.parent || ""; }
  function upItem(it: ViewItem) { return index().byId.get(derived.parentOf(it.id) || "") || null; }
  function notesOf(key: string) { return index().notesBy.get(key) || []; }
  function headOf(it: ViewItem) { return it.head || ""; }
  function logOf(it: ViewItem) { return it.log.slice().sort((a,b) => a.at.localeCompare(b.at)); }
  function latestOf(it: ViewItem) { return [it.updated, ...it.log.map(e => e.at), ...notesOf("it:" + it.id).filter(n => n.reply).map(n => n.repliedAt || n.sentAt || n.at)].sort().at(-1)!; }
  function isArchived(it: ViewItem) { return derived.isArchived(it.id); }
  function inArchive(it: ViewItem) { return derived.inArchive(it.id); }
  function archivedPath(it: ViewItem) { return inArchive(it); }
  function statusOf(it: ViewItem) { return derived.statusOf(it.id); }
  function leavesOf(it: ViewItem) { return state.items.filter(i => derived.isLeaf(i.id) && (i.id === it.id || derived.ancestors(i.id).includes(it.id))); }
  function priorityOf(it: ViewItem) { return derived.priorityOf(it.id); }
  function effPriorityOf(it: ViewItem) { return derived.effectivePriorityOf(it.id); }
  function raisedBy(it: ViewItem) { return index().byId.get(derived.raisedBy(it.id) || "") || null; }
  function visible(it: ViewItem) { return !isArchived(it); }
  function byPriority(a: ViewItem,b: ViewItem) { return derived.compareSiblings(a.id,b.id); }
  function kids(id: string, all = false) { return (index().children.get(id || "") || []).filter(i => all || visible(i)).sort(byPriority); }
  function openQ(q: string) { return snapshot.decisions[q]?.status === "open"; }
  function askPending(it: ViewItem) { return derived.askPending(it.id); }
  function waitsQ(d: ViewDecision) { return derived.cardWaiting(d.id); }
  function needsOwner(it: ViewItem) { return derived.needsOwner(it.id); }
  const ended = (it: ViewItem) => /^(done|cancelled)$/.test(statusOf(it));
  function ancestors(it: ViewItem) { return derived.ancestors(it.id).map(k => index().byId.get(k)!); }
  function lineOf(it: ViewItem) { return index().byId.get(derived.lineOf(it.id))!; }
  function groupOf(it: ViewItem) { return derived.groupOf(it.id); }
  function isLeaf(it: ViewItem) { return derived.isLeaf(it.id); }
  function waitedBy() { return cached("waitedBy", () => new Map(state.items.map(i => [i.id, derived.dependents(i.id).map(d => index().byId.get(d.id)!)]))); }
  function depEntries(it: ViewItem) { return derived.depsOf(it.id); }
  function depIds(it: ViewItem) { return depEntries(it).filter(e => e.kind === "item").map(e => e.id); }
  function whyOf(w: ViewItem, id: string) { return depEntries(w).find(d => d.kind === "item" && d.id === id)?.why || ""; }
  function openDeps(it: ViewItem) { return depEntries(it).filter(e => e.open).map(e => e.kind === "item" ? index().byId.get(e.id)! : index().byId.get(snapshot.decisions[e.id]!.item)!).filter(Boolean); }
  function openWaiters(it: ViewItem) { return (waitedBy().get(it.id) || []).filter(w => !ended(w) && !inArchive(w)); }
  function outDeps(it: ViewItem) { return openDeps(it).filter(d => !derived.ancestors(d.id).includes(it.id)); }
  function outWaiters(it: ViewItem) { return openWaiters(it).filter(w => !derived.ancestors(it.id).includes(w.id)); }
  function checksOf(it: ViewItem) { return derived.checks(it.id); }
  function touched(kind: string,id: string) { return steps.some(s => s.docs.some(d => d.kind === kind && d.id === id)); }
  function cardNew(d: ViewDecision) { return touched("decision",d.id); }
  function cardFresh(d: ViewDecision) { return cardNew(d) || notesOf("q:" + d.id).some(n => touched("note",n.id)); }
  function noteFresh(n: ViewNote) {
    const before = unreadBefore<Note>("note",n.id);
    return { created: before === null, reply: before !== undefined && !!n.reply && before?.reply !== n.reply };
  }
  function newReplies(key: string) { return notesOf(key).filter(n => noteFresh(n).reply); }
  function newNotes(key: string) { return notesOf(key).filter(n => noteFresh(n).created); }
  // How many new things a document holds (server-counted; derived from the summary for a step without counts).
  function piecesOf(doc: Step["docs"][number]): {log:number;reply:number;other:number} {
    if (doc.pieces) return doc.pieces;
    const k = legacyKinds(doc);
    return { log: k.includes("log") ? Number(/\+(\d+) log/.exec(doc.summary)?.[1] ?? 1) : 0, reply: k.includes("reply") ? 1 : 0, other: k.includes("other") ? 1 : 0 };
  }
  function docKinds(doc: Step["docs"][number]): string[] { const p = piecesOf(doc); return (["log","reply","other"] as const).filter(k => p[k] > 0); }
  // The pieces of a stop the kind filter keeps: what the 新 counts add up.
  function stopCount(st: FreshStop) { const p = piecesOf(st.doc); return (["log","reply","other"] as const).reduce((n, k) => n + (fon(k) ? p[k] : 0), 0); }
  function countOf(list: FreshStop[]) { return list.reduce((n, st) => n + stopCount(st), 0); }
  function legacyKinds(doc: Step["docs"][number]): string[] {
    const kinds = new Set<string>();
    const changes = doc.summary.split(", ");
    const reply = changes.includes("new reply") || changes.includes("reply changed");
    for (const change of changes) {
      if (/^(\+\d+ log|log changed)$/.test(change)) kinds.add("log");
      else if (/^(new reply|reply changed)$/.test(change)) kinds.add("reply");
      else if (!(doc.kind === "note" && reply && change === "state changed")) kinds.add("other");
    }
    return kinds.size ? [...kinds] : ["other"];
  }
  function stopTouches(st: FreshStop, key: string): boolean {
    const doc = st.doc;
    if (key.startsWith("q:")) return doc.kind === "decision" && doc.id === key.slice(2) || doc.kind === "note" && snapshot.notes[doc.id]?.target === key;
    const id = key.slice(3);
    return doc.kind === "item" && doc.id === id || doc.kind === "decision" && snapshot.decisions[doc.id]?.item === id || doc.kind === "note" && (snapshot.notes[doc.id]?.target === key || snapshot.decisions[snapshot.notes[doc.id]?.target.slice(2) || ""]?.item === id);
  }
  // Each project group has its own filters, under its heading. They narrow its tree to the matching items, with the
  // path to each kept, dimmed: any number of status filters (a match on any of them), and one dependency filter on top.
  // Archived items take part only under 已归档, which shows each archived item with its subtree where it sits.
  let filters: Record<string, {status:string[];dep:string}> = {};
  try { filters = JSON.parse(localStorage.getItem("board-filters2") || "{}") || {}; } catch (e) {}
  function groupFilter(g: string) { return filters[g || ""] || { status: [], dep: "" }; }
  const WEEK = 7 * 24 * 3600 * 1000;
  type Filter = [string,string,string,(it:ViewItem)=>boolean];
  const STATUS_FILTERS: Filter[] = [
    ["wip", "进行中", "进行中的条目", it => statusOf(it) === "wip"],
    ["blocked", "卡住", "卡住的条目", it => statusOf(it) === "blocked"],
    ["todo", "未开始", "还没开始的条目，包括部分完成但没人在做的", it => statusOf(it) === "todo"],
    ["done7", "7 天内完成", "最近 7 天完成的条目", it => statusOf(it) === "done" && Date.parse(latestOf(it)) > Date.now() - WEEK],
    ["cancelled", "取消", "取消的条目", it => statusOf(it) === "cancelled"],
    ["archived", "已归档", "归档的条目，各在原来的位置", it => inArchive(it)]
  ];
  const DEP_FILTERS: Filter[] = [
    ["chain", "阻塞链", "只看依赖下级以外的工作、被上级以外的条目依赖或卡住的条目", it => !ended(it) && (outDeps(it).length > 0 || outWaiters(it).length > 0 || (isLeaf(it) && statusOf(it) === "blocked"))],
    ["cross", "跨项目依赖", "只看依赖或被依赖跨了项目的条目", it => !ended(it) && (openDeps(it).some(d => groupOf(d) !== groupOf(it)) || openWaiters(it).some(w => groupOf(w) !== groupOf(it)))],
    ["check", "需核对", "只看状态和依赖对不上、或依赖写错的条目", it => checksOf(it).length > 0]
  ];
  function filtering(g: string) { const f = groupFilter(g); return f.status.length > 0 || !!f.dep; }
  function anyFiltering() { return Object.keys(filters).some(filtering); }
  function showsArchived(g: string) { return groupFilter(g).status.includes("archived"); }
  function matches(it: ViewItem) {
    const f = groupFilter(groupOf(it)), arch = inArchive(it);
    if (arch && !f.status.includes("archived")) return false;
    const st = f.status.length ? STATUS_FILTERS.some(([k, , , fn]) => f.status.includes(k) && fn(it)) : !arch;
    const d = DEP_FILTERS.find(x => x[0] === f.dep);
    return st && (!d || d[3](it));
  }
  function filterMatches() {
    return cached("filterMatch", () => {
      const hit = new Set<string>();
      state.items.forEach(it => { if (filtering(groupOf(it)) && matches(it)) hit.add(it.id); });
      const anc = new Set<string>();
      hit.forEach(id => ancestors(index().byId.get(id)!).forEach(a => anc.add(a.id)));
      // anc: every item above a match, opened by the filter; the ones that do not match themselves show as dimmed path.
      return { hit, anc, keep: new Set([...hit, ...anc]) };
    });
  }
  function filterCount(list: Filter[], key: string, g: string) { const f = list.find(x => x[0] === key); return state.items.filter(it => groupOf(it) === g && (key === "archived" ? isArchived(it) : !inArchive(it)) && f![3](it)).length; }
  function passes(it: ViewItem) { return !filtering(groupOf(it)) || filterMatches().keep.has(it.id); }
  function saveFilters() { rulePresentationDirty=true; try { localStorage.setItem("board-filters2", JSON.stringify(filters)); } catch (e) {} invalidate(); renderNow("areas"); }
  function toggleStatusFilter(g: string, key: string) { const f = groupFilter(g); filters[g] = { status: f.status.includes(key) ? f.status.filter(k => k !== key) : f.status.concat(key), dep: f.dep }; saveFilters(); }
  function setDepFilter(g: string, key: string) { const f = groupFilter(g); filters[g] = { status: f.status, dep: f.dep === key ? "" : key }; saveFilters(); }
  function clearFilters(g?: string | null) { if (g == null) filters = {}; else delete filters[g]; try { localStorage.setItem("board-filters2", JSON.stringify(filters)); } catch (e) {} invalidate(); }
  // The filter row under a project heading: the status filters with their counts in that project, then the dependency ones it has.
  function filterRow(g: string) {
    const row = el("div", "sum-row grp-filters");
    const f = groupFilter(g);
    const btn = (on: boolean, text: string, title: string, fn: () => void) => { const b = el("button", "sbtn s-plain" + (on ? " s-on" : ""), text); b.type = "button"; if (title) b.title = title; b.addEventListener("click", fn); return b; };
    STATUS_FILTERS.forEach(([key, label, title]) => {
      const n = filterCount(STATUS_FILTERS, key, g), on = f.status.includes(key);
      if (n || on) row.appendChild(btn(on, label + " " + n, title + "（可多选）", () => toggleStatusFilter(g, key)));
    });
    DEP_FILTERS.forEach(([key, label, title]) => {
      const n = filterCount(DEP_FILTERS, key, g), on = f.dep === key;
      if (n || on) row.appendChild(btn(on, label + " " + n, title, () => setDepFilter(g, key)));
    });
    if (filtering(g)) row.appendChild(btn(false, "清除筛选", "", () => { clearFilters(g); renderNow("areas"); }));
    return row;
  }
  const byOrder = (a: {order?:number}, b: {order?:number}) => (a.order || 0) - (b.order || 0);
  // For each item, how many waiting and new stops lie below it; recomputed once per render.
  let below: {wait: Record<string,number>;fresh: Record<string,number>} = {wait:{},fresh:{}};
  function countBelow() {
    const byId = new Map(state.items.map(i => [i.id, i]));
    const tally = <T extends {item: string | null}>(list: T[], into: Record<string,number>, weight: (x: T) => number) => list.forEach(x => { const it = x.item && byId.get(x.item); if (it) ancestors(it).forEach(a => { into[a.id] = (into[a.id] || 0) + weight(x); }); });
    below = { wait: {}, fresh: {} };
    tally(stops(), below.wait, () => 1);
    tally(freshStops(), below.fresh, stopCount);
  }
  // Top-level items, in their project group's order (the order of the group's first item), then their own order.
  function tops() { return derived.areas(id => !derived.isArchived(id) || showsArchived(snapshot.items[id]?.group || "")).map(id => index().byId.get(id)!); }
  function boardOrder() { return cached("boardOrder", boardOrderNow); }
  function boardOrderNow() {
    const out: ViewItem[] = [];
    const walk = (list: ViewItem[]) => list.forEach(i => { out.push(i); walk(kids(i.id)); });
    for (const g of projectGroups()) { walk(derived.inbox(g.name).map(id => index().byId.get(id)!)); walk(g.items); }
    return out;
  }
  function homeOf(d: ViewDecision) { return index().byId.has(d.item) ? d.item : null; }
  function ruledUnder(it: ViewItem) { return derived.cardsOf(it.id).map(id => index().decById.get(id)!).filter(d => d.status !== "open"); }
  function cardsUnder(it: ViewItem) { return derived.cardsOf(it.id).map(id => index().decById.get(id)!).filter(d => d.status === "open"); }

  // The stops 下一条 walks: each item's ask, then each open decision, in board order; decisions no item lists come last.
  function stops() { return cached("stops", stopsNow); }
  function stopsNow() {
    const out: Array<{id:string;item:string|null}> = [];
    boardOrder().forEach(i => { if (askPending(i)) out.push({ id: "ask-" + i.id, item: i.id }); cardsUnder(i).filter(waitsQ).forEach(d => out.push({ id: "q-" + d.id, item: i.id })); });
    state.decisions.filter(d => waitsQ(d) && !homeOf(d)).sort(byOrder).forEach(d => out.push({ id: "q-" + d.id, item: null }));
    return out;
  }
  // Unread steps stay in commit order, independent of tree and filter order.
  // Which kinds of new things the 新 walk and counts include, picked like the project filters: replies to the owner's
  // notes (reply), new log entries (log) and every other change (other); none picked means all of them.
  const FRESH_KINDS: Array<[string,string,string]> = [["reply", "评论回复", "只看对你评论的新回复"], ["log", "进展", "只看新的进展记录"], ["other", "其他", "只看正文、标题、状态等其他改动"]];
  let freshSel: string[] = [];
  try { freshSel = (JSON.parse(localStorage.getItem("board-fresh-sel") || "[]") || []).filter((k: string) => FRESH_KINDS.some(f => f[0] === k)); } catch (e) {}
  function fon(kind: string) { return !freshSel.length || freshSel.includes(kind); }
  function setFreshSel(sel: string[]) {
    freshSel = sel.length === FRESH_KINDS.length ? [] : sel;
    try { localStorage.setItem("board-fresh-sel", JSON.stringify(freshSel)); } catch (e) {}
    renderAll();
  }
  function toggleFresh(kind: string) { setFreshSel(freshSel.includes(kind) ? freshSel.filter(k => k !== kind) : freshSel.concat(kind)); }
  // Each document a step changed is its own stop, shown under its own item or card. A change inside an archived item
  // is not new: archiving says the owner is done with it; reading a later stop still moves the cursor past it.
  function allFreshStops() { return cached("allFreshStops", freshStopsNow); }
  function freshStops() { return cached("freshStops", () => allFreshStops().filter(st => st.kinds.some(fon))); }
  function freshShown(i: ViewItem) { return freshStops().some(st => stopTouches(st, "it:" + i.id)); }
  function freshStopsNow(): FreshStop[] {
    const out = steps.flatMap(step => step.docs.map((d): FreshStop => {
      let card: string | undefined, item: string | null = null, notes: string | undefined;
      if (d.kind === "item") item = d.id;
      if (d.kind === "decision") { card = d.id; item = snapshot.decisions[d.id]?.item || null; }
      if (d.kind === "note") { const n = snapshot.notes[d.id]; notes = n?.target; if (notes?.startsWith("q:")) { card = notes.slice(2); item = snapshot.decisions[card]?.item || null; } else item = notes?.slice(3) || null; }
      const key = step.id + "|" + d.kind + "|" + d.id;
      return { key, step: step.id, doc: d, kinds: docKinds(d), sel: d.kind === "item" ? "it:" + d.id : d.kind === "decision" ? "q:" + d.id : "note:" + d.id, item, card, notes };
    })).filter(st => !(st.item && snapshot.items[st.item] && derived.inArchive(st.item)));
    return out;
  }

  function noteElementId(id:string) { return "note-"+id.replace(/[^A-Za-z0-9_-]/g,"_"); }
  function noteId(n: ViewNote) { return noteElementId(n.id); }
  // The element a stop selects, once its item, card and comment list are open.
  function stopEl(st: FreshStop) { return selEl(st.sel); }
  async function goFresh(k: number) {
    const all = freshStops();
    if (!all.length) return;
    const st = all[((k % all.length) + all.length) % all.length]!;
    shownStop = st.key;
    await navigate({id:st.doc.kind === "note" ? noteElementId(st.doc.id) : st.card ? "q-"+st.card : "it-"+st.doc.id,item:st.item,card:st.card,notes:st.notes,note:st.doc.kind === "note" ? st.doc.id : undefined},() => shownStop === st.key && allFreshStops().some(s => s.key === st.key));
  }
  interface NavigationTarget { id:string; item:string | null; card?:string; notes?:string; note?:string; selection?:string }
  async function navigate(target:NavigationTarget, valid:() => boolean = () => true) {
    const navigation=++freshNavigation;
    const active=() => navigation === freshNavigation && valid();
    const retry=new Set(failedDiffs);
    clearCurrent();
    const it=target.item && index().byId.get(target.item);
    if (it) {
      if (inArchive(it)) { const g=groupOf(it); filters[g]={...groupFilter(g),status:["archived"]}; invalidate(); }
      else if (!passes(it)) clearFilters(groupOf(it));
      openPath(it.id);
    }
    if (target.card) { const d=index().decById.get(target.card); if (d && d.status !== "open") { ruledOpen[d.id]=true; saveRuled(); } }
    const comments=target.notes || (target.card ? "q:"+target.card : target.item ? "it:"+target.item : undefined);
    if (comments) { notesOpen[comments]=true; try { localStorage.setItem("board-notes",JSON.stringify(notesOpen)); } catch {} }
    scheduleRender(...(target.card ? ["card:"+target.card] : []),...(comments ? ["notes:"+comments] : []));
    if (it && !get("it-"+it.id)) scheduleRender("group:"+groupOf(it));
    await rendered();
    if (!active()) return;
    let required=navigationBaselines(target);
    for (const key of required.keys()) if (retry.has(key)) failedDiffs.delete(key);
    for (;;) {
      await Promise.all([...required.values()].map(({step,doc}) => loadDiff(step,doc)));
      if (!active()) return;
      await rendered();
      if (!active()) return;
      required=navigationBaselines(target);
      if ([...required.keys()].some(key => failedDiffs.has(key))) return;
      if ([...required.keys()].every(key => diffs.has(key))) break;
    }
    const e=get(target.id);
    if (!e) return;
    glideToTarget(e);
    setCurrent(target.note || target.selection ? e : e.closest<HTMLElement>(".card, .item"));
  }
  function navigationBaselines(st: NavigationTarget) {
    const required = new Map<string,{step:Step;doc:Step["docs"][number]}>();
    const add = (kind: Step["docs"][number]["kind"], id: string) => {
      const step = steps.find(s => s.docs.some(d => d.kind === kind && d.id === id));
      const doc = step?.docs.find(d => d.kind === kind && d.id === id);
      if (step && doc) required.set(step.id + ":" + kind + ":" + id,{step,doc});
    };
    const notes = (key:string) => {
      // An explicit fold stays folded as marks load; an unspecified list may still auto-open for fresh content.
      if (notesOpen[key] === false) return;
      notesOf(key).filter(listed).forEach(n => add("note",n.id));
    };
    const card = (id:string) => { if (!get("q-" + id)) return; add("decision",id); notes("q:" + id); };
    if (st.item) for (const id of [st.item,...derived.ancestors(st.item)]) {
      if (!get("it-" + id)) continue;
      // Comments render outside the manually opened body, including ancestors opened only by a filter.
      notes("it:" + id);
      if (!manual[id]) continue;
      add("item",id);
      derived.cardsOf(id).forEach(card);
    }
    if (st.card) card(st.card);
    if (st.note && snapshot.notes[st.note]) add("note",st.note);
    return required;
  }
  // A chip counts the unread stops touching this item or card; a click opens the oldest.
  function freshChip(key: string) {
    const all = freshStops();
    const mine = all.map((st, k): [FreshStop,number] => [st, k]).filter(([st]) => stopTouches(st, key));
    const c = el("span", "newtag freshchip", "新 " + Math.max(1, countOf(mine.map(([st]) => st))));
    c.title = "点一下到这里的第一条新内容；n 走到下一条，r 标为已阅";
    if (mine.length) {
      c.setAttribute("role", "button"); c.tabIndex = 0;
      const go = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); goFresh(mine[0]![1]); };
      c.addEventListener("click", go);
      c.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") go(ev); });
    }
    return c;
  }
  function shownFresh() { return shownStop ? allFreshStops().find(st => st.key === shownStop) || null : null; }
  async function markRead(key: string) {
    const st = key.startsWith("step:") ? allFreshStops().find(s => s.key === key.slice(5)) : shownFresh();
    return st ? readThrough(st.step) : false;
  }
  async function readThrough(step: string) {
    if (!steps.some(s => s.id === step)) return false;
    freshNavigation++;
    try { for (const id of Object.keys(logShown)) if (manual[id]) logHold[id] = true; await api("/api/read", { through: step }); shownStop = null; void refreshOwner().catch(showError); return true; } catch (e) { showError(e); return false; }
  }
  function goNextFresh() {
    const all = freshStops(); if (!all.length) return;
    const at = all.findIndex(s => s.key === shownStop);
    goFresh(at < 0 ? 0 : at + 1);
  }
  function goPrevFresh() {
    const all = freshStops(); if (!all.length) return;
    const at = all.findIndex(s => s.key === shownStop);
    goFresh(at < 0 ? all.length - 1 : at - 1);
  }
  function selectedFresh() {
    const st = shownFresh();
    // A deleted document has no selectable body, but its logical stop still advances the read cursor.
    const missing = st && (st.doc.kind === "item" ? !snapshot.items[st.doc.id] : st.doc.kind === "decision" ? !snapshot.decisions[st.doc.id] : !snapshot.notes[st.doc.id]);
    return st && (missing ? current === null : current === st.sel && onScreen(stopEl(st))) ? { key: "step:" + st.key } : null;
  }

  // The selection: an item (it:), a card (q:), a log entry (log:<item>@<time>) or a comment or reply (note:<id>).
  // r, c, e and a act on it, or on the item or card that holds it.
  let current: string | null = null;
  function keyOfBox(box: HTMLElement | null) { return !box ? null : box.dataset.sel || (box.id.startsWith("q-") ? "q:" + box.id.slice(2) : box.id.startsWith("it-") ? "it:" + box.id.slice(3) : null); }
  function selEl(key: string | null) {
    if (!key) return null;
    if (key.startsWith("it:")) return get("it-" + key.slice(3));
    if (key.startsWith("q:")) return get("q-" + key.slice(2));
    return document.querySelector<HTMLElement>('[data-sel="' + CSS.escape(key) + '"]');
  }
  function boxOfKey(key: string | null) { return selEl(key); }
  // The item or card a selection belongs to.
  function containerOf(key: string | null) {
    if (!key) return null;
    if (key.startsWith("it:") || key.startsWith("q:")) return key;
    if (key.startsWith("log:")) return "it:" + key.slice(4, key.indexOf("@"));
    if (key.startsWith("dep:")) return "it:" + key.slice(4, key.indexOf("@"));
    if (key.startsWith("note:")) { const n = state.notes.find(x => x.id === key.slice(5)); return n ? n.target : null; }
    return null;
  }
  // What a comment on the selection is about, beyond its item or card: a log entry or a reply.
  function anchorOf(key: string | null): Note["anchor"] | null {
    if (key && key.startsWith("log:")) return { kind: "log", at: key.slice(key.indexOf("@") + 1) };
    if (key && key.startsWith("note:")) return { kind: "note", id: key.slice(5) };
    return null;
  }
  function setCurrent(box: HTMLElement | null) {
    const key = keyOfBox(box);
    if (!key || !box) return;
    const old = selEl(current);
    if (old) old.classList.remove("cur");
    current = key;
    box.classList.add("cur");
  }
  function onScreen(e: HTMLElement | null) {
    if (!e) return false;
    const bar = get("crumbs");
    const topEdge = bar && !bar.hidden ? bar.getBoundingClientRect().bottom : 0;
    const r = e.getBoundingClientRect();
    return r.bottom > topEdge && r.top < innerHeight;
  }
  function clearCurrent() { const old = boxOfKey(current); if (old) old.classList.remove("cur"); current = null; }
  // A click on an item or card selects it; a click on blank space (not on a control) clears the selection.
  document.addEventListener("click", ev => {
    const t = ev.target as HTMLElement & {type?: string};
    const box = t.closest && t.closest<HTMLElement>("[data-sel], #areas .item, #areas .card, #cards .card");
    if (box) setCurrent(box);
    else if (!(t.closest && t.closest<HTMLElement>("button, a, input, textarea, select, label"))) clearCurrent();
  }, true);
  // Otherwise the item or card the reader is looking at: the one just below the location bar, or near the top of the screen.
  function targetOnScreen() {
    if (current && onScreen(boxOfKey(current))) return current;
    const bar = get("crumbs");
    const y = (bar && !bar.hidden ? bar.getBoundingClientRect().bottom : 0) + 16;
    const wrap = document.querySelector<HTMLElement>(".wrap")!.getBoundingClientRect();
    const hit = document.elementFromPoint(wrap.left + wrap.width / 2, y);
    const box = hit && (hit.closest<HTMLElement>(".card") || hit.closest<HTMLElement>(".item"));
    if (box && box.id.startsWith("q-")) return "q:" + box.id.slice(2);
    if (box && box.id.startsWith("it-")) return "it:" + box.id.slice(3);
    const first = [...document.querySelectorAll<HTMLElement>(".item, .card")].find(e => { const r = e.getBoundingClientRect(); return r.top >= y - 16 && r.top < innerHeight; });
    if (!first) return null;
    return first.id.startsWith("q-") ? "q:" + first.id.slice(2) : "it:" + first.id.slice(3);
  }
  // Shortcuts, listed with their actions in ACTIONS below and in the ☰ menu: n, r, c, e, a, w;
  // Backspace or [ goes back after following a dependency; Esc closes lists; gg goes to the top and G to the bottom, as in vi.
  // They stay off only while typing: a focused checkbox or button does not swallow them.
  let lastG = 0;
  document.addEventListener("keydown", ev => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return;
    const t = ev.target as HTMLElement & {type?: string};
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || (t.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset)$/.test(t.type || "")))) return;
    if (ev.key === "G") { ev.preventDefault(); lastG = 0; glideTo(document.documentElement.scrollHeight); return; }
    if (ev.key === "g") {
      ev.preventDefault();
      const now = Date.now();
      if (now - lastG < 600) { lastG = 0; glideTo(0); } else lastG = now;
      return;
    }
    lastG = 0;
    if (ev.key === "Backspace" || ev.key === "[") { if (backStack.length) { ev.preventDefault(); goBack(); } return; }
    if (ev.key === "j" || ev.key === "k") { ev.preventDefault(); moveFocus(ev.key === "j" ? 1 : -1); return; }
    if (ev.key === "Enter") { if (toggleFocused()) ev.preventDefault(); return; }
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") { ev.preventDefault(); stepStop(ev.key === "ArrowRight" ? 1 : -1); return; }
    const act = ACTIONS.find(a => a.key === ev.key && a.db);
    if (act && !connected) { showError(new Error(DISCONNECTED)); return; }
    if (act && act.run()) ev.preventDefault();
  });
  // The actions behind the shortcut keys; the menu (☰) lists them and runs them on a click as well.
  // Each acts on the selected item or card while it is on screen, else on the one at the top of the screen.
  function itemOfSelection() {
    const box = current && boxOfKey(current);
    if (!box || !onScreen(box)) return null;
    const itemBox = current?.startsWith("it:") ? box : box.closest<HTMLElement>("#areas .item");
    return itemBox ? index().byId.get(itemBox.id.slice(3)) : null;
  }
  // j and k move the selection to the next or previous item or card on the page, in screen order, without opening
  // anything; the page scrolls only as far as keeps the new selection in view. Enter opens or folds the selected item.
  function navBoxes() { return [...document.querySelectorAll<HTMLElement>("#areas .item, #areas .card, #cards .card")].filter(e => e.offsetParent !== null); }
  function moveFocus(dir: number) {
    const list = navBoxes();
    if (!list.length) return;
    const bar = get("crumbs");
    const topEdge = bar && !bar.hidden ? bar.getBoundingClientRect().bottom : 0;
    const sel = selEl(current);
    const box = sel && (sel.matches(".item, .card") ? sel : sel.closest<HTMLElement>(".card, .item"));
    let k = box ? list.indexOf(box) : -1;
    let next;
    if (k >= 0 && onScreen(box)) next = list[Math.min(list.length - 1, Math.max(0, k + dir))];
    else next = list.find(e => e.getBoundingClientRect().top >= topEdge) || list[0];
    if (!next) return;
    setCurrent(next);
    const r = next.getBoundingClientRect();
    if (r.top < topEdge + 4) glideTo(scrollY + r.top - topEdge - 8);
    else if (r.bottom > innerHeight - 4) glideTo(scrollY + Math.min(r.top - topEdge - 8, r.bottom - innerHeight + 8));
  }
  function toggleFocused() {
    const sel = selEl(current);
    const box = sel && (sel.matches(".item") ? sel : sel.closest<HTMLElement>(".item"));
    const head = box && box.querySelector<HTMLButtonElement>(":scope > .item-row > .item-head");
    if (!head) return false;
    head.click();
    // The head click focuses the head for keyboard users; from Enter that leaves a focus ring, so drop the focus.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return true;
  }
  // Left and right arrows step through what waits for the owner (requests and open cards), from the selection.
  function stepStop(dir: number) {
    const all = stops();
    if (!all.length) return;
    const key = containerOf(current);
    let k = key ? all.findIndex(st => key === "q:" + st.id.slice(2) && st.id.startsWith("q-") || (st.item && key === "it:" + st.item && st.id.startsWith("ask-"))) : -1;
    if (k >= 0) { goStop(k + dir); return; }
    const bar = get("crumbs");
    const topEdge = bar && !bar.hidden ? bar.getBoundingClientRect().bottom : 0;
    const pos = (st: {id:string;item:string|null}) => { const e = get(st.id) || (st.item ? get("it-" + st.item) : null); return e ? e.getBoundingClientRect().top : Infinity; };
    if (dir > 0) { const n = all.findIndex(st => pos(st) > topEdge); goStop(n >= 0 ? n : 0); }
    else { let n = -1; all.forEach((st, i) => { if (pos(st) < topEdge) n = i; }); goStop(n >= 0 ? n : all.length - 1); }
  }
  const ACTIONS = [
    { key: "j", show: "j / k", label: "选中下一个 / 上一个条目（不展开）", run: () => { moveFocus(1); return true; } },
    { key: "Enter", show: "Enter", label: "展开或收起选中的条目", run: () => toggleFocused() },
    { key: "ArrowRight", show: "← / →", label: "上一条 / 下一条等你处理", run: () => { stepStop(1); return true; } },
    { key: "n", label: "下一条新", db: true, run: () => { goNextFresh(); return true; } },
    { key: "N", label: "上一条新", db: true, run: () => { goPrevFresh(); return true; } },
    { key: "r", label: "标为已阅", db: true, run: () => { const st = selectedFresh(); if (st) markRead(st.key); return !!st; } },
    { key: "c", label: "评论选中的内容（条目、卡片、某条进展或回复）", db: true, run: () => { const k = targetOnScreen(); if (k && containerOf(k)) openComment(containerOf(k)!, anchorOf(k)); return !!k; } },
    { key: "e", label: "请 Claude 详细解释（再按一次撤回）", db: true, run: () => { const k = targetOnScreen(); if (k && containerOf(k)) toggleExplain(containerOf(k)!); return !!k; } },
    { key: "a", label: "归档或取消归档（选中的条目，或选中卡片所在的条目）", db: true, run: () => { const it = itemOfSelection(); if (it) toggleArchive(it); return !!it; } },
    { key: "Backspace", show: "Backspace 或 [", label: "跟着依赖跳转后返回", run: () => { goBack(); return true; } },
    { key: "gg", show: "gg / G", label: "回到顶部 / 到底部", run: () => { glideTo(0); return true; } }
  ];
  function renderMenu() {
    let m = get("keymenu");
    if (!m) {
      m = el("div", "keymenu"); m.id = "keymenu";
      const b = el("button", "keymenu-btn", "☰"); b.type = "button"; b.title = "快捷键"; b.setAttribute("aria-label", "快捷键");
      b.addEventListener("click", ev => { ev.stopPropagation(); m.classList.toggle("open"); });
      m.appendChild(b);
      const list = el("div", "keymenu-list");
      list.appendChild(el("div", "keymenu-head", "快捷键：作用于选中的条目或卡片；没选中时作用于屏幕最上面那一条"));
      ACTIONS.forEach(a => {
        const r = el("button", "keymenu-row", '<kbd>' + esc(a.show || a.key) + "</kbd><span>" + esc(a.label) + "</span>");
        r.type = "button";
        r.addEventListener("click", ev => { ev.stopPropagation(); if (a.db && !connected) { showError(new Error(DISCONNECTED)); return; } a.run(); m.classList.remove("open"); });
        list.appendChild(r);
      });
      m.appendChild(list);
      document.body.appendChild(m);
      document.addEventListener("click", ev => { if (!m.contains(ev.target as Node)) m.classList.remove("open"); });
    }
  }
  function goStop(k: number) {
    const all = stops();
    if (!all.length) return;
    const st = all[((k % all.length) + all.length) % all.length]!;
    jump(st.id);
  }
  // The last waiting stop leads to the send box, so the owner sends the batch without scrolling back.
  function nextButton(stopId: string) {
    const all = stops();
    const k = all.findIndex(x => x.id === stopId);
    const last = k === all.length - 1;
    const b = el("button", "nextbtn", last ? "去发送" : "下一条（" + (k + 2) + "/" + all.length + "）");
    b.dataset.stop=stopId;
    b.type = "button";
    b.addEventListener("click", ev => { ev.stopPropagation(); if (last) jump("sendbox"); else goStop(k + 1); });
    return b;
  }
  // An item opens by default when it is in progress, waits for the owner, or holds something that does.
  // Everything starts folded; an item opens when the owner opens it or a jump (下一条, 下一条新, a chip) leads into it.
  // Under a dependency filter, the items above a match open unless the owner folded them.
  function isOpen(it: ViewItem) { return filtering(groupOf(it)) && !(it.id in manual) ? filterMatches().anc.has(it.id) : !!manual[it.id]; }

  // Scrolling glides for at most about a third of a second however far it goes: a long trip jumps most of the way
  // and eases over the last screenful, so the motion still shows the direction without dragging.
  let glideRun = 0;
  let landing:{id:string;top:number;gliding?:number} | null = null;
  let expectedScroll:number | null = null;
  function scrollTo(top:number) { expectedScroll=top; window.scrollTo(0,top); expectedScroll=window.scrollY; }
  function scrollBy(delta:number) { expectedScroll=window.scrollY+delta; window.scrollBy(0,delta); expectedScroll=window.scrollY; }
  function releaseLanding() { landing=null; glideRun++; freshNavigation++; }
  function glideTo(top: number, pin?:{id:string;top:number}) {
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    top = Math.min(max, Math.max(0, Math.round(top)));
    const run = ++glideRun;
    const target=pin && get(pin.id);
    landing=pin && target ? {id:pin.id,top:window.scrollY+target.getBoundingClientRect().top-top,gliding:run} : null;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { scrollTo(top); if (landing) delete landing.gliding; return; }
    const reach = innerHeight;
    let from = scrollY;
    if (Math.abs(top - from) > reach) { from = top - Math.sign(top - from) * reach; scrollTo(from); }
    const dist = top - from, ms = 160 + Math.abs(dist) / reach * 160, t0 = performance.now();
    const step = (now: number) => {
      if (run !== glideRun) return;
      const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      const target=landing && get(landing.id);
      const destination=target && landing ? window.scrollY+target.getBoundingClientRect().top-landing.top : top;
      scrollTo(from + (destination-from) * e);
      if (k < 1) frame(step); else if (landing) delete landing.gliding;
    };
    frame(step);
  }
  // The reader's own wheel or touch stops a glide.
  ["wheel", "touchstart"].forEach(t => addEventListener(t, releaseLanding, { passive: true }));
  ["keydown","click"].forEach(t => document.addEventListener(t, ev => { if (ev.isTrusted !== false) releaseLanding(); }, {capture:true}));
  function glideToEl(t: HTMLElement, block: string) {
    const r = t.getBoundingClientRect();
    const margin = parseFloat(getComputedStyle(t).scrollMarginTop) || 0;
    const top = block === "start" || r.height + margin > innerHeight ? r.top - margin : r.top - (innerHeight - r.height) / 2;
    glideTo(scrollY + top,t.id ? {id:t.id,top:r.top-top} : undefined);
  }
  // A jump keeps the target in view first; within that, it shows as much of the enclosing card or item as fits,
  // and centres what it shows: the whole card when it fits under the location bar, else the target, moved off
  // centre only as far as keeps the card filling three quarters of the view.
  function glideToTarget(t: HTMLElement) {
    const bar = get("crumbs");
    const top = (bar && !bar.hidden && bar.offsetHeight ? bar.offsetHeight : 46) + 8, bottom = innerHeight - 8, room = bottom - top;
    const doc = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY }; };
    const T = doc(t);
    const box = (t.parentElement && t.parentElement.closest<HTMLElement>(".card, .item")) && !t.matches(".card, .item") ? t.parentElement.closest<HTMLElement>(".card, .item") : t;
    const C = doc(box || t);
    let view;
    if (C.bottom - C.top <= room) view = C.top - (room - (C.bottom - C.top)) / 2;
    else {
      view = Math.min(Math.max((T.top + T.bottom) / 2 - room / 2, C.top - room / 4), C.bottom - room * 3 / 4);
      view = T.bottom - T.top <= room ? Math.min(Math.max(view, T.bottom - room), T.top) : T.top;
    }
    const destination=view-top;
    glideTo(destination,t.id ? {id:t.id,top:T.top-destination} : undefined);
  }
  function jump(id: string | HTMLElement) {
    const name=typeof id === "string" ? id : id.id, e=typeof id === "string" ? get(id) : id;
    const box=e?.closest<HTMLElement>(".card, .item");
    const card=name.startsWith("q-") ? name.slice(2) : box?.id.startsWith("q-") ? box.id.slice(2) : undefined;
    const item=name.startsWith("it-") ? name.slice(3) : name.startsWith("ask-") ? name.slice(4) : card ? snapshot.decisions[card]?.item || null : box?.id.startsWith("it-") ? box.id.slice(3) : null;
    const note=e?.dataset.sel?.startsWith("note:") ? e.dataset.sel.slice(5) : undefined;
    if (item || card || note) { void navigate({id:name,item,card,note,selection:e?.dataset.sel,notes:note ? snapshot.notes[note]?.target : undefined}); return; }
    if (e) { glideToTarget(e); setCurrent(e.closest<HTMLElement>(".card, .item")); }
  }
  function openPath(id: string) {
    let it = index().byId.get(id);
    let outer:string | undefined;
    if (it && !manual[it.id]) { manual[it.id] = true; outer=it.id; }
    if (it) ancestors(it).forEach(p => { if (!isOpen(p)) { manual[p.id] = true; outer=p.id; } });
    saveManual();
    if (outer) renderNow(get("it-"+outer) ? "tree:"+outer : "group:"+derived.groupOf(outer));
  }
  function reveal(id: string) { jump("it-" + id); }
  // Following a dependency remembers where the reader was; Backspace, [ or the 返回 button goes back.
  const backStack: Array<{key:string|null;y:number}> = [];
  function follow(id: string) {
    const from = targetOnScreen();
    backStack.push({ key: from, y: scrollY });
    if (backStack.length > 50) backStack.shift();
    reveal(id);
    renderBack();
  }
  function goBack() {
    const b = backStack.pop();
    renderBack();
    if (!b) return;
    const box = b.key && boxOfKey(b.key);
    if (box) jump(box); else glideTo(b.y);
  }
  function renderBack() {
    let btn = get<HTMLButtonElement>("backbtn");
    if (!btn) {
      btn = el("button", "backbtn", "← 返回");
      btn.id = "backbtn"; btn.type = "button"; btn.title = "回到跳转前的位置（Backspace 或 [）";
      btn.addEventListener("click", goBack);
      document.body.appendChild(btn);
    }
    btn.hidden = !backStack.length;
  }
  // One row per item in a dependency list: status, effective priority, where it lives (the project when it is
  // another one), and its title; a click follows it.
  function depRow(d: ViewItem, from: ViewItem, extra?: string) {
    const st = statusOf(d), pr = effPriorityOf(d);
    // A dependency in another project names that project; within the project no label is needed.
    const where = groupOf(d) !== groupOf(from) ? groupOf(d) || "其他" : "";
    const b = el("button", "deprow" + (groupOf(d) !== groupOf(from) ? " cross" : ""),
      '<span class="st ' + st + '">' + esc(STATUS[st] || st) + "</span>"
      + '<span class="prio ' + (pr ? pr.toLowerCase() : "none") + '">' + (pr || "P?") + "</span>"
      + (where ? '<span class="where">' + inline(where) + "</span>" : "")
      + '<span class="t">' + inline(d.title) + "</span>" + (extra ? '<span class="where">' + extra + "</span>" : ""));
    b.type = "button";
    b.addEventListener("click", ev => { ev.stopPropagation(); follow(d.id); });
    return b;
  }
  // A row of the 被依赖 or 依赖 list: the item and, under its title, why the depending item needs it.
  function whyRow(d: ViewItem, from: ViewItem, why: string) {
    const b = depRow(d, from);
    b.querySelector(".t")!.appendChild(el("span", "why" + (why ? "" : " none"), why ? inline(why) : "（没写为什么）"));
    return b;
  }
  // A row for a dependency that is not a live item: a decision card shows its state where an item shows its status,
  // its question as the title and, under it, why the depending item needs it, like an item row.
  function depFallbackRow(kind: string, id: string, why: string) {
    const d = kind === "card" ? snapshot.decisions[id] : undefined;
    const tag = !d ? '<span class="st cancelled">已删除</span>'
      : derived.cardWaiting(id) ? '<span class="asktag">等你决定</span>'
      : d.status === "open" ? '<span class="st todo">未定</span>'
      : '<span class="st done">' + (d.ruling ? "已裁定" : "已结束") + "</span>";
    const b = el("button", "deprow", tag + '<span class="t">' + inline(d?.question || id)
      + '<span class="why' + (why ? "" : " none") + '">' + (why ? inline(why) : "（没写为什么）") + "</span></span>");
    b.type = "button";
    if (d) b.addEventListener("click", ev => { ev.stopPropagation(); followCard(id); });
    return b;
  }
  function followCard(id: string) { if (snapshot.decisions[id]) jump("q-"+id); }
  function depLink(d: ViewItem | {kind: "item" | "card"; id: string}) {
    const card = "kind" in d && d.kind === "card";
    const title = card ? snapshot.decisions[d.id]?.question : snapshot.items[d.id]?.title;
    const b = el("button", "ref", inline(title || d.id)); b.type = "button";
    b.addEventListener("click", ev => { ev.stopPropagation(); if (card) followCard(d.id); else follow(d.id); }); return b;
  }

  // One line per project group: how much open work there waits on other projects, and how much waits on it.
  function crossSummary(g: string) {
    const out = new Map<string,number>(), inn = new Map<string,number>();
    state.items.forEach(w => {
      if (ended(w) || inArchive(w)) return;
      openDeps(w).forEach(d => {
        const gw = groupOf(w), gd = groupOf(d);
        if (gw === gd) return;
        if (gw === g) out.set(gd, (out.get(gd) || 0) + 1);
        if (gd === g) inn.set(gw, (inn.get(gw) || 0) + 1);
      });
    });
    const name = (x: string) => plain(x) || "其他";
    return [...out].map(([k, n]) => "等 " + name(k) + " " + n).concat([...inn].map(([k, n]) => "被 " + name(k) + " 等 " + n)).join(" · ");
  }
  // Comments are kept in the board's own store; the owner writes them inline and sends the batch at once.
  const EXPLAIN = "请详细解释这一项。";
  function titleOf(key: string) {
    if (key.startsWith("it:")) { const it = index().byId.get(key.slice(3)); return it ? it.title : ""; }
    const d = index().decById.get(key.slice(2)); return d ? d.question || "决策" : "决策";
  }
  function pendingDraft(key:string,kind:DraftKind) {
    const overlay = optimistic.get(draftKey(key,kind));
    return overlay ? overlay.on ? overlay : undefined : notesOf(key).find(n => n.kind === kind && n.state === "draft");
  }
  function pendingExplain(key: string) { return pendingDraft(key,"explain"); }
  // An explain request toggles: the first press queues it, a second press withdraws the unsent request.
  async function toggleExplain(key: string) {
    await setDraft(key,"explain",!pendingExplain(key),EXPLAIN);
  }
  // A comment on a log entry or a reply keeps its target, the item or card, and names the piece in anchor.
  let editingAnchor: Note["anchor"] | null = null;
  function openComment(key: string, anchor?: Note["anchor"] | null) {
    if (key.startsWith("it:")) openPath(key.slice(3));
    editing = key; editingAnchor = anchor || null;
    renderNow("notes:"+key);
    const ta = get<HTMLTextAreaElement>("ed-" + key.replace(/[^A-Za-z0-9_-]/g, "_"));
    if (ta) { ta.focus(); ta.scrollIntoView({ block: "center" }); }
  }
  // A queued explain request shows on the item or card it asks about until it is sent.
  function pendingChip(key: string) { return pendingExplain(key) ? el("span", "pendtag", "待发：详细解释") : null; }
  function elements(root:HTMLElement): HTMLElement[] { return [root,...[...root.children].flatMap(e => elements(e as HTMLElement))]; }
  function patchDraft(target:string,kind:DraftKind) {
    const box = target.startsWith("q:") ? get("q-"+target.slice(2)) : get("it-"+target.slice(3));
    if (!box) return;
    const busy = optimistic.has(draftKey(target,kind));
    if (kind === "choice") {
      const d=index().decById.get(target.slice(2)); if (!d) return;
      const chosen=choiceOf(d), choice=chosen?.choice || d.choice;
      elements(box).filter(e => e.dataset.option).forEach(e => {
        const selected=choice === e.dataset.option;
        e.classList.remove("sel"); if (selected) e.classList.add("sel");
        e.setAttribute("aria-pressed",String(selected));
        (e as HTMLButtonElement).disabled=busy || !connected || d.status !== "open" || e.dataset.removed === "true" || !!(chosen && chosen.state !== "draft");
      });
    } else if (kind === "explain") {
      const head=box.children[0]?.children[0] as HTMLElement | undefined; if (!head) return;
      const old=[...head.children].find(e => e.classList.contains("pendtag"));
      if (pendingExplain(target)) { if (!old) head.appendChild(pendingChip(target)!); } else old?.remove();
    } else {
      const pending=pendingDraft(target,kind), sent=notesOf(target).some(n => n.kind === kind && n.state === "sent");
      elements(box).filter(e => e.dataset.answer === kind).forEach(e => {
        e.classList.remove("on"); if (pending || sent) e.classList.add("on");
        e.textContent=sent ? ANSWER[kind]!.sent : pending ? ANSWER[kind]!.queued : ANSWER[kind]!.label;
        (e as HTMLButtonElement).disabled=busy || sent || !connected;
      });
    }
  }
  function setDraft(target:string,kind:DraftKind,on:boolean,text:string,choice?:string):Promise<boolean> {
    const key=draftKey(target,kind), existing=optimistic.get(key);
    if (existing) return existing.promise!;
    if (!connected) { showError(new Error(DISCONNECTED)); return Promise.resolve(false); }
    const overlay:DraftOverlay={on,choice,state:"draft"};
    const started=eventGeneration;
    optimistic.set(key,overlay); patchDraft(target,kind);
    sendMessage="";
    let changed=false;
    const operation=(async () => {
      try {
        const result=await api<{note:{id:string;doc:Note}|null;deleted:string[];commit:string}>("/api/draft",{target,kind,on,text,...choice ? {choice} : {}});
        snapshot={...snapshot,notes:{...snapshot.notes}};
        for (const id of result.deleted) {
          noteTombstones.set(id,Infinity);
          const currentNote=snapshot.notes[id];
          if (currentNote) { delete snapshot.notes[id]; changed=true; }
        }
        if (result.note) {
          const {id,doc}=result.note, currentNote=snapshot.notes[id];
          if ((currentNote ? currentNote.rev <= doc.rev : (noteEvents.get(id) ?? 0) <= started) && !sameValue(currentNote,doc)) { snapshot.notes[id]=doc; changed=true; }
        }
        if (changed) { snapshotGeneration++; rulePresentationDirty=true; applySnapshot(snapshot); }
        return true;
      } catch (e) { showError(e); return false; }
      finally {
        if (optimistic.get(key) === overlay) { optimistic.delete(key); invalidate(); patchDraft(target,kind); if (changed) scheduleRender("notes:"+target); else renderSend(); }
      }
    })();
    overlay.promise=operation;
    renderSend();
    return operation;
  }
  // The owner's answer to an item's request: "approve" for a request the agent carries out, "done" for one the owner carried out (a merge).
  const ANSWER: Record<string, {label:string;queued:string;sent:string;prefix:string}> = { approve: { label: "同意", queued: "已同意，待发", sent: "已发送同意", prefix: "同意：" }, done: { label: "完成", queued: "已标完成，待发", sent: "已发送完成", prefix: "已完成：" } };
  function answerButton(kind: "approve" | "done", key: string, title: string, ask: string) {
    const k = ANSWER[kind]!;
    const pending = pendingDraft(key,kind);
    const sent = notesOf(key).find(n => n.kind === kind && n.state === "sent");
    const b = el("button", "okbtn" + (pending || sent ? " on" : ""), sent ? k.sent : pending ? k.queued : k.label);
    b.type = "button";
    b.disabled = !!sent || optimistic.has(draftKey(key,kind));
    b.dataset.answer = kind;
    b.title = pending ? "再点一次撤回" : "随下一次“发给 Claude”一起发出";
    b.addEventListener("click", async ev => {
      ev.stopPropagation();
      await setDraft(key,kind,!pendingDraft(key,kind),k.prefix + ask);
    });
    return b;
  }
  // Archiving an item hides it and its sub-items until new progress brings it back; doing it again restores it.
  async function toggleArchive(it: ViewItem) {
    try { await api("/api/archive", { id: it.id, on: !isArchived(it) }); void refreshOwner().catch(showError); return true; } catch (e) { showError(e); return false; }
  }

  // Approvals and choices show on their buttons; the comment list holds comments, explain requests, and any approval or choice a session replied to.
  function listed(n: ViewNote) { return (!ANSWER[n.kind] && n.kind !== "choice") || !!n.reply; }
  function anchorLabel(a: NonNullable<Note["anchor"]>) {
    if (a.kind === "log") return "进展 " + day(a.at);
    const n = state.notes.find(x => x.id === a.id);
    return n ? "回复（" + day(n.repliedAt || n.at) + "）" : "一条回复";
  }
  const NOTE_STATE: Record<Note["state"], string> = { draft: "未发送", sent: "已发送，等处理", done: "已处理" };
  function noteThread(n: Note, fresh = false, replyFresh = false) {
    const box = el("div", "note" + (n.state === "draft" ? " draft" : "") + (fresh ? " newbar" : ""));
    box.appendChild(el("div", "who", esc(day(n.at)) + " · " + NOTE_STATE[n.state]));
    if (n.anchor) box.appendChild(el("div", "anchor", "关于" + esc(anchorLabel(n.anchor))));
    box.appendChild(el("div", "txt", n.kind === "explain" ? "请求：详细解释" : n.kind === "approve" ? "同意" : n.kind === "choice" ? "选择：" + esc(n.choice || "") : blocks(n.text)));
    if (n.reply) box.appendChild(el("div", "reply rich" + (replyFresh ? " newbar" : ""), '<div class="sub">Claude</div>' + blocks(n.reply)));
    return box;
  }
  function noteBlock(key: string, title: string) {
    const mine = notesOf(key).filter(listed).sort((x, y) => String(x.at).localeCompare(String(y.at)));
    if (!mine.length && editing !== key) return null;
    const wrap = el("div", "notes");
    // New comments and reply content open the list until the owner folds or opens it by hand.
    const freshReplies = newReplies(key), freshNotes = newNotes(key);
    const shown = Object.prototype.hasOwnProperty.call(notesOpen, key) ? !!notesOpen[key] : freshReplies.length + freshNotes.length > 0;
    if (mine.length) {
      const replied = mine.filter(n => n.reply).length;
      const pend = mine.filter(n => n.state === "draft").length;
      const t = el("button", "notes-toggle" + (!shown && (fon("reply") && freshReplies.length || fon("other") && freshNotes.length) ? " newbar" : ""), (shown ? "▾ " : "▸ ") + "评论 " + mine.length + " 条" + (replied ? "，" + replied + " 条有回复" : "") + (pend ? '<span class="pend">' + pend + " 条未发送</span>" : ""));
      t.type = "button";
      t.setAttribute("aria-expanded", String(shown));
      t.addEventListener("click", () => { notesOpen[key] = !shown; try { localStorage.setItem("board-notes", JSON.stringify(notesOpen)); } catch (e) {} renderNow("notes:"+key); });
      wrap.appendChild(t);
    }
    (shown ? mine : []).forEach(n => {
      const replyFresh = fon("reply") && freshReplies.includes(n);
      const box = noteThread(n, replyFresh || fon("other") && freshNotes.includes(n), replyFresh);
      box.id = noteId(n);
      box.dataset.sel = "note:" + n.id;
      if (current === "note:" + n.id) box.classList.add("cur");
      const who = box.firstElementChild!;
      if (n.state === "draft") {
        const del = el("button", "linkbtn", "删除"); del.type = "button";
        del.addEventListener("click", async () => { del.disabled = true; try { await deleteNote(n.id); } catch(e) { showError(e); } finally { del.disabled = false; } });
        who.appendChild(del);
      }
      wrap.appendChild(box);
    });
    if (editing === key) {
      const ed = el("div", "editor");
      const ta = document.createElement("textarea");
      ta.id = "ed-" + key.replace(/[^A-Za-z0-9_-]/g, "_");
      ta.maxLength = 4000;
      ta.placeholder = "写给 Claude 的意见或问题（关于：" + title + (editingAnchor ? "，" + anchorLabel(editingAnchor) : "") + "）。回车保存，Shift+回车换行，Esc 取消";
      ta.value = drafts[key] || "";
      ta.addEventListener("input", () => { drafts[key] = ta.value; });
      // Enter saves, Shift+Enter starts a new line, Esc cancels and keeps the draft; inside an IME composition both only act on the composition.
      ta.addEventListener("keydown", ev => {
        if (ev.isComposing || ev.keyCode === 229) return;
        if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); save.click(); }
        else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancel.click(); }
      });
      ed.appendChild(ta);
      const row = el("div", "row");
      const save = el("button", "save", "保存"); save.type = "button";
      const cancel = el("button", "cancel", "取消"); cancel.type = "button";
      save.addEventListener("click", async () => {
        const text = (ta.value || "").trim();
        if (!text) { ta.focus(); return; }
        save.disabled = true;
        try {
          await createNote(Object.assign({ target: key, text: text, kind: "comment" as const }, editingAnchor ? { anchor: editingAnchor } : {}));
          drafts[key] = ""; editing = null; editingAnchor = null; renderNow("notes:"+key);
        } catch (e) { save.disabled = false; save.textContent = "保存"; }
      });
      cancel.addEventListener("click", () => { editing = null; editingAnchor = null; renderNow("notes:"+key); });
      row.appendChild(save); row.appendChild(cancel);
      ed.appendChild(row);
      wrap.appendChild(ed);
    }
    return wrap;
  }

  function renderSend() {
    const box = get("sendbox");
    const btn = get<HTMLButtonElement>("send-all");
    const note = get("send-note");
    if (!connected) { box.hidden = true; return; }
    box.hidden = false;
    const pending = [...state.notes.filter(x => x.state === "draft" && !optimistic.has(draftKey(x.target,x.kind as DraftKind))), ...[...optimistic].filter(([,o]) => o.on).map(([key]) => ({kind:key.slice(key.lastIndexOf("|")+1)}))];
    const n = pending.length;
    const waiting = state.notes.filter(x => x.state === "sent").length;
    btn.textContent = n ? "把 " + n + " 条发给 Claude" : "发给 Claude";
    btn.disabled = sending || !n;
    const ex = pending.filter(x => x.kind === "explain").length;
    const ok = pending.filter(x => x.kind === "approve").length;
    const ch = pending.filter(x => x.kind === "choice").length;
    const dn = pending.filter(x => x.kind === "done").length;
    if (!sending) note.textContent = sendMessage || (n ? "待发：" + (n - ex - ok - ch - dn) + " 条评论、" + ex + " 个解释请求、" + ok + " 个同意、" + ch + " 个选择、" + dn + " 个完成，看完一起发。" : waiting ? waiting + " 条已发送，等 Claude 处理。" : "条目右边：「详细解释」一点就加入待发，「评论」写意见；看完在这里一起发。");
  }

  function renderHeader() {
    const m: Partial<Board> = state.meta || {};
    if (state.meta) get("goal").innerHTML = inline(m.goal || "");
    if (m.title) { get("goal-title").textContent = m.title; document.title = m.title; }
    get("eyebrow").textContent = m.eyebrow || "";
    const meta = get("meta");
    meta.innerHTML = "";

    const sum = get("summary");
    sum.innerHTML = "";
    // The controls sit in rows by kind: what waits for the owner and what is new, how the tree is folded, the
    // dependency filters; each row is labelled, and the dependency row shows only when a filter has matches.
    const acts = el("div", "sum-row"), view = el("div", "sum-row"), stats = el("div", "sum-stats");
    const sbtn = (cls: string, text: string, title: string, onClick: () => void) => { const b = el("button", "sbtn " + cls, text); b.type = "button"; if (title) b.title = title; b.addEventListener("click", onClick); return b; };
    const waiting = stops().length;
    if (waiting) acts.appendChild(sbtn("s-wait", "等你处理 " + waiting + " ›", "从第一条开始", () => goStop(0)));
    // Counts are pieces, as the page always counted (each new log entry, each new reply, each other change); n walks
    // one document at a time and shows all of its pieces.
    const fresh = countOf(freshStops());
    if (fresh) acts.appendChild(sbtn("s-new", "新 " + fresh + " ›", "新内容和新回复，从第一条开始（n）", () => goFresh(0)));
    // Which kinds of new things count, picked like the project filters; each shows how many new pieces it has.
    const everyFresh = allFreshStops();
    FRESH_KINDS.forEach(([kind, label, title]) => {
      const n = everyFresh.reduce((sum, st) => sum + piecesOf(st.doc)[kind as "log" | "reply" | "other"], 0), on = freshSel.includes(kind);
      if (n || on) { const b = sbtn("s-plain" + (on ? " s-on" : ""), label + " " + n, title + "（可多选）", () => toggleFresh(kind)); acts.appendChild(b); }
    });
    if (freshSel.length) acts.appendChild(sbtn("s-plain", "清除筛选", "", () => setFreshSel([])));
    if (steps.length && connected) {
      // 全部已阅 asks once before it marks everything read, so a stray click costs nothing.
      const all = sbtn("s-read", "全部已阅", "把全部未读变化都标为已阅（包括筛选隐藏的变化）", () => {
        const ask = el("span", "readconfirm", "把全部 " + steps.length + " 步变化都标为已阅（包括筛选隐藏的变化）？");
        const yes = sbtn("s-read", "确认", "", async () => {
          yes.disabled = true;
          try {
            await readThrough(steps.at(-1)!.id);
          } finally { yes.disabled = false; }
        });
        const no = sbtn("s-plain", "取消", "", () => ask.replaceWith(all));
        ask.appendChild(yes); ask.appendChild(no);
        all.replaceWith(ask);
        no.focus();
      });
      acts.appendChild(all);
    }
    view.appendChild(el("span", "sum-k", "视图"));
    const fold = sbtn("s-plain", "全部折叠", "折叠所有条目和评论", () => {
      // Folding everything also folds every comment list, including ones that new replies had opened.
      manual = {}; logOpen = {}; saveManual();
      notesOpen = {};
      state.notes.forEach(n => { if (n.target) notesOpen[n.target] = false; });
      try { localStorage.setItem("board-notes", JSON.stringify(notesOpen)); } catch (e) {}
      ruledOpen = {}; state.decisions.forEach(d => { if (d.status !== "open") ruledOpen[d.id] = false; }); saveRuled();
      renderNow("areas","cards");
    });
    view.appendChild(fold);
    // Opens every top-level item so the items under it show, each one folded: the first level and nothing deeper.
    view.appendChild(sbtn("s-plain", "展开第一层", "展开每条工作线，只显示它下面第一层条目", () => {
      state.items.forEach(i => { delete manual[i.id]; });
      tops().forEach(t => { manual[t.id] = true; });
      saveManual(); renderNow("areas");
    }));
    acts.insertBefore(el("span", "sum-k", "待看"), acts.firstChild);

    const n: Record<string,number> = { wip: 0, blocked: 0, todo: 0, done: 0, cancelled: 0 };
    state.items.forEach(i => { const st = statusOf(i); if (n[st] != null) n[st]++; });
    ([["wip", "进行中", "--bar-wip"], ["blocked", "卡住", "--bar-block"], ["todo", "未开始", "--bar-todo"], ["done", "完成", "--bar-done"], ["cancelled", "取消", "--bar-cancel"]] as Array<[string,string,string]>)
      .filter(([k]) => (k !== "cancelled" && k !== "blocked") || n[k])
      .forEach(([k, label, bar]) => stats.appendChild(el("span", null, '<span class="dot" style="background:var(' + bar + ')"></span>' + label + " " + n[k])));
    sum.appendChild(acts);
    sum.appendChild(view);
    sum.appendChild(stats);
  }

  // The progress log: newest at the bottom; new entries and the two before them show, earlier ones fold.
  let logOpen: Record<string, boolean> = {};
  // Per open item, the first log entry shown, and whether a read the owner just made holds it there; both clear when the item folds.
  const logShown: Record<string, number> = {}, logHold: Record<string,boolean> = {};
  function logEntry(e: LogEntry, fresh = false) {
    const row = el("div", "log-entry" + (fresh ? " fresh" : ""));
    row.appendChild(el("div", "log-meta", esc(day(e.at)) + (e.by ? " · " + esc(e.by) : "")));
    row.appendChild(el("div", "rich", blocks(e.text)));
    return row;
  }
  function logSection(it: ViewItem) {
    const all = logOf(it);
    if (!all.length) return null;
    const unread = unreadLogs(it);
    const firstNew = all.findIndex(e => unread.includes(e));
    // Marking the item read does not fold the entries that were new while it stays open; they fold the next time it opens.
    const fold = Math.max(0, Math.min(firstNew < 0 ? all.length : firstNew, all.length) - 2);
    const start = logOpen[it.id] ? 0 : logHold[it.id] && logShown[it.id] != null ? Math.min(fold, logShown[it.id]!) : fold;
    logShown[it.id] = start;
    const box = el("div", "log");
    box.appendChild(el("div", "log-head", "进展"));
    if (start > 0) {
      const more = el("button", "notes-toggle", "▸ 更早的 " + start + " 条");
      more.type = "button";
      more.addEventListener("click", () => { logOpen[it.id] = true; renderNow("areas"); });
      box.appendChild(more);
    }
    all.slice(start).forEach((e, j) => {
      const i = start + j;
      const isNew = fon("log") && unread.includes(e);
      const row = logEntry(e, isNew);
      row.id = "log-" + it.id + "-" + i;
      row.dataset.sel = "log:" + it.id + "@" + e.at;
      if (current === row.dataset.sel) row.classList.add("cur");
      box.appendChild(row);
    });
    return box;
  }

  function refsRow(it:ViewItem,before?:Item | null) {
      const refs = el("div", "refs");
      let has = false;
      if (derived.cardsOf(it.id).length) {
        has = true;
        refs.appendChild(el("span", "k", "决策"));
        derived.cardsOf(it.id).forEach(q => {
          const d = index().decById.get(q);
          const label = d ? (d.question || "决策") : "决策";
          const talk = d ? notesOf("q:" + q).filter(listed).length : 0;
          const b = el("button", "ref q" + (openQ(q) ? " open" : "") + (d && d.status !== "open" && ruledShown(d) ? " shown" : ""), esc(label.length > 24 ? label.slice(0, 24) + "…" : label) + (d && d.status !== "open" && d.ruling ? " · " + esc(d.ruling.length > 18 ? d.ruling.slice(0, 18) + "…" : d.ruling) : "") + (talk ? " · 评论 " + talk : ""));
          b.type = "button";
          b.title = d ? (d.status === "open" ? "待你决定" : "点开查看这张已结束的决策卡和它的评论") : "";
          b.addEventListener("click", () => {
            if (!d) return;
            if (d.status !== "open") { const show = !ruledShown(d); ruledOpen[q] = show; saveRuled(); if (show) jump("q-"+q); else renderNow("card:"+q); return; }
            jump("q-" + q);
          });
          refs.appendChild(b);
        });
      }
      orderedChanges(before?.links || it.links,it.links).forEach(({value:l,mark}) => {
        has = true;
        const a = el("a", mark + (mark === "chg-add" || before === null ? " fresh" : ""), esc(l.label));
        if (/^https:\/\//.test(l.url || "")) { a.href = l.url; a.target = "_blank"; a.rel = "noopener"; }
        refs.appendChild(a);
      });
      return has ? refs : null;
  }
  function askRow(it:ViewItem,before?:Item | null) {
    if (askPending(it)) {
        const a = el("div", "ask" + (before && !sameValue(before.ask,it.ask) ? " chg-add" : ""));
        a.id = "ask-" + it.id;
        a.style.scrollMarginTop = "24px";
        a.appendChild(el("span", null, '<span class="asktag">等你处理</span> ' + inline(it.ask?.text)));
        if (/^https:\/\//.test(it.ask?.url || "")) { const go = el("a", "okbtn golink", "去处理 ↗"); go.href = it.ask!.url!; go.target = "_blank"; go.rel = "noopener"; a.appendChild(go); if (connected) a.appendChild(answerButton("done", "it:" + it.id, it.title, it.ask!.text)); }
        else if (it.ask?.chat) a.appendChild(el("span", "chatnote", "请在对话窗口里确认"));
        else if (connected) a.appendChild(answerButton("approve", "it:" + it.id, it.title, it.ask!.text));
        a.appendChild(nextButton("ask-" + it.id));
        return a;
      }
    return null;
  }
  function itemNode(it: ViewItem, inArchive = false, headerOnly = false, boxOnly = false) {
    const retained=groupReuse?.items.get(it.id);
    if (retained && !groupReuse!.dirtyItems.has(it.id) && !headerOnly && !boxOnly) return retained;
    const li = el("li");
    // A filter opens the path to its matches, their sub-item lists only; an item's body opens only when the owner opens it.
    const open = isOpen(it), bodyOpen = !!manual[it.id];
    if (!bodyOpen) { delete logShown[it.id]; delete logHold[it.id]; }
    const baseline = unreadBefore<Item>("item",it.id);
    const before = bodyOpen ? baseline : undefined;
    const st = statusOf(it);
    const box = el("div", "item " + st + (up(it) ? "" : " line") + (baseline === null ? " fresh" : "") + (filtering(groupOf(it)) && !filterMatches().hit.has(it.id) ? " ctx" : ""));
    box.id = "it-" + it.id;
    if (current === "it:" + it.id) box.classList.add("cur");
    box.dataset.title = plain(it.title);
    // Archived sub-items stay where they are: hidden, unless the 已归档 filter shows them.
    const sub = kids(it.id, inArchive || showsArchived(groupOf(it))).filter(k => inArchive || passes(k));
    const ck = checksOf(it), raised = raisedBy(it);
    const hasBody = !!(before?.head || before?.deps.length || before?.links.length || before?.ask || headOf(it) || logOf(it).length || it.data || it.ask || derived.cardsOf(it.id).length || depIds(it).length || (waitedBy().get(it.id) || []).length || ck.length || raised || (it.links || []).length || sub.length);
    const head = el("button", "item-head");
    head.type = "button";
    head.setAttribute("aria-expanded", String(open));
    head.appendChild(el("span", "caret", hasBody ? (open ? "▾" : "▸") : ""));

    head.appendChild(el("span", "st " + st + (before && it.status !== undefined && before.status !== it.status ? " chg-add" : ""), esc(STATUS[st] || st)));
    // The badge shows the effective priority; a raised one also shows the written one, struck through.
    const pr = effPriorityOf(it), wrote = priorityOf(it);
    const pb = el("span", "prio " + (pr ? pr.toLowerCase() : "none") + (before && it.priority !== undefined && before.priority !== it.priority ? " chg-add" : ""), pr || "P?");
    if (raised) pb.title = "写的是 " + (wrote || "未设") + "；因为「" + plain(raised.title) + "」(" + effPriorityOf(raised) + ") 在等它";
    head.appendChild(pb);
    if (raised) head.appendChild(el("span", "prio-was", esc(wrote || "P?")));
    appendTitle(head,it.title,before === null ? null : before?.title,"item-title");
    if (ck.length) head.appendChild(el("span", "checktag", "需核对")).title = ck.map(c => c.text).join("\n");
    if (needsOwner(it)) head.appendChild(el("span", "asktag", "等你处理"));
    if (freshShown(it)) head.appendChild(freshChip("it:" + it.id));
    const pc = pendingChip("it:" + it.id);
    if (pc) head.appendChild(pc);
    // A parent also counts what waits or is new below it, so a folded section shows where to look.
    if (sub.length) {
      const waitingBelow = below.wait[it.id] || 0;
      const freshBelow = below.fresh[it.id] || 0;
      if (waitingBelow) head.appendChild(el("span", "asktag", "等 " + waitingBelow)).title = "下面有 " + waitingBelow + " 处等你处理";
      if (freshBelow) head.appendChild(el("span", "newtag", "新 " + freshBelow)).title = "下面有 " + freshBelow + " 条新内容";
    }
    // Opening or closing changes only this item's own subtree, so only that subtree is rebuilt.
    head.addEventListener("click", () => { manual[it.id] = !(open && bodyOpen); saveManual(); renderNow("tree:"+it.id); get("it-"+it.id)?.querySelector<HTMLElement>(".item-head")?.focus({preventScroll:true}); });
    // The row is the head alone: the actions live in the shortcut menu (☰) and its keys.
    const row = el("div", "item-row");
    row.appendChild(head);
    // A parent counts its leaves by status at the right of its row; archived ones are left out.
    if ((index().children.get(it.id) || []).length) {
      const n: Record<string,number> = {};
      leavesOf(it).filter(l => l !== it && !archivedPath(l)).forEach(l => { const k = statusOf(l); n[k] = (n[k] || 0) + 1; });
      const cs = el("span", "counts");
      ["todo", "wip", "blocked", "done", "cancelled"].forEach(k => { if (n[k]) cs.appendChild(el("span", "st " + k, esc(STATUS[k]) + " " + n[k])); });
      if (cs.children.length) row.appendChild(cs);
    }
    box.appendChild(row);
    if (headerOnly) { li.appendChild(box); return li; }
    if (bodyOpen) {
      const body = el("div", "body");
      // The body reads from what depends on the item, through the item itself, to what it depends on, then its log.
      // The parent, which the tree requires to be one of them, leads the 被依赖 list.
      const ws = (waitedBy().get(it.id) || []).slice().sort((a, b) => Number(b === upItem(it)) - Number(a === upItem(it)));
      if (ws.length) {
        const wl = el("div", "deplists");
        wl.appendChild(el("div", "k", "被依赖"));
        ws.forEach(w => wl.appendChild(whyRow(w, it, whyOf(w, it.id))));
        body.appendChild(wl);
      }
      if (headOf(it) || before?.head) body.appendChild(el("div", "rich", markedBlocks(before?.head ?? (before ? "" : undefined),headOf(it))));
      if (it.data) body.appendChild(el("div", "data", inline(it.data)));
      const des = orderedChanges(before?.deps || it.deps,it.deps).map(({value,mark}) => ({kind:"id" in value ? "item" : "card",id:"id" in value ? value.id : value.card,why:value.why,mark}));
      if (des.length) {
        const dl = el("div", "deplists after");
        dl.appendChild(el("div", "k", "依赖"));
        des.forEach(e => {
          const d = e.kind === "item" ? index().byId.get(e.id) : undefined;
          const r = d ? whyRow(d, it, e.why) : depFallbackRow(e.kind, e.id, e.why);
          r.dataset.sel = "dep:" + it.id + "@" + e.id;
          r.id = "sel-" + encodeURIComponent(JSON.stringify([r.dataset.sel,e.mark === "chg-del"]));
          if (e.mark) r.classList.add(e.mark);
          if (e.mark === "chg-add" || before === null) r.classList.add("fresh");
          if (current === r.dataset.sel) r.classList.add("cur");
          dl.appendChild(r);
        });
        body.appendChild(dl);
      }
      const lg = logSection(it);
      if (lg) body.appendChild(lg);
      // The owner's request and the decision cards come after the log, whose last entry usually leads to them.
      const ask = askRow(it,before); if (ask) body.appendChild(ask);
      if (before?.ask && !it.ask) body.appendChild(el("div", "ask chg-del",inline(before.ask.text)));
      cardsUnder(it).forEach(d => body.appendChild(decisionCard(d)));
      ruledUnder(it).filter(ruledShown).forEach(d => body.appendChild(decisionCard(d)));
      if (ck.length || raised) {
        const cb = el("div", "checks");
        if (raised) { const r = el("div", null, "按 " + pr + " 排：写的是 " + esc(wrote || "未设") + "，因为 "); r.appendChild(depLink(raised)); r.appendChild(document.createTextNode("（" + effPriorityOf(raised) + "）在等它")); cb.appendChild(r); }
        ck.forEach(c => { const r = el("div", null, "需核对：" + esc(c.text) + " "); if (c.target) r.appendChild(depLink(c.target)); cb.appendChild(r); });
        body.appendChild(cb);
      }
      const refs=refsRow(it,before); if (refs) body.appendChild(refs);
      box.appendChild(body);
    }
    const nb = noteBlock("it:" + it.id, it.title);
    if (nb) box.appendChild(nb);
    li.appendChild(box);
    if (open && sub.length && !boxOnly) {
      const ul = el("ul", "tree");
      sub.forEach(k => ul.appendChild(itemNode(k, inArchive)));
      li.appendChild(ul);
    }
    if (derived.isRequest(it.id)) {
      const prefix = `${it.request!.by} 提出：`, first = it.log[0]?.text || "";
      li.appendChild(el("div", "request-meta", esc(it.request!.by) + " · " + esc(day(it.request!.at)) + " · " + inline(first.startsWith(prefix) ? first.slice(prefix.length) : first)));
    }
    return li;
  }
  function projectGroups() {
    const groups: Array<{name:string;items:ViewItem[]}> = snapshot.board.projects.map(p => ({name:p.name,items:[]}));
    tops().forEach(t => { const name = t.group || ""; let group = groups.find(g => g.name === name); if (!group) { group = {name,items:[]}; groups.push(group); } group.items.push(t); });
    return groups;
  }
  let groupReuse:{items:Map<string,HTMLElement>;cards:Map<string,HTMLElement>;dirtyItems:Set<string>;dirtyCards:Set<string>} | undefined;
  function renderAreasDOM(only?:Set<string>, scope?:Set<string>) {
    const root = get("areas");
    const nav = get("nav");
    const groups = projectGroups();
    const existing=root.firstElementChild as HTMLElement | null;
    const partial=only && existing && groups.length === existing.children.length && groups.every((g,i) => (existing.children[i] as HTMLElement).dataset.group === g.name);
    if (partial && scope) {
      const dirtyItems=new Set<string>(), dirtyCards=new Set<string>();
      for (const key of scope) {
        const kind=key.slice(0,key.indexOf(":")), id=key.slice(key.indexOf(":")+1);
        const item=kind === "item" || kind === "tree" || kind === "head" ? id : kind === "card" ? snapshot.decisions[id]?.item : kind === "notes" ? id.startsWith("it:") ? id.slice(3) : snapshot.decisions[id.slice(2)]?.item : undefined;
        if (item) { dirtyItems.add(item); derived.ancestors(item).forEach(p => dirtyItems.add(p)); }
        if (kind === "card" || kind === "notes" && id.startsWith("q:")) dirtyCards.add(kind === "card" ? id : id.slice(2));
      }
      groupReuse={dirtyItems,dirtyCards,items:new Map(elements(root).filter(e => e.id.startsWith("it-")).map(e => [e.id.slice(3),e.parentElement!])),cards:new Map(elements(root).filter(e => e.classList.contains("card")).map(e => [e.id.slice(2),e]))};
    }
    if (!partial) { root.innerHTML = ""; nav.innerHTML = ""; }
    countBelow();
    // Top-level items render under their project group; under a dependency filter only those holding a match show.
    if (!groups.length) { root.appendChild(el("p", "empty", "看板还没有内容。")); return; }
    const wrap = partial ? existing : el("div"); wrap.style.display = "flex"; wrap.style.flexDirection = "column"; wrap.style.gap = "34px";
    groups.forEach((g, gi) => {
      if (partial && !only!.has(g.name)) return;
      const box = el("section", "group");
      box.id = "group-" + gi;
      box.dataset.title = plain(g.name || "其他");
      box.dataset.group=g.name;
      const gh = el("h2", "group-head", inline(g.name || "其他"));
      const xs = crossSummary(g.name);
      if (xs) { const x = el("button", "xdeps", esc(xs)); x.type = "button"; x.title = "只看跨项目依赖"; x.addEventListener("click", () => setDepFilter(g.name, "cross")); gh.appendChild(x); }
      box.appendChild(gh);
      if (!partial) { const gl = el("a", "grp", esc(g.name || "其他")); gl.href = "#group-" + gi; nav.appendChild(gl); }
      const requests = derived.inbox(g.name);
      if (requests.length) {
        const inbox = el("section", "inbox"); inbox.appendChild(el("h3", null, "收件箱 " + requests.length));
        const rows = el("ul", "tree lines");
        for (const id of requests) rows.appendChild(itemNode(index().byId.get(id)!));
        inbox.appendChild(rows); box.appendChild(inbox);
      }
      box.appendChild(filterRow(g.name));
      const shown = g.items.filter(passes);
      if (shown.length) { const ul = el("ul", "tree lines"); shown.forEach(t => ul.appendChild(itemNode(t))); box.appendChild(ul); }
      else box.appendChild(el("p", "empty", "没有符合这个筛选的条目。"));
      if (partial) get("group-"+gi).replaceWith(box); else wrap.appendChild(box);
    });
    if (!partial) root.appendChild(wrap);
    groupReuse=undefined;
  }

  function choiceOf(d: ViewDecision) {
    const overlay = optimistic.get(draftKey("q:"+d.id,"choice"));
    return overlay ? overlay.on ? overlay : undefined : notesOf("q:" + d.id).find(n => n.kind === "choice" && (n.state === "draft" || n.state === "sent" || n.state === "done"));
  }
  function decisionCard(d: ViewDecision) {
    const retained=groupReuse?.cards.get(d.id); if (retained && !groupReuse!.dirtyCards.has(d.id)) return retained;
    const before = unreadBefore<Decision>("decision",d.id);
    const c = el("article", "card" + (current === "q:" + d.id ? " cur" : "") + (before === null ? " fresh" : ""));
    c.id = "q-" + d.id;
    const top = el("div", "card-top");
    const h = el("h3");
    const closed = d.status !== "open";
    if (waitsQ(d)) h.appendChild(el("span", "asktag", "等你决定"));
    if (closed) h.appendChild(el("span", "closedtag" + (before && before.status !== d.status ? " chg-add" : ""), d.ruling ? "已裁定" : "已结束"));
    if (proseBlocks(d.question).length > 1 || before && proseBlocks(before.question).length > 1) {
      h.appendChild(el("span", "rich" + (before === null ? " chg-add" : ""),markedBlocks(before?.question,d.question)));
    } else appendTitle(h,d.question || "",before === null ? null : before?.question);
    if (cardFresh(d)) h.appendChild(freshChip("q:" + d.id));
    const pc = pendingChip("q:" + d.id);
    if (pc) h.appendChild(pc);
    top.appendChild(h);
    if (closed) {
      const x = el("button", "cbtn", "收起"); x.type = "button";
      x.addEventListener("click", ev => { ev.stopPropagation(); ruledOpen[d.id] = false; saveRuled(); renderNow(homeOf(d) ? "item:"+d.item : "cards"); });
      top.appendChild(x);
    }
    c.appendChild(top);
    if (closed && (d.ruling || before?.ruling)) c.appendChild(el("div", "rich", '<div class="sub">裁定</div>' + markedBlocks(before?.ruling ?? (before ? "" : undefined),d.ruling || "") + (d.ruledAt ? '<p>' + esc(day(d.ruledAt)) + '</p>' : '')));
    if (d.background || before?.background) c.appendChild(el("div", "rich", '<div class="sub">背景</div>' + markedBlocks(before?.background,d.background || "")));
    const chosen = choiceOf(d);
    if (d.options.length || before?.options.length) {
      c.appendChild(el("p", null, '<span class="lbl">选项：</span>'));
      const ol = el("ul", "opts");
      const oldOptions = new Map(before?.options.map(o => [o.key,o]));
      const opts = orderedChanges(before?.options || d.options,d.options,(a,b) => a.key === b.key);
      opts.forEach(({value:o,mark}) => {
        const li = el("li");
        const sel = (chosen?.choice || d.choice) === o.key;
        const rec = !!o.recommended || /[（(]推荐[)）]/.test(o.text || "");
        const btn = el("button", "optbtn" + (mark === "chg-del" ? " chg-del" : "") + (before && mark !== "chg-del" && oldOptions.get(o.key)?.recommended !== o.recommended ? " chg-add" : "") + (rec ? " rec" : "") + (sel ? " sel" : ""), (rec ? '<span class="recchip">推荐</span>' : "") + '<span class="lbl">' + esc(o.key) + "：</span>" + '<div class="rich">' + markedBlocks(mark === "chg-del" || !before ? undefined : oldOptions.get(o.key)?.text || "",o.text) + '</div>');
        btn.type = "button";
        btn.dataset.option = o.key;
        if (mark === "chg-del") btn.dataset.removed = "true";
        btn.setAttribute("aria-pressed", String(sel));
        btn.disabled = mark === "chg-del" || !connected || closed || !!(chosen && chosen.state !== "draft") || optimistic.has(draftKey("q:"+d.id,"choice"));
        btn.addEventListener("click", async () => {
          const currentChoice = choiceOf(d)?.choice || d.choice;
          await setDraft("q:"+d.id,"choice",currentChoice !== o.key,"选 "+o.key,o.key);
        });
        li.appendChild(btn);
        ol.appendChild(li);
      });
      c.appendChild(ol);
    }
    if (d.confidence) c.appendChild(el("p", null, '<span class="lbl">信心：</span>' + inline((d.confidence.score === undefined ? "" : d.confidence.score + "/5：") + d.confidence.reason)));
    const nb = noteBlock("q:" + d.id, d.question || "决策");
    if (nb) c.appendChild(nb);
    if (waitsQ(d)) {
      const foot = el("div", "card-foot");
      foot.appendChild(nextButton("q-" + d.id));
      c.appendChild(foot);
    }
    return c;
  }

  // Decisions live under their items; this section holds only open decisions that no item lists.
  function renderCardsDOM() {
    const root = get("cards");
    const sec = get("decisions");
    root.innerHTML = "";
    const loose = state.decisions.filter(d => !homeOf(d) && (d.status === "open" || ruledShown(d))).sort(byOrder);
    sec.hidden = !loose.length;
    loose.forEach(d => root.appendChild(decisionCard(d)));
  }

  // The sticky bar names where the reader is: project group, then each item down to the one under the bar.
  function crumbPath(y: number) {
    const wrap = document.querySelector<HTMLElement>(".wrap");
    const r = wrap!.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !hit.closest<HTMLElement>("#areas")) return hit && hit.closest<HTMLElement>("#decisions") ? [{ label: "其他待决事项", target: get("decisions") }] : [];
    const path: Array<{label:string;target:HTMLElement;item?:string}> = [];
    const group = hit.closest<HTMLElement>("section.group");
    if (group) path.push({ label: group.dataset.title || "", target: group });
    const chain: Array<{label:string;target:HTMLElement;item?:string}> = [];
    let li = hit.closest<HTMLElement>("li");
    while (li && li.closest<HTMLElement>("#areas")) {
      const box = li.querySelector<HTMLElement>(":scope > .item");
      if (box) chain.unshift({ label: box.dataset.title || "", target: box, item: box.id.slice(3) });
      li = li.parentElement ? li.parentElement.closest<HTMLElement>("li") : null;
    }
    return path.concat(chain);
  }
  // The bar stacks the path one row per level, like sticky headers: the project, then each item's head line, indented
  // by depth, down to the item under the bar. The bar's height follows the path, so the path is read again below a bar
  // whose height changed.
  let crumbKey: string | null = null;
  function updateCrumbs() {
    const bar = get("crumbs");
    const header = document.querySelector<HTMLElement>("header.top");
    const atTop = header!.getBoundingClientRect().bottom > 0;
    bar.hidden = atTop;
    if (atTop) { crumbKey = "\u0001"; return; }
    for (let round = 0; round < 3; round++) {
      const h = bar.offsetHeight || 34;
      const path = crumbPath(h + 10);
      const tag = (p: {item?:string}) => { const it = p.item && index().byId.get(p.item); return it ? statusOf(it) + "/" + effPriorityOf(it) : ""; };
      const key = path.map(p => p.label + tag(p)).join("\u0000");
      if (key === crumbKey) return;
      crumbKey = key;
      renderCrumbs(bar, path);
      if (bar.offsetHeight === h) return;
    }
  }
  function renderCrumbs(bar: HTMLElement, path: Array<{label: string; target: HTMLElement; item?: string}>) {
    bar.innerHTML = "";
    if (!path.length) {
      const home = el("div", "crumbrow proj", '<span class="t">' + esc(get("goal-title").textContent) + "</span>");
      home.setAttribute("role", "button"); home.tabIndex = 0; home.addEventListener("click", () => glideTo(0)); bar.appendChild(home); return;
    }
    path.forEach((p, i) => {
      const it = p.item && index().byId.get(p.item);
      const row = el("div", "crumbrow" + (it ? "" : " proj") + (i === path.length - 1 ? " cur" : ""));
      row.setAttribute("role", "button"); row.tabIndex = 0;
      row.addEventListener("keydown", ev => { if (ev.key === "Enter") row.click(); });
      row.style.paddingLeft = (it ? 8 + (i - 1) * 18 : 0) + "px";
      if (it) {
        const st = statusOf(it), pr = effPriorityOf(it);
        row.appendChild(el("span", "st " + st, esc(STATUS[st] || st)));
        if (pr) row.appendChild(el("span", "prio " + pr.toLowerCase(), pr));
      }
      row.appendChild(el("span", "t", esc(p.label)));
      if (i === 0) { const top = el("span", "totop", "↑ 顶部"); top.addEventListener("click", ev => { ev.stopPropagation(); glideTo(0); }); row.appendChild(top); }
      // The rows outlive re-renders of the tree, so a click looks its target up again; an item row selects the item.
      const go = () => {
        const t = it ? get("it-" + it.id) : (p.target && p.target.id ? get(p.target.id) : p.target);
        if (!t) return;
        if (it) jump(t); else glideToEl(t, "start");
      };
      row.addEventListener("click", go);
      bar.appendChild(row);
    });
  }
  let crumbQueued = false;
  window.addEventListener("scroll", () => {
    if (landing && (expectedScroll === null || Math.abs(window.scrollY-expectedScroll)>1)) releaseLanding();
    if (crumbQueued) return; crumbQueued = true; frame(() => { crumbQueued = false; updateCrumbs(); });
  }, { passive: true });
  window.addEventListener("resize", () => updateCrumbs(), { passive: true });

  // A snapshot can re-render while the owner is typing; keep the editor's focus and caret.
  // The item or card the reader is looking at, and where it sits, so a data update does not move the page under them.
  function scrollAnchor() {
    const cur = boxOfKey(current);
    if (cur && onScreen(cur)) return { id: cur.id, top: cur.getBoundingClientRect().top };
    const bar = get("crumbs");
    const topEdge = bar && !bar.hidden ? bar.getBoundingClientRect().bottom : 0;
    const e = [...document.querySelectorAll<HTMLElement>("#areas .item, #areas .card, #cards .card")].find(x => x.getBoundingClientRect().bottom > topEdge);
    return e ? { id: e.id, top: e.getBoundingClientRect().top } : null;
  }
  const dirty = new Set<string>();
  let renderQueued = false;
  let waitingOrder:string[]=[];
  const renderWaiters:Array<() => void>=[];
  let rulePresentationDirty=true;
  let presentations=new Map<string,{signature:string;archived:boolean;shown:boolean;request:boolean;group:string}>();
  function frame(fn:FrameRequestCallback) {
    if (typeof requestAnimationFrame !== "function") { setTimeout(() => fn(performance.now()),0); return; }
    let finished=false, raf:number | undefined;
    const run=(now:number) => { if (finished) return; finished=true; clearTimeout(watchdog); if (raf !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf); fn(now); };
    const watchdog=setTimeout(() => run(performance.now()),100);
    raf=requestAnimationFrame(run);
  }
  function scheduleRender(...scope:string[]) {
    invalidate(); scope.forEach(s => dirty.add(s));
    if (renderQueued) return;
    renderQueued = true; frame(() => { renderQueued=false; flushRender(); });
  }
  function flushRender() { if (dirty.size) { const scope=new Set(dirty); dirty.clear(); renderPage(scope); } renderWaiters.splice(0).forEach(resolve => resolve()); }
  function rendered() { return dirty.size ? new Promise<void>(resolve => { renderWaiters.push(resolve); if (!renderQueued) scheduleRender(); }) : Promise.resolve(); }
  function renderNow(...scope:string[]) { invalidate(); scope.forEach(s => dirty.add(s)); flushRender(); }
  function renderAll() { renderNow("all"); }
  function scopedHeads(id:string,scope:Set<string>) { scope.add("head:"+id); derived.ancestors(id).forEach(p => scope.add("head:"+p)); }
  // Compare with the last painted state once per frame, including transitive derived consumers.
  function presentationScopes(scope:Set<string>) {
    if (!rulePresentationDirty) return;
    rulePresentationDirty=false;
    const next=new Map<string,{signature:string;archived:boolean;shown:boolean;request:boolean;group:string}>();
    for (const it of state.items) {
      const id=it.id;
      const label=(kind:string,key:string) => kind === "item" ? [snapshot.items[key]?.title,derived.groupOf(key),derived.statusOf(key),derived.effectivePriorityOf(key)] : [snapshot.decisions[key]?.question,snapshot.decisions[key]?.status];
      const deps=derived.depsOf(id).map(d => [d,...label(d.kind,d.id)]);
      const waiters=derived.dependents(id).map(d => [d,...label("item",d.id)]);
      const signature=JSON.stringify([derived.groupOf(id),derived.statusOf(id),derived.priorityOf(id),derived.effectivePriorityOf(id),derived.raisedBy(id),derived.checks(id),deps,waiters]);
      const current={signature,archived:inArchive(it),shown:passes(it),request:derived.isRequest(id),group:groupOf(it)}, previous=presentations.get(id);
      next.set(id,current);
      if (!previous) continue;
      if (previous.signature !== signature) scope.add("item:"+id);
      if (previous.archived !== current.archived || previous.shown !== current.shown || previous.request !== current.request) { scope.add("group:"+previous.group); scope.add("group:"+current.group); }
    }
    presentations=next;
  }
  function scopeForDoc(kind:string,id:string,target?:string):string[] {
    return kind === "item" ? ["item:"+id] : kind === "decision" ? ["card:"+id] : target ? ["notes:"+target] : [];
  }
  function replaceNotes(target:string) {
    if (target.startsWith("q:")) {
      reconcileCard(target.slice(2)); return;
    }
    const it=index().byId.get(target.slice(3)), box=get("it-"+target.slice(3)); if (!it || !box) return;
    const old=[...box.children].find(e => e.classList.contains("notes")), next=noteBlock(target,it.title);
    if (old && next) old.replaceWith(next); else if (old) old.remove(); else if (next) box.appendChild(next);
    const ask=get("ask-"+it.id), nextAsk=askRow(it,unreadBefore<Item>("item",it.id));
    const body=[...box.children].find(e => e.classList.contains("body"));
    if (ask && nextAsk) ask.replaceWith(nextAsk); else if (ask) ask.remove(); else if (body && nextAsk) body.insertBefore(nextAsk,[...body.children].find(e => e.classList.contains("card")) || null);
  }
  function reconcileCard(id:string) {
    const d=index().decById.get(id), old=get("q-"+id);
    const home=d ? homeOf(d) : null, item=home ? get("it-"+home) : null;
    const container=d && (home ? manual[home] && item?.querySelector<HTMLElement>(":scope > .body") : get("cards"));
    if (!d || !container || d.status !== "open" && !ruledShown(d)) { old?.remove(); }
    else {
      const last=[...container.children].reverse().find(e => e.classList.contains("card"));
      const after=last ? [...container.children][[...container.children].indexOf(last)+1] || null : [...container.children].find(e => e.classList.contains("checks") || e.classList.contains("refs")) || null;
      const next=decisionCard(d);
      if (old && old.parentElement === container) old.replaceWith(next); else { old?.remove(); container.insertBefore(next,after); }
      const ids=home ? [...cardsUnder(index().byId.get(home)!),...ruledUnder(index().byId.get(home)!).filter(ruledShown)].map(d => d.id) : state.decisions.filter(d => !homeOf(d) && (d.status === "open" || ruledShown(d))).sort(byOrder).map(d => d.id);
      const cards=ids.map(id => get("q-"+id)).filter((e):e is HTMLElement => !!e && e.parentElement === container);
      cards.forEach(card => container.insertBefore(card,after));
    }
    get("decisions").hidden=!get("cards").children.length;
  }
  function patchRefs(id:string) {
    const it=index().byId.get(id), box=get("it-"+id); if (!it || !box) return;
    const body=[...box.children].find(e => e.classList.contains("body")); if (!body) return;
    const old=[...body.children].find(e => e.classList.contains("refs")), next=refsRow(it,unreadBefore<Item>("item",id));
    if (old && next) old.replaceWith(next); else if (old) old.remove(); else if (next) body.appendChild(next);
  }
  function renderPage(scope:Set<string>) {
    presentationScopes(scope);
    // Live updates rebuild the page; a text field being typed in keeps its focus and caret.
    const a = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
    const keep = a && a.id && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") ? { id: a.id, start: a.selectionStart, end: a.selectionEnd } : null;
    const anchor = landing ? landing.gliding ? null : {...landing} : window.scrollY > 0 ? scrollAnchor() : null;
    countBelow();
    if (scope.has("all") || scope.has("areas")) renderAreasDOM();
    else { const groups=new Set([...scope].filter(k => k.startsWith("group:")).map(k => k.slice(6))); if (groups.size) renderAreasDOM(groups,scope); }
    if (scope.has("all") || scope.has("cards")) renderCardsDOM();
    if (!scope.has("all")) {
      const heads=new Set<string>(), drawnCards=new Set<string>(), drawnItems=new Set<string>(), refs=new Set<string>();
      // Areas/groups paint hosted content; the cards scope paints only loose cards.
      const paintedHome=(home:string | null) => home ? scope.has("areas") || scope.has("group:"+derived.groupOf(home)) : scope.has("cards");
      for (const key of scope) {
        const kind=key.slice(0,key.indexOf(":")), id=key.slice(key.indexOf(":")+1);
        if (kind === "item" || kind === "tree") {
          const it=index().byId.get(id), old=get("it-"+id); if (it && old && !scope.has("areas") && !scope.has("group:"+groupOf(it))) {
            const next=itemNode(it,inArchive(it),false,kind !== "tree");
            // A body update reuses cards whose own documents/notes did not change.
            for (const card of elements(old).filter(e => e.classList.contains("card"))) {
              const id=card.id.slice(2), replacement=elements(next).find(e => e.id === card.id);
              if (!replacement) continue;
              if (!scope.has("card:"+id) && !scope.has("notes:q:"+id)) replacement.replaceWith(card);
              else drawnCards.add(id);
            }
            if (kind === "tree") old.parentElement!.replaceWith(next); else old.replaceWith(next.children[0]!);
            drawnItems.add(id);
          }
          if (it) derived.ancestors(id).forEach(p => heads.add(p));
        } else if (kind === "card") {
          const d=index().decById.get(id); if (d && !paintedHome(homeOf(d)) && !drawnCards.has(id)) { reconcileCard(id); drawnCards.add(id); }
          if (d) { heads.add(d.item); derived.ancestors(d.item).forEach(p => heads.add(p)); }
          if (d) refs.add(d.item);
        } else if (kind === "notes") {
          const card=id.startsWith("q:") ? id.slice(2) : null;
          const d=card ? index().decById.get(card) : undefined, home=card ? d ? homeOf(d) : null : id.slice(3);
          if (!paintedHome(home) && !(card && drawnCards.has(card)) && !(id.startsWith("it:") && drawnItems.has(id.slice(3)))) { replaceNotes(id); if (card) drawnCards.add(card); }
          const item=id.startsWith("it:") ? id.slice(3) : snapshot.decisions[id.slice(2)]?.item;
          if (item) { heads.add(item); derived.ancestors(item).forEach(p => heads.add(p)); }
          if (item && card) refs.add(item);
        } else if (kind === "head") heads.add(id);
      }
      refs.forEach(patchRefs);
      for (const id of heads) {
        const it=index().byId.get(id), old=get("it-"+id); if (!it || !old || scope.has("areas")) continue;
        const next=itemNode(it,inArchive(it),true).children[0] as HTMLElement;
        old.children[0]!.replaceWith(next.children[0]!); old.className=next.className; old.dataset.title=next.dataset.title;
      }
      // Keep the existing sibling subtrees while reflecting derived status/priority ordering.
      const parents=new Set<HTMLElement>();
      for (const key of scope) if (key.startsWith("item:")) { const li=get("it-"+key.slice(5))?.parentElement; if (li?.parentElement) parents.add(li.parentElement); }
      for (const parent of parents) {
        const rows=[...parent.children] as HTMLElement[];
        if (parent.parentElement?.tagName === "LI" && rows.every(li => li.children[0]?.id.startsWith("it-"))) rows.sort((a,b) => derived.compareSiblings(a.children[0]!.id.slice(3),b.children[0]!.id.slice(3))).forEach(li => parent.appendChild(li));
      }
    }
    // Group counts and dependency summaries are independent of the unchanged item/card subtrees.
    projectGroups().forEach((g,i) => {
      const box=get("group-"+i); if (!box) return;
      const filters=[...box.children].find(e => e.classList.contains("grp-filters")); if (filters) filters.replaceWith(filterRow(g.name));
      const head=box.children[0] as HTMLElement | undefined; if (!head) return;
      const next=el("h2","group-head",inline(g.name || "其他")), summary=crossSummary(g.name);
      if (summary) { const button=el("button","xdeps",esc(summary)); button.type="button"; button.title="只看跨项目依赖"; button.addEventListener("click",() => setDepFilter(g.name,"cross")); next.appendChild(button); }
      head.replaceWith(next);
    });
    const order=stops().map(s => s.id);
    if (!sameValue(order,waitingOrder)) {
      waitingOrder=order;
      for (const root of [get("areas"),get("cards")]) for (const button of elements(root).filter(e => e.dataset.stop)) button.replaceWith(nextButton(button.dataset.stop!));
    }
    renderHeader(); renderSend(); renderMenu();
    if (anchor) { const e = get(anchor.id); if (e) { const d = e.getBoundingClientRect().top - anchor.top; if (d) scrollBy(d); if (landing) expectedScroll=window.scrollY; } }
    crumbKey = null; updateCrumbs();
    if (keep) { const t = get<HTMLTextAreaElement | HTMLInputElement>(keep.id); if (t) { t.focus({ preventScroll: true }); try { t.setSelectionRange(keep.start, keep.end); } catch (e) {} } }
  }
  renderAll();

  get("to-top").addEventListener("click", () => glideTo(0));

  get<HTMLButtonElement>("send-all").addEventListener("click", async () => {
    if (sending) return; sending = true; sendMessage = ""; renderSend();
    try {
      const drafts=[...optimistic.values()].map(o => o.promise!);
      if ((await Promise.all(drafts)).some(ok => !ok)) return;
      const result = await api<{sent: Array<{project: string}>}>("/api/send", {});
      const counts = new Map<string,number>();
      result.sent.forEach(n => counts.set(n.project, (counts.get(n.project) || 0) + 1));
      sendMessage = "已发出 " + result.sent.length + " 条：" + [...counts].map(([project,n]) => project + "×" + n).join(" · ");
    } catch(e) { showError(e); } finally { sending = false; renderSend(); }
  });

  const DISCONNECTED = "已和看板服务器断开，正在重连…";
  const WRITE_TIMEOUT = "看板服务器没有响应，请刷新页面后核对操作结果。";
  async function api<T = unknown>(path: string, data?: unknown, method = "POST", signal?: AbortSignal): Promise<T> {
    const writing = data !== undefined && method !== "GET";
    if (writing && !connected) throw new Error(DISCONNECTED);
    const controller = writing ? new AbortController() : undefined;
    const request = (async () => {
      const response = await fetch(path, data === undefined ? { method: "GET", cache: "no-store", signal } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), signal: controller?.signal ?? signal });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "HTTP " + response.status);
      return value as T;
    })();
    if (!writing) return request;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([request,new Promise<never>((_resolve,reject) => {
        deadline = setTimeout(() => { reject(new Error(WRITE_TIMEOUT)); controller!.abort(); },8000);
      })]);
    } finally { if (deadline !== undefined) clearTimeout(deadline); }
  }
  function showError(e: unknown) { get("server-banner").hidden = false; get("server-banner").textContent = e instanceof Error ? e.message : String(e); }
  async function createNote(note: Parameters<OwnerOps["createNote"]>[0]) { sendMessage = ""; try { return await api("/api/notes", note); } catch(e) { showError(e); throw e; } }
  async function deleteNote(id: string) { try { return await api("/api/notes/" + encodeURIComponent(id), {}, "DELETE"); } catch(e) { showError(e); throw e; } }
  function applySnapshot(s: Snapshot) {
    rulePresentationDirty=true;
    snapshot = s;
    state.meta = s.board;
    state.items = Object.entries(s.items).map(([id,it]) => ({...it,id}));
    state.decisions = Object.entries(s.decisions).map(([id,d]) => ({...d,id}));
    state.notes = Object.entries(s.notes).map(([id,n]) => ({...n,id}));
    invalidate();
  }
  let unreadGeneration = 0;
  let unreadFlight:{signal?:AbortSignal;promise:Promise<boolean>} | undefined;
  function refreshUnread(active: () => boolean = () => true, signal?: AbortSignal):Promise<boolean> {
    if (unreadFlight && unreadFlight.signal === signal) return unreadFlight.promise;
    const generation = ++unreadGeneration;
    const operation=(async () => {
      for (;;) {
        const revision=eventGeneration;
        const result = await api<{cursor?: string; steps: Step[]}>("/api/unread",undefined,"GET",signal);
        if (generation !== unreadGeneration || !active()) return false;
        if (revision !== eventGeneration) continue;
        const previous=steps, changed=!sameValue(previous,result.steps) || failedDiffs.size > 0;
        steps = result.steps; snapshot.owner.cursor = result.cursor; failedDiffs.clear(); invalidate();
        if (shownStop && !steps.some(s => shownStop!.startsWith(s.id + "|"))) shownStop = null;
        if (changed) {
          const scope=new Set<string>();
          [...previous,...steps].forEach(s => s.docs.forEach(d => scopeForDoc(d.kind,d.id,snapshot.notes[d.id]?.target).forEach(k => scope.add(k))));
          scheduleRender(...scope);
        }
        return true;
      }
    })();
    unreadFlight={signal,promise:operation};
    void operation.finally(() => { if (unreadFlight?.promise === operation) unreadFlight=undefined; }).catch(() => {});
    return operation;
  }
  let unreadQueued=false;
  function queueUnread(active:()=>boolean, signal:AbortSignal, expected:EventSource) {
    if (unreadQueued) return; unreadQueued=true;
    frame(() => { unreadQueued=false; if (active()) void refreshUnread(active,signal).catch(() => { if (active()) serverDown(expected); }); });
  }
  async function refreshOwner() {
    const expected = source, signal = connectionAbort?.signal;
    const active = () => expected !== undefined && source === expected && connected && !signal?.aborted;
    if (!active()) return;
    try { await loadSnapshot(active,signal); if (active()) await refreshUnread(active,signal); }
    catch (e) { if (active()) throw e; }
  }
  function loadDiff(step: Step, doc: Step["docs"][number]): Promise<void> {
    const key = step.id + ":" + doc.kind + ":" + doc.id;
    if (diffs.has(key) || failedDiffs.has(key)) return Promise.resolve();
    const pending = pendingDiffs.get(key);
    if (pending) return pending;
    const request = (async () => {
      try {
        const diff = await api<{before: unknown; after: unknown; diff: string}>("/api/step?id=" + step.id + "&kind=" + doc.kind + "&doc=" + encodeURIComponent(doc.id));
        diffs.set(key,diff); scheduleRender(...scopeForDoc(doc.kind,doc.id,snapshot.notes[doc.id]?.target));
      } catch(e) {
        // A failed baseline cannot keep a render/navigation drain retrying forever. The next unread refresh or unread walk retries it.
        failedDiffs.add(key);
        if (steps.some(s => s.id === step.id)) showError(e);
      } finally { pendingDiffs.delete(key); }
    })();
    pendingDiffs.set(key,request);
    return request;
  }
  function unreadLogs(it: ViewItem) {
    const before = unreadBefore<Item>("item",it.id);
    if (before === undefined) return [];
    const previous = (before?.log || []).slice();
    return it.log.filter(e => {
      const old = previous.findIndex(entry => entry.at === e.at && entry.by === e.by && entry.text === e.text);
      if (old < 0) return true;
      previous.splice(old,1); return false;
    });
  }
  function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v,i) => sameValue(v,b[i]));
    const left = a as Record<string,unknown>, right = b as Record<string,unknown>;
    return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(k => Object.hasOwn(right,k) && sameValue(left[k],right[k]));
  }
  // undefined means no unread baseline (or still loading); null means the document is new.
  function unreadBefore<T>(kind: Step["docs"][number]["kind"], id: string): T | null | undefined {
    const first = steps.find(s => s.docs.some(d => d.kind === kind && d.id === id));
    if (!first) return undefined;
    const doc = first.docs.find(d => d.kind === kind && d.id === id)!;
    const diff = diffs.get(first.id + ":" + kind + ":" + id);
    if (!diff) { void loadDiff(first,doc); return undefined; }
    return diff.before as T | null;
  }
  // Blank lines delimit blocks, except inside a fenced code block. A contiguous list or table is one block.
  function proseBlocks(text: string): string[] {
    const out: string[] = [], block: string[] = [];
    let fenced = false;
    const flush = () => { if (block.length) out.push(block.join("\n")); block.length = 0; };
    for (const line of text.replace(/\r/g, "").split("\n")) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      if (!line.trim() && !fenced) flush(); else block.push(line);
    }
    flush(); return out;
  }
  // An ordered LCS leaves deletions at their original place; replacements remove before adding.
  function orderedChanges<T>(before: T[], after: T[], equal: (a:T,b:T) => boolean = sameValue): Array<{value:T; mark:"" | "chg-add" | "chg-del"}> {
    const lcs = Array.from({length:before.length + 1}, () => new Uint32Array(after.length + 1));
    for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) {
      lcs[i]![j] = equal(before[i]!,after[j]!) ? 1 + lcs[i + 1]![j + 1]! : Math.max(lcs[i + 1]![j]!,lcs[i]![j + 1]!);
    }
    const out: Array<{value:T; mark:"" | "chg-add" | "chg-del"}> = [];
    let i = 0, j = 0;
    while (i < before.length || j < after.length) {
      if (i < before.length && j < after.length && equal(before[i]!,after[j]!)) { out.push({value:after[j++]!,mark:""}); i++; }
      else if (i < before.length && (j === after.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({value:before[i++]!,mark:"chg-del"});
      else out.push({value:after[j++]!,mark:"chg-add"});
    }
    return out;
  }
  function markedBlocks(before: string | undefined, after: string) {
    if (before === undefined || before === after) return blocks(after);
    return orderedChanges(proseBlocks(before),proseBlocks(after)).map(({value,mark}) => mark ? '<div class="' + mark + '">' + blocks(value) + '</div>' : blocks(value)).join("");
  }
  function appendTitle(parent: HTMLElement, title: string, before: string | null | undefined, cls = "") {
    parent.appendChild(el("span", cls + (before !== undefined && before !== title ? " chg-add" : ""),inline(title)));
    if (before != null && before !== title) parent.appendChild(el("small", "title-was chg-del",inline(before)));
  }
  let retry: ReturnType<typeof setTimeout> | undefined;
  let source: EventSource | undefined;
  let connectionAbort: AbortController | undefined;
  let eventGeneration = 0;
  let snapshotGeneration = 0;
  async function loadSnapshot(active: () => boolean = () => true, signal?: AbortSignal) {
    for (;;) {
      const generation = snapshotGeneration;
      const s = await api<Snapshot>("/api/snapshot",undefined,"GET",signal);
      if (!active()) return;
      if (generation !== snapshotGeneration) continue;
      applySnapshot(s); scheduleRender("all"); return;
    }
  }
  function serverDown(expected: EventSource | undefined = source) {
    if (expected !== source) return;
    connected = false; scheduleRender("all"); showError(new Error(DISCONNECTED));
    source?.close(); source = undefined; connectionAbort?.abort();
    if (retry !== undefined) clearTimeout(retry);
    retry = setTimeout(() => { retry = undefined; connect(); },5000);
  }
  function connect() {
    if (retry !== undefined) clearTimeout(retry);
    source?.close(); connectionAbort?.abort();
    connected = false;
    const next = new EventSource("/api/events"), controller = new AbortController();
    source = next; connectionAbort = controller;
    const active = () => source === next && !controller.signal.aborted;
    // A hung handshake or reload must not prevent the next five-second attempt.
    retry = setTimeout(() => { retry = undefined; if (active()) { showError(new Error(DISCONNECTED)); connect(); } },5000);
    next.onopen = async () => {
      if (!active()) return;
      try {
        await loadSnapshot(active,controller.signal);
        if (!active()) return;
        // A change event can supersede this reload; wait for our own current unread result before enabling writes.
        while (active() && !await refreshUnread(active,controller.signal)) {}
        if (!active()) return;
        if (retry !== undefined) clearTimeout(retry);
        retry = undefined; connected = true; get("server-banner").hidden = true; scheduleRender("all");
      } catch(e) { if (active()) serverDown(next); }
    };
    next.onerror = () => serverDown(next);
    next.addEventListener("change", event => {
      if (!active()) return;
      eventGeneration++;
      snapshotGeneration++;
      const change = JSON.parse((event as MessageEvent).data) as {commit: string; changed: Array<{kind: string; id: string; after: unknown}>};
      const scope=new Set<string>();
      const relocated:string[]=[];
      snapshot={...snapshot,items:{...snapshot.items},decisions:{...snapshot.decisions},notes:{...snapshot.notes}};
      rulePresentationDirty=true;
      for (const doc of change.changed) {
        const previous=doc.kind === "item" ? snapshot.items[doc.id] : doc.kind === "decision" ? snapshot.decisions[doc.id] : snapshot.notes[doc.id];
        if (doc.kind === "note") {
          const after=doc.after as Note | null;
          if (after && (after.rev < ((previous as Note | undefined)?.rev ?? 0) || after.rev <= (noteTombstones.get(doc.id) ?? -1))) continue;
          if (!after && previous) noteTombstones.set(doc.id,Infinity);
          noteEvents.set(doc.id,eventGeneration);
          for (const target of [(previous as Note | undefined)?.target,after?.target]) if (target) scope.add("notes:"+target);
        } else if (doc.kind === "item") {
          const before=previous as Item | undefined, after=doc.after as Item | null;
          scope.add("item:"+doc.id);
          if (!before || !after || before.parent !== after.parent || before.group !== after.group || before.order !== after.order || !sameValue(before.request,after.request)) {
            if (before) { scope.add("group:"+derived.groupOf(doc.id)); derived.ancestors(doc.id).forEach(p => scope.add("item:"+p)); } relocated.push(doc.id);
          }
          else {
            scope.add("item:"+doc.id); scopedHeads(doc.id,scope);

          }
        } else if (doc.kind === "decision") {
          const before=previous as Decision | undefined, after=doc.after as Decision | null;
          if (!before || !after || before.item !== after.item || before.status !== after.status) {
            for (const item of [before?.item,after?.item]) if (item && snapshot.items[item]) scope.add("item:"+item);
            if (!before?.item || !snapshot.items[before.item] || !after?.item || !snapshot.items[after.item]) scope.add("cards");
          }
          scope.add("card:"+doc.id);

        } else scope.add("all");
        if (doc.kind === "board") snapshot.board = doc.after as Board;
        else if (doc.kind === "owner") snapshot.owner = doc.after as OwnerState;
        else {
          const collection = doc.kind === "item" ? snapshot.items : doc.kind === "decision" ? snapshot.decisions : snapshot.notes;
          if (doc.after === null) delete collection[doc.id]; else Object.assign(collection, { [doc.id]: doc.after });
        }
      }
      snapshot.head = change.commit; applySnapshot(snapshot);
      relocated.forEach(id => { if (snapshot.items[id]) scope.add("group:"+derived.groupOf(id)); });

      scheduleRender(...scope); queueUnread(active,controller.signal,next);
    });
  }
  void connect();

function get<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
