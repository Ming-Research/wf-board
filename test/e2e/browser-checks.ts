// The checks of test/e2e/browser.e2e.ts that are not in invariants.ts (the page's layout) or mermaid-checks.ts (the diagrams): a smoke
// check, the agent list's place and jump, and the list of messages not being covered. Each returns its violations, each opening with its
// family name, so that a test asserts none and the page with the thing spoiled can be shown to report it.

import { ops } from "../../src/ops.ts";
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
