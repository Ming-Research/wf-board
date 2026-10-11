import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { rules } from "../src/rules.ts";
import type { Snapshot, Decision, Note } from "../src/model.ts";

// Execute the actual bundle against a tiny synthetic DOM. No browser or listener
// is needed: these regressions concern event handlers and text, not layout.
// The element the page last focused; document.activeElement reads it.
const focused: { current: Element | null } = { current: null };
class Element {
  tagName: string;
  id = ""; className = ""; textContent = ""; private html = ""; hidden = false;
  value = "";
  disabled = false; type = ""; title = ""; tabIndex = 0;
  attributes: Record<string,string> = {};
  style: Record<string, string> = {}; dataset: Record<string, string> = {};
  children: Element[] = []; parentElement: Element | null = null;
  handlers = new Map<string, Array<(event: unknown) => unknown>>();
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  classList = {
    add: (c: string) => { this.className += " " + c; },
    remove: (c: string) => { this.className = this.className.split(" ").filter(v => v !== c).join(" "); },
    toggle: (c: string) => { if (this.className.split(" ").includes(c)) this.classList.remove(c); else this.classList.add(c); },
  };
  appendChild(e: Element) { this.children.push(e); e.parentElement = this; return e; }
  insertBefore(e: Element) { this.children.unshift(e); e.parentElement = this; }
  replaceWith(e: Element) { const p = this.parentElement; if (!p) return; p.children[p.children.indexOf(this)] = e; e.parentElement = p; this.parentElement = null; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(kind: string, fn: (event: unknown) => unknown) { this.handlers.set(kind, [...this.handlers.get(kind) ?? [], fn]); }
  async click() { for (const fn of this.handlers.get("click") ?? []) await fn({ stopPropagation() {}, preventDefault() {} }); }
  selectionStart = 0; selectionEnd = 0;
  focus() { focused.current = this; } blur() { if (focused.current === this) focused.current = null; } scrollIntoView() {}
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  geometry?: () => {top:number;bottom:number;height:number;left:number;width:number};
  getBoundingClientRect() { return this.geometry?.() ?? { left: 0, width: 900, height: 100, top: 50, bottom: 150 }; }
  matches(selector: string) { return selector.split(/,\s*/).some(s => s.startsWith(".") && this.className.split(" ").includes(s.slice(1))); }
  closest(selector: string): Element | null { return this.matches(selector.replace("#areas ", "")) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelector(selector: string) { if (selector === ".t") { const e = new Element("span"); e.className = "t"; return this.appendChild(e); } return null; }
  get innerHTML() { return this.html; }
  set innerHTML(value: string) { this.html = value; this.children = []; }
  get firstChild(): Element | null { return this.children[0] ?? null; }
  get firstElementChild(): Element | null { return this.firstChild; }
}
let bundle: Promise<string> | undefined;
interface PageOptions { notesOpen?: Record<string,boolean>; geometry?: (e:Element, all: () => Element[]) => {top:number;height:number} }
async function page(snapshot: Snapshot, unread: unknown[], before: unknown = null, after?: unknown, options: PageOptions = {}) {
  const code = await (bundle ??= build({ entryPoints: ["web/app.ts"], bundle: true, format: "iife", globalName: "BoardPage", write: false, target: "es2022" }).then(result => result.outputFiles[0]!.text));
  const roots = new Map<string, Element>();
  for (const id of ["goal", "goal-title", "eyebrow", "meta", "summary", "nav", "areas", "cards", "decisions", "crumbs", "sendbox", "send-all", "send-note", "to-top", "server-banner"]) { const e = new Element(id === "send-all" ? "button" : "div"); e.id = id; roots.set(id,e); }
  const body = new Element("body"), wrap = new Element("div"), header = new Element("header");
  const all = (): Element[] => { const out: Element[] = []; function walk(e: Element) { out.push(e); e.children.forEach(walk); } for (const e of [...roots.values(),body]) walk(e); return out; };
  const calls: Array<{path: string; body?: unknown}> = [];
  const measurements: Array<{id:string;top:number;height:number}> = [], scrolls: number[] = [];
  const listeners = new Map<string, (event: unknown) => unknown>();
  const document = {
    body, get activeElement() { return focused.current; }, documentElement: { scrollHeight: 10000 },
    getElementById: (id: string) => all().find(e => e.id === id) ?? null,
    createElement: (tag: string) => {
      const e = new Element(tag);
      if (options.geometry) e.geometry = () => { const r = options.geometry!(e,all); measurements.push({id:e.id,...r}); return {...r,bottom:r.top+r.height,left:0,width:900}; };
      return e;
    },
    querySelector: (selector: string) => selector === ".wrap" ? wrap : selector === "header.top" ? header : all().find(e => selector === '[data-sel="' + e.dataset.sel + '"]') ?? null,
    querySelectorAll: () => [], elementFromPoint: () => null,
    addEventListener: (kind: string, fn: (event: unknown) => unknown) => listeners.set(kind, fn),
  };
  const sse = new Map<string, (event: unknown) => unknown>();
  class EventSource { addEventListener(kind: string, fn: (event: unknown) => unknown) { sse.set(kind, fn); } close() {} }
  const context = {
    BoardPage: undefined,
    document, HTMLElement: Element, EventSource, console, CSS: { escape: (s: string) => s },
    innerHeight: 1000, scrollY: 0, localStorage: { getItem: (key:string) => key === "board-notes" && options.notesOpen ? JSON.stringify(options.notesOpen) : null, setItem() {} },
    matchMedia: () => ({ matches: true }), getComputedStyle: () => ({ scrollMarginTop: "0" }),
    performance, setTimeout, clearTimeout, requestAnimationFrame() {}, addEventListener() {},
    window: { scrollY: 0, addEventListener() {}, scrollBy() {}, scrollTo(_x:number,y:number) { scrolls.push(y); } },
    fetch: async (path: string, options?: {body?: string}) => {
      const input = options?.body ? JSON.parse(options.body) : undefined; calls.push({path,body:input});
      let value: unknown;
      if (path === "/api/snapshot") value = snapshot;
      else if (path === "/api/unread") value = { steps: unread };
      else if (path.startsWith("/api/step?")) {
        const params = new URLSearchParams(path.split("?")[1]), id = params.get("doc")!;
        const collection = params.get("kind") === "item" ? snapshot.items : params.get("kind") === "decision" ? snapshot.decisions : snapshot.notes;
        value = typeof before === "function" ? await before(params) : { before, after: after === undefined ? collection[id] ?? null : after, diff: "+ synthetic changed text" };
      }
      else if (path === "/api/send") value = { sent: [{project: "Halo-wf"}, {project: "Halo-wf"}, {project: "Firn-wf"}] };
      else if (path === "/api/read") { const through = (input as {through: string}).through; const stop = unread.findIndex(s => (s as {id:string}).id === through); unread = through === "all" ? [] : unread.slice(stop + 1); value = { ok: true }; }
      else throw new Error("Unexpected page request " + path);
      return { ok: true, status: 200, json: async () => structuredClone(value) };
    },
  };
  runInNewContext(code, context);
  await setImmediate(); await setImmediate();
  // A live update from the server, as the page's event stream delivers it.
  const change = async (commit: string) => { sse.get("change")!({ data: JSON.stringify({ commit, changed: [] }) }); await setImmediate(); };
  return { roots, all, calls, document, change, measurements, scrolls,
    key: (key: string) => listeners.get("keydown")!({key,target:new Element("div"),preventDefault(){}}) };
}
const at = "2026-10-11T01:02:03Z";
function snapshot(): Snapshot {
  return { board: { title: "Synthetic title", projects: [{name:"Project"}], eyebrow: "Synthetic eyebrow" }, head: "a".repeat(40), owner: { archived: {} }, decisions: {}, notes: {}, items: {
    area: { title: "Parent", group: "Project", updated: at, rev: 1, deps: [{id:"child",why:"needs child"}], links: [], log: [] },
    child: { title: "Child", parent: "area", status: "wip", priority: "P1", updated: at, rev: 1, deps: [], links: [], log: [] },
  } };
}
test("bundled page renders board metadata and the recorded-send count by project", async () => {
  const s = snapshot(); s.notes.n = { target: "it:child", kind: "comment", text: "draft", at, state: "draft", rev: 1 };
  const p = await page(s, []);
  assert.equal(p.roots.get("goal-title")!.textContent, "Synthetic title");
  assert.equal(p.roots.get("eyebrow")!.textContent, "Synthetic eyebrow");
  await p.roots.get("send-all")!.click();
  assert.equal(p.roots.get("send-note")!.textContent, "已发出 3 条：Halo-wf×2 · Firn-wf×1");
});
function descendants(root: Element): Element[] { return [root,...root.children.flatMap(descendants)]; }
function markup(root: Element): string { return descendants(root).map(e => e.innerHTML + e.textContent).join("\n"); }
function card(): Decision {
  return {item:"child",question:"如何显示？",background:"**背景**：中文正文",options:[{key:"A",text:"保留 YAML"},{key:"B",text:"渲染正文",recommended:true}],status:"open",updated:at,rev:1};
}
const stepId = "d".repeat(40);
function unread(kind = "item", doc = "child", id = stepId) { return [{id,commits:[id],author:"Session A",at,docs:[{kind,id:doc,summary:"synthetic change"}]}]; }
async function expand(p: Awaited<ReturnType<typeof page>>, id = "child") {
  if (id !== "area") await p.all().find(e => e.id === "it-area")!.children[0]!.children[0]!.click();
  await p.all().find(e => e.id === "it-" + id)!.children[0]!.children[0]!.click();
  await setImmediate(); await setImmediate();
}
function item(p: Awaited<ReturnType<typeof page>>, id = "child") { return p.all().find(e => e.id === "it-" + id)!; }

test("inline added paragraph renders rich text without any unread box", async () => {
  const s = snapshot(), before = {...s.items.child!,head:"Unchanged"};
  s.items.child!.head = "Unchanged\n\n**Added** paragraph";
  const p = await page(s,unread(),before); await expand(p);
  assert.match(markup(item(p)), /class="chg-add"[^>]*><p><strong>Added<\/strong> paragraph<\/p>/);
  p.key("n"); await setImmediate();
  assert.ok(!p.all().some(e => e.className.includes("unread-step")));
  assert.ok(!markup(item(p)).includes("次提交"));
});

test("inline removed paragraph stays at its original position and unchanged paragraphs carry no marks", async () => {
  const s = snapshot(), before = {...s.items.child!,head:"First\n\n- **Removed** paragraph\n\nLast"};
  s.items.child!.head = "First\n\nLast";
  const p = await page(s,unread(),before); await expand(p);
  const body = markup(item(p));
  assert.match(body, /<p>First<\/p>.*class="chg-del"[^>]*><ul><li><strong>Removed<\/strong> paragraph<\/li><\/ul>.*<p>Last<\/p>/s);
  assert.ok(!/class="chg-(add|del)"[^>]*><p>(First|Last)<\/p>/.test(body));
});

test("inline existing fenced code keeps blank lines and contiguous lists and tables remain rich blocks", async () => {
  const s = snapshot(), before = {...s.items.child!,head:"```\nold\n\ncode\n```\n\n- Keep\n- Old list\n\n| Header |\n| --- |\n| Old row |"};
  s.items.child!.head = "```\nnew\n\ncode\n```\n\n- Keep\n- New list\n\n| Header |\n| --- |\n| New row |";
  const p = await page(s,unread(),before); await expand(p);
  const body = markup(item(p));
  assert.match(body, /class="chg-del"[^>]*><pre class="code"><code>old\n\ncode<\/code><\/pre>/);
  assert.match(body, /class="chg-add"[^>]*><pre class="code"><code>new\n\ncode<\/code><\/pre>/);
  assert.match(body, /class="chg-add"[^>]*><ul><li>Keep<\/li><li>New list<\/li><\/ul>/);
  assert.match(body, /class="chg-del"[^>]*><div class="tablewrap"><table><thead><tr><th>Header<\/th>.*<td>Old row<\/td>/s);
  assert.match(body, /class="chg-add"[^>]*><div class="tablewrap"><table><thead><tr><th>Header<\/th>.*<td>New row<\/td>/s);
});

test("inline changed title marks the new title and strikes the old title immediately after it", async () => {
  const s = snapshot(), before = {...s.items.child!,title:"Old title"}; s.items.child!.title = "New title";
  const p = await page(s,unread(),before); await expand(p);
  const head = descendants(item(p)).find(e => e.className === "item-head")!;
  const title = head.children.find(e => e.className.includes("item-title"))!;
  assert.ok(title.className.includes("chg-add")); assert.equal(title.innerHTML,"New title");
  const old = head.children[head.children.indexOf(title) + 1]!;
  assert.equal(old.tagName,"SMALL"); assert.ok(old.className.includes("chg-del")); assert.equal(old.innerHTML,"Old title");
});

test("inline removed dependency and link stay struck while changed priority status and ask are marked", async () => {
  const s = snapshot(), before = {...s.items.child!,status:"todo",priority:"P2",ask:{text:"Old ask"},deps:[{id:"area",why:"Old reason"}],links:[{label:"Old link",url:"https://example.com/old"}]};
  s.items.child!.ask = {text:"New ask"};
  const p = await page(s,unread(),before); await expand(p);
  const all = descendants(item(p));
  assert.ok(all.some(e => e.className.includes("deprow") && e.className.includes("chg-del") && markup(e).includes("Old reason")));
  assert.ok(all.some(e => e.tagName === "A" && e.className.includes("chg-del") && e.innerHTML === "Old link"));
  assert.ok(all.some(e => e.className.includes("prio") && e.className.includes("chg-add") && e.innerHTML === "P1"));
  assert.ok(all.some(e => e.className.includes("st ") && e.className.includes("chg-add") && e.innerHTML === "WIP"));
  assert.ok(all.some(e => e.className.includes("ask") && e.className.includes("chg-add") && markup(e).includes("New ask")));
});

test("inline removed non-HTTPS link remains struck without an active href", async () => {
  const s = snapshot(), before = {...s.items.child!,links:[{label:"Removed HTTP link",url:"http://example.com/old"}]};
  const p = await page(s,unread(),before); await expand(p);
  const row = descendants(item(p)).find(e => e.tagName === "A" && e.innerHTML === "Removed HTTP link");
  assert.ok(row,"a removed valid non-HTTPS link must remain visible");
  assert.ok(row.className.includes("chg-del"));
  assert.ok(!Object.hasOwn(row,"href"),"non-HTTPS links must not receive an active href");
});

test("expanded unread marks show before n and disappear after r reads their stop", async () => {
  const s = snapshot(), before = {...s.items.child!,head:"Old body"}; s.items.child!.head = "New body";
  const p = await page(s,unread(),before); await expand(p);
  assert.match(markup(item(p)), /chg-add/);
  p.key("r"); assert.equal(p.calls.filter(c => c.path === "/api/read").length,0);
  p.key("n"); await setImmediate(); p.key("r"); await setImmediate(); await setImmediate();
  assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{through:stepId}]);
  assert.ok(!markup(item(p)).includes("chg-add") && !markup(item(p)).includes("Old body"));
});

