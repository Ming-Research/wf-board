// Facts of the page's stylesheet that the owner sees on the page, checked on the page in a DOM library against what the stylesheet
// declares for the elements the page draws (test/dom/styles.ts): the font of a code block, the contrast of a tag chip, the colour of a
// status chip, where the list of messages sits. They need no layout. Families: code-font, tag-contrast, idle-status, messages-place.

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

/** Whether the element or an ancestor carries the `hidden` attribute. */
function hiddenByAttribute(el: Element): boolean {
  for (let e: Element | null = el; e; e = e.parentElement) if ((e as HTMLElement).hidden) return true;
  return false;
}
