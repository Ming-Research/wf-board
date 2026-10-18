// The checks of the diagrams on the owner's page, run in a DOM library against a stand-in for the diagram library
// (test/dom/mermaid-library.ts) and a model of the diagram boxes (test/dom/mermaid-layout.ts). They are the checks of
// test/e2e/mermaid.e2e.ts whose answer is the page's own doing: what it makes of a block (its state, its error, its toolbar), what it
// asks the library, how it zooms and drags, which stylesheet rules it relies on. Each returns its violations, each opening with the
// family name, so a test can assert none and a witness can assert the one its spoiled page causes. What the real library draws and how
// a real browser lays a box out are the browser layer's.

import { ops } from "../../src/ops.ts";
import type { BoardServer, Hooks } from "../e2e/board-server.ts";
import { fence, BAD, PIPELINE, OWN } from "../e2e/mermaid-charts.ts";
import type { Revert } from "../e2e/variant.ts";
import { DomPage } from "./page.ts";
import { StandIn } from "./mermaid-library.ts";
import { diagramBoxes } from "./mermaid-layout.ts";
import { Styles, contrast, over, parseColor } from "./styles.ts";
import type { Rgba } from "./styles.ts";

/** Writes `head` as the head of item `id`. */
export async function setHead(board: BoardServer, id: string, head: string) {
  const it = board.store.snapshot().items[id]!;
  await ops(board.store).updateItem({ author: it.group, id, rev: it.rev, head, reason: "test content" });
}
export async function addLog(board: BoardServer, id: string, text: string) {
  const it = board.store.snapshot().items[id]!;
  await ops(board.store).appendLog({ author: it.group, id, text });
}

/** A page open on the board's witness item, whose head `seed` has written. */
export interface Scene { bp: DomPage; board: BoardServer; id: string; lib: () => StandIn }
/** Opens the page, with `reverts` applied, with the stand-in for the library and diagram boxes `box` px wide, and selects the item (the board's witness item unless one is named). */
export async function scene(t: Hooks, board: BoardServer, seed: (board: BoardServer, id: string) => Promise<void>, reverts: Revert[] = [], box = 600, id = board.gen.witness.code): Promise<Scene> {
  await seed(board, id);
  const bp = await DomPage.open(t, board, { reverts, library: page => new StandIn(() => page.doc), setup: diagramBoxes(box) });
  await bp.select(id);
  return { bp, board, id, lib: () => bp.library as StandIn };
}

const round = (n: number) => Math.round(n);
const text = (e: Element | null | undefined) => e?.textContent ?? "";
/** What the page's stylesheet gives an element: the cascade after the page changed (test/dom/styles.ts). */
function css(bp: DomPage, el: Element, prop: string, pseudo: string | null = null): string | undefined { bp.styles.forget(); return bp.styles.value(el, prop, pseudo); }

/** Waits until `scope` holds `count` mermaid blocks, none of them still loading. The answer is null, or what the page held when it did not. */
export async function settled(bp: DomPage, count: number, scope = "#item-detail"): Promise<string | null> {
  const states = () => bp.$$(scope + " .mermaid-block").map(b => b.dataset.state ?? "none");
  for (let k = 0; k < 6; k++) {
    await bp.settle();
    const now = states();
    if (now.length === count && now.every(s => s === "done" || s === "error")) return null;
  }
  const now = states();
  return `expected ${count} mermaid blocks drawn; found ${now.length} blocks, states ${now.join(",") || "-"}`;
}
const states = (bp: DomPage) => bp.$$("#item-detail .mermaid-block").map(b => b.dataset.state ?? "none");
/** Whether the page shows the source of GOOD as an ordinary code block under `scope`: the part a page without the wrapper still has. */
const shownAsCode = (bp: DomPage, scope: string) => bp.$$(scope + " pre.code").some(p => !p.closest(".mermaid-block") && text(p).includes("A[需求] --> B[设计]"));

