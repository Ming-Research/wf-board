import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { rules } from "../src/rules.ts";
import type { Snapshot, Decision, Note } from "../src/model.ts";

// Execute the actual bundle against a tiny synthetic DOM and modeled geometry. No browser or listener
// is needed: the harness checks controls, frame scheduling and synthetic layout/scrolling.
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
    contains: (c:string) => this.className.split(" ").includes(c),
    add: (c: string) => { this.className += " " + c; },
    remove: (c: string) => { this.className = this.className.split(" ").filter(v => v !== c).join(" "); },
    toggle: (c: string) => { if (this.className.split(" ").includes(c)) this.classList.remove(c); else this.classList.add(c); },
  };
  appendChild(e: Element) { e.parentElement?.removeChild(e); this.children.push(e); e.parentElement = this; return e; }
  removeChild(e: Element) { this.children=this.children.filter(x=>x !== e); e.parentElement=null; return e; }
  remove() { this.parentElement?.removeChild(this); }
  insertBefore(e: Element, before:Element|null=null) { e.parentElement?.removeChild(e); const i=before ? this.children.indexOf(before) : this.children.length; assert.ok(i>=0); this.children.splice(i,0,e); e.parentElement=this; return e; }
  replaceWith(e: Element) { const p = this.parentElement; if (!p) return; p.children[p.children.indexOf(this)] = e; e.parentElement = p; this.parentElement = null; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(kind: string, fn: (event: unknown) => unknown) { this.handlers.set(kind, [...this.handlers.get(kind) ?? [], fn]); }
  captureClick?:()=>void;
  async click() { this.captureClick?.(); for (const fn of this.handlers.get("click") ?? []) await fn({ stopPropagation() {}, preventDefault() {} }); }
  selectionStart = 0; selectionEnd = 0;
  focus() { focused.current = this; } blur() { if (focused.current === this) focused.current = null; } scrollIntoView() {}
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  geometry?: () => {top:number;bottom:number;height:number;left:number;width:number};
  getBoundingClientRect() { return this.geometry?.() ?? { left: 0, width: 900, height: 100, top: 50, bottom: 150 }; }
  matches(selector: string):boolean { return selector.split(/,\s*/).some(s=> {
    const parts=s.trim().split(/\s+/), last=parts.pop()!;
    const own=last.startsWith(".") ? last.slice(1).split(".").every(c=>this.className.split(" ").includes(c)) : last.startsWith("#") ? this.id === last.slice(1) : this.tagName === last.toUpperCase();
    return own && (!parts.length || !!this.parentElement?.closest(parts.join(" ")));
  }); }
  closest(selector: string): Element | null { return this.matches(selector.replace("#areas ", "")) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelector(selector: string):Element|null { const children=selector.startsWith(":scope > ") ? this.children : this.children.flatMap(descendants); const match=children.find(e=>e.matches(selector.replace(":scope > ",""))); if(match) return match; if (selector === ".t") { const e = new Element("span"); e.className = "t"; return this.appendChild(e); } return null; }
  contains(e:Element):boolean { return e === this || this.children.some(c=>c.contains(e)); }
  get innerHTML() { return this.html; }
  set innerHTML(value: string) { this.html = value; this.children = []; }
  get firstChild(): Element | null { return this.children[0] ?? null; }
  get firstElementChild(): Element | null { return this.firstChild; }
}
let bundle: Promise<string> | undefined;
interface FakeResponse { ok:boolean; status:number; json: () => Promise<unknown> }
interface PageOptions {
  notesOpen?: Record<string,boolean>; geometry?: (e:Element, all: () => Element[]) => {top:number;height:number};
  transform?: (code:string) => string;
  frames?: Frames;
  reducedMotion?:boolean; noFrames?:boolean; scrollHeight?:()=>number;
  clock?: FakeClock; autoOpen?: boolean; response?: (path:string,body:unknown,init:{method?:string;signal?:AbortSignal}) => FakeResponse | Promise<FakeResponse> | undefined;
}
async function page(snapshot: Snapshot, unread: unknown[], before: unknown = null, after?: unknown, options: PageOptions = {}) {
  const code = await (bundle ??= build({ entryPoints: ["web/app.ts"], bundle: true, format: "iife", globalName: "BoardPage", write: false, target: "es2022" }).then(result => result.outputFiles[0]!.text));
  const roots = new Map<string, Element>();
  for (const id of ["goal", "goal-title", "eyebrow", "meta", "summary", "nav", "areas", "cards", "decisions", "crumbs", "sendbox", "send-all", "send-note", "to-top", "server-banner"]) { const e = new Element(id === "send-all" ? "button" : "div"); e.id = id; roots.set(id,e); }
  const body = new Element("body"), wrap = new Element("div"), header = new Element("header");
  const all = (): Element[] => { const out: Element[] = []; function walk(e: Element) { out.push(e); e.children.forEach(walk); } for (const e of [...roots.values(),body]) walk(e); return out; };
  const calls: Array<{path: string; body?: unknown}> = [];
  const measurements: Array<{id:string;top:number;height:number}> = [], scrolls: number[] = [];
  const renders:unknown[]=[]; let scrollPosition=0;
  const frame = options.frames?.request ?? ((fn:(now:number)=>void)=> { void setImmediate().then(()=>fn(performance.now())); return 1; });
  const windowListeners=new Map<string,Array<(event:unknown)=>unknown>>();
  const listeners = new Map<string,Array<{fn:(event:unknown)=>unknown;capture:boolean}>>();
  const dispatch=(kind:string,event:unknown,captureOnly=false)=> { for(const {fn,capture} of [...listeners.get(kind) ?? []].sort((a,b)=>Number(b.capture)-Number(a.capture))) if (!captureOnly || capture) fn(event); };
  const programmaticScroll=()=> { void Promise.resolve().then(()=> { for(const fn of windowListeners.get("scroll") ?? []) fn({isTrusted:true}); }); };
  const document = {
    body, get activeElement() { return focused.current; }, documentElement: { get scrollHeight() { return options.scrollHeight?.() ?? 10000; } },
    getElementById: (id: string) => all().find(e => e.id === id) ?? null,
    createTextNode: (text:string) => { const e=new Element("#text"); e.textContent=text; return e; },
    createElement: (tag: string) => {
      const e = new Element(tag);
      e.captureClick=()=>dispatch("click",{isTrusted:true,target:e},true);
      if (options.geometry) e.geometry = () => { const r = options.geometry!(e,all); measurements.push({id:e.id,...r}); return {...r,bottom:r.top+r.height,left:0,width:900}; };
      return e;
    },
    querySelector: (selector: string) => selector === ".wrap" ? wrap : selector === "header.top" ? header : all().find(e => selector === '[data-sel="' + e.dataset.sel + '"]') ?? null,
    querySelectorAll: (selector:string) => all().filter(e=>e.matches(selector)), elementFromPoint: () => null,
    addEventListener: (kind: string, fn: (event: unknown) => unknown,opts?:{capture?:boolean}) => listeners.set(kind,[...listeners.get(kind) ?? [],{fn,capture:!!opts?.capture}]),
  };
  const sources: EventSource[] = [];
  class EventSource {
    onopen?: () => unknown; onerror?: () => unknown; closed=false;
    handlers = new Map<string, (event:unknown) => unknown>();
    constructor(_url:string) { sources.push(this); }
    addEventListener(kind: string, fn: (event: unknown) => unknown) { this.handlers.set(kind,fn); }
    close() { this.closed=true; }
  }
  const context = {
    BoardPage: undefined,
    document, HTMLElement: Element, EventSource, AbortController, console, CSS: { escape: (s: string) => s },
    innerHeight: 1000, get scrollY() { return scrollPosition; }, localStorage: { getItem: (key:string) => key === "board-notes" && options.notesOpen ? JSON.stringify(options.notesOpen) : null, setItem() {} },
    matchMedia: () => ({ matches: options.reducedMotion !== false }), getComputedStyle: () => ({ scrollMarginTop: "0" }),
    recordRender:(scope:unknown)=>renders.push(scope),
    performance:{now:()=>options.frames?.now ?? performance.now()}, setTimeout: options.clock?.setTimeout ?? setTimeout, clearTimeout: options.clock?.clearTimeout ?? clearTimeout, ...options.noFrames ? {} : {requestAnimationFrame:frame},
    addEventListener:(kind:string,fn:(event:unknown)=>unknown)=>windowListeners.set(kind,[...windowListeners.get(kind) ?? [],fn]),
    window: { get scrollY() { return scrollPosition; }, addEventListener:(kind:string,fn:(event:unknown)=>unknown)=>windowListeners.set(kind,[...windowListeners.get(kind) ?? [],fn]), scrollBy(_x:number,y:number) { scrollPosition=Math.max(0,Math.min((options.scrollHeight?.() ?? 10000)-1000,scrollPosition+y)); programmaticScroll(); }, scrollTo(_x:number,y:number) { scrolls.push(y); scrollPosition=Math.max(0,Math.min((options.scrollHeight?.() ?? 10000)-1000,y)); programmaticScroll(); } },
    fetch: async (path: string, init?: {body?: string; method?: string; signal?:AbortSignal}) => {
      const input = init?.body ? JSON.parse(init.body) : undefined; calls.push({path,body:input});
      const intercepted = options.response?.(path,input,init ?? {});
      if (intercepted !== undefined) return await intercepted;
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
      else if (path === "/api/draft") {
        const a=input as {target:string;kind:Note["kind"];on:boolean;text:string;choice?:string};
        const deleted=Object.keys(snapshot.notes).filter(id=>snapshot.notes[id]!.target === a.target && snapshot.notes[id]!.kind === a.kind && snapshot.notes[id]!.state === "draft");
        deleted.forEach(id=>delete snapshot.notes[id]);
        const id="persisted-draft", doc:Note={target:a.target,kind:a.kind,text:a.text,at,state:"draft",rev:1,...a.choice ? {choice:a.choice} : {}};
        if (a.on) snapshot.notes[id]=doc;
        value={note:a.on ? {id,doc} : null,deleted,commit:"c".repeat(40)};
      }
      else throw new Error("Unexpected page request " + path);
      return { ok: true, status: 200, json: async () => structuredClone(value) };
    },
  };
  const recorded=code.includes("function renderPage(scope)") ? code.replace("function renderPage(scope) {","function renderPage(scope) { recordRender(scope);") : code.replace("function renderAll() {","function renderAll() { recordRender('all');");
  runInNewContext(options.transform?.(recorded) ?? recorded, context);
  await setImmediate(); await setImmediate();
  if (options.autoOpen !== false) { await sources[0]?.onopen?.(); await setImmediate(); await setImmediate(); }
  const flush=async()=> { for (let i=0;i<4;i++) { options.frames?.flush(); if (options.noFrames) options.clock?.advance(0); if (options.noFrames) await new Promise(resolve=>setTimeout(resolve,0)); await setImmediate(); } };
  await flush();
  // A live update from the server, as the page's event stream delivers it.
  const emit=(commit:string,changed:unknown[]=[])=>sources.at(-1)!.handlers.get("change")!({ data: JSON.stringify({commit,changed}) });
  const change = async (commit: string,changed:unknown[]=[]) => { emit(commit,changed); await setImmediate(); };
  return { roots, all, calls, document, change, emit, measurements, scrolls, sources, renders,flush, get scrollY() { return scrollPosition; },
    user:(kind:string)=> { if (kind === "scroll") scrollPosition+=100; dispatch(kind,{isTrusted:true,target:new Element("div")}); for(const fn of windowListeners.get(kind) ?? []) fn({isTrusted:true,target:new Element("div")}); },
    key: (key: string) => dispatch("keydown",{key,isTrusted:true,target:new Element("div"),preventDefault(){}}) };
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
  p.key("n"); await setImmediate(); p.key("r"); await p.flush();
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
  p.key("n"); await setImmediate(); p.key("r"); await p.flush();
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
  const p = await page(s,unread("note","n"),before); p.key("n"); await p.flush();
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
  p.key("n"); await p.flush(); assert.ok(item(p).className.includes("cur"));
  assert.ok(!p.calls.some(c => c.path === "/api/read"));
  p.key("n"); await p.flush(); assert.ok(item(p,"area").className.includes("cur"));
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
  p.key("n"); await p.flush();
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
  await p.change("b".repeat(40),[{kind:"note",id:"live",after:{target:"it:area",kind:"comment",text:"Live note",at,state:"sent",rev:1}}]); await p.flush();
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


class FakeClock {
  now=0; next=1; jobs=new Map<number,{at:number;fn:()=>void}>();
  setTimeout=(fn:()=>void,ms=0) => { const id=this.next++; this.jobs.set(id,{at:this.now+ms,fn}); return id; };
  clearTimeout=(id:number) => { this.jobs.delete(id); };
  advance(ms:number) { const end=this.now+ms; for (;;) { const next=[...this.jobs].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]; if (!next) break; this.now=next[1].at; this.jobs.delete(next[0]); next[1].fn(); } this.now=end; }
}
function reply(value:unknown):FakeResponse { return {ok:true,status:200,json:async()=>structuredClone(value)}; }
function button(p:Awaited<ReturnType<typeof page>>, label:string) { return p.all().find(e=>e.tagName === "BUTTON" && (e.innerHTML === label || e.textContent === label))!; }
class Frames {
  jobs:Array<(now:number)=>void>=[];
  now=0;
  request=(fn:(now:number)=>void)=> { this.jobs.push(fn); return this.jobs.length; };
  flush(ms=100) { this.now+=ms; const jobs=this.jobs.splice(0); jobs.forEach(fn=>fn(this.now)); }
}

test("unrelated collapsed baseline does not block target navigation", async () => {
  const s=snapshot(), hold=deferred<unknown>(); s.items.far={...s.items.area!,title:"Far",deps:[]};
  const p=await page(s,[...unread(),...unread("item","far","e".repeat(40))],(params:URLSearchParams)=>params.get("doc") === "far" ? hold.promise : endpoints(s,params,null),undefined,{geometry:geom});
  p.key("n"); await settle();
  assert.equal(p.scrolls.length,1,"a collapsed unrelated baseline must not delay the target");
  assert.equal(p.measurements[0]!.id,"it-child");
  hold.resolve(endpoints(s,new URLSearchParams("kind=item&doc=far"),null)); await settle();
});

test("unrelated collapsed baseline failure does not suppress target navigation", async () => {
  const s=snapshot(); s.items.far={...s.items.area!,title:"Far",deps:[]};
  const p=await page(s,[...unread(),...unread("item","far","e".repeat(40))],(params:URLSearchParams)=>params.get("doc") === "far" ? Promise.reject(new Error("Unrelated failure")) : endpoints(s,params,null),undefined,{geometry:geom});
  p.key("n"); await settle(); assert.equal(p.scrolls.length,1);
});

test("explicitly collapsed ancestor comments do not block child navigation on pending or failed note baselines", async t => {
  for (const state of ["pending","failed"]) await t.test(state,async () => {
    const s=snapshot(), hold=deferred<unknown>(); let attempts=0;
    s.notes.hidden={target:"it:area",kind:"comment",text:"Hidden ancestor comment",at,state:"sent",rev:1};
    const p=await page(s,[...unread(),...unread("note","hidden","e".repeat(40))],(params:URLSearchParams)=> {
      if (params.get("doc") === "hidden") { attempts++; return hold.promise; }
      return endpoints(s,params,null);
    },undefined,{notesOpen:{"it:area":false},geometry:geom});
    await expand(p,"area"); assert.equal(attempts,1,"rendering checks whether the hidden note is fresh");
    assert.ok(!p.all().some(e=>e.id === "note-hidden"));
    if (state === "failed") { hold.reject(new Error("Hidden ancestor note unavailable")); await settle(); }
    p.key("n"); await settle();
    assert.equal(p.scrolls.length,1,"an explicitly hidden ancestor note cannot change target geometry");
    assert.equal(p.measurements[0]!.id,"it-child");
    assert.equal(attempts,1,"navigation does not retry hidden failed notes");
    if (state === "pending") { hold.resolve(endpoints(s,new URLSearchParams("kind=note&doc=hidden"),null)); await settle(); }
  });
});

test("filtered ancestor comments can auto-open without its body and navigation waits for their final geometry", async () => {
  const s=snapshot(), hold=deferred<unknown>(); s.items.area!.head="Ancestor body stays folded";
  s.notes.above={target:"it:area",kind:"comment",text:"New ancestor comment",at,state:"sent",rev:1};
  const p=await page(s,[...unread(),...unread("note","above","e".repeat(40))],(params:URLSearchParams)=>params.get("doc") === "above" ? hold.promise : endpoints(s,params,null),undefined,{geometry:(e,all)=>({top:e.id === "it-child" ? (all().some(v=>v.id === "note-above") ? 2100 : 1200) : 600,height:e.id === "it-child" ? 100 : 2400})});
  const filter=p.all().find(e=>e.tagName === "BUTTON" && e.innerHTML.startsWith("进行中 "))!; await filter.click();
  assert.ok(p.all().some(e=>e.id === "it-child"),"filter opens the ancestor path");
  assert.ok(!markup(item(p,"area")).includes("Ancestor body stays folded"));
  assert.ok(!p.all().some(e=>e.id === "note-above"));
  p.key("n"); await settle();
  assert.equal(p.scrolls.length,0,"visible ancestor comments must finish loading even with its body folded");
  hold.resolve(endpoints(s,new URLSearchParams("kind=note&doc=above"),null)); await settle();
  assert.ok(p.all().some(e=>e.id === "note-above"),"fresh ancestor comment auto-opens");
  assert.ok(!markup(item(p,"area")).includes("Ancestor body stays folded"),"ancestor body remains manually folded");
  assert.equal(p.measurements[0]!.id,"it-child"); assert.equal(p.measurements[0]!.top,2100);
  assert.equal(p.scrolls.length,1);
});

async function questionContract(tail:string, transform?:PageOptions["transform"]) {
  const s=snapshot(), before={...card(),question:"Common\n\nOld question"+tail}; s.decisions.q={...card(),question:"Common\n\nNew question"+tail};
  const p=await page(s,unread("decision","q"),before,undefined,{transform}); await expand(p);
  const c=p.all().find(e=>e.id === "q-q")!, html=markup(c);
  assert.match(html,/<p>Common<\/p>.*class="chg-del"[^>]*><p>Old question<\/p>.*class="chg-add"[^>]*><p>New question<\/p>/s);
  assert.equal(html.split("<p>Common</p>").length-1,1);
  if (tail) { assert.match(html,/<p>New question<\/p>.*<p>Last<\/p>/s); assert.equal(html.split("<p>Last</p>").length-1,1); }
}
test("multi-paragraph card question compares blocks without repeating unchanged paragraphs", async t => {
  for (const tail of ["","\n\nLast"]) await t.test(tail ? "three paragraphs" : "two paragraphs",()=>questionContract(tail));
});
test("two-paragraph question guard detects old whole-question title rendering", async () => {
  let transformed=false;
  await assert.rejects(()=>questionContract("",code=> {
    const old=code.replace(/if \(proseBlocks\(d.question\).length > 1 \|\| before && proseBlocks\(before.question\).length > 1\) \{[\s\S]*?\} else appendTitle\(h, d.question \|\| "", before === null \? null : before\?\.question\);/, 'appendTitle(h, d.question || "", before === null ? null : before?.question);');
    transformed=old !== code; return old;
  }),{code:"ERR_ASSERTION"});
  assert.ok(transformed,"mutation restores the old whole-question appendTitle path");
});

function cssContract(html:string) {
  html=html.replace(/\/\*[\s\S]*?\*\//g, "");
  const themes=[html.match(/:root \{([^}]+)\}/)![1]!,...html.matchAll(/:root(?::not\(\[data-theme="light"\]\)|\[data-theme="dark"\]) \{([^}]+)\}/g)].map(v=>typeof v === "string" ? v : v[1]!);
  assert.equal(themes.length,3);
  for (const theme of themes) for (const token of ["--chg-add","--chg-del","--chg-del-ink","--fresh"]) assert.ok(new RegExp(token+":\\s*#[a-fA-F0-9]+").test(theme),"every theme defines "+token);
  const rules=[...html.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  const has=(sel:string,decl:RegExp) => rules.some(r=>r[1]!.split(",").map(v=>v.trim()).includes(sel)&&decl.test(r[2]!));
  assert.ok(has(".chg-add",/background:\s*var\(--chg-add\)/));
  assert.ok(has(".chg-del",/background:\s*var\(--chg-del\)/));
  assert.ok(has(".chg-del",/color:\s*var\(--chg-del-ink\)/));
  for (const sel of [".chg-del",".chg-del *"]) {
    assert.ok(has(sel,/text-decoration:\s*line-through/));
    assert.ok(has(sel,/color:\s*var\(--chg-del-ink\)\s*!important/),sel+" keeps rich descendants red");
  }
  for (const sel of [".item.fresh",".card.fresh",".log-entry.fresh",".deprow.fresh",".note.newbar",".note .reply.newbar",".notes-toggle.newbar",".refs .fresh"]) assert.ok(has(sel,/(?:box-shadow|border-left):[^;]*var\(--fresh\)/),sel+" has blue bar CSS");
}
test("CSS mark tokens and every blue bar selector are wired in light and both dark themes", async () => { cssContract(await readFile("web/index.html","utf8")); });
test("CSS contract detects removed theme tokens mark declarations and blue selectors", async t => {
  const html=await readFile("web/index.html","utf8");
  for (const token of ["--chg-add","--chg-del","--chg-del-ink","--fresh"]) {
    const declarations=[...html.matchAll(new RegExp(token+":\\s*#[a-fA-F0-9]+;","g"))];
    assert.equal(declarations.length,3);
    for (const [i,match] of declarations.entries()) await t.test(token+" theme "+i,()=> {
      const broken=html.slice(0,match.index)+html.slice(match.index+match[0].length);
      assert.throws(()=>cssContract(broken));
    });
  }
  for (const [name,pattern] of [
    ["green background",/background:\s*var\(--chg-add\)(?:\s*!important)?;/g],
    ["red background",/background:\s*var\(--chg-del\);/g],
    ["red ink",/color:\s*var\(--chg-del-ink\)(?:\s*!important)?;/g],
    ["descendant red ink override",/color:\s*var\(--chg-del-ink\)\s*!important;/g],
    ["strike",/text-decoration:\s*line-through;/g],
  ] as const) await t.test(name,()=> { assert.match(html,pattern); assert.throws(()=>cssContract(html.replaceAll(pattern,""))); });
  for (const selector of [".item.fresh",".card.fresh",".log-entry.fresh",".deprow.fresh",".note.newbar",".note .reply.newbar",".notes-toggle.newbar",".refs .fresh"]) await t.test(selector,()=> {
    assert.ok(html.includes(selector)); assert.throws(()=>cssContract(html.replaceAll(selector, ".removed-selector")));
  });
});
test("obsolete freshbtn CSS is removed", async () => { const html=await readFile("web/index.html","utf8"); assert.ok(!/\.freshbtn(?:\b|:)/.test(html)); });

async function allReadContract(transform?: PageOptions["transform"]) {
  const ids=[stepId,"e".repeat(40)], p=await page(snapshot(),[...unread("item","child",ids[0]),...unread("item","area",ids[1])],null,undefined,{transform});
  await button(p,"全部已阅").click(); assert.equal(p.calls.filter(c=>c.path === "/api/read").length,0);
  await button(p,"取消").click(); assert.equal(p.calls.filter(c=>c.path === "/api/read").length,0);
  await button(p,"全部已阅").click(); await button(p,"确认").click(); await settle();
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{through:ids[1]}]);
}
test("all-read requires confirmation cancel writes nothing and confirm reads the last step", async () => { await allReadContract(); });
test("all-read guard detects writes before confirmation or on cancel and missing or wrong confirmed steps", async t => {
  for (const [name,from,to] of [
    ["write before confirmation",'const ask = el("span", "readconfirm",','void readThrough(steps.at(-1).id); const ask = el("span", "readconfirm",'],
    ["missing confirmed write","await readThrough(steps.at(-1).id);","void 0;"],
    ["write on cancel","() => ask.replaceWith(all)","() => { void readThrough(steps.at(-1).id); ask.replaceWith(all); }"],
    ["confirmed first step instead of last","await readThrough(steps.at(-1).id);","await readThrough(steps[0].id);"],
  ]) await t.test(name!,async ()=> {
    await assert.rejects(()=>allReadContract(code=> { assert.ok(code.includes(from!)); return code.replace(from!,to!); }),{code:"ERR_ASSERTION"});
  });
});

