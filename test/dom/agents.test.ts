// The agent list on the page in a DOM library: it sits above the projects, it keeps the tree's element ids to the tree, and 在树中
// selects the item and 返回 comes back; a cell unfolds its sub-items in place, the list folds apart from the tree, and a session with
// no dispatch record sits behind 其他 N 个. The fake-DOM tests in test/web.test.ts cover what the list says; the browser layer keeps
// where it lies and how far the jump scrolls (test/e2e/agents.e2e.ts). Each scenario also runs on a page with one thing spoiled,
// where it must fail for the reason it states.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ops } from "../../src/ops.ts";
import { rules } from "../../src/rules.ts";
import { startBoard, openAll } from "../e2e/board-server.ts";
import type { BoardServer, Hooks } from "../e2e/board-server.ts";
import type { Revert } from "../e2e/variant.ts";
import { DomPage } from "./page.ts";
import { oracle, checkTreeRows } from "./checks.ts";

/** An open item drawn far down the tree, so a jump to its row is a long way from the list. */
function farItem(bp: DomPage, board: BoardServer): string {
  const items = board.store.snapshot().items, rows = bp.treeRows();
  const id = [...rows].reverse().find(row => items[row] && !items[row]!.record && items[row]!.group);
  assert.ok(id, "the generated board draws an open item in the tree");
  return id;
}
const write = (board: BoardServer, session: string, id: string) =>
  ops(board.store).appendLog({ author: board.store.snapshot().items[id]!.group, session, id, text: `${session} wrote here` });
// A dispatch record that is unfinished and alive: the session is then running, so the list unfolds its row. A session
// with no dispatch record (the plain `write`) is never running. The record is written with no session of its own, so the
// writer adds no row to the list.
const start = (board: BoardServer, agent: string, id: string) =>
  ops(board.store).dispatchStart({ author: board.store.snapshot().items[id]!.group, id, role: "工程师", level: 2, model: "Sonnet", agent, agentId: `${agent}-id` });
const FOLLOWING = 4;
const open = async (t: Hooks, board: BoardServer, reverts: Revert[]) => DomPage.open(t, board, { storage: openAll(board), reverts });

async function listAboveProjects(t: Hooks, reverts: Revert[] = []) {
  const board = await startBoard(t), bp = await open(t, board, reverts);
  const id = farItem(bp, board);
  assert.equal(bp.visible(bp.$("#agents")), false, "no session has written yet: no list, and no space for it");
  const base = bp.changes();
  await start(board, "agent-x", id);
  await bp.waitChanges(base + 1);
  const row = bp.$('#agents [data-agent="agent-x"]');
  assert.ok(row, "the session has a row");
  const agents = bp.$("#agents")!, areas = bp.$("#areas")!, header = bp.$("header.top")!;
  assert.equal(!!(header.compareDocumentPosition(agents) & FOLLOWING), true, "the list follows the header");
  assert.equal(!!(agents.compareDocumentPosition(areas) & FOLLOWING), true, "the list comes before the projects");
  assert.equal(bp.$$('[id^="it-"]', agents).length, 0, "the list holds no element id the tree uses");
  assert.equal(bp.$$(`[id="it-${id}"]`).length, 1, "the item's tree element id is the tree's alone");
  bp.click(bp.$(".agitem-tree", row!), "在树中");
  await bp.settle();
  assert.ok(bp.row(id), "the item has its tree row");
  assert.equal(bp.selected(), id, "the item is selected, so its detail shows");
  assert.equal(bp.visible(bp.$("#backbtn")), true, "the jump is remembered");
  bp.click(bp.$("#backbtn"), "返回");
  await bp.settle();
  assert.equal(bp.visible(bp.$("#backbtn")), false, "Back returns");
  assert.deepEqual(bp.errors, []);
}

async function twoSessions(t: Hooks, reverts: Revert[] = []) {
  const board = await startBoard(t), bp = await open(t, board, reverts);
  const id = farItem(bp, board);
  const base = bp.changes();
  await start(board, "agent-x", id);
  // Commit times have a resolution of one second, and rows with the same time sort by name: leave a second between the writes.
  await new Promise(resolve => setTimeout(resolve, 1100));
  await start(board, "agent-y", id);
  await bp.waitChanges(base + 2);
  assert.ok(bp.$('#agents [data-agent="agent-y"]'), "the second session has a row");
  assert.deepEqual(bp.$$("#agents .agent").map(r => r.dataset.agent), ["agent-y", "agent-x"], "newest writer first");
  assert.equal(bp.$$("#agents .agitem").length, 2);
  const ids = bp.$$("#agents .agitem").map(c => c.id);
  assert.equal(new Set(ids).size, 2, "each cell has its own id");
  const all = bp.$$("#agents [id]").map(e => e.id);
  assert.equal(new Set(all).size, all.length, `every id in the list is unique (${all.join(", ")})`);
  assert.equal(bp.$$(`[id="it-${id}"]`).length, 1);
  bp.click(bp.$('#agents [data-agent="agent-x"] .agitem-title'), "the title of the cell");
  await bp.settle();
  assert.equal(bp.selected(), id, "a title click selects the item");
  assert.deepEqual(bp.errors, []);
}

