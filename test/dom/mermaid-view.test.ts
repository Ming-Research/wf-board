// The diagram's box and toolbar on the owner's page, in a DOM library against a stand-in for the diagram library and a model of the
// boxes (test/dom/mermaid-layout.ts, whose widths are the page's own stylesheet evaluated): a diagram is as wide as itself or its box,
// whichever is less, never larger, centered when narrow, with nothing to scroll sideways at the default size; the buttons and Ctrl with
// the wheel zoom by a step about a point that stays put, the plain wheel is left to the page, an enlarged diagram is dragged and fit to
// width gives the default size back; the 60%, 90% and 100% buttons draw it at that share of its own width; the toolbar is the top row of
// the frame with its items in order and the hint at the right; an enlarged diagram says it can be moved (a scroll bar that stays, the
// hand, a word in the bar, a shade at the edge) and the bar reads in both color schemes. Each check also runs on a page with the one part
// it protects taken out, where it must report the part's absence. What a real browser lays out (the ends of an enlarged diagram, the
// native wheel, the width at real window sizes) is the browser layer's (test/e2e/mermaid.e2e.ts). Docs/design.md, section 11.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard } from "../e2e/board-server.ts";
import type { BoardServer, Hooks } from "../e2e/board-server.ts";
import type { Revert } from "../e2e/variant.ts";
import { fence, FIT_HEAD, PIPELINE } from "../e2e/mermaid-charts.ts";
import { scene, setHead, checkFit, checkZoom, checkActual, checkBar, checkPan } from "./mermaid-checks.ts";
import type { Scene } from "./mermaid-checks.ts";
import { SPOILED } from "./mermaid-spoiled.ts";

const none = (v: string[]) => assert.equal(v.length, 0, v.length + " violations:\n" + v.join("\n"));
/** The check must report a line that says `why`. */
const caught = (v: string[], why: RegExp) => assert.ok(v.some(l => why.test(l)), `the check must report ${String(why)}; it reported:\n${v.join("\n") || "(nothing)"}`);

const seedFit = (board: BoardServer, id: string) => setHead(board, id, FIT_HEAD);
const seedPipeline = (board: BoardServer, id: string) => setHead(board, id, fence(PIPELINE));

