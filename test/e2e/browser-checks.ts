// The checks of test/e2e/browser.e2e.ts that are not in invariants.ts (the page's layout) or mermaid-checks.ts (the diagrams): a smoke
// check, the agent list's place and jump, the runner's table of the agent list, and the list of messages not being covered. Each returns its violations, each opening with its
// family name, so that a test asserts none and the page with the thing spoiled can be shown to report it.

import { ops } from "../../src/ops.ts";
import { rules } from "../../src/rules.ts";
import { wholeView } from "../../src/whole-view.ts";
import { openAll } from "./harness.ts";
import type { BoardPage, BoardServer } from "./harness.ts";
import type { Oracle } from "./invariants.ts";

/** The page is loaded, a click opens an item, and the page does not scroll sideways. */
export async function checkSmoke(bp: BoardPage, board: BoardServer): Promise<string[]> {
  const rows = await bp.treeRows(), id = board.gen.witness.code, v: string[] = [];
  if (rows.length <= 50) v.push(`smoke: the tree draws ${rows.length} rows of the generated board's items, not over 50`);
  await bp.select(id);
  if (await bp.selected() !== id) v.push(`smoke: a click on ${id} opened ${await bp.selected()}`);
  const [wide, window] = await bp.page.evaluate(() => [document.documentElement.scrollWidth, innerWidth] as const);
  if (wide > window + 1) v.push(`smoke: the page is ${wide} px wide in a window of ${window} px`);
  return v;
}

/** Items whose plans name cards (every one). */
export const planItems = (o: Oracle) => Object.keys(o.s.items).filter(id => o.s.items[id]!.plan.some(row => "card" in row));
/** The witness cards (one of every shape) and a sample of the rest. */
export const cardSample = (o: Oracle, w: BoardServer["gen"]["witness"]) => [...new Set([w.commentCard, w.multiPlanCard, w.donePlanCard, w.otherPlanCard, w.rowCard, w.recordCard, w.legacyCard, w.proseCard, w.withdrawnCard, w.openLegacyCard, ...Object.keys(o.s.decisions).slice(0, 30)])].filter(c => o.s.decisions[c]);

/** The agent list lies above the projects with room of its own, 在树中 lands on the item's row in the tree (far below the list) with the row in
 * view, and 返回 scrolls back to the list. Adds a running session to the board. */
export async function checkAgentList(bp: BoardPage, board: BoardServer): Promise<string[]> {
  const items = board.store.snapshot().items, rows = await bp.treeRows(), v: string[] = [];
  // An open item drawn far down the tree, so a jump to its row has to scroll the list.
  const id = [...rows].reverse().find(row => items[row] && !items[row]!.record && items[row]!.group);
  if (!id) return ["agent-list: the generated board draws no open item in the tree"];
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
  if (!layout.drawn) v.push("agent-list: the list has no height");
  if (!layout.aboveProjects) v.push("agent-list: the list does not lie above the projects");

  const top = await bp.page.evaluate(() => document.getElementById("page-left")!.scrollTop);
  await row.locator(".agitem-tree").first().click();
  await bp.settle();
  const landed = await bp.page.evaluate(id => {
    const tree = document.querySelector(`#areas [id="it-${id}"]`), pane = document.getElementById("page-left")!;
    if (!tree) return "no tree row";
    const r = tree.getBoundingClientRect(), p = pane.getBoundingClientRect();
    return r.top >= p.top - 1 && r.bottom <= p.bottom + 1 ? "in view" : `row ${r.top}..${r.bottom} outside the list ${p.top}..${p.bottom}`;
  }, id);
  if (landed !== "in view") v.push(`agent-list: the jump to the tree row of ${id} does not bring it into view: ${landed}`);
  const away = await bp.page.evaluate(() => document.getElementById("page-left")!.scrollTop);
  if (!(away > top + 500)) v.push(`agent-list: the jump did not scroll the list well away from the agent list (${top} to ${away})`);
  await bp.page.locator("#backbtn").click();
  await bp.settle();
  const back = await bp.page.evaluate(() => document.getElementById("page-left")!.scrollTop);
  if (!(Math.abs(back - top) <= 2)) v.push(`agent-list: Back does not scroll the list back to where the agent list was (${top}, now ${back})`);
  return v;
}

