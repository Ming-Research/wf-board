// The runner's block of the agent list on the page in a DOM library: the work the runner holds is a row each with the state its report
// gives, the level of its session and, for a turn running, what the runner last beat; the older list does not draw the same session
// twice. The rows' rules are tested on plain data in test/runner-rows.test.ts, the table's form in test/dom/runner-table.test.ts; where
// the block lies is not a question for this layer. docs/design.md, section 7, Agent list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rules } from "../../src/rules.ts";
import { wholeView } from "../../src/whole-view.ts";
import { startBoard } from "../e2e/board-server.ts";
import type { BoardServer } from "../e2e/board-server.ts";
import { DomPage } from "./page.ts";

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A piece of open work nobody holds, and the runner as the writer of that item's project. */
function target(board: BoardServer) {
  const s = board.store.snapshot(), now = Date.now(), row = wholeView(s, rules(s, now), now).rows.find(x => x.bucket === "unattended");
  assert.ok(row, "the generated board has an item nobody holds");
  return { id: row.id, runner: { author: s.items[row.id]!.group, session: "执行程序" } };
}
const rowOf = (bp: DomPage, id: string) => bp.$(`#agents .runner-row[data-agent="${id}"]`);
const cell = (bp: DomPage, id: string, name: string) => bp.$(`.${name}`, rowOf(bp, id)!);
// What the wide column says of the turn running, and what its hover says in full.
const turnLine = (bp: DomPage, id: string) => cell(bp, id, "rt-what")?.textContent ?? null;
const turnHover = (bp: DomPage, id: string) => cell(bp, id, "rt-what")?.title ?? null;

test("the runner's job is a row with its state, its level and the turn running; a beat puts the last action in the row, and the next state takes it away", async t => {
  const board = await startBoard(t), bp = await DomPage.open(t, board), { id, runner } = target(board);
  assert.equal(bp.visible(bp.$("#agents")), false, "no session has written yet: no list");
  const base = bp.changes();
  await board.ops.dispatchStart({ ...runner, id, role: "工程师", level: 2, model: "Sonnet", effort: "xhigh", agent: id, agentId: `${id}-1` });
  await board.ops.reportState({ ...runner, id, state: "running", note: "第 1 轮", turns: 1, cost: 0.5 });
  await bp.waitChanges(base + 2);
  const row = rowOf(bp, id);
  assert.ok(row, "the job has a row in the runner's block");
  assert.equal(cell(bp, id, "rt-level")!.textContent, "2", "the level is a small number before the title");
  assert.match(cell(bp, id, "rt-level")!.title, /2 级 Sonnet xhigh/, "the model and the effort are on its hover");
  assert.equal(cell(bp, id, "agent-state")!.textContent, "在跑");
  assert.match(cell(bp, id, "rt-total")!.textContent!, /^共 .* · 1 轮 · \$0\.50$/, "the time, turns and cost the runner reported");
  assert.equal(turnLine(bp, id), "第 1 轮，还没报这一轮的动作", "before any beat the row claims nothing about the turn's inside");
  assert.match(turnHover(bp, id)!, /执行程序还没报这一轮之内的动作/);
  assert.equal(bp.$("#agents .agents-toggle")!.textContent, "▾ 代理 1");
  assert.equal(bp.$$("#agents .agent").filter(r => r.dataset.agent === id).length, 1, "the older list does not draw the session a second time");
  assert.equal(bp.$$("#agents .agent").some(r => r.dataset.agent === "执行程序"), false, "and the runner's own writes are no session of it");
  // A beat is not a change of the board: the page hears it from the stream and the row gains the last action.
  await board.ops.reportLive({ ...runner, id, role: "工程师", turn: 1, turnSeconds: 125, idleSeconds: 4, action: "改 web/app.ts" });
  await bp.waitFor(() => turnLine(bp, id) === "改 web/app.ts", "the beat's action on the row");
  assert.equal(turnHover(bp, id), "第 1 轮 · 这一轮 2 分钟 · 最后动作 不到 1 分钟前：改 web/app.ts");
  assert.equal(cell(bp, id, "agent-state")!.textContent, "在跑 第 1 轮", "the beat's turn number joins the state");
  // The turn ends in a wait: the report says CI, so the line is the report's note, though the beat is still held.
  const waiting = bp.changes();
  await board.ops.reportState({ ...runner, id, state: "ci", note: "wf-board#9 提交 abc1234 的 CI" });
  await bp.waitChanges(waiting + 1);
  assert.equal(cell(bp, id, "agent-state")!.textContent, "等 CI");
  assert.equal(turnLine(bp, id), "wf-board#9 的 CI", "the report no longer says a turn runs; its note shows, without the commit id");
  const chip = () => bp.$(".agent-state.runner", rowOf(bp, id)!)!;
  assert.equal(chip().classList.contains("overdue"), false, "a wait inside its limit is not amber");
  // An exception has no time to wait out: the whole view's limit marks it at once, and a person has to look at it.
  const failed = bp.changes();
  await board.ops.reportState({ ...runner, id, state: "exception", note: "两轮没有交回状态" });
  await bp.waitChanges(failed + 1);
  assert.equal(cell(bp, id, "agent-state")!.textContent, "要人看");
  assert.equal(chip().classList.contains("overdue"), true, "past its limit, or an exception: amber");
  assert.equal(chip().classList.contains("needs-person"), true, "and red, for a person to look at");
  assert.equal(rowOf(bp, id)!.classList.contains("needs-person"), true);
  assert.deepEqual(bp.errors, []);
});

