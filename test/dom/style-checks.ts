// Facts of the page's stylesheet that the owner sees on the page, checked on the page in a DOM library against what the stylesheet
// declares for the elements the page draws (test/dom/styles.ts): the font of a code block, the contrast of a tag chip, the colour of a
// status chip, where the list of messages sits, the blue bar of a changed block, the width of the blocks of the right column. They need no
// layout. Families: code-font, tag-contrast, idle-status, messages-place, changed-block, full-width-cap.

import type { DOMWindow } from "jsdom";
import type { Oracle } from "./checks.ts";
import { DomPage } from "./page.ts";
import { Styles, contrast, over, parseColor } from "./styles.ts";
import type { Rgba } from "./styles.ts";

/** Code blocks are set in Monaco at 13.5px, and the inner code element inherits the block's font. */
export async function checkCodeFont(bp: DomPage, o: Oracle): Promise<string[]> {
  const v: string[] = [], x = bp.board.gen.witness.code;
  await bp.select(x);
  const pre = bp.$("#item-detail .rich pre.code"), code = pre?.querySelector("code");
  if (!pre || !code) return [`code-font: ${x} (${o.s.items[x]!.title}) shows no code block`];
  const st = new Styles(bp.win);
  const f = { preFamily: st.value(pre, "font-family") ?? "", preSize: st.value(pre, "font-size") ?? "", codeFamily: st.value(code, "font-family") ?? "", codeSize: st.value(code, "font-size") ?? "" };
  if (f.preFamily.split(",")[0]!.trim().replace(/["']/g, "") !== "Monaco") v.push(`code-font: a code block's font is ${f.preFamily}, not Monaco first`);
  if (f.preSize !== "13.5px") v.push(`code-font: a code block is ${f.preSize}, not 13.5px`);
  if (f.codeFamily !== f.preFamily || f.codeSize !== f.preSize) v.push(`code-font: the code text inside a block is set in ${f.codeFamily} ${f.codeSize}, not the block's ${f.preFamily} ${f.preSize}`);
  return v;
}

/** Tag chips' text contrasts with what is behind it at least 4.5:1 (WCAG AA), in light and dark themes. Chips in dimmed rows (a context
 * row of a filter, a closed item on the path to open work) are faded on purpose and left out. */
export async function checkTagContrast(bp: DomPage): Promise<string[]> {
  const v: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    const st = new Styles(bp.win, { scheme });
    const color = (e: Element, prop: string): Rgba | null => { const text = st.value(e, prop); return text === undefined ? null : parseColor(text); };
    for (const chip of bp.$$(".tagchip")) {
      if (hiddenByAttribute(chip)) continue;
      let faded = false;
      const layers: Rgba[] = [];
      for (let e: Element | null = chip; e; e = e.parentElement) {
        if (Number(st.value(e, "opacity") ?? 1) < 1) faded = true;
        const bg = color(e, "background-color");
        if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 1) break; }
      }
      if (faded) continue;
      let base = { r: 255, g: 255, b: 255 };
      if (!layers.length || layers.at(-1)!.a < 1) { const c = color(bp.doc.body, "background-color"); if (c) base = { r: c.r, g: c.g, b: c.b }; }
      for (const layer of layers.reverse()) base = over(layer, base);
      const fg = color(chip, "color");
      if (!fg) { v.push(`tag-contrast (${scheme}): ${chip.closest("[id]")?.id ?? "?"} 「${chip.textContent}」 has no text colour`); continue; }
      const ratio = contrast(over(fg, base), base);
      if (ratio < 4.5) v.push(`tag-contrast (${scheme}): ${chip.closest("[id]")?.id ?? "?"} 「${chip.textContent}」 ${ratio.toFixed(2)}:1 (${st.value(chip, "color")} on rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)}))`);
    }
  }
  return v;
}

/** The 停滞 status (docs/design.md, Status): the status chip of an open item of each live status has a background of its own. Violations
 * start with "idle-status". */
export async function checkStatusChipBackground(bp: DomPage, o: Oracle): Promise<string[]> {
  const v: string[] = [], ids = Object.keys(o.s.items).filter(id => !o.s.items[id]!.record);
  for (const scheme of ["light", "dark"] as const) {
    const st = new Styles(bp.win, { scheme });
    for (const status of ["todo", "idle", "wip", "blocked"]) {
      const id = ids.find(x => o.r.statusOf(x) === status);
      if (!id) { v.push(`idle-status: the board has no item with status ${status}`); continue; }
      await bp.select(id);
      const chip = bp.$("#item-detail > .item .item-head .st");
      if (!chip) { v.push(`idle-status: ${id} (${status}) shows no status chip`); continue; }
      const bg = st.value(chip, "background-color");
      if (!bg || parseColor(bg).a === 0) v.push(`idle-status: the chip of ${id} (${status}) has no background of its own (${scheme})`);
    }
  }
  return v;
}

