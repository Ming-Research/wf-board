// The parts of the page the diagram checks protect, each taken out in turn (an edit applied while the page is bundled, test/e2e/variant.ts):
// the page with that one part missing, on which the check that protects it must report the part's absence.

import type { Revert } from "../e2e/variant.ts";

const spoil = (file: Revert["file"], edit: string, find: string, replace: string): Revert => ({ file, edit, find, replace });
const mermaid = (edit: string, find: string, replace: string) => spoil("web/mermaid.ts", edit, find, replace);
const css = (edit: string, find: string, replace: string) => spoil("web/index.html", edit, find, replace);

export const SPOILED = {
  noWrap: spoil("web/highlight.ts", "a mermaid block is not wrapped for the page to draw", `return fenceLang(info) === "mermaid" ? '<div class="mermaid-block">' + pre + "</div>" : pre;`, "return pre;"),
  noError: mermaid("a bad block shows no error", 'note.textContent = "图画不出来：" + message;', 'note.textContent = "";'),
  loose: mermaid("the library runs with the loose security level", 'securityLevel: "strict"', 'securityLevel: "loose"'),
  eager: mermaid("the library is asked for at start", 'if (typeof MutationObserver === "undefined") return;', 'if (typeof MutationObserver === "undefined") return;\n  void load();'),
  // Draws only until the first diagram is drawn, the way a page that draws from its first render alone would (with lateDraw, which takes out the other place the page draws a repainted item's diagrams).
  firstOnly: mermaid("only the first render is drawn", "new MutationObserver(records => {\n", "new MutationObserver(records => {\n    if (drawn.size) return;\n"),
  lateDraw: spoil("web/app.ts", "the diagrams are drawn after the repaint restores the scroll", "drawMermaid(pane);", ""),
  sameIds: mermaid("a copy keeps the ids of the first copy", 'show(block, known.svg.replaceAll(known.id, "mermaid-" + ++serial), source)', "show(block, known.svg, source)"),
  ignoreOwn: mermaid("the frontmatter of a diagram is taken off", "await mermaid.render(id, source)", 'await mermaid.render(id, source.replace(/^---\\n[\\s\\S]*?\\n---\\n/, ""))'),
  lightOnly: mermaid("the diagram is always drawn in the light colors", 'theme = dark() ? "dark" : "default"', 'theme = "default"'),
  systemOnly: mermaid("the system's scheme wins over the owner's attribute", 'return theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);', 'return matchMedia("(prefers-color-scheme: dark)").matches;'),
  // A diagram at its own width, whatever its box: what the page did before it fitted diagrams to the box.
  fixedSize: css("a diagram is drawn at its own width", "width: calc(min(var(--natural), 100%) * var(--zoom, 1));", "width: var(--natural);"),
  noScroll: css("the box of a diagram does not scroll", ".mermaid-fig { overflow-x: auto; ", ".mermaid-fig { "),
  noCenter: css("a narrow diagram is not centered", "display: block; margin-inline: auto; ", "display: block; "),
  // A zoom that leaves the scroll alone, so the point under the cursor moves: sideways, and up or down.
  noAnchorX: mermaid("a zoom keeps the box's scroll", "fig.scrollLeft += after.left + (at.x - before.left) / before.width * after.width - at.x;", ""),
  noAnchorY: mermaid("a zoom keeps the page's scroll", "scroller(fig).scrollTop += after.top + (at.y - before.top) / before.height * after.height - at.y;", ""),
  resetNothing: mermaid("fit to width does nothing", "() => { set(1, middle()); fig.scrollLeft = 0; }", "() => {}"),
  noVerticalDrag: mermaid("a drag leaves the page alone", "page.scrollTop = start.top - (e.clientY - start.y);", ""),
  noTools: mermaid("a drawn diagram has no toolbar", "block.prepend(viewer(block, fig, source));", ""),
  wheelZoomsAll: mermaid("the plain wheel zooms too", "if (!event.ctrlKey) return;", ""),
  noDrag: mermaid("a diagram cannot be dragged", 'if (down.button !== 0 || down.pointerType !== "mouse" || block.dataset.pan !== "yes") return;', "return;"),
  actualIsFit: mermaid("the share buttons draw the box's width", "else set(ownSize() * part, middle());", "else set(1, middle());"),
  staleSize: mermaid("the size in the toolbar is not updated", 'percent.textContent = Math.round(drawn / own * 100) + "%";', 'percent.textContent ||= Math.round(drawn / own * 100) + "%";'),
  noHint: css("the hint is not shown", ".mermaid-hint { margin-left: auto;", ".mermaid-hint { display: none; margin-left: auto;"),
  hintLeft: css("the hint sits at the left", ".mermaid-hint { margin-left: auto;", ".mermaid-hint {"),
  wrongHint: mermaid("the hint reads another text", 'hint.textContent = "双指缩放，拖动或滚动查看";', 'hint.textContent = "可拖动";'),
  noFrame: css("a diagram has no frame", '.mermaid-block[data-state="done"] { border: 1px solid var(--rule); border-radius: 6px; }', ""),
  barBelow: mermaid("the toolbar is below the diagram", "block.prepend(viewer(block, fig, source));", "block.append(viewer(block, fig, source));"),
  sizeSwapped: mermaid("the size comes after larger", '    percent,\n    button("+", "放大", () => set(zoom * STEP, middle())),', '    button("+", "放大", () => set(zoom * STEP, middle())),\n    percent,'),
  noScrollbar: css("the box has no scroll bar of its own", ".mermaid-fig::-webkit-scrollbar { height: 10px; }", ""),
  noShade: css("no shade at the edge that has more", 'content: ""; position: absolute; top: 0; bottom: 0; width: 18px; pointer-events: none;', ""),
  noGrab: css("no grabbing hand", "cursor: grab; ", ""),
  // Colors that do not follow the page's color scheme.
  fixedInk: css("the toolbar keeps its light-scheme ink", "background: var(--surface); color: var(--ink); font-size: 13px;", "background: var(--surface); color: #18201e; font-size: 13px;"),
  fixedThumb: css("the scroll bar keeps its light-scheme color", ".mermaid-fig::-webkit-scrollbar-thumb { background: var(--muted);", ".mermaid-fig::-webkit-scrollbar-thumb { background: #5b6763;"),
  // A view that is forgotten at once, and one shared by every source.
  forgetView: mermaid("a view is forgotten", "const saved = views.get(source);", "const saved = undefined as { zoom: number; left: number } | undefined;"),
  oneView: [
    mermaid("every source shares one view (read)", "const saved = views.get(source);", 'const saved = views.get("");'),
    mermaid("every source shares one view (forget)", "views.delete(source)", 'views.delete("")'),
    mermaid("every source shares one view (keep)", "views.set(source, {", 'views.set("", {'),
  ],
} satisfies Record<string, Revert | Revert[]>;
