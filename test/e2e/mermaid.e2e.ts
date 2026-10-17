// Mermaid blocks on the owner's page (web/mermaid.ts), in headless Chromium against the real server: a block in an item's head or log
// is drawn as a diagram; a block that does not parse shows its source and the error and leaves the rest alone; the text of a diagram
// never runs; a page with no diagram never fetches the library; a diagram survives the repaint a live update makes; the same diagram
// drawn twice has no id twice; both color schemes read, and the owner's data-theme attribute wins over the system's. A diagram is
// drawn compact (less area than with the library's own settings, text still at least 12 px on the screen) and, when wider than its
// box, shrunk to it, never enlarged, at two window widths; it zooms with buttons and with Ctrl and the wheel, the plain wheel scrolls
// the page, a zoomed one is dragged and says so, and a live update that leaves its source alone leaves its view alone too. Each
// check also runs on a page with one part taken out (an edit applied while the page is bundled), where it must report the part's
// absence for the reason the check protects. A diagram that never appears can only be observed by waiting, so the wait is short
// (GIVE_UP) and the reported line must say what was waited for and what the page held; a bare timeout, or a page that did not start,
// is not a catch.
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
import { PIPELINE } from "./mermaid-charts.ts";

type Hooks = Parameters<typeof startBoard>[0];

const fence = (code: string) => "```mermaid\n" + code + "\n```";
const GOOD = "flowchart LR\n  A[需求] --> B[设计]\n  B --> C[实现]";
const SEQUENCE = "sequenceDiagram\n  参与者甲->>参与者乙: 你好\n  参与者乙-->>参与者甲: 收到";
// Two arrows in a row: a syntax error.
const BAD = "flowchart LR\n  A --> --> B";
const HEAD = ["先看这张图：", "", fence(GOOD), "", "下面这张是错的：", "", fence(BAD), "", "错的后面还有一张：", "", fence(SEQUENCE), "", "```wf\nfn main() {}\n```"].join("\n");
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

async function setHead(board: BoardServer, id: string, head: string) {
  const it = board.store.snapshot().items[id]!;
  await ops(board.store).updateItem({ author: it.group, id, rev: it.rev, head, reason: "test content" });
}
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

/** Waits until `scope` holds `count` mermaid blocks, none of them still loading. The answer is null, or what the page held when `wait` ran out. */
async function settled(bp: BoardPage, count: number, wait: number, scope = "#item-detail"): Promise<string | null> {
  try {
    await bp.page.waitForFunction(({ count, scope }) => {
      const blocks = [...document.querySelectorAll<HTMLElement>(scope + " .mermaid-block")];
      return blocks.length === count && blocks.every(b => b.dataset.state === "done" || b.dataset.state === "error");
    }, { count, scope }, { timeout: wait });
    return null;
  } catch {
    const now = await bp.page.evaluate(scope => [...document.querySelectorAll<HTMLElement>(scope + " .mermaid-block")].map(b => b.dataset.state ?? "none"), scope);
    return `expected ${count} mermaid blocks drawn within ${wait / 1000} s; found ${now.length} blocks, states ${now.join(",") || "-"}`;
  }
}
const states = (bp: BoardPage) => bp.page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#item-detail .mermaid-block")].map(b => b.dataset.state ?? "none"));
/** How many times this page has fetched the library. */
const fetches = (bp: BoardPage) => bp.page.evaluate(() => performance.getEntriesByType("resource").filter(e => new URL(e.name).pathname === "/mermaid.js").length);

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

/** A block in a log entry is a diagram too: the log is opened the way the owner does. */
async function checkLog(bp: BoardPage, wait: number): Promise<string[]> {
  await bp.page.locator("#item-detail .log-toggle").click();
  const waited = await settled(bp, 1, wait, "#item-detail .log");
  if (waited) return [`mermaid-log: ${waited}`, ...(await shownAsCode(bp, "#item-detail .log") ? ["mermaid-log: the log's diagram source is shown as plain code"] : [])];
  const got = await bp.page.evaluate(() => { const b = document.querySelector<HTMLElement>("#item-detail .log .mermaid-block")!; return { state: b.dataset.state, svg: !!b.querySelector(".mermaid-fig svg"), label: b.querySelector("svg")?.textContent ?? "" }; });
  return got.state === "done" && got.svg && got.label.includes("需求") ? [] : [`mermaid-log: the block in the log is ${got.state} (diagram ${got.svg}, text ${JSON.stringify(got.label)})`];
}

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

/** The library is fetched when the page shows a block, once, and not when it shows none. */
async function checkLazy(bp: BoardPage, blocks: number, wait: number): Promise<string[]> {
  await bp.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
  if (blocks > 0) { const waited = await settled(bp, blocks, wait); if (waited) return [`mermaid-lazy: ${waited}`]; }
  const n = await fetches(bp);
  return n === (blocks === 0 ? 0 : 1) ? [] : [`mermaid-lazy: a page with ${blocks} diagrams fetched the library ${n} times, expected ${blocks === 0 ? "none" : "once"}`];
}