test("all mutating requests time out at eight seconds and recover their controls without late success", async t => {
  for (const action of ["send","notes","read","archive","delete","json"] as const) await t.test(action, async () => {
    const s=snapshot(), clock=new FakeClock(), hold=deferred<FakeResponse>(), body=deferred<unknown>(); let signal:AbortSignal|undefined;
    s.notes.d={target:"it:area",kind:"comment",text:"Draft",at,state:"draft",rev:1};
    const path=action === "json" ? "/api/send" : action === "delete" ? "/api/notes/d" : "/api/"+action;
    const p=await page(s,unread("item","area"),null,undefined,{clock,response:(url,_value,init)=>{ if (url !== path) return; signal=init.signal; return action === "json" ? {ok:true,status:200,json:()=>body.promise} : hold.promise; }});
    let control:Element, pending:Promise<unknown>|undefined;
    if (action === "send" || action === "json") { control=p.roots.get("send-all")!; pending=control.click(); }
    else if (action === "read") { await button(p,"全部已阅").click(); control=button(p,"确认"); pending=control.click(); }
    else {
      p.key("n"); await settle();
      if (action === "archive") { control=p.all().find(e=>e.className === "keymenu-row" && e.innerHTML.includes("归档或取消归档"))!; pending=control.click(); }
      else if (action === "notes") { p.key("c"); await settle(); const text=p.all().find(e=>e.id === "ed-it_area")!; text.value="New draft"; control=button(p,"保存"); pending=control.click(); }
      else { const toggle=p.all().find(e=>e.className.startsWith("notes-toggle") && e.innerHTML.includes("评论 1 条"))!; await toggle.click(); control=button(p,"删除"); pending=control.click(); }
    }
    await settle(); clock.advance(7999); await settle(); assert.ok(p.roots.get("server-banner")!.hidden || !p.roots.get("server-banner")!.textContent.includes("刷新"));
    clock.advance(1); await settle();
    assert.match(p.roots.get("server-banner")!.textContent,/看板服务器.*(?:未|没).*响应.*刷新/);
    assert.equal(control.disabled,false,action+" control recovers"); if (action === "notes") assert.equal(control.textContent || control.innerHTML,"保存");
    assert.equal(signal?.aborted,true,action+" aborts transport");
    hold.resolve(reply({sent:[{project:"Late"}]})); body.resolve({sent:[{project:"Late"}]}); await settle();
    assert.ok(!p.roots.get("send-note")!.textContent.includes("Late"));
    await pending;
  });
});

