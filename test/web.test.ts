import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { rules } from "../src/rules.ts";
import type { Snapshot, Decision, Note, ItemTarget, Item, PlanRow, PlanStep, Status, Project } from "../src/model.ts";
import { RECHECK_MS, STUCK, WAITING } from "../web/update.ts";

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
  getAttribute(name: string) { return this.attributes[name] ?? (name.startsWith("data-") ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_all, char: string) => char.toUpperCase())] : undefined) ?? null; }
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
  version?: string; session?: Map<string,string>;
  now?: () => number; clock?: FakeClock; autoOpen?: boolean; notification?: unknown; response?: (path:string,body:unknown,init:{method?:string;signal?:AbortSignal}) => FakeResponse | Promise<FakeResponse> | undefined;
}
async function page(fixture: PageInput, unread: unknown[], before: unknown = null, after?: unknown, options: PageOptions = {}) {
  const snapshot = nativeFixture(fixture);
  const nativeDocument = (value: unknown, id: string): unknown => {
    if (!value || typeof value !== "object" || !("title" in value)) return value;
    return nativeFixture({ ...fixture, items: { ...fixture.items, [id]: value as FixtureItem } } as PageInput).items[id];
  };
  const nativeWire = (path: string, value: unknown): unknown => {
    if (path === "/api/snapshot" && value && typeof value === "object" && "items" in value && "board" in value) return nativeFixture(value as PageInput);
    if (!path.startsWith("/api/step?") || !value || typeof value !== "object") return value;
    const params = new URLSearchParams(path.split("?")[1]);
    if (params.get("kind") !== "item") return value;
    const doc = value as { before?: unknown; after?: unknown }, id = params.get("doc")!;
    return { ...doc, before: nativeDocument(doc.before, id), after: nativeDocument(doc.after, id) };
  };
  const code = await (bundle ??= build({ entryPoints: ["web/app.ts"], bundle: true, format: "iife", globalName: "BoardPage", write: false, target: "es2022" }).then(result => result.outputFiles[0]!.text));
  const roots = new Map<string, Element>();
  for (const id of ["goal", "goal-title", "eyebrow", "meta", "summary", "nav", "agents", "areas", "cards", "decisions", "sendbox", "send-all", "send-note", "to-top", "server-banner", "update-banner", "hint", "item-detail", "split-divider", "page-left"]) { const e = new Element(id === "send-all" ? "button" : id === "nav" ? "nav" : "div"); e.id = id; roots.set(id,e); }
  // The page's own version, which the server fills into the page's text; a page opened without one does not know it.
  if (options.version !== undefined) { const meta = new Element("meta"); meta.id = "page-version"; meta.attributes.content = options.version; roots.set("page-version", meta); }
  const session = options.session ?? new Map<string,string>();
  let reloads = 0;
  roots.get("nav")!.className = "nav";
  roots.get("summary")!.appendChild(roots.get("nav")!);
  const detail=roots.get("item-detail")!, storage=options.storage ?? new Map<string,string>();
  detail.geometry=()=>({top:0,bottom:1000,height:1000,left:1000,width:900});
  // The left list pane scrolls the list; its scroll events arrive after the scroll, as a browser's do.
  const listPane=roots.get("page-left")!;
  listPane.geometry=()=>({top:0,bottom:1000,height:1000,left:0,width:900});
  Object.defineProperty(listPane,"scrollHeight",{get:()=>options.scrollHeight?.() ?? 10000});
  Object.defineProperty(detail,"scrollHeight",{get:()=>options.scrollHeight?.() ?? 10000});
  const listMax=()=>(options.scrollHeight?.() ?? 10000)-1000;
  const body = new Element("body"), wrap = new Element("div");
  const all = (): Element[] => { const out: Element[] = []; function walk(e: Element) { out.push(e); e.children.forEach(walk); } for (const e of [...roots.values(),body].filter(e=>!e.parentElement)) walk(e); return out; };
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
      e.captureClick=at=> { let go=true; dispatch("click",{isTrusted:true,target:e,...at,defaultPrevented:false,stopPropagation() { go=false; },preventDefault(this: { defaultPrevented: boolean }) { this.defaultPrevented=true; }},true); return go; };
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
  const intervals: Array<() => void> = [];
  const context = {
    Date: class extends Date { static now() { return options.now?.() ?? Date.now(); } },
    setInterval: (fn: () => void) => { intervals.push(fn); return intervals.length; },
    BoardPage: undefined,
    getSelection: () => ({ isCollapsed: !selected }),
    document, HTMLElement: Element, EventSource, AbortController, structuredClone, console, CSS: { escape: (s: string) => s },
    ...options.notification === undefined ? {} : { Notification: options.notification },
    sessionStorage: { getItem: (key:string) => session.get(key) ?? null, setItem(key:string,value:string) { session.set(key,value); }, removeItem(key:string) { session.delete(key); } },
    location: { reload() { reloads++; } },
    innerHeight: 1000, get scrollY() { return scrollPosition; }, localStorage: { getItem: (key:string) => { if(options.storageUnavailable) throw new Error("Unavailable storage"); return storage.get(key) ?? (key === "board-notes" && options.notesOpen ? JSON.stringify(options.notesOpen) : null); }, setItem(key:string,value:string) { if(options.storageUnavailable) throw new Error("Unavailable storage"); storage.set(key,value); } },
    matchMedia: (query:string) => ({matches:query.includes("prefers-reduced-motion") && options.reducedMotion !== false}),
    recordRender:(scope:unknown)=>renders.push(scope),
    performance:{now:()=>options.stalledFrames ? options.clock!.now : options.frames?.now ?? performance.now()}, setTimeout: options.clock?.setTimeout ?? setTimeout, clearTimeout: options.clock?.clearTimeout ?? clearTimeout, ...options.noFrames ? {} : {requestAnimationFrame:frame,cancelAnimationFrame:(_id:number)=>{}},
    addEventListener:(kind:string,fn:(event:unknown)=>unknown)=>windowListeners.set(kind,[...windowListeners.get(kind) ?? [],fn]),
    window: { innerWidth: 1200, get scrollY() { return scrollPosition; }, focus() {}, addEventListener:(kind:string,fn:(event:unknown)=>unknown)=>windowListeners.set(kind,[...windowListeners.get(kind) ?? [],fn]), scrollBy(_x:number,y:number) { scrollPosition=Math.max(0,Math.min((options.scrollHeight?.() ?? 10000)-1000,scrollPosition+y)); programmaticScroll(); }, scrollTo(_x:number,y:number) { scrolls.push(y); scrollPosition=Math.max(0,Math.min((options.scrollHeight?.() ?? 10000)-1000,y)); programmaticScroll(); } },
    fetch: async (path: string, init?: {body?: string; method?: string; signal?:AbortSignal}) => {
      const input = init?.body ? JSON.parse(init.body) : undefined; calls.push({path,body:input});
      const intercepted = options.response?.(path,input,init ?? {});
      if (intercepted !== undefined) {
        const response = await intercepted;
        return { ...response, json: async () => nativeWire(path, await response.json()) };
      }
      let value: unknown;
      if (path === "/api/snapshot") value = nativeFixture(fixture);
      else if (path === "/api/unread") value = { steps: unread };
      else if (path.startsWith("/api/step?")) {
        const params = new URLSearchParams(path.split("?")[1]), id = params.get("doc")!;
        const collection = params.get("kind") === "item" ? snapshot.items : params.get("kind") === "decision" ? snapshot.decisions : snapshot.notes;
        value = typeof before === "function" ? await before(params) : { before, after: after === undefined ? collection[id] ?? null : after, diff: "+ synthetic changed text" };
        if (params.get("kind") === "item" && value && typeof value === "object") {
          const doc = value as { before?: unknown; after?: unknown };
          value = { ...doc, before: nativeDocument(doc.before, id), after: nativeDocument(doc.after, id) };
        }
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
      else if (path === "/api/draft" && input.id) {
        const a = input as {id: string; rev: number; text: string}, previous = snapshot.notes[a.id]!;
        const doc: Note = { ...previous, text: a.text, rev: previous.rev + 1, ...(previous.kind === "approve" || previous.kind === "done" ? {answerText: previous.answerText ?? previous.text} : {}) };
        snapshot.notes[a.id] = doc;
        value = {note: {id: a.id, doc}, deleted: [], commit: "c".repeat(40)};
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
      return { ok: true, status: 200, json: async () => structuredClone(nativeWire(path, value)) };
    },
  };
  const recorded=code.includes("function renderPage(scope)") ? code.replace("function renderPage(scope) {","function renderPage(scope) { recordRender(scope);") : code.replace("function renderAll() {","function renderAll() { recordRender('all');");
  runInNewContext(options.transform?.(recorded) ?? recorded, context);
  await setImmediate(); await setImmediate();
  if (options.autoOpen !== false) { await sources[0]?.onopen?.(); await setImmediate(); await setImmediate(); }
  const flush=async()=> { for (let i=0;i<4;i++) { if (!options.stalledFrames) options.frames?.flush(); else options.clock!.advance(100); if (options.noFrames) options.clock?.advance(0); if (options.noFrames) await new Promise(resolve=>setTimeout(resolve,0)); await setImmediate(); } };
  await flush();
  // A live update from the server, as the page's event stream delivers it.
  // `activity`, when given, is the event's activity change (rules ActivityDelta).
  const emit=(commit:string,changed:unknown[]=[],activity?:unknown)=>sources.at(-1)!.handlers.get("change")!({ data: JSON.stringify({commit,changed: changed.map(value => {
    const doc = value as {kind: string; id: string; after?: unknown};
    return doc.kind === "item" ? {...doc, after: nativeDocument(doc.after, doc.id)} : doc;
  }),...(activity === undefined ? {} : {activity})}) });
  const change = async (commit: string,changed:unknown[]=[]) => { emit(commit,changed); await setImmediate(); };
  // The page's stream announces the version of the page the server serves now (src/http.ts).
  const announce = (version: string) => sources.at(-1)!.handlers.get("page")!({ data: JSON.stringify({ version }) });
  return { roots, all, calls, document, wrap, change, emit, intervals, measurements, scrolls, detailScrolls, sources, renders,flush, storage, session, announce,
    get reloads() { return reloads; },
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
// Controls established before plans keep their synthetic setup vocabulary in
// this test-only adapter. Product inputs, baselines and item events always use
// native plans. Tests of plan behavior below construct native plans directly.
type FixtureItem = Omit<Item, "group" | "status" | "plan"> & {
  group?: string; status?: Status; plan?: PlanRow[]; parent?: string;
  deps: Array<{id: string; why?: string} | {card: string; why?: string}>;
  steps?: PlanStep[];
};
type PageFixture = Omit<Snapshot, "items" | "board"> & {
  items: Record<string, FixtureItem>;
  board: Omit<Snapshot["board"], "projects"> & {projects: Array<Project & {migrated?: boolean}>};
};
type PageInput = PageFixture | Snapshot;
const planRowDomId = (item: string, row: string) => "plan-" + encodeURIComponent(JSON.stringify([item, row]));
function nativeFixture(source: PageInput): Snapshot {
  const groupOf = (id: string, seen = new Set<string>()): string => {
    const it = source.items[id] as FixtureItem | undefined; if (!it || seen.has(id)) return ""; seen.add(id);
    return it.group ?? (it.parent ? groupOf(it.parent, seen) : "");
  };
  const oldStatus = (id: string, seen = new Set<string>()): Status | undefined => {
    const it=source.items[id] as FixtureItem | undefined; if (!it || it.record) return undefined; if (seen.has(id)) return "todo"; seen.add(id);
    const children=Object.keys(source.items).filter(key=>(source.items[key] as FixtureItem).parent === id).map(key=>oldStatus(key,new Set(seen))).filter((s):s is Status=>s !== undefined);
    if (!children.length) return it.status ?? "todo";
    const live=children.filter(s=>s !== "cancelled");
    return !live.length ? "cancelled" : live.includes("wip") ? "wip" : live.includes("blocked") ? "blocked" : live.every(s=>s === "done") ? "done" : "todo";
  };
  const items: Record<string, Item> = {};
  for (const [id, value] of Object.entries(source.items)) {
    const old = value as FixtureItem;
    const {parent: _parent, deps = [], steps, status, ...fields}=old;
    if (old.plan !== undefined) { items[id]={...fields, group: groupOf(id), plan: structuredClone(old.plan), ...(status === "cancelled" ? {status} : {})}; continue; }
    const derived=oldStatus(id);
    const refs: PlanRow[]=deps.map(row=>"card" in row ? {id:row.card,card:row.card,after:[]} : {id:row.id,item:row.id,own:(source.items[row.id] as FixtureItem | undefined)?.parent === id,after:[]});
    for (const [child, it] of Object.entries(source.items)) if ((it as FixtureItem).parent === id && !refs.some(row=>"item" in row && row.item === child)) refs.push({id:child,item:child,own:true,after:[]});
    const ownSteps=steps ?? (old.record ? [] : refs.some(row=>"item" in row && row.own) ? [] : [{id:"work",text:"Work",state: derived === "wip" ? "doing" as const : derived === "done" ? "done" as const : "todo" as const, ...(derived === "wip" ? {since:old.updated} : derived === "done" ? {doneAt:old.updated} : {}), after:[]}]);
    const plan: PlanRow[]=[...refs,...ownSteps];
    if (!old.record) plan.push({id:"accept",accept:true,text:"Checks pass",state:derived === "done" ? "done" : "todo",...(derived === "done" ? {doneAt:old.updated} : {})});
    items[id]={...fields,group:groupOf(id),plan,...(derived === "cancelled" ? {status:"cancelled"} : {})};
  }
  return {...source,board:{...source.board,projects:source.board.projects.map(value=> { const {migrated:_migrated,...p}=value as Project & {migrated?:boolean}; return p; })},items};
}
function nativeSnapshot(): Snapshot { return nativeFixture(snapshot()); }
function planStep(id: string, text=id, state: PlanStep["state"]="todo", fields: Partial<PlanStep>={}): PlanStep {
  return {id,text,state,...(state === "done" ? {doneAt:at} : state === "doing" ? {since:at} : state === "dropped" ? {reason:"Replaced",droppedAt:at} : {}),...fields};
}
function planAcceptance(state: PlanStep["state"]="todo"): PlanStep { return planStep("accept","Checks pass",state,{accept:true}); }
const planWork = (rows: PlanRow[], state: PlanStep["state"]="todo"): PlanRow[] => [...rows,planAcceptance(state)];
const ownedRow = (item: string, after: string[]=[]): PlanRow => ({id:item,item,own:true,after});
const sharedRow = (item: string, after: string[]=[]): PlanRow => ({id:item,item,own:false,after});
const cardRow = (card: string, after: string[]=[]): PlanRow => ({id:card,card,after});
function planRow(p: Awaited<ReturnType<typeof page>>, itemId: string, rowId: string): Element {
  return p.document.getElementById(planRowDomId(itemId,rowId))!;
}
const at = "2026-10-11T01:02:03Z";
function snapshot(): PageFixture {
  return { board: { title: "Synthetic title", projects: [{name:"Project",migrated:true}], eyebrow: "Synthetic eyebrow" }, head: "a".repeat(40), owner: {}, decisions: {}, notes: {}, glossaries: {}, items: {
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

test("a paused item shows its reason and no pause or resume control on any item", async () => {
  const s=nativeSnapshot(), original=structuredClone(s.items.area!.plan);
  const p=await page(s,[]); await expand(p,"area");
  assert.equal(item(p,"area").querySelector(".pause-start"),null,"open work has no pause button");
  assert.equal(item(p,"area").querySelector(".pause-control"),null,"an unpaused item leaves no empty row under its title");
  const paused={...s.items.area!,paused:{reason:"等第一版发布",at},rev:2};
  await p.change("b".repeat(40),[{kind:"item",id:"area",after:paused}]); await p.flush();
  assert.equal(item(p,"area").querySelector(".item-head .st")!.innerHTML,"◌ PAUSE");
  assert.match(markup(item(p,"area")),/暂停：等第一版发布/);
  assert.equal(item(p,"area").querySelector(".pause-resume"),null,"paused work has no resume button");
  assert.equal(item(p,"area").querySelector(".pause-start"),null);
  assert.deepEqual(item(p,"area").querySelectorAll(".plan-row").map(row=>row.id),original.map(row=>planRowDomId("area",row.id)));
  assert.equal(p.calls.filter(call=>call.path === "/api/pause").length,0);
});

test("inherited pause uses a grey glyph, honest counts and filters and links to its source", async () => {
  const s=nativeSnapshot(); s.items.area!.paused={reason:"本轮先停",at};
  const p=await page(s,[]); await expand(p,"area");
  const target=planRow(p,"area","child");
  assert.equal(target.querySelector(".g")!.innerHTML,"◌","paused item rows differ from owner/card waiting glyphs");
  assert.ok(target.classList.contains("paused"));
  assert.equal(target.querySelector(".st"),null,"a plan row uses only its state glyph");
  assert.equal(rowOf(p,"area").querySelector(".counts .st.paused")!.innerHTML,"1");
  assert.equal(rowOf(p,"area").querySelector(".counts .st.paused")!.attributes["aria-label"],"◌ PAUSE 1");
  assert.match(markup(p.roots.get("summary")!),/暂停 2/,"overview counts both root and descendant");
  const filter=p.all().find(e=>e.tagName === "BUTTON" && e.innerHTML === "暂停 2");
  assert.ok(filter,"the project offers the paused status filter"); await filter.click(); await p.flush();
  assert.ok(rowOf(p,"area")); assert.ok(rowOf(p,"child"));
  await expand(p,"child");
  assert.match(markup(item(p)),/暂停：本轮先停/);
  assert.match(markup(item(p)),/由「[\s\S]*Parent[\s\S]*」暂停/);
  assert.doesNotMatch(markup(item(p)),/请在该条目恢复/);
  assert.equal(item(p).querySelector(".pause-resume"),null,"a child cannot accidentally resume its ancestor");
  assert.equal(item(p).querySelector(".pause-start"),null,"inherited pause is presented at its source");
  assert.equal(planRow(p,"child","work").querySelector(".g")!.innerHTML,"●","pause leaves doing step rows unchanged");
  p.key("/");
  const search=p.all().find(e=>e.classList.contains("searchrow") && e.innerHTML.includes("Child"));
  assert.ok(search); assert.match(search.innerHTML,/<span class="st paused">◌ PAUSE<\/span>/);
  p.key("Escape",p.document.getElementById("search-input")!);
  await p.change("d".repeat(40),[{kind:"item",id:"area",after:{...s.items.area!,paused:{reason:"原因已改",at},rev:2}}]); await p.flush();
  assert.match(markup(item(p)),/暂停：原因已改/,"ancestor reason updates repaint the selected child even when status stays paused");
  assert.doesNotMatch(markup(item(p)),/本轮先停/);
  await p.change("e".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,paused:{reason:"下级也暂停",at},rev:2}}]); await p.flush();
  assert.match(markup(item(p)),/暂停：下级也暂停/);
  assert.equal(item(p).querySelector(".pause-resume"),null,"no resume button, even on a direct marker");
  await p.change("f".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,rev:3}}]); await p.flush();
  assert.equal(item(p).querySelector(".item-head .st")!.innerHTML,"◌ PAUSE","clearing the child's own marker leaves the ancestor's pause effective");
  assert.match(markup(item(p)),/暂停：原因已改/);
  assert.equal(item(p).querySelector(".pause-resume"),null);
  const html=await readFile("web/index.html","utf8");
  assert.match(html,/\.plan-row\.paused > \.g\s*\{\s*color:\s*var\(--muted\)/);
  assert.match(html,/\.st\.cancelled, \.st\.paused\s*\{\s*color:\s*var\(--muted\)/);
  assert.match(html,/\.st\.paused\s*\{\s*flex:\s*none;\s*min-width:\s*max-content;/,"the seven-character pause label keeps its intrinsic width in a narrow flex row");
});

test("record, completed and cancelled heads have no pause control", async t => {
  for (const state of ["record","done","cancelled"] as const) await t.test(state,async()=> {
    const s=nativeSnapshot();
    s.items.area!.plan=state === "record" ? [] : planWork([],state === "done" ? "done" : "todo");
    if (state === "record") s.items.area!.record=true;
    if (state === "cancelled") s.items.area!.status="cancelled";
    const p=await page(s,[]); await expand(p,"child");
    assert.equal(item(p,"child").querySelector(".pause-start"),null,"the open boundary has no pause button");
    assert.equal(item(p,"child").querySelector(".pause-control .sbtn"),null);
    await expand(p,"area");
    assert.equal(item(p,"area").querySelector(".pause-control"),null);
    assert.equal(p.calls.filter(call=>call.path === "/api/pause").length,0);
  });
});

test("a completed pause source is linked read-only when open work inherits it through a record", async () => {
  const s=nativeSnapshot(), childPlan=structuredClone(s.items.child!.plan);
  s.items.queue={...s.items.area!,title:"Run queue",record:true,plan:[ownedRow("child")]};
  s.items.area!.plan=[ownedRow("queue"),planAcceptance("done")];
  s.items.area!.paused={reason:"先停这一轮",at};
  const rootPlan=structuredClone(s.items.area!.plan);
  const storage=new Map([["board-open",JSON.stringify({area:true,queue:true})]]);
  const p=await page(s,[],null,undefined,{storage});
  await expand(p,"child");
  assert.equal(item(p).querySelector(".item-head .st")!.innerHTML,"◌ PAUSE");
  const source=item(p).querySelector(".pause-reason .ref");
  assert.ok(source,"the inherited pause links to the completed source");
  await source.click(); await p.flush();
  assert.ok(detailItem(p,"area"));
  assert.equal(item(p,"area").querySelector(".item-head .st")!.innerHTML,"DONE");
  assert.match(markup(item(p,"area")),/暂停：先停这一轮/);
  assert.equal(item(p,"area").querySelector(".pause-start"),null,"closed work cannot be paused again");
  assert.equal(item(p,"area").querySelector(".pause-resume"),null,"the closed source shows its marker without a resume button");
  const {paused:_paused,...restored}=s.items.area!;
  await p.change("b".repeat(40),[{kind:"item",id:"area",after:{...restored,rev:2}}]); await p.flush();
  assert.equal(item(p,"area").querySelector(".item-head .st")!.innerHTML,"DONE","clearing pause does not reopen the completed source");
  assert.equal(item(p,"area").querySelector(".pause-control"),null);
  assert.deepEqual(restored.plan,rootPlan);
  await expand(p,"child");
  assert.equal(item(p).querySelector(".item-head .st")!.innerHTML,"WIP","open descendants recover their preserved work state");
  assert.equal(item(p).querySelector(".pause-reason"),null);
  assert.deepEqual(s.items.child!.plan,childPlan);
  assert.equal(planRow(p,"child","work").querySelector(".g")!.innerHTML,"●");
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
  const unfold=async () => {
    const caret=rowOf(p,"area")?.querySelector(".caret");
    if (caret && caret.attributes["aria-expanded"] !== "true" && !caret.disabled) { await caret.click(); await p.flush(); }
  };
  await unfold();
  if (!rowOf(p,id)) {
    for (const show of p.all().filter(e => e.tagName === "BUTTON" && (/^完成 \d/.test(e.innerHTML) || /^取消 \d/.test(e.innerHTML)))) {
      await show.click(); await p.flush(); await unfold();
      if (rowOf(p,id)) break;
    }
  }
  await rowOf(p,id).querySelector(".item-head")!.click();
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
  assert.match(body, /class="chg-add"[^>]*><pre class="code numbered"><code><span class="l">new<\/span>\n<span class="l"><\/span>\n<span class="l">code<\/span><\/code><\/pre>/);
  assert.match(body, /class="chg-add"[^>]*><ul><li>Keep<\/li><li>New list<\/li><\/ul>/);
  assert.match(body, /class="chg-add"[^>]*><div class="tablewrap"><table><thead><tr><th>Header<\/th>.*<td>New row<\/td>/s);
});

test("detail: each 参考 section is a folded details from its line to the next one or the end, other text unchanged", async () => {
  const s = snapshot(); s.items.child!.head = "Body\n\n**参考：First**\n\nFirst detail\n\n**参考：Second**\n\nSecond detail";
  const p = await page(s,unread()); await expand(p);
  assert.match(markup(item(p)), /<p>Body<\/p><details class="refsec" data-ref="[^"]*"><summary><strong>参考：First<\/strong><\/summary><div class="refbody"><p>First detail<\/p><\/div><\/details><details class="refsec" data-ref="[^"]*"><summary><strong>参考：Second<\/strong><\/summary><div class="refbody"><p>Second detail<\/p><\/div><\/details>/);
});

test("detail: a changed 参考 section is marked as one block, its unchanged title and body included", async () => {
  const s = snapshot(), before = {...s.items.child!,head:"Body\n\n**参考：R**\n\nold detail"};
  s.items.child!.head = "Body\n\n**参考：R**\n\nnew detail\n\nmore";
  const p = await page(s,unread(),before); await expand(p);
  const body = markup(item(p));
  assert.match(body, /<div class="chg-add"><details class="refsec" data-ref="[^"]*"><summary><strong>参考：R<\/strong><\/summary><div class="refbody"><p>new detail<\/p><p>more<\/p><\/div><\/details><\/div>/);
  assert.ok(!body.includes("old detail"),"the former section text is not shown");
});

test("detail: a 参考 line inside fenced code, a title-only section and one at the head's start fold as the rule says", async () => {
  const s = snapshot(), head = "**参考：Start**\n\n```\n**参考：inside code**\n```\n\n**参考：Empty**";
  s.items.child!.head = head;
  const p = await page(s,unread()); await expand(p);
  const body = markup(item(p));
  assert.match(body, /<details class="refsec"[^>]*><summary><strong>参考：Start<\/strong><\/summary><div class="refbody">.*参考：inside code.*<\/div><\/details>/s);
  assert.match(body, /<details class="refsec"[^>]*><summary><strong>参考：Empty<\/strong><\/summary><div class="refbody"><\/div><\/details>/);
  assert.equal((body.match(/class="refsec"/g) ?? []).length, 2,"the fenced line opens no section");
});

test("detail: 参考 text in a card's background is plain, never folded", async () => {
  const s = snapshot(), c = card();
  s.decisions.q = {...c, background: "**参考：Not a section**\n\nBody"};
  const p = await page(s,unread("decision","q")); await expand(p);
  const card1 = p.all().find(e => e.id === "q-q")!;
  assert.match(markup(card1), /<strong>参考：Not a section<\/strong>/);
  assert.ok(!markup(card1).includes('class="refsec"'),"a card's background shows no fold");
});

// The text a reader copies from a rendered block: markup removed, entities decoded; the gutter is CSS-generated, so absent.
const codeText = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

test("detail: wf fence renders numbered highlighted lines whose text is the source, and a 2-line block has no numbers", async () => {
  const src = 'fn main() {\n  // count <up>\n  let x = 7_u64 & "a\\"b";\n}';
  const s = snapshot(); s.items.child!.head = "```wf\n" + src + "\n```\n\n```wf\nlet a = 1;\nlet b = 2;\n```";
  const p = await page(s,unread(),null); await expand(p);
  const html = markup(item(p)), pres = html.match(/<pre class="code[^"]*"><code>.*?<\/code><\/pre>/gs)!;
  assert.equal(pres.length,2);
  assert.ok(pres[0]!.startsWith('<pre class="code numbered">'));
  assert.deepEqual([...pres[0]!.matchAll(/<span class="l">/g)].length,4,"one numbered line span per source line, 1..4");
  assert.match(pres[0]!, /<span class="tk-k">fn<\/span>/);
  assert.match(pres[0]!, /<span class="tk-c">\/\/ count &lt;up&gt;<\/span>/);
  assert.match(pres[0]!, /<span class="tk-n">7_u64<\/span>/);
  assert.equal(codeText(pres[0]!.replace(/^<pre[^>]*><code>/,"").replace(/<\/code><\/pre>$/,"")),src);
  assert.ok(pres[1]!.startsWith('<pre class="code"><code>') && !pres[1]!.includes('class="l"'),"two lines show no gutter");
  assert.equal(codeText(pres[1]!),"let a = 1;\nlet b = 2;");
});

test("detail: change marking marks a head whose block holds code and keeps the code intact", async () => {
  const s = snapshot(), before = {...s.items.child!,head:"```wf\nlet a = 1;\nlet b = 2;\nlet c = 3;\n```"};
  s.items.child!.head = "```wf\nlet a = 1;\nlet b = 2;\nlet c = 4;\n```";
  const p = await page(s,unread(),before); await expand(p);
  const body = markup(item(p));
  assert.match(body, /class="chg-add"[^>]*><pre class="code numbered"><code>.*<span class="tk-n">4<\/span>/s);
  assert.ok(!body.includes("3;"),"the old block is not shown");
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
  const s = nativeSnapshot(); s.items.area!.plan=planWork([]);
  const before = {...s.items.child!,priority:"P2" as const,ask:{text:"Old ask"},plan:planWork([sharedRow("area"),planStep("work","Work","todo",{after:[]})]),links:[{label:"Old link",url:"https://example.com/old"}]};
  s.items.child!.ask = {text:"New ask"};
  const p = await page(s,unread(),before); await expand(p);
  const all = descendants(item(p));
  assert.ok(!item(p).querySelectorAll(".plan-row").some(e => e.id === planRowDomId("child","area")),"a removed dependency row is not rendered");
  assert.ok(!all.some(e => e.tagName === "A" && e.innerHTML === "Old link"),"a removed link is not rendered");
  assert.ok(!markup(item(p)).includes("Old ask") && !markup(item(p)).includes("chg-del"),"the former ask is not rendered");
  assert.ok(all.some(e => e.className.includes("prio") && e.className.includes("chg-add") && e.innerHTML === "P1"));
  assert.ok(all.some(e => e.className.includes("st ") && e.className.includes("chg-add") && e.innerHTML === "WIP"));
  assert.ok(all.some(e => e.className.includes("ask") && e.className.includes("chg-add") && markup(e).includes("New ask")));
});

test("an unread owned item's unchanged derived priority is not marked as a priority edit", async () => {
  const s=nativeSnapshot(), before={...s.items.child!,head:"Old head"}; delete before.priority;
  s.items.child!.head="New head";
  const p=await page(s,unread(),before); await expand(p);
  const priority=item(p).querySelector(".item-head")!.querySelector(".prio"); assert.ok(priority);
  assert.equal(priority.innerHTML,"P1","the child still inherits its owner's priority");
  assert.ok(!priority.classList.contains("chg-add"),"an ignored written priority difference is not a displayed priority change");
  assert.match(markup(item(p)),/chg-add[^]*New head/,"the actual unread head edit is still marked");
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

test("expanded unread marks disappear when m reads the selected item without an n walk", async () => {
  const s = snapshot(), before = {...s.items.child!,head:"Old body"}; s.items.child!.head = "New body";
  const p = await page(s,unread(),before); await expand(p);
  assert.match(markup(item(p)), /chg-add/);
  p.key("m"); await p.flush();
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
  p.key("n"); await setImmediate(); p.key("m"); await p.flush();
  assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{doc:"item:child",through:last}]);
  assert.ok(!p.all().some(e => e.innerHTML === "新 1 ›"));
  assert.ok(!markup(item(p)).includes("chg-add") && !markup(item(p)).includes("Intermediate"));
});

test("detail: new item keeps rich head and its log stays collapsed without unread marks", async () => {
  const s = snapshot(); s.items.child!.head = "**Goal**：Body\n\n- List\n\n```\n<unsafe>\n\ncode\n```";
  s.items.child!.log = [{at,text:"same"},{at,text:"same"}];
  const p = await page(s,unread(),null); await expand(p);
  assert.ok(descendants(item(p)).some(e => e.className.includes("item-title") && e.className.includes("chg-add")));
  assert.ok(!markup(item(p)).includes('class="chg-add"'));
  assert.match(markup(item(p)), /<pre class="code numbered"><code><span class="l">&lt;unsafe&gt;<\/span>\n<span class="l"><\/span>\n<span class="l">code<\/span><\/code><\/pre>/);
  assert.equal(descendants(item(p)).filter(e => e.className.includes("log-entry")).length,0);
  await button(p,"▸ 日志").click();
  assert.equal(descendants(item(p)).filter(e => e.className.includes("log-entry")).length,2);
  assert.equal(descendants(item(p)).filter(e => e.className.includes("log-entry") && e.className.includes("fresh")).length,0);
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
  p.key("m"); await setImmediate(); await setImmediate();
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
    p.key("m"); await setImmediate();
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
  p.key("m"); await setImmediate();
  assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{doc:"item:area",through:stepId}]);
});

test("log append remains collapsed and never makes an item unread, including legacy unread summaries", async () => {
  const s = snapshot(), before = {...s.items.area!};
  s.items.area!.log = [{at,text:"Old history"},{at,text:"New log entry"}];
  const legacy = [{...unread("item","area")[0]!,docs:[{kind:"item",id:"area",summary:"+1 log",pieces:{log:1,reply:0,other:0}}]}];
  const p = await page(s,legacy,before); await expand(p,"area");
  assert.equal(item(p,"area").querySelectorAll(".log-entry").length,0);
  assert.ok(!item(p,"area").className.includes("fresh"));
  assert.ok(!p.all().some(e => /^新 |^进展 /.test(e.innerHTML)));
  p.key("n"); await p.flush();
  assert.equal(p.calls.filter(c => c.path.startsWith("/api/step")).length,0,"log-only changes have no unread baseline or navigation stop");
  await button(p,"▸ 日志").click();
  assert.equal(item(p,"area").querySelectorAll(".log-entry").length,2);
  assert.equal(item(p,"area").querySelectorAll(".log-entry.fresh").length,0);
  await p.change("b".repeat(40),[{kind:"item",id:"area",after:{...s.items.area!,rev:2,log:[...s.items.area!.log,{at,text:"Later log entry"}]}}]); await p.flush();
  assert.equal(item(p,"area").querySelectorAll(".log-entry").length,3,"explicitly opened log retains its view");
  assert.ok(!item(p,"area").className.includes("fresh"));
  await button(p,"▾ 日志").click();
  assert.equal(item(p,"area").querySelectorAll(".log-entry").length,0);
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
  const far = planRow(p,"area","far").querySelector(".plan-link")!;
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
    const p = await page(s, []), r = rules(nativeFixture(s));
    await expand(p);
    // The waiting badge and approval action are rendered from the predicates.
    assert.equal(p.all().some(e => e.className === "asktag" && e.innerHTML === "决策卡"), r.cardWaiting("q") && !r.cardBlocking("q"));
    assert.equal(p.all().some(e => e.id === "ask-child"), r.askPending("child"));
  }
});

test("n reaches completed items holding unread content in page order, and m reads the selected item but not its sub-items", async () => {
  const s = snapshot(), id = "e".repeat(40);
  s.items.other = {title:"Completed",parent:"area",status:"done",priority:"P2",updated:at,rev:1,deps:[],links:[],log:[]};
  s.items.area!.deps.push({id:"other",why:"needs other"});
  const p = await page(s,[{id,commits:[id],author:"Session A",at,docs:[{kind:"item",id:"child",summary:"status todo→wip"},{kind:"item",id:"other",summary:"status wip→done"},{kind:"item",id:"area",summary:"head changed"}]}]);
  await wideCaret(p).click(); await p.flush();
  p.key("m"); assert.ok(!p.calls.some(c => c.path === "/api/read"));
  // The page shows the parent above its child, so n reaches the parent first although the step lists the child first.
  p.key("n"); await p.flush(); assert.ok(item(p,"area").className.includes("cur"));
  assert.ok(!item(p).className.includes("cur"));
  assert.ok(!p.calls.some(c => c.path === "/api/read"));
  p.key("m"); await p.flush(); assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body),[{doc:"item:area",through:id}]);
  assert.ok(item(p).className.includes("fresh"),"the sub-item stays unread");
  const areaChip=descendants(item(p,"area").querySelector(".item-head")!).filter(e=>e.className === "newtag freshchip");
  assert.deepEqual(areaChip.map(e=>e.innerHTML),["2"],"the parent counts both open and completed sub-items holding unread content");
  assert.match(areaChip[0]!.title,/本身没有新内容，下面的子条目有 2 条/);
  assert.ok(!item(p,"area").className.includes("fresh"),"its line leaves: nothing of its own is new, only the sub-item it counts");
  p.key("m"); assert.match(p.roots.get("hint")!.textContent,/这一条本身没有新内容；新的 2 条在下面的子条目里/,"m says where the new content is");
  p.key("n"); await p.flush(); assert.ok(item(p).className.includes("cur"),"after m, n goes on to the next stop on the page");
  p.key("n"); await p.flush(); const completed=detailItem(p,"other"); assert.ok(completed,"the completed item's detail is rendered");
  assert.ok(completed.className.includes("cur"),"the completed item remains the next unread stop");
  assert.ok(rowOf(p,"other")?.className.includes("fresh-ended"),"the completed item shows dimmed in the tree while it holds unread content");
});

