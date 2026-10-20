// What the owner's page does with a drawn mermaid block afterwards, in a DOM library against the real server and a stand-in for the
// diagram library (test/dom/mermaid-library.ts): the diagrams are drawn again after a live update repaints their item, the same diagram
// drawn twice has no id twice, a diagram's own settings win, a diagram keeps its view through a repaint that leaves its source alone, and
// the theme follows the owner's attribute or the system's scheme. Each check also runs on a page with the one part it protects taken out,
// where it must report the part's absence. The first drawing is test/dom/mermaid-page.test.ts. Docs/design.md, section 11.

import { test } from "node:test";
import { startBoard } from "../e2e/board-server.ts";
import { HEAD } from "../e2e/mermaid-charts.ts";
import { checkRepaint, checkIds, checkOwn, checkColors, checkTheme, checkKeep } from "./mermaid-checks.ts";
import { SPOILED } from "./mermaid-spoiled.ts";
import { none, caught } from "./mermaid-view.ts";
import { seedHead, seedOne, seedTwice, seedOwn, seedPipeline, scenesOn } from "./mermaid-page.ts";

test("the owner's page draws a mermaid block again after an update and keeps its view and its colors", { timeout: 5 * 60_000 }, async t => {
  const on = scenesOn(await startBoard(t));

  await t.test("a diagram is a diagram again after a live update repaints its item", async st => none(await on(st, seedHead, [], sc => checkRepaint(sc, HEAD))));
  await t.test("the same check on a page that draws only its first render reports the code left behind", async st => {
    // The blocks are in the page after a repaint, and none of them was drawn. (The page repaints the item once it is selected, so the
    // window shows it before the check's own update as often as after.)
    caught(await on(st, seedHead, [SPOILED.firstOnly, SPOILED.lateDraw], sc => checkRepaint(sc, HEAD)), /^mermaid-repaint: (before the update|after the live update), expected [34] mermaid blocks drawn; found [34] blocks, states none(,none)+/);
  });

  await t.test("the same diagram drawn twice, the first in a folded section, has no id twice and the visible copy keeps its own markers", async st => none(await on(st, seedTwice, [], checkIds, 2)));
  await t.test("the same check on a page whose second copy keeps the first copy's ids reports the repeated ids and the markers outside the visible diagram", async st => {
    const v = await on(st, seedTwice, [SPOILED.sameIds], checkIds, 3);
    caught(v, /^mermaid-ids: \d+ ids are in the page twice/);
    caught(v, /^mermaid-ids: the visible diagram's lines point at markers outside it/);
  });

  await t.test("a diagram's own frontmatter settings reach the library whole, so they win over the page's", async st => none(await on(st, seedOwn, [], checkOwn)));
  await t.test("the same check on a page that takes the frontmatter off before drawing reports the page's colors", async st => caught(await on(st, seedOwn, [SPOILED.ignoreOwn], checkOwn), /^mermaid-own: the diagram asks for the dark theme in its frontmatter and the page does not use it/));

  await t.test("a live update that leaves a diagram's source alone leaves its view alone, and one that changes the source starts it at the default size", async st => none(await on(st, seedPipeline, [], checkKeep)));
  await t.test("the same check on a page that forgets the view reports the size", async st => caught(await on(st, seedPipeline, [SPOILED.forgetView], checkKeep), /^mermaid-keep: after a live update that left its source alone the diagram is/));
  await t.test("the same check on a page that keeps one view for every source reports the changed diagram", async st => caught(await on(st, seedPipeline, SPOILED.oneView, checkKeep), /^mermaid-keep: a diagram whose source changed/));

  await t.test("a change of the system's color scheme redraws the open diagram in the colors of that scheme", async st => none(await on(st, seedOne, [], checkColors)));
  await t.test("the same check on a page that draws in the light colors only reports that the dark colors never came", async st => caught(await on(st, seedOne, [SPOILED.lightOnly], checkColors), /^mermaid-colors \(dark\): the diagram did not take the dark colors/));

  await t.test("the owner's data-theme attribute wins over the system's scheme, both ways round", async st => none(await on(st, seedOne, [], checkTheme)));
  await t.test("the same check on a page that reads only the system's scheme reports the attribute not followed", async st => caught(await on(st, seedOne, [SPOILED.systemOnly], checkTheme), /^mermaid-theme \(dark data-theme over a light system\): the diagram did not take the dark colors/));
});
