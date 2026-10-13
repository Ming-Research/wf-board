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
  style: Record<string, string> & {setProperty(name:string,value:string):void} = {setProperty(name:string,value:string) { this[name]=value; }} as Element["style"]; dataset: Record<string, string> = {};
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
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  addEventListener(kind: string, fn: (event: unknown) => unknown) { this.handlers.set(kind, [...this.handlers.get(kind) ?? [], fn]); }
  captureClick?:(at:{clientX:number;clientY:number})=>boolean;
  // A click at a point; a document capture listener that stops propagation keeps it from the element, as in a browser.
  async click(at={clientX:0,clientY:0}) { if (this.captureClick?.(at) === false) return; let stopped=false; const event={ ...at, target:this, stopPropagation() { stopped=true; }, preventDefault() {} }; for (let e:Element|null=this;e;e=this.bubbleClick && !stopped ? e.parentElement : null) for (const fn of e.handlers.get("click") ?? []) await fn(event); }
  capturedPointer: number | null = null;
  setPointerCapture(id:number) { this.capturedPointer=id; }
  releasePointerCapture(id:number) { if (this.capturedPointer === id) this.capturedPointer=null; }
  async pointer(kind:string, at:{clientX:number;pointerId?:number;button?:number}) { for (const fn of this.handlers.get(kind) ?? []) await fn({target:this,pointerId:1,button:0,...at,preventDefault(){},stopPropagation(){}}); }
  scrollTop = 0; clientHeight = 1000; scrollHeight = 10000;
  scrollTo(_x: number | {top?:number}, y?: number) { this.scrollTop = Math.max(0, Math.min(this.scrollHeight-this.clientHeight, typeof _x === "object" ? _x.top ?? 0 : y ?? 0)); }
  scrollBy(_x: number, y: number) { this.scrollTo(0,this.scrollTop+y); }
  bubbleClick = false;
  selectionStart = 0; selectionEnd = 0;
  focus() { focused.current = this; } blur() { if (focused.current === this) focused.current = null; } scrollIntoView() {}
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  geometry?: () => {top:number;bottom:number;height:number;left:number;width:number};
  getBoundingClientRect() { return this.geometry?.() ?? { left: 0, width: 900, height: 100, top: 50, bottom: 150 }; }
  matches(selector: string):boolean { return selector.split(/,\s*/).some(s=> {
    const parts=s.trim().split(/\s+/), last=parts.pop()!;
    const own=last === "[data-sel]" ? this.dataset.sel !== undefined : last.startsWith(".") ? last.slice(1).split(".").every(c=>this.className.split(" ").includes(c)) : last.startsWith("#") ? this.id === last.slice(1) : /^[\w-]+(?:\.[\w-]+)*$/.test(last) && this.tagName === last.split(".")[0]!.toUpperCase() && last.split(".").slice(1).every(c=>this.className.split(" ").includes(c));
    return own && (!parts.length || !!this.parentElement?.closest(parts.join(" ")));
  }); }
  closest(selector: string): Element | null { return this.matches(selector.replace("#areas ", "")) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelector(selector: string):Element|null {
    // Follow each direct-child step, as focused-head lookup uses a two-step scoped selector.
    let candidates:Element[];
    if (selector.startsWith(":scope > ")) {
      candidates=[this];
      for (const part of selector.slice(9).split(/\s*>\s*/)) candidates=candidates.flatMap(e=>e.children).filter(e=>e.matches(part));
    } else candidates=this.children.flatMap(descendants).filter(e=>e.matches(selector));
    const match=candidates[0]; if(match) return match;
    if (selector === ".t") { const e = new Element("span"); e.className = "t"; return this.appendChild(e); } return null;
  }
  querySelectorAll(selector:string):Element[] { return this.children.flatMap(descendants).filter(e=>e.matches(selector)); }
  contains(e:Element):boolean { return e === this || this.children.some(c=>c.contains(e)); }
  get innerHTML() { return this.html; }
  set innerHTML(value: string) { this.html = value; this.children = []; }
  get firstChild(): Element | null { return this.children[0] ?? null; }
  get firstElementChild(): Element | null { return this.firstChild; }
}
let bundle: Promise<string> | undefined;
interface FakeResponse { ok:boolean; status:number; json: () => Promise<unknown> }
interface PageOptions {
  storageUnavailable?: boolean; storage?: Map<string,string>; detailGeometry?: (e:Element, all: () => Element[]) => {top:number;height:number};
  notesOpen?: Record<string,boolean>; geometry?: (e:Element, all: () => Element[]) => {top:number;height:number};
  transform?: (code:string) => string;
  frames?: Frames;
  reducedMotion?:boolean; noFrames?:boolean; scrollHeight?:()=>number; stalledFrames?:boolean; pointId?:string;
  clock?: FakeClock; autoOpen?: boolean; response?: (path:string,body:unknown,init:{method?:string;signal?:AbortSignal}) => FakeResponse | Promise<FakeResponse> | undefined;
}
async function page(snapshot: Snapshot, unread: unknown[], before: unknown = null, after?: unknown, options: PageOptions = {}) {
  const code = await (bundle ??= build({ entryPoints: ["web/app.ts"], bundle: true, format: "iife", globalName: "BoardPage", write: false, target: "es2022" }).then(result => result.outputFiles[0]!.text));
  const roots = new Map<string, Element>();
  for (const id of ["goal", "goal-title", "eyebrow", "meta", "summary", "nav", "areas", "cards", "decisions", "sendbox", "send-all", "send-note", "to-top", "server-banner", "hint", "item-detail", "split-divider", "page-left"]) { const e = new Element(id === "send-all" ? "button" : "div"); e.id = id; roots.set(id,e); }
  const detail=roots.get("item-detail")!, storage=options.storage ?? new Map<string,string>();
  detail.geometry=()=>({top:0,bottom:1000,height:1000,left:1000,width:900});
  // The left list pane scrolls the list; its scroll events arrive after the scroll, as a browser's do.
  const listPane=roots.get("page-left")!;
  listPane.geometry=()=>({top:0,bottom:1000,height:1000,left:0,width:900});
  Object.defineProperty(listPane,"scrollHeight",{get:()=>options.scrollHeight?.() ?? 10000});
  Object.defineProperty(detail,"scrollHeight",{get:()=>options.scrollHeight?.() ?? 10000});
  const listMax=()=>(options.scrollHeight?.() ?? 10000)-1000;
  const body = new Element("body"), wrap = new Element("div");
  const all = (): Element[] => { const out: Element[] = []; function walk(e: Element) { out.push(e); e.children.forEach(walk); } for (const e of [...roots.values(),body]) walk(e); return out; };
  const calls: Array<{path: string; body?: unknown}> = [];
  const measurements: Array<{id:string;top:number;height:number}> = [], scrolls: number[] = [], detailScrolls: number[] = [];
  const renders:unknown[]=[]; let scrollPosition=0, selected=false;
  const frame = options.frames?.request ?? ((fn:(now:number)=>void)=> { void setImmediate().then(()=>fn(performance.now())); return 1; });
  const windowListeners=new Map<string,Array<(event:unknown)=>unknown>>();
  const listeners = new Map<string,Array<{fn:(event:unknown)=>unknown;capture:boolean}>>();
  const dispatch=(kind:string,event:unknown,captureOnly=false)=> { for(const {fn,capture} of [...listeners.get(kind) ?? []].sort((a,b)=>Number(b.capture)-Number(a.capture))) if (!captureOnly || capture) fn(event); };
  const programmaticScroll=()=> { void Promise.resolve().then(()=> { for(const fn of windowListeners.get("scroll") ?? []) fn({isTrusted:true}); }); };
  const paneScrolled=()=> { void Promise.resolve().then(()=> { for(const fn of listPane.handlers.get("scroll") ?? []) fn({isTrusted:true}); }); };
  listPane.scrollTo=(_x:number | {top?:number},y?:number)=> { const to=typeof _x === "object" ? _x.top ?? 0 : y ?? 0; scrolls.push(to); listPane.scrollTop=Math.max(0,Math.min(listMax(),to)); paneScrolled(); };
  detail.scrollTo=(_x:number | {top?:number},y?:number)=> { const to=typeof _x === "object" ? _x.top ?? 0 : y ?? 0; detailScrolls.push(to); detail.scrollTop=Math.max(0,Math.min(detail.scrollHeight-detail.clientHeight,to)); };
  const document = {
    body, get activeElement() { return focused.current; }, documentElement: { get scrollHeight() { return options.scrollHeight?.() ?? 10000; } },
    getElementById: (id: string) => all().find(e => e.id === id) ?? null,
    createTextNode: (text:string) => { const e=new Element("#text"); e.textContent=text; return e; },
    createElement: (tag: string) => {
      const e = new Element(tag);
      e.bubbleClick=true;
      e.captureClick=at=> { let go=true; dispatch("click",{isTrusted:true,target:e,...at,stopPropagation() { go=false; },preventDefault() {}},true); return go; };
      e.geometry = () => { const inDetail=detail.contains(e), r=inDetail ? options.detailGeometry?.(e,all) ?? {top:50,height:100} : options.geometry?.(e,all) ?? {top:50,height:100}; const top=r.top-(inDetail ? detail.scrollTop : 0); measurements.push({id:e.id,top,height:r.height}); return {top,height:r.height,bottom:top+r.height,left:inDetail ? 1000 : 0,width:900}; };
      return e;
    },
    querySelector: (selector: string) => selector === ".wrap" ? wrap : all().find(e => selector === '[data-sel="' + e.dataset.sel + '"]') ?? null,
    querySelectorAll: (selector:string) => all().filter(e=>e.matches(selector)), elementFromPoint: () => options.pointId ? all().find(e=>e.id === options.pointId) ?? null : null,
    addEventListener: (kind: string, fn: (event: unknown) => unknown,opts?:boolean | {capture?:boolean}) => listeners.set(kind,[...listeners.get(kind) ?? [],{fn,capture:typeof opts === "boolean" ? opts : !!opts?.capture}]),
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
    getSelection: () => ({ isCollapsed: !selected }),
    document, HTMLElement: Element, EventSource, AbortController, console, CSS: { escape: (s: string) => s },
    innerHeight: 1000, get scrollY() { return scrollPosition; }, localStorage: { getItem: (key:string) => { if(options.storageUnavailable) throw new Error("Unavailable storage"); return storage.get(key) ?? (key === "board-notes" && options.notesOpen ? JSON.stringify(options.notesOpen) : null); }, setItem(key:string,value:string) { if(options.storageUnavailable) throw new Error("Unavailable storage"); storage.set(key,value); } },
    matchMedia: (query:string) => ({matches:query.includes("prefers-reduced-motion") && options.reducedMotion !== false}),
    recordRender:(scope:unknown)=>renders.push(scope),
    performance:{now:()=>options.stalledFrames ? options.clock!.now : options.frames?.now ?? performance.now()}, setTimeout: options.clock?.setTimeout ?? setTimeout, clearTimeout: options.clock?.clearTimeout ?? clearTimeout, ...options.noFrames ? {} : {requestAnimationFrame:frame,cancelAnimationFrame:(_id:number)=>{}},
    addEventListener:(kind:string,fn:(event:unknown)=>unknown)=>windowListeners.set(kind,[...windowListeners.get(kind) ?? [],fn]),
    window: { innerWidth: 1200, get scrollY() { return scrollPosition; }, addEventListener:(kind:string,fn:(event:unknown)=>unknown)=>windowListeners.set(kind,[...windowListeners.get(kind) ?? [],fn]), scrollBy(_x:number,y:number) { scrollPosition=Math.max(0,Math.min((options.scrollHeight?.() ?? 10000)-1000,scrollPosition+y)); programmaticScroll(); }, scrollTo(_x:number,y:number) { scrolls.push(y); scrollPosition=Math.max(0,Math.min((options.scrollHeight?.() ?? 10000)-1000,y)); programmaticScroll(); } },
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
      else if (path === "/api/read") {
        const {doc,through} = input as {doc?:string;through:string};
        const stop = unread.findIndex(s => (s as {id:string}).id === through);
        if (doc) unread = unread.flatMap((value,k) => {
          const step=value as {id:string;docs:Array<{kind:string;id:string}>};
          const docs=k <= stop ? step.docs.filter(d => d.kind+":"+d.id !== doc) : step.docs;
          return docs.length ? [{...step,docs}] : [];
        });
        else unread = through === "all" ? [] : unread.slice(stop + 1);
        value = { ok: true };
      }
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
  const flush=async()=> { for (let i=0;i<4;i++) { if (!options.stalledFrames) options.frames?.flush(); else options.clock!.advance(100); if (options.noFrames) options.clock?.advance(0); if (options.noFrames) await new Promise(resolve=>setTimeout(resolve,0)); await setImmediate(); } };
  await flush();
  // A live update from the server, as the page's event stream delivers it.
  const emit=(commit:string,changed:unknown[]=[])=>sources.at(-1)!.handlers.get("change")!({ data: JSON.stringify({commit,changed}) });
  const change = async (commit: string,changed:unknown[]=[]) => { emit(commit,changed); await setImmediate(); };
  return { roots, all, calls, document, wrap, change, emit, measurements, scrolls, detailScrolls, sources, renders,flush, storage,
    // Every scroll either pane was asked to make.
    get scrollCount() { return scrolls.length + detailScrolls.length; },
    // Where the list is scrolled: the left pane. `windowScrollY` is the window, which the page never scrolls.
    get scrollY() { return listPane.scrollTop; },
    get windowScrollY() { return scrollPosition; },
    user:(kind:string)=> { if (kind === "scroll") listPane.scrollTop+=100; dispatch(kind,{isTrusted:true,target:new Element("div")}); for(const fn of windowListeners.get(kind) ?? []) fn({isTrusted:true,target:new Element("div")}); },
    key: (key: string,target:Element=new Element("div")) => { let prevented=false, stopped=false; const ev={key,isTrusted:true,target,preventDefault(){prevented=true;},stopPropagation(){stopped=true;}}; for (const fn of target?.handlers.get("keydown") ?? []) fn(ev); if (!stopped) dispatch("keydown",ev); return prevented; },
    // The reader presses the mouse at a point, leaving text selected or not when the button is released.
    press: (clientX:number,clientY:number,select:boolean) => { selected=select; dispatch("mousedown",{isTrusted:true,target:new Element("div"),clientX,clientY}); } };
}
const at = "2026-10-11T01:02:03Z";
function snapshot(): Snapshot {
  return { board: { title: "Synthetic title", projects: [{name:"Project",migrated:true}], eyebrow: "Synthetic eyebrow" }, head: "a".repeat(40), owner: { archived: {} }, decisions: {}, notes: {}, notices: {}, glossaries: {}, items: {
    area: { title: "Parent", group: "Project", priority: "P1", updated: at, rev: 1, deps: [{id:"child",why:"needs child"}], links: [], log: [] },
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
// The page always shows the selected item's body in the detail column. expand unfolds the parent "area" and selects the
// item, so its body, cards and comments are on the page.
async function expand(p: Awaited<ReturnType<typeof page>>, id = "child") {
  const caret = rowOf(p, "area").querySelector(".caret")!;
  if (caret.attributes["aria-expanded"] !== "true" && !caret.disabled) await caret.click();
  await rowOf(p, id).querySelector(".item-head")!.click();
  await setImmediate(); await setImmediate();
}
// An item's tree row, and the item as the reader sees it: its detail box when it is the selected item, else its row.
function rowOf(p: Awaited<ReturnType<typeof page>>, id = "child") { return p.all().find(e => e.id === "it-" + id)!; }
function item(p: Awaited<ReturnType<typeof page>>, id = "child") { return p.all().find(e => e.id === "detail-it-" + id) ?? rowOf(p, id); }

test("detail: added paragraph renders rich text without any unread box", async () => {
  const s = snapshot(), before = {...s.items.child!,head:"Unchanged"};
  s.items.child!.head = "Unchanged\n\n**Added** paragraph";
  const p = await page(s,unread(),before); await expand(p);
  assert.match(markup(item(p)), /class="chg-add"[^>]*><p><strong>Added<\/strong> paragraph<\/p>/);
  p.key("n"); await setImmediate();
  assert.ok(!p.all().some(e => e.className.includes("unread-step")));
  assert.ok(!markup(item(p)).includes("次提交"));
});

test("detail: removed paragraph is not shown and unchanged paragraphs carry no marks", async () => {
  const s = snapshot(), before = {...s.items.child!,head:"First\n\n- **Removed** paragraph\n\nLast"};
  s.items.child!.head = "First\n\nLast";
  const p = await page(s,unread(),before); await expand(p);
  const body = markup(item(p));
  assert.match(body, /<p>First<\/p>.*<p>Last<\/p>/s);
  assert.ok(!body.includes("Removed") && !body.includes("chg-del"),"a removed head block is not rendered");
  assert.ok(!/class="chg-add"[^>]*><p>(First|Last)<\/p>/.test(body));
});

test("detail: existing fenced code keeps blank lines and contiguous lists and tables remain rich blocks", async () => {
  const s = snapshot(), before = {...s.items.child!,head:"```\nold\n\ncode\n```\n\n- Keep\n- Old list\n\n| Header |\n| --- |\n| Old row |"};
  s.items.child!.head = "```\nnew\n\ncode\n```\n\n- Keep\n- New list\n\n| Header |\n| --- |\n| New row |";
  const p = await page(s,unread(),before); await expand(p);
  const body = markup(item(p));
  assert.ok(!body.includes("old\n\ncode") && !body.includes("Old list") && !body.includes("Old row"),"replaced blocks show only their current form");
  assert.match(body, /class="chg-add"[^>]*><pre class="code"><code>new\n\ncode<\/code><\/pre>/);
  assert.match(body, /class="chg-add"[^>]*><ul><li>Keep<\/li><li>New list<\/li><\/ul>/);
  assert.match(body, /class="chg-add"[^>]*><div class="tablewrap"><table><thead><tr><th>Header<\/th>.*<td>New row<\/td>/s);
});

test("detail: changed title marks the new title and shows no former title", async () => {
  const s = snapshot(), before = {...s.items.child!,title:"Old title"}; s.items.child!.title = "New title";
  const p = await page(s,unread(),before); await expand(p);
  const head = descendants(item(p)).find(e => e.className === "item-head")!;
  const title = head.children.find(e => e.className.includes("item-title"))!;
  assert.ok(title.className.includes("chg-add")); assert.equal(title.innerHTML,"New title");
  assert.ok(!markup(head).includes("Old title") && !head.children.some(e => e.tagName === "SMALL" || e.className.includes("title-was")),"the former title is not rendered");
});

test("detail: removed dependency and link are not shown while changed priority status and ask are marked", async () => {
  const s = snapshot(), before = {...s.items.child!,status:"todo",priority:"P2",ask:{text:"Old ask"},deps:[{id:"area",why:"Old reason"}],links:[{label:"Old link",url:"https://example.com/old"}]};
  s.items.child!.ask = {text:"New ask"};
  const p = await page(s,unread(),before); await expand(p);
  const all = descendants(item(p));
  assert.ok(!markup(item(p)).includes("Old reason"),"a removed dependency row is not rendered");
  assert.ok(!all.some(e => e.tagName === "A" && e.innerHTML === "Old link"),"a removed link is not rendered");
  assert.ok(!markup(item(p)).includes("Old ask") && !markup(item(p)).includes("chg-del"),"the former ask is not rendered");
  assert.ok(all.some(e => e.className.includes("prio") && e.className.includes("chg-add") && e.innerHTML === "P1"));
  assert.ok(all.some(e => e.className.includes("st ") && e.className.includes("chg-add") && e.innerHTML === "WIP"));
  assert.ok(all.some(e => e.className.includes("ask") && e.className.includes("chg-add") && markup(e).includes("New ask")));
});

test("detail: removed link is not shown and an added non-HTTPS link has no active href", async () => {
  const s = snapshot(), before = {...s.items.child!,links:[{label:"Removed HTTP link",url:"http://example.com/old"}]};
  s.items.child!.links = [{label:"Added HTTP link",url:"http://example.com/new"}];
  const p = await page(s,unread(),before); await expand(p);
  assert.ok(!descendants(item(p)).some(e => e.innerHTML === "Removed HTTP link"),"a removed link is not rendered");
  const row = descendants(item(p)).find(e => e.tagName === "A" && e.innerHTML === "Added HTTP link");
  assert.ok(row,"an added valid non-HTTPS link is visible");
  assert.ok(row.className.includes("chg-add"));
  assert.ok(!Object.hasOwn(row,"href"),"non-HTTPS links must not receive an active href");
});

test("detail: cleared ask is not shown as removed text", async () => {
  const s = snapshot(), before = {...s.items.child!,ask:{text:"Cleared ask"}}; delete s.items.child!.ask;
  const p = await page(s,unread(),before); await expand(p);
  assert.ok(!markup(item(p)).includes("Cleared ask") && !markup(item(p)).includes("chg-del"));
});

test("expanded unread marks disappear when r reads the selected item without an n walk", async () => {
  const s = snapshot(), before = {...s.items.child!,head:"Old body"}; s.items.child!.head = "New body";
  const p = await page(s,unread(),before); await expand(p);
  assert.match(markup(item(p)), /chg-add/);
  p.key("r"); await p.flush();
  assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{doc:"item:child",through:stepId}]);
  assert.ok(!markup(item(p)).includes("chg-add") && !markup(item(p)).includes("Old body"));
});

test("detail: baseline is first unread before and after is current snapshot rather than an intermediate step", async () => {
  const s = snapshot(), first = "b".repeat(40), last = "c".repeat(40);
  s.items.child!.head = "Original\n\nCurrent";
  const p = await page(s,[...unread("item","child",first),...unread("item","child",last)],(params: URLSearchParams) => ({before:{...s.items.child!,head:params.get("id") === first ? "Original" : "Original\n\nIntermediate"},after:{...s.items.child!,head:"Original\n\nIntermediate"},diff:""}));
  await expand(p);
  assert.match(markup(item(p)), /class="chg-add"[^>]*><p>Current<\/p>/);
  assert.ok(!markup(item(p)).includes("Intermediate"));
  p.key("n"); await setImmediate(); p.key("r"); await p.flush();
  assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{doc:"item:child",through:last}]);
  assert.ok(!p.all().some(e => e.innerHTML === "新 1 ›"));
  assert.ok(!markup(item(p)).includes("chg-add") && !markup(item(p)).includes("Intermediate"));
});

test("detail: new item marks only its title and keeps rich head and duplicate new log markings", async () => {
  const s = snapshot(); s.items.child!.head = "**Goal**：Body\n\n- List\n\n```\n<unsafe>\n\ncode\n```";
  s.items.child!.log = [{at,text:"same"},{at,text:"same"}];
  const p = await page(s,unread(),null); await expand(p);
  assert.ok(descendants(item(p)).some(e => e.className.includes("item-title") && e.className.includes("chg-add")));
  assert.ok(!markup(item(p)).includes('class="chg-add"'));
  assert.match(markup(item(p)), /<pre class="code"><code>&lt;unsafe&gt;\n\ncode<\/code><\/pre>/);
  assert.equal(descendants(item(p)).filter(e => e.className.includes("log-entry") && e.className.includes("fresh")).length,2);
});

