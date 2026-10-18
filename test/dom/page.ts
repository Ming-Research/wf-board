// The owner's page run in a DOM library (jsdom) with no browser: the bundled page loads the real index.html, talks to the real
// server (the wiring of src/main.ts, in process) through a real fetch and a real event stream, and is driven by script clicks and
// key events. It is the middle layer between test/web.test.ts (a hand-written fake DOM) and test/e2e (headless Chromium): the real
// page and server on a generated board like the real one, without a browser's cost. It computes no layout (every box is 0 by 0), so
// checks of position, size and hit-testing stay in the browser layer. docs/design.md, section 11, Three test layers.

import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import type { DOMWindow } from "jsdom";
import { join } from "node:path";
import { stampPage } from "../../src/page-version.ts";
import { ROOT } from "../e2e/board-server.ts";
import type { BoardServer, Hooks } from "../e2e/board-server.ts";
import { reverted } from "../e2e/variant.ts";
import type { Revert } from "../e2e/variant.ts";
import { Styles } from "./styles.ts";

/** One turn of the event loop: what the page's frames, its short timers and its settled promises need to run. */
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** The page's timers up to this long are waited for by settle(); longer ones are timeouts, retries and hints that fire only if nothing happens. */
const SHORT_TIMER_MS = 10;
// The window's own objects are written to by the shims below, so they are typed loosely here.
type Loose = Record<string, any>;

// The bundle and the page text of each variant, built once per process. A variant is the current page with fixes reversed
// (test/e2e/variant.ts): the edits are applied to the source text and the bundle is built in memory, as the browser layer's
// variantWeb does on disk.
const bundles = new Map<string, Promise<string>>();
const pages = new Map<string, Promise<string>>();
const key = (reverts: Revert[]) => JSON.stringify(reverts);
/** The page's script for a window: the same esbuild options as `build:web`, as a script instead of a module so the window can evaluate it. */
export function pageScript(reverts: Revert[] = []): Promise<string> {
  const k = key(reverts);
  if (!bundles.has(k)) bundles.set(k, (async () => {
    const contents = await reverted("web/app.ts", reverts);
    const out = await build({ stdin: { contents, resolveDir: join(ROOT, "web"), sourcefile: "app.ts", loader: "ts" }, bundle: true, format: "iife", target: "es2022", write: false, logLevel: "silent" });
    return out.outputFiles[0]!.text;
  })());
  return bundles.get(k)!;
}
/** The page's HTML as `GET /` serves it for a page that does not know its version (it then never reloads itself). */
export function pageHtml(reverts: Revert[] = []): Promise<string> {
  const k = key(reverts);
  if (!pages.has(k)) pages.set(k, reverted("web/index.html", reverts).then(html => stampPage(html, undefined)));
  return pages.get(k)!;
}

export interface PageOptions {
  /** Viewer state written to localStorage before the page loads (values JSON-encoded unless strings). */
  storage?: Record<string, unknown>;
  /** The page with these fixes reversed. */
  reverts?: Revert[];
  /** The colour scheme the page's media queries answer for. */
  scheme?: "light" | "dark";
}

export class DomPage {
  readonly board: BoardServer;
  win!: DOMWindow & Loose;
  /** What the page itself reported: uncaught errors, unhandled rejections and its console errors. */
  errors: string[] = [];
  /** Counts of the performance marks the page leaves for its tests (`board:render` is a draw). */
  marks = new Map<string, number>();
  private inflight = 0;
  private frames = 0;
  private changeCount = 0;
  private pending = new Map<number, NodeJS.Timeout>();
  private timers = new Map<number, NodeJS.Timeout>();
  private streams = new Set<AbortController>();
  private stylesOfWindow: Styles | undefined;
  private options: PageOptions;
  private constructor(board: BoardServer, options: PageOptions) { this.board = board; this.options = options; }

  /** Opens the page on `board` and waits until it has drawn; the window is closed when the test ends. */
  static async open(t: Hooks, board: BoardServer, options: PageOptions = {}): Promise<DomPage> {
    const page = new DomPage(board, options);
    t.after(() => page.close());
    await page.reset(options.storage);
    return page;
  }

  get doc(): Document { return this.win.document; }
  /** What the page's stylesheet declares for its elements, in the light scheme (test/dom/styles.ts). */
  get styles(): Styles { return this.stylesOfWindow ??= new Styles(this.win); }
  get draws(): number { return this.marks.get("board:render") ?? 0; }

