// Evidence that the browser checks catch bugs that once shipped: each check runs on the current page, where it must
// find nothing, and on the page with that bug's fix reversed (the fix commit's hunks undone in a copy), where it must
// report the bug. A witness whose edits no longer match the current file fails loudly; update or retire it then. Where
// later work rewrote the lines around a fix, the witness removes the fix by a targeted edit instead of the commit's hunk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ops } from "../../src/ops.ts";
import { rules } from "../../src/rules.ts";
import { startBoard, launch, BoardPage, openAll, variantWeb } from "./harness.ts";
import type { BoardServer, Revert } from "./harness.ts";
import { checkReload, checkWriting, checkLoop } from "./update.ts";
import { setHead, checkFit, FIT_HEAD } from "./mermaid-checks.ts";
import { oracle, burst, checkBadges, checkComments, checkCodeFont, checkEmptyRows, checkPlanRows, checkCardBox, checkFresh, checkWrap, checkRefFold, checkSharedSection, checkChangedBlocks, checkFullWidth, measureBlocks, checkProgress } from "./invariants.ts";

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
// `copy`: the check rebuilds the page it is served (test/e2e/update.ts), so the current page is served from a copy of the page directory.
interface Witness { bug: string; reverts: Revert[]; family: string; copy?: true; storage?: (b: BoardServer) => Record<string, unknown>; run: (bp: BoardPage, b: BoardServer) => Promise<string[]> }
// The maximum widths the right column's blocks once had (the owner asked for none on 2026-10-17): each is the rule's opening, which the
// page now holds without the cap, and the cap in characters. A witness puts one cap back.
const CAPS = [
  { sel: ".note", find: ".note { font-size: 14px; border-radius: 6px; padding: 6px 10px; background: var(--note-bg); display: flex; flex-direction: column; gap: 2px;", ch: 78 },
  { sel: ".log", find: ".log { display: flex; flex-direction: column; gap: 6px; margin-top: 4px;", ch: 78 },
  { sel: ".rich", find: ".rich { display: flex; flex-direction: column; gap: 6px;", ch: 78 },
  { sel: ".editor", find: ".editor { display: flex; flex-direction: column; gap: 6px;", ch: 78 },
  { sel: ".body p", find: ".body p { margin: 0;", ch: 78 },
  { sel: ".ask", find: ".ask { background: var(--bg); border: 1px solid var(--rule); border-radius: 8px; padding: 8px 12px; font-size: 14.5px; font-weight: 500;", ch: 78 },
  { sel: ".checks", find: ".checks { font-size: 13.5px; color: var(--wip); background: var(--wip-soft); border-radius: 6px; padding: 4px 10px; display: flex; flex-direction: column; gap: 2px;", ch: 78 },
  { sel: ".deplists", find: ".deplists { display: flex; flex-direction: column; gap: 1px;", ch: 78 },
  { sel: ".card p", find: ".card p { margin: 0;", ch: 76 },
  { sel: ".refpop", find: ".refpop { display: flex; flex-direction: column;", ch: 78 },
];
// Ways other than a maximum width to keep the column's content from filling the window, one for each other thing the check measures.
const NARROWINGS: Array<{ bug: string; edit: string; find: string; replace: string; family: string }> = [
  { bug: "a block of the right column was set to a width of its own, narrower than its box", edit: "a width of 78ch on the log", find: ".log { display: flex; flex-direction: column; gap: 6px; margin-top: 4px;", replace: ".log { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; width: 78ch;", family: "full-width-fill .log:" },
  { bug: "an item's box in the right column was capped, narrower than the column", edit: "a maximum width on the item's box", find: "body.wide #item-detail .item > .body, body.wide #item-detail .item > .notes { padding-left: 0; }", replace: "body.wide #item-detail .item > .body, body.wide #item-detail .item > .notes { padding-left: 0; }\nbody.wide #item-detail > .item { max-width: 600px; }", family: "full-width-box:" },
  { bug: "an item's body in the right column was capped, narrower than its box", edit: "a maximum width on the item's body", find: "body.wide #item-detail .item > .body, body.wide #item-detail .item > .notes { padding-left: 0; }", replace: "body.wide #item-detail .item > .body, body.wide #item-detail .item > .notes { padding-left: 0; }\nbody.wide #item-detail .item > .body { max-width: 600px; }", family: "full-width-body:" },
  { bug: "a block of the right column was wider than the column, so the column scrolled sideways", edit: "a minimum width on the log", find: ".log { display: flex; flex-direction: column; gap: 6px; margin-top: 4px;", replace: ".log { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; min-width: 3000px;", family: "full-width-scroll:" },
  { bug: "the page was wider than the window, so the page scrolled sideways", edit: "a minimum width on the two columns", find: "body.wide .wrap { flex: 1; min-height: 0; max-width: none; min-width: 688px;", replace: "body.wide .wrap { flex: 1; min-height: 0; max-width: none; min-width: 3000px;", family: "full-width-page:" },
];
const capBack = (c: typeof CAPS[number]): Revert => ({ file: "web/index.html", edit: `the maximum width of ${c.sel}`, find: c.find, replace: `${c.find} max-width: ${c.ch}ch;` });
const WITNESSES: Witness[] = [
  {
    bug: "changed body blocks lost their mark once the green background was removed (fixed in head-change-bar)",
    // The blue bar rule that marks a changed body block and a changed card question; removing it leaves both with no mark.
    reverts: [{ file: "web/index.html", edit: "the blue bar of changed blocks", find: "\n.rich > .chg-add::before, .card h3 > .chg-add::before { content: \"\"; position: absolute; left: -7px; top: 3px; bottom: 3px; width: 3px; border-radius: 2px; background: var(--fresh); }", replace: "" }],
    family: "changed-block",
    storage: b => openAll(b),
    run: async bp => checkChangedBlocks(bp),
  },
  {
    bug: "changed card questions lost their mark while changed body blocks kept theirs (fixed in head-change-bar)",
    // The bar rule without its card selector: the body block keeps its line, the card question loses it.
    reverts: [{ file: "web/index.html", edit: "the card question's blue bar", find: ", .card h3 > .chg-add::before {", replace: " {" }],
    family: "changed-block",
    storage: b => openAll(b),
    run: async bp => checkChangedBlocks(bp),
  },
  {
    bug: "changed body blocks' blue bar lost its place beside the block (fixed in head-change-bar)",
    // Without absolute placement the bar falls into the block's flow, where it has no height and no place at the left.
    reverts: [{ file: "web/index.html", edit: "the placement of the blue bar of changed blocks", find: ".rich > .chg-add::before, .card h3 > .chg-add::before { content: \"\"; position: absolute; ", replace: ".rich > .chg-add::before, .card h3 > .chg-add::before { content: \"\"; " }],
    family: "changed-block",
    storage: b => openAll(b),
    run: async bp => checkChangedBlocks(bp),
  },
  {
    bug: "changed body blocks took a background colour (fixed in head-change-bar)",
    // A background on the changed block itself is the green mark the owner removed.
    reverts: [{ file: "web/index.html", edit: "a background on changed blocks", find: ".rich > .chg-add { position: relative; display: flex; flex-direction: column; gap: 6px; }", replace: ".rich > .chg-add { position: relative; display: flex; flex-direction: column; gap: 6px; background: #e3f2e6; }" }],
    family: "changed-block",
    storage: b => openAll(b),
    run: async bp => checkChangedBlocks(bp),
  },
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
  {
    bug: "the agent list took its place in the page even when empty, because its display rule overrode the hidden attribute (agent list, review of wf-board#37)",
    reverts: [{ file: "web/index.html", edit: "the hidden agent list takes no space", find: ".agents[hidden] { display: none; }\n", replace: "" }], family: "agents-hidden",
    // No session has written: the list is hidden, and a hidden list is not displayed.
    run: async bp => {
      const display = await bp.page.evaluate(() => getComputedStyle(document.getElementById("agents")!).display);
      return display === "none" ? [] : [`agents-hidden: the empty agent list is displayed as ${display}`];
    },
  },
  {
    bug: "a key command with nothing selected took the first item row it found, an unfolded row of the agent list, for a tree row (agent list, review of wf-board#37)",
    reverts: [{ file: "web/app.ts", edit: "the list's rows count as a place on screen", find: 'find(e => { if (e.closest("#agents")) return false; const r =', replace: "find(e => { const r =" }], family: "agents-key",
    // An agent's cell is unfolded so its item rows sit above the tree, nothing is selected, and c asks for the item on screen.
    run: async (bp, b) => {
      const s = b.store.snapshot(), r = rules(s), rows = await bp.treeRows();
      const id = rows.find(x => !s.items[x]!.record && s.items[x]!.group && r.children(x).some(c => rows.includes(c)));
      if (!id) return ["witness setup: the board draws no item with a drawn sub-item"];
      const base = await bp.changes();
      await ops(b.store).appendLog({ author: s.items[id]!.group, session: "agent-x", id, text: "agent-x wrote here" });
      await bp.waitChanges(base + 1);
      await bp.page.locator('#agents [data-agent="agent-x"] .agitem-caret').first().click();
      await bp.settle();
      await bp.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
      if (await bp.selected() !== null) return ["witness setup: an item is already selected"];
      // The unfolded list nearly fills the screen: scroll its first item row near the top (a little below it, so rounding cannot push it out of range), so that the tree's first row is on screen too.
      const shown = await bp.page.evaluate(() => {
        const pane = document.getElementById("page-left")!, row = document.querySelector("#agents .item")!, tree = document.querySelector("#areas .item")!;
        pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - 24;
        const p = pane.getBoundingClientRect(), t = tree.getBoundingClientRect();
        return t.top >= p.top && t.top < p.bottom;
      });
      if (!shown) return ["witness setup: no tree row is on screen with the list's row near the top"];
      await bp.page.keyboard.press("c");
      await bp.settle();
      const sel = await bp.selected();
      return sel && s.items[sel] ? [] : [`agents-key: c with the list unfolded and nothing selected selected ${sel}, not an item of the tree`];
    },
  },
  {
    bug: "a root another project began to depend on stayed among its project's own roots until the page was reloaded (owner, 2026-10-15)",
    // Without the comparison, a change between the project's own roots and the roots other projects depend on repaints no group.
    reverts: [{ file: "web/app.ts", edit: "an item changing section repaints its group", find: '    if (previous.shared !== current.shared) scope.add("group:"+current.group);\n', replace: "" }], family: "shared-section-above",
    run: async (bp, b) => checkSharedSection(bp, b),
  },
  {
    bug: "a root stayed under the line for the roots other projects depend on after the shared row to it was removed (review of wf-board#44)",
    // Only a root that becomes depended on repaints its group; one that stops being depended on does not.
    reverts: [{ file: "web/app.ts", edit: "only an item moving under the line repaints its group", find: 'if (previous.shared !== current.shared) scope.add("group:"+current.group);', replace: 'if (!previous.shared && current.shared) scope.add("group:"+current.group);' }], family: "shared-section-under",
    run: async (bp, b) => checkSharedSection(bp, b),
  },
  {
    bug: "a page that stayed open through a deploy kept running the old page: the owner saw no new feature until a manual reload (owner, 2026-10-16)",
    // The page no longer acts on the version the stream announces.
    reverts: [{ file: "web/app.ts", edit: "the page acts on the announced version", find: "      pageUpdates.announce((JSON.parse((event as MessageEvent).data) as { version: string }).version);\n", replace: "" }], family: "update-reload", copy: true,
    run: async (bp, b) => checkReload(bp, b),
  },
  {
    bug: "a page that reloaded for a deploy came back scrolled to the top (owner, 2026-10-16)",
    // The new page does not scroll the two panes back.
    reverts: [{ file: "web/app.ts", edit: "the new page scrolls back to where the old one was", find: "listScroller().to(saved.list); detailScroller().to(saved.detail);", replace: "" }], family: "update-scroll", copy: true,
    run: async (bp, b) => checkReload(bp, b),
  },
  {
    bug: "a page that reloaded for a deploy came back with no item selected (owner, 2026-10-16)",
    // The page no longer keeps the selected item, so the page that follows a reload has none.
    reverts: [{ file: "web/app.ts", edit: "the selected item is kept across a reload", find: '    try { localStorage.setItem("board-selected", id || ""); } catch {}\n', replace: "" }], family: "update-state", copy: true,
    run: async (bp, b) => checkReload(bp, b),
  },
  {
    bug: "a deploy reloaded the page under a comment box the owner was typing in (owner, 2026-10-16)",
    // The page never counts itself as busy.
    reverts: [{ file: "web/app.ts", edit: "the page waits while the owner writes", find: "busy: () => editing !== null || draftEdits.size > 0 || Object.values(drafts).some(text => text.trim() !== \"\") || sending || writesInFlight > 0,", replace: "busy: () => false," }], family: "update-writing", copy: true,
    run: async (bp, b) => checkWriting(bp, b),
  },
  {
    bug: "a page whose version never matched the announced one reloaded without end (design: a reload toward the same version within a minute is not repeated)",
    // The page forgets its last reload, so nothing stops a second one.
    reverts: [{ file: "web/app.ts", edit: "the page remembers the reload it began", find: "lastReload: () => readSession<{ version: string; at: number }>(RELOAD_KEY),", replace: "lastReload: () => undefined," }], family: "update-loop", copy: true,
    run: async (bp, b) => checkLoop(bp, b),
  },
  ...CAPS.map((c): Witness => ({
    bug: `blocks of the right column stayed at ${c.ch} characters in a wide window (${c.sel}; owner, 2026-10-17)`,
    // The cap on this one block; the other blocks keep filling the column.
    reverts: [capBack(c)], family: `full-width-cap ${c.sel}:`,
    run: async bp => checkFullWidth(bp),
  })),
  ...NARROWINGS.map((n): Witness => ({
    bug: `${n.bug} (owner, 2026-10-17)`,
    reverts: [{ file: "web/index.html", edit: n.edit, find: n.find, replace: n.replace }], family: n.family,
    run: async bp => checkFullWidth(bp),
  })),
  {
    bug: "an item with part done and nobody on it was counted and filtered as 未开始, with no 停滞 filter (owner, 2026-10-16)",
    // The project's 停滞 button is gone, so part-done items fall back under 未开始 alone.
    reverts: [{ file: "web/app.ts", edit: "the 停滞 filter", find: "    [\"idle\", \"停滞\", \"做完了一部分、现在没人在做的条目\", it => statusOf(it) === \"idle\"],\n", replace: "" }], family: "idle-status",
    run: async (bp, b) => checkProgress(bp, await oracle(b.store)),
  },
  {
    bug: "the chip of a part-done item had no colour of its own, so it read as nothing (owner, 2026-10-16)",
    // Without its background rule the chip is bare text beside the coloured chips of the other statuses.
    reverts: [{ file: "web/index.html", edit: "the background of a part-done chip", find: ".st.idle { background: var(--idle-soft); }\n", replace: "" }], family: "idle-status",
    run: async (bp, b) => checkProgress(bp, await oracle(b.store)),
  },
  {
    bug: "the detail of an open item said nothing about how far it is or who is on it (owner, 2026-10-16)",
    // The line under the title is not drawn.
    reverts: [{ file: "web/app.ts", edit: "the progress line under the title", find: "      if (line) box.appendChild(el(\"div\", \"progress-line \" + line.kind, esc(plain(line.text))));\n", replace: "" }], family: "progress-line",
    run: async (bp, b) => checkProgress(bp, await oracle(b.store)),
  },
  {
    bug: "a diagram wider than the text was drawn at its own width, so its right part was cut off by a box that scrolled sideways without showing it could (owner, 2026-10-17)",
    // Every diagram at its own width again, whatever its box.
    reverts: [{ file: "web/index.html", edit: "a diagram is fitted to its box", find: "width: calc(min(var(--natural), 100%) * var(--zoom, 1));", replace: "width: var(--natural);" }], family: "mermaid-fit",
    // A small diagram, a wide one and a tall one in one head, as the page's own mermaid checks draw them.
    run: async (bp, b) => { await setHead(b, b.gen.witness.code, FIT_HEAD); await bp.select(b.gen.witness.code); return checkFit(bp, 60_000); },
  },
];

