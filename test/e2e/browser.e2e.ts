// The browser layer: what only a real browser shows of the owner's page, in headless Chromium against the real server on a generated board
// (docs/design.md, section 11, Four test layers). A box's width and place, what a browser hides, hit-testing, scrolling, and what the real
// diagram library draws. Every other check of the page runs in the DOM layer (test/dom) or the fake DOM (test/web.test.ts) with its
// fix-reversed witnesses; this file has none, and it is kept small: one browser, one board, one page, at most 15 tests (the unit test
// test/browser-limits.test.ts holds the count) and 90 seconds (the workflow's `timeout`), run after a merge to the main line and every
// night (.github/workflows/browser.yml). A test is added here only when a script cannot see the fact, and the pull request says why.
// A new test is shown to fail on a page with the thing it guards spoiled, once, in the pull request that adds it.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ops } from "../../src/ops.ts";
import { startBoard, launch, BoardPage, openAll } from "./harness.ts";
import type { BoardServer } from "./harness.ts";
import type { Hooks } from "./board-server.ts";
import { oracle, checkFullWidth, checkPlanCardLayout, checkCardFold, checkDifficultyChipLayout, checkProgressBands } from "./invariants.ts";
import type { Oracle } from "./invariants.ts";
import {
  WAIT, narrow, probe, figures, round, settled, checkFit, checkHead, checkStrict, checkIds, checkOwn, checkZoom, checkActual, checkKeep, checkColors,
  seedHead, seedHostile, seedTwice, seedOwn, seedFit, seedPipeline, seedOne,
} from "./mermaid-checks.ts";

const LONG = { timeout: 5 * 60_000 };
const none = (v: string[]) => assert.equal(v.length, 0, v.length + " violations:\n" + v.slice(0, 60).join("\n"));

// One browser, one board and one page for the whole file; each test clears the viewer's state and reloads the page. The tests that
// write diagrams into an item's head come last, so that the right column's width probes (which look for the item with code in its head)
// meet the generated head.
const cleanups: Array<() => unknown> = [];
const hooks: Hooks = { after: fn => { cleanups.push(fn); } };
after(async () => { for (const fn of cleanups.reverse()) await fn(); });
let world: Promise<{ board: BoardServer; bp: BoardPage }> | undefined;
const open = () => world ??= (async () => {
  const board = await startBoard(hooks), browser = await launch(hooks);
  return { board, bp: await BoardPage.open(browser, board, openAll(board)) };
})();
/** The page freshly loaded with the viewer's state clear and every tree row unfolded. */
async function fresh() {
  const { board, bp } = await open();
  await bp.reset(openAll(board));
  return { board, bp };
}

test("the page loads, a click opens an item, and the page does not scroll sideways", LONG, async () => {
  const { board, bp } = await fresh();
  const rows = await bp.treeRows(), id = board.gen.witness.code;
  assert.ok(rows.length > 50, `the tree draws the generated board's items (${rows.length} rows)`);
  await bp.select(id);
  assert.equal(await bp.selected(), id, "a click on an item opens it");
  const [wide, window] = await bp.page.evaluate(() => [document.documentElement.scrollWidth, innerWidth] as const);
  assert.ok(wide <= window + 1, `the page is ${wide} px wide in a window of ${window} px`);
});

test("the right column's blocks fill their boxes at three window widths and nothing scrolls sideways", LONG, async () => {
  const { bp } = await fresh();
  none(await checkFullWidth(bp));
});

// Items whose plans name cards (every one); the witness cards (one of every shape) and a sample of the rest.
const planItems = (o: Oracle) => Object.keys(o.s.items).filter(id => o.s.items[id]!.plan.some(row => "card" in row));
const cardSample = (o: Oracle, w: BoardServer["gen"]["witness"]) => [...new Set([w.commentCard, w.multiPlanCard, w.donePlanCard, w.otherPlanCard, w.rowCard, w.recordCard, w.legacyCard, w.proseCard, w.withdrawnCard, w.openLegacyCard, ...Object.keys(o.s.decisions).slice(0, 30)])].filter(c => o.s.decisions[c]);

test("a plan's card rows keep their question link wide enough and a click brings the card into the pane", LONG, async () => {
  const { board, bp } = await fresh();
  const o = await oracle(board.store);
  none(await checkPlanCardLayout(bp, o, planItems(o)));
});

test("a closed card shows only its line while folded, and what is under it once the line is clicked", LONG, async () => {
  const { board, bp } = await fresh();
  const o = await oracle(board.store);
  none(await checkCardFold(bp, o, cardSample(o, board.gen.witness)));
});

test("progress bands are as wide as the plan's share, in both colour schemes", LONG, async () => {
  const { board, bp } = await fresh();
  none(await checkProgressBands(bp, await oracle(board.store)));
});

test("the difficulty chip lies on the tags' line, below the title", LONG, async () => {
  const { board, bp } = await fresh();
  none(await checkDifficultyChipLayout(bp, await oracle(board.store)));
});

