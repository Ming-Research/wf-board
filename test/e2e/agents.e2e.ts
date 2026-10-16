// The agent list in a real browser: it sits above the projects, it keeps the tree's element ids to the tree, and 在树中
// lands on the item's row in the tree (far below the list) and 返回 comes back. The fake-DOM tests in test/web.test.ts
// cover what the list says; only layout and scrolling need a browser. Run by CI's e2e job (npm run test:e2e).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ops } from "../../src/ops.ts";
import { rules } from "../../src/rules.ts";
import { startBoard, launch, BoardPage, openAll } from "./harness.ts";
import type { BoardServer } from "./harness.ts";
import { oracle, checkTreeRows } from "./invariants.ts";

/** An open item drawn far down the tree, so a jump to its row has to scroll the list. */
async function farItem(bp: BoardPage, board: BoardServer): Promise<string> {
  const items = board.store.snapshot().items, rows = await bp.treeRows();
  const id = [...rows].reverse().find(row => items[row] && !items[row]!.record && items[row]!.group);
  assert.ok(id, "the generated board draws an open item in the tree");
  return id;
}
const write = (board: BoardServer, session: string, id: string) =>
  ops(board.store).appendLog({ author: board.store.snapshot().items[id]!.group, session, id, text: `${session} wrote here` });

test("the agent list is above the projects, and 在树中 lands on the item's tree row and Back returns", async t => {
  const board = await startBoard(t), browser = await launch(t);
  const bp = await BoardPage.open(browser, board, openAll(board));
  const id = await farItem(bp, board);
  assert.equal(await bp.page.locator("#agents:not([hidden])").count(), 0, "no session has written yet: no list");
  const base = await bp.changes();
  await write(board, "agent-x", id);
  await bp.waitChanges(base + 1);
  const row = bp.page.locator('#agents [data-agent="agent-x"]');
  await row.waitFor();
  const layout = await bp.page.evaluate(() => {
    const agents = document.getElementById("agents")!, areas = document.getElementById("areas")!, header = document.querySelector("header.top")!;
    const a = agents.getBoundingClientRect(), r = areas.getBoundingClientRect();
    return {
      afterHeader: !!(header.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING),
      beforeProjects: !!(agents.compareDocumentPosition(areas) & Node.DOCUMENT_POSITION_FOLLOWING) && a.bottom <= r.top,
      drawn: a.height > 0,
      treeIdsInList: agents.querySelectorAll('[id^="it-"]').length,
    };
  });
  assert.deepEqual(layout, { afterHeader: true, beforeProjects: true, drawn: true, treeIdsInList: 0 });
  assert.equal(await bp.page.locator(`[id="it-${id}"]`).count(), 1, "the item's tree element id is the tree's alone");

  const top = await bp.page.evaluate(() => document.getElementById("page-left")!.scrollTop);
  await row.locator(".agitem-tree").first().click();
  await bp.settle();
  const landed = await bp.page.evaluate(id => {
    const tree = document.querySelector(`#areas [id="it-${id}"]`), pane = document.getElementById("page-left")!;
    if (!tree) return "no tree row";
    const r = tree.getBoundingClientRect(), p = pane.getBoundingClientRect();
    return r.top >= p.top - 1 && r.bottom <= p.bottom + 1 ? "in view" : `row ${r.top}..${r.bottom} outside the list ${p.top}..${p.bottom}`;
  }, id);
  assert.equal(landed, "in view", "the jump scrolls the tree row into view");
  assert.equal(await bp.selected(), id, "the item is selected, so its detail shows");
  assert.equal(await bp.page.locator("#backbtn").isVisible(), true, "the jump is remembered");
  const away = await bp.page.evaluate(() => document.getElementById("page-left")!.scrollTop);
  assert.ok(away > top + 500, `the jump scrolled the list well away from the agent list (${top} to ${away})`);
  await bp.page.locator("#backbtn").click();
  await bp.settle();
  assert.equal(await bp.page.locator("#backbtn").isVisible(), false, "Back returns");
  const back = await bp.page.evaluate(() => document.getElementById("page-left")!.scrollTop);
  assert.ok(Math.abs(back - top) <= 2, `Back scrolls the list back to where the agent list was (${top}, now ${back})`);
});

