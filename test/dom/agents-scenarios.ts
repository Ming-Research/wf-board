// The agent list on the page in a DOM library: it sits above the projects, it keeps the tree's element ids to the tree, and 在树中
// selects the item and 返回 comes back; a cell unfolds its sub-items in place, the list folds apart from the tree, a session whose
// dispatch has ended sits behind 其他 N 个, and a session with no dispatch record has no row. The fake-DOM tests in test/web-cases.ts cover what the list says; the browser layer keeps
// where it lies and how far the jump scrolls (test/e2e/browser.e2e.ts). Each scenario also runs on a page with one thing spoiled,
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
// with no dispatch record (the plain `write`) has no row. The record is written with no session of its own, so the
// writer adds no row to the list.
const start = (board: BoardServer, agent: string, id: string) =>
  ops(board.store).dispatchStart({ author: board.store.snapshot().items[id]!.group, id, role: "工程师", level: 2, model: "Sonnet", agent, agentId: `${agent}-id` });
// A dispatch that began three hours ago and ended two hours ago: the session wrote nothing since, so it has no row until it writes again.
async function startAndEnd(board: BoardServer, agent: string, id: string) {
  const o = ops(board.store), author = board.store.snapshot().items[id]!.group, ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
  await o.dispatchStart({ author, id, role: "工程师", level: 2, model: "Sonnet", agent, agentId: `${agent}-id`, startedAt: ago(3) });
  await o.dispatchFinish({ author, id, agentId: `${agent}-id`, result: "一次通过", usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, cost: 0, reports: 0, kickbacks: 0, endedAt: ago(2) });
}
const FOLLOWING = 4;
const open = async (t: Hooks, board: BoardServer, reverts: Revert[]) => DomPage.open(t, board, { storage: openAll(board), reverts });