  /** Closes the window: its timers stop and its event stream is dropped. */
  close() {
    for (const timer of [...this.pending.values(), ...this.timers.values()]) clearTimeout(timer);
    this.pending.clear(); this.timers.clear(); this.frames = 0;
    for (const stream of this.streams) stream.abort();
    this.streams.clear();
    this.win?.close();
  }

  /** Throws the viewer state away, writes `storage`, loads the page afresh in a new window and waits until it has drawn. */
  async reset(storage: Record<string, unknown> = {}) {
    this.close();
    this.stylesOfWindow = undefined;
    this.errors = []; this.marks = new Map(); this.inflight = 0; this.changeCount = 0;
    const { reverts = [] } = this.options;
    const [html, script] = await Promise.all([pageHtml(reverts), pageScript(reverts)]);
    // The window's own complaints about what it does not implement (a stylesheet it cannot parse, navigation) are not the page's.
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("error", (...args: unknown[]) => { this.errors.push("console.error: " + args.map(String).join(" ")); });
    const dom = new JSDOM(html, { url: this.board.url + "/", pretendToBeVisual: true, runScripts: "outside-only", virtualConsole });
    this.win = dom.window as DOMWindow & Loose;
    for (const [k, v] of Object.entries(storage)) this.win.localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    this.install();
    try { this.win.eval(script); } catch (e) { this.errors.push("the page's script threw: " + String(e instanceof Error ? e.stack : e).split("\n").slice(0, 4).join(" | ")); }
    await this.waitFor(() => !!this.doc.querySelector("#sendbox:not([hidden])") && !!this.doc.querySelector("#areas .item"), "the page to draw its first board");
    await this.settle();
    if (this.errors.length) throw new Error("the page reported errors while loading:\n" + this.errors.join("\n"));
  }