/** A live update repaints the item: its diagrams, the old ones and a new one, are diagrams again after it. */
async function checkRepaint(bp: BoardPage, board: BoardServer, id: string, wait: number): Promise<string[]> {
  const first = await settled(bp, 3, wait);
  if (first) return [`mermaid-repaint: before the update, ${first}`];
  await bp.page.evaluate(() => { (window as unknown as { __old: Element }).__old = document.querySelector("#item-detail .mermaid-block")!; });
  const base = await bp.changes();
  await setHead(board, id, "新写了一段。\n\n" + HEAD + "\n\n" + fence("flowchart TD\n  P[甲] --> Q[乙]"));
  await bp.waitChanges(base + 1);
  const v: string[] = [];
  if (await bp.page.evaluate(() => (window as unknown as { __old: Element }).__old.isConnected)) v.push("witness setup: the live update did not repaint the item");
  const waited = await settled(bp, 4, wait);
  if (waited) v.push(`mermaid-repaint: after the live update, ${waited}`);
  else {
    const now = await states(bp);
    if (now.join() !== "done,error,done,done") v.push(`mermaid-repaint: after the live update the blocks are ${now.join(",")}, expected done,error,done,done`);
  }
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

const round = (n: number) => Math.round(n);
/** What the page does at one click of the enlarge button (web/mermaid.ts, STEP). */
const STEP = 1.25;

/** What the page makes of each diagram under the item's detail: its own width (its view box), the width it is drawn at, its box and the
 * places of both on the screen; and whether anything above a diagram is wider than itself, which would scroll the page sideways. */
async function figures(bp: BoardPage) {
  return bp.page.evaluate(() => {
    const figs = [...document.querySelectorAll<HTMLElement>("#item-detail .mermaid-fig")];
    return {
      figs: figs.map(f => {
        const svg = f.querySelector("svg")!, r = svg.getBoundingClientRect(), b = f.getBoundingClientRect(), label = svg.querySelector(".nodeLabel, .node text");
        return {
          natural: svg.viewBox.baseVal.width, naturalHeight: svg.viewBox.baseVal.height, drawn: r.width, drawnHeight: r.height,
          box: f.clientWidth, scroll: f.scrollWidth, scrollLeft: f.scrollLeft, overflowX: getComputedStyle(f).overflowX,
          left: r.left, top: r.top, right: r.right, boxLeft: b.left, boxRight: b.right,
          pan: f.closest<HTMLElement>(".mermaid-block")!.dataset.pan ?? "", font: label ? parseFloat(getComputedStyle(label).fontSize) : 0,
        };
      }),
      spilling: figs.flatMap(f => { const out: string[] = []; for (let e = f.parentElement; e; e = e.parentElement) if (e.scrollWidth > e.clientWidth + 1) out.push(e.tagName.toLowerCase() + (e.id ? "#" + e.id : "")); return out; }),
      page: [document.documentElement.scrollWidth, document.documentElement.clientWidth] as [number, number],
    };
  });
}
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

/** At its default size a diagram is as wide as itself or, when its box is narrower, as wide as the box: never larger than itself, and the box
 * and the page have nothing to scroll sideways. A narrow one is centered. Held at the window the page is open in. */
async function checkFit(bp: BoardPage, wait: number): Promise<string[]> {
  const waited = await settled(bp, 3, wait);
  if (waited) return [`mermaid-fit: ${waited}`];
  const got = await figures(bp);
  if (got.figs.length !== 3) return [`mermaid-fit: ${got.figs.length} diagrams, expected 3`];
  const v: string[] = [];
  const [small, wide] = got.figs as [Figure, Figure, Figure];
  if (wide.natural <= wide.box + 1) v.push(`witness setup: the wide diagram is ${round(wide.natural)} px, not wider than its box of ${wide.box} px`);
  got.figs.forEach((f, i) => {
    const name = ["small", "wide", "tall"][i]!, want = Math.min(f.natural, f.box);
    if (Math.abs(f.drawn - want) > 1) v.push(`mermaid-fit: the ${name} diagram is drawn ${round(f.drawn)} px wide; it should be ${round(want)}: its own width is ${round(f.natural)} px and its box is ${f.box} px wide`);
    if (f.scroll > f.box + 1) v.push(`mermaid-fit: the box of the ${name} diagram scrolls sideways at the default size (scroll width ${f.scroll} px in a box of ${f.box} px)`);
    if (f.pan !== "no") v.push(`mermaid-fit: the ${name} diagram says it can be dragged at the default size`);
  });
  if (small.natural < small.box && Math.abs(small.left - small.boxLeft - (small.box - small.drawn) / 2) > 2) {
    v.push(`mermaid-fit: the small diagram is not centered: it starts ${round(small.left - small.boxLeft)} px from the left of its ${small.box} px box, centered would be ${round((small.box - small.drawn) / 2)} px`);
  }
  if (got.spilling.length) v.push(`mermaid-fit: the page scrolls sideways: ${[...new Set(got.spilling)].join(", ")} are wider than themselves`);
  if (got.page[0] > got.page[1] + 1) v.push(`mermaid-fit: the page scrolls sideways: it is ${got.page[0]} px wide in a window of ${got.page[1]} px`);
  return v;
}
type Figure = Awaited<ReturnType<typeof figures>>["figs"][number];

/** The chart's own size, the width it is drawn at and the font of its node text. */
async function chartSize(bp: BoardPage, wait: number): Promise<Figure | { problem: string }> {
  const waited = await settled(bp, 1, wait);
  return waited ? { problem: waited } : firstFigure(bp);
}
const area = (f: Figure) => f.natural * f.naturalHeight;
/** The compact settings draw the same chart in less area than without them. */
function checkCompact(now: Figure | { problem: string }, was: Figure | { problem: string }): string[] {
  if ("problem" in now) return [`mermaid-compact: ${now.problem}`];
  if ("problem" in was) return [`mermaid-compact: with the settings left out, ${was.problem}`];
  return area(now) < area(was) ? [] : [`mermaid-compact: the chart takes ${round(now.natural)}x${round(now.naturalHeight)} px (${round(area(now))}) with the settings and ${round(was.natural)}x${round(was.naturalHeight)} px (${round(area(was))}) without them; they do not make it smaller`];
}
/** The text of a node reads on the screen: at its default size the font, times the shrinking that fitting does, is at least 12 px. */
function checkText(now: Figure | { problem: string }): string[] {
  if ("problem" in now) return [`mermaid-text: ${now.problem}`];
  const px = now.font * now.drawn / now.natural;
  return px >= 12 ? [] : [`mermaid-text: the text of a node is ${px.toFixed(1)} px high on the screen (a ${now.font} px font, drawn at ${round(now.drawn / now.natural * 100)}% of its size); it should be at least 12`];
}

/** The tool strip: the buttons zoom by a step, Ctrl and the wheel zoom about the cursor, the plain wheel scrolls the page and neither zooms nor
 * scrolls the diagram, a zoomed diagram can be scrolled to both its ends and dragged, and Reset gives the default size back. */
async function checkZoom(bp: BoardPage, wait: number): Promise<string[]> {
  const waited = await settled(bp, 1, wait);
  if (waited) return [`mermaid-zoom: ${waited}`];
  const have = await buttons(bp), v: string[] = [];
  for (const need of ["缩小", "放大", "还原"]) if (!have.includes(need)) v.push(`mermaid-zoom: the diagram has no ${need} button; its buttons are ${have.join(", ") || "none"}`);
  if (v.length) return v;
  await scrollProbe(bp);
  const start = await firstFigure(bp);
  await press(bp, "放大");
  const once = await firstFigure(bp);
  if (Math.abs(once.drawn - start.drawn * STEP) > 2) v.push(`mermaid-zoom: the enlarge button took the diagram from ${round(start.drawn)} to ${round(once.drawn)} px wide, not by ${STEP}`);
  await press(bp, "缩小");
  const back = await firstFigure(bp);
  if (Math.abs(back.drawn - start.drawn) > 2) v.push(`mermaid-zoom: enlarging and then shrinking left the diagram ${round(back.drawn)} px wide, from ${round(start.drawn)} px`);
  for (let i = 0; i < 4; i++) await press(bp, "放大");
  const big = await firstFigure(bp);
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
  const at = await middle(bp), pre = await firstFigure(bp);
  await bp.page.mouse.move(at.x, at.y);
  await bp.page.keyboard.down("Control");
  await bp.page.mouse.wheel(0, -100);
  await bp.page.keyboard.up("Control");
  if (!await widerThan(bp, pre.drawn + 5)) v.push("mermaid-zoom: Ctrl and the wheel did not enlarge the diagram");
  else {
    const post = await firstFigure(bp);
    const x = [(at.x - pre.left) / pre.drawn, (at.x - post.left) / post.drawn], y = [(at.y - pre.top) / pre.drawnHeight, (at.y - post.top) / post.drawnHeight];
    if (Math.abs(x[0]! - x[1]!) > 0.02 || Math.abs(y[0]! - y[1]!) > 0.03) v.push(`mermaid-zoom: Ctrl and the wheel moved the point under the cursor from (${x[0]!.toFixed(3)}, ${y[0]!.toFixed(3)}) to (${x[1]!.toFixed(3)}, ${y[1]!.toFixed(3)}) of the diagram`);
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

  await press(bp, "还原");
  const end = await firstFigure(bp);
  if (Math.abs(end.drawn - start.drawn) > 2 || end.scrollLeft !== 0 || end.pan !== "no") v.push(`mermaid-zoom: after Reset the diagram is ${round(end.drawn)} px wide, scrolled ${round(end.scrollLeft)} px, dragging ${end.pan === "yes" ? "on" : "off"}; it was ${round(start.drawn)} px, 0 and off at the start`);
  const page = (await figures(bp)).page;
  if (page[0] > page[1] + 1) v.push(`mermaid-zoom: the page scrolls sideways: it is ${page[0]} px wide in a window of ${page[1]} px`);
  return v;
}

/** An enlarged diagram says it can be moved: a scroll bar that stays, the grabbing hand, a word in the bar. The bar and the scroll bar read
 * in both color schemes (4.5:1 for the words, 3:1 for the bar against its track). */
async function checkPan(bp: BoardPage, wait: number): Promise<string[]> {
  const waited = await settled(bp, 1, wait);
  if (waited) return [`mermaid-pan: ${waited}`];
  if (!(await buttons(bp)).includes("放大")) return ["mermaid-pan: the diagram has no 放大 button"];
  for (let i = 0; i < 4; i++) await press(bp, "放大");
  const v: string[] = [];
  const got = await bp.page.evaluate(() => {
    const f = document.querySelector<HTMLElement>("#item-detail .mermaid-fig")!, hint = f.closest(".mermaid-block")!.querySelector<HTMLElement>(".mermaid-hint");
    return { pan: f.closest<HTMLElement>(".mermaid-block")!.dataset.pan, cursor: getComputedStyle(f).cursor, bar: parseFloat(getComputedStyle(f, "::-webkit-scrollbar").height), hint: hint ? getComputedStyle(hint).display : "none", hintText: hint?.textContent ?? "" };
  });
  if (got.pan !== "yes") return [`witness setup: the enlarged diagram does not say it can be dragged (${got.pan})`];
  if (got.cursor !== "grab") v.push(`mermaid-pan: a diagram that can be dragged shows the cursor ${got.cursor}, not grab`);
  if (!(got.bar >= 8)) v.push(`mermaid-pan: the box of a diagram that can be dragged has no scroll bar of its own, and the system's hides itself when idle (the bar is ${got.bar} px high)`);
  if (got.hint === "none" || !got.hintText) v.push("mermaid-pan: the tool strip of a diagram that can be dragged does not say so");
  // A shade at the edge that has more: along the whole diagram, so it shows however far down the scroll bar is.
  const shades = () => bp.page.evaluate(() => {
    const block = document.querySelector<HTMLElement>("#item-detail .mermaid-block")!, view = block.querySelector(".mermaid-view")!;
    const shade = (pseudo: string) => { const cs = getComputedStyle(view, pseudo); return cs.content !== "none" && cs.content !== "normal" && parseFloat(cs.width) >= 8; };
    return { more: block.dataset.more ?? "", left: shade("::before"), right: shade("::after") };
  });
  await bp.page.evaluate(() => { document.querySelector<HTMLElement>("#item-detail .mermaid-fig")!.scrollLeft = 0; });
  await bp.page.waitForFunction(() => document.querySelector<HTMLElement>("#item-detail .mermaid-block")!.dataset.more === "right", null, { timeout: 3_000 }).catch(() => {});
  const atStart = await shades();
  if (!atStart.more.includes("right") || !atStart.right || atStart.left) v.push(`mermaid-pan: an enlarged diagram at its left edge does not show a shade on its right alone (more: "${atStart.more}", shade left ${atStart.left}, right ${atStart.right})`);
  await bp.page.evaluate(() => { const f = document.querySelector<HTMLElement>("#item-detail .mermaid-fig")!; f.scrollLeft = f.scrollWidth; });
  await bp.page.waitForFunction(() => document.querySelector<HTMLElement>("#item-detail .mermaid-block")!.dataset.more === "left", null, { timeout: 3_000 }).catch(() => {});
  const atEnd = await shades();
  if (atEnd.more !== "left" || !atEnd.left || atEnd.right) v.push(`mermaid-pan: an enlarged diagram at its right edge does not show a shade on its left alone (more: "${atEnd.more}", shade left ${atEnd.left}, right ${atEnd.right})`);
  await bp.page.evaluate(() => { document.querySelector<HTMLElement>("#item-detail .mermaid-fig")!.scrollLeft = 0; });
  for (const scheme of ["light", "dark"] as const) {
    await bp.page.emulateMedia({ colorScheme: scheme });
    const what = `mermaid-pan (${scheme})`;
    const drawnAgain = await colors(bp, scheme, what, wait);
    if ("problem" in drawnAgain) { v.push(drawnAgain.problem); continue; }
    const read = await bp.page.evaluate(() => {
      const rgb = (c: string) => { const m = c.match(/[\d.]+/g)!.map(Number); return { r: m[0]!, g: m[1]!, b: m[2]!, a: m.length > 3 ? m[3]! : 1 }; };
      const lum = (c: { r: number; g: number; b: number }) => { const f = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
      const ratio = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
      const f = document.querySelector<HTMLElement>("#item-detail .mermaid-fig")!, bar = document.querySelector<HTMLElement>("#item-detail .mermaid-tools")!;
      const ground = rgb(getComputedStyle(bar).backgroundColor), word = bar.querySelector("button")!, hint = bar.querySelector(".mermaid-hint")!;
      return {
        button: ratio(rgb(getComputedStyle(word).color), ground), hint: ratio(rgb(getComputedStyle(hint).color), ground),
        thumb: ratio(rgb(getComputedStyle(f, "::-webkit-scrollbar-thumb").backgroundColor), rgb(getComputedStyle(f, "::-webkit-scrollbar-track").backgroundColor)),
      };
    });
    if (read.button < 4.5) v.push(`${what}: the words on the buttons read ${read.button.toFixed(2)}:1 on the tool strip`);
    if (read.hint < 4.5) v.push(`${what}: the hint reads ${read.hint.toFixed(2)}:1 on the tool strip`);
    if (read.thumb < 3) v.push(`${what}: the scroll bar reads ${read.thumb.toFixed(2)}:1 against its track`);
  }
  await bp.page.emulateMedia({ colorScheme: "light" });
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

/** The owner's data-theme attribute on the root element wins over the system's scheme, whichever way they disagree, and the open diagram follows it. */
async function checkTheme(bp: BoardPage, wait: number): Promise<string[]> {
  const v: string[] = [];
  for (const [system, attribute] of [["light", "dark"], ["dark", "light"]] as const) {
    await bp.page.emulateMedia({ colorScheme: system });
    await bp.page.evaluate(theme => document.documentElement.setAttribute("data-theme", theme), attribute);
    const what = `mermaid-theme (${attribute} data-theme over a ${system} system)`;
    v.push(...readable(what, await colors(bp, attribute, what, wait)));
  }
  await bp.page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await bp.page.emulateMedia({ colorScheme: "light" });
  return v;
}

const none = (v: string[]) => assert.equal(v.length, 0, v.length + " violations:\n" + v.join("\n"));
/** The check must report a line that says `why`: what it waited for and what the page held, not a bare timeout. */
const caught = (v: string[], why: RegExp) => assert.ok(v.some(l => why.test(l)), `the check must report ${String(why)}; it reported:\n${v.join("\n") || "(nothing)"}`);

const seedHead = async (board: BoardServer, id: string) => setHead(board, id, HEAD);
const seedLog = async (board: BoardServer, id: string) => addLog(board, id, "日志里的图：\n\n" + fence(GOOD));
const seedHostile = async (board: BoardServer, id: string) => setHead(board, id, fence(HOSTILE));
const seedOne = async (board: BoardServer, id: string) => setHead(board, id, fence(GOOD));
// The first copy sits in the head's 参考 section, which is folded; the second is in the log, opened after the first is drawn.
const seedTwice = async (board: BoardServer, id: string) => { await setHead(board, id, "正文。\n\n**参考：同一张图**\n" + fence(GOOD)); await addLog(board, id, "同一张图又画一次：\n\n" + fence(GOOD)); };
const WIDE = "flowchart LR\n  " + Array.from({ length: 30 }, (_, i) => `N${i}[第${i}步]`).join(" --> ");
const SMALL = "flowchart LR\n  A[甲] --> B[乙]";
// A small diagram, a wide one and the tall chart, in one head.
const seedFit = async (board: BoardServer, id: string) => setHead(board, id, ["一张窄的：", "", fence(SMALL), "", "一张很宽的：", "", fence(WIDE), "", "一张又高又宽的：", "", fence(PIPELINE)].join("\n"));
const seedPipeline = async (board: BoardServer, id: string) => setHead(board, id, fence(PIPELINE));
/** The window at about the width of a phone held sideways, where the page puts the list and the detail side by side in two narrow columns. */
const NARROW = { width: 700, height: 1000 };
const narrow = async (bp: BoardPage) => { await bp.page.setViewportSize(NARROW); await bp.settle(); };
const seedNone = async (board: BoardServer, id: string) => setHead(board, id, "没有图，只有代码：\n\n```wf\nfn main() {}\n```");
const probe = (bp: BoardPage) => bp.page.evaluate(() => { (window as unknown as { __probe: () => void }).__probe = () => { (window as unknown as { __xss: number }).__xss = 4; }; });

// The parts a variant takes out; each is the one thing a check protects.
const NO_WRAP: Edit = { file: "highlight.ts", find: `return fenceLang(info) === "mermaid" ? '<div class="mermaid-block">' + pre + "</div>" : pre;`, replace: "return pre;" };
const LOOSE: Edit = { file: "mermaid.ts", find: 'securityLevel: "strict"', replace: 'securityLevel: "loose"' };
const EAGER: Edit = { file: "mermaid.ts", find: 'if (typeof MutationObserver === "undefined") return;', replace: 'if (typeof MutationObserver === "undefined") return;\n  void load();' };
// Draws only until the first diagram is drawn, the way a page that draws from its first render alone would (with LATE_DRAW, which takes out the other place the page draws a repainted item's diagrams).
const FIRST_ONLY: Edit = { file: "mermaid.ts", find: "new MutationObserver(records => {\n", replace: "new MutationObserver(records => {\n    if (drawn.size) return;\n" };
const LIGHT_ONLY: Edit = { file: "mermaid.ts", find: 'theme = dark() ? "dark" : "default"', replace: 'theme = "default"' };
const NO_ERROR: Edit = { file: "mermaid.ts", find: 'note.textContent = "图画不出来：" + message;', replace: 'note.textContent = "";' };
const SYSTEM_ONLY: Edit = { file: "mermaid.ts", find: 'return theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);', replace: 'return matchMedia("(prefers-color-scheme: dark)").matches;' };
const NO_SCROLL: Edit = { file: "index.html", find: ".mermaid-fig { overflow-x: auto; ", replace: ".mermaid-fig { " };
const NO_CENTER: Edit = { file: "index.html", find: "display: block; margin-inline: auto; ", replace: "display: block; " };
// A diagram at its own width, whatever its box: what the page did before it fitted diagrams to the box.
const FIXED_SIZE: Edit = { file: "index.html", find: "width: calc(min(var(--natural), 100%) * var(--zoom, 1));", replace: "width: var(--natural);" };
// The library's own spacing and padding.
const NO_COMPACT: Edit = { file: "mermaid.ts", find: "...COMPACT,", replace: "" };
// Text so small that fitting it to the box leaves it unreadable.
const TINY_TEXT: Edit = { file: "mermaid.ts", find: "...COMPACT,", replace: '...COMPACT, themeCSS: ".nodeLabel, .nodeLabel p, .label, .label p { font-size: 7px !important; }",' };
const NO_TOOLS: Edit = { file: "mermaid.ts", find: "block.prepend(viewer(block, fig, source));", replace: "" };
const WHEEL_ZOOMS_ALL: Edit = { file: "mermaid.ts", find: "if (!event.ctrlKey) return;", replace: "" };
const NO_DRAG: Edit = { file: "mermaid.ts", find: 'if (down.button !== 0 || down.pointerType !== "mouse" || block.dataset.pan !== "yes") return;', replace: "return;" };
const NO_SCROLLBAR: Edit = { file: "index.html", find: ".mermaid-fig::-webkit-scrollbar { height: 10px; }", replace: "" };
const NO_HINT: Edit = { file: "index.html", find: '.mermaid-block[data-pan="yes"] .mermaid-hint { display: inline; }', replace: "" };
const NO_SHADE: Edit = { file: "index.html", find: 'content: ""; position: absolute; top: 0; bottom: 0; width: 18px; pointer-events: none;', replace: "" };
const NO_GRAB: Edit = { file: "index.html", find: "cursor: grab; ", replace: "" };
// Colors that do not follow the page's color scheme.
const FIXED_INK: Edit = { file: "index.html", find: "background: var(--surface); color: var(--ink); font-size: 13px;", replace: "background: var(--surface); color: #18201e; font-size: 13px;" };
const FIXED_THUMB: Edit = { file: "index.html", find: ".mermaid-fig::-webkit-scrollbar-thumb { background: var(--muted);", replace: ".mermaid-fig::-webkit-scrollbar-thumb { background: #5b6763;" };
// A view that is forgotten at once, and one shared by every source.
const FORGET_VIEW: Edit = { file: "mermaid.ts", find: "const view = views.get(source);", replace: "const view = undefined as { zoom: number; left: number } | undefined;" };
const ONE_VIEW: Edit[] = [
  { file: "mermaid.ts", find: "const view = views.get(source);", replace: 'const view = views.get("");' },
  { file: "mermaid.ts", find: "views.delete(source)", replace: 'views.delete("")' },
  { file: "mermaid.ts", find: "views.set(source, {", replace: 'views.set("", {' },
];
// The detail pane is repainted and its scroll restored before the diagrams are drawn again.
const LATE_DRAW: Edit = { file: "app.ts", find: "drawMermaid(pane);", replace: "" };
const SAME_IDS: Edit = { file: "mermaid.ts", find: 'show(block, known.svg.replaceAll(known.id, "mermaid-" + ++serial), source)', replace: "show(block, known.svg, source)" };

const LONG = { timeout: 5 * 60_000 };

test("a mermaid block in an item's head is a diagram; a bad one shows its source and the error", LONG, async t => {
  const { bp } = await open(t, seedHead);
  none(await checkHead(bp, WAIT));
});
test("the same check on a page that never wraps mermaid blocks reports that no block is drawn", LONG, async t => {
  const { bp } = await open(t, seedHead, [NO_WRAP]);
  const v = await checkHead(bp, GIVE_UP);
  caught(v, /^mermaid-head: expected 3 mermaid blocks drawn within 8 s; found 0 blocks/);
  caught(v, /^mermaid-head: the head's diagram source is shown as plain code/);
});
test("the same check on a page that shows no error under a bad block reports the missing error", LONG, async t => {
  const { bp } = await open(t, seedHead, [NO_ERROR]);
  caught(await checkHead(bp, GIVE_UP), /^mermaid-head: the bad block shows no error/);
});

test("a mermaid block in a log entry is a diagram", LONG, async t => {
  const { bp } = await open(t, seedLog);
  none(await checkLog(bp, WAIT));
});
test("the same check on a page that never wraps mermaid blocks reports that the log holds no block drawn", LONG, async t => {
  const { bp } = await open(t, seedLog, [NO_WRAP]);
  const v = await checkLog(bp, GIVE_UP);
  caught(v, /^mermaid-log: expected 1 mermaid blocks drawn within 8 s; found 0 blocks/);
  caught(v, /^mermaid-log: the log's diagram source is shown as plain code/);
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

test("a page with no diagram never fetches the library; one with diagrams fetches it once", LONG, async t => {
  none(await checkLazy((await open(t, seedNone)).bp, 0, WAIT));
  none(await checkLazy((await open(t, seedHead)).bp, 3, WAIT));
});
test("the same check on a page that loads the library at start reports the fetch", LONG, async t => {
  const { bp } = await open(t, seedNone, [EAGER]);
  caught(await checkLazy(bp, 0, GIVE_UP), /^mermaid-lazy: a page with 0 diagrams fetched the library 1 times, expected none/);
});

test("a diagram is a diagram again after a live update repaints its item", LONG, async t => {
  const { bp, board, id } = await open(t, seedHead);
  none(await checkRepaint(bp, board, id, WAIT));
});
test("the same check on a page that draws only its first render reports the code left behind", LONG, async t => {
  const { bp, board, id } = await open(t, seedHead, [FIRST_ONLY, LATE_DRAW]);
  // The blocks are in the page after the update, and none of them was drawn.
  caught(await checkRepaint(bp, board, id, GIVE_UP), /^mermaid-repaint: after the live update, expected 4 mermaid blocks drawn within 8 s; found 4 blocks, states none,none,none,none/);
});

test("the same diagram drawn twice, the first in a folded section, has no id twice and the visible copy keeps its own markers", LONG, async t => {
  const { bp } = await open(t, seedTwice);
  none(await checkIds(bp, WAIT));
});
test("the same check on a page whose second copy keeps the first copy's ids reports the repeated ids and the markers outside the visible diagram", LONG, async t => {
  const { bp } = await open(t, seedTwice, [SAME_IDS]);
  const v = await checkIds(bp, GIVE_UP);
  caught(v, /^mermaid-ids: \d+ ids are in the page twice/);
  caught(v, /^mermaid-ids: the visible diagram's lines point at markers outside it/);
});

const describe = (f: Figure | { problem: string }) => "problem" in f ? f.problem : `${round(f.natural)}x${round(f.naturalHeight)} px (${round(area(f))}), node text ${f.font} px, drawn ${round(f.drawn)} px wide`;

test("a diagram is as wide as itself or as its box, whichever is less, and neither its box nor the page scrolls sideways", LONG, async t => {
  const { bp } = await open(t, seedFit);
  none(await checkFit(bp, WAIT));
});
test("at a window 700px wide the same holds", LONG, async t => {
  const { bp } = await open(t, seedFit);
  await narrow(bp);
  none(await checkFit(bp, WAIT));
});
test("the same check on a page that draws every diagram at its own width reports the size", LONG, async t => {
  const { bp } = await open(t, seedFit, [FIXED_SIZE]);
  caught(await checkFit(bp, GIVE_UP), /^mermaid-fit: the (wide|tall) diagram is drawn \d+ px wide; it should be/);
});
test("the same check on a page that does not center a small diagram reports where it sits", LONG, async t => {
  const { bp } = await open(t, seedFit, [NO_CENTER]);
  caught(await checkFit(bp, GIVE_UP), /^mermaid-fit: the small diagram is not centered/);
});

test("the compact settings draw the chart in less area than the library's own, and its text is at least 12 px high on the screen", LONG, async t => {
  const now = await chartSize((await open(t, seedPipeline)).bp, WAIT), was = await chartSize((await open(t, seedPipeline, [NO_COMPACT])).bp, WAIT);
  t.diagnostic(`with the compact settings: ${describe(now)}; with the library's own: ${describe(was)}`);
  none(checkCompact(now, was));
  none(checkText(now));
});
test("the same comparison between two pages without the settings reports that nothing got smaller", LONG, async t => {
  const was = await chartSize((await open(t, seedPipeline, [NO_COMPACT])).bp, WAIT);
  caught(checkCompact(was, was), /^mermaid-compact: .* they do not make it smaller/);
});
test("the same text check on a page whose text is tiny reports its height", LONG, async t => {
  const tiny = await chartSize((await open(t, seedPipeline, [TINY_TEXT])).bp, WAIT);
  t.diagnostic(`with 7 px text: ${describe(tiny)}`);
  caught(checkText(tiny), /^mermaid-text: the text of a node is [\d.]+ px high on the screen/);
});

test("the buttons and Ctrl with the wheel zoom, the plain wheel scrolls the page, an enlarged diagram can be dragged, and Reset restores the default size", LONG, async t => {
  const { bp } = await open(t, seedPipeline);
  none(await checkZoom(bp, WAIT));
});
test("the same check on a page without the tool strip reports the missing buttons", LONG, async t => {
  const { bp } = await open(t, seedPipeline, [NO_TOOLS]);
  caught(await checkZoom(bp, GIVE_UP), /^mermaid-zoom: the diagram has no (缩小|放大|还原) button/);
});
test("the same check on a page where the plain wheel zooms reports the page not scrolled", LONG, async t => {
  const { bp } = await open(t, seedPipeline, [WHEEL_ZOOMS_ALL]);
  caught(await checkZoom(bp, GIVE_UP), /^mermaid-zoom: the plain wheel over the diagram (did not scroll the page|zoomed it)/);
});
test("the same check on a page that cannot drag reports the box not moved", LONG, async t => {
  const { bp } = await open(t, seedPipeline, [NO_DRAG]);
  caught(await checkZoom(bp, GIVE_UP), /^mermaid-zoom: dragging the enlarged diagram 120 px to the left moved its box/);
});
test("the same check on a page whose diagram box does not scroll reports the box", LONG, async t => {
  const { bp } = await open(t, seedPipeline, [NO_SCROLL]);
  caught(await checkZoom(bp, GIVE_UP), /^mermaid-zoom: the enlarged diagram's box does not scroll sideways/);
});

test("an enlarged diagram says it can be moved, in both color schemes", LONG, async t => {
  const { bp } = await open(t, seedPipeline);
  none(await checkPan(bp, WAIT));
});
test("the same check on a page without its own scroll bar reports the bar", LONG, async t => {
  const { bp } = await open(t, seedPipeline, [NO_SCROLLBAR]);
  caught(await checkPan(bp, GIVE_UP), /^mermaid-pan: the box of a diagram that can be dragged has no scroll bar of its own/);
});
test("the same check on a page without the hint reports the hint", LONG, async t => {
  const { bp } = await open(t, seedPipeline, [NO_HINT]);
  caught(await checkPan(bp, GIVE_UP), /^mermaid-pan: the tool strip of a diagram that can be dragged does not say so/);
});
test("the same check on a page without the grabbing hand reports the cursor", LONG, async t => {
  const { bp } = await open(t, seedPipeline, [NO_GRAB]);
  caught(await checkPan(bp, GIVE_UP), /^mermaid-pan: a diagram that can be dragged shows the cursor/);
});
test("the same check on a page without the shades at the edges reports the edge", LONG, async t => {
  const { bp } = await open(t, seedPipeline, [NO_SHADE]);
  caught(await checkPan(bp, GIVE_UP), /^mermaid-pan: an enlarged diagram at its left edge does not show a shade on its right alone/);
});
test("the same check on a page whose buttons keep their light-scheme ink reports the buttons in the dark scheme", LONG, async t => {
  const { bp } = await open(t, seedPipeline, [FIXED_INK]);
  caught(await checkPan(bp, GIVE_UP), /^mermaid-pan \(dark\): the words on the buttons read/);
});
test("the same check on a page whose scroll bar keeps its light-scheme color reports the bar in the dark scheme", LONG, async t => {
  const { bp } = await open(t, seedPipeline, [FIXED_THUMB]);
  caught(await checkPan(bp, GIVE_UP), /^mermaid-pan \(dark\): the scroll bar reads/);
});

test("a live update that leaves a diagram's source alone leaves its view alone, and one that changes the source starts it at the default size", LONG, async t => {
  const { bp, board, id } = await open(t, seedPipeline);
  none(await checkKeep(bp, board, id, WAIT));
});
test("the same check on a page that forgets the view reports the size", LONG, async t => {
  const { bp, board, id } = await open(t, seedPipeline, [FORGET_VIEW]);
  caught(await checkKeep(bp, board, id, GIVE_UP), /^mermaid-keep: after a live update that left its source alone the diagram is/);
});
test("the same check on a page that keeps one view for every source reports the changed diagram", LONG, async t => {
  const { bp, board, id } = await open(t, seedPipeline, ONE_VIEW);
  caught(await checkKeep(bp, board, id, GIVE_UP), /^mermaid-keep: a diagram whose source changed/);
});
test("the same check on a page that draws the diagrams after it restores the scroll reports the page position", LONG, async t => {
  const { bp, board, id } = await open(t, seedPipeline, [LATE_DRAW]);
  caught(await checkKeep(bp, board, id, GIVE_UP), /^mermaid-keep: after a live update that left its source alone the page is scrolled/);
});

test("labels and lines read in the light and the dark scheme, and a change of scheme redraws the diagram", LONG, async t => {
  const { bp } = await open(t, seedOne);
  none(await checkColors(bp, WAIT));
});
test("the same check on a page that draws in the light colors only reports that the dark colors never came", LONG, async t => {
  const { bp } = await open(t, seedOne, [LIGHT_ONLY]);
  caught(await checkColors(bp, GIVE_UP), /^mermaid-colors \(dark\): the diagram did not take the dark colors within 8 s/);
});

test("the owner's data-theme attribute wins over the system's scheme, both ways round", LONG, async t => {
  const { bp } = await open(t, seedOne);
  none(await checkTheme(bp, WAIT));
});
test("the same check on a page that reads only the system's scheme reports the attribute not followed", LONG, async t => {
  const { bp } = await open(t, seedOne, [SYSTEM_ONLY]);
  caught(await checkTheme(bp, GIVE_UP), /^mermaid-theme \(dark data-theme over a light system\): the diagram did not take the dark colors within 8 s/);
});