test("inline baseline is first unread before and after is current snapshot rather than an intermediate step", async () => {
  const s = snapshot(), first = "b".repeat(40), last = "c".repeat(40);
  s.items.child!.head = "Original\n\nCurrent";
  const p = await page(s,[...unread("item","child",first),...unread("item","child",last)],(params: URLSearchParams) => ({before:{...s.items.child!,head:params.get("id") === first ? "Original" : "Original\n\nIntermediate"},after:{...s.items.child!,head:"Original\n\nIntermediate"},diff:""}));
  await expand(p);
  assert.match(markup(item(p)), /class="chg-add"[^>]*><p>Current<\/p>/);
  assert.ok(!markup(item(p)).includes("Intermediate"));
  p.key("n"); await setImmediate(); p.key("r"); await setImmediate(); await setImmediate();
  assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{through:first}]);
  assert.match(markup(item(p)), /class="chg-del"[^>]*><p>Intermediate<\/p>/);
  assert.match(markup(item(p)), /class="chg-add"[^>]*><p>Current<\/p>/);
  assert.ok(p.all().some(e => e.innerHTML === "新 1 ›"));
  p.key("n"); await setImmediate(); p.key("r"); await setImmediate(); await setImmediate();
  assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{through:first},{through:last}]);
  assert.ok(!markup(item(p)).includes("chg-add") && !markup(item(p)).includes("Intermediate"));
});

