// The blocks of the owner's right column have no maximum width (the owner asked for none on 2026-10-17): the check of
// test/dom/style-checks.ts on the page as it is, where it finds nothing, and on the page with one block's old cap put back, where it must
// report that block. The caps are the opening of each block's rule, which the page now holds without the cap, and the cap in characters. The
// files width-caps-*.test.ts run a share of the blocks each, on a board of their own, so they go side by side.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard, openAll } from "../e2e/board-server.ts";
import type { Revert } from "../e2e/variant.ts";
import { DomPage } from "./page.ts";
import { oracle } from "./checks.ts";
import { checkNoWidthCaps } from "./style-checks.ts";

const CAPS = [
  { sel: ".note", find: ".note { font-size: 14px; border-radius: 6px; padding: 6px 10px; background: var(--note-bg); display: flex; flex-direction: column; gap: 2px;", ch: 78 },
  { sel: ".log", find: ".log { display: flex; flex-direction: column; gap: 6px; margin-top: 4px;", ch: 78 },
  { sel: ".rich", find: ".rich { display: flex; flex-direction: column; gap: 6px;", ch: 78 },
  { sel: ".editor", find: ".editor { display: flex; flex-direction: column; gap: 6px;", ch: 78 },
  { sel: ".body p", find: ".body p { margin: 0;", ch: 78 },
  { sel: ".ask", find: ".ask { background: var(--bg); border: 1px solid var(--rule); border-radius: 8px; padding: 8px 12px; font-size: 14.5px; font-weight: 500;", ch: 78 },
  { sel: ".checks", find: ".checks { font-size: 13.5px; color: var(--wip); background: var(--wip-soft); border-radius: 6px; padding: 4px 10px; display: flex; flex-direction: column; gap: 2px;", ch: 78 },
  { sel: ".deplists", find: ".deplists { display: flex; flex-direction: column; gap: 1px;", ch: 78 },
  { sel: ".card p", find: ".card p { margin: 0;", ch: 76 },
  { sel: ".refpop", find: ".refpop { display: flex; flex-direction: column;", ch: 78 },
];
const capBack = (c: typeof CAPS[number]): Revert => ({ file: "web/index.html", edit: `the maximum width of ${c.sel}`, find: c.find, replace: `${c.find} max-width: ${c.ch}ch;` });

/** The caps at the positions `part` of `of` takes, each on a page with that cap put back. */
export function widthCapTests(part: number, of: number) {
  test(`the right column's blocks have no maximum width, and the page with a cap put back is reported (part ${part + 1} of ${of})`, { timeout: 5 * 60_000 }, async t => {
    const board = await startBoard(t);
    const bp = await DomPage.open(t, board, { storage: openAll(board) });
    const none = await checkNoWidthCaps(bp, await oracle(board.store));
    assert.equal(none.length, 0, none.length + " violations:\n" + none.slice(0, 40).join("\n"));
    for (const c of CAPS.filter((_, k) => k % of === part)) await t.test(`blocks of the right column stayed at ${c.ch} characters in a wide window (${c.sel}; owner, 2026-10-17)`, async st => {
      const spoiled = await DomPage.open(st, board, { storage: openAll(board), reverts: [capBack(c)] });
      const found = await checkNoWidthCaps(spoiled, await oracle(board.store));
      assert.ok(found.some(line => line.startsWith(`full-width-cap ${c.sel}:`)), `the check reports ${c.sel} on the spoiled page, it reported ${found.length} lines, first: ${JSON.stringify(found.slice(0, 2))}`);
    });
  });
}
