// Evidence that the browser checks catch bugs that once shipped: each check runs on the current page, where it must
// find nothing, and on the page with that bug's fix reversed (the fix commit's hunks undone in a copy), where it must
// report the bug. A witness whose edits no longer match the current file fails loudly; update or retire it then. Where
// later work rewrote the lines around a fix, the witness removes the fix by a targeted edit instead of the commit's hunk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard, launch, BoardPage, openAll, variantWeb } from "./harness.ts";
import type { BoardServer, Revert } from "./harness.ts";
import { oracle, burst, checkBadges, checkComments, checkCodeFont, checkEmptyRows, checkPlanRows, checkFresh, checkWrap } from "./invariants.ts";

interface Witness { bug: string; reverts: Revert[]; family: string; storage?: (b: BoardServer) => Record<string, unknown>; run: (bp: BoardPage, b: BoardServer) => Promise<string[]> }
const WITNESSES: Witness[] = [
  {
    bug: "saving a comment on a card folded its comment list and hid the 发送 button (fixed in 1ecc074)",
    // The fix's two lines, removed where they stand now: opening a comment and saving one unfold the list.
    reverts: [
      { file: "web/app.ts", edit: "opening a comment unfolds its list", find: "    // Writing a comment shows the list it joins, so the saved draft and its send button are in view.\n    notesOpen[key] = true; try { localStorage.setItem(\"board-notes\", JSON.stringify(notesOpen)); } catch (e) {}\n", replace: "" },
      { file: "web/app.ts", edit: "saving a comment unfolds its list", find: "drafts[key] = \"\"; editing = null; editingAnchor = null;\n          notesOpen[key] = true; try { localStorage.setItem(\"board-notes\", JSON.stringify(notesOpen)); } catch (e) {}\n", replace: "drafts[key] = \"\"; editing = null; editingAnchor = null;\n" },
    ], family: "comment-hidden",
    storage: b => ({ ...openAll(b), "board-notes": { ["it:" + b.gen.witness.commentItem]: false, ["q:" + b.gen.witness.commentCard]: false } }),
    run: async (bp, b) => checkComments(bp, await oracle(b.store)),
  },
  {
    bug: "purple and red numbers jumped to another project's card after unrelated re-renders (fixed in 1ecc074)",
    reverts: [{ commit: "1ecc074", file: "web/app.ts", hunks: [0, 3] }], family: "badge-landing",
    run: async (bp, b) => { const base = await bp.changes(), n = await burst(b, 1); await bp.waitChanges(base + n); return checkBadges(bp, await oracle(b.store)); },
  },
  {
    bug: "a card row in a plan jumped to the card's own item, even a done one, instead of unfolding in place (fixed in 3a337e8 and 517c448)",
    reverts: [{ commit: "517c448", file: "web/app.ts" }, { commit: "3a337e8", file: "web/app.ts" }, { commit: "3a337e8", file: "web/index.html" }], family: "plan-card-row",
    // The items whose plans name a card that lives in another item: the card named by three plans, by a done item's
    // plan, and only by another item's plan.
    run: async (bp, b) => { const o = await oracle(b.store); return checkPlanRows(bp, o, Object.keys(o.s.items).filter(id => o.s.items[id]!.plan.some(row => "card" in row && o.s.decisions[row.card]?.item !== id))); },
  },
  {
    bug: "code blocks were not set in Monaco: the global code rule overrode the block's font (fixed in 8f3ed75)",
    reverts: [{ commit: "8f3ed75", file: "web/index.html" }], family: "code-font",
    run: async (bp, b) => checkCodeFont(bp, await oracle(b.store)),
  },
  {
    bug: "n landed on done or cancelled items the left tree hid (owner, 2026-10-14)",
    // Both halves of the fix, removed where they stand: closed items holding unread content leave the tree, and n's
    // stops no longer follow the tree, so n lands on rows the tree does not show.
    reverts: [{ file: "web/app.ts", edit: "closed items holding unread content stay in the tree", find: "openWorkAncestors().has(it.id) || freshPath().has(it.id); }", replace: "openWorkAncestors().has(it.id); }" },
      { file: "web/app.ts", edit: "new-content stops follow the shown tree", find: " && (!st.item || !index().byId.has(st.item) || treeShown(st.item))", replace: "" }],
    family: "n-walk",
    run: async (bp, b) => checkFresh(bp, await oracle(b.store)),
  },
  {
    // The same check also walks n from the bottom row on the current page (it must land on the first row holding new
    // content); the seeded board does not reproduce the owner's wrong n landing, so that half has no reversal yet.
    bug: "the right arrow jumped to cards of rows the list does not show (owner, 2026-10-14)",
    reverts: [{ file: "web/app.ts", edit: "the arrows walk only stops of shown rows", find: "const all = stops().filter(st => !st.item || treeShown(st.item));", replace: "const all = stops();" }],
    family: "wrap-card",
    run: async (bp, b) => checkWrap(bp, await oracle(b.store)),
  },
  {
    bug: "an empty pause row sat under every unpaused item's title (fixed in 756e5ea)",
    reverts: [{ commit: "756e5ea", file: "web/app.ts" }], family: "empty-row",
    run: (bp, b) => checkEmptyRows(bp, [b.gen.witness.unpaused, b.gen.witness.code]),
  },
];

for (const w of WITNESSES) test(`the browser checks catch: ${w.bug}`, { timeout: 10 * 60_000 }, async t => {
  const browser = await launch(t);
  for (const [page, webDir] of [["current page", undefined], ["page with the fix reversed", await variantWeb(t, w.reverts)]] as const) {
    const board = await startBoard(t, { webDir });
    const bp = await BoardPage.open(browser, board, w.storage?.(board) ?? openAll(board));
    const all = await w.run(bp, board), hits = all.filter(v => v.startsWith(w.family));
    await bp.context.close();
    if (page === "current page") assert.deepEqual(all, [], "the current page passes this check");
    else assert.ok(hits.length > 0, `the check misses the bug on the ${page}; it reported: ${all.join("\n") || "nothing"}`);
  }
});
