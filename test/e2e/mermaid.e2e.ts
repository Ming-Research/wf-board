// Mermaid blocks on the owner's page (web/mermaid.ts), in headless Chromium against the real server: a block in an item's head or log
// is drawn as a diagram; a block that does not parse shows its source and the error and leaves the rest alone; the text of a diagram
// never runs; a page with no diagram never fetches the library; a diagram survives the repaint a live update makes; the same diagram
// drawn twice has no id twice; both color schemes read, and the owner's data-theme attribute wins over the system's. Each check also
// runs on a page with one part taken out (an edit applied while the page is bundled), where it must report the part's absence for
// the reason the check protects: the reported line must say it, so a page that did not start or a wait that ran out does not pass
// for a catch. Run by CI's e2e job (npm run test:e2e), not on the owner's Mac.

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
  if (waited) return [`mermaid-head: ${waited}`];
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

/** A block in a log entry is a diagram too: the log is opened the way the owner does. */
async function checkLog(bp: BoardPage, wait: number): Promise<string[]> {
  await bp.page.locator("#item-detail .log-toggle").click();
  const waited = await settled(bp, 1, wait, "#item-detail .log");
  if (waited) return [`mermaid-log: ${waited}`];
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

/** A wide diagram keeps its own size and its box scrolls sideways, and the page does not; a narrow one is not stretched either. */
async function checkWide(bp: BoardPage, wait: number): Promise<string[]> {
  const waited = await settled(bp, 2, wait);
  if (waited) return [`mermaid-wide: ${waited}`];
  const got = await bp.page.evaluate(() => {
    const figs = [...document.querySelectorAll<HTMLElement>("#item-detail .mermaid-fig")];
    return {
      figs: figs.map(f => {
        const svg = f.querySelector("svg")!;
        return { natural: svg.viewBox.baseVal.width, drawn: svg.getBoundingClientRect().width, box: f.clientWidth, scroll: f.scrollWidth, overflowX: getComputedStyle(f).overflowX };
      }),
      // Anything above a diagram's box that is wider than itself would scroll the page, or part of it, sideways.
      spilling: figs.flatMap(f => { const out: string[] = []; for (let e = f.parentElement; e; e = e.parentElement) if (e.scrollWidth > e.clientWidth + 1) out.push(e.tagName.toLowerCase() + (e.id ? "#" + e.id : "")); return out; }),
      page: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
    };
  });
  const v: string[] = [];
  const [small, wide] = got.figs;
  if (!small || !wide) return [`mermaid-wide: ${got.figs.length} diagrams, expected 2`];
  if (wide.natural <= wide.box + 1) v.push(`witness setup: the wide diagram is ${wide.natural}px, not wider than its box of ${wide.box}px`);
  if (small.natural >= small.box - 40) v.push(`witness setup: the narrow diagram is ${small.natural}px, not narrower than its box of ${small.box}px`);
  for (const [what, f] of [["narrow", small], ["wide", wide]] as const) if (Math.abs(f.drawn - f.natural) > 1) v.push(`mermaid-wide: the ${what} diagram is drawn ${Math.round(f.drawn)}px wide, not its own ${Math.round(f.natural)}px`);
  if (wide.scroll <= wide.box + 1 || !/auto|scroll/.test(wide.overflowX)) v.push(`mermaid-wide: the wide diagram's box does not scroll sideways (scroll width ${wide.scroll}px in a box of ${wide.box}px, overflow-x ${wide.overflowX})`);
  if (got.spilling.length) v.push(`mermaid-wide: the page scrolls sideways: ${[...new Set(got.spilling)].join(", ")} are wider than themselves`);
  if (got.page[0]! > got.page[1]! + 1) v.push(`mermaid-wide: the page scrolls sideways: it is ${got.page[0]}px wide in a window of ${got.page[1]}px`);
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
/** The check must report a line that says `why`: the part's absence, not a wait that ran out. */
const caught = (v: string[], why: RegExp) => assert.ok(v.some(l => why.test(l)), `the check must report ${String(why)}; it reported:\n${v.join("\n") || "(nothing)"}`);

const seedHead = async (board: BoardServer, id: string) => setHead(board, id, HEAD);
const seedLog = async (board: BoardServer, id: string) => addLog(board, id, "日志里的图：\n\n" + fence(GOOD));
const seedHostile = async (board: BoardServer, id: string) => setHead(board, id, fence(HOSTILE));
const seedOne = async (board: BoardServer, id: string) => setHead(board, id, fence(GOOD));
// The first copy sits in the head's 参考 section, which is folded; the second is in the log, opened after the first is drawn.
const seedTwice = async (board: BoardServer, id: string) => { await setHead(board, id, "正文。\n\n**参考：同一张图**\n" + fence(GOOD)); await addLog(board, id, "同一张图又画一次：\n\n" + fence(GOOD)); };
const WIDE = "flowchart LR\n  " + Array.from({ length: 30 }, (_, i) => `N${i}[第${i}步]`).join(" --> ");
const seedWide = async (board: BoardServer, id: string) => setHead(board, id, ["一张窄的：", "", fence(GOOD), "", "一张很宽的：", "", fence(WIDE)].join("\n"));
const seedNone = async (board: BoardServer, id: string) => setHead(board, id, "没有图，只有代码：\n\n```wf\nfn main() {}\n```");
const probe = (bp: BoardPage) => bp.page.evaluate(() => { (window as unknown as { __probe: () => void }).__probe = () => { (window as unknown as { __xss: number }).__xss = 4; }; });

// The parts a variant takes out; each is the one thing a check protects.
const NO_WRAP: Edit = { file: "highlight.ts", find: `return fenceLang(info) === "mermaid" ? '<div class="mermaid-block">' + pre + "</div>" : pre;`, replace: "return pre;" };
const LOOSE: Edit = { file: "mermaid.ts", find: 'securityLevel: "strict"', replace: 'securityLevel: "loose"' };
const EAGER: Edit = { file: "mermaid.ts", find: 'if (typeof MutationObserver === "undefined") return;', replace: 'if (typeof MutationObserver === "undefined") return;\n  void load();' };
// Draws only until the first diagram is drawn, the way a page that draws from its first render alone would.
const FIRST_ONLY: Edit = { file: "mermaid.ts", find: "new MutationObserver(records => {\n", replace: "new MutationObserver(records => {\n    if (drawn.size) return;\n" };
const LIGHT_ONLY: Edit = { file: "mermaid.ts", find: 'theme = dark() ? "dark" : "default"', replace: 'theme = "default"' };
const NO_ERROR: Edit = { file: "mermaid.ts", find: 'note.textContent = "图画不出来：" + message;', replace: 'note.textContent = "";' };
const SYSTEM_ONLY: Edit = { file: "mermaid.ts", find: 'return theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);', replace: 'return matchMedia("(prefers-color-scheme: dark)").matches;' };
const FIT_WIDTH: Edit = { file: "mermaid.ts", find: 'if (drawing && width) drawing.style.width = width + "px";', replace: "" };
const NO_SCROLL: Edit = { file: "index.html", find: ".mermaid-fig { overflow-x: auto; ", replace: ".mermaid-fig { " };
const SAME_IDS: Edit = { file: "mermaid.ts", find: 'show(block, known.svg.replaceAll(known.id, "mermaid-" + ++serial))', replace: "show(block, known.svg)" };

const LONG = { timeout: 5 * 60_000 };

test("a mermaid block in an item's head is a diagram; a bad one shows its source and the error", LONG, async t => {
  const { bp } = await open(t, seedHead);
  none(await checkHead(bp, WAIT));
});
test("the same check on a page that never wraps mermaid blocks reports that no block is drawn", LONG, async t => {
  const { bp } = await open(t, seedHead, [NO_WRAP]);
  caught(await checkHead(bp, GIVE_UP), /^mermaid-head: expected 3 mermaid blocks drawn within 8 s; found 0 blocks/);
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
  caught(await checkLog(bp, GIVE_UP), /^mermaid-log: expected 1 mermaid blocks drawn within 8 s; found 0 blocks/);
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
  const { bp, board, id } = await open(t, seedHead, [FIRST_ONLY]);
  // The blocks are in the page after the update, and none of them was drawn.
  caught(await checkRepaint(bp, board, id, GIVE_UP), /^mermaid-repaint: after the live update, expected 4 mermaid blocks drawn within 8 s; found 4 blocks, states (none|loading)/);
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

test("a wide diagram keeps its own size and scrolls in its box, and the page does not scroll sideways", LONG, async t => {
  const { bp } = await open(t, seedWide);
  none(await checkWide(bp, WAIT));
});
test("the same check on a page that fits every diagram to its box reports the size", LONG, async t => {
  const { bp } = await open(t, seedWide, [FIT_WIDTH]);
  caught(await checkWide(bp, GIVE_UP), /^mermaid-wide: the (narrow|wide) diagram is drawn \d+px wide, not its own \d+px/);
});
test("the same check on a page whose diagram box does not scroll reports the box or the page", LONG, async t => {
  const { bp } = await open(t, seedWide, [NO_SCROLL]);
  caught(await checkWide(bp, GIVE_UP), /^mermaid-wide: (the wide diagram's box does not scroll sideways|the page scrolls sideways)/);
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
