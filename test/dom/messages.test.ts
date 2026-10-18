// The list of messages on the page in a DOM library: its button opens the list, a message sent while the page is open appears in it,
// and its item link selects the item. Where the button sits and how the list lies over the page are facts of the stylesheet
// (test/dom/styles.test.ts); that nothing covers the list needs a layout (test/e2e/browser.e2e.ts). The scenario also runs on a page
// with one thing spoiled, where it must fail for the reason it states.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ops } from "../../src/ops.ts";
import { startBoard, openAll } from "../e2e/board-server.ts";
import type { Hooks } from "../e2e/board-server.ts";
import type { Revert } from "../e2e/variant.ts";
import { DomPage } from "./page.ts";

async function messageList(t: Hooks, reverts: Revert[] = []) {
  const board = await startBoard(t), bp = await DomPage.open(t, board, { storage: openAll(board), reverts });
  const button = () => bp.$("#messages .messages-toggle");
  assert.ok(button(), "the page has the messages button");
  assert.equal(bp.$("#messages-panel"), null, "the list is closed until the button is pressed");
  bp.click(button(), "the messages button");
  await bp.settle();
  assert.equal(bp.visible(bp.$("#messages-panel")), true, "the list opens");
  assert.equal(bp.$("#messages-panel .empty")?.textContent, "还没有消息。");
  const items = board.store.snapshot().items;
  const item = Object.keys(items).find(id => !items[id]!.record && items[id]!.group);
  assert.ok(item, "the generated board has an open item");
  const base = bp.changes();
  await ops(board.store).sendMessage({ author: items[item]!.group, session: "agent-x", to: "架构师", text: "看这个条目的日志，等你回", item });
  await bp.waitChanges(base + 1);
  const row = bp.$("#messages-panel .message");
  assert.ok(row, "a message sent now appears in the open list");
  assert.equal(bp.$(".message-text", row!)?.textContent, "看这个条目的日志，等你回");
  assert.equal(bp.$(".message-who", row!)?.textContent, `agent-x（${items[item]!.group}）→ 架构师`);
  bp.click(bp.$("a.itemref", row!), "the item link of the message");
  await bp.settle();
  assert.equal(bp.selected(), item, "the item link selects the item");
  bp.click(button(), "the messages button");
  await bp.settle();
  assert.equal(bp.$("#messages-panel"), null, "the button closes the list");
  assert.deepEqual(bp.errors, []);
}

test("the messages button opens its list, a message sent now appears in it, and its item link selects the item", t => messageList(t));

const app = (edit: string, find: string, replace: string): Revert => ({ file: "web/app.ts", edit, find, replace });
const WITNESSES: Array<{ bug: string; reverts: Revert[]; reason: RegExp }> = [
  { bug: "the button did not open the list", reverts: [app("the messages button does nothing", "toggle.addEventListener(\"click\", () => { messagesOpen = !messagesOpen; renderNow(\"messages\"); });", "toggle.addEventListener(\"click\", () => { renderNow(\"messages\"); });")], reason: /the list opens/ },
  { bug: "the empty list said nothing", reverts: [app("an empty list is blank", 'if (!list.length) panel.appendChild(el("p", "empty", "还没有消息。"));', 'if (!list.length) panel.appendChild(el("p", "empty", ""));')], reason: /还没有消息/ },
  { bug: "a message showed no text", reverts: [app("a message has no text", 'li.appendChild(el("div", "message-text", inline(m.text)));', 'li.appendChild(el("div", "message-text", ""));')], reason: /看这个条目的日志/ },
  { bug: "a message named its recipient and sender the wrong way round", reverts: [app("sender and recipient swapped", 'esc(m.from + "（" + m.project + "）→ " + m.to)', 'esc(m.to + "（" + m.project + "）→ " + m.from)')], reason: /agent-x（/ },
  { bug: "a message's item link went to another item", reverts: [app("the item link names another item", 'inline("[[it:" + m.item + "]]")', 'inline("[[it:" + Object.keys(snapshot.items).at(-1) + "]]")')], reason: /the item link selects the item/ },
  { bug: "the list never held a message", reverts: [app("the list holds no message", "Object.values(snapshot.messages ?? {}).flatMap(day => day.messages)", "([] as Message[])")], reason: /a message sent now appears in the open list/ },
];
test("the messages scenario fails on the page with the thing it guards spoiled", async t => {
  for (const w of WITNESSES) await t.test(w.bug, st => assert.rejects(() => messageList(st, w.reverts), (error: Error) => w.reason.test(error.message) || (assert.fail(`failed for another reason: ${error.message}`), false)));
});