test("detail: card marks current question background option and ruling and shows no removed option or former question", async () => {
  const s = snapshot(), before = card();
  s.decisions.q = {...before,question:"Current question",background:"Old background\n\nNew background",status:"ruled",choice:"B",ruling:"**Current** ruling",options:[{key:"B",text:"New option",recommended:true}]};
  const p = await page(s,unread("decision","q"),{...before,background:"Old background"},{...before,ruling:"Intermediate ruling"}); await expand(p);
  const c = p.all().find(e => e.id === "q-q")!, all = descendants(c);
  assert.ok(all.some(e => e.className.includes("chg-add") && e.innerHTML === "Current question"));
  assert.ok(!markup(c).includes(before.question),"the former question is not rendered");
  assert.match(markup(c), /class="chg-add"[^>]*><p>New background<\/p>/);
  assert.match(markup(c), /class="chg-add"[^>]*><p><strong>Current<\/strong> ruling<\/p>/);
  assert.match(markup(c), /class="chg-add"[^>]*><p>New option<\/p>/);
  assert.ok(!all.some(e => e.className.includes("optbtn") && markup(e).includes("保留 YAML")),"a removed option is not rendered");
  assert.ok(!markup(c).includes("Intermediate ruling"));
});

test("detail: new card marks its title only and retains unscored confidence", async () => {
  const s = snapshot(); s.decisions.q = {...card(),confidence:{reason:"Unscored evidence"}};
  const p = await page(s,unread("decision","q"),null); await expand(p);
  const c = p.all().find(e => e.id === "q-q")!;
  assert.ok(descendants(c).some(e => e.className.includes("chg-add") && e.innerHTML === card().question));
  assert.ok(!markup(c).includes('class="chg-add"') && !markup(c).includes("undefined/5"));
  assert.match(markup(c), /Unscored evidence/);
});

test("detail: note stops select the existing fresh reply row without duplicated thread", async () => {
  const s = snapshot(), before: Note = {target:"it:child",kind:"comment",text:"Owner question",at,state:"sent",rev:1};
  s.notes.n = {...before,state:"done",reply:"**Reply**：Answer",repliedAt:at};
  const p = await page(s,unread("note","n"),before); p.key("n"); await p.flush();
  const row = p.all().find(e => e.id === "note-n")!;
  assert.ok(row.className.includes("cur") && !row.className.includes("newbar") && row.children.some(e => e.className.includes("reply") && e.className.includes("newbar")));
  assert.equal(p.all().filter(e => e.className.startsWith("note ")).length,1);
  p.key("r"); await setImmediate(); await setImmediate();
  assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{doc:"note:n",through:stepId}]);
  assert.ok(!descendants(p.all().find(e => e.id === "note-n")!).some(e => e.className.includes("newbar")));
});

test("detail: deleted document stops render no body but remain countable walkable and readable", async () => {
  for (const kind of ["item","decision"] as const) {
    const s = snapshot(); delete s.items.child; s.items.area!.deps = [];
    const p = await page(s,unread(kind,"gone"),kind === "item" ? {...snapshot().items.child!,head:"Deleted body"} : card(),null);
    assert.ok(p.all().some(e => e.innerHTML === "新 1 ›"));
    p.key("n"); await setImmediate();
    assert.ok(!markup(p.roots.get("areas")!).includes("Deleted body") && !p.all().some(e => e.className.includes("unread-step")));
    p.key("r"); await setImmediate();
    assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{doc:kind+":gone",through:stepId}]);
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
  assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{doc:"item:area",through:stepId}]);
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

test("a drag that leaves text selected in a row neither folds nor follows it; a click still does", async () => {
  const s = snapshot(); s.items.area!.deps.push({ id: "far", why: "needs far" });
  s.items.far = { title: "Far area", group: "Other project", status: "todo", priority: "P2", updated: at, rev: 1, deps: [], links: [], log: [] };
  const p = await page(s, []);
  const head = () => rowOf(p, "area").querySelector(".caret")!, open = () => p.all().some(e => e.id === "it-child");
  const before = open();
  p.press(10, 10, true); await head().click({ clientX: 120, clientY: 12 }); await p.flush();
  assert.equal(open(), before, "a drag ending in a selection leaves the item as it was");
  p.press(10, 10, false); await head().click({ clientX: 120, clientY: 12 }); await p.flush();
  assert.notEqual(open(), before, "a moved press that selects nothing is a click");
  p.press(10, 10, true); await head().click({ clientX: 10, clientY: 10 }); await p.flush();
  assert.equal(open(), before, "a click in place toggles even while text elsewhere stays selected");
  p.press(0, 0, false); await rowOf(p, "area").querySelector(".item-head")!.click(); await p.flush();
  const far = descendants(item(p, "area")).find(e => e.className.startsWith("deprow") && e.innerHTML.includes("Far area"))!;
  const scrolled = p.scrollCount;
  p.press(10, 10, true); await far.click({ clientX: 200, clientY: 10 }); await p.flush();
  assert.equal(p.scrollCount, scrolled, "a drag over a dependency row does not follow it");
  p.press(10, 10, false); await far.click({ clientX: 10, clientY: 10 }); await p.flush();
  assert.ok(p.scrollCount > scrolled, "a click on a dependency row follows it");
});

test("R9 owner controls follow shared ask/card predicates through draft and sent answers", async () => {
  for (const state of ["draft", "sent", "done"] as const) {
    const s = snapshot(); s.items.child!.ask = { text: "Approve work" }; s.decisions.q = card();
    s.notes.a = { target: "it:child", kind: "approve", text: "同意：Approve work", at, state, rev: 1 };
    s.notes.c = { target: "q:q", kind: "choice", choice: "B", text: "B", at, state, rev: 1 };
    const p = await page(s, []), r = rules(s);
    await expand(p);
    // The waiting badge and approval action are rendered from the predicates.
    assert.equal(p.all().some(e => e.className === "asktag" && e.innerHTML === "决策卡"), r.cardWaiting("q") && !r.cardBlocking("q"));
    assert.equal(p.all().some(e => e.id === "ask-child"), r.askPending("child"));
  }
});

test("n reaches items in page order, skips archived ones, and r reads the selected item but not its sub-items", async () => {
  const s = snapshot(), id = "e".repeat(40);
  s.items.other = {title:"Archived",parent:"area",status:"done",priority:"P2",updated:at,rev:1,deps:[],links:[],log:[]};
  s.items.area!.deps.push({id:"other",why:"needs other"}); s.owner.archived = {other:at};
  const p = await page(s,[{id,commits:[id],author:"Session A",at,docs:[{kind:"item",id:"child",summary:"status todo→wip"},{kind:"item",id:"other",summary:"status wip→done"},{kind:"item",id:"area",summary:"+1 log"}]}]);
  await wideCaret(p).click(); await p.flush();
  p.key("r"); assert.ok(!p.calls.some(c => c.path === "/api/read"));
  // The page shows the parent above its child, so n reaches the parent first although the step lists the child first.
  p.key("n"); await p.flush(); assert.ok(item(p,"area").className.includes("cur"));
  assert.ok(!item(p).className.includes("cur"));
  assert.ok(!p.calls.some(c => c.path === "/api/read"));
  p.key("r"); await p.flush(); assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{doc:"item:area",through:id}]);
  assert.ok(item(p).className.includes("fresh"),"the sub-item stays unread");
  const areaChip=descendants(item(p,"area").querySelector(".item-head")!).filter(e=>e.className === "newtag freshchip");
  assert.deepEqual(areaChip.map(e=>e.innerHTML),["1"],"the parent's one chip now counts only the sub-item");
  assert.match(areaChip[0]!.title,/本身没有新内容，下面的子条目有 1 条/);
  assert.ok(!item(p,"area").className.includes("fresh"),"its line leaves: nothing of its own is new, only the sub-item it counts");
  p.key("r"); assert.match(p.roots.get("hint")!.textContent,/这一条本身没有新内容；新的 1 条在下面的子条目里/,"r says where the new content is");
  p.key("n"); await p.flush(); assert.ok(item(p).className.includes("cur"),"after r, n goes on to the next stop on the page");
});

test("inside a changed item n visits each new place in turn before the next item; a new item is one stop at its start", async () => {
  // Elements of the detail column sit at fixed positions, one row apart in document order; the pane moves over them.
  const geometry = (e:Element, all:() => Element[]) => {
    const y = e.className.split(" ").includes("item") ? 600 : 600 + all().indexOf(e) * 40;
    return {top:y, height:e.className.split(" ").includes("item") ? 6000 : 20};
  };
  const s = snapshot();
  s.items.child!.log = [{at, by:"Session A", text:"First new entry"}, {at:"2026-10-11T02:00:00Z", by:"Session A", text:"Second new entry"}];
  const p = await page(s, unread("item","child"), {...s.items.child!, status:"todo", log:[]}, undefined, {detailGeometry:geometry});
  const before = p.detailScrolls.length;
  p.key("n"); await p.flush(); p.key("n"); await p.flush(); p.key("n"); await p.flush(); p.key("n"); await p.flush();
  const visits = p.detailScrolls.slice(before);
  assert.ok(item(p).className.includes("cur"), "n stays inside the changed item");
  assert.equal(visits.length, 4);
  assert.ok(visits[0]! < visits[1]! && visits[1]! < visits[2]!, "a changed status and two new log entries, down the page: " + visits.join(", "));
  assert.equal(visits[3], visits[0], "after its last place, n goes on to the next stop, here the same item again");
  const created = await page(snapshot(), unread("item","child"), null, undefined, {detailGeometry:geometry});
  const start = created.detailScrolls.length;
  created.key("n"); await created.flush(); created.key("n"); await created.flush();
  assert.equal(new Set(created.detailScrolls.slice(start)).size, 1, "a new item is one stop, at its start: " + created.detailScrolls.slice(start).join(", "));
});


test("n walks the page from top to bottom, one stop per changed document, and goes on from a read item", async () => {
  const s = snapshot(), [a,b,c] = ["a","b","c"].map(x => x.repeat(40)) as [string,string,string];
  s.items.plain = {title:"Plain",group:"Project",status:"todo",priority:"P2",updated:at,rev:1,deps:[],links:[],log:[]};
  const doc = (id:string) => ({kind:"item" as const,id,summary:"+1 log",pieces:{log:1,reply:0,other:0}});
  // Commit order is plain, child, area, area again; the page order is area, its child, then plain.
  const p = await page(s,[{id:a,commits:[a],author:"Session A",at,docs:[doc("plain"),doc("child")]},{id:b,commits:[b],author:"Session B",at,docs:[doc("area")]},{id:c,commits:[c],author:"Session A",at,docs:[doc("area")]}]);
  await wideCaret(p).click(); await p.flush();
  const cur = () => ["area","child","plain"].filter(id => item(p,id).className.split(" ").includes("cur"));
  assert.ok(p.all().some(e => e.tagName === "BUTTON" && e.innerHTML === "新 3 ›"),"three items have something new");
  p.key("n"); await p.flush(); assert.deepEqual(cur(),["area"]);
  assert.ok(descendants(item(p,"area").children[0]!).some(e => e.className === "newtag freshchip" && e.innerHTML === "2"),"area counts itself and its child once each");
  p.key("n"); await p.flush(); assert.deepEqual(cur(),["child"],"area's second change is not a second stop");
  p.key("r"); await p.flush(); assert.deepEqual(p.calls.filter(x => x.path === "/api/read").map(x => x.body),[{doc:"item:child",through:a}]);
  p.key("n"); await p.flush(); assert.deepEqual(cur(),["plain"],"after r, n continues below the read stop instead of starting over");
});

test("a dependency row names its project only when the project differs from the depending item's", async () => {
  const s = snapshot();
  s.items.sib = { title: "Sibling", parent: "area", status: "todo", priority: "P2", updated: at, rev: 1, deps: [], links: [], log: [] };
  s.items.area!.deps.push({ id: "sib", why: "needs sibling" });
  s.items.far = { title: "Far area", group: "Other project", status: "todo", priority: "P2", updated: at, rev: 1, deps: [], links: [], log: [] };
  s.items.child!.deps = [{ id: "sib", why: "same area" }, { id: "far", why: "other area" }];
  const p = await page(s, []);
  await expand(p);
  const rows = descendants(item(p)).filter(e => e.className.startsWith("deprow"));
  const same = rows.find(e => e.innerHTML.includes("Sibling"))!, far = rows.find(e => e.innerHTML.includes("Far area"))!;
  assert.ok(same && far);
  assert.ok(!same.innerHTML.includes('class="where"'), "a same-project dependency carries no label");
  assert.match(far.innerHTML, /<span class="where">Other project<\/span>/);
});

test("a project lists its own roots first, then a rule and the roots other projects depend on", async () => {
  const s=snapshot(); s.board.projects.push({name:"Other",migrated:true});
  s.items.own={title:"Own root",group:"Project",priority:"P1",updated:at,rev:1,deps:[],links:[],log:[]};
  s.items.needed={title:"Needed root",group:"Project",priority:"P1",updated:at,rev:1,deps:[],links:[],log:[]};
  s.items.user={title:"Other root",group:"Other",priority:"P0",updated:at,rev:1,deps:[{id:"needed",why:"uses it"}],links:[],log:[]};
  s.items.alone={title:"Other own",group:"Other",priority:"P2",updated:at,rev:1,deps:[],links:[],log:[]};
  const p=await page(s,[]);
  const section=(g:string) => p.all().find(e=>e.className==="group" && e.dataset.group===g)!;
  const tops=(g:string) => descendants(section(g)).filter(e=>e.id.startsWith("it-") || e.className==="shared-sep").map(e=>e.className==="shared-sep" ? "|" : e.id.slice(3));
  const projectTops=tops("Project").filter(k=>["area","own","needed","|"].includes(k));
  assert.deepEqual(projectTops,["area","own","|","needed"],"own roots, then the rule, then the root another project depends on");
  const rule=descendants(section("Project")).filter(e=>e.className==="shared-sep");
  assert.equal(rule.length,1); assert.equal(rule[0]!.innerHTML,"被其他项目依赖");
  assert.equal(descendants(section("Other")).filter(e=>e.className==="shared-sep").length,0,"a project with none shows no rule");
});

test("project page omits session assignments and shows inbox requests, including empty projects", async () => {
  const s=snapshot(); s.board.projects.push({name:"Empty"});
  s.items.incoming={title:"Request title",group:"Project",ask:{text:"Approve request"},request:{by:"Visitor",at},status:"todo",priority:"P0",head:"Request body",updated:at,rev:1,log:[{at,by:"Visitor",text:"Visitor 提出：Need feature"}],deps:[],links:[]};
  const p=await page(s,[]), headings=p.all().filter(e=>e.className==="group-head");
  assert.equal(headings.length,2); assert.ok(headings.every(h => !markup(h).includes("负责：")));
  assert.ok(p.all().some(e=>e.innerHTML==="阻塞 1 ›"));
  const inbox=p.all().find(e=>e.className==="inbox"); assert.ok(inbox);
  assert.match(markup(inbox),/收件箱 1/); assert.match(markup(inbox),/Request title/);
  const tree=p.all().find(e=>e.id==="it-incoming"); assert.ok(tree); assert.ok(descendants(inbox).includes(tree));
  await descendants(tree).find(e=>e.className==="item-head")!.click();
  assert.match(markup(p.all().find(e=>e.id==="detail-it-incoming")!),/Request body/);
  assert.ok(p.all().some(e=>e.className==="request-meta" && e.innerHTML.includes("Visitor") && e.innerHTML.includes("Need feature")));
});