test("successful read releases confirmation even when snapshot or unread refresh stalls", async t => {
  for (const path of ["/api/snapshot","/api/unread"]) await t.test(path, async () => {
    const clock=new FakeClock(), hold=deferred<FakeResponse>(); let written=false;
    const p=await page(snapshot(),unread(),null,undefined,{clock,response:(url)=> {
      if (url === "/api/read") { written=true; return; }
      if (written && url === path) return hold.promise;
    }});
    await button(p,"全部已阅").click(); const confirm=button(p,"确认"); let completed=false;
    const pending=confirm.click().then(()=> { completed=true; });
    await settle(); clock.advance(8000); await settle();
    assert.equal(confirm.disabled,false,"a successful write cannot keep the control waiting for GET refresh");
    assert.equal(completed,true,"the click handler settles when the write settles");
    assert.equal(p.calls.filter(c=>c.path === "/api/read").length,1);
    hold.resolve(reply(path === "/api/snapshot" ? snapshot() : {steps:[]})); await pending;
  });
});

test("disconnection immediately reports and refuses existing write controls without fetch", async () => {
  const s=snapshot(), clock=new FakeClock(); s.notes.d={target:"it:area",kind:"comment",text:"Draft",at,state:"draft",rev:1};
  const p=await page(s,unread("item","area"),null,undefined,{clock}); p.key("n"); await settle(); p.key("c"); await settle();
  const text=p.all().find(e=>e.id === "ed-it_area")!; text.value="Offline draft";
  p.sources[0]!.onerror!();
  assert.equal(p.roots.get("server-banner")!.textContent,"已和看板服务器断开，正在重连…");
  const calls=p.calls.length; await button(p,"保存").click(); await p.roots.get("send-all")!.click(); p.key("e"); await settle();
  assert.equal(p.calls.length,calls,"disconnected writes never reach fetch");
  assert.equal(p.roots.get("server-banner")!.textContent,"已和看板服务器断开，正在重连…");
});

