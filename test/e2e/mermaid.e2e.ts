// What only a real browser and the real diagram library show of the mermaid blocks on the owner's page (web/mermaid.ts), in headless
// Chromium against the real server. The page's own doing with a block (its states, errors, toolbar, zoom arithmetic, drag, theme, laziness,
// repaint, ids and the stylesheet rules it relies on) is checked in a DOM library against a stand-in for the library
// (test/dom/mermaid-page.test.ts, mermaid-view.test.ts). Here: the real library draws a diagram with its Chinese labels and a size, a block that
// does not parse shows the library's error and leaves the rest alone; the library's strict security level leaves nothing of a hostile text
// that runs; a diagram drawn twice has no id twice and the visible copy's line markers are its own, which depends on how the real library
// names its ids; the settings in a diagram's own frontmatter win over the page's, which the real library applies; a diagram is as wide as
// itself or its box, whichever is less, at two window widths, with nothing to scroll sideways in the box or the page; the buttons and Ctrl
// with the wheel zoom, the plain wheel scrolls the page and nothing else, an enlarged diagram can be scrolled to both its ends and dragged,
// and 适应宽度 restores the default size; the 60%, 90% and 100% buttons draw a diagram wider than a narrow box at that share of its size;
// a diagram keeps its zoom, its sideways scroll and the page's scroll through a live update that leaves its source alone; labels and lines
// read in both color schemes. Where a check also runs on a page with one part taken out (an edit applied while the page is bundled), it must
// report the part's absence for the reason the check protects. A diagram that never appears can only be observed by waiting, so the wait
// is short (GIVE_UP) and the reported line must say what was waited for and what the page held; a bare timeout, or a page that did not
// start, is not a catch.
// Run by CI's e2e job (npm run test:e2e), not on the owner's Mac.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { Plugin } from "esbuild";
import { ops } from "../../src/ops.ts";
import { startBoard, launch, BoardPage, ROOT } from "./harness.ts";
import type { BoardServer } from "./harness.ts";
import { PIPELINE, GOOD, BAD, HEAD, OWN } from "./mermaid-charts.ts";
import { fence, setHead, settled, round, figures, checkFit, FIT_HEAD } from "./mermaid-checks.ts";
import type { Figure } from "./mermaid-checks.ts";

type Hooks = Parameters<typeof startBoard>[0];

// Labels and links that would run script if the library let them: a label with an image whose load fails, a label with a script
// element, a link to a javascript: address and a click that calls a function of the page.
const HOSTILE = [
  "flowchart LR",
  '  A["点<img src=x onerror=window.__xss=1>"] --> B["<script>window.__xss=2</script>危险"]',
  '  click A href "javascript:window.__xss=3"',
  "  click B call __probe()",
].join("\n");

/** How long a check waits for diagrams on a page that must draw them, and on a page where it expects them not to appear. */
const WAIT = 60_000, GIVE_UP = 8_000;

async function addLog(board: BoardServer, id: string, text: string) {
  const it = board.store.snapshot().items[id]!;
  await ops(board.store).appendLog({ author: it.group, id, text });
}

interface Edit { file: string; find: string; replace: string }
/** A page directory serving the current page with `edits` applied to web/index.html and to the sources of web/ while they are bundled; the library is the built one. */
async function variantPage(t: Hooks, edits: Edit[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-mermaid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "dist"));
  const applied = new Set<Edit>();
  const once = (text: string, edit: Edit) => {
    if (text.split(edit.find).length !== 2) throw new Error(`${edit.file} no longer holds ${JSON.stringify(edit.find)} exactly once; update this variant`);
    applied.add(edit);
    return text.replace(edit.find, () => edit.replace);
  };
  let html = await readFile(join(ROOT, "web/index.html"), "utf8");
  for (const edit of edits) if (edit.file === "index.html") html = once(html, edit);
  await writeFile(join(dir, "index.html"), html);
  await symlink(join(ROOT, "web/dist/mermaid.js"), join(dir, "dist/mermaid.js"));
  const plugin: Plugin = {
    name: "edit",
    setup(b) {
      b.onLoad({ filter: /[\\/]web[\\/][\w-]+\.ts$/ }, async args => {
        let text = await readFile(args.path, "utf8");
        for (const edit of edits) if (args.path.endsWith("/" + edit.file)) text = once(text, edit);
        return { contents: text, loader: "ts" };
      });
    },
  };
  // The same options as the build:web script.
  await build({ entryPoints: [join(ROOT, "web/app.ts")], bundle: true, format: "esm", target: "es2022", outfile: join(dir, "dist/app.js"), plugins: [plugin], logLevel: "silent" });
  assert.equal(applied.size, edits.length, "every edit of the variant was applied");
  return dir;
}

/** A board whose item `witness.code` has been written by `seed`, served from the current page or from a variant of it, and a browser page open on it with that item selected. */
async function open(t: Hooks, seed: (board: BoardServer, id: string) => Promise<void>, edits: Edit[] = []) {
  const board = await startBoard(t, edits.length ? { webDir: await variantPage(t, edits) } : {}), browser = await launch(t), id = board.gen.witness.code;
  await seed(board, id);
  const bp = await BoardPage.open(browser, board);
  await bp.select(id);
  return { bp, board, id };
}

