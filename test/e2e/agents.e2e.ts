// The agent list in a real browser: it sits above the projects with room of its own, and 在树中 lands on the item's row in the tree (far
// below the list) with the row in view, and 返回 scrolls back to the list. What the list says, which element ids it uses and what its
// controls do are checked in a DOM library (test/dom/agents.test.ts); only layout and scrolling need a browser. Run by CI's e2e job
// (npm run test:e2e).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ops } from "../../src/ops.ts";
import { startBoard, launch, BoardPage, openAll } from "./harness.ts";

test("the agent list lies above the projects, 在树中 scrolls the item's tree row into view and Back scrolls back", async t => {
  const board = await startBoard(t), browser = await launch(t);
  const bp = await BoardPage.open(browser, board, openAll(board));
  const items = board.store.snapshot().items, rows = await bp.treeRows();
  // An open item drawn far down the tree, so a jump to its row has to scroll the list.
  const id = [...rows].reverse().find(row => items[row] && !items[row]!.record && items[row]!.group);
  assert.ok(id, "the generated board draws an open item in the tree");
  const base = await bp.changes();
  // A dispatch record that is unfinished and alive: the session is then running, so the list unfolds its row.
  await ops(board.store).dispatchStart({ author: items[id]!.group, id, role: "工程师", level: 2, model: "Sonnet", agent: "agent-x", agentId: "agent-x-id" });
  await bp.waitChanges(base + 1);
  const row = bp.page.locator('#agents [data-agent="agent-x"]');
  await row.waitFor();
  const layout = await bp.page.evaluate(() => {
    const agents = document.getElementById("agents")!, areas = document.getElementById("areas")!;
    const a = agents.getBoundingClientRect(), r = areas.getBoundingClientRect();
    return { aboveProjects: a.bottom <= r.top, drawn: a.height > 0 };
  });
  assert.deepEqual(layout, { aboveProjects: true, drawn: true });

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
  const away = await bp.page.evaluate(() => document.getElementById("page-left")!.scrollTop);
  assert.ok(away > top + 500, `the jump scrolled the list well away from the agent list (${top} to ${away})`);
  await bp.page.locator("#backbtn").click();
  await bp.settle();
  const back = await bp.page.evaluate(() => document.getElementById("page-left")!.scrollTop);
  assert.ok(Math.abs(back - top) <= 2, `Back scrolls the list back to where the agent list was (${top}, now ${back})`);
});