test("SSE reconnection retries every five seconds and waits for open plus snapshot reload", async () => {
  const s=snapshot(), clock=new FakeClock(), hold=deferred<FakeResponse>(); let hang=false;
  const p=await page(s,unread(),null,undefined,{clock,response:path=>hang&&path === "/api/snapshot" ? hold.promise : undefined});
  hang=true; p.sources[0]!.onerror!(); clock.advance(4999); await settle(); assert.equal(p.sources.length,1);
  clock.advance(1); await settle(); assert.equal(p.sources.length,2,"a new SSE connection starts after five seconds");
  const obsolete=p.sources[1]!; void obsolete.onopen!(); await settle();
  assert.equal(p.roots.get("server-banner")!.hidden,false,"open alone cannot clear banner before snapshot");
  clock.advance(5000); await settle(); assert.equal(p.sources.length,3,"hung reload cannot block the next connection attempt");
  hang=false; await p.sources[2]!.onopen!(); await settle(); assert.equal(p.roots.get("server-banner")!.hidden,true);
  assert.equal(p.sources[2]!.closed,false);
  obsolete.onerror!(); await settle(); assert.equal(p.roots.get("server-banner")!.hidden,true,"obsolete callbacks cannot disconnect the healthy source");
  hold.resolve(reply({...s,board:{...s.board,title:"Obsolete snapshot"}})); await settle();
  assert.equal(p.roots.get("goal-title")!.textContent,s.board.title,"late obsolete reload cannot replace current snapshot");
});

test("writes remain unavailable before initial SSE open and reload", async () => {
  const s=snapshot(), clock=new FakeClock(); s.notes.d={target:"it:area",kind:"comment",text:"Draft",at,state:"draft",rev:1};
  const p=await page(s,[],null,undefined,{clock,autoOpen:false}); const n=p.calls.length;
  await p.roots.get("send-all")!.click(); await settle(); assert.equal(p.calls.length,n);
  assert.equal(p.roots.get("server-banner")!.textContent,"已和看板服务器断开，正在重连…");
  await p.sources[0]!.onopen!(); await settle(); assert.equal(p.roots.get("server-banner")!.hidden,true);
});

test("owner refresh from an obsolete connection cannot replace snapshot or report a late error", async t => {
  for (const late of ["snapshot","error"]) await t.test(late,async () => {
    const s=snapshot(), clock=new FakeClock(), hold=deferred<FakeResponse>(); let written=false, holding=true;
    const p=await page(s,unread(),null,undefined,{clock,response:path=> {
      if (path === "/api/read") { written=true; return; }
      if (written && holding && path === "/api/snapshot") return hold.promise;
    }});
    await button(p,"全部已阅").click(); await button(p,"确认").click(); await settle();
    p.sources[0]!.onerror!(); holding=false; clock.advance(5000); await p.sources[1]!.onopen!(); await settle();
    assert.equal(p.roots.get("server-banner")!.hidden,true);
    if (late === "snapshot") hold.resolve(reply({...s,board:{...s.board,title:"Obsolete owner refresh"}}));
    else hold.reject(new Error("Obsolete owner refresh failed"));
    await settle();
    assert.equal(p.roots.get("goal-title")!.textContent,s.board.title,"old owner reload cannot replace the current snapshot");
    assert.equal(p.roots.get("server-banner")!.hidden,true,"old owner reload cannot report an error after reconnect");
  });
});

