// TMP-MEASURE (item ci-under-1min-study, never merged): can the real page run in a DOM library with no browser, and how fast?
// Runs the bundled page against the real server on the e2e harness's generated board, then repeats two checks of
// test/e2e/invariants.ts (tree rows select their item; plan item rows go to their item and Back returns) with script clicks.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { startBoard, ROOT } from "../test/e2e/harness.ts";

const lib = process.argv[2] ?? "jsdom";
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const cleanups: Array<() => unknown> = [];
const hooks = { after: (fn: () => unknown) => { cleanups.push(fn); } };
const t0 = performance.now();
const lap = (label: string) => console.log(`PROTO ${lib} ${label}: ${(performance.now() - t0).toFixed(0)} ms since start`);
const errors: string[] = [];
process.on("unhandledRejection", e => { errors.push("unhandledRejection " + String(e instanceof Error ? e.stack : e).split("\n").slice(0, 3).join(" | ")); });

const board = await startBoard(hooks);
lap("board seeded and served");
const html = await (await fetch(board.url + "/")).text();
const code = (await build({ entryPoints: [join(ROOT, "web/app.ts")], bundle: true, format: "iife", globalName: "BoardPage", write: false, target: "es2022" })).outputFiles[0]!.text;
void readFile;
lap("html fetched, bundle built");

// The window.
let w: any;
if (lib === "jsdom") {
  const { JSDOM } = await import("jsdom");
  w = new JSDOM(html, { url: board.url + "/", pretendToBeVisual: true, runScripts: "outside-only" }).window;
} else if (lib === "happy-dom") {
  const { Window } = await import("happy-dom");
  w = new Window({ url: board.url + "/", settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: false, disableCSSFileLoading: true } });
  w.document.write(html);
} else throw new Error("unknown lib " + lib);
lap("window created");

let inflight = 0, draws = 0, fetches = 0;
const realFetch = globalThis.fetch.bind(globalThis);
w.fetch = (input: unknown, init?: RequestInit) => { inflight++; fetches++; return realFetch(new URL(String(input), board.url), init).finally(() => { inflight--; }); };
w.requestAnimationFrame = (fn: (now: number) => void) => setTimeout(() => fn(performance.now()), 0) as unknown as number;
w.cancelAnimationFrame = (id: number) => clearTimeout(id);
w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
// The page's event stream, read from the real server: onopen when the response starts, then the named events.
w.EventSource = class {
  onopen?: () => unknown; onerror?: () => unknown; handlers = new Map<string, Array<(event: unknown) => unknown>>(); abort = new AbortController();
  constructor(url: string) { void this.run(url); }
  addEventListener(kind: string, fn: (event: unknown) => unknown) { this.handlers.set(kind, [...this.handlers.get(kind) ?? [], fn]); }
  close() { this.abort.abort(); }
  async run(url: string) {
    try {
      const res = await realFetch(new URL(url, board.url), { signal: this.abort.signal, headers: { Accept: "text/event-stream" } });
      void this.onopen?.();
      const decoder = new TextDecoder(); let buffer = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let at: number;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          let kind = "message", data = "";
          for (const line of block.split("\n")) { if (line.startsWith("event:")) kind = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trim(); }
          for (const fn of this.handlers.get(kind) ?? []) fn({ data });
        }
      }
    } catch { /* closed */ }
  }
};
try { w.CSS = { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, c => "\\" + c) }; } catch { /* the window has its own */ }
w.structuredClone = structuredClone;
for (const proto of [w.Element?.prototype, w.HTMLElement?.prototype]) if (proto) {
  proto.scrollIntoView ??= function () {};
  proto.scrollTo ??= function () {};
  proto.scrollBy ??= function () {};
}
w.scrollTo ??= () => {}; w.scrollBy ??= () => {};
w.performance.clearMarks ??= () => {};
const mark0 = w.performance.mark?.bind(w.performance);
w.performance.mark = (name: string, ...rest: unknown[]) => { if (name === "board:render") draws++; return mark0?.(name, ...rest); };
w.addEventListener("error", (e: any) => { errors.push("window error " + (e.message ?? e)); });
// Every tree row unfolded, as the e2e harness's openAll does.
w.localStorage.setItem("board-open", JSON.stringify(Object.fromEntries(Object.keys(board.store.snapshot().items).map(id => [id, true]))));

