import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import type { Snapshot } from "../src/model.ts";

// Execute the actual bundle against a tiny synthetic DOM. No browser or listener
// is needed: these regressions concern event handlers and text, not layout.
class Element {
  tagName: string;
  id = ""; className = ""; textContent = ""; private html = ""; hidden = false;
  disabled = false; type = ""; title = ""; tabIndex = 0;
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
  setAttribute() {}
  addEventListener(kind: string, fn: (event: unknown) => unknown) { this.handlers.set(kind, [...this.handlers.get(kind) ?? [], fn]); }
  async click() { for (const fn of this.handlers.get("click") ?? []) await fn({ stopPropagation() {}, preventDefault() {} }); }
  focus() {} blur() {} scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, width: 900, height: 100, top: 50, bottom: 150 }; }
  matches(selector: string) { return selector.split(/,\s*/).some(s => s.startsWith(".") && this.className.split(" ").includes(s.slice(1))); }
  closest(selector: string): Element | null { return this.matches(selector.replace("#areas ", "")) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelector(selector: string) { if (selector === ".t") { const e = new Element("span"); e.className = "t"; return this.appendChild(e); } return null; }
  get innerHTML() { return this.html; }
  set innerHTML(value: string) { this.html = value; this.children = []; }
  get firstChild(): Element | null { return this.children[0] ?? null; }
}
async function page(snapshot: Snapshot, unread: unknown[], before: unknown = null) {
  const code = (await build({ entryPoints: ["web/app.ts"], bundle: true, format: "iife", write: false, target: "es2022" })).outputFiles[0]!.text;
  const roots = new Map<string, Element>();
  for (const id of ["goal", "goal-title", "eyebrow", "meta", "summary", "nav", "areas", "cards", "decisions", "crumbs", "sendbox", "send-all", "send-note", "to-top", "server-banner"]) { const e = new Element(id === "send-all" ? "button" : "div"); e.id = id; roots.set(id,e); }
  const body = new Element("body"), wrap = new Element("div"), header = new Element("header");
  const all = (): Element[] => { const out: Element[] = []; function walk(e: Element) { out.push(e); e.children.forEach(walk); } for (const e of [...roots.values(),body]) walk(e); return out; };
  const calls: Array<{path: string; body?: unknown}> = [];
  const listeners = new Map<string, (event: unknown) => unknown>();
  const document = {
    body, activeElement: null, documentElement: { scrollHeight: 1000 },
    getElementById: (id: string) => all().find(e => e.id === id) ?? null,
    createElement: (tag: string) => new Element(tag),
    querySelector: (selector: string) => selector === ".wrap" ? wrap : selector === "header.top" ? header : null,
    querySelectorAll: () => [], elementFromPoint: () => null,
    addEventListener: (kind: string, fn: (event: unknown) => unknown) => listeners.set(kind, fn),
  };
  class EventSource { addEventListener() {} close() {} }
  const context = {
    document, HTMLElement: Element, EventSource, console, CSS: { escape: (s: string) => s },
    innerHeight: 1000, scrollY: 0, localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: true }), getComputedStyle: () => ({ scrollMarginTop: "0" }),
    performance, setTimeout, clearTimeout, requestAnimationFrame() {}, addEventListener() {},
    window: { scrollY: 0, addEventListener() {}, scrollBy() {}, scrollTo() {} },
    fetch: async (path: string, options?: {body?: string}) => {
      const input = options?.body ? JSON.parse(options.body) : undefined; calls.push({path,body:input});
      let value: unknown;
      if (path === "/api/snapshot") value = snapshot;
      else if (path === "/api/unread") value = { steps: unread };
      else if (path.startsWith("/api/step?")) value = { before, after: {}, diff: "+ synthetic changed text" };
      else if (path === "/api/send") value = { sent: [{agent: "Session A"}, {agent: "Session A"}, {agent: "Session B"}] };
      else if (path === "/api/read") { unread = []; value = { ok: true }; }
      else throw new Error("Unexpected page request " + path);
      return { ok: true, status: 200, json: async () => structuredClone(value) };
    },
  };
  runInNewContext(code, context);
  await setImmediate(); await setImmediate();
  return { roots, all, calls, key: (key: string) => listeners.get("keydown")!({key,target:new Element("div"),preventDefault(){}}) };
}
const at = "2026-10-11T01:02:03Z";
function snapshot(): Snapshot {
  return { board: { title: "Synthetic title", eyebrow: "Synthetic eyebrow" }, head: "a".repeat(40), owner: { archived: {} }, decisions: {}, notes: {}, items: {
    area: { title: "Parent", group: "Project", agent: "Session A", updated: at, rev: 1, deps: [{id:"child",why:"needs child"}], links: [], log: [] },
    child: { title: "Child", parent: "area", status: "wip", priority: "P1", updated: at, rev: 1, deps: [], links: [], log: [] },
  } };
}
test("bundled page renders board metadata and the recorded-send count by session", async () => {
  const s = snapshot(); s.notes.n = { target: "it:child", kind: "comment", text: "draft", at, state: "draft", rev: 1 };
  const p = await page(s, []);
  assert.equal(p.roots.get("goal-title")!.textContent, "Synthetic title");
  assert.equal(p.roots.get("eyebrow")!.textContent, "Synthetic eyebrow");
  await p.roots.get("send-all")!.click();
  assert.equal(p.roots.get("send-note")!.textContent, "已发出 3 条：Session A×2 … Session B×1");
});
test("filtered parent navigation opens its body, shows the step diff and reads only through a shown commit", async () => {
  const id = "b".repeat(40);
  const p = await page(snapshot(), [{ id, commits: [id], author: "Session A", at, docs: [{kind:"item",id:"area",summary:"title changed"}] }]);
  p.key("r"); assert.ok(!p.calls.some(c => c.path === "/api/read"));
  // Enable the child's status filter; its parent is now automatically open as context.
  const filter = p.all().find(e => e.tagName === "BUTTON" && e.innerHTML === "进行中 2") ?? p.all().find(e => e.tagName === "BUTTON" && e.innerHTML.startsWith("进行中 "));
  assert.ok(filter); await filter.click();
  p.key("n"); await setImmediate();
  const step = p.all().find(e => e.id === "step:" + id); assert.ok(step, "selected parent's body must contain its step");
  assert.ok(step.children.some(e => e.tagName === "PRE" && e.innerHTML.includes("synthetic changed text")));
  const read = step.children.find(e => e.tagName === "BUTTON"); assert.ok(read); await read.click();
  await setImmediate();
  assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body), [{through:id}]);
});

test("unread logs expand with two preceding entries, highlight duplicate appends and stay open after reading", async () => {
  const s = snapshot(), id = "c".repeat(40);
  s.items.area!.deps = [];
  const old = [{at,by:"Session A",text:"duplicate"},{at,by:"Session A",text:"old two"},{at,by:"Session A",text:"old three"}];
  s.items.area!.log = [...old,{...old[0]!},{at,by:"Session A",text:"new two"},{at,by:"Session A",text:"new three"}];
  const p = await page(s,[{id,commits:[id],author:"Session A",at,docs:[{kind:"item",id:"area",summary:"+3 log"}]}],{...s.items.area,log:old});
  p.key("n"); await setImmediate();
  const rows = () => p.all().filter(e => e.id.startsWith("log-area-"));
  assert.equal(rows().length,5); assert.equal(rows().filter(e => e.className.includes("fresh")).length,3);
  const step = p.all().find(e => e.id === "step:" + id)!;
  await step.children.find(e => e.tagName === "BUTTON")!.click(); await setImmediate();
  assert.equal(rows().length,5); assert.equal(rows().filter(e => e.className.includes("fresh")).length,0);
});
