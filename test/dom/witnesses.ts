// Evidence that the page checks of test/dom/checks.ts catch what they guard: each runs on the current page, where test/dom/page-families.ts
// holds it to find nothing, and here on the page with one thing spoiled, a copy edited as it is bundled (test/e2e/variant.ts), where it
// must report the family the spoiled thing belongs to. A witness whose edit no longer matches the current file fails loudly; update or
// retire it then. Most spoilings are small bugs of the kind the check exists for (a click that selects the wrong item, a number that
// counts one too many); most of the others are the bugs the browser layer's witnesses once showed, which moved here when their checks
// needed no layout (the ones that need one stay in test/e2e/regressions.e2e.ts). A fix is reversed by a literal edit of the current source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { placedCards } from "../../src/rules.ts";
import { startBoard, openAll } from "../e2e/board-server.ts";
import type { BoardServer } from "../e2e/board-server.ts";
import type { Revert } from "../e2e/variant.ts";
import { DomPage } from "./page.ts";
import { oracle, burst, checkTreeRows, checkPlanRows, checkCardBox, checkDependents, checkBadges, checkWaitPanel, checkFresh, checkWrap, checkFilters, checkSearch, checkComments, checkEmptyRows, checkTagText, checkDifficultyChip, checkIdleStatus, checkRefFold, checkSharedSection } from "./checks.ts";

