// The browser layer's harness: a real server (the same wiring as src/main.ts) on a temporary data repository seeded
// with a generated board, and headless Chromium driving the real page against the real API and event stream.

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import type { BoardServer, Hooks } from "./board-server.ts";

// The server and the pre-fix page variants need no browser; they live in board-server.ts and variant.ts and are
// re-exported here for the files of this layer.
export { ROOT, openAll, startBoard, serveBoard } from "./board-server.ts";
export type { BoardServer } from "./board-server.ts";
export { reverted, variantWeb } from "./variant.ts";
export type { Revert } from "./variant.ts";

export async function launch(t: Hooks): Promise<Browser> {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  return browser;
}

// Counts the page's fetches in flight, its draws (the page marks each one) and the change events its event stream
// delivered, so a test waits for the page to finish what a click or a server write started instead of sleeping.
const INSTRUMENT = `(() => {
  let inflight = 0, changes = 0, draws = 0;
  const drawObserver = new PerformanceObserver(list => { for (const e of list.getEntries()) if (e.name === "board:render") draws++; });
  drawObserver.observe({ entryTypes: ["mark"] });
  Object.defineProperty(window, "__draws", { get: () => { for (const e of drawObserver.takeRecords()) if (e.name === "board:render") draws++; return draws; } });
  const fetch = window.fetch.bind(window);
  window.fetch = (...args) => { inflight++; return fetch(...args).then(async r => { try { await r.clone().arrayBuffer(); } catch {} return r; }).finally(() => { inflight--; }); };
  Object.defineProperty(window, "__inflight", { get: () => inflight });
  const Source = window.EventSource;
  window.EventSource = class extends Source { constructor(...args) { super(...args); this.addEventListener("change", () => { changes++; }); } };
  Object.defineProperty(window, "__changes", { get: () => changes });
})();`;

export class BoardPage {
  readonly page: Page; readonly context: BrowserContext; readonly board: BoardServer;
  constructor(page: Page, context: BrowserContext, board: BoardServer) { this.page = page; this.context = context; this.board = board; }
  /** `init`: a script that runs before the page's own on every load. */
  static async open(browser: Browser, board: BoardServer, storage: Record<string, unknown> = {}, init?: string): Promise<BoardPage> {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, reducedMotion: "reduce", colorScheme: "light" });
    // The page's web fonts come from Google; the tests read declared font stacks and stay offline.
    await context.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
    await context.addInitScript({ content: INSTRUMENT });
    if (init) await context.addInitScript({ content: init });
    // A click that cannot land fails within seconds and is reported as a violation, rather than stalling the walk.
    context.setDefaultTimeout(5_000);
    const bp = new BoardPage(await context.newPage(), context, board);
    await bp.reset(storage);
    return bp;
  }
  /** Clears the viewer's stored state, writes `storage` (values JSON-encoded unless strings), loads the page and waits. */
  async reset(storage: Record<string, unknown> = {}) {
    await this.page.goto(this.board.url + "/health");
    await this.page.evaluate(entries => { localStorage.clear(); for (const [k, v] of entries) localStorage.setItem(k, v); }, Object.entries(storage).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)] as [string, string]));
    await this.page.goto(this.board.url + "/");
    await this.page.waitForSelector("#sendbox:not([hidden])", { timeout: 20_000 });
    await this.page.waitForSelector("#areas .item");
    await this.settle();
  }
  /** Waits until no fetch is in flight and the page drew nothing across two animation frames: a navigation waits a frame
   * for its draw before it fetches and again before it lands, and neither wait has a fetch in flight. */
  async settle() {
    const state = () => this.page.evaluate(() => { const w = window as unknown as { __inflight: number; __draws: number }; return { inflight: w.__inflight, draws: w.__draws }; });
    for (let k = 0; k < 50; k++) {
      await this.page.waitForFunction(() => (window as unknown as { __inflight: number }).__inflight === 0, null, { timeout: 15_000 });
      const before = await state();
      await this.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 20)))));
      const after = await state();
      if (after.inflight === 0 && after.draws === before.draws) return;
    }
  }
  async changes(): Promise<number> { return this.page.evaluate(() => (window as unknown as { __changes: number }).__changes); }
  /** Waits until the page has received `n` change events, then settles. */
  async waitChanges(n: number) {
    await this.page.waitForFunction(n => (window as unknown as { __changes: number }).__changes >= n, n, { timeout: 20_000 });
    await this.settle();
  }
  /** The item whose detail is shown, or null. */
  async selected(): Promise<string | null> {
    return this.page.evaluate(() => { const d = document.querySelector("#item-detail > .item"); return d ? d.id.slice("detail-it-".length) : null; });
  }
  /** The decision cards marked as the current selection. */
  async currentCards(): Promise<string[]> {
    return this.page.evaluate(() => [...document.querySelectorAll(".card.cur")].map(e => e.id.slice(2)));
  }
  /** The ids of the item rows drawn in the tree, in page order. */
  async treeRows(): Promise<string[]> {
    return this.page.evaluate(() => [...document.querySelectorAll("#areas .item")].map(e => e.id.slice(3)));
  }
  row(id: string) { return this.page.locator(`#areas [id="it-${id}"]`); }
  head(id: string) { return this.page.locator(`#areas [id="it-${id}"] > .item-row > .item-head`); }
  /** Selects an item the way the owner does: its tree row when drawn, otherwise the "/" search by its short number. */
  async select(id: string): Promise<void> {
    if (await this.head(id).count()) await this.head(id).locator(".item-title").click();
    else {
      const num = this.board.store.snapshot().items[id]?.num;
      await this.search("#" + num);
      await this.page.keyboard.press("Enter");
    }
    await this.settle();
  }
  /** Opens the "/" search and types a query; the result rows are then `.searchrow`. */
  async search(query: string) {
    await this.page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.(); });
    await this.page.keyboard.press("/");
    await this.page.locator("#search-input").fill(query);
  }
}