test("inline new item marks only its title and keeps rich head and duplicate new log markings", async () => {
  const s = snapshot(); s.items.child!.head = "**Goal**：Body\n\n- List\n\n```\n<unsafe>\n\ncode\n```";
  s.items.child!.log = [{at,text:"same"},{at,text:"same"}];
  const p = await page(s,unread(),null); await expand(p);
  assert.ok(descendants(item(p)).some(e => e.className.includes("item-title") && e.className.includes("chg-add")));
  assert.ok(!markup(item(p)).includes('class="chg-add"'));
  assert.match(markup(item(p)), /<pre class="code"><code>&lt;unsafe&gt;\n\ncode<\/code><\/pre>/);
  assert.equal(descendants(item(p)).filter(e => e.className.includes("log-entry") && e.className.includes("fresh")).length,2);
});

test("inline card marks current question background option and ruling and retains removed options", async () => {
  const s = snapshot(), before = card();
  s.decisions.q = {...before,question:"Current question",background:"Old background\n\nNew background",status:"ruled",choice:"B",ruling:"**Current** ruling",options:[{key:"B",text:"New option",recommended:true}]};
  const p = await page(s,unread("decision","q"),{...before,background:"Old background"},{...before,ruling:"Intermediate ruling"}); await expand(p);
  const c = p.all().find(e => e.id === "q-q")!, all = descendants(c);
  assert.ok(all.some(e => e.className.includes("chg-add") && e.innerHTML === "Current question"));
  assert.ok(all.some(e => e.className.includes("chg-del") && e.innerHTML === before.question));
  assert.match(markup(c), /class="chg-add"[^>]*><p>New background<\/p>/);
  assert.match(markup(c), /class="chg-add"[^>]*><p><strong>Current<\/strong> ruling<\/p>/);
  assert.match(markup(c), /class="chg-add"[^>]*><p>New option<\/p>/);
  assert.ok(all.some(e => e.className.includes("optbtn") && e.className.includes("chg-del") && e.disabled && markup(e).includes("保留 YAML")));
  assert.ok(!markup(c).includes("Intermediate ruling"));
});