test("新 counts items: one per item however many changes, a parent adding the items below it, in one chip", async () => {
  const s = snapshot(), id = "f".repeat(40);
  const p = await page(s, [{ id, commits: [id], author: "Session A", at, docs: [
    { kind: "item", id: "child", summary: "head changed, +3 log", pieces: { log: 3, reply: 0, other: 1 } },
    { kind: "item", id: "area", summary: "+2 log", pieces: { log: 2, reply: 0, other: 0 } },
  ] }]);
  const buttons = p.all().filter(e => e.tagName === "BUTTON").map(e => e.innerHTML);
  assert.ok(buttons.includes("新 2 ›"), "two items have something new: " + buttons.join(" | "));
  assert.ok(buttons.includes("进展 2") && buttons.includes("其他 1"), "kind counts are items too");
  await wideCaret(p).click();
  const chip = (itemId: string) => descendants(p.all().find(e => e.id === "it-" + itemId)!.children[0]!).filter(e => e.className.includes("newtag")).map(e => e.innerHTML);
  assert.deepEqual(chip("child"), ["1"], "four changes in one item count once");
  assert.deepEqual(chip("area"), ["2"], "the parent shows one chip: itself and the item below it");
  await p.all().find(e => e.tagName === "BUTTON" && e.innerHTML === "其他 1")!.click();
  assert.ok(p.all().some(e => e.tagName === "BUTTON" && e.innerHTML === "新 1 ›"));
  assert.deepEqual(chip("area"), ["1"], "with only other changes kept, the parent counts its child alone");
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

test("the blue line marks an item's own new content: new and changed items, not parents of new content or untouched items", async () => {
  const css = await readFile("web/index.html","utf8");
  assert.ok(/[^{}]*\.item\.fresh[^{}]*\{[^}]*var\(--fresh\)/.test(css),"new item bar CSS must use the fresh token");
  const s=snapshot(); s.items.child!.deps=[{id:"area",why:"Created dependency"}]; s.items.child!.links=[{label:"Created link",url:"https://example.com/new"}];
  const created=await page(s,unread(),null); await expand(created);
  assert.ok(item(created).className.split(" ").includes("fresh"));
  const rows=descendants(item(created));
  const dep=rows.find(e=>e.className.includes("deprow") && markup(e).includes("Created dependency"))!, link=rows.find(e=>e.tagName === "A" && e.innerHTML === "Created link")!;
  assert.ok(dep.className.split(" ").includes("fresh") && link.className.split(" ").includes("fresh"),"new item dependency and link rows also need blue bars");
  assert.ok(!dep.className.includes("chg-add") && !link.className.includes("chg-add"),"new item retains title-only green marks");
  s.items.plain={title:"Untouched",group:"Project",status:"todo",priority:"P2",updated:at,rev:1,deps:[],links:[],log:[]};
  const changed=await page(s,unread(),{...s.items.child!,head:"Before"}); await expand(changed);
  assert.ok(item(changed).className.split(" ").includes("fresh"),"a changed item shows 新 and so carries the bar");
  assert.ok(!item(changed,"area").className.split(" ").includes("fresh"),"a parent with only new content below carries no line, only its 新 chip");
  assert.ok(descendants(item(changed,"area").querySelector(".item-head")!).some(e=>e.className === "newtag freshchip"),"that parent still counts the sub-item");
  assert.ok(!item(changed,"plain").className.split(" ").includes("fresh"),"an item with nothing new carries no bar");
});

test("new and changed cards carry the blue bar with their 新 chip; a changed card also keeps its inline marks", async () => {
  const s=snapshot(); s.decisions.q=card();
  const created=await page(s,unread("decision","q"),null); await expand(created);
  assert.ok(created.all().find(e=>e.id === "q-q")!.className.split(" ").includes("fresh"));
  const changed=await page(s,unread("decision","q"),{...card(),question:"Old question"}); await expand(changed);
  const c=changed.all().find(e=>e.id === "q-q")!;
  assert.ok(c.className.split(" ").includes("fresh"));
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

test("new reply marks only the reply, not the owner's own comment, without any bookkeeping diff", async () => {
  const css=await readFile("web/index.html","utf8");
  assert.ok(/[^{}]*\.reply\.newbar[^{}]*\{[^}]*var\(--fresh\)/.test(css),"reply bar CSS must use the fresh token");
  const s=snapshot(), before:Note={target:"it:child",kind:"comment",text:"Question",at,state:"sent",rev:1};
  s.notes.n={...before,state:"done",reply:"Answer",repliedAt:at,repliedBy:"Project"};
  const p=await page(s,unread("note","n"),before); p.key("n"); await settle();
  const row=p.all().find(e=>e.id === "note-n")!, reply=row.children.find(e=>e.className.includes("reply"))!;
  assert.ok(!row.className.includes("newbar") && reply.className.includes("newbar"),"one line, beside the reply");
  assert.ok(!markup(p.roots.get("areas")!).includes("状态：") && !markup(p.roots.get("areas")!).includes("回复项目"));
  assert.equal(p.all().filter(e=>e.className.includes("reply rich")).length,1);
  p.key("r"); await settle();
  assert.ok(!descendants(p.all().find(e=>e.id === "note-n")!).some(e=>e.className.includes("newbar")));
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
    const p=await page(s,unread("note","n"),null,undefined,{notesOpen:{[target]:false},detailGeometry:geom});
    assert.ok(!p.all().some(e=>e.id === "note-n"));
    p.key("n"); await settle();
    assert.ok(p.all().find(e=>e.id === "note-n")!.className.includes("cur"));
    assert.ok(p.measurements.some(m=>m.id === "note-n" && m.top === 1700),"the note supplies the landing geometry");
    assert.ok(p.detailScrolls.at(-1)! > 0,"scroll must use the note's nonzero geometry");
    assert.ok(p.calls.some(c=>c.path.startsWith("/api/step?") && c.path.includes("kind=note")),"scroll must wait for note rendering's baseline");
  }
});

test("rapid n suppresses obsolete scrolling while delayed note baselines finish", async () => {
  const s=snapshot(), first=deferred<unknown>(), second=deferred<unknown>();
  s.notes.one={target:"it:child",kind:"comment",text:"First",at,state:"sent",rev:1}; s.notes.two={...s.notes.one,text:"Second"};
  const p=await page(s,[...unread("note","one"),...unread("note","two","e".repeat(40))],(params:URLSearchParams)=>params.get("doc") === "one" ? first.promise : second.promise,undefined,{notesOpen:{"it:child":false},detailGeometry:geom});
  p.key("n"); p.key("n"); await settle();
  assert.equal(p.scrollCount,0,"both navigation requests must await rendered note baselines");
  second.resolve(endpoints(s,new URLSearchParams("kind=note&doc=two"),null)); await settle(); assert.equal(p.scrollCount,0,"another rendered pending baseline can still move the target");
  first.resolve(endpoints(s,new URLSearchParams("kind=note&doc=one"),null)); await settle();
  assert.equal(p.detailScrolls.length,1); assert.ok(p.measurements.some(m=>m.id === "note-two" && m.top === 1700));
  assert.ok(p.all().find(e=>e.id === "note-two")!.className.includes("cur"));
});


test("failed rendered baseline prevents scrolling and retries once on the next n", async () => {
  const s=snapshot(), hold=deferred<unknown>(); let attempts=0;
  s.notes.n={target:"it:child",kind:"comment",text:"New note",at,state:"sent",rev:1};
  const p=await page(s,unread("note","n"),(params:URLSearchParams)=>++attempts === 1 ? hold.promise : endpoints(s,params,null),undefined,{notesOpen:{"it:child":false},detailGeometry:geom});
  p.key("n"); await settle(); assert.equal(attempts,1); assert.equal(p.scrollCount,0);
  hold.reject(new Error("Synthetic baseline unavailable")); await settle();
  assert.equal(p.scrollCount,0,"failed baseline cannot provide a final layout for scrolling");
  assert.equal(attempts,1,"a failed navigation must not retry repeatedly during rendering");
  shownInHint(p,/Synthetic baseline unavailable/);
  p.key("n"); await settle();
  assert.equal(attempts,2,"next n retries the failed rendered baseline once");
  assert.equal(p.detailScrolls.length,1); assert.ok(p.measurements.some(m=>m.id === "note-n" && m.top === 1700));
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

test("N reaches a child while a baseline for its ancestor's unread note is still pending", async () => {
  const s=snapshot(), hold=deferred<unknown>();
  s.notes.above={target:"it:area",kind:"comment",text:"New ancestor comment",at,state:"sent",rev:1};
  const p=await page(s,[...unread("item","child"),...unread("note","above","e".repeat(40))],(params:URLSearchParams)=>params.get("doc") === "above" ? hold.promise : endpoints(s,params,null),undefined,{geometry:geom,detailGeometry:geom});
  // The ancestor's note comes first in page order, so n would target it and rightly wait; the child is the last stop, so N reaches it first.
  p.key("N"); await settle();
  assert.ok(detailItem(p,"child"),"the child is selected and shown without waiting for the ancestor note's baseline");
  hold.resolve(endpoints(s,new URLSearchParams("kind=note&doc=above"),null)); await settle();
});

async function questionContract(tail:string, transform?:PageOptions["transform"]) {
  const s=snapshot(), before={...card(),question:"Common\n\nOld question"+tail}; s.decisions.q={...card(),question:"Common\n\nNew question"+tail};
  const p=await page(s,unread("decision","q"),before,undefined,{transform}); await expand(p);
  const c=p.all().find(e=>e.id === "q-q")!, html=markup(c);
  assert.match(html,/<p>Common<\/p>.*class="chg-add"[^>]*><p>New question<\/p>/s);
  assert.ok(!html.includes("Old question"),"the removed paragraph is not rendered");
  assert.equal(html.split("<p>Common</p>").length-1,1);
  if (tail) { assert.match(html,/<p>New question<\/p>.*<p>Last<\/p>/s); assert.equal(html.split("<p>Last</p>").length-1,1); }
}
test("multi-paragraph card question compares blocks without repeating unchanged paragraphs", async t => {
  for (const tail of ["","\n\nLast"]) await t.test(tail ? "three paragraphs" : "two paragraphs",()=>questionContract(tail));
});
test("two-paragraph question guard detects old whole-question title rendering", async () => {
  let transformed=false;
  await assert.rejects(()=>questionContract("",code=> {
    const old=code.replace(/if \(proseBlocks\(d.question\).length > 1\) \{[\s\S]*?\} else appendTitle\(h, d.question \|\| "", before === null \? null : before\?\.question, "", terms\);/, 'appendTitle(h, d.question || "", before === null ? null : before?.question, "", terms);');
    transformed=old !== code; return old;
  }),{code:"ERR_ASSERTION"});
  assert.ok(transformed,"mutation restores the old whole-question appendTitle path");
});

function cssContract(html:string) {
  html=html.replace(/\/\*[\s\S]*?\*\//g, "");
  const themes=[html.match(/:root \{([^}]+)\}/)![1]!,...html.matchAll(/:root(?::not\(\[data-theme="light"\]\)|\[data-theme="dark"\]) \{([^}]+)\}/g)].map(v=>typeof v === "string" ? v : v[1]!);
  assert.equal(themes.length,3);
  for (const theme of themes) for (const token of ["--fresh","--blockwait","--blockwait-soft"]) assert.ok(new RegExp(token+":\\s*#[a-fA-F0-9]+").test(theme),"every theme defines "+token);
  const rules=[...html.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  const has=(sel:string,decl:RegExp) => rules.some(r=>r[1]!.split(",").map(v=>v.trim()).includes(sel)&&decl.test(r[2]!));
  // The owner never asked for a green background on new or changed text and does not want it: .chg-add only marks
  // where n lands and carries no colour.
  assert.ok(!/--chg-add/.test(html) && !rules.some(r=>r[1]!.split(",").some(v=>/\.chg-add\b/.test(v))&&/background|color/.test(r[2]!)),"no green mark on added or changed text");
  // The owner does not want removed content shown, struck through in red or otherwise.
  assert.ok(!/chg-del|title-was/.test(html),"no red deleted-text styling");
  for (const sel of [".item.fresh",".card.fresh",".log-entry.fresh",".deprow.fresh",".note.newbar",".note .reply.newbar",".notes-toggle.newbar",".refs .fresh"]) assert.ok(has(sel+"::before",/background:\s*var\(--fresh\)/) && has(sel,/position:\s*relative/),sel+" has blue bar CSS");
  // A bar drawn as a shadow or border bends with rounded corners; the bar is one drawn line on every box.
  assert.ok(!rules.some(r=>/(?:box-shadow|border-left):[^;]*var\(--fresh\)/.test(r[2]!)),"no blue bar drawn as a shadow or border");
  for (const sel of [".waittag",".sbtn.s-block"]) assert.ok(has(sel,/background:\s*var\(--blockwait\)/),sel+" is the filled purple chip");
  for (const sel of [".item-head",".deprow",".ref",".optbtn",".notes-toggle"]) assert.ok(has(sel,/(?<!-)user-select:\s*text/) && has(sel,/-webkit-user-select:\s*text/),sel+" text is selectable");
}
test("CSS mark tokens and every blue bar selector are wired in light and both dark themes", async () => { cssContract(await readFile("web/index.html","utf8")); });
test("CSS contract detects removed theme tokens mark declarations and blue selectors", async t => {
  const html=await readFile("web/index.html","utf8");
  for (const token of ["--fresh","--blockwait","--blockwait-soft"]) {
    const declarations=[...html.matchAll(new RegExp(token+":\\s*#[a-fA-F0-9]+;","g"))];
    assert.equal(declarations.length,3);
    for (const [i,match] of declarations.entries()) await t.test(token+" theme "+i,()=> {
      const broken=html.slice(0,match.index)+html.slice(match.index+match[0].length);
      assert.throws(()=>cssContract(broken));
    });
  }
  await t.test("red deleted text comes back",()=> { assert.throws(()=>cssContract(html.replace("</style>",".chg-del { text-decoration: line-through; }\n</style>"))); });
  await t.test("green mark comes back",()=> { assert.throws(()=>cssContract(html.replace("</style>",".chg-add { background: #e3f2e6; }\n</style>"))); });
  await t.test("selectable rows",()=> { assert.throws(()=>cssContract(html.replace(/(?<!-)user-select: text;/,""))); });
  for (const selector of [".item.fresh",".card.fresh",".log-entry.fresh",".deprow.fresh",".note.newbar",".note .reply.newbar",".notes-toggle.newbar",".refs .fresh"]) await t.test(selector,()=> {
    assert.ok(html.includes(selector)); assert.throws(()=>cssContract(html.replaceAll(selector, ".removed-selector")));
  });
});
test("every item title has the same slightly heavy weight, whatever the status or depth", async () => {
  const html=(await readFile("web/index.html","utf8")).replace(/\/\*[\s\S]*?\*\//g,"");
  const rules=[...html.matchAll(/([^{}]+)\{([^{}]+)\}/g)].filter(r=>/\.item-title\b/.test(r[1]!));
  assert.ok(rules.some(r=>/font-weight:\s*500/.test(r[2]!)),"titles set one weight, 500");
  assert.ok(rules.some(r=>r[1]!.trim() === ".item-title strong" && /font-weight:\s*inherit/.test(r[2]!)),"markdown strong inherits the title's weight");
  assert.deepEqual(rules.filter(r=>[...r[2]!.matchAll(/font-weight:\s*([^;]+)/g)].some(m=>m[1]!.trim() !== (r[1]!.trim() === ".item-title strong" ? "inherit" : "500"))).map(r=>r[1]!.trim()),[],"title rules require 500; only strong descendants inherit it");
});
test("scrolling over the detail pane never scrolls the list behind it", async () => {
  const html=(await readFile("web/index.html","utf8")).replace(/\/\*[\s\S]*?\*\//g,"");
  const rule=[...html.matchAll(/([^{}]+)\{([^{}]+)\}/g)].find(r=>r[1]!.trim() === "body.wide #item-detail");
  assert.ok(rule,"the wide detail pane has its own rule");
  assert.match(rule![2]!,/overscroll-behavior:\s*contain/,"wheel and trackpad scrolls stop at the pane, even when it is too short to scroll");
});
test("the left list is its own scroll container, so the document has no scrollbar", async () => {
  const html=(await readFile("web/index.html","utf8")).replace(/\/\*[\s\S]*?\*\//g,"");
  const rules=[...html.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  const rule=(selector:string) => rules.filter(r=>r[1]!.trim() === selector).map(r=>r[2]!).join(";");
  const list=rule("body.wide .page-left");
  assert.match(list,/overflow-y:\s*auto/,"the wide list scrolls on its own, with its scrollbar at the pane's right edge");
  assert.match(list,/overscroll-behavior:\s*contain/,"scrolling the list never chains to the document");
  const body=rule("body.wide");
  assert.match(body,/overflow-y:\s*hidden/,"nothing makes the wide document scroll");
  assert.match(body,/height:\s*100dvh/,"the wide document is exactly one viewport tall");
  assert.match(body,/padding-block:\s*0\b/,"the body's bottom padding does not add to the viewport height");
  assert.match(rule("body.wide .wrap"),/min-height:\s*0/,"the panes share the height left under the connection banner");
  assert.ok(/id="page-left"/.test(html) && /class="page-left"/.test(html),"the list pane is the element the page scrolls");
});
function shortDetailLineContract(source:string) {
  const html=source.replace(/\/\*[\s\S]*?\*\//g,"");
  const rules=[...html.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  const has=(sel:string,decl:RegExp) => rules.some(r=>r[1]!.split(",").map(v=>v.trim()).includes(sel)&&decl.test(r[2]!));
  assert.ok(!rules.some(r=>/\.item\.fresh > \.body/.test(r[1]!)),"no line runs down an item's body or its comments");
  assert.ok(has("body.wide #item-detail .item.fresh > .item-row::before",/background:\s*var\(--fresh\)/),"a short line beside the headline");
  const marker=rules.filter(r=>r[1]!.split(",").map(v=>v.trim()).includes("body.wide #item-detail .item.fresh > .item-row::before")).map(r=>r[2]!).join(";");
  assert.match(marker,/top:\s*3px/,"line begins inside the headline");
  assert.match(marker,/bottom:\s*3px/,"line ends inside the headline");
  assert.doesNotMatch(marker,/(?:^|;)\s*(?:min-|max-)?height\s*:/,"top and bottom alone bound the line to the headline");
}
test("an item's new-content line in the detail column is a short mark beside its headline, not a line down the body", async () => {
  shortDetailLineContract(await readFile("web/index.html","utf8"));
});
test("short detail line contract rejects a viewport-tall marker that the old background check accepted", async () => {
  const html=await readFile("web/index.html","utf8");
  const broken=html.replace(/(body\.wide #item-detail \.item\.fresh > \.item-row::before\s*\{)/,"$1 height: 100dvh;");
  assert.notEqual(broken,html,"mutation reaches the detail marker");
  assert.match(broken,/body\.wide #item-detail \.item\.fresh > \.item-row::before\s*\{[^}]*background:\s*var\(--fresh\)/,"the previous assertion alone still passes");
  assert.throws(()=>shortDetailLineContract(broken),/top and bottom alone/);
});
test("added rich blocks retain vertical spacing without extra visual styling", async () => {
  const html=(await readFile("web/index.html","utf8")).replace(/\/\*[\s\S]*?\*\//g,"");
  const rule=[...html.matchAll(/([^{}]+)\{([^{}]+)\}/g)].find(r=>r[1]!.trim() === ".rich > .chg-add");
  assert.ok(rule,"changed rich blocks have their own layout rule");
  assert.deepEqual(rule[2]!.split(";").map(v=>v.trim()).filter(Boolean),["display: flex","flex-direction: column","gap: 6px"],"restore only the lost layout and spacing");
});
test("page and read-cursor documentation agree on short detail lines and number-only chips", async t => {
  const doc=await readFile("docs/design.md","utf8");
  const readCursor=doc.slice(doc.indexOf("- **The read cursor.**"),doc.indexOf("## 6."));
  const page=doc.slice(doc.indexOf("## 7."),doc.indexOf("## 8."));
  await t.test("short detail line",()=> {
    assert.match(readCursor,/detail column, with a short blue line beside its headline/);
    assert.doesNotMatch(readCursor,/with the full body line/);
  });
  await t.test("all new-content chips are numbers",()=> {
    assert.match(page,/Every 新 chip shows only its number, including detail headlines and cards/);
    assert.doesNotMatch(page,/detail headline and cards keep their existing chip text/i);
  });
  await t.test("removed page additions stay out of guidance",()=> {
    assert.doesNotMatch(page,/in tooltips and accessibility labels|and right arrow keys while focused|menu help explains the caret|check tag, pending explanation tag/);
    assert.match(page,/accessibility labels/);
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
    if (action === "archive") s.items.child!.status="done";
    const path=action === "json" ? "/api/send" : action === "delete" ? "/api/notes/d" : "/api/"+action;
    const p=await page(s,unread("item","area"),null,undefined,{clock,response:(url,_value,init)=>{ if (url !== path) return; signal=init.signal; return action === "json" ? {ok:true,status:200,json:()=>body.promise} : hold.promise; }});
    let control:Element, pending:Promise<unknown>|undefined;
    if (action === "send" || action === "json") { control=p.roots.get("send-all")!; pending=control.click(); }
    else if (action === "read") { await button(p,"全部已阅").click(); control=button(p,"确认"); pending=control.click(); }
    else {
      p.key("n"); await settle();
      if (action === "archive") { control=p.all().find(e=>e.className === "keymenu-row" && e.innerHTML.includes("归档或取消归档"))!; pending=control.click(); }
      else if (action === "notes") { p.key("c"); await settle(); const text=p.all().find(e=>e.id === "ed-it_area")!; text.value="New draft"; control=button(p,"保存"); pending=control.click(); }
      else { if (!button(p,"删除")) { const toggle=p.all().find(e=>e.className.startsWith("notes-toggle") && e.innerHTML.includes("评论 1 条"))!; await toggle.click(); } control=button(p,"删除"); pending=control.click(); }
    }
    await settle(); clock.advance(7999); await settle(); assert.ok(p.roots.get("hint")!.hidden || !p.roots.get("hint")!.textContent.includes("刷新"));
    clock.advance(1); await settle();
    shownInHint(p,/看板服务器.*(?:未|没).*响应.*刷新/);
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
  const p=await page(s,unread("item","area"),null,undefined,{clock}); p.key("n"); await p.flush(); p.key("c"); await settle();
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
  assert.equal(p.roots.get("server-banner")!.textContent,"已和看板服务器断开，正在重连…"); assert.equal(p.roots.get("server-banner")!.hidden,false);
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
    assert.equal(p.roots.get("server-banner")!.hidden,true,"old owner reload cannot report a disconnect after reconnect");
    assert.ok(p.roots.get("hint")!.hidden || !p.roots.get("hint")!.textContent.includes("Obsolete owner refresh"),"old owner reload cannot report an error after reconnect");
  });
});

// An operation error reports in the bottom hint, which hides itself after three seconds; call this right after the error, before the clock passes that.
function shownInHint(p:Awaited<ReturnType<typeof page>>, message:RegExp) { const hint=p.roots.get("hint")!; assert.match(hint.textContent,message); assert.equal(hint.hidden,false,"the error is still showing in the hint"); }
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
  shownInHint(p,/Draft refused/); assert.equal(option(p,"A").disabled,false);
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
    shownInHint(p,/Draft refused/);
    assert.ok(!p.all().some(e=>e.className === "pendtag"));
    if (kind !== "explain") assert.equal(button(p,kind === "approve" ? "同意" : "完成").disabled,false);
  });
});

test("SSE burst renders once per frame and fetches unread once", async () => {
  const frames=new Frames(), p=await page(snapshot(),[],null,undefined,{frames,notesOpen:{"it:area":true}}); await expand(p,"area"); await p.flush(); const renders=p.renders.length, reads=p.calls.filter(c=>c.path === "/api/unread").length;
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
  const s=snapshot(), frames=new Frames(); s.items.sibling={...s.items.child!,title:"Sibling"}; s.items.area!.deps.push({id:"sibling",why:"Needs sibling"}); s.decisions.other={...card(),item:"sibling"};
  // A root depending on child gives it P0; it sorts first until that dependency moves to sibling.
  s.items.pusher={title:"Pusher",group:"Project",status:"todo",priority:"P0",updated:at,rev:1,deps:[{id:"child",why:"Needs child"}],links:[],log:[]};
  const p=await page(s,[],null,undefined,{frames}); await expand(p,"sibling"); await p.flush();
  const other=p.all().find(e=>e.id === "q-other")!;
  p.emit("b".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,head:"Updated head",log:[{at,text:"Updated log"}]}}]); await p.flush();
  assert.equal(p.all().find(e=>e.id === "q-other"),other);
  assert.deepEqual(p.all().filter(e=>e.id === "it-child" || e.id === "it-sibling").map(e=>e.id),["it-child","it-sibling"]);
  p.emit("c".repeat(40),[{kind:"item",id:"pusher",after:{...s.items.pusher!,deps:[{id:"sibling",why:"Needs sibling"}]}}]); await p.flush();
  assert.deepEqual(p.all().filter(e=>e.id === "it-child" || e.id === "it-sibling").map(e=>e.id),["it-sibling","it-child"]);
  p.emit("e".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,status:"done"}}]); await p.flush();
  const doneCount=item(p,"area").querySelector(".counts .done")!;
  assert.equal(doneCount.innerHTML,"1"); assert.equal(doneCount.attributes["aria-label"],"DONE 1");
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

test("card jump waits for target baseline then stays pinned through a later unrelated baseline and SSE until owner scroll", async () => {
  const s=snapshot(), frames=new Frames(), hold=deferred<unknown>(), later=deferred<unknown>(); s.decisions.q=card(); s.items.far={...s.items.area!,title:"Far",deps:[]}; let above=0, p!:Awaited<ReturnType<typeof page>>, fresh=unread("decision","q");
  p=await page(s,fresh,(params:URLSearchParams)=>params.get("doc") === "q" ? hold.promise : later.promise,undefined,{frames,response:path=>path === "/api/unread" ? reply({steps:fresh}) : undefined,detailGeometry:e=>({top: e.id === "q-q" ? 1800+above : 600,height:e.id === "q-q" ? 400 : 2400})}); await expand(p); await p.flush();
  const pane=p.roots.get("item-detail")!;
  p.key("ArrowRight"); await p.flush(); assert.equal(p.scrollCount,0,"target baseline must complete before landing");
  hold.resolve({before:card(),after:card(),diff:""}); await p.flush(); const landed=p.all().find(e=>e.id === "q-q")!.getBoundingClientRect().top;
  fresh=[...fresh,...unread("item","far","e".repeat(40))]; p.emit("a".repeat(40)); await p.flush();
  above=400; later.resolve({before:{...s.items.far!,head:"Removed"},after:s.items.far,diff:""}); await p.flush();
  assert.equal(p.all().find(e=>e.id === "q-q")!.getBoundingClientRect().top,landed,"later unrelated baseline cannot move landed target");
  above=800; p.emit("b".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,head:"Inserted above"}}]); await p.flush();
  assert.equal(p.all().find(e=>e.id === "q-q")!.getBoundingClientRect().top,landed,"SSE insertion cannot move landed target");
  p.user("wheel"); const released=pane.scrollTop; above=1000; p.emit("c".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,head:"More above"}}]); await p.flush();
  assert.equal(pane.scrollTop,released,"owner scroll releases the pin");
});

test("explain withdrawal removes its pending badge before fetch and restores it on failure", async () => {
  const s=snapshot(), clock=new FakeClock(), hold=deferred<FakeResponse>(); s.notes.ex={target:"it:area",kind:"explain",text:"Explain",at,state:"draft",rev:1};
  let p!:Awaited<ReturnType<typeof page>>, observed=false;
  p=await page(s,unread("item","area"),null,undefined,{clock,response:(_path,_body,init)=> { if (init.method && init.method !== "GET") { observed=!p.all().some(e=>e.className === "pendtag"); return hold.promise; } }});
  p.key("n"); await p.flush(); p.key("e");
  try { assert.equal(observed,true,"withdrawal removes the actual header badge synchronously"); }
  finally { hold.reject(new Error("Withdrawal refused")); await p.flush(); }
  assert.ok(p.all().some(e=>e.className === "pendtag")); shownInHint(p,/Withdrawal refused/);
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
  assert.equal(descendants(other).find(e=>e.className === "nextbtn")!.innerHTML,"下一条（3/3）","untouched peer footer follows changed waiting order"); await next.click(); await p.flush(); assert.ok(p.all().find(e=>e.id === "q-other")!.className.includes("cur"));
});

test("card closure and a filtered item update preserve unrelated card identities", async () => {
  const s=snapshot(), frames=new Frames(); s.decisions.q=card(); s.decisions.other={...card(),question:"Other"};
  s.board.projects.push({name:"Elsewhere"}); s.items.far={...s.items.child!,title:"Far",parent:undefined,group:"Elsewhere"}; 
  const p=await page(s,[],null,undefined,{frames}); await expand(p);
  const other=p.all().find(e=>e.id === "q-other")!; assert.ok(other);
  p.emit("b".repeat(40),[{kind:"decision",id:"q",after:{...card(),status:"cancelled"}}]); await p.flush();
  assert.ok(p.all().find(e=>e.id === "q-other") === other,"closing a card preserves its peer");
  await p.all().find(e=>e.tagName === "BUTTON" && e.innerHTML.startsWith("进行中 "))!.click();
  const sameProject=p.all().find(e=>e.id === "q-other")!, farRow=p.all().find(e=>e.id === "it-far")!;
  assert.ok(sameProject && farRow);
  p.emit("c".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,head:"Filtered prose update"}}]); await p.flush();
  assert.ok(p.all().find(e=>e.id === "q-other") === sameProject,"filtered prose preserves same-project peer card");
  assert.ok(p.all().find(e=>e.id === "it-far") === farRow,"a filter in one project cannot rebuild another project's tree row");
});

test("frame fallback works without requestAnimationFrame and smooth jump follows changes during its glide", async t => {
  await t.test("no rAF",async()=> { const p=await page(snapshot(),[],null,undefined,{noFrames:true,clock:new FakeClock(),notesOpen:{"it:area":true}}); await expand(p,"area"); await p.flush(); const count=p.renders.length; p.emit("b".repeat(40),[{kind:"note",id:"n",after:{target:"it:area",kind:"comment",text:"Fallback note",at,state:"sent",rev:1}}]); assert.equal(p.renders.length,count,"timer fallback also defers to its frame"); await p.flush(); assert.match(markup(item(p,"area")),/Fallback note/); });
  await t.test("smooth glide",async()=> {
    const s=snapshot(), frames=new Frames(), hold=deferred<unknown>(); s.decisions.q=card(); let p!:Awaited<ReturnType<typeof page>>, above=0;
    p=await page(s,unread("decision","q"),()=>hold.promise,undefined,{frames,reducedMotion:false,detailGeometry:e=>({top:e.id === "q-q" ? 1800+above : 600,height:e.id === "q-q" ? 400 : 2400})}); await expand(p);
    const pane=p.roots.get("item-detail")!;
    p.key("ArrowRight"); frames.flush(50); await settle(); assert.equal(pane.scrollTop,0,"pending target baseline cannot start the glide");
    hold.resolve({before:card(),after:card(),diff:""}); await settle(); frames.flush(0); await settle(); assert.ok(pane.scrollTop>0 && pane.scrollTop<1500,"glide is still moving toward the centered landing without the removed bar reservation");
    above=500; p.emit("b".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,head:"Inserted during glide"}}]); await p.flush();
    assert.equal(p.all().find(e=>e.id === "q-q")!.getBoundingClientRect().top,300,"without the removed bar reservation, the card lands at the viewport center");
    for (const input of ["click","keydown","scroll"]) {
      p.key("ArrowRight"); await p.flush();
      if (input === "scroll") { pane.scrollTop+=100; for (const fn of pane.handlers.get("scroll") ?? []) fn({isTrusted:true}); } else p.user(input);
      const position:number=pane.scrollTop; above+=200; p.emit("c".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,head:"Above "+above}}]); await p.flush(); assert.equal(pane.scrollTop,position,input+" releases pin");
    }
  });
});