export async function listAboveProjects(t: Hooks, reverts: Revert[] = []) {
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

export async function twoSessions(t: Hooks, reverts: Revert[] = []) {
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

export async function cellUnfolds(t: Hooks, reverts: Revert[] = []) {
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

export async function othersFold(t: Hooks, reverts: Revert[] = []) {
  const board = await startBoard(t), bp = await open(t, board, reverts);
  const [idle, busy] = bp.treeRows().filter(x => board.store.snapshot().items[x] && !board.store.snapshot().items[x]!.record && board.store.snapshot().items[x]!.group);
  assert.ok(idle && busy, "the generated board draws two open items");
  let base = bp.changes();
  // A session no dispatch record names has no row, however much it writes.
  await write(board, "agent-plain", idle);
  await bp.waitChanges(base + 1);
  assert.equal(bp.visible(bp.$("#agents")), false, "a session with no dispatch record is no programmer the board sent out: no list");
  base = bp.changes();
  await startAndEnd(board, "agent-bare", idle);
  await write(board, "agent-bare", idle);
  await bp.waitChanges(base + 3);
  const toggle = () => bp.$("#agents .agents-others-toggle");
  assert.ok(toggle(), "the line of the folded sessions is drawn");
  assert.equal(bp.$("#agents .agents-toggle")!.textContent, "▾ 代理 0", "nothing runs: the heading counts none");
  assert.equal(toggle()!.textContent!.trim(), "▸ 其他 1 个", "the plain session is not counted, the session whose dispatch ended is");
  assert.equal(bp.$$("#agents .agent").length, 0, "the row of a session whose dispatch ended is not drawn while the line is closed");
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

/**
 * The runner's free slots stand under the heading whether the list is open or folded, even when no session has a row; a pool that has had a free
 * slot and nothing to start for an hour is marked, and the owner is told once. The text is src/agent-list.ts `poolsLine`'s, tested on plain data in
 * test/agent-list.test.ts; this is where it lies on the page and when it is drawn.
 */
export async function slotsLine(t: Hooks, reverts: Revert[] = []) {
  const board = await startBoard(t), bp = await open(t, board, reverts);
  const slots = () => bp.$("#agents .agents-slots");
  assert.equal(bp.visible(bp.$("#agents")), false, "the runner has reported no slots yet: no list");
  board.pools.put([{ pool: "1", label: "1 级", slots: 10, running: 2, dryForSeconds: 600 }]);
  await bp.waitFor(() => !!slots(), "the line about the free slots", 5_000);
  assert.match(slots()!.textContent!, /^名额：1 级 空着 8 个（共 10），派活队列里没有能开工的活已 10 分钟$/);
  assert.equal(bp.visible(bp.$("#agents")), true, "the slots alone make the list appear");
  assert.equal(slots()!.classList.contains("idle"), false, "ten minutes with nothing to start does not mark the line");
  assert.equal(bp.$("#agents .agents-toggle")!.textContent, "▾ 代理 0", "no session runs: the heading counts none");
  assert.equal(board.told.length, 0, "and the owner is told nothing");
  // An hour and a minute of nothing to start: the line is marked, and the owner is told once.
  board.pools.put([{ pool: "1", label: "1 级", slots: 10, running: 2, dryForSeconds: 3660 }]);
  await bp.waitFor(() => /已 1 小时 1 分$/.test(slots()?.textContent ?? ""), "the line to count past the hour", 5_000);
  assert.equal(slots()!.classList.contains("idle"), true, "an hour with nothing to start marks the line");
  assert.deepEqual(board.told.map((x: { title: string }) => x.title), ["名额空着 · 1 级"], "the owner is told once");
  // The line stays under the heading when the list is folded: it is what the owner must see without opening anything.
  bp.click(bp.$("#agents .agents-toggle"), "the heading");
  await bp.settle();
  assert.equal(bp.$("#agents .agents-toggle")!.textContent, "▸ 代理 0");
  assert.ok(slots(), "the line about the slots stays under the heading when the list is folded");
  // All the slots taken: the line says full, and is not marked.
  board.pools.put([{ pool: "1", label: "1 级", slots: 10, running: 10, dryForSeconds: 3700 }]);
  await bp.waitFor(() => /满 10\/10/.test(slots()?.textContent ?? ""), "the line to say the pool is full", 5_000);
  assert.equal(slots()!.classList.contains("idle"), false, "a full pool is not idle");
  assert.deepEqual(bp.errors, []);
}

/** With nothing selected and a cell of the list unfolded, a key command (c) asks for the item on screen: a row of the tree, not a row of
 * the list, whose element id is not an item's. */
export async function keyWithListUnfolded(t: Hooks, reverts: Revert[] = []) {
  const board = await startBoard(t), bp = await open(t, board, reverts);
  const s = board.store.snapshot(), r = rules(s), rows = bp.treeRows();
  const id = rows.find(x => !s.items[x]!.record && s.items[x]!.group && r.children(x).some(c => rows.includes(c)));
  assert.ok(id, "the generated board draws an item with a drawn sub-item");
  const base = bp.changes();
  await start(board, "agent-x", id);
  await bp.waitChanges(base + 1);
  bp.click(bp.$('#agents [data-agent="agent-x"] .agitem-caret'), "the cell's caret");
  await bp.settle();
  bp.blur();
  assert.equal(bp.selected(), null, "nothing is selected before the key");
  assert.ok(bp.$$("#agents .item").length > 0, "the unfolded cell shows item rows above the tree");
  bp.key("c");
  await bp.settle();
  const sel = bp.selected();
  assert.ok(sel && s.items[sel], `c with the list unfolded and nothing selected selected ${sel}, not an item of the tree`);
}

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
    scenario: othersFold, reverts: [app("the heading counts all rows", '(agentsOpen ? "▾ " : "▸ ") + "代理 " + count', '(agentsOpen ? "▾ " : "▸ ") + "代理 " + (rowCount + runner.length)')], reason: /nothing runs: the heading counts none/,
  },
  {
    bug: "the line about the runner's free slots was drawn only when a session had a row",
    scenario: slotsLine, reverts: [app("the slots alone draw no list", 'host.hidden = !rowCount && !runner.length && !slots;\n    host.innerHTML = "";\n    if (!rowCount && !runner.length && !slots) return;', 'host.hidden = !rowCount && !runner.length;\n    host.innerHTML = "";\n    if (!rowCount && !runner.length) return;')], reason: /the line about the free slots/,
  },
  {
    bug: "the line about the runner's free slots did not mark a pool idle for an hour",
    scenario: slotsLine, reverts: [app("the idle mark is gone", '"agents-slots" + (slots.idle ? " idle" : "")', '"agents-slots" + ""')], reason: /an hour with nothing to start marks the line/,
  },
  {
    bug: "the line about the runner's free slots vanished when the list was folded",
    scenario: slotsLine, reverts: [app("the slots are drawn only when the list is open", 'if (slots) {\n      const line = el("p", "agents-slots"', 'if (slots && agentsOpen) {\n      const line = el("p", "agents-slots"')], reason: /stays under the heading when the list is folded/,
  },
  {
    bug: "a key command with nothing selected took the first item row it found, an unfolded row of the agent list, for a tree row (agent list, review of wf-board#37)",
    scenario: keyWithListUnfolded, reverts: [app("the list's rows count as a place on screen", 'find(e => { if (e.closest("#agents")) return false; const r =', "find(e => { const r =")], reason: /not an item of the tree/,
  },
  {
    bug: "the folded sessions came above the running ones",
    scenario: othersFold, reverts: [app("the fold line comes first", "running.forEach(r => list.appendChild(agentRow(r)));\n    if (others.length) list.appendChild(agentOthers(others));", "if (others.length) list.appendChild(agentOthers(others));\n    running.forEach(r => list.appendChild(agentRow(r)));")], reason: /the running row is above the fold line/,
  },
];

/** One half of the spoiled-page runs: the witnesses at the positions `part` of `of` takes, so the files run side by side. */
export function agentWitnessTests(part: number, of: number) {
  test(`each agent list scenario fails on the page with the thing it guards spoiled (part ${part + 1} of ${of})`, async t => {
    for (const w of WITNESSES.filter((_, k) => k % of === part)) await t.test(w.bug, st => assert.rejects(() => w.scenario(st, w.reverts), (error: Error) => w.reason.test(error.message) || (assert.fail(`failed for another reason: ${error.message}`), false)));
  });
}