test("inline new card marks its title only and retains unscored confidence", async () => {
  const s = snapshot(); s.decisions.q = {...card(),confidence:{reason:"Unscored evidence"}};
  const p = await page(s,unread("decision","q"),null); await expand(p);
  const c = p.all().find(e => e.id === "q-q")!;
  assert.ok(descendants(c).some(e => e.className.includes("chg-add") && e.innerHTML === card().question));
  assert.ok(!markup(c).includes('class="chg-add"') && !markup(c).includes("undefined/5"));
  assert.match(markup(c), /Unscored evidence/);
});

test("inline note stops select the existing fresh reply row without duplicated thread", async () => {
  const s = snapshot(), before: Note = {target:"it:child",kind:"comment",text:"Owner question",at,state:"sent",rev:1};
  s.notes.n = {...before,state:"done",reply:"**Reply**：Answer",repliedAt:at};
  const p = await page(s,unread("note","n"),before); p.key("n"); await setImmediate();
  const row = p.all().find(e => e.id === "note-n")!;
  assert.ok(row.className.includes("cur") && row.className.includes("newbar"));
  assert.equal(p.all().filter(e => e.className.startsWith("note ")).length,1);
  p.key("r"); await setImmediate(); await setImmediate();
  assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{through:stepId}]);
  assert.ok(!p.all().find(e => e.id === "note-n")!.className.includes("newbar"));
});

test("inline deleted document stops render no body but remain countable walkable and readable", async () => {
  for (const kind of ["item","decision"] as const) {
    const s = snapshot(); delete s.items.child; s.items.area!.deps = [];
    const p = await page(s,unread(kind,"gone"),kind === "item" ? {...snapshot().items.child!,head:"Deleted body"} : card(),null);
    assert.ok(p.all().some(e => e.innerHTML === "新 1 ›"));
    p.key("n"); await setImmediate();
    assert.ok(!markup(p.roots.get("areas")!).includes("Deleted body") && !p.all().some(e => e.className.includes("unread-step")));
    p.key("r"); await setImmediate();
    assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{through:stepId}]);
  }
});