/** The list of messages sits at the page's top right, just left of the shortcut menu, level with it and clear of it, fixed to the window
 * so it stays when the list scrolls, and its panel opens inside that fixed box, so it lies over the page and moves nothing. */
export async function checkMessagesPlace(bp: DomPage): Promise<string[]> {
  const v: string[] = [], st = new Styles(bp.win);
  const box = bp.$("#messages"), toggle = bp.$("#messages .messages-toggle"), menu = bp.$("#keymenu"), menuButton = bp.$("#keymenu .keymenu-btn");
  if (!box || !toggle || !menu || !menuButton) return [`messages-place: the page lacks ${[["#messages", box], ["its button", toggle], ["#keymenu", menu], ["the menu's button", menuButton]].filter(([, e]) => !e).map(([n]) => n).join(", ")}`];
  const px = (e: Element, prop: string) => { const text = st.value(e, prop); const m = text?.match(/^(-?[\d.]+)px$/); return m ? Number(m[1]) : null; };
  const pos = (e: Element) => st.value(e, "position");
  for (const [what, e] of [["the messages box", box], ["the shortcut menu", menu]] as const) if (pos(e) !== "fixed") v.push(`messages-place: ${what} is ${pos(e) ?? "static"}, not fixed to the window, so it would scroll with the list`);
  if (st.value(box, "top") !== st.value(menu, "top")) v.push(`messages-place: the messages box is at top ${st.value(box, "top")}, the menu at ${st.value(menu, "top")}: not on one row`);
  if (px(toggle, "height") !== px(menuButton, "height")) v.push(`messages-place: the messages button is ${px(toggle, "height")}px high, the menu's ${px(menuButton, "height")}px: not on one row`);
  const right = px(box, "right"), menuRight = px(menu, "right"), menuWidth = px(menuButton, "width");
  if (right === null || menuRight === null || menuWidth === null) v.push(`messages-place: cannot read the right edges (box ${st.value(box, "right")}, menu ${st.value(menu, "right")}, menu button width ${st.value(menuButton, "width")})`);
  else {
    // The gap between the messages box's right edge and the menu's left edge: not negative (it would cover the menu), under 20px (beside it).
    const gap = right - (menuRight + menuWidth);
    if (gap < 0) v.push(`messages-place: the messages box overlaps the shortcut menu by ${-gap}px`);
    if (gap >= 20) v.push(`messages-place: the messages box is ${gap}px from the shortcut menu, not beside it`);
  }
  // The panel exists once the list is opened.
  if (!bp.$("#messages-panel")) { bp.click(toggle, "the messages button"); await bp.settle(); }
  const panel = bp.$("#messages-panel");
  if (panel && (!box.contains(panel) || pos(panel) === "fixed")) v.push(`messages-place: the panel is not laid out inside the messages box (${pos(panel) ?? "static"})`);
  return v;
}

/** A changed body block, and a changed card question, carry a blue bar at their left edge and no background of their own. The bar is the
 * block's `::before`, placed against the block (the block is its anchor, the bar absolute, 7px left of the block's edge, 3px in from the
 * block's top and bottom so it is as tall as the block less 6px, 3px wide, with a colour). The page holds no changed block to look at, so
 * probes are added to a window with the page's stylesheet and read the way the page's own text would be: the rules are not scoped to an
 * item. Violations start with "changed-block". */