function option(p:Awaited<ReturnType<typeof page>>, key:string, id="q") { return descendants(p.all().find(e=>e.id === "q-"+id)!).find(e=>e.className.split(" ").includes("optbtn") && e.innerHTML.includes('class="lbl">'+key+'：'))!; }
test("choice feedback is synchronous before fetch and rolls back on failure", async () => {
  const s=snapshot(), clock=new FakeClock(), hold=deferred<FakeResponse>(); s.decisions.q=card();
  s.notes.previous={target:"q:q",kind:"choice",choice:"B",text:"选 B",at,state:"draft",rev:1};
  let p!:Awaited<ReturnType<typeof page>>, observed=false;
  p=await page(s,[],null,undefined,{clock,response:(_path,_body,init)=> { if (init.method && init.method !== "GET") { observed=option(p,"A").className.includes("sel") && !option(p,"B").className.includes("sel"); return hold.promise; } }});
  await expand(p); const click=option(p,"A").click();
  try { assert.equal(observed,true,"selection and deselection happen before fetch is dispatched"); }
  finally { hold.reject(new Error("Draft refused")); await click; await p.flush(); }
  assert.ok(option(p,"B").className.includes("sel")); assert.ok(!option(p,"A").className.includes("sel"));
  assert.match(p.roots.get("server-banner")!.textContent,/Draft refused/); assert.equal(option(p,"A").disabled,false);
  assert.equal(p.calls.filter(c=>c.path === "/api/draft").length,1);
});

test("approve done and explain feedback is synchronous and failure restores it", async t => {
  for (const kind of ["approve","done","explain"]) await t.test(kind,async () => {
    const s=snapshot(), clock=new FakeClock(), hold=deferred<FakeResponse>(); s.items.area!.ask={text:"Act",...kind === "done" ? {url:"https://example.com/act"} : {}};
    let p!:Awaited<ReturnType<typeof page>>, observed=false;
    p=await page(s,unread("item","area"),null,undefined,{clock,response:(_path,_body,init)=> { if (init.method && init.method !== "GET") { observed=kind === "explain" ? p.all().some(e=>e.className === "pendtag") : p.all().some(e=>e.className.includes("okbtn") && e.className.includes("on") && (e.textContent || e.innerHTML).includes("待发")); return hold.promise; } }});
    p.key("n"); await settle(); let click:Promise<void>|undefined;
    if (kind === "explain") p.key("e"); else click=button(p,kind === "approve" ? "同意" : "完成").click();
    try { assert.equal(observed,true,kind+" displays queued feedback before fetch"); }
    finally { hold.reject(new Error("Draft refused")); await click; await p.flush(); }
    assert.match(p.roots.get("server-banner")!.textContent,/Draft refused/);
    assert.ok(!p.all().some(e=>e.className === "pendtag"));
    if (kind !== "explain") assert.equal(button(p,kind === "approve" ? "同意" : "完成").disabled,false);
  });
});

test("SSE burst renders once per frame and fetches unread once", async () => {
  const frames=new Frames(), p=await page(snapshot(),[],null,undefined,{frames,notesOpen:{"it:area":true}}); const renders=p.renders.length, reads=p.calls.filter(c=>c.path === "/api/unread").length;
  for(let i=0;i<10;i++) p.emit(String(i).repeat(40),[{kind:"note",id:"burst",after:{target:"it:area",kind:"comment",text:"Burst "+i,at,state:"sent",rev:i+1}}]);
  assert.equal(p.renders.length,renders,"asynchronous events do not render before the frame");
  await p.flush(); assert.equal(p.renders.length-renders,1); assert.equal(p.calls.filter(c=>c.path === "/api/unread").length-reads,1);
  assert.match(markup(item(p,"area")),/Burst 9/);
});

test("note-only updates and unread baseline followups preserve unrelated card identity", async () => {
  const s=snapshot(), frames=new Frames(), hold=deferred<unknown>(); s.decisions.q=card(); s.decisions.other={...card(),question:"Other card"};
  const p=await page(s,unread("note","reply"),()=>hold.promise,undefined,{frames}); await expand(p); await p.flush();
  const other=p.all().find(e=>e.id === "q-other")!;
  const note:Note={target:"q:q",kind:"comment",text:"Question",reply:"New reply",at,state:"done",rev:1};
  p.emit("b".repeat(40),[{kind:"note",id:"reply",after:note}]); await p.flush();
  assert.equal(p.all().find(e=>e.id === "q-other"),other,"note change preserves other card");
  hold.resolve({before:null,after:note,diff:""}); await p.flush();
  assert.equal(p.all().find(e=>e.id === "q-other"),other,"unread and baseline refresh preserve other card");
  assert.ok(p.all().some(e=>e.id === "note-reply"));
});

test("single item prose update preserves sibling card and status priority update reorders and refreshes counts", async () => {
  const s=snapshot(), frames=new Frames(); s.items.sibling={...s.items.child!,title:"Sibling",priority:"P0"}; s.items.area!.deps.push({id:"sibling",why:"Needs sibling"}); s.decisions.other={...card(),item:"sibling"};
  const p=await page(s,[],null,undefined,{frames}); await expand(p,"sibling"); await p.flush();
  const other=p.all().find(e=>e.id === "q-other")!;
  p.emit("b".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,head:"Updated head",log:[{at,text:"Updated log"}]}}]); await p.flush();
  assert.equal(p.all().find(e=>e.id === "q-other"),other);
  p.emit("c".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,status:"done",priority:"P0"}},{kind:"item",id:"sibling",after:{...s.items.sibling!,priority:"P2"}}]); await p.flush();
  const ids=p.all().filter(e=>e.id === "it-child" || e.id === "it-sibling").map(e=>e.id);
  assert.deepEqual(ids,["it-child","it-sibling"]); assert.match(markup(item(p,"area")),/DONE 1/);
});

test("send waits for optimistic draft acknowledgement and refuses to send a failed draft", async t => {
  for(const failed of [false,true]) await t.test(failed ? "failure" : "acknowledgement",async()=> {
    const s=snapshot(), clock=new FakeClock(), hold=deferred<FakeResponse>(); s.decisions.q=card();
    const p=await page(s,[],null,undefined,{clock,response:(path,_body,init)=>init.method && init.method !== "GET" && path !== "/api/send" ? hold.promise : undefined}); await expand(p);
    const click=option(p,"A").click(), sending=p.roots.get("send-all")!.click(); await settle();
    assert.equal(p.calls.filter(c=>c.path === "/api/send").length,0,"visible pending draft must settle first");
    if(failed) hold.reject(new Error("Draft refused")); else hold.resolve(reply({note:{id:"persisted",doc:{target:"q:q",kind:"choice",choice:"A",text:"选 A",at,state:"draft",rev:1}},deleted:[],commit:"c".repeat(40)}));
    await click; await sending; await p.flush(); assert.equal(p.calls.filter(c=>c.path === "/api/send").length,failed ? 0 : 1);
  });
});

