// The owner's page in headless Chromium against the real server, on a generated board with the real board's shapes.
// Every kind of clickable thing must land on what it claims: first on a freshly loaded page per family, then on one
// page kept open while sessions write elsewhere between the families, so incremental re-renders happen in between.
// Run by CI's e2e job (npm run test:e2e), not on the owner's Mac.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard, launch, BoardPage, openAll } from "./harness.ts";
import { oracle, burst, checkTreeRows, checkPlanRows, checkDependents, checkBadges, checkWaitPanel, checkFresh, checkFilters, checkSearch, checkComments, checkCodeFont, checkEmptyRows, checkTagChips, checkDifficultyChip } from "./invariants.ts";
import type { Oracle } from "./invariants.ts";

const none = (v: string[]) => assert.equal(v.length, 0, v.length + " violations:\n" + v.slice(0, 60).join("\n"));

test("the owner's page lands every click on what it claims", { timeout: 40 * 60_000 }, async t => {
  const board = await startBoard(t), browser = await launch(t), w = board.gen.witness;
  const bp = await BoardPage.open(browser, board, openAll(board));
  // Items whose plans name cards (every one), share other items, or own items (a sample); items with dependents.
  const planItems = (o: Oracle) => {
    const ids = Object.keys(o.s.items), plan = (id: string) => o.s.items[id]!.plan;
    return [...new Set([
      ...ids.filter(id => plan(id).some(row => "card" in row)),
      ...ids.filter(id => plan(id).some(row => "item" in row && !row.own)).slice(0, 20),
      ...ids.filter(id => plan(id).some(row => "item" in row && row.own)).slice(0, 8),
    ])];
  };
  const depItems = (o: Oracle) => Object.keys(o.s.items).filter(id => o.r.dependents(id).some(d => !d.own)).slice(0, 25);
  const families: Array<[string, (o: Oracle) => Promise<string[]>]> = [
    ["tree rows select their item", o => checkTreeRows(bp, o)],
    ["plan rows: items go there, cards unfold in place, steps select", o => checkPlanRows(bp, o, planItems(o))],
    ["dependent rows go to their item and Back returns", o => checkDependents(bp, o, depItems(o))],
    ["purple and red numbers count and reach their own waits", o => checkBadges(bp, o)],
    ["header wait numbers and the wait panel", o => checkWaitPanel(bp, o)],
    ["blue numbers, the 新 number and n", o => checkFresh(bp, o)],
    ["project filters count, show and hide the right items", o => checkFilters(bp, o)],
    ["search finds and shows items and cards", o => checkSearch(bp, o)],
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
  await t.test("code blocks are set in Monaco", async () => {
    await bp.reset(openAll(board));
    none(await checkCodeFont(bp, await oracle(board.store)));
  });
  await t.test("no empty row under an item's title", async () => {
    await bp.reset(openAll(board));
    const o = await oracle(board.store), ids = Object.keys(o.s.items), st = (id: string) => o.r.statusOf(id);
    const sample = [w.unpaused, w.pausedRoot, w.code, ...o.r.children(w.pausedRoot).slice(0, 1), ids.find(id => o.s.items[id]!.record), ids.find(id => st(id) === "done"),
      ids.find(id => st(id) === "cancelled"), ids.find(id => st(id) === "blocked"), ids.find(id => o.r.askPending(id))].filter((id): id is string => !!id);
    none(await checkEmptyRows(bp, [...new Set(sample)]));
  });
  await t.test("tag chips name the item's tags and read at 4.5:1 or more", async () => {
    await bp.reset(openAll(board));
    await bp.select(w.unpaused);
    none(await checkTagChips(bp, await oracle(board.store)));
  });
  await t.test("the difficulty chip says the item's difficulty on the tags' line, and an unrated item has none", async () => {
    await bp.reset(openAll(board));
    none(await checkDifficultyChip(bp, await oracle(board.store)));
  });
  await t.test("a comment saved on a folded list stays in view and its 发送 sends it", async () => {
    await bp.reset({ ...openAll(board), "board-notes": { ["it:" + w.commentItem]: false, ["q:" + w.commentCard]: false } });
    none(await checkComments(bp, await oracle(board.store)));
  });
});
