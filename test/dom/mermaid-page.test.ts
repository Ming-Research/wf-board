// What the owner's page does with a mermaid block, in a DOM library against the real server and a stand-in for the diagram library
// (test/dom/mermaid-library.ts): a block in an item's head or log is drawn; a block that does not parse shows its source and the error
// and leaves the rest alone; the library is asked for once and only when a block is shown; the page asks it for strict security, a
// compact drawing and chart colors that follow the scheme. Each check also runs on a page with the one part it protects taken out,
// where it must report the part's absence. The diagrams drawn again after an update, their ids, their own settings, their view and their
// colors are test/dom/mermaid-redraw.test.ts; what the real library draws, and what only a layout shows, is the browser layer's
// (test/e2e/browser.e2e.ts). Docs/design.md, section 11.

import { test } from "node:test";
import { startBoard } from "../e2e/board-server.ts";
import { checkHead, checkLog, checkLazy, checkStrict, checkCompact, checkChartConfig } from "./mermaid-checks.ts";
import { SPOILED } from "./mermaid-spoiled.ts";
import { none, caught } from "./mermaid-view.ts";
import { seedHead, seedLog, seedOne, seedNone, scenesOn } from "./mermaid-page.ts";

test("the owner's page draws a mermaid block with the stand-in library", { timeout: 5 * 60_000 }, async t => {
  const on = scenesOn(await startBoard(t));

  await t.test("a mermaid block in an item's head is a diagram; a bad one shows its source and the error", async st => none(await on(st, seedHead, [], checkHead)));
  await t.test("the same check on a page that never wraps mermaid blocks reports that no block is drawn", async st => {
    const v = await on(st, seedHead, [SPOILED.noWrap], checkHead);
    caught(v, /^mermaid-head: expected 3 mermaid blocks drawn; found 0 blocks/);
    caught(v, /^mermaid-head: the head's diagram source is shown as plain code/);
  });
  await t.test("the same check on a page that shows no error under a bad block reports the missing error", async st => caught(await on(st, seedHead, [SPOILED.noError], checkHead), /^mermaid-head: the bad block shows no error/));

  await t.test("a mermaid block in a log entry is a diagram", async st => none(await on(st, seedLog, [], checkLog, 0)));
  await t.test("the same check on a page that never wraps mermaid blocks reports that the log holds no block drawn", async st => {
    const v = await on(st, seedLog, [SPOILED.noWrap], checkLog, 1);
    caught(v, /^mermaid-log: expected 1 mermaid blocks drawn; found 0 blocks/);
    caught(v, /^mermaid-log: the log's diagram source is shown as plain code/);
  });

  await t.test("a page with no diagram never asks for the library; one with diagrams asks for it once", async st => {
    none(await on(st, seedNone, [], sc => checkLazy(sc, 0)));
    none(await on(st, seedHead, [], sc => checkLazy(sc, 3)));
  });
  await t.test("the same check on a page that loads the library at start reports the request", async st => caught(await on(st, seedNone, [SPOILED.eager], sc => checkLazy(sc, 0)), /^mermaid-lazy: a page with 0 diagrams asked for the library 1 times, expected none/));

  await t.test("the page configures the library with the strict security level", async st => none(await on(st, seedOne, [], checkStrict)));
  await t.test("the same check on a page that asks for the loose security level reports the level", async st => caught(await on(st, seedOne, [SPOILED.loose], checkStrict), /^mermaid-strict: the page configured the library with security level "loose", not "strict"/));

  await t.test("the page configures the library for a compact drawing: the classic look, padding 8 and gaps of 20", async st => none(await on(st, seedOne, [], checkCompact)));
  await t.test("the same check on a page that asks the library for nothing of the look and the gaps reports the configuration", async st => caught(await on(st, seedOne, [SPOILED.noCompact], checkCompact), /^mermaid-config: the page configured the library with \{\}, not/));

  await t.test("the page configures the library for a data chart: series colors that follow the color scheme, a clear plate and a height of 360", async st => none(await on(st, seedOne, [], checkChartConfig)));
  await t.test("the same check on a page that gives the library no chart colors reports the colors and the plate", async st => {
    const v = await on(st, seedOne, [SPOILED.noChartColors], checkChartConfig);
    caught(v, /^mermaid-chart \(dark\): the page gave the library the series colors undefined, not/);
    caught(v, /^mermaid-chart \(light\): the page gave the library the chart plate undefined, not "transparent"/);
  });
  await t.test("the same check on a page that keeps the light chart colors in the dark scheme reports the dark colors missing", async st => caught(await on(st, seedOne, [SPOILED.lightChartColors], checkChartConfig), /^mermaid-chart \(dark\): the page gave the library the series colors "#2a78d6,/));
  await t.test("the same check on a page that leaves a chart at the library's height reports the height", async st => caught(await on(st, seedOne, [SPOILED.noChartSize], checkChartConfig), /^mermaid-chart \(dark\): the page gave the library the chart height undefined, not 360/));
});