test("inside a changed item n visits each new place in turn before the next item; a new item is one stop at its start", async () => {
  // Elements of the detail column sit at fixed positions, one row apart in document order; the pane moves over them.
  const geometry = (e:Element, all:() => Element[]) => {
    const y = e.className.split(" ").includes("item") ? 600 : 600 + all().indexOf(e) * 40;
    return {top:y, height:e.className.split(" ").includes("item") ? 6000 : 20};
  };
  const s = nativeSnapshot(), baseline={...s.items.child!,plan:planWork([])};
  s.items.child!.plan = planWork([planStep("first","First new step","doing"),planStep("second","Second new step")]);
  const p = await page(s, unread("item","child"), baseline, undefined, {detailGeometry:geometry});
  const before = p.detailScrolls.length;
  p.key("n"); await p.flush(); p.key("n"); await p.flush(); p.key("n"); await p.flush(); p.key("n"); await p.flush();
  const visits = p.detailScrolls.slice(before);
  assert.ok(item(p).className.includes("cur"), "n stays inside the changed item");
  assert.equal(visits.length, 4);
  assert.ok(visits[0]! < visits[1]! && visits[1]! < visits[2]!, "a changed status and two new steps, down the page: " + visits.join(", "));
  assert.equal(visits[3], visits[0], "after its last place, n goes on to the next stop, here the same item again");
  const created = await page(snapshot(), unread("item","child"), null, undefined, {detailGeometry:geometry});
  const start = created.detailScrolls.length;
  created.key("n"); await created.flush(); created.key("n"); await created.flush();
  assert.equal(new Set(created.detailScrolls.slice(start)).size, 1, "a new item is one stop, at its start: " + created.detailScrolls.slice(start).join(", "));
});


test("n walks the page from top to bottom, one stop per changed document, and goes on from a read item", async () => {
  const s = snapshot(), [a,b,c] = ["a","b","c"].map(x => x.repeat(40)) as [string,string,string];
  s.items.plain = {title:"Plain",group:"Project",status:"todo",priority:"P2",updated:at,rev:1,deps:[],links:[],log:[]};
  const doc = (id:string) => ({kind:"item" as const,id,summary:"head changed",pieces:{progress:0,reply:0,other:1}});
  // Commit order is plain, child, area, area again; the page order is area, its child, then plain.
  const p = await page(s,[{id:a,commits:[a],author:"Session A",at,docs:[doc("plain"),doc("child")]},{id:b,commits:[b],author:"Session B",at,docs:[doc("area")]},{id:c,commits:[c],author:"Session A",at,docs:[doc("area")]}]);
  await wideCaret(p).click(); await p.flush();
  const cur = () => ["area","child","plain"].filter(id => item(p,id).className.split(" ").includes("cur"));
  assert.ok(p.all().some(e => e.tagName === "BUTTON" && e.innerHTML === "新 3 ›"),"three items have something new");
  p.key("n"); await p.flush(); assert.deepEqual(cur(),["area"]);
  assert.ok(descendants(item(p,"area").children[0]!).some(e => e.className === "newtag freshchip" && e.innerHTML === "2"),"area counts itself and its child once each");
  p.key("n"); await p.flush(); assert.deepEqual(cur(),["child"],"area's second change is not a second stop");
  p.key("m"); await p.flush(); assert.deepEqual(p.calls.filter(x => x.path === "/api/read").map(x => x.body),[{doc:"item:child",through:a}]);
  p.key("n"); await p.flush(); assert.deepEqual(cur(),["plain"],"after m, n continues below the read stop instead of starting over");
});

test("after the owner selects another item in the tree, n goes to the first new stop at or below it, and its reverse to the last one above it", async () => {
  const s = snapshot(), [a,b] = ["a","b"].map(x => x.repeat(40)) as [string,string];
  s.items.plain = {title:"Plain",group:"Project",status:"todo",priority:"P2",updated:at,rev:1,deps:[],links:[],log:[]};
  const doc = (id:string) => ({kind:"item" as const,id,summary:"head changed",pieces:{progress:0,reply:0,other:1}});
  // Page order: area, its child, then plain; all three hold new content.
  const p = await page(s,[{id:a,commits:[a],author:"Session A",at,docs:[doc("plain"),doc("child")]},{id:b,commits:[b],author:"Session B",at,docs:[doc("area")]}]);
  await wideCaret(p).click(); await p.flush();
  const cur = () => ["area","child","plain"].filter(id => item(p,id).className.split(" ").includes("cur"));
  p.key("n"); await p.flush(); assert.deepEqual(cur(),["area"]);
  // Without the fix n went on from where it last landed (child), not from the item the owner clicked.
  await selectWide(p,"plain"); p.key("n"); await p.flush(); assert.deepEqual(cur(),["plain"],"n starts from the clicked item");
  await selectWide(p,"child"); p.key("N"); await p.flush(); assert.deepEqual(cur(),["area"],"its reverse goes to the last stop above the clicked item");
});