test("the owner's page sizes, zooms and drags a diagram in its box, and its toolbar and scroll bar read in both color schemes", { timeout: 5 * 60_000 }, async t => {
  const board = await startBoard(t);
  /** The violations of `run` on a scene of `seed` with `reverts`, and what the page reported. */
  async function on(st: Hooks, seed: (board: BoardServer, id: string) => Promise<void>, reverts: Revert[], run: (sc: Scene) => Promise<string[]>): Promise<string[]> {
    const sc = await scene(st, board, seed, reverts);
    return [...await run(sc), ...sc.bp.errors.map(e => "page-error: " + e)];
  }

  await t.test("a diagram is as wide as itself or as its box, whichever is less, and neither its box nor the page scrolls sideways", async st => none(await on(st, seedFit, [], checkFit)));
  await t.test("the same check on a page that draws every diagram at its own width reports the size, the box that scrolls and the drag it offers", async st => {
    const v = await on(st, seedFit, [SPOILED.fixedSize], checkFit);
    caught(v, /^mermaid-fit: the (wide|tall) diagram is drawn \d+ px wide; it should be/);
    caught(v, /^mermaid-fit: the box of the (wide|tall) diagram scrolls sideways at the default size/);
    caught(v, /^mermaid-fit: the (wide|tall) diagram says it can be dragged at the default size/);
  });
  await t.test("the same check on a page that draws every diagram at its own width in a box that does not scroll reports the page scrolling sideways", async st => {
    caught(await on(st, seedFit, [SPOILED.fixedSize, SPOILED.noScroll], checkFit), /^mermaid-fit: the page scrolls sideways: /);
  });
  await t.test("the same check on a page that does not center a small diagram reports where it sits", async st => caught(await on(st, seedFit, [SPOILED.noCenter], checkFit), /^mermaid-fit: the small diagram is not centered/));

  await t.test("the buttons and Ctrl with the wheel zoom, the toolbar shows the size, the plain wheel is left to the page, an enlarged diagram can be dragged, and fit to width restores the default size", async st => none(await on(st, seedPipeline, [], checkZoom)));
  await t.test("the same check on a page without the toolbar reports the missing buttons", async st => caught(await on(st, seedPipeline, [SPOILED.noTools], checkZoom), /^mermaid-zoom: the diagram has no (缩小|放大|适应宽度) button/));
  await t.test("the same check on a page where the plain wheel zooms reports the page not left the event", async st => {
    caught(await on(st, seedPipeline, [SPOILED.wheelZoomsAll], checkZoom), /^mermaid-zoom: the plain wheel over the diagram (did not scroll the page|zoomed it)/);
  });
  await t.test("the same check on a page that cannot drag reports the box and the page not moved", async st => {
    const v = await on(st, seedPipeline, [SPOILED.noDrag], checkZoom);
    caught(v, /^mermaid-zoom: dragging the enlarged diagram 120 px to the left moved its box/);
    caught(v, /^mermaid-zoom: dragging the enlarged diagram 80 px up moved the page/);
  });
  await t.test("the same check on a page whose drag leaves the page alone reports the page not moved", async st => {
    const v = await on(st, seedPipeline, [SPOILED.noVerticalDrag], checkZoom);
    caught(v, /^mermaid-zoom: dragging the enlarged diagram 80 px up moved the page/);
    assert.ok(!v.some(l => /to the left moved its box/.test(l)), "the sideways drag still works there, so only the page line is reported:\n" + v.join("\n"));
  });
  await t.test("the same check on a page whose zoom keeps the scroll reports the point under the cursor moving sideways", async st => caught(await on(st, seedPipeline, [SPOILED.noAnchorX], checkZoom), /^mermaid-zoom: Ctrl and the wheel moved the point under the cursor from/));
  await t.test("the same check on a page whose zoom keeps the page scroll reports the point under the cursor moving along the page", async st => caught(await on(st, seedPipeline, [SPOILED.noAnchorY], checkZoom), /^mermaid-zoom: Ctrl and the wheel moved the point under the cursor from/));
  await t.test("the same check on a page whose fit to width does nothing reports the size it was left at", async st => caught(await on(st, seedPipeline, [SPOILED.resetNothing], checkZoom), /^mermaid-zoom: after 适应宽度 the diagram is \d+ px wide, scrolled \d+ px/));
  await t.test("the same check on a page whose diagram box does not scroll reports the box", async st => caught(await on(st, seedPipeline, [SPOILED.noScroll], checkZoom), /^mermaid-zoom: the enlarged diagram's box does not scroll sideways/));
  await t.test("the same check on a page whose toolbar shows a stale size reports the percentage", async st => caught(await on(st, seedPipeline, [SPOILED.staleSize], checkZoom), /^mermaid-zoom: the toolbar says "\d+%" for a diagram drawn at/));

  await t.test("the 60%, 90% and 100% buttons draw a diagram wider than its box at its share of its own size, the one shown is pressed, and pressed again it gives the box's width back", async st => none(await on(st, seedPipeline, [], checkActual)));
  await t.test("the same check on a page whose diagram button draws the box's width reports the size", async st => caught(await on(st, seedPipeline, [SPOILED.actualIsFit], checkActual), /^mermaid-actual: the 60% button draws the diagram/));

  await t.test("the toolbar is the top row of the diagram's frame: smaller, size, larger, fit to width, 60%, 90%, 100%, and the hint at the right", async st => none(await on(st, seedPipeline, [], checkBar)));
  await t.test("the same check on a page with no frame around the diagram reports the frame", async st => caught(await on(st, seedPipeline, [SPOILED.noFrame], checkBar), /^mermaid-bar: the block has no frame/));
  await t.test("the same check on a page whose toolbar is below the diagram reports where it is", async st => caught(await on(st, seedPipeline, [SPOILED.barBelow], checkBar), /^mermaid-bar: the toolbar is not above the diagram/));
  await t.test("the same check on a page whose size comes after larger reports the order", async st => caught(await on(st, seedPipeline, [SPOILED.sizeSwapped], checkBar), /^mermaid-bar: the toolbar reads, left to right/));
  await t.test("the same check on a page whose hint sits at the left of its row reports the hint", async st => caught(await on(st, seedPipeline, [SPOILED.hintLeft], checkBar), /^mermaid-bar: the hint is not at the right/));
  await t.test("the same check on a page with another hint text reports the text", async st => caught(await on(st, seedPipeline, [SPOILED.wrongHint], checkBar), /^mermaid-bar: the hint reads/));
  await t.test("the same check on a page that hides the hint reports it", async st => caught(await on(st, seedPipeline, [SPOILED.noHint], checkBar), /^mermaid-bar: the hint is not shown/));

  await t.test("an enlarged diagram says it can be moved, in both color schemes", async st => none(await on(st, seedPipeline, [], checkPan)));
  await t.test("the same check on a page without its own scroll bar reports the bar", async st => caught(await on(st, seedPipeline, [SPOILED.noScrollbar], checkPan), /^mermaid-pan: the box of a diagram that can be dragged has no scroll bar of its own/));
  await t.test("the same check on a page without the hint reports the hint", async st => caught(await on(st, seedPipeline, [SPOILED.noHint], checkPan), /^mermaid-pan: the toolbar of a diagram that can be dragged does not say so/));
  await t.test("the same check on a page without the grabbing hand reports the cursor", async st => caught(await on(st, seedPipeline, [SPOILED.noGrab], checkPan), /^mermaid-pan: a diagram that can be dragged shows the cursor/));
  await t.test("the same check on a page without the shades at the edges reports the edge", async st => caught(await on(st, seedPipeline, [SPOILED.noShade], checkPan), /^mermaid-pan: an enlarged diagram at its left edge does not show a shade on its right alone/));
  await t.test("the same check on a page whose buttons keep their light-scheme ink reports the buttons in the dark scheme", async st => caught(await on(st, seedPipeline, [SPOILED.fixedInk], checkPan), /^mermaid-pan \(dark\): the words on the buttons read/));
  await t.test("the same check on a page whose scroll bar keeps its light-scheme color reports the bar in the dark scheme", async st => caught(await on(st, seedPipeline, [SPOILED.fixedThumb], checkPan), /^mermaid-pan \(dark\): the scroll bar reads/));
});
