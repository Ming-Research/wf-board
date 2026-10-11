import { rules } from "../src/rules.ts";
import type { Snapshot, Item, Decision, Note, Board, OwnerState, LogEntry } from "../src/model.ts";
import type { Step } from "../src/history.ts";
import type { OwnerOps } from "../src/owner-ops.ts";
type ViewItem = Item & { id: string };
type ViewDecision = Decision & { id: string };
type ViewNote = Note & { id: string };
interface ViewState { meta: Board | null; items: ViewItem[]; decisions: ViewDecision[]; notes: ViewNote[] }
interface FreshStop { key: string; step: string; doc: Step["docs"][number]; last: boolean; kinds: string[]; sel: string; item: string | null; container: string; card?: string; notes?: string }

interface LineGroup { kind: "same" | "added" | "removed"; lines: string[] }
/** Longest common subsequence of physical lines; replacements remove before adding. */
export function lineDiff(before: string, after: string): LineGroup[] {
  const lines = (s: string) => s ? s.replace(/\r/g, "").split("\n") : [];
  const a = lines(before), b = lines(after);
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    lcs[i]![j] = a[i] === b[j] ? 1 + lcs[i + 1]![j + 1]! : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const groups: LineGroup[] = [];
  const push = (kind: LineGroup["kind"], line: string) => {
    if (groups.at(-1)?.kind !== kind) groups.push({ kind, lines: [] });
    groups.at(-1)!.lines.push(line);
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { push("same", a[i++]!); j++; }
    else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) push("removed", a[i++]!);
    else push("added", b[j++]!);
  }
  return groups;
}

  const STATUS: Record<string,string> = { wip: "WIP", done: "DONE", todo: "TODO", blocked: "BLOCK", cancelled: "DROP" };
  const state: ViewState = { meta: null, items: [], decisions: [], notes: [] };
  let snapshot: Snapshot = { board: { title: "进度板", projects: [] }, items: {}, decisions: {}, notes: {}, owner: { archived: {} }, head: "" };
  let derived = rules(snapshot);
  let steps: Step[] = [];
  let shownStop: string | null = null;
  const pendingDiffs = new Set<string>();
  const diffs = new Map<string, { before: unknown; after: unknown; diff: string }>();
  let sendMessage = "";
  let connected = false;
  let editing: string | null = null, sending = false;
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
    const fresh = (_line: string) => false;
    const cls = (changed: boolean) => changed ? ' class="chg"' : "";
    const out: string[] = [];
    let para: string[] = [], list: {tag:string;items:Array<{text:string;raw:string}>} | null = null, code: string[] | null = null;
    const flushPara = () => {
      if (!para.length) return;
      const m = para[0]!.match(/^\*\*([^*]+)\*\*\s*[：:]\s*(.*)$/);
      let lead = para.slice();
      if (m) { out.push('<div class="sub' + (fresh(para[0]!) ? " chg" : "") + '">' + inline(m[1]) + "</div>"); lead[0] = m[2]!; lead = lead.filter((l, i) => i > 0 || l); }
      if (lead.length) out.push("<p" + cls(para.some(fresh)) + ">" + lead.map(inline).join("<br>") + "</p>");
      para = [];
    };
    const flushList = () => { if (list) { out.push("<" + list.tag + ">" + list.items.map(t => "<li" + cls(fresh(t.raw)) + ">" + inline(t.text) + "</li>").join("") + "</" + list.tag + ">"); list = null; } };
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
      if (head) h += "<thead><tr" + cls(fresh(head)) + ">" + cells(head).map((c, i) => td("th", c, i)).join("") + "</tr></thead>";
      h += "<tbody>" + body.map(r => "<tr" + cls(fresh(r)) + ">" + cells(r).map((c, i) => td("td", c, i)).join("") + "</tr>").join("") + "</tbody></table></div>";
      out.push(h);
    };
    for (const line of lines) {
      if (!code && /^\s*\|/.test(line)) { flushPara(); flushList(); (table = table || []).push(line); continue; }
      flushTable();
      if (code) { if (/^\s*```/.test(line)) { out.push("<pre" + (code.some(fresh) ? ' class="code chg"' : ' class="code"') + "><code>" + esc(code.join("\n")) + "</code></pre>"); code = null; } else code.push(line); continue; }
      if (/^\s*```/.test(line)) { flushPara(); flushList(); code = []; continue; }
      const ul = line.match(/^\s*[-*]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const tag = ul ? "ul" : "ol";
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push({ text: (ul || ol)![1]!, raw: line });
        continue;
      }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      flushList();
      para.push(line);
    }
    if (code) out.push("<pre" + (code.some(fresh) ? ' class="code chg"' : ' class="code"') + "><code>" + esc(code.join("\n")) + "</code></pre>");
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
  function agentsFor(it: ViewItem | null | undefined) { return it ? derived.agentsFor(it.id) : []; }
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
  function newReplies(key: string) { return notesOf(key).filter(n => n.reply && touched("note",n.id)); }
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
  function saveFilters() { try { localStorage.setItem("board-filters2", JSON.stringify(filters)); } catch (e) {} invalidate(); renderAreas(); }
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
    if (filtering(g)) row.appendChild(btn(false, "清除筛选", "", () => { clearFilters(g); renderAreas(); }));
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
      return { key, step: step.id, doc: d, last: false, kinds: docKinds(d), sel: "step:" + key, item, card, notes, container: card ? "q:" + card : item ? "it:" + item : "history" };
    })).filter(st => !(st.item && snapshot.items[st.item] && derived.inArchive(st.item)));
    // The cursor moves by whole commits, so only a step's last shown stop offers 已阅.
    out.forEach((st, k) => { st.last = out[k + 1]?.step !== st.step; });
    return out;
  }

  function noteId(n: ViewNote) { return "note-" + String(n.id).replace(/[^A-Za-z0-9_-]/g, "_"); }
  // The element a stop selects, once its item, card and comment list are open.
  function stopEl(st: FreshStop) { return selEl(st.sel); }
  function goFresh(k: number) {
    const all = freshStops();
    if (!all.length) return;
    const st = all[((k % all.length) + all.length) % all.length]!;
    shownStop = st.key;
    void loadDiff(steps.find(s => s.id === st.step)!, st.doc);
    if (st.item && snapshot.items[st.item] && derived.inArchive(st.item)) { const g = derived.groupOf(st.item), f = groupFilter(g); filters[g] = { ...f, status: ["archived"] }; }
    if (st.card) { const d = index().decById.get(st.card); if (d && d.status !== "open" && !ruledOpen[d.id]) { ruledOpen[d.id] = true; saveRuled(); } }
    if (st.notes && !notesOpen[st.notes]) { notesOpen[st.notes] = true; try { localStorage.setItem("board-notes", JSON.stringify(notesOpen)); } catch (e) {} }
    if (st.item) { const item = snapshot.items[st.item]; if (item && !passes({...item,id:st.item})) clearFilters(derived.groupOf(st.item)); openPath(st.item); renderCards(); } else { renderAreas(); renderCards(); }
    const e = stopEl(st) || (st.item ? get("it-" + st.item) : null);
    if (e) { jump(e); setCurrent(e); }
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
    try { for (const id of Object.keys(logShown)) if (manual[id]) logHold[id] = true; await api("/api/read", { through: step }); shownStop = null; await refreshOwner(); return true; } catch (e) { showError(e); return false; }
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
  function selectedFresh() { return shownFresh() && onScreen(selEl("step:" + shownStop)) ? { key: "step:" + shownStop } : null; }

  // The selection: an item (it:), a card (q:), a log entry (log:<item>@<time>) or a comment or reply (note:<id>).
  // r, c, e and a act on it, or on the item or card that holds it.
  let current: string | null = null;
  function keyOfBox(box: HTMLElement | null) { return !box ? null : box.dataset.sel || (box.id.startsWith("q-") ? "q:" + box.id.slice(2) : box.id.startsWith("it-") ? "it:" + box.id.slice(3) : null); }
  function selEl(key: string | null) {
    if (!key) return null;
    if (key.startsWith("step:")) return get(key);
    if (key.startsWith("it:")) return get("it-" + key.slice(3));
    if (key.startsWith("q:")) return get("q-" + key.slice(2));
    return document.querySelector<HTMLElement>('[data-sel="' + CSS.escape(key) + '"]');
  }
  function boxOfKey(key: string | null) { return selEl(key); }
  // The item or card a selection belongs to.
  function containerOf(key: string | null) {
    if (!key) return null;
    if (key.startsWith("step:")) return allFreshStops().find(st => st.key === key.slice(5))?.container || null;
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
    if (!connected) return;
    const act = ACTIONS.find(a => a.key === ev.key && a.db);
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
        r.addEventListener("click", ev => { ev.stopPropagation(); if (a.db && !connected) return; a.run(); m.classList.remove("open"); });
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
    if (st.item) openPath(st.item);
    jump(st.id);
  }
  // The last waiting stop leads to the send box, so the owner sends the batch without scrolling back.
  function nextButton(stopId: string) {
    const all = stops();
    const k = all.findIndex(x => x.id === stopId);
    const last = k === all.length - 1;
    const b = el("button", "nextbtn", last ? "去发送" : "下一条（" + (k + 2) + "/" + all.length + "）");
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
  function glideTo(top: number) {
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    top = Math.min(max, Math.max(0, Math.round(top)));
    const run = ++glideRun;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { window.scrollTo(0, top); return; }
    const reach = innerHeight;
    let from = scrollY;
    if (Math.abs(top - from) > reach) { from = top - Math.sign(top - from) * reach; window.scrollTo(0, from); }
    const dist = top - from, ms = 160 + Math.abs(dist) / reach * 160, t0 = performance.now();
    const step = (now: number) => {
      if (run !== glideRun) return;
      const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      window.scrollTo(0, from + dist * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  // The reader's own wheel or touch stops a glide.
  ["wheel", "touchstart"].forEach(t => addEventListener(t, () => { glideRun++; }, { passive: true }));
  function glideToEl(t: HTMLElement, block: string) {
    const r = t.getBoundingClientRect();
    const margin = parseFloat(getComputedStyle(t).scrollMarginTop) || 0;
    const top = block === "start" || r.height + margin > innerHeight ? r.top - margin : r.top - (innerHeight - r.height) / 2;
    glideTo(scrollY + top);
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
    glideTo(view - top);
  }
  function jump(id: string | HTMLElement) {
    let t = typeof id === "string" ? get(id) : id;
    // A target the dependency filter hides clears the filter.
    if (!t && anyFiltering() && typeof id === "string") { clearFilters(); renderAreas(); t = get(id); }
    if (!t) return;
    glideToTarget(t);
    setCurrent(t.closest<HTMLElement>(".card, .item"));
  }
  function openPath(id: string) {
    let it = index().byId.get(id);
    if (it) manual[it.id] = true;
    if (it) ancestors(it).forEach(p => { if (!isOpen(p)) manual[p.id] = true; });
    saveManual(); renderAreas();
  }
  function reveal(id: string) { openPath(id); jump("it-" + id); }
  // Following a dependency remembers where the reader was; Backspace, [ or the 返回 button goes back.
  const backStack: Array<{key:string|null;y:number}> = [];
  function follow(id: string) {
    const from = targetOnScreen();
    backStack.push({ key: from, y: scrollY });
    if (backStack.length > 50) backStack.shift();
    const target = index().byId.get(id);
    if (target && !passes(target)) clearFilters(groupOf(target));
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
  function followCard(id: string) { const d = snapshot.decisions[id]; if (!d) return; if (d.status !== "open") { ruledOpen[id] = true; saveRuled(); } openPath(d.item); renderCards(); jump("q-" + id); }
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
  function pendingExplain(key: string) { return notesOf(key).find(n => n.kind === "explain" && n.state === "draft"); }
  // An explain request toggles: the first press queues it, a second press withdraws the unsent request.
  async function toggleExplain(key: string) {
    const pending = pendingExplain(key);
    try {
      if (pending) await deleteNote(pending.id);
      else await createNote({ target: key, kind: "explain", text: EXPLAIN });
    } catch (e) {}
  }
  // A comment on a log entry or a reply keeps its target, the item or card, and names the piece in anchor.
  let editingAnchor: Note["anchor"] | null = null;
  function openComment(key: string, anchor?: Note["anchor"] | null) {
    if (key.startsWith("it:")) openPath(key.slice(3));
    editing = key; editingAnchor = anchor || null;
    renderAreas(); renderCards();
    const ta = get<HTMLTextAreaElement>("ed-" + key.replace(/[^A-Za-z0-9_-]/g, "_"));
    if (ta) { ta.focus(); ta.scrollIntoView({ block: "center" }); }
  }
  // A queued explain request shows on the item or card it asks about until it is sent.
  function pendingChip(key: string) { return pendingExplain(key) ? el("span", "pendtag", "待发：详细解释") : null; }
  // The owner's answer to an item's request: "approve" for a request the agent carries out, "done" for one the owner carried out (a merge).
  const ANSWER: Record<string, {label:string;queued:string;sent:string;prefix:string}> = { approve: { label: "同意", queued: "已同意，待发", sent: "已发送同意", prefix: "同意：" }, done: { label: "完成", queued: "已标完成，待发", sent: "已发送完成", prefix: "已完成：" } };
  function answerButton(kind: "approve" | "done", key: string, title: string, ask: string) {
    const k = ANSWER[kind]!;
    const pending = notesOf(key).find(n => n.kind === kind && n.state === "draft");
    const sent = notesOf(key).find(n => n.kind === kind && n.state === "sent");
    const b = el("button", "okbtn" + (pending || sent ? " on" : ""), sent ? k.sent : pending ? k.queued : k.label);
    b.type = "button";
    b.disabled = !!sent;
    b.title = pending ? "再点一次撤回" : "随下一次“发给 Claude”一起发出";
    b.addEventListener("click", async ev => {
      ev.stopPropagation();
      b.disabled = true;
      try {
        if (pending) await deleteNote(pending.id);
        else await createNote({ target: key, kind: kind, text: k.prefix + ask });
      } catch (e) { b.disabled = false; }
    });
    return b;
  }
  // Archiving an item hides it and its sub-items until new progress brings it back; doing it again restores it.
  async function toggleArchive(it: ViewItem) {
    try { await api("/api/archive", { id: it.id, on: !isArchived(it) }); await refreshOwner(); return true; } catch (e) { showError(e); return false; }
  }

  // Approvals and choices show on their buttons; the comment list holds comments, explain requests, and any approval or choice a session replied to.
  function listed(n: ViewNote) { return (!ANSWER[n.kind] && n.kind !== "choice") || !!n.reply; }
  function anchorLabel(a: NonNullable<Note["anchor"]>) {
    if (a.kind === "log") return "进展 " + day(a.at);
    const n = state.notes.find(x => x.id === a.id);
    return n ? "回复（" + day(n.repliedAt || n.at) + "）" : "一条回复";
  }
  const NOTE_STATE: Record<Note["state"], string> = { draft: "未发送", sent: "已发送，等处理", done: "已处理" };
  function noteThread(n: Note, fresh = false) {
    const box = el("div", "note" + (n.state === "draft" ? " draft" : "") + (fresh ? " newbar" : ""));
    box.appendChild(el("div", "who", esc(day(n.at)) + " · " + NOTE_STATE[n.state]));
    if (n.anchor) box.appendChild(el("div", "anchor", "关于" + esc(anchorLabel(n.anchor))));
    box.appendChild(el("div", "txt", n.kind === "explain" ? "请求：详细解释" : n.kind === "approve" ? "同意" : n.kind === "choice" ? "选择：" + esc(n.choice || "") : blocks(n.text)));
    if (n.reply) box.appendChild(el("div", "reply rich", '<div class="sub">Claude</div>' + blocks(n.reply)));
    return box;
  }
  function noteBlock(key: string, title: string) {
    const mine = notesOf(key).filter(listed).sort((x, y) => String(x.at).localeCompare(String(y.at)));
    if (!mine.length && editing !== key) return null;
    const wrap = el("div", "notes");
    // New replies open the list until the owner folds or opens it by hand.
    const shown = Object.prototype.hasOwnProperty.call(notesOpen, key) ? !!notesOpen[key] : newReplies(key).length > 0;
    if (mine.length) {
      const replied = mine.filter(n => n.reply).length;
      const pend = mine.filter(n => n.state === "draft").length;
      const t = el("button", "notes-toggle" + (!shown && fon("reply") && newReplies(key).length ? " newbar" : ""), (shown ? "▾ " : "▸ ") + "评论 " + mine.length + " 条" + (replied ? "，" + replied + " 条有回复" : "") + (pend ? '<span class="pend">' + pend + " 条未发送</span>" : ""));
      t.type = "button";
      t.setAttribute("aria-expanded", String(shown));
      t.addEventListener("click", () => { notesOpen[key] = !shown; try { localStorage.setItem("board-notes", JSON.stringify(notesOpen)); } catch (e) {} renderAreas(); renderCards(); });
      wrap.appendChild(t);
    }
    const fresh = fon("reply") ? newReplies(key) : [];
    (shown ? mine : []).forEach(n => {
      const box = noteThread(n, fresh.includes(n));
      box.id = noteId(n);
      box.dataset.sel = "note:" + n.id;
      if (current === "note:" + n.id) box.classList.add("cur");
      const who = box.firstElementChild!;
      if (n.state === "draft") {
        const del = el("button", "linkbtn", "删除"); del.type = "button";
        del.addEventListener("click", () => { deleteNote(n.id).catch(showError); });
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
          drafts[key] = ""; editing = null; editingAnchor = null; renderAreas(); renderCards();
        } catch (e) { save.disabled = false; save.textContent = "没存上，再试一次"; }
      });
      cancel.addEventListener("click", () => { editing = null; editingAnchor = null; renderAreas(); renderCards(); });
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
    const n = state.notes.filter(x => x.state === "draft").length;
    const waiting = state.notes.filter(x => x.state === "sent").length;
    btn.textContent = n ? "把 " + n + " 条发给 Claude" : "发给 Claude";
    btn.disabled = sending || !n;
    const ex = state.notes.filter(x => x.state === "draft" && x.kind === "explain").length;
    const ok = state.notes.filter(x => x.state === "draft" && x.kind === "approve").length;
    const ch = state.notes.filter(x => x.state === "draft" && x.kind === "choice").length;
    const dn = state.notes.filter(x => x.state === "draft" && x.kind === "done").length;
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
          } catch (e) { yes.disabled = false; }
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
      renderAreas(); renderCards();
    });
    view.appendChild(fold);
    // Opens every top-level item so the items under it show, each one folded: the first level and nothing deeper.
    view.appendChild(sbtn("s-plain", "展开第一层", "展开每条工作线，只显示它下面第一层条目", () => {
      state.items.forEach(i => { delete manual[i.id]; });
      tops().forEach(t => { manual[t.id] = true; });
      saveManual(); renderAreas();
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
      more.addEventListener("click", () => { logOpen[it.id] = true; renderAreas(); });
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

  function itemNode(it: ViewItem, inArchive = false) {
    const li = el("li");
    // A filter opens the path to its matches, their sub-item lists only; an item's body opens only when the owner opens it.
    const open = isOpen(it), bodyOpen = !!manual[it.id];
    if (!bodyOpen) { delete logShown[it.id]; delete logHold[it.id]; }
    const st = statusOf(it);
    const box = el("div", "item " + st + (up(it) ? "" : " line") + (freshShown(it) ? " fresh" : "") + (filtering(groupOf(it)) && !filterMatches().hit.has(it.id) ? " ctx" : ""));
    box.id = "it-" + it.id;
    if (current === "it:" + it.id) box.classList.add("cur");
    box.dataset.title = plain(it.title);
    // Archived sub-items stay where they are: hidden, unless the 已归档 filter shows them.
    const sub = kids(it.id, inArchive || showsArchived(groupOf(it))).filter(k => inArchive || passes(k));
    const ck = checksOf(it), raised = raisedBy(it);
    const hasBody = !!(headOf(it) || logOf(it).length || it.data || it.ask || derived.cardsOf(it.id).length || depIds(it).length || (waitedBy().get(it.id) || []).length || ck.length || raised || (it.links || []).length || sub.length);
    const head = el("button", "item-head");
    head.type = "button";
    head.setAttribute("aria-expanded", String(open));
    head.appendChild(el("span", "caret", hasBody ? (open ? "▾" : "▸") : ""));

    head.appendChild(el("span", "st " + st, esc(STATUS[st] || st)));
    // The badge shows the effective priority; a raised one also shows the written one, struck through.
    const pr = effPriorityOf(it), wrote = priorityOf(it);
    const pb = el("span", "prio " + (pr ? pr.toLowerCase() : "none"), pr || "P?");
    if (raised) pb.title = "写的是 " + (wrote || "未设") + "；因为「" + plain(raised.title) + "」(" + effPriorityOf(raised) + ") 在等它";
    head.appendChild(pb);
    if (raised) head.appendChild(el("span", "prio-was", esc(wrote || "P?")));
    head.appendChild(el("span", "item-title", inline(it.title)));
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
    head.addEventListener("click", () => { manual[it.id] = !(open && bodyOpen); saveManual(); const next = itemNode(it, inArchive); li.replaceWith(next); next.querySelector<HTMLElement>(".item-head")?.focus({ preventScroll: true }); });
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
      if (headOf(it)) body.appendChild(el("div", "rich", blocks(headOf(it))));
      if (it.data) body.appendChild(el("div", "data", inline(it.data)));
      const des = depEntries(it);
      if (des.length) {
        const dl = el("div", "deplists after");
        dl.appendChild(el("div", "k", "依赖"));
        const fd = new Set<string>();
        des.forEach(e => {
          const d = e.kind === "item" ? index().byId.get(e.id) : undefined;
          const r = d ? whyRow(d, it, e.why) : el("button", "deprow", inline(e.kind === "card" ? snapshot.decisions[e.id]?.question || e.id : e.id) + '<span class="why">' + inline(e.why) + '</span>');
          if (!d && e.kind === "card") r.addEventListener("click", () => followCard(e.id));
          r.dataset.sel = "dep:" + it.id + "@" + e.id;
          if (fd.has(e.id)) r.classList.add("fresh");
          if (current === r.dataset.sel) r.classList.add("cur");
          dl.appendChild(r);
        });
        body.appendChild(dl);
      }
      appendStep(body, "it:" + it.id);
      const lg = logSection(it);
      if (lg) body.appendChild(lg);
      // The owner's request and the decision cards come after the log, whose last entry usually leads to them.
      if (askPending(it)) {
        const a = el("div", "ask");
        a.id = "ask-" + it.id;
        a.style.scrollMarginTop = "24px";
        a.appendChild(el("span", null, '<span class="asktag">等你处理</span> ' + inline(it.ask?.text)));
        if (/^https:\/\//.test(it.ask?.url || "")) { const go = el("a", "okbtn golink", "去处理 ↗"); go.href = it.ask!.url!; go.target = "_blank"; go.rel = "noopener"; a.appendChild(go); if (connected) a.appendChild(answerButton("done", "it:" + it.id, it.title, it.ask!.text)); }
        else if (it.ask?.chat) a.appendChild(el("span", "chatnote", "请在对话窗口里确认"));
        else if (connected) a.appendChild(answerButton("approve", "it:" + it.id, it.title, it.ask!.text));
        a.appendChild(nextButton("ask-" + it.id));
        body.appendChild(a);
      }
      cardsUnder(it).forEach(d => body.appendChild(decisionCard(d)));
      ruledUnder(it).filter(ruledShown).forEach(d => body.appendChild(decisionCard(d)));
      if (ck.length || raised) {
        const cb = el("div", "checks");
        if (raised) { const r = el("div", null, "按 " + pr + " 排：写的是 " + esc(wrote || "未设") + "，因为 "); r.appendChild(depLink(raised)); r.appendChild(document.createTextNode("（" + effPriorityOf(raised) + "）在等它")); cb.appendChild(r); }
        ck.forEach(c => { const r = el("div", null, "需核对：" + esc(c.text) + " "); if (c.target) r.appendChild(depLink(c.target)); cb.appendChild(r); });
        body.appendChild(cb);
      }
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
            const h = homeOf(d);
            if (d.status !== "open") { const show = !ruledShown(d); ruledOpen[q] = show; saveRuled(); if (h) openPath(h); else renderAreas(); if (show) jump("q-" + q); return; }
            if (h) openPath(h); jump("q-" + q);
          });
          refs.appendChild(b);
        });
      }
      (it.links || []).forEach(l => { if (/^https:\/\//.test(l.url || "")) { has = true; const a = el("a", null, esc(l.label)); a.href = l.url; a.target = "_blank"; a.rel = "noopener"; refs.appendChild(a); } });
      if (has) body.appendChild(refs);
      box.appendChild(body);
    }
    const nb = noteBlock("it:" + it.id, it.title);
    if (nb) box.appendChild(nb);
    li.appendChild(box);
    if (open && sub.length) {
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
  function renderAreas() {
    const root = get("areas");
    const nav = get("nav");
    root.innerHTML = ""; nav.innerHTML = "";
    countBelow();
    // Top-level items render under their project group; under a dependency filter only those holding a match show.
    const groups = projectGroups();
    if (!groups.length) { root.appendChild(el("p", "empty", "看板还没有内容。")); appendStep(root, "history"); return; }
    const wrap = el("div"); wrap.style.display = "flex"; wrap.style.flexDirection = "column"; wrap.style.gap = "34px";
    groups.forEach((g, gi) => {
      const box = el("section", "group");
      box.id = "group-" + gi;
      box.dataset.title = plain(g.name || "其他");
      const gh = el("h2", "group-head", inline(g.name || "其他"));
      const project = snapshot.board.projects.find(p => p.name === g.name);
      gh.appendChild(el("span", "project-agents", "负责：" + esc(project?.agents.join("、") || "未指定")));
      const xs = crossSummary(g.name);
      if (xs) { const x = el("button", "xdeps", esc(xs)); x.type = "button"; x.title = "只看跨项目依赖"; x.addEventListener("click", () => setDepFilter(g.name, "cross")); gh.appendChild(x); }
      box.appendChild(gh);
      const gl = el("a", "grp", esc(g.name || "其他")); gl.href = "#group-" + gi; nav.appendChild(gl);
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
      wrap.appendChild(box);
    });
    root.appendChild(wrap);
    appendStep(root, "history");
  }

  function choiceOf(d: ViewDecision) { return notesOf("q:" + d.id).find(n => n.kind === "choice" && (n.state === "draft" || n.state === "sent" || n.state === "done")); }
  function decisionCard(d: ViewDecision, historical = false) {
    const c = el("article", "card" + (!historical && current === "q:" + d.id ? " cur" : "") + (!historical && fon("other") && cardNew(d) ? " fresh" : ""));
    if (!historical) c.id = "q-" + d.id;
    const top = el("div", "card-top");
    const h = el("h3");
    const closed = d.status !== "open";
    if (!historical && waitsQ(d)) h.appendChild(el("span", "asktag", "等你决定"));
    if (closed) h.appendChild(el("span", "closedtag", d.ruling ? "已裁定" : "已结束"));
    h.appendChild(el("span", null, inline(d.question || "")));
    if (!historical && cardFresh(d)) h.appendChild(freshChip("q:" + d.id));
    const pc = historical ? null : pendingChip("q:" + d.id);
    if (pc) h.appendChild(pc);
    top.appendChild(h);
    if (closed && !historical) {
      const x = el("button", "cbtn", "收起"); x.type = "button";
      x.addEventListener("click", ev => { ev.stopPropagation(); ruledOpen[d.id] = false; saveRuled(); renderAreas(); renderCards(); });
      top.appendChild(x);
    }
    c.appendChild(top);
    if (closed && d.ruling) c.appendChild(el("p", null, '<span class="lbl">裁定：</span>' + inline(d.ruling) + (d.ruledAt ? ' · ' + esc(day(d.ruledAt)) : '')));
    if (d.background) c.appendChild(el("div", "rich", '<div class="sub">背景</div>' + blocks(d.background)));
    const chosen = historical ? undefined : choiceOf(d);
    if (Array.isArray(d.options) && d.options.length) {
      c.appendChild(el("p", null, '<span class="lbl">选项：</span>'));
      const ol = el("ul", "opts");
      d.options.forEach(o => {
        const li = el("li");
        const sel = (chosen?.choice || d.choice) === o.key;
        const rec = !!o.recommended || /[（(]推荐[)）]/.test(o.text || "");
        const btn = el("button", "optbtn" + (rec ? " rec" : "") + (sel ? " sel" : ""), (rec ? '<span class="recchip">推荐</span>' : "") + '<span class="lbl">' + esc(o.key) + "：</span>" + inline(o.text));
        btn.type = "button";
        btn.setAttribute("aria-pressed", String(sel));
        btn.disabled = historical || !connected || closed || !!(chosen && chosen.state !== "draft");
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            if (chosen && chosen.state === "draft") await deleteNote(chosen.id);
            if (!sel) await createNote({ target: "q:" + d.id, kind: "choice", choice: o.key, text: "选 " + o.key });
          } catch (e) { btn.disabled = false; }
        });
        li.appendChild(btn);
        ol.appendChild(li);
      });
      c.appendChild(ol);
    }
    if (d.confidence) c.appendChild(el("p", null, '<span class="lbl">信心：</span>' + inline((d.confidence.score === undefined ? "" : d.confidence.score + "/5：") + d.confidence.reason)));
    if (!historical) appendStep(c, "q:" + d.id);
    const nb = historical ? null : noteBlock("q:" + d.id, d.question || "决策");
    if (nb) c.appendChild(nb);
    if (!historical && waitsQ(d)) {
      const foot = el("div", "card-foot");
      foot.appendChild(nextButton("q-" + d.id));
      c.appendChild(foot);
    }
    return c;
  }

  // Decisions live under their items; this section holds only open decisions that no item lists.
  function renderCards() {
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
  window.addEventListener("scroll", () => { if (crumbQueued) return; crumbQueued = true; requestAnimationFrame(() => { crumbQueued = false; updateCrumbs(); }); }, { passive: true });
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
  function renderAll() {
    invalidate();
    // Live updates rebuild the page; a text field being typed in keeps its focus and caret.
    const a = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
    const keep = a && a.id && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") ? { id: a.id, start: a.selectionStart, end: a.selectionEnd } : null;
    const anchor = window.scrollY > 0 ? scrollAnchor() : null;
    renderHeader(); renderAreas(); renderCards(); renderSend(); renderMenu();
    if (anchor) { const e = get(anchor.id); if (e) { const d = e.getBoundingClientRect().top - anchor.top; if (d) window.scrollBy(0, d); } }
    crumbKey = null; updateCrumbs();
    if (keep) { const t = get<HTMLTextAreaElement | HTMLInputElement>(keep.id); if (t) { t.focus({ preventScroll: true }); try { t.setSelectionRange(keep.start, keep.end); } catch (e) {} } }
  }
  renderAll();

  get("to-top").addEventListener("click", () => glideTo(0));

  get<HTMLButtonElement>("send-all").addEventListener("click", async () => {
    if (sending) return; sending = true; sendMessage = ""; renderSend();
    try {
      const result = await api<{sent: Array<{agents: string[]}>}>("/api/send", {});
      const counts = new Map<string,number>();
      result.sent.forEach(n => (n.agents.length ? n.agents : ["未指定负责会话"]).forEach(agent => counts.set(agent, (counts.get(agent) || 0) + 1)));
      sendMessage = "已发出 " + result.sent.length + " 条：" + [...counts].map(([agent,n]) => agent + "×" + n).join(" · ");
    } catch(e) { showError(e); } finally { sending = false; renderSend(); }
  });

  async function api<T = unknown>(path: string, data?: unknown, method = "POST"): Promise<T> {
    const response = await fetch(path, data === undefined ? { method: "GET", cache: "no-store" } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "HTTP " + response.status);
    return value as T;
  }
  function showError(e: unknown) { get("server-banner").hidden = false; get("server-banner").textContent = e instanceof Error ? e.message : String(e); }
  async function createNote(note: Parameters<OwnerOps["createNote"]>[0]) { sendMessage = ""; try { return await api("/api/notes", note); } catch(e) { showError(e); throw e; } }
  async function deleteNote(id: string) { try { return await api("/api/notes/" + encodeURIComponent(id), {}, "DELETE"); } catch(e) { showError(e); throw e; } }
  function applySnapshot(s: Snapshot) {
    snapshot = s;
    state.meta = s.board;
    state.items = Object.entries(s.items).map(([id,it]) => ({...it,id}));
    state.decisions = Object.entries(s.decisions).map(([id,d]) => ({...d,id}));
    state.notes = Object.entries(s.notes).map(([id,n]) => ({...n,id}));
  }
  let unreadGeneration = 0;
  async function refreshUnread() {
    const generation = ++unreadGeneration;
    const result = await api<{cursor?: string; steps: Step[]}>("/api/unread");
    if (generation !== unreadGeneration) return;
    steps = result.steps; snapshot.owner.cursor = result.cursor;
    if (shownStop && !steps.some(s => shownStop!.startsWith(s.id + "|"))) shownStop = null;
    renderAll();
  }
  async function refreshOwner() { await loadSnapshot(); await refreshUnread(); }
  async function loadDiff(step: Step, doc: Step["docs"][number]) {
    const key = step.id + ":" + doc.kind + ":" + doc.id;
    if (diffs.has(key) || pendingDiffs.has(key)) return;
    pendingDiffs.add(key);
    try {
      const diff = await api<{before: unknown; after: unknown; diff: string}>("/api/step?id=" + step.id + "&kind=" + doc.kind + "&doc=" + encodeURIComponent(doc.id));
      diffs.set(key,diff); renderAll();
    } catch(e) { if (steps.some(s => s.id === step.id)) showError(e); }
    finally { pendingDiffs.delete(key); }
  }
  function unreadLogs(it: ViewItem) {
    const first = steps.find(s => s.docs.some(d => d.kind === "item" && d.id === it.id));
    if (!first) return [];
    const doc = first.docs.find(d => d.kind === "item" && d.id === it.id)!;
    const diff = diffs.get(first.id + ":item:" + it.id);
    if (!diff) { void loadDiff(first,doc); return []; }
    const previous = ((diff.before as Item | null)?.log || []).slice();
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
  // Match occurrences, not just membership: appending an identical log entry is still an addition.
  function entryChanges<T>(before: T[], after: T[]) {
    const removed = before.slice(), added: T[] = [];
    for (const entry of after) {
      const i = removed.findIndex(old => sameValue(old,entry));
      if (i < 0) added.push(entry); else removed.splice(i,1);
    }
    return { removed, added };
  }
  function valueText(value: unknown): string {
    if (value == null) return "未设";
    if (typeof value !== "object") return String(value);
    if (Array.isArray(value)) return value.map(valueText).join("；");
    return Object.values(value).map(valueText).join(" · ");
  }
  function changedFields<T extends object>(box: HTMLElement, before: T | null, after: T | null, fields: Array<[keyof T, string, ((value: unknown) => string)?]>) {
    for (const [key,label,format = valueText] of fields) {
      const a = before?.[key], b = after?.[key];
      if (!sameValue(a,b)) box.appendChild(el("div", "change-field", esc(label) + "：" + inline(format(a)) + " → " + inline(format(b))));
    }
  }
  function headChanges(before: string, after: string) {
    const box = el("div", "head-changes");
    for (const group of lineDiff(before,after)) {
      const content = el("div", "rich change-" + group.kind, blocks(group.lines.join("\n")));
      if (group.kind === "same" && group.lines.length > 3) {
        const fold = el("details", "change-context");
        fold.appendChild(el("summary", null, "… 省略 " + group.lines.length + " 行"));
        fold.appendChild(content); box.appendChild(fold);
      } else box.appendChild(content);
    }
    return box;
  }
  function itemName(value: unknown) { return value == null ? "未设" : snapshot.items[String(value)]?.title || String(value); }
  function askText(value: unknown) {
    const ask = value as Item["ask"];
    return ask ? ask.text + (ask.url ? " · " + ask.url : "") + (ask.chat ? " · 请在对话窗口里确认" : "") : "未设";
  }
  function itemChanges(before: Item | null, after: Item | null) {
    const box = el("div", "document-change"), item = after || before!;
    if (!before || !after) {
      box.appendChild(el("div", "change-label", after ? "新条目" : "已删除条目"));
      const body = el("div", after ? "change-added" : "change-removed");
      if (item.head) body.appendChild(el("div", "rich", blocks(item.head)));
      if (item.log.length) {
        const log = el("div", "log"); log.appendChild(el("div", "log-head", "进展"));
        item.log.slice().sort((a,b) => a.at.localeCompare(b.at)).forEach(e => log.appendChild(logEntry(e,!!after)));
        body.appendChild(log);
      }
      box.appendChild(body);
    } else {
      changedFields(box,before,after,[["title","标题"]]);
    }
    // An item that gained sub-items loses its own status and priority, which are now derived: not a change to show.
    const shown = before && after ? { ...before, ...(after.status === undefined ? { status: undefined } : {}), ...(after.priority === undefined ? { priority: undefined } : {}) } : before;
    changedFields(box,shown,after,[
      ["status","状态", v => v == null ? "未设" : STATUS[String(v)] || String(v)],
      ["priority","优先级"], ["data","数字"], ["ask","请求",askText],
      ["parent","上级",itemName],
      ["group","项目"], ["order","排序"],
    ]);
    if (before && after) {
      if (before.head !== after.head) box.appendChild(headChanges(before.head || "",after.head || ""));
      const log = entryChanges(before.log,after.log);
      for (const kind of ["removed","added"] as const) for (const e of log[kind]) {
        const row = logEntry(e,kind === "added"); row.classList.add("change-" + kind);
        box.appendChild(row);
      }
    }
    const deps = entryChanges(before?.deps || [],after?.deps || []);
    for (const kind of ["removed","added"] as const) for (const dep of deps[kind]) {
      const title = "id" in dep ? itemName(dep.id) : snapshot.decisions[dep.card]?.question || dep.card;
      box.appendChild(el("div", "change-" + kind, "依赖" + (kind === "added" ? "新增" : "移除") + "：" + inline(title) + '<span class="why"> · ' + inline(dep.why) + '</span>'));
    }
    const links = entryChanges(before?.links || [],after?.links || []);
    for (const kind of ["removed","added"] as const) for (const link of links[kind]) {
      const row = el("div", "change-" + kind, "链接" + (kind === "added" ? "新增" : "移除") + "：");
      const a = el("a", null, esc(link.label));
      if (/^https:\/\//.test(link.url)) { a.href = link.url; a.target = "_blank"; a.rel = "noopener"; }
      row.appendChild(a); row.appendChild(el("span", null, " · " + esc(link.url))); box.appendChild(row);
    }
    return box;
  }
  const CARD_STATUS: Record<Decision["status"],string> = { open: "待决定", ruled: "已裁定", withtree: "随设计树处理", elsewhere: "在别处处理" };
  function decisionChanges(before: Decision | null, after: Decision | null, id: string) {
    const box = el("div", "document-change");
    if (!before || !after) {
      box.appendChild(el("div", "change-label", after ? "新决策卡" : "已删除决策卡"));
      const card = decisionCard({...(after || before!),id},true);
      card.classList.add(after ? "change-added" : "change-removed"); box.appendChild(card);
      return box;
    }
    if (after.ruling && (before.ruling !== after.ruling || before.choice !== after.choice)) {
      box.appendChild(el("div", "change-added", "裁决：" + inline(after.ruling)));
      const option = after.options.find(o => o.key === after.choice);
      if (after.choice) box.appendChild(el("div", "change-added", "选择：" + inline(after.choice) + (option ? " · " + inline(option.text) : "")));
    } else {
      changedFields(box,before,after,[["ruling","裁决"],["choice","选择"]]);
    }
    changedFields(box,before,after,[
      ["question","问题"], ["background","背景"],
      ["options","选项", v => (v as Decision["options"]).map(o => o.key + "：" + o.text + (o.recommended ? "（推荐）" : "")).join("；")],
      ["confidence","信心", v => { const c = v as Decision["confidence"]; return c ? (c.score === undefined ? "" : c.score + "/5：") + c.reason : "未设"; }],
      ["status","状态",v => CARD_STATUS[v as Decision["status"]]], ["item","所属条目",itemName],
      ["ruledAt","裁决时间",v => day(v as string | undefined) || "未设"], ["order","排序"], ["at","创建时间",v => day(v as string | undefined) || "未设"],
    ]);
    return box;
  }
  function noteChanges(before: Note | null, after: Note | null) {
    const box = el("div", "document-change");
    if (!before || !after || before.reply !== after.reply || before.text !== after.text) {
      if (!after) box.appendChild(el("div", "change-label", "已删除评论"));
      if (before && after && (before.text !== after.text || before.reply && before.reply !== after.reply)) {
        const old = noteThread(before); old.classList.add("change-removed"); box.appendChild(old);
      }
      const thread = noteThread(after || before!,!!after);
      thread.classList.add(after ? "change-added" : "change-removed"); box.appendChild(thread);
    }
    const noteKind = (v: unknown) => ({ comment: "评论", explain: "详细解释", approve: "同意", choice: "选择", done: "完成" })[v as Note["kind"]] || "未设";
    changedFields(box,before,after,[
      ["state","状态",v => NOTE_STATE[v as Note["state"]] || "未设"], ["kind","类型",noteKind],
      ["target","所属条目",v => v == null ? "未设" : titleOf(String(v))], ["choice","选择"],
      ["repliedBy","回复会话"], ["repliedAt","回复时间",v => day(v as string | undefined) || "未设"],
    ]);
    return box;
  }
  function documentChange(doc: Step["docs"][number], diff: {before: unknown; after: unknown; diff: string}) {
    const box = diff.before === null && diff.after === null ? el("div", "document-change", "本步前后均无此文档") :
      doc.kind === "item" ? itemChanges(diff.before as Item | null,diff.after as Item | null) :
      doc.kind === "decision" ? decisionChanges(diff.before as Decision | null,diff.after as Decision | null,doc.id) :
      noteChanges(diff.before as Note | null,diff.after as Note | null);
    if (!box.children.length && !box.innerHTML) box.appendChild(el("div", "change-same", "其他字段变化"));
    return box;
  }
  function appendStep(parent: HTMLElement, key: string) {
    const st = shownFresh(), step = st && steps.find(s => s.id === st.step);
    if (!st || !step) return;
    const missing = st.item && !snapshot.items[st.item] || st.card && !snapshot.decisions[st.card];
    if ((missing ? "history" : st.container) !== key) return;
    const box = el("section", "unread-step"); box.id = "step:" + st.key; box.dataset.sel = box.id;
    const others = allFreshStops().filter(s => s.step === st.step).length - 1;
    box.appendChild(el("div", "log-meta", esc(day(step.at)) + " · " + esc(step.author) + " · " + step.commits.length + " 次提交" + (others ? " · 同一步还改了 " + others + " 处" : "")));
    {
      const doc = st.doc;
      const diff = diffs.get(step.id + ":" + doc.kind + ":" + doc.id);
      const historical = (diff?.after || diff?.before) as Item | Decision | Note | undefined;
      const title = doc.kind === "item" ? (historical as Item | undefined)?.title || snapshot.items[doc.id]?.title :
        doc.kind === "decision" ? (historical as Decision | undefined)?.question || snapshot.decisions[doc.id]?.question :
        historical ? titleOf((historical as Note).target) : snapshot.notes[doc.id] ? titleOf(snapshot.notes[doc.id]!.target) : undefined;
      box.appendChild(el("div", "sub", esc(title || doc.id) + " · " + esc(doc.summary)));
      box.appendChild(diff ? documentChange(doc,diff) : el("div", "change-same", "正在读取变化…"));
    }
    const read = el("button", "freshbtn", st.last ? "已阅（包括此前所有变化）" : "下一处（这一步看完再标已阅）"); read.type = "button";
    read.addEventListener("click", ev => { ev.stopPropagation(); if (st.last) void markRead("step:" + st.key); else goNextFresh(); }); box.appendChild(read); parent.appendChild(box);
  }
  let retry: ReturnType<typeof setTimeout> | undefined;
  let source: EventSource | undefined;
  let loading = false;
  let eventGeneration = 0;
  async function loadSnapshot() {
    for (;;) {
      const generation = eventGeneration;
      const s = await api<Snapshot>("/api/snapshot");
      if (generation !== eventGeneration) continue;
      applySnapshot(s); connected = true; renderAll(); return;
    }
  }
  function serverDown() {
    connected = false; renderSend();
    get("server-banner").hidden = false;
    get("server-banner").textContent = "wf-board 服务器没有响应，正在重试。";
    source?.close(); source = undefined;
    if (!retry) retry = setTimeout(() => { retry = undefined; void connect(); }, 5000);
  }
  async function connect() {
    if (loading) return; loading = true;
    try {
      await loadSnapshot(); await refreshUnread();
      get("server-banner").hidden = true;
      // Subscribe before a second snapshot so commits between load and subscription are not missed.
      source?.close(); source = new EventSource("/api/events");
      source.onopen = () => { void refreshOwner().catch(serverDown); };
      source.onerror = serverDown;
      source.addEventListener("change", event => {
        eventGeneration++;
        const change = JSON.parse((event as MessageEvent).data) as {commit: string; changed: Array<{kind: string; id: string; after: unknown}>};
        for (const doc of change.changed) {
          if (doc.kind === "board") snapshot.board = doc.after as Board;
          else if (doc.kind === "owner") snapshot.owner = doc.after as OwnerState;
          else {
            const collection = doc.kind === "item" ? snapshot.items : doc.kind === "decision" ? snapshot.decisions : snapshot.notes;
            if (doc.after === null) delete collection[doc.id]; else Object.assign(collection, { [doc.id]: doc.after });
          }
        }
        snapshot.head = change.commit; applySnapshot(snapshot); renderAll(); void refreshUnread().catch(serverDown);
      });
    } catch(e) { serverDown(); } finally { loading = false; }
  }
  void connect();

function get<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
