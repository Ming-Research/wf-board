// The owner's page while the board is deployed (docs/design.md, section 7, Updating the page): an open page replaces itself with
// the new version without losing its place, waits while a comment is being written, and does not loop. The checks are in update.ts;
// each runs on a page served from a copy of the page directory, which the check rebuilds the way the deploy job does. The same checks
// run against pages with one part reversed in test/e2e/regressions.e2e.ts. Run by CI's e2e job (npm run test:e2e), not on the owner's Mac.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard, launch, BoardPage, openAll, variantWeb } from "./harness.ts";
import type { BoardServer } from "./harness.ts";
import { checkReload, checkWriting, checkSame, checkLoop } from "./update.ts";

const none = (v: string[]) => assert.equal(v.length, 0, v.length + " violations:\n" + v.join("\n"));
/** A board served from its own copy of the current page, and a browser page open on it. */
async function open(t: Parameters<typeof startBoard>[0]): Promise<{ bp: BoardPage; board: BoardServer }> {
  const board = await startBoard(t, { webDir: await variantWeb(t, []) }), browser = await launch(t);
  return { bp: await BoardPage.open(browser, board, openAll(board)), board };
}

test("a page open before a deploy reloads itself and keeps the selected item, the folds and the scroll", { timeout: 5 * 60_000 }, async t => {
  const { bp, board } = await open(t);
  none(await checkReload(bp, board));
});

test("a page waits while a comment is being written, then reloads once it is saved", { timeout: 5 * 60_000 }, async t => {
  const { bp, board } = await open(t);
  none(await checkWriting(bp, board));
});

test("a deploy that left the page as it was does not reload it", { timeout: 5 * 60_000 }, async t => {
  const { bp, board } = await open(t);
  none(await checkSame(bp, board));
});

test("a page that cannot reach the announced version reloads once and then asks for a reload by hand", { timeout: 5 * 60_000 }, async t => {
  const { bp, board } = await open(t);
  none(await checkLoop(bp, board));
});