test("card jump stays pinned through baseline and unrelated SSE changes until owner scroll", async () => {
  const s=snapshot(), frames=new Frames(), hold=deferred<unknown>(); s.decisions.q=card(); let above=0, p!:Awaited<ReturnType<typeof page>>;
  p=await page(s,unread("decision","q"),()=>hold.promise,undefined,{frames,geometry:e=>({top: e.id === "q-q" ? 1800+above-(p?.scrollY ?? 0) : 600,height:e.id === "q-q" ? 400 : 2400})}); await expand(p); await p.flush();
  p.key("ArrowRight"); await p.flush(); const landed=p.all().find(e=>e.id === "q-q")!.getBoundingClientRect().top;
  above=400; hold.resolve({before:{...card(),background:"Removed\n\n"+card().background},after:card(),diff:""}); await p.flush();
  assert.equal(p.all().find(e=>e.id === "q-q")!.getBoundingClientRect().top,landed,"baseline cannot move landed target");
  above=800; p.emit("b".repeat(40),[{kind:"item",id:"area",after:{...s.items.area!,head:"Inserted above"}}]); await p.flush();
  assert.equal(p.all().find(e=>e.id === "q-q")!.getBoundingClientRect().top,landed,"SSE insertion cannot move landed target");
  p.user("wheel"); p.user("scroll"); const released=p.scrollY; above=1000; p.emit("c".repeat(40),[{kind:"item",id:"area",after:{...s.items.area!,head:"More above"}}]); await p.flush();
  assert.equal(p.scrollY,released,"owner scroll releases the pin");
});

test("explain withdrawal removes its pending badge before fetch and restores it on failure", async () => {
  const s=snapshot(), clock=new FakeClock(), hold=deferred<FakeResponse>(); s.notes.ex={target:"it:area",kind:"explain",text:"Explain",at,state:"draft",rev:1};
  let p!:Awaited<ReturnType<typeof page>>, observed=false;
  p=await page(s,unread("item","area"),null,undefined,{clock,response:(_path,_body,init)=> { if (init.method && init.method !== "GET") { observed=!p.all().some(e=>e.className === "pendtag"); return hold.promise; } }});
  p.key("n"); await p.flush(); p.key("e");
  try { assert.equal(observed,true,"withdrawal removes the actual header badge synchronously"); }
  finally { hold.reject(new Error("Withdrawal refused")); await p.flush(); }
  assert.ok(p.all().some(e=>e.className === "pendtag")); assert.match(p.roots.get("server-banner")!.textContent,/Withdrawal refused/);
});

test("draft acknowledgement survives an older owner snapshot fetch and newer SSE note revision wins", async () => {
  const s=snapshot(), hold=deferred<FakeResponse>(), frames=new Frames(); s.decisions.q=card(); let written=false, held=true;
  const p=await page(s,unread("item","area"),null,undefined,{frames,response:path=> { if(path === "/api/read") { written=true; return; } if(written && held && path === "/api/snapshot") return hold.promise; }});
  await expand(p); await button(p,"全部已阅").click(); await button(p,"确认").click();
  await option(p,"A").click(); await p.flush();
  held=false; hold.resolve(reply({...s,notes:{}})); await p.flush();
  assert.ok(option(p,"A").className.includes("sel"),"older snapshot cannot erase an acknowledged choice");
  const next=deferred<FakeResponse>();
  // The second race has a reply already delivered before the atomic response.
  const q=await page(s,[],null,undefined,{frames:new Frames(),response:path=>path === "/api/draft" ? next.promise : undefined}); await expand(q);
  const clicking=option(q,"B").click();
  q.emit("e".repeat(40),[{kind:"note",id:"persisted-draft",after:{target:"q:q",kind:"choice",choice:"B",text:"Latest",at,state:"sent",rev:3}}]); await q.flush();
  next.resolve(reply({note:{id:"persisted-draft",doc:{target:"q:q",kind:"choice",choice:"B",text:"Older",at,state:"draft",rev:2}},deleted:[],commit:"d".repeat(40)})); await clicking; await q.flush();
  assert.equal(option(q,"B").disabled,true,"newer sent note cannot become a draft again");
});

test("scoped note changes refresh ask controls card reference counts and the next-control chain", async () => {
  const s=snapshot(), frames=new Frames(); s.items.child!.ask={text:"Approve"}; s.decisions.q=card(); s.decisions.other={...card(),question:"Other"}; s.decisions.third={...card(),question:"Third"};
  const p=await page(s,[],null,undefined,{frames}); await expand(p);
  const other=p.all().find(e=>e.id === "q-other")!;
  p.emit("b".repeat(40),[{kind:"note",id:"answer",after:{target:"it:child",kind:"approve",text:"同意：Approve",at,state:"sent",rev:1}},{kind:"note",id:"comment",after:{target:"q:q",kind:"comment",text:"Comment",at,state:"sent",rev:1}}]); await p.flush();
  assert.ok(!p.all().some(e=>e.id === "ask-child"));
  const ref=p.all().find(e=>e.className.startsWith("ref q") && e.innerHTML.includes("如何显示"))!;
  assert.match(ref.innerHTML,/评论 1/); assert.ok(p.all().find(e=>e.id === "q-other") === other);
  const next=descendants(p.all().find(e=>e.id === "q-q")!).find(e=>e.className === "nextbtn")!;
  assert.equal(next.innerHTML,"下一条（2/3）");
  assert.equal(descendants(other).find(e=>e.className === "nextbtn")!.innerHTML,"下一条（3/3）","untouched peer footer follows changed waiting order"); await next.click(); assert.ok(p.all().find(e=>e.id === "q-other")!.className.includes("cur"));
});

test("card closure and a filtered item update preserve unrelated card identities", async () => {
  const s=snapshot(), frames=new Frames(); s.decisions.q=card(); s.decisions.other={...card(),question:"Other"};
  s.board.projects.push({name:"Elsewhere"}); s.items.far={...s.items.child!,title:"Far",parent:undefined,group:"Elsewhere"}; s.decisions.far={...card(),item:"far"};
  const p=await page(s,[],null,undefined,{frames}); await expand(p); await item(p,"far").children[0]!.children[0]!.click();
  const other=p.all().find(e=>e.id === "q-other")!, far=p.all().find(e=>e.id === "q-far")!; assert.ok(other && far);
  p.emit("b".repeat(40),[{kind:"decision",id:"q",after:{...card(),status:"cancelled"}}]); await p.flush();
  assert.ok(p.all().find(e=>e.id === "q-other") === other,"closing a card preserves its peer");
  await p.all().find(e=>e.tagName === "BUTTON" && e.innerHTML.startsWith("进行中 "))!.click();
  const farAfterFilter=p.all().find(e=>e.id === "q-far")!, sameProject=p.all().find(e=>e.id === "q-other")!;
  assert.ok(sameProject && farAfterFilter);
  p.emit("c".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,head:"Filtered prose update"}}]); await p.flush();
  assert.ok(p.all().find(e=>e.id === "q-far") === farAfterFilter,"filter in one project cannot rebuild another project");
  assert.ok(p.all().find(e=>e.id === "q-other") === sameProject,"filtered prose preserves same-project peer card");
  assert.ok(far);
});

test("frame fallback works without requestAnimationFrame and smooth jump follows changes during its glide", async t => {
  await t.test("no rAF",async()=> { const p=await page(snapshot(),[],null,undefined,{noFrames:true,clock:new FakeClock(),notesOpen:{"it:area":true}}); const count=p.renders.length; p.emit("b".repeat(40),[{kind:"note",id:"n",after:{target:"it:area",kind:"comment",text:"Fallback note",at,state:"sent",rev:1}}]); assert.equal(p.renders.length,count,"timer fallback also defers to its frame"); await p.flush(); assert.match(markup(item(p,"area")),/Fallback note/); });
  await t.test("smooth glide",async()=> {
    const s=snapshot(), frames=new Frames(), hold=deferred<unknown>(); s.decisions.q=card(); let p!:Awaited<ReturnType<typeof page>>, above=0;
    p=await page(s,unread("decision","q"),()=>hold.promise,undefined,{frames,reducedMotion:false,geometry:e=>({top:e.id === "q-q" ? 1800+above-(p?.scrollY ?? 0) : 600,height:e.id === "q-q" ? 400 : 2400})}); await expand(p);
    p.key("ArrowRight"); frames.flush(50); await settle(); assert.ok(p.scrollY>0 && p.scrollY<1477,"glide is still moving");
    above=500; hold.resolve({before:card(),after:card(),diff:""}); await p.flush();
    assert.equal(p.all().find(e=>e.id === "q-q")!.getBoundingClientRect().top,323,"glide retains its intended landing after insertion");
    for (const input of ["click","keydown","scroll"]) { p.key("ArrowRight"); await p.flush(); p.user(input); const position=p.scrollY; above+=200; p.emit("c".repeat(40),[{kind:"item",id:"area",after:{...s.items.area!,head:"Above "+above}}]); await p.flush(); assert.equal(p.scrollY,position,input+" releases pin"); }
  });
});

