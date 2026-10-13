// The browser layer's harness: a real server (the same wiring as src/main.ts) on a temporary data repository seeded
// with a generated board, and headless Chromium driving the real page against the real API and event stream.

import { once } from "node:events";
import { mkdtemp, rm, mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { ops } from "../../src/ops.ts";
import { ownerOps } from "../../src/owner-ops.ts";
import { createHttpServer } from "../../src/http.ts";
import { createMcpServer } from "../../src/mcp.ts";
import type { Store } from "../../src/store.ts";
import { generateBoard } from "./board-gen.ts";
import type { Generated } from "./board-gen.ts";
import { seedBoard } from "./seed.ts";

export const ROOT = join(import.meta.dirname, "../..");
interface Hooks { after(fn: () => unknown): void }

export interface BoardServer { url: string; store: Store; gen: Generated; dir: string }
/** Viewer state that draws every tree row: each item's sub-items unfolded. */
export function openAll(board: BoardServer): Record<string, unknown> {
  return { "board-open": Object.fromEntries(Object.keys(board.store.snapshot().items).map(id => [id, true])) };
}
/** Seeds a generated board into a temporary repository and serves it with the page from `webDir` (default web/). */
export async function startBoard(t: Hooks, opts: { seed?: number; webDir?: string } = {}): Promise<BoardServer> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-e2e-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const gen = generateBoard(opts.seed ?? 1);
  const { store } = await seedBoard(dir, gen);
  const op = ops(store);
  const server: Server = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: opts.webDir ?? join(ROOT, "web"), createMcp: () => createMcpServer({ store, ops: op }) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return { url: `http://127.0.0.1:${address.port}`, store, gen, dir };
}

export async function launch(t: Hooks): Promise<Browser> {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  return browser;
}

// Counts the page's fetches in flight and the change events its event stream delivered, so a test waits for the page
// to finish what a click or a server write started instead of sleeping.
const INSTRUMENT = `(() => {
  let inflight = 0, changes = 0;
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
  static async open(browser: Browser, board: BoardServer, storage: Record<string, unknown> = {}): Promise<BoardPage> {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, reducedMotion: "reduce", colorScheme: "light" });
    // The page's web fonts come from Google; the tests read declared font stacks and stay offline.
    await context.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
    await context.addInitScript({ content: INSTRUMENT });
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
  /** Waits until no fetch is in flight across two animation frames. */
  async settle() {
    for (let k = 0; k < 50; k++) {
      await this.page.waitForFunction(() => (window as unknown as { __inflight: number }).__inflight === 0, null, { timeout: 15_000 });
      await this.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 20)))));
      if (await this.page.evaluate(() => (window as unknown as { __inflight: number }).__inflight === 0)) return;
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

// Pre-fix variants of the page, for showing that a check catches a bug that once shipped: reverse the named hunks of a
// fix commit's diff in a copy of the current file, and serve the copy. The repository is never written.
export interface Revert { commit: string; file: "web/app.ts" | "web/index.html"; hunks?: number[] }
/** The hunks of one file's diff in a commit, each as its old and new text. */
function hunks(commit: string, file: string): Array<{ before: string; after: string }> {
  const diff = execFileSync("git", ["show", "--format=", "--no-color", "-U3", commit, "--", file], { cwd: ROOT, encoding: "utf8" });
  const out: Array<{ before: string[]; after: string[] }> = [];
  for (const line of diff.split("\n")) {
    const cur = out.at(-1);
    if (line.startsWith("@@")) out.push({ before: [], after: [] });
    else if (!cur) continue;
    else if (line.startsWith(" ")) { cur.before.push(line.slice(1)); cur.after.push(line.slice(1)); }
    else if (line.startsWith("-")) cur.before.push(line.slice(1));
    else if (line.startsWith("+")) cur.after.push(line.slice(1));
  }
  return out.map(h => ({ before: h.before.join("\n"), after: h.after.join("\n") }));
}
/** The current text of `file` with the chosen hunks of `commit` reversed; throws when one no longer matches exactly once. */
export async function reverted(revert: Revert): Promise<string> {
  let text = await readFile(join(ROOT, revert.file), "utf8");
  const all = hunks(revert.commit, revert.file);
  for (const k of revert.hunks ?? all.map((_, k) => k)) {
    const h = all[k];
    if (!h) throw new Error(`${revert.commit} ${revert.file}: no hunk ${k}`);
    const at = text.indexOf(h.after);
    if (at < 0 || text.indexOf(h.after, at + 1) >= 0) throw new Error(`${revert.commit} ${revert.file} hunk ${k} no longer matches the current file once; retire or update this regression witness`);
    text = text.slice(0, at) + h.before + text.slice(at + h.after.length);
  }
  return text;
}
/** A page directory serving the current page with the given reverts applied. */
export async function variantWeb(t: Hooks, reverts: Revert[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-variant-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "dist"));
  const html = reverts.find(r => r.file === "web/index.html"), app = reverts.find(r => r.file === "web/app.ts");
  if (html) await writeFile(join(dir, "index.html"), await reverted(html)); else await copyFile(join(ROOT, "web/index.html"), join(dir, "index.html"));
  const contents = app ? await reverted(app) : await readFile(join(ROOT, "web/app.ts"), "utf8");
  // The same options as the build:web script, reading the variant from stdin so its imports resolve from web/.
  await build({ stdin: { contents, resolveDir: join(ROOT, "web"), sourcefile: "app.ts", loader: "ts" }, bundle: true, format: "esm", target: "es2022", outfile: join(dir, "dist/app.js"), logLevel: "silent" });
  return dir;
}