for (const w of WITNESSES) test(`the browser checks catch: ${w.bug}`, { timeout: 10 * 60_000 }, async t => {
  const browser = await launch(t);
  for (const [page, webDir] of [["current page", w.copy ? await variantWeb(t, []) : undefined], ["page with the fix reversed", await variantWeb(t, w.reverts)]] as const) {
    const board = await startBoard(t, { webDir });
    const bp = await BoardPage.open(browser, board, w.storage?.(board) ?? openAll(board));
    const all = await w.run(bp, board), hits = all.filter(v => v.startsWith(w.family));
    await bp.context.close();
    if (page === "current page") assert.deepEqual(all, [], "the current page passes this check");
    else assert.ok(hits.length > 0, `the check misses the bug on the ${page}; it reported: ${all.join("\n") || "nothing"}`);
  }
});

test("at a window 700px wide the blocks of the right column sit where they did with the maximum widths", { timeout: 10 * 60_000 }, async t => {
  const browser = await launch(t), laid: string[][] = [];
  for (const webDir of [undefined, await variantWeb(t, CAPS.map(capBack))]) {
    const board = await startBoard(t, { webDir });
    const bp = await BoardPage.open(browser, board, openAll(board));
    await bp.page.setViewportSize({ width: 700, height: 1000 });
    await bp.settle();
    const { blocks } = await measureBlocks(bp, await oracle(board.store));
    await bp.context.close();
    laid.push(blocks.map(b => `${b.item} ${b.sel} #${b.at}: x ${Math.round(b.x)}, ${Math.round(b.w)}px wide`));
  }
  assert.ok(laid[0]!.length > 0, "the page shows blocks to compare");
  assert.deepEqual(laid[0], laid[1]);
});
