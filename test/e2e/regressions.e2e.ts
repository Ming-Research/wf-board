// Evidence that the browser checks catch bugs that once shipped: each check runs on the current page, where it must
// find nothing, and on the page with that bug's fix reversed (the fix commit's hunks undone in a copy), where it must
// report the bug. A witness whose edits no longer match the current file fails loudly; update or retire it then. Where
// later work rewrote the lines around a fix, the witness removes the fix by a targeted edit instead of the commit's hunk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard, launch, BoardPage, openAll, variantWeb } from "./harness.ts";
import type { BoardServer, Revert } from "./harness.ts";
import { oracle, burst, checkBadges, checkComments, checkCodeFont, checkEmptyRows, checkPlanRows, checkCardBox, checkFresh, checkWrap, checkRefFold } from "./invariants.ts";

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
interface Witness { bug: string; reverts: Revert[]; family: string; storage?: (b: BoardServer) => Record<string, unknown>; run: (bp: BoardPage, b: BoardServer) => Promise<string[]> }
const WITNESSES: Witness[] = [
  {
    bug: "saving a comment on a card folded its comment list and hid the 发送 button (fixed in 1ecc074)",
    // The fix's two lines, removed where they stand now: opening a comment and saving one unfold the list.
    reverts: [
      { file: "web/app.ts", edit: "opening a comment unfolds its list", find: "    // Writing a comment shows the list it joins, so the saved draft and its send button are in view.\n    notesOpen[key] = true; try { localStorage.setItem(\"board-notes\", JSON.stringify(notesOpen)); } catch (e) {}\n", replace: "" },
      { file: "web/app.ts", edit: "saving a comment unfolds its list", find: "drafts[key] = \"\"; editing = null; editingAnchor = null;\n          notesOpen[key] = true; try { localStorage.setItem(\"board-notes\", JSON.stringify(notesOpen)); } catch (e) {}\n", replace: "drafts[key] = \"\"; editing = null; editingAnchor = null;\n" },
    ], family: "comment-hidden",
    storage: b => ({ ...openAll(b), "board-notes": { ["it:" + b.gen.witness.commentItem]: false, ["q:" + b.gen.witness.commentCard]: false } }),
    run: async (bp, b) => checkComments(bp, await oracle(b.store)),
  },
  {
    bug: "purple and red numbers jumped to another project's card after unrelated re-renders (fixed in 1ecc074)",
    reverts: [{ commit: "1ecc074", file: "web/app.ts", hunks: [0, 3] }], family: "badge-landing",
    run: async (bp, b) => { const base = await bp.changes(), n = await burst(b, 1); await bp.waitChanges(base + n); return checkBadges(bp, await oracle(b.store)); },
  },
  {
    bug: "a card row in a plan did not go to the card in the item's body (feature, card-in-plan)",
    // The click handler keeps its default-prevention and does nothing else: the row stays put.
    reverts: [{ file: "web/app.ts", edit: "a card row does not go to the card", find: "const jumpToCard = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); if (isPlaced(stored.card)) jump(\"q-\" + stored.card); else toggleCardUnder(stored.card); };", replace: "const jumpToCard = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); };" }],
    family: "plan-card-row",
    // The items whose plans hold the witness cards: blocking and placed in the head, ruled on a done item, blocking and not placed, converted from the old form.
    run: async (bp, b) => { const o = await oracle(b.store), w = b.gen.witness; return checkPlanRows(bp, o, [...new Set([w.multiPlanCard, w.donePlanCard, w.rowCard, w.openLegacyCard].map(c => o.s.decisions[c]!.item))]); },
  },
  {
    bug: "code blocks were not set in Monaco: the global code rule overrode the block's font (fixed in 8f3ed75)",
    reverts: [{ commit: "8f3ed75", file: "web/index.html" }], family: "code-font",
    run: async (bp, b) => checkCodeFont(bp, await oracle(b.store)),
  },
  {
    bug: "n landed on done or cancelled items the left tree hid (owner, 2026-10-14)",
    // Both halves of the fix, removed where they stand: closed items holding unread content leave the tree, and n's
    // stops no longer follow the tree, so n lands on rows the tree does not show.
    reverts: [{ file: "web/app.ts", edit: "closed items holding unread content stay in the tree", find: "openWorkAncestors().has(it.id) || freshPath().has(it.id); }", replace: "openWorkAncestors().has(it.id); }" },
      { file: "web/app.ts", edit: "new-content stops follow the shown tree", find: " && (!st.item || !index().byId.has(st.item) || treeShown(st.item))", replace: "" }],
    family: "n-walk",
    // The current page is also walked with n and the right arrow from the bottom row of the tree (checkWrap); the
    // seeded board does not yet reproduce the owner's wrong landings there, so those have no reversal witness.
    run: async (bp, b) => { const o = await oracle(b.store); return [...await checkFresh(bp, o), ...await checkWrap(bp, o)]; },
  },
  {
    bug: "the right arrow chose the card nearest the top of the screen instead of the next one in the list (owner, 2026-10-14)",
    // The old stepStop body, back where the new one stands.
    reverts: [{ file: "web/app.ts", edit: "the arrows step by the list's rows", find: ARROW_NEW, replace: ARROW_OLD }],
    family: "wrap-card",
    run: async (bp, b) => checkWrap(bp, await oracle(b.store)),
  },
  {
    bug: "a card's old background showed unfolded instead of folded under 原卡的背景 (feature, card-in-plan)",
    // The fold starts open whatever the reader chose before.
    reverts: [{ file: "web/app.ts", edit: "old card text starts unfolded", find: "fold.open = refOpen[key] ?? !closed;", replace: "fold.open = true;" }],
    family: "card-legacy",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.legacyCard, w.proseCard, w.openLegacyCard], true); },
  },
  {
    bug: "an open card's old background started folded although the reader decides from it (owner, 2026-10-16)",
    // The fold starts closed whatever the card's state.
    reverts: [{ file: "web/app.ts", edit: "old card text starts folded on an open card", find: "fold.open = refOpen[key] ?? !closed;", replace: "fold.open = refOpen[key] ?? false;" }],
    family: "card-legacy-open",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.openLegacyCard], true); },
  },
  {
    bug: "a ruled card filled the item's body with its whole pick and old text instead of being one line (owner, 2026-10-16)",
    // The card's line is not a fold: everything under it shows at once.
    reverts: [{ file: "web/app.ts", edit: "a closed card shows all of its content", find: "fold.dataset.ref = key; fold.open = !!refOpen[key];\n      fold.appendChild(top)", replace: "fold.dataset.ref = key; fold.open = true;\n      fold.appendChild(top)" }],
    family: "card-fold",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.legacyCard, w.proseCard, w.donePlanCard], true); },
  },
  {
    bug: "a card whose line stands in the item's head showed after the head instead of at that line (feature, card-in-plan)",
    // No line is taken as a place for a card, so every card follows the head.
    reverts: [{ file: "web/app.ts", edit: "a line holding only a card key places no card", find: "key => own.has(key) && !placed.has(key) && !!placed.add(key)", replace: "key => false" }],
    family: "card-place",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.multiPlanCard, w.commentCard]); },
  },
  {
    bug: "a card showed its question, options or pick wrongly: an open card without its option buttons and 发送, a ruled one without what was chosen (feature, card-in-plan)",
    // A ruled card's pick line is not drawn.
    reverts: [{ file: "web/app.ts", edit: "a ruled card shows no pick", find: "else if (d.status === \"ruled\") top.appendChild(el(\"span\", \"pick pickshort\"", replace: "else if (false as boolean) top.appendChild(el(\"span\", \"pick pickshort\"" }],
    family: "card-box",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.commentCard, w.multiPlanCard, w.donePlanCard, w.legacyCard, w.proseCard, w.withdrawnCard, w.otherPlanCard, w.rowCard]); },
  },
  {
    bug: "a card its item's head does not place was drawn after the head although nobody asked for it, so the 646 old cards filled every item (owner, 2026-10-16)",
    // Every card with no line in the head and no plan row is drawn after the refs line.
    reverts: [{ file: "web/app.ts", edit: "a card with no place is always drawn", find: ".filter(key => !placed.has(key) && !hasRow(key) && shownUnder(key))", replace: ".filter(key => !placed.has(key) && !hasRow(key))" }],
    family: "card-unplaced",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.otherPlanCard, w.rowCard], true); },
  },
  {
    bug: "an open card showed its option names without what each option does, costs and risks (feature, card-in-plan)",
    // The detail of an option is not drawn.
    reverts: [{ file: "web/app.ts", edit: "an option shows no detail", find: "const detail = o.detail ? '<div class=\"rich optdetail\">'", replace: "const detail = o.detail && !o.detail ? '<div class=\"rich optdetail\">'" }],
    family: "card-option-detail",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.commentCard, w.multiPlanCard, w.openLegacyCard], true); },
  },
  {
    bug: "an open card did not show how sure its writer is of the recommended option (feature, card-in-plan)",
    // The confidence line of an open card is not drawn.
    reverts: [{ file: "web/app.ts", edit: "an open card shows no confidence", find: "if (confidence) c.appendChild(confidence);", replace: "" }],
    family: "card-confidence",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.commentCard, w.multiPlanCard], true); },
  },
  {
    bug: "an empty pause row sat under every unpaused item's title (fixed in 756e5ea)",
    reverts: [{ commit: "756e5ea", file: "web/app.ts" }], family: "empty-row",
    run: (bp, b) => checkEmptyRows(bp, [b.gen.witness.unpaused, b.gen.witness.code]),
  },
  {
    bug: "a head's 参考 sections showed their whole text instead of folding shut under their titles (feature, ref-fold)",
    // Without the split, the head is one run of text: a 参考 line is ordinary bold text and nothing folds.
    reverts: [{ file: "web/app.ts", edit: "the head is not split into sections", find: "const [head = [], ...refs] = refSplit(lines), at = scope;", replace: "const [head = [], ...refs] = [lines], at = scope;" }], family: "ref-fold-split",
    run: async (bp, b) => checkRefFold(bp, b),
  },
  {
    bug: "a 参考 section's title and text took the monospace button look of the reference buttons (class collision, ref-fold)",
    reverts: [{ file: "web/app.ts", edit: "sections use the reference buttons' class", find: '<details class="refsec"', replace: '<details class="ref"' }], family: "ref-fold-look",
    run: async (bp, b) => checkRefFold(bp, b),
  },
  {
    bug: "a 参考 section the reader opened folded again after the item re-rendered (ref-fold)",
    reverts: [{ file: "web/app.ts", edit: "open 参考 sections are not saved", find: '    refOpen[d.dataset.ref!] = d.open;\n    try { localStorage.setItem("board-refs", JSON.stringify(refOpen)); } catch (e) {}\n', replace: "" }], family: "ref-fold-keep",
    run: async (bp, b) => checkRefFold(bp, b),
  },
];

for (const w of WITNESSES) test(`the browser checks catch: ${w.bug}`, { timeout: 10 * 60_000 }, async t => {
  const browser = await launch(t);
  for (const [page, webDir] of [["current page", undefined], ["page with the fix reversed", await variantWeb(t, w.reverts)]] as const) {
    const board = await startBoard(t, { webDir });
    const bp = await BoardPage.open(browser, board, w.storage?.(board) ?? openAll(board));
    const all = await w.run(bp, board), hits = all.filter(v => v.startsWith(w.family));
    await bp.context.close();
    if (page === "current page") assert.deepEqual(all, [], "the current page passes this check");
    else assert.ok(hits.length > 0, `the check misses the bug on the ${page}; it reported: ${all.join("\n") || "nothing"}`);
  }
});
