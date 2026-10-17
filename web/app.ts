import { tagApplies, difficultyText } from "../src/model.ts";
import { agentRows } from "../src/agents.ts";
import type { AgentRow } from "../src/agents.ts";
import { rules, draftEditable, noteTextProblem, changedItemPlan, changedItemTargets, isLogChange, checkLabel, STALLED_LABEL, DerivedCache, applyActivityDelta, affectedItems, changeSeeds, presentationSignature } from "../src/rules.ts";
import type { ActivityDelta, Rules } from "../src/rules.ts";
import { codeBlock } from "./highlight.ts";
import { drawMermaid, watchMermaid } from "./mermaid.ts";
import { compareAt, stopIndex } from "./fresh.ts";
import { findTargets, refQuery, refToken, refsIn, replaceRefs } from "./find.ts";
import { showNotice } from "./notice.ts";
import { progressLine } from "./progress.ts";
import { pageUpdater } from "./update.ts";
import type { OwnerNotice, NoticeEnv } from "./notice.ts";
import { isRefTitle, refSplit } from "./refs.ts";
import type { Target } from "./find.ts";
import type { Snapshot, Item, Decision, Note, Board, OwnerState, LogEntry, Glossary, AgentTouch } from "../src/model.ts";
import type { Step } from "../src/history.ts";
import type { OwnerOps } from "../src/owner-ops.ts";
type ViewItem = Item & { id: string };
type ViewDecision = Decision & { id: string };
type ViewNote = Note & { id: string };
interface ViewState { meta: Board | null; items: ViewItem[]; decisions: ViewDecision[]; notes: ViewNote[] }
interface FreshStop { key: string; step: string; doc: Step["docs"][number]; kinds: string[]; sel: string; item: string | null; card?: string; notes?: string; at: number[] }

  const STATUS: Record<string,string> = { wip: "WIP", done: "DONE", stalled: "STALLED", todo: "TODO", blocked: "BLOCK", paused: "◌ PAUSE", cancelled: "DROP", record: "记录" };
  const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  const state: ViewState = { meta: null, items: [], decisions: [], notes: [] };
  let snapshot: Snapshot = { board: { title: "进度板", projects: [] }, items: {}, decisions: {}, notes: {}, glossaries: {}, owner: {}, head: "" };
  // Keeps the parsed activity times across snapshots, so each new Rules object reads them without rescanning every log.
  const activityCache = new DerivedCache();
  let derived = rules(snapshot);
  let steps: Step[] = [];
  let serverSteps: Step[] = [];
  const pendingReads = new Map<string, { covered: Set<string>; saving: boolean }>();
  function pendingReadCovers(doc: string, step: Step) {
    const overlay = pendingReads.get(doc);
    // A pending mark can split a coalesced step. Wait for the server's split before showing its later portion.
    return overlay && (overlay.covered.has(step.id) || step.commits.some(id => overlay.covered.has(id)));
  }
  function applyReadMarks() {
    steps = serverSteps.flatMap(step => {
      const docs = step.docs.filter(doc => docKinds(doc).length > 0 && !pendingReadCovers(doc.kind + ":" + doc.id, step));
      return docs.length ? [{ ...step, docs }] : [];
    });
    invalidate();
  }
  let shownStop: string | null = null;
  // Where the last stop n showed sits on the page, so the walk continues after it once m has read it.
  let shownAt: number[] | null = null;
  // Which new place inside the shown item n reached last.
  let shownMark = 0;
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
  // Sending changes presentation only. Draft acknowledgements still gate the send,
  // and a refusal reveals the untouched snapshot and any editor again.
  const sentNotes = new Set<string>();
  const sendingDrafts = new Set<string>();
  function sendPending(n: Pick<ViewNote,"id" | "target" | "kind">) {
    return sentNotes.has(n.id) || sendingDrafts.has(draftKey(n.target,n.kind as DraftKind));
  }
  interface DraftEdit { text: string; rev: number }
  const draftEdits = new Map<string, DraftEdit>();
  const pendingEdits = new Map<string, Promise<boolean>>();
  type DraftResult = Awaited<ReturnType<OwnerOps["setDraft"]>>;
  const noteEvents = new Map<string,number>();
  const noteTombstones = new Map<string,number>();
  const draftKey = (target:string,kind:DraftKind) => target + "|" + kind;
  const drafts: Record<string, string> = {};
  let notesOpen: Record<string, boolean> = {};
  // Open 参考 sections, keyed by item and section title, so a re-render keeps what the reader opened.
  let refOpen: Record<string, boolean> = {};
  try { refOpen = JSON.parse(localStorage.getItem("board-refs") || "{}") || {}; } catch (e) { refOpen = {}; }
  document.addEventListener("toggle", ev => {
    const d = ev.target;
    if (!(d instanceof HTMLDetailsElement) || !d.classList.contains("refsec")) return;
    refOpen[d.dataset.ref!] = d.open;
    try { localStorage.setItem("board-refs", JSON.stringify(refOpen)); } catch (e) {}
  }, true);
  try { notesOpen = JSON.parse(localStorage.getItem("board-notes") || "{}") || {}; } catch (e) { notesOpen = {}; }
  // Closed decisions show under their item only when opened from its chip, or while they carry new replies.
  let ruledOpen: Record<string, boolean> = {};
  try { ruledOpen = JSON.parse(localStorage.getItem("board-ruled") || "{}") || {}; } catch (e) { ruledOpen = {}; }
  function saveRuled() { try { localStorage.setItem("board-ruled", JSON.stringify(ruledOpen)); } catch (e) {} }
  // A card any item's plan names unfolds inline under that plan row of the shown item; collapsed until opened, remembered
  // per card, so it is the same card wherever it unfolds.
  let inlineOpen: Record<string, boolean> = {};
  try { inlineOpen = JSON.parse(localStorage.getItem("board-inline-cards") || "{}") || {}; } catch (e) { inlineOpen = {}; }
  function saveInline() { try { localStorage.setItem("board-inline-cards", JSON.stringify(inlineOpen)); } catch (e) {} }
  function cardRowOf(item: string, card: string) { return index().byId.get(item)?.plan.find(row => "card" in row && row.card === card); }
  // Whether the card's own item's plan names it, so its item shows it under that row instead of at the bottom.
  function inPlan(d: Decision & { id: string }) { return !!cardRowOf(d.item, d.id); }
  // The item whose plan the card unfolds under: the shown item when its plan names the card, else the card's own item
  // when its plan does. A card no item holds stays in the list at the bottom.
  function inlineHost(id: string) {
    const d = snapshot.decisions[id];
    if (!d || !snapshot.items[d.item]) return null;
    if (selectedItem && cardRowOf(selectedItem, id)) return selectedItem;
    return cardRowOf(d.item, id) ? d.item : null;
  }
  function inlineShown(d: Decision & { id: string }) { return inlineHost(d.id) !== null && !!inlineOpen[d.id]; }
  // The item a card is reached in: the shown item when the card unfolds in its plan, else the card's own item.
  function cardPlace(id: string) { const host = inlineHost(id); return host === selectedItem && host ? host : snapshot.decisions[id]?.item || null; }
  function planRowId(item: string, row: string) { return "plan-" + encodeURIComponent(JSON.stringify([item, row])); }
  function ruledShown(d: ViewDecision) { return Object.prototype.hasOwnProperty.call(ruledOpen, d.id) ? !!ruledOpen[d.id] : cardFresh(d); }
  let manual: Record<string, boolean> = {};
  try { manual = JSON.parse(localStorage.getItem("board-open") || "{}") || {}; } catch (e) { manual = {}; }
  function saveManual() { try { localStorage.setItem("board-open", JSON.stringify(manual)); } catch (e) {} }

  let treeWidth: number | null = null;
  try { const stored=Number(localStorage.getItem("board-tree-width")); if (Number.isFinite(stored) && stored > 0) treeWidth=stored; } catch {}
  let selectedItem: string | null = null;
  try { selectedItem = localStorage.getItem("board-selected"); } catch {}
  let selectionRestored = false, detailDirty = true;
  function rememberSelected(id: string | null) {
    selectedItem = id;
    try { localStorage.setItem("board-selected", id || ""); } catch {}
  }
  function bodyShown(id: string) { return selectedItem === id; }
  function itemBox(id: string) { return get("detail-it-" + id); }
  function selectItem(id: string) {
    if (!snapshot.items[id]) return;
    if (selectedItem !== id) {
      get("it-" + selectedItem)?.classList.remove("selected");
      rememberSelected(id); detailDirty = true;
      get("item-detail").scrollTop = 0;
    }
    get("it-" + id)?.classList.add("selected");
    if (detailDirty) renderNow("detail");
  }

  function esc(s: unknown) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }
  // What each escape esc writes shows as.
  const ENTITIES: Record<string,string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
  // Inline text: **bold**, `code`, [label](https://...), and [[it:key]] or [[q:key]] references to an item or a decision
  // card. Escaped first, so stored text cannot inject markup.
  function inline(s: unknown) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return replaceRefs(t, refHtml);
  }
  // A reference shows its target's current title as a link; when the key no longer exists it shows the key, struck through.
  function firstLine(s: string) { return s.split("\n").find(l => l.trim()) ?? ""; }
  function refHtml(kind: Target["kind"], key: string) {
    const title = kind === "item" ? snapshot.items[key]?.title : snapshot.decisions[key]?.question;
    if (title === undefined) return '<span class="itemref missing" title="' + (kind === "item" ? "没有这个条目：" : "没有这张决策卡：") + esc(key) + '">' + esc(key) + "</span>";
    return '<a class="itemref" href="#" data-ref="' + (kind === "item" ? "it:" : "q:") + esc(key) + '">' + esc(plain(firstLine(title)) || key) + "</a>";
  }
  // Block text: blank lines split paragraphs, "- " and "1. " lines make lists, ``` fences make code, and a paragraph opening with **label**: shows the label as a subheading.
  function textLines(src: unknown) {
    // A **label**: written mid-paragraph after a sentence end starts its own paragraph, so a section label still reads as a subheading.
    return String(src == null ? "" : src).replace(/\r/g, "").replace(/([。；！？.!?])[ \t]*(\*\*[^*\n]{1,16}\*\*[ \t]*[：:])/g, "$1\n\n$2").split("\n");
  }
  // With a scope (an item's head) its 参考 sections fold shut, each under its title; the scope keeps each one's open state.
  function blocks(src: unknown, scope?: string) {
    const lines = textLines(src);
    if (scope === undefined) return plainBlocks(lines);
    const [head = [], ...refs] = refSplit(lines), at = scope;
    return plainBlocks(head) + refs.map(r => refSection(r, at)).join("");
  }
  function refSection(lines: string[], scope: string) {
    const [title = "", ...body] = lines, key = scope + "\n" + title;
    return '<details class="refsec"' + (refOpen[key] ? " open" : "") + ' data-ref="' + esc(key) + '"><summary>' + inline(title) + '</summary><div class="refbody">' + plainBlocks(body) + "</div></details>";
  }
  function plainBlocks(lines: string[]) {
    const out: string[] = [];
    let para: string[] = [], list: {tag:string;items:Array<{text:string}>} | null = null, code: string[] | null = null, codeInfo = "";
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
      if (code) { if (/^\s*```/.test(line)) { out.push(codeBlock(code, codeInfo)); code = null; } else code.push(line); continue; }
      if (/^\s*```/.test(line)) { flushPara(); flushList(); code = []; codeInfo = line.replace(/^\s*```/, ""); continue; }
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
    if (code) out.push(codeBlock(code, codeInfo));
    flushTable(); flushPara(); flushList();
    return out.join("");
  }
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, html?: string): HTMLElementTagNameMap[K] { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function plain(s: unknown) { return String(s == null ? "" : s).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`]/g, ""); }
  function day(iso: string | undefined) { return iso ? String(iso).slice(0, 16).replace("T", " ") : ""; }

  // Rendering indexes adapt the shared rules' ids into page view objects.
  let memo: Record<string, unknown> = {};
  function invalidate() { memo = {}; const s = snapshot; derived = rules(s, Date.now(), { activity: () => activityCache.activity(s) }); }
  function cached<T>(name: string, make: () => T): T { return name in memo ? memo[name] as T : (memo[name] = make()) as T; }
  function index() {
    return cached("index", () => {
      const byId = new Map(state.items.map(i => [i.id, i]));
      const children = new Map<string, ViewItem[]>();
      for (const id of ["", ...byId.keys()]) children.set(id, (id ? derived.children(id) : derived.areas()).map(k => byId.get(k)!).filter(Boolean));
      const notesBy = new Map<string, ViewNote[]>();
      state.notes.forEach(n => { const list = notesBy.get(n.target) || []; list.push(n.state === "draft" && sendPending(n) ? {...n,state:"sent"} : n); notesBy.set(n.target, list); });
      return { byId, children, notesBy, decById: new Map(state.decisions.map(d => [d.id, d])) };
    });
  }
  function up(it: ViewItem) { return derived.parentOf(it.id) || ""; }
  function upItem(it: ViewItem) { return index().byId.get(derived.parentOf(it.id) || "") || null; }
  function notesOf(key: string) { return index().notesBy.get(key) || []; }
  function headOf(it: ViewItem) { return it.head || ""; }
  function logOf(it: ViewItem) { return it.log.slice().sort((a,b) => a.at.localeCompare(b.at)); }
  function latestOf(it: ViewItem) { return [it.updated, ...it.log.map(e => e.at), ...notesOf("it:" + it.id).filter(n => n.reply).map(n => n.repliedAt || n.sentAt || n.at)].sort().at(-1)!; }
  function statusOf(it: ViewItem) { return derived.statusOf(it.id); }
  function isCancelled(it: ViewItem) { return statusOf(it) === "cancelled"; }
  function leavesOf(it: ViewItem) { return state.items.filter(i => derived.isStatusLeaf(i.id) && (i.id === it.id || derived.ancestors(i.id).includes(it.id))); }
  function priorityOf(it: ViewItem) { return derived.priorityOf(it.id); }
  function openWorkAncestors() {
    return cached("openWorkAncestors", () => new Set(state.items.filter(it => derived.isOpenWork(it.id)).flatMap(it => derived.ancestors(it.id))));
  }
  // Closed owners remain a path to open work, including through other closed owners. A done or cancelled item also
  // shows, dimmed, while it or anything under it holds content the owner has not read (owner, 2026-10-14), so n and the
  // new-content counts only reach rows on screen and the news of a completion is not lost; once read, it hides again.
  function freshPath() {
    return cached("freshPath", () => new Set(allFreshStops().filter(st => st.kinds.some(fon) && st.item && index().byId.has(st.item)).flatMap(st => [st.item!, ...derived.ancestors(st.item!)])));
  }
  function shownForFresh(it: ViewItem) { return ended(it) && !openWorkAncestors().has(it.id) && freshPath().has(it.id); }
  function visible(it: ViewItem) { return !ended(it) || openWorkAncestors().has(it.id) || freshPath().has(it.id); }
  function byPriority(a: ViewItem,b: ViewItem) { return derived.compareSiblings(a.id,b.id); }
  function kids(id: string, all = false) { return (index().children.get(id || "") || []).filter(i => all || visible(i)); }
  function openQ(q: string) { return snapshot.decisions[q]?.status === "open"; }
  function askPending(it: ViewItem) { return derived.askPending(it.id); }
  function sendingChoice(id:string) { return sendingDrafts.has(draftKey("q:"+id,"choice")) || state.notes.some(n => n.target === "q:"+id && n.kind === "choice" && sentNotes.has(n.id)); }
  function waitsQ(d: ViewDecision) { return !sendingChoice(d.id) && derived.cardWaiting(d.id); }
  const ended = (it: ViewItem) => /^(done|cancelled)$/.test(statusOf(it) ?? "");
  function ancestors(it: ViewItem) { return derived.ancestors(it.id).map(k => index().byId.get(k)!); }
  function lineOf(it: ViewItem) { return index().byId.get(derived.lineOf(it.id))!; }
  function groupOf(it: ViewItem) { return derived.groupOf(it.id); }
  function isLeaf(it: ViewItem) { return derived.isLeaf(it.id); }
  function waitedBy() { return cached("waitedBy", () => new Map(state.items.map(i => [i.id, derived.dependents(i.id).map(d => index().byId.get(d.id)!)]))); }
  function depEntries(it: ViewItem) { return derived.depsOf(it.id); }
  function openDeps(it: ViewItem) { return depEntries(it).filter(e => e.open).flatMap(e => {
    const id = e.kind === "item" ? e.id : snapshot.decisions[e.id]?.item;
    const target = id ? index().byId.get(id) : undefined;
    return target ? [target] : [];
  }); }
  function openWaiters(it: ViewItem) { return (waitedBy().get(it.id) || []).filter(w => !ended(w)); }
  function outDeps(it: ViewItem) { return openDeps(it).filter(d => !derived.ancestors(d.id).includes(it.id)); }
  function outWaiters(it: ViewItem) { return openWaiters(it).filter(w => !derived.ancestors(it.id).includes(w.id)); }
  function checksOf(it: ViewItem) { return derived.checks(it.id); }
  // The first unread step holding each document ("kind:id"), and the baselines of all steps, built once per data change:
  // rendering asks for them per item, card and comment, and a pass over every step each time grows with the backlog.
  function firstSteps() {
    return cached("firstSteps", () => {
      const first = new Map<string, {step:Step;doc:Step["docs"][number]}>();
      for (const step of steps) for (const doc of step.docs) if (!first.has(doc.kind + ":" + doc.id)) first.set(doc.kind + ":" + doc.id, {step, doc});
      return first;
    });
  }
  function stepBaselines() { return cached("stepBaselines", () => new Set(steps.flatMap(step => step.docs.map(doc => baselineKey(step,doc))))); }
  function touched(kind: string,id: string) { return firstSteps().has(kind + ":" + id); }
  function cardNew(d: ViewDecision) { return touched("decision",d.id); }
  function cardFresh(d: ViewDecision) { return cardNew(d) || notesOf("q:" + d.id).some(n => touched("note",n.id)); }
  function noteFresh(n: ViewNote) {
    const before = unreadBefore<Note>("note",n.id);
    return { created: before === null, reply: before !== undefined && !!n.reply && before?.reply !== n.reply };
  }
  function newReplies(key: string) { return notesOf(key).filter(n => noteFresh(n).reply); }
  function newNotes(key: string) { return notesOf(key).filter(n => noteFresh(n).created); }
  // How many new things a document holds (server-counted; derived from the summary for a step without counts).
  function piecesOf(doc: Step["docs"][number]): {progress:number;reply:number;other:number} {
    if (doc.pieces) return { progress: doc.pieces.progress ?? 0, reply: doc.pieces.reply, other: doc.pieces.other };
    const k = legacyKinds(doc);
    return { progress: k.includes("progress") ? 1 : 0, reply: k.includes("reply") ? 1 : 0, other: k.includes("other") ? 1 : 0 };
  }
  function docKinds(doc: Step["docs"][number]): string[] { const p = piecesOf(doc); return (["progress","reply","other"] as const).filter(k => p[k] > 0); }
  // The pieces of a stop the kind filter keeps: what the 新 counts add up.
  // 新 counts items: an item with any unread change in itself, its cards or their comments is one, however many changes
  // it holds. A change no item holds (a card without an item, a deleted document) is one on its own.
  function unitOf(st: FreshStop) { return st.item && snapshot.items[st.item] ? "it:" + st.item : st.card && snapshot.decisions[st.card] ? "q:" + st.card : st.doc.kind + ":" + st.doc.id; }
  function countOf(list: FreshStop[]) { return new Set(list.map(unitOf)).size; }
  function legacyKinds(doc: Step["docs"][number]): string[] {
    const kinds = new Set<string>();
    const changes = doc.summary.split(", ");
    const reply = changes.includes("new reply") || changes.includes("reply changed");
    for (const change of changes) {
      if (isLogChange(change)) continue;
      else if (change === "plan changed" || change === "targets changed") kinds.add("progress");
      else if (/^(new reply|reply changed)$/.test(change)) kinds.add("reply");
      else if (!(doc.kind === "note" && reply && change === "state changed")) kinds.add("other");
    }
    return [...kinds];
  }
  // The item and card keys ("it:<item>", "q:<card>") whose new content a stop is part of: an item holds its own changes, its
  // cards' and the comments on either; a card holds its own changes and its comments.
  function touchKeys(st: FreshStop): string[] {
    const doc = st.doc;
    if (doc.kind === "item") return ["it:" + doc.id];
    if (doc.kind === "decision") { const item = snapshot.decisions[doc.id]?.item; return ["q:" + doc.id, ...(item === undefined ? [] : ["it:" + item])]; }
    const target = snapshot.notes[doc.id]?.target;
    if (target === undefined) return [];
    const item = snapshot.decisions[target.slice(2) || ""]?.item;
    return [target, ...(item === undefined ? [] : ["it:" + item])];
  }
  // Each project group has its own filters, under its heading. They narrow its tree to the matching items, with the
  // path to each kept, dimmed: any number of status filters (a match on any of them), and one dependency filter on top.
  // Closed nodes show under their status filters or as a path to open work; their plan rows always show.
  let filters: Record<string, {status:string[];dep:string;tags?:string[]}> = {};
  try { filters = JSON.parse(localStorage.getItem("board-filters2") || "{}") || {}; } catch (e) {}
  function groupFilter(g: string) { const f=filters[g || ""]; return f ? {...f,status:f.status.filter(k => STATUS_FILTERS.some(([key]) => key === k)),tags:(f.tags ?? []).filter(t => (snapshot.board.tags ?? []).some(v => v.name === t))} : { status: [], dep: "", tags: [] as string[] }; }
  const WEEK = 7 * 24 * 3600 * 1000;
  type Filter = [string,string,string,(it:ViewItem)=>boolean];
  const STATUS_FILTERS: Filter[] = [
    ["wip", "进行中", "进行中的条目", it => statusOf(it) === "wip"],
    ["blocked", "卡住", "卡住的条目", it => statusOf(it) === "blocked"],
    ["paused", "暂停", "由主人暂停的条目，包括暂停条目的下级", it => statusOf(it) === "paused"],
    ["stalled", "停滞", "做完了一部分、现在没人在做的条目", it => statusOf(it) === "stalled"],
    ["todo", "未开始", "什么都还没做、也没人在做的条目", it => statusOf(it) === "todo"],
    ["done", "完成", "所有完成的条目", it => statusOf(it) === "done"],
    ["done7", "7 天内完成", "最近 7 天完成的条目", it => statusOf(it) === "done" && Date.parse(latestOf(it)) > Date.now() - WEEK],
    ["cancelled", "取消", "取消的条目", it => statusOf(it) === "cancelled"]
  ];
  const DEP_FILTERS: Filter[] = [
    ["chain", "阻塞链", "只看依赖下级以外的工作、被上级以外的条目依赖或卡住的条目", it => !ended(it) && (outDeps(it).length > 0 || outWaiters(it).length > 0 || (isLeaf(it) && statusOf(it) === "blocked"))],
    ["cross", "跨项目依赖", "只看依赖或被依赖跨了项目的条目", it => !ended(it) && (openDeps(it).some(d => groupOf(d) !== groupOf(it)) || openWaiters(it).some(w => groupOf(w) !== groupOf(it)))],
    ["check", "需核对", "只看状态和依赖对不上、或依赖写错的条目", it => checksOf(it).length > 0]
  ];
  function filtering(g: string) { const f = groupFilter(g); return f.status.length > 0 || !!f.dep || f.tags.length > 0; }
  function anyFiltering() { return Object.keys(filters).some(filtering); }
  function matches(it: ViewItem) {
    const f = groupFilter(groupOf(it));
    const st = f.status.length ? STATUS_FILTERS.some(([k, , , fn]) => f.status.includes(k) && fn(it)) : !ended(it);
    const d = DEP_FILTERS.find(x => x[0] === f.dep);
    return st && (!d || d[3](it)) && (!f.tags.length || f.tags.some(t => it.tags?.includes(t)));
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
  function filterCount(list: Filter[], key: string, g: string) { const f = list.find(x => x[0] === key); return state.items.filter(it => groupOf(it) === g && f![3](it)).length; }
  function passes(it: ViewItem) { return filtering(groupOf(it)) ? filterMatches().keep.has(it.id) : visible(it); }
  function saveFilters() { rulePresentationDirty=true; try { localStorage.setItem("board-filters2", JSON.stringify(filters)); } catch (e) {} invalidate(); renderNow("areas",...(selectedItem ? ["head:"+selectedItem] : [])); }
  function toggleStatusFilter(g: string, key: string) { const f = groupFilter(g); filters[g] = { status: f.status.includes(key) ? f.status.filter(k => k !== key) : f.status.concat(key), dep: f.dep, tags: f.tags }; saveFilters(); }
  // Tag filters keep items carrying any selected tag.
  function toggleTagFilter(g: string, name: string) { const f = groupFilter(g); filters[g] = { status: f.status, dep: f.dep, tags: f.tags.includes(name) ? f.tags.filter(t => t !== name) : f.tags.concat(name) }; saveFilters(); }
  function setDepFilter(g: string, key: string) { const f = groupFilter(g); filters[g] = { status: f.status, dep: f.dep === key ? "" : key, tags: f.tags }; saveFilters(); }
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
    (snapshot.board.tags ?? []).filter(t => tagApplies(t, g)).forEach(t => {
      const n = state.items.filter(it => groupOf(it) === g && it.tags?.includes(t.name)).length, on = f.tags.includes(t.name);
      if (n || on) { const b = btn(on, esc(t.name) + " " + n, t.meaning + "（可多选，显示带任一所选标签的条目）", () => toggleTagFilter(g, t.name)); b.classList.add("tagfilter"); row.appendChild(b); }
    });
    if (filtering(g)) row.appendChild(btn(false, "清除筛选", "", () => { clearFilters(g); renderNow("areas",...(selectedItem ? ["head:"+selectedItem] : [])); }));
    return row;
  }
  const byOrder = (a: {order?:number}, b: {order?:number}) => (a.order || 0) - (b.order || 0);
  // For each item, how many waiting and new stops lie below it; recomputed once per render.
  let below: {fresh: Record<string,number>} = {fresh:{}};
  function countBelow() {
    const byId = new Map(state.items.map(i => [i.id, i]));
    const tally = <T extends {item: string | null}>(list: T[], into: Record<string,number>, weight: (x: T) => number) => list.forEach(x => { const it = x.item && byId.get(x.item); if (it) ancestors(it).forEach(a => { into[a.id] = (into[a.id] || 0) + weight(x); }); });
    below = { fresh: {} };
    const freshItems = [...new Set(freshStops().map(st => st.item && snapshot.items[st.item] ? st.item : null).filter((id): id is string => !!id))];
    tally(freshItems.map(item => ({item})), below.fresh, () => 1);
  }
  // Top-level items, in their project group's order (the order of the group's first item), then their own order.
  function tops() { return derived.areas(id => passes(index().byId.get(id)!)).map(id => index().byId.get(id)!); }
  function boardOrder() { return cached("boardOrder", boardOrderNow); }
  function boardOrderNow() {
    const out: ViewItem[] = [];
    const walk = (list: ViewItem[]) => list.forEach(i => { out.push(i); walk(kids(i.id,true)); });
    const roots=derived.areas().map(id => index().byId.get(id)!);
    const groups=[...new Set([...snapshot.board.projects.map(g => g.name),...roots.map(groupOf)])];
    for (const group of groups) {
      const items=roots.filter(it => groupOf(it) === group);
      walk([...items.filter(it => !neededElsewhere(it)),...items.filter(neededElsewhere)]);
    }
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
    // Blocking waits come first, so 阻塞 and the arrow keys walk them before the decision cards that block nothing.
    return [...out.filter(blockingStop), ...out.filter(st => !blockingStop(st))];
  }
  // An ask always blocks; a card blocks when it names the work it stops (its blocks).
  function blockingStop(st: {id:string}) { return st.id.startsWith("ask-") || derived.cardBlocking(st.id.slice(2)); }
  // Unread steps stay in commit order, independent of tree and filter order.
  // Which kinds of new things the 新 walk and counts include, picked like the project filters: replies to the owner's
  // notes (reply), item step and target changes (progress) and every other change (other); none picked means all of them.
  const FRESH_KINDS: Array<[string,string,string]> = [["reply", "评论回复", "只看对你评论的新回复"], ["progress", "进展", "只看步骤和目标数字改动"], ["other", "其他", "只看正文、标题、状态等其他改动"]];
  let freshSel: string[] = [];
  try { freshSel = (JSON.parse(localStorage.getItem("board-fresh-sel") || "[]") || []).map((k: string) => k === "log" ? "progress" : k).filter((k: string) => FRESH_KINDS.some(f => f[0] === k)); } catch (e) {}
  function fon(kind: string) { return !freshSel.length || freshSel.includes(kind); }
  function setFreshSel(sel: string[]) {
    freshSel = sel.length === FRESH_KINDS.length ? [] : sel;
    try { localStorage.setItem("board-fresh-sel", JSON.stringify(freshSel)); } catch (e) {}
    renderAll();
  }
  function toggleFresh(kind: string) { setFreshSel(freshSel.includes(kind) ? freshSel.filter(k => k !== kind) : freshSel.concat(kind)); }
  // Each document with unread changes is one stop, holding the pieces of every step that changed it, shown under its
  // own item or card. Stops follow the page from top to bottom: an item, then its comments, then each of its cards and
  // that card's comments; what the page does not place comes last, in commit order. Closed items remain stops even
  // while their tree nodes are hidden. A document read leaves it unread in history.
  function allFreshStops() { return cached("allFreshStops", freshStopsNow); }
  // n and every new-content count follow the left tree as shown: a stop counts only when its item, and every item above
  // it, passes the project's filters; unfiltered, every item holding new content is shown (see visible).
  function treeShown(id: string) { const it = index().byId.get(id); return !!it && passes(it) && ancestors(it).every(passes); }
  function freshStops() { return cached("freshStops", () => allFreshStops().filter(st => st.kinds.some(fon) && (!st.item || !index().byId.has(st.item) || treeShown(st.item)))); }
  // The stops indexed once per data change, so n, the chips and the blue lines look a stop up instead of passing over
  // every stop for each key press, item and card: each stop's place and the next one by page position (freshIndex), the
  // first stop that is part of each item or card (touching), and the first stop in each item's subtree (under).
  function allFreshIndex() { return cached("allFreshIndex", () => stopIndex(allFreshStops())); }
  function freshIndex() {
    return cached("freshIndex", () => {
      const all = freshStops(), touching = new Map<string, number>(), under = new Map<string, number>();
      all.forEach((st, k) => {
        for (const key of touchKeys(st)) if (!touching.has(key)) touching.set(key, k);
        if (st.item) for (const id of [st.item, ...derived.ancestors(st.item)]) if (!under.has(id)) under.set(id, k);
      });
      return { ...stopIndex(all), touching, under };
    });
  }
  function freshShown(i: ViewItem) { return freshIndex().touching.has("it:" + i.id); }
  function freshStopsNow(): FreshStop[] {
    const place = new Map<string, number>();
    boardOrder().forEach((it, k) => { if (!place.has(it.id)) place.set(it.id, k); });
    const merged = new Map<string, FreshStop>();
    steps.forEach((step, k) => step.docs.forEach(d => {
      const key = d.kind + ":" + d.id, seen = merged.get(key);
      if (seen) {
        const a = piecesOf(seen.doc), b = piecesOf(d);
        seen.doc = { ...d, summary: seen.doc.summary + ", " + d.summary, pieces: { progress: a.progress + b.progress, reply: a.reply + b.reply, other: a.other + b.other } };
        seen.kinds = docKinds(seen.doc); seen.step = step.id;
        return;
      }
      let card: string | undefined, item: string | null = null, notes: string | undefined;
      if (d.kind === "item") item = d.id;
      if (d.kind === "decision") { card = d.id; item = snapshot.decisions[d.id]?.item || null; }
      if (d.kind === "note") { const n = snapshot.notes[d.id]; notes = n?.target; if (notes?.startsWith("q:")) { card = notes.slice(2); item = snapshot.decisions[card]?.item || null; } else item = notes?.slice(3) || null; }
      const row = item !== null && place.has(item) ? place.get(item)! : Number.MAX_SAFE_INTEGER;
      // Page order inside an item: the item, the cards its plan unfolds (in plan order), its own comments, then its other cards.
      const planned = item ? (snapshot.items[item]?.plan ?? []).filter(row => "card" in row && snapshot.decisions[row.card]?.item === item).map(row => (row as {card:string}).card) : [];
      const cardRank = card ? planned.includes(card) ? 1 + planned.indexOf(card) : 1 + planned.length + 1 + Math.max(0, item ? derived.cardsOf(item).indexOf(card) : 0) : d.kind === "note" ? 1 + planned.length : 0;
      merged.set(key, { key, step: step.id, doc: d, kinds: docKinds(d), sel: d.kind === "item" ? "it:" + d.id : d.kind === "decision" ? "q:" + d.id : "note:" + d.id, item, card, notes,
        at: [row, cardRank, d.kind === "note" ? 1 : 0, row === Number.MAX_SAFE_INTEGER ? k : 0] });
    }));
    return [...merged.values()].sort((a, b) => compareAt(a.at, b.at));
  }

  function noteElementId(id:string) { return "note-"+id.replace(/[^A-Za-z0-9_-]/g,"_"); }
  function noteId(n: ViewNote) { return noteElementId(n.id); }
  // The element a stop selects, once its item, card and comment list are open.
  function stopEl(st: FreshStop) { return selEl(st.sel); }
  async function goFresh(k: number) {
    const all = freshStops();
    if (!all.length) return;
    const st = all[((k % all.length) + all.length) % all.length]!;
    shownStop = st.key; shownAt = st.at; shownMark = 0;
    await navigate({id:st.doc.kind === "note" ? noteElementId(st.doc.id) : st.card ? "q-"+st.card : "it-"+st.doc.id,item:st.item,card:st.card,notes:st.notes,note:st.doc.kind === "note" ? st.doc.id : undefined,marks:st.doc.kind === "item" ? st.doc.id : undefined},() => shownStop === st.key && allFreshIndex().position.has(st.key));
  }
  interface NavigationTarget { id:string; item:string | null; card?:string; notes?:string; note?:string; selection?:string; marks?:string }
  // The new places inside a changed item, top to bottom: a changed status, title or body block, a new or changed step or target, an added
  // dependency or link. Its cards and comments are stops of their own. A new item has none: n lands on its start.
  function freshMarks(box: HTMLElement, id: string) {
    if (unreadBefore<Item>("item", id) === null) return [];
    return [...box.querySelectorAll<HTMLElement>(".chg-add, .plan-row.newbar, .item-target.newbar, .refs .fresh")].filter(m => m.closest(".item") === box && !m.closest(".card, .notes"));
  }
  async function navigate(target:NavigationTarget, valid:() => boolean = () => true) {
    const navigation=++freshNavigation;
    const active=() => navigation === freshNavigation && valid();
    const retry=new Set(failedDiffs);
    clearCurrent();
    // A card the shown item's plan names is reached there, unfolded under its row, rather than in the card's own item.
    if (target.card && selectedItem && inlineHost(target.card) === selectedItem) target={...target,item:selectedItem};
    const it=target.item && index().byId.get(target.item);
    if (it) {
      if (!ended(it) && !passes(it)) clearFilters(groupOf(it));
      openPath(it.id);
      selectItem(it.id);
    }
    if (target.card) {
      const d=index().decById.get(target.card);
      if (d && d.status !== "open") { ruledOpen[d.id]=true; saveRuled(); }
      // A card its item's plan names is reached unfolded under its plan row.
      if (d && it && inlineHost(d.id) === it.id && !inlineOpen[d.id]) { inlineOpen[d.id]=true; saveInline(); }
    }
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
    const primary=it && target.id === "it-"+it.id ? itemBox(it.id) : get(target.id);
    const e=target.selection ? selEl(target.selection) || primary : primary;
    if (!e) return;
    if (it) {
      const row=get("it-"+it.id);
      if (row) {
        const y=scrollToShow(listScroller(),row.getBoundingClientRect());
        if (y !== null) listScroller().to(y);
      }
    }
    glideToTarget(target.marks && freshMarks(e, target.marks)[0] || e);
    setCurrent(target.note || target.selection ? e : e.closest<HTMLElement>(".card, .item"));
  }
  function navigationBaselines(st: NavigationTarget) {
    const required = new Map<string,{step:Step;doc:Step["docs"][number]}>();
    const add = (kind: Step["docs"][number]["kind"], id: string) => {
      const first = firstSteps().get(kind + ":" + id);
      if (first) required.set(baselineKey(first.step,first.doc),first);
    };
    const notes = (key:string) => {
      // An explicit fold stays folded as marks load; an unspecified list may still auto-open for fresh content.
      if (notesOpen[key] === false) return;
      notesOf(key).filter(listed).forEach(n => add("note",n.id));
    };
    const card = (id:string) => { if (!get("q-" + id)) return; add("decision",id); notes("q:" + id); };
    // Only the selected item's rendered body and its expanded comment list need baselines.
    if (st.item && itemBox(st.item) && bodyShown(st.item)) {
      notes("it:" + st.item);
      add("item",st.item);
      derived.cardsOf(st.item).forEach(card);
    }
    if (st.card) card(st.card);
    if (st.note && snapshot.notes[st.note]) add("note",st.note);
    return required;
  }
  // An item's one chip counts the items with something new in its subtree, itself included; a card no item holds has a
  // chip of its own. A click opens the first new place there, in page order.
  function freshChip(key: string, n: number, own: boolean) {
    const id = key.startsWith("it:") ? key.slice(3) : null;
    // Read when clicked: an incremental repaint elsewhere can move the stops this chip was drawn against.
    const firstNow = () => id ? freshIndex().under.get(id) : freshIndex().touching.get(key);
    const first = firstNow();
    const c = el("span", "newtag freshchip", String(Math.max(1, n)));
    c.title = own ? "这一条有新内容" + (n > 1 ? "，下面的子条目还有 " + (n - 1) + " 条" : "") + "；点一下到第一处，n 走到下一处，m 把这一条标为已阅（子条目不动）"
      : "这一条本身没有新内容，下面的子条目有 " + n + " 条；点一下到第一处，在子条目上按 m";
    c.title=Math.max(1,n)+" 处新内容；"+c.title; c.setAttribute("aria-label",c.title);
    if (first !== undefined) {
      c.setAttribute("role", "button"); c.tabIndex = 0;
      const go = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); const now = firstNow(); if (now !== undefined) goFresh(now); };
      c.addEventListener("click", go);
      c.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") go(ev); });
    }
    return c;
  }
  // Clicks per purple or red number, kept across repaints, so repeated clicks walk the stops it counts.
  const chipClicks = new Map<string, number>();
  function shownFresh() { const k = shownStop === null ? undefined : allFreshIndex().position.get(shownStop); return k === undefined ? null : allFreshStops()[k]!; }
  function selectedDocument() {
    // Deleted documents have no selectable body, but n still exposes their logical stop before the displayed item.
    const st = shownFresh();
    if (!current && st && !(st.doc.kind === "item" ? snapshot.items[st.doc.id] : st.doc.kind === "decision" ? snapshot.decisions[st.doc.id] : snapshot.notes[st.doc.id])) return st.doc.kind + ":" + st.doc.id;
    const key=effectiveSelection();
    if (key?.startsWith("it:")) return "item:" + key.slice(3);
    if (key?.startsWith("q:")) return "decision:" + key.slice(2);
    if (key?.startsWith("note:")) return key;
    if (key?.startsWith("log:") || key?.startsWith("row:")) return "item:" + key.slice(4, key.indexOf("@"));
    return null;
  }
  // What m reads: the whole item holding the selection, with everything new inside it (its own changes, its cards and
  // the comments on both) but not its sub-items; a card no item holds; or the deleted document n is showing.
  function selectedUnit() {
    const doc = selectedDocument(); if (!doc) return null;
    const kind = doc.slice(0, doc.indexOf(":")), id = doc.slice(doc.indexOf(":") + 1);
    const ofCard = (card: string) => { const it = snapshot.decisions[card]?.item; return it && snapshot.items[it] ? "it:" + it : "q:" + card; };
    if (kind === "item") return snapshot.items[id] ? "it:" + id : doc;
    if (kind === "decision") return snapshot.decisions[id] ? ofCard(id) : doc;
    const target = snapshot.notes[id]?.target;
    if (target?.startsWith("it:") && snapshot.items[target.slice(3)]) return target;
    if (target?.startsWith("q:")) return ofCard(target.slice(2));
    return doc;
  }
  async function markRead() {
    const unit = selectedUnit();
    const docs = unit ? [...new Set(allFreshStops().filter(st => unitOf(st) === unit).map(st => st.doc.kind + ":" + st.doc.id))] : [];
    if (!docs.length) {
      const id = unit?.startsWith("it:") ? unit.slice(3) : null;
      const below = id ? countOf(freshStops().filter(st => st.item && derived.ancestors(st.item).includes(id))) : 0;
      showHint(below ? "这一条本身没有新内容；新的 " + below + " 条在下面的子条目里，按 n 过去" : "这里没有新内容");
      return false;
    }
    return (await Promise.all(docs.map(markDocRead))).every(Boolean);
  }
  async function markDocRead(doc: string) {
    if (pendingReads.get(doc)?.saving) return false;
    const latest = steps.findLast(step => step.docs.some(d => d.kind + ":" + d.id === doc));
    if (!latest) return false;
    const selected = latest.docs.find(d => d.kind + ":" + d.id === doc)!;
    const scope = scopeForDoc(selected.kind, selected.id, snapshot.notes[selected.id]?.target);
    if (!scope.length) scope.push("header");
    const previous = pendingReads.get(doc);
    const overlay = { covered: new Set(serverSteps.slice(0, serverSteps.findIndex(step => step.id === latest.id) + 1).map(step => step.id)), saving: true };
    pendingReads.set(doc, overlay);
    freshNavigation++;
    applyReadMarks(); renderNow(...scope);
    try {
      await api("/api/read", { doc, through: latest.id });
      overlay.saving = false;
      if (shownStop && !allFreshIndex().position.has(shownStop)) shownStop = null;
      // A GET begun before acknowledgement must not supply the authoritative read result.
      unreadGeneration++; unreadFlight = undefined;
      void refreshOwner().catch(showError);
      return true;
    } catch (e) {
      if (pendingReads.get(doc) === overlay) {
        if (previous) pendingReads.set(doc, previous); else pendingReads.delete(doc);
      }
      applyReadMarks(); renderNow(...scope); showError(e);
      return false;
    }
  }
  async function readThrough(step: string) {
    if (!steps.some(s => s.id === step)) return false;
    freshNavigation++;
    try { await api("/api/read", { through: step }); shownStop = null; void refreshOwner().catch(showError); return true; } catch (e) { showError(e); return false; }
  }
  // n and its reverse step from the stop shown last; once m has read it, from where it stood on the page.
  function shownPlace() { return shownStop === null ? -1 : freshIndex().position.get(shownStop) ?? -1; }
  // When the owner selected another item since n last landed (a click in the tree), n starts from that item: the
  // first stop at or below its row, and its reverse the last stop above it (owner, 2026-10-14).
  function selectionRow() {
    if (!selectedItem) return null;
    const all = freshStops(), at = shownPlace(), landed = at >= 0 ? all[at]!.item : null;
    if (landed === selectedItem) return null;
    const row = boardOrder().findIndex(it => it.id === selectedItem);
    return row < 0 ? null : row;
  }
  function goNextFresh() {
    const all = freshStops(); if (!all.length) return;
    const row = selectionRow();
    if (row !== null) { const k = all.findIndex(st => st.at[0]! >= row && st.at[0]! < Number.MAX_SAFE_INTEGER); goFresh(k < 0 ? 0 : k); return; }
    const at = shownPlace();
    if (at >= 0) {
      // Inside a changed item, n first visits its remaining new places.
      const st = all[at]!, box = st.doc.kind === "item" ? itemBox(st.doc.id) : null;
      const marks = box ? freshMarks(box, st.doc.id) : [];
      if (shownMark + 1 < marks.length) { shownMark++; glideToTarget(marks[shownMark]!); return; }
      goFresh(at + 1); return;
    }
    const after = shownAt ? freshIndex().after(shownAt) : 0;
    goFresh(after < 0 ? 0 : after);
  }
  function goPrevFresh() {
    const all = freshStops(); if (!all.length) return;
    const row = selectionRow();
    if (row !== null) { let k = -1; all.forEach((st, i) => { if (st.at[0]! < row) k = i; }); goFresh(k < 0 ? all.length - 1 : k); return; }
    const at = shownPlace();
    if (at >= 0) { goFresh(at - 1); return; }
    const before = shownAt ? freshIndex().before(shownAt) : -1;
    goFresh(before < 0 ? all.length - 1 : before);
  }

  // The selection: an item (it:), a card (q:), a log entry (log:<item>@<time>) or a comment or reply (note:<id>).
  // m, c and e act on it, or on the item or card that holds it.
  let current: string | null = null;
  function effectiveSelection() { return current ?? (selectedItem && snapshot.items[selectedItem] ? "it:"+selectedItem : null); }
  function keyOfBox(box: HTMLElement | null) { return !box ? null : box.dataset.sel || (box.id.startsWith("q-") ? "q:" + box.id.slice(2) : box.id.startsWith("it-") ? "it:" + box.id.slice(3) : null); }
  function selEl(key: string | null) {
    if (!key) return null;
    if (key.startsWith("it:")) return itemBox(key.slice(3)) || get("it-"+key.slice(3));
    if (key.startsWith("q:")) return get("q-" + key.slice(2));
    return document.querySelector<HTMLElement>('[data-sel="' + CSS.escape(key) + '"]');
  }
  function boxOfKey(key: string | null) { return selEl(key); }
  // The item or card a selection belongs to.
  function containerOf(key: string | null) {
    if (!key) return null;
    if (key.startsWith("it:") || key.startsWith("q:")) return key;
    if (key.startsWith("log:")) return "it:" + key.slice(4, key.indexOf("@"));
    if (key.startsWith("row:")) return "it:" + key.slice(4, key.indexOf("@"));
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
    clearSelectionClasses();
    current = key;
    box.classList.add("cur");
    if (key === "it:"+selectedItem) get("it-"+selectedItem)?.classList.add("cur");
  }
  function onScreen(e: HTMLElement | null) {
    if (!e) return false;
    const s=get("item-detail").contains(e) ? detailScroller() : listScroller();
    const r = e.getBoundingClientRect();
    return r.bottom > s.origin() && r.top < s.origin() + s.height();
  }
  function clearSelectionClasses() {
    selEl(current)?.classList.remove("cur");
    if (current?.startsWith("it:")) get("it-"+current.slice(3))?.classList.remove("cur");
  }
  function clearCurrent() { clearSelectionClasses(); current = null; }
  function clearSelectedItem() {
    clearCurrent();
    get("it-"+selectedItem)?.classList.remove("selected");
    rememberSelected(null);
    // Keep n/N's place, but no logical stop remains selected for m.
    shownStop=null;
    releaseLanding();
    detailDirty=true;
    renderNow("detail");
  }
  // A drag that selects text ends in a click on the row where it started; that click must not toggle, follow or
  // re-render the row, or the selection is gone. Movement is required: a press on a button keeps a selection made
  // elsewhere, so a plain click with text still selected is a click.
  let pressedAt: {x:number;y:number} | null = null;
  document.addEventListener("mousedown", ev => { pressedAt = {x: ev.clientX, y: ev.clientY}; }, true);
  document.addEventListener("click", ev => {
    const moved = pressedAt && Math.abs(ev.clientX - pressedAt.x) + Math.abs(ev.clientY - pressedAt.y) > 4;
    const sel = getSelection();
    if (moved && sel && !sel.isCollapsed) { ev.stopPropagation(); ev.preventDefault(); return; }
    // A click on an item or card selects it; blank space outside a control clears both selection states.
    const t = ev.target as HTMLElement & {type?: string};
    if (t.closest && t.closest<HTMLElement>("button.caret, #split-divider")) return;
    const box = t.closest && t.closest<HTMLElement>("[data-sel], #areas .item, #areas .card, #cards .card, #item-detail .card");
    if (box) setCurrent(box);
    else if (!(t.closest && t.closest<HTMLElement>("button, a, input, textarea, select, label"))) clearSelectedItem();
  }, true);
  // Otherwise the item or card the reader is looking at near the top of the screen.
  function targetOnScreen() {
    if (current && onScreen(boxOfKey(current))) return current;
    if (selectedItem && snapshot.items[selectedItem]) return "it:"+selectedItem;
    const list = listScroller(), y = list.origin() + 16;
    const wrap = get("areas").getBoundingClientRect();
    const hit = document.elementFromPoint(wrap.left + wrap.width / 2, y);
    const box = hit && (hit.closest<HTMLElement>(".card") || hit.closest<HTMLElement>(".item"));
    if (box && box.id.startsWith("q-")) return "q:" + box.id.slice(2);
    if (box && box.id.startsWith("it-")) return "it:" + box.id.slice(3);
    const first = [...document.querySelectorAll<HTMLElement>(".item, .card")].find(e => { if (e.closest("#agents")) return false; const r = e.getBoundingClientRect(); return r.top >= list.origin() && r.top < list.origin() + list.height(); });
    if (!first) return null;
    return first.id.startsWith("q-") ? "q:" + first.id.slice(2) : "it:" + first.id.slice(3);
  }
  // Shortcuts, listed with their actions in ACTIONS below and in the ☰ menu: n, m, c, e, w;
  // Backspace or [ goes back after following a dependency; Esc closes lists; gg goes to the top and G to the bottom, as in vi.
  // They stay off only while typing: a focused checkbox or button does not swallow them.
  let lastG = 0;
  document.addEventListener("keydown", ev => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return;
    const t = ev.target as HTMLElement & {type?: string};
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || (t.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset)$/.test(t.type || "")))) return;
    if (ev.key === "/") { ev.preventDefault(); openSearch(); return; }
    if (ev.key === "G") { ev.preventDefault(); lastG = 0; glideTo(listScroller().max()); return; }
    if (ev.key === "g") {
      ev.preventDefault();
      const now = Date.now();
      if (now - lastG < 600) { lastG = 0; glideTo(0); } else lastG = now;
      return;
    }
    lastG = 0;
    if (ev.key === "Backspace" || ev.key === "[") { if (backStack.length) { ev.preventDefault(); goBack(); } return; }
    if (ev.key === "j" || ev.key === "k") { ev.preventDefault(); moveFocus(ev.key === "j" ? 1 : -1); return; }
    if (ev.key === "Enter") {
      if (t?.closest<HTMLElement>("button.caret")) return;
      if (toggleFocused(t?.classList.contains("item-head") ? t : undefined)) ev.preventDefault();
      return;
    }
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") { ev.preventDefault(); stepStop(ev.key === "ArrowRight" ? 1 : -1); return; }
    const act = ACTIONS.find(a => a.key === ev.key && a.db);
    if (act && !connected) { showDisconnected(); return; }
    if (act && act.run()) ev.preventDefault();
  });
  // j and k move the selection to the next or previous item or card on the page, in screen order, without opening
  // anything; the page scrolls only as far as keeps the new selection in view. Enter shows the selected item's detail.
  function navBoxes() { return [...document.querySelectorAll<HTMLElement>("#areas .item, #areas .card, #cards .card")].filter(e => e.offsetParent !== null); }
  function moveFocus(dir: number) {
    const list = navBoxes();
    if (!list.length) return;
    const selection=effectiveSelection();
    const sel = selection?.startsWith("it:") ? get("it-"+selection.slice(3)) : selEl(selection);
    const selectedBox = sel && (sel.matches(".item, .card") ? sel : sel.closest<HTMLElement>(".card, .item"));
    const box = selectedBox && get("item-detail").contains(selectedBox) ? get("it-"+selectedItem) : selectedBox;
    let k = box ? list.indexOf(box) : -1;
    let next;
    if (k >= 0 && onScreen(box)) next = list[Math.min(list.length - 1, Math.max(0, k + dir))];
    else next = list.find(e => e.getBoundingClientRect().top >= 0) || list[0];
    if (!next) return;
    setCurrent(next);
    const head=next.classList.contains("item") ? next.querySelector<HTMLElement>(".item-head") : null;
    if (head) head.focus({preventScroll:true}); else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const y = scrollToShow(listScroller(), next.getBoundingClientRect());
    if (y !== null) glideTo(y);
  }
  function toggleFocused(focusedHead?:HTMLElement) {
    const sel = selEl(effectiveSelection());
    const box = sel && (sel.matches(".item") ? sel : sel.closest<HTMLElement>(".item"));
    const head = focusedHead || box && box.querySelector<HTMLButtonElement>(":scope > .item-row > .item-head");
    if (!head) return false;
    head.click();
    // The head click focuses the head for keyboard users; from Enter that leaves a focus ring, so drop the focus.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return true;
  }
  // Left and right arrows step through what waits for the owner (requests and open cards), from the selection.
  function stepStop(dir: number) {
    // Only the stops whose item the left list shows; a stop with no item sits in the card list and always counts.
    const all = stops().filter(st => !st.item || treeShown(st.item));
    if (!all.length) return;
    const key = containerOf(effectiveSelection());
    const k = key ? all.findIndex(st => key === "q:" + st.id.slice(2) && st.id.startsWith("q-") || (st.item && key === "it:" + st.item && st.id.startsWith("ask-"))) : -1;
    if (k >= 0) { goStop(stops().findIndex(st => st.id === all[((k + dir) % all.length + all.length) % all.length]!.id)); return; }
    // Otherwise start from the selected row of the list, as n does: forward the first stop at or below it, backward the
    // last stop above it, wrapping around at the list's ends.
    const order = new Map<string, number>(); boardOrder().forEach((it, i) => { if (!order.has(it.id)) order.set(it.id, i); });
    const home = key?.startsWith("q:") ? index().decById.get(key.slice(2))?.item : key?.startsWith("it:") ? key.slice(3) : selectedItem;
    const row = home && order.has(home) ? order.get(home)! : -1;
    const at = (st: {item:string|null}) => st.item && order.has(st.item) ? order.get(st.item)! : Infinity;
    let n = -1;
    if (dir > 0) n = all.findIndex(st => at(st) >= row);
    else all.forEach((st, i) => { if (at(st) < row) n = i; });
    const pick = all[n >= 0 ? n : dir > 0 ? 0 : all.length - 1]!;
    goStop(stops().findIndex(st => st.id === pick.id));
  }
  const ACTIONS = [
    { key: "j", show: "j / k", label: "选中下一个 / 上一个条目（不展开）", run: () => { moveFocus(1); return true; } },
    { key: "Enter", show: "Enter", label: "查看选中的条目", run: () => toggleFocused() },
    { key: "ArrowRight", show: "← / →", label: "上一条 / 下一条等你的事（阻塞在前）", run: () => { stepStop(1); return true; } },
    { key: "/", label: "按标题搜索所有条目和决策卡", run: () => { openSearch(); return true; } },
    { key: "n", label: "下一条新", db: true, run: () => { goNextFresh(); return true; } },
    { key: "N", label: "上一条新", db: true, run: () => { goPrevFresh(); return true; } },
    { key: "m", label: "标为已阅", db: true, run: () => { void markRead(); return true; } },
    { key: "c", label: "评论选中的内容（条目、卡片、某条日志或回复）", db: true, run: () => { const k = targetOnScreen(); if (k && containerOf(k)) openComment(containerOf(k)!, anchorOf(k)); return !!k; } },
    { key: "e", label: "请 Claude 详细解释（再按一次撤回）", db: true, run: () => { const k = targetOnScreen(); if (k && containerOf(k)) toggleExplain(containerOf(k)!); return !!k; } },
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
      list.appendChild(el("div", "keymenu-head", "快捷键：已阅需要选中条目或卡片；评论和解释在没选中时作用于屏幕最上面那一条<br>" +
        "蓝色数字是本条及子树有新内容的条目数。" +
        "紫色数字是本条及下面阻塞工作、等你处理的处数，红色数字是不挡工作的决策卡张数。" +
        "右侧状态色数字是子树叶条目按状态分类的数量，不计取消的条目。"));
      ACTIONS.forEach(a => {
        const r = el("button", "keymenu-row", '<kbd>' + esc(a.show || a.key) + "</kbd><span>" + esc(a.label) + "</span>");
        r.type = "button";
        r.addEventListener("click", ev => { ev.stopPropagation(); if (a.db && !connected) { showDisconnected(); return; } a.run(); m.classList.remove("open"); });
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
  // Sub-items start folded; owner toggles and navigation open their path.
  // Under a dependency filter, the items above a match open unless the owner folded them.
  function isOpen(it: ViewItem) { return filtering(groupOf(it)) && !(it.id in manual) ? filterMatches().anc.has(it.id) : !!manual[it.id]; }
  // The agent list draws item rows with itemNode too, under a mount: the row ids start with the mount's prefix instead of the
  // tree's 「it-」, and each mount keeps its own fold state, so one item folds on its own in the list and in the tree, and
  // every lookup of a tree row by id still finds only the tree's. A mount is set only while the list is being drawn.
  interface Mount { prefix: string }
  let mount: Mount | null = null;
  let agentOpen: Record<string, boolean> = {};
  try { agentOpen = JSON.parse(localStorage.getItem("board-agent-open") || "{}") || {}; } catch (e) { agentOpen = {}; }
  function saveAgentOpen() { try { localStorage.setItem("board-agent-open", JSON.stringify(agentOpen)); } catch (e) {} }
  function rowOpen(m: Mount | null, it: ViewItem) { return m ? !!agentOpen[m.prefix + it.id] : isOpen(it); }
  function setRowOpen(m: Mount | null, it: ViewItem, open: boolean) {
    if (m) { agentOpen[m.prefix + it.id] = open; saveAgentOpen(); renderNow("agents"); }
    else { manual[it.id] = open; saveManual(); renderNow("tree:" + it.id); }
  }

  // Scrolling glides for at most about a third of a second however far it goes: a long trip jumps most of the way
  // and eases over the last screenful, so the motion still shows the direction without dragging.
  let glideRun = 0;
  let landing:{id:string;top:number;gliding?:number;pane?:boolean} | null = null;
  let expectedScroll:number | null = null;
  let expectedDetailScroll:number | null = null;
  // A scroller is the thing that scrolls one column: the left list pane (the list scroller) or the detail pane. Positions are scroll offsets; origin is the scroller's top edge in viewport
  // coordinates, so a rectangle's viewport top minus the origin is its place inside the scroller's view. Its own scrolls
  // are recorded in `expected`, so the scroll event they raise is not mistaken for the reader scrolling.
  interface Scroller { height():number; position():number; max():number; origin():number; to(y:number):void; by(delta:number):void; expect():void }
  function elementScroller(pane:HTMLElement, expected:(position:number) => void): Scroller {
    const s:Scroller={
      height:() => pane.clientHeight,
      position:() => pane.scrollTop,
      max:() => Math.max(0,pane.scrollHeight-pane.clientHeight),
      origin:() => pane.getBoundingClientRect().top,
      to(y) { pane.scrollTo(0,y); s.expect(); },
      by(delta) { pane.scrollTo(0,pane.scrollTop+delta); s.expect(); },
      expect:() => expected(pane.scrollTop),
    };
    return s;
  }
  function listScroller(): Scroller { return elementScroller(get("page-left"),position => { expectedScroll=position; }); }
  function detailScroller(): Scroller { return elementScroller(get("item-detail"),position => { expectedDetailScroll=position; }); }
  // Where the scroller must go to bring a rectangle into view with an 8px margin, or null when it is already in view.
  function scrollToShow(s:Scroller, r:{top:number;bottom:number}) {
    const top=r.top-s.origin(), bottom=r.bottom-s.origin(), height=s.height();
    if (top < 4) return s.position()+top-8;
    if (bottom > height-4) return s.position()+Math.min(top-8,bottom-height+8);
    return null;
  }
  function releaseLanding() { landing=null; glideRun++; freshNavigation++; }
  function glideTo(top: number, pin?:{id:string;top:number}, detail=false) {
    const s=detail ? detailScroller() : listScroller();
    const height=s.height(), position=() => s.position(), place=(y:number) => s.to(y);
    top = Math.min(s.max(), Math.max(0, Math.round(top)));
    const run = ++glideRun;
    const target=pin && get(pin.id);
    landing=pin && target ? {id:pin.id,top:position()+target.getBoundingClientRect().top-s.origin()-top,gliding:run,pane:detail} : null;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { place(top); if (landing) delete landing.gliding; return; }
    const reach = height;
    let from = position();
    if (Math.abs(top - from) > reach) { from = top - Math.sign(top - from) * reach; place(from); }
    const dist = top - from, ms = 160 + Math.abs(dist) / reach * 160, t0 = performance.now();
    const step = (now: number) => {
      if (run !== glideRun) return;
      const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      const target=landing && get(landing.id);
      const destination=target && landing ? position()+target.getBoundingClientRect().top-s.origin()-landing.top : top;
      place(from + (destination-from) * e);
      if (k < 1) frame(step); else if (landing) delete landing.gliding;
    };
    frame(step);
  }
  // The reader's own wheel or touch stops a glide.
  ["wheel", "touchstart"].forEach(t => addEventListener(t, releaseLanding, { passive: true }));
  ["keydown","click"].forEach(t => document.addEventListener(t, ev => { if (ev.isTrusted !== false) { releaseLanding(); hideHint(); } }, {capture:true}));
  // A jump keeps the target in view first; within that, it shows as much of the enclosing card or item as fits,
  // and centres what it shows: the whole card when it fits in the viewport, else the target, moved off
  // centre only as far as keeps the card filling three quarters of the view.
  function glideToTarget(t: HTMLElement) {
    const inDetail=get("item-detail").contains(t), s=inDetail ? detailScroller() : listScroller();
    const origin=s.origin(), height=s.height(), offset=s.position();
    const top = 8, bottom = height - 8, room = bottom - top;
    const doc = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return { top: r.top-origin+offset, bottom: r.bottom-origin+offset }; };
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
    glideTo(destination,t.id ? {id:t.id,top:T.top-destination} : undefined,inDetail);
  }
  function jump(id: string | HTMLElement) {
    const name=typeof id === "string" ? id : id.id, e=typeof id === "string" ? get(id) : id;
    const box=e?.closest<HTMLElement>(".card, .item");
    const card=name.startsWith("q-") ? name.slice(2) : box?.id.startsWith("q-") ? box.id.slice(2) : undefined;
    const item=name.startsWith("detail-it-") ? name.slice(10) : name.startsWith("it-") ? name.slice(3) : name.startsWith("ask-") ? name.slice(4) : card ? cardPlace(card) : box?.id.startsWith("detail-it-") ? box.id.slice(10) : box?.id.startsWith("it-") ? box.id.slice(3) : null;
    const note=e?.dataset.sel?.startsWith("note:") ? e.dataset.sel.slice(5) : undefined;
    if (item || card || note) { void navigate({id:name,item,card,note,selection:e?.dataset.sel,notes:note ? snapshot.notes[note]?.target : undefined}); return; }
    if (e) { glideToTarget(e); setCurrent(e.closest<HTMLElement>(".card, .item")); }
  }
  function openPath(id: string) {
    let it = index().byId.get(id);
    let outer:string | undefined;
    if (it) ancestors(it).forEach(p => { if (!isOpen(p)) { manual[p.id] = true; outer=p.id; } });
    saveManual();
    if (outer) renderNow(get("it-"+outer) ? "tree:"+outer : "group:"+derived.groupOf(outer));
  }
  function reveal(id: string) { jump("it-" + id); }
  // Following a dependency remembers where the reader was; Backspace, [ or the 返回 button goes back.
  const backStack: Array<{key:string|null;y:number}> = [];
  // `fromList`: the reader leaves the agent list at the top of the page, so Back returns to the scroll position, not to an item below.
  function remember(fromList = false) {
    backStack.push({ key: fromList ? null : targetOnScreen(), y: listScroller().position() });
    if (backStack.length > 50) backStack.shift();
  }
  function follow(id: string, fromList = false) {
    remember(fromList);
    reveal(id);
    renderBack();
  }
  // A glossary link opens a popover with its term's definition, beside the link. It acts before the clicked element's own
  // handlers, so a term inside an option button does not choose that option. A click elsewhere, Escape, a scroll or another
  // term closes the popover.
  let termPopover: HTMLElement | null = null;
  function closeTermPopover() { termPopover?.remove(); termPopover = null; }
  function openTermPopover(link: HTMLElement) {
    closeTermPopover();
    const [project, term] = parseTermAnchor(link.getAttribute("href")!.slice(1));
    const entry = snapshot.glossaries[project]?.terms.find(t => t.term === term);
    if (!entry) return;
    const pop = el("div", "termpop", "<strong>" + esc(entry.term) + "</strong> " + esc(entry.definition));
    document.body.appendChild(pop);
    const at = link.getBoundingClientRect(), box = pop.getBoundingClientRect(), vw = window.innerWidth || 0;
    const below = at.bottom + 6, fits = below + box.height <= innerHeight || at.top - 6 - box.height < 0;
    pop.style.top = (fits ? below : at.top - 6 - box.height) + "px";
    pop.style.left = Math.max(8, Math.min(at.left, vw - box.width - 8)) + "px";
    termPopover = pop;
  }
  document.addEventListener("click", ev => {
    const target = ev.target as HTMLElement;
    if (termPopover?.contains(target)) return;
    const link = target.closest?.<HTMLElement>("a.term");
    if (!link || ev.defaultPrevented) { closeTermPopover(); return; }
    ev.preventDefault(); ev.stopPropagation();
    openTermPopover(link);
  }, true);
  document.addEventListener("keydown", ev => { if (ev.key === "Escape") closeTermPopover(); }, true);
  document.addEventListener("scroll", ev => { if (!termPopover?.contains(ev.target as Node)) closeTermPopover(); }, true);
  function goBack() {
    const b = backStack.pop();
    renderBack();
    if (!b) return;
    const box = b.key && boxOfKey(b.key);
    if (b.key) {
      const container=containerOf(b.key), card=container?.startsWith("q:") ? container.slice(2) : undefined;
      const item=container?.startsWith("it:") ? container.slice(3) : card ? cardPlace(card) : null;
      const note=b.key.startsWith("note:") ? b.key.slice(5) : undefined;
      if (item || card || note) {
        const id=note ? noteElementId(note) : card ? "q-"+card : "it-"+item;
        void navigate({id,item,card,note,selection:b.key,notes:note ? snapshot.notes[note]?.target : undefined}); return;
      }
    }
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
  // One row per item in a dependency list: status, priority, where it lives (the project when it is
  // another one), and its title; a click follows it.
  function depRow(d: ViewItem, from: ViewItem, extra?: string) {
    const st = statusOf(d) ?? "record", pr = priorityOf(d);
    // A dependency in another project names that project; within the project no label is needed.
    const where = groupOf(d) !== groupOf(from) ? groupOf(d) || "其他" : "";
    const b = el("button", "deprow" + (groupOf(d) !== groupOf(from) ? " cross" : ""),
      statusChip(d, st)
      + '<span class="prio ' + (pr ? pr.toLowerCase() : "none") + '">' + (pr || "P?") + "</span>"
      + (where ? '<span class="where">' + inline(where) + "</span>" : "")
      + '<span class="t">' + inline(d.title) + "</span>" + (extra ? '<span class="where">' + extra + "</span>" : ""));
    b.type = "button";
    b.addEventListener("click", ev => { ev.stopPropagation(); follow(d.id); });
    return b;
  }
  // An item's status chip shows its short number; the chip's colour carries the status, which its tooltip names.
  // A paused item keeps the ◌ mark. An item without a number (data not yet numbered) shows the status word.
  function chipText(it: Item, st: string) {
    return it.num === undefined ? STATUS[st] || st : (st === "paused" ? "◌ " : "") + it.num;
  }
  function statusChip(it: Item, st: string) {
    return '<span class="st ' + st + '"' + (it.num === undefined ? "" : ' title="' + esc(STATUS[st] || st) + '"') + ">" + esc(chipText(it, st)) + "</span>";
  }
  function cardTag(id: string, d: Decision | undefined) {
    return !d ? '<span class="st cancelled">已删除</span>'
      : derived.cardBlocking(id) ? '<span class="waittag" title="' + esc(d.blocks) + '">阻塞</span>'
      : derived.cardWaiting(id) ? '<span class="asktag">决策卡</span>'
      : d.status === "open" ? '<span class="st todo">未定</span>'
      : '<span class="st done">' + (d.ruling ? "已裁定" : "已结束") + "</span>";
  }
  function followCard(id: string) { if (snapshot.decisions[id]) jump("q-"+id); }
  // Every item and decision card the owner can search for or refer to, in board data order, with what a result row shows:
  // its project, its parent item (the item holding it, for a card) and its status.
  interface Found extends Target { project: string; parent: string; tag: string }
  function allTargets(): Found[] {
    return cached("targets", () => {
      const out: Found[] = [];
      for (const it of state.items) {
        const st = statusOf(it) ?? "record", parent = upItem(it);
        out.push({ kind: "item", key: it.id, ...(it.num === undefined ? {} : { num: it.num }), title: plain(it.title), project: groupOf(it), parent: parent ? plain(parent.title) : "", tag: statusChip(it, st) });
      }
      for (const d of state.decisions) {
        const home = index().byId.get(d.item);
        out.push({ kind: "card", key: d.id, ...(d.num === undefined ? {} : { num: d.num }), title: plain(firstLine(d.question)) || "决策", project: home ? groupOf(home) : "", parent: home ? plain(home.title) : "", tag: cardTag(d.id, d) });
      }
      return out;
    });
  }
  function targetRow(t: Found, cls: string) {
    const b = el("button", "deprow " + cls, t.tag + '<span class="t">' + esc(t.title) + '</span><span class="where">' + esc([t.project || "其他", t.parent].filter(Boolean).join(" › ")) + "</span>");
    b.type = "button";
    return b;
  }
  // A list of found targets with one marked row, shared by the "/" search and the "#" popup.
  function targetList(host: HTMLElement, pick: (t: Found) => void, rowClass: string) {
    let rows: Found[] = [], els: HTMLElement[] = [], at = 0;
    const mark = () => els.forEach((e, i) => { e.classList.remove("sel"); if (i === at) e.classList.add("sel"); });
    return {
      show(found: Found[]) {
        rows = found; at = 0; host.innerHTML = "";
        els = found.map(t => {
          const b = targetRow(t, rowClass);
          // The text field keeps its focus while a row is clicked.
          b.addEventListener("mousedown", ev => ev.preventDefault());
          b.addEventListener("click", ev => { ev.stopPropagation(); pick(t); });
          host.appendChild(b); return b;
        });
        mark();
      },
      move(delta: number) { if (rows.length) { at = (at + delta + rows.length) % rows.length; mark(); els[at]!.scrollIntoView({ block: "nearest" }); } },
      get current() { return rows[at]; },
      get size() { return rows.length; },
    };
  }
  // A reference click and a search pick both remember where the reader was, so Back returns.
  function jumpTo(kind: Target["kind"], key: string) { remember(); goTo(kind, key); renderBack(); }
  function goTo(kind: Target["kind"], key: string) { if (kind === "item") { if (snapshot.items[key]) reveal(key); } else followCard(key); }
  // A reference in a comment, log or reply selects its target like a dependency link: Back returns to where the reader was.
  document.addEventListener("click", ev => {
    const link = (ev.target as HTMLElement).closest?.<HTMLElement>("a.itemref");
    if (!link || ev.defaultPrevented) return;
    ev.preventDefault(); ev.stopPropagation();
    const ref = link.getAttribute("data-ref") ?? "";
    jumpTo(ref.startsWith("it:") ? "item" : "card", ref.slice(ref.indexOf(":") + 1));
  }, true);
  // "/" searches every item and decision card by title; up and down choose a row, Enter or a click goes there, Esc closes.
  let searchBox: HTMLElement | null = null;
  function closeSearch() { searchBox?.remove(); searchBox = null; }
  function openSearch() {
    if (searchBox) { searchBox.querySelector<HTMLInputElement>("input")?.focus(); return; }
    const box = el("div", "searchbox"), list = el("div", "search-list");
    box.id = "search"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "搜索条目和决策卡");
    const input = document.createElement("input");
    input.type = "text"; input.id = "search-input"; input.placeholder = "搜索条目和决策卡的标题或编号"; input.setAttribute("aria-label", "搜索条目和决策卡的标题或编号");
    box.appendChild(input); box.appendChild(list);
    const found = targetList(list, t => { closeSearch(); jumpTo(t.kind, t.key); }, "searchrow");
    const update = () => {
      const rows = findTargets(allTargets(), input.value);
      found.show(rows);
      if (!rows.length) list.appendChild(el("p", "empty", "没有匹配的条目或决策卡"));
    };
    input.addEventListener("input", update);
    input.addEventListener("keydown", ev => {
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeSearch(); }
      else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); found.move(ev.key === "ArrowDown" ? 1 : -1); }
      else if (ev.key === "Enter" && found.current) { ev.preventDefault(); const t = found.current; closeSearch(); jumpTo(t.kind, t.key); }
    });
    document.body.appendChild(box); searchBox = box;
    update(); input.focus();
  }
  document.addEventListener("mousedown", ev => { if (searchBox && !searchBox.contains(ev.target as Node)) closeSearch(); }, true);
  function depLink(d: ViewItem | {kind: "item" | "card"; id: string}) {
    const card = "kind" in d && d.kind === "card";
    const title = card ? snapshot.decisions[d.id]?.question : snapshot.items[d.id]?.title;
    const b = el("button", "ref", inline(title || d.id)); b.type = "button";
    b.addEventListener("click", ev => { ev.stopPropagation(); if (card) followCard(d.id); else follow(d.id); }); return b;
  }

  // Comments are kept in the board's own store; the owner writes them inline and sends the batch at once.
  const EXPLAIN = "请详细解释这一项。";
  function titleOf(key: string) {
    if (key.startsWith("it:")) { const it = index().byId.get(key.slice(3)); return it ? it.title : ""; }
    const d = index().decById.get(key.slice(2)); return d ? d.question || "决策" : "决策";
  }
  function pendingDraft(key:string,kind:DraftKind) {
    if (sendingDrafts.has(draftKey(key,kind))) return undefined;
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
    if (key.startsWith("it:")) { openPath(key.slice(3)); selectItem(key.slice(3)); }
    else if (key.startsWith("q:")) { const id=cardPlace(key.slice(2)); if (id && snapshot.items[id]) { openPath(id); selectItem(id); } }
    editing = key; editingAnchor = anchor || null;
    // Writing a comment shows the list it joins, so the saved draft and its send button are in view.
    notesOpen[key] = true; try { localStorage.setItem("board-notes", JSON.stringify(notesOpen)); } catch (e) {}
    renderNow("notes:"+key);
    const ta = get<HTMLTextAreaElement>("ed-" + key.replace(/[^A-Za-z0-9_-]/g, "_"));
    if (ta) { ta.focus(); ta.scrollIntoView({ block: "center" }); }
  }
  // A queued explain request shows on the item or card it asks about until it is sent.
  function pendingChip(key: string) { return pendingExplain(key) ? el("span", "pendtag", "待发：详细解释") : null; }
  function elements(root:HTMLElement): HTMLElement[] { return [root,...[...root.children].flatMap(e => elements(e as HTMLElement))]; }
  function patchDraft(target:string,kind:DraftKind) {
    const box = target.startsWith("q:") ? get("q-"+target.slice(2)) : itemBox(target.slice(3)) || get("it-"+target.slice(3));
    if (!box) return;
    const busy = optimistic.has(draftKey(target,kind));
    if (kind === "choice") {
      const d=index().decById.get(target.slice(2)); if (!d) return;
      const chosen=choiceOf(d), choice=chosen?.choice || d.choice;
      elements(box).filter(e => e.dataset.option).forEach(e => {
        const selected=choice === e.dataset.option;
        e.classList.remove("sel"); if (selected) e.classList.add("sel");
        e.setAttribute("aria-pressed",String(selected));
        (e as HTMLButtonElement).disabled=busy || !connected || d.status !== "open" || !!(chosen && chosen.state !== "draft");
      });
      elements(box).filter(e => e.dataset.cardsend === d.id).forEach(e => { (e as HTMLButtonElement).disabled=!connected || chosen?.state !== "draft"; });
    } else if (kind === "explain") {
      const boxes=[box,...(target.startsWith("it:") ? [get("it-"+target.slice(3))].filter((e):e is HTMLElement => !!e && e !== box) : [])];
      for (const host of boxes) {
        const head=target.startsWith("it:") ? host.querySelector<HTMLElement>(".item-head") : host.children[0]?.children[0] as HTMLElement | undefined;
        if (!head) continue;
        const old=[...head.children].find(e => e.classList.contains("pendtag"));
        if (pendingExplain(target)) { if (!old) head.appendChild(pendingChip(target)!); } else old?.remove();
      }
    } else {
      const pending=pendingDraft(target,kind), sent=notesOf(target).some(n => n.kind === kind && n.state === "sent");
      elements(box).filter(e => e.dataset.answer === kind).forEach(e => {
        e.classList.remove("on"); if (pending || sent) e.classList.add("on");
        e.textContent=sent ? ANSWER[kind]!.sent : pending ? ANSWER[kind]!.queued : ANSWER[kind]!.label;
        (e as HTMLButtonElement).disabled=busy || sent || !connected;
      });
      elements(box).filter(e => e.dataset.asksend === target.slice(3) && e.dataset.askkind === kind).forEach(e => { (e as HTMLButtonElement).disabled=!connected || !pending; });
    }
  }
  // Acknowledgements can arrive after a newer SSE revision or deletion.
  function applyDraftResult(result: DraftResult, started: number): boolean {
    let changed = false;
    snapshot = { ...snapshot, notes: { ...snapshot.notes } };
    for (const id of result.deleted) {
      noteTombstones.set(id, Infinity);
      if (snapshot.notes[id]) { delete snapshot.notes[id]; changed = true; }
    }
    if (result.note) {
      const { id, doc } = result.note, currentNote = snapshot.notes[id];
      if ((currentNote ? currentNote.rev <= doc.rev : (noteEvents.get(id) ?? 0) <= started) && !sameValue(currentNote, doc)) { snapshot.notes[id] = doc; changed = true; }
    }
    if (changed) { snapshotGeneration++; rulePresentationDirty = true; applySnapshot(snapshot); }
    return changed;
  }
  function saveDraftEdit(n: ViewNote, edit: DraftEdit): Promise<boolean> {
    const pending = pendingEdits.get(n.id);
    if (pending) return pending;
    if (!connected) { showDisconnected(); return Promise.resolve(false); }
    if (!draftEditable(snapshot.notes[n.id])) { draftEdits.delete(n.id); renderNow("notes:" + n.target); return Promise.resolve(false); }
    const textProblem = noteTextProblem({ kind: n.kind, text: edit.text });
    if (textProblem) { showError(new Error(textProblem)); return Promise.resolve(false); }
    const started = eventGeneration;
    sendMessage = "";
    const operation = (async () => {
      try {
        const result = await api<DraftResult>("/api/draft", { id: n.id, rev: edit.rev, text: edit.text });
        applyDraftResult(result, started);
        if (draftEdits.get(n.id) === edit) draftEdits.delete(n.id);
        return true;
      } catch (e) { showError(e); return false; }
      finally { pendingEdits.delete(n.id); scheduleRender("notes:" + n.target); renderSend(); }
    })();
    pendingEdits.set(n.id, operation);
    renderNow("notes:" + n.target);
    return operation;
  }
  function draftEditor(n: ViewNote, edit: DraftEdit): HTMLElement {
    const ed = el("div", "editor"), row = el("div", "row"), ta = document.createElement("textarea");
    const busy = pendingEdits.has(n.id);
    ta.id = "edit-draft-" + n.id; ta.value = edit.text; ta.disabled = busy;
    ta.setAttribute("aria-label", "编辑未发送的内容");
    const picker = refPicker(ta, ed, row, () => { edit.text = ta.value; });
    ta.addEventListener("input", () => { edit.text = ta.value; picker.update(); });
    ta.addEventListener("blur", () => picker.close());
    ta.addEventListener("keydown", ev => {
      if (ev.isComposing || ev.keyCode === 229 || picker.key(ev)) return;
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); save.click(); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancel.click(); }
    });
    ed.appendChild(ta);
    const save = el("button", "save", busy ? "保存中…" : "保存"), cancel = el("button", "cancel", "取消");
    save.type = cancel.type = "button"; save.disabled = busy || !connected; cancel.disabled = busy;
    save.addEventListener("click", async () => { edit.text = ta.value; await saveDraftEdit(n, edit); });
    cancel.addEventListener("click", () => { if (pendingEdits.has(n.id)) return; draftEdits.delete(n.id); renderNow("notes:" + n.target); });
    row.appendChild(save); row.appendChild(cancel); ed.appendChild(row);
    return ed;
  }
  function setDraft(target:string,kind:DraftKind,on:boolean,text:string,choice?:string):Promise<boolean> {
    const key=draftKey(target,kind), existing=optimistic.get(key);
    if (existing) return existing.promise!;
    if (!connected) { showDisconnected(); return Promise.resolve(false); }
    const overlay:DraftOverlay={on,choice,state:"draft"};
    const started=eventGeneration;
    optimistic.set(key,overlay); patchDraft(target,kind);
    sendMessage="";
    let changed=false;
    const operation=(async () => {
      try {
        const result=await api<{note:{id:string;doc:Note}|null;deleted:string[];commit:string}>("/api/draft",{target,kind,on,text,...choice ? {choice} : {}});
        changed = applyDraftResult(result, started);
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
  // Approvals and choices show on their buttons; the comment list holds comments, explain requests, and any approval or choice a session replied to.
  function listed(n: ViewNote) { return (!ANSWER[n.kind] && n.kind !== "choice") || !!n.reply; }
  function anchorLabel(a: NonNullable<Note["anchor"]>) {
    if (a.kind === "log") return "日志 " + day(a.at);
    const n = state.notes.find(x => x.id === a.id);
    return n ? "回复（" + day(n.repliedAt || n.at) + "）" : "一条回复";
  }
  const NOTE_STATE: Record<Note["state"], string> = { draft: "未发送", sent: "已发送，等处理", done: "已处理" };
  function noteThread(n: Note, fresh = false, replyFresh = false) {
    const box = el("div", "note" + (n.state === "draft" ? " draft" : "") + (fresh ? " newbar" : ""));
    const terms = itemTerms(n.target.startsWith("it:") ? n.target.slice(3) : snapshot.decisions[n.target.slice(2)]?.item || "");
    box.appendChild(el("div", "who", esc(day(n.at)) + " · " + NOTE_STATE[n.state]));
    if (n.anchor) box.appendChild(el("div", "anchor", "关于" + esc(anchorLabel(n.anchor))));
    const label = n.kind === "explain" ? "请求：详细解释" : n.kind === "approve" ? "同意" : n.kind === "choice" ? "选择：" + (n.choice || "") : undefined;
    const canonical = n.kind === "explain" ? n.text === EXPLAIN : n.kind === "choice" ? n.text === "选 " + n.choice : n.kind === "approve" ? n.answerText === undefined || n.text === n.answerText : false;
    box.appendChild(el("div", "txt", label === undefined ? linkTerms(blocks(n.text),terms) : esc(label) + (canonical || !n.text ? "" : '<div class="rich">' + linkTerms(blocks(n.text),terms) + "</div>")));
    if (n.reply) box.appendChild(el("div", "reply rich" + (replyFresh ? " newbar" : ""), '<div class="sub">Claude</div>' + linkTerms(blocks(n.reply),terms)));
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
      // The owner wrote the comment, so only what a session added carries the line: a new reply marks the reply alone.
      const box = noteThread(n, !replyFresh && fon("other") && freshNotes.includes(n), replyFresh);
      box.id = noteId(n);
      box.dataset.sel = "note:" + n.id;
      if (current === "note:" + n.id) box.classList.add("cur");
      const who = box.firstElementChild!;
      if (draftEditable(n)) {
        const activeEdit = draftEdits.get(n.id), busy = pendingEdits.has(n.id);
        {
          const edit = el("button", "linkbtn", "编辑"); edit.type = "button"; edit.disabled = busy || !!activeEdit || !connected;
          edit.addEventListener("click", () => {
            if (!draftEditable(snapshot.notes[n.id])) return;
            draftEdits.set(n.id, { text: n.text, rev: n.rev }); renderNow("notes:" + key);
            get<HTMLTextAreaElement>("edit-draft-" + n.id)?.focus();
          });
          who.appendChild(edit);
        }
        const del = el("button", "linkbtn", "删除"); del.type = "button"; del.disabled = busy || !connected;
        del.addEventListener("click", async () => { del.disabled = true; try { await deleteNote(n.id); } catch(e) { showError(e); } finally { del.disabled = false; } });
        who.appendChild(del);
        if (activeEdit) box.querySelector(".txt")!.replaceWith(draftEditor(n, activeEdit));
        // Sends this comment alone, below its text; the editor stays as it is.
        const send = el("button", "cardsend", "发送"); send.type = "button"; send.disabled = busy || !!activeEdit || !connected;
        send.addEventListener("click", () => sendDrafts(note => note.id === n.id));
        box.appendChild(send);
      }
      wrap.appendChild(box);
    });
    if (editing === key) {
      const ed = el("div", "editor"), row = el("div", "row");
      const ta = document.createElement("textarea");
      ta.id = "ed-" + key.replace(/[^A-Za-z0-9_-]/g, "_");
      ta.maxLength = 4000;
      ta.placeholder = "写给 Claude 的意见或问题（关于：" + title + (editingAnchor ? "，" + anchorLabel(editingAnchor) : "") + "）。回车保存，Shift+回车换行，Esc 取消";
      ta.value = drafts[key] || "";
      const picker = refPicker(ta, ed, row, () => { drafts[key] = ta.value; });
      ta.addEventListener("input", () => { drafts[key] = ta.value; picker.update(); });
      ta.addEventListener("blur", () => picker.close());
      // Enter saves, Shift+Enter starts a new line, Esc cancels and keeps the draft; inside an IME composition both only act on the composition.
      // While the "#" popup is open it takes the arrow keys, Enter and Esc first.
      ta.addEventListener("keydown", ev => {
        if (ev.isComposing || ev.keyCode === 229) return;
        if (picker.key(ev)) return;
        if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); save.click(); }
        else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancel.click(); }
      });
      ed.appendChild(ta);
      const save = el("button", "save", "保存"); save.type = "button";
      const cancel = el("button", "cancel", "取消"); cancel.type = "button";
      save.addEventListener("click", async () => {
        const text = (ta.value || "").trim();
        if (!text) { ta.focus(); return; }
        save.disabled = true;
        try {
          await createNote(Object.assign({ target: key, text: text, kind: "comment" as const }, editingAnchor ? { anchor: editingAnchor } : {}));
          drafts[key] = ""; editing = null; editingAnchor = null;
          notesOpen[key] = true; try { localStorage.setItem("board-notes", JSON.stringify(notesOpen)); } catch (e) {}
          renderNow("notes:"+key);
        } catch (e) { save.disabled = false; save.textContent = "保存"; }
      });
      cancel.addEventListener("click", () => { editing = null; editingAnchor = null; renderNow("notes:"+key); });
      row.appendChild(save); row.appendChild(cancel);
      ed.appendChild(row);
      wrap.appendChild(ed);
    }
    return wrap;
  }

  // Typing "#" in a comment opens a small popup of the items and decision cards whose title contains what follows it. Up and
  // down choose, Enter or a click writes the target's reference token over "#…", Esc closes only the popup. A "#" glued to a
  // word before it (Repo#341) is not a reference.
  function refPicker(ta: HTMLTextAreaElement, ed: HTMLElement, before: HTMLElement, sync: () => void) {
    const pop = el("div", "refpop");
    pop.setAttribute("role", "listbox");
    let start = 0, open = false;
    const list = targetList(pop, t => choose(t), "refopt");
    function close() { if (open) { pop.remove(); open = false; } }
    function choose(t: Found) {
      const token = refToken(t.kind, t.key), caret = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, start) + token + ta.value.slice(caret);
      ta.setSelectionRange(start + token.length, start + token.length);
      sync(); close(); ta.focus();
    }
    return {
      close,
      update() {
        const q = refQuery(ta.value, ta.selectionStart ?? ta.value.length);
        const rows = q ? findTargets(allTargets(), q.query).slice(0, 8) : [];
        if (!q || !rows.length) { close(); return; }
        start = q.start; list.show(rows);
        if (!open) { ed.insertBefore(pop, before); open = true; }
      },
      // True when the popup used the key.
      key(ev: KeyboardEvent) {
        if (!open) return false;
        if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); list.move(ev.key === "ArrowDown" ? 1 : -1); return true; }
        if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); choose(list.current!); return true; }
        if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); return true; }
        if (ev.key === "ArrowLeft" || ev.key === "ArrowRight" || ev.key === "Home" || ev.key === "End") close();
        return false;
      },
    };
  }

  function renderSend() {
    const box = get("sendbox");
    const btn = get<HTMLButtonElement>("send-all");
    const note = get("send-note");
    if (!connected) { box.hidden = true; return; }
    box.hidden = false;
    const pending = [...state.notes.filter(x => x.state === "draft" && !sendPending(x) && !optimistic.has(draftKey(x.target,x.kind as DraftKind))), ...[...optimistic].filter(([key,o]) => o.on && !sendingDrafts.has(key)).map(([key]) => ({kind:key.slice(key.lastIndexOf("|")+1)}))];
    const n = pending.length;
    const waiting = state.notes.filter(x => x.state === "sent" || x.state === "draft" && sendPending(x)).length;
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
    const nav = get("nav");
    nav.remove(); // Keep the project links and their element while rebuilding the summary around them.
    sum.innerHTML = "";
    // One concern per row: owner waits, new-content navigation and filters, then tools and links.
    const waitingRow = el("div", "header-row header-wait"); waitingRow.id = "wait-row";
    const acts = el("div", "sum-row"), unreadRow = el("div", "sum-row"), view = el("div", "sum-row"), stats = el("div", "sum-stats");
    unreadRow.id = "unread-row"; view.id = "tools-row";
    const sbtn = (cls: string, text: string, title: string, onClick: () => void) => { const b = el("button", "sbtn " + cls, text); b.type = "button"; if (title) b.title = title; b.addEventListener("click", onClick); return b; };
    const blocking = stops().filter(blockingStop).length, plainCards = stops().length - blocking;
    if (blocking) acts.appendChild(sbtn("s-block", "阻塞 " + blocking + " ›", "工作停着等你，从第一条开始", () => goStop(0)));
    if (plainCards) acts.appendChild(sbtn("s-wait", "决策卡 " + plainCards + " ›", "不挡工作的决策卡，从第一张开始", () => goStop(blocking)));
    // Counts are items, as the chips count them; n visits each new place inside them.
    const fresh = countOf(freshStops());
    if (fresh) unreadRow.appendChild(sbtn("s-new", "新 " + fresh + " ›", "新内容和新回复，从第一条开始（n）", () => goFresh(0)));
    // Which kinds of new things count, picked like the project filters; each shows how many items have that kind.
    const everyFresh = allFreshStops();
    ["progress", "other", "reply"].forEach(key => {
      const [kind, label, title] = FRESH_KINDS.find(([kind]) => kind === key)!;
      const n = countOf(everyFresh.filter(st => st.kinds.includes(kind))), on = freshSel.includes(kind);
      if (n || on) { const b = sbtn("s-plain" + (on ? " s-on" : ""), label + " " + n, title + "（可多选）", () => toggleFresh(kind)); unreadRow.appendChild(b); }
    });
    if (freshSel.length) unreadRow.appendChild(sbtn("s-plain", "清除筛选", "", () => setFreshSel([])));
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
      unreadRow.appendChild(all);
    }
    if (fresh && unreadRow.children.length > 1) {
      const divider = el("span", "sum-divider"); divider.setAttribute("aria-hidden", "true");
      unreadRow.insertBefore(divider, unreadRow.children[1]!);
    }

    const fold = sbtn("s-plain", "全部折叠", "折叠所有条目和评论", () => {
      // Folding everything also folds every comment list, including ones that new replies had opened.
      manual = {}; logOpen = {}; saveManual();
      notesOpen = {};
      state.notes.forEach(n => { if (n.target) notesOpen[n.target] = false; });
      try { localStorage.setItem("board-notes", JSON.stringify(notesOpen)); } catch (e) {}
      ruledOpen = {}; state.decisions.forEach(d => { if (d.status !== "open") ruledOpen[d.id] = false; }); saveRuled();
      agentOpen = {}; saveAgentOpen();
      renderNow("areas","cards","detail","agents");
    });
    view.appendChild(fold);
    // Opens every top-level item so the items under it show, each one folded: the first level and nothing deeper.
    view.appendChild(sbtn("s-plain", "展开第一层", "展开每条工作线，只显示它下面第一层条目", () => {
      state.items.forEach(i => { delete manual[i.id]; });
      tops().forEach(t => { manual[t.id] = true; });
      saveManual(); renderNow("areas",...(selectedItem ? ["head:"+selectedItem] : []));
    }));

    const n: Record<string,number> = { wip: 0, blocked: 0, paused: 0, stalled: 0, todo: 0, done: 0, cancelled: 0 };
    state.items.forEach(i => { const st = statusOf(i); if (st !== undefined && n[st] != null) n[st]++; });
    ([["wip", "进行中", "--bar-wip"], ["blocked", "卡住", "--bar-block"], ["paused", "暂停", "--bar-cancel"], ["stalled", "停滞", "--bar-stalled"], ["todo", "未开始", "--bar-todo"], ["done", "完成", "--bar-done"], ["cancelled", "取消", "--bar-cancel"]] as Array<[string,string,string]>)
      .filter(([k]) => (k !== "cancelled" && k !== "blocked" && k !== "paused") || n[k])
      .forEach(([k, label, bar]) => stats.appendChild(el("span", null, '<span class="dot" style="background:var(' + bar + ')"></span>' + label + " " + n[k])));
    view.appendChild(stats);
    view.appendChild(nav);
    if (acts.children.length) waitingRow.appendChild(acts);
    const panel = waitPanel(); if (panel) waitingRow.appendChild(panel);
    if (waitingRow.children.length) sum.appendChild(waitingRow);
    if (unreadRow.children.length) sum.appendChild(unreadRow);
    sum.appendChild(view);
  }
  // The agent list: one row per session that wrote to the board lately, with the two items it touched last (src/agents.ts,
  // docs/design.md "Agent list"). Everything shown is what sessions declared by writing; nothing is observed, and the
  // state word is inferred, so every row carries how long ago the session wrote.
  let agentsOpen = true;
  try { agentsOpen = localStorage.getItem("board-agents") !== "closed"; } catch (e) {}
  // What the list was last painted from: a repaint with the same inputs is skipped, so a write elsewhere leaves it alone.
  let agentsSignature = "";
  function agoText(iso: string) {
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000)), hours = Math.floor(minutes / 60), rest = minutes % 60;
    return hours ? hours + " 小时" + (rest ? " " + rest + " 分钟" : "") + "前" : minutes ? minutes + " 分钟前" : "不到 1 分钟前";
  }
  function agentRowsNow() { return cached("agentRows", () => agentRows(snapshot, Date.now())); }
  // The level as a reader says it: 「2 级」, and 「审查 3 级」 for a reviewer.
  function agentLevel(r: AgentRow) { return r.level === undefined ? "" : (r.role === "审查" ? "审查 " : "") + r.level + " 级"; }
  const AGENT_STATE_TITLES: Record<string, string> = {
    working: "它有进行中的行，30 分钟内写过看板。这是从写看板推出来的，不是看到它在干活",
    "maybe-stopped": "它有进行中的行，超过 30 分钟没写看板，也没写在等什么。可能停了，也可能在读代码或等 CI",
  };
  function agentState(r: AgentRow) {
    if (r.state === "none") return null;
    const text = r.state === "waiting" ? "在等：" + inline(r.waits) : r.state === "working" ? "干活" : "可能停了";
    const chip = el("span", "agent-state " + r.state + (r.amber ? " amber" : ""), text);
    chip.title = r.state === "waiting"
      ? "它在进行中的行上写了在等什么，这句话是代理自己写的，不按时间判断" + (r.amber ? "。已经超过 1 小时没写：空闲约一小时的会话会被 Claude Code 停掉，这可能是已经停了的等待" : "")
      : AGENT_STATE_TITLES[r.state]!;
    return chip;
  }
  // The tree draws an ended item only while something open hangs on it, so only then is there a row to jump to.
  function inTree(it: ViewItem) { return visible(it) && ancestors(it).every(visible); }
  // An item can sit in several rows, so each row's elements carry the row's own id prefix; none starts with 「it-」, which is the
  // tree's. The name is written so that two names never share a prefix: every character but a letter, digit or hyphen becomes
  // its code point in hex between underscores.
  function agentMount(name: string) { return "ag-" + [...name].map(c => /[A-Za-z0-9-]/.test(c) ? c : "_" + c.codePointAt(0)!.toString(16) + "_").join("") + "--"; }
  function agentItem(r: AgentRow, t: AgentTouch, it: ViewItem) {
    const st = statusOf(it) ?? "record", li = el("li", "agitem"), m: Mount = { prefix: agentMount(r.name) };
    // A cell and the item row an unfolded parent draws for the same item must not share an id.
    li.id = m.prefix + "cell-" + it.id;
    const row = el("div", "agitem-row"), sub = kids(it.id, true).filter(passes), open = rowOpen(m, it) && sub.length > 0;
    // The arrow unfolds the sub-items under the cell, as the tree's arrow does; the list's folds are its own.
    const caret = el("button", "agitem-caret", sub.length ? open ? "▾" : "▸" : "");
    caret.type = "button"; caret.disabled = !sub.length;
    caret.setAttribute("aria-expanded", String(open)); caret.setAttribute("aria-label", open ? "收起子条目" : "展开子条目");
    caret.addEventListener("click", ev => { ev.stopPropagation(); setRowOpen(m, it, !open); });
    row.appendChild(caret);
    row.appendChild(el("span", "agitem-st", statusChip(it, st)));
    const title = el("button", "agitem-title", inline(it.title));
    title.type = "button"; title.title = plain(it.title);
    title.addEventListener("click", ev => { ev.stopPropagation(); selectItem(it.id); setCurrent(itemBox(it.id)); });
    row.appendChild(title);
    if (inTree(it)) {
      const link = el("button", "agitem-tree", "在树中");
      link.type = "button"; link.title = "在下面的项目树里找到它，接着展开它周围的条目；顶上的「返回」回到这里";
      link.addEventListener("click", ev => { ev.stopPropagation(); follow(it.id, true); });
      row.appendChild(link);
    }
    row.appendChild(el("span", "agitem-time", agoText(t.at)));
    li.appendChild(row);
    if (open) {
      const ul = el("ul", "tree");
      mount = m;
      try { sub.forEach(k => ul.appendChild(itemNode(k))); } finally { mount = null; }
      li.appendChild(ul);
    }
    return li;
  }
  function agentRow(r: AgentRow) {
    const box = el("li", "agent");
    box.dataset.agent = r.name;
    const head = el("div", "agent-head");
    head.appendChild(el("span", "agent-name", esc(r.name)));
    const level = agentLevel(r);
    if (level) head.appendChild(el("span", "tagchip diffchip", esc(level))).title = r.role ? "起这个会话时定的等级（派活记录）" : "它最近碰过的、有进行中的行的条目的难度";
    const state = agentState(r); if (state) head.appendChild(state);
    head.appendChild(el("span", "agent-ago", agoText(r.lastAt) + (r.lastKind === "started" ? "起" : "写过"))).title = r.lastKind === "started" ? "派活记录里的开始时间；它还没写过看板" : "它最近一次写看板的时间";
    box.appendChild(head);
    const cells = el("ul", "agent-items");
    for (const t of r.touched) { const it = index().byId.get(t.item); if (it) cells.appendChild(agentItem(r, t, it)); }
    if (cells.children.length) box.appendChild(cells);
    return box;
  }
  function renderAgents() {
    const host = get("agents"); if (!host) return;
    const rows = agentRowsNow();
    // An unfolded cell draws item rows below it, each with what the tree's row shows (its tags, checks, counts, new-content
    // chip, and its own sub-items when unfolded), so each drawn row's presentation joins the list's signature.
    const drawn = (prefix: string, id: string): unknown => [id, presentationSignature(derived, snapshot.decisions, id), freshShown(index().byId.get(id)!), below.fresh[id] || 0, !!pendingExplain("it:" + id),
      agentOpen[prefix + id] ? kids(id, true).filter(passes).map(k => drawn(prefix, k.id)) : 0];
    const unfolded = (prefix: string, id: string): unknown => agentOpen[prefix + id] ? kids(id, true).filter(passes).map(k => drawn(prefix, k.id)) : 0;
    const signature = JSON.stringify([agentsOpen, rows.map(r => [r.name, r.level, r.role, r.state, r.waits, r.amber, r.lastKind, agoText(r.lastAt), r.touched.map(t => {
      const it = index().byId.get(t.item);
      return it ? [t.item, it.title, it.num, statusOf(it), inTree(it), agoText(t.at), unfolded(agentMount(r.name), t.item)] : null;
    })])]);
    if (signature === agentsSignature) return;
    agentsSignature = signature;
    host.hidden = !rows.length;
    host.innerHTML = "";
    if (!rows.length) return;
    const toggle = el("button", "agents-toggle", (agentsOpen ? "▾ " : "▸ ") + "代理 " + rows.length);
    toggle.type = "button"; toggle.setAttribute("aria-expanded", String(agentsOpen)); toggle.title = agentsOpen ? "收起代理列表" : "展开代理列表";
    toggle.addEventListener("click", () => { agentsOpen = !agentsOpen; try { localStorage.setItem("board-agents", agentsOpen ? "open" : "closed"); } catch (e) {} renderNow("agents"); });
    host.appendChild(el("h2", "agents-head")).appendChild(toggle);
    if (!agentsOpen) return;
    host.appendChild(el("p", "agents-note", "最近 6 小时写过看板的会话，各带它最近碰过的 2 个条目。状态是从进行中的行和多久没写推出来的，不是看到的；只读不写的时候（读代码、等 CI）这里看不出。"));
    const list = el("ul", "agent-list");
    rows.forEach(r => list.appendChild(agentRow(r)));
    host.appendChild(list);
  }
  // The blocking waits (cards with blocks, and asks), most urgent first: priority P0 first, then the longest waiting.
  function waitPanel() {
    const rows = stops().filter(blockingStop).map(st => {
      const card = st.id.startsWith("q-") ? snapshot.decisions[st.id.slice(2)] : undefined, it = st.item ? snapshot.items[st.item] : undefined;
      const rank = st.item ? PRIORITY_RANK[derived.priorityOf(st.item)] ?? 3 : 3;
      const since = card ? card.at ?? card.updated : it?.updated ?? "";
      return { st, card, it, rank, since, text: card ? card.blocks || "" : it?.ask?.text || "", project: st.item ? groupOf(index().byId.get(st.item)!) : "", summary: card ? plain(firstLine(card.question)) : plain(it?.title) };
    }).sort((a, b) => a.rank - b.rank || a.since.localeCompare(b.since) || a.st.id.localeCompare(b.st.id));
    if (!rows.length) return null;
    const box = el("div", "waitpanel"); box.id = "wait-panel";
    rows.forEach(r => {
      const short = r.summary.length > 40 ? r.summary.slice(0, 40) + "…" : r.summary;
      const b = el("button", "waitrow", '<span class="waitdot"></span><span class="where">' + esc(r.project || "其他") + '</span><span class="t">' + inline(r.text) + '</span><span class="where">' + esc(short) + "</span>");
      b.type = "button";
      b.addEventListener("click", () => { if (r.card) jumpTo("card", r.st.id.slice(2)); else if (r.st.item) jumpTo("item", r.st.item); });
      box.appendChild(b);
    });
    const plainCards = stops().filter(st => !blockingStop(st)).length;
    if (plainCards) box.appendChild(el("div", "waitmore", "另有 " + plainCards + " 张决策卡不挡工作"));
    return box;
  }
  function planSection(it: ViewItem, before: Item | null | undefined, terms: TermLinks) {
    if (!it.plan.length) return null;
    const changed = new Set(before === undefined ? [] : changedItemPlan(before?.plan, it.plan).map(row => row.id));
    const rows = derived.planRows(it.id), groups = new Map(derived.planGroups(it.id).map(group => [group.start, group]));
    const box = el("section", "plan"); box.setAttribute("aria-label", "计划和进展");
    const ratio = derived.planRatio(it.id);
    const heading = el("div", "log-head", "计划和进展");
    if (it.provisional && !isCancelled(it)) heading.appendChild(el("span", "checktag", "待重写"));
    heading.appendChild(el("span", "steps-ratio", ratio.done + "/" + ratio.total)); box.appendChild(heading);
    const stateClass = (row: typeof rows[number]) => row.dropped ? "dropped" : "item" in row.row && derived.isPaused(row.row.item) ? "paused" : ({resolved:"done",progress:"wip",waiting:"blocked",open:"todo"} as const)[row.state];
    const ref = (kind: "item" | "card", id: string, title: string) => {
      const link = el("a", "plan-link itemref", esc(plain(title))); link.href = "#"; link.dataset.ref = (kind === "item" ? "it:" : "q:") + id;
      return link;
    };
    const renderRow = (value: typeof rows[number]) => {
      const stored = value.row, accept = "accept" in stored && stored.accept;
      const row = el("div", "plan-row " + stateClass(value) + (accept ? " accept" : "") + (fon("progress") && changed.has(stored.id) ? " newbar" : ""));
      row.dataset.sel = "row:" + it.id + "@" + stored.id;
      row.id = planRowId(it.id, stored.id);
      if (current === row.dataset.sel) row.classList.add("cur");
      row.appendChild(el("span", "g", value.glyph));
      const main = el("div", "plan-main");
      if ("text" in stored) {
        if (accept) main.appendChild(el("span", "tag", "验收"));
        let text = stored.text;
        if (stored.state === "doing") text += " · " + derived.stepDays(stored) + " 天" + (stored.waits ? " · 等 " + stored.waits : "");
        else if (stored.state === "done") text += " · " + stored.doneAt!.slice(5,10);
        else if (stored.state === "dropped") text += " · " + stored.reason;
        main.appendChild(el("span", "plan-text rich", linkTerms(blocks(text), terms)));
      } else if ("item" in stored) {
        // An item row looks like the item's own head in the tree: the row glyph carries its status, then priority,
        // title, ratio and tags on one line.
        const target = snapshot.items[stored.item];
        const pr = target ? derived.priorityOf(stored.item) : undefined;
        row.classList.add("item-line", stored.own ? "own" : "shared");
        main.appendChild(el("span", "prio " + (pr ? pr.toLowerCase() : "none"), pr || "P?"));
        const link = ref("item", stored.item, target?.title || stored.item); link.classList.add("item-title"); main.appendChild(link);
        if (stored.own && target) {
          const meta = el("span", "plan-meta"), childRatio = derived.planRatio(stored.item);
          if (childRatio.total) meta.appendChild(el("span", "steps-ratio", childRatio.done + "/" + childRatio.total));
          if (target.provisional && derived.statusOf(stored.item) !== "cancelled") meta.appendChild(el("span", "checktag", "待重写"));
          if (childRatio.total || target.provisional) main.appendChild(meta);
        }
      } else {
        const card = snapshot.decisions[stored.card];
        main.appendChild(el("span", null, !card ? cardTag(stored.card, card) : card.status !== "open"
          ? '<span class="closedtag">' + (card.ruling ? "已裁定" : "已结束") + '</span>'
          : derived.cardBlocking(stored.card)
            ? '<span class="waittag" title="' + esc(card.blocks || "") + '">阻塞</span>'
            : '<span class="asktag">待裁定</span>'));
        const home = card && snapshot.items[card.item] ? index().decById.get(stored.card) : undefined;
        if (home) {
          // The question unfolds the whole card under this row instead of jumping to it, whichever item holds the card.
          const toggle = el("a", "plan-link cardtoggle", esc(plain(firstLine(card!.question)) || stored.card)); toggle.href = "#";
          toggle.setAttribute("aria-expanded", String(inlineShown(home)));
          toggle.title = inlineShown(home) ? "收起这张决策卡" : "展开这张决策卡";
          const flip = (ev: Event) => {
            ev.preventDefault(); ev.stopPropagation();
            inlineOpen[home.id] = !inlineShown(home); saveInline();
            toggle.setAttribute("aria-expanded", String(inlineOpen[home.id])); toggle.title = inlineOpen[home.id] ? "收起这张决策卡" : "展开这张决策卡";
            // Opening selects the card, so c and m act on it; closing leaves the reader where it was.
            if (inlineOpen[home.id]) jump("q-" + home.id); else renderNow("card:" + home.id);
          };
          toggle.addEventListener("click", flip);
          // The whole row folds and unfolds the card, so a click beside a wrapped question still acts; links and buttons
          // inside the row keep their own action.
          row.classList.add("cardrow");
          row.addEventListener("click", ev => { if (!(ev.target as HTMLElement).closest?.("a, button, input, textarea, select, label")) flip(ev); });
          main.appendChild(toggle);
        } else main.appendChild(ref("card", stored.card, card?.question || stored.card));
      }
      row.insertBefore(main, row.children[1] || null);
      return row;
    };
    // An unfolded card follows the first row naming it in the shown item's plan.
    const appendRow = (outer: HTMLElement, value: typeof rows[number]) => {
      const stored = value.row, d = "card" in stored ? index().decById.get(stored.card) : undefined;
      // A card row is one tinted box: the row with its card unfolded inside it, so the title shows once.
      const parent = d && inlineHost(d.id) !== null ? el("div", "cardbox") : outer;
      parent.appendChild(renderRow(value));
      if (d && inlineHost(d.id) === it.id && cardRowOf(it.id, d.id)?.id === stored.id && inlineShown(d)) parent.appendChild(decisionCard(d));
      if (parent !== outer) outer.appendChild(parent);
    };
    const units: Array<{start:number;end:number}> = [];
    for (let i=0; i<rows.length;) {
      const group=groups.get(i), end=group?.end ?? i+1;
      units.push({start:i,end}); i=end;
    }
    const renderUnit = (unit: typeof units[number]) => {
      const group = groups.get(unit.start);
      if (!group) { appendRow(box, rows[unit.start]!); return; }
      const bracket = el("div", "plan-group"); bracket.setAttribute("role", "group"); bracket.setAttribute("aria-label", "可同时进行");
      bracket.appendChild(el("div", "plan-group-label", "可同时进行"));
      rows.slice(unit.start,unit.end).forEach(row => appendRow(bracket, row)); box.appendChild(bracket);
    };
    units.forEach(renderUnit);
    return box;
  }
  function pauseControl(it: ViewItem) {
    // Read-only: the reason a paused item shows, with its source when inherited. Nothing renders otherwise, so an
    // unpaused item has no empty row under its title.
    if (it.record || ended(it) && !it.paused) return null;
    const source = derived.pausedBy(it.id), pause = source ? snapshot.items[source]?.paused : undefined;
    if (!pause) return null;
    const box = el("div", "pause-control");
    const reason = el("span", "pause-reason", "暂停：" + esc(pause.reason));
    if (source !== it.id) {
      reason.appendChild(document.createTextNode(" · 由「"));
      const ancestor = index().byId.get(source!);
      if (ancestor) reason.appendChild(depLink(ancestor));
      reason.appendChild(document.createTextNode("」暂停"));
    }
    box.appendChild(reason);
    return box;
  }
  function itemComments(it: ViewItem) {
    const box=el("div","item-comments");
    const button=el("button","sbtn s-plain item-comment","评论这个条目"); button.type="button";
    button.addEventListener("click",ev => { ev.stopPropagation(); if (!connected) { showDisconnected(); return; } openComment("it:"+it.id); });
    box.appendChild(button);
    const notes=noteBlock("it:"+it.id,it.title); if (notes) box.appendChild(notes);
    return box;
  }

  function targetsSection(it: ViewItem, before: Item | null | undefined) {
    if (!it.targets?.length) return null;
    const changed = new Set(before === undefined ? [] : changedItemTargets(before?.targets, it.targets).map(target => target.id));
    const box = el("div", "item-targets"), table = el("table", "targets-table");
    table.appendChild(el("caption", "log-head", "目标"));
    const columns = ["目标", "当前", "目标值", "比较对象", "日期"];
    const head = el("thead"), headings = el("tr");
    for (const label of columns) { const cell = el("th", null, label); cell.setAttribute("scope", "col"); headings.appendChild(cell); }
    head.appendChild(headings); table.appendChild(head);
    const body = el("tbody");
    for (const target of it.targets) {
      const row = el("tr", "item-target" + (fon("progress") && changed.has(target.id) ? " newbar" : ""));
      row.id = "target-" + it.id + "-" + target.id;
      [target.goal, target.current, target.target, target.baseline, target.date.slice(0, 10)].forEach((value, i) => {
        const cell = el("td", null, esc(value)); cell.dataset.label = columns[i]!; row.appendChild(cell);
      });
      body.appendChild(row);
    }
    table.appendChild(body); box.appendChild(table);
    return box;
  }

  // Logs retain the full history and comment anchors, but never mark unread progress.
  let logOpen: Record<string, boolean> = {};
  function logEntry(e: LogEntry, terms: TermLinks) {
    const row = el("div", "log-entry");
    row.appendChild(el("div", "log-meta", esc(day(e.at)) + (e.by ? " · " + esc(e.by) : "")));
    row.appendChild(el("div", "rich", linkTerms(blocks(e.text),terms)));
    return row;
  }
  function logSection(it: ViewItem, terms: TermLinks) {
    const all = logOf(it), open = !!logOpen[it.id];
    const box = el("div", "log");
    const toggle = el("button", "notes-toggle log-toggle", (open ? "▾ " : "▸ ") + "日志");
    toggle.type = "button"; toggle.setAttribute("aria-expanded", String(open));
    toggle.addEventListener("click", () => { logOpen[it.id] = !open; renderNow("item:"+it.id); });
    box.appendChild(toggle);
    if (!open) return box;
    if (!all.length) box.appendChild(el("div", "sub", "暂无日志"));
    all.forEach((e, i) => {
      const row = logEntry(e, terms);
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
          const b = el("button", "ref q" + (openQ(q) ? " open" : "") + (d && (inPlan(d) ? inlineShown(d) : d.status !== "open" && ruledShown(d)) ? " shown" : ""), esc(label.length > 24 ? label.slice(0, 24) + "…" : label) + (d && d.status !== "open" && d.ruling ? " · " + esc(d.ruling.length > 18 ? d.ruling.slice(0, 18) + "…" : d.ruling) : "") + (talk ? " · 评论 " + talk : ""));
          b.type = "button";
          b.title = d ? (d.status === "open" ? "待你决定" : "点开查看这张已结束的决策卡和它的评论") : "";
          b.addEventListener("click", () => {
            if (!d) return;
            if (inPlan(d)) { const show = !inlineShown(d); inlineOpen[q] = show; saveInline(); if (show) jump("q-"+q); else renderNow("card:"+q); return; }
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
        a.appendChild(el("span", null, '<span class="waittag">阻塞</span> ' + inline(it.ask?.text)));
        if (/^https:\/\//.test(it.ask?.url || "")) { const go = el("a", "okbtn golink", "去处理 ↗"); go.href = it.ask!.url!; go.target = "_blank"; go.rel = "noopener"; a.appendChild(go); if (connected) a.appendChild(answerButton("done", "it:" + it.id, it.title, it.ask!.text)); }
        else if (it.ask?.chat) a.appendChild(el("span", "chatnote", "请在对话窗口里确认"));
        else if (connected) a.appendChild(answerButton("approve", "it:" + it.id, it.title, it.ask!.text));
        a.appendChild(nextButton("ask-" + it.id));
        // Sends this item's answer alone; it stays disabled until the answer is waiting to go out.
        const kind: DraftKind | "" = /^https:\/\//.test(it.ask?.url || "") ? "done" : it.ask?.chat ? "" : "approve";
        if (kind) {
          const send = el("button", "cardsend", "发送");
          send.type = "button"; send.dataset.asksend = it.id; send.dataset.askkind = kind;
          send.disabled = !connected || !pendingDraft("it:" + it.id, kind);
          send.addEventListener("click", () => sendDrafts(note => note.target === "it:" + it.id && note.kind === kind));
          a.appendChild(send);
        }
        return a;
      }
    return null;
  }
  function itemNode(it: ViewItem, headerOnly = false, boxOnly = false, detail = false) {
    const m = mount;
    const retained=m ? undefined : groupReuse?.items.get(it.id);
    if (retained && !groupReuse!.dirtyItems.has(it.id) && !headerOnly && !boxOnly && !detail) return retained;
    const li = el("li");
    // Filters open sub-item paths; the body renders only as the selected item's detail.
    const open = rowOpen(m, it), bodyOpen = detail;
    const baseline = unreadBefore<Item>("item",it.id);
    const before = baseline;
    const st = statusOf(it) ?? "record";
    const context = filtering(groupOf(it)) ? !filterMatches().hit.has(it.id) : !detail && ended(it);
    const box = el("div", "item " + st + (up(it) ? "" : " line") + (baseline === null ? " fresh" : "") + (context ? " ctx" : ""));
    box.id = detail ? "detail-it-" + it.id : (m ? m.prefix : "") + "it-" + it.id;
    if (!detail && shownForFresh(it)) box.classList.add("fresh-ended");
    if (detail) box.dataset.sel = "it:"+it.id;
    // The selection and the current mark show in the tree only.
    if (!detail && !m && selectedItem === it.id) box.classList.add("selected");
    if (!m && current === "it:" + it.id) box.classList.add("cur");
    const sub = kids(it.id,true).filter(passes);
    const ck = checksOf(it);

    const head = el("button", "item-head");
    head.type = "button";

    // The baseline is a document; status and priority are derived. Restore
    // that document and use the same current reference targets for comparison.
    const beforeRules = before ? rules({ ...snapshot, items: { ...snapshot.items, [it.id]: before } }) : undefined;
    const beforeStatus = beforeRules?.statusOf(it.id) ?? (before ? "record" : undefined);
    head.appendChild(el("span", "st " + st + (before && beforeStatus !== st ? " chg-add" : ""), esc(chipText(it, st)))).title = it.num === undefined ? "" : STATUS[st] || st;
    const pr = priorityOf(it);
    head.appendChild(el("span", "prio " + (pr ? pr.toLowerCase() : "none") + (beforeRules && beforeRules.priorityOf(it.id) !== pr ? " chg-add" : ""), pr || "P?"));
    appendTitle(head,it.title,before === null ? null : before?.title,"item-title");
    if (!detail && it.tags?.length) { const tags = el("span", "tagchips"); for (const name of it.tags) tags.appendChild(el("span", "tagchip", esc(name))).title = (snapshot.board.tags ?? []).find(t => t.name === name)?.meaning ?? ""; head.appendChild(tags); }
    if (it.plan.length) {
      const ratio = derived.planRatio(it.id);
      head.appendChild(el("span", "steps-ratio", ratio.done + "/" + ratio.total));
    }
    if (!detail) head.querySelector<HTMLElement>(".item-title")!.title=plain(it.title);
    // One tag per distinct label, each explained by its checks' full texts; a cancelled item shows none.
    if (!isCancelled(it)) for (const label of new Set(ck.map(checkLabel))) head.appendChild(el("span", "checktag", esc(label))).title = ck.filter(c => checkLabel(c) === label).map(c => c.text).join("\n");
    const stalledBelow = sub.length && !open ? derived.stalledBelow(it.id) : 0;
    if (stalledBelow) head.appendChild(el("span", "checktag stalledbelow", esc(STALLED_LABEL) + " " + stalledBelow)).title = stalledBelow + " 个进行中的下级条目 1 小时（活跃时间）没有动静";
    const ownFresh = freshShown(it), freshCount = (ownFresh ? 1 : 0) + (below.fresh[it.id] || 0);
    if (freshCount) head.appendChild(freshChip("it:" + it.id, freshCount, ownFresh));
    const pc = pendingChip("it:" + it.id);
    if (pc) head.appendChild(pc);
    // Numbers count the waits in the item and below it: purple blocks work, red blocks none. Each leads to its first place.
    for (const [cls, count, label, wanted] of [["waittag", derived.blockingBelow(it.id), "处阻塞工作", true], ["asktag", derived.nonBlockingBelow(it.id), "张决策卡不挡工作", false]] as const) {
      if (!count) continue;
      const chip = el("span", cls, String(count));
      chip.title = count + " " + label; chip.setAttribute("aria-label", chip.title); head.appendChild(chip);
      // The stops this number counts: the item's own and those of the items it owns, read when clicked so a re-render
      // elsewhere cannot leave the chip pointing at a stale position. Each click goes to the next of them, then around.
      const reachable = () => {
        const sub = new Set<string>(), walk = (v: string) => { if (sub.has(v)) return; sub.add(v); derived.children(v).forEach(walk); };
        walk(it.id);
        return stops().map((st, k) => ({ st, k })).filter(({ st }) => !!st.item && sub.has(st.item) && blockingStop(st) === wanted).map(({ k }) => k);
      };
      if (reachable().length) {
        chip.setAttribute("role","button"); chip.tabIndex=0;
        const go=(ev: Event) => { ev.stopPropagation(); ev.preventDefault(); const ks = reachable(), at = chipClicks.get(cls+it.id) ?? 0; if (ks.length) { chipClicks.set(cls+it.id, at + 1); goStop(ks[at % ks.length]!); } };
        chip.addEventListener("click",go); chip.addEventListener("keydown",ev => { if (ev.key === "Enter" || ev.key === " ") go(ev); });
      }
    }
    // The blue line marks what m on this item reads: its own new content. New sub-items carry their own line, and a
    // parent with nothing new of its own shows them only in its 新 chip.
    if (ownFresh) box.classList.add("fresh");
    // A head click selects the item whose detail is displayed.
    head.addEventListener("click", ev => {
      ev.stopPropagation(); selectItem(it.id); setCurrent(itemBox(it.id));
      (m ? box : get("it-"+it.id))?.querySelector<HTMLElement>(".item-head")?.focus({preventScroll:true});
    });
    // The row is the head alone: the actions live in the shortcut menu (☰) and its keys.
    const row = el("div", "item-row" + (!detail ? " tree-row" : ""));
    const caret=el("button","caret",sub.length ? open ? "▾" : "▸" : "");
    caret.type="button"; caret.disabled=!sub.length;
    caret.setAttribute("aria-expanded",String(open)); caret.setAttribute("aria-label",open ? "收起子条目" : "展开子条目");
    caret.addEventListener("click", ev => { ev.stopPropagation(); setRowOpen(m, it, !open); });
    row.appendChild(caret);
    row.addEventListener("click", () => { selectItem(it.id); setCurrent(itemBox(it.id)); });
    // A double-click on a tree row folds or unfolds its sub-items, as the caret does; a single click only selects.
    if (!detail && sub.length) row.addEventListener("dblclick", ev => {
      if ((ev.target as HTMLElement).closest?.("button.caret, a, [role=button]")) return;
      getSelection()?.removeAllRanges?.(); setRowOpen(m, it, !open);
    });
    row.appendChild(head);
    // A parent counts its leaves by status at the right of its row; cancelled ones are left out.
    if ((index().children.get(it.id) || []).length) {
      const n: Record<string,number> = {};
      leavesOf(it).filter(l => l !== it && !isCancelled(l)).forEach(l => { const k = statusOf(l); if (k !== undefined) n[k] = (n[k] || 0) + 1; });
      const cs = el("span", "counts");
      // Done and cancelled parts are not counted on the row: only what is still open.
      ["todo", "stalled", "wip", "blocked", "paused"].forEach(k => { if (n[k]) {
        const count=el("span", "st " + k, String(n[k]));
        count.setAttribute("aria-label",(STATUS[k] || k)+" "+n[k]);
        cs.appendChild(count);
      } });
      if (cs.children.length) row.appendChild(cs);
    }
    box.appendChild(row);
    // The line under the detail's title: the difficulty first, then the tags; an item with only a difficulty has it too.
    if (detail && (it.tags?.length || it.difficulty !== undefined)) {
      const chips = el("div", "tagchips item-tags");
      if (it.difficulty !== undefined) chips.appendChild(el("span", "tagchip diffchip", difficultyText(it.difficulty))).title = "难度等级，只有架构师能改";
      for (const name of it.tags ?? []) chips.appendChild(el("span", "tagchip", esc(name))).title = (snapshot.board.tags ?? []).find(t => t.name === name)?.meaning ?? "";
      box.appendChild(chips);
    }
    // Then how far the item is and what holds it, on a line of its own; the tree rows show neither.
    if (detail) {
      const line = progressLine(statusOf(it), derived.progress(it.id), { item: id => index().byId.get(id)?.title ?? id, card: key => snapshot.decisions[key]?.question ?? key });
      if (line) box.appendChild(el("div", "progress-line " + line.kind, esc(plain(line.text))));
    }
    if (detail) { const pause = pauseControl(it); if (pause) box.appendChild(pause); }
    if (headerOnly) { li.appendChild(box); return li; }
    if (bodyOpen) {
      const body = el("div", "body");
      const terms = itemTerms(it.id);
      const targets = targetsSection(it, before); if (targets) body.appendChild(targets);
      const plan = planSection(it, before, terms); if (plan) body.appendChild(plan);
      // Progress first, then the stable head, then the owner's comments on it, then the log.
      if (headOf(it)) body.appendChild(el("div", "rich", linkTerms(markedBlocks(before?.head ?? (before ? "" : undefined),headOf(it),"it:" + it.id),terms)));
      if (it.data) body.appendChild(el("div", "data", inline(it.data)));
      const ws = derived.dependents(it.id).filter(row => !row.own).map(row => index().byId.get(row.id)).filter((row): row is ViewItem => !!row && !isCancelled(row));
      if (ws.length) {
        const list = el("div", "deplists"); list.appendChild(el("div", "k", "被依赖"));
        ws.forEach(row => list.appendChild(depRow(row,it))); body.appendChild(list);
      }
      body.appendChild(itemComments(it));
      body.appendChild(logSection(it, terms));
      // The owner's request and the cards its plan does not name follow its progress and optional log history.
      const ask = askRow(it,before); if (ask) body.appendChild(ask);
      cardsUnder(it).filter(d => !inPlan(d)).forEach(d => body.appendChild(decisionCard(d)));
      ruledUnder(it).filter(d => !inPlan(d) && ruledShown(d)).forEach(d => body.appendChild(decisionCard(d)));
      if (ck.length) {
        const cb = el("div", "checks");
        ck.forEach(c => { const r = el("div", null, "需核对：" + esc(c.text) + " "); if (c.target) r.appendChild(depLink(c.target)); cb.appendChild(r); });
        body.appendChild(cb);
      }
      const refs=refsRow(it,before); if (refs) body.appendChild(refs);
      box.appendChild(body);

    }
    li.appendChild(box);
    if (open && sub.length && !boxOnly && !detail) {
      const ul = el("ul", "tree");
      sub.forEach(k => ul.appendChild(itemNode(k)));
      li.appendChild(ul);
    }
    return li;
  }
  // A top-level item that an open item of another project depends on directly: its priority comes from those dependents.
  function neededElsewhere(t: ViewItem) { return waitedBy().get(t.id)!.some(w => !ended(w) && groupOf(w) !== groupOf(t)); }
  function projectGroups() {
    const groups: Array<{name:string;items:ViewItem[]}> = snapshot.board.projects.map(p => ({name:p.name,items:[]}));
    tops().forEach(t => { const name = t.group || ""; let group = groups.find(g => g.name === name); if (!group) { group = {name,items:[]}; groups.push(group); } group.items.push(t); });
    groups.forEach(g => { g.items = [...g.items.filter(t => !neededElsewhere(t)), ...g.items.filter(neededElsewhere)]; });
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
      box.dataset.group=g.name;
      const gh = el("h2", "group-head", inline(g.name || "其他"));
      box.appendChild(gh);
      if (!partial) { const gl = el("a", "grp", esc(g.name || "其他")); gl.href = "#group-" + gi; nav.appendChild(gl); }
      box.appendChild(filterRow(g.name));
      const shown = g.items.filter(passes);
      if (shown.length) {
        const list = (xs: ViewItem[]) => { const ul = el("ul", "tree lines"); xs.forEach(t => ul.appendChild(itemNode(t))); box.appendChild(ul); };
        const own = shown.filter(t => !neededElsewhere(t)), shared = shown.filter(neededElsewhere);
        if (own.length) list(own);
        if (shared.length) { box.appendChild(el("div", "shared-sep", "被其他项目依赖")); list(shared); }
      }
      else box.appendChild(el("p", "empty", "没有符合这个筛选的条目。"));
      if (partial) get("group-"+gi).replaceWith(box); else wrap.appendChild(box);
    });
    if (!partial) root.appendChild(wrap);
    groupReuse=undefined;
  }

  function choiceOf(d: ViewDecision) {
    const overlay = optimistic.get(draftKey("q:"+d.id,"choice"));
    return overlay ? overlay.on ? sendingDrafts.has(draftKey("q:"+d.id,"choice")) ? {...overlay,state:"sent" as const} : overlay : undefined : notesOf("q:" + d.id).find(n => n.kind === "choice" && (n.state === "draft" || n.state === "sent" || n.state === "done"));
  }
  function decisionCard(d: ViewDecision) {
    const retained=groupReuse?.cards.get(d.id); if (retained && !groupReuse!.dirtyCards.has(d.id)) return retained;
    const before = unreadBefore<Decision>("decision",d.id);
    const c = el("article", "card" + (current === "q:" + d.id ? " cur" : "") + (before === null ? " fresh" : ""));
    c.id = "q-" + d.id;
    c.hidden = sendingChoice(d.id);
    const terms = itemTerms(d.item);
    const top = el("div", "card-top");
    const h = el("h3");
    const inlined = inlineHost(d.id) !== null; // the plan row above carries the title and the status
    if (inlined) c.classList.add("inlinecard");
    const closed = d.status !== "open";
    if (derived.cardBlocking(d.id)) { const tag = el("span", "waittag", "阻塞"); tag.title = d.blocks || ""; h.appendChild(tag); }
    else if (waitsQ(d)) h.appendChild(el("span", "asktag", "决策卡"));
    if (closed) h.appendChild(el("span", "closedtag" + (before && before.status !== d.status ? " chg-add" : ""), d.ruling ? "已裁定" : "已结束"));
    if (d.num !== undefined) h.appendChild(el("span", "cardnum", String(d.num))).title = "决策卡编号";
    if (proseBlocks(d.question).length > 1) {
      h.appendChild(el("span", "rich" + (before === null ? " chg-add" : ""),linkTerms(markedBlocks(before?.question,d.question),terms)));
    } else appendTitle(h,d.question || "",before === null ? null : before?.question,"",terms);
    // A card counts toward its item's chip; only a card no item holds shows a chip of its own.
    if (cardFresh(d)) { if (!homeOf(d)) h.appendChild(freshChip("q:" + d.id, 1, true)); c.classList.add("fresh"); }
    const pc = pendingChip("q:" + d.id);
    if (pc && !inlined) h.appendChild(pc);
    if (!inlined) top.appendChild(h); else if (pc) top.appendChild(pc);
    if (closed) {
      const x = el("button", "cbtn", "收起"); x.type = "button";
      x.addEventListener("click", ev => { ev.stopPropagation(); ruledOpen[d.id] = false; saveRuled(); const host = inlineHost(d.id); if (host) { inlineOpen[d.id] = false; saveInline(); } renderNow(host ? "card:"+d.id : homeOf(d) ? "item:"+d.item : "cards"); });
      top.appendChild(x);
    }
    if (top.children.length) c.appendChild(top);
    if (closed && d.ruling) c.appendChild(el("div", "rich", '<div class="sub">裁定</div>' + linkTerms(markedBlocks(before?.ruling ?? (before ? "" : undefined),d.ruling || ""),terms) + (d.ruledAt ? '<p>' + esc(day(d.ruledAt)) + '</p>' : '')));
    if (d.background) c.appendChild(el("div", "rich", '<div class="sub">背景</div>' + linkTerms(markedBlocks(before?.background,d.background || ""),terms)));
    derived.cardChecks(d.id).forEach(k => c.appendChild(el("div", "checks", "需核对：" + esc(k.text))));
    const chosen = choiceOf(d);
    if (d.options.length) {
      c.appendChild(el("p", null, '<span class="lbl">选项：</span>'));
      const ol = el("ul", "opts");
      const oldOptions = new Map(before?.options.map(o => [o.key,o]));
      d.options.forEach(o => {
        const li = el("li");
        const sel = (chosen?.choice || d.choice) === o.key;
        const rec = !!o.recommended || /[（(]推荐[)）]/.test(o.text || "");
        const btn = el("button", "optbtn" + (before && oldOptions.get(o.key)?.recommended !== o.recommended ? " chg-add" : "") + (rec ? " rec" : "") + (sel ? " sel" : ""), (rec ? '<span class="recchip">推荐</span>' : "") + '<span class="lbl">' + esc(o.key) + "：</span>" + '<div class="rich">' + linkTerms(markedBlocks(!before ? undefined : oldOptions.get(o.key)?.text || "",o.text),terms) + '</div>');
        btn.type = "button";
        btn.dataset.option = o.key;
        btn.setAttribute("aria-pressed", String(sel));
        btn.disabled = !connected || closed || !!(chosen && chosen.state !== "draft") || optimistic.has(draftKey("q:"+d.id,"choice"));
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
      // Sends this card's drafts alone; it stays disabled until a choice is waiting to go out.
      const send = el("button", "cardsend", "发送");
      send.type = "button"; send.dataset.cardsend = d.id;
      send.disabled = !connected || choiceOf(d)?.state !== "draft";
      send.addEventListener("click", () => sendDrafts(note => note.target === "q:" + d.id));
      foot.appendChild(send);
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
  // The reader scrolling the list releases a landing; the list scrolls in the left pane.
  function listScrolled() {
    if (landing && !landing.pane && (expectedScroll === null || Math.abs(listScroller().position()-expectedScroll)>1)) releaseLanding();
  }
  get("page-left").addEventListener("scroll", () => listScrolled(), { passive: true });

  // A snapshot can re-render while the owner is typing; keep the editor's focus and caret.
  // The item or card the reader is looking at, and where it sits, so a data update does not move the page under them.
  function scrollAnchor() {
    const cur = boxOfKey(current);
    const origin=listScroller().origin();
    if (cur && !get("item-detail").contains(cur) && onScreen(cur)) return { id: cur.id, top: cur.getBoundingClientRect().top-origin };
    const e = [...document.querySelectorAll<HTMLElement>("#areas .item, #areas .card, #cards .card")].find(x => x.getBoundingClientRect().bottom > origin);
    return e ? { id: e.id, top: e.getBoundingClientRect().top-origin } : null;
  }
  const dirty = new Set<string>();
  let renderQueued = false;
  let waitingOrder:string[]=[];
  const renderWaiters:Array<() => void>=[];
  let rulePresentationDirty=true;
  // Items a live update may have changed (rules affectedItems); only these are signed again while nothing asks for all.
  let presentationAffected:Set<string> | null=null;
  // What the last paint drew for an item: its derived signature, whether the filters show it, its project group and, for a top-level item, whether it sits under 被其他项目依赖.
  type Presented={signature:string;shown:boolean;group:string;shared:boolean};
  let presentations=new Map<string,Presented>();
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
    if (!rulePresentationDirty && !presentationAffected) return;
    const all=rulePresentationDirty, only=presentationAffected;
    rulePresentationDirty=false; presentationAffected=null;
    const next=all ? new Map<string,Presented>() : new Map(presentations);
    if (!all) for (const id of only!) if (!index().byId.has(id)) next.delete(id);
    for (const it of all ? state.items : [...only!].flatMap(id => index().byId.get(id) ?? [])) signPresentation(it,next,scope);
    presentations=next;
  }
  function signPresentation(it:ViewItem,next:Map<string,Presented>,scope:Set<string>) {
    const id=it.id;
    const signature=presentationSignature(derived,snapshot.decisions,id);
    const current={signature,shown:passes(it),group:groupOf(it),shared:!derived.parentOf(id) && neededElsewhere(it)}, previous=presentations.get(id);
    next.set(id,current);
    if (!previous) return;
    if (previous.signature !== signature) scope.add("item:"+id);
    if (previous.shown !== current.shown) { scope.add("group:"+previous.group); scope.add("group:"+current.group); }
    // A top-level item changes between its project's own roots and the roots other projects depend on: that is the group's layout.
    if (previous.shared !== current.shared) scope.add("group:"+current.group);
  }
  function scopeForDoc(kind:string,id:string,target?:string):string[] {
    return kind === "item" ? ["item:"+id] : kind === "decision" ? ["card:"+id] : target ? ["notes:"+target] : [];
  }
  function replaceNotes(target:string) {
    if (target.startsWith("q:")) {
      reconcileCard(target.slice(2)); return;
    }
    const it=index().byId.get(target.slice(3)), box=itemBox(target.slice(3)); if (!it || !box) return;
    const old=box.querySelector<HTMLElement>(".item-comments"), next=bodyShown(it.id) ? itemComments(it) : null;
    if (old && next) old.replaceWith(next); else if (old) old.remove();
    const ask=get("ask-"+it.id), nextAsk=askRow(it,unreadBefore<Item>("item",it.id));
    const body=[...box.children].find(e => e.classList.contains("body"));
    if (ask && nextAsk) ask.replaceWith(nextAsk); else if (ask) ask.remove(); else if (body && nextAsk) body.insertBefore(nextAsk,[...body.children].find(e => e.classList.contains("card")) || null);
  }
  function reconcileCard(id:string) {
    const d=index().decById.get(id), old=get("q-"+id), host=d ? inlineHost(id) : null;
    if (d && host) {
      // An inline card lives right after its plan row, only while unfolded and its host item's body is shown.
      const planned=cardRowOf(host,id);
      const row=bodyShown(host) && planned ? get(planRowId(host,planned.id)) : null, parent=row?.parentElement;
      const toggle=row?.querySelector<HTMLElement>(".cardtoggle");
      if (toggle) { toggle.setAttribute("aria-expanded",String(inlineShown(d))); toggle.title=inlineShown(d) ? "收起这张决策卡" : "展开这张决策卡"; }
      if (!row || !parent || !inlineShown(d)) old?.remove();
      else {
        const next=decisionCard(d);
        old?.remove();
        parent.insertBefore(next,[...parent.children][[...parent.children].indexOf(row)+1] || null);
      }
      get("decisions").hidden=!get("cards").children.length;
      return;
    }
    const home=d ? homeOf(d) : null, item=home ? itemBox(home) : null;
    const container=d && (home ? bodyShown(home) && item?.querySelector<HTMLElement>(":scope > .body") : get("cards"));
    if (!d || !container || d.status !== "open" && !ruledShown(d)) { old?.remove(); }
    else {
      const last=[...container.children].reverse().find(e => e.classList.contains("card"));
      const after=last ? [...container.children][[...container.children].indexOf(last)+1] || null : [...container.children].find(e => e.classList.contains("checks") || e.classList.contains("refs")) || null;
      const next=decisionCard(d);
      if (old && old.parentElement === container) old.replaceWith(next); else { old?.remove(); container.insertBefore(next,after); }
      const ids=home ? [...cardsUnder(index().byId.get(home)!),...ruledUnder(index().byId.get(home)!).filter(ruledShown)].filter(d => !inPlan(d)).map(d => d.id) : state.decisions.filter(d => !homeOf(d) && (d.status === "open" || ruledShown(d))).sort(byOrder).map(d => d.id);
      const cards=ids.map(id => get("q-"+id)).filter((e):e is HTMLElement => !!e && e.parentElement === container);
      cards.forEach(card => container.insertBefore(card,after));
    }
    get("decisions").hidden=!get("cards").children.length;
  }
  function patchRefs(id:string) {
    const it=index().byId.get(id), box=itemBox(id); if (!it || !box) return;
    const body=[...box.children].find(e => e.classList.contains("body")); if (!body) return;
    const old=[...body.children].find(e => e.classList.contains("refs")), next=refsRow(it,unreadBefore<Item>("item",id));
    if (old && next) old.replaceWith(next); else if (old) old.remove(); else if (next) body.appendChild(next);
  }
  function renderDetail(scope:Set<string>) {
    const pane=get("item-detail");
    const top=pane.scrollTop;
    const retained=new Map(elements(pane).filter(e => e.classList.contains("card")).map(e => [e.id,e]));
    pane.innerHTML="";
    const it=selectedItem && index().byId.get(selectedItem);
    pane.hidden=!it;
    divider.hidden=!it;
    if (it) wrap.classList.remove("detail-collapsed"); else wrap.classList.add("detail-collapsed");
    if (it) {
      applyTreeWidth();
      const next=itemNode(it,false,true,true);
      for (const card of elements(next).filter(e => e.classList.contains("card"))) {
        const old=retained.get(card.id), id=card.id.slice(2);
        if (old && !scope.has("all") && !scope.has("detail") && !scope.has("card:"+id) && !scope.has("notes:q:"+id)) card.replaceWith(old);
      }
      [...next.children].forEach(child => pane.appendChild(child));
      // The diagrams the library has drawn before are drawn now, not a microtask later: the scroll position restored below is clamped to
      // the height the pane has at that moment, and a diagram is taller than the code it replaces.
      drawMermaid(pane);
    }
    pane.scrollTop=top;
    detailDirty=false;
  }
  function renderPage(scope:Set<string>) {
    presentationScopes(scope);
    // Live updates rebuild the page; a text field being typed in keeps its focus and caret.
    const a = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
    const keep = a && a.id && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") ? { id: a.id, start: a.selectionStart, end: a.selectionEnd } : null;
    const anchor = landing ? landing.gliding ? null : {...landing} : listScroller().position() > 0 ? scrollAnchor() : null;
    const paneTop=get("item-detail").scrollTop;
    countBelow();
    const detailPainted=detailDirty || scope.has("all") || scope.has("detail") || !!selectedItem && scope.has("item:"+selectedItem);
    if (detailPainted) renderDetail(scope);
    if (scope.has("all") || scope.has("areas")) renderAreasDOM();
    else { const groups=new Set([...scope].filter(k => k.startsWith("group:")).map(k => k.slice(6))); if (groups.size) renderAreasDOM(groups,scope); }
    if (scope.has("all") || scope.has("cards")) renderCardsDOM();
    if (!scope.has("all")) {
      const heads=new Set<string>(), drawnCards=new Set<string>(), drawnItems=new Set<string>(), refs=new Set<string>();
      // Areas/groups paint hosted content; the cards scope paints only loose cards.
      const paintedHome=(home:string | null) => home ? home === selectedItem && detailPainted : scope.has("cards");
      // A card unfolded in the shown item's plan is painted with that item, wherever its own item is.
      const shownIn=(d:ViewDecision) => selectedItem && inlineHost(d.id) === selectedItem ? selectedItem : homeOf(d);
      for (const key of scope) {
        const kind=key.slice(0,key.indexOf(":")), id=key.slice(key.indexOf(":")+1);
        if (kind === "item" || kind === "tree") {
          const it=index().byId.get(id), old=get("it-"+id); if (it && old && !scope.has("areas") && !scope.has("group:"+groupOf(it))) {
            const next=itemNode(it,false,kind !== "tree");
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
          if (it) { if (kind === "tree") heads.add(id); derived.ancestors(id).forEach(p => heads.add(p)); }
        } else if (kind === "card") {
          const d=index().decById.get(id); if (d && !paintedHome(shownIn(d)) && !drawnCards.has(id)) { reconcileCard(id); drawnCards.add(id); }
          if (d) { heads.add(d.item); derived.ancestors(d.item).forEach(p => heads.add(p)); }
          if (d) refs.add(d.item);
        } else if (kind === "notes") {
          const card=id.startsWith("q:") ? id.slice(2) : null;
          const d=card ? index().decById.get(card) : undefined, home=card ? d ? shownIn(d) : null : id.slice(3);
          if (!paintedHome(home) && !(card && drawnCards.has(card)) && !(id.startsWith("it:") && drawnItems.has(id.slice(3)))) { replaceNotes(id); if (card) drawnCards.add(card); }
          const item=id.startsWith("it:") ? id.slice(3) : snapshot.decisions[id.slice(2)]?.item;
          if (item) { heads.add(item); derived.ancestors(item).forEach(p => heads.add(p)); }
          if (item && card) refs.add(item);
        } else if (kind === "head") heads.add(id);
      }
      refs.forEach(patchRefs);
      for (const id of heads) {
        const it=index().byId.get(id), old=get("it-"+id); if (!it) continue;
        if (old && !scope.has("areas") && !scope.has("group:"+groupOf(it))) {
          const next=itemNode(it,true).children[0] as HTMLElement;
          old.children[0]!.replaceWith(next.children[0]!); old.className=next.className;
        }
        if (id === selectedItem && !detailPainted) {
          const detail=itemBox(id);
          if (detail) {
            const head=itemNode(it,true,true,true).children[0] as HTMLElement;
            detail.children[0]!.replaceWith(head.children[0]!); detail.className=head.className;
          }
        }
      }
      // Keep the existing sibling subtrees while reflecting derived status/priority ordering.
      const parents=new Set<HTMLElement>();
      for (const key of scope) if (key.startsWith("item:")) { const li=get("it-"+key.slice(5))?.parentElement; if (li?.parentElement) parents.add(li.parentElement); }
      for (const parent of parents) {
        const rows=[...parent.children] as HTMLElement[];
        if (parent.parentElement?.tagName === "LI" && rows.every(li => li.children[0]?.id.startsWith("it-"))) rows.sort((a,b) => { const owner=parent.parentElement!.children[0]!.id.slice(3), order=derived.children(owner); return order.indexOf(a.children[0]!.id.slice(3))-order.indexOf(b.children[0]!.id.slice(3)); }).forEach(li => parent.appendChild(li));
      }
    }
    // Group counts and dependency summaries are independent of the unchanged item/card subtrees.
    projectGroups().forEach((g,i) => {
      const box=get("group-"+i); if (!box) return;
      const filters=[...box.children].find(e => e.classList.contains("grp-filters")); if (filters) filters.replaceWith(filterRow(g.name));
      const head=box.children[0] as HTMLElement | undefined; if (!head) return;
      const next=el("h2","group-head",inline(g.name || "其他"));
      head.replaceWith(next);
    });
    const order=stops().map(s => s.id);
    if (!sameValue(order,waitingOrder)) {
      waitingOrder=order;
      for (const root of [get("areas"),get("cards"),get("item-detail")]) for (const button of elements(root).filter(e => e.dataset.stop)) button.replaceWith(nextButton(button.dataset.stop!));
    }
    renderHeader(); renderAgents(); renderSend(); renderMenu();
    get("item-detail").scrollTop=paneTop;
    if (anchor) { const e = get(anchor.id); if (e) {
      const s="pane" in anchor && anchor.pane ? detailScroller() : listScroller();
      const d=e.getBoundingClientRect().top-s.origin()-anchor.top;
      if (d) s.by(d);
      if ("pane" in anchor && anchor.pane || landing) s.expect();
    } }
    if (keep) { const t = get<HTMLTextAreaElement | HTMLInputElement>(keep.id); if (t) { t.focus({ preventScroll: true }); try { t.setSelectionRange(keep.start, keep.end); } catch (e) {} } }
  }
  const divider=get("split-divider"), wrap=document.querySelector<HTMLElement>(".wrap")!;
  divider.setAttribute("role","separator"); divider.setAttribute("aria-orientation","vertical");
  divider.setAttribute("aria-label","调整左右栏宽度"); divider.setAttribute("aria-controls","areas item-detail");
  let drag: {pointer:number;x:number;width:number} | null = null;
  function applyTreeWidth() {
    // Desktop columns retain their useful minimums; narrow-screen CSS lets both columns shrink to fit.
    const maximum=Math.max(300,Math.floor(wrap.getBoundingClientRect().width-8-380));
    const width=Math.round(Math.max(300,Math.min(maximum,treeWidth ?? (wrap.getBoundingClientRect().width-8)/2.3)));
    wrap.style.setProperty("--tree-width",width+"px");
    divider.setAttribute("aria-valuemin","300"); divider.setAttribute("aria-valuemax",String(maximum)); divider.setAttribute("aria-valuenow",String(width));
    return width;
  }
  function resizeTree(width:number) {
    treeWidth=width;
    treeWidth=applyTreeWidth()!;
    try { localStorage.setItem("board-tree-width",String(treeWidth)); } catch {}
  }
  function endDrag() {
    if (!drag) return;
    divider.releasePointerCapture(drag.pointer); drag=null;
  }
  divider.addEventListener("pointerdown",ev => {
    if (divider.hidden || drag || ev.button !== 0) return;
    ev.preventDefault();
    drag={pointer:ev.pointerId,x:ev.clientX,width:applyTreeWidth()!}; divider.setPointerCapture(ev.pointerId);
  });
  divider.addEventListener("pointermove",ev => { if (drag && ev.pointerId === drag.pointer) resizeTree(drag.width+ev.clientX-drag.x); });
  for (const kind of ["pointerup","pointercancel"] as const) divider.addEventListener(kind,ev => { if (drag && ev.pointerId === drag.pointer) endDrag(); });
  divider.addEventListener("lostpointercapture",() => { drag=null; });
  window.addEventListener("resize",() => applyTreeWidth(),{passive:true});

  get("item-detail").addEventListener("scroll", () => {
    if (landing?.pane && (expectedDetailScroll === null || Math.abs(get("item-detail").scrollTop-expectedDetailScroll)>1)) releaseLanding();
  }, {passive:true});
  applyTreeWidth();
  detailDirty=true; releaseLanding(); renderAll();

  get("to-top").addEventListener("click", () => glideTo(0));

  // React before awaiting draft writes, but never send a draft whose save failed.
  async function sendDrafts(pick?: (note: Pick<ViewNote,"target" | "kind"> & {id?:string}) => boolean) {
    if (sending) return;
    if (!connected) { showDisconnected(); return; }
    sending = true; sendMessage = "";
    const selected = new Set(state.notes.filter(n => n.state === "draft" && !sendPending(n) && (!pick || pick(n))).map(n => n.id));
    const targets = new Set(state.notes.filter(n => selected.has(n.id)).map(n => n.target));
    for (const [key,overlay] of optimistic) {
      const split=key.lastIndexOf("|"), target=key.slice(0,split), kind=key.slice(split+1) as DraftKind;
      if (overlay.on && (!pick || pick({target,kind}))) { sendingDrafts.add(key); targets.add(target); }
    }
    selected.forEach(id => sentNotes.add(id));
    const paint = () => { renderNow(...[...targets].map(target => "notes:"+target)); renderSend(); };
    paint();
    let succeeded=false;
    try {
      const drafts=[...[...optimistic.values()].map(o => o.promise!), ...pendingEdits.values()];
      if ((await Promise.all(drafts)).some(ok => !ok)) return;
      for (const [id,n] of Object.entries(snapshot.notes)) if (n.state === "draft" && sendingDrafts.has(draftKey(n.target,n.kind as DraftKind))) selected.add(id);
      // A newer sent/deleted SSE revision must not be sent again.
      const ids=[...selected].filter(id => draftEditable(snapshot.notes[id]));
      selected.forEach(id => sentNotes.add(id));
      if (pick && !ids.length) return;
      const result = await api<{sent: Array<{project: string}>}>("/api/send", pick ? {ids} : {});
      succeeded=true;
      const counts = new Map<string,number>();
      result.sent.forEach(n => counts.set(n.project, (counts.get(n.project) || 0) + 1));
      sendMessage = "已发出 " + result.sent.length + " 条：" + [...counts].map(([project,n]) => project + "×" + n).join(" · ");
    } catch(e) { showError(e); } finally {
      if (!succeeded) selected.forEach(id => sentNotes.delete(id));
      sendingDrafts.clear(); sending = false; paint();
    }
  }
  get<HTMLButtonElement>("send-all").addEventListener("click", () => sendDrafts());

  // The writes the page has sent and not yet seen answered; a reload now would cut them off (the page updater waits for none).
  let writesInFlight = 0;
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
    writesInFlight++;
    try {
      return await Promise.race([request,new Promise<never>((_resolve,reject) => {
        deadline = setTimeout(() => { reject(new Error(WRITE_TIMEOUT)); controller!.abort(); },8000);
      })]);
    } finally { writesInFlight--; if (deadline !== undefined) clearTimeout(deadline); }
  }
  // A hint answers a key that found nothing to act on. Unlike an error it is not kept: it leaves after a few seconds or
  // at the next key or click.
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  function showHint(text: string) { const h = get("hint"); h.textContent = text; h.hidden = false; clearTimeout(hintTimer); hintTimer = setTimeout(hideHint, 3000); }
  function hideHint() { clearTimeout(hintTimer); hintTimer = undefined; const h = get("hint"); if (h) h.hidden = true; }
  // An error reports like a hint, at the bottom for a few seconds; only a lost connection, a state rather than an event, stays at the top until it heals.
  function showError(e: unknown) { const m = e instanceof Error ? e.message : String(e); if (m === DISCONNECTED) showDisconnected(); else showHint(m); }
  function showDisconnected() { get("server-banner").hidden = false; get("server-banner").textContent = DISCONNECTED; }
  async function createNote(note: Parameters<OwnerOps["createNote"]>[0]) { sendMessage = ""; try { return await api("/api/notes", note); } catch(e) { showError(e); throw e; } }
  async function deleteNote(id: string) { try { return await api("/api/notes/" + encodeURIComponent(id), {}, "DELETE"); } catch(e) { showError(e); throw e; } }
  /** `partial`: the caller names the items to sign again (presentationAffected) instead of all. */
  function applySnapshot(s: Snapshot, partial = false) {
    if (!partial) rulePresentationDirty=true;
    snapshot = s;
    for (const id of sentNotes) if (s.notes[id]?.state !== "draft") sentNotes.delete(id);
    for (const id of draftEdits.keys()) if (!draftEditable(s.notes[id])) draftEdits.delete(id);
    state.meta = s.board;
    state.items = Object.entries(s.items).map(([id,it]) => ({...it,id}));
    state.decisions = Object.entries(s.decisions).map(([id,d]) => ({...d,id}));
    state.notes = Object.entries(s.notes).map(([id,n]) => ({...n,id}));
    invalidate();
    if (selectedItem && !s.items[selectedItem]) { rememberSelected(null); detailDirty=true; current=null; }
    if (!selectionRestored) {
      selectionRestored=true;
      if (selectedItem && s.items[selectedItem]) {
        current="it:"+selectedItem;
        const it=index().byId.get(selectedItem)!;
        if (!ended(it) && !passes(it)) clearFilters(groupOf(it));
        ancestors(it).forEach(p => { manual[p.id]=true; }); saveManual();
      }
    }
  }
  let unreadGeneration = 0;
  let unreadFlight:{signal?:AbortSignal;promise:Promise<boolean>} | undefined;
  function unreadContributions(list:Step[]) {
    const docs=new Map<string,Array<{step:string;parent:string | null;doc:Step["docs"][number]}>>();
    for (const step of list) for (const doc of step.docs) {
      const key=doc.kind+":"+doc.id, entries=docs.get(key) || [];
      entries.push({step:step.id,parent:step.parent ?? null,doc}); docs.set(key,entries);
    }
    return docs;
  }
  function refreshUnread(active: () => boolean = () => true, signal?: AbortSignal):Promise<boolean> {
    if (unreadFlight && unreadFlight.signal === signal) return unreadFlight.promise;
    const generation = ++unreadGeneration;
    const operation=(async () => {
      for (;;) {
        const revision=eventGeneration;
        const result = await api<{cursor?: string; steps: Step[]}>("/api/unread",undefined,"GET",signal);
        if (generation !== unreadGeneration || !active()) return false;
        if (revision !== eventGeneration) continue;
        const previous=steps, before=unreadContributions(previous), failed=new Set(failedDiffs);
        serverSteps = result.steps;
        for (const [doc, overlay] of pendingReads) {
          if (!overlay.saving && !serverSteps.some(step => pendingReadCovers(doc, step) && step.docs.some(d => d.kind + ":" + d.id === doc))) pendingReads.delete(doc);
        }
        applyReadMarks(); snapshot.owner.cursor = result.cursor; failedDiffs.clear();
        if (shownStop && !allFreshIndex().position.has(shownStop)) shownStop = null;
        const after=unreadContributions(steps), scope=new Set<string>();
        // A step can contain several documents; only a changed document contribution invalidates its content.
        for (const key of new Set([...before.keys(),...after.keys()])) {
          if (sameValue(before.get(key),after.get(key))) continue;
          const doc=(after.get(key) || before.get(key))![0]!.doc;
          scopeForDoc(doc.kind,doc.id,snapshot.notes[doc.id]?.target).forEach(k => scope.add(k));
        }
        if (!scope.size && !sameValue(previous,steps)) scope.add("header");
        for (const step of steps) for (const doc of step.docs) if (failed.has(baselineKey(step,doc))) void loadDiff(step,doc);
        if (scope.size) scheduleRender(...scope);
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
  function baselineKey(step:Step,doc:Step["docs"][number]) { return JSON.stringify([step.id,step.parent ?? null,doc.kind,doc.id]); }
  function loadDiff(step: Step, doc: Step["docs"][number]): Promise<void> {
    const key = baselineKey(step,doc);
    const relevant=() => stepBaselines().has(key);
    if (diffs.has(key) || failedDiffs.has(key)) return Promise.resolve();
    const pending = pendingDiffs.get(key);
    if (pending) return pending;
    const request = (async () => {
      try {
        const diff = await api<{before: unknown; after: unknown; diff: string}>("/api/step?id=" + step.id + "&kind=" + doc.kind + "&doc=" + encodeURIComponent(doc.id));
        diffs.set(key,diff); if (relevant()) scheduleRender(...scopeForDoc(doc.kind,doc.id,snapshot.notes[doc.id]?.target));
      } catch(e) {
        // A failed baseline cannot keep a render/navigation drain retrying forever. The next unread refresh or unread walk retries it.
        failedDiffs.add(key);
        if (relevant()) showError(e);
      } finally { pendingDiffs.delete(key); }
    })();
    pendingDiffs.set(key,request);
    return request;
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
    const first = firstSteps().get(kind + ":" + id);
    if (!first) return undefined;
    const diff = diffs.get(baselineKey(first.step,first.doc));
    if (!diff) { void loadDiff(first.step,first.doc); return undefined; }
    return diff.before as T | null;
  }
  // Blank lines delimit blocks, except inside a fenced code block. A contiguous list or table is one block.
  function proseBlocks(text: string): string[] {
    const out: string[] = [], block: string[] = [];
    let fenced = false, inRef = false;
    const flush = () => { if (block.length) out.push(block.join("\n")); block.length = 0; };
    for (const line of text.replace(/\r/g, "").split("\n")) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      // A 参考 section is one block whatever blank lines it holds, so a change marks it as a whole.
      if (!fenced && isRefTitle(line)) { flush(); inRef = true; }
      if (!line.trim() && !fenced && !inRef) flush(); else block.push(line);
    }
    flush(); return out;
  }
  // An ordered LCS marks the entries of `after` that `before` lacks; removed entries are not shown.
  function orderedChanges<T>(before: T[], after: T[], equal: (a:T,b:T) => boolean = sameValue): Array<{value:T; mark:"" | "chg-add"}> {
    const lcs = Array.from({length:before.length + 1}, () => new Uint32Array(after.length + 1));
    for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) {
      lcs[i]![j] = equal(before[i]!,after[j]!) ? 1 + lcs[i + 1]![j + 1]! : Math.max(lcs[i + 1]![j]!,lcs[i]![j + 1]!);
    }
    const out: Array<{value:T; mark:"" | "chg-add"}> = [];
    let i = 0, j = 0;
    while (i < before.length || j < after.length) {
      if (i < before.length && j < after.length && equal(before[i]!,after[j]!)) { out.push({value:after[j++]!,mark:""}); i++; }
      else if (i < before.length && (j === after.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) i++;
      else out.push({value:after[j++]!,mark:"chg-add"});
    }
    return out;
  }
  function markedBlocks(before: string | undefined, after: string, scope?: string) {
    if (before === undefined || before === after) return blocks(after, scope);
    return orderedChanges(proseBlocks(before),proseBlocks(after)).map(({value,mark}) => mark ? '<div class="' + mark + '">' + blocks(value, scope) + '</div>' : blocks(value, scope)).join("");
  }
  function appendTitle(parent: HTMLElement, title: string, before: string | null | undefined, cls = "", terms?: TermLinks) {
    parent.appendChild(el("span", cls + (before !== undefined && before !== title ? " chg-add" : ""),linkTerms(inline(title),terms)));
  }
  // Glossary links. In one text (an item's head and shown log, in display order; a card; a note with its reply) the first
  // occurrence of each glossary term links to the term's definition. Matching is by plain substring, the
  // longest term at each position winning; the text's own project's glossary wins over another project's for the same term.
  interface TermLinks { terms: Map<string,string>; byFirst: Map<string,string[]>; seen: Set<string> }
  function termLinks(project: string): TermLinks {
    const { terms, byFirst } = cached("terms:" + project, () => {
      const terms = new Map<string,string>(), byFirst = new Map<string,string[]>();
      for (const name of [project, ...snapshot.board.projects.map(p => p.name)]) for (const t of snapshot.glossaries[name]?.terms ?? []) if (!terms.has(t.term)) terms.set(t.term, name);
      for (const term of [...terms.keys()].sort((a, b) => b.length - a.length)) byFirst.set(term[0]!, [...byFirst.get(term[0]!) || [], term]);
      return { terms, byFirst };
    });
    return { terms, byFirst, seen: new Set() };
  }
  function termAnchor(project: string, term: string) { return "term-" + encodeURIComponent(JSON.stringify([project, term])); }
  function parseTermAnchor(anchor: string): [string, string] {
    try { const [project, term] = JSON.parse(decodeURIComponent(anchor.slice("term-".length))); return [String(project), String(term)]; } catch { return ["", ""]; }
  }
  // Links terms in rendered HTML. Tags and their attributes are copied, and so is everything inside a link or code;
  // rendered text escapes "<", so tags and text alternate in the split.
  function linkTerms(html: string, links: TermLinks | undefined) {
    if (!links?.terms.size) return html;
    let out = "", skip = 0;
    for (const part of html.split(/(<[^>]*>)/)) {
      const tag = /^<(\/?)(a|code|pre)\b/.exec(part);
      if (tag) skip += tag[1] ? -1 : 1;
      out += part.startsWith("<") || skip ? part : linkText(part, links);
    }
    return out;
  }
  function linkText(text: string, links: TermLinks) {
    // One unit per shown character, an escaped one included, so a term matches what the reader sees.
    const units = text.match(/&#?\w+;|[\s\S]/g) || [], chars = units.map(u => ENTITIES[u] ?? u);
    let out = "";
    for (let i = 0; i < units.length;) {
      const term = (links.byFirst.get(chars[i]!) || []).find(t => chars.slice(i, i + t.length).join("") === t);
      if (!term) { out += units[i++]; continue; }
      const source = units.slice(i, i + term.length).join("");
      i += term.length;
      if (links.seen.has(term)) { out += source; continue; }
      links.seen.add(term);
      out += '<a class="term" href="#' + termAnchor(links.terms.get(term)!, term) + '">' + source + "</a>";
    }
    return out;
  }
  function itemTerms(id: string) { return termLinks(derived.projectOf(id)); }
  // Every "it:key" and "q:key" some document of the board refers to, built when a changed target needs to know.
  function citedRefs() {
    return cached("citedRefs", () => {
      const out = new Set<string>();
      for (const docs of [snapshot.items, snapshot.decisions, snapshot.notes]) for (const doc of Object.values(docs)) refsIn(JSON.stringify(doc)).forEach(k => out.add(k));
      refsIn(JSON.stringify(snapshot.board)).forEach(k => out.add(k)); // the goal and project names render through inline() too
      return out;
    });
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
    connected = false; scheduleRender("all"); showDisconnected();
    source?.close(); source = undefined; connectionAbort?.abort();
    if (retry !== undefined) clearTimeout(retry);
    retry = setTimeout(() => { retry = undefined; connect(); },5000);
  }
  // The owner's notices: a browser notice per card or item, shown only if the owner allowed them. Asked on the first click,
  // since browsers ignore a permission request with no user gesture.
  const noticeEnv: NoticeEnv = {
    Notification: typeof Notification === "undefined" ? undefined : Notification as unknown as NoticeEnv["Notification"],
    focus: () => window.focus(),
    open: target => target ? jumpTo(target.kind, target.key) : clearSelectedItem(),
  };
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    document.addEventListener("click", () => { void Notification.requestPermission().catch(() => {}); }, { once: true });
  }
  // The server announces the current version of the page on the stream. A page on another version reloads itself, and waits for the
  // owner to finish writing first (web/update.ts). What the next page needs is kept in sessionStorage: where the panes were scrolled,
  // and the last reload made for a new version. The selected item, the folds and the filters are in localStorage already.
  const SCROLL_KEY = "board-scroll", RELOAD_KEY = "board-reload", SCROLL_FRESH_MS = 30_000;
  function readSession<T>(key: string): T | undefined { try { const text = sessionStorage.getItem(key); return text ? JSON.parse(text) as T : undefined; } catch { return undefined; } }
  function writeSession(key: string, value: unknown) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch {} }
  // Read once, so only the page that follows a reload restores the scroll.
  let scrollToRestore = readSession<{list:number;detail:number;at:number}>(SCROLL_KEY);
  try { sessionStorage.removeItem(SCROLL_KEY); } catch {}
  if (scrollToRestore && Date.now() - scrollToRestore.at > SCROLL_FRESH_MS) scrollToRestore = undefined;
  const pageUpdates = pageUpdater({
    // The server fills in the version this page was served as (src/page-version.ts); anything else means it is not known.
    own: (() => { const content = document.getElementById("page-version")?.getAttribute("content") ?? ""; return /^[0-9a-f]+$/.test(content) ? content : ""; })(),
    // An open comment box, a comment typed and not saved, a saved draft being edited, or a request in flight.
    busy: () => editing !== null || draftEdits.size > 0 || Object.values(drafts).some(text => text.trim() !== "") || sending || writesInFlight > 0,
    banner: text => { const line = document.getElementById("update-banner"); if (!line) return; line.hidden = text === null; line.textContent = text ?? ""; },
    reload: () => { writeSession(SCROLL_KEY, { list: get("page-left").scrollTop, detail: get("item-detail").scrollTop, at: Date.now() }); location.reload(); },
    lastReload: () => readSession<{ version: string; at: number }>(RELOAD_KEY),
    rememberReload: reload => writeSession(RELOAD_KEY, reload),
    now: () => Date.now(),
    later: (fn, ms) => { setTimeout(fn, ms); },
  });
  function connect() {
    if (retry !== undefined) clearTimeout(retry);
    source?.close(); connectionAbort?.abort();
    connected = false;
    const next = new EventSource("/api/events"), controller = new AbortController();
    source = next; connectionAbort = controller;
    const active = () => source === next && !controller.signal.aborted;
    // A hung handshake or reload must not prevent the next five-second attempt.
    retry = setTimeout(() => { retry = undefined; if (active()) { showDisconnected(); connect(); } },5000);
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
        // After a reload for a new version the panes are scrolled back to where they were, once the page is drawn.
        if (scrollToRestore) {
          await rendered();
          if (!active()) return;
          const saved = scrollToRestore; scrollToRestore = undefined;
          listScroller().to(saved.list); detailScroller().to(saved.detail);
        }
      } catch(e) { if (active()) serverDown(next); }
    };
    next.onerror = () => serverDown(next);
    next.addEventListener("page", event => {
      if (!active()) return;
      pageUpdates.announce((JSON.parse((event as MessageEvent).data) as { version: string }).version);
    });
    next.addEventListener("owner", event => {
      if (!active()) return;
      showNotice(JSON.parse((event as MessageEvent).data) as OwnerNotice, noticeEnv);
    });
    next.addEventListener("change", event => {
      if (!active()) return;
      eventGeneration++;
      snapshotGeneration++;
      const change = JSON.parse((event as MessageEvent).data) as {commit: string; activity?: ActivityDelta; changed: Array<{kind: string; id: string; after: unknown}>};
      const scope=new Set<string>();
      const relocated:string[]=[], retitled:string[]=[];
      // The rules of the snapshot before this change: the affected items are found by comparing with them.
      const base=snapshot, baseRules:Rules=derived;
      snapshot={...snapshot,items:{...snapshot.items},decisions:{...snapshot.decisions},notes:{...snapshot.notes},glossaries:{...snapshot.glossaries}};
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
          if (before?.title !== after?.title) retitled.push("it:"+doc.id);
          if (!before || !after || !sameValue(before.plan.filter(row => "item" in row && row.own), after.plan.filter(row => "item" in row && row.own)) || before.group !== after.group || before.order !== after.order) {
            if (before) { scope.add("group:"+derived.groupOf(doc.id)); derived.ancestors(doc.id).forEach(p => scope.add("item:"+p)); } relocated.push(doc.id);
          }
          else {
            scope.add("item:"+doc.id); scopedHeads(doc.id,scope);

          }
        } else if (doc.kind === "decision") {
          const before=previous as Decision | undefined, after=doc.after as Decision | null;
          if (before?.question !== after?.question) retitled.push("q:"+doc.id);
          if (!before || !after || before.item !== after.item || before.status !== after.status) {
            for (const item of [before?.item,after?.item]) if (item && snapshot.items[item]) scope.add("item:"+item);
            if (!before?.item || !snapshot.items[before.item] || !after?.item || !snapshot.items[after.item]) scope.add("cards");
          }
          scope.add("card:"+doc.id);

        }
        else scope.add("all"); // the board, owner state, or a glossary, whose terms any text may link
        if (doc.kind === "board") snapshot.board = doc.after as Board;
        else if (doc.kind === "owner") snapshot.owner = doc.after as OwnerState;
        else if (doc.kind === "glossary") { if (doc.after === null) delete snapshot.glossaries[doc.id]; else snapshot.glossaries[doc.id] = doc.after as Glossary; }
        else {
          const collection = doc.kind === "item" ? snapshot.items : doc.kind === "decision" ? snapshot.decisions : snapshot.notes;
          if (doc.after === null) delete collection[doc.id]; else Object.assign(collection, { [doc.id]: doc.after });
        }
      }
      snapshot.head = change.commit;
      // The activity arrives as its change against the commit before. A snapshot already at this commit holds it; one
      // at another commit missed or overtook events, so the page reloads the whole snapshot.
      let resync=false;
      if (change.activity) {
        if (base.head === change.activity.from) snapshot.activity = applyActivityDelta(base.activity, change.activity);
        else if (base.head !== change.commit) resync=true;
      }
      applySnapshot(snapshot,true);
      const seeds=changeSeeds(base,snapshot,baseRules,derived,change.changed,change.activity);
      if (!seeds) rulePresentationDirty=true;
      else if (!rulePresentationDirty) { presentationAffected ??= new Set(); for (const id of affectedItems(baseRules,derived,seeds)) presentationAffected.add(id); }
      if (resync) void loadSnapshot(active,controller.signal).catch(() => { if (active()) serverDown(next); });
      relocated.forEach(id => { if (snapshot.items[id]) scope.add("group:"+derived.groupOf(id)); });
      // A title that changed, or a target that appeared or went, changes how every reference to it reads.
      if (retitled.some(k => citedRefs().has(k))) scope.add("all");
      // A write by a session moves its row in the agent list even when nothing else on the page changes.
      if (Object.keys(change.activity?.agents ?? {}).length) scope.add("agents");

      scheduleRender(...scope); queueUnread(active,controller.signal,next);
    });
  }
  // Active time and doing-step day counts can advance without another board write.
  setInterval(() => { rulePresentationDirty = true; scheduleRender("header"); }, 60_000);
  void connect();
  watchMermaid();

function get<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
