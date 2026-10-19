// The diagram's toolbar on the owner's page, in a DOM library against a stand-in for the diagram library and a model of the boxes
// (test/dom/mermaid-layout.ts): the 60%, 90% and 100% buttons draw a diagram at that share of its own width; the toolbar is the top row
// of the frame with its items in order and the hint at the right; an enlarged diagram says it can be moved (a scroll bar that stays,
// the hand, a word in the bar, a shade at the edge) and the bar reads in both color schemes. Each check also runs on a page with the
// one part it protects taken out, where it must report the part's absence. The size and the zoom are test/dom/mermaid-view.test.ts,
// the helpers both use test/dom/mermaid-view.ts. Docs/design.md, section 11.

import { test } from "node:test";
import { startBoard } from "../e2e/board-server.ts";
import { checkActual, checkBar, checkPan } from "./mermaid-checks.ts";
import { SPOILED } from "./mermaid-spoiled.ts";
import { caught, none, seedPipeline, viewOn } from "./mermaid-view.ts";

test("the owner's page draws a diagram at a share of its width, its toolbar is the frame's top row, and its toolbar and scroll bar read in both color schemes", { timeout: 5 * 60_000 }, async t => {
  const board = await startBoard(t), on = viewOn(board);
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