/** The head's blocks: a good one is a diagram in place of its code, with its labels; the bad one shows its source and the error; the one after it and the code block after that are untouched. */
export async function checkHead({ bp }: Scene): Promise<string[]> {
  const waited = await settled(bp, 3);
  if (waited) return [`mermaid-head: ${waited}`, ...(shownAsCode(bp, "#item-detail") ? ["mermaid-head: the head's diagram source is shown as plain code"] : [])];
  const v: string[] = [];
  const got = bp.$$("#item-detail .mermaid-block").map(b => {
    const fig = b.querySelector(".mermaid-fig"), pre = b.querySelector("pre.code"), err = b.querySelector(".mermaid-err");
    return { state: b.dataset.state, svg: !!fig?.querySelector("svg"), label: text(fig?.querySelector("svg")), code: text(pre), codeShown: !!pre && css(bp, pre, "display") !== "none", err: err ? text(err) : null };
  });
  const [good, bad, sequence] = got;
  if (!good || good.state !== "done" || !good.svg) v.push(`mermaid-head: the good block is ${good?.state ?? "missing"}, not a drawn diagram`);
  else {
    for (const word of ["需求", "设计", "实现"]) if (!good.label.includes(word)) v.push(`mermaid-head: the diagram lacks the label ${word}; its text is ${JSON.stringify(good.label)}`);
    if (good.codeShown) v.push("mermaid-head: the code still shows beside the drawn diagram");
  }
  if (!bad || bad.state !== "error") v.push(`mermaid-head: the bad block is ${bad?.state ?? "missing"}, not an error`);
  else {
    if (bad.svg) v.push("mermaid-head: the bad block has a diagram");
    if (!bad.codeShown || bad.code !== BAD) v.push(`mermaid-head: the bad block does not show its source: ${JSON.stringify(bad.code)}`);
    if (!bad.err?.startsWith("图画不出来：") || bad.err.length < 12) v.push(`mermaid-head: the bad block shows no error: ${JSON.stringify(bad.err)}`);
  }
  if (!sequence || sequence.state !== "done" || !sequence.svg || !sequence.label.includes("参与者甲")) v.push(`mermaid-head: the block after the bad one is ${sequence?.state ?? "missing"}, not a drawn diagram with its labels`);
  const wf = bp.$$("#item-detail pre.code").filter(p => !p.closest(".mermaid-block")).map(p => text(p)), stray = bp.$$('[id^="dmermaid-"]').length;
  if (!wf.includes("fn main() {}")) v.push("mermaid-head: the code block after the diagrams is not shown as code");
  if (stray) v.push(`mermaid-head: ${stray} half-drawn diagrams were left in the page`);
  return v;
}

/** A block in a log entry is a diagram too: the log is opened the way the owner does. */
export async function checkLog({ bp }: Scene): Promise<string[]> {
  bp.click(bp.$("#item-detail .log-toggle"), "the log toggle");
  const waited = await settled(bp, 1, "#item-detail .log");
  if (waited) return [`mermaid-log: ${waited}`, ...(shownAsCode(bp, "#item-detail .log") ? ["mermaid-log: the log's diagram source is shown as plain code"] : [])];
  const b = bp.$("#item-detail .log .mermaid-block")!, label = text(b.querySelector("svg")), svg = !!b.querySelector(".mermaid-fig svg");
  return b.dataset.state === "done" && svg && label.includes("需求") ? [] : [`mermaid-log: the block in the log is ${b.dataset.state} (diagram ${svg}, text ${JSON.stringify(label)})`];
}

/** The library is asked for when the page shows a block, once, and not when it shows none. */
export async function checkLazy({ bp }: Scene, blocks: number): Promise<string[]> {
  await bp.settle();
  if (blocks > 0) { const waited = await settled(bp, blocks); if (waited) return [`mermaid-lazy: ${waited}`]; }
  const n = bp.loads.length;
  return n === (blocks === 0 ? 0 : 1) ? [] : [`mermaid-lazy: a page with ${blocks} diagrams asked for the library ${n} times, expected ${blocks === 0 ? "none" : "once"}`];
}

/** The library is told to keep the text of a diagram plain: strict security level, which makes a label plain text and leaves out the click handlers (what strict does is the library's, test/e2e). */
export async function checkStrict({ bp, lib }: Scene): Promise<string[]> {
  const waited = await settled(bp, 1);
  if (waited) return [`mermaid-strict: ${waited}`];
  const config = lib().configs.at(-1);
  return config?.securityLevel === "strict" ? [] : [`mermaid-strict: the page configured the library with security level ${JSON.stringify(config?.securityLevel)}, not "strict"`];
}

/** The head the repaint check writes: a new line before the blocks and a new diagram after them. */
export const REPAINT_HEAD = (head: string) => "新写了一段。\n\n" + head + "\n\n" + fence("flowchart TD\n  P[甲] --> Q[乙]");
/** A live update repaints the item: its diagrams, the old ones and a new one, are diagrams again after it. */
export async function checkRepaint({ bp, board, id }: Scene, head: string): Promise<string[]> {
  const first = await settled(bp, 3);
  if (first) return [`mermaid-repaint: before the update, ${first}`];
  const old = bp.$("#item-detail .mermaid-block")!;
  const base = bp.changes();
  await setHead(board, id, REPAINT_HEAD(head));
  await bp.waitChanges(base + 1);
  const v: string[] = [];
  if (old.isConnected) v.push("witness setup: the live update did not repaint the item");
  const waited = await settled(bp, 4);
  if (waited) v.push(`mermaid-repaint: after the live update, ${waited}`);
  else if (states(bp).join() !== "done,error,done,done") v.push(`mermaid-repaint: after the live update the blocks are ${states(bp).join(",")}, expected done,error,done,done`);
  return v;
}

