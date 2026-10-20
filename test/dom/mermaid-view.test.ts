// The diagram's box on the owner's page, in a DOM library against a stand-in for the diagram library and a model of the boxes
// (test/dom/mermaid-layout.ts, whose widths are the page's own stylesheet evaluated): a diagram is as wide as itself or its box,
// whichever is less, never larger, centered when narrow, with nothing to scroll sideways at the default size; the buttons and Ctrl with
// the wheel zoom by a step about a point that stays put, the plain wheel is left to the page, an enlarged diagram is dragged and fit to
// width gives the default size back. Each check also runs on a page with the one part it protects taken out, where it must report the
// part's absence. The toolbar's own checks are test/dom/mermaid-toolbar.test.ts, the helpers both use test/dom/mermaid-view.ts. What a
// real browser lays out (the ends of an enlarged diagram, the native wheel, the width at real window sizes) is the browser layer's
// (test/e2e/browser.e2e.ts). Docs/design.md, section 11.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard } from "../e2e/board-server.ts";
import { checkFit, checkZoom } from "./mermaid-checks.ts";
import { SPOILED } from "./mermaid-spoiled.ts";
import { caught, none, seedFit, seedPipeline, viewOn } from "./mermaid-view.ts";

test("the owner's page sizes, zooms and drags a diagram in its box", { timeout: 5 * 60_000 }, async t => {
  const board = await startBoard(t), on = viewOn(board);
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
});