test("owner input cancels an unread jump still awaiting its baseline", async () => {
  const s=snapshot(), hold=deferred<unknown>(), frames=new Frames(), p=await page(s,unread(),()=>hold.promise,undefined,{frames});
  p.key("n"); await settle(); p.user("click"); hold.resolve(endpoints(s,new URLSearchParams("kind=item&doc=child"),null)); await p.flush();
  assert.equal(p.scrollCount,0); assert.ok(!item(p).className.includes("cur"));
});

test("saving a comment preserves other card identity", async () => {
  const s=snapshot(), frames=new Frames(); s.decisions.q=card(); s.decisions.other={...card(),question:"Other"};
  const p=await page(s,[],null,undefined,{frames,response:path=>path === "/api/notes" ? reply({id:"saved-comment"}) : undefined}); await expand(p); p.key("ArrowRight"); await p.flush(); p.key("c"); await p.flush();
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

test("a dependency on a card shows the card's state and its why under the question, like an item row", async () => {
  const s=snapshot(); s.decisions.q={...card(),item:"area"}; s.decisions.r={...card(),question:"已定的问题",item:"area",status:"ruled",ruling:"A",choice:"A"};
  s.items.child!.status="blocked"; s.items.child!.deps=[{card:"q",why:"Needs ruling"},{card:"r",why:"Was ruled"},{card:"gone",why:"Deleted card"}];
  const p=await page(s,[]); await expand(p,"child");
  const rows=descendants(item(p,"child")).filter(e=>e.className.startsWith("deprow"));
  const row=(text:string)=>rows.find(e=>e.innerHTML.includes(text))!;
  for (const [text,tag,why] of [["如何显示","asktag\">决策卡","Needs ruling"],["已定的问题","st done\">已裁定","Was ruled"],["gone","st cancelled\">已删除","Deleted card"]] as const) {
    const r=row(text); assert.ok(r,text);
    assert.ok(r.innerHTML.startsWith('<span class="'+tag),text+" starts with its state tag");
    assert.match(r.innerHTML,new RegExp('<span class="t">[^]*<span class="why">'+why+'</span></span>$'),text+" keeps its why under the question");
  }
});

test("card and item rule changes refresh dependency consumers and transitive priority", async () => {
  const s=snapshot(), frames=new Frames(); s.decisions.q={...card(),item:"area"};
  s.items.child!.status="blocked"; s.items.child!.deps=[{card:"q",why:"Needs ruling"}];
  s.items.blocker={...s.items.child!,title:"Blocker",status:"todo",priority:"P2",deps:[{id:"further",why:"Needs further"}]};
  s.items.further={...s.items.child!,title:"Further",status:"todo",priority:"P2",deps:[]};
  s.items.waiter={...s.items.child!,parent:undefined,group:"Project",title:"Urgent waiter",status:"wip",priority:"P0",deps:[{id:"blocker",why:"Needs blocker"}]};
  s.items.area!.deps.push(...["blocker","further"].map(id=>({id,why:"Child"})));
  const p=await page(s,[],null,undefined,{frames}); await expand(p,"blocker"); await rowOf(p,"further").querySelector(".item-head")!.click(); await rowOf(p,"child").querySelector(".item-head")!.click();
  assert.match(markup(item(p,"further")),/P0/);
  p.emit("b".repeat(40),[{kind:"decision",id:"q",after:{...s.decisions.q!,status:"ruled",ruling:"A"}},{kind:"item",id:"waiter",after:{...s.items.waiter!,status:"done"}}]); await p.flush();
  assert.match(markup(item(p,"child")),/可解除阻塞/,"ruling updates the blocked waiter check");
  assert.ok(!descendants(item(p,"further")).some(e=>e.className.split(" ").includes("prio") && e.innerHTML === "P0"),"closing urgent waiter releases transitive priority");
  await rowOf(p,"blocker").querySelector(".item-head")!.click(); await p.flush();
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
  const p=await page(s,[],null,undefined,{frames}); assert.ok(!p.all().some(e=>e.id === "it-child"),"the archived child is hidden");
  assert.equal(rowOf(p,"area").querySelector(".caret")!.disabled,true,"the parent has no visible sub-item to unfold while its only child is archived");
  p.emit("b".repeat(40),[{kind:"note",id:"reply",after:{target:"it:child",kind:"comment",text:"Question",reply:"Answered",at,state:"done",repliedAt:"2026-10-13T00:00:00Z",rev:1}}]); await p.flush();
  const caret=rowOf(p,"area").querySelector(".caret")!; assert.equal(caret.disabled,false,"the reply restores a visible sub-item under the parent");
  await caret.click(); await p.flush();
  assert.ok(p.all().some(e=>e.id === "it-child"),"reply restores previously archived subtree");
});

test("unread navigation waits for its scheduled frame before measuring", async () => {
  const s=snapshot(), frames=new Frames(), hold=deferred<unknown>();
  const p=await page(s,unread(),()=>hold.promise,undefined,{frames}); p.key("n"); await settle();
  hold.resolve(endpoints(s,new URLSearchParams("kind=item&doc=child"),null)); await settle();
  assert.equal(p.scrollCount,0,"baseline completion cannot flush DOM and scroll outside its frame"); await p.flush(); assert.ok(p.scrollCount>0);
});

test("card landing keeps the actual clamped viewport top across later renders", async () => {
  const s=snapshot(), frames=new Frames(); s.decisions.q=card(); let p!:Awaited<ReturnType<typeof page>>, above=0,height=10000;
  p=await page(s,[],null,undefined,{frames,scrollHeight:()=>height,detailGeometry:e=>({top:e.id === "q-q" ? 9800+above : 600,height:e.id === "q-q" ? 400 : 2400})}); await expand(p);
  const pane=p.roots.get("item-detail")!;
  p.key("ArrowRight"); await p.flush(); assert.equal(pane.scrollTop,9000); const top=p.all().find(e=>e.id === "q-q")!.getBoundingClientRect().top;
  height=11000; above=200; p.emit("b".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,head:"Inserted above"}}]); await p.flush();
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
  const p=await page(s,[],null,undefined,{frames}); await expand(p); const q=p.all().find(e=>e.id === "q-q")!; assert.ok(q);
  const added={...s.items.child!,title:"Added child"};
  p.emit("b".repeat(40),[{kind:"item",id:"added",after:added}]); await p.flush(); assert.ok(p.all().some(e=>e.id === "it-added")); assert.ok(p.all().find(e=>e.id === "q-q") === q);
  p.emit("c".repeat(40),[{kind:"item",id:"added",after:{...added,parent:"other"}}]); await p.flush(); await wideCaret(p,"other").click(); await p.flush(); assert.ok(descendants(rowOf(p,"other").parentElement!).some(e=>e.id === "it-added")); assert.ok(p.all().find(e=>e.id === "q-q") === q);
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

test("scoped unread card membership inserts replies and removes read ended cards without rebuilding peers", async t => {
  for (const kind of ["note","decision"]) for (const hosted of [true,false]) for (const showing of [true,false]) await t.test(kind+" "+(hosted ? "hosted " : "loose ")+(showing ? "insert" : "remove"),async()=> {
    const s=snapshot(), frames=new Frames(), note:Note={target:"q:q",kind:"comment",text:"Question",reply:"Reply",at,state:"done",rev:2};
    s.decisions.q={...card(),item:hosted ? "child" : "absent",status:"ruled",ruling:"A",order:2}; s.decisions.other={...card(),item:hosted ? "child" : "absent",order:1}; s.decisions.third={...card(),item:hosted ? "child" : "absent",order:3};
    if (!showing && kind === "note") s.notes.n=note;
    let fresh=showing ? [] : unread(kind,kind === "note" ? "n" : "q");
    const p=await page(s,fresh,(params:URLSearchParams)=>endpoints(s,params,params.get("kind") === "note" ? {...note,reply:undefined} : {...s.decisions.q!,background:"Old"}),undefined,{frames,response:path=>path === "/api/unread" ? reply({steps:fresh}) : path === "/api/read" ? (fresh=[],reply({ok:true})) : undefined}); if(hosted) await expand(p); await p.flush();
    const peer=p.all().find(e=>e.id === "q-other")!, third=p.all().find(e=>e.id === "q-third")!; assert.ok(peer && third);
    if(showing) { assert.ok(!p.all().some(e=>e.id === "q-q")); fresh=unread(kind,kind === "note" ? "n" : "q"); p.emit("b".repeat(40),[{kind,id:kind === "note" ? "n" : "q",after:kind === "note" ? note : {...s.decisions.q!,background:"Updated",rev:2}}]); await p.flush(); }
    else { fresh=[]; p.emit("b".repeat(40)); await p.flush(); }
    assert.equal(p.all().some(e=>e.id === "q-q"),showing,"ended card membership follows unread state"); assert.ok(p.all().find(e=>e.id === "q-other") === peer); assert.ok(p.all().find(e=>e.id === "q-third") === third);
    if(showing) { assert.deepEqual(p.all().filter(e=>e.id === "q-q" || e.id === "q-other" || e.id === "q-third").map(e=>e.id),hosted ? ["q-other","q-third","q-q"] : ["q-other","q-q","q-third"]); if(hosted) { const body=item(p).children.find(e=>e.className === "body")!; assert.ok(body.children.findIndex(e=>e.id === "q-q") < body.children.findIndex(e=>e.className === "refs"),"card region stays before reference rows"); } }
  });
});

test("all card jump entry points await baselines before selecting and scrolling", async t => {
  // A card its item holds has no 新 chip of its own (it counts toward the item's), so the chip is no entry point here.
  for(const path of ["waiting key","previous key","reference","dependency","next button"]) await t.test(path,async()=> {
    const s=snapshot(), frames=new Frames(), hold=deferred<unknown>(), other=deferred<unknown>(); s.decisions.q=card(); s.notes.n={target:"q:q",kind:"comment",text:"Target comment",at,state:"sent",rev:1};
    if(path === "dependency") s.items.area!.deps.push({card:"q",why:"Needs decision"});
    if(path === "next button") s.items.area!.ask={text:"Parent approval"};
    const p=await page(s,[...unread("decision","q"),...unread("item","area","e".repeat(40))],(params:URLSearchParams)=>params.get("doc") === "q" ? hold.promise : other.promise,undefined,{frames,notesOpen:{"q:q":false}}); await expand(p,path === "dependency" || path === "next button" ? "area" : "child"); await p.flush();
    if(path === "waiting key") p.key("ArrowRight");
    else if(path === "previous key") p.key("ArrowLeft");
    else if(path === "reference") await p.all().find(e=>e.className.startsWith("ref q"))!.click();
    else if(path === "dependency") await p.all().find(e=>e.className === "deprow" && e.innerHTML.includes("如何显示"))!.click();
    else await button(p,"下一条（2/2）").click();
    await p.flush(); assert.equal(p.scrollCount,0,"no document jump may scroll with an unresolved target baseline");
    assert.ok(p.all().some(e=>e.id === "note-n"),"jump unfolds the target comment list");
    hold.resolve({before:card(),after:card(),diff:""}); await p.flush(); assert.ok(p.scrollCount>0); assert.ok(p.all().find(e=>e.id === "q-q")!.className.includes("cur"));
    other.resolve({before:s.items.area,after:s.items.area,diff:""});
  });
});

test("a stalled animation frame still renders and finishes a smooth document jump within one second", async () => {
  const s=snapshot(), frames=new Frames(), clock=new FakeClock(); s.decisions.q=card(); let p!:Awaited<ReturnType<typeof page>>;
  p=await page(s,[],null,undefined,{frames,clock,stalledFrames:true,reducedMotion:false,detailGeometry:e=>({top:e.id === "q-q" ? 1800 : 600,height:e.id === "q-q" ? 400 : 2400})});
  assert.ok(item(p,"area"),"watchdog must paint the initial snapshot while rAF is stalled");
  await expand(p); await p.flush(); const start=clock.now; p.key("ArrowRight");
  let landedAt:number | undefined;
  for(let i=0;i<8;i++) { clock.advance(100); await settle(); if (landedAt === undefined && p.all().find(e=>e.id === "q-q")!.getBoundingClientRect().top === 300) landedAt=clock.now-start; }
  assert.ok(landedAt !== undefined && landedAt <= 600,"render plus smooth glide finishes within its bounded timer schedule");
  assert.equal(p.all().find(e=>e.id === "q-q")!.getBoundingClientRect().top,300); assert.ok(clock.now-start<1000);
  const count=p.renders.length, scrolls=p.scrollCount; frames.flush(); await settle(); assert.equal(p.renders.length,count); assert.equal(p.scrollCount,scrolls,"late rAF callbacks cannot run watchdog-completed work again");
});

test("draft fetch and response-body stalls roll back at eight seconds and ignore late success", async t => {
  for(const phase of ["fetch","json"]) await t.test(phase,async()=> {
    const s=snapshot(), clock=new FakeClock(), frames=new Frames(), hold=deferred<FakeResponse>(), body=deferred<unknown>(); s.decisions.q=card();
    s.notes.old={target:"q:q",kind:"choice",choice:"B",text:"Old",at,state:"draft",rev:1};
    const p=await page(s,[],null,undefined,{clock,frames,response:path=>path === "/api/draft" ? phase === "fetch" ? hold.promise : {ok:true,status:200,json:()=>body.promise} : undefined}); await expand(p); const click=option(p,"A").click();
    assert.ok(option(p,"A").className.includes("sel")); assert.equal(option(p,"B").disabled,true); clock.advance(7999); await settle(); assert.equal(option(p,"B").disabled,true);
    clock.advance(1); await settle(); await p.flush(); assert.ok(option(p,"B").className.includes("sel")); assert.equal(option(p,"A").disabled,false); shownInHint(p,/没有响应.*刷新/); assert.equal(p.roots.get("send-all")!.textContent,"把 1 条发给 Claude");
    const result={note:{id:"old",doc:{...s.notes.old!,choice:"A",rev:2}},deleted:[],commit:"b".repeat(40)};
    if(phase === "fetch") hold.resolve(reply(result)); else body.resolve(result); await click; await p.flush(); assert.ok(option(p,"B").className.includes("sel")); assert.equal(p.roots.get("send-all")!.textContent,"把 1 条发给 Claude");
  });
});

test("a fast baseline rejection is attempted once per jump and retries on the next jump", async () => {
  const s=snapshot(), frames=new Frames(); let attempts=0;
  const p=await page(s,unread(),(params:URLSearchParams)=> { attempts++; return attempts === 1 ? Promise.reject(new Error("Baseline refused")) : endpoints(s,params,null); },undefined,{frames});
  p.key("n"); await settle(); await p.flush(); assert.equal(attempts,1); assert.equal(p.scrollCount,0); p.key("n"); await p.flush(); assert.equal(attempts,2); assert.ok(p.scrollCount>0);
});

test("document jump restores an already-open target hidden by filtering or archive", async t => {
  for (const hiding of ["filter","archive"]) await t.test(hiding,async()=> {
    const s=snapshot(), frames=new Frames(); s.items.child!.status="todo"; s.items.sibling={...s.items.child!,title:"Sibling",status:"wip",deps:[{id:"child",why:"Needs child"}]}; s.items.area!.deps.push({id:"sibling",why:"Sibling"});
    const p=await page(s,[],null,undefined,{frames}); await expand(p); await rowOf(p,"sibling").querySelector(".item-head")!.click();
    if(hiding === "filter") await p.all().find(e=>e.tagName === "BUTTON" && e.innerHTML.startsWith("进行中 "))!.click();
    else { p.emit("b".repeat(40),[{kind:"owner",id:"owner",after:{archived:{child:"2026-10-12T00:00:00Z"}}}]); await p.flush(); }
    assert.ok(!item(p)); const dep=descendants(item(p,"sibling")).find(e=>e.className === "deprow" && e.innerHTML.includes('class="t">Child<'))!; assert.ok(dep); await dep.click(); await p.flush();
    assert.ok(item(p),"jump materializes the previously open target again"); assert.ok(item(p).className.includes("cur")); assert.ok(p.scrollCount>0);
  });
});

test("scoped first-card insertion stays before checks and references", async () => {
  const s=snapshot(), frames=new Frames(); s.decisions.q={...card(),status:"ruled",ruling:"A"}; s.items.child!.deps=[{id:"missing",why:"Needs missing item"}]; let fresh:unknown[]=[];
  const p=await page(s,fresh,null,undefined,{frames,response:path=>path === "/api/unread" ? reply({steps:fresh}) : undefined}); await expand(p); await p.flush(); assert.ok(!p.all().some(e=>e.id === "q-q"));
  fresh=unread("note","n"); p.emit("b".repeat(40),[{kind:"note",id:"n",after:{target:"q:q",kind:"comment",text:"Question",reply:"Reply",at,state:"done",rev:1}}]); await p.flush();
  const children=item(p).children.find(e=>e.className === "body")!.children, cardIndex=children.findIndex(e=>e.id === "q-q"); assert.ok(cardIndex>=0);
  assert.ok(cardIndex < children.findIndex(e=>e.className === "checks")); assert.ok(cardIndex < children.findIndex(e=>e.className === "refs"));
});

test("scoped card membership retains explicit shown and hidden overrides", async t => {
  for(const shown of [true,false]) await t.test(String(shown),async()=> {
    const s=snapshot(), frames=new Frames(), note:Note={target:"q:q",kind:"comment",text:"Question",reply:"Reply",at,state:"done",rev:2}; s.decisions.q={...card(),status:"ruled",ruling:"A"}; s.notes.n=note; let fresh=unread("note","n");
    const p=await page(s,fresh,{...note,reply:undefined},undefined,{frames,response:path=>path === "/api/unread" ? reply({steps:fresh}) : undefined}); await expand(p); await p.flush();
    await p.all().find(e=>e.className.startsWith("ref q"))!.click(); await p.flush();
    if(shown) { await p.all().find(e=>e.className.startsWith("ref q"))!.click(); await p.flush(); }
    fresh=[]; p.emit("b".repeat(40)); await p.flush(); assert.equal(p.all().some(e=>e.id === "q-q"),shown,"reading preserves the explicit override");
    fresh=unread("note","n","e".repeat(40)); p.emit("c".repeat(40),[{kind:"note",id:"n",after:{...note,reply:"Later reply",rev:3}}]); await p.flush(); assert.equal(p.all().some(e=>e.id === "q-q"),shown,"new freshness preserves the explicit override");
  });
});

test("scoped card order updates reorder its region and preserve other card elements", async () => {
  const s=snapshot(), frames=new Frames(); s.decisions.q={...card(),order:1}; s.decisions.other={...card(),order:2}; s.decisions.third={...card(),order:3};
  const p=await page(s,[],null,undefined,{frames}); await expand(p); const peer=p.all().find(e=>e.id === "q-other")!, third=p.all().find(e=>e.id === "q-third")!;
  p.emit("b".repeat(40),[{kind:"decision",id:"q",after:{...s.decisions.q!,order:4,rev:2}}]); await p.flush();
  assert.deepEqual(p.all().filter(e=>["q-q","q-other","q-third"].includes(e.id)).map(e=>e.id),["q-other","q-third","q-q"]); assert.ok(p.all().find(e=>e.id === "q-other") === peer); assert.ok(p.all().find(e=>e.id === "q-third") === third);
});

test("held unread and loose addition coalesce without suppressing hosted card membership", async t => {
  for (const kind of ["note","decision"]) await t.test(kind,async()=> {
    const s=snapshot(), frames=new Frames(), held=deferred<FakeResponse>(), baseline=deferred<unknown>();
    s.decisions.q={...card(),status:"ruled",ruling:"A"}; s.decisions.peer=card();
    s.notes.n={target:"q:q",kind:"comment",text:"Question",reply:"Reply",at,state:"done",rev:2};
    let hold=false;
    const p=await page(s,[],()=>baseline.promise,undefined,{frames,response:path=>path === "/api/unread" && hold ? held.promise : undefined}); await expand(p); await p.flush();
    const peer=p.all().find(e=>e.id === "q-peer")!; assert.ok(peer); assert.ok(!p.all().some(e=>e.id === "q-q"));
    hold=true; p.emit("b".repeat(40)); frames.flush(); await settle();
    held.resolve(reply({steps:unread(kind,kind === "note" ? "n" : "q")})); await settle();
    p.emit("c".repeat(40),[{kind:"decision",id:"loose",after:{...card(),item:"absent"}}]);
    const count=p.renders.length; frames.flush(); await settle();
    assert.equal(p.renders.length-count,1);
    assert.deepEqual([...p.renders.at(-1) as Set<string>].sort(),["cards","card:loose",kind === "note" ? "notes:q:q" : "card:q"].sort(),"the held unread result and loose addition share precisely the affected scopes");
    assert.ok(p.all().some(e=>e.id === "q-loose"));
    assert.ok(p.all().some(e=>e.id === "q-q"),"loose-card rendering must not suppress hosted membership reconciliation");
    assert.ok(p.all().find(e=>e.id === "q-peer") === peer,"the hosted peer is untouched");
  });
});

test("dependency Back reacquires selects and scrolls its row after an owner rerender", async () => {
  const s=snapshot(), frames=new Frames(), baseline=deferred<unknown>(); let fresh:unknown[]=[]; let p!:Awaited<ReturnType<typeof page>>;
  p=await page(s,fresh,()=>baseline.promise,undefined,{frames,response:path=>path === "/api/unread" ? reply({steps:fresh}) : undefined,detailGeometry:e=>({top:e.dataset.sel === "dep:area@child" ? 600 : 0,height:e.dataset.sel === "dep:area@child" ? 80 : 2400})});
  await expand(p,"area"); await p.flush();
  const from=p.all().find(e=>e.dataset.sel === "dep:area@child")!; assert.ok(from.matches("[data-sel]"),"capture click selects the actual dependency row");
  await from.click(); await p.flush(); assert.ok(item(p).className.includes("cur"));
  fresh=unread("item","area"); p.emit("b".repeat(40),[{kind:"item",id:"area",after:{...s.items.area!,head:"New parent prose",rev:2}}]); await p.flush();
  const scrolls=p.scrollCount; await button(p,"← 返回").click(); await p.flush(); assert.equal(p.scrollCount,scrolls,"return waits for the enclosing item baseline");
  baseline.resolve({before:s.items.area,after:s.items.area,diff:""}); await p.flush();
  const returned=p.all().find(e=>e.dataset.sel === "dep:area@child")!;
  assert.ok(returned !== from,"the detail was rebuilt for the item the reader returned to");
  assert.ok(returned.className.includes("cur"),"Back selects the dependency row rather than its enclosing item");
  assert.ok(!item(p,"area").className.includes("cur")); assert.ok(p.scrollCount>scrolls);
  assert.ok(returned.getBoundingClientRect().top >= 8 && returned.getBoundingClientRect().bottom <= 992,"the row lands in the viewport without space reserved for the removed bar");
  assert.ok(p.measurements.some(m=>m.id === returned.id && m.height === 80),"scroll geometry comes from the dependency row");
});

test("loose-card scope does not suppress a coalesced item-note update", async () => {
  const s=snapshot(), frames=new Frames(); s.notes.n={target:"it:child",kind:"comment",text:"Original comment",at,state:"sent",rev:1};
  const p=await page(s,[],null,undefined,{frames,notesOpen:{"it:child":true}}); await expand(p); await p.flush();
  p.emit("b".repeat(40),[{kind:"note",id:"n",after:{...s.notes.n!,text:"Updated comment",rev:2}},{kind:"decision",id:"loose",after:{...card(),item:"absent"}}]);
  frames.flush(); await settle();
  assert.deepEqual([...p.renders.at(-1) as Set<string>].sort(),["cards","card:loose","notes:it:child"].sort());
  assert.match(markup(item(p)),/Updated comment/); assert.ok(p.all().some(e=>e.id === "q-loose"));
});


test("r reads the card selected by 下一条 while an earlier unread item stays new", async () => {
  const s=snapshot(), later="e".repeat(40); s.decisions.q=card(); s.items.child!.ask={text:"Approve"};
  const p=await page(s,[...unread("item","area"),...unread("decision","q",later)]); await expand(p);
  await button(p,"下一条（2/2）").click(); await p.flush();
  assert.ok(p.all().find(e=>e.id === "q-q")!.className.includes("cur"));
  p.key("r"); await p.flush();
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:"decision:q",through:later}]);
  assert.ok(!p.all().find(e=>e.id === "q-q")!.className.includes("fresh"));
  assert.ok(!descendants(p.all().find(e=>e.id === "q-q")!).some(e=>e.className.includes("freshchip")));
  assert.ok(item(p,"area").className.includes("fresh"),"earlier item remains unread");
  assert.ok(p.all().some(e=>e.innerHTML === "新 1 ›"));
});

