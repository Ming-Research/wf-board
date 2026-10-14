// Evidence that the browser checks catch bugs that once shipped: each check runs on the current page, where it must
// find nothing, and on the page with that bug's fix reversed (the fix commit's hunks undone in a copy), where it must
// report the bug. A witness whose edits no longer match the current file fails loudly; update or retire it then. Where
// later work rewrote the lines around a fix, the witness removes the fix by a targeted edit instead of the commit's hunk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard, launch, BoardPage, openAll, variantWeb } from "./harness.ts";
import type { BoardServer, Revert } from "./harness.ts";
import { oracle, burst, checkBadges, checkComments, checkCodeFont, checkEmptyRows, checkPlanRows, checkCardBox, checkFresh, checkWrap } from "./invariants.ts";

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
    bug: "a card row in a plan jumped to the card's own item, even a done one, instead of unfolding in place (fixed in 3a337e8 and 517c448)",
    // 3a337e8's app.ts hunks around the card row were rewritten by the card-box change, so that part is a targeted
    // edit: no row unfolds its card, every card row links to the card's own item instead.
    reverts: [{ commit: "517c448", file: "web/app.ts" },
      { file: "web/app.ts", edit: "a card row links to the card's item instead of unfolding", find: "const home = card && snapshot.items[card.item] ? index().decById.get(stored.card) : undefined;", replace: "const home = undefined as ViewDecision | undefined;" },
      { file: "web/app.ts", edit: "no plan names a card as its host", find: "    if (selectedItem && cardRowOf(selectedItem, id)) return selectedItem;\n    return cardRowOf(d.item, id) ? d.item : null;", replace: "    return null;" },
      { commit: "3a337e8", file: "web/index.html" }], family: "plan-card-row",
    // The items whose plans name a card that lives in another item: the card named by three plans, by a done item's
    // plan, and only by another item's plan.
    run: async (bp, b) => { const o = await oracle(b.store); return checkPlanRows(bp, o, Object.keys(o.s.items).filter(id => o.s.items[id]!.plan.some(row => "card" in row && o.s.decisions[row.card]?.item !== id))); },
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
    bug: "a card row in a plan showed its title again in a second box when unfolded, and a folded card row took several lines instead of one bold truncated line (owner, 2026-10-14)",
    // The unfolded card gets its title heading back, and the folded row loses its one-line bold ellipsis style.
    reverts: [{ file: "web/app.ts", edit: "the unfolded card carries no title", find: "if (!inlined) top.appendChild(h); else if (pc) top.appendChild(pc);", replace: "top.appendChild(h);" },
      { file: "web/index.html", edit: "a folded card row is one bold line", find: ".plan-row.cardrow .cardtoggle { font-weight: 700; min-width: 0; flex: 1 1 auto; }\n.plan-row.cardrow .cardtoggle[aria-expanded=\"false\"] { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }", replace: "" }],
    family: "card-box",
    run: async (bp, b) => { const w = b.gen.witness; return checkCardBox(bp, await oracle(b.store), [w.commentCard, w.donePlanCard]); },
  },
  {
    bug: "an empty pause row sat under every unpaused item's title (fixed in 756e5ea)",
    reverts: [{ commit: "756e5ea", file: "web/app.ts" }], family: "empty-row",
    run: (bp, b) => checkEmptyRows(bp, [b.gen.witness.unpaused, b.gen.witness.code]),
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