const settle = async () => {
  for (let k = 0; k < 200; k++) {
    while (inflight > 0) await sleep(0);
    const before = draws;
    await sleep(0); await sleep(0);
    if (inflight === 0 && draws === before) return;
  }
};
const doc = w.document;
try { w.eval(code); } catch (e) { errors.push("page eval: " + String((e as Error).stack).split("\n").slice(0, 4).join(" | ")); }
lap("page code evaluated");
for (let k = 0; k < 2000 && !(doc.querySelector("#sendbox:not([hidden])") && doc.querySelector("#areas .item")); k++) await sleep(5);
await settle();
lap(`first render done (${doc.querySelectorAll("#areas .item").length} tree rows, ${fetches} fetches)`);

const selected = () => { const d = doc.querySelector("#item-detail > .item"); return d ? d.id.slice("detail-it-".length) : null; };
const treeRows = () => [...doc.querySelectorAll("#areas .item")].map((e: any) => e.id.slice(3));
const bad: string[] = [];

// Family 1: every tree row's title selects that item.
let began = performance.now();
const rows = treeRows();
for (const id of rows) {
  const head = doc.getElementById("it-" + id)?.querySelector(":scope > .item-row > .item-head .item-title") ?? doc.querySelector(`[id="it-${id}"] .item-title`);
  if (!head) { bad.push("no title for " + id); continue; }
  head.click();
  await settle();
  const sel = selected();
  if (sel !== id) bad.push(`tree-row: clicking ${id}'s title selected ${sel}`);
}
console.log(`PROTO ${lib} family tree rows: ${rows.length} clicks in ${(performance.now() - began).toFixed(0)} ms (${((performance.now() - began) / rows.length).toFixed(1)} ms per click); wrong landings ${bad.length}; browser run of the same family: about 14.9 s`);
if (bad.length) console.log("PROTO " + lib + " first wrong: " + bad.slice(0, 3).join(" || "));

// Family 2: plan item rows go to their item and Back returns (items whose plans share or own other items).
began = performance.now();
const snap = board.store.snapshot();
const picks = Object.keys(snap.items).filter(id => snap.items[id]!.plan.some(r => "item" in r)).slice(0, 40);
let planClicks = 0; const bad2: string[] = [];
for (const x of picks) {
  doc.getElementById("it-" + x)?.querySelector(".item-title")?.click(); await settle();
  if (selected() !== x) { bad2.push("could not select " + x); continue; }
  const row = snap.items[x]!.plan.find(r => "item" in r)!;
  const el = "plan-" + encodeURIComponent(JSON.stringify([x, row.id]));
  const link = doc.getElementById(el)?.querySelector(".plan-main a.plan-link");
  if (!link) { bad2.push(`no plan link in ${x}`); continue; }
  link.click(); await settle(); planClicks++;
  if (selected() !== (row as { item: string }).item) bad2.push(`plan-item-row: ${x} -> ${(row as { item: string }).item} selected ${selected()}`);
  doc.getElementById("backbtn")?.click(); await settle(); planClicks++;
  if (selected() !== x) bad2.push(`back from ${(row as { item: string }).item} to ${x} selected ${selected()}`);
}
console.log(`PROTO ${lib} family plan item rows: ${picks.length} items, ${planClicks} clicks in ${(performance.now() - began).toFixed(0)} ms; wrong landings ${bad2.length}`);
if (bad2.length) console.log("PROTO " + lib + " first wrong: " + bad2.slice(0, 3).join(" || "));
if (errors.length) console.log(`PROTO ${lib} page errors (${errors.length}): ` + errors.slice(0, 5).join(" || "));
lap("done");
for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* ignore */ } }
process.exit(0);