test("the agent list lies above the projects, 在树中 scrolls the item's tree row into view and Back scrolls back", LONG, async () => {
  const { board, bp } = await fresh();
  const items = board.store.snapshot().items, rows = await bp.treeRows();
  // An open item drawn far down the tree, so a jump to its row has to scroll the list.
  const id = [...rows].reverse().find(row => items[row] && !items[row]!.record && items[row]!.group);
  assert.ok(id, "the generated board draws an open item in the tree");
  const base = await bp.changes();
  // A dispatch record that is unfinished and alive: the session is then running, so the list unfolds its row.
  await ops(board.store).dispatchStart({ author: items[id]!.group, id, role: "工程师", level: 2, model: "Sonnet", agent: "agent-x", agentId: "agent-x-id" });
  await bp.waitChanges(base + 1);
  const row = bp.page.locator('#agents [data-agent="agent-x"]');
  await row.waitFor();
  const layout = await bp.page.evaluate(() => {
    const agents = document.getElementById("agents")!, areas = document.getElementById("areas")!;
    const a = agents.getBoundingClientRect(), r = areas.getBoundingClientRect();
    return { aboveProjects: a.bottom <= r.top, drawn: a.height > 0 };
  });
  assert.deepEqual(layout, { aboveProjects: true, drawn: true });

  const top = await bp.page.evaluate(() => document.getElementById("page-left")!.scrollTop);
  await row.locator(".agitem-tree").first().click();
  await bp.settle();
  const landed = await bp.page.evaluate(id => {
    const tree = document.querySelector(`#areas [id="it-${id}"]`), pane = document.getElementById("page-left")!;
    if (!tree) return "no tree row";
    const r = tree.getBoundingClientRect(), p = pane.getBoundingClientRect();
    return r.top >= p.top - 1 && r.bottom <= p.bottom + 1 ? "in view" : `row ${r.top}..${r.bottom} outside the list ${p.top}..${p.bottom}`;
  }, id);
  assert.equal(landed, "in view", "the jump scrolls the tree row into view");
  const away = await bp.page.evaluate(() => document.getElementById("page-left")!.scrollTop);
  assert.ok(away > top + 500, `the jump scrolled the list well away from the agent list (${top} to ${away})`);
  await bp.page.locator("#backbtn").click();
  await bp.settle();
  const back = await bp.page.evaluate(() => document.getElementById("page-left")!.scrollTop);
  assert.ok(Math.abs(back - top) <= 2, `Back scrolls the list back to where the agent list was (${top}, now ${back})`);
});

test("nothing on the page covers the list of messages once it is open", LONG, async () => {
  const { board, bp } = await fresh();
  const items = board.store.snapshot().items;
  const item = Object.keys(items).find(id => !items[id]!.record && items[id]!.group);
  assert.ok(item, "the generated board has an open item");
  const base = await bp.changes();
  await ops(board.store).sendMessage({ author: items[item]!.group, session: "agent-x", to: "架构师", text: "看这个条目的日志，等你回", item });
  await bp.waitChanges(base + 1);
  await bp.page.locator("#messages .messages-toggle").click();
  await bp.settle();
  const row = bp.page.locator("#messages-panel .message").first();
  await row.waitFor();
  const onTop = await row.evaluate(e => {
    const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && e.contains(hit);
  });
  assert.equal(onTop, true, "nothing on the page covers the list");
});

// The tests from here write diagrams into the head of the item `witness.code` and select it, on a page loaded afterwards.
async function show(seed: (board: BoardServer, id: string) => Promise<void>) {
  const { board, bp } = await open(), id = board.gen.witness.code;
  await seed(board, id);
  await bp.reset();
  await bp.select(id);
  return { board, bp, id };
}
/** Runs `fn` with the window narrowed (about a phone held sideways, where the page puts the list and the detail in two narrow columns), and puts the window back at 1500. */
async function atNarrow<T>(bp: BoardPage, fn: () => Promise<T>): Promise<T> {
  await narrow(bp);
  try { return await fn(); } finally { await bp.page.setViewportSize({ width: 1500, height: 1000 }); await bp.settle(); }
}

test("the real library draws a head's diagrams and shows a bad one's error, runs no hostile text, names its ids apart and applies a diagram's own settings", LONG, async () => {
  const v: string[] = [];
  v.push(...await checkHead((await show(seedHead)).bp, WAIT));
  const hostile = await show(seedHostile);
  await probe(hostile.bp);
  v.push(...await checkStrict(hostile.bp, WAIT));
  v.push(...await checkIds((await show(seedTwice)).bp, WAIT));
  v.push(...await checkOwn((await show(seedOwn)).bp, WAIT));
  none(v);
});

test("a diagram is as wide as itself or as its box, whichever is less, in a window 1500 and one 700 px wide, and neither its box nor the page scrolls sideways", LONG, async t => {
  const { bp } = await show(seedFit);
  /** Prints each diagram's own width and its box's, to the CI log: how much of the checks' diagrams the box shrinks at this window. */
  const sizes = async (window: string) => {
    if (await settled(bp, 3, WAIT)) return;
    t.diagnostic(`at a window ${window}: ` + (await figures(bp)).figs.map((f, i) => `${["small", "wide", "tall"][i]} ${round(f.natural)} px in a box of ${f.box} px, drawn ${round(f.drawn)} px`).join("; "));
  };
  await sizes("1500 px wide");
  const wide = await checkFit(bp, WAIT);
  const narrowed = await atNarrow(bp, async () => { await sizes("700 px wide"); return checkFit(bp, WAIT); });
  none([...wide, ...narrowed]);
});

test("the buttons and Ctrl with the wheel zoom, the plain wheel scrolls the page, an enlarged diagram scrolls to both ends and can be dragged, and fit to width restores the default size", LONG, async () => {
  none(await checkZoom((await show(seedPipeline)).bp, WAIT));
});

test("the 60%, 90% and 100% buttons draw a diagram wider than its box at its share of its own size, in a narrow column", LONG, async () => {
  const { bp } = await show(seedPipeline);
  none(await atNarrow(bp, () => checkActual(bp, WAIT)));
});

test("a live update that leaves a diagram's source alone leaves its view alone, and one that changes the source starts it at the default size", LONG, async () => {
  const { bp, board, id } = await show(seedPipeline);
  none(await checkKeep(bp, board, id, WAIT));
});

test("labels and lines read in the light and the dark scheme, and a change of scheme redraws the diagram", LONG, async () => {
  none(await checkColors((await show(seedOne)).bp, WAIT));
});