test("two sessions on one item each show it, and the tree's element is still found once", async t => {
  const board = await startBoard(t), browser = await launch(t);
  const bp = await BoardPage.open(browser, board, openAll(board));
  const id = await farItem(bp, board);
  const base = await bp.changes();
  await write(board, "agent-x", id);
  // Commit times have a resolution of one second, and rows with the same time sort by name: leave a second between the writes.
  await new Promise(resolve => setTimeout(resolve, 1100));
  await write(board, "agent-y", id);
  await bp.waitChanges(base + 2);
  await bp.page.locator('#agents [data-agent="agent-y"]').waitFor();
  assert.deepEqual(await bp.page.locator("#agents .agent").evaluateAll(rows => rows.map(r => (r as HTMLElement).dataset.agent)), ["agent-y", "agent-x"], "newest writer first");
  assert.equal(await bp.page.locator("#agents .agitem").count(), 2);
  const ids = await bp.page.locator("#agents .agitem").evaluateAll(cells => cells.map(c => c.id));
  assert.equal(new Set(ids).size, 2, "each cell has its own id");
  assert.equal(await bp.page.locator(`[id="it-${id}"]`).count(), 1);
  await bp.page.locator('#agents [data-agent="agent-x"] .agitem-title').first().click();
  await bp.settle();
  assert.equal(await bp.selected(), id, "a title click selects the item");
});

test("a cell unfolds its sub-items in place, the list folds apart from the tree, and every tree click still lands", { timeout: 15 * 60_000 }, async t => {
  const board = await startBoard(t), browser = await launch(t);
  const bp = await BoardPage.open(browser, board, openAll(board));
  const s = board.store.snapshot(), r = rules(s), rows = await bp.treeRows();
  // An open item that is drawn in the tree together with a sub-item: the same two items then sit in the list and in the tree.
  const id = rows.find(x => !s.items[x]!.record && s.items[x]!.group && r.children(x).some(c => rows.includes(c)));
  assert.ok(id, "the generated board draws an item with a drawn sub-item");
  const child = r.children(id).find(c => rows.includes(c))!;
  const base = await bp.changes();
  await write(board, "agent-x", id);
  await bp.waitChanges(base + 1);
  const cell = bp.page.locator('#agents [data-agent="agent-x"] .agitem').first();
  await cell.waitFor();
  assert.equal(await bp.page.locator("#agents .item").count(), 0, "folded: no item row in the list");
  await cell.locator(".agitem-caret").click();
  await bp.settle();
  const listIds = await bp.page.locator("#agents .item").evaluateAll(els => els.map(e => e.id));
  assert.ok(listIds.includes(`ag-agent-x--it-${child}`), `the sub-item unfolds under the cell (${listIds.join(", ")})`);
  assert.ok(listIds.every(x => !x.startsWith("it-")), "no row of the list has an id the tree uses");
  assert.deepEqual(await bp.treeRows(), rows, "unfolding in the list changes nothing in the tree");
  assert.equal(await bp.page.locator(`[id="it-${child}"]`).count(), 1, "the tree's row for the sub-item is still found once");
  // A tree row folds on its own; the list keeps its cell unfolded.
  const caret = bp.page.locator(`#areas [id="it-${id}"] > .item-row > .caret`);
  await caret.click();
  await bp.settle();
  assert.equal(await bp.page.locator(`#agents [id="ag-agent-x--it-${child}"]`).count(), 1, "folding the tree's row leaves the list's sub-item");
  await caret.click();
  await bp.settle();
  const failures = await checkTreeRows(bp, await oracle(board.store));
  assert.equal(failures.length, 0, failures.length + " violations:\n" + failures.slice(0, 40).join("\n"));
  assert.equal(await bp.page.locator(`#agents [id="ag-agent-x--it-${child}"]`).count(), 1, "the unfolded cell survives the tree walk");
});
