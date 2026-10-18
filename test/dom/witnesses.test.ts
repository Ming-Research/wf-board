// Evidence that the page checks of test/dom/checks.ts catch what they guard: each runs on the current page, where test/dom/page-families.ts
// holds it to find nothing, and here on the page with one thing spoiled, a copy edited as it is bundled (test/e2e/variant.ts), where it
// must report the family the spoiled thing belongs to. A witness whose edit no longer matches the current file fails loudly; update or
// retire it then. Most spoilings are small bugs of the kind the check exists for (a click that selects the wrong item, a number that
// counts one too many); some are the bugs the browser layer's witnesses (test/e2e/regressions.e2e.ts) once showed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard, openAll } from "../e2e/board-server.ts";
import type { BoardServer } from "../e2e/board-server.ts";
import type { Revert } from "../e2e/variant.ts";
import { DomPage } from "./page.ts";
import { oracle, checkTreeRows, checkPlanRows, checkCardBox, checkDependents, checkBadges, checkWaitPanel, checkFresh, checkFilters, checkSearch, checkComments, checkEmptyRows, checkTagText, checkDifficultyChip, checkIdleStatus } from "./checks.ts";

const app = (edit: string, find: string, replace: string): Revert => ({ file: "web/app.ts", edit, find, replace });
interface Witness { bug: string; reverts: Revert[]; family: string; storage?: (b: BoardServer) => Record<string, unknown>; run: (bp: DomPage, b: BoardServer) => Promise<string[]> }
// Some of the tree's rows are enough to see a bug that every row has.
const some = (bp: DomPage, n = 6) => bp.treeRows().filter((_, k) => k % Math.ceil(bp.treeRows().length / n) === 0);

