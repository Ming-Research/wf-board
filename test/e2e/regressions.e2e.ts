// Evidence that the browser checks catch bugs that once shipped: each check runs on the current page, where it must
// find nothing, and on the page with that bug's fix reversed (the fix commit's hunks undone in a copy), where it must
// report the bug. A witness whose hunks no longer match the current file fails loudly; retire it on purpose then.
// The card-row bug (a card row in a plan jumps to another item instead of unfolding) has no fix on this branch yet:
// page.e2e.ts reports it on the current page until that fix lands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard, launch, BoardPage, openAll, variantWeb } from "./harness.ts";
import type { BoardServer, Revert } from "./harness.ts";
import { oracle, burst, checkBadges, checkComments, checkCodeFont, checkEmptyRows } from "./invariants.ts";

interface Witness { bug: string; reverts: Revert[]; family: string; storage?: (b: BoardServer) => Record<string, unknown>; run: (bp: BoardPage, b: BoardServer) => Promise<string[]> }
const WITNESSES: Witness[] = [
  {
    bug: "saving a comment on a card folded its comment list and hid the 发送 button (fixed in f7bf758)",
    reverts: [{ commit: "f7bf758", file: "web/app.ts", hunks: [1, 2] }], family: "comment-hidden",
    storage: b => ({ ...openAll(b), "board-notes": { ["it:" + b.gen.witness.commentItem]: false, ["q:" + b.gen.witness.commentCard]: false } }),
    run: async (bp, b) => checkComments(bp, await oracle(b.store)),
  },
  {
    bug: "purple and red numbers jumped to another project's card after unrelated re-renders (fixed in f7bf758)",
    reverts: [{ commit: "f7bf758", file: "web/app.ts", hunks: [0, 3] }], family: "badge-landing",
    run: async (bp, b) => { const base = await bp.changes(), n = await burst(b, 1); await bp.waitChanges(base + n); return checkBadges(bp, await oracle(b.store)); },
  },
  {
    bug: "code blocks were not set in Monaco: the global code rule overrode the block's font (fixed in 2ecbbaf)",
    reverts: [{ commit: "2ecbbaf", file: "web/index.html" }], family: "code-font",
    run: async (bp, b) => checkCodeFont(bp, await oracle(b.store)),
  },
  {
    bug: "an empty pause row sat under every unpaused item's title (fixed in 138634b)",
    reverts: [{ commit: "138634b", file: "web/app.ts" }], family: "empty-row",
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