/** The same diagram drawn twice in one page, its first copy in a folded section (the head's 参考 section) and its second in the log opened after: no id is in the page twice, and each line marker a visible diagram points at is in that diagram, not in the hidden copy. */
export async function checkIds({ bp }: Scene): Promise<string[]> {
  const first = await settled(bp, 1);
  if (first) return [`mermaid-ids: ${first}`];
  bp.click(bp.$("#item-detail .log-toggle"), "the log toggle");
  const waited = await settled(bp, 2);
  if (waited) return [`mermaid-ids: ${waited}`];
  const figs = bp.$$("#item-detail .mermaid-fig"), ids = figs.flatMap(f => [...f.querySelectorAll("[id]")].map(e => e.id));
  // A folded section is not shown; the copy in it is not the visible one.
  const shown = figs.filter(f => bp.shown(f));
  const foreign: string[] = [];
  let markers = 0;
  for (const f of shown) for (const e of f.querySelectorAll("[marker-end], [marker-start]")) {
    for (const attribute of ["marker-end", "marker-start"]) {
      const target = /url\(["']?#([^"')]+)/.exec(e.getAttribute(attribute) ?? "")?.[1];
      if (target === undefined) continue;
      markers++;
      if (!f.contains(bp.doc.getElementById(target))) foreign.push(target);
    }
  }
  const v: string[] = [];
  if (figs.length !== 2 || shown.length !== 1) v.push(`witness setup: ${figs.length} diagrams, ${shown.length} of them visible; expected 2 and 1 (the first in a folded section)`);
  const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (twice.length) v.push(`mermaid-ids: ${twice.length} ids are in the page twice, such as ${twice[0]}`);
  if (!ids.length) v.push("mermaid-ids: the diagrams have no ids at all, so the check saw nothing");
  if (!markers) v.push("witness setup: the visible diagram has no line markers to check");
  if (foreign.length) v.push(`mermaid-ids: the visible diagram's lines point at markers outside it: ${foreign.join(", ")}`);
  return v;
}

/** A diagram brings its own settings in a frontmatter block at its start: the page gives the library the text whole, so they win over the page's (the library applies them, test/e2e). */
export async function checkOwn({ bp, lib }: Scene): Promise<string[]> {
  const waited = await settled(bp, 1);
  if (waited) return [`mermaid-own: ${waited}`];
  const asked = lib().drawn.at(-1)?.text;
  const theme = bp.$("#item-detail .mermaid-fig svg")?.getAttribute("data-theme");
  return asked === OWN && theme === "dark" ? [] : [`mermaid-own: the diagram asks for the dark theme in its frontmatter and the page does not use it: the library was given ${JSON.stringify(asked)} and drew the ${theme} theme`];
}

/** The theme the stand-in drew the open diagram with. */
const drawnTheme = (bp: DomPage) => bp.$("#item-detail .mermaid-fig svg")?.getAttribute("data-theme");
/** Waits until the open diagram is drawn with `theme`; a message when it is not. */
async function takes(bp: DomPage, theme: "dark" | "default", what: string): Promise<string | null> {
  for (let k = 0; k < 6; k++) {
    await bp.settle();
    if (drawnTheme(bp) === theme) return null;
  }
  return `${what}: the diagram did not take the ${theme === "dark" ? "dark" : "light"} colors; it is drawn with ${drawnTheme(bp) ?? "nothing"}`;
}
/** The page drawing in each color scheme: the diagram follows the system's scheme, and a change of scheme redraws the open diagram. */
export async function checkColors({ bp }: Scene): Promise<string[]> {
  const waited = await settled(bp, 1);
  if (waited) return [`mermaid-colors: ${waited}`];
  const v: string[] = [];
  for (const scheme of ["dark", "light"] as const) {
    bp.setScheme(scheme);
    const missing = await takes(bp, scheme === "dark" ? "dark" : "default", `mermaid-colors (${scheme})`);
    if (missing) v.push(missing);
  }
  return v;
}
/** The owner's data-theme attribute on the root element wins over the system's scheme, whichever way they disagree, and the open diagram follows it. */
export async function checkTheme({ bp }: Scene): Promise<string[]> {
  const waited = await settled(bp, 1);
  if (waited) return [`mermaid-theme: ${waited}`];
  const v: string[] = [];
  for (const [system, attribute] of [["light", "dark"], ["dark", "light"]] as const) {
    bp.setScheme(system);
    bp.doc.documentElement.setAttribute("data-theme", attribute);
    const missing = await takes(bp, attribute === "dark" ? "dark" : "default", `mermaid-theme (${attribute} data-theme over a ${system} system)`);
    if (missing) v.push(missing);
  }
  bp.doc.documentElement.removeAttribute("data-theme");
  bp.setScheme("light");
  return v;
}

// The boxes and what they hold, as the model of the diagram boxes lays them out.
export interface Figure { natural: number; drawn: number; drawnHeight: number; box: number; scroll: number; scrollLeft: number; overflowX: string; left: number; top: number; boxLeft: number; pan: string; own: string }
export function figures(bp: DomPage): Figure[] {
  return bp.$$("#item-detail .mermaid-fig").map(fig => {
    const svg = fig.querySelector("svg")!, r = svg.getBoundingClientRect(), b = fig.getBoundingClientRect();
    return {
      natural: svg.viewBox.baseVal.width, drawn: r.width, drawnHeight: r.height, box: fig.clientWidth, scroll: fig.scrollWidth, scrollLeft: fig.scrollLeft,
      overflowX: css(bp, fig, "overflow-x") ?? "visible", left: r.left, top: r.top, boxLeft: b.left, pan: fig.closest<HTMLElement>(".mermaid-block")!.dataset.pan ?? "", own: (fig as HTMLElement).style.getPropertyValue("--natural"),
    };
  });
}
const firstFigure = (bp: DomPage) => figures(bp)[0]!;
const scrolls = (overflowX: string) => /auto|scroll/.test(overflowX);

/** At its default size a diagram is as wide as itself or, when its box is narrower, as wide as the box: never larger than itself, the box has nothing to scroll sideways and a box that cannot scroll never holds a wider diagram. A narrow one is centered. The box is the model's (test/dom/mermaid-layout.ts): the width is the page's stylesheet evaluated for it; the browser layer holds the same at two real window widths. */
export async function checkFit({ bp }: Scene): Promise<string[]> {
  const waited = await settled(bp, 3);
  if (waited) return [`mermaid-fit: ${waited}`];
  const got = figures(bp);
  if (got.length !== 3) return [`mermaid-fit: ${got.length} diagrams, expected 3`];
  const v: string[] = [];
  const [small, wide] = got as [Figure, Figure, Figure];
  if (wide.natural <= wide.box + 1) v.push(`witness setup: the wide diagram is ${round(wide.natural)} px, not wider than its box of ${wide.box} px`);
  got.forEach((f, i) => {
    const name = ["small", "wide", "tall"][i]!, want = Math.min(f.natural, f.box);
    if (f.own !== f.natural + "px") v.push(`mermaid-fit: the box of the ${name} diagram says its own width is ${JSON.stringify(f.own)}, not ${f.natural}px`);
    if (Math.abs(f.drawn - want) > 1) v.push(`mermaid-fit: the ${name} diagram is drawn ${round(f.drawn)} px wide; it should be ${round(want)}: its own width is ${round(f.natural)} px and its box is ${f.box} px wide`);
    if (f.scroll > f.box + 1) v.push(`mermaid-fit: the box of the ${name} diagram scrolls sideways at the default size (scroll width ${f.scroll} px in a box of ${f.box} px)`);
    if (f.pan !== "no") v.push(`mermaid-fit: the ${name} diagram says it can be dragged at the default size`);
    if (f.drawn > f.box + 1 && !/auto|scroll|hidden/.test(f.overflowX)) v.push(`mermaid-fit: the page scrolls sideways: the ${name} diagram is ${round(f.drawn)} px wide in a box of ${f.box} px that does not scroll (overflow-x ${f.overflowX})`);
  });
  if (small.natural < small.box && Math.abs(small.left - small.boxLeft - (small.box - small.drawn) / 2) > 2) {
    v.push(`mermaid-fit: the small diagram is not centered: it starts ${round(small.left - small.boxLeft)} px from the left of its ${small.box} px box, centered would be ${round((small.box - small.drawn) / 2)} px`);
  }
  return v;
}

const press = (bp: DomPage, label: string) => bp.click(bp.$(`#item-detail .mermaid-tools button[aria-label="${label}"]`), `the ${label} button`);
const buttons = (bp: DomPage) => bp.$$("#item-detail .mermaid-tools button").map(b => b.getAttribute("aria-label") ?? "");
const pageScroll = (bp: DomPage) => bp.doc.documentElement.scrollTop;
/** The middle of the part of the first diagram's box that is on the screen. */
function middle(bp: DomPage) {
  const b = bp.$("#item-detail .mermaid-fig")!.getBoundingClientRect(), top = Math.max(b.top, 0), bottom = Math.min(b.bottom, bp.win.innerHeight);
  return { x: b.left + b.width / 2, y: top < bottom ? (top + bottom) / 2 : b.top };
}
/** What the page does at one click of the enlarge button (web/mermaid.ts, STEP). */
const STEP = 1.25;

/** What the toolbar says about the size of the first diagram, against how large the diagram is drawn as a share of its own width; null when they agree. */
function percentIssue(bp: DomPage, f: Figure): string | null {
  const shown = text(bp.$("#item-detail .mermaid-percent")), want = f.drawn / f.natural * 100;
  return /^\d+%$/.test(shown) && Math.abs(parseInt(shown) - want) <= 1 ? null : `mermaid-zoom: the toolbar says ${JSON.stringify(shown)} for a diagram drawn at ${want.toFixed(1)}% of its own width`;
}

/** The buttons zoom by a step and show the size in percent, Ctrl and the wheel zoom about the cursor, the plain wheel is left to the page (it scrolls the page in a browser: test/e2e), a zoomed diagram is dragged, and fit to width gives the default size back. */
export async function checkZoom({ bp }: Scene): Promise<string[]> {
  const waited = await settled(bp, 1);
  if (waited) return [`mermaid-zoom: ${waited}`];
  const have = buttons(bp), v: string[] = [];
  for (const need of ["缩小", "放大", "适应宽度"]) if (!have.includes(need)) v.push(`mermaid-zoom: the diagram has no ${need} button; its buttons are ${have.join(", ") || "none"}`);
  if (v.length) return v;
  const start = firstFigure(bp);
  const shown = (f: Figure) => { const issue = percentIssue(bp, f); if (issue) v.push(issue); };
  shown(start);
  press(bp, "放大");
  const once = firstFigure(bp);
  shown(once);
  if (Math.abs(once.drawn - start.drawn * STEP) > 2) v.push(`mermaid-zoom: the enlarge button took the diagram from ${round(start.drawn)} to ${round(once.drawn)} px wide, not by ${STEP}`);
  press(bp, "缩小");
  const back = firstFigure(bp);
  if (Math.abs(back.drawn - start.drawn) > 2) v.push(`mermaid-zoom: enlarging and then shrinking left the diagram ${round(back.drawn)} px wide, from ${round(start.drawn)} px`);
  for (let i = 0; i < 4; i++) press(bp, "放大");
  const big = firstFigure(bp);
  shown(big);
  if (Math.abs(big.drawn - start.drawn * STEP ** 4) > start.drawn * 0.02) v.push(`mermaid-zoom: four steps up took the diagram from ${round(start.drawn)} to ${round(big.drawn)} px wide, expected ${round(start.drawn * STEP ** 4)}`);
  if (big.scroll <= big.box + 1) v.push(`witness setup: the enlarged diagram is ${round(big.drawn)} px wide and still fits its box of ${big.box} px`);
  else {
    if (!scrolls(big.overflowX)) v.push(`mermaid-zoom: the enlarged diagram's box does not scroll sideways (overflow-x ${big.overflowX})`);
    if (big.pan !== "yes") v.push(`mermaid-zoom: the enlarged diagram is wider than its box (${big.scroll} px in ${big.box} px) but does not say it can be dragged`);
  }

  const fig = bp.$<HTMLElement>("#item-detail .mermaid-fig")!;
  // Ctrl and the wheel zoom, and the point under the cursor stays under it.
  fig.scrollLeft = (fig.scrollWidth - fig.clientWidth) / 2;
  const at = middle(bp), pre = firstFigure(bp);
  const wheel = (init: WheelEventInit) => { const event = new bp.win.WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, ...init }); fig.dispatchEvent(event); return event; };
  wheel({ ctrlKey: true, deltaY: -100 });
  const post = firstFigure(bp);
  if (post.drawn <= pre.drawn + 5) v.push("mermaid-zoom: Ctrl and the wheel did not enlarge the diagram");
  else {
    const x = [(at.x - pre.left) / pre.drawn, (at.x - post.left) / post.drawn], y = [(at.y - pre.top) / pre.drawnHeight, (at.y - post.top) / post.drawnHeight];
    if (Math.abs(x[0]! - x[1]!) > 0.01 || Math.abs(y[0]! - y[1]!) > 0.01) v.push(`mermaid-zoom: Ctrl and the wheel moved the point under the cursor from (${x[0]!.toFixed(3)}, ${y[0]!.toFixed(3)}) to (${x[1]!.toFixed(3)}, ${y[1]!.toFixed(3)}) of the diagram`);
  }

  // The plain wheel is not taken from the page: no zoom, no scroll of the box, the event left to scroll the page.
  const w0 = firstFigure(bp), plain = wheel({ deltaY: 300 }), w1 = firstFigure(bp);
  if (plain.defaultPrevented) v.push("mermaid-zoom: the plain wheel over the diagram did not scroll the page: the page took the event");
  if (Math.abs(w1.drawn - w0.drawn) > 1) v.push(`mermaid-zoom: the plain wheel over the diagram zoomed it, from ${round(w0.drawn)} to ${round(w1.drawn)} px wide`);
  if (Math.abs(w1.scrollLeft - w0.scrollLeft) > 1) v.push(`mermaid-zoom: the plain wheel over the diagram scrolled its box sideways by ${round(w1.scrollLeft - w0.scrollLeft)} px`);

  // A mouse drags the diagram: sideways inside its box, up and down along the page.
  fig.scrollLeft = 200;
  const d0 = firstFigure(bp), q0 = pageScroll(bp), grab = middle(bp);
  const pointer = (kind: string, x: number, y: number) => fig.dispatchEvent(new bp.win.PointerEvent(kind, { bubbles: true, cancelable: true, button: 0, pointerType: "mouse", pointerId: 1, clientX: x, clientY: y }));
  pointer("pointerdown", grab.x, grab.y);
  for (let k = 1; k <= 8; k++) pointer("pointermove", grab.x - 15 * k, grab.y - 10 * k);
  pointer("pointerup", grab.x - 120, grab.y - 80);
  const d1 = firstFigure(bp), q1 = pageScroll(bp);
  if (Math.abs(d1.scrollLeft - d0.scrollLeft - 120) > 3) v.push(`mermaid-zoom: dragging the enlarged diagram 120 px to the left moved its box ${round(d1.scrollLeft - d0.scrollLeft)} px`);
  if (Math.abs(q1 - q0 - 80) > 3) v.push(`mermaid-zoom: dragging the enlarged diagram 80 px up moved the page ${round(q1 - q0)} px`);

  press(bp, "适应宽度");
  const end = firstFigure(bp);
  shown(end);
  if (Math.abs(end.drawn - start.drawn) > 2 || end.scrollLeft !== 0 || end.pan !== "no") v.push(`mermaid-zoom: after 适应宽度 the diagram is ${round(end.drawn)} px wide, scrolled ${round(end.scrollLeft)} px, dragging ${end.pan === "yes" ? "on" : "off"}; it was ${round(start.drawn)} px, 0 and off at the start`);
  return v;
}

