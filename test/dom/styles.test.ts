// Facts of the page's stylesheet that the owner sees, checked on the page in a DOM library (test/dom/style-checks.ts): code blocks in
// Monaco, tag chips that read in both themes, a status chip with a colour of its own, the list of messages beside the shortcut menu.
// Each check runs on the current page, where it must find nothing, and on the page with the one rule it protects spoiled, where it
// must report that rule. The browser layer keeps what needs a box (test/e2e).

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard, openAll } from "../e2e/board-server.ts";
import type { BoardServer, Hooks } from "../e2e/board-server.ts";
import type { Revert } from "../e2e/variant.ts";
import { DomPage } from "./page.ts";
import { oracle } from "./checks.ts";
import { checkCodeFont, checkTagContrast, checkStatusChipBackground, checkMessagesPlace } from "./style-checks.ts";

const none = (v: string[]) => assert.equal(v.length, 0, v.length + " violations:\n" + v.slice(0, 40).join("\n"));
/** The violations of a check on the page with `reverts` applied to it. */
async function on(t: Hooks, board: BoardServer, reverts: Revert[], run: (bp: DomPage) => Promise<string[]>): Promise<string[]> {
  const bp = await DomPage.open(t, board, { storage: openAll(board), reverts });
  const v = await run(bp);
  return [...v, ...bp.errors.map(e => "page-error: " + e)];
}
const css = (edit: string, find: string, replace: string): Revert => ({ file: "web/index.html", edit, find, replace });
/** A spoiled page must be reported by the check, in the family the spoiled rule belongs to. */
async function reported(t: Hooks, board: BoardServer, reverts: Revert[], family: string, run: (bp: DomPage) => Promise<string[]>) {
  const v = await on(t, board, reverts, run);
  assert.ok(v.some(line => line.startsWith(family)), `the check reports ${family} on the spoiled page, it reported ${JSON.stringify(v.slice(0, 3))}`);
}

test("code blocks are set in Monaco at 13.5px, inner code included", async t => {
  const board = await startBoard(t);
  none(await on(t, board, [], async bp => checkCodeFont(bp, await oracle(board.store))));
  await t.test("the code element falls back to the inline-code font", () => reported(t, board, [css("the code in a block no longer inherits", ".rich pre.code code { font: inherit;", ".rich pre.code code {")], "code-font", async bp => checkCodeFont(bp, await oracle(board.store))));
  await t.test("the block loses Monaco", () => reported(t, board, [css("the block's font", "font-family: Monaco, var(--font-mono); font-size: 13.5px;", "font-size: 13.5px;")], "code-font", async bp => checkCodeFont(bp, await oracle(board.store))));
  await t.test("the block's size changes", () => reported(t, board, [css("the block's size", "font-family: Monaco, var(--font-mono); font-size: 13.5px;", "font-family: Monaco, var(--font-mono); font-size: 12px;")], "code-font", async bp => checkCodeFont(bp, await oracle(board.store))));
});

test("tag chips read at 4.5:1 or more in the light theme and in both dark-theme blocks", async t => {
  const board = await startBoard(t);
  none(await on(t, board, [], checkTagContrast));
  await t.test("the light theme's tag text is pale", () => reported(t, board, [css("pale tag text in the light theme", "--tag-bg: #e3f2f1; --tag-ink: #0b4f4b;", "--tag-bg: #e3f2f1; --tag-ink: #7fb9b4;")], "tag-contrast (light)", checkTagContrast));
  await t.test("the dark theme's tag text is dark", () => reported(t, board, [css("dark tag text in the system dark theme", ':root:not([data-theme="light"]) {\n    --tag-bg: #163633; --tag-ink: #8fe0d8;', ':root:not([data-theme="light"]) {\n    --tag-bg: #163633; --tag-ink: #2f6b66;')], "tag-contrast (dark)", checkTagContrast));
});

test("a status chip has a background of its own in each status and theme", async t => {
  const board = await startBoard(t);
  none(await on(t, board, [], async bp => checkStatusChipBackground(bp, await oracle(board.store))));
  await t.test("the part-done chip has none", () => reported(t, board, [css("the 停滞 chip's background", ".st.idle { background: var(--idle-soft); }", "")], "idle-status", async bp => checkStatusChipBackground(bp, await oracle(board.store))));
  await t.test("the chip's colour names a token that is not defined", () => reported(t, board, [css("a misspelled token", ".st.wip { background: var(--wip-soft); }", ".st.wip { background: var(--wip-sofft); }")], "idle-status", async bp => checkStatusChipBackground(bp, await oracle(board.store))));
});

test("the list of messages is fixed at the top right, beside the shortcut menu and clear of it", async t => {
  const board = await startBoard(t);
  none(await on(t, board, [], checkMessagesPlace));
  await t.test("the box moves under the menu", () => reported(t, board, [css("messages box over the menu", "right: 54px; z-index: 40;", "right: 40px; z-index: 40;")], "messages-place", checkMessagesPlace));
  await t.test("the box moves away from the menu", () => reported(t, board, [css("messages box far from the menu", "right: 54px; z-index: 40;", "right: 120px; z-index: 40;")], "messages-place", checkMessagesPlace));
  await t.test("the box scrolls with the list", () => reported(t, board, [css("messages box not fixed", ".messages { position: fixed;", ".messages { position: absolute;")], "messages-place", checkMessagesPlace));
});