/** The head's blocks: a good one is a diagram in place of its code, with its Chinese labels; the bad one shows its source and the error; the one after it and the code block after that are untouched. */
async function checkHead(bp: BoardPage, wait: number): Promise<string[]> {
  const waited = await settled(bp, 3, wait);
  if (waited) return [`mermaid-head: ${waited}`, ...(await shownAsCode(bp, "#item-detail") ? ["mermaid-head: the head's diagram source is shown as plain code"] : [])];
  const v: string[] = [];
  const got = await bp.page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#item-detail .mermaid-block")].map(b => {
    const fig = b.querySelector<HTMLElement>(".mermaid-fig"), pre = b.querySelector("pre.code"), err = b.querySelector(".mermaid-err");
    return {
      state: b.dataset.state, svg: !!fig?.querySelector("svg"), label: fig?.querySelector("svg")?.textContent ?? "", width: fig?.getBoundingClientRect().width ?? 0, height: fig?.getBoundingClientRect().height ?? 0,
      code: pre?.textContent ?? "", codeShown: !!pre && getComputedStyle(pre).display !== "none", err: err?.textContent ?? null,
    };
  }));
  const [good, bad, sequence] = got;
  if (!good || good.state !== "done" || !good.svg) v.push(`mermaid-head: the good block is ${good?.state ?? "missing"}, not a drawn diagram`);
  else {
    for (const word of ["需求", "设计", "实现"]) if (!good.label.includes(word)) v.push(`mermaid-head: the diagram lacks the label ${word}; its text is ${JSON.stringify(good.label)}`);
    if (good.height < 40 || good.width < 40) v.push(`mermaid-head: the diagram is ${good.width}x${good.height}px`);
    if (good.codeShown) v.push("mermaid-head: the code still shows beside the drawn diagram");
  }
  if (!bad || bad.state !== "error") v.push(`mermaid-head: the bad block is ${bad?.state ?? "missing"}, not an error`);
  else {
    if (bad.svg) v.push("mermaid-head: the bad block has a diagram");
    if (!bad.codeShown || bad.code !== BAD) v.push(`mermaid-head: the bad block does not show its source: ${JSON.stringify(bad.code)}`);
    if (!bad.err?.startsWith("图画不出来：") || bad.err.length < 12) v.push(`mermaid-head: the bad block shows no error: ${JSON.stringify(bad.err)}`);
  }
  if (!sequence || sequence.state !== "done" || !sequence.svg || !sequence.label.includes("参与者甲")) v.push(`mermaid-head: the block after the bad one is ${sequence?.state ?? "missing"}, not a drawn diagram with its labels`);
  const rest = await bp.page.evaluate(() => ({
    wf: [...document.querySelectorAll("#item-detail pre.code")].filter(p => !p.closest(".mermaid-block")).map(p => p.textContent),
    stray: document.querySelectorAll('[id^="dmermaid-"]').length,
  }));
  if (!rest.wf.includes("fn main() {}")) v.push("mermaid-head: the code block after the diagrams is not shown as code");
  if (rest.stray) v.push(`mermaid-head: ${rest.stray} half-drawn diagrams were left in the page`);
  return v;
}

/** Whether the page shows the source of GOOD as an ordinary code block under `scope`: the part a page without the wrapper still has. */
const shownAsCode = (bp: BoardPage, scope: string) => bp.page.evaluate(scope => [...document.querySelectorAll(scope + " pre.code")].some(p => !p.closest(".mermaid-block") && p.textContent?.includes("A[需求] --> B[设计]")), scope);

/** The text of a diagram never runs: nothing it holds is an event handler, a script or a javascript: address, and nothing it asked for ran. */
async function checkStrict(bp: BoardPage, wait: number): Promise<string[]> {
  const waited = await settled(bp, 1, wait);
  if (waited) return [`mermaid-strict: ${waited}`];
  await bp.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 800)));
  const got = await bp.page.evaluate(() => {
    const fig = document.querySelector("#item-detail .mermaid-fig");
    const all = fig ? [...fig.querySelectorAll("*")] : [];
    return {
      drawn: !!fig?.querySelector("svg"),
      handlers: all.flatMap(e => e.getAttributeNames().filter(n => n.startsWith("on")).map(n => e.tagName + "@" + n)),
      scripts: all.filter(e => e.tagName.toLowerCase() === "script").length,
      urls: all.flatMap(e => e.getAttributeNames().filter(n => /href/.test(n)).map(n => e.getAttribute(n)!)).filter(u => /^\s*javascript:/i.test(u)),
      ran: (window as unknown as { __xss?: unknown }).__xss ?? null,
    };
  });
  const v: string[] = [];
  if (!got.drawn) v.push("mermaid-strict: the diagram with hostile text was not drawn");
  if (got.handlers.length) v.push(`mermaid-strict: event handlers in the diagram: ${got.handlers.join(", ")}`);
  if (got.scripts) v.push(`mermaid-strict: ${got.scripts} script elements in the diagram`);
  if (got.urls.length) v.push(`mermaid-strict: javascript: addresses in the diagram: ${got.urls.join(", ")}`);
  if (got.ran !== null) v.push(`mermaid-strict: the text of the diagram ran (window.__xss = ${String(got.ran)})`);
  return v;
}