/** The 60%, 90% and 100% buttons draw a diagram wider than its box at that share of its own size, the one shown is pressed, and pressed again the button gives the box's width back. */
export async function checkActual({ bp }: Scene): Promise<string[]> {
  const waited = await settled(bp, 1);
  if (waited) return [`mermaid-actual: ${waited}`];
  const have = buttons(bp);
  for (const need of ["60%", "90%", "100%"]) if (!have.includes(need)) return [`mermaid-actual: the diagram has no ${need} button; its buttons are ${have.join(", ") || "none"}`];
  const v: string[] = [], start = firstFigure(bp);
  if (start.natural <= start.box) return [`witness setup: the diagram is ${round(start.natural)} px wide and fits its box of ${start.box} px`];
  const pressed = () => bp.$$('#item-detail .mermaid-tools button[aria-pressed="true"]').map(b => b.getAttribute("aria-label"));
  for (const [label, share] of [["60%", 0.6], ["90%", 0.9]] as const) {
    press(bp, label);
    const f = firstFigure(bp);
    if (Math.abs(f.drawn - f.natural * share) > 2) v.push(`mermaid-actual: the ${label} button draws the diagram ${round(f.drawn)} px wide, not ${round(f.natural * share)} px`);
    const on = pressed();
    if (on.join() !== label) v.push(`mermaid-actual: with ${label} shown the pressed buttons are ${on.join(", ") || "none"}`);
  }
  press(bp, "100%");
  const actual = firstFigure(bp);
  if (Math.abs(actual.drawn - actual.natural) > 2) v.push(`mermaid-actual: the 100% button draws the diagram ${round(actual.drawn)} px wide, not its own ${round(actual.natural)} px`);
  if (actual.scroll <= actual.box + 1) v.push(`mermaid-actual: at its own size the diagram fits its box of ${actual.box} px`);
  else if (!scrolls(actual.overflowX)) v.push(`mermaid-actual: the box does not scroll sideways (overflow-x ${actual.overflowX})`);
  const issue = percentIssue(bp, actual);
  if (issue) v.push(issue);
  press(bp, "100%");
  const back = firstFigure(bp);
  if (Math.abs(back.drawn - start.drawn) > 2) v.push(`mermaid-actual: pressed again, 100% leaves the diagram ${round(back.drawn)} px wide, not the width of the box, ${round(start.drawn)} px`);
  return v;
}

