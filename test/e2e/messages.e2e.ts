// The list of messages in a real browser: the button sits at the page's top right beside the shortcut menu and is not
// covered by it, its list opens over the page without moving it, a message sent while the page is open appears in the
// list, and its item link selects the item. The fake-DOM test in test/web.test.ts covers what the list says; layout and
// the live stream need a browser. Run by CI's e2e job (npm run test:e2e).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ops } from "../../src/ops.ts";
import { startBoard, launch, BoardPage } from "./harness.ts";

test("the messages button is at the top right, its list opens over the page, and a message sent now appears in it", { timeout: 5 * 60_000 }, async t => {
  const board = await startBoard(t), browser = await launch(t);
  const bp = await BoardPage.open(browser, board);
  const button = bp.page.locator("#messages .messages-toggle");
  await button.waitFor();
  const placed = await bp.page.evaluate(() => {
    const b = document.querySelector("#messages .messages-toggle")!.getBoundingClientRect(), menu = document.querySelector("#keymenu .keymenu-btn")!.getBoundingClientRect();
    return { top: b.top < 40, besideMenu: b.right <= menu.left && menu.left - b.right < 20, sameRow: Math.abs(b.top - menu.top) <= 2 };
  });
  assert.deepEqual(placed, { top: true, besideMenu: true, sameRow: true }, "at the page's top right, just left of the shortcut menu");
  // Scrolled down the list, the button stays where it is.
  await bp.page.evaluate(() => { document.getElementById("page-left")!.scrollTop = 2000; });
  assert.ok(await bp.page.evaluate(() => document.querySelector("#messages .messages-toggle")!.getBoundingClientRect().top < 40), "fixed at the top");
  await bp.page.evaluate(() => { document.getElementById("page-left")!.scrollTop = 0; });
  await bp.settle();
  const areasTop = () => bp.page.evaluate(() => document.getElementById("areas")!.getBoundingClientRect().top);
  const before = await areasTop();
  await button.click();
  await bp.settle();
  assert.equal(await bp.page.locator("#messages-panel").isVisible(), true);
  assert.equal(await bp.page.locator("#messages-panel .empty").textContent(), "还没有消息。");
  assert.equal(await areasTop(), before, "the open list lies over the page and moves nothing");

  const items = board.store.snapshot().items;
  const item = Object.keys(items).find(id => !items[id]!.record && items[id]!.group);
  assert.ok(item, "the generated board has an open item");
  const base = await bp.changes();
  await ops(board.store).sendMessage({ author: items[item]!.group, session: "agent-x", to: "架构师", text: "看这个条目的日志，等你回", item });
  await bp.waitChanges(base + 1);
  const row = bp.page.locator("#messages-panel .message").first();
  await row.waitFor();
  assert.equal(await row.locator(".message-text").textContent(), "看这个条目的日志，等你回");
  assert.equal(await row.locator(".message-who").textContent(), `agent-x（${items[item]!.group}）→ 架构师`);
  const onTop = await row.evaluate(e => {
    const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && e.contains(hit);
  });
  assert.equal(onTop, true, "nothing on the page covers the list");
  await row.locator("a.itemref").click();
  await bp.settle();
  assert.equal(await bp.selected(), item, "the item link selects the item");
});
