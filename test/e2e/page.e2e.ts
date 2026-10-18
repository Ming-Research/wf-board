// The owner's page in headless Chromium against the real server, on a generated board with the real board's shapes: what needs a
// layout. Where a box lands, how wide it is and what a browser hides; every other click on the page is checked in a DOM library
// (test/dom/page-families.ts). Run by CI's e2e job (npm run test:e2e), not on the owner's Mac.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard, launch, BoardPage, openAll } from "./harness.ts";
import { oracle, burst, checkPlanCardLayout, checkCardFold, checkDifficultyChipLayout, checkProgressBands } from "./invariants.ts";
import type { Oracle } from "./invariants.ts";

const none = (v: string[]) => assert.equal(v.length, 0, v.length + " violations:\n" + v.slice(0, 60).join("\n"));

test("the owner's page lays out what its clicks lead to", { timeout: 10 * 60_000 }, async t => {
  const board = await startBoard(t), browser = await launch(t), w = board.gen.witness;
  const bp = await BoardPage.open(browser, board, openAll(board));
  // Items whose plans name cards (every one); the witness cards (one of every shape) and a sample of the rest.
  const planItems = (o: Oracle) => Object.keys(o.s.items).filter(id => o.s.items[id]!.plan.some(row => "card" in row));
  const cardSample = (o: Oracle) => [...new Set([w.commentCard, w.multiPlanCard, w.donePlanCard, w.otherPlanCard, w.rowCard, w.recordCard, w.legacyCard, w.proseCard, w.withdrawnCard, w.openLegacyCard, ...Object.keys(o.s.decisions).slice(0, 30)])].filter(c => o.s.decisions[c]);
  const families: Array<[string, (o: Oracle) => Promise<string[]>]> = [
    ["a plan's card rows keep their question link wide enough and a click brings the card into the pane", o => checkPlanCardLayout(bp, o, planItems(o))],
    ["a closed card shows only its line while folded, and what is under it once the line is clicked", o => checkCardFold(bp, o, cardSample(o))],
    ["progress bands: as wide as the plan's share, in both colour schemes", o => checkProgressBands(bp, o)],
  ];
  for (const [name, run] of families) await t.test("fresh page: " + name, async () => {
    await bp.reset(openAll(board));
    none(await run(await oracle(board.store)));
  });
  // One page stays open; before each family a burst of writes lands on other items.
  await bp.reset(openAll(board));
  let round = 0;
  for (const [name, run] of families) await t.test("after writes elsewhere: " + name, async () => {
    const base = await bp.changes(), n = await burst(board, ++round);
    await bp.waitChanges(base + n);
    none(await run(await oracle(board.store)));
  });
  await t.test("the difficulty chip lies on the tags' line, below the title", async () => {
    await bp.reset(openAll(board));
    none(await checkDifficultyChipLayout(bp, await oracle(board.store)));
  });
});
