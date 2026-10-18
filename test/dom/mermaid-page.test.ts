// What the owner's page does with a mermaid block, in a DOM library against the real server and a stand-in for the diagram library
// (test/dom/mermaid-library.ts): a block in an item's head or log is drawn; a block that does not parse shows its source and the error
// and leaves the rest alone; the library is asked for once and only when a block is shown; the page asks it for strict security, the
// diagram's own text whole and the theme the owner's attribute or the system's scheme gives; the diagrams are drawn again after a live
// update repaints their item, the same diagram drawn twice has no id twice, and a diagram keeps its zoom and its box's scroll through a
// repaint. Each check also runs on a page with the one part it protects taken out, where it must report the part's absence. What the
// real library draws, and what only a layout shows, is the browser layer's (test/e2e/mermaid.e2e.ts). Docs/design.md, section 11.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard } from "../e2e/board-server.ts";
import type { BoardServer, Hooks } from "../e2e/board-server.ts";
import type { Revert } from "../e2e/variant.ts";
import { fence, GOOD, HEAD, OWN, PIPELINE } from "../e2e/mermaid-charts.ts";
import { scene, setHead, addLog, checkHead, checkLog, checkLazy, checkStrict, checkRepaint, checkIds, checkOwn, checkColors, checkTheme, checkKeep } from "./mermaid-checks.ts";
import type { Scene } from "./mermaid-checks.ts";
import { SPOILED } from "./mermaid-spoiled.ts";

const none = (v: string[]) => assert.equal(v.length, 0, v.length + " violations:\n" + v.join("\n"));
/** The check must report a line that says `why`. */
const caught = (v: string[], why: RegExp) => assert.ok(v.some(l => why.test(l)), `the check must report ${String(why)}; it reported:\n${v.join("\n") || "(nothing)"}`);

const seedHead = (board: BoardServer, id: string) => setHead(board, id, HEAD);
const seedLog = (board: BoardServer, id: string) => addLog(board, id, "日志里的图：\n\n" + fence(GOOD));
const seedOne = (board: BoardServer, id: string) => setHead(board, id, fence(GOOD));
// The first copy sits in the head's 参考 section, which is folded; the second is in the log, opened after the first is drawn.
const seedTwice = async (board: BoardServer, id: string) => { await setHead(board, id, "正文。\n\n**参考：同一张图**\n" + fence(GOOD)); await addLog(board, id, "同一张图又画一次：\n\n" + fence(GOOD)); };
const seedOwn = (board: BoardServer, id: string) => setHead(board, id, fence(OWN));
const seedPipeline = (board: BoardServer, id: string) => setHead(board, id, fence(PIPELINE));
const seedNone = (board: BoardServer, id: string) => setHead(board, id, "没有图，只有代码：\n\n```wf\nfn main() {}\n```");

test("the owner's page draws a mermaid block with the stand-in library and keeps its view", { timeout: 5 * 60_000 }, async t => {
  const board = await startBoard(t);
  // The scenes that write a log entry use an item of their own each, so no diagram of an earlier scene is in a later one's log.
  const items = Object.entries(board.store.snapshot().items).filter(([id, it]) => !it.record && id !== board.gen.witness.code).map(([id]) => id);
  const spare = (n: number) => items[n]!;
  /** The violations of `run` on a scene of `seed` with `reverts` on the witness item, or on `spare(own)`, and what the page reported. */
  async function on(st: Hooks, seed: (board: BoardServer, id: string) => Promise<void>, reverts: Revert[], run: (sc: Scene) => Promise<string[]>, own?: number): Promise<string[]> {
    const sc = await scene(st, board, seed, reverts, 600, own === undefined ? undefined : spare(own));
    return [...await run(sc), ...sc.bp.errors.map(e => "page-error: " + e)];
  }

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