test("r on a read selection shows a passing hint, not a kept error, and writes nothing", async () => {
  const clock=new FakeClock();
  const p=await page(snapshot(),[],null,undefined,{clock}); await item(p,"area").children[0]!.click(); p.key("r");
  const hint=p.roots.get("hint")!;
  assert.equal(hint.hidden,false); assert.match(hint.textContent,/这里没有新内容/);
  assert.equal(p.roots.get("server-banner")!.hidden,true,"the error banner stays for errors");
  assert.equal(p.calls.filter(c=>c.path === "/api/read").length,0);
  clock.advance(3000); assert.equal(hint.hidden,true,"the hint leaves by itself");
  p.key("r"); assert.equal(hint.hidden,false);
  p.key("j"); assert.equal(hint.hidden,true,"the next key clears it");
});

test("r reads all selected document steps from item card note and log clicks", async t => {
  for(const selection of ["item","decision","note","log"] as const) await t.test(selection,async()=> {
    const s=snapshot(), first="e".repeat(40), last="f".repeat(40), kind=selection === "log" ? "item" : selection;
    s.decisions.q=card(); s.items.child!.log=[{at,text:"Latest log"}];
    s.notes.n={target:"it:child",kind:"comment",text:"Question",at,state:"done",reply:"Answer",rev:1};
    const id=kind === "item" ? "child" : kind === "decision" ? "q" : "n";
    const p=await page(s,[...unread("item","area"),...unread(kind,id,first),...unread(kind,id,last)],null,undefined,{notesOpen:{"it:child":true}}); await expand(p);
    const box=selection === "item" ? item(p) : selection === "decision" ? p.all().find(e=>e.id === "q-q")! : selection === "note" ? p.all().find(e=>e.id === "note-n")! : p.all().find(e=>e.dataset.sel?.startsWith("log:child@"))!;
    await box.click(); p.key("r"); await p.flush();
    assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:kind+":"+id,through:last}]);
    assert.ok(item(p,"area").className.includes("fresh"));
    assert.ok(p.all().some(e=>e.innerHTML === "新 1 ›"),"all steps of the selected document were read");
  });
});

test("r on a card reads its whole item at once and restores both on error or eight-second deadline without retry", async t => {
  for(const failure of ["refused","deadline"] as const) await t.test(failure,async()=> {
    const s=snapshot(), clock=new FakeClock(), hold=deferred<FakeResponse>(); s.decisions.q=card(); let signal:AbortSignal|undefined;
    const p=await page(s,[...unread("item","child"),...unread("decision","q","e".repeat(40))],null,undefined,{clock,response:(path,_body,init)=> { if(path === "/api/read") { signal=init.signal; return hold.promise; } }}); await expand(p);
    await p.all().find(e=>e.id === "q-q")!.click(); p.key("r");
    assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>(c.body as {doc:string}).doc).sort(),["decision:q","item:child"],"r on the card reads the item holding it with the card");
    assert.ok(!p.all().find(e=>e.id === "q-q")!.className.includes("fresh"),"read is painted before fetch settles");
    assert.ok(!item(p).className.includes("fresh"));
    assert.ok(!p.all().some(e=>e.innerHTML.startsWith("新 ")));
    p.key("r"); assert.equal(p.calls.filter(c=>c.path === "/api/read").length,2,"pending reads are not repeated");
    if(failure === "refused") hold.resolve({ok:false,status:400,json:async()=>({error:"Read refused"})});
    else { clock.advance(7999); await settle(); assert.ok(!p.all().find(e=>e.id === "q-q")!.className.includes("fresh")); clock.advance(1); }
    await settle(); await p.flush();
    assert.ok(p.all().find(e=>e.id === "q-q")!.className.includes("fresh"));
    assert.ok(item(p).className.includes("fresh"));
    assert.ok(p.all().some(e=>e.innerHTML === "新 1 ›"),"one item holds both changes");
    shownInHint(p,failure === "refused" ? /Read refused/ : /没有响应.*刷新/);
    if(failure === "deadline") { assert.equal(signal?.aborted,true); hold.resolve(reply({ok:true})); await settle(); assert.ok(p.all().find(e=>e.id === "q-q")!.className.includes("fresh"),"late acknowledgement cannot reapply timed-out read"); }
    assert.equal(p.calls.filter(c=>c.path === "/api/read").length,2);
  });
});

test("pending selected read survives unread refresh and leaves a later change visible", async () => {
  const s=snapshot(), frames=new Frames(), hold=deferred<FakeResponse>(), later="f".repeat(40); s.decisions.q=card();
  let fresh=[...unread("item","area"),...unread("decision","q","e".repeat(40))];
  const p=await page(s,fresh,null,undefined,{frames,response:path=>path === "/api/read" ? hold.promise : path === "/api/unread" ? reply({steps:fresh}) : undefined}); await expand(p);
  await p.all().find(e=>e.id === "q-q")!.click(); p.key("r");
  p.emit("b".repeat(40)); await p.flush(); assert.ok(!p.all().find(e=>e.id === "q-q")!.className.includes("fresh"),"stale unread response must respect pending read");
  fresh=[...fresh,...unread("decision","q",later)]; p.emit("c".repeat(40)); await p.flush();
  assert.ok(p.all().find(e=>e.id === "q-q")!.className.includes("fresh"),"later change remains unread");
  assert.ok(p.all().some(e=>e.innerHTML === "新 2 ›"));
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:"decision:q",through:"e".repeat(40)}]);
  fresh=[fresh[0]!,fresh.at(-1)!]; hold.resolve(reply({ok:true})); await p.flush();
  assert.ok(p.all().find(e=>e.id === "q-q")!.className.includes("fresh"));
  assert.ok(p.all().some(e=>e.innerHTML === "新 2 ›"));
});


test("pending document read hides a coalesced step until acknowledgement splits its later change", async t => {
  for(const accepted of [true,false]) await t.test(accepted ? "acknowledged split" : "refused restores combined step",async()=> {
    const s=snapshot(), frames=new Frames(), hold=deferred<FakeResponse>(), first="e".repeat(40), later="f".repeat(40); s.decisions.q=card();
    let fresh=[...unread("item","area"),...unread("decision","q",first)];
    const p=await page(s,fresh,null,undefined,{frames,response:path=>path === "/api/read" ? hold.promise : path === "/api/unread" ? reply({steps:fresh}) : undefined}); await expand(p);
    await p.all().find(e=>e.id === "q-q")!.click(); p.key("r");
    fresh=[fresh[0]!,{...unread("decision","q",later)[0]!,commits:[first,later]}];
    p.emit("b".repeat(40)); await p.flush();
    assert.ok(!p.all().find(e=>e.id === "q-q")!.className.includes("fresh"),"overlapping combined step must not restore the old blue marks");
    if(accepted) { fresh=[fresh[0]!,unread("decision","q",later)[0]!]; hold.resolve(reply({ok:true})); }
    else hold.resolve({ok:false,status:400,json:async()=>({error:"Read refused"})});
    await p.flush();
    assert.ok(p.all().find(e=>e.id === "q-q")!.className.includes("fresh"),"later unread change or refused mark remains visible");
    assert.ok(p.all().some(e=>e.innerHTML === "新 2 ›"));
    assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:"decision:q",through:first}]);
    if(!accepted) shownInHint(p,/Read refused/);
  });
});


test("r reads every selected document kind even when the fresh filter hides its latest step", async () => {
  const s=snapshot(), first="e".repeat(40), last="f".repeat(40); s.items.child!.log=[{at,text:"Progress"}];
  const fresh=[...unread("item","area"),{...unread("item","child",first)[0]!,docs:[{kind:"item",id:"child",summary:"+1 log",pieces:{log:1,reply:0,other:0}}]},...unread("item","child",last)];
  const p=await page(s,fresh); await expand(p); await button(p,"进展 1").click();
  p.key("n"); await p.flush(); assert.ok(item(p).className.includes("cur"));
  p.key("r"); await p.flush();
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:"item:child",through:last}]);
  await button(p,"进展 0").click();
  assert.ok(item(p,"area").className.includes("fresh"));
  assert.ok(!item(p).className.includes("fresh"));
  assert.ok(p.all().some(e=>e.innerHTML === "新 1 ›"));
});

async function dependencyReadContract(transform?: PageOptions["transform"]) {
  const s=snapshot(), later="e".repeat(40); s.decisions.q=card(); s.items.child!.deps=[{card:"q",why:"Needs decision"}];
  const p=await page(s,[...unread("item","area"),...unread("decision","q",later)],null,undefined,{transform});
  p.key("n"); await p.flush(); assert.ok(item(p,"area").className.includes("cur"));
  await wideCaret(p).click(); await p.flush();
  await rowOf(p).querySelector(".item-head")!.click(); await descendants(item(p)).find(e=>e.dataset.sel === "dep:child@q")!.click(); await p.flush();
  assert.ok(p.all().find(e=>e.id === "q-q")!.className.includes("cur"));
  p.key("r"); await p.flush();
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:"decision:q",through:later}]);
  assert.ok(item(p,"area").className.includes("fresh"));
  assert.ok(!p.all().find(e=>e.id === "q-q")!.className.includes("fresh"));
}
test("r follows a dependency-selected card instead of the document previously shown by n", async () => {
  await dependencyReadContract();
  let mutated=false;
  await assert.rejects(()=>dependencyReadContract(code=> {
    const old=code.replace("async function markRead() {", "async function markRead() { if (current !== shownFresh()?.sel) return false;");
    mutated=old !== code; return old;
  }), (error: unknown) => {
    const failure=error as {code?:string;actual?:unknown[];expected?:unknown[]};
    return failure.code === "ERR_ASSERTION" && failure.actual?.length === 0 && failure.expected?.length === 1;
  });
  assert.ok(mutated,"restoring the old shownFresh selection restriction must make the document read disappear");
});

function wideHead(p: Awaited<ReturnType<typeof page>>, id="area") { return rowOf(p,id).querySelector(".item-head")!; }
function wideCaret(p: Awaited<ReturnType<typeof page>>, id="area") { return rowOf(p,id).querySelector(".caret")!; }
function detailItem(p: Awaited<ReturnType<typeof page>>, id="area") { return p.document.getElementById("detail-it-"+id); }
async function selectWide(p: Awaited<ReturnType<typeof page>>, id="area") { await wideHead(p,id).click(); await p.flush(); }

test("the purple blocking number leads to the first place below that waits for the owner", async () => {
  const s=snapshot(); s.items.child!.ask={text:"Child ask"};
  const p=await page(s,[]);
  const wait=wideHead(p).children.find(e=>e.className === "waittag")!;
  assert.equal(wait.innerHTML,"1"); assert.equal(wait.attributes["role"],"button");
  assert.ok(!detailItem(p,"child"),"nothing is selected before the click");
  await wait.click(); await p.flush();
  assert.ok(detailItem(p,"child"),"the click selects the waiting child and shows it in the detail");
});

test("tree new and blocking chips show only numbers with full labels", async () => {
  const s=snapshot(); s.items.area!.ask={text:"Parent ask"}; s.items.child!.ask={text:"Child ask"};
  const p=await page(s,[...unread("item","area"),...unread("item","child","e".repeat(40))]);
  const head=wideHead(p), fresh=head.querySelector(".freshchip")!;
  assert.equal(fresh.innerHTML,"2","blue chip is the count alone");
  assert.match(fresh.title,/2 处新内容/); assert.equal(fresh.attributes["aria-label"],fresh.title);
  const wait=head.children.find(e=>e.className === "waittag")!;
  assert.equal(wait.innerHTML,"2","purple chip counts the item's own ask and the ask below, as a number alone");
  assert.equal(wait.title,"2 处阻塞工作"); assert.equal(wait.attributes["aria-label"],wait.title);
  assert.ok(!head.children.some(e=>e.innerHTML === "等你处理"),"no wordy tag remains on the row");
  assert.ok(!head.children.some(e=>e.className === "asktag"),"no red chip without a non-blocking card");
  await selectWide(p);
  assert.equal(detailItem(p)!.querySelector(".freshchip")!.innerHTML,"2","the detail headline's chip is the count alone too");
  assert.equal(detailItem(p)!.querySelector(".item-title")!.title,"","detail headings have no added hover tooltip");
});

// The owner limited the added help to the three numeric row marks.
test("existing menu help keeps its shortcut sentence and explains only the three numeric row marks", async () => {
  const p=await page(snapshot(),[]), menu=p.document.getElementById("keymenu")!;
  assert.equal(menu.querySelectorAll(".keymenu-head").length,1,"help extends the existing description");
  const help=menu.querySelector(".keymenu-head")!.innerHTML;
  assert.match(help,/^快捷键：作用于选中的条目或卡片；没选中时作用于屏幕最上面那一条<br>/,"the original shortcut sentence is retained");
  for (const mark of ["▸/▾","TODO","WIP","BLOCK","DONE","DROP","P0","P1","P2","蓝线","需核对","待发","状态条","选中底色","原标题","原写优先级","父条目"]) assert.ok(!help.includes(mark),"help omits unrequested explanation "+mark);
  assert.match(help,/蓝色数字[^。]*新内容/); assert.match(help,/紫色数字[^。]*阻塞[^。]*红色数字[^。]*决策卡/);
  assert.match(help,/右侧状态色数字[^。]*叶条目/);
  assert.equal(menu.querySelector(".keymenu-btn")!.innerHTML,"☰");
  const css=await readFile("web/index.html","utf8");
  assert.doesNotMatch(css,/\.keymenu-list\s*\{[^}]*(?:max-height|overflow-y):/,"the shorter help needs no added scrolling rules");
});

test("sticky path bar and its code CSS and scroll reservations are absent", async () => {
  const [html,code]=await Promise.all([readFile("web/index.html","utf8"),readFile("web/app.ts","utf8")]);
  assert.doesNotMatch(html,/id=["']crumbs["']/,"the sticky path bar has no DOM element");
  assert.doesNotMatch(html,/crumbbar|crumbrow|scroll-margin-top/,"the removed bar leaves no styles or scroll margin");
  assert.doesNotMatch(code,/crumb|scrollMarginTop|glideToEl/,"there is no path-bar builder or scroll-offset reader");
  const p=await page(snapshot(),[]);
  assert.equal(p.document.getElementById("crumbs"),null);
  assert.ok(p.roots.get("to-top"),"the existing send-box top button remains");
});

test("parent counts are numbers with status color and labels", async () => {
  const s=snapshot(); s.items.todo={...s.items.child!,title:"Todo",status:"todo"};
  const p=await page(s,[]), counts=rowOf(p,"area").querySelector(".counts")!;
  assert.deepEqual(counts.children.map(e=>e.innerHTML),["1","1"]);
  for (const [i,status] of ["todo","wip"].entries()) {
    const count=counts.children[i]!; assert.ok(count.classList.contains(status));
    // Status labels remain accessible; the owner removed the added hover tooltip.
    assert.equal(count.title,""); assert.equal(count.attributes["aria-label"],status.toUpperCase()+" 1");
  }
});

test("split divider pointer drag clamps both columns and persists the width", async () => {
  const storage=new Map<string,string>(), p=await page(snapshot(),[],null,undefined,{storage});
  const divider=p.roots.get("split-divider")!;
  assert.equal(divider.hidden,false,"split exposes a divider");
  assert.equal(divider.attributes.role,"separator");
  const before=parseFloat(p.wrap.style["--tree-width"]!);
  assert.ok(Number.isFinite(before),"the CSS property supplies a real starting width");
  await divider.pointer("pointerdown",{clientX:400});
  assert.equal(divider.capturedPointer,1,"drag captures the pointer outside the divider");
  await divider.pointer("pointermove",{clientX:480,pointerId:2});
  assert.equal(parseFloat(p.wrap.style["--tree-width"]!),before,"other pointers cannot resize this drag");
  await divider.pointer("pointermove",{clientX:480});
  assert.equal(parseFloat(p.wrap.style["--tree-width"]!),before+80);
  await divider.pointer("pointerup",{clientX:480});
  assert.equal(divider.capturedPointer,null);
  const reloaded=await page(snapshot(),[],null,undefined,{storage});
  assert.equal(reloaded.wrap.style["--tree-width"],p.wrap.style["--tree-width"],"width survives reload");
  await divider.pointer("pointerdown",{clientX:480});
  await divider.pointer("pointermove",{clientX:-1000});
  assert.equal(p.wrap.style["--tree-width"],"300px","left column retains its minimum");
  await divider.pointer("pointermove",{clientX:2000});
  assert.equal(p.wrap.style["--tree-width"],"512px","900px container reserves 8px divider and 380px detail");
  await divider.pointer("pointercancel",{clientX:2000});
  assert.equal(divider.capturedPointer,null);
});

// Keyboard resizing was outside the requested pointer-drag behavior.
test("split divider has no added keyboard resizing or focus styles", async () => {
  const p=await page(snapshot(),[]);
  assert.equal(p.roots.get("split-divider")!.handlers.has("keydown"),false);
  const [code,html]=await Promise.all([readFile("web/app.ts","utf8"),readFile("web/index.html","utf8")]);
  assert.doesNotMatch(code,/divider\.tabIndex\s*=/);
  assert.doesNotMatch(code,/divider\.focus\(/);
  assert.doesNotMatch(html,/#split-divider[^}]*:focus-visible|id="split-divider"[^>]*tabindex/);
});

test("the page is always the split view: a fixed two-column body, a divider, no layout toggle and no stored layout choice", async () => {
  const html=await readFile("web/index.html","utf8");
  assert.match(html,/<body class="wide">/,"the two-column layout is on from the first paint");
  assert.doesNotMatch(html,/split-toggle|id="split-divider"[^>]*hidden|id="item-detail"[^>]*hidden/);
  const storage=new Map<string,string>(), p=await page(snapshot(),[],null,undefined,{storage});
  assert.equal(p.roots.get("item-detail")!.hidden,false); assert.equal(p.roots.get("split-divider")!.hidden,false);
  assert.equal(p.document.getElementById("split-toggle"),null,"there is no 分屏 / 单栏 toggle");
  assert.ok(!p.all().some(e=>e.innerHTML === "单栏" || e.innerHTML === "分屏"));
  await selectWide(p); await p.flush();
  assert.ok(detailItem(p),"a head click selects the item for the detail column");
  assert.equal(rowOf(p,"area").querySelector(".body"),null,"the tree never holds a body");
  assert.ok(![...storage.keys()].some(k=>k === "board-split"),"no layout choice is stored");
  assert.ok(p.all().filter(e=>e.id.startsWith("it-")).every(e=>!e.querySelector(".body")),"no tree row holds a body");
});

test("the page tolerates unavailable localStorage", async () => {
  const p=await page(snapshot(),[],null,undefined,{storageUnavailable:true});
  assert.equal(p.roots.get("item-detail")!.hidden,false);
  await selectWide(p); assert.ok(detailItem(p),"selecting still works without storage");
  await p.roots.get("split-divider")!.pointer("pointerdown",{clientX:400});
  await p.roots.get("split-divider")!.pointer("pointermove",{clientX:420});
  assert.ok(Number.isFinite(parseFloat(p.wrap.style["--tree-width"]!)));
});

test("parent leaf counts are number-only with a status label", async () => {
  const s=snapshot();
  s.items.todo={...s.items.child!,title:"Todo",status:"todo"};
  s.items.block={...s.items.child!,title:"Blocked",status:"blocked"};
  const p=await page(s,[]);
  const counts=rowOf(p,"area").querySelector(".counts")!;
  assert.deepEqual(counts.children.map(e=>e.innerHTML),["1","1","1"]);
  for (const [i,label] of ["TODO","WIP","BLOCK"].entries()) {
    assert.equal(counts.children[i]!.title,"","status-count hover tooltips were removed at the owner's request");
    assert.equal(counts.children[i]!.attributes["aria-label"],label+" 1");
  }
});

// A cancelled leaf, a parent cancelled through its only sub-item, and a cancelled top-level item beside the open child.
function cancelledSnapshot() {
  const s=snapshot();
  s.items.gone={...s.items.child!,title:"Gone",status:"cancelled",deps:[{id:"child",why:"Gone needs child"}]};
  s.items.dropped={...s.items.child!,title:"Dropped",status:undefined};
  s.items.droppedKid={...s.items.child!,title:"Dropped kid",parent:"dropped",status:"cancelled"};
  s.items.topGone={...s.items.area!,title:"Top gone",deps:[],status:"cancelled"};
  s.items.area!.deps.push({id:"gone",why:"needs gone"},{id:"dropped",why:"needs dropped"});
  s.items.dropped.deps=[{id:"droppedKid",why:"needs kid"}];
  return s;
}
test("the tree leaves out cancelled items with their subtrees", async () => {
  const p=await page(cancelledSnapshot(),[]); await expand(p,"area");
  assert.ok(item(p,"child"),"the open sub-item stays");
  for (const id of ["gone","dropped","droppedKid","topGone"]) assert.ok(!item(p,id),id+" is hidden");
});
test("the 取消 filter shows cancelled items where they sit", async () => {
  const p=await page(cancelledSnapshot(),[]); await expand(p,"area");
  assert.ok(item(p,"child") && !item(p,"gone"),"hidden while the filter is off");
  const button=p.all().find(e=>e.tagName === "BUTTON" && e.innerHTML.startsWith("取消 "))!;
  assert.equal(button.innerHTML,"取消 4","the status bar keeps counting cancelled items");
  await button.click(); await p.flush();
  for (const id of ["gone","dropped","droppedKid"]) assert.ok(descendants(rowOf(p,"area").parentElement!).includes(rowOf(p,id)),id+" shows under its parent");
  assert.ok(item(p,"topGone"),"a cancelled top-level item shows too");
});
test("parent leaf counts leave out cancelled leaves", async () => {
  const p=await page(cancelledSnapshot(),[]);
  const counts=item(p,"area").querySelector(".counts")!;
  assert.deepEqual(counts.children.map(e=>e.className),["st wip"]);
  assert.deepEqual(counts.children.map(e=>e.innerHTML),["1"]);
});
test("dependency lists leave out cancelled items and removed rows but keep added and deleted rows", async () => {
  const s=cancelledSnapshot();
  s.items.old={...s.items.child!,title:"Old",status:"cancelled"};
  s.items.area!.deps.push({id:"missing",why:"needs missing"});
  const before={...s.items.area!,deps:[...s.items.area!.deps,{id:"old",why:"needed old"}]};
  const p=await page(s,unread("item","area"),before); await expand(p,"area"); await p.flush();
  const rows=(id:string) => descendants(item(p,id)).filter(e=>e.className.split(" ").includes("deprow")).map(e=>e.innerHTML.match(/class="t">([^<]*)</)?.[1] ?? e.innerHTML);
  const areaRows=rows("area");
  assert.ok(areaRows.includes("Child"),"an open dependency stays");
  assert.ok(!areaRows.includes("Gone") && !areaRows.includes("Dropped"),"cancelled dependencies leave the 依赖 list");
  assert.ok(areaRows.some(r=>r.includes("missing")),"a deleted dependency keeps its fallback row");
  assert.ok(!areaRows.includes("Old"),"a removed dependency on a cancelled item is not shown");
  await item(p,"child").querySelector(".item-head")!.click(); await p.flush();
  const childRows=rows("child");
  assert.ok(childRows.includes("Parent"),"the parent leads the 被依赖 list");
  assert.ok(!childRows.includes("Gone"),"a cancelled dependent leaves the 被依赖 list");
});
test("tree head structure and CSS keep badges chips title and counts on one line", async () => {
  const s=snapshot(); s.items.area!.title="A very long parent title"; s.items.child!.ask={text:"Needs owner"};
  const p=await page(s,unread("item","area"));
  const row=rowOf(p,"area").children[0]!, head=wideHead(p);
  assert.ok(row.classList.contains("tree-row"),"tree rows opt into the one-line layout");
  assert.deepEqual(row.children.map(e=>e.className),["caret","item-head","counts"]);
  for (const cls of ["st","prio","item-title","newtag","waittag"]) assert.ok(head.children.some(e=>e.classList.contains(cls)),cls+" stays in the same head");
  assert.equal(head.querySelector(".item-title")!.title,s.items.area!.title);
  const css=await readFile("web/index.html","utf8");
  assert.match(css,/\.tree-row > \.item-head\s*\{[^}]*flex-wrap:\s*nowrap/);
  // Counts start at zero basis and alone receive spare space. Only after that space is gone can the head shrink.
  assert.match(css,/\.tree-row > \.item-head\s*\{[^}]*flex:\s*0 1 auto[^}]*min-width:\s*0/);
  assert.match(css,/\.tree-row > \.item-head\s*\{[^}]*width:\s*auto/);
  assert.doesNotMatch(css,/\.tree-row > \.item-head\s*\{[^}]*max-width:/,"no cap reserves residual space for counts");
  assert.match(css,/\.tree-row \.item-title\s*\{[^}]*min-width:\s*6ch[^}]*text-overflow:\s*ellipsis/);
  assert.match(css,/\.tree-row > \.item-head > :not\(\.item-title\)\s*\{[^}]*flex-shrink:\s*0/);
  assert.match(css,/\.tree-row \.counts\s*\{[^}]*flex:\s*1 0 0[^}]*max-width:\s*max-content[^}]*min-width:\s*0[^}]*overflow:\s*hidden/);
});

