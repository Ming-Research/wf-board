import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import { rules } from "../src/rules.ts";
import type { Snapshot, Decision, Note } from "../src/model.ts";

// Execute the actual bundle against a tiny synthetic DOM. No browser or listener
// is needed: these regressions concern event handlers and text, not layout.
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
  focus() {} blur() {} scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, width: 900, height: 100, top: 50, bottom: 150 }; }
  matches(selector: string) { return selector.split(/,\s*/).some(s => s.startsWith(".") && this.className.split(" ").includes(s.slice(1))); }
  closest(selector: string): Element | null { return this.matches(selector.replace("#areas ", "")) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelector(selector: string) { if (selector === ".t") { const e = new Element("span"); e.className = "t"; return this.appendChild(e); } return null; }
  get innerHTML() { return this.html; }
  set innerHTML(value: string) { this.html = value; this.children = []; }
  get firstChild(): Element | null { return this.children[0] ?? null; }
  get firstElementChild(): Element | null { return this.firstChild; }
}
type LineGroup = { kind: "same" | "added" | "removed"; lines: string[] };
let bundle: Promise<string> | undefined;
async function page(snapshot: Snapshot, unread: unknown[], before: unknown = null, after?: unknown) {
  const code = await (bundle ??= build({ entryPoints: ["web/app.ts"], bundle: true, format: "iife", globalName: "BoardPage", write: false, target: "es2022" }).then(result => result.outputFiles[0]!.text));
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
    BoardPage: undefined as unknown as { lineDiff: (a: string, b: string) => LineGroup[] },
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
      else if (path.startsWith("/api/step?")) {
        const params = new URLSearchParams(path.split("?")[1]), id = params.get("doc")!;
        const collection = params.get("kind") === "item" ? snapshot.items : params.get("kind") === "decision" ? snapshot.decisions : snapshot.notes;
        value = { before, after: after === undefined ? collection[id] ?? null : after, diff: "+ synthetic changed text" };
      }
      else if (path === "/api/send") value = { sent: [{agents: ["Session A","Session B"]}, {agents: ["Session A"]}, {agents: []}] };
      else if (path === "/api/requests") value = {id:"req-new"};
      else if (path === "/api/read") { unread = []; value = { ok: true }; }
      else throw new Error("Unexpected page request " + path);
      return { ok: true, status: 200, json: async () => structuredClone(value) };
    },
  };
  runInNewContext(code, context);
  await setImmediate(); await setImmediate();
  return { roots, all, calls,
    lineDiff: (a: string, b: string): LineGroup[] => JSON.parse(JSON.stringify(context.BoardPage.lineDiff(a,b))),
    key: (key: string) => listeners.get("keydown")!({key,target:new Element("div"),preventDefault(){}}) };
}
const at = "2026-10-11T01:02:03Z";
function snapshot(): Snapshot {
  return { board: { title: "Synthetic title", projects: [{name:"Project",agents:["Session A","Session B"]}], eyebrow: "Synthetic eyebrow" }, head: "a".repeat(40), owner: { archived: {} }, decisions: {}, notes: {}, items: {
    area: { title: "Parent", group: "Project", updated: at, rev: 1, deps: [{id:"child",why:"needs child"}], links: [], log: [] },
    child: { title: "Child", parent: "area", status: "wip", priority: "P1", updated: at, rev: 1, deps: [], links: [], log: [] },
  } };
}
test("bundled page renders board metadata and the recorded-send count by session", async () => {
  const s = snapshot(); s.notes.n = { target: "it:child", kind: "comment", text: "draft", at, state: "draft", rev: 1 };
  const p = await page(s, []);
  assert.equal(p.roots.get("goal-title")!.textContent, "Synthetic title");
  assert.equal(p.roots.get("eyebrow")!.textContent, "Synthetic eyebrow");
  await p.roots.get("send-all")!.click();
  assert.equal(p.roots.get("send-note")!.textContent, "已发出 3 条：Session A×2 · Session B×1 · 未指定负责会话×1");
});
test("filtered parent navigation opens its body, shows the step diff and reads only through a shown commit", async () => {
  const id = "b".repeat(40);
  const p = await page(snapshot(), [{ id, commits: [id], author: "Session A", at, docs: [{kind:"item",id:"area",summary:"title changed"}] }]);
  p.key("r"); assert.ok(!p.calls.some(c => c.path === "/api/read"));
  // Enable the child's status filter; its parent is now automatically open as context.
  const filter = p.all().find(e => e.tagName === "BUTTON" && e.innerHTML === "进行中 2") ?? p.all().find(e => e.tagName === "BUTTON" && e.innerHTML.startsWith("进行中 "));
  assert.ok(filter); await filter.click();
  p.key("n"); await setImmediate();
  const step = p.all().find(e => e.id.startsWith("step:" + id + "|")); assert.ok(step, "selected parent's body must contain its step");
  // The change shows field by field; the raw git diff is not shown.
  assert.ok(!descendants(step).some(e => e.innerHTML.includes("synthetic changed text") || e.innerHTML.includes("原始 diff")));
  assert.match(markup(step), /Parent · title changed/);
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
  const step = p.all().find(e => e.id.startsWith("step:" + id + "|"))!;
  await step.children.find(e => e.tagName === "BUTTON")!.click(); await setImmediate();
  assert.equal(rows().length,5); assert.equal(rows().filter(e => e.className.includes("fresh")).length,0);
});