async function cellUnfolds(t: Hooks, reverts: Revert[] = []) {
  const board = await startBoard(t), bp = await open(t, board, reverts);
  const s = board.store.snapshot(), r = rules(s), rows = bp.treeRows();
  // An open item that is drawn in the tree together with a sub-item: the same two items then sit in the list and in the tree.
  const id = rows.find(x => !s.items[x]!.record && s.items[x]!.group && r.children(x).some(c => rows.includes(c)));
  assert.ok(id, "the generated board draws an item with a drawn sub-item");
  const child = r.children(id).find(c => rows.includes(c))!;
  const base = bp.changes();
  await start(board, "agent-x", id);
  await bp.waitChanges(base + 1);
  const cell = bp.$('#agents [data-agent="agent-x"] .agitem');
  assert.ok(cell, "the session has a cell");
  assert.equal(bp.$$("#agents .item").length, 0, "folded: no item row in the list");
  bp.click(bp.$(".agitem-caret", cell!), "the cell's caret");
  await bp.settle();
  const listIds = bp.$$("#agents .item").map(e => e.id);
  assert.ok(listIds.includes(`ag-agent-x--it-${child}`), `the sub-item unfolds under the cell (${listIds.join(", ")})`);
  assert.ok(listIds.every(x => !x.startsWith("it-")), "no row of the list has an id the tree uses");
  assert.deepEqual(bp.treeRows(), rows, "unfolding in the list changes nothing in the tree");
  assert.equal(bp.$$(`[id="it-${child}"]`).length, 1, "the tree's row for the sub-item is still found once");
  // A tree row folds on its own; the list keeps its cell unfolded.
  const caret = () => bp.$(`#areas [id="it-${id}"] > .item-row > .caret`);
  bp.click(caret(), "the tree row's caret");
  await bp.settle();
  assert.equal(bp.$$(`#agents [id="ag-agent-x--it-${child}"]`).length, 1, "folding the tree's row leaves the list's sub-item");
  bp.click(caret(), "the tree row's caret");
  await bp.settle();
  const failures = await checkTreeRows(bp, await oracle(board.store));
  assert.equal(failures.length, 0, failures.length + " violations:\n" + failures.slice(0, 40).join("\n"));
  assert.equal(bp.$$(`#agents [id="ag-agent-x--it-${child}"]`).length, 1, "the unfolded cell survives the tree walk");
  assert.deepEqual(bp.errors, []);
}

async function othersFold(t: Hooks, reverts: Revert[] = []) {
  const board = await startBoard(t), bp = await open(t, board, reverts);
  const [idle, busy] = bp.treeRows().filter(x => board.store.snapshot().items[x] && !board.store.snapshot().items[x]!.record && board.store.snapshot().items[x]!.group);
  assert.ok(idle && busy, "the generated board draws two open items");
  let base = bp.changes();
  await write(board, "agent-bare", idle);
  await bp.waitChanges(base + 1);
  const toggle = () => bp.$("#agents .agents-others-toggle");
  assert.ok(toggle(), "the line of the folded sessions is drawn");
  assert.equal(bp.$("#agents .agents-toggle")!.textContent, "▾ 代理 0", "nothing runs: the heading counts none");
  assert.equal(toggle()!.textContent!.trim(), "▸ 其他 1 个");
  assert.equal(bp.$$("#agents .agent").length, 0, "the row of a session with no dispatch record is not drawn while the line is closed");
  base = bp.changes();
  await start(board, "agent-busy", busy);
  await bp.waitChanges(base + 1);
  assert.ok(bp.$('#agents [data-agent="agent-busy"]'), "the running session has a row");
  assert.equal(bp.$("#agents .agents-toggle")!.textContent, "▾ 代理 1");
  assert.equal(bp.$$('#agents [data-agent="agent-bare"]').length, 0, "still folded");
  assert.equal(!!(bp.$('#agents [data-agent="agent-busy"]')!.compareDocumentPosition(toggle()!) & FOLLOWING), true, "the running row is above the fold line");
  bp.click(toggle(), "the line of the folded sessions");
  await bp.settle();
  assert.equal(toggle()!.textContent!.trim(), "▾ 其他 1 个");
  assert.deepEqual(bp.$$("#agents .agent").map(e => e.dataset.agent), ["agent-busy", "agent-bare"], "opened: the folded row follows the running one");
  assert.deepEqual(bp.errors, []);
}