test("wide head click selects detail without changing the sub-item fold", async () => {
  const s=snapshot(); s.items.area!.head="Parent detail";
  const p=await page(s,[]);
  assert.ok(!rowOf(p,"child"),"the parent initially folds its sub-items");
  await selectWide(p);
  assert.ok(!rowOf(p,"child"),"selecting a head leaves sub-items folded");
  assert.ok(rowOf(p,"area").className.includes("cur"),"the selected tree row is highlighted");
  assert.match(markup(detailItem(p)!),/Parent detail/);
  await selectWide(p);
  assert.ok(detailItem(p),"clicking the selected head keeps its detail visible");
});

test("double-clicking a wide tree row folds its sub-items like the caret; a single click only selects", async () => {
  const p=await page(snapshot(),[]);
  const dbl=async (id:string)=> { const row=rowOf(p,id).children.find(e=>e.className.includes("tree-row"))!; for (const fn of row.handlers.get("dblclick") ?? []) await fn({target:row.children[1]}); await p.flush(); };
  assert.ok(!rowOf(p,"child"),"sub-items start folded");
  await selectWide(p,"area");
  assert.ok(!rowOf(p,"child"),"a single click does not unfold");
  await dbl("area");
  assert.ok(rowOf(p,"child"),"a double-click unfolds sub-items");
  await dbl("area");
  assert.ok(!rowOf(p,"child"),"a second double-click folds them again");
  await dbl("area");
  assert.equal((rowOf(p,"child").children.find(e=>e.className.includes("tree-row"))!.handlers.get("dblclick") ?? []).length,0,"a row without sub-items has no double-click action");
});

test("wide caret folds sub-items only and preserves the selected detail", async () => {
  const s=snapshot(); s.items.area!.head="Parent detail";
  const p=await page(s,[]);
  await wideCaret(p).click(); await p.flush();
  assert.ok(rowOf(p,"child"),"the caret unfolds sub-items");
  assert.ok(!rowOf(p,"area").querySelector(".body"),"unfolding never puts a body in the tree");
  assert.ok(!detailItem(p),"a caret does not select an item");
  await selectWide(p,"child"); const selected=detailItem(p,"child");
  await wideCaret(p).click(); await p.flush();
  assert.ok(!rowOf(p,"child"),"the caret folds sub-items");
  assert.equal(detailItem(p,"child"),selected,"folding an ancestor leaves its selected child's detail alone");
});

test("wide detail owns the selected body cards comments and unique DOM ids", async () => {
  const s=snapshot(); s.items.child!.head="Selected body"; s.decisions.q=card();
  s.notes.n={target:"it:child",kind:"comment",text:"Selected comment",at,state:"sent",rev:1};
  const p=await page(s,[],null,undefined,{notesOpen:{"it:child":true}});
  await wideCaret(p).click(); await p.flush(); await selectWide(p,"child");
  const d=detailItem(p,"child"); assert.ok(d,"selected item has a detail wrapper");
  assert.match(markup(d),/Selected body/); assert.match(markup(d),/如何显示/); assert.match(markup(d),/Selected comment/);
  const tree=p.roots.get("areas")!;
  assert.equal(tree.querySelectorAll(".body, .card, .notes").length,0,"the tree contains head rows only");
  assert.equal(p.all().filter(e=>e.id === "q-q").length,1); assert.equal(p.all().filter(e=>e.id === "note-n").length,1);
  const ids=p.all().map(e=>e.id).filter(Boolean); assert.equal(new Set(ids).size,ids.length,"tree and detail use unique ids");
});

test("wide n selects the stop's item and scrolls the right pane to its first fresh mark", async () => {
  const s=snapshot(), before={...s.items.child!,log:[]}; s.items.child!.log=[{at,text:"Fresh entry"}];
  const p=await page(s,unread(),before,undefined,{detailGeometry:e=>({top:e.className.includes("log-entry") ? 1800 : 50,height:e.id === "detail-it-child" ? 2400 : 100})});
  p.key("n"); await p.flush();
  assert.ok(detailItem(p,"child"),"n selects the item in the detail pane");
  assert.ok(rowOf(p,"child").className.includes("cur"),"n unfolds ancestors and highlights the target tree row");
  assert.ok(p.roots.get("item-detail")!.scrollTop>1000,"fresh mark navigation uses the independently scrolled pane");
  assert.ok(p.measurements.some(m=>m.id === "log-child-0" && m.top>1000),"the fresh log entry supplies the landing geometry");
  const landed=p.document.getElementById("log-child-0")!.getBoundingClientRect();
  assert.ok(landed.top>=0 && landed.bottom<=p.roots.get("item-detail")!.clientHeight,"the first fresh mark lands inside the right pane viewport");
  assert.ok(p.scrollY<1000,"the detail's distant mark does not scroll the tree to that offset");
});

test("wide r on a selected detail log entry reads its item and leaves sub-items unread", async () => {
  const s=snapshot(); s.items.area!.log=[{at,text:"Parent fresh log"}];
  const p=await page(s,[...unread("item","area"),...unread()]);
  await selectWide(p);
  const log=detailItem(p)?.querySelector(".log-entry"); assert.ok(log,"the log entry is in the selected detail");
  await log.click(); p.key("r"); await p.flush();
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:"item:area",through:stepId}]);
  await wideCaret(p).click(); await p.flush();
  assert.ok(rowOf(p,"child").className.includes("fresh"),"r leaves the child's own new content unread");
});

test("wide selected-item live update rerenders its detail and keeps the independent scroll", async () => {
  const s=snapshot(), frames=new Frames(); s.items.area!.head="Old detail";
  const p=await page(s,[],null,undefined,{frames}); await selectWide(p);
  const old=detailItem(p); assert.ok(old,"selected detail is rendered before the update");
  const pane=p.roots.get("item-detail")!; pane.scrollTop=425;
  p.emit("b".repeat(40),[{kind:"item",id:"area",after:{...s.items.area!,head:"Updated detail"}}]); await p.flush();
  assert.notEqual(detailItem(p),old,"selected prose update replaces the detail body");
  assert.match(markup(detailItem(p)!),/Updated detail/); assert.equal(pane.scrollTop,425);
  assert.equal(rowOf(p,"area").querySelectorAll(".body").length,0);
});

test("wide unrelated-item live update preserves the selected detail DOM identity", async () => {
  const s=snapshot(), frames=new Frames();
  s.items.picked={title:"Independent selection",group:"Project",status:"wip",priority:"P1",head:"Selected detail",updated:at,rev:1,deps:[],links:[],log:[]};
  let fresh=unread("item","picked");
  const p=await page(s,fresh,(params:URLSearchParams)=>endpoints(s,params,{...s.items[params.get("doc")!]!,head:"Earlier detail"}),undefined,{frames,response:path=>path === "/api/unread" ? reply({steps:fresh}) : undefined});
  await selectWide(p,"picked");
  const old=detailItem(p,"picked"); assert.ok(old,"the already-unread selected detail is rendered before an unrelated update");
  assert.match(markup(old),/class="chg-add"[^>]*><p>Selected detail<\/p>/,"the loaded baseline marks the changed block");
  const reads=p.calls.filter(c=>c.path === "/api/unread").length;
  fresh=[...fresh,...unread("item","area","e".repeat(40))];
  s.items.area={...s.items.area!,head:"Other detail"};
  p.emit("b".repeat(40),[{kind:"item",id:"area",after:s.items.area}]); await p.flush();
  assert.ok(p.calls.filter(c=>c.path === "/api/unread").length>reads,"the live update refreshes changed unread data");
  assert.equal(detailItem(p,"picked"),old,"adding another item's unread change never rebuilds unchanged selected unread content");
});

test("wide same-id unread parent changes reload the selected baseline and removed unread clears its marks", async () => {
  const s=snapshot(), frames=new Frames(); s.items.area!.head="Selected detail";
  let fresh=[{...unread("item","area")[0]!,parent:"a".repeat(40)}], before={...s.items.area!,head:"Original baseline"};
  const p=await page(s,fresh,(params:URLSearchParams)=>endpoints(s,params,before),undefined,{frames,response:path=>path === "/api/unread" ? reply({steps:fresh}) : undefined});
  await selectWide(p); const old=detailItem(p)!;
  assert.match(markup(old),/class="chg-add"[^>]*><p>Selected detail<\/p>/,"the first baseline marks the changed block");
  const baselines=p.calls.filter(c=>c.path.includes("kind=item&doc=area")).length;
  before={...before,head:"Selected detail"}; fresh=[{...fresh[0]!,parent:"f".repeat(40)}];
  p.emit("b".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,head:"Unrelated update"}}]); await p.flush();
  assert.ok(p.calls.filter(c=>c.path.includes("kind=item&doc=area")).length>baselines,"a changed parent reloads the baseline despite the unchanged step id");
  assert.notEqual(detailItem(p),old); assert.ok(!markup(detailItem(p)!).includes("chg-add"),"the reloaded baseline equals the current head, so nothing is marked");
  const changed=detailItem(p); fresh=[];
  p.emit("c".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,head:"Another unrelated update"}}]); await p.flush();
  assert.notEqual(detailItem(p),changed,"removing the selected item's unread data refreshes its detail");
  assert.ok(!detailItem(p)!.className.includes("fresh")); assert.ok(!markup(detailItem(p)!).includes('class="chg-add"'));
});

test("wide selected item survives reload through per-viewer localStorage", async () => {
  const storage=new Map<string,string>(), s=snapshot(); s.items.child!.head="Restored detail";
  const first=await page(s,[],null,undefined,{storage});
  await wideCaret(first).click(); await first.flush(); await selectWide(first,"child");
  const reloaded=await page(s,[],null,undefined,{storage});
  const d=detailItem(reloaded,"child"); assert.ok(d,"a fresh page restores the last selected item");
  assert.match(markup(d),/Restored detail/); assert.ok(rowOf(reloaded,"child").className.includes("cur"));
  const missing=snapshot(); delete missing.items.child;
  const removed=await page(missing,[],null,undefined,{storage});
  assert.ok(!detailItem(removed,"child"),"a removed item cannot be restored");
  assert.match(markup(removed.roots.get("item-detail")!),/点左边/);
});

test("wide dependency follow and Backspace restore the prior dependency selection", async () => {
  const p=await page(snapshot(),[]); await selectWide(p);
  const from=detailItem(p)?.querySelectorAll(".deprow").find(e=>e.dataset.sel === "dep:area@child");
  assert.ok(from,"the source dependency is rendered in the detail pane");
  await from.click(); await p.flush(); assert.ok(detailItem(p,"child"),"following a dependency selects its target");
  p.key("Backspace"); await p.flush();
  const returned=detailItem(p)?.querySelectorAll(".deprow").find(e=>e.dataset.sel === "dep:area@child");
  assert.ok(returned && returned !== from,"Back reacquires the dependency from the restored detail");
  assert.ok(returned.className.includes("cur"),"Back restores the exact dependency selection");
  assert.ok(rowOf(p,"area").className.includes("selected"),"the restored detail item remains highlighted in the tree");
});

test("wide scoped note and card updates preserve detail identity and independent scroll", async () => {
  const s=snapshot(); s.decisions.q={...card(),item:"area"}; s.items.area!.ask={text:"Approve parent"};
  let held: ReturnType<typeof deferred<FakeResponse>> | undefined;
  s.notes.n={target:"it:area",kind:"comment",text:"Old note",at,state:"sent",rev:1};
  const p=await page(s,[],null,undefined,{notesOpen:{"it:area":true},response:path=>path === "/api/draft" && held ? held.promise : undefined}); await selectWide(p);
  const d=detailItem(p), q=p.document.getElementById("q-q"); assert.ok(d,"the item detail exists before scoped updates"); assert.ok(q);
  const pane=p.roots.get("item-detail")!; pane.scrollTop=425;
  p.emit("b".repeat(40),[{kind:"note",id:"n",after:{...s.notes.n!,text:"Updated note",rev:2}}]); await p.flush();
  assert.equal(detailItem(p),d,"notes: updates replace only the comment list");
  assert.equal(p.document.getElementById("q-q"),q,"item comments do not rebuild its cards");
  assert.match(markup(d),/Updated note/); assert.equal(pane.scrollTop,425);
  p.emit("c".repeat(40),[{kind:"decision",id:"q",after:{...s.decisions.q!,question:"Updated card",rev:2}}]); await p.flush();
  assert.equal(detailItem(p),d,"card: updates replace only the affected card");
  assert.notEqual(p.document.getElementById("q-q"),q); assert.match(markup(d),/Updated card/); assert.equal(pane.scrollTop,425);
  await wideCaret(p).click(); await p.flush();
  pane.scrollTop=0; const currentCard=p.document.getElementById("q-q")!;
  await currentCard.click(); assert.ok(currentCard.className.includes("cur"),"clicking a right-pane card selects the card itself");
  p.key("j",currentCard); await p.flush();
  assert.ok(rowOf(p,"child").className.includes("cur"),"j from a detail card moves from its item's tree row");
  assert.equal(detailItem(p),d,"moving focus from a card leaves the shown detail intact");
  await currentCard.click();
  p.key("c"); await p.flush();
  assert.ok(p.document.getElementById("q-q")!.querySelector("textarea"),"c opens the clicked card's own editor");
  assert.ok(p.document.getElementById("ed-q_q"),"the editor retains the card selection key");
  assert.equal(p.document.getElementById("ed-it_area"),null,"the clicked card does not open its item's editor");
  await selectWide(p); pane.scrollTop=425;
  held=deferred<FakeResponse>();
  const approve=descendants(d).find(e=>e.dataset.answer === "approve")!;
  const approving=approve.click(); await settle();
  assert.equal(approve.disabled,true,"approval shows its busy state in the detail before acknowledgement");
  assert.ok(approve.className.includes("on")); assert.match(approve.textContent,/待发/);
  held.resolve(reply({note:{id:"approve-draft",doc:{target:"it:area",kind:"approve",text:"同意",at,state:"draft",rev:1}},deleted:[],commit:"d".repeat(40)}));
  await approving; await p.flush();
  held=deferred<FakeResponse>(); p.key("e"); await settle();
  assert.ok(detailItem(p)!.querySelector(".item-head")!.querySelector(".pendtag"),"explain patches the detail head immediately");
  assert.ok(wideHead(p).querySelector(".pendtag"),"explain also patches the tree head");
  assert.equal(wideCaret(p).querySelector(".pendtag"),null,"the pending chip never lands inside the fold toggle");
  held.resolve(reply({note:{id:"explain-draft",doc:{target:"it:area",kind:"explain",text:"请求：详细解释",at,state:"draft",rev:1}},deleted:[],commit:"e".repeat(40)}));
  await p.flush(); assert.equal(pane.scrollTop,425);
});

test("wide j and k move tree focus while Enter selects the focused head", async () => {
  const p=await page(snapshot(),[]);
  p.key("j"); await p.flush();
  assert.ok(rowOf(p,"area").className.includes("cur")); assert.ok(!detailItem(p),"j only moves focus");
  p.key("Enter"); await p.flush(); assert.ok(detailItem(p),"Enter selects the focused head's detail");
  assert.ok(!rowOf(p,"child"),"Enter does not change the sub-item fold");
  await wideCaret(p).click(); await p.flush(); const d=detailItem(p);
  p.key("j"); await p.flush(); assert.ok(rowOf(p,"child").className.includes("cur")); assert.equal(detailItem(p),d,"j does not open the next detail");
  p.key("k"); await p.flush(); assert.ok(rowOf(p,"area").className.includes("cur"));
  p.key("j"); p.key("Enter"); await p.flush(); assert.ok(detailItem(p,"child"));
  const nativeEnter=async(target:Element) => {
    target.focus(); const prevented=p.key("Enter",target);
    // Native button activation follows keydown only when the page leaves its default action intact.
    if (!prevented) await target.click(); await p.flush(); return prevented;
  };
  const childDetail=detailItem(p,"child");
  assert.equal(await nativeEnter(wideCaret(p)),false,"Enter on the fold button keeps native activation");
  assert.ok(!rowOf(p,"child"),"the focused caret folds sub-items");
  assert.equal(detailItem(p,"child"),childDetail,"caret Enter preserves the selected detail");
  await nativeEnter(wideCaret(p)); assert.ok(rowOf(p,"child"));
  await nativeEnter(wideHead(p)); assert.ok(detailItem(p),"Enter selects the actual focused head");
  await nativeEnter(wideHead(p,"child")); assert.ok(detailItem(p,"child"),"tabbing to a different head changes the Enter target");
  await selectWide(p); const stale=wideHead(p);
  p.key("j",stale); await p.flush();
  assert.equal(p.document.activeElement,wideHead(p,"child"),"j moves DOM focus away from the previously clicked head");
  await nativeEnter(p.document.activeElement!); assert.ok(detailItem(p,"child"),"Enter follows j's moved focus");
  p.key("k",p.document.activeElement!); await p.flush(); assert.ok(rowOf(p,"area").className.includes("cur"));
  assert.equal(p.document.activeElement,wideHead(p),"k moves DOM focus back to the previous head");
  p.key("c",p.document.activeElement!); await p.flush();
  assert.ok(detailItem(p),"commenting on a focused row selects its detail");
  assert.ok(detailItem(p)!.querySelector("textarea"),"the focused item's comment editor opens in the right pane");
  assert.equal(rowOf(p,"area").querySelector("textarea"),null);
});

test("wide n lands on card and note stops in the detail pane and keeps loose-card navigation", async t => {
  for (const kind of ["decision","note"] as const) await t.test(kind,async()=> {
    const s=snapshot(); s.decisions.q=card(); s.decisions.loose={...card(),item:"missing",question:"Loose card"};
    s.notes.n={target:"it:child",kind:"comment",text:"Fresh comment",at,state:"sent",rev:1};
    const id=kind === "decision" ? "q" : "n", stop=kind === "decision" ? "q-q" : "note-n";
    const p=await page(s,[...unread(kind,id),...unread("decision","loose","e".repeat(40))],null,undefined,{notesOpen:{"it:child":false},geometry:e=>({top:e.id === "q-loose" ? 1800 : 50,height:100}),detailGeometry:e=>({top:e.id === stop ? 1800 : 50,height:e.id === "detail-it-child" ? 2400 : 100})});
    p.key("n"); await p.flush(); assert.ok(detailItem(p,"child"),"the fresh stop opens its containing item's detail");
    assert.ok(detailItem(p,"child")!.contains(p.document.getElementById(stop)!));
    assert.ok(p.document.getElementById(stop)!.className.includes("cur"),"the exact card or note is selected");
    assert.ok(p.roots.get("item-detail")!.scrollTop>1000,"the card or note scrolls the independent pane");
    p.key("n"); await p.flush();
    const loose=p.document.getElementById("q-loose")!;
    assert.ok(loose.className.includes("cur")); assert.ok(!p.roots.get("item-detail")!.contains(loose),"a loose card stays in the decisions section");
    assert.ok(p.scrollY>1000,"a loose card scrolls the list");
    assert.ok(p.roots.get("page-left")!.scrollTop>1000,"the list is the left pane");
    assert.equal(p.windowScrollY,0,"the window never scrolls");
  });
});

test("wide list navigation scrolls the left pane, never the window", async () => {
  const s=snapshot(); let p!:Awaited<ReturnType<typeof page>>;
  s.items.far={title:"Far",group:"Project",status:"todo",priority:"P2",updated:at,rev:1,deps:[],links:[],log:[]};
  p=await page(s,[],null,undefined,{geometry:e=>({top:(e.id === "it-far" ? 1800 : 50)-p.scrollY,height:100})});
  const pane=p.roots.get("page-left")!;
  p.key("j"); await p.flush(); assert.equal(pane.scrollTop,0,"the first row is in view");
  p.key("j"); await p.flush();
  assert.ok(rowOf(p,"far").className.includes("cur"));
  assert.equal(pane.scrollTop,908,"j brings the row below the view to 8px above the bottom edge, in the pane");
  assert.equal(p.windowScrollY,0,"the window stays at the top");
  p.key("G"); await p.flush(); assert.equal(pane.scrollTop,9000); assert.equal(p.windowScrollY,0,"G goes to the bottom of the pane");
  p.key("g"); p.key("g"); await p.flush(); assert.equal(pane.scrollTop,0); assert.equal(p.windowScrollY,0,"gg goes to its top");
  p.key("G"); await p.flush(); await p.roots.get("to-top")!.click(); await p.flush();
  assert.equal(pane.scrollTop,0); assert.equal(p.windowScrollY,0,"the 回顶部 button scrolls the pane");
});

test("wide Back after following a dependency scrolls the list pane back to the item the reader left", async () => {
  const s=snapshot(); let p!:Awaited<ReturnType<typeof page>>;
  s.items.far={title:"Far",group:"Project",status:"todo",priority:"P2",updated:at,rev:1,deps:[],links:[],log:[]};
  s.items.area!.deps.push({id:"far",why:"needs far"});
  p=await page(s,[],null,undefined,{geometry:e=>({top:(e.id === "it-far" ? 2500 : e.id === "it-area" ? 700 : -500)-p.scrollY,height:20})});
  const pane=p.roots.get("page-left")!;
  await selectWide(p);
  const dep=p.all().find(e=>e.dataset.sel === "dep:area@far")!;
  pane.scrollTo(0,700); await p.flush(); assert.equal(pane.scrollTop,700);
  await dep.click(); await p.flush();
  assert.ok(pane.scrollTop>1000,"following the dependency scrolls the pane to its row");
  p.key("Backspace"); await p.flush();
  const top=rowOf(p,"area").getBoundingClientRect().top;
  assert.ok(top>=0 && top<1000,"Back brings the item the reader left into the pane's view"); assert.equal(p.windowScrollY,0);
});