export function checkChangedBlocks(win: DOMWindow): string[] {
  const v: string[] = [], doc = win.document;
  const add = (tag: string, cls: string, parent: Element) => { const e = doc.createElement(tag); if (cls) e.className = cls; e.textContent = "probe"; parent.appendChild(e); return e; };
  const rich = add("div", "rich", doc.body), block = add("div", "chg-add", rich);
  const card = add("div", "card", doc.body), question = add("span", "chg-add", add("h3", "", card));
  const st = new Styles(win);
  for (const [what, e] of [["a changed block", block], ["a changed card question", question]] as const) {
    const bar = (prop: string) => st.value(e, prop, "before");
    const color = bar("background-color");
    if (!color || parseColor(color).a === 0) v.push(`changed-block: ${what} has no blue bar`);
    if (bar("width") !== "3px") v.push(`changed-block: ${what}'s bar is ${bar("width")} wide, expected 3px`);
    if (bar("position") !== "absolute" || bar("left") !== "-7px") v.push(`changed-block: ${what}'s bar is at ${bar("left")} (${bar("position") ?? "static"}), not beside its left edge at -7px`);
    if (bar("top") !== "3px" || bar("bottom") !== "3px" || bar("height") !== undefined) v.push(`changed-block: ${what}'s bar is not the block's height less 6px (top ${bar("top")}, bottom ${bar("bottom")}, height ${bar("height")})`);
    if (st.value(e, "position") !== "relative") v.push(`changed-block: ${what} is ${st.value(e, "position") ?? "static"}, so its bar is not placed against it`);
    const own = st.value(e, "background-color");
    if (own !== undefined && parseColor(own).a > 0) v.push(`changed-block: ${what} has a background ${own}`);
  }
  return v;
}

/** The blocks of an item's detail that once had a maximum width of 78 characters (76 for the paragraphs of a card). */
const FULL_WIDTH_BLOCKS = [".note", ".log", ".rich", ".editor", ".body p", ".ask", ".checks", ".deplists", ".card p", ".refpop"] as const;
/** Items that between them show every block in FULL_WIDTH_BLOCKS: the one with listed comments (and a head, a log), the one with code in its
 * head, items with an ask, with checks, with dependents, and the home of a card no plan names. */
function widthProbes(o: Oracle, w: DomPage["board"]["gen"]["witness"]): string[] {
  const ids = Object.keys(o.s.items), live = (id: string) => o.r.statusOf(id) !== "cancelled";
  const some = (n: number, pred: (id: string) => boolean) => ids.filter(id => live(id) && pred(id)).slice(0, n);
  return [...new Set([
    w.commentItem, w.code,
    ...some(2, id => !!o.s.items[id]!.ask),
    ...some(2, id => o.r.checks(id).length > 0),
    ...some(2, id => o.r.dependents(id).some(d => !d.own && live(d.id))),
    o.s.decisions[w.recordCard]!.item, o.s.decisions[w.otherPlanCard]!.item,
  ])];
}
/** The blocks of an item's detail have no maximum width: the owner asked for the column's content to fill it. Opens each probe item with
 * its log and comment lists unfolded and the comment box open, and reads what the stylesheet gives each block it shows. (That the blocks
 * then fill their boxes, and that nothing else narrows them, needs a layout: test/e2e.) Violations start with "full-width-cap <block>:"; a
 * block no probe shows is "full-width-setup". */
export async function checkNoWidthCaps(bp: DomPage, o: Oracle): Promise<string[]> {
  const v: string[] = [], w = bp.board.gen.witness, found = new Set<string>();
  for (const id of widthProbes(o, w)) {
    await bp.select(id);
    // A list unfolded can show another folded under it.
    for (let k = 0; k < 3; k++) {
      const folded = bp.$$('#item-detail .notes-toggle[aria-expanded="false"]');
      folded.forEach(b => b.click());
      await bp.settle();
      if (!folded.length) break;
    }
    const field = bp.$("#item-detail .item-comment");
    if (field) {
      bp.click(field, "the comment field"); await bp.settle();
      // Typing "#" and the start of a title opens the popup of items under the comment field.
      if (id === w.commentItem) { bp.fill(bp.$("#item-detail textarea"), "#" + o.s.items[id]!.title.slice(0, 2), "the comment box"); await bp.settle(); }
    }
    const st = new Styles(bp.win), detail = bp.$("#item-detail")!;
    for (const sel of FULL_WIDTH_BLOCKS) for (const e of bp.$$(sel, detail)) {
      if (!bp.shown(e)) continue;
      found.add(sel);
      const cap = st.value(e, "max-width");
      if (cap !== undefined && cap !== "none") v.push(`full-width-cap ${sel}: a ${sel} in ${id} has max-width ${cap}`);
    }
  }
  for (const sel of FULL_WIDTH_BLOCKS) if (!found.has(sel)) v.push(`full-width-setup: no ${sel} is shown in any probe item`);
  return v;
}

/** Whether the element or an ancestor carries the `hidden` attribute. */
function hiddenByAttribute(el: Element): boolean {
  for (let e: Element | null = el; e; e = e.parentElement) if ((e as HTMLElement).hidden) return true;
  return false;
}