/** The same diagram drawn twice in one page, its first copy in a folded section (the head's 参考 section) and its second in the log opened after: no id is in the page twice, and each line marker a visible diagram points at is in that diagram, not in the hidden copy. */
async function checkIds(bp: BoardPage, wait: number): Promise<string[]> {
  const first = await settled(bp, 1, wait);
  if (first) return [`mermaid-ids: ${first}`];
  await bp.page.locator("#item-detail .log-toggle").click();
  const waited = await settled(bp, 2, wait);
  if (waited) return [`mermaid-ids: ${waited}`];
  const got = await bp.page.evaluate(() => {
    const figs = [...document.querySelectorAll<HTMLElement>("#item-detail .mermaid-fig")];
    const ids = figs.flatMap(f => [...f.querySelectorAll("[id]")].map(e => e.id));
    // The content of a folded section has boxes in current Chromium (it is skipped, not removed), so offsetParent cannot tell it apart.
    const shown = figs.filter(f => !f.closest("details:not([open])"));
    // The markers (arrowheads) the visible diagram's lines point at, and whether each is inside it.
    const foreign: string[] = [];
    let markers = 0;
    for (const f of shown) for (const e of f.querySelectorAll("[marker-end], [marker-start]")) {
      for (const attribute of ["marker-end", "marker-start"]) {
        const target = /url\(["']?#([^"')]+)/.exec(e.getAttribute(attribute) ?? "")?.[1];
        if (target === undefined) continue;
        markers++;
        if (!f.contains(document.getElementById(target))) foreign.push(target);
      }
    }
    return { figs: figs.length, shown: shown.length, ids, markers, foreign };
  });
  const v: string[] = [];
  if (got.figs !== 2 || got.shown !== 1) v.push(`witness setup: ${got.figs} diagrams, ${got.shown} of them visible; expected 2 and 1 (the first in a folded section)`);
  const twice = [...new Set(got.ids.filter((id, i) => got.ids.indexOf(id) !== i))];
  if (twice.length) v.push(`mermaid-ids: ${twice.length} ids are in the page twice, such as ${twice[0]}`);
  if (!got.ids.length) v.push("mermaid-ids: the diagrams have no ids at all, so the check saw nothing");
  if (!got.markers) v.push("witness setup: the visible diagram has no line markers to check");
  if (got.foreign.length) v.push(`mermaid-ids: the visible diagram's lines point at markers outside it: ${got.foreign.join(", ")}`);
  return v;
}

/** What the page does at one click of the enlarge button (web/mermaid.ts, STEP). */
const STEP = 1.25;

const firstFigure = async (bp: BoardPage) => (await figures(bp)).figs[0]!;
/** The page's vertical scroll position above the first diagram: the sum over everything that scrolls it, whichever that is. */
const scrollProbe = (bp: BoardPage) => bp.page.evaluate(() => {
  Object.assign(window, {
    __pageScroll: () => { let sum = document.scrollingElement?.scrollTop ?? 0; for (let e = document.querySelector("#item-detail .mermaid-fig")!.parentElement; e; e = e.parentElement) if (e !== document.documentElement) sum += e.scrollTop; return sum; },
  });
});
const pageScroll = (bp: BoardPage) => bp.page.evaluate(() => (window as unknown as { __pageScroll(): number }).__pageScroll());
/** Waits until the page's scroll position is not `from`; false when it stays. */
const scrolledFrom = (bp: BoardPage, from: number) => bp.page.waitForFunction(from => (window as unknown as { __pageScroll(): number }).__pageScroll() !== from, from, { timeout: 3_000 }).then(() => true, () => false);
/** Waits until the first diagram is drawn wider than `from` px; false when it stays. */
const widerThan = (bp: BoardPage, from: number) => bp.page.waitForFunction(from => document.querySelector("#item-detail .mermaid-fig svg")!.getBoundingClientRect().width > from, from, { timeout: 3_000 }).then(() => true, () => false);
/** The middle of the part of the first diagram's box that is on the screen. */
const middle = (bp: BoardPage) => bp.page.evaluate(() => {
  const b = document.querySelector("#item-detail .mermaid-fig")!.getBoundingClientRect(), top = Math.max(b.top, 0), bottom = Math.min(b.bottom, innerHeight);
  return { x: b.left + b.width / 2, y: top < bottom ? (top + bottom) / 2 : b.top };
});
const press = (bp: BoardPage, label: string) => bp.page.locator(`#item-detail .mermaid-tools button[aria-label="${label}"]`).first().click();
const buttons = (bp: BoardPage) => bp.page.locator("#item-detail .mermaid-tools button").evaluateAll(bs => bs.map(b => b.getAttribute("aria-label") ?? ""));
/** Scrolls the page until the first diagram's box starts at the top of what scrolls. */
const alignTop = (bp: BoardPage) => bp.page.evaluate(() => document.querySelector("#item-detail .mermaid-fig")!.scrollIntoView({ block: "start" }));

/** A diagram brings its own settings in a frontmatter block at its start, and they win over the page's: this one asks for the library's
 * dark theme on a page that shows the light colors, and its boxes are dark. */
async function checkOwn(bp: BoardPage, wait: number): Promise<string[]> {
  const waited = await settled(bp, 1, wait);
  if (waited) return [`mermaid-own: ${waited}`];
  const fill = await bp.page.evaluate(() => {
    const shape = document.querySelector("#item-detail .mermaid-fig .node rect, #item-detail .mermaid-fig .node polygon, #item-detail .mermaid-fig .node path");
    return shape ? getComputedStyle(shape).fill : "";
  });
  const m = fill.match(/\d+/g)?.map(Number);
  if (!m) return [`mermaid-own: the diagram has no box to read the color of (fill ${JSON.stringify(fill)})`];
  return (m[0]! + m[1]! + m[2]!) / 3 < 140 ? [] : [`mermaid-own: the diagram asks for the dark theme in its frontmatter and the page does not use it: its boxes are filled ${fill} on a light page`];
}

/** What the toolbar says about the size of the first diagram, against how large the diagram is drawn as a share of its own width; null when they agree. */
async function percentIssue(bp: BoardPage, f: Figure): Promise<string | null> {
  const text = await bp.page.locator("#item-detail .mermaid-percent").first().textContent(), want = f.drawn / f.natural * 100;
  return text !== null && /^\d+%$/.test(text) && Math.abs(parseInt(text) - want) <= 1 ? null : `mermaid-zoom: the toolbar says ${JSON.stringify(text)} for a diagram drawn at ${want.toFixed(1)}% of its own width`;
}

/** The toolbar buttons zoom by a step and show the size in percent, Ctrl and the wheel zoom about the cursor, the plain wheel scrolls the page
 * and neither zooms nor scrolls the diagram, a zoomed diagram can be scrolled to both its ends and dragged, and fit to width gives the default size back. */
async function checkZoom(bp: BoardPage, wait: number): Promise<string[]> {
  const waited = await settled(bp, 1, wait);
  if (waited) return [`mermaid-zoom: ${waited}`];
  const have = await buttons(bp), v: string[] = [];
  for (const need of ["缩小", "放大", "适应宽度"]) if (!have.includes(need)) v.push(`mermaid-zoom: the diagram has no ${need} button; its buttons are ${have.join(", ") || "none"}`);
  if (v.length) return v;
  await scrollProbe(bp);
  const start = await firstFigure(bp);
  const shown = async (f: Figure) => { const issue = await percentIssue(bp, f); if (issue) v.push(issue); };
  await shown(start);
  await press(bp, "放大");
  const once = await firstFigure(bp);
  await shown(once);
  if (Math.abs(once.drawn - start.drawn * STEP) > 2) v.push(`mermaid-zoom: the enlarge button took the diagram from ${round(start.drawn)} to ${round(once.drawn)} px wide, not by ${STEP}`);
  await press(bp, "缩小");
  const back = await firstFigure(bp);
  if (Math.abs(back.drawn - start.drawn) > 2) v.push(`mermaid-zoom: enlarging and then shrinking left the diagram ${round(back.drawn)} px wide, from ${round(start.drawn)} px`);
  for (let i = 0; i < 4; i++) await press(bp, "放大");
  const big = await firstFigure(bp);
  await shown(big);
  if (Math.abs(big.drawn - start.drawn * STEP ** 4) > start.drawn * 0.02) v.push(`mermaid-zoom: four steps up took the diagram from ${round(start.drawn)} to ${round(big.drawn)} px wide, expected ${round(start.drawn * STEP ** 4)}`);
  if (big.scroll <= big.box + 1) v.push(`witness setup: the enlarged diagram is ${round(big.drawn)} px wide and still fits its box of ${big.box} px`);
  else {
    if (!/auto|scroll/.test(big.overflowX)) v.push(`mermaid-zoom: the enlarged diagram's box does not scroll sideways (overflow-x ${big.overflowX})`);
    if (big.pan !== "yes") v.push(`mermaid-zoom: the enlarged diagram is wider than its box (${big.scroll} px in ${big.box} px) but does not say it can be dragged`);
  }
  // Both ends of the enlarged diagram can be brought into its box.
  const ends = await bp.page.evaluate(() => {
    const f = document.querySelector<HTMLElement>("#item-detail .mermaid-fig")!, svg = f.querySelector("svg")!;
    f.scrollLeft = 0;
    const left = svg.getBoundingClientRect().left - f.getBoundingClientRect().left;
    f.scrollLeft = f.scrollWidth;
    const right = f.getBoundingClientRect().right - svg.getBoundingClientRect().right;
    return { left, right };
  });
  if (ends.left < -1) v.push(`mermaid-zoom: the left end of the enlarged diagram cannot be scrolled into its box (${round(ends.left)} px outside)`);
  if (ends.right < -1) v.push(`mermaid-zoom: the right end of the enlarged diagram cannot be scrolled into its box (${round(-ends.right)} px outside)`);

  // Ctrl and the wheel zoom, and the point under the cursor stays under it.
  await bp.page.evaluate(() => { const f = document.querySelector<HTMLElement>("#item-detail .mermaid-fig")!; f.scrollLeft = (f.scrollWidth - f.clientWidth) / 2; });
  await alignTop(bp);
  const at = await middle(bp), pre = await firstFigure(bp);
  await bp.page.mouse.move(at.x, at.y);
  await bp.page.keyboard.down("Control");
  await bp.page.mouse.wheel(0, -100);
  await bp.page.keyboard.up("Control");
  if (!await widerThan(bp, pre.drawn + 5)) v.push("mermaid-zoom: Ctrl and the wheel did not enlarge the diagram");
  else {
    const post = await firstFigure(bp);
    const x = [(at.x - pre.left) / pre.drawn, (at.x - post.left) / post.drawn], y = [(at.y - pre.top) / pre.drawnHeight, (at.y - post.top) / post.drawnHeight];
    if (Math.abs(x[0]! - x[1]!) > 0.01 || Math.abs(y[0]! - y[1]!) > 0.01) v.push(`mermaid-zoom: Ctrl and the wheel moved the point under the cursor from (${x[0]!.toFixed(3)}, ${y[0]!.toFixed(3)}) to (${x[1]!.toFixed(3)}, ${y[1]!.toFixed(3)}) of the diagram`);
  }

  // The plain wheel scrolls the page, nothing else.
  await alignTop(bp);
  const w0 = await firstFigure(bp), p0 = await pageScroll(bp), over = await middle(bp);
  await bp.page.mouse.move(over.x, over.y);
  await bp.page.mouse.wheel(0, 300);
  const moved = await scrolledFrom(bp, p0), w1 = await firstFigure(bp), p1 = await pageScroll(bp);
  if (!moved || p1 <= p0 + 20) v.push(`mermaid-zoom: the plain wheel over the diagram did not scroll the page (it moved ${round(p1 - p0)} px)`);
  if (Math.abs(w1.drawn - w0.drawn) > 1) v.push(`mermaid-zoom: the plain wheel over the diagram zoomed it, from ${round(w0.drawn)} to ${round(w1.drawn)} px wide`);
  if (Math.abs(w1.scrollLeft - w0.scrollLeft) > 1) v.push(`mermaid-zoom: the plain wheel over the diagram scrolled its box sideways by ${round(w1.scrollLeft - w0.scrollLeft)} px`);

  // A mouse drags the diagram: sideways inside its box, up and down along the page.
  await alignTop(bp);
  await bp.page.evaluate(() => { document.querySelector<HTMLElement>("#item-detail .mermaid-fig")!.scrollLeft = 200; });
  const d0 = await firstFigure(bp), q0 = await pageScroll(bp), grab = await middle(bp);
  await bp.page.mouse.move(grab.x, grab.y);
  await bp.page.mouse.down();
  await bp.page.mouse.move(grab.x - 120, grab.y - 80, { steps: 8 });
  await bp.page.mouse.up();
  const d1 = await firstFigure(bp), q1 = await pageScroll(bp);
  if (Math.abs(d1.scrollLeft - d0.scrollLeft - 120) > 3) v.push(`mermaid-zoom: dragging the enlarged diagram 120 px to the left moved its box ${round(d1.scrollLeft - d0.scrollLeft)} px`);
  if (Math.abs(q1 - q0 - 80) > 3) v.push(`mermaid-zoom: dragging the enlarged diagram 80 px up moved the page ${round(q1 - q0)} px`);

  await press(bp, "适应宽度");
  const end = await firstFigure(bp);
  await shown(end);
  if (Math.abs(end.drawn - start.drawn) > 2 || end.scrollLeft !== 0 || end.pan !== "no") v.push(`mermaid-zoom: after 适应宽度 the diagram is ${round(end.drawn)} px wide, scrolled ${round(end.scrollLeft)} px, dragging ${end.pan === "yes" ? "on" : "off"}; it was ${round(start.drawn)} px, 0 and off at the start`);
  const page = (await figures(bp)).page;
  if (page[0] > page[1] + 1) v.push(`mermaid-zoom: the page scrolls sideways: it is ${page[0]} px wide in a window of ${page[1]} px`);
  return v;
}

/** The 60%, 90% and 100% buttons draw a diagram wider than its box at that share of its own size, the one shown is pressed, and at 100% its
 * box scrolls sideways to both ends and the page does not; pressed again, the button gives the width of the box back. */
async function checkActual(bp: BoardPage, wait: number): Promise<string[]> {
  const waited = await settled(bp, 1, wait);
  if (waited) return [`mermaid-actual: ${waited}`];
  const have = await buttons(bp);
  for (const need of ["60%", "90%", "100%"]) if (!have.includes(need)) return [`mermaid-actual: the diagram has no ${need} button; its buttons are ${have.join(", ") || "none"}`];
  const v: string[] = [];
  const start = await firstFigure(bp);
  if (start.natural <= start.box) return [`witness setup: the diagram is ${round(start.natural)} px wide and fits its box of ${start.box} px`];
  const pressed = () => bp.page.locator('#item-detail .mermaid-tools button[aria-pressed="true"]').evaluateAll(bs => bs.map(b => b.getAttribute("aria-label")));
  for (const [label, share] of [["60%", 0.6], ["90%", 0.9]] as const) {
    await press(bp, label);
    const f = await firstFigure(bp);
    if (Math.abs(f.drawn - f.natural * share) > 2) v.push(`mermaid-actual: the ${label} button draws the diagram ${round(f.drawn)} px wide, not ${round(f.natural * share)} px`);
    const on = await pressed();
    if (on.join() !== label) v.push(`mermaid-actual: with ${label} shown the pressed buttons are ${on.join(", ") || "none"}`);
  }
  await press(bp, "100%");
  const actual = await firstFigure(bp);
  if (Math.abs(actual.drawn - actual.natural) > 2) v.push(`mermaid-actual: the 100% button draws the diagram ${round(actual.drawn)} px wide, not its own ${round(actual.natural)} px`);
  if (actual.scroll <= actual.box + 1) v.push(`mermaid-actual: at its own size the diagram fits its box of ${actual.box} px`);
  else {
    if (!/auto|scroll/.test(actual.overflowX)) v.push(`mermaid-actual: the box does not scroll sideways (overflow-x ${actual.overflowX})`);
    const reach = await bp.page.evaluate(() => {
      const f = document.querySelector<HTMLElement>("#item-detail .mermaid-fig")!;
      f.scrollLeft = 1e6;
      const right = f.scrollLeft, end = f.scrollWidth - f.clientWidth;
      f.scrollLeft = 0;
      return { right, end };
    });
    if (reach.right < reach.end - 1) v.push(`mermaid-actual: the right end of the diagram cannot be scrolled into its box (reached ${round(reach.right)} of ${round(reach.end)} px)`);
  }
  const page = (await figures(bp)).page;
  if (page[0] > page[1] + 1) v.push(`mermaid-actual: the page scrolls sideways at the diagram's own size (${page[0]} px wide in ${page[1]} px)`);
  const issue = await percentIssue(bp, actual);
  if (issue) v.push(issue);
  await press(bp, "100%");
  const back = await firstFigure(bp);
  if (Math.abs(back.drawn - start.drawn) > 2) v.push(`mermaid-actual: pressed again, 100% leaves the diagram ${round(back.drawn)} px wide, not the width of the box, ${round(start.drawn)} px`);
  return v;
}

/** A live update repaints the item. A diagram whose source is the same keeps its zoom, its box's scroll and the page's scroll; one whose
 * source changed starts at the default size. */
async function checkKeep(bp: BoardPage, board: BoardServer, id: string, wait: number): Promise<string[]> {
  const first = await settled(bp, 1, wait);
  if (first) return [`mermaid-keep: ${first}`];
  if (!(await buttons(bp)).includes("放大")) return ["mermaid-keep: the diagram has no 放大 button"];
  await scrollProbe(bp);
  for (let i = 0; i < 3; i++) await press(bp, "放大");
  // A view worth keeping: sideways in the box, and far down the page, where a short stand-in for the diagram would cut the scroll short.
  await bp.page.evaluate(() => {
    const f = document.querySelector<HTMLElement>("#item-detail .mermaid-fig")!;
    f.scrollLeft = 150;
    f.scrollIntoView({ block: "end" });
    (window as unknown as { __old: Element }).__old = f.closest(".mermaid-block")!;
  });
  const before = await firstFigure(bp), at = await pageScroll(bp);
  const v: string[] = [];
  if (before.scrollLeft < 100 || at < 100) v.push(`witness setup: the view to keep is ${round(before.scrollLeft)} px sideways and ${round(at)} px down`);
  const base = await bp.changes();
  await setHead(board, id, fence(PIPELINE) + "\n\n后面加了一段。");
  await bp.waitChanges(base + 1);
  if (await bp.page.evaluate(() => (window as unknown as { __old: Element }).__old.isConnected)) v.push("witness setup: the live update did not repaint the item");
  const same = await settled(bp, 1, wait);
  if (same) return [...v, `mermaid-keep: after the live update, ${same}`];
  const after = await firstFigure(bp), down = await pageScroll(bp);
  if (Math.abs(after.drawn - before.drawn) > 1) v.push(`mermaid-keep: after a live update that left its source alone the diagram is ${round(after.drawn)} px wide, from ${round(before.drawn)} px`);
  if (Math.abs(after.scrollLeft - before.scrollLeft) > 1) v.push(`mermaid-keep: after a live update that left its source alone the diagram's box is scrolled ${round(after.scrollLeft)} px, from ${round(before.scrollLeft)} px`);
  if (Math.abs(down - at) > 2) v.push(`mermaid-keep: after a live update that left its source alone the page is scrolled ${round(down)} px, from ${round(at)} px`);

  await setHead(board, id, fence(PIPELINE + '\n  N28 --> N29["29 新加的一步"]') + "\n\n后面加了一段。");
  await bp.waitChanges(base + 2);
  const changed = await settled(bp, 1, wait);
  if (changed) return [...v, `mermaid-keep: after the source changed, ${changed}`];
  const fresh = await firstFigure(bp);
  if (Math.abs(fresh.drawn - Math.min(fresh.natural, fresh.box)) > 1 || fresh.scrollLeft !== 0 || fresh.pan !== "no") {
    v.push(`mermaid-keep: a diagram whose source changed is ${round(fresh.drawn)} px wide, scrolled ${round(fresh.scrollLeft)} px, dragging ${fresh.pan === "yes" ? "on" : "off"}; it should start at its default size, ${round(Math.min(fresh.natural, fresh.box))} px`);
  }
  return v;
}

/** Waits until the open diagram has the colors of `scheme`, then reads how the diagram reads: its labels against their boxes and its lines against the page behind it. */
async function colors(bp: BoardPage, scheme: "light" | "dark", what: string, wait: number): Promise<{ problem: string } | { label: number; line: number | null }> {
  const waited = await settled(bp, 1, wait);
  if (waited) return { problem: `${what}: ${waited}` };
  // A diagram drawn for the other scheme is replaced a moment after the scheme changes.
  try {
    await bp.page.waitForFunction(scheme => {
      const rect = document.querySelector("#item-detail .mermaid-fig .node rect, #item-detail .mermaid-fig .node polygon, #item-detail .mermaid-fig .node path");
      const m = rect ? getComputedStyle(rect).fill.match(/\d+/g)?.map(Number) : null;
      return !!m && ((m[0]! + m[1]! + m[2]!) / 3 > 140) === (scheme === "light");
    }, scheme, { timeout: wait });
  } catch { return { problem: `${what}: the diagram did not take the ${scheme} colors within ${wait / 1000} s` }; }
  return bp.page.evaluate(() => {
    const rgb = (c: string) => { const m = c.match(/[\d.]+/g)!.map(Number); return { r: m[0]!, g: m[1]!, b: m[2]!, a: m.length > 3 ? m[3]! : 1 }; };
    const lum = (c: { r: number; g: number; b: number }) => { const f = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const ratio = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
    const fig = document.querySelector<HTMLElement>("#item-detail .mermaid-fig")!;
    // What is behind the diagram: the first opaque background above it.
    let page = rgb(getComputedStyle(document.body).backgroundColor);
    for (let e: Element | null = fig; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.a >= 1) { page = c; break; } }
    const node = fig.querySelector(".node")!, shape = node.querySelector("rect, polygon, path")!;
    const fill = rgb(getComputedStyle(shape).fill), label = node.querySelector(".nodeLabel");
    const text = rgb(label ? getComputedStyle(label).color : getComputedStyle(node.querySelector("text")!).fill);
    const line = fig.querySelector(".flowchart-link");
    return { label: ratio(text, fill), line: line ? ratio(rgb(getComputedStyle(line).stroke), page) : null };
  });
}
function readable(what: string, got: Awaited<ReturnType<typeof colors>>): string[] {
  if ("problem" in got) return [got.problem];
  const v: string[] = [];
  if (got.label < 4.5) v.push(`${what}: the label reads ${got.label.toFixed(2)}:1 on its box`);
  if (got.line === null) v.push(`${what}: the diagram has no line`);
  else if (got.line < 3) v.push(`${what}: the lines read ${got.line.toFixed(2)}:1 on the page`);
  return v;
}

/** In each color scheme the labels read on their boxes (4.5:1) and the lines on the page (3:1); the page changing scheme redraws the open diagram. */
async function checkColors(bp: BoardPage, wait: number): Promise<string[]> {
  const v: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    await bp.page.emulateMedia({ colorScheme: scheme });
    const what = `mermaid-colors (${scheme})`;
    v.push(...readable(what, await colors(bp, scheme, what, wait)));
  }
  await bp.page.emulateMedia({ colorScheme: "light" });
  return v;
}

const none = (v: string[]) => assert.equal(v.length, 0, v.length + " violations:\n" + v.join("\n"));
/** The check must report a line that says `why`: what it waited for and what the page held, not a bare timeout. */
const caught = (v: string[], why: RegExp) => assert.ok(v.some(l => why.test(l)), `the check must report ${String(why)}; it reported:\n${v.join("\n") || "(nothing)"}`);

const seedHead = async (board: BoardServer, id: string) => setHead(board, id, HEAD);
const seedHostile = async (board: BoardServer, id: string) => setHead(board, id, fence(HOSTILE));
const seedOne = async (board: BoardServer, id: string) => setHead(board, id, fence(GOOD));
// The first copy sits in the head's 参考 section, which is folded; the second is in the log, opened after the first is drawn.
const seedTwice = async (board: BoardServer, id: string) => { await setHead(board, id, "正文。\n\n**参考：同一张图**\n" + fence(GOOD)); await addLog(board, id, "同一张图又画一次：\n\n" + fence(GOOD)); };
const seedFit = async (board: BoardServer, id: string) => setHead(board, id, FIT_HEAD);
const seedOwn = async (board: BoardServer, id: string) => setHead(board, id, fence(OWN));
const seedPipeline = async (board: BoardServer, id: string) => setHead(board, id, fence(PIPELINE));
/** The window at about the width of a phone held sideways, where the page puts the list and the detail side by side in two narrow columns. */
const NARROW = { width: 700, height: 1000 };
const narrow = async (bp: BoardPage) => { await bp.page.setViewportSize(NARROW); await bp.settle(); };
const probe = (bp: BoardPage) => bp.page.evaluate(() => { (window as unknown as { __probe: () => void }).__probe = () => { (window as unknown as { __xss: number }).__xss = 4; }; });

// The parts a variant takes out; each is the one thing a check protects.
const LOOSE: Edit = { file: "mermaid.ts", find: 'securityLevel: "strict"', replace: 'securityLevel: "loose"' };
// The box's contents centered with flex, which puts the left half of an enlarged diagram outside the box where nothing can scroll to it.
const CENTERED_FLEX: Edit[] = [
  { file: "index.html", find: ".mermaid-fig { overflow-x: auto; ", replace: ".mermaid-fig { display: flex; justify-content: center; overflow-x: auto; " },
  { file: "index.html", find: "display: block; margin-inline: auto; ", replace: "display: block; flex: none; " },
];
// The diagram out of the box's flow: the box has nothing to scroll, so the right part of an enlarged diagram cannot be brought in.
const OUT_OF_FLOW: Edit = { file: "index.html", find: "display: block; margin-inline: auto; ", replace: "position: absolute; display: block; " };
// The detail pane is repainted and its scroll restored before the diagrams are drawn again.
const LATE_DRAW: Edit = { file: "app.ts", find: "drawMermaid(pane);", replace: "" };

const LONG = { timeout: 5 * 60_000 };

test("a mermaid block in an item's head is a diagram; a bad one shows its source and the error", LONG, async t => {
  const { bp } = await open(t, seedHead);
  none(await checkHead(bp, WAIT));
});

test("the text of a diagram never runs", LONG, async t => {
  const { bp } = await open(t, seedHostile);
  await probe(bp);
  none(await checkStrict(bp, WAIT));
});
test("the same check on a page with the library's loose security level reports what the text holds or ran", LONG, async t => {
  const { bp } = await open(t, seedHostile, [LOOSE]);
  await probe(bp);
  caught(await checkStrict(bp, GIVE_UP), /^mermaid-strict: (event handlers|\d+ script elements|javascript: addresses|the text of the diagram ran)/);
});

test("the same diagram drawn twice, the first in a folded section, has no id twice and the visible copy keeps its own markers", LONG, async t => {
  const { bp } = await open(t, seedTwice);
  none(await checkIds(bp, WAIT));
});

/** Prints each diagram's own width and its box's, to the CI log: how much of the checks' diagrams the box shrinks at this window. */
async function sizes(t: { diagnostic(message: string): void }, bp: BoardPage, window: string) {
  if (await settled(bp, 3, WAIT)) return;
  t.diagnostic(`at a window ${window}: ` + (await figures(bp)).figs.map((f, i) => `${["small", "wide", "tall"][i]} ${round(f.natural)} px in a box of ${f.box} px, drawn ${round(f.drawn)} px`).join("; "));
}
test("a diagram is as wide as itself or as its box, whichever is less, and neither its box nor the page scrolls sideways", LONG, async t => {
  const { bp } = await open(t, seedFit);
  await sizes(t, bp, "1500 px wide");
  none(await checkFit(bp, WAIT));
});
test("at a window 700px wide the same holds", LONG, async t => {
  const { bp } = await open(t, seedFit);
  await narrow(bp);
  await sizes(t, bp, "700 px wide");
  none(await checkFit(bp, WAIT));
});

test("a diagram's own frontmatter settings win over the page's", LONG, async t => {
  const { bp } = await open(t, seedOwn);
  none(await checkOwn(bp, WAIT));
});

test("the buttons and Ctrl with the wheel zoom, the toolbar shows the size, the plain wheel scrolls the page, an enlarged diagram can be dragged, and fit to width restores the default size", LONG, async t => {
  const { bp } = await open(t, seedPipeline);
  none(await checkZoom(bp, WAIT));
});
test("the same check on a page that centers the enlarged diagram out of reach on the left reports that end", LONG, async t => {
  const { bp } = await open(t, seedPipeline, CENTERED_FLEX);
  caught(await checkZoom(bp, GIVE_UP), /^mermaid-zoom: the left end of the enlarged diagram cannot be scrolled into its box/);
});
test("the same check on a page whose diagram sits outside the box's flow reports the right end out of reach", LONG, async t => {
  const { bp } = await open(t, seedPipeline, [OUT_OF_FLOW]);
  caught(await checkZoom(bp, GIVE_UP), /^mermaid-zoom: the right end of the enlarged diagram cannot be scrolled into its box/);
});

test("the 60%, 90% and 100% buttons draw a diagram wider than its box at its share of its own size, the one shown is pressed, and pressed again it gives the box's width back, in a narrow column", LONG, async t => {
  const { bp } = await open(t, seedPipeline);
  await narrow(bp);
  none(await checkActual(bp, WAIT));
});

test("a live update that leaves a diagram's source alone leaves its view alone, and one that changes the source starts it at the default size", LONG, async t => {
  const { bp, board, id } = await open(t, seedPipeline);
  none(await checkKeep(bp, board, id, WAIT));
});
test("the same check on a page that draws the diagrams after it restores the scroll reports the page position", LONG, async t => {
  const { bp, board, id } = await open(t, seedPipeline, [LATE_DRAW]);
  caught(await checkKeep(bp, board, id, GIVE_UP), /^mermaid-keep: after a live update that left its source alone the page is scrolled/);
});

test("labels and lines read in the light and the dark scheme, and a change of scheme redraws the diagram", LONG, async t => {
  const { bp } = await open(t, seedOne);
  none(await checkColors(bp, WAIT));
});