test("wide landing in the list pins through updates until the reader scrolls the pane", async () => {
  const s=snapshot(), frames=new Frames(); s.decisions.loose={...card(),item:"missing",question:"Loose card"};
  let above=0, p!:Awaited<ReturnType<typeof page>>;
  p=await page(s,unread("decision","loose"),null,undefined,{frames,geometry:e=>({top:e.id === "q-loose" ? 1800+above-p.scrollY : 600,height:e.id === "q-loose" ? 400 : 2400})});
  const pane=p.roots.get("page-left")!, top=() => p.all().find(e=>e.id === "q-loose")!.getBoundingClientRect().top;
  p.key("n"); await p.flush(); const landed=top();
  assert.ok(pane.scrollTop>1000,"the landing scrolls the pane"); assert.equal(p.windowScrollY,0);
  above=800; p.emit("b".repeat(40),[{kind:"item",id:"area",after:{...s.items.area!,head:"Inserted above"}}]); await p.flush();
  assert.equal(top(),landed,"an update above cannot move the landed card");
  p.user("wheel"); p.user("scroll"); const released=pane.scrollTop;
  above=1000; p.emit("c".repeat(40),[{kind:"item",id:"area",after:{...s.items.area!,head:"More above"}}]); await p.flush();
  assert.equal(pane.scrollTop,released,"scrolling the pane releases the pin"); assert.equal(p.windowScrollY,0);
});

test("wide blank clicks clear the current selection while actions fall back to the displayed item", async t => {
  for (const action of ["r","a","c","e","Enter","j","k","ArrowRight","ArrowLeft","n","N"] as const) await t.test(action,async()=> {
    const s=snapshot(), fresh=[...unread("item","area"),...unread("item","child","e".repeat(40))];
    s.items.area!.ask={text:"Parent ask"}; s.items.child!.ask={text:"Child ask"}; if (action === "a") s.items.child!.status="done";
    s.items.other={title:"Following root",group:"Project",status:"todo",priority:"P2",ask:{text:"Other ask"},updated:at,rev:1,deps:[],links:[],log:[]};
    const p=await page(s,fresh,null,undefined,{geometry:e=>({top:e.id === "it-area" ? 300 : e.id === "it-child" ? 450 : e.id === "it-other" ? 600 : 50,height:100}),response:(path,input)=> {
      if (path !== "/api/archive") return undefined;
      const {id,on}=input as {id:string;on:boolean}; if (on) s.owner.archived[id]=at; else delete s.owner.archived[id];
      return reply({ok:true});
    }});
    await wideCaret(p).click(); await p.flush(); await selectWide(p,"child");
    const displayed=detailItem(p,"child"); assert.ok(displayed);
    const blank=p.document.createElement("div"); blank.focus(); await blank.click();
    assert.equal(p.all().filter(e=>e.classList.contains("cur")).length,0,"blank space clears the current item or sub-selection");
    assert.equal(detailItem(p,"child"),displayed,"clearing current leaves the displayed item intact");
    const prevented=p.key(action); await p.flush();
    if (action === "r") {
      assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:"item:child",through:"e".repeat(40)}]);
      assert.ok(rowOf(p,"area").className.includes("fresh"),"fallback read leaves the parent's own unread content alone");
    } else if (action === "a") assert.deepEqual(p.calls.filter(c=>c.path === "/api/archive").map(c=>c.body),[{id:"child",on:true}]);
    else if (action === "c") { assert.ok(p.document.getElementById("ed-it_child")); assert.equal(p.document.getElementById("ed-it_area"),null); }
    else if (action === "e") assert.equal((p.calls.find(c=>c.path === "/api/draft")!.body as {target:string}).target,"it:child");
    else if (action === "Enter") { assert.equal(prevented,true); assert.ok(rowOf(p,"child").className.includes("cur"),"Enter selects the displayed item's head after a blank click"); }
    else if (action === "j" || action === "k") {
      assert.ok(rowOf(p,action === "j" ? "other" : "area").className.includes("cur"),"tree focus starts from the displayed item's row");
      assert.equal(detailItem(p,"child"),displayed,"moving focus leaves the displayed detail intact");
    } else if (action === "ArrowRight" || action === "ArrowLeft") assert.ok(detailItem(p,action === "ArrowRight" ? "other" : "area"),"owner-work navigation starts from the displayed item's ask");
    else assert.ok(detailItem(p,action === "n" ? "area" : "child"),"fresh navigation retains its global cursor and selects its stop");
  });
});

test("an operation error shows in the bottom hint for three seconds and leaves the connection banner alone", async () => {
  const clock=new FakeClock(), s=snapshot(), failing=(path:string)=> path === "/api/archive" ? {ok:false,status:400,json:async()=>({error:"Archive refused"})} as FakeResponse : undefined;
  s.items.child!.status="done";
  const p=await page(s,unread("item","area"),null,undefined,{clock,response:failing});
  const hint=p.roots.get("hint")!, banner=p.roots.get("server-banner")!;
  p.key("n"); await p.flush(); p.key("a"); await p.flush();
  assert.equal(p.calls.filter(c=>c.path === "/api/archive").length,1,"the failing write was attempted");
  assert.equal(hint.hidden,false); assert.equal(hint.textContent,"Archive refused");
  assert.equal(banner.hidden,true,"an operation error is an event, not the connection state"); assert.equal(banner.textContent,"");
  clock.advance(2999); assert.equal(hint.hidden,false,"the hint is still showing just before three seconds");
  clock.advance(1); assert.equal(hint.hidden,true,"the hint leaves by itself after three seconds");
  assert.equal(banner.hidden,true);
});

test("a archives only done or cancelled items: an open item makes no archive call and shows the reason", async () => {
  const s=snapshot(), archive=(path:string)=> path === "/api/archive" ? reply({ok:true}) : undefined;
  const p=await page(s,unread("item","area"),null,undefined,{response:archive});
  p.key("n"); await p.flush(); p.key("a"); await p.flush();
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/archive"),[],"a wip parent is not archived");
  assert.equal(p.roots.get("hint")!.hidden,false); assert.equal(p.roots.get("hint")!.textContent,"只有完成或取消的条目能归档");
  const d=snapshot(); d.items.child!.status="done";
  const q=await page(d,unread("item","area"),null,undefined,{response:archive});
  q.key("n"); await q.flush(); q.key("a"); await q.flush();
  assert.deepEqual(q.calls.filter(c=>c.path === "/api/archive").map(c=>c.body),[{id:"area",on:true}],"a parent whose sub-items are all done archives");
});

test("a archives a cancelled item", async () => {
  const s=snapshot(), archive=(path:string)=> path === "/api/archive" ? reply({ok:true}) : undefined;
  s.items.child!.status="cancelled";
  const p=await page(s,unread("item","area"),null,undefined,{response:archive});
  p.key("n"); await p.flush(); p.key("a"); await p.flush();
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/archive").map(c=>c.body),[{id:"area",on:true}],"a parent whose sub-items are all cancelled archives");
  assert.notEqual(p.roots.get("hint")!.textContent,"只有完成或取消的条目能归档");
});

test("an archived cancelled item shows under 已归档 and not under 取消", async () => {
  const s=snapshot(); s.items.child!.status="cancelled";
  const archive=(path:string,input:unknown)=> { if (path !== "/api/archive") return undefined; const {id,on}=input as {id:string;on:boolean}; if (on) s.owner.archived[id]="2999-01-01T00:00:00Z"; else delete s.owner.archived[id]; return reply({ok:true}); };
  const p=await page(s,unread("item","area"),null,undefined,{response:archive});
  p.key("n"); await p.flush(); p.key("a"); await p.flush();
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/archive").map(c=>c.body),[{id:"area",on:true}]);
  assert.ok(!p.all().some(e=>e.id === "it-area"),"the archived cancelled item leaves the default tree");
});

test("a on an item inside an archived subtree un-archives the nearest archived ancestor", async () => {
  const s=snapshot(); s.owner.archived.area="2999-01-01T00:00:00Z";
  const p=await page(s,[],null,undefined,{response:(path,input)=> {
    if (path !== "/api/archive") return undefined;
    const {id,on}=input as {id:string;on:boolean}; if (on) s.owner.archived[id]="2999-01-01T00:00:00Z"; else delete s.owner.archived[id];
    return reply({ok:true});
  }});
  await p.all().find(e=>e.tagName === "BUTTON" && e.innerHTML.startsWith("已归档"))!.click(); await p.flush();
  await expand(p,"area"); assert.ok(item(p,"child"),"the archived subtree shows under 已归档");
  await item(p,"child").querySelector(".item-head")!.click(); await p.flush();
  p.key("a"); await p.flush();
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/archive").map(c=>c.body),[{id:"area",on:false}],"the child is not archived; its archived ancestor is restored");
  assert.equal(p.roots.get("server-banner")!.hidden,true);
});

test("LEGACY PRIORITY: an unmigrated item raised by a waiter shows its written priority struck; a migrated raise shows only the higher one", async () => {
  for (const migratedWaiter of [false, true]) {
    const s = snapshot();
    s.board.projects = [{ name: "Project" }, { name: "Elsewhere", ...(migratedWaiter ? { migrated: true } : {}) }];
    s.items.waiter = { title: "Waiter", group: migratedWaiter ? "Elsewhere" : "Project", status: "todo", priority: "P0", updated: at, rev: 1, deps: [{ id: "child", why: "Needs child" }], links: [], log: [] };
    const p = await page(s, []); await expand(p);
    const head = descendants(item(p)).find(e => e.className === "item-head")!, badge = head.children.find(e => e.className.split(" ").includes("prio"))!;
    assert.equal(badge.innerHTML, "P0", String(migratedWaiter));
    const was = head.children.find(e => e.className === "prio-was");
    if (migratedWaiter) { assert.equal(was, undefined); assert.ok(!markup(item(p)).includes("按 P0 排")); }
    else { assert.equal(was!.innerHTML, "P1"); assert.equal(badge.title, "写的是 P1；因为「Waiter」(P0) 在等它"); assert.ok(markup(item(p)).includes("按 P0 排：写的是 P1，因为 ")); }
  }
});

// Glossary links: each project's glossary; the anchor a term link leads to, as the page names it.
function glossaries(s: Snapshot) {
  const term = (term: string, definition: string, by: string) => ({ term, definition, updated: at, by });
  s.board.projects.push({ name: "Other", migrated: true });
  s.glossaries = {
    Project: { terms: [term("否决线", "本项目的否决线", "Project"), term("否决", "本项目的否决", "Project")], rev: 1 },
    Other: { terms: [term("孪生对照", "同一构建的第二份副本", "Other"), term("否决线", "另一项目的否决线", "Other")], rev: 1 },
  };
  return s;
}
const anchor = (project: string, term: string) => "#term-" + encodeURIComponent(JSON.stringify([project, term]));
const termLinks = (html: string) => [...html.matchAll(/<a class="term" href="([^"]+)">([^<]*)<\/a>/g)].map(m => [m[2], m[1]]);
test("glossary links: only the first occurrence of a term in an item's head and log links, and the longest term wins", async () => {
  const s = glossaries(snapshot());
  s.items.child!.head = "否决线定了。否决线再提一次。否决单独出现。";
  s.items.child!.log = [{ at, by: "Project", text: "否决线在进展里不再链接；孪生对照第一次出现，孪生对照第二次不链接" }];
  const p = await page(s, []); await expand(p);
  const body = descendants(item(p)), head = body.find(e => e.className === "rich")!, log = body.find(e => e.className === "log-entry")!;
  assert.equal(head.innerHTML, '<p><a class="term" href="' + anchor("Project", "否决线") + '">否决线</a>定了。否决线再提一次。<a class="term" href="' + anchor("Project", "否决") + '">否决</a>单独出现。</p>',
    "the second 否决线 is not linked, and neither is the 否决 inside it");
  assert.deepEqual(termLinks(markup(log)), [["孪生对照", anchor("Other", "孪生对照")]], "a term the head already linked is not linked again in the log");
});

test("glossary links: none inside code spans, code blocks or links, and the text's own project's term wins", async () => {
  const s = glossaries(snapshot());
  s.items.child!.head = "`否决线` 在代码里，[否决线](https://example.com/x) 在链接里。\n\n```\n否决线\n```\n\n最后 否决线。";
  s.items.x = { title: "Other area", group: "Other", priority: "P1", status: "todo", head: "否决线 & 孪生对照", updated: at, rev: 1, deps: [], links: [], log: [] };
  const p = await page(s, []); await expand(p);
  const head = descendants(item(p)).find(e => e.className === "rich")!.innerHTML;
  assert.deepEqual(termLinks(head), [["否决线", anchor("Project", "否决线")]]);
  assert.match(head, /<p>最后 <a class="term"[^>]*>否决线<\/a>。<\/p>$/);
  await item(p, "x").querySelector(".item-head")!.click(); await setImmediate();
  const other = descendants(item(p, "x")).find(e => e.className === "rich")!.innerHTML;
  assert.deepEqual(termLinks(other), [["否决线", anchor("Other", "否决线")], ["孪生对照", anchor("Other", "孪生对照")]], "an item of Other links Other's 否决线");
  assert.match(other, /<\/a> &amp; <a /, "escaped text between terms stays intact");
});

test("glossary links: each card and each note with its reply is its own text, and a term click opens its definition without choosing the option", async () => {
  const s = glossaries(snapshot());
  s.items.child!.head = "否决线";
  s.decisions.q = { ...card(), question: "否决线怎么定？", background: "否决线背景", options: [{ key: "A", text: "提高否决线" }, { key: "B", text: "否决" }] };
  s.notes.n = { target: "it:child", kind: "comment", text: "否决线是什么？", at, state: "done", reply: "否决线和否决都解释了", repliedAt: at, rev: 1 };
  const p = await page(s, [], null, undefined, { notesOpen: { "it:child": true } }); await expand(p);
  const cardBox = p.all().find(e => e.id === "q-q")!, note = descendants(item(p)).find(e => e.className.split(" ").includes("note"))!;
  assert.deepEqual(termLinks(markup(cardBox)), [["否决线", anchor("Project", "否决线")], ["否决", anchor("Project", "否决")]], "a card links its question's term once, and its options only a new term");
  assert.deepEqual(termLinks(markup(note)), [["否决线", anchor("Project", "否决线")], ["否决", anchor("Project", "否决")]], "a note and its reply are one text");
  // A link rendered inside an option button, clicked as a browser would, bubbling to the button: the page shows the
  // definition, and the button's own handler does not run.
  const button = option(p, "B"), link = termLink(p, "Project", "否决"); button.appendChild(link);
  await link.click(); await p.flush();
  assert.match(markup(popovers(p)[0]!), /否决[\s\S]*本项目的否决/, "the popover shows the term and its definition");
  assert.equal(p.calls.filter(c => c.path === "/api/draft").length, 0, "clicking the term chooses no option");
  assert.ok(!p.all().some(e => e.id === "backbtn" && !e.hidden), "a term link navigates nowhere, so there is nothing to come back from");
  await button.click(); await p.flush();
  assert.equal(p.calls.filter(c => c.path === "/api/draft").length, 1, "the option itself still chooses");
});

function termLink(p: Awaited<ReturnType<typeof page>>, project: string, term: string) {
  const link = p.document.createElement("a");
  link.className = "term"; link.setAttribute("href", anchor(project, term)); link.bubbleClick = true;
  return link;
}
const popovers = (p: Awaited<ReturnType<typeof page>>) => p.all().filter(e => e.className.split(" ").includes("termpop"));
const boldTerm = (e: Element) => /^<strong>([^<]*)<\/strong> /.exec(e.innerHTML)?.[1];

test("glossary links: a term click opens one popover with that project's definition; another term, Escape, an outside click and a scroll close or replace it", async () => {
  const s = glossaries(snapshot());
  const p = await page(s, []);
  const host = p.roots.get("sendbox")!, outside = p.document.createElement("div"), plain = p.document.createElement("button");
  const first = termLink(p, "Project", "否决线"), second = termLink(p, "Other", "否决线"), third = termLink(p, "Other", "孪生对照");
  for (const e of [first, second, third, outside, plain]) host.appendChild(e);
  assert.equal(popovers(p).length, 0, "no popover before a click");
  await first.click(); await p.flush();
  assert.equal(popovers(p).length, 1);
  assert.equal(boldTerm(popovers(p)[0]!), "否决线", "the term is bold");
  assert.ok(markup(popovers(p)[0]!).includes("本项目的否决线") && !markup(popovers(p)[0]!).includes("另一项目"), "the definition is the project named in the link");
  assert.equal(p.windowScrollY, 0, "the page does not scroll"); assert.equal(p.scrolls.length, 0);
  await second.click(); await p.flush();
  assert.equal(popovers(p).length, 1, "only one popover at a time");
  assert.ok(markup(popovers(p)[0]!).includes("另一项目的否决线") && !markup(popovers(p)[0]!).includes("本项目"), "the other project's definition replaces it");
  await popovers(p)[0]!.click(); await p.flush();
  assert.equal(popovers(p).length, 1, "a click inside the popover keeps it");
  p.key("Escape"); await p.flush();
  assert.equal(popovers(p).length, 0, "Escape closes it");
  await third.click(); await p.flush(); assert.equal(popovers(p).length, 1);
  assert.ok(markup(popovers(p)[0]!).includes("同一构建的第二份副本"));
  await outside.click(); await p.flush();
  assert.equal(popovers(p).length, 0, "a click elsewhere closes it");
  await third.click(); await p.flush(); assert.equal(popovers(p).length, 1);
  p.key("j"); await p.flush(); assert.equal(popovers(p).length, 1, "other keys leave it");
  p.user("scroll"); await p.flush();
  assert.equal(popovers(p).length, 0, "scrolling closes it");
  await plain.click(); await p.flush(); assert.equal(popovers(p).length, 0, "an outside click with nothing open does nothing");
});

test("glossary links: the popover escapes the definition and its term, and a term gone from the glossary opens nothing", async () => {
  const s = glossaries(snapshot());
  s.glossaries.Project!.terms.push({ term: "<b>x</b>", definition: '<img src=x onerror=alert(1)> & "quoted"', updated: at, by: "Project" });
  const p = await page(s, []);
  const link = termLink(p, "Project", "<b>x</b>"), gone = termLink(p, "Project", "已删除"), unknown = termLink(p, "Nowhere", "否决线");
  for (const e of [link, gone, unknown]) p.roots.get("sendbox")!.appendChild(e);
  await link.click(); await p.flush();
  const html = descendants(popovers(p)[0]!).map(e => e.innerHTML).join("\n");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;") && html.includes("&lt;b&gt;x&lt;/b&gt;"), "markup in the definition and the term is escaped");
  assert.ok(!html.includes("<img") && !html.includes("<b>"));
  await gone.click(); await p.flush(); assert.equal(popovers(p).length, 0, "a term no longer in the glossary shows nothing");
  await link.click(); await unknown.click(); await p.flush(); assert.equal(popovers(p).length, 0, "an unknown project shows nothing, and closes the one before");
});

