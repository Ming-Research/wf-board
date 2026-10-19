// The runner's block of the agent list as a table on the page in a DOM library (docs/design.md, section 7, Agent list): a row for each piece
// of work, the title first with the level as a small number before it, the item's key on the title's hover and nowhere else, the state in a
// word, one line for what the work does or waits for, cut to one line by the stylesheet, no commit id and no path of the machine, and each
// of the level and the times once; a person's work first. Where the cells lie is for the browser layer (test/e2e/browser-checks.ts). The
// scenario also runs on pages with one thing spoiled, where it must fail for the reason it states.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rules } from "../../src/rules.ts";
import { wholeView } from "../../src/whole-view.ts";
import { startBoard } from "../e2e/board-server.ts";
import type { Hooks } from "../e2e/board-server.ts";
import type { Revert } from "../e2e/variant.ts";
import { DomPage } from "./page.ts";
import { Styles } from "./styles.ts";

const app = (edit: string, find: string, replace: string): Revert => ({ file: "web/app.ts", edit, find, replace });
const html = (edit: string, find: string, replace: string): Revert => ({ file: "web/index.html", edit, find, replace });

/** Everything a row shows or says on hover: its text and the `title` of each of its elements. */
const sayings = (row: Element) => [row, ...row.querySelectorAll("*")].flatMap(e => [e.textContent ?? "", e.getAttribute("title") ?? ""]).join("\n");