const HINT = "双指缩放，拖动或滚动查看";
/** The toolbar is the top row of the diagram's frame, above the diagram: from the left smaller, the size in percent, larger, fit to width, 60%, 90%, 100%, and the hint at the right, there from the start whatever the size. */
export async function checkBar({ bp }: Scene): Promise<string[]> {
  const waited = await settled(bp, 1);
  if (waited) return [`mermaid-bar: ${waited}`];
  const block = bp.$<HTMLElement>("#item-detail .mermaid-block")!, bar = block.querySelector<HTMLElement>(".mermaid-tools");
  if (!bar) return ["mermaid-bar: the diagram has no toolbar"];
  const name = (e: Element) => e.getAttribute("aria-label") ?? (e.classList.contains("mermaid-percent") ? "size" : e.classList.contains("mermaid-hint") ? "hint" : "?");
  const items = [...bar.children], names = items.map(name), v: string[] = [];
  if (names.join() !== "缩小,size,放大,适应宽度,60%,90%,100%,hint") v.push(`mermaid-bar: the toolbar reads, left to right, ${names.join(", ")}; expected 缩小, size, 放大, 适应宽度, 60%, 90%, 100%, hint`);
  else {
    const size = items[1]!, hint = items[7]!;
    if (!/^\d+%$/.test(text(size))) v.push(`mermaid-bar: the size reads ${JSON.stringify(text(size))}, not a percentage`);
    if (text(hint) !== HINT) v.push(`mermaid-bar: the hint reads ${JSON.stringify(text(hint))}, expected ${JSON.stringify(HINT)}`);
    if (!bp.shown(hint)) v.push("mermaid-bar: the hint is not shown");
    // The hint is pushed to the right end of the toolbar, a row of flex items, by its auto left margin.
    if (css(bp, bar, "display") !== "flex" || css(bp, hint, "margin-left") !== "auto") v.push(`mermaid-bar: the hint is not at the right: the toolbar is ${css(bp, bar, "display")}, the hint's left margin ${css(bp, hint, "margin-left")}`);
  }
  const border = css(bp, block, "border") ?? "";
  if (!/^\s*[1-9][\d.]*px\s+(solid|dashed)/.test(border)) v.push(`mermaid-bar: the block has no frame (border ${JSON.stringify(border)})`);
  const view = block.querySelector(".mermaid-view")!;
  if (bar.parentElement !== block) v.push("mermaid-bar: the toolbar is not inside the frame of the block");
  else if (!(bar.compareDocumentPosition(view) & bp.win.Node.DOCUMENT_POSITION_FOLLOWING)) v.push("mermaid-bar: the toolbar is not above the diagram: it comes after it in the frame");
  return v;
}