test("shared plan rows are one line: no owner or origin line under them", async () => {
  const s=nativeSnapshot(); s.board.projects.push({name:"Other project"});
  s.items.sib={...s.items.child!,title:"Sibling",plan:planWork([planStep("work")])}; s.items.area!.plan=planWork([ownedRow("child"),ownedRow("sib")]);
  s.items.far={...s.items.child!,title:"Far area",group:"Other project",plan:planWork([planStep("work")])}; s.items.child!.plan=planWork([sharedRow("sib"),sharedRow("far")]);
  const p=await page(s,[]); await expand(p);
  for (const id of ["sib","far"]) {
    assert.equal(planRow(p,"child",id).querySelector(".plan-sub"),null,id+" has no second line");
    assert.doesNotMatch(markup(planRow(p,"child",id)),/共用/);
  }
  assert.match(markup(planRow(p,"child","far")),/Far area/);
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

test("a root another project starts to depend on moves under the rule while the page stays open, and back when the dependency goes", async () => {
  const s=snapshot(); s.board.projects.push({name:"Other",migrated:true});
  const root=(title:string,group:string,priority:"P0"|"P2"):FixtureItem => ({title,group,priority,updated:at,rev:1,deps:[],links:[],log:[],plan:planWork([planStep("work")])});
  s.items.own=root("Own root","Project","P2"); s.items.needed=root("Needed root","Project","P2"); s.items.user=root("Other root","Other","P0");
  const p=await page(s,[]);
  const section=(g:string) => p.all().find(e=>e.className==="group" && e.dataset.group===g)!;
  const projectTops=() => descendants(section("Project")).filter(e=>e.id.startsWith("it-") || e.className==="shared-sep").map(e=>e.className==="shared-sep" ? "|" : e.id.slice(3)).filter(k=>["area","own","needed","|"].includes(k));
  const user=(rows:PlanRow[],rev:number,status?:"cancelled") => ({...nativeFixture({...s,items:{...s.items,user:{...s.items.user!,plan:planWork(rows),...(status ? {status} : {})}}}).items.user!,rev});
  const write=async (rev:number,rows:PlanRow[],status?:"cancelled") => { await p.change(String(rev).repeat(40),[{kind:"item",id:"user",after:user(rows,rev,status)}]); await p.flush(); };
  assert.deepEqual(projectTops(),["area","own","needed"],"before: both roots are the project's own");
  await write(2,[sharedRow("needed")]);
  assert.deepEqual(projectTops(),["area","own","|","needed"],"the root the other project now waits on sits under the rule, with no reload");
  // A cancelled waiter no longer needs the root, which is the project's own again; reopened, it needs it again.
  await write(3,[sharedRow("needed")],"cancelled");
  assert.deepEqual(projectTops(),["area","own","needed"],"a cancelled waiter does not hold the root under the rule");
  await write(4,[sharedRow("needed")]);
  assert.deepEqual(projectTops(),["area","own","|","needed"],"the reopened waiter holds it there again");
  await write(5,[]);
  assert.deepEqual(projectTops(),["area","own","needed"],"after the row goes it is the project's own root again, and the rule is gone");
});

test("project page follows board project list order on load and live reorder, with new projects last", async () => {
  const s = snapshot();
  s.board.projects = [{ name: "Z first" }, ...s.board.projects, { name: "A last" }];
  const p = await page(s, []);
  const names = () => p.all().filter(e => e.className === "group").map(e => e.dataset.group);
  assert.deepEqual(names(), ["Z first", "Project", "A last"], "project names are not sorted alphabetically or by item priority");
  const reordered = { ...s.board, projects: [s.board.projects[2]!, s.board.projects[0]!, s.board.projects[1]!] };
  await p.change("b".repeat(40), [{ kind: "board", id: "board", after: reordered }]); await p.flush();
  assert.deepEqual(names(), ["A last", "Z first", "Project"]);
  await p.change("c".repeat(40), [{ kind: "board", id: "board", after: { ...reordered, projects: [...reordered.projects, { name: "New" }] } }]); await p.flush();
  assert.deepEqual(names(), ["A last", "Z first", "Project", "New"]);
});

test("project page omits session assignments and shows empty projects", async () => {
  const s=snapshot(); s.board.projects.push({name:"Empty"});
  const p=await page(s,[]), headings=p.all().filter(e=>e.className==="group-head");
  assert.equal(headings.length,2); assert.ok(headings.every(h => !markup(h).includes("负责：")));
});

test("新 counts items: one per item however many changes, a parent adding the items below it, in one chip", async () => {
  const s = snapshot(), id = "f".repeat(40);
  s.items.child!.steps = [{id:"c1",text:"First child part",state:"todo"},{id:"c2",text:"Second child part",state:"todo"},{id:"c3",text:"Third child part",state:"todo"}];
  s.items.area!.steps = [{id:"a1",text:"First parent part",state:"todo"},{id:"a2",text:"Second parent part",state:"todo"}];
  const p = await page(s, [{ id, commits: [id], author: "Session A", at, docs: [
    { kind: "item", id: "child", summary: "head changed, plan changed", pieces: { progress: 3, reply: 0, other: 1 } },
    { kind: "item", id: "area", summary: "plan changed", pieces: { progress: 2, reply: 0, other: 0 } },
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
  const p = await page(snapshot(), [{ id, commits: [id], author: "Session A", at, docs: [{ kind: "item", id: "area", summary: "head changed", pieces: { progress: 0, reply: 0, other: 1 } }] }]);
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
function endpoints(s:PageInput, p:URLSearchParams, before:unknown) { const id=p.get("doc")!, kind=p.get("kind"); return {before,after:kind === "item" ? s.items[id] : kind === "decision" ? s.decisions[id] : s.notes[id],diff:""}; }

test("the blue line marks an item's own new content: new and changed items, not parents of new content or untouched items", async () => {
  const css = await readFile("web/index.html","utf8");
  assert.ok(/[^{}]*\.item\.fresh[^{}]*\{[^}]*var\(--fresh\)/.test(css),"new item bar CSS must use the fresh token");
  const s=snapshot(); s.items.child!.deps=[{id:"area",why:"Created dependency"}]; s.items.child!.links=[{label:"Created link",url:"https://example.com/new"}];
  const created=await page(s,unread(),null); await expand(created);
  assert.ok(item(created).className.split(" ").includes("fresh"));
  const rows=descendants(item(created));
  const dep=rows.find(e=>e.className.includes("plan-row") && e.dataset.sel === "row:child@area")!, link=rows.find(e=>e.tagName === "A" && e.innerHTML === "Created link")!;
  assert.ok(dep.className.split(" ").includes("newbar") && link.className.split(" ").includes("fresh"),"new item dependency and link rows also need blue bars");
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
  p.key("m"); await settle();
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

test("added plan rows and links keep their blue bars and navigation marks", async () => {
  const s=snapshot(), before={...s.items.child!,deps:[],links:[]};
  s.items.child!.deps=[{id:"area",why:"Added dependency"}]; s.items.child!.links=[{label:"Added link",url:"https://example.com/new"}];
  const p=await page(s,unread(),before); await expand(p);
  const rows=descendants(item(p)), dep=rows.find(e=>e.className.includes("plan-row") && e.dataset.sel === "row:child@area")!, link=rows.find(e=>e.tagName === "A" && e.innerHTML === "Added link")!;
  assert.ok(dep.className.split(" ").includes("newbar") && !dep.className.includes("chg-add"));
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
  // where n lands and carries no colour; its ::before is the blue bar.
  assert.ok(!/--chg-add/.test(html) && !rules.some(r=>r[1]!.split(",").some(v=>/\.chg-add\b/.test(v)&&!/::before$/.test(v.trim()))&&/background|color/.test(r[2]!)),"no green mark on added or changed text");
  // The owner does not want removed content shown, struck through in red or otherwise.
  assert.ok(!/chg-del|title-was/.test(html),"no red deleted-text styling");
  for (const sel of [".item.fresh",".card.fresh",".plan-row.newbar",".deprow.fresh",".note.newbar",".note .reply.newbar",".notes-toggle.newbar",".refs .fresh",".rich > .chg-add",".card h3 > .chg-add"]) assert.ok(has(sel+"::before",/background:\s*var\(--fresh\)/) && has(sel,/position:\s*relative/),sel+" has blue bar CSS");
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
  for (const selector of [".item.fresh",".card.fresh",".plan-row.newbar",".deprow.fresh",".note.newbar",".note .reply.newbar",".notes-toggle.newbar",".refs .fresh",".rich > .chg-add",".card h3 > .chg-add"]) await t.test(selector,()=> {
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
  // position: relative is only the containing block of the blue bar; no colour, border or background is added.
  assert.deepEqual(rule[2]!.split(";").map(v=>v.trim()).filter(Boolean),["position: relative","display: flex","flex-direction: column","gap: 6px"],"restore only the lost layout and spacing");
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
  for (const action of ["send","notes","read","delete","json"] as const) await t.test(action, async () => {
    const s=snapshot(), clock=new FakeClock(), hold=deferred<FakeResponse>(), body=deferred<unknown>(); let signal:AbortSignal|undefined;
    s.notes.d={target:"it:area",kind:"comment",text:"Draft",at,state:"draft",rev:1};
    const path=action === "json" ? "/api/send" : action === "delete" ? "/api/notes/d" : "/api/"+action;
    const p=await page(s,unread("item","area"),null,undefined,{clock,response:(url,_value,init)=>{ if (url !== path) return; signal=init.signal; return action === "json" ? {ok:true,status:200,json:()=>body.promise} : hold.promise; }});
    let control:Element, pending:Promise<unknown>|undefined;
    if (action === "send" || action === "json") { control=p.roots.get("send-all")!; pending=control.click(); }
    else if (action === "read") { await button(p,"全部已阅").click(); control=button(p,"确认"); pending=control.click(); }
    else {
      p.key("n"); await settle();
      if (action === "notes") { p.key("c"); await settle(); const text=p.all().find(e=>e.id === "ed-it_area")!; text.value="New draft"; control=button(p,"保存"); pending=control.click(); }
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

test("prose and priority updates preserve sibling cards and owned rows remain in plan order", async () => {
  const s=nativeSnapshot(), frames=new Frames(); s.items.sibling={...s.items.child!,title:"Sibling"}; s.items.area!.plan=planWork([ownedRow("child"),ownedRow("sibling")]); s.decisions.other={...card(),item:"sibling"};
  s.items.pusher={...s.items.area!,title:"Pusher",priority:"P0",plan:planWork([sharedRow("child")])};
  const p=await page(s,[],null,undefined,{frames}); await expand(p,"sibling"); const other=p.document.getElementById("q-other")!;
  p.emit("b".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,head:"Updated head"}}]); await p.flush(); assert.equal(p.document.getElementById("q-other"),other);
  p.emit("c".repeat(40),[{kind:"item",id:"pusher",after:{...s.items.pusher!,plan:planWork([sharedRow("sibling")])}}]); await p.flush();
  assert.deepEqual(p.all().filter(e=>e.id === "it-child" || e.id === "it-sibling").map(e=>e.id),["it-child","it-sibling"],"owned order never follows changed priority");
  p.emit("e".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,plan:planWork([],"done")}}]); await p.flush();
  assert.equal(rowOf(p,"area").querySelector(".counts .done"),null,"a finished part is not counted on its owner's row");
  const open=rowOf(p,"area").querySelectorAll(".counts .st"); assert.equal(open.length,1,"the sibling still open is counted"); assert.equal(open[0]!.innerHTML,"1");
});
test("send hides the chosen card immediately, waits for draft acknowledgement and restores a failed draft", async t => {
  for(const failed of [false,true]) await t.test(failed ? "failure" : "acknowledgement",async()=> {
    const s=snapshot(), clock=new FakeClock(), hold=deferred<FakeResponse>(); s.decisions.q=card();
    const p=await page(s,[],null,undefined,{clock,response:(path,_body,init)=>init.method && init.method !== "GET" && path !== "/api/send" ? hold.promise : undefined}); await expand(p);
    const click=option(p,"A").click(), sending=p.roots.get("send-all")!.click(); await settle();
    assert.equal(p.document.getElementById("q-q")!.hidden,true,"the card hides before the draft server answers");
    assert.equal(p.calls.filter(c=>c.path === "/api/send").length,0,"visible pending draft must settle first");
    if(failed) hold.reject(new Error("Draft refused")); else hold.resolve(reply({note:{id:"persisted",doc:{target:"q:q",kind:"choice",choice:"A",text:"选 A",at,state:"draft",rev:1}},deleted:[],commit:"c".repeat(40)}));
    await click; await sending; await p.flush(); assert.equal(p.calls.filter(c=>c.path === "/api/send").length,failed ? 0 : 1);
    if (failed) {
      assert.equal(p.document.getElementById("q-q")!.hidden,false,"failed draft restores the card");
      assert.equal(option(p,"A").classList.contains("sel"),false,"failed choice restores the previous unselected state");
      assert.equal(option(p,"A").disabled,false);
      assert.equal(cardSend(p).disabled,true,"no failed choice becomes sendable");
      shownInHint(p,/Draft refused/);
    }
  });
});

test("card send hides before send acknowledgement and restores its exact choice and comments on refusal", async () => {
  assert.match(await readFile("web/index.html","utf8"),/\.card\[hidden\]\s*\{\s*display:\s*none\s*;/,"card flex styling must not override the hidden state");
  const s=snapshot(), hold=deferred<FakeResponse>(); s.decisions.q=card();
  s.notes.choice={target:"q:q",kind:"choice",choice:"B",text:"选 B",at,state:"draft",rev:1};
  s.notes.comment={target:"q:q",kind:"comment",text:"Card detail",at,state:"draft",rev:1};
  s.notes.other={target:"it:child",kind:"comment",text:"Unrelated",at,state:"draft",rev:1};
  const p=await page(s,[],null,undefined,{notesOpen:{"q:q":true,"it:child":true},response:path=>path === "/api/send" ? hold.promise : undefined}); await expand(p); await p.flush();
  const before=markup(p.document.getElementById("q-q")!), unrelated=markup(p.document.getElementById("note-other")!);
  const sending=cardSend(p).click();
  assert.equal(p.document.getElementById("q-q")!.hidden,true,"hide synchronously before any server response");
  assert.equal(markup(p.document.getElementById("note-other")!),unrelated,"scoped send leaves other drafts alone");
  await settle();
  assert.deepEqual(p.calls.find(c=>c.path === "/api/send")!.body,{ids:["choice","comment"]});
  hold.reject(new Error("Send refused")); await sending; await p.flush();
  assert.equal(p.document.getElementById("q-q")!.hidden,false);
  assert.equal(markup(p.document.getElementById("q-q")!),before,"choice, note text and draft controls return exactly");
  shownInHint(p,/Send refused/);
});

test("comment, explain and send-all show sent immediately and restore only their affected drafts on failure", async t => {
  for (const action of ["comment","explain","all"] as const) await t.test(action,async()=> {
    const s=snapshot(), hold=deferred<FakeResponse>();
    s.notes.comment={target:"it:child",kind:"comment",text:"Comment text",at,state:"draft",rev:1};
    s.notes.explain={target:"it:child",kind:"explain",text:"请详细解释这一项。",at,state:"draft",rev:1};
    const p=await page(s,[],null,undefined,{notesOpen:{"it:child":true},response:path=>path === "/api/send" ? hold.promise : undefined}); await expand(p); await p.flush();
    const beforeComment=markup(p.document.getElementById("note-comment")!), beforeExplain=markup(p.document.getElementById("note-explain")!);
    const sending=(action === "all" ? p.roots.get("send-all")! : noteButton(p,action,"发送")!).click();
    const selected=action === "all" ? ["comment","explain"] : [action];
    for (const id of selected) {
      assert.match(markup(p.document.getElementById("note-"+id)!),/已发送，等处理/,"mark sent before the server answers");
      assert.equal(noteButton(p,id,"发送"),undefined,"pending sends cannot be clicked twice");
    }
    if (action === "comment") assert.equal(markup(p.document.getElementById("note-explain")!),beforeExplain);
    if (action === "explain") assert.equal(markup(p.document.getElementById("note-comment")!),beforeComment);
    await settle(); hold.reject(new Error("Send refused")); await sending; await p.flush();
    assert.equal(markup(p.document.getElementById("note-comment")!),beforeComment);
    assert.equal(markup(p.document.getElementById("note-explain")!),beforeExplain);
    shownInHint(p,/Send refused/);
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

test("card plan rows show waiting and resolved glyphs, link their question and retain a missing-target fallback", async () => {
  const s=nativeSnapshot(); s.decisions.q={...card(),item:"area"}; s.decisions.r={...card(),question:"已定的问题",item:"area",status:"ruled",ruling:"A"};
  s.items.child!.plan=planWork([cardRow("q"),cardRow("r"),cardRow("gone")]);
  const p=await page(s,[]); await expand(p);
  assert.equal(planRow(p,"child","q").querySelector(".g")!.innerHTML,"⏸");
  assert.equal(planRow(p,"child","r").querySelector(".g")!.innerHTML,"✓");
  assert.equal(planRow(p,"child","gone").querySelector(".g")!.innerHTML,"⏸");
  assert.match(markup(planRow(p,"child","q")),/如何显示/); assert.match(markup(planRow(p,"child","r")),/已定的问题/);
  // A card another item holds unfolds under this row like the item's own card; a missing card keeps its key as a link.
  assert.equal(planRow(p,"child","q").querySelector(".cardtoggle")!.attributes["aria-expanded"],"false");
  assert.equal(planRow(p,"child","q").querySelector(".plan-link")!.dataset.ref,undefined);
  assert.equal(planRow(p,"child","gone").querySelector(".plan-link")!.innerHTML,"gone");
  assert.equal(item(p).querySelectorAll(".why").length,0,"plan rows have no why field");
});
test("card rulings and item progress refresh plan consumers and transitive priority", async () => {
  const s=nativeSnapshot(), frames=new Frames(); s.decisions.q={...card(),item:"area"};
  s.items.child!.plan=planWork([cardRow("q")]);
  s.items.blocker={...s.items.child!,title:"Blocker",plan:planWork([sharedRow("further")])};
  s.items.further={...s.items.child!,title:"Further",plan:planWork([planStep("work")])};
  s.items.waiter={...s.items.child!,title:"Urgent waiter",priority:"P0",plan:planWork([sharedRow("blocker"),planStep("working","Working","doing",{after:[]})])};
  s.items.area!.plan=planWork([ownedRow("child"),ownedRow("blocker"),ownedRow("further")]);
  const p=await page(s,[],null,undefined,{frames}); await expand(p,"further"); assert.match(markup(item(p,"further")),/P0/);
  await expand(p,"child"); assert.equal(planRow(p,"child","q").querySelector(".g")!.innerHTML,"⏸");
  p.emit("b".repeat(40),[{kind:"decision",id:"q",after:{...s.decisions.q!,status:"ruled",ruling:"A"}},{kind:"item",id:"waiter",after:{...s.items.waiter!,status:"cancelled"}}]); await p.flush();
  assert.equal(planRow(p,"child","q").querySelector(".g")!.innerHTML,"✓");
  assert.match(markup(item(p)),/只差验收/); assert.doesNotMatch(markup(item(p)),/可解除阻塞/);
  await expand(p,"further"); assert.equal(item(p,"further").querySelector(".prio")!.innerHTML,"P1");
  await expand(p,"blocker"); assert.ok(!markup(item(p,"blocker")).includes("Urgent waiter"),"cancelled work leaves backlinks and passes no priority");
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

test("replies on a completed item leave its node hidden while its plan row stays visible", async () => {
  const s=nativeSnapshot(), frames=new Frames(); s.items.child!.plan=planWork([],"done");
  const p=await page(s,[],null,undefined,{frames}); await expand(p,"area");
  assert.ok(!rowOf(p,"child")); assert.equal(rowOf(p,"area").querySelector(".caret")!.disabled,true);
  p.emit("b".repeat(40),[{kind:"note",id:"reply",after:{target:"it:child",kind:"comment",text:"Question",reply:"Answered",at,state:"done",repliedAt:"2026-10-13T00:00:00Z",rev:1}}]); await p.flush();
  assert.ok(!rowOf(p,"child")); assert.equal(planRow(p,"area","child").querySelector(".g")!.innerHTML,"✓");
  await planRow(p,"area","child").querySelector(".plan-link")!.click(); await p.flush();
  const child=detailItem(p,"child"); assert.ok(child); assert.ok(!rowOf(p,"child")); assert.match(markup(child),/Answered/);
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

test("reopening a completed sibling restores its node and retains unrelated card identity", async () => {
  const s=nativeSnapshot(), frames=new Frames(); s.items.other={...s.items.child!,title:"Hidden sibling",plan:planWork([],"done")}; s.items.area!.plan=planWork([ownedRow("child"),ownedRow("other")]); s.decisions.q=card();
  const p=await page(s,[],null,undefined,{frames}); await expand(p); const q=p.all().find(e=>e.id === "q-q")!;
  assert.ok(!rowOf(p,"other"));
  p.emit("b".repeat(40),[{kind:"item",id:"other",after:{...s.items.other!,plan:planWork([planStep("again","Verify changed result")])}}]); await p.flush();
  assert.ok(rowOf(p,"other")); assert.ok(p.all().find(e=>e.id === "q-q") === q,"group membership refresh reuses unrelated sibling card");
});

test("draft deletion acknowledgement removes duplicates delivered after the click", async () => {
  const s=snapshot(), frames=new Frames(), ack=deferred<FakeResponse>(); s.decisions.q=card();
  const p=await page(s,[],null,undefined,{frames,response:path=>path === "/api/draft" ? ack.promise : undefined}); await expand(p); const click=option(p,"A").click();
  p.emit("b".repeat(40),[{kind:"note",id:"duplicate",after:{target:"q:q",kind:"choice",choice:"B",text:"Delayed duplicate",at,state:"draft",rev:1}}]); await p.flush();
  ack.resolve(reply({note:{id:"retained",doc:{target:"q:q",kind:"choice",choice:"A",text:"A",at,state:"draft",rev:1}},deleted:["duplicate"],commit:"c".repeat(40)})); await click; await p.flush();
  assert.equal(p.roots.get("send-all")!.textContent,"把 1 条发给 Claude"); assert.ok(option(p,"A").className.includes("sel"));
});

test("atomic owner-plan changes reconcile child membership while reusing sibling cards", async () => {
  const s=nativeSnapshot(), frames=new Frames(); s.decisions.q=card(); s.items.other={...s.items.child!,title:"Other parent",plan:planWork([planStep("work")])};
  const p=await page(s,[],null,undefined,{frames}); await expand(p); const q=p.document.getElementById("q-q")!;
  const added={...s.items.child!,title:"Added child",plan:planWork([planStep("work")])};
  p.emit("b".repeat(40),[{kind:"item",id:"added",after:added},{kind:"item",id:"area",after:{...s.items.area!,rev:2,plan:planWork([ownedRow("child"),ownedRow("added")])}}]); await p.flush();
  assert.ok(p.document.getElementById("it-added")); assert.equal(p.document.getElementById("q-q"),q);
  p.emit("c".repeat(40),[{kind:"item",id:"area",after:{...s.items.area!,rev:3}},{kind:"item",id:"other",after:{...s.items.other!,rev:2,plan:planWork([ownedRow("added")])}}]); await p.flush(); await wideCaret(p,"other").click(); await p.flush();
  assert.ok(descendants(rowOf(p,"other").parentElement!).some(e=>e.id === "it-added")); assert.equal(p.document.getElementById("q-q"),q);
  p.emit("d".repeat(40),[{kind:"item",id:"added",after:null},{kind:"item",id:"other",after:{...s.items.other!,rev:3}}]); await p.flush();
  assert.equal(p.document.getElementById("it-added"),null); assert.equal(p.document.getElementById("q-q"),q);
  p.emit("e".repeat(40),[{kind:"item",id:"other",after:{...s.items.other!,rev:4,priority:"P0"}}]); await p.flush();
  assert.deepEqual(p.all().filter(e=>e.id === "it-area" || e.id === "it-other").map(e=>e.id),["it-area","it-other"]);
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
    else if(path === "dependency") await planRow(p,"area","q").querySelector(".plan-link")!.click();
    else await button(p,"下一条（2/2）").click();
    await p.flush(); assert.equal(p.scrollCount,0,"no document jump may scroll with an unresolved target baseline");
    assert.ok(p.all().some(e=>e.id === "note-n"),"jump unfolds the target comment list");
    // The parent's plan row unfolds the card in the parent, which is unread too: its baseline alone does not release the jump.
    if(path === "dependency") { other.resolve({before:s.items.area,after:s.items.area,diff:""}); await p.flush(); assert.equal(p.scrollCount,0,"the card's own baseline still holds the jump"); }
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

test("document jump restores an already-open target hidden by filtering or completion", async t => {
  for (const hiding of ["filter","completion"]) await t.test(hiding,async()=> {
    const s=snapshot(), frames=new Frames(); s.items.child!.status="todo"; s.items.sibling={...s.items.child!,title:"Sibling",status:"wip",deps:[{id:"child",why:"Needs child"}]}; s.items.area!.deps.push({id:"sibling",why:"Sibling"});
    const p=await page(s,[],null,undefined,{frames}); await expand(p); await rowOf(p,"sibling").querySelector(".item-head")!.click();
    if(hiding === "filter") await p.all().find(e=>e.tagName === "BUTTON" && e.innerHTML.startsWith("进行中 "))!.click();
    else { p.emit("b".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,status:"done"}}]); await p.flush(); }
    assert.ok(!item(p)); const dep=planRow(p,"sibling","child").querySelector(".plan-link")!; assert.ok(dep); await (dep.querySelector(".plan-link") ?? dep).click(); await p.flush();
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
  p=await page(s,fresh,()=>baseline.promise,undefined,{frames,response:path=>path === "/api/unread" ? reply({steps:fresh}) : undefined,detailGeometry:e=>({top:e.dataset.sel === "row:area@child" ? 600 : 0,height:e.dataset.sel === "row:area@child" ? 80 : 2400})});
  await expand(p,"area"); await p.flush();
  const from=p.all().find(e=>e.dataset.sel === "row:area@child")!; assert.ok(from.matches("[data-sel]"),"capture click selects the actual dependency row");
  await from.querySelector(".plan-link")!.click(); await p.flush(); assert.ok(item(p).className.includes("cur"));
  fresh=unread("item","area"); p.emit("b".repeat(40),[{kind:"item",id:"area",after:{...s.items.area!,head:"New parent prose",rev:2}}]); await p.flush();
  const scrolls=p.scrollCount; await button(p,"← 返回").click(); await p.flush(); assert.equal(p.scrollCount,scrolls,"return waits for the enclosing item baseline");
  baseline.resolve({before:s.items.area,after:s.items.area,diff:""}); await p.flush();
  const returned=p.all().find(e=>e.dataset.sel === "row:area@child")!;
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


test("m reads the card selected by 下一条 while an earlier unread item stays new", async () => {
  const s=snapshot(), later="e".repeat(40); s.decisions.q=card(); s.items.child!.ask={text:"Approve"};
  const p=await page(s,[...unread("item","area"),...unread("decision","q",later)]); await expand(p);
  await button(p,"下一条（2/2）").click(); await p.flush();
  assert.ok(p.all().find(e=>e.id === "q-q")!.className.includes("cur"));
  p.key("m"); await p.flush();
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:"decision:q",through:later}]);
  assert.ok(!p.all().find(e=>e.id === "q-q")!.className.includes("fresh"));
  assert.ok(!descendants(p.all().find(e=>e.id === "q-q")!).some(e=>e.className.includes("freshchip")));
  assert.ok(item(p,"area").className.includes("fresh"),"earlier item remains unread");
  assert.ok(p.all().some(e=>e.innerHTML === "新 1 ›"));
});

test("m on a read selection shows a passing hint, not a kept error, and writes nothing", async () => {
  const clock=new FakeClock();
  const p=await page(snapshot(),[],null,undefined,{clock}); await item(p,"area").children[0]!.click(); p.key("m");
  const hint=p.roots.get("hint")!;
  assert.equal(hint.hidden,false); assert.match(hint.textContent,/这里没有新内容/);
  assert.equal(p.roots.get("server-banner")!.hidden,true,"the error banner stays for errors");
  assert.equal(p.calls.filter(c=>c.path === "/api/read").length,0);
  clock.advance(3000); assert.equal(hint.hidden,true,"the hint leaves by itself");
  p.key("m"); assert.equal(hint.hidden,false);
  p.key("j"); assert.equal(hint.hidden,true,"the next key clears it");
});

test("m reads all selected document steps from item card note and log clicks", async t => {
  for(const selection of ["item","decision","note","log"] as const) await t.test(selection,async()=> {
    const s=snapshot(), first="e".repeat(40), last="f".repeat(40), kind=selection === "log" ? "item" : selection;
    s.decisions.q=card(); s.items.child!.log=[{at,text:"Latest log"}];
    s.notes.n={target:"it:child",kind:"comment",text:"Question",at,state:"done",reply:"Answer",rev:1};
    const id=kind === "item" ? "child" : kind === "decision" ? "q" : "n";
    const p=await page(s,[...unread("item","area"),...unread(kind,id,first),...unread(kind,id,last)],null,undefined,{notesOpen:{"it:child":true}}); await expand(p);
    if (selection === "log") await button(p,"▸ 日志").click();
    const box=selection === "item" ? item(p) : selection === "decision" ? p.all().find(e=>e.id === "q-q")! : selection === "note" ? p.all().find(e=>e.id === "note-n")! : p.all().find(e=>e.dataset.sel?.startsWith("log:child@"))!;
    await box.click(); p.key("m"); await p.flush();
    assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:kind+":"+id,through:last}]);
    assert.ok(item(p,"area").className.includes("fresh"));
    assert.ok(p.all().some(e=>e.innerHTML === "新 1 ›"),"all steps of the selected document were read");
  });
});

test("m on a card reads its whole item at once and restores both on error or eight-second deadline without retry", async t => {
  for(const failure of ["refused","deadline"] as const) await t.test(failure,async()=> {
    const s=snapshot(), clock=new FakeClock(), hold=deferred<FakeResponse>(); s.decisions.q=card(); let signal:AbortSignal|undefined;
    const p=await page(s,[...unread("item","child"),...unread("decision","q","e".repeat(40))],null,undefined,{clock,response:(path,_body,init)=> { if(path === "/api/read") { signal=init.signal; return hold.promise; } }}); await expand(p);
    await p.all().find(e=>e.id === "q-q")!.click(); p.key("m");
    assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>(c.body as {doc:string}).doc).sort(),["decision:q","item:child"],"m on the card reads the item holding it with the card");
    assert.ok(!p.all().find(e=>e.id === "q-q")!.className.includes("fresh"),"read is painted before fetch settles");
    assert.ok(!item(p).className.includes("fresh"));
    assert.ok(!p.all().some(e=>e.innerHTML.startsWith("新 ")));
    p.key("m"); assert.equal(p.calls.filter(c=>c.path === "/api/read").length,2,"pending reads are not repeated");
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
  await p.all().find(e=>e.id === "q-q")!.click(); p.key("m");
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
    await p.all().find(e=>e.id === "q-q")!.click(); p.key("m");
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


test("m reads every selected document kind even when the fresh filter hides its latest step", async () => {
  const s=snapshot(), first="e".repeat(40), last="f".repeat(40); s.items.child!.steps=[{id:"progress",text:"Progress",state:"todo"}];
  const fresh=[...unread("item","area"),{...unread("item","child",first)[0]!,docs:[{kind:"item",id:"child",summary:"plan changed",pieces:{progress:1,reply:0,other:0}}]},...unread("item","child",last)];
  const p=await page(s,fresh); await expand(p); await button(p,"进展 1").click();
  p.key("n"); await p.flush(); assert.ok(item(p).className.includes("cur"));
  p.key("m"); await p.flush();
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
  await rowOf(p).querySelector(".item-head")!.click(); await planRow(p,"child","q").querySelector(".cardtoggle")!.click(); await p.flush();
  assert.ok(p.all().find(e=>e.id === "q-q")!.className.includes("cur"));
  p.key("m"); await p.flush();
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:"decision:q",through:later}]);
  assert.ok(item(p,"area").className.includes("fresh"));
  assert.ok(!p.all().find(e=>e.id === "q-q")!.className.includes("fresh"));
}
test("m follows a dependency-selected card instead of the document previously shown by n", async () => {
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
test("existing menu help states shortcut selection scope and explains only the three numeric row marks", async () => {
  const p=await page(snapshot(),[]), menu=p.document.getElementById("keymenu")!;
  assert.equal(menu.querySelectorAll(".keymenu-head").length,1,"help extends the existing description");
  const help=menu.querySelector(".keymenu-head")!.innerHTML;
  assert.match(help,/^快捷键：已阅需要选中条目或卡片；评论和解释在没选中时作用于屏幕最上面那一条<br>/,"the shortcut sentence distinguishes actions that require selection");
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
  const s=nativeSnapshot(); s.items.todo={...s.items.child!,title:"Todo",plan:planWork([planStep("work")])}; s.items.area!.plan=planWork([ownedRow("child"),ownedRow("todo")]);
  const p=await page(s,[]), counts=rowOf(p,"area").querySelector(".counts")!;
  assert.deepEqual(counts.children.map(e=>e.innerHTML),["1","1"]);
  for (const [i,status] of ["todo","wip"].entries()) { const count=counts.children[i]!; assert.ok(count.classList.contains(status)); assert.equal(count.title,""); assert.equal(count.attributes["aria-label"],status.toUpperCase()+" 1"); }
});
test("split divider pointer drag clamps both columns and persists the width", async () => {
  const storage=new Map<string,string>(), p=await page(snapshot(),[],null,undefined,{storage});
  await selectWide(p);
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

test("the page collapses unselected detail and opens a split view on selection without a layout toggle", async () => {
  const html=await readFile("web/index.html","utf8");
  assert.match(html,/<body class="wide">/,"the viewport remains the panes' fixed-height frame");
  assert.match(html,/<div class="wrap detail-collapsed">/,"unselected first paint uses the full-width tree");
  assert.match(html,/id="split-divider"[^>]*hidden/);
  assert.match(html,/id="item-detail"[^>]*hidden/);
  assert.doesNotMatch(html,/split-toggle/);
  const storage=new Map<string,string>(), p=await page(snapshot(),[],null,undefined,{storage});
  assert.equal(p.roots.get("item-detail")!.hidden,true); assert.equal(p.roots.get("split-divider")!.hidden,true);
  assert.ok(p.wrap.classList.contains("detail-collapsed"));
  assert.equal(p.document.getElementById("split-toggle"),null,"there is no 分屏 / 单栏 toggle");
  assert.ok(!p.all().some(e=>e.innerHTML === "单栏" || e.innerHTML === "分屏"));
  await selectWide(p); await p.flush();
  assert.equal(p.roots.get("item-detail")!.hidden,false); assert.equal(p.roots.get("split-divider")!.hidden,false);
  assert.ok(!p.wrap.classList.contains("detail-collapsed"));
  assert.ok(detailItem(p),"a head click selects the item for the detail column");
  assert.equal(rowOf(p,"area").querySelector(".body"),null,"the tree never holds a body");
  assert.ok(![...storage.keys()].some(k=>k === "board-split"),"no layout choice is stored");
  assert.ok(p.all().filter(e=>e.id.startsWith("it-")).every(e=>!e.querySelector(".body")),"no tree row holds a body");
});

test("the page tolerates unavailable localStorage", async () => {
  const p=await page(snapshot(),[],null,undefined,{storageUnavailable:true});
  assert.equal(p.roots.get("item-detail")!.hidden,true);
  await selectWide(p); assert.ok(detailItem(p),"selecting still works without storage");
  await p.roots.get("split-divider")!.pointer("pointerdown",{clientX:400});
  await p.roots.get("split-divider")!.pointer("pointermove",{clientX:420});
  assert.ok(Number.isFinite(parseFloat(p.wrap.style["--tree-width"]!)));
});

test("blank space in either pane clears both selections and reselecting restores the dragged width", async t => {
  for (const pane of ["page-left","item-detail"] as const) await t.test(pane,async()=> {
    const storage=new Map<string,string>(), s=snapshot(); s.items.child!.head="Picked child detail";
    const p=await page(s,[],null,undefined,{storage});
    await wideCaret(p).click(); await p.flush(); await selectWide(p,"child");
    const divider=p.roots.get("split-divider")!;
    await divider.pointer("pointerdown",{clientX:400}); await divider.pointer("pointermove",{clientX:480}); await divider.pointer("pointerup",{clientX:480});
    const width=p.wrap.style["--tree-width"]!;
    assert.ok(rowOf(p,"child").classList.contains("selected")); assert.ok(detailItem(p,"child")!.classList.contains("cur"));
    const blank=p.document.createElement("div"); p.roots.get(pane)!.appendChild(blank); await blank.click(); await p.flush();
    assert.equal(p.all().filter(e=>e.classList.contains("selected") || e.classList.contains("cur")).length,0,"neither pane retains a selected row");
    assert.equal(p.roots.get("item-detail")!.children.length,0,"detail has no selected content or placeholder");
    assert.equal(p.roots.get("item-detail")!.hidden,true); assert.equal(divider.hidden,true);
    assert.ok(p.wrap.classList.contains("detail-collapsed"));
    assert.equal(storage.get("board-selected"),"","a cleared selection is persisted");
    assert.equal(storage.get("board-tree-width"),String(parseFloat(width)),"collapse preserves the dragged width");
    const reloaded=await page(s,[],null,undefined,{storage});
    assert.equal(reloaded.roots.get("item-detail")!.hidden,true,"reload does not restore the cleared item");
    assert.ok(reloaded.wrap.classList.contains("detail-collapsed"));
    await selectWide(p,"child");
    assert.equal(p.roots.get("item-detail")!.hidden,false); assert.equal(divider.hidden,false);
    assert.ok(!p.wrap.classList.contains("detail-collapsed"));
    assert.match(markup(detailItem(p,"child")!),/Picked child detail/);
    assert.ok(rowOf(p,"child").classList.contains("selected"));
    assert.equal(p.wrap.style["--tree-width"],width,"reopening uses the existing remembered split width");
  });
});

test("controls divider clicks and text-selection drags preserve an open detail", async () => {
  const p=await page(snapshot(),[]); await selectWide(p);
  const picked=detailItem(p)!, divider=p.roots.get("split-divider")!;
  const dividerTarget=p.document.createElement("span"); divider.appendChild(dividerTarget);
  await dividerTarget.click(); await p.flush();
  assert.equal(detailItem(p),picked,"the click after divider dragging does not clear selection");
  await wideCaret(p).click(); await p.flush(); assert.equal(detailItem(p),picked,"folding is independent of detail selection");
  const blank=p.document.createElement("div"); p.roots.get("page-left")!.appendChild(blank);
  p.press(0,0,true); await blank.click({clientX:100,clientY:0}); await p.flush();
  assert.equal(detailItem(p),picked,"a text-selection drag ending on blank space does not deselect");
  p.press(0,0,false); await blank.click(); await p.flush();
  assert.equal(p.roots.get("item-detail")!.hidden,true,"an ordinary blank click still deselects");
});

test("blank deselection cancels an unread jump waiting for its baseline", async () => {
  const s=snapshot(), baseline=deferred<unknown>();
  const p=await page(s,unread(),async()=>baseline.promise);
  p.key("n"); await settle();
  assert.ok(detailItem(p,"child"),"navigation opens the target before its baseline arrives");
  const blank=p.document.createElement("div"); await blank.click();
  baseline.resolve({before:null,after:s.items.child,diff:""}); await p.flush();
  assert.equal(p.all().filter(e=>e.classList.contains("cur") || e.classList.contains("selected")).length,0,"the late baseline cannot revive a cleared selection");
  assert.equal(p.roots.get("item-detail")!.hidden,true);
  p.key("n"); await p.flush(); assert.ok(detailItem(p,"child"),"a new unread jump can reopen the detail");
});

function collapsedTreeContract(html:string) {
  const rules=[...html.replace(/\/\*[\s\S]*?\*\//g,"").matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  const rule=rules.find(r=>r[1]!.trim() === "body.wide .wrap.detail-collapsed");
  assert.ok(rule,"collapse has a more specific rule than both desktop and narrow split layouts");
  assert.match(rule[2]!,/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/,"one column gives the tree all available width");
  assert.match(rule[2]!,/min-width:\s*0\s*;/,"collapse does not retain the split's desktop minimum");
}
test("collapsed layout fills the tree width at desktop and narrow widths and rejects missing collapse CSS", async () => {
  const html=await readFile("web/index.html","utf8"); collapsedTreeContract(html);
  assert.throws(()=>collapsedTreeContract(html.replace(/body\.wide \.wrap\.detail-collapsed\s*\{[^}]*\}/,"")));
  assert.throws(()=>collapsedTreeContract(html.replace(/(body\.wide \.wrap\.detail-collapsed\s*\{[^}]*grid-template-columns:)\s*minmax\(0, 1fr\)/,"$1 300px 8px 1fr")));
});

test("parent leaf counts are number-only with a status label", async () => {
  const s=nativeSnapshot(); s.items.todo={...s.items.child!,title:"Todo",plan:planWork([planStep("work")])}; s.decisions.wait=card(); s.items.block={...s.items.child!,title:"Blocked",plan:planWork([cardRow("wait")])}; s.items.area!.plan=planWork([ownedRow("child"),ownedRow("todo"),ownedRow("block")]);
  const p=await page(s,[]), counts=rowOf(p,"area").querySelector(".counts")!;
  assert.deepEqual(counts.children.map(e=>e.innerHTML),["1","1","1"]);
  for (const [i,label] of ["TODO","WIP","BLOCK"].entries()) { assert.equal(counts.children[i]!.title,""); assert.equal(counts.children[i]!.attributes["aria-label"],label+" 1"); }
});
// Cancellation is stored on each work item; owned cancelled rows remain in plans.
function cancelledSnapshot(): Snapshot {
  const s=nativeSnapshot();
  s.items.gone={...s.items.child!,title:"Gone",status:"cancelled",plan:planWork([sharedRow("child")])};
  s.items.dropped={...s.items.child!,title:"Dropped",status:"cancelled",plan:planWork([ownedRow("droppedKid")])};
  s.items.droppedKid={...s.items.child!,title:"Dropped kid",status:"cancelled"};
  s.items.topGone={...s.items.area!,title:"Top gone",status:"cancelled",plan:planWork([])};
  s.items.area!.plan=planWork([ownedRow("child"),ownedRow("gone"),ownedRow("dropped")]);
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
test("plans keep cancelled owned rows and missing targets while backlinks omit owners and cancelled waiters", async () => {
  const s=cancelledSnapshot(); s.items.old={...s.items.child!,title:"Old",status:"cancelled"}; s.items.area!.plan=planWork([ownedRow("child"),ownedRow("gone"),ownedRow("dropped"),sharedRow("missing")]);
  const before={...s.items.area!,plan:planWork([ownedRow("child"),ownedRow("gone"),ownedRow("dropped"),sharedRow("missing"),sharedRow("old")])};
  const p=await page(s,unread("item","area"),before); await expand(p,"area"); await p.flush();
  assert.equal(planRow(p,"area","gone").querySelector(".g")!.innerHTML,"✗"); assert.ok(planRow(p,"area","dropped"));
  assert.ok(planRow(p,"area","missing")); assert.equal(p.document.getElementById(planRowDomId("area","old")),null,"removed rows never render");
  await expand(p,"child"); const backlinks=item(p).querySelector(".deplists"); assert.equal(backlinks,null,"the cancelled waiter is omitted"); assert.equal(item(p).querySelector(".item-owner"),null,"an owned item's detail has no 属于 line"); assert.doesNotMatch(markup(item(p)),/属于/);
});test("tree head structure and CSS keep badges chips title and counts on one line", async () => {
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
  const s=snapshot(), before={...s.items.child!,steps:[]}; s.items.child!.steps=[{id:"fresh",state:"todo",text:"Fresh step"}];
  const p=await page(s,unread(),before,undefined,{detailGeometry:e=>({top:e.className.includes("plan-row") ? 1800 : 50,height:e.id === "detail-it-child" ? 2400 : 100})});
  p.key("n"); await p.flush();
  assert.ok(detailItem(p,"child"),"n selects the item in the detail pane");
  assert.ok(rowOf(p,"child").className.includes("cur"),"n unfolds ancestors and highlights the target tree row");
  assert.ok(p.roots.get("item-detail")!.scrollTop>1000,"fresh mark navigation uses the independently scrolled pane");
  assert.ok(p.measurements.some(m=>m.id === planRowDomId("child","fresh") && m.top>1000),"the fresh step supplies the landing geometry");
  const landed=p.document.getElementById(planRowDomId("child","fresh"))!.getBoundingClientRect();
  assert.ok(landed.top>=0 && landed.bottom<=p.roots.get("item-detail")!.clientHeight,"the first fresh mark lands inside the right pane viewport");
  assert.ok(p.scrollY<1000,"the detail's distant mark does not scroll the tree to that offset");
});

test("wide m on a selected detail log entry reads its item and leaves sub-items unread", async () => {
  const s=snapshot(); s.items.area!.log=[{at,text:"Parent history"}]; s.items.area!.head="Unread head";
  const p=await page(s,[...unread("item","area"),...unread()]);
  await selectWide(p);
  await button(p,"▸ 日志").click();
  const log=detailItem(p)?.querySelector(".log-entry"); assert.ok(log,"the log entry is in the selected detail");
  await log.click(); p.key("m"); await p.flush();
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:"item:area",through:stepId}]);
  await wideCaret(p).click(); await p.flush();
  assert.ok(rowOf(p,"child").className.includes("fresh"),"m leaves the child's own new content unread");
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
  assert.equal(removed.roots.get("item-detail")!.hidden,true,"a removed stored selection leaves the tree full-width");
  assert.equal(removed.roots.get("split-divider")!.hidden,true);
});

test("wide dependency follow and Backspace restore the prior dependency selection", async () => {
  const p=await page(snapshot(),[]); await selectWide(p);
  const from=detailItem(p)?.querySelectorAll(".plan-row").find(e=>e.dataset.sel === "row:area@child");
  assert.ok(from,"the source dependency is rendered in the detail pane");
  await from.querySelector(".plan-link")!.click(); await p.flush(); assert.ok(detailItem(p,"child"),"following a dependency selects its target");
  p.key("Backspace"); await p.flush();
  const returned=detailItem(p)?.querySelectorAll(".plan-row").find(e=>e.dataset.sel === "row:area@child");
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
  const dep=p.all().find(e=>e.dataset.sel === "row:area@far")!;
  pane.scrollTo(0,700); await p.flush(); assert.equal(pane.scrollTop,700);
  await (dep.querySelector(".plan-link") ?? dep).click(); await p.flush();
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

test("wide blank clicks clear both selections and keyboard actions use the visible tree or navigation cursor", async t => {
  for (const action of ["m","c","e","Enter","j","k","ArrowRight","ArrowLeft","n","N"] as const) await t.test(action,async()=> {
    const s=snapshot(), fresh=[...unread("item","area"),...unread("item","child","e".repeat(40))];
    s.items.area!.ask={text:"Parent ask"}; s.items.child!.ask={text:"Child ask"};
    s.items.other={title:"Following root",group:"Project",status:"todo",priority:"P2",ask:{text:"Other ask"},updated:at,rev:1,deps:[],links:[],log:[]};
    const p=await page(s,fresh,null,undefined,{geometry:e=>({top:e.id === "it-area" ? 300 : e.id === "it-child" ? 450 : e.id === "it-other" ? 600 : 50,height:100})});
    await wideCaret(p).click(); await p.flush(); await selectWide(p,"child");
    const displayed=detailItem(p,"child"); assert.ok(displayed);
    const blank=p.document.createElement("div"); blank.focus(); await blank.click();
    assert.equal(p.all().filter(e=>e.classList.contains("cur")).length,0,"blank space clears the current item or sub-selection");
    assert.equal(p.all().filter(e=>e.classList.contains("selected")).length,0,"the displayed item's tree highlight clears too");
    assert.equal(detailItem(p,"child"),null,"the old detail is removed");
    assert.equal(p.roots.get("item-detail")!.hidden,true);
    const prevented=p.key(action); await p.flush();
    if (action === "m") {
      assert.equal(p.calls.filter(c=>c.path === "/api/read").length,0,"m does not read the cleared item or imply a new selection");
      assert.equal(p.roots.get("item-detail")!.hidden,true,"reading does not open a detail selection");
      p.key("n"); await p.flush(); p.key("m"); await p.flush();
      assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:"item:area",through:stepId}],"n explicitly reselects the first unread item so m can read it");
      assert.ok(rowOf(p,"child").className.includes("fresh"),"reading the reopened parent leaves the child unread");
    } else if (action === "c") { assert.ok(p.document.getElementById("ed-it_area")); assert.equal(p.document.getElementById("ed-it_child"),null); }
    else if (action === "e") assert.equal((p.calls.find(c=>c.path === "/api/draft")!.body as {target:string}).target,"it:area");
    else if (action === "Enter") { assert.equal(prevented,false); assert.equal(p.roots.get("item-detail")!.hidden,true,"Enter with no focused or selected head leaves detail collapsed"); }
    else if (action === "j" || action === "k") {
      assert.ok(rowOf(p,"area").className.includes("cur"),"tree focus starts at the first visible row with no selection");
      assert.equal(p.roots.get("item-detail")!.hidden,true,"moving focus leaves detail collapsed");
      p.key("Enter"); await p.flush(); assert.ok(detailItem(p,"area"),"Enter opens the newly focused head");
    } else if (action === "ArrowRight" || action === "ArrowLeft") assert.ok(detailItem(p,action === "ArrowRight" ? "area" : "other"),"owner-work navigation starts from the visible waits with no selection");
    else assert.ok(detailItem(p,action === "n" ? "area" : "child"),"fresh navigation retains its global cursor and selects its stop");
  });
});

test("an operation error shows in the bottom hint for three seconds and leaves the connection banner alone", async () => {
  const clock=new FakeClock(), s=snapshot(), failing=(path:string)=> path === "/api/read" ? {ok:false,status:400,json:async()=>({error:"Read refused"})} as FakeResponse : undefined;
  const p=await page(s,unread("item","area"),null,undefined,{clock,response:failing});
  const hint=p.roots.get("hint")!, banner=p.roots.get("server-banner")!;
  p.key("n"); await p.flush(); p.key("m"); await p.flush();
  assert.equal(p.calls.filter(c=>c.path === "/api/read").length,1,"the failing write was attempted");
  assert.equal(hint.hidden,false); assert.equal(hint.textContent,"Read refused");
  assert.equal(banner.hidden,true,"an operation error is an event, not the connection state"); assert.equal(banner.textContent,"");
  clock.advance(2999); assert.equal(hint.hidden,false,"the hint is still showing just before three seconds");
  clock.advance(1); assert.equal(hint.hidden,true,"the hint leaves by itself after three seconds");
  assert.equal(banner.hidden,true);
});

test("completed and cancelled nodes default to hidden and the status filters show all ages in place", async () => {
  const s=nativeSnapshot();
  s.items.child!.plan=planWork([],"done").map(row=>"text" in row ? {...row,doneAt:"2020-01-01T00:00:00Z"} : row); s.items.child!.updated="2020-01-01T00:00:00Z";
  s.items.gone={...s.items.child!,title:"Cancelled child",status:"cancelled",plan:planWork([],"dropped")};
  s.items.rootDone={...s.items.child!,title:"Completed root"};
  s.items.rootGone={...s.items.gone!,title:"Cancelled root"};
  s.items.area!.plan=planWork([ownedRow("child"),ownedRow("gone"),planStep("work","Remaining parent work","doing",{after:[]})]);
  const p=await page(s,[]); await expand(p,"area");
  for (const id of ["child","gone","rootDone","rootGone"]) assert.ok(!rowOf(p,id));
  assert.equal(planRow(p,"area","child").querySelector(".g")!.innerHTML,"✓");
  assert.equal(planRow(p,"area","gone").querySelector(".g")!.innerHTML,"✗");
  assert.match(markup(planRow(p,"area","child")),/Child/); assert.match(markup(planRow(p,"area","gone")),/Cancelled child/);
  const done=p.all().find(e=>e.tagName === "BUTTON" && e.innerHTML === "完成 2")!; await done.click(); await p.flush();
  assert.ok(rowOf(p,"child") && rowOf(p,"rootDone"),"完成 shows old completed work and roots, not only the seven-day window");
  assert.ok(!rowOf(p,"gone") && !rowOf(p,"rootGone"));
  const cancelled=p.all().find(e=>e.tagName === "BUTTON" && e.innerHTML === "取消 2")!; await cancelled.click(); await p.flush();
  assert.ok(rowOf(p,"gone") && rowOf(p,"rootGone"));
  assert.deepEqual(rowOf(p,"area").parentElement!.querySelector("ul")!.children.map(li=>li.children[0]!.id),["it-child","it-gone"],"the combined filters keep owned row order");
  await button(p,"清除筛选").click(); await p.flush();
  assert.ok(!rowOf(p,"child") && !rowOf(p,"gone"));
  assert.ok(planRow(p,"area","child") && planRow(p,"area","gone"),"filter reset never removes plan rows from selected detail");
});

test("closed owners remain dimmed default paths to open descendants and leave when the last descendant closes", async t => {
  for (const ownerState of ["done","cancelled"] as const) await t.test(ownerState,async()=> {
    const s=nativeSnapshot();
    s.items.leaf={...s.items.child!,title:"Open descendant",plan:planWork([])};
    s.items.closedChild={...s.items.child!,title:"Already completed descendant",plan:planWork([],"done")};
    s.items.middle={...s.items.child!,title:"Closed intermediate owner",status:"cancelled",plan:planWork([ownedRow("leaf"),ownedRow("closedChild")])};
    s.items.child={...s.items.child!,title:"Closed child owner",status:"cancelled",plan:planWork([ownedRow("middle")])};
    s.items.area!.plan=planWork([ownedRow("child")],ownerState === "done" ? "done" : "todo");
    if (ownerState === "cancelled") s.items.area!.status="cancelled";
    s.items.closedRoot={...s.items.closedChild!,title:"Closed root without open descendants"};
    assert.equal(rules(s).statusOf("area"),ownerState,"a done owner resolves its cancelled child even with pre-refusal open descendants");
    const storage=new Map<string,string>();
    const p=await page(s,[],null,undefined,{storage});
    for (const id of ["area","child","middle"]) {
      const row=rowOf(p,id); assert.ok(row,"each closed owner is retained in the default path");
      assert.ok(row.classList.contains("ctx"),"the closed path uses existing dimmed context styling");
      assert.ok(row.classList.contains(id === "area" ? ownerState : "cancelled"),"visibility never changes its status");
      const caret=row.querySelector(".caret"); assert.ok(caret); assert.equal(caret.disabled,false,"the default path can be unfolded");
      await caret.click(); await p.flush();
    }
    const leaf=rowOf(p,"leaf"); assert.ok(leaf,"the open descendant stays reachable through every closed owner");
    assert.ok(!leaf.classList.contains("ctx"));
    assert.ok(!rowOf(p,"closedChild") && !rowOf(p,"closedRoot"),"closed work without open descendants stays hidden");
    await leaf.querySelector(".item-head")!.click(); await p.flush();
    assert.ok(detailItem(p,"leaf"),"the open descendant remains selectable from its tree node");
    assert.ok(!storage.has("board-filters2"),"showing the ownership path needs no status filter choice");
    const todo=p.all().find(e=>e.tagName === "BUTTON" && e.innerHTML === "未开始 1"); assert.ok(todo); await todo.click(); await p.flush();
    assert.ok(rowOf(p,"leaf") && rowOf(p,"area").classList.contains("ctx"),"an explicit open filter also retains the dimmed path");
    await button(p,"清除筛选").click(); await p.flush();
    assert.ok(rowOf(p,"leaf"),"clearing filters returns to the reachable default tree");
    const after={...s.items.leaf!,plan:planWork([],"done"),updated:"2026-10-12T01:02:03Z",rev:2};
    await p.change("e".repeat(40),[{kind:"item",id:"leaf",after}]); await p.flush();
    for (const id of ["area","child","middle","leaf","closedChild","closedRoot"]) assert.ok(!rowOf(p,id),"closing the last open descendant removes the closed default path");
    assert.ok(detailItem(p,"leaf"),"hiding tree nodes does not discard the selected closed item's detail");
    const done=p.all().find(e=>e.tagName === "BUTTON" && /^完成 \d/.test(e.innerHTML)); assert.ok(done); await done.click(); await p.flush();
    assert.ok(rowOf(p,"leaf") && rowOf(p,"area") && rowOf(p,"child") && rowOf(p,"middle"),"the completed filter restores the same ownership path after closure");
  });
});

test("hidden closed item references open detail and Back returns without changing the filter choice", async t => {
  for (const state of ["done","cancelled"] as const) await t.test(state,async()=> {
    const s=nativeSnapshot(), storage=new Map<string,string>();
    s.items.child!.plan=planWork([],state === "done" ? "done" : "dropped");
    if (state === "cancelled") s.items.child!.status="cancelled";
    const p=await page(s,[],null,undefined,{storage}); await expand(p,"area");
    await planRow(p,"area","child").querySelector(".plan-link")!.click(); await p.flush();
    const child=detailItem(p,"child"); assert.ok(child,"the hidden child's detail is rendered");
    assert.ok(child.className.includes("cur")); assert.ok(!rowOf(p,"child"));
    assert.ok(!storage.has("board-filters2"),"following a plan row does not switch the closed status filter on");
    p.key("Backspace"); await p.flush(); assert.ok(detailItem(p,"area"));
    const reloaded=await page(s,[],null,undefined,{storage:new Map<string,string>([...storage,["board-selected","child"]])});
    assert.ok(detailItem(reloaded,"child")); assert.ok(!rowOf(reloaded,"child"),"reload keeps a hidden selected item's detail available");
  });
});

test("done and cancelled items holding unread item, card or reply content show dimmed in the tree and can be read", async t => {
  for (const state of ["done","cancelled"] as const) for (const kind of ["item","decision","note"] as const) await t.test(state+" "+kind,async()=> {
    const s=nativeSnapshot(), baseline={...s.items.child!,head:"Before"};
    s.items.child!.plan=planWork([],state === "done" ? "done" : "dropped"); s.items.child!.head="Changed";
    if (state === "cancelled") s.items.child!.status="cancelled";
    s.decisions.q={...card(),status:"ruled",ruling:"A"};
    s.notes.n={target:"it:child",kind:"comment",text:"Question",at,state:"done",reply:"New answer",repliedAt:at,rev:1};
    const id=kind === "item" ? "child" : kind === "decision" ? "q" : "n";
    const p=await page(s,unread(kind,id),kind === "item" ? baseline : null); await expand(p,"area");
    // Owner, 2026-10-14: n only lands on rows on screen, so a closed item holding unread content shows, dimmed.
    assert.ok(rowOf(p,"child")?.className.includes("fresh-ended"),"the closed item shows dimmed while it holds unread content"); assert.ok(p.all().some(e=>e.innerHTML === "新 1 ›"));
    const chip=rowOf(p,"area").querySelector(".freshchip")!; assert.ok(chip,"a hidden child's unread content still reaches its visible owner");
    await chip.click(); await p.flush();
    const child=detailItem(p,"child"); assert.ok(child); assert.ok(rowOf(p,"child"));
    const target=kind === "item" ? child : p.document.getElementById(kind === "decision" ? "q-q" : "note-n");
    assert.ok(target,"the unread target is rendered inside the hidden item's detail");
    assert.ok(target.className.includes("cur"));
    if (kind === "item") assert.match(markup(child),/chg-add[^]*Changed/,"baseline marks load without a tree node");
    p.key("m"); await p.flush();
    assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:kind+":"+id,through:stepId}]);
    assert.ok(!p.all().some(e=>e.innerHTML === "新 1 ›"));
  });
});

test("retired stored filter values do not hide the project's open nodes", async () => {
  const storage=new Map<string,string>([["board-filters2",JSON.stringify({Project:{status:["archived"],dep:""}})]]);
  const p=await page(nativeSnapshot(),[],null,undefined,{storage}); await expand(p);
  assert.ok(rowOf(p,"area") && rowOf(p,"child"));
  assert.ok(!p.all().some(e=>e.innerHTML.includes("归档")));
});

test("archive controls and shortcut are removed", async () => {
  const p=await page(nativeSnapshot(),[]); await expand(p);
  assert.ok(!p.all().some(e => e.innerHTML.includes("归档")));
  assert.match(p.document.getElementById("keymenu")!.querySelector(".keymenu-head")!.innerHTML,/右侧状态色数字是子树叶条目按状态分类的数量，不计取消的条目。/);
  assert.equal(p.key("a"),false,"the retired key has no action");
  assert.ok(!p.calls.some(c => c.path === "/api/archive"));
  const source=await readFile("web/app.ts","utf8"); assert.ok(!source.includes("/api/archive"));
});

test("a shared waiter raises priority and the page shows the derived value without a legacy struck value", async () => {
  const s=nativeSnapshot(); s.board.projects.push({name:"Elsewhere"});
  s.items.waiter={...s.items.area!,title:"Waiter",group:"Elsewhere",priority:"P0",plan:planWork([sharedRow("child")])};
  const p=await page(s,[]); await expand(p);
  assert.equal(item(p).querySelector(".prio")!.innerHTML,"P0");
  assert.equal(item(p).querySelector(".prio-was"),null); assert.ok(!markup(item(p)).includes("按 P0 排"));
});
// Glossary links: each project's glossary; the anchor a term link leads to, as the page names it.
function glossaries<T extends PageInput>(s: T): T {
  const term = (term: string, definition: string, by: string) => ({ term, definition, updated: at, by });
  s.board.projects.push({ name: "Other" });
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
  await button(p,"▸ 日志").click();
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
function linked(): PageFixture {
  const s = snapshot(); s.decisions.q = card();
  s.items.shipped = { title: "已交付 Alpha", group: "Project", status: "done", priority: "P2", updated: at, rev: 1, deps: [], links: [], log: [] };
  s.items.dropped = { title: "取消的 Beta", parent: "area", status: "cancelled", priority: "P2", updated: at, rev: 1, deps: [], links: [], log: [] };
  return s;
}
const classes = (e: Element) => e.className.split(" ");
const rowTitle = (e: Element) => e.innerHTML.match(/class="t">([^<]*)</)![1]!;
async function composer(snap: PageInput = linked(), extra: PageOptions = {}) {
  const p = await page(snap, [], null, undefined, { response: path => path === "/api/notes" ? reply({ id: "saved" }) : undefined, ...extra });
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
  await button(p,"▸ 日志").click();
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
  assert.ok(!rowOf(p,"dropped"),"following a closed item leaves its tree node hidden");
  assert.equal(planRow(p,"dropped","accept").querySelector(".g")!.innerHTML,"○","a converted cancelled item's acceptance remains todo for reopening");
  p.key("/"); await type("显示"); await rows()[0]!.click(); await p.flush();
  assert.equal(p.document.getElementById("search"), null);
  assert.ok(detailItem(p, "child") && p.all().find(e => e.id === "q-q")!.className.includes("cur"), "a card result shows its item and selects the card");
  p.key("/"); await type("alpha"); p.key("Enter", input()); await p.flush();
  assert.ok(detailItem(p,"shipped") && !rowOf(p,"shipped"),"a done item is reachable without exposing its tree node");
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

// Owner waits: blocking (purple) and non-blocking (red), and the 等你 panel.
function waitSnapshot(): PageFixture {
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
  assert.equal(sum.children[0]!.id,"wait-row");
  const row1=sum.children[0]!.children[0]!;
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
  // The walk follows board order (area before hot), blocking waits first: the first stop is the older card on child.
  assert.ok(q.all().some(e=>e.id === "detail-it-child") && !q.all().some(e=>e.id === "detail-it-hot"),"the first blocking wait is a blocking card on child, which opens in the detail");
});
test("top controls: waits, unread navigation and filters, then tools and project links occupy three rows", async () => {
  const s=waitSnapshot(); s.notes.r={target:"it:child",kind:"comment",text:"c",at,state:"done",reply:"re",repliedAt:at,repliedBy:"Project",rev:1};
  s.items.child!.steps=[{id:"p",text:"Progress",state:"todo"}];
  const docs=[{kind:"item",id:"child",summary:"head changed, plan changed",pieces:{progress:1,reply:0,other:1}},{kind:"note",id:"r",summary:"new reply",pieces:{progress:0,reply:1,other:0}}];
  const p=await page(s,[{id:stepId,commits:[stepId],author:"A",at,docs}]);
  const rows=p.roots.get("summary")!.children;
  assert.deepEqual(rows.map(r=>r.id),["wait-row","unread-row","tools-row"]);
  assert.deepEqual(rows.map(r=>r.className),["header-row header-wait","sum-row","sum-row"]);
  assert.ok(!summaryText(p).some(e=>e.innerHTML === "未读"),"the unread row has no visible label");
  assert.deepEqual(rows[0]!.children[0]!.children.map(e=>e.innerHTML),["阻塞 3 ›","决策卡 1 ›"]);
  assert.equal(rows[0]!.children[1]!.id,"wait-panel");
  assert.deepEqual(rows[1]!.children.map(e=>e.innerHTML),["新 1 ›","","进展 1","其他 1","评论回复 1","全部已阅"],"new-content navigation and its filters share one flex row, separated by a decorative line");
  assert.equal(rows[1]!.children[1]!.className,"sum-divider");
  assert.equal(rows[1]!.children[1]!.getAttribute("aria-hidden"),"true");
  assert.deepEqual(rows[2]!.children.slice(0,2).map(e=>e.innerHTML),["全部折叠","展开第一层"]);
  assert.equal(rows[2]!.children[2]!.className,"sum-stats","the status legend shares the tools row");
  const nav=p.roots.get("nav")!, links=[...nav.children];
  assert.equal(rows[2]!.children[3],nav,"the existing project navigation shares the tools row");
  assert.deepEqual(links.map(e=>e.innerHTML),["Project"]);
  // Ruling a blocking card changes the waits row and rebuilds the header.
  s.decisions.old={...s.decisions.old!,status:"ruled",ruling:"A",choice:"A"};
  await p.change("e".repeat(40),[{kind:"decision",id:"old",after:s.decisions.old}]); await p.flush();
  assert.equal(p.document.getElementById("nav"),nav,"rebuilding the header preserves the navigation element");
  assert.equal(nav.parentElement!.id,"tools-row");
  assert.deepEqual(nav.children,links,"a header rebuild retains the existing project links");
  assert.deepEqual(p.roots.get("summary")!.children.map(r=>r.id),["wait-row","unread-row","tools-row"]);
});
test("top controls: a filter with no matching new content keeps its controls without a dangling divider", async () => {
  const docs=[{kind:"item",id:"child",summary:"head changed",pieces:{progress:0,reply:0,other:1}}];
  const p=await page(snapshot(),[{id:stepId,commits:[stepId],author:"A",at,docs}],null,undefined,{storage:new Map([["board-fresh-sel",'["progress"]']])});
  const row=p.document.getElementById("unread-row")!;
  assert.deepEqual(row.children.map(e=>e.innerHTML),["进展 0","其他 1","清除筛选","全部已阅"]);
  assert.ok(!row.children.some(e=>e.className === "sum-divider"),"without 新 there is no separator");
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
  assert.equal(panel.parentElement,summary.children[0],"the panel remains part of the waits row");
  assert.equal(panel.parentElement!.children[0]!.children[0]!.innerHTML,"阻塞 3 ›","the counter buttons precede the panel");
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
test("等你 panel shortens a long card question at 40 characters", async () => {
  const s=snapshot(), q40="问".repeat(40), q41=q40+"题";
  s.decisions.a40={...card(),question:q40,blocks:"停着甲"}; s.decisions.a41={...card(),question:q41,blocks:"停着乙"};
  const p=await page(s,[]), rows=p.all().find(e=>e.id === "wait-panel")!.children.filter(e=>e.className === "waitrow");
  const row=(blocks:string)=>rows.find(e=>e.innerHTML.includes(blocks))!;
  assert.ok(row("停着甲").innerHTML.includes(q40) && !row("停着甲").innerHTML.includes("…"),"exactly 40 characters stays whole");
  assert.ok(row("停着乙").innerHTML.includes(q40+"…") && !row("停着乙").innerHTML.includes(q41),"41 characters is cut to 40 with an ellipsis");
});

test("record labels render in the page and stay outside status counts", async () => {
  const s = snapshot(); s.items.child!.record = true; delete s.items.child!.status;
  const p = await page(s, []); await expand(p);
  const row = rowOf(p);
  assert.ok(row.querySelectorAll(".st").some(e => e.innerHTML === "记录"));
  assert.ok(!row.querySelectorAll(".st").some(e => /TODO|WIP/.test(e.innerHTML)));
  const counts = summaryText(p).find(e => e.className === "sum-stats")!.children.map(e => e.innerHTML);
  assert.equal(counts.length, 3);
  assert.match(counts[0]!, /进行中 0$/);
  assert.match(counts[1]!, /未开始 1$/, "only the ordinary parent counts as TODO; its record child has no status");
  assert.match(counts[2]!, /完成 0$/);
});

// Records each item the page signs (rules presentationSignature) as a render entry "sign:<id>".
const recordSigning = (code: string) => { assert.ok(code.includes("function signPresentation(it, next, scope) {")); return code.replace("function signPresentation(it, next, scope) {", "function signPresentation(it, next, scope) { recordRender(\"sign:\" + it.id);"); };
test("a live update signs and repaints only the items it can change, applying the activity change to the page's copy", async () => {
  const s = snapshot(), began = Date.parse(at), head = "a".repeat(40);
  s.items.lone = { title: "Unrelated", group: "Project", priority: "P2", updated: at, rev: 1, deps: [], links: [], log: [] };
  s.activity = { writes: Array.from({length: 2}, (_, i) => new Date(began + i * 30 * 60 * 1000).toISOString()), items: {} };
  const p = await page(s, [], null, undefined, {now: () => began + 60 * 60 * 1000, transform: recordSigning}); await expand(p); await p.flush();
  const checkText = (id = "child") => rowOf(p, id).querySelectorAll(".checktag").map(e => e.title).join("\n");
  assert.ok(p.renders.includes("sign:lone"), "the first pass signs every item");
  assert.ok(checkText().includes("活跃时间"), "the leaf is stalled before the update");
  const lone = rowOf(p, "lone"), snapshots = p.calls.filter(c => c.path === "/api/snapshot").length;
  p.renders.length = 0;
  // A write to the child an hour later. Its document carries no new time, so only the activity change moves its clock;
  // nothing reaches the unrelated item.
  const written = new Date(began + 59 * 60 * 1000).toISOString();
  p.emit("b".repeat(40), [{ kind: "item", id: "child", after: { ...s.items.child!, rev: 2, head: "Progress" } }], { from: head, write: written, items: { child: written }, pauses: {} });
  await p.flush();
  assert.ok(!checkText().includes("活跃时间"), "the activity change reset the child's clock on the page");
  assert.ok(p.renders.includes("sign:child") && p.renders.includes("sign:area"), "the changed item and its owner are signed again");
  assert.ok(!p.renders.includes("sign:lone"), "an unrelated item is not signed again");
  assert.ok(!p.renders.some(r => r instanceof Set && (r.has("item:lone") || r.has("all"))), "nor repainted");
  assert.strictEqual(rowOf(p, "lone"), lone, "its row is the same element");
  assert.equal(p.calls.filter(c => c.path === "/api/snapshot").length, snapshots, "a delta against the page's head needs no reload");
  // A delta made against another head means the page missed or overtook an event: it reloads the snapshot.
  p.emit("d".repeat(40), [{ kind: "item", id: "lone", after: { ...s.items.lone!, rev: 2, head: "Later" } }], { from: "c".repeat(40), write: written, items: { lone: written }, pauses: {} });
  await p.flush();
  assert.equal(p.calls.filter(c => c.path === "/api/snapshot").length, snapshots + 1, "an out-of-order delta reloads the snapshot");
});

test("page refreshes the stalled check when active time crosses the threshold without another write", async () => {
  const s = snapshot(), began = Date.parse(at);
  let now = began + 60 * 60 * 1000 - 1;
  s.activity = { writes: Array.from({length: 2}, (_, i) => new Date(began + i * 30 * 60 * 1000).toISOString()), items: {} };
  const p = await page(s, [], null, undefined, {now: () => now}); await expand(p); await p.flush();
  const checkText = (id = "child") => rowOf(p, id).querySelectorAll(".checktag").map(e => e.title).join("\n");
  assert.ok(!checkText().includes("活跃时间"), "the visible leaf is not stalled one millisecond before one active hour");
  const callsBeforeTick = p.calls.length;
  now++;
  p.intervals.forEach(fn => fn()); await p.flush();
  assert.ok(checkText().includes("进行中但 1 小时（活跃时间）没有动静"), "the timer refreshes the visible leaf's check at exactly one active hour");
  assert.ok(!checkText("area").includes("活跃时间"), "a parent with a work child is not a stalled leaf");
  assert.equal(p.calls.length, callsBeforeTick, "the timer updates checks without another server request or write");
});

test("a stalled leaf shows 无人推进 beside its title with the full explanation as tooltip, and a folded parent shows the count", async () => {
  const s = snapshot(), began = Date.parse(at);
  s.activity = { writes: Array.from({length: 2}, (_, i) => new Date(began + i * 30 * 60 * 1000).toISOString()), items: {} };
  const p = await page(s, [], null, undefined, {now: () => began + 60 * 60 * 1000});
  // Other checks (here the missing completion condition and the missing difficulty) keep their own tags; only the stalled tags are asserted on.
  const tags = (id: string) => rowOf(p, id).querySelectorAll(".checktag").filter(e => e.innerHTML !== "需核对" && e.innerHTML !== "缺难度");
  const folded = tags("area");
  assert.deepEqual(folded.map(e => e.innerHTML), ["无人推进 1"], "the folded parent counts its stalled leaf");
  assert.equal(folded[0]!.title, "1 个进行中的下级条目 1 小时（活跃时间）没有动静", "the subtree chip uses the same one-hour threshold as the leaf check");
  await expand(p);
  const leaf = tags("child");
  assert.deepEqual(leaf.map(e => e.innerHTML), ["无人推进"], "the stalled leaf shows its own label, not 需核对");
  assert.equal(leaf[0]!.title, "进行中但 1 小时（活跃时间）没有动静");
  assert.deepEqual(tags("area").map(e => e.innerHTML), [], "an open parent shows no count");
});

function noteButton(p: Awaited<ReturnType<typeof page>>, id: string, label: string) {
  const note = p.document.getElementById("note-" + id)!;
  return descendants(note).find(e => e.tagName === "BUTTON" && (e.innerHTML === label || e.textContent === label));
}
function typeDraftEdit(p: Awaited<ReturnType<typeof page>>, id: string, text: string) {
  const ta = p.document.getElementById("edit-draft-" + id)!;
  ta.value = text;
  for (const handler of ta.handlers.get("input") ?? []) handler({target: ta});
  return ta;
}

test("draft comment editor prefills, cancels without writing, and saves the existing note", async () => {
  const s = snapshot();
  s.notes.d = {target: "it:child", kind: "comment", text: "Original", at, state: "draft", rev: 4, anchor: {kind: "log", at}};
  s.notes.sent = {...s.notes.d, text: "Sent", state: "sent", rev: 1};
  s.notes.done = {...s.notes.d, text: "Handled", state: "done", rev: 1};
  const p = await page(s, [], null, undefined, {notesOpen: {"it:child": true}}); await expand(p);
  assert.ok(noteButton(p, "d", "编辑"));
  assert.equal(noteButton(p, "sent", "编辑"), undefined); assert.equal(noteButton(p, "done", "编辑"), undefined);
  await noteButton(p, "d", "编辑")!.click();
  assert.equal(p.document.getElementById("edit-draft-d")!.value, "Original");
  typeDraftEdit(p, "d", "Discard this"); await noteButton(p, "d", "取消")!.click();
  assert.equal(p.document.getElementById("edit-draft-d"), null);
  assert.equal(p.calls.filter(c => c.path === "/api/draft" || c.path === "/api/notes").length, 0);
  await noteButton(p, "d", "编辑")!.click(); typeDraftEdit(p, "d", "Edited\ntext");
  await noteButton(p, "d", "保存")!.click(); await p.flush();
  assert.deepEqual(p.calls.find(c => c.path === "/api/draft")!.body, {id: "d", rev: 4, text: "Edited\ntext"});
  assert.equal(p.calls.filter(c => c.path === "/api/notes").length, 0, "editing never creates a replacement comment");
  assert.equal(p.document.getElementById("edit-draft-d"), null);
  assert.match(markup(p.document.getElementById("note-d")!), /Edited/);
  assert.equal(s.notes.d!.state, "draft"); assert.equal(s.notes.d!.anchor?.kind, "log");
});

test("edited explanation requests display the edited text and keep their kind", async () => {
  const s = snapshot(); s.notes.ex = {target: "it:child", kind: "explain", text: "请详细解释这一项。", at, state: "draft", rev: 1};
  const p = await page(s, [], null, undefined, {notesOpen: {"it:child": true}}); await expand(p);
  await noteButton(p, "ex", "编辑")!.click();
  assert.equal(p.document.getElementById("edit-draft-ex")!.value, "请详细解释这一项。");
  typeDraftEdit(p, "ex", "请解释为什么选择这个方案。"); await noteButton(p, "ex", "保存")!.click(); await p.flush();
  const text = markup(p.document.getElementById("note-ex")!);
  assert.match(text, /请求：详细解释/); assert.match(text, /请解释为什么选择这个方案/);
  assert.equal(s.notes.ex!.kind, "explain");
});

test("draft edits keep typed text and original revision across rerenders and newer note events", async () => {
  const s = snapshot(); s.notes.d = {target: "it:child", kind: "comment", text: "Original", at, state: "draft", rev: 1};
  const p = await page(s, [], null, undefined, {frames: new Frames(), notesOpen: {"it:child": true}, response: path => path === "/api/draft" ? {ok: false, status: 409, json: async () => ({error: "expected rev 1, current rev 2"})} : undefined}); await expand(p); await p.flush();
  await noteButton(p, "d", "编辑")!.click(); typeDraftEdit(p, "d", "My unsaved text");
  p.intervals.forEach(fn => fn()); await p.flush();
  p.emit("d".repeat(40), [{kind: "note", id: "d", after: {...s.notes.d, text: "Other edit", rev: 2}}]); await p.flush();
  assert.equal(p.document.getElementById("edit-draft-d")!.value, "My unsaved text");
  await noteButton(p, "d", "保存")!.click(); await p.flush();
  assert.deepEqual(p.calls.find(c => c.path === "/api/draft")!.body, {id: "d", rev: 1, text: "My unsaved text"});
  assert.equal(p.document.getElementById("edit-draft-d")!.value, "My unsaved text");
  assert.equal(p.calls.filter(c => c.path === "/api/draft").length, 1);
  shownInHint(p, /expected rev 1, current rev 2/);
});

test("send waits for draft text saves and stops after a failed save", async t => {
  for (const failed of [false, true]) await t.test(String(failed), async () => {
    const s = snapshot(), hold = deferred<FakeResponse>(); s.notes.d = {target: "it:child", kind: "comment", text: "Original", at, state: "draft", rev: 1};
    const p = await page(s, [], null, undefined, {notesOpen: {"it:child": true}, response: path => path === "/api/draft" ? hold.promise : undefined}); await expand(p);
    await noteButton(p, "d", "编辑")!.click(); typeDraftEdit(p, "d", "Edited");
    const saving = noteButton(p, "d", "保存")!.click();
    assert.equal(noteButton(p, "d", "删除")!.disabled, true);
    const sending = p.roots.get("send-all")!.click(); await settle();
    assert.equal(p.calls.filter(c => c.path === "/api/send").length, 0);
    assert.match(markup(p.document.getElementById("note-d")!),/已发送，等处理/,"pending text acknowledgement does not delay the visual send");
    if (failed) hold.reject(new Error("Edit refused"));
    else hold.resolve(reply({note: {id: "d", doc: {...s.notes.d, text: "Edited", rev: 2}}, deleted: [], commit: "c".repeat(40)}));
    await saving; await sending; await p.flush();
    assert.equal(p.calls.filter(c => c.path === "/api/send").length, failed ? 0 : 1);
    if (failed) {
      assert.equal(p.document.getElementById("edit-draft-d")!.value,"Edited","failed save restores the editor and unsaved text");
      assert.equal(noteButton(p,"d","删除")!.disabled,false);
      shownInHint(p,/Edit refused/);
    }
  });
});

test("a sent transition closes a draft editor and a late save cannot restore the draft", async () => {
  const s = snapshot(), hold = deferred<FakeResponse>(); s.notes.d = {target: "it:child", kind: "comment", text: "Original", at, state: "draft", rev: 1};
  const p = await page(s, [], null, undefined, {frames: new Frames(), notesOpen: {"it:child": true}, response: path => path === "/api/draft" ? hold.promise : undefined}); await expand(p); await p.flush();
  await noteButton(p, "d", "编辑")!.click(); typeDraftEdit(p, "d", "Edited"); const saving = noteButton(p, "d", "保存")!.click();
  p.emit("e".repeat(40), [{kind: "note", id: "d", after: {...s.notes.d, text: "Newest sent text", state: "sent", sentAt: at, rev: 3}}]); await p.flush();
  assert.equal(p.document.getElementById("edit-draft-d"), null); assert.equal(noteButton(p, "d", "编辑"), undefined); assert.equal(noteButton(p, "d", "删除"), undefined);
  hold.resolve(reply({note: {id: "d", doc: {...s.notes.d, text: "Older acknowledgement", rev: 2}}, deleted: [], commit: "c".repeat(40)}));
  await saving; await p.flush();
  assert.match(markup(p.document.getElementById("note-d")!), /Newest sent text/);
  assert.equal(noteButton(p, "d", "编辑"), undefined);
});

test("plan steps show all states, elapsed days and acceptance; prose precedes comments and logs start collapsed", async () => {
  const s=nativeSnapshot(); s.items.child!.head="Stable head";
  s.items.child!.plan=planWork([planStep("done","Deliver parser #42","done",{doneAt:"2026-10-06T12:00:00Z"}),planStep("doing","Validate replies","doing",{since:"2026-10-06T12:00:00Z",waits:"CI"}),planStep("todo","Publish evidence"),planStep("drop","Old approach","dropped",{reason:"Superseded"})]); s.items.child!.log=[{at,text:"Detailed investigation"}];
  const p=await page(s,[],null,undefined,{now:()=>Date.parse("2026-10-12T12:00:00Z")}); await expand(p);
  assert.deepEqual(item(p).querySelectorAll(".plan-row .g").map(e=>e.innerHTML),["✓","●","○","✗","○"]);
  assert.match(markup(planRow(p,"child","done")),/Deliver parser #42 · 10-06/); assert.match(markup(planRow(p,"child","doing")),/Validate replies · 6 天 · 等 CI/); assert.match(markup(planRow(p,"child","drop")),/Old approach · Superseded/);
  assert.equal(rowOf(p).querySelector(".steps-ratio")!.innerHTML,"1/4"); assert.equal(item(p).querySelector(".steps-ratio")!.innerHTML,"1/4");
  const body=item(p).querySelector(".body")!, progress=body.children.findIndex(e=>e.className === "plan"), comments=body.children.findIndex(e=>e.className === "item-comments"), prose=body.children.findIndex(e=>e.className === "rich"), logs=body.children.findIndex(e=>e.className === "log");
  // Owner, 2026-10-13: plan, then the head, then the item's comments, then the log.
  assert.ok(progress>=0 && prose === progress+1 && comments === prose+1 && logs === comments+1);
  assert.equal(item(p).querySelector(".log-toggle")!.attributes["aria-expanded"],"false"); assert.equal(item(p).querySelectorAll(".log-entry").length,0);
  await button(p,"▸ 日志").click(); assert.equal(item(p).querySelectorAll(".log-entry").length,1); assert.match(markup(item(p)),/Detailed investigation/);
  await expand(p,"area"); assert.ok(item(p,"area").querySelector(".plan")); assert.equal(item(p,"area").querySelector(".log-toggle")!.attributes["aria-expanded"],"false");
  await button(p,"▸ 日志").click(); assert.match(markup(item(p,"area")),/暂无日志/);
});
const goalNumber = (id: string, current = "12 倍 Chromium"): ItemTarget => ({id, goal: "apollo11 样式计算 " + id, target: "≤ 1 倍 Chromium", current, baseline: "Chromium 同机同页", date: at});

test("goal numbers show a five-column table before plans for work and record items and hide absent or empty lists", async t => {
  for (const record of [false, true]) await t.test(record ? "record" : "work", async () => {
    const s=nativeSnapshot();
    if (record) { s.items.child!.record=true; delete s.items.child!.status; }
    s.items.child!.plan=record ? [planStep("part","Measure goal")] : planWork([planStep("part","Measure goal")]);
    s.items.child!.targets=[{...goalNumber("style"),goal:"<script>goal</script>"},goalNumber("layout","2 倍 Chromium")];
    const p=await page(s,[]); await expand(p);
    const body=item(p).querySelector(".body")!, progress=body.children.findIndex(e=>e.className === "plan"), targets=body.children.findIndex(e=>e.className === "item-targets"), log=body.children.findIndex(e=>e.className === "log");
    assert.ok(targets >= 0 && progress === targets+1 && log > progress,"targets precede plans and history follows comments");
    const table=item(p).querySelector(".targets-table")!;
    assert.equal(table.querySelector("caption")!.innerHTML,"目标");
    assert.deepEqual(table.querySelectorAll("th").map(e=>[e.innerHTML,e.attributes.scope]),["目标","当前","目标值","比较对象","日期"].map(label=>[label,"col"]));
    const rows=table.querySelectorAll(".item-target");
    assert.equal(rows.length,2,"one row per goal");
    assert.deepEqual(rows[0]!.children.map(e=>e.innerHTML),["&lt;script&gt;goal&lt;/script&gt;","12 倍 Chromium","≤ 1 倍 Chromium","Chromium 同机同页","2026-10-11"]);
    assert.deepEqual(rows[0]!.children.map(e=>e.dataset.label),["目标","当前","目标值","比较对象","日期"],"phone cells keep their column labels");
    assert.equal(rows[1]!.children[1]!.innerHTML,"2 倍 Chromium");
    await expand(p,"area"); assert.equal(item(p,"area").querySelector(".item-targets"),null,"legacy items need no targets field");
    const empty=snapshot(); empty.items.child!.targets=[];
    const emptyPage=await page(empty,[]); await expand(emptyPage);
    assert.equal(item(emptyPage).querySelector(".item-targets"),null,"an explicitly empty list is hidden");
  });
});

test("added and edited goal rows mark only their own rows and progress navigation lands on each before m reads them", async () => {
  const s=snapshot(), baseline={...s.items.child!,targets:[goalNumber("same"),goalNumber("edit")]};
  s.items.child!.targets=[goalNumber("new"),goalNumber("same"),{...goalNumber("edit","6 倍 Chromium"),date:"2026-10-12T12:00:00Z"}];
  const history=[{...unread()[0]!,docs:[{kind:"item",id:"child",summary:"targets changed",pieces:{progress:2,reply:0,other:0}}]}];
  const p=await page(s,history,baseline,undefined,{detailGeometry:e=>({top:e.id === "target-child-new" ? 1800 : e.id === "target-child-edit" ? 2300 : 50,height:e.id === "detail-it-child" ? 4000 : 100})});
  await expand(p); await p.flush();
  const marked=()=>item(p).querySelectorAll(".item-target.newbar").map(e=>e.id);
  assert.deepEqual(marked(),["target-child-new","target-child-edit"],"insertion does not mark a shifted unchanged row");
  assert.ok(p.all().some(e=>e.innerHTML === "进展 1"));
  assert.ok(!p.all().some(e=>e.innerHTML === "其他 1"),"goal rows count only as progress");
  await button(p,"进展 1").click(); p.key("n"); await p.flush();
  assert.ok(p.measurements.some(m=>m.id === "target-child-new" && m.top>1000),"navigation uses the first goal row's geometry");
  assert.ok(p.roots.get("item-detail")!.scrollTop>1000,"the changed row lands in the detail pane");
  p.key("n"); await p.flush();
  assert.ok(p.measurements.some(m=>m.id === "target-child-edit"),"the next navigation visits the edited row");
  p.key("m"); await p.flush();
  assert.deepEqual(marked(),[]); assert.ok(!rowOf(p).className.includes("fresh"));
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:"item:child",through:stepId}]);
});

test("target removals and reordering remain unread progress without marking unchanged rows", async t => {
  for (const change of ["remove","remove all","reorder"] as const) await t.test(change,async()=> {
    const s=snapshot(), baseline={...s.items.child!,targets:[goalNumber("a"),goalNumber("b")]};
    s.items.child!.targets=change === "remove" ? [baseline.targets[1]!] : change === "remove all" ? [] : [...baseline.targets].reverse();
    const p=await page(s,[{...unread()[0]!,docs:[{kind:"item",id:"child",summary:"targets changed",pieces:{progress:1,reply:0,other:0}}]}],baseline); await expand(p); await p.flush();
    assert.ok(rowOf(p).className.includes("fresh")); assert.ok(p.all().some(e=>e.innerHTML === "进展 1"));
    assert.equal(item(p).querySelectorAll(".item-target.newbar").length,0);
    assert.deepEqual(item(p).querySelectorAll(".item-target").map(e=>e.id),s.items.child!.targets!.map(target=>"target-child-"+target.id));
    await button(p,"进展 1").click(); p.key("n"); await p.flush(); assert.ok(rowOf(p).className.includes("cur"));
  });
});

test("legacy unread summaries classify target changes as progress", async () => {
  const s=snapshot(); s.items.child!.targets=[goalNumber("fresh")];
  const p=await page(s,[{...unread()[0]!,docs:[{kind:"item",id:"child",summary:"targets changed"}]}],{...s.items.child!,targets:[]}); await expand(p); await p.flush();
  assert.ok(p.all().some(e=>e.innerHTML === "进展 1"));
  assert.ok(!p.all().some(e=>e.innerHTML === "其他 1"));
  await button(p,"进展 1").click(); assert.ok(rowOf(p).className.includes("fresh"));
});

test("added and edited plan rows mark only themselves until m reads them and the progress filter walks them", async () => {
  const s=nativeSnapshot(), baseline={...s.items.child!,plan:planWork([planStep("same","Unchanged"),planStep("edit","Earlier")])};
  s.items.child!.plan=planWork([planStep("new","Added"),planStep("same","Unchanged"),planStep("edit","Changed","doing",{waits:"Review"})]);
  const history=[{...unread()[0]!,docs:[{kind:"item",id:"child",summary:"plan changed",pieces:{progress:2,reply:0,other:0}}]}];
  const p=await page(s,history,baseline,undefined,{now:()=>Date.parse(at)}); await expand(p); await p.flush();
  const marked=()=>item(p).querySelectorAll(".plan-row.newbar").map(e=>e.id);
  assert.deepEqual(marked(),[planRowDomId("child","new"),planRowDomId("child","edit")]); assert.ok(rowOf(p).className.includes("fresh"));
  await button(p,"进展 1").click(); p.key("n"); await p.flush(); assert.ok(rowOf(p).className.includes("cur"));
  p.key("m"); await p.flush(); assert.deepEqual(marked(),[]); assert.ok(!rowOf(p).className.includes("fresh"));
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:"item:child",through:stepId}]);
});
test("plan removal and reordering remain unread progress without marking unchanged rows", async t => {
  for (const change of ["remove","reorder"] as const) await t.test(change,async()=> {
    const s=nativeSnapshot(), rows=[planStep("a","A","todo",{after:[]}),planStep("b","B","todo",{after:[]})], baseline={...s.items.child!,plan:planWork(rows)};
    s.items.child!.plan=planWork(change === "remove" ? [rows[1]!] : [...rows].reverse());
    const p=await page(s,[{...unread()[0]!,docs:[{kind:"item",id:"child",summary:"plan changed",pieces:{progress:1,reply:0,other:0}}]}],baseline); await expand(p); await p.flush();
    assert.ok(rowOf(p).className.includes("fresh")); assert.ok(p.all().some(e=>e.innerHTML === "进展 1")); assert.equal(item(p).querySelectorAll(".plan-row.newbar").length,0);
    assert.deepEqual(item(p).querySelectorAll(".plan-row").map(e=>e.id),s.items.child!.plan.map(row=>planRowDomId("child",row.id)));
  });
});
test("record plans omit acceptance, show zero when all dropped and refresh doing days without writes", async () => {
  const s=nativeSnapshot(); s.items.child!.record=true; s.items.child!.plan=[planStep("old","Retired","dropped",{reason:"No longer needed"})];
  let now=Date.parse(at)+24*60*60*1000-1; const p=await page(s,[],null,undefined,{now:()=>now}); await expand(p); await p.flush();
  assert.equal(item(p).querySelector(".steps-ratio")!.innerHTML,"0/0"); assert.equal(item(p).querySelectorAll(".plan-row.accept").length,0);
  await p.change("b".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,rev:2,plan:[planStep("work","Collect evidence","doing")]}}]); await p.flush();
  assert.match(markup(planRow(p,"child","work")),/Collect evidence · 0 天/);
  const calls=p.calls.length; now++; p.intervals.forEach(fn=>fn()); await p.flush(); assert.match(markup(planRow(p,"child","work")),/Collect evidence · 1 天/); assert.equal(p.calls.length,calls);
});
test("plan prose resolves glossary and reference tokens and follows target renames", async () => {
  const s=glossaries(nativeSnapshot()); s.items.child!.plan=planWork([planStep("ref","否决线 [[it:area]]","doing",{waits:"[[it:area]]"})]);
  const p=await page(s,[]); await expand(p);
  const text=()=>planRow(p,"child","ref").querySelector(".plan-text")!.innerHTML;
  assert.deepEqual(termLinks(text()),[["否决线",anchor("Project","否决线")]]); assert.match(text(),/data-ref="it:area">Parent<\/a>/);
  await p.change("b".repeat(40),[{kind:"item",id:"area",after:{...s.items.area!,title:"Renamed parent"}}]); await p.flush(); assert.match(text(),/data-ref="it:area">Renamed parent<\/a>/);
});

test("the native plan mockup shows glyphs, parallel groups, glyph-only item status, shared ownership and acceptance before delivery", async () => {
  const s=nativeSnapshot(); s.board.projects.push({name:"Other"});
  s.items.child!.plan=planWork([planStep("ci","Run Lua checks","doing",{waits:"CI"})]);
  s.items.host={...s.items.area!,title:"Other owner",group:"Other",plan:planWork([ownedRow("dependency")])};
  s.items.dependency={...s.items.child!,title:"Whitefoot can read the peer address",group:"Other",plan:planWork([planStep("build")])};
  s.decisions.q={...card(),item:"area",blocks:"Release waits for the ruling"};
  s.items.area!.provisional=true;
  s.items.area!.plan=[planStep("done","Delivered parser","done"),planStep("drop","Old approach","dropped"),planStep("writing","Write parser","doing",{after:[]}),ownedRow("child"),sharedRow("dependency"),cardRow("q"),{...planAcceptance("done"),after:["done"]},planStep("notes","Release notes")];
  const p=await page(s,[],null,undefined,{now:()=>Date.parse(at)+2*24*60*60*1000}); await expand(p,"area");
  assert.deepEqual(item(p,"area").querySelectorAll(".plan-row .g").map(e=>e.innerHTML),["✓","✗","●","●","⏸","⏸","✓","○"]);
  const group=item(p,"area").querySelector(".plan-group")!; assert.equal(group.attributes.role,"group"); assert.equal(group.attributes["aria-label"],"可同时进行");
  const owned=planRow(p,"area","child");
  assert.equal(owned.querySelector(".plan-sub"),null,"an owned item row has no activity line under it");
  assert.equal(owned.querySelector(".st"),null,"the row glyph carries the item's status, so no status chip");
  // The card's own item unfolds it inline from its plan row rather than linking away.
  assert.equal(planRow(p,"area","q").querySelector(".cardtoggle")!.attributes["aria-expanded"],"false");
  // The 待重写 tag on an owned row is the target's own: a provisional parent does not mark a rewritten child.
  assert.ok(!planRow(p,"area","child").querySelectorAll(".checktag").some(e=>e.innerHTML === "待重写"));
  s.items.child!.provisional=true;
  const q=await page(s,[],null,undefined,{now:()=>Date.parse(at)+2*24*60*60*1000}); await expand(q,"area");
  assert.ok(planRow(q,"area","child").querySelectorAll(".checktag").some(e=>e.innerHTML === "待重写"));
  const plan=item(p,"area").querySelector(".plan")!; assert.ok(plan.querySelector(".checktag")!.innerHTML === "待重写");
  const rows=plan.querySelectorAll(".plan-row"); assert.ok(rows.at(-2)!.classList.contains("accept")); assert.match(markup(rows.at(-2)!),/验收[^]*Checks pass/);
  assert.equal(rows.at(-1)!.id,planRowDomId("area","notes")); assert.ok(!rows.at(-1)!.classList.contains("accept"));
  assert.equal(plan.querySelector(".steps-ratio")!.innerHTML,"2/7","the dropped step is excluded and completed acceptance counts before delivery");
  assert.doesNotMatch(markup(item(p,"area")),/验收已标完成，但还有行没完成/,"a completed acceptance check does not warn about unrelated or later unfinished work");
});

test("acceptance scenarios keep step glyphs and tags in a parallel group before delivery", async () => {
  const s=nativeSnapshot(), scenarios=[
    planStep("checked","Replies match","done",{accept:true,after:["build"]}),
    planStep("timing","Timing check","doing",{accept:true,after:["build"]}),
    planStep("scenario","Second scenario","todo",{accept:true,after:["build"]}),
    planStep("superseded","Retired scenario","dropped",{accept:true,after:["build"]}),
  ];
  s.items.child!.plan=[planStep("build","Build implementation","done"),...scenarios,planStep("merge","Merge into main","todo",{after:scenarios.map(row=>row.id)})];
  const p=await page(s,[],null,undefined,{now:()=>Date.parse(at)}); await expand(p);
  const plan=item(p).querySelector(".plan")!;
  const group=plan.querySelector(".plan-group");
  assert.ok(group,"acceptance uses ordinary after levels, so independent scenarios form one parallel group");
  assert.deepEqual(group.querySelectorAll(".plan-row").map(row=>row.id),scenarios.map(row=>planRowDomId("child",row.id)));
  assert.deepEqual(plan.querySelectorAll(".plan-row").map(row=>row.id),s.items.child!.plan.map(row=>planRowDomId("child",row.id)),"acceptance scenarios and delivery remain in stored order");
  assert.deepEqual(plan.querySelectorAll(".plan-row.accept .g").map(row=>row.innerHTML),["✓","●","○","✗"]);
  assert.deepEqual(plan.querySelectorAll(".plan-row.accept .tag").map(row=>row.innerHTML),["验收","验收","验收","验收"]);
  assert.equal(plan.querySelector(".steps-ratio")!.innerHTML,"2/5","each acceptance counts like a step and a dropped scenario is excluded");
  assert.equal(planRow(p,"child","merge").querySelector(".g")!.innerHTML,"○");
  const status=rowOf(p).querySelector(".item-head .st")!;
  assert.equal(status.innerHTML,"WIP","unfinished scenarios and delivery do not become done early");
});

test("acceptance tags do not add a divider or extra spacing above ordinary plan rows", async () => {
  const html=(await readFile("web/index.html","utf8")).replace(/\/\*[\s\S]*?\*\//g,"");
  const acceptanceRules=[...html.matchAll(/([^{}]+)\{([^{}]+)\}/g)].filter(rule=>/\.plan-row\.accept\b/.test(rule[1]!));
  for (const rule of acceptanceRules) assert.doesNotMatch(rule[2]!,/(?:^|;)\s*(?:border-top|margin-top|padding-top)\s*:/,"acceptance is an ordinary row wherever the check happens");
  assert.match(html,/\.plan-row \.tag\s*\{[^}]*border:\s*1px solid var\(--rule\)/,"the 验收 tag remains visually distinct");
});

test("plan rows refresh when a shared target's title or card blocking text changes", async () => {
  const s=nativeSnapshot();
  s.board.projects.push({name:"Other"});
  s.items.host={...s.items.area!,group:"Other",title:"First owner",plan:planWork([ownedRow("dependency")])};
  s.items.otherHost={...s.items.area!,group:"Other",title:"Second owner",plan:planWork([])};
  s.items.dependency={...s.items.child!,group:"Other",title:"Shared result",plan:planWork([])};
  s.decisions.q={...card(),question:"Direct card",item:"area"};
  s.items.area!.plan=planWork([ownedRow("child"),sharedRow("dependency"),cardRow("q")]);
  const p=await page(s,[]); await expand(p,"area");
  assert.match(markup(planRow(p,"area","dependency")),/Shared result/);
  assert.match(markup(planRow(p,"area","q")),/待裁定/);
  await p.change("b".repeat(40),[{kind:"item",id:"dependency",after:{...s.items.dependency!,title:"Renamed result"}}]); await p.flush();
  assert.match(markup(planRow(p,"area","dependency")),/Renamed result/);
  assert.doesNotMatch(markup(planRow(p,"area","dependency")),/Shared result/);
  await p.change("f".repeat(40),[{kind:"decision",id:"q",after:{...s.decisions.q!,blocks:"Release waits"}}]); await p.flush();
  assert.match(markup(planRow(p,"area","q")),/阻塞/);
  assert.match(markup(planRow(p,"area","q")),/<span class="waittag" title="Release waits">阻塞<\/span>/,"the exact blocking tag and its tooltip update together");
});

test("every resolved plan row stays visible in stored order on initial paint and reload despite stale folding storage", async t => {
  for (const stale of [undefined, "{}", JSON.stringify({[JSON.stringify(["child","a","b","drop","finished","cancelled","shared","ruled"])]:false}), JSON.stringify({[JSON.stringify(["child","a","b","drop","finished","cancelled","shared","ruled"])]:true}), "malformed old setting"]) await t.test(String(stale), async () => {
    const s=nativeSnapshot(), storage=new Map<string,string>([["board-selected","child"]]);
    if (stale !== undefined) storage.set("board-plan-open",stale);
    s.items.finished={...s.items.child!,title:"Finished owned result",plan:planWork([],"done")};
    s.items.cancelled={...s.items.child!,title:"Cancelled owned result",status:"cancelled",plan:planWork([],"dropped")};
    s.items.shared={...s.items.child!,title:"Finished shared result",plan:planWork([],"done")};
    s.items.area!.plan=planWork([ownedRow("child"),ownedRow("shared")]);
    s.decisions.ruled={...card(),question:"Resolved choice",status:"ruled",ruling:"Settled"};
    s.items.child!.plan=planWork([
      planStep("a","A","done",{after:[]}),planStep("b","B","done",{after:[]}),planStep("drop","Dropped step","dropped",{after:[]}),
      ownedRow("finished"),ownedRow("cancelled"),sharedRow("shared"),cardRow("ruled"),
    ],"done");
    const expected=s.items.child!.plan.map(row=>planRowDomId("child",row.id));
    for (const p of [await page(s,[],null,undefined,{storage}),await page(s,[],null,undefined,{storage})]) {
      assert.ok(detailItem(p,"child"),"the selected plan is present on its first paint, with no plan controls pressed");
      assert.deepEqual(item(p).querySelectorAll(".plan-row").map(row=>row.id),expected);
      assert.deepEqual(item(p).querySelectorAll(".plan-row .g").map(row=>row.innerHTML),["✓","✓","✗","✓","✗","✓","✓","✓"]);
      assert.equal(item(p).querySelectorAll(".plan-fold").length,0);
      assert.deepEqual(item(p).querySelector(".plan-group")!.querySelectorAll(".plan-row").map(row=>row.id),expected.slice(0,-1));
      assert.match(markup(planRow(p,"child","drop")),/Dropped step[^]*Replaced/);
    }
    assert.equal(storage.get("board-plan-open"),stale,"the retired choice is neither read nor rewritten");
  });
});

test("resolved rows preserve unread bars and current selection while every completed row remains visible", async () => {
  const s=nativeSnapshot(), rows=[planStep("a","A","done"),planStep("b","B","dropped"),planStep("c","C","done")]; s.items.child!.plan=planWork(rows,"done");
  const baseline={...s.items.child!,plan:planWork([{...rows[0]!,text:"Earlier A"},rows[1]!,rows[2]!],"done")};
  const p=await page(s,unread(),baseline); await expand(p); await p.flush();
  const expected=s.items.child!.plan.map(row=>planRowDomId("child",row.id));
  assert.deepEqual(item(p).querySelectorAll(".plan-row").map(row=>row.id),expected);
  assert.ok(planRow(p,"child","a").classList.contains("newbar"));
  assert.ok(!planRow(p,"child","b").classList.contains("newbar"),"unchanged dropped rows are visible without becoming unread");
  await planRow(p,"child","b").click(); await p.flush();
  assert.ok(planRow(p,"child","b").classList.contains("cur"));
  await p.change("b".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,title:"Renamed child"}}]); await p.flush();
  assert.deepEqual(item(p).querySelectorAll(".plan-row").map(row=>row.id),expected);
  assert.ok(planRow(p,"child","b").classList.contains("cur"),"a detail refresh preserves the selected dropped row");
  assert.equal(item(p).querySelectorAll(".plan-fold").length,0);
});

test("mixed parallel groups retain every completed, dropped and open member in stored order", async () => {
  const s=nativeSnapshot(); s.items.child!.plan=planWork([planStep("a","A","done",{after:[]}),planStep("b","B","dropped",{after:[]}),planStep("c","C","done",{after:[]}),planStep("d","D","todo",{after:[]})]);
  const p=await page(s,[]); await expand(p);
  const expected=s.items.child!.plan.map(row=>planRowDomId("child",row.id));
  assert.deepEqual(item(p).querySelectorAll(".plan-row").map(row=>row.id),expected);
  assert.deepEqual(item(p).querySelector(".plan-group")!.querySelectorAll(".plan-row").map(row=>row.id),expected.slice(0,-1));
  await p.change("b".repeat(40),[{kind:"item",id:"child",after:{...s.items.child!,plan:planWork([planStep("a","A","done",{after:[]}),planStep("b","B","dropped",{after:[]}),planStep("c","C","done",{after:[]}),planStep("d","D","done",{after:[]})])}}]); await p.flush();
  assert.deepEqual(item(p).querySelectorAll(".plan-row").map(row=>row.id),expected,"resolving the last member does not replace the group with a summary");
  assert.deepEqual(item(p).querySelector(".plan-group")!.querySelectorAll(".plan-row .g").map(row=>row.innerHTML),["✓","✗","✓","✓"]);
});

test("a plan row comment goes to its item without an anchor and the comment entry follows the plan", async () => {
  const s=nativeSnapshot(); s.items.child!.plan=planWork([planStep("part","Write checks")]);
  const p=await page(s,[],null,undefined,{response:path=>path === "/api/notes" ? reply({id:"saved"}) : undefined}); await expand(p); const body=item(p).querySelector(".body")!, index=body.children.findIndex(e=>e.className === "plan"); assert.equal(body.children[index+1]!.className,"item-comments");
  await planRow(p,"child","part").click(); p.key("c"); await p.flush(); assert.ok(p.document.getElementById("ed-it_child"));
  const editor=p.document.getElementById("ed-it_child")!; editor.value="Row work question";
  await editor.parentElement!.querySelector(".save")!.click(); await p.flush();
  const call=p.calls.find(c=>c.path === "/api/notes"); assert.ok(call); assert.equal((call.body as {target:string}).target,"it:child"); assert.equal(Object.hasOwn(call.body as object,"anchor"),false);
});

test("complete plans render without storage and phone CSS retains the glyph gutter", async () => {
  const s=nativeSnapshot(); s.items.child!.plan=planWork([planStep("a","A","done"),planStep("b","B","dropped"),planStep("c","C","done")]);
  const expected=s.items.child!.plan.map(row=>planRowDomId("child",row.id));
  for (let reload=0;reload<2;reload++) {
    const p=await page(s,[],null,undefined,{storageUnavailable:true}); await expand(p);
    assert.deepEqual(item(p).querySelectorAll(".plan-row").map(row=>row.id),expected);
    assert.deepEqual(item(p).querySelectorAll(".plan-row .g").map(row=>row.innerHTML),["✓","✗","✓","○"]);
    assert.equal(item(p).querySelectorAll(".plan-fold").length,0);
  }
  const source=await readFile("web/app.ts","utf8"); assert.ok(!source.includes("board-plan-open"),"the retired choice has no reader or writer");
  const css=await readFile("web/index.html","utf8"); assert.ok(!css.includes(".plan-fold")); assert.match(css,/\.plan-row\s*\{[^}]*grid-template-columns:\s*16px minmax\(0, 1fr\)/); assert.match(css,/@media \(max-width: 560px\)[^]*\.plan-row\.own \.plan-meta\s*\{[^}]*display:\s*flex/); assert.match(css,/\.plan-group\s*\{[^}]*border-left-width:\s*1px/);
});

function cardSend(p: Awaited<ReturnType<typeof page>>, id = "q") { return descendants(p.all().find(e => e.id === "q-" + id)!).find(e => e.dataset.cardsend === id)!; }
test("a decision card's send button needs a choice draft and sends only that card's drafts", async () => {
  const s = snapshot(); s.decisions.q = card();
  s.notes.cq = {target: "q:q", kind: "comment", text: "On the card", at, state: "draft", rev: 1};
  s.notes.other = {target: "it:child", kind: "comment", text: "Elsewhere", at, state: "draft", rev: 1};
  const p = await page(s, []); await expand(p);
  assert.equal(cardSend(p).innerHTML, "发送"); assert.equal(cardSend(p).disabled, true, "no choice yet");
  await option(p, "A").click(); await p.flush();
  assert.equal(cardSend(p).disabled, false, "a choice draft exists");
  await option(p, "A").click(); await p.flush();
  assert.equal(cardSend(p).disabled, true, "withdrawing the choice disables it again");
  await option(p, "A").click(); await p.flush();
  await cardSend(p).click(); await p.flush();
  const sends = p.calls.filter(c => c.path === "/api/send");
  assert.equal(sends.length, 1);
  assert.deepEqual((sends[0]!.body as {ids: string[]}).ids.sort(), ["cq", "persisted-draft"], "the other item's draft is not sent");
});
test("a draft comment's send button sends only that comment; the batch button still sends everything", async () => {
  const s = snapshot();
  s.notes.d = {target: "it:child", kind: "comment", text: "One", at, state: "draft", rev: 1};
  s.notes.e = {target: "it:child", kind: "comment", text: "Two", at, state: "draft", rev: 1};
  s.notes.sent = {target: "it:child", kind: "comment", text: "Sent", at, state: "sent", rev: 1};
  const p = await page(s, [], null, undefined, {notesOpen: {"it:child": true}}); await expand(p);
  assert.equal(noteButton(p, "sent", "发送"), undefined, "only drafts can be sent");
  await noteButton(p, "d", "编辑")!.click();
  assert.equal(noteButton(p, "d", "发送")!.disabled, true, "disabled while the comment is being edited");
  await noteButton(p, "d", "取消")!.click();
  assert.equal(noteButton(p, "d", "发送")!.disabled, false);
  await noteButton(p, "d", "发送")!.click(); await p.flush();
  assert.deepEqual(p.calls.filter(c => c.path === "/api/send").map(c => c.body), [{ids: ["d"]}]);
  await p.roots.get("send-all")!.click(); await p.flush();
  assert.deepEqual(p.calls.filter(c => c.path === "/api/send").map(c => c.body), [{ids: ["d"]}, {}]);
});


test("m is the mark-read key and the retired r key makes no write", async () => {
  const p=await page(nativeSnapshot(),unread());
  p.key("n"); await p.flush();
  assert.equal(p.key("r"),false,"r is no longer an action key"); await p.flush();
  assert.equal(p.calls.filter(c=>c.path === "/api/read").length,0,"the retired key leaves the selected item unread");
  p.key("m"); await p.flush();
  assert.deepEqual(p.calls.filter(c=>c.path === "/api/read").map(c=>c.body),[{doc:"item:child",through:stepId}]);
  const menu=p.document.getElementById("keymenu")!;
  assert.ok(markup(menu).includes("<kbd>m</kbd>")); assert.ok(!markup(menu).includes("<kbd>r</kbd>"));
});

test("project headings omit the retired cross-dependency summary and shared plan rows show only the target", async () => {
  const s=nativeSnapshot(); s.board.projects.push({name:"Other"});
  s.items.far={...s.items.child!,group:"Other",title:"External result",plan:planWork([])};
  s.items.child!.plan=planWork([sharedRow("far")]);
  const p=await page(s,[]); await expand(p);
  assert.equal(p.all().filter(e=>e.classList.contains("xdeps")).length,0,"neither project heading displays the removed cross-dependency summary");
  assert.match(markup(planRow(p,"child","far")),/External result/,"the shared row names its target");
  assert.doesNotMatch(markup(planRow(p,"child","far")),/Other/,"the owner asked for no project or owner line under a shared row");
});

test("a cancelled item shows no check tags, in the tree or on plan rows", async () => {
  const s=nativeSnapshot(); s.items.gone={...s.items.child!,title:"Gone",status:"cancelled",provisional:true,plan:planWork([])};
  s.items.area!.plan=planWork([ownedRow("child"),ownedRow("gone")]);
  const p=await page(s,[]); await expand(p,"area");
  assert.ok(!planRow(p,"area","gone").querySelectorAll(".checktag").some(e=>e.innerHTML === "待重写"),"a cancelled owned row drops 待重写");
  s.items.child!.provisional=true;
  const q=await page(s,[]); await expand(q,"area");
  assert.ok(planRow(q,"area","child").querySelectorAll(".checktag").some(e=>e.innerHTML === "待重写"),"an open owned row keeps it");
});

test("numbered items show their number in the status chip, cards show theirs, and / finds by number", async () => {
  const s=snapshot(); s.decisions.q={...card(),num:812} as Decision;
  Object.assign(s.items.area!,{num:7}); Object.assign(s.items.child!,{num:8});
  const p=await page(s,[]); await expand(p);
  const chip=rowOf(p,"child").querySelector(".item-head .st")!;
  assert.equal(chip.innerHTML,"8","the tree row's chip shows the number instead of the status word");
  assert.ok(chip.classList.contains("wip"),"the chip's colour class still carries the status");
  assert.equal(chip.title,"WIP","the status word stays discoverable as the tooltip");
  const detail=item(p,"child").querySelector(".item-head .st")!;
  assert.equal(detail.innerHTML,"8"); assert.equal(detail.title,"WIP","the detail header's chip matches the tree row");
  const c=p.all().find(e=>e.id === "q-q")!, num=descendants(c).find(e=>e.classList.contains("cardnum"))!;
  assert.equal(num.innerHTML,"812","the card header shows its number");
  const h=num.parentElement!; assert.ok(h.children.indexOf(num) < h.children.findIndex(e=>e.innerHTML === card().question),"the number comes before the question");
  p.key("/");
  const input=p.document.getElementById("search-input")!; input.value="812"; await input.handlers.get("input")![0]!({});
  const rows=p.all().filter(e=>e.classList.contains("searchrow"));
  assert.ok(rows.length >= 1 && rows[0]!.innerHTML.includes(card().question),"a number query lists the card holding it first");
  input.value="8"; await input.handlers.get("input")![0]!({});
  const first=p.all().find(e=>e.classList.contains("searchrow"))!;
  assert.match(first.innerHTML,/<span class="st wip" title="WIP">8<\/span>.*Child/,"the item found by number shows its numbered chip");
  p.key("Escape",input);
  s.items.area!.paused={reason:"停",at};
  const paused=await page(s,[]);
  assert.equal(rowOf(paused,"area").querySelector(".item-head .st")!.innerHTML,"◌ 7","a paused item keeps the pause mark beside its number");
});

test("a card its item's plan names unfolds inline under its row, once, and navigation unfolds it", async () => {
  const s=nativeSnapshot(); s.decisions.q=card(); s.decisions.loose={...card(),question:"Not in the plan"};
  s.items.child!.plan=planWork([planStep("work","Work"),cardRow("q")]);
  s.items.area!.plan=[...s.items.area!.plan.slice(0,-1),cardRow("q"),s.items.area!.plan.at(-1)!];
  const storage=new Map<string,string>();
  const p=await page(s,[],null,undefined,{storage}); await expand(p);
  const cards=()=>p.all().filter(e=>e.id === "q-q");
  assert.equal(cards().length,0,"collapsed by default, and not repeated in the card list at the bottom");
  assert.ok(p.all().some(e=>e.id === "q-loose"),"a card the plan does not name keeps its place at the bottom");
  const toggle=planRow(p,"child","q").querySelector(".cardtoggle")!;
  await toggle.click(); await p.flush();
  assert.equal(cards().length,1,"one card element, so ids stay unique");
  const row=planRow(p,"child","q"), parent=row.parentElement!;
  assert.equal(parent.children[parent.children.indexOf(row)+1],cards()[0],"the card sits right under its plan row");
  assert.match(markup(cards()[0]!),/渲染正文/); assert.match(markup(cards()[0]!),/中文正文/,"options and background are shown inline");
  assert.equal(planRow(p,"child","q").querySelector(".cardtoggle")!.attributes["aria-expanded"],"true");
  assert.equal(JSON.parse(storage.get("board-inline-cards")!).q,true,"the unfolded state is remembered");
  p.key("c"); await settle();
  assert.ok(p.all().some(e=>e.id === "ed-q_q"),"c on the unfolded, selected card comments on that card");
  const reloaded=await page(s,[],null,undefined,{storage}); await expand(reloaded);
  assert.equal(reloaded.all().filter(e=>e.id === "q-q").length,1,"a reload keeps it unfolded");
  await planRow(p,"child","q").querySelector(".cardtoggle")!.click(); await p.flush();
  assert.equal(cards().length,0,"a second click folds it again");
  // Another item's plan row for the card unfolds it too, rather than linking to the card's own item.
  await expand(p,"area");
  assert.equal(planRow(p,"area","q").querySelector(".cardtoggle")!.attributes["aria-expanded"],"false");
  // Following a reference to the card from an item whose plan does not name it opens the card's item and unfolds it
  // inline under the plan row.
  storage.delete("board-inline-cards");
  s.items.area!.plan=s.items.area!.plan.filter(row => !("card" in row));
  const q=await page(s,[],null,undefined,{storage}); await expand(q,"area");
  const ref=q.document.createElement("a"); ref.className="itemref"; ref.setAttribute("data-ref","q:q"); ref.bubbleClick=true; q.roots.get("sendbox")!.appendChild(ref);
  await ref.click(); await q.flush();
  assert.equal(storage.get("board-selected"),"child","the card's own item is selected");
  const shown=q.all().filter(e=>e.id === "q-q");
  assert.equal(shown.length,1);
  const target=planRow(q,"child","q"), host=target.parentElement!;
  assert.equal(host.children[host.children.indexOf(target)+1],shown[0],"navigation unfolds the card under its row");
});

test("a card row whose card belongs to another item unfolds inline there and keeps the selection", async () => {
  // The card's own item is the finished parent, whose plan does not name it; the child's plan shares it.
  const s=nativeSnapshot(); s.decisions.q={...card(),item:"area",blocks:"Release waits for the ruling"};
  s.items.area!.plan=planWork([planStep("work","Work","done")],"done");
  s.items.child!.plan=planWork([planStep("work","Work"),cardRow("q")]);
  const storage=new Map<string,string>();
  const p=await page(s,[],null,undefined,{storage}); await expand(p);
  assert.ok(item(p,"child").id === "detail-it-child");
  await planRow(p,"child","q").querySelector(".plan-link")!.click({clientX:0,clientY:0}); await p.flush();
  assert.equal(storage.get("board-selected"),"child","the shown item stays selected");
  assert.ok(p.all().some(e => e.id === "detail-it-child") && !p.all().some(e => e.id === "detail-it-area"),"the detail pane still shows the child");
  const shown=p.all().filter(e => e.id === "q-q"), row=planRow(p,"child","q"), parent=row.parentElement!;
  assert.equal(shown.length,1,"one card element");
  assert.equal(parent.children[parent.children.indexOf(row)+1],shown[0],"the card unfolds under the row that was clicked");
  assert.ok(shown[0]!.className.split(" ").includes("cur"),"the unfolded card is selected, so c and m act on it");
  // Commenting on it keeps the child shown and comments on the same card.
  p.key("c"); await settle();
  assert.equal(storage.get("board-selected"),"child","c on the inline card does not switch to the card's own item");
  assert.ok(p.all().some(e => e.id === "ed-q_q"),"the comment box is the card's own");
  // A second click folds it again, still in place.
  await planRow(p,"child","q").querySelector(".plan-link")!.click({clientX:0,clientY:0}); await p.flush();
  assert.equal(p.all().filter(e => e.id === "q-q").length,0);
  assert.equal(storage.get("board-selected"),"child");
});

test("a click anywhere on a card row folds and unfolds its card, while links inside the row keep their action", async () => {
  const s=nativeSnapshot(); s.decisions.q=card();
  s.items.child!.plan=planWork([planStep("work","Work"),cardRow("q")]);
  const storage=new Map<string,string>();
  const p=await page(s,[],null,undefined,{storage}); await expand(p);
  // The row element itself, as a click in the blank space after a wrapped question hits it.
  await planRow(p,"child","q").click({clientX:0,clientY:0}); await p.flush();
  const row=planRow(p,"child","q"), parent=row.parentElement!, shown=p.all().filter(e => e.id === "q-q");
  assert.equal(shown.length,1,"a click on the row unfolds the card");
  assert.equal(parent.children[parent.children.indexOf(row)+1],shown[0],"under its row");
  assert.equal(row.querySelector(".cardtoggle")!.attributes["aria-expanded"],"true");
  assert.equal(storage.get("board-selected"),"child");
  await planRow(p,"child","q").click({clientX:0,clientY:0}); await p.flush();
  assert.equal(p.all().filter(e => e.id === "q-q").length,0,"a second click on the row folds it");
  // A link inside the row acts as itself and does not also fold or unfold the card.
  const link=p.document.createElement("a"); link.className="itemref"; link.setAttribute("data-ref","it:area"); link.bubbleClick=true;
  planRow(p,"child","q").appendChild(link);
  await link.click(); await p.flush();
  assert.equal(storage.get("board-selected"),"area","the link inside the row followed its target");
  assert.equal(JSON.parse(storage.get("board-inline-cards")!).q,false,"the card's fold did not change");
});

test("a card row for the item's own card unfolds inline when a finished item's plan also names the card", async () => {
  // A ruled card, so the other item naming it can be finished.
  const s=nativeSnapshot(); s.decisions.q={...card(),status:"ruled",ruling:"B"};
  s.items.child!.plan=planWork([planStep("work","Work"),cardRow("q")]);
  s.items.finished={...s.items.area!,title:"Finished",plan:[cardRow("q"),planAcceptance("done")]};
  // The finished item comes first in board order, so a lookup by card name across plans would find it first.
  s.items={finished:s.items.finished!,...s.items};
  const storage=new Map<string,string>();
  const p=await page(s,[],null,undefined,{storage}); await expand(p);
  assert.equal(rules(s).statusOf("finished"),"done");
  await planRow(p,"child","q").querySelector(".plan-link")!.click({clientX:0,clientY:0}); await p.flush();
  assert.equal(storage.get("board-selected"),"child","the click does not move to the finished item");
  const shown=p.all().filter(e => e.id === "q-q"), row=planRow(p,"child","q"), parent=row.parentElement!;
  assert.equal(shown.length,1);
  assert.equal(parent.children[parent.children.indexOf(row)+1],shown[0],"the card unfolds under the child's row");
  // Following the card from the finished item's own row, with the finished item shown, unfolds it there instead.
  await expand(p,"finished");
  assert.equal(storage.get("board-selected"),"finished");
  const there=planRow(p,"finished","q"), host=there.parentElement!;
  assert.equal(host.children[host.children.indexOf(there)+1],p.all().find(e => e.id === "q-q"),"the remembered unfolded card shows under the finished item's row");
});

test("n visits an item, then the cards its plan unfolds, then its comments, then its other cards", async () => {
  const s=nativeSnapshot(); s.decisions.q=card(); s.decisions.loose={...card(),question:"Not in the plan"};
  s.items.child!.plan=planWork([cardRow("q")]);
  s.notes.n={target:"it:child",kind:"comment",text:"Owner comment",at,state:"sent",rev:1};
  const p=await page(s,[...unread("decision","loose","1".repeat(40)),...unread("note","n","2".repeat(40)),...unread("decision","q","3".repeat(40)),...unread("item","child","4".repeat(40))]);
  const visited: string[]=[];
  for (let i=0;i<4;i++) {
    p.key("n"); await p.flush();
    const cur=p.all().find(e=>e.className.split(" ").includes("cur") && (e.id.startsWith("q-") || e.id.startsWith("note-") || e.id.startsWith("detail-it-")))!;
    visited.push(cur.id);
  }
  assert.deepEqual(visited,["detail-it-child","q-q","note-n","q-loose"]);
  assert.ok(planRow(p,"child","q").parentElement!.children.some(e=>e.id === "q-q"),"n unfolded the planned card under its row");
});

function taggedSnapshot(): Snapshot {
  const s = nativeSnapshot();
  s.board.tags = [{ name: "健全性", meaning: "改动影响程序是否被正确拒绝或接受" }, { name: "报错信息", meaning: "改动影响诊断" }];
  s.items.child!.tags = ["健全性", "报错信息"];
  return s;
}
test("a tree row shows its tags after the title, and the detail shows them on a line directly under the title", async () => {
  const p = await page(taggedSnapshot(), []);
  await expand(p, "child");
  const head = rowOf(p, "child").querySelector(".item-head")!;
  const kinds = head.children.map(e => e.className.split(" ")[0]);
  assert.ok(kinds.indexOf("tagchips") > kinds.indexOf("item-title"), "the chips follow the title on the same row");
  const chips = head.querySelector(".tagchips")!.children;
  assert.deepEqual(chips.map(c => c.innerHTML), ["健全性", "报错信息"]);
  assert.equal(chips[0]!.title, "改动影响程序是否被正确拒绝或接受", "hovering a tag shows its meaning");
  assert.equal(rowOf(p, "child").querySelector(".item-tags"), null, "the tree row has no separate tag line");
  const detail = item(p, "child");
  assert.equal(detail.id, "detail-it-child");
  assert.ok(detail.children[0]!.classList.contains("item-row"));
  assert.ok(detail.children[1]!.classList.contains("item-tags"), "the tag line comes directly after the title row");
  assert.deepEqual(detail.children[1]!.children.map(c => c.innerHTML), ["健全性", "报错信息"]);
  assert.equal(detail.children[0]!.querySelector(".tagchips"), null, "the detail title row does not repeat them");
  assert.equal(rowOf(p, "area").querySelector(".item-head .tagchips"), null, "an untagged item shows no chips and no warning");
  const html = await readFile("web/index.html", "utf8");
  assert.match(html, /\.tagchip \{[^}]*background/, "the chips are neutral, not a status colour");
  assert.doesNotMatch(html.match(/\.tagchip \{[^}]*\}/)![0], /--(wip|done|blocked|todo)/);
});

test("the tag filter shows items carrying any selected tag and their ancestors, and hides the rest", async () => {
  const s = taggedSnapshot();
  s.items.sibling = { ...structuredClone(s.items.child!), title: "Sibling", tags: ["报错信息"] } as Item;
  s.items.area!.plan = [...s.items.area!.plan.filter(r => !("accept" in r)), { id: "sibling", item: "sibling", own: true, after: [] }, ...s.items.area!.plan.filter(r => "accept" in r)];
  s.items.other = { ...structuredClone(s.items.child!), title: "Other", tags: ["健全性"], group: "Project" } as Item;
  s.items.area!.plan.splice(-1, 0, { id: "other", item: "other", own: true, after: [] });
  s.items.child!.tags = ["健全性"];
  const p = await page(s, []); await expand(p, "child");
  assert.ok(rowOf(p, "child") && rowOf(p, "sibling") && rowOf(p, "other"), "unfiltered: all visible");
  const button = (text: string) => p.all().find(e => e.tagName === "BUTTON" && e.innerHTML === text);
  assert.ok(button("健全性 2") && button("报错信息 1"), "the filter row offers each tag with its item count");
  await button("报错信息 1")!.click(); await p.flush();
  assert.ok(rowOf(p, "sibling"), "the item carrying the tag stays");
  assert.ok(rowOf(p, "area"), "its ancestor stays for context");
  assert.equal(rowOf(p, "child"), undefined, "an item without the selected tag is hidden");
  assert.equal(rowOf(p, "other"), undefined);
  await button("健全性 2")!.click(); await p.flush();
  assert.ok(rowOf(p, "sibling") && rowOf(p, "child") && rowOf(p, "other"), "any selected tag keeps an item");
  await button("报错信息 1")!.click(); await p.flush();
  assert.equal(rowOf(p, "sibling"), undefined);
  assert.ok(rowOf(p, "child") && rowOf(p, "other"));
});

test("a tag name is shown as text, not markup, in the chips and the filter button", async () => {
  const s = taggedSnapshot();
  s.board.tags = [{ name: "<b>x</b>", meaning: "markup in a name" }];
  s.items.child!.tags = ["<b>x</b>"];
  const p = await page(s, []); await expand(p, "child");
  const chip = rowOf(p, "child").querySelector(".tagchips")!.children[0]!;
  assert.equal(chip.innerHTML, "&lt;b&gt;x&lt;/b&gt;");
  assert.ok(p.all().some(e => e.tagName === "BUTTON" && e.innerHTML === "&lt;b&gt;x&lt;/b&gt; 1"), "the filter button escapes the name");
});

test("the detail shows the difficulty first on the line under the title, before the tags; the tree row and an unrated item show none", async () => {
  const s = taggedSnapshot();
  s.items.child!.difficulty = 3;
  const p = await page(s, []);
  await expand(p, "child");
  const line = item(p, "child").children[1]!;
  assert.ok(line.classList.contains("item-tags"), "the difficulty shares the line directly under the title");
  assert.deepEqual(line.children.map(c => c.innerHTML), ["难度 3", "健全性", "报错信息"], "the difficulty comes first, then the tags");
  assert.ok(line.children[0]!.classList.contains("diffchip") && line.children[0]!.classList.contains("tagchip"));
  assert.ok(!line.children[1]!.classList.contains("diffchip"));
  assert.equal(rowOf(p, "child").querySelector(".diffchip"), null, "the tree row does not show it");
  // The architect's own item has the label, and its line exists without any tag.
  const own = taggedSnapshot(); own.items.area!.difficulty = "architect";
  const q = await page(own, []); await selectWide(q, "area");
  assert.deepEqual(detailItem(q, "area")!.querySelector(".item-tags")!.children.map(c => c.innerHTML), ["架构师做"]);
  // An item without a difficulty and tags has no line.
  const bare = await page(taggedSnapshot(), []); await selectWide(bare, "area");
  assert.equal(detailItem(bare, "area")!.querySelector(".item-tags"), null);
  const html = await readFile("web/index.html", "utf8");
  assert.doesNotMatch(html.match(/\.diffchip \{[^}]*\}/)![0], /--tag-/, "the difficulty is not drawn as one of the teal tags");
});

test("a live change of the difficulty repaints the chip, also when it first appears or goes", async () => {
  const s = taggedSnapshot(); s.items.child!.difficulty = 2;
  const p = await page(s, []); await expand(p, "child");
  const chips = () => item(p, "child").querySelector(".item-tags")?.children.map(c => c.innerHTML);
  assert.deepEqual(chips(), ["难度 2", "健全性", "报错信息"]);
  await p.change("c".repeat(40), [{ kind: "item", id: "child", after: { ...s.items.child!, difficulty: 4, rev: 2 } }]); await p.flush();
  assert.deepEqual(chips(), ["难度 4", "健全性", "报错信息"], "the changed difficulty is painted");
  const { difficulty: _gone, ...unrated } = s.items.child!;
  await p.change("d".repeat(40), [{ kind: "item", id: "child", after: { ...unrated, rev: 3 } as Item }]); await p.flush();
  assert.deepEqual(chips(), ["健全性", "报错信息"], "an item that loses its difficulty keeps its tags");
  await p.change("e".repeat(40), [{ kind: "item", id: "child", after: { ...unrated, difficulty: "architect", rev: 4 } as Item }]); await p.flush();
  assert.deepEqual(chips(), ["架构师做", "健全性", "报错信息"]);
});

test("writing a note on an unfolded inline card keeps it unfolded through save and send", async () => {
  const s=nativeSnapshot(); s.decisions.q=card();
  s.items.child!.plan=planWork([planStep("work","Work"),{...cardRow("q"),id:"ask-owner"}]);
  const storage=new Map<string,string>([["board-inline-cards",'{"q":true}'],["board-notes",'{"q:q":true}']]); // unfolded earlier and remembered; its plan row id differs from the card key
  const p=await page(s,[],null,undefined,{storage,response:path=>path === "/api/notes" ? reply({id:"saved"}) : undefined}); await expand(p);
  const cards=()=>p.all().filter(e=>e.id === "q-q");
  assert.equal(cards().length,1,"unfolded");
  await cards()[0]!.click(); await p.flush();
  p.key("c"); await settle();
  const editor=p.all().find(e=>e.id === "ed-q_q")!; assert.ok(editor,"the card's comment editor is open");
  editor.value="Draft on the card";
  await editor.parentElement!.querySelector(".save")!.click(); await p.flush(); await settle();
  const draft={target:"q:q",kind:"comment" as const,text:"Draft on the card",at,state:"draft" as const,rev:1};
  await p.change("c".repeat(40),[{kind:"note",id:"saved",after:draft},{kind:"item",id:"child",after:{...s.items.child!,rev:2}},{kind:"decision",id:"q",after:{...s.decisions.q!,rev:2}}]); await p.flush(); await settle();
  assert.equal(cards().length,1,"saving the draft keeps the card unfolded");
  assert.equal(planRow(p,"child","ask-owner").querySelector(".cardtoggle")!.attributes["aria-expanded"],"true");
  assert.equal(JSON.parse(storage.get("board-inline-cards")!).q,true);
  assert.match(markup(cards()[0]!),/Draft on the card/,"the draft note is visible on the card");
  await cardSend(p).click(); await p.flush(); await settle();
  await p.change("d".repeat(40),[{kind:"note",id:"saved",after:{...draft,state:"sent",rev:2}}]); await p.flush(); await settle();
  assert.equal(cards().length,1,"sending keeps the card unfolded");
  assert.equal(planRow(p,"child","ask-owner").querySelector(".cardtoggle")!.attributes["aria-expanded"],"true");
});

test("an item's purple number cycles only through the blocking cards it counts, also after an unrelated re-render", async () => {
  const s=snapshot();
  s.items.x={title:"X",group:"Project",priority:"P1",updated:at,rev:1,deps:[],links:[],log:[]};
  s.items.y={title:"Y",group:"Project",priority:"P1",updated:at,rev:1,deps:[],links:[],log:[]};
  s.decisions.y1={...card(),item:"y",blocks:"Y work 1"}; s.decisions.y2={...card(),item:"y",blocks:"Y work 2"};
  const p=await page(s,[]);
  assert.equal(wideHead(p,"y").children.find(e=>e.className === "waittag")!.innerHTML,"2");
  // A blocking card appears on an item that comes earlier on the board; only that item's row is repainted.
  p.emit("b".repeat(40),[{kind:"decision",id:"x1",after:{...card(),item:"x",blocks:"X work"}}]); await p.flush();
  assert.equal(wideHead(p,"x").children.find(e=>e.className === "waittag")!.innerHTML,"1");
  const landed=new Set<string>();
  for (let i=0;i<4;i++) {
    await wideHead(p,"y").children.find(e=>e.className === "waittag")!.click(); await p.flush();
    const cur=p.all().find(e=>e.id.startsWith("q-") && e.className.split(" ").includes("cur"));
    assert.ok(cur,"a card is selected"); landed.add(cur!.id);
    assert.ok(["q-y1","q-y2"].includes(cur!.id),"click "+(i+1)+" landed on "+cur!.id+", not on one of Y's own cards");
  }
  assert.deepEqual([...landed].sort(),["q-y1","q-y2"],"the clicks cycle through both of Y's cards");
});

test("an item's red number leads to the non-blocking cards it counts, also after an unrelated re-render", async () => {
  const s=snapshot();
  s.items.x={title:"X",group:"Project",priority:"P1",updated:at,rev:1,deps:[],links:[],log:[]};
  s.items.y={title:"Y",group:"Project",priority:"P1",updated:at,rev:1,deps:[],links:[],log:[]};
  s.items.z={title:"Z",parent:"y",status:"wip",group:"Project",priority:"P1",updated:at,rev:1,deps:[],links:[],log:[]};
  s.decisions.y1={...card(),item:"y"}; s.decisions.z1={...card(),item:"z"};
  const p=await page(s,[]);
  const red=()=>wideHead(p,"y").children.find(e=>e.className === "asktag")!;
  assert.equal(red().innerHTML,"2","the collapsed child's card counts");
  p.emit("b".repeat(40),[{kind:"decision",id:"x1",after:{...card(),item:"x"}}]); await p.flush();
  const landed=new Set<string>();
  for (let i=0;i<4;i++) {
    await red().click(); await p.flush();
    const cur=p.all().find(e=>e.id.startsWith("q-") && e.className.split(" ").includes("cur"));
    assert.ok(cur && ["q-y1","q-z1"].includes(cur.id),"click "+(i+1)+" landed on "+cur?.id+", outside Y's subtree");
    landed.add(cur!.id);
  }
  assert.deepEqual([...landed].sort(),["q-y1","q-z1"]);
});

test("a comment saved on an open card of a record item no plan names stays in view with its send button", async () => {
  const s=nativeSnapshot();
  s.items.queue={title:"Queue",group:"Project",priority:"P1",updated:at,rev:1,deps:[],links:[],log:[],record:true,plan:[]} as never;
  s.decisions.q={...card(),item:"queue",blocks:"perf measurements"};
  s.notes.old={target:"q:q",kind:"comment",text:"Earlier comment",at,state:"sent",rev:1};
  // The list was folded by hand earlier, as on the owner's board.
  const storage=new Map<string,string>([["board-notes",'{"q:q":false}']]);
  const p=await page(s,[],null,undefined,{storage,response:path=>path === "/api/notes" ? reply({id:"saved"}) : undefined}); await expand(p,"queue");
  const cards=()=>p.all().filter(e=>e.id === "q-q");
  assert.equal(cards().length,1,"the open card is shown");
  assert.doesNotMatch(markup(cards()[0]!),/Earlier comment/,"the list starts folded");
  await cards()[0]!.click(); await p.flush();
  p.key("c"); await settle();
  const editor=p.all().find(e=>e.id === "ed-q_q")!; assert.ok(editor,"the card's comment editor is open");
  editor.value="Draft on the card";
  await editor.parentElement!.querySelector(".save")!.click(); await p.flush(); await settle();
  const draft={target:"q:q",kind:"comment" as const,text:"Draft on the card",at:"2026-10-11T01:02:04Z",state:"draft" as const,rev:1};
  await p.change("c".repeat(40),[{kind:"note",id:"saved",after:draft},{kind:"item",id:"queue",after:{...(s.items.queue as object),rev:2} as never},{kind:"decision",id:"q",after:{...s.decisions.q!,rev:2}}]); await p.flush(); await settle();
  assert.equal(cards().length,1,"saving keeps the card");
  assert.match(markup(cards()[0]!),/Draft on the card/,"the saved draft is visible without unfolding the comment list");
  assert.ok(descendants(cards()[0]!).some(e=>e.className === "cardsend" && e.innerHTML === "发送"),"its send button is reachable");
});

test("an item's blue number leads to its own first new place after an unrelated item gains new content", async () => {
  const s=snapshot();
  s.items.x={title:"X",group:"Project",priority:"P1",updated:at,rev:1,deps:[],links:[],log:[]};
  s.items.y={title:"Y",group:"Project",priority:"P1",updated:at,rev:1,deps:[],links:[],log:[]};
  s.items.z={title:"Z",parent:"y",status:"wip",group:"Project",priority:"P1",updated:at,rev:1,deps:[],links:[],log:[]};
  const yStep=unread("item","z","7".repeat(40)), xStep=unread("item","x","8".repeat(40));
  let steps=yStep;
  const p=await page(s,yStep,null,undefined,{response:path=>path === "/api/unread" ? reply({steps}) : undefined});
  const blue=()=>wideHead(p,"y").children.find(e=>e.className.includes("freshchip"))!;
  assert.equal(blue().innerHTML,"1","Y shows the new content of its child");
  // New unread content appears on X, which comes earlier on the board; Y's row is not repainted.
  steps=[...xStep,...yStep];
  p.emit("b".repeat(40),[{kind:"item",id:"x",after:{...s.items.x!,rev:2}}]); await p.flush(); await settle();
  await blue().click(); await p.flush(); await settle();
  const selected=p.all().find(e=>e.id.startsWith("detail-it-"));
  assert.equal(selected?.id,"detail-it-z","the click lands on Y's new place (its child Z), not on X");
});

test("code blocks are set in Monaco: the inner code element inherits the block's font instead of the inline-code font", async () => {
  const html = await readFile("web/index.html", "utf8");
  assert.match(html.match(/\.rich pre\.code \{[^}]*\}/)![0], /font-family: Monaco/);
  assert.match(html.match(/\.rich pre\.code code \{[^}]*\}/)![0], /font: inherit/, "the global code rule would otherwise reset the family to the mono stack");
});

test("tag chips are one teal with text readable at 4.5:1 in the light theme and both dark-theme blocks", async () => {
  const html = await readFile("web/index.html", "utf8");
  assert.match(html.match(/\n\.tagchip \{[^}]*\}/)![0], /background: var\(--tag-bg\); color: var\(--tag-ink\); border: 1px solid var\(--tag-rule\)/);
  const lum = (hex: string) => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const pairs = [...html.matchAll(/--tag-bg: (#[0-9a-f]{6}); --tag-ink: (#[0-9a-f]{6});/g)];
  assert.equal(pairs.length, 3, "light :root, the prefers-color-scheme dark block and the data-theme dark block each set the tag colors");
  for (const [, bg, ink] of pairs) {
    const [hi, lo] = [lum(bg!), lum(ink!)].sort((a, b) => b - a);
    assert.ok((hi! + 0.05) / (lo! + 0.05) >= 4.5, `tag text ${ink} on ${bg} is below 4.5:1`);
  }
});

test("an open card with two options shows the option check on the card and its item; three options show none", async () => {
  const s = snapshot(), frames = new Frames();
  s.decisions.short = card();
  s.decisions.full = {...card(), options: [...card().options, {key:"C",text:"以后再说"}]};
  const p = await page(s, [], null, undefined, {frames}); await expand(p); await p.flush();
  const shown = (id: string) => markup(p.all().find(e => e.id === "q-" + id)!);
  const warning = "决策卡只有 2 个选项";
  assert.match(shown("short"), /需核对：决策卡只有 2 个选项，至少要给三个都走得通的做法/, "the open two-option card shows the check");
  assert.ok(!shown("full").includes(warning), "three options show no check");
  assert.match(markup(item(p)), /需核对：决策卡只有 2 个选项/, "the item lists the check under its body");
  assert.deepEqual(rowOf(p).querySelectorAll(".checktag").map(e => e.innerHTML).filter(label => label === "选项不足"), ["选项不足"], "the item row carries the tag");
});

test("an owner notice from the stream shows one browser notice; its click opens the card it is about; an obsolete stream shows none", async () => {
  const s = snapshot(), clock = new FakeClock();
  s.decisions.hard = { item: "child", question: "选哪个？", background: "背景", options: [{ key: "A", text: "是", recommended: true }], status: "open", blocks: "挡住 chrome-notify", updated: at, rev: 1 };
  const shown: Array<{ title: string; options: { body: string; tag: string }; onclick: (() => void) | null; closed: boolean; close(): void }> = [];
  class FakeNotification {
    static permission = "granted";
    onclick: (() => void) | null = null; closed = false; title: string; options: { body: string; tag: string };
    constructor(title: string, options: { body: string; tag: string }) { this.title = title; this.options = options; shown.push(this); }
    close() { this.closed = true; }
  }
  const p = await page(s, [], null, undefined, { clock, notification: FakeNotification }); await expand(p);
  const owner = (notice: unknown) => p.sources.at(-1)!.handlers.get("owner")!({ data: JSON.stringify(notice) });
  owner({ title: "挡事的卡 · Whitefoot", message: "选哪个？（挡住：挡住 chrome-notify）", target: { kind: "card", key: "hard" } });
  assert.equal(shown.length, 1, "one notice for one owner event");
  assert.equal(shown[0]!.title, "挡事的卡 · Whitefoot");
  assert.equal(shown[0]!.options.tag, "card:hard", "the tag is the card's key, so open tabs share one notice");
  shown[0]!.onclick!(); await p.flush();
  assert.equal(shown[0]!.closed, true);
  assert.ok(p.all().find(e => e.id === "q-hard")!.className.includes("cur"), "the click selects the card the notice names");
  // A notice about no card or item opens the home view, which selects no card.
  owner({ title: "架构师一小时没响应", message: "x" });
  shown[1]!.onclick!(); await p.flush();
  assert.ok(!p.all().find(e => e.id === "q-hard")?.className.includes("cur"), "the home view selects nothing");
  // After a reconnect the old stream's events are ignored; the new one shows its notices.
  p.sources.at(-1)!.onerror!(); clock.advance(5000); await settle();
  const obsolete = p.sources[0]!;
  obsolete.handlers.get("owner")!({ data: JSON.stringify({ title: "旧的", message: "不该弹" }) });
  assert.equal(shown.length, 2, "an obsolete stream shows nothing");
  owner({ title: "新的", message: "弹" });
  assert.equal(shown.length, 3);
  assert.equal(shown[2]!.options.tag, "新的", "a notice with no target is tagged with its title");
});

// --- The agent list --------------------------------------------------------------------------------------------------

const NOW = Date.parse("2026-10-16T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
/** The page's fixture with a session list: `eng` touched child and area; `child` has a step in progress. */
function agentSnapshot(agents: NonNullable<Snapshot["activity"]>["agents"], steps?: PlanStep[]) {
  const s = snapshot();
  if (steps) s.items.child!.steps = steps;
  s.activity = { writes: [], items: {}, agents };
  return s;
}
const agentRowsOf = (p: Awaited<ReturnType<typeof page>>) => p.roots.get("agents")!.querySelectorAll(".agent");
const agentText = (e: Element) => descendants(e).map(x => x.textContent || x.innerHTML.replace(/<[^>]*>/g, "")).join(" ");

test("agent list: a row per session with its level, state word, how long ago it wrote and its two items", async () => {
  const s = agentSnapshot({ eng: [{ item: "child", at: minutesAgo(5) }, { item: "area", at: minutesAgo(70) }] });
  s.items.child!.dispatches = [{ agentId: "x1", agent: "eng", role: "工程师", level: 2, model: "Sonnet", started: minutesAgo(90) }];
  const p = await page(s, [], null, undefined, { now: () => NOW });
  const host = p.roots.get("agents")!;
  assert.equal(host.hidden, false);
  assert.equal(host.querySelector(".agents-toggle")!.innerHTML, "▾ 代理 1");
  const [row] = agentRowsOf(p);
  assert.ok(row);
  assert.equal(row!.dataset.agent, "eng");
  assert.equal(row!.querySelector(".agent-name")!.innerHTML, "eng");
  assert.equal(row!.querySelector(".diffchip")!.innerHTML, "2 级");
  assert.equal(row!.querySelector(".agent-state")!.innerHTML, "干活");
  assert.equal(row!.querySelector(".agent-ago")!.innerHTML, "5 分钟前写过");
  const cells = row!.querySelectorAll(".agitem");
  assert.deepEqual(cells.map(c => c.querySelector(".agitem-title")!.innerHTML), ["Child", "Parent"], "newest first");
  assert.deepEqual(cells.map(c => c.querySelector(".agitem-time")!.innerHTML), ["5 分钟前", "1 小时 10 分钟前"]);
  assert.ok(cells.every(c => c.id.startsWith("ag-eng--cell-")), "cells carry the row's prefix and their own infix");
  assert.ok(!descendants(host).some(e => e.id.startsWith("it-")), "no element of the list has an id the tree uses");
  assert.match(host.querySelector(".agents-note")!.innerHTML, /不是看到的/, "the list says its state is inferred");
});

test("agent list: waiting shows the step's own text, a long wait is amber, a stale step reads maybe stopped, no step has no word", async () => {
  const waiting = (waits: string): PlanStep[] => [planStep("work", "Work", "doing", { waits }), planAcceptance()];
  const word = async (m: number, steps?: PlanStep[], item = "child") => {
    const p = await page(agentSnapshot({ a: [{ item, at: minutesAgo(m) }] }, steps), [], null, undefined, { now: () => NOW });
    // A session with no step in progress is not running, so its row is behind 其他 N 个: open that.
    if (!agentRowsOf(p).length) { await p.roots.get("agents")!.querySelector(".agents-others-toggle")!.click(); await p.flush(); }
    const state = agentRowsOf(p)[0]!.querySelector(".agent-state");
    return state ? [state.innerHTML, state.className] : null;
  };
  assert.deepEqual(await word(20, waiting("PR 草稿 CI")), ["在等：PR 草稿 CI", "agent-state waiting"]);
  assert.deepEqual(await word(61, waiting("PR 草稿 CI")), ["在等：PR 草稿 CI", "agent-state waiting amber"]);
  assert.deepEqual(await word(29), ["干活", "agent-state working"]);
  assert.deepEqual(await word(31), ["可能停了", "agent-state maybe-stopped"]);
  assert.equal(await word(5, undefined, "area"), null, "no step in progress on the item: only the time");
});

test("agent list: only running rows are unfolded; the rest sit behind 其他 N 个, which opens them and the choice is kept", async () => {
  // eng has a step in progress on child; the open reviews are judged by their start; idle touched only area, which has no step.
  const s = agentSnapshot({ eng: [{ item: "child", at: minutesAgo(5) }], idle: [{ item: "area", at: minutesAgo(8) }], idle2: [{ item: "area", at: minutesAgo(50) }] });
  const review = (agent: string, started: number) => ({ agentId: agent, agent, role: "审查" as const, level: 3, model: "Opus", started: minutesAgo(started) });
  s.items.child!.dispatches = [review("fresh-review", 10), review("old-review", 45)];
  const storage = new Map<string, string>();
  const p = await page(s, [], null, undefined, { now: () => NOW, storage });
  const host = p.roots.get("agents")!, others = () => host.querySelector(".agents-others-toggle")!;
  assert.deepEqual(agentRowsOf(p).map(r => r.dataset.agent), ["eng", "fresh-review"], "running rows only, newest first");
  assert.equal(host.querySelector(".agents-toggle")!.innerHTML, "▾ 代理 2", "the heading counts the running rows");
  assert.equal(others().innerHTML, "▸ 其他 3 个");
  assert.equal(others().attributes["aria-expanded"], "false");
  assert.equal(host.querySelector(".agent-list")!.children.at(-1)!.classList.contains("agent-others"), true, "the fold is the last line of the list");
  await others().click(); await p.flush();
  assert.equal(others().innerHTML, "▾ 其他 3 个");
  assert.deepEqual(agentRowsOf(p).map(r => r.dataset.agent), ["eng", "fresh-review", "idle", "old-review", "idle2"], "opened: the other rows follow the running ones, newest first, drawn as before");
  assert.equal(storage.get("board-agents-others"), "open");
  const again = await page(s, [], null, undefined, { now: () => NOW, storage });
  assert.equal(agentRowsOf(again).length, 5, "a reload keeps it open");
  await again.roots.get("agents")!.querySelector(".agents-others-toggle")!.click(); await again.flush();
  assert.deepEqual(agentRowsOf(again).map(r => r.dataset.agent), ["eng", "fresh-review"], "closed again");
  assert.equal(storage.get("board-agents-others"), "closed");
});

test("agent list: with nothing running the list shows its heading and the fold only, and without sessions it hides", async () => {
  const p = await page(agentSnapshot({ idle: [{ item: "area", at: minutesAgo(8) }] }), [], null, undefined, { now: () => NOW });
  const host = p.roots.get("agents")!;
  assert.equal(host.hidden, false);
  assert.equal(host.querySelector(".agents-toggle")!.innerHTML, "▾ 代理 0");
  assert.equal(agentRowsOf(p).length, 0);
  assert.equal(host.querySelector(".agents-others-toggle")!.innerHTML, "▸ 其他 1 个");
  const none = await page(agentSnapshot({}), [], null, undefined, { now: () => NOW });
  assert.equal(none.roots.get("agents")!.hidden, true);
  assert.equal(none.roots.get("agents")!.querySelector(".agents-others-toggle"), null);
});

test("agent list: a reviewer with a dispatch record and no write is listed by its start, with no state word", async () => {
  const s = agentSnapshot({});
  s.items.child!.dispatches = [{ agentId: "r1", agent: "child-review", role: "审查", level: 3, model: "Opus", started: minutesAgo(12) }];
  const p = await page(s, [], null, undefined, { now: () => NOW });
  const [row] = agentRowsOf(p);
  assert.equal(row!.dataset.agent, "child-review");
  assert.equal(row!.querySelector(".diffchip")!.innerHTML, "审查 3 级");
  assert.equal(row!.querySelector(".agent-state"), null);
  assert.equal(row!.querySelector(".agent-ago")!.innerHTML, "12 分钟前起");
  assert.deepEqual(row!.querySelectorAll(".agitem-title").map(t => t.innerHTML), ["Child"]);
});

test("agent list: the architect's session, sessions out of the window and ended dispatches are not listed; with none the list hides", async () => {
  const s = agentSnapshot({ "架构师": [{ item: "child", at: minutesAgo(1) }], old: [{ item: "child", at: minutesAgo(400) }], done: [{ item: "child", at: minutesAgo(40) }] });
  s.items.child!.dispatches = [{ agentId: "d1", agent: "done", role: "工程师", level: 2, model: "Sonnet", started: minutesAgo(100), finish: { ended: minutesAgo(30), result: "一次通过", reports: 0, kickbacks: 0, signals: [], usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, cost: 0 } }];
  const p = await page(s, [], null, undefined, { now: () => NOW });
  assert.equal(agentRowsOf(p).length, 0);
  assert.equal(p.roots.get("agents")!.hidden, true);
});

test("agent list: 在树中 reveals the item in the tree and remembers the place, and the title selects it", async () => {
  const p = await page(agentSnapshot({ eng: [{ item: "child", at: minutesAgo(2) }] }), [], null, undefined, { now: () => NOW });
  const cell = agentRowsOf(p)[0]!.querySelector(".agitem")!;
  assert.equal(p.all().find(e => e.id === "backbtn")?.hidden ?? true, true);
  p.roots.get("page-left")!.scrollTop = 120;
  await cell.querySelector(".agitem-tree")!.click(); await p.flush();
  assert.equal(p.all().find(e => e.id === "backbtn")!.hidden, false, "the jump is remembered");
  assert.ok(rowOf(p, "child"), "the tree row for the item exists, parent unfolded");
  assert.ok(p.all().find(e => e.id === "detail-it-child"), "the item is selected, so its detail shows");
  assert.ok(!p.roots.get("agents")!.querySelectorAll(".agitem").some(e => e.id.startsWith("it-")), "the list has no element with a tree id");
  p.roots.get("page-left")!.scrollTop = 900;
  await p.all().find(e => e.id === "backbtn")!.click(); await p.flush();
  assert.equal(p.all().find(e => e.id === "backbtn")!.hidden, true, "Back returns");
  assert.equal(p.scrollY, 120, "Back returns to where the list was scrolled, not to an item below it");
  // The title selects the other item without moving the page.
  const area = agentRowsOf(p)[0]!;
  await area.querySelector(".agitem-title")!.click(); await p.flush();
  assert.ok(p.all().find(e => e.id === "detail-it-child"));
});

test("agent list: the heading folds the list and the choice is kept", async () => {
  const s = agentSnapshot({ eng: [{ item: "child", at: minutesAgo(2) }] }), storage = new Map<string, string>();
  const p = await page(s, [], null, undefined, { now: () => NOW, storage });
  await p.roots.get("agents")!.querySelector(".agents-toggle")!.click(); await p.flush();
  assert.equal(agentRowsOf(p).length, 0, "folded");
  assert.equal(p.roots.get("agents")!.querySelector(".agents-toggle")!.innerHTML, "▸ 代理 1");
  assert.equal(storage.get("board-agents"), "closed");
  const again = await page(s, [], null, undefined, { now: () => NOW, storage });
  assert.equal(agentRowsOf(again).length, 0, "a reload keeps it folded");
  await again.roots.get("agents")!.querySelector(".agents-toggle")!.click(); await again.flush();
  assert.equal(agentRowsOf(again).length, 1);
});

test("agent list: a write by a session shows its row within two seconds, and a minute passing updates the times", async () => {
  let now = NOW;
  const s = agentSnapshot({ eng: [{ item: "child", at: minutesAgo(2) }] });
  const p = await page(s, [], null, undefined, { now: () => now });
  assert.equal(agentRowsOf(p).length, 1);
  const began = performance.now();
  p.emit("b".repeat(40), [{ kind: "item", id: "area", after: { ...s.items.area!, rev: 2 } }], { from: s.head, write: minutesAgo(0), items: {}, pauses: {}, sessions: {}, agents: { newcomer: [{ item: "child", at: minutesAgo(0) }] } });
  await p.flush();
  assert.ok(performance.now() - began < 2000, "the row is there well inside the two-second target");
  assert.deepEqual(agentRowsOf(p).map(r => r.dataset.agent), ["newcomer", "eng"], "the writer is newest");
  assert.equal(p.roots.get("agents")!.querySelector(".agents-toggle")!.innerHTML, "▾ 代理 2");
  now += 3 * 60_000;
  for (const tick of p.intervals) tick();
  await p.flush();
  assert.equal(agentRowsOf(p)[1]!.querySelector(".agent-ago")!.innerHTML, "5 分钟前写过", "the minute timer repaints the time");
});

test("agent list: a write that changes the list changes it once, and one elsewhere leaves it untouched", async () => {
  const s = agentSnapshot({ eng: [{ item: "child", at: minutesAgo(2) }] });
  const p = await page(s, [], null, undefined, { now: () => NOW });
  const before = agentRowsOf(p)[0]!;
  p.emit("c".repeat(40), [{ kind: "item", id: "area", after: { ...s.items.area!, rev: 2, updated: at } }]);
  await p.flush();
  assert.equal(agentRowsOf(p)[0], before, "the row element is kept when nothing it shows changed");
});

test("agent list: a cell unfolds its sub-items in place, they unfold further, and the list folds apart from the tree", async () => {
  // Both sessions touched grand too, which has a step in progress: the rows are running, so they are unfolded.
  const s = agentSnapshot({ eng: [{ item: "area", at: minutesAgo(2) }, { item: "grand", at: minutesAgo(20) }], other: [{ item: "area", at: minutesAgo(3) }, { item: "grand", at: minutesAgo(21) }] });
  s.items.grand = { title: "Grand", parent: "child", status: "wip", priority: "P1", updated: at, rev: 1, deps: [], links: [], log: [] };
  const storage = new Map<string, string>();
  const p = await page(s, [], null, undefined, { now: () => NOW, storage });
  const cell = (name: string) => agentRowsOf(p).find(r => r.dataset.agent === name)!.querySelector(".agitem")!;
  const caret = cell("eng").querySelector(".agitem-caret")!;
  assert.deepEqual([caret.disabled, caret.innerHTML], [false, "▸"], "an item with sub-items has an arrow");
  assert.equal(cell("eng").querySelector(".agitem-time") !== null, true);
  await caret.click(); await p.flush();
  const sub = p.all().find(e => e.id === "ag-eng--it-child")!;
  assert.ok(sub, "the sub-item is an item row under the cell, with the row's prefix");
  assert.ok(sub.classList.contains("item"), "and it is the tree's item row, so it unfolds the same way");
  assert.equal(cell("eng").querySelector(".agitem-caret")!.innerHTML, "▾");
  assert.equal(cell("other").querySelectorAll(".item").length, 0, "the same item in another session's row stays folded");
  await sub.querySelector(".caret")!.click(); await p.flush();
  assert.ok(p.all().find(e => e.id === "ag-eng--it-grand"), "sub-items unfold further");
  assert.equal(p.all().some(e => e.id === "it-child"), false, "the tree's own area is still folded: no tree row for the sub-item yet");
  assert.notEqual(rowOf(p, "area").querySelector(".caret")!.attributes["aria-expanded"], "true");
  // Unfolding the tree's row leaves the list as it was, and both rows exist side by side.
  await rowOf(p, "area").querySelector(".caret")!.click(); await p.flush();
  assert.ok(p.all().find(e => e.id === "it-child"), "the tree row exists once unfolded there");
  assert.ok(p.all().find(e => e.id === "ag-eng--it-grand"), "the list kept its folds");
  assert.deepEqual(p.all().filter(e => e.id === "it-child" || e.id === "ag-eng--it-child").map(e => e.id).sort(), ["ag-eng--it-child", "it-child"]);
  // A click on the list's row selects the item, and the selection mark shows in the tree only.
  await sub.querySelector(".item-head")!.click(); await p.flush();
  assert.ok(p.all().find(e => e.id === "detail-it-child"), "selected: its detail shows");
  assert.ok(rowOf(p, "child").classList.contains("selected"), "the tree's row is marked");
  assert.ok(!p.all().find(e => e.id === "ag-eng--it-child")!.classList.contains("selected"), "the list's row is not");
  // Drawn afresh (the list folded and unfolded), the list's row is still not marked.
  for (let k = 0; k < 2; k++) { await p.roots.get("agents")!.querySelector(".agents-toggle")!.click(); await p.flush(); }
  assert.ok(!p.all().find(e => e.id === "ag-eng--it-child")!.classList.contains("selected"), "nor when the list is drawn afresh");
  // The folds are kept across a reload, and 全部折叠 folds the list too.
  const again = await page(s, [], null, undefined, { now: () => NOW, storage });
  assert.ok(again.all().find(e => e.id === "ag-eng--it-grand"), "unfolded cells stay unfolded after a reload");
  const fold = again.all().find(e => e.tagName === "BUTTON" && e.innerHTML === "全部折叠")!;
  await fold.click(); await again.flush();
  assert.equal(again.all().some(e => e.id.startsWith("ag-") && e.classList.contains("item")), false, "全部折叠 folds the list");
});

test("agent list: with nothing selected, a key command finds the tree's first row, not an unfolded row of the list", async () => {
  const s = agentSnapshot({ eng: [{ item: "area", at: minutesAgo(2) }, { item: "child", at: minutesAgo(20) }] });
  const storage = new Map<string, string>([["board-agent-open", JSON.stringify({ "ag-eng--area": true })]]);
  const p = await page(s, [], null, undefined, { now: () => NOW, storage });
  const unfolded = p.all().find(e => e.id === "ag-eng--it-child");
  assert.ok(unfolded, "the list shows an unfolded item row, before the tree in page order");
  assert.equal(p.all().some(e => e.id.startsWith("detail-it-")), false, "nothing is selected");
  p.key("c"); await p.flush();
  assert.ok(p.all().some(e => e.id === "detail-it-area"), "c opened a comment on the tree's first row (and selected it), not on a name cut from the list's element id");
});

test("agent list: a cell and the item row an unfolded parent draws for the same item have different ids, and no two names share a prefix", async () => {
  const s = agentSnapshot({ eng: [{ item: "area", at: minutesAgo(2) }, { item: "child", at: minutesAgo(3) }], "x y": [{ item: "area", at: minutesAgo(4) }, { item: "child", at: minutesAgo(21) }], "x_20y": [{ item: "area", at: minutesAgo(5) }, { item: "child", at: minutesAgo(22) }] });
  const storage = new Map<string, string>([["board-agent-open", JSON.stringify({ "ag-eng--area": true })]]);
  const p = await page(s, [], null, undefined, { now: () => NOW, storage });
  const ids = descendants(p.roots.get("agents")!).map(e => e.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, "every id in the list is unique: " + ids.join(", "));
  assert.ok(ids.includes("ag-eng--cell-child") && ids.includes("ag-eng--it-child"), "both the child's own cell and the item row under its parent's cell");
  assert.equal(agentRowsOf(p).length, 3);
});

test("agent list: an unfolded sub-item row repaints at once when what it shows changes, not at the next minute", async () => {
  const s = agentSnapshot({ eng: [{ item: "area", at: minutesAgo(2) }, { item: "child", at: minutesAgo(20) }] });
  const storage = new Map<string, string>([["board-agent-open", JSON.stringify({ "ag-eng--area": true })]]);
  const p = await page(s, [], null, undefined, { now: () => NOW, storage });
  const sub = () => p.all().find(e => e.id === "ag-eng--it-child")!;
  assert.equal(sub().querySelector(".tagchip"), null);
  p.emit("d".repeat(40), [{ kind: "item", id: "child", after: { ...s.items.child!, tags: ["看板"], rev: 2 } }]);
  await p.flush();
  assert.ok(sub().querySelector(".tagchip"), "the new tag shows in the list's row with the change");
});

// The page replaces itself when the server announces another version of it (docs/design.md, section 7, Updating the page).
const updateLine = (p: Awaited<ReturnType<typeof page>>) => { const line = p.roots.get("update-banner")!; return line.hidden || !line.textContent ? null : line.textContent; };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("a page told another version reloads itself, and the next page scrolls both panes back to where they were", async () => {
  const session = new Map<string, string>();
  const first = await page(nativeSnapshot(), [], null, undefined, { version: "a1", session });
  first.roots.get("page-left")!.scrollTop = 420; first.roots.get("item-detail")!.scrollTop = 130;
  first.announce("b2");
  assert.equal(first.reloads, 1);
  assert.equal(updateLine(first), null, "a page that is not writing reloads without a banner");
  assert.deepEqual([JSON.parse(session.get("board-scroll")!).list, JSON.parse(session.get("board-scroll")!).detail], [420, 130]);
  const second = await page(nativeSnapshot(), [], null, undefined, { version: "b2", session });
  assert.equal(second.scrollY, 420);
  assert.equal(second.roots.get("item-detail")!.scrollTop, 130);
  assert.equal(session.has("board-scroll"), false, "the position is used once");
  // A position left by a reload long ago is not this page's to restore.
  session.set("board-scroll", JSON.stringify({ list: 420, detail: 130, at: Date.now() - 60_000 }));
  const later = await page(nativeSnapshot(), [], null, undefined, { version: "b2", session });
  assert.equal(later.scrollY, 0);
});

test("a page told its own version stays, and a page that does not know its version ignores the announcement", async () => {
  const same = await page(nativeSnapshot(), [], null, undefined, { version: "a1" });
  same.announce("a1");
  assert.equal(same.reloads, 0);
  assert.equal(updateLine(same), null);
  for (const version of [undefined, ""]) {
    const unknown = await page(nativeSnapshot(), [], null, undefined, version === undefined ? {} : { version });
    unknown.announce("b2");
    assert.equal(unknown.reloads, 0, `a page served with version ${JSON.stringify(version)}`);
  }
});

test("while a comment box is open the page shows the banner and waits; once the comment is saved it reloads, and the comment is kept", async () => {
  const { p, ta, type } = await composer(linked(), { version: "a1" });
  p.announce("b2");
  assert.equal(p.reloads, 0);
  assert.equal(updateLine(p), WAITING);
  await type("写到一半的评论");
  await sleep(RECHECK_MS + 200);
  assert.equal(p.reloads, 0, "the box is still open");
  p.key("Enter", ta); await settle();
  assert.deepEqual(noteCalls(p).map(c => c.body), [{ target: "it:child", text: "写到一半的评论", kind: "comment" }], "the comment was saved on the server before the page went");
  await sleep(RECHECK_MS + 200);
  assert.equal(p.reloads, 1);
});

test("a comment typed and not saved holds the reload after the box is closed with Esc, until it is saved", async () => {
  const { p, ta, type } = await composer(linked(), { version: "a1" });
  await type("还没存的话");
  p.key("Escape", ta); await p.flush();
  assert.ok(!p.all().some(e => e.id === "ed-it_child"), "Esc closed the box and kept the text");
  p.announce("b2");
  assert.equal(updateLine(p), WAITING);
  await sleep(RECHECK_MS + 200);
  assert.equal(p.reloads, 0);
  p.key("c"); await p.flush();
  const again = p.all().find(e => e.id === "ed-it_child")!;
  assert.equal(again.value, "还没存的话");
  p.key("Enter", again); await settle();
  await sleep(RECHECK_MS + 200);
  assert.equal(p.reloads, 1);
});

test("a box opened and closed with nothing typed does not hold the reload", async () => {
  const { p, ta } = await composer(linked(), { version: "a1" });
  p.key("Escape", ta); await p.flush();
  p.announce("b2");
  assert.equal(p.reloads, 1);
});

test("a send in flight holds the reload until the server has answered it", async () => {
  const s = snapshot(); s.notes.n = { target: "it:child", kind: "comment", text: "draft", at, state: "draft", rev: 1 };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const p = await page(s, [], null, undefined, { version: "a1", response: path => path === "/api/send" ? gate.then(() => reply({ sent: [{ project: "Halo-wf" }] })) : undefined });
  const clicked = p.roots.get("send-all")!.click();
  await settle();
  p.announce("b2");
  assert.equal(p.reloads, 0);
  assert.equal(updateLine(p), WAITING);
  release(); await clicked; await settle();
  await sleep(RECHECK_MS + 200);
  assert.equal(p.reloads, 1);
});

test("a reload that left the page on another version is not repeated at once: the banner says to reload by hand", async () => {
  const session = new Map<string, string>([["board-reload", JSON.stringify({ version: "b2", at: Date.now() - 1000 })]]);
  const p = await page(nativeSnapshot(), [], null, undefined, { version: "a1", session });
  p.announce("b2");
  assert.equal(p.reloads, 0);
  assert.equal(updateLine(p), STUCK);
});

test("a draft being saved holds the reload too, though nothing is typed or sent", async () => {
  const held = deferred<FakeResponse>();
  const p = await page(snapshot(), [], null, undefined, { version: "a1", response: path => path === "/api/draft" ? held.promise : undefined });
  await expand(p); p.key("e"); await settle();
  assert.equal(p.calls.filter(c => c.path === "/api/draft").length, 1, "the explain request is on its way");
  p.announce("b2");
  assert.equal(p.reloads, 0);
  held.resolve(reply({ note: { id: "explain-draft", doc: { target: "it:child", kind: "explain", text: "请求：详细解释", at, state: "draft", rev: 1 } }, deleted: [], commit: "e".repeat(40) }));
  await p.flush();
  await sleep(RECHECK_MS + 200);
  assert.equal(p.reloads, 1);
});

test("a saved draft being edited holds the reload until the edit is saved", async () => {
  const s = snapshot(); s.notes.d = { target: "it:child", kind: "comment", text: "Original", at, state: "draft", rev: 1 };
  const p = await page(s, [], null, undefined, { version: "a1", notesOpen: { "it:child": true } }); await expand(p);
  await noteButton(p, "d", "编辑")!.click();
  p.announce("b2");
  assert.equal(updateLine(p), WAITING);
  await sleep(RECHECK_MS + 200);
  assert.equal(p.reloads, 0);
  typeDraftEdit(p, "d", "Edited"); await noteButton(p, "d", "保存")!.click(); await p.flush();
  await sleep(RECHECK_MS + 200);
  assert.equal(p.reloads, 1);
});