const app = (edit: string, find: string, replace: string): Revert => ({ file: "web/app.ts", edit, find, replace });
// `fresh`: the witness writes to the board, so it gets a board of its own and the others see none of its writes.
interface Witness { bug: string; reverts: Revert[]; family: string; fresh?: true; storage?: (b: BoardServer) => Record<string, unknown>; run: (bp: DomPage, b: BoardServer) => Promise<string[]> }
// The right arrow's step, in the form it has now and in the form it had when it went to the card nearest the top of the screen.
const ARROW_NEW = `    // Only the stops whose item the left list shows; a stop with no item sits in the card list and always counts.
    const all = stops().filter(st => !st.item || treeShown(st.item));
    if (!all.length) return;
    const key = containerOf(effectiveSelection());
    const k = key ? all.findIndex(st => key === "q:" + st.id.slice(2) && st.id.startsWith("q-") || (st.item && key === "it:" + st.item && st.id.startsWith("ask-"))) : -1;
    if (k >= 0) { goStop(stops().findIndex(st => st.id === all[((k + dir) % all.length + all.length) % all.length]!.id)); return; }
    // Otherwise start from the selected row of the list, as n does: forward the first stop at or below it, backward the
    // last stop above it, wrapping around at the list's ends.
    const order = new Map<string, number>(); boardOrder().forEach((it, i) => { if (!order.has(it.id)) order.set(it.id, i); });
    const home = key?.startsWith("q:") ? index().decById.get(key.slice(2))?.item : key?.startsWith("it:") ? key.slice(3) : selectedItem;
    const row = home && order.has(home) ? order.get(home)! : -1;
    const at = (st: {item:string|null}) => st.item && order.has(st.item) ? order.get(st.item)! : Infinity;
    let n = -1;
    if (dir > 0) n = all.findIndex(st => at(st) >= row);
    else all.forEach((st, i) => { if (at(st) < row) n = i; });
    const pick = all[n >= 0 ? n : dir > 0 ? 0 : all.length - 1]!;
    goStop(stops().findIndex(st => st.id === pick.id));
`;
const ARROW_OLD = `    const all = stops();
    if (!all.length) return;
    const key = containerOf(effectiveSelection());
    let k = key ? all.findIndex(st => key === "q:" + st.id.slice(2) && st.id.startsWith("q-") || (st.item && key === "it:" + st.item && st.id.startsWith("ask-"))) : -1;
    if (k >= 0) { goStop(k + dir); return; }
    const pos = (st: {id:string;item:string|null}) => { const e = get(st.id) || (st.item ? get("it-" + st.item) : null); return e ? e.getBoundingClientRect().top : Infinity; };
    if (dir > 0) { const n = all.findIndex(st => pos(st) > 0); goStop(n >= 0 ? n : 0); }
    else { let n = -1; all.forEach((st, i) => { if (pos(st) < 0) n = i; }); goStop(n >= 0 ? n : all.length - 1); }
`;
// The purple and red numbers as they were before 1ecc074: the stops a number leads to are found when it is drawn, not when it is clicked.
const BADGES_NOW = [
  '      // The stops this number counts: the item\'s own and those of the items it owns, read when clicked so a re-render',
  '      // elsewhere cannot leave the chip pointing at a stale position. Each click goes to the next of them, then around.',
  '      const reachable = () => {',
  '        const sub = new Set<string>(), walk = (v: string) => { if (sub.has(v)) return; sub.add(v); derived.children(v).forEach(walk); };',
  '        walk(it.id);',
  '        return stops().map((st, k) => ({ st, k })).filter(({ st }) => !!st.item && sub.has(st.item) && blockingStop(st) === wanted).map(({ k }) => k);',
  '      };',
  '      if (reachable().length) {',
  '',
].join("\n");
const BADGES_OLD = [
  '      const first = stops().findIndex(st => !!st.item && (st.item === it.id || derived.ancestors(st.item).includes(it.id)) && blockingStop(st) === wanted);',
  '      if (first >= 0) {',
  '',
].join("\n");
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
  {
    bug: "purple and red numbers jumped to another project's card after unrelated re-renders (fixed in 1ecc074)",
    // The numbers and the blue ones go back to the stops found when they were drawn, which sessions' writes elsewhere then move.
    reverts: [
      app("a blue number reads its stop when drawn", '    // Read when clicked: an incremental repaint elsewhere can move the stops this chip was drawn against.\n    const firstNow = () => id ? freshIndex().under.get(id) : freshIndex().touching.get(key);\n    const first = firstNow();\n', '    const first = id ? freshIndex().under.get(id) : freshIndex().touching.get(key);\n'),
      app("a blue number goes to the stop it read when drawn", "const go = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); const now = firstNow(); if (now !== undefined) goFresh(now); };", "const go = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); goFresh(first); };"),
      app("the clicks of a number are not counted", "  // Clicks per purple or red number, kept across repaints, so repeated clicks walk the stops it counts.\n  const chipClicks = new Map<string, number>();\n", ""),
      app("a purple or red number finds its stops when drawn", BADGES_NOW, BADGES_OLD),
      app("a purple or red number goes to the stop it found when drawn", "const go=(ev: Event) => { ev.stopPropagation(); ev.preventDefault(); const ks = reachable(), at = chipClicks.get(cls+it.id) ?? 0; if (ks.length) { chipClicks.set(cls+it.id, at + 1); goStop(ks[at % ks.length]!); } };", "const go=(ev: Event) => { ev.stopPropagation(); ev.preventDefault(); goStop(first); };"),
    ], family: "badge-landing", fresh: true,
    // A burst of writes by sessions puts new waits in front of the ones the numbers were drawn against.
    run: async (bp, b) => { const base = bp.changes(), n = await burst(b, 1); await bp.waitChanges(base + n); const o = await oracle(b.store); return checkBadges(bp, o, bp.treeRows().filter(id => o.purple(id).length + o.red(id).length > 0)); },
  },
  {
    bug: "the right arrow chose the card nearest the top of the screen instead of the next one in the list (owner, 2026-10-14)",
    // The old step body, back where the new one stands.
    reverts: [app("the arrows step by the list's rows", ARROW_NEW, ARROW_OLD)], family: "wrap-card",
    run: async (bp, b) => checkWrap(bp, await oracle(b.store)),
  },
  {
    bug: "an open card's old background started folded although the reader decides from it (owner, 2026-10-16)",
    // The fold starts closed whatever the card's state.
    reverts: [app("old card text starts folded on an open card", "fold.open = refOpen[key] ?? !closed;", "fold.open = refOpen[key] ?? false;")], family: "card-legacy-open",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.openLegacyCard], true); },
  },
  {
    bug: "a card its item's head does not place was not drawn at all, so a card written without its line vanished from the page (architect, 2026-10-16)",
    // Only the cards the head places are drawn.
    reverts: [app("a card with no place is not drawn", "cardOrder(it.id).filter(key => !placed.has(key)).forEach(key => {", "cardOrder(it.id).filter(key => false).forEach(key => {")], family: "card-unplaced",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.otherPlanCard, w.rowCard], true); },
  },
  {
    bug: "the line before a closed card with no place told the reader to withdraw it, which the board refuses for a card that is not open (review of card-in-plan)",
    // Every such line offers to withdraw the card.
    reverts: [app("a closed card with no place is told to be withdrawn", '(d.status === "open" ? "，或者撤回它。" : "。")', '"，或者撤回它。"')], family: "card-unplaced",
    run: async (bp, b) => {
      const o = await oracle(b.store), closed = Object.keys(o.s.decisions).find(key => { const d = o.s.decisions[key]!; return d.status === "ruled" && !placedCards(o.s.items[d.item]!.head).includes(key); });
      assert.ok(closed, "the generated board has a closed card its head does not place");
      return checkCardBox(bp, o, [closed!], true);
    },
  },
  {
    bug: "a head's 参考 sections showed their whole text instead of folding shut under their titles (feature, ref-fold)",
    // Without the split, the head is one run of text: a 参考 line is ordinary bold text and nothing folds.
    reverts: [app("the head is not split into sections", "const [head = [], ...refs] = refSplit(lines), at = scope;", "const [head = [], ...refs] = [lines], at = scope;")], family: "ref-fold-split",
    run: async (bp, b) => checkRefFold(bp, b),
  },
  {
    bug: "a 参考 section's title and text took the monospace button look of the reference buttons (class collision, ref-fold)",
    reverts: [app("sections use the reference buttons' class", '<details class="refsec"', '<details class="ref"')], family: "ref-fold-look",
    run: async (bp, b) => checkRefFold(bp, b),
  },
  {
    bug: "a 参考 section the reader opened folded again after the item re-rendered (ref-fold)",
    reverts: [app("open 参考 sections are not saved", "    rememberRef(d.dataset.ref!, d.open);\n", "")], family: "ref-fold-keep",
    run: async (bp, b) => checkRefFold(bp, b),
  },
  {
    bug: "a root another project began to depend on stayed among its project's own roots until the page was reloaded (owner, 2026-10-15)",
    // Without the comparison, a change between the project's own roots and the roots other projects depend on repaints no group.
    reverts: [app("an item changing section repaints its group", '    if (previous.shared !== current.shared) scope.add("group:"+current.group);\n', "")], family: "shared-section-above", fresh: true,
    run: async (bp, b) => checkSharedSection(bp, b),
  },
  {
    bug: "a root stayed under the line for the roots other projects depend on after the shared row to it was removed (review of wf-board#44)",
    // Only a root that becomes depended on repaints its group; one that stops being depended on does not.
    reverts: [app("only an item moving under the line repaints its group", 'if (previous.shared !== current.shared) scope.add("group:"+current.group);', 'if (!previous.shared && current.shared) scope.add("group:"+current.group);')], family: "shared-section-under", fresh: true,
    run: async (bp, b) => checkSharedSection(bp, b),
  },
];

/** The witnesses at the positions `part` of `of` takes, on a board of their own, so the files that run them go side by side. A witness
 * runs on a page of its own, closed when it ends. */
export function witnessTests(part: number, of: number) {
  test(`each page check reports the spoiled page it guards against (part ${part + 1} of ${of})`, async t => {
    const shared = await startBoard(t);
    for (const w of WITNESSES.filter((_, k) => k % of === part)) await t.test(`${w.family}: ${w.bug}`, async st => {
      const board = w.fresh ? await startBoard(st) : shared;
      const bp = await DomPage.open(st, board, { storage: w.storage?.(board) ?? openAll(board), reverts: w.reverts });
      const v = [...await w.run(bp, board), ...bp.errors.map(e => "page-error: " + e)];
      assert.ok(v.some(line => line.startsWith(w.family)), `the check reports ${w.family} on the spoiled page, it reported ${v.length} lines, first: ${JSON.stringify(v.slice(0, 2))}`);
    });
  });
}