  /** What a browser provides and jsdom does not, so the page runs as it does there: a real fetch to the server, its event stream,
   * frames that arrive after a turn of the event loop, and the smaller browser objects the page asks for. */
  private install() {
    const win = this.win, board = this.board;
    const abs = (input: unknown) => new URL(typeof input === "string" ? input : (input as { url?: string }).url ?? String(input), board.url);
    // A fetch is in flight until its body has been read, so a test waits for the page to have what it asked for.
    win.fetch = (input: unknown, init?: RequestInit) => {
      this.inflight++;
      return fetch(abs(input), init).then(async response => { try { await response.clone().arrayBuffer(); } catch { /* aborted */ } return response; }).finally(() => { this.inflight--; });
    };
    // The event stream: `open` when the response starts, then the named events. A change event counts before the page sees it.
    const page = this;
    win.EventSource = class {
      onopen: (() => unknown) | null = null; onerror: (() => unknown) | null = null;
      readyState = 0; url: string;
      private handlers = new Map<string, Array<(event: unknown) => unknown>>(); private controller = new AbortController();
      constructor(url: string) { this.url = url; page.streams.add(this.controller); void this.run(); }
      addEventListener(kind: string, fn: (event: unknown) => unknown) { this.handlers.set(kind, [...this.handlers.get(kind) ?? [], fn]); }
      removeEventListener(kind: string, fn: (event: unknown) => unknown) { this.handlers.set(kind, (this.handlers.get(kind) ?? []).filter(f => f !== fn)); }
      close() { this.readyState = 2; this.controller.abort(); }
      private async run() {
        try {
          const response = await fetch(abs(this.url), { signal: this.controller.signal, headers: { Accept: "text/event-stream" } });
          this.readyState = 1; void this.onopen?.();
          const decoder = new TextDecoder(); let buffer = "";
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            buffer += decoder.decode(chunk, { stream: true });
            for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
              const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
              let kind = "message", data = "";
              for (const line of block.split("\n")) { if (line.startsWith("event:")) kind = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trim(); }
              if (kind === "change") page.changeCount++;
              for (const fn of this.handlers.get(kind) ?? []) fn({ data });
            }
          }
        } catch { /* closed by the page or the test */ }
        if (this.readyState !== 2) { this.readyState = 2; void this.onerror?.(); }
      }
    };
    // A callback of the page's own that throws is the page's error, as in a browser.
    const guarded = (fn: (...args: any[]) => unknown, ...args: unknown[]) => { try { fn(...args); } catch (e) { this.errors.push("window error: " + String(e instanceof Error ? e.stack : e).split("\n").slice(0, 3).join(" | ")); } };
    // Frames: a callback runs after a turn of the event loop, and settle() knows how many wait.
    let nextFrame = 1;
    win.requestAnimationFrame = (fn: (now: number) => void) => {
      const id = nextFrame++; this.frames++;
      this.pending.set(id, setImmediate(() => { this.pending.delete(id); this.frames--; guarded(fn, win.performance.now()); }) as unknown as NodeJS.Timeout);
      return id;
    };
    win.cancelAnimationFrame = (id: number) => { const timer = this.pending.get(id); if (timer) { clearImmediate(timer as unknown as NodeJS.Immediate); this.pending.delete(id); this.frames--; } };
    // Short timers are the page's own bookkeeping (a fallback frame, a deferred call) that settle() waits for; longer ones are left to the window.
    const windowSetTimeout = win.setTimeout.bind(win), windowClearTimeout = win.clearTimeout.bind(win);
    let nextTimer = 1_000_000_000;
    win.setTimeout = (fn: unknown, ms = 0, ...args: unknown[]) => {
      if (typeof fn !== "function" || ms > SHORT_TIMER_MS) return windowSetTimeout(fn as TimerHandler, ms, ...args);
      const id = nextTimer++;
      this.timers.set(id, setTimeout(() => { this.timers.delete(id); guarded(fn as (...a: unknown[]) => unknown, ...args); }, ms));
      return id;
    };
    win.clearTimeout = (id?: number) => { const timer = id === undefined ? undefined : this.timers.get(id); if (timer) { clearTimeout(timer); this.timers.delete(id!); } else windowClearTimeout(id); };
    // The page leaves performance marks for its tests; they are counted here by name and not kept.
    const perf = win.performance as Loose, mark = perf.mark?.bind(perf);
    perf.mark = (name: string, ...rest: unknown[]) => { this.marks.set(name, (this.marks.get(name) ?? 0) + 1); return mark?.(name, ...rest); };
    perf.clearMarks = () => {};
    // A reader who prefers reduced motion: the page then moves at once instead of gliding.
    win.matchMedia = (query: string) => {
      const matches = /prefers-reduced-motion:\s*reduce/.test(query) || (/prefers-color-scheme:\s*dark/.test(query) && this.options.scheme === "dark");
      return { matches, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
    };
    win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    // The page hands its AbortController's signals to fetch, which is Node's, so it uses Node's classes.
    for (const name of ["AbortController", "AbortSignal", "structuredClone", "TextEncoder", "TextDecoder"]) win[name] = (globalThis as Loose)[name];
    win.CSS = { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, c => "\\" + c) };
    for (const proto of [win.Element.prototype, win.HTMLElement.prototype] as Loose[]) {
      proto.scrollIntoView ??= function () {}; proto.scrollTo ??= function () {}; proto.scrollBy ??= function () {};
    }
    win.scrollTo = () => {}; win.scrollBy = () => {};
    // There is no layout, so the window is modelled as one tall enough for the whole page: every box is the same small box at the top
    // of panes that show it, and nothing scrolls. What the page decides by where a box is (whether it is on screen) then always says yes.
    win.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, toJSON() { return this; } });
    for (const name of ["clientHeight", "scrollHeight", "offsetHeight"]) Object.defineProperty(win.Element.prototype, name, { configurable: true, get: () => 1000 });
    // There is no layout to hit-test: nothing is under any point.
    win.document.elementFromPoint = () => null; win.document.elementsFromPoint = () => [];
    // An element is laid out unless it or an ancestor is hidden or not displayed; there is no layout to find its box.
    Object.defineProperty(win.HTMLElement.prototype, "offsetParent", { configurable: true, get(this: HTMLElement) { return this.isConnected && this.checkVisibility() ? this.ownerDocument.body : null; } });
    win.HTMLElement.prototype.checkVisibility = function (this: HTMLElement) { return page.shown(this); };
    win.addEventListener("error", (e: ErrorEvent) => { this.errors.push("window error: " + (e.message || String(e.error))); });
    win.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => { this.errors.push("unhandled rejection: " + String(e.reason)); });
  }

  /** Waits until `done()` holds, polling by turns of the event loop; throws saying what was waited for. */
  async waitFor(done: () => boolean, what: string, ms = 20_000) {
    const until = Date.now() + ms;
    while (!done()) {
      if (this.errors.length) throw new Error(`while waiting for ${what} the page reported:\n${this.errors.join("\n")}`);
      if (Date.now() > until) throw new Error(`gave up waiting for ${what} after ${ms} ms`);
      await sleep(1);
    }
  }
  /** Waits until no fetch is in flight, no frame or short timer is waiting and the page drew nothing across two turns. */
  async settle() {
    const busy = () => this.inflight > 0 || this.frames > 0 || this.timers.size > 0;
    for (let k = 0; k < 200; k++) {
      while (busy()) await turn();
      const before = this.draws;
      await turn(); await turn();
      if (!busy() && this.draws === before) return;
    }
    throw new Error(`the page did not settle: ${this.inflight} fetches in flight, ${this.frames} frames and ${this.timers.size} timers waiting, ${this.draws} draws`);
  }
  /** The change events the page's event stream delivered. */
  changes(): number { return this.changeCount; }
  /** Waits until the page has received `n` change events, then settles. */
  async waitChanges(n: number) {
    await this.waitFor(() => this.changeCount >= n, `change event ${n} (${this.changeCount} arrived)`);
    await this.settle();
  }

  // What a person does, as script events.
  $<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = this.doc): T | null { return root.querySelector<T>(selector); }
  $$<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = this.doc): T[] { return [...root.querySelectorAll<T>(selector)]; }
  /** Whether the element is displayed, as a browser decides without a layout: it and its ancestors are not `display: none`, which is what
   * the `hidden` attribute means only until a rule of the page's own sets another display; and a closed `details` shows only its summary. */
  shown(el: Element): boolean {
    this.styles.forget();
    for (let e: Element | null = el; e; e = e.parentElement) {
      const display = this.styles.value(e, "display");
      if (display === "none" || (display === undefined && (e as HTMLElement).hidden)) return false;
      const parent = e.parentElement;
      if (parent instanceof this.win.HTMLDetailsElement && !parent.open && e !== parent.querySelector(":scope > summary")) return false;
    }
    return true;
  }
  /** Whether a person could see the element: attached and displayed. */
  visible(el: Element | null | undefined): boolean { return !!el && el.isConnected && this.shown(el); }
  /** A click on an element a person could click: it must exist, not be hidden by an attribute and be enabled. (Whether a style
   * covers or hides it is a question for the stylesheet or a browser: test/dom/styles.ts, test/e2e.) */
  click(el: Element | null | undefined, what = "the element") {
    if (!el) throw new Error(`${what} is not on the page`);
    for (let e: Element | null = el; e; e = e.parentElement) if ((e as HTMLElement).hidden) throw new Error(`${what} is on the page but hidden`);
    if ((el as HTMLButtonElement).disabled) throw new Error(`${what} is disabled`);
    (el as HTMLElement).click();
  }
  /** A key pressed with focus where it is now (the body when nothing has it). */
  key(key: string, init: KeyboardEventInit = {}) {
    const target = this.doc.activeElement ?? this.doc.body;
    target.dispatchEvent(new this.win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  }
  /** Types `text` into a field the way a person does: its value changes and the page is told. */
  fill(el: Element | null | undefined, text: string, what = "the field") {
    if (!el) throw new Error(`${what} is not on the page`);
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    field.focus(); field.value = text;
    field.dispatchEvent(new this.win.Event("input", { bubbles: true }));
  }
  blur() { (this.doc.activeElement as HTMLElement | null)?.blur?.(); }

  // The page's state, read the way the browser layer's BoardPage reads it.
  /** The item whose detail is shown, or null. */
  selected(): string | null { const d = this.$("#item-detail > .item"); return d ? d.id.slice("detail-it-".length) : null; }
  /** The decision cards marked as the current selection. */
  currentCards(): string[] { return this.$$(".card.cur").map(e => e.id.slice(2)); }
  /** The ids of the item rows drawn in the tree, in page order. */
  treeRows(): string[] { return this.$$("#areas .item").map(e => e.id.slice(3)); }
  /** The tree row of an item. */
  row(id: string): HTMLElement | null { return this.$(`#areas [id="it-${attr(id)}"]`); }
  /** The head line of an item's tree row. */
  head(id: string): HTMLElement | null { return this.$(`#areas [id="it-${attr(id)}"] > .item-row > .item-head`); }
  /** Selects an item the way the owner does: its tree row when drawn, otherwise the "/" search by its short number. */
  async select(id: string): Promise<void> {
    const head = this.head(id);
    if (head) this.click(this.$(".item-title", head), `the title of ${id}`);
    else {
      const num = this.board.store.snapshot().items[id]?.num;
      this.search("#" + num);
      this.key("Enter");
    }
    await this.settle();
  }
  /** Opens the "/" search and types a query; the result rows are then `.searchrow`. */
  search(query: string) {
    this.blur();
    this.key("/");
    this.fill(this.$("#search-input"), query, "the search field");
  }
}

/** `id` as the value in an attribute selector written with double quotes. */
export function attr(id: string): string { return id.replace(/["\\]/g, "\\$&"); }