function descendants(root: Element): Element[] { return [root,...root.children.flatMap(descendants)]; }
function markup(root: Element): string { return descendants(root).map(e => e.innerHTML + e.textContent).join("\n"); }
async function changeView(s: Snapshot, kind: "item" | "decision" | "note", doc: string, before: unknown, after?: unknown) {
  const id = "d".repeat(40);
  const p = await page(s,[{id,commits:[id],author:"Session A",at,docs:[{kind,id:doc,summary:"synthetic change"}]}],before,after);
  p.key("n"); await setImmediate(); await setImmediate();
  const step = p.all().find(e => e.id.startsWith("step:" + id + "|")); assert.ok(step,"the selected unread step must render");
  const view = step.children.find(e => e.className === "document-change"); assert.ok(view,"the step must render a document change view");
  assert.equal(step.children.filter(e => e.tagName === "PRE").length,0,"raw YAML must not be the default view");
  return {p,step,view};
}

test("LCS line diff separates insertions, deletions and replacements and preserves matched lines", async t => {
  const p = await page(snapshot(),[]);
  await t.test("insertion", () => assert.deepEqual(p.lineDiff("首行\n末行","首行\n新增\n末行"),[
    {kind:"same",lines:["首行"]},{kind:"added",lines:["新增"]},{kind:"same",lines:["末行"]},
  ]));
  await t.test("deletion", () => assert.deepEqual(p.lineDiff("首行\n移除\n末行","首行\n末行"),[
    {kind:"same",lines:["首行"]},{kind:"removed",lines:["移除"]},{kind:"same",lines:["末行"]},
  ]));
  await t.test("replacement", () => assert.deepEqual(p.lineDiff("首行\n旧一\n旧二\n末行","首行\n新一\n新二\n末行"),[
    {kind:"same",lines:["首行"]},{kind:"removed",lines:["旧一","旧二"]},{kind:"added",lines:["新一","新二"]},{kind:"same",lines:["末行"]},
  ]));
  // A positional comparison would mark the repeated lines as changes; LCS retains both.
  await t.test("repeated lines", () => assert.deepEqual(p.lineDiff("重复\n删除\n重复","重复\n重复\n插入"),[
    {kind:"same",lines:["重复"]},{kind:"removed",lines:["删除"]},{kind:"same",lines:["重复"]},{kind:"added",lines:["插入"]},
  ]));
  await t.test("empty endpoints", () => {
    assert.deepEqual(p.lineDiff("","甲\n乙"),[{kind:"added",lines:["甲","乙"]}]);
    assert.deepEqual(p.lineDiff("甲\n乙",""),[{kind:"removed",lines:["甲","乙"]}]);
    assert.deepEqual(p.lineDiff("",""),[]);
  });
});

test("head diff collapses unchanged runs longer than three lines without dropping their content", async () => {
  const s = snapshot(), before = {...s.items.child!,head:"甲\n乙\n丙\n丁\n旧\n一\n二\n三\n终旧"};
  s.items.child!.head = "甲\n乙\n丙\n丁\n新\n一\n二\n三\n终新";
  const {view} = await changeView(s,"item","child",before);
  const folds = descendants(view).filter(e => e.className === "change-context");
  assert.equal(folds.length,1); assert.equal(folds[0]!.tagName,"DETAILS");
  assert.ok(!("open" in folds[0]!.attributes));
  assert.equal(folds[0]!.children[0]!.innerHTML,"… 省略 4 行");
  assert.equal(folds[0]!.children[1]!.innerHTML,"<p>甲<br>乙<br>丙<br>丁</p>");
  const visibleContext = descendants(view).find(e => e.className === "rich change-same" && e.innerHTML === "<p>一<br>二<br>三</p>");
  assert.ok(visibleContext); assert.equal(visibleContext.parentElement!.className,"head-changes");
});