test("the agent list is above the projects, and 在树中 selects the item's tree row and Back returns", t => listAboveProjects(t));
test("two sessions on one item each show it, and the tree's element is still found once", t => twoSessions(t));
test("a cell unfolds its sub-items in place, the list folds apart from the tree, and every tree click still lands", t => cellUnfolds(t));
test("a session with no dispatch record sits behind 其他 N 个 until the line is opened, and a running one is unfolded above it", t => othersFold(t));

const app = (edit: string, find: string, replace: string): Revert => ({ file: "web/app.ts", edit, find, replace });
const html = (edit: string, find: string, replace: string): Revert => ({ file: "web/index.html", edit, find, replace });
const WITNESSES: Array<{ bug: string; scenario: (t: Hooks, reverts: Revert[]) => Promise<void>; reverts: Revert[]; reason: RegExp }> = [
  {
    bug: "the agent list took its place in the page even when empty, because its display rule overrode the hidden attribute (agent list, review of wf-board#37)",
    scenario: listAboveProjects, reverts: [html("the hidden agent list takes no space", ".agents[hidden] { display: none; }\n", "")], reason: /no list, and no space for it/,
  },
  {
    bug: "the agent list stood below the projects",
    scenario: listAboveProjects, reverts: [html("the list is moved below the projects", '  <section class="agents" id="agents" aria-label="代理" hidden></section>\n', ""), html("the list follows the projects", '  <div id="areas"></div>', '  <div id="areas"></div>\n  <section class="agents" id="agents" aria-label="代理" hidden></section>')], reason: /the list comes before the projects/,
  },
  {
    bug: "a cell of the list took the element id of the tree's row for its item",
    scenario: listAboveProjects, reverts: [app("a cell takes the tree's id", 'li.id = m.prefix + "cell-" + it.id;', 'li.id = "it-" + it.id;')], reason: /the list holds no element id the tree uses/,
  },
  {
    bug: "在树中 did nothing",
    scenario: listAboveProjects, reverts: [app("在树中 does not follow", 'link.addEventListener("click", ev => { ev.stopPropagation(); follow(it.id, true); });', 'link.addEventListener("click", ev => { ev.stopPropagation(); });')], reason: /the item is selected, so its detail shows/,
  },
  {
    bug: "the list showed the oldest writer first",
    scenario: twoSessions, reverts: [app("rows in the other order", "running.forEach(r => list.appendChild(agentRow(r)));", "[...running].reverse().forEach(r => list.appendChild(agentRow(r)));")], reason: /newest writer first/,
  },
  {
    bug: "a click on a cell's title selected nothing",
    scenario: twoSessions, reverts: [app("a cell's title does not select", 'title.addEventListener("click", ev => { ev.stopPropagation(); selectItem(it.id); setCurrent(itemBox(it.id)); });', 'title.addEventListener("click", ev => { ev.stopPropagation(); });')], reason: /a title click selects the item/,
  },
  {
    bug: "a cell's arrow did not unfold its sub-items",
    scenario: cellUnfolds, reverts: [app("a cell's arrow does nothing", 'caret.setAttribute("aria-label", open ? "收起子条目" : "展开子条目");\n    caret.addEventListener("click", ev => { ev.stopPropagation(); setRowOpen(m, it, !open); });\n    row.appendChild(caret);\n    row.appendChild(el("span", "agitem-st"', 'caret.setAttribute("aria-label", open ? "收起子条目" : "展开子条目");\n    row.appendChild(caret);\n    row.appendChild(el("span", "agitem-st"')], reason: /the sub-item unfolds under the cell/,
  },
  {
    bug: "the line of the folded sessions did not open",
    scenario: othersFold, reverts: [app("the fold line does not open", "toggle.addEventListener(\"click\", () => { othersOpen = !othersOpen;", 'toggle.addEventListener("click", () => {')], reason: /▾ 其他 1 个/,
  },
  {
    bug: "the heading counted every session, not only the running ones",
    scenario: othersFold, reverts: [app("the heading counts all rows", '(agentsOpen ? "▾ " : "▸ ") + "代理 " + running.length', '(agentsOpen ? "▾ " : "▸ ") + "代理 " + rows.length')], reason: /nothing runs: the heading counts none/,
  },
  {
    bug: "the folded sessions came above the running ones",
    scenario: othersFold, reverts: [app("the fold line comes first", "running.forEach(r => list.appendChild(agentRow(r)));\n    if (others.length) list.appendChild(agentOthers(others));", "if (others.length) list.appendChild(agentOthers(others));\n    running.forEach(r => list.appendChild(agentRow(r)));")], reason: /the running row is above the fold line/,
  },
];
test("each agent list scenario fails on the page with the thing it guards spoiled", async t => {
  for (const w of WITNESSES) await t.test(w.bug, st => assert.rejects(() => w.scenario(st, w.reverts), (error: Error) => w.reason.test(error.message) || (assert.fail(`failed for another reason: ${error.message}`), false)));
});