test("filtered parent n stop opens its body and selects its own item", async () => {
  const s = snapshot(), before = {...s.items.area!,head:"Before"}; s.items.area!.head = "After";
  const p = await page(s,unread("item","area"),before);
  const filter = p.all().find(e => e.tagName === "BUTTON" && e.innerHTML.startsWith("进行中 "))!; await filter.click();
  assert.ok(!markup(item(p,"area")).includes("After"));
  p.key("n"); await setImmediate();
  assert.ok(item(p,"area").className.includes("cur"));
  assert.match(markup(item(p,"area")), /class="chg-add"[^>]*><p>After<\/p>/);
  p.key("r"); await setImmediate();
  assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{through:stepId}]);
});

test("unread logs expand with preceding entries highlight duplicate appends and stay open after reading", async () => {
  const s = snapshot(); s.items.area!.deps = [];
  const old = [{at,text:"duplicate"},{at,text:"old two"},{at,text:"old three"}];
  s.items.area!.log = [...old,{...old[0]!},{at,text:"new two"},{at,text:"new three"}];
  const p = await page(s,unread("item","area"),{...s.items.area,log:old}); p.key("n"); await setImmediate();
  const rows = () => p.all().filter(e => e.id.startsWith("log-area-"));
  assert.equal(rows().length,5); assert.equal(rows().filter(e => e.className.includes("fresh")).length,3);
  p.key("r"); await setImmediate(); await setImmediate();
  assert.equal(rows().length,5); assert.equal(rows().filter(e => e.className.includes("fresh")).length,0);
});

test("R9 owner controls follow shared ask/card predicates through draft and sent answers", async () => {
  for (const state of ["draft", "sent", "done"] as const) {
    const s = snapshot(); s.items.child!.ask = { text: "Approve work" }; s.decisions.q = card();
    s.notes.a = { target: "it:child", kind: "approve", text: "同意：Approve work", at, state, rev: 1 };
    s.notes.c = { target: "q:q", kind: "choice", choice: "B", text: "B", at, state, rev: 1 };
    const p = await page(s, []), r = rules(s);
    await p.all().find(e => e.className === "item-head")!.click();
    await p.all().filter(e => e.className === "item-head").at(-1)!.click();
    // The waiting badge and approval action are rendered from the predicates.
    assert.equal(p.all().some(e => e.className === "asktag" && e.innerHTML === "等你决定"), r.cardWaiting("q"));
    assert.equal(p.all().some(e => e.id === "ask-child"), r.askPending("child"));
  }
});

test("n selects one existing document at a time skips archived documents and r reads its exact step", async () => {
  const s = snapshot(), id = "e".repeat(40);
  s.items.other = {title:"Archived",parent:"area",status:"done",priority:"P2",updated:at,rev:1,deps:[],links:[],log:[]};
  s.items.area!.deps.push({id:"other",why:"needs other"}); s.owner.archived = {other:at};
  const p = await page(s,[{id,commits:[id],author:"Session A",at,docs:[{kind:"item",id:"child",summary:"status todo→wip"},{kind:"item",id:"other",summary:"status wip→done"},{kind:"item",id:"area",summary:"+1 log"}]}]);
  p.key("r"); assert.ok(!p.calls.some(c => c.path === "/api/read"));
  p.key("n"); await setImmediate(); assert.ok(item(p).className.includes("cur"));
  assert.ok(!p.calls.some(c => c.path === "/api/read"));
  p.key("n"); await setImmediate(); assert.ok(item(p,"area").className.includes("cur"));
  assert.ok(!item(p).className.includes("cur"));
  p.key("r"); await setImmediate(); assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{through:id}]);
});

test("a dependency row names its project only when the project differs from the depending item's", async () => {
  const s = snapshot();
  s.items.sib = { title: "Sibling", parent: "area", status: "todo", priority: "P2", updated: at, rev: 1, deps: [], links: [], log: [] };
  s.items.area!.deps.push({ id: "sib", why: "needs sibling" });
  s.items.far = { title: "Far area", group: "Other project", status: "todo", priority: "P2", updated: at, rev: 1, deps: [], links: [], log: [] };
  s.items.child!.deps = [{ id: "sib", why: "same area" }, { id: "far", why: "other area" }];
  const p = await page(s, []);
  await p.all().find(e => e.id === "it-area")!.children[0]!.children[0]!.click();
  await p.all().find(e => e.id === "it-child")!.children[0]!.children[0]!.click();
  const rows = descendants(p.all().find(e => e.id === "it-child")!).filter(e => e.className.startsWith("deprow"));
  const same = rows.find(e => e.innerHTML.includes("Sibling"))!, far = rows.find(e => e.innerHTML.includes("Far area"))!;
  assert.ok(same && far);
  assert.ok(!same.innerHTML.includes('class="where"'), "a same-project dependency carries no label");
  assert.match(far.innerHTML, /<span class="where">Other project<\/span>/);
});

