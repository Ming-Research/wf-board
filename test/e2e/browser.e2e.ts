// The browser layer: what only a real browser shows of the owner's page, in headless Chromium against the real server on a generated board
// (docs/design.md, section 11, The browser file). A box's width and place, what a browser hides, hit-testing, scrolling, and what the real
// diagram library draws. Every other check of the page runs in the DOM layer (test/dom) or the fake DOM (test/web.test.ts) with its
// fix-reversed witnesses; this file has none, and it is kept small: one browser, one board, one page, at most 15 tests (the unit test
// test/browser-limits.test.ts holds the count) and 90 seconds (the workflow's `timeout`), run after a merge to the main line and every
// night (.github/workflows/browser.yml). A test is added here only when a script cannot see the fact, and the pull request says why.
// A new test is shown to fail on a page with the thing it guards spoiled, once, in the pull request that adds it.
// The checks are in invariants.ts (the page's layout), browser-checks.ts, mermaid-checks.ts and mermaid-compact.ts; each test only picks the page's state for one.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startBoard, launch, BoardPage, openAll } from "./harness.ts";
import type { BoardServer } from "./harness.ts";
import type { Hooks } from "./board-server.ts";
import { oracle, checkFullWidth, checkPlanCardLayout, checkCardFold, checkDifficultyChipLayout, checkProgressBands } from "./invariants.ts";
import { checkSmoke, planItems, cardSample, checkAgentList, checkMessages } from "./browser-checks.ts";
import { checkCompact } from "./mermaid-compact.ts";
import { WAIT, showHead, atNarrow, checkLibrary, checkFitWindows, checkZoom, checkActual, checkKeep, checkColors, seedPipeline, seedOne } from "./mermaid-checks.ts";

const LONG = { timeout: 5 * 60_000 };
const none = (v: string[]) => assert.equal(v.length, 0, v.length + " violations:\n" + v.slice(0, 60).join("\n"));

// One browser, one board and one page for the whole file; each test clears the viewer's state and reloads the page. The tests that write
// diagrams into an item's head come last, so that the right column's width probes (which look for the item with code in its head) meet
// the generated head.
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
  none(await checkSmoke(bp, board));
});

test("the right column's blocks fill their boxes at three window widths and nothing scrolls sideways", LONG, async () => {
  none(await checkFullWidth((await fresh()).bp));
});

test("a plan's card rows keep their question link wide enough and a click brings the card into the pane", LONG, async () => {
  const { board, bp } = await fresh(), o = await oracle(board.store);
  none(await checkPlanCardLayout(bp, o, planItems(o)));
});

test("a closed card shows only its line while folded, and what is under it once the line is clicked", LONG, async () => {
  const { board, bp } = await fresh(), o = await oracle(board.store);
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
  none(await checkAgentList(bp, board));
});

test("nothing on the page covers the list of messages once it is open", LONG, async () => {
  const { board, bp } = await fresh();
  none(await checkMessages(bp, board));
});

test("the real library draws a head's diagrams and shows a bad one's error, runs no hostile text, names its ids apart and applies a diagram's own settings", LONG, async () => {
  const { board, bp } = await open();
  none(await checkLibrary(bp, board));
});

test("a diagram is as wide as itself or as its box, whichever is less, in a window 1500 and one 700 px wide, and neither its box nor the page scrolls sideways", LONG, async t => {
  const { board, bp } = await open();
  none(await checkFitWindows(bp, board, line => t.diagnostic(line)));
});

test("the buttons and Ctrl with the wheel zoom, the plain wheel scrolls the page, an enlarged diagram scrolls to both ends and can be dragged, and fit to width restores the default size", LONG, async () => {
  const { board, bp } = await open();
  await showHead(bp, board, seedPipeline);
  none(await checkZoom(bp, WAIT));
});

test("the 60%, 90% and 100% buttons draw a diagram wider than its box at its share of its own size, in a narrow column", LONG, async () => {
  const { board, bp } = await open();
  await showHead(bp, board, seedPipeline);
  none(await atNarrow(bp, () => checkActual(bp, WAIT)));
});

test("a live update that leaves a diagram's source alone leaves its view alone, and one that changes the source starts it at the default size", LONG, async () => {
  const { board, bp } = await open();
  const id = await showHead(bp, board, seedPipeline);
  none(await checkKeep(bp, board, id, WAIT));
});

test("labels and lines read in the light and the dark scheme, and a change of scheme redraws the diagram", LONG, async () => {
  const { board, bp } = await open();
  await showHead(bp, board, seedOne);
  none(await checkColors(bp, WAIT));
});

test("a role's chart, a chart with lanes and one with its own gaps are drawn short, 20 px or the asked gap apart, with arrows entering from above and nothing covering anything", LONG, async t => {
  const { board, bp } = await open();
  none(await checkCompact(bp, board, line => t.diagnostic(line)));
});