test("new item renders its head and every log with the existing rich block markup", async () => {
  const s = snapshot();
  s.items.child!.head = "**目标**：读中文\n\n- **保留**列表\n\n```\n<unsafe>\n```";
  s.items.child!.log = [{at,by:"中文会话",text:"**完成**：正文\n\n1. 验证"},{at,text:"第二条"}];
  const {view} = await changeView(s,"item","child",null);
  assert.equal(view.children[0]!.innerHTML,"新条目");
  const body = view.children[1]!; assert.equal(body.className,"change-added");
  const head = body.children[0]!;
  assert.equal(head.className,"rich");
  assert.equal(head.innerHTML,'<div class="sub">目标</div><p>读中文</p><ul><li><strong>保留</strong>列表</li></ul><pre class="code"><code>&lt;unsafe&gt;</code></pre>');
  const logs = descendants(body).filter(e => e.className === "log-entry fresh");
  assert.equal(logs.length,2);
  assert.equal(logs[0]!.children[0]!.innerHTML,"2026-10-11 01:02 · 中文会话");
  assert.equal(logs[0]!.children[1]!.innerHTML,'<div class="sub">完成</div><p>正文</p><ol><li>验证</li></ol>');
  assert.equal(logs[1]!.children[0]!.innerHTML,"2026-10-11 01:02");
  assert.ok(!markup(body).includes("child"),"the body must not repeat the document id");
});

test("status change renders page labels and log additions match duplicate occurrences", async () => {
  const s = snapshot(), old = {at,by:"Session A",text:"重复进展"};
  const before = {...s.items.child!,status:"todo",log:[old,{at,text:"被移除"},{at,text:"保留进展"}]};
  s.items.child!.log = [old,{at,text:"保留进展"},{...old},{at,by:"Session B",text:"**新进展**"}];
  const {view} = await changeView(s,"item","child",before);
  assert.ok(view.children.some(e => e.innerHTML === "状态：TODO → WIP"));
  const logs = descendants(view).filter(e => e.className.split(" ").includes("log-entry"));
  const added = logs.filter(e => e.className.includes("change-added")), removed = logs.filter(e => e.className.includes("change-removed"));
  assert.equal(added.length,2); assert.equal(removed.length,1);
  assert.ok(added.every(e => e.className.includes("fresh")));
  assert.equal(added[0]!.children[1]!.innerHTML,"<p>重复进展</p>");
  assert.equal(added[1]!.children[0]!.innerHTML,"2026-10-11 01:02 · Session B");
  assert.equal(added[1]!.children[1]!.innerHTML,"<p><strong>新进展</strong></p>");
  assert.equal(removed[0]!.children[1]!.innerHTML,"<p>被移除</p>");
  assert.ok(!markup(view).includes("保留进展"),"unchanged logs must not clutter the change view");
});

test("head changes use rich line groups for removal, addition and dimmed context", async () => {
  const s = snapshot(), before = {...s.items.child!,head:"共同开头\n\n- **旧条款**\n\n共同结尾"};
  s.items.child!.head = "共同开头\n\n- **新条款**\n\n共同结尾";
  const {view} = await changeView(s,"item","child",before);
  const head = view.children.find(e => e.className === "head-changes"); assert.ok(head);
  assert.deepEqual(head.children.map(e => [e.className,e.innerHTML]),[
    ["rich change-same","<p>共同开头</p>"],
    ["rich change-removed","<ul><li><strong>旧条款</strong></li></ul>"],
    ["rich change-added","<ul><li><strong>新条款</strong></li></ul>"],
    ["rich change-same","<p>共同结尾</p>"],
  ]);
});

function card(): Decision {
  return {item:"child",question:"如何显示？",background:"**背景**：中文正文",options:[{key:"A",text:"保留 YAML"},{key:"B",text:"渲染正文",recommended:true}],status:"open",updated:at,rev:1};
}
test("card ruling includes the ruling and chosen option from the step, not the latest snapshot", async () => {
  const s = snapshot(), before = card();
  const after: Decision = {...before,status:"ruled",choice:"B",ruling:"同意渲染正文",ruledAt:at};
  s.decisions.q = {...after,choice:"A",ruling:"后续裁决"};
  const {view} = await changeView(s,"decision","q",before,after);
  assert.ok(view.children.some(e => e.innerHTML === "裁决：同意渲染正文"));
  assert.ok(view.children.some(e => e.innerHTML === "选择：B · 渲染正文"));
  assert.ok(view.children.some(e => e.innerHTML === "状态：待决定 → 已裁定"));
  assert.ok(!markup(view).includes("后续裁决"));
});