test("project page omits session assignments and shows inbox requests, including empty projects", async () => {
  const s=snapshot(); s.board.projects.push({name:"Empty"});
  s.items.incoming={title:"Request title",group:"Project",ask:{text:"Approve request"},request:{by:"Visitor",at},status:"todo",priority:"P0",head:"Request body",updated:at,rev:1,log:[{at,by:"Visitor",text:"Visitor 提出：Need feature"}],deps:[],links:[]};
  const p=await page(s,[]), headings=p.all().filter(e=>e.className==="group-head");
  assert.equal(headings.length,2); assert.ok(headings.every(h => !markup(h).includes("负责：")));
  assert.ok(p.all().some(e=>e.innerHTML==="等你处理 1 ›"));
  const inbox=p.all().find(e=>e.className==="inbox"); assert.ok(inbox);
  assert.match(markup(inbox),/收件箱 1/); assert.match(markup(inbox),/Request title/); assert.match(markup(inbox),/Visitor/); assert.match(markup(inbox),/Need feature/);
  const item=p.all().find(e=>e.id==="it-incoming"); assert.ok(item); assert.ok(descendants(inbox).includes(item));
  await descendants(item).find(e=>e.className==="item-head")!.click();
  assert.match(markup(p.all().find(e=>e.id==="it-incoming")!),/Request body/);
  assert.ok(p.all().some(e=>e.className==="request-meta" && e.innerHTML.includes("Visitor") && e.innerHTML.includes("Need feature")));
});

test("the 新 counts add up pieces while n walks one document at a time", async () => {
  const s = snapshot(), id = "f".repeat(40);
  const p = await page(s, [{ id, commits: [id], author: "Session A", at, docs: [
    { kind: "item", id: "child", summary: "head changed, +3 log", pieces: { log: 3, reply: 0, other: 1 } },
    { kind: "item", id: "area", summary: "+2 log", pieces: { log: 2, reply: 0, other: 0 } },
  ] }]);
  const buttons = p.all().filter(e => e.tagName === "BUTTON").map(e => e.innerHTML);
  assert.ok(buttons.includes("新 6 ›"), buttons.join(" | "));
  assert.ok(buttons.includes("进展 5") && buttons.includes("其他 1"));
  await p.all().find(e => e.id === "it-area")!.children[0]!.children[0]!.click();
  const chip = (itemId: string) => descendants(p.all().find(e => e.id === "it-" + itemId)!.children[0]!).filter(e => e.className.includes("newtag")).map(e => e.innerHTML);
  assert.ok(chip("child").includes("新 4"), "the item's chip adds its pieces: " + chip("child"));
  assert.ok(chip("area").includes("新 4") && chip("area").includes("新 2"), "the parent shows its own 2 and the 4 below it: " + chip("area"));
  // Keeping only progress: 3 + 2 pieces.
  await p.all().find(e => e.tagName === "BUTTON" && e.innerHTML === "进展 5")!.click();
  const after = p.all().filter(e => e.tagName === "BUTTON").map(e => e.innerHTML);
  assert.ok(after.includes("新 5 ›"), after.join(" | "));
  assert.ok(chip("child").includes("新 3") && chip("area").includes("新 3"));
  p.key("n"); await setImmediate();
  assert.ok(item(p).className.includes("cur"));
});

test("a note being typed keeps its focus, text and caret across a live re-render", async () => {
  const id = "f".repeat(40);
  const p = await page(snapshot(), [{ id, commits: [id], author: "Session A", at, docs: [{ kind: "item", id: "area", summary: "+1 log", pieces: { log: 1, reply: 0, other: 0 } }] }]);
  // n selects the changed item; c opens a note on the selection.
  p.key("n"); await setImmediate();
  p.key("c"); await setImmediate();
  const input = p.all().find(e => e.id === "ed-it_area")!;
  assert.ok(input, "the note editor has a stable id");
  input.value = "Half typed"; await input.handlers.get("input")![0]!({});
  input.focus(); input.setSelectionRange(4, 4);
  // A live update (another session's write) re-renders the page and rebuilds the editor.
  await p.change("b".repeat(40));
  const again = p.all().find(e => e.id === "ed-it_area")!;
  assert.notEqual(again, input, "the field was rebuilt");
  assert.equal(p.document.activeElement, again);
  assert.equal(again.value, "Half typed");
  assert.deepEqual([again.selectionStart, again.selectionEnd], [4, 4]);
});

