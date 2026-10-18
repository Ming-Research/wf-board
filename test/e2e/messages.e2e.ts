// The list of messages in a real browser: nothing on the page covers it once it is open. The button, what the list says, its item link
// and the live stream are checked in a DOM library (test/dom/messages.test.ts), and where the button sits and how the list lies over the
// page are facts of the stylesheet (test/dom/styles.test.ts); only a hit needs a layout. Run by CI's e2e job (npm run test:e2e).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ops } from "../../src/ops.ts";
import { startBoard, launch, BoardPage } from "./harness.ts";

test("nothing on the page covers the list of messages once it is open", { timeout: 5 * 60_000 }, async t => {
  const board = await startBoard(t), browser = await launch(t);
  const bp = await BoardPage.open(browser, board);
  const items = board.store.snapshot().items;
  const item = Object.keys(items).find(id => !items[id]!.record && items[id]!.group);
  assert.ok(item, "the generated board has an open item");
  const base = await bp.changes();
  await ops(board.store).sendMessage({ author: items[item]!.group, session: "agent-x", to: "架构师", text: "看这个条目的日志，等你回", item });
  await bp.waitChanges(base + 1);
  await bp.page.locator("#messages .messages-toggle").click();
  await bp.settle();
  const row = bp.page.locator("#messages-panel .message").first();
  await row.waitFor();
  const onTop = await row.evaluate(e => {
    const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && e.contains(hit);
  });
  assert.equal(onTop, true, "nothing on the page covers the list");
});