test("owner input cancels an unread jump still awaiting its baseline", async () => {
  const s=snapshot(), hold=deferred<unknown>(), frames=new Frames(), p=await page(s,unread(),()=>hold.promise,undefined,{frames});
  p.key("n"); await settle(); p.user("click"); hold.resolve(endpoints(s,new URLSearchParams("kind=item&doc=child"),null)); await p.flush();
  assert.equal(p.scrolls.length,0); assert.ok(!item(p).className.includes("cur"));
});

test("saving a comment preserves other card identity", async () => {
  const s=snapshot(), frames=new Frames(); s.decisions.q=card(); s.decisions.other={...card(),question:"Other"};
  const p=await page(s,[],null,undefined,{frames,response:path=>path === "/api/notes" ? reply({id:"saved-comment"}) : undefined}); await expand(p); p.key("ArrowRight"); p.key("c"); await p.flush();
  const other=p.all().find(e=>e.id === "q-other")!, editor=p.all().find(e=>e.id === "ed-q_q")!;
  editor.value="Comment"; await button(p,"保存").click(); await p.flush();
  assert.ok(p.all().find(e=>e.id === "q-other") === other,"successful note-only save cannot rebuild another card");
});

test("mixed SSE unread and baseline completions share one scoped frame", async () => {
  const s=snapshot(), frames=new Frames(), old=deferred<unknown>(), cardBefore=deferred<unknown>(), reads=deferred<FakeResponse>(); s.decisions.q=card(); let held=false;
  const initial=[...unread("item","area"),...unread("decision","q","e".repeat(40))];
  const p=await page(s,initial,(params:URLSearchParams)=>params.get("kind") === "decision" ? cardBefore.promise : old.promise,undefined,{frames,response:path=>held && path === "/api/unread" ? reads.promise : undefined}); await expand(p); await p.flush();
  held=true; p.emit("a".repeat(40)); await p.flush(); const count=p.renders.length;
  p.emit("b".repeat(40),[{kind:"note",id:"mixed",after:{target:"q:q",kind:"comment",text:"Mixed event",at,state:"sent",rev:1}}]);
  reads.resolve(reply({steps:initial})); old.resolve(endpoints(s,new URLSearchParams("kind=item&doc=area"),s.items.area)); cardBefore.resolve(endpoints(s,new URLSearchParams("kind=decision&doc=q"),s.decisions.q));
  await settle(); frames.flush(); await settle();
  assert.equal(p.renders.length-count,1,"all asynchronous dirty scopes unite at the frame");
});

test("identical draft ACK cannot restart unread fetch already begun after its SSE", async () => {
  const s=snapshot(), frames=new Frames(), ack=deferred<FakeResponse>(), unreadHold=deferred<FakeResponse>(); s.decisions.q=card(); let holdReads=false;
  const p=await page(s,[],null,undefined,{frames,response:path=>path === "/api/draft" ? ack.promise : path === "/api/unread" && holdReads ? unreadHold.promise : undefined}); await expand(p); const before=p.calls.filter(c=>c.path === "/api/unread").length;
  const click=option(p,"A").click(), doc:Note={target:"q:q",kind:"choice",choice:"A",text:"选 A",at,state:"draft",rev:1}; holdReads=true;
  p.emit("c".repeat(40),[{kind:"note",id:"choice",after:doc}]); await p.flush();
  ack.resolve(reply({note:{id:"choice",doc},deleted:[],commit:"c".repeat(40)})); await click; unreadHold.resolve(reply({steps:[]})); await p.flush();
  assert.equal(p.calls.filter(c=>c.path === "/api/unread").length-before,1); assert.ok(option(p,"A").className.includes("sel"));
});

test("card and item rule changes refresh dependency consumers and transitive priority", async () => {
  const s=snapshot(), frames=new Frames(); s.decisions.q={...card(),item:"area"};
  s.items.child!.status="blocked"; s.items.child!.deps=[{card:"q",why:"Needs ruling"}];
  s.items.blocker={...s.items.child!,title:"Blocker",status:"todo",priority:"P2",deps:[{id:"further",why:"Needs further"}]};
  s.items.further={...s.items.child!,title:"Further",status:"todo",priority:"P2",deps:[]};
  s.items.waiter={...s.items.child!,title:"Urgent waiter",status:"wip",priority:"P0",deps:[{id:"blocker",why:"Needs blocker"}]};
  s.items.area!.deps.push(...["blocker","further","waiter"].map(id=>({id,why:"Child"})));
  const p=await page(s,[],null,undefined,{frames}); await expand(p,"blocker"); await item(p,"further").children[0]!.children[0]!.click(); await item(p,"child").children[0]!.children[0]!.click();
  assert.match(markup(item(p,"further")),/P0/);
  p.emit("b".repeat(40),[{kind:"decision",id:"q",after:{...s.decisions.q!,status:"ruled",ruling:"A"}},{kind:"item",id:"waiter",after:{...s.items.waiter!,status:"done"}}]); await p.flush();
  assert.match(markup(item(p,"child")),/可解除阻塞/,"ruling updates the blocked waiter check");
  assert.ok(!descendants(item(p,"further")).some(e=>e.className.split(" ").includes("prio") && e.innerHTML === "P0"),"closing urgent waiter releases transitive priority");
  p.emit("c".repeat(40),[{kind:"item",id:"waiter",after:{...s.items.waiter!,deps:[]}}]); await p.flush();
  assert.ok(!markup(item(p,"blocker")).includes("Urgent waiter"),"removed dependency refreshes backlink row");
});

test("older SSE notes cannot overwrite an acknowledged draft or resurrect its deleted predecessor", async t => {
  for (const retained of [true,false]) await t.test(retained ? "retained revision" : "deleted ids including unknown predecessor",async () => {
    const s=snapshot(), frames=new Frames(); s.decisions.q=card(); const old:Note={target:"q:q",kind:"choice",choice:"B",text:"Old",at,state:"draft",rev:1}; s.notes.old=old;
    const doc:Note={...old,choice:"A",text:"New",rev:retained ? 2 : 1};
    const p=await page(s,[],null,undefined,{frames,response:path=>path === "/api/draft" ? reply({note:{id:retained ? "old" : "new",doc},deleted:retained ? [] : ["old","unknown"],commit:"c".repeat(40)}) : undefined}); await expand(p); await option(p,"A").click(); await p.flush();
    p.emit("b".repeat(40),[{kind:"note",id:"old",after:old},...retained ? [] : [{kind:"note",id:"unknown",after:old}]]); await p.flush();
    assert.ok(option(p,"A").className.includes("sel"),"older queued note cannot erase acknowledged selection");
    assert.equal(p.roots.get("send-all")!.textContent,"把 1 条发给 Claude","deleted old drafts cannot reappear");
  });
});

test("reply unarchives an item into its visible project tree", async () => {
  const s=snapshot(), frames=new Frames(); s.owner.archived.child="2026-10-12T00:00:00Z";
  const p=await page(s,[],null,undefined,{frames}); await expand(p,"area"); assert.ok(!p.all().some(e=>e.id === "it-child"));
  p.emit("b".repeat(40),[{kind:"note",id:"reply",after:{target:"it:child",kind:"comment",text:"Question",reply:"Answered",at,state:"done",repliedAt:"2026-10-13T00:00:00Z",rev:1}}]); await p.flush();
  assert.ok(p.all().some(e=>e.id === "it-child"),"reply restores previously archived subtree");
});