/** The five cells of a runner row, in the order they lie in a wide row. */
const RUNNER_CELLS = ["rt-title", "agent-state", "rt-what", "rt-since", "rt-total"] as const;
/** The boxes (left, top, right, bottom) of the runner's table, its head and its rows' cells, and whether a row's line of text is cut. */
const measureRunnerTable = (bp: BoardPage) => bp.page.evaluate(cells => {
  const box = (e: Element): number[] => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
  const rows = [...document.querySelectorAll<HTMLElement>("#agents .runner-row")].map(row => {
    const what = row.querySelector<HTMLElement>(".rt-what")!;
    return { id: row.dataset.agent!, box: box(row), cells: cells.map(c => box(row.querySelector("." + c)!)), cut: what.scrollWidth > what.clientWidth, overflow: getComputedStyle(what).textOverflow };
  });
  const head = document.querySelector("#agents .runner-head");
  return {
    rows, head: head ? [...head.children].map(box) : [], headShown: !!head && getComputedStyle(head).display !== "none",
    page: [document.documentElement.scrollWidth, innerWidth], pane: document.getElementById("page-left")!.clientWidth,
  };
}, RUNNER_CELLS as unknown as string[]);

/** The runner's table of the agent list in a window 1280 px wide: the rows are as tall as one line whatever their text, their cells and the
 * head's line up from row to row, a text too long is cut with an ellipsis and a short one is not, the rows a person looks at come first, and
 * nothing makes the page scroll sideways; with an item open the list's column is narrow and a row falls to three lines. Adds three jobs
 * held by the runner to the board and loads the page afresh. */