test("new card reuses the card renderer without active choices, duplicate ids or recursive steps", async () => {
  const s = snapshot(); s.decisions.q = card();
  const {step,view} = await changeView(s,"decision","q",null);
  assert.equal(view.children[0]!.innerHTML,"新决策卡");
  const rendered = view.children.find(e => e.tagName === "ARTICLE"); assert.ok(rendered); assert.equal(rendered.id,"");
  assert.ok(markup(rendered).includes('<div class="sub">背景</div><div class="sub">背景</div><p>中文正文</p>'));
  const opts = descendants(rendered).filter(e => e.className.startsWith("optbtn"));
  assert.equal(opts.length,2); assert.ok(opts.every(e => e.disabled));
  assert.ok(opts[1]!.className.includes("rec"));
  assert.equal(descendants(step).filter(e => e.className === "unread-step").length,1);
});

test("note reply renders the owner thread and reply with state changes", async () => {
  const s = snapshot(), before: Note = {target:"it:child",kind:"comment",text:"**我的问题**",at,state:"sent",rev:1};
  s.notes.n = {...before,state:"done",reply:"**回答**：已完成",repliedAt:at,repliedBy:"Session A"};
  const {view} = await changeView(s,"note","n",before);
  const thread = view.children.find(e => e.className.startsWith("note ")); assert.ok(thread);
  assert.ok(thread.className.includes("newbar"));
  assert.equal(thread.children.find(e => e.className === "txt")!.innerHTML,"<p><strong>我的问题</strong></p>");
  assert.equal(thread.children.find(e => e.className === "reply rich")!.innerHTML,'<div class="sub">Claude</div><div class="sub">回答</div><p>已完成</p>');
  assert.ok(view.children.some(e => e.innerHTML === "状态：已发送，等处理 → 已处理"));
});

test("dependencies and links show added and removed targets and explanations", async () => {
  const s = snapshot(); s.decisions.q = card();
  const before = {...s.items.child!,deps:[{id:"area",why:"旧原因"}],links:[{label:"旧链接",url:"https://example.com/old"}]};
  s.items.child!.deps = [{card:"q",why:"选择渲染方式"}];
  s.items.child!.links = [{label:"新链接",url:"https://example.com/new"}];
  const {view} = await changeView(s,"item","child",before);
  const removed = view.children.filter(e => e.className === "change-removed"), added = view.children.filter(e => e.className === "change-added");
  assert.ok(removed.some(e => e.innerHTML === '依赖移除：Parent<span class="why"> · 旧原因</span>'));
  assert.ok(added.some(e => e.innerHTML === '依赖新增：如何显示？<span class="why"> · 选择渲染方式</span>'));
  assert.ok(removed.some(e => markup(e).includes("旧链接") && markup(e).includes("https://example.com/old")));
  assert.ok(added.some(e => markup(e).includes("新链接") && markup(e).includes("https://example.com/new")));
});

test("deleted items preserve their head and logs, and absent endpoints remain readable", async () => {
  const s = snapshot(), before = {...s.items.child!,head:"已删除正文",log:[{at,text:"已删除进展"}]}; delete s.items.child;
  const {view} = await changeView(s,"item","child",before,null);
  assert.equal(view.children[0]!.innerHTML,"已删除条目");
  assert.equal(view.children[1]!.className,"change-removed");
  assert.ok(markup(view.children[1]!).includes("已删除正文")); assert.ok(markup(view.children[1]!).includes("已删除进展"));
  const absent = await changeView(s,"item","child",null,null);
  assert.equal(absent.view.innerHTML,"本步前后均无此文档");
});


