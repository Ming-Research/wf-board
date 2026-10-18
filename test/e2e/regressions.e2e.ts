// Evidence that the browser checks catch bugs that once shipped: each check runs on the current page, where it must find nothing, and on
// the page with that bug's fix reversed (literal text edits applied to a copy), where it must report the bug. These are the witnesses of
// facts that need a box (a width or a position the layout gives); every witness that needs none runs without a browser (test/dom,
// test/web.test.ts). A witness whose edit no longer matches the current file fails loudly; update or retire it then.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard, launch, BoardPage, openAll, variantWeb } from "./harness.ts";
import type { BoardServer, Revert } from "./harness.ts";
import { setHead, checkFit, FIT_HEAD } from "./mermaid-checks.ts";
import { oracle, checkPlanCardLayout, checkFullWidth } from "./invariants.ts";

interface Witness { bug: string; reverts: Revert[]; family: string; run: (bp: BoardPage, b: BoardServer) => Promise<string[]> }
// Ways other than a maximum width to keep the column's content from filling the window, one for each other thing the check measures.
const NARROWINGS: Array<{ bug: string; edit: string; find: string; replace: string; family: string }> = [
  { bug: "a block of the right column was set to a width of its own, narrower than its box", edit: "a width of 78ch on the log", find: ".log { display: flex; flex-direction: column; gap: 6px; margin-top: 4px;", replace: ".log { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; width: 78ch;", family: "full-width-fill .log:" },
  { bug: "an item's box in the right column was capped, narrower than the column", edit: "a maximum width on the item's box", find: "body.wide #item-detail .item > .body, body.wide #item-detail .item > .notes { padding-left: 0; }", replace: "body.wide #item-detail .item > .body, body.wide #item-detail .item > .notes { padding-left: 0; }\nbody.wide #item-detail > .item { max-width: 600px; }", family: "full-width-box:" },
  { bug: "an item's body in the right column was capped, narrower than its box", edit: "a maximum width on the item's body", find: "body.wide #item-detail .item > .body, body.wide #item-detail .item > .notes { padding-left: 0; }", replace: "body.wide #item-detail .item > .body, body.wide #item-detail .item > .notes { padding-left: 0; }\nbody.wide #item-detail .item > .body { max-width: 600px; }", family: "full-width-body:" },
  { bug: "a block of the right column was wider than the column, so the column scrolled sideways", edit: "a minimum width on the log", find: ".log { display: flex; flex-direction: column; gap: 6px; margin-top: 4px;", replace: ".log { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; min-width: 3000px;", family: "full-width-scroll:" },
  { bug: "the page was wider than the window, so the page scrolled sideways", edit: "a minimum width on the two columns", find: "body.wide .wrap { flex: 1; min-height: 0; max-width: none; min-width: 688px;", replace: "body.wide .wrap { flex: 1; min-height: 0; max-width: none; min-width: 3000px;", family: "full-width-page:" },
];
const WITNESSES: Witness[] = [
  {
    bug: "a ruled card's plan row showed no question when the pick it names is long: the pick would not shrink and squeezed the question to nothing (feature, card-in-plan)",
    // The pick takes its full width again.
    reverts: [{ file: "web/index.html", edit: "the pick of a card row does not shrink", find: ".plan-row.cardrow > .plan-main > span:not(.cardpick) { flex: none; }", replace: ".plan-row.cardrow > .plan-main > span { flex: none; }" }],
    family: "plan-card-row",
    run: async (bp, b) => { const o = await oracle(b.store); return checkPlanCardLayout(bp, o, [o.s.decisions[b.gen.witness.donePlanCard]!.item]); },
  },
  {
    bug: "a diagram wider than the text was drawn at its own width, so its right part was cut off by a box that scrolled sideways without showing it could (owner, 2026-10-17)",
    // Every diagram at its own width again, whatever its box.
    reverts: [{ file: "web/index.html", edit: "a diagram is fitted to its box", find: "width: calc(min(var(--natural), 100%) * var(--zoom, 1));", replace: "width: var(--natural);" }], family: "mermaid-fit",
    // A small diagram, a wide one and a tall one in one head, as the page's own mermaid checks draw them.
    run: async (bp, b) => { await setHead(b, b.gen.witness.code, FIT_HEAD); await bp.select(b.gen.witness.code); return checkFit(bp, 60_000); },
  },
  ...NARROWINGS.map((n): Witness => ({
    bug: `${n.bug} (owner, 2026-10-17)`,
    reverts: [{ file: "web/index.html", edit: n.edit, find: n.find, replace: n.replace }], family: n.family,
    run: async bp => checkFullWidth(bp),
  })),
];

for (const w of WITNESSES) test(`the browser checks catch: ${w.bug}`, { timeout: 10 * 60_000 }, async t => {
  const browser = await launch(t);
  for (const [page, webDir] of [["current page", undefined], ["page with the fix reversed", await variantWeb(t, w.reverts)]] as const) {
    const board = await startBoard(t, { webDir });
    const bp = await BoardPage.open(browser, board, openAll(board));
    const all = await w.run(bp, board), hits = all.filter(v => v.startsWith(w.family));
    await bp.context.close();
    if (page === "current page") assert.deepEqual(all, [], "the current page passes this check");
    else assert.ok(hits.length > 0, `the check misses the bug on the ${page}; it reported: ${all.join("\n") || "nothing"}`);
  }
});