const WITNESSES: Witness[] = [
  {
    bug: "a click on a tree row's title selected the item that was selected before",
    reverts: [app("selecting keeps the old item", "rememberSelected(id); detailDirty = true;", "rememberSelected(selectedItem ?? id); detailDirty = true;")], family: "tree-row",
    run: async (bp, b) => checkTreeRows(bp, await oracle(b.store), some(bp)),
  },
  {
    bug: "a plan row for an item pointed at a card of that name, so the click went nowhere",
    reverts: [app("an item row's link names a card", 'link.dataset.ref = (kind === "item" ? "it:" : "q:") + id;', 'link.dataset.ref = "q:" + id;')], family: "plan-item-row",
    run: async (bp, b) => { const o = await oracle(b.store); return checkPlanRows(bp, o, Object.keys(o.s.items).filter(id => o.s.items[id]!.plan.some(row => "item" in row && !row.own)).slice(0, 2)); },
  },
  {
    bug: "following a link left nothing for Back to return to",
    reverts: [app("no place is remembered", "backStack.push({ key: fromList ? null : targetOnScreen(), y: listScroller().position() });", "void { key: fromList ? null : targetOnScreen(), y: listScroller().position() };")], family: "back",
    run: async (bp, b) => { const o = await oracle(b.store); return checkPlanRows(bp, o, Object.keys(o.s.items).filter(id => o.s.items[id]!.plan.some(row => "item" in row && !row.own)).slice(0, 2)); },
  },
  {
    bug: "a card row in a plan did not go to the card in the item's body (feature, card-in-plan)",
    // The click handler keeps its default-prevention and does nothing else: the row stays put.
    reverts: [app("a card row does not go to the card", 'const jumpToCard = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); jump("q-" + stored.card); };', "const jumpToCard = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); };")], family: "plan-card-row",
    run: async (bp, b) => { const o = await oracle(b.store), w = b.gen.witness; return checkPlanRows(bp, o, [...new Set([w.multiPlanCard, w.donePlanCard, w.rowCard, w.openLegacyCard].map(c => o.s.decisions[c]!.item))]); },
  },
  {
    bug: "a step row of a plan was not a selectable place, so a click on it cleared the selection",
    reverts: [app("a step row is not selectable", '      row.dataset.sel = "row:" + it.id + "@" + stored.id;\n      row.id = planRowId(it.id, stored.id);', '      row.id = planRowId(it.id, stored.id);')], family: "plan-step-row",
    run: async (bp, b) => { const o = await oracle(b.store); return checkPlanRows(bp, o, Object.keys(o.s.items).filter(id => o.s.items[id]!.plan.some(row => "text" in row)).slice(0, 2)); },
  },
  {
    bug: "a ruled card showed its question, options or pick wrongly: a ruled one without what was chosen (feature, card-in-plan)",
    reverts: [app("a ruled card shows no pick", 'else if (d.status === "ruled") top.appendChild(el("span", "pick pickshort"', 'else if (false as boolean) top.appendChild(el("span", "pick pickshort"')], family: "card-box",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.donePlanCard, w.legacyCard]); },
  },
  {
    bug: "a card showed its question twice, once in its heading and again in a second heading (owner, 2026-10-14)",
    reverts: [app("a card draws its heading twice", "top.appendChild(h);", "top.appendChild(h); top.appendChild(h.cloneNode(true));")], family: "card-question",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.commentCard, w.multiPlanCard]); },
  },
  {
    bug: "an open card showed its option names without what each option does, costs and risks (feature, card-in-plan)",
    reverts: [app("an option shows no detail", "const detail = o.detail ? '<div class=\"rich optdetail\">'", "const detail = o.detail && !o.detail ? '<div class=\"rich optdetail\">'")], family: "card-option-detail",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.commentCard, w.multiPlanCard], true); },
  },
  {
    bug: "an open card did not show how sure its writer is of the recommended option (feature, card-in-plan)",
    reverts: [app("an open card shows no confidence", "if (confidence) c.appendChild(confidence);", "")], family: "card-confidence",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.commentCard, w.multiPlanCard], true); },
  },
  {
    bug: "a card's old background showed unfolded instead of folded under 原卡的背景 (feature, card-in-plan)",
    reverts: [app("old card text starts unfolded", "fold.open = refOpen[key] ?? !closed;", "fold.open = true;")], family: "card-legacy",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.legacyCard, w.proseCard], true); },
  },
  {
    bug: "a ruled card filled the item's body with its whole pick and old text instead of being one line (owner, 2026-10-16)",
    reverts: [app("a closed card shows all of its content", "fold.dataset.ref = key; fold.open = !!refOpen[key];\n      fold.appendChild(top)", "fold.dataset.ref = key; fold.open = true;\n      fold.appendChild(top)")], family: "card-fold",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.legacyCard, w.donePlanCard], true); },
  },
  {
    bug: "a card whose line stands in the item's head showed after the head instead of at that line (feature, card-in-plan)",
    reverts: [app("a line holding only a card key places no card", "key => own.has(key) && !placed.has(key) && !!placed.add(key)", "key => false")], family: "card-place",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.multiPlanCard, w.commentCard]); },
  },
  {
    bug: "a card its item's head does not place was drawn without the line that tells the writer it has no place (architect, 2026-10-16)",
    reverts: [app("a card with no place has no note", 'body.appendChild(el("div", "unplacednote", "这张卡在正文里没标位置：补上一行 <code>[[q:" + esc(key) + "]]</code>" + (d.status === "open" ? "，或者撤回它。" : "。")));', "")], family: "card-unplaced",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.otherPlanCard, w.rowCard], true); },
  },
  {
    bug: "a dependent row went to the item it hangs under, not to the dependent",
    reverts: [app("a dependent row follows its own item", "b.addEventListener(\"click\", ev => { ev.stopPropagation(); follow(d.id); });", "b.addEventListener(\"click\", ev => { ev.stopPropagation(); follow(from.id); });")], family: "dep-row",
    run: async (bp, b) => { const o = await oracle(b.store); return checkDependents(bp, o, Object.keys(o.s.items).filter(id => o.r.dependents(id).some(d => !d.own)).slice(0, 2)); },
  },
  {
    bug: "the purple and red numbers counted one wait too many",
    reverts: [app("a wait number counts one too many", 'const chip = el("span", cls, String(count));', 'const chip = el("span", cls, String(count + 1));')], family: "badge-count",
    run: async (bp, b) => { const o = await oracle(b.store); return checkBadges(bp, o, bp.treeRows().filter(id => o.purple(id).length + o.red(id).length > 0).slice(0, 4)); },
  },
  {
    bug: "a number clicked as often as it says went back to its first wait every time",
    reverts: [app("a wait number always goes to the first wait", "goStop(ks[at % ks.length]!)", "goStop(ks[0]!)")], family: "badge-landing",
    run: async (bp, b) => { const o = await oracle(b.store); return checkBadges(bp, o, bp.treeRows().filter(id => o.purple(id).length + o.red(id).length > 1).slice(0, 4)); },
  },
  {
    bug: "the header's 阻塞 number counted one wait too many",
    reverts: [app("the blocking number counts one too many", '"阻塞 " + blocking + " ›"', '"阻塞 " + (blocking + 1) + " ›"')], family: "wait-count",
    run: async (bp, b) => checkWaitPanel(bp, await oracle(b.store)),
  },
  {
    bug: "a row of the wait panel for a card went to its item and not to the card",
    reverts: [app("a wait panel row skips the card", 'if (r.card) jumpTo("card", r.st.id.slice(2)); else if (r.st.item) jumpTo("item", r.st.item);', 'if (r.st.item) jumpTo("item", r.st.item);')], family: "wait-landing",
    run: async (bp, b) => checkWaitPanel(bp, await oracle(b.store)),
  },
  {
    bug: "a blue number counted one item too many",
    reverts: [app("a blue number counts one too many", 'head.appendChild(freshChip("it:" + it.id, freshCount, ownFresh));', 'head.appendChild(freshChip("it:" + it.id, freshCount + 1, ownFresh));')], family: "fresh-count",
    run: async (bp, b) => checkFresh(bp, await oracle(b.store), some(bp), false),
  },
  {
    bug: "the header's 新 number counted one unit too many",
    reverts: [app("the new number counts one too many", '"新 " + fresh + " ›"', '"新 " + (fresh + 1) + " ›"')], family: "new-count",
    run: async (bp, b) => checkFresh(bp, await oracle(b.store), [], false),
  },
  {
    bug: "n landed on done or cancelled items the left tree hid (owner, 2026-10-14)",
    // Both halves of the fix, removed where they stand: closed items holding unread content leave the tree, and n's stops no longer
    // follow the tree, so n lands on rows the tree does not show.
    reverts: [app("closed items holding unread content stay in the tree", "openWorkAncestors().has(it.id) || freshPath().has(it.id); }", "openWorkAncestors().has(it.id); }"),
      app("new-content stops follow the shown tree", " && (!st.item || !index().byId.has(st.item) || treeShown(st.item))", "")], family: "n-walk",
    run: async (bp, b) => checkFresh(bp, await oracle(b.store), [], true),
  },
  {
    bug: "a filter button counted one item too many",
    reverts: [app("a status filter counts one too many", 'if (n || on) row.appendChild(btn(on, label + " " + n, title + "（可多选）", () => toggleStatusFilter(g, key)));', 'if (n || on) row.appendChild(btn(on, label + " " + (n + 1), title + "（可多选）", () => toggleStatusFilter(g, key)));')], family: "filter-count",
    run: async (bp, b) => { const o = await oracle(b.store); return checkFilters(bp, o, [o.s.board.projects[0]!.name]); },
  },
  {
    bug: "a tag filter showed the project's closed items undimmed",
    reverts: [app("filters keep closed items", ": !ended(it);\n    const d = DEP_FILTERS", ": true;\n    const d = DEP_FILTERS")], family: "filter-sound",
    run: async (bp, b) => { const o = await oracle(b.store); return checkFilters(bp, o, [o.s.board.projects[0]!.name]); },
  },
  {
    bug: "choosing a search result did nothing",
    reverts: [app("Enter in the search does not open the result", 'else if (ev.key === "Enter" && found.current) { ev.preventDefault(); const t = found.current; closeSearch(); jumpTo(t.kind, t.key); }', 'else if (ev.key === "Enter" && found.current) { ev.preventDefault(); closeSearch(); }')], family: "search",
    run: async (bp, b) => checkSearch(bp, await oracle(b.store), 7, 4),
  },
  {
    bug: "saving a comment on a card folded its comment list and hid the 发送 button (fixed in 1ecc074)",
    // The fix's two lines, removed where they stand now: opening a comment and saving one unfold the list.
    reverts: [app("opening a comment unfolds its list", '    // Writing a comment shows the list it joins, so the saved draft and its send button are in view.\n    notesOpen[key] = true; try { localStorage.setItem("board-notes", JSON.stringify(notesOpen)); } catch (e) {}\n', ""),
      app("saving a comment unfolds its list", 'drafts[key] = ""; editing = null; editingAnchor = null;\n          notesOpen[key] = true; try { localStorage.setItem("board-notes", JSON.stringify(notesOpen)); } catch (e) {}\n', 'drafts[key] = ""; editing = null; editingAnchor = null;\n')], family: "comment-hidden",
    storage: b => ({ ...openAll(b), "board-notes": { ["it:" + b.gen.witness.commentItem]: false, ["q:" + b.gen.witness.commentCard]: false } }),
    run: async (bp, b) => checkComments(bp, await oracle(b.store)),
  },
  {
    bug: "an empty pause row sat under every unpaused item's title (fixed in 756e5ea)",
    reverts: [app("an unpaused item draws an empty pause row", '    if (!pause) return null;\n    const box = el("div", "pause-control");', '    const box = el("div", "pause-control");\n    if (!pause) return box;')], family: "empty-row",
    run: (bp, b) => checkEmptyRows(bp, [b.gen.witness.unpaused, b.gen.witness.code]),
  },
  {
    bug: "a tag chip said something other than the tag",
    reverts: [app("a tag chip adds a mark", 'tags.appendChild(el("span", "tagchip", esc(name)))', 'tags.appendChild(el("span", "tagchip", esc(name) + "!"))')], family: "tag-text",
    run: async (bp, b) => checkTagText(bp, await oracle(b.store)),
  },
  {
    bug: "the difficulty chip said a level one too high",
    reverts: [app("the difficulty chip is a level off", 'el("span", "tagchip diffchip", difficultyText(it.difficulty))', 'el("span", "tagchip diffchip", difficultyText((it.difficulty as number) + 1))')], family: "difficulty-chip",
    storage: b => openAll(b),
    run: async (bp, b) => checkDifficultyChip(bp, await oracle(b.store)),
  },
  {
    bug: "an item with part done and nobody on it was counted and filtered as 未开始, with no 停滞 filter (owner, 2026-10-16)",
    // The project's 停滞 button is gone, so part-done items fall back under 未开始 alone.
    reverts: [app("the 停滞 filter", '    ["idle", "停滞", "做完了一部分、现在没人在做的条目", it => statusOf(it) === "idle"],\n', "")], family: "idle-status",
    run: async (bp, b) => checkIdleStatus(bp, await oracle(b.store)),
  },
  {
    bug: "the chip of a part-done item took the class of an unstarted one",
    reverts: [app("a part-done chip is classed todo", 'el("span", "st " + st + (before && beforeStatus !== st ? " chg-add" : ""), esc(chipText(it, st)))', 'el("span", "st " + (st === "idle" ? "todo" : st) + (before && beforeStatus !== st ? " chg-add" : ""), esc(chipText(it, st)))')], family: "idle-status",
    run: async (bp, b) => checkIdleStatus(bp, await oracle(b.store)),
  },
];

test("each page check reports the spoiled page it guards against", async t => {
  const board = await startBoard(t);
  for (const w of WITNESSES) await t.test(`${w.family}: ${w.bug}`, async () => {
    const bp = await DomPage.open(t, board, { storage: w.storage?.(board) ?? openAll(board), reverts: w.reverts });
    const v = [...await w.run(bp, board), ...bp.errors.map(e => "page-error: " + e)];
    assert.ok(v.some(line => line.startsWith(w.family)), `the check reports ${w.family} on the spoiled page, it reported ${v.length} lines, first: ${JSON.stringify(v.slice(0, 2))}`);
  });
});