export async function runnerTable(t: Hooks, reverts: Revert[] = []) {
  const board = await startBoard(t), s = board.store.snapshot(), now = Date.now();
  // Titles of plain text whose key does not occur in them, so that the key's place in a row is told by where it stands.
  const plainTitle = (id: string) => !/[*`[\]]|级|Sonnet|xhigh/.test(s.items[id]!.title) && !s.items[id]!.title.includes(id);
  const free = wholeView(s, rules(s, now), now).rows.filter(x => x.bucket === "unattended" && plainTitle(x.id)).map(x => x.id);
  const [running, failed, waiting, asking, waitedFor] = free;
  if (!running || !failed || !waiting || !asking || !waitedFor) throw new Error("the generated board has fewer than five items nobody holds (four jobs and the item one of them waits for)");
  const card = Object.keys(s.decisions).find(id => !/[*`[\]]/.test(s.decisions[id]!.question));
  assert.ok(card, "and a card with a plain question");
  const bp = await DomPage.open(t, board, { reverts }), runner = (id: string) => ({ author: s.items[id]!.group, session: "执行程序" });
  const base = bp.changes();
  // The jobs began two hours ago, the one running five (and half a minute more, so that a report stamped to the second a moment before this test's
  // clock still leaves two full hours of work): each agent's line is its session's span, so the work before the state it reports is a segment of
  // its own, and five hours are longer than the three a segment is drawn in full.
  const began = new Date(now - 2 * 3600_000 - 30_000).toISOString(), beganLong = new Date(now - 5 * 3600_000 - 30_000).toISOString(), startOf = (id: string) => id === running ? beganLong : began;
  let n = 0;
  for (const id of [running, failed, waiting, asking]) {
    await board.ops.dispatchStart({ ...runner(id), id, role: "工程师", level: 2, model: "Sonnet", effort: "xhigh", agent: id, agentId: `${id}-1`, startedAt: startOf(id) });
    n++;
  }
  await board.ops.reportState({ ...runner(asking), id: asking, state: "ask", to: "owner", cards: [card], startedAt: startOf(asking) });
  await board.ops.reportState({ ...runner(failed), id: failed, state: "exception", note: "提交 0578e89 的 CI 红了，日志在 ~/Library/Logs/wf-board.log", startedAt: startOf(failed) });
  await board.ops.reportState({ ...runner(waiting), id: waiting, state: "items", items: [waitedFor], startedAt: startOf(waiting) });
  await board.ops.reportState({ ...runner(running), id: running, state: "running", note: "第 1 轮", turns: 1, cost: 0.5, startedAt: startOf(running) });
  await board.ops.reportLive({ ...runner(running), id: running, role: "工程师", turn: 1, turnSeconds: 125, idleSeconds: 4, action: "改 /Users/user/dev/x/web/app.ts" });
  await bp.waitChanges(base + n + 4);
  await bp.waitFor(() => /app\.ts/.test(bp.$(`.runner-row[data-agent="${running}"] .rt-what`)?.textContent ?? ""), "the beat's action on the row");

  const rows = bp.$$("#agents .runner-row"), by = (id: string) => rows.find(r => r.dataset.agent === id)!;
  assert.equal(rows.length, 4);
  const header = bp.$("#agents .runner-head");
  assert.deepEqual([...header!.children].map(c => c.textContent), ["标题", "状态", "在做或在等", "这个状态", "合计", "时间线"], "the columns are named");
  // A person's work first (the longest in its state first), then the turn running, then the waiting.
  assert.deepEqual(new Set(rows.slice(0, 2).map(r => r.dataset.agent)), new Set([failed, asking]), "an ask to the owner and an exception come first");
  assert.deepEqual(rows.slice(2).map(r => r.dataset.agent), [running, waiting], "then the turn running, then what waits");
  for (const r of rows.slice(0, 2)) assert.ok(r.classList.contains("needs-person"), "the rows a person looks at are marked");
  assert.equal(by(running).classList.contains("needs-person"), false);

  for (const id of [running, failed, waiting, asking]) {
    const row = by(id), title = s.items[id]!.title, cells = [...row.children].map(c => c.className.split(" ")[0]);
    assert.deepEqual(cells, ["rt-title", "agent-state", "rt-what", "rt-since", "rt-total", "rt-line"], `${id}: the six cells of a row, the title first and the line last`);
    const name = bp.$(".rt-name", row)!;
    assert.equal(name.textContent, title, `${id}: the title stands in the row`);
    assert.ok(!row.textContent!.includes(id), `${id}: the key is not in the row`);
    assert.equal(name.getAttribute("title"), `${id} · ${title}`, `${id}: the key is on the title's hover`);
    assert.equal(bp.$$(".rt-level", row).length, 1, `${id}: the level is drawn once`);
    assert.doesNotMatch(row.textContent!, /级|Sonnet|xhigh/, `${id}: the level is only a number, its model and effort are on its hover`);
    assert.equal(bp.$(".rt-level", row)!.textContent, "2");
    assert.equal(bp.$$(".rt-since", row).length + bp.$$(".rt-total", row).length, 2, `${id}: the two times are two cells`);
    assert.equal(bp.$$(".agent-ago, .agitem-time, .agitem-tree, .agitem-st, .agent-name", row).length, 0, `${id}: no second time, no link into the tree, no item chip, no key in monospace`);
    assert.match(bp.$(".rt-since", row)!.textContent!, /^(不到 1 分钟|\d+ 分钟)$/);
    assert.match(bp.$(".rt-total", row)!.textContent!, /^共 /);
    const said = sayings(row);
    assert.doesNotMatch(said, /0578e89|\/Users|Library\/Logs|~\//, `${id}: no commit id and no path of the machine`);
  }
  // The line of the agent (src/timeline.ts): its session began with a turn, then one segment of the kind its reported state makes (the state `running` is the turn itself),
  // and each segment says on hover what it is.
  for (const [id, kinds, label] of [[running, ["work"], "干活"], [failed, ["work", "person"], "要人看"], [waiting, ["work", "items"], "等条目"], [asking, ["work", "owner"], "等主人"]] as const) {
    const segments = bp.$$(".rt-line .tl", by(id)), last = segments.at(-1)!;
    assert.deepEqual(segments.map(x => x.dataset.kind), kinds, `${id}: the line has a segment of the work and one of the state it reports`);
    assert.ok(last.classList.contains("tl-" + kinds.at(-1)), `${id}: the segment is coloured by its kind`);
    assert.match(last.getAttribute("title") ?? "", new RegExp("^" + label + " · "), `${id}: the hover of the segment says what it is and how long`);
  }
  // The legend under the header lists each kind some row draws, once, in the order of the kinds; each swatch is coloured as its segments are.
  const items = [...bp.$$("#agents .runner-legend-item")];
  assert.deepEqual(items.map(c => c.textContent), ["干活", "等主人", "等条目", "要人看"], "the legend lists the kinds the rows draw, in order, and no other");
  for (const item of items) {
    const swatch = item.querySelector("i")!, kind = swatch.classList[1] ?? "none";
    assert.ok(swatch.classList.contains("tl-swatch"), "a swatch is a coloured square");
    assert.ok(bp.$$(`#agents .rt-line .${kind}`).length > 0, `the swatch of ${item.textContent} is the colour class of the segments of that kind`);
  }
  // Each segment is as long as the time it took, up to three hours; a longer one is drawn shorter with a gap marked in it, and the hover says how long it was.
  const grow = (seg: Element) => Number((seg as HTMLElement).style.flexGrow);
  const [askWork, askWait] = bp.$$(".rt-line .tl", by(asking)) as [HTMLElement, HTMLElement];
  assert.ok(Math.abs(grow(askWork) - 120) < 3, `a segment is drawn as long as the time it took: two hours of work are 120 minutes, not ${grow(askWork)}`);
  assert.ok(grow(askWait) >= 1 && grow(askWait) < 3, `the wait that has just begun is the one minute a segment is drawn with at least, not ${grow(askWait)}`);
  assert.ok(grow(askWork) > 40 * grow(askWait), `the two hours are drawn about a hundred and twenty times as long as the wait just begun (${grow(askWork)} to ${grow(askWait)})`);
  const long = bp.$$(".rt-line .tl", by(running))[0]!;
  assert.ok(Math.abs(grow(long) - 192) < 1, `a segment over three hours is drawn shorter: five hours are 180 minutes and a tenth of the 120 beyond, 192, not ${grow(long)}`);
  assert.equal(bp.$$(".tl-gap", long).length, 1, "a gap is marked in a segment drawn shorter than it was");
  assert.match(long.getAttribute("title")!, /这一段太长，画短了/, "and its hover says so");
  for (const id of [failed, waiting, asking]) assert.equal(bp.$$(".rt-line .tl-gap", by(id)).length, 0, `${id}: no gap in a line of segments under three hours`);
  assert.match(askWork.getAttribute("title")!, /^干活 · 2 小时( \d+ 分)? · /, "the hover of a segment says how long it was");
  assert.match(askWait.getAttribute("title")!, /^等主人 · (不到 1 分钟|\d+ 分钟) · /, "the hover of the wait says how long it was");
  assert.match(long.getAttribute("title")!, /^干活 · 5 小时( \d+ 分)? · /, "the hover of the long segment has its whole time, not the drawn one");
  assert.match(bp.$$(".rt-line .tl", by(asking)).at(-1)!.getAttribute("title")!, new RegExp(s.decisions[card]!.question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "an ask's segment says the question of the card it waits for");
  // What each row says in the wide column: the last action of the turn, the note, the titles of what it waits for, the question of the card.
  assert.equal(bp.$(".rt-what", by(running))!.textContent, "改 app.ts");
  assert.equal(bp.$(".rt-what", by(failed))!.textContent, "的 CI 红了，日志在 wf-board.log");
  assert.equal(bp.$(".rt-what", by(waiting))!.textContent, s.items[waitedFor]!.title);
  assert.equal(bp.$(".rt-what", by(waiting))!.getAttribute("title"), `${s.items[waitedFor]!.title}（${waitedFor}）`, "the key of what it waits for is on the hover");
  assert.equal(bp.$(".rt-what", by(asking))!.textContent, s.decisions[card]!.question);
  // A long line is cut to one line by the stylesheet and says the rest on hover.
  const st = new Styles(bp.win, { width: 1280 });
  for (const row of rows) {
    const what = bp.$(".rt-what", row)!, name = bp.$(".rt-name", row)!;
    for (const [cell, prop, value] of [[what, "white-space", "nowrap"], [what, "overflow", "hidden"], [what, "text-overflow", "ellipsis"], [name, "white-space", "nowrap"], [name, "text-overflow", "ellipsis"]] as const) {
      assert.equal(st.value(cell, prop), value, `a long ${cell.className.split(" ")[0]} is cut to one line: ${prop} is ${st.value(cell, prop)}, not ${value}`);
    }
    assert.ok(what.getAttribute("title"), "the full text is on the hover");
  }
  // A click on the title opens the item.
  bp.click(bp.$(".rt-name", by(waiting)), "the title");
  await bp.settle();
  assert.equal(bp.selected(), waiting, "a title click selects the item");
  assert.deepEqual(bp.errors, []);
}

test("the runner's block is a table: the title first, the key on the hover only, one cut line for what it does, no commit id and no path, a person's work first", async t => {
  await runnerTable(t);
});

const WITNESSES: Array<{ bug: string; reverts: Revert[]; reason: RegExp }> = [
  {
    bug: "a row showed the item's key where the title belongs",
    reverts: [app("the key stands for the title", 'const title = el("button", "agitem-title rt-name", it ? inline(it.title) : esc(x.item));', 'const title = el("button", "agitem-title rt-name", esc(x.item));')], reason: /the title stands in the row/,
  },
  {
    bug: "the key was not on the title's hover",
    reverts: [app("the hover has the title only", 'title.title = it ? x.item + " · " + plain(it.title) : x.item;', "title.title = it ? plain(it.title) : x.item;")], reason: /the key is on the title's hover/,
  },
  {
    bug: "a long line in the wide column was not cut to one line",
    reverts: [html("the line is not cut", ".rt-what, .rt-total { overflow: hidden; text-overflow: ellipsis; }\n", "")], reason: /a long rt-what is cut to one line/,
  },
  {
    bug: "a segment of the line said nothing on hover",
    reverts: [app("the segment has no hover", "cell.title = segmentTip(seg);", "")], reason: /the hover of the segment says what it is/,
  },
  {
    bug: "a segment of the line was not coloured by its kind",
    reverts: [app("the segment has no kind", 'const cell = el("span", "tl tl-" + seg.kind);', 'const cell = el("span", "tl");')], reason: /the segment is coloured by its kind/,
  },
  {
    bug: "a swatch of the legend had no colour of its kind",
    reverts: [app("the swatch has no kind", 'item.appendChild(el("i", "tl-swatch tl-" + kind));', 'item.appendChild(el("i", "tl-swatch"));')], reason: /the swatch of 干活 is the colour class/,
  },
  {
    bug: "the legend listed every kind, not those the rows draw",
    reverts: [app("the legend lists all kinds", "SEGMENT_KINDS.filter(kind => seen.has(kind)).forEach", "SEGMENT_KINDS.forEach")], reason: /the legend lists the kinds the rows draw/,
  },
  {
    bug: "every segment of a line was drawn as long as the next",
    reverts: [app("the length is a constant", 'cell.style.flexGrow = String(Math.max(drawLength(seg.to - seg.from) / 60_000, 1));', 'cell.style.flexGrow = "1";')], reason: /a segment is drawn as long as the time it took/,
  },
  {
    bug: "a segment of five hours was drawn the whole five hours",
    reverts: [app("the long segment is not shortened", 'cell.style.flexGrow = String(Math.max(drawLength(seg.to - seg.from) / 60_000, 1));', 'cell.style.flexGrow = String(Math.max((seg.to - seg.from) / 60_000, 1));')], reason: /a segment over three hours is drawn shorter/,
  },
  {
    bug: "a segment drawn shorter than it was had no gap marked in it",
    reverts: [app("the gap is not marked", 'if (seg.to - seg.from > LONG_SEGMENT_MS) cell.appendChild(el("i", "tl-gap"));', "")], reason: /a gap is marked in a segment drawn shorter/,
  },
  {
    bug: "the hover of a segment did not say how long it was",
    reverts: [app("the hover has no length", '[SEGMENT_TEXT[seg.kind] + " · " + spanText(seg.to - seg.from) + " · " + clockText(seg.from) + " 起", waits,', '[SEGMENT_TEXT[seg.kind] + " · " + clockText(seg.from) + " 起", waits,')], reason: /the hover of a segment says how long it was/,
  },
  {
    bug: "a click on the title opened nothing",
    reverts: [app("the title does not select", 'title.addEventListener("click", ev => { ev.stopPropagation(); selectItem(x.item); setCurrent(itemBox(x.item)); });', 'title.addEventListener("click", ev => { ev.stopPropagation(); });')], reason: /a title click selects the item/,
  },
  {
    bug: "the level was written out with its model in every row",
    reverts: [app("the level is written out", 'el("span", "tagchip diffchip rt-level", String(x.level))', 'el("span", "tagchip diffchip rt-level", x.level + " 级 " + x.model)')], reason: /the level is only a number/,
  },
];

test("the table's scenario fails on a page with the thing it guards spoiled", async t => {
  for (const w of WITNESSES) await t.test(w.bug, st => assert.rejects(() => runnerTable(st, w.reverts), (error: Error) => w.reason.test(error.message) || (assert.fail(`failed for another reason: ${error.message}`), false)));
});