// Deferred history reads exercise the actual render/scroll ordering without browser timing guesses.
function deferred<T>() { let resolve!: (value:T) => void; let reject!: (reason:Error) => void; const promise = new Promise<T>((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; }
async function settle() { await setImmediate(); await setImmediate(); }
function geom(e:Element) { return {top:e.id.startsWith("note-") ? 1700 : 600,height:e.id.startsWith("note-") ? 100 : 2400}; }
function endpoints(s:Snapshot, p:URLSearchParams, before:unknown) { const id=p.get("doc")!, kind=p.get("kind"); return {before,after:kind === "item" ? s.items[id] : kind === "decision" ? s.decisions[id] : s.notes[id],diff:""}; }

test("new item blue bar has CSS support and an existing changed item has no blue creation bar", async () => {
  const css = await readFile("web/index.html","utf8");
  assert.ok(/[^{}]*\.item\.fresh[^{}]*\{[^}]*var\(--fresh\)/.test(css),"new item bar CSS must use the fresh token");
  const s=snapshot(); s.items.child!.deps=[{id:"area",why:"Created dependency"}]; s.items.child!.links=[{label:"Created link",url:"https://example.com/new"}];
  const created=await page(s,unread(),null); await expand(created);
  assert.ok(item(created).className.split(" ").includes("fresh"));
  const rows=descendants(item(created));
  const dep=rows.find(e=>e.className.includes("deprow") && markup(e).includes("Created dependency"))!, link=rows.find(e=>e.tagName === "A" && e.innerHTML === "Created link")!;
  assert.ok(dep.className.split(" ").includes("fresh") && link.className.split(" ").includes("fresh"),"new item dependency and link rows also need blue bars");
  assert.ok(!dep.className.includes("chg-add") && !link.className.includes("chg-add"),"new item retains title-only green marks");
  const changed=await page(s,unread(),{...s.items.child!,head:"Before"}); await expand(changed);
  assert.ok(!item(changed).className.split(" ").includes("fresh"));
});

test("new card has a blue creation bar while an existing changed card only has inline marks", async () => {
  const s=snapshot(); s.decisions.q=card();
  const created=await page(s,unread("decision","q"),null); await expand(created);
  assert.ok(created.all().find(e=>e.id === "q-q")!.className.split(" ").includes("fresh"));
  const changed=await page(s,unread("decision","q"),{...card(),question:"Old question"}); await expand(changed);
  const c=changed.all().find(e=>e.id === "q-q")!;
  assert.ok(!c.className.split(" ").includes("fresh"));
  assert.ok(descendants(c).some(e=>e.className.includes("chg-add")));
});

test("new note without a reply receives a blue row bar inside its comment list", async () => {
  const s=snapshot(); s.notes.n={target:"it:child",kind:"comment",text:"New owner note",at,state:"sent",rev:1};
  const p=await page(s,unread("note","n"),null); p.key("n"); await settle();
  const row=p.all().find(e=>e.id === "note-n")!;
  assert.ok(row.className.split(" ").includes("newbar"));
  assert.equal(row.parentElement!.className,"notes");
  assert.equal(p.all().filter(e=>e.className.startsWith("note ")).length,1);
  assert.ok(row.children.some(e=>e.className === "who" && e.innerHTML.includes("已发送，等处理")));
});

test("new reply marks both note row and reply itself without any bookkeeping diff", async () => {
  const css=await readFile("web/index.html","utf8");
  assert.ok(/[^{}]*\.reply\.newbar[^{}]*\{[^}]*var\(--fresh\)/.test(css),"reply bar CSS must use the fresh token");
  const s=snapshot(), before:Note={target:"it:child",kind:"comment",text:"Question",at,state:"sent",rev:1};
  s.notes.n={...before,state:"done",reply:"Answer",repliedAt:at,repliedBy:"Project"};
  const p=await page(s,unread("note","n"),before); p.key("n"); await settle();
  const row=p.all().find(e=>e.id === "note-n")!, reply=row.children.find(e=>e.className.includes("reply"))!;
  assert.ok(row.className.includes("newbar") && reply.className.includes("newbar"));
  assert.ok(!markup(p.roots.get("areas")!).includes("状态：") && !markup(p.roots.get("areas")!).includes("回复项目"));
  assert.equal(p.all().filter(e=>e.className.includes("reply rich")).length,1);
  p.key("r"); await settle();
  assert.ok(!p.all().find(e=>e.id === "note-n")!.className.includes("newbar"));
});

test("note bookkeeping changes do not mark an unchanged reply or open its collapsed list", async () => {
  const s=snapshot(), before:Note={target:"it:child",kind:"comment",text:"Question",at,state:"sent",reply:"Earlier answer",repliedAt:at,rev:1};
  s.notes.n={...before,state:"done",repliedBy:"Different project",repliedAt:"2026-10-11T02:00:00Z",rev:2};
  const p=await page(s,unread("note","n"),before); await expand(p);
  assert.ok(!p.all().some(e=>e.id === "note-n"),"bookkeeping must not auto-open the list");
  await p.all().find(e=>e.className.startsWith("notes-toggle") && e.innerHTML.includes("评论 1 条"))!.click(); await settle();
  const row=p.all().find(e=>e.id === "note-n")!;
  assert.ok(!row.className.includes("newbar") && !row.children.some(e=>e.className.includes("newbar")));
});

test("added dependency and link rows retain green marks and also have blue bars", async () => {
  const s=snapshot(), before={...s.items.child!,deps:[],links:[]};
  s.items.child!.deps=[{id:"area",why:"Added dependency"}]; s.items.child!.links=[{label:"Added link",url:"https://example.com/new"}];
  const p=await page(s,unread(),before); await expand(p);
  const rows=descendants(item(p)), dep=rows.find(e=>e.className.includes("deprow") && markup(e).includes("Added dependency"))!, link=rows.find(e=>e.tagName === "A" && e.innerHTML === "Added link")!;
  assert.ok(dep.className.includes("chg-add") && dep.className.split(" ").includes("fresh"));
  assert.ok(link.className.includes("chg-add") && link.className.split(" ").includes("fresh"));
  const css=await readFile("web/index.html","utf8");
  assert.ok(/[^{}]*\.refs[^{}]*\.fresh[^{}]*\{[^}]*var\(--fresh\)/.test(css),"new link bar CSS must use the fresh token");
});

test("n opens collapsed item and card comment lists then scrolls to the existing note row", async () => {
  for (const target of ["it:child","q:q"]) {
    const s=snapshot(); if (target.startsWith("q:")) s.decisions.q=card();
    s.notes.n={target,kind:"comment",text:"New note",at,state:"sent",rev:1};
    const p=await page(s,unread("note","n"),null,undefined,{notesOpen:{[target]:false},geometry:geom});
    assert.ok(!p.all().some(e=>e.id === "note-n"));
    p.key("n"); await settle();
    assert.ok(p.all().find(e=>e.id === "note-n")!.className.includes("cur"));
    assert.equal(p.measurements[0]!.id,"note-n");
    assert.ok(p.scrolls.at(-1)! > 0,"scroll must use the note's nonzero geometry");
    assert.ok(p.calls.some(c=>c.path.startsWith("/api/step?") && c.path.includes("kind=note")),"scroll must wait for note rendering's baseline");
  }
});

test("n waits for an already pending ancestor mark request before measuring and scrolling to a note", async () => {
  const s=snapshot(), hold=deferred<unknown>(); s.items.area!.head="Current ancestor";
  s.notes.n={target:"it:child",kind:"comment",text:"Note below ancestor",at,state:"sent",rev:1};
  const changes=[...unread("note","n"),...unread("item","area","e".repeat(40))];
  const p=await page(s,changes,(params:URLSearchParams)=>params.get("doc") === "area" ? hold.promise : endpoints(s,params,null),undefined,{notesOpen:{"it:child":false},geometry:(e,all)=>({top:e.id === "note-n" ? (all().some(v=>v.innerHTML.includes('class="chg-del"')) ? 2100 : 1200) : 600,height:e.id === "note-n" ? 100 : 2400})});
  await expand(p,"area"); assert.ok(p.calls.some(c=>c.path.includes("doc=area")));
  p.key("n"); await settle();
  assert.equal(p.scrolls.length,0,"scroll cannot precede the already pending ancestor request");
  hold.resolve(endpoints(s,new URLSearchParams("kind=item&doc=area"),{...s.items.area!,head:"Removed ancestor\n\nCurrent ancestor"})); await settle();
  assert.equal(p.measurements[0]!.id,"note-n"); assert.equal(p.measurements[0]!.top,2100);
  assert.equal(p.scrolls.length,1);
});

test("rapid n suppresses obsolete scrolling while delayed note baselines finish", async () => {
  const s=snapshot(), first=deferred<unknown>(), second=deferred<unknown>();
  s.notes.one={target:"it:child",kind:"comment",text:"First",at,state:"sent",rev:1}; s.notes.two={...s.notes.one,text:"Second"};
  const p=await page(s,[...unread("note","one"),...unread("note","two","e".repeat(40))],(params:URLSearchParams)=>params.get("doc") === "one" ? first.promise : second.promise,undefined,{notesOpen:{"it:child":false},geometry:geom});
  p.key("n"); p.key("n"); await settle();
  assert.equal(p.scrolls.length,0,"both navigation requests must await rendered note baselines");
  second.resolve(endpoints(s,new URLSearchParams("kind=note&doc=two"),null)); await settle(); assert.equal(p.scrolls.length,0,"another rendered pending baseline can still move the target");
  first.resolve(endpoints(s,new URLSearchParams("kind=note&doc=one"),null)); await settle();
  assert.equal(p.scrolls.length,1); assert.equal(p.measurements[0]!.id,"note-two");
  assert.ok(p.all().find(e=>e.id === "note-two")!.className.includes("cur"));
});


test("failed rendered baseline prevents scrolling and retries once on the next n", async () => {
  const s=snapshot(), hold=deferred<unknown>(); let attempts=0;
  s.notes.n={target:"it:child",kind:"comment",text:"New note",at,state:"sent",rev:1};
  const p=await page(s,unread("note","n"),(params:URLSearchParams)=>++attempts === 1 ? hold.promise : endpoints(s,params,null),undefined,{notesOpen:{"it:child":false},geometry:geom});
  p.key("n"); await settle(); assert.equal(attempts,1); assert.equal(p.scrolls.length,0);
  hold.reject(new Error("Synthetic baseline unavailable")); await settle();
  assert.equal(p.scrolls.length,0,"failed baseline cannot provide a final layout for scrolling");
  assert.equal(attempts,1,"a failed navigation must not retry repeatedly during rendering");
  assert.match(p.roots.get("server-banner")!.textContent,/Synthetic baseline unavailable/);
  p.key("n"); await settle();
  assert.equal(attempts,2,"next n retries the failed rendered baseline once");
  assert.equal(p.scrolls.length,1); assert.equal(p.measurements[0]!.id,"note-n");
});