test("the page has no glossary section", async () => {
  const html = await readFile("web/index.html", "utf8");
  assert.ok(!/id="glossary"|id="terms|class="glossary"|术语/.test(html), "index.html has no glossary markup");
  assert.ok(!/\.glossary|#terms/.test(html), "index.html has no glossary styles");
  const s = glossaries(snapshot()); s.items.child!.head = "否决线";
  const p = await page(s, []); await expand(p);
  assert.equal(p.document.getElementById("glossary"), null);
  assert.equal(p.document.getElementById("terms"), null);
  assert.equal(p.all().filter(e => ["DL", "DT", "DD"].includes(e.tagName)).length, 0, "no term list is rendered, though a glossary exists");
  await p.change("b".repeat(40), [{ kind: "glossary", id: "Project", after: { terms: [{ term: "孪生对照", definition: "定义", updated: at, by: "Project" }], rev: 2 } }]); await p.flush();
  assert.equal(p.all().filter(e => ["DL", "DT", "DD"].includes(e.tagName)).length, 0, "nor after a glossary change");
});

test("glossary links follow a live glossary change", async () => {
  const s = snapshot(); s.items.child!.head = "孪生对照";
  const p = await page(s, []); await expand(p);
  assert.deepEqual(termLinks(markup(item(p))), []);
  await p.change("b".repeat(40), [{ kind: "glossary", id: "Project", after: { terms: [{ term: "孪生对照", definition: "定义", updated: at, by: "Project" }], rev: 1 } }]); await p.flush();
  assert.deepEqual(termLinks(markup(item(p))), [["孪生对照", anchor("Project", "孪生对照")]]);
  const link = termLink(p, "Project", "孪生对照"); p.roots.get("sendbox")!.appendChild(link);
  await link.click(); await p.flush();
  assert.ok(markup(popovers(p)[0]!).includes("定义"), "the popover reads the changed glossary");
});

// References with # and the / search: items and decision cards found by title.
function linked(): Snapshot {
  const s = snapshot(); s.decisions.q = card();
  s.items.shipped = { title: "已交付 Alpha", group: "Project", status: "done", priority: "P2", updated: at, rev: 1, deps: [], links: [], log: [] };
  s.items.dropped = { title: "取消的 Beta", parent: "area", status: "cancelled", priority: "P2", updated: at, rev: 1, deps: [], links: [], log: [] };
  return s;
}
const classes = (e: Element) => e.className.split(" ");
const rowTitle = (e: Element) => e.innerHTML.match(/class="t">([^<]*)</)![1]!;
async function composer(snap: Snapshot = linked()) {
  const p = await page(snap, [], null, undefined, { response: path => path === "/api/notes" ? reply({ id: "saved" }) : undefined });
  await expand(p); p.key("c"); await p.flush();
  const ta = p.all().find(e => e.id === "ed-it_child")!;
  const type = async (text: string) => { ta.value = text; ta.setSelectionRange(text.length, text.length); await ta.handlers.get("input")![0]!({}); };
  const pop = () => p.all().find(e => e.className === "refpop");
  const options = () => pop() ? descendants(pop()!).filter(e => classes(e).includes("refopt")) : [];
  return { p, ta, type, pop, options, titles: () => options().map(rowTitle) };
}
const noteCalls = (p: Awaited<ReturnType<typeof page>>) => p.calls.filter(c => c.path === "/api/notes");

test("typing # in a comment lists the matching items and cards; Enter inserts the token and the note is saved with it", async () => {
  const { p, ta, type, pop, options, titles } = await composer();
  await type("见 #");
  assert.deepEqual(titles(), ["Parent", "Child", "已交付 Alpha", "取消的 Beta", "如何显示？"], "every item, done and cancelled ones too, and the card, in board order");
  await type("见 #ALPHA");
  assert.deepEqual(titles(), ["已交付 Alpha"], "matching ignores case");
  assert.match(options()[0]!.innerHTML, /^<span class="st done">DONE<\/span>.*<span class="where">Project<\/span>$/, "a row names the status and the project");
  const prevented = p.key("Enter", ta);
  assert.equal(prevented, true, "Enter chooses instead of saving");
  assert.equal(ta.value, "见 [[it:shipped]]"); assert.equal(pop(), undefined, "choosing closes the popup");
  assert.equal(noteCalls(p).length, 0, "choosing saved nothing");
  p.key("Enter", ta); await settle();
  assert.deepEqual(noteCalls(p).map(c => c.body), [{ target: "it:child", text: "见 [[it:shipped]]", kind: "comment" }], "the stored text keeps the key, not the title");
});

test("# popup: Chinese search finds a card, arrows wrap, a click inserts, Esc closes only the popup", async () => {
  const { p, ta, type, pop, options, titles } = await composer();
  await type("#显示"); assert.deepEqual(titles(), ["如何显示？"]);
  assert.match(options()[0]!.innerHTML, /asktag">决策卡<\/span>.*<span class="where">Project › Child<\/span>$/, "a card row shows its state and the item holding it");
  p.key("Enter", ta); assert.equal(ta.value, "[[q:q]]", "a card token carries its own prefix");
  await type("#"); assert.ok(classes(options()[0]!).includes("sel"));
  p.key("ArrowDown", ta); assert.ok(classes(options()[1]!).includes("sel") && !classes(options()[0]!).includes("sel"));
  p.key("ArrowUp", ta); p.key("ArrowUp", ta); assert.ok(classes(options().at(-1)!).includes("sel"), "up from the first row wraps to the last");
  p.key("Enter", ta); assert.equal(ta.value, "[[q:q]]");
  await type("a #取消"); await options()[0]!.click();
  assert.equal(ta.value, "a [[it:dropped]]", "a mouse click inserts too, over the #query only"); assert.equal(pop(), undefined);
  await type("#"); assert.ok(pop());
  assert.equal(p.key("Escape", ta), true); assert.equal(pop(), undefined, "Esc closes the popup");
  assert.ok(p.all().some(e => e.id === "ed-it_child"), "the editor stays open after the first Esc");
  p.key("Escape", ta); await p.flush();
  assert.ok(!p.all().some(e => e.id === "ed-it_child"), "a second Esc cancels the comment as before");
  assert.equal(noteCalls(p).length, 0);
});

test("a # glued to a word, or with no match, opens no popup and Enter still saves", async () => {
  const { p, ta, type, pop } = await composer();
  await type("see Whitefoot#341"); assert.equal(pop(), undefined, "Repo#341 is a pull request reference");
  await type("#zzzz"); assert.equal(pop(), undefined, "no match, no popup");
  p.key("Enter", ta); await settle();
  assert.deepEqual(noteCalls(p).map(c => (c.body as { text: string }).text), ["#zzzz"], "the text is saved as typed");
});

test("a reference token renders the target's current title as a link and a missing target as its struck key, everywhere text renders", async () => {
  const s = linked(); s.items.other = { title: "Other root", group: "Project", status: "todo", priority: "P2", updated: at, rev: 1, deps: [], links: [], log: [] };
  s.notes.n = { target: "it:child", kind: "comment", text: "看 [[it:area]] 和 [[q:q]]，还有 [[it:gone]]、[[q:gone]] 与 `[[it:area]]`\n\n| 列 |\n| --- |\n| [[it:other]] |", at, state: "done", reply: "回复 [[it:area]]", repliedAt: at, rev: 1 };
  s.items.child!.log = [{ at, by: "Project", text: "见 [[it:area]]" }]; s.items.child!.head = "头部 [[it:area]]";
  const p = await page(s, [], null, undefined, { notesOpen: { "it:child": true } }); await expand(p);
  const area = '<a class="itemref" href="#" data-ref="it:area">Parent</a>';
  const note = markup(p.all().find(e => e.id === "note-n")!);
  assert.ok(note.includes("看 " + area), "the item link");
  assert.ok(note.includes('<a class="itemref" href="#" data-ref="q:q">如何显示？</a>'), "the card link shows the card's question");
  assert.ok(note.includes('<span class="itemref missing" title="没有这个条目：gone">gone</span>') && note.includes('<span class="itemref missing" title="没有这张决策卡：gone">gone</span>'), "a missing item or card shows its key");
  assert.ok(note.includes("<code>[[it:area]]</code>"), "a code span keeps the token as typed");
  assert.match(note, /<td><a class="itemref"[^>]*data-ref="it:other">Other root<\/a><\/td>/, "tables render the link in their cells");
  assert.ok(note.includes("回复 " + area), "a reply renders it");
  assert.ok(markup(p.all().find(e => e.className === "log-entry")!).includes("见 " + area), "a log entry renders it");
  assert.ok(markup(item(p)).includes("头部 " + area), "so does an item's head");
  // The title is read when the page renders, so a rename shows at once and a deleted target turns invalid.
  await p.change("b".repeat(40), [{ kind: "item", id: "area", after: { ...s.items.area!, title: "Renamed parent" } }]); await p.flush();
  assert.ok(markup(p.all().find(e => e.id === "note-n")!).includes('data-ref="it:area">Renamed parent</a>'), "a renamed item shows its current title");
  await p.change("c".repeat(40), [{ kind: "item", id: "other", after: null }]); await p.flush();
  assert.ok(markup(p.all().find(e => e.id === "note-n")!).includes('<span class="itemref missing" title="没有这个条目：other">other</span>'), "a deleted item turns invalid");
  await p.change("d".repeat(40), [{ kind: "item", id: "other", after: s.items.other }]); await p.flush();
  assert.ok(markup(p.all().find(e => e.id === "note-n")!).includes('data-ref="it:other">Other root</a>'), "and valid again when it returns");
});

test("clicking a reference selects its item with its ancestors unfolded, or its card, and Back returns", async () => {
  const s = linked(); s.items.other = { title: "Other root", group: "Project", status: "todo", priority: "P2", updated: at, rev: 1, deps: [], links: [], log: [] };
  s.items.otherKid = { title: "Other kid", parent: "other", status: "todo", priority: "P2", updated: at, rev: 1, deps: [], links: [], log: [] };
  s.notes.n = { target: "it:child", kind: "comment", text: "去 [[it:otherKid]] 或 [[q:q]]", at, state: "done", reply: "ok", repliedAt: at, rev: 1 };
  const p = await page(s, [], null, undefined, { notesOpen: { "it:child": true } }); await expand(p);
  assert.ok(!p.all().some(e => e.id === "it-otherKid"), "the target is under a folded parent");
  const ref = (key: string) => { const a = p.document.createElement("a"); a.className = "itemref"; a.setAttribute("data-ref", key); a.bubbleClick = true; p.roots.get("sendbox")!.appendChild(a); return a; };
  await ref("it:otherKid").click(); await p.flush();
  assert.ok(detailItem(p, "otherKid"), "the item is shown in the detail column");
  assert.ok(rowOf(p, "otherKid").className.includes("selected"), "and selected in the tree, its parent unfolded");
  assert.equal(p.all().find(e => e.id === "backbtn")!.hidden, false);
  p.key("Backspace"); await p.flush();
  assert.ok(detailItem(p, "child"), "Back returns to the item the reader left");
  await ref("q:q").click(); await p.flush();
  assert.ok(p.all().find(e => e.id === "q-q")!.className.includes("cur"), "a card reference shows and selects the card");
  await ref("it:gone").click(); await p.flush();
  assert.ok(detailItem(p, "child"), "a reference to nothing goes nowhere");
});

test("/ opens a search over every item and card by title, done and cancelled ones included, and Esc closes it", async () => {
  const p = await page(linked(), []);
  const box = () => p.document.getElementById("search"), input = () => p.document.getElementById("search-input")!;
  const rows = () => p.all().filter(e => classes(e).includes("searchrow"));
  const type = async (text: string) => { input().value = text; await input().handlers.get("input")![0]!({}); };
  assert.equal(box(), null);
  assert.equal(p.key("/"), true); assert.ok(box(), "/ opens the box");
  assert.equal(p.document.activeElement, input(), "the search field has the focus");
  assert.deepEqual(rows().map(rowTitle), ["Parent", "Child", "已交付 Alpha", "取消的 Beta", "如何显示？"], "an empty query lists everything");
  await type("alpha"); assert.deepEqual(rows().map(rowTitle), ["已交付 Alpha"], "a done item is found");
  assert.equal(rows()[0]!.innerHTML, '<span class="st done">DONE</span><span class="t">已交付 Alpha</span><span class="where">Project</span>', "a row shows status, title, project and no parent for a root");
  await type("取消"); assert.equal(rows()[0]!.innerHTML, '<span class="st cancelled">DROP</span><span class="t">取消的 Beta</span><span class="where">Project › Parent</span>', "a cancelled item is found, with its parent's title");
  await type("CHILD"); assert.equal(rows()[0]!.innerHTML, '<span class="st wip">WIP</span><span class="t">Child</span><span class="where">Project › Parent</span>');
  await type("显示"); assert.match(rows()[0]!.innerHTML, /^<span class="asktag">决策卡<\/span><span class="t">如何显示？<\/span><span class="where">Project › Child<\/span>$/, "a card shows its state and the item holding it");
  await type("没有这样的标题"); assert.equal(rows().length, 0); assert.ok(markup(box()!).includes("没有匹配"));
  p.key("/", input()); assert.equal(p.all().filter(e => e.id === "search").length, 1, "/ typed in the field is text, and opens no second box");
  p.key("Escape", input()); assert.equal(box(), null, "Esc closes it");
  p.key("/"); assert.ok(box()); p.press(1, 1, false); assert.equal(box(), null, "a press outside closes it");
});

test("a search jump remembers where the reader was, so Back returns, as after a reference click", async () => {
  const p = await page(linked(), []); await expand(p);
  const input = () => p.document.getElementById("search-input")!, rows = () => p.all().filter(e => classes(e).includes("searchrow"));
  const type = async (text: string) => { input().value = text; await input().handlers.get("input")![0]!({}); };
  assert.ok(detailItem(p, "child"));
  p.key("/"); await type("alpha"); p.key("Enter", input()); await p.flush();
  assert.ok(detailItem(p, "shipped"), "the search jumped away");
  assert.equal(p.all().find(e => e.id === "backbtn")!.hidden, false, "the 返回 button shows after a search jump");
  p.key("Backspace"); await p.flush();
  assert.ok(detailItem(p, "child"), "Back returns to the item the reader left");
  p.key("/"); await type("alpha"); await rows()[0]!.click(); await p.flush();
  assert.ok(detailItem(p, "shipped"));
  p.key("Backspace"); await p.flush();
  assert.ok(detailItem(p, "child"), "Back also returns from a clicked search row");
});

test("search: arrows and Enter jump to the item with its ancestors unfolded, even a cancelled one; a click jumps too", async () => {
  const p = await page(linked(), []);
  const input = () => p.document.getElementById("search-input")!, rows = () => p.all().filter(e => classes(e).includes("searchrow"));
  const type = async (text: string) => { input().value = text; await input().handlers.get("input")![0]!({}); };
  p.key("/"); assert.ok(classes(rows()[0]!).includes("sel"));
  p.key("ArrowDown", input()); assert.ok(classes(rows()[1]!).includes("sel") && !classes(rows()[0]!).includes("sel"));
  p.key("ArrowUp", input()); p.key("ArrowUp", input()); assert.ok(classes(rows().at(-1)!).includes("sel"), "up from the first row wraps to the last");
  p.key("ArrowDown", input()); p.key("ArrowDown", input()); p.key("Enter", input()); await p.flush();
  assert.equal(p.document.getElementById("search"), null, "jumping closes the box");
  assert.ok(detailItem(p, "child"), "the second row, Child, is shown in the detail column");
  assert.ok(rowOf(p, "child").className.includes("selected"), "its ancestors are unfolded and its row selected");
  p.key("/"); await type("取消"); p.key("Enter", input()); await p.flush();
  assert.ok(detailItem(p, "dropped"), "a cancelled item hidden from the tree is shown");
  assert.ok(rowOf(p, "dropped").className.includes("selected"));
  p.key("/"); await type("显示"); await rows()[0]!.click(); await p.flush();
  assert.equal(p.document.getElementById("search"), null);
  assert.ok(detailItem(p, "child") && p.all().find(e => e.id === "q-q")!.className.includes("cur"), "a card result shows its item and selects the card");
  p.key("/"); await type("alpha"); p.key("Enter", input()); await p.flush();
  assert.ok(detailItem(p, "shipped") && rowOf(p, "shipped").className.includes("selected"), "a done item is reachable");
});

test("/ is ignored while typing in a text field, a text area or editable content", async () => {
  const p = await page(linked(), []);
  const field = p.document.createElement("input"); field.type = "text";
  const area = p.document.createElement("textarea");
  const editable = p.document.createElement("div"); (editable as Element & { isContentEditable: boolean }).isContentEditable = true;
  for (const target of [field, area, editable]) { assert.equal(p.key("/", target), false, target.tagName + " keeps the key"); assert.equal(p.document.getElementById("search"), null); }
  const box = p.document.createElement("input"); box.type = "checkbox";
  assert.equal(p.key("/", box), true, "a focused checkbox does not swallow it"); assert.ok(p.document.getElementById("search"));
  p.key("Escape", p.document.getElementById("search-input")!);
  assert.equal(p.key("/", p.document.createElement("button")), true, "nor does a button");
});

test("the keyboard help lists the search key", async () => {
  const p = await page(snapshot(), []);
  assert.ok(p.all().some(e => e.className === "keymenu-row" && e.innerHTML.includes("<kbd>/</kbd>")), "the ☰ menu has a / row");
  await p.all().find(e => e.className === "keymenu-row" && e.innerHTML.includes("<kbd>/</kbd>"))!.click();
  assert.ok(p.document.getElementById("search"), "and its row opens the search");
});

// Owner waits: blocking (purple) and non-blocking (red), the 等你 panel and the 要你知道 list.
function waitSnapshot(): Snapshot {
  const s=snapshot();
  s.items.hot={title:"Hot",group:"Project",priority:"P0",ask:{text:"Hot ask"},updated:"2026-10-02T00:00:00Z",rev:1,deps:[],links:[],log:[]};
  s.decisions.old={...card(),question:"旧的问题",blocks:"#398 合并停着",at:"2026-10-01T00:00:00Z"};
  s.decisions.newer={...card(),question:"较新的问题",blocks:"发布停着",at:"2026-10-03T00:00:00Z"};
  s.decisions.plain={...card(),question:"不挡工作的问题"};
  return s;
}
const summaryText=(p:Awaited<ReturnType<typeof page>>)=>descendants(p.roots.get("summary")!);
test("top controls: purple 阻塞 and red 决策卡 counters lead their row, with no 待看 or 视图 label", async () => {
  const p=await page(waitSnapshot(),[]), sum=p.roots.get("summary")!;
  const row1=sum.children[0]!;
  assert.deepEqual(row1.children.map(e=>e.innerHTML),["阻塞 3 ›","决策卡 1 ›"],"hot ask and two blocking cards; one plain card");
  assert.equal(row1.children[0]!.className,"sbtn s-block"); assert.equal(row1.children[1]!.className,"sbtn s-wait");
  const text=summaryText(p).map(e=>e.innerHTML+e.textContent).join("|");
  assert.ok(!text.includes("待看") && !text.includes("视图") && !text.includes("等你处理"));
  assert.ok(!sum.children.some(e=>e.className === "sum-row" && e.children[0]?.innerHTML === "待看"));
  await button(p,"决策卡 1 ›").click(); await p.flush();
  assert.ok(p.all().find(e=>e.id === "q-plain")?.className.includes("cur"),"决策卡 starts at the first non-blocking card, after every blocking one");
});
test("top controls: 阻塞 steps to the first blocking wait and an empty kind shows no counter", async () => {
  const s=snapshot(); s.decisions.plain={...card(),question:"不挡工作的问题"};
  const p=await page(s,[]);
  assert.ok(!p.all().some(e=>e.innerHTML.startsWith("阻塞 ")),"no blocking wait, no 阻塞 counter");
  assert.ok(!p.all().some(e=>e.id === "wait-panel"),"no blocking wait, no panel");
  assert.ok(p.all().some(e=>e.innerHTML === "决策卡 1 ›"));
  const t=waitSnapshot(), q=await page(t,[]);
  await button(q,"阻塞 3 ›").click(); await q.flush();
  assert.ok(q.all().some(e=>e.id === "detail-it-hot"),"the first blocking wait is the ask on the P0 item, which opens in the detail");
});
test("top controls: 未读 labels the second row with 进展, 其他 and 全部已阅; 评论回复 sits in the first row; the view row has no label", async () => {
  const s=snapshot(); s.notes.r={target:"it:child",kind:"comment",text:"c",at,state:"done",reply:"re",repliedAt:at,repliedBy:"Project",rev:1};
  const docs=[{kind:"item",id:"child",summary:"+1 log",pieces:{log:1,reply:0,other:1}},{kind:"note",id:"r",summary:"new reply",pieces:{log:0,reply:1,other:0}}];
  const p=await page(s,[{id:stepId,commits:[stepId],author:"A",at,docs}]);
  const rows=p.roots.get("summary")!.children;
  const labels=rows.map(r=>r.children[0]?.className === "sum-k" ? r.children[0]!.innerHTML : "");
  assert.deepEqual(rows.map(r=>r.className),["sum-row","sum-row","sum-row"]);
  assert.deepEqual(labels,["","未读",""]);
  assert.ok(rows[0]!.children.some(e=>e.innerHTML === "评论回复 1") && rows[0]!.children.some(e=>e.innerHTML.startsWith("新 ")));
  assert.equal(rows[1]!.children.map(e=>e.innerHTML).filter(h=>/^(进展|其他)/.test(h)).length,2);
  assert.ok(rows[1]!.children.some(e=>e.innerHTML === "全部已阅"));
  assert.deepEqual(rows[2]!.children.slice(0,2).map(e=>e.innerHTML),["全部折叠","展开第一层"]);
  assert.equal(rows[2]!.children.at(-1)!.className,"sum-stats","the status legend shares the view row");
});
test("tree chips are numbers: purple counts blocking waits, red counts non-blocking cards, own and below, hidden at zero", async () => {
  const s=waitSnapshot(); s.decisions.plain!.item="child"; s.decisions.old!.item="child"; delete s.decisions.newer;
  const p=await page(s,[]);
  const area=wideHead(p,"area"), chips=(h:Element)=>h.children.filter(e=>e.className === "waittag" || e.className === "asktag").map(e=>[e.className,e.innerHTML,e.title]);
  assert.deepEqual(chips(area),[["waittag","1","1 处阻塞工作"],["asktag","1","1 张决策卡不挡工作"]]);
  await rowOf(p,"area").querySelector(".caret")!.click();
  assert.deepEqual(chips(wideHead(p,"child")),[["waittag","1","1 处阻塞工作"],["asktag","1","1 张决策卡不挡工作"]]);
  const hot=wideHead(p,"hot");
  assert.deepEqual(chips(hot),[["waittag","1","1 处阻塞工作"]],"a zero count shows no chip");
  assert.ok(!p.all().some(e=>e.innerHTML === "等你决定" || e.innerHTML === "等你处理"));
});
test("card header tag: 阻塞 with the blocks text as its tooltip for a blocking card, 决策卡 for the others", async () => {
  const p=await page(waitSnapshot(),[]); await expand(p);
  const tag=(id:string)=>descendants(p.all().find(e=>e.id === "q-"+id)!).find(e=>e.className === "waittag" || e.className === "asktag")!;
  assert.equal(tag("old").className,"waittag"); assert.equal(tag("old").innerHTML,"阻塞"); assert.equal(tag("old").title,"#398 合并停着");
  assert.equal(tag("plain").className,"asktag"); assert.equal(tag("plain").innerHTML,"决策卡");
});
test("等你 panel: blocking waits by priority then oldest, one row each, the plain-card line, and a click jumps and Back returns", async () => {
  const p=await page(waitSnapshot(),[]), panel=p.all().find(e=>e.id === "wait-panel")!;
  assert.ok(panel,"the panel shows with blocking waits");
  const rows=panel.children.filter(e=>e.className === "waitrow");
  assert.equal(rows.length,3);
  assert.match(rows[0]!.innerHTML,/Hot ask/,"P0 first");
  assert.match(rows[1]!.innerHTML,/#398 合并停着/,"then the older card"); assert.match(rows[2]!.innerHTML,/发布停着/);
  assert.match(rows[1]!.innerHTML,/waitdot/); assert.match(rows[1]!.innerHTML,/Project/); assert.match(rows[1]!.innerHTML,/旧的问题/);
  assert.equal(panel.children.at(-1)!.innerHTML,"另有 1 张决策卡不挡工作");
  const summary=p.roots.get("summary")!;
  assert.ok(summary.children.indexOf(panel) > summary.children.findIndex(e=>e.children.some(c=>c.innerHTML.startsWith("阻塞"))),"the panel sits under row 1");
  await rows[1]!.click(); await p.flush();
  assert.ok(p.all().find(e=>e.id === "detail-it-child"),"the click selects the card's item");
  const back=p.document.getElementById("backbtn")!; assert.equal(back.hidden,false,"the jump is remembered");
  await back.click(); await p.flush();
  assert.equal(p.document.getElementById("backbtn")!.hidden,true,"Back returns");
});
test("等你 panel is gone when the last blocking wait is answered", async () => {
  const s=snapshot(); s.decisions.old={...card(),blocks:"停着"};
  const p=await page(s,[]); assert.ok(p.all().some(e=>e.id === "wait-panel"));
  s.decisions.old={...s.decisions.old!,status:"ruled",ruling:"A",choice:"A"};
  await p.change("e".repeat(40),[{kind:"decision",id:"old",after:s.decisions.old}]); await p.flush();
  assert.ok(!p.all().some(e=>e.id === "wait-panel"));
});
test("要你知道 lists unread notices newest first, 已读 hides one through the API, and the section disappears when none is left", async () => {
  const s=snapshot();
  s.notices={n1:{text:"旧的 **通知**",author:"跨项目",at:"2026-10-01T00:00:00Z",rev:1},n2:{text:"新的，见 [[it:child]]",item:"child",author:"Firn",at:"2026-10-03T00:00:00Z",rev:1},n3:{text:"已读的",author:"Firn",at:"2026-10-02T00:00:00Z",read:at,rev:1}};
  const p=await page(s,[],null,undefined,{response:(path)=> path === "/api/notice-read" ? {ok:true,status:200,json:async()=>({marked:[]})} : undefined});
  const section=()=>p.all().find(e=>e.id === "notices");
  assert.equal(section()!.children[0]!.innerHTML,"要你知道 2");
  const rows=section()!.children.filter(e=>e.className === "notice");
  assert.equal(rows.length,2); assert.match(markup(rows[0]!),/新的/); assert.match(markup(rows[0]!),/Firn/); assert.match(markup(rows[1]!),/旧的/);
  assert.ok(!markup(section()!).includes("已读的"));
  assert.ok(rows[0]!.children.some(e=>e.className.includes("notice-item")),"a notice with an item links to it");
  assert.ok(p.roots.get("summary")!.children.indexOf(section()!) >= 1);
  await rows[0]!.children.find(e=>e.className.includes("notice-read"))!.click();
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/notice-read").map(c=>c.body),[{id:"n2"}]);
  await p.change("f".repeat(40),[{kind:"notice",id:"n2",after:{...s.notices.n2!,read:at,rev:2}}]); await p.flush();
  assert.equal(section()!.children[0]!.innerHTML,"要你知道 1"); assert.ok(!markup(section()!).includes("新的"));
  await p.change("g".repeat(40),[{kind:"notice",id:"n1",after:{...s.notices.n1!,read:at,rev:2}}]); await p.flush();
  assert.equal(section(),undefined,"all read, no section");
  await p.change("h".repeat(40),[{kind:"notice",id:"n4",after:{text:"又一条",author:"Firn",at,rev:1}}]); await p.flush();
  assert.match(section()!.children[0]!.innerHTML,/要你知道 1/);
});