test("R5 unscored confidence renders its text without an undefined score", async () => {
  const s = snapshot(); s.decisions.q = { ...card(), confidence: { reason: "Unscored evidence" } };
  const { view } = await changeView(s, "decision", "q", null);
  assert.ok(markup(view).includes("Unscored evidence"));
  assert.ok(!markup(view).includes("undefined/5"));
  const changed = await changeView(s, "decision", "q", { ...card(), confidence: { score: 3, reason: "Earlier" } });
  assert.ok(markup(changed.view).includes("3/5：Earlier → Unscored evidence"));
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

test("each document of a step is its own stop under its own item, archived items are not new, and only the step's last stop reads", async () => {
  const s = snapshot(), id = "e".repeat(40);
  s.items.other = { title: "Archived", parent: "area", status: "done", priority: "P2", updated: at, rev: 1, deps: [], links: [], log: [] };
  s.items.area!.deps.push({ id: "other", why: "needs other" });
  s.owner.archived = { other: "2026-10-11T05:00:00Z" };
  const p = await page(s, [{ id, commits: [id], author: "Session A", at, docs: [
    { kind: "item", id: "child", summary: "status todo→wip" }, { kind: "item", id: "other", summary: "status wip→done" }, { kind: "item", id: "area", summary: "+1 log" },
  ] }]);
  const shown = () => p.all().filter(e => e.id.startsWith("step:" + id + "|"));
  p.key("n"); await setImmediate();
  assert.deepEqual(shown().map(e => e.id), ["step:" + id + "|item|child"]);
  assert.equal(p.all().find(e => e.id === "it-child")!.children.some(c => descendants(c).includes(shown()[0]!)), true, "the stop renders inside its own item");
  const next = shown()[0]!.children.find(e => e.tagName === "BUTTON")!;
  assert.match(next.innerHTML, /下一处/); await next.click(); await setImmediate();
  assert.ok(!p.calls.some(c => c.path === "/api/read"), "a stop before the step's last does not move the cursor");
  // The archived item's stop is skipped: the next stop is the area's.
  assert.deepEqual(shown().map(e => e.id), ["step:" + id + "|item|area"]);
  const read = shown()[0]!.children.find(e => e.tagName === "BUTTON")!;
  assert.match(read.innerHTML, /已阅/); await read.click(); await setImmediate();
  assert.deepEqual(p.calls.filter(c => c.path === "/api/read").map(c => c.body), [{ through: id }]);
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

test("project page shows agents, inbox requests and an inline request form including empty projects", async () => {
  const s=snapshot(); s.board.projects.push({name:"Empty",agents:[]});
  s.items.incoming={title:"Request title",group:"Project",ask:{text:"Approve request"},request:{by:"Visitor",at},status:"todo",priority:"P0",head:"Request body",updated:at,rev:1,log:[{at,by:"Visitor",text:"Visitor 提出：Need feature"}],deps:[],links:[]};
  const p=await page(s,[]), headings=p.all().filter(e=>e.className==="group-head");
  assert.equal(headings.length,2); assert.match(markup(headings[0]!),/负责：Session A、Session B/); assert.match(markup(headings[1]!),/负责：未指定/);
  assert.ok(p.all().some(e=>e.innerHTML==="等你处理 1 ›"));
  const inbox=p.all().find(e=>e.className==="inbox"); assert.ok(inbox);
  assert.match(markup(inbox),/收件箱 1/); assert.match(markup(inbox),/Request title/); assert.match(markup(inbox),/Visitor/); assert.match(markup(inbox),/Need feature/);
  const item=p.all().find(e=>e.id==="it-incoming"); assert.ok(item); assert.ok(descendants(inbox).includes(item));
  await descendants(item).find(e=>e.className==="item-head")!.click();
  assert.match(markup(p.all().find(e=>e.id==="it-incoming")!),/Request body/);
  assert.ok(p.all().some(e=>e.className==="request-meta" && e.innerHTML.includes("Visitor") && e.innerHTML.includes("Need feature")));
  await p.all().filter(e=>e.tagName==="BUTTON" && e.innerHTML==="提需求")[1]!.click();
  let form=p.all().find(e=>e.className==="request-form"); assert.ok(form);
  const inputs=descendants(form);
  inputs.find(e=>e.tagName==="INPUT")!.value="New title";
  inputs.find(e=>e.tagName==="TEXTAREA")!.value="New text";
  inputs.find(e=>e.tagName==="SELECT")!.value="P0";
  for (const input of inputs.filter(e=>["INPUT","TEXTAREA","SELECT"].includes(e.tagName))) for (const fn of input.handlers.get("input") ?? []) fn({});
  await inputs.find(e=>e.tagName==="BUTTON" && e.innerHTML==="提交")!.click();
  assert.deepEqual(p.calls.find(c=>c.path==="/api/requests")!.body,{project:"Empty",title:"New title",text:"New text",priority:"P0"});
  await p.all().filter(e=>e.tagName==="BUTTON" && e.innerHTML==="提需求")[0]!.click();
  form=p.all().find(e=>e.className==="request-form")!;
  await descendants(form).find(e=>e.tagName==="BUTTON" && e.innerHTML==="取消")!.click();
  assert.ok(!p.all().some(e=>e.className==="request-form"));
});