test("unread navigation waits for its scheduled frame before measuring", async () => {
  const s=snapshot(), frames=new Frames(), hold=deferred<unknown>();
  const p=await page(s,unread(),()=>hold.promise,undefined,{frames}); p.key("n"); await settle();
  hold.resolve(endpoints(s,new URLSearchParams("kind=item&doc=child"),null)); await settle();
  assert.equal(p.scrolls.length,0,"baseline completion cannot flush DOM and scroll outside its frame"); await p.flush(); assert.ok(p.scrolls.length>0);
});

test("card landing keeps the actual clamped viewport top across later renders", async () => {
  const s=snapshot(), frames=new Frames(); s.decisions.q=card(); let p!:Awaited<ReturnType<typeof page>>, above=0,height=10000;
  p=await page(s,[],null,undefined,{frames,scrollHeight:()=>height,geometry:e=>({top:e.id === "q-q" ? 9800+above-(p?.scrollY ?? 0) : 600,height:e.id === "q-q" ? 400 : 2400})}); await expand(p);
  p.key("ArrowRight"); await p.flush(); assert.equal(p.scrollY,9000); const top=p.all().find(e=>e.id === "q-q")!.getBoundingClientRect().top;
  height=11000; above=200; p.emit("b".repeat(40),[{kind:"item",id:"area",after:{...s.items.area!,head:"Inserted above"}}]); await p.flush();
  assert.equal(p.all().find(e=>e.id === "q-q")!.getBoundingClientRect().top,top,"clamped jump records where the target actually landed");
});

test("complete optimistic click coalesces acknowledgement SSE and unread rendering", async () => {
  const s=snapshot(), frames=new Frames(), ack=deferred<FakeResponse>(); s.decisions.q=card();
  const p=await page(s,[],null,undefined,{frames,response:path=>path === "/api/draft" ? ack.promise : undefined}); await expand(p); await p.flush();
  const before=p.renders.length, reads=p.calls.filter(c=>c.path === "/api/unread").length, click=option(p,"A").click();
  assert.equal(p.renders.length-before,0,"synchronous control patch is not a page render");
  const doc:Note={target:"q:q",kind:"choice",choice:"A",text:"选 A",at,state:"draft",rev:1};
  p.emit("c".repeat(40),[{kind:"note",id:"choice",after:doc}]); ack.resolve(reply({note:{id:"choice",doc},deleted:[],commit:"c".repeat(40)})); await click; await p.flush();
  assert.equal(p.renders.length-before,1,"acknowledgement and SSE settle in one scoped pass");
  assert.equal(p.calls.filter(c=>c.path === "/api/unread").length-reads,1); await p.flush(); assert.equal(p.renders.length-before,1,"later frames have no duplicate pass");
});

test("already expanded containers reveal folded notes and ruled cards when jumped to", async () => {
  const s=snapshot(), frames=new Frames(); s.notes.n={target:"it:child",kind:"comment",text:"Folded note",at,state:"sent",rev:1}; s.decisions.q={...card(),status:"ruled",ruling:"A"};
  const p=await page(s,unread("note","n"),null,undefined,{frames,notesOpen:{"it:child":false}}); await expand(p); await p.flush();
  assert.ok(!p.all().some(e=>e.id === "note-n")); p.key("n"); await p.flush(); assert.ok(p.all().some(e=>e.id === "note-n" && e.className.includes("cur")));
  assert.ok(!p.all().some(e=>e.id === "q-q")); const ref=p.all().find(e=>e.className.startsWith("ref q"))!; await ref.click(); await p.flush();
  assert.ok(p.all().some(e=>e.id === "q-q" && e.className.includes("cur")),"reference reveals ended card in already open body");
});

test("unarchiving a sibling retains unrelated card identity within its project", async () => {
  const s=snapshot(), frames=new Frames(); s.items.other={...s.items.child!,title:"Hidden sibling"}; s.items.area!.deps.push({id:"other",why:"Sibling"}); s.owner.archived.other="2026-10-12T00:00:00Z"; s.decisions.q=card();
  const p=await page(s,[],null,undefined,{frames}); await expand(p); const q=p.all().find(e=>e.id === "q-q")!;
  p.emit("b".repeat(40),[{kind:"note",id:"reply",after:{target:"it:other",kind:"comment",text:"Question",reply:"Answer",at,state:"done",repliedAt:"2026-10-13T00:00:00Z",rev:1}}]); await p.flush();
  assert.ok(p.all().some(e=>e.id === "it-other")); assert.ok(p.all().find(e=>e.id === "q-q") === q,"group membership refresh reuses unrelated sibling card");
});

test("draft deletion acknowledgement removes duplicates delivered after the click", async () => {
  const s=snapshot(), frames=new Frames(), ack=deferred<FakeResponse>(); s.decisions.q=card();
  const p=await page(s,[],null,undefined,{frames,response:path=>path === "/api/draft" ? ack.promise : undefined}); await expand(p); const click=option(p,"A").click();
  p.emit("b".repeat(40),[{kind:"note",id:"duplicate",after:{target:"q:q",kind:"choice",choice:"B",text:"Delayed duplicate",at,state:"draft",rev:1}}]); await p.flush();
  ack.resolve(reply({note:{id:"retained",doc:{target:"q:q",kind:"choice",choice:"A",text:"A",at,state:"draft",rev:1}},deleted:["duplicate"],commit:"c".repeat(40)})); await click; await p.flush();
  assert.equal(p.roots.get("send-all")!.textContent,"把 1 条发给 Claude"); assert.ok(option(p,"A").className.includes("sel"));
});

test("structural child changes reconcile membership while reusing sibling cards", async () => {
  const s=snapshot(), frames=new Frames(); s.decisions.q=card(); s.items.other={...s.items.child!,title:"Other parent",parent:undefined,group:"Project"};
  const p=await page(s,[],null,undefined,{frames}); await expand(p); await item(p,"other").children[0]!.children[0]!.click(); const q=p.all().find(e=>e.id === "q-q")!; assert.ok(q);
  const added={...s.items.child!,title:"Added child"};
  p.emit("b".repeat(40),[{kind:"item",id:"added",after:added}]); await p.flush(); assert.ok(p.all().some(e=>e.id === "it-added")); assert.ok(p.all().find(e=>e.id === "q-q") === q);
  p.emit("c".repeat(40),[{kind:"item",id:"added",after:{...added,parent:"other"}}]); await p.flush(); assert.ok(descendants(item(p,"other").parentElement!).some(e=>e.id === "it-added")); assert.ok(p.all().find(e=>e.id === "q-q") === q);
  p.emit("d".repeat(40),[{kind:"item",id:"added",after:null}]); await p.flush(); assert.ok(!p.all().some(e=>e.id === "it-added")); assert.ok(p.all().find(e=>e.id === "q-q") === q);
  p.emit("e".repeat(40),[{kind:"item",id:"other",after:{...s.items.other!,priority:"P0"}}]); await p.flush();
  assert.deepEqual(p.all().filter(e=>e.id === "it-area" || e.id === "it-other").map(e=>e.id),["it-area","it-other"],"root order follows area order rather than priority");
});

test("finishing an inbox request moves it into the normal project tree", async () => {
  const s=snapshot(), frames=new Frames(); s.items.request={...s.items.child!,parent:undefined,group:"Project",request:{by:"Elsewhere",at}}; s.items.request2={...s.items.request!,title:"Later request",priority:"P2",request:{by:"Elsewhere",at:"2026-10-12T00:00:00Z"}};
  const p=await page(s,[],null,undefined,{frames}); assert.ok(item(p,"request").closest(".inbox"));
  p.emit("a".repeat(40),[{kind:"item",id:"request2",after:{...s.items.request2!,priority:"P0"}}]); await p.flush();
  assert.deepEqual(p.all().filter(e=>e.id === "it-request" || e.id === "it-request2").map(e=>e.id),["it-request","it-request2"],"inbox remains ordered by request time");
  p.emit("b".repeat(40),[{kind:"item",id:"request",after:{...s.items.request!,status:"done"}}]); await p.flush();
  assert.ok(!item(p,"request").closest(".inbox"),"ended request leaves inbox without a request-object edit");
});