test("the architect's turn is drawn under the work that asks the architect while the runner says it runs, and a beat the runner stopped sending shows as silent", async t => {
  const board = await startBoard(t), bp = await DomPage.open(t, board), { id, runner } = target(board);
  let base = bp.changes();
  await board.ops.dispatchStart({ ...runner, id, role: "工程师", level: 2, model: "Sonnet", effort: "xhigh", agent: id, agentId: `${id}-1` });
  await board.ops.reportState({ ...runner, id, state: "ask", to: "architect", note: "架构师轮次在答" });
  await bp.waitChanges(base + 2);
  assert.equal(cell(bp, id, "agent-state")!.textContent, "等架构师");
  assert.equal(turnLine(bp, id), "架构师轮次在答", "no architect turn is running yet: only the wait is shown");
  await board.ops.reportLive({ ...runner, id, role: "架构师", turn: 3, turnSeconds: 70, idleSeconds: 2, action: "读 条目 " + id });
  await bp.waitFor(() => /^架构师在答/.test(turnLine(bp, id) ?? ""), "the architect's turn in the row");
  assert.equal(turnLine(bp, id), `架构师在答：读 条目 ${id}`);
  assert.equal(turnHover(bp, id), `架构师第 3 轮 · 这一轮 1 分钟 · 最后动作 不到 1 分钟前：读 条目 ${id}`);
  // The engineer is back at work: the architect's turn is over, though its beat is still held.
  base = bp.changes();
  await board.ops.reportState({ ...runner, id, state: "running", note: "第 2 轮" });
  await bp.waitChanges(base + 1);
  assert.equal(turnLine(bp, id), "第 2 轮，还没报这一轮的动作");
  // A beat the runner has not repeated for 200 seconds: silent, with what it last said, counted from when it was heard.
  const now = Date.now();
  board.live.put({ role: "工程师", item: id, turn: 2, turnStartedAt: iso(now - 600_000), lastActionAt: iso(now - 400_000), action: "跑 git push", at: iso(now - 200_000) });
  await bp.waitFor(() => /没有动静/.test(turnLine(bp, id) ?? ""), "the silent turn");
  assert.equal(turnLine(bp, id), "没有动静 3 分钟");
  assert.match(turnHover(bp, id)!, /^没有动静：执行程序 3 分钟没报这一轮；上次报的是第 2 轮，这一轮 6 分钟，最后动作 3 分钟前：跑 git push$/);
  assert.ok(bp.$(".rt-what.silent", rowOf(bp, id)!), "marked for the reader's eye");
  assert.deepEqual(bp.errors, []);
});