/** The rule of the page's stylesheet with this selector. */
function rule(bp: DomPage, selector: string): CSSStyleDeclaration | undefined {
  for (const sheet of bp.doc.styleSheets as unknown as Iterable<CSSStyleSheet>) for (const r of sheet.cssRules as unknown as Iterable<CSSStyleRule>) if (r.selectorText === selector) return r.style;
  return undefined;
}
/** A colour the stylesheet gives as `var(--name)` or as a literal, in the scheme the Styles answers for. */
function colorOf(bp: DomPage, value: string, scheme: "light" | "dark"): Rgba | null {
  const v = /^var\((--[\w-]+)\)$/.exec(value.trim());
  const resolved = v ? new Styles(bp.win, { scheme }).value(bp.doc.documentElement, v[1]!) : value;
  try { return resolved ? parseColor(resolved) : null; } catch { return null; }
}

/** An enlarged diagram says it can be moved: a scroll bar that stays, the grabbing hand, a word in the bar, a shade at the edge that has more. The bar and the scroll bar read in both color schemes (4.5:1 for the words, 3:1 for the bar against its track). */
export async function checkPan({ bp }: Scene): Promise<string[]> {
  const waited = await settled(bp, 1);
  if (waited) return [`mermaid-pan: ${waited}`];
  if (!buttons(bp).includes("放大")) return ["mermaid-pan: the diagram has no 放大 button"];
  for (let i = 0; i < 4; i++) press(bp, "放大");
  const v: string[] = [], fig = bp.$<HTMLElement>("#item-detail .mermaid-fig")!, block = fig.closest<HTMLElement>(".mermaid-block")!;
  const hint = block.querySelector<HTMLElement>(".mermaid-hint");
  if (block.dataset.pan !== "yes") return [`witness setup: the enlarged diagram does not say it can be dragged (${block.dataset.pan})`];
  const cursor = css(bp, fig, "cursor");
  if (cursor !== "grab") v.push(`mermaid-pan: a diagram that can be dragged shows the cursor ${cursor}, not grab`);
  const bar = parseFloat(rule(bp, ".mermaid-fig::-webkit-scrollbar")?.height ?? "");
  if (!(bar >= 8)) v.push(`mermaid-pan: the box of a diagram that can be dragged has no scroll bar of its own, and the system's hides itself when idle (the bar is ${bar} px high)`);
  if (!hint || css(bp, hint, "display") === "none" || !text(hint)) v.push("mermaid-pan: the toolbar of a diagram that can be dragged does not say so");
  // A shade at the edge that has more: along the whole diagram, so it shows however far down the scroll bar is.
  const view = block.querySelector(".mermaid-view")!;
  const shade = (pseudo: "before" | "after") => { const content = css(bp, view, "content", pseudo), width = parseFloat(css(bp, view, "width", pseudo) ?? ""); return content !== undefined && content !== "none" && content !== "normal" && width >= 8; };
  const shades = () => ({ more: block.dataset.more ?? "", left: shade("before"), right: shade("after") });
  fig.scrollLeft = 0;
  const atStart = shades();
  if (!atStart.more.includes("right") || !atStart.right || atStart.left) v.push(`mermaid-pan: an enlarged diagram at its left edge does not show a shade on its right alone (more: "${atStart.more}", shade left ${atStart.left}, right ${atStart.right})`);
  fig.scrollLeft = fig.scrollWidth;
  const atEnd = shades();
  if (atEnd.more !== "left" || !atEnd.left || atEnd.right) v.push(`mermaid-pan: an enlarged diagram at its right edge does not show a shade on its left alone (more: "${atEnd.more}", shade left ${atEnd.left}, right ${atEnd.right})`);
  fig.scrollLeft = 0;
  for (const scheme of ["light", "dark"] as const) {
    const what = `mermaid-pan (${scheme})`, st = new Styles(bp.win, { scheme });
    const toolbar = block.querySelector<HTMLElement>(".mermaid-tools")!, button = toolbar.querySelector("button")!, size = toolbar.querySelector(".mermaid-percent")!;
    const paint = (e: Element, prop: string): Rgba | null => { const value = st.value(e, prop); try { return value === undefined ? null : parseColor(value); } catch { return null; } };
    const ground = paint(toolbar, "background-color");
    if (!ground) { v.push(`${what}: the toolbar has no background to read the words against`); continue; }
    const read = (e: Element | null, label: string, minimum: number) => {
      const ink = e ? paint(e, "color") : null;
      if (!ink) { v.push(`${what}: ${label} has no color`); return; }
      const ratio = contrast(over(ink, ground), ground);
      if (ratio < minimum) v.push(`${what}: ${label} reads ${ratio.toFixed(2)}:1 on the toolbar`);
    };
    read(button, "the words on the buttons", 4.5);
    read(size, "the size", 4.5);
    read(hint, "the hint", 4.5);
    const thumb = colorOf(bp, rule(bp, ".mermaid-fig::-webkit-scrollbar-thumb")?.getPropertyValue("background") ?? "", scheme), track = colorOf(bp, rule(bp, ".mermaid-fig::-webkit-scrollbar-track")?.getPropertyValue("background") ?? "", scheme);
    if (!thumb || !track) v.push(`${what}: the scroll bar has no colors to read`);
    else {
      const ratio = contrast(thumb, track);
      if (ratio < 3) v.push(`${what}: the scroll bar reads ${ratio.toFixed(2)}:1 against its track`);
    }
  }
  return v;
}