export async function checkRunnerTable(bp: BoardPage, board: BoardServer): Promise<string[]> {
  const v: string[] = [], s = board.store.snapshot(), now = Date.now();
  const free = wholeView(s, rules(s, now), now).rows.filter(x => x.bucket === "unattended").map(x => x.id);
  const [running, failed, waiting] = free;
  if (!running || !failed || !waiting) return ["runner-table: the generated board has fewer than three items nobody holds"];
  const runner = (id: string) => ({ author: s.items[id]!.group, session: "执行程序" });
  const base = await bp.changes();
  for (const id of [running, failed, waiting]) await board.ops.dispatchStart({ ...runner(id), id, role: "工程师", level: 2, model: "Sonnet", effort: "xhigh", agent: id, agentId: `${id}-1` });
  await board.ops.reportState({ ...runner(running), id: running, state: "running", note: "第 1 轮" });
  await board.ops.reportState({ ...runner(failed), id: failed, state: "exception", note: "这是一段很长的说明文字，".repeat(9) });
  await board.ops.reportState({ ...runner(waiting), id: waiting, state: "ci", note: "wf-board#9 的 CI" });
  await board.ops.reportLive({ ...runner(running), id: running, role: "工程师", turn: 1, turnSeconds: 90, idleSeconds: 3, action: "改 " + "some-long-directory/".repeat(3) + "file.ts" });
  await bp.waitChanges(base + 6);
  await bp.reset(openAll(board));
  await bp.page.setViewportSize({ width: 1280, height: 1000 });
  try {
    await bp.page.waitForSelector("#agents .runner-row");
    await bp.settle();
    const wide = await measureRunnerTable(bp), near = (a: number, b: number) => Math.abs(a - b) <= 1.5;
    if (wide.rows.map(r => r.id).join() !== [failed, running, waiting].join()) v.push(`runner-table: the rows are ${wide.rows.map(r => r.id).join()}, not the exception, the turn running, the wait`);
    if (wide.pane < 1000) v.push(`runner-table: the list's column is ${wide.pane} px wide in a window of 1280 px, not the page's width`);
    if (!wide.headShown) v.push("runner-table: the head of the columns is not drawn");
    const heights = wide.rows.map(r => r.box[3]! - r.box[1]!);
    if (Math.max(...heights) > 40 || Math.max(...heights) - Math.min(...heights) > 1.5) v.push(`runner-table: the rows are ${heights.map(h => h.toFixed(1)).join(", ")} px tall, not one line each of the same height`);
    RUNNER_CELLS.forEach((cell, k) => {
      const lefts = wide.rows.map(r => r.cells[k]![0]!);
      if (Math.max(...lefts) - Math.min(...lefts) > 1.5) v.push(`runner-table: the cell ${cell} starts at ${lefts.map(x => x.toFixed(1)).join(", ")} px in the rows, not in a column`);
      if (wide.head[k] && !near(wide.head[k]![0]!, lefts[0]!)) v.push(`runner-table: the head of ${cell} starts at ${wide.head[k]![0]!.toFixed(1)} px, its cells at ${lefts[0]!.toFixed(1)} px`);
    });
    for (const r of wide.rows) {
      if (r.cells.some(c => c[2]! > r.box[2]! + 1 || c[1]! < r.box[1]! - 1 || c[3]! > r.box[3]! + 1)) v.push(`runner-table: a cell of ${r.id} lies outside its row`);
      if (r.cells.some((c, k) => k > 0 && c[0]! < r.cells[k - 1]![2]! - 1)) v.push(`runner-table: the cells of ${r.id} overlap`);
    }
    const [longRow, shortRow] = [wide.rows.find(r => r.id === failed)!, wide.rows.find(r => r.id === waiting)!];
    if (!longRow.cut || longRow.overflow !== "ellipsis") v.push(`runner-table: a text of 117 characters is not cut with an ellipsis (cut ${longRow.cut}, text-overflow ${longRow.overflow})`);
    if (shortRow.cut) v.push("runner-table: a short text is cut");
    if (wide.page[0]! > wide.page[1]! + 1) v.push(`runner-table: the page is ${wide.page[0]} px wide in a window of ${wide.page[1]} px`);
    // With an item open the list's column is the tree's, about 300 px: the cells of a row lie on three lines.
    await bp.select(failed);
    await bp.settle();
    const narrow = await measureRunnerTable(bp);
    if (narrow.pane >= 760) v.push(`runner-table: with an item open the list's column is ${narrow.pane} px wide, not under 760`);
    if (narrow.headShown) v.push("runner-table: the head of the columns is drawn in a narrow column");
    for (const r of narrow.rows) {
      const [title, state, what, since, total] = r.cells as [number[], number[], number[], number[], number[]];
      if (!(title[1]! < state[1]! - 1 && state[1]! < since[1]! - 1)) v.push(`runner-table: the cells of ${r.id} do not lie on three lines in a narrow column (tops ${title[1]}, ${state[1]}, ${since[1]})`);
      if (!near(state[1]!, what[1]!) || !near(since[1]!, total[1]!) || !(what[0]! > state[2]! - 1) || !(total[0]! > since[2]! - 1)) v.push(`runner-table: the state and its text, or the two times, do not lie side by side in ${r.id}`);
      if (r.cells.some(c => c[0]! < r.box[0]! - 1 || c[2]! > r.box[2]! + 1)) v.push(`runner-table: a cell of ${r.id} lies outside its row in a narrow column`);
    }
    if (narrow.page[0]! > narrow.page[1]! + 1) v.push(`runner-table: with an item open the page is ${narrow.page[0]} px wide in a window of ${narrow.page[1]} px`);
  } finally {
    await bp.page.setViewportSize({ width: 1500, height: 1000 });
  }
  return v;
}

/** Nothing on the page covers the list of messages once it is open. Adds a message to the board. */
export async function checkMessages(bp: BoardPage, board: BoardServer): Promise<string[]> {
  const items = board.store.snapshot().items;
  const item = Object.keys(items).find(id => !items[id]!.record && items[id]!.group);
  if (!item) return ["messages: the generated board has no open item"];
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
  return onTop ? [] : ["messages: something on the page covers the list of messages"];
}
