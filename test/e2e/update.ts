// Checks of a page that is open while the board is deployed: it replaces itself with the new version, keeping the selected item,
// the folds and the scroll, waits while the owner writes, and does not loop. Each runs on a page the test serves from a copy of
// the page directory (BoardServer.webDir), which it rebuilds the way the deploy job does. Families: update-reload, update-scroll,
// update-state, update-writing, update-same, update-loop.

import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { BoardPage, BoardServer } from "./harness.ts";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** How long a page that is going to reload is given to do it. */
const RELOAD_MS = 15_000;

/** A deploy that rebuilt the bundle: the page directory now holds another page than the one the open page was served as. */
async function rebuild(b: BoardServer) { await appendFile(join(b.webDir, "dist/app.js"), "\n// rebuilt\n"); }
/** What the deploy job does when a deploy ends (src/deploy.ts): it pushes `deployed` through the daemon's own route. */
async function deployed(b: BoardServer) {
  const res = await fetch(b.url + "/api/wake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "deployed", version: "a".repeat(40), previous: "b".repeat(40), changes: [], restarted: false }) });
  if (!res.ok) throw new Error(`POST /api/wake answered ${res.status}`);
}
/** Marks the loaded page, so a later look can tell whether it is still the same page. */
const mark = (bp: BoardPage) => bp.page.evaluate(() => { (window as unknown as { __loaded: boolean }).__loaded = true; });
const marked = (bp: BoardPage) => bp.page.evaluate(() => (window as unknown as { __loaded?: boolean }).__loaded === true);
/** Starts waiting for the page to load again; call before the deploy, await after. */
const nextLoad = (bp: BoardPage) => bp.page.waitForEvent("load", { timeout: RELOAD_MS }).then(() => true, () => false);
async function drawn(bp: BoardPage) {
  await bp.page.waitForSelector("#sendbox:not([hidden])", { timeout: 20_000 });
  await bp.page.waitForSelector("#areas .item");
  await bp.settle();
}
const versionOf = (bp: BoardPage) => bp.page.evaluate(() => document.getElementById("page-version")?.getAttribute("content") ?? "");
const scrolls = (bp: BoardPage) => bp.page.evaluate(() => ({ list: document.getElementById("page-left")!.scrollTop, detail: document.getElementById("item-detail")!.scrollTop }));

/** The item with the most text, so that its detail is taller than the pane and scrolls. */
function longest(b: BoardServer): string {
  const items = b.store.snapshot().items;
  return Object.keys(items).filter(id => !items[id]!.record).sort((x, y) => JSON.stringify(items[y]).length - JSON.stringify(items[x]).length)[0]!;
}

/** A page open before a deploy that rebuilt the bundle reloads itself, on the new version, with the same item selected, the same
 * rows unfolded and both panes scrolled as far as before. */
export async function checkReload(bp: BoardPage, b: BoardServer): Promise<string[]> {
  const v: string[] = [];
  const id = longest(b);
  await bp.select(id);
  await bp.page.evaluate(() => { document.getElementById("page-left")!.scrollTop = 600; document.getElementById("item-detail")!.scrollTop = 150; });
  const was = await scrolls(bp), rows = await bp.treeRows(), version = await versionOf(bp);
  if (was.list < 300 || was.detail < 50 || !/^[0-9a-f]{16}$/.test(version)) return [`witness setup: the page is scrolled to ${JSON.stringify(was)} and was served as version "${version}"`];
  const loaded = nextLoad(bp);
  await rebuild(b); await deployed(b);
  if (!await loaded) return ["update-reload: the page open before the deploy did not reload itself"];
  await drawn(bp);
  const now = await versionOf(bp);
  if (!/^[0-9a-f]{16}$/.test(now) || now === version) v.push(`update-reload: the reloaded page was served as version "${now}", not a new one after "${version}"`);
  if (await bp.selected() !== id) v.push(`update-state: the selected item was ${id} and is ${await bp.selected()} after the reload`);
  const after = JSON.stringify(await bp.treeRows());
  if (after !== JSON.stringify(rows)) v.push("update-state: the rows of the tree changed across the reload");
  // The scroll is put back once the page is drawn: give it a moment.
  await bp.page.waitForFunction(w => Math.abs(document.getElementById("page-left")!.scrollTop - w.list) <= 2 && Math.abs(document.getElementById("item-detail")!.scrollTop - w.detail) <= 2, was, { timeout: 5_000 }).catch(() => {});
  const got = await scrolls(bp);
  if (Math.abs(got.list - was.list) > 2) v.push(`update-scroll: the list was scrolled to ${was.list} and is at ${got.list} after the reload`);
  if (Math.abs(got.detail - was.detail) > 2) v.push(`update-scroll: the detail was scrolled to ${was.detail} and is at ${got.detail} after the reload`);
  return v;
}

/** While a comment box is open the page does not reload: the banner says the board was updated and the typed text stays. Once the
 * comment is saved the page reloads, and the comment is on the server and shown. */
export async function checkWriting(bp: BoardPage, b: BoardServer): Promise<string[]> {
  const v: string[] = [], w = b.gen.witness;
  await bp.select(w.commentItem);
  await bp.page.locator("#item-detail .item-comment").click();
  await bp.settle();
  const box = bp.page.locator(`[id="ed-${("it:" + w.commentItem).replace(/[^A-Za-z0-9_-]/g, "_")}"]`);
  if (!await box.count()) return ["witness setup: no comment field opened"];
  const text = "写到一半的评论 " + Date.now();
  await box.fill(text);
  await mark(bp);
  await rebuild(b); await deployed(b);
  await sleep(2_500);
  if (!await marked(bp)) return ["update-writing: the page reloaded under an open comment box"];
  const banner = bp.page.locator("#update-banner");
  if (!await banner.isVisible() || !(await banner.textContent() ?? "").includes("看板已更新")) v.push("update-writing: the page waiting for the comment shows no 看板已更新 line");
  if (await box.inputValue() !== text) v.push("update-writing: the text typed in the comment box changed while the page waited");
  const loaded = nextLoad(bp);
  await box.press("Enter");
  if (!await loaded) return [...v, "update-writing: the page did not reload after the comment was saved"];
  await drawn(bp);
  const saved = Object.values(b.store.snapshot().notes).some(n => n.target === "it:" + w.commentItem && n.text === text);
  if (!saved) v.push("update-writing: the comment was not on the server when the page reloaded");
  else if (!await bp.page.getByText(text).first().waitFor({ timeout: 5_000 }).then(() => true, () => false)) v.push("update-writing: the saved comment is not shown on the reloaded page");
  return v;
}

/** A deploy that left the page files as they were does not reload the page. */
export async function checkSame(bp: BoardPage, b: BoardServer): Promise<string[]> {
  await mark(bp);
  await deployed(b);
  await sleep(2_500);
  return await marked(bp) ? [] : ["update-same: a deploy that left the page as it was reloaded the page"];
}

/** A page whose version never matches the one announced (its own text says another) reloads once, then stops and asks for a reload by hand. */
export async function checkLoop(bp: BoardPage, b: BoardServer): Promise<string[]> {
  const v: string[] = [];
  await bp.context.route(b.url + "/", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(/(id="page-version" name="page-version" content=")[0-9a-f]*"/, '$1deadbeefdeadbeef"') });
  });
  let loads = 0;
  bp.page.on("load", () => { loads++; });
  const loaded = nextLoad(bp);
  await rebuild(b); await deployed(b);
  if (!await loaded) return ["update-loop: the page did not reload for the first deploy"];
  await sleep(4_000);
  if (loads !== 1) v.push(`update-loop: the page loaded ${loads} times in four seconds, not once: it kept reloading toward a version it could not reach`);
  const banner = bp.page.locator("#update-banner");
  if (!await banner.isVisible() || !(await banner.textContent() ?? "").includes("手动刷新")) v.push("update-loop: the page that stopped reloading does not ask for a reload by hand");
  return v;
}