/** A live update repaints the item. A diagram whose source is the same keeps its zoom and its box's scroll (and, in a browser, the page's: test/e2e); one whose source changed starts at the default size. */
export async function checkKeep({ bp, board, id }: Scene): Promise<string[]> {
  const waited = await settled(bp, 1);
  if (waited) return [`mermaid-keep: ${waited}`];
  if (!buttons(bp).includes("放大")) return ["mermaid-keep: the diagram has no 放大 button"];
  for (let i = 0; i < 3; i++) press(bp, "放大");
  // A view worth keeping: enlarged, and sideways in the box.
  const fig = bp.$<HTMLElement>("#item-detail .mermaid-fig")!;
  fig.scrollLeft = 150;
  const old = fig.closest(".mermaid-block")!, before = firstFigure(bp), v: string[] = [];
  if (before.scrollLeft < 100) v.push(`witness setup: the view to keep is ${round(before.scrollLeft)} px sideways`);
  const base = bp.changes();
  await setHead(board, id, fence(PIPELINE) + "\n\n后面加了一段。");
  await bp.waitChanges(base + 1);
  if (old.isConnected) v.push("witness setup: the live update did not repaint the item");
  const same = await settled(bp, 1);
  if (same) return [...v, `mermaid-keep: after the live update, ${same}`];
  const after = firstFigure(bp);
  if (Math.abs(after.drawn - before.drawn) > 1) v.push(`mermaid-keep: after a live update that left its source alone the diagram is ${round(after.drawn)} px wide, from ${round(before.drawn)} px`);
  if (Math.abs(after.scrollLeft - before.scrollLeft) > 1) v.push(`mermaid-keep: after a live update that left its source alone the diagram's box is scrolled ${round(after.scrollLeft)} px, from ${round(before.scrollLeft)} px`);
  await setHead(board, id, fence(PIPELINE + '\n  N28 --> N29["29 新加的一步"]') + "\n\n后面加了一段。");
  await bp.waitChanges(base + 2);
  const changed = await settled(bp, 1);
  if (changed) return [...v, `mermaid-keep: after the source changed, ${changed}`];
  const fresh = firstFigure(bp);
  if (Math.abs(fresh.drawn - Math.min(fresh.natural, fresh.box)) > 1 || fresh.scrollLeft !== 0 || fresh.pan !== "no") {
    v.push(`mermaid-keep: a diagram whose source changed is ${round(fresh.drawn)} px wide, scrolled ${round(fresh.scrollLeft)} px, dragging ${fresh.pan === "yes" ? "on" : "off"}; it should start at its default size, ${round(Math.min(fresh.natural, fresh.box))} px`);
  }
  return v;
}
