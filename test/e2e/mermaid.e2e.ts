// Mermaid blocks on the owner's page (web/mermaid.ts), in headless Chromium against the real server: a block in an item's head or log
// is drawn as a diagram; a block that does not parse shows its source and the error and leaves the rest alone; the text of a diagram
// never runs; a page with no diagram never fetches the library; a diagram survives the repaint a live update makes; both color
// schemes read. Each check also runs on a page with one part taken out (an edit applied while the page is bundled), where it must
// report the part's absence: that is what shows a check can fail. Run by CI's e2e job (npm run test:e2e), not on the owner's Mac.

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

async function setHead(board: BoardServer, id: string, head: string) {
  const it = board.store.snapshot().items[id]!;
  await ops(board.store).updateItem({ author: it.group, id, rev: it.rev, head, reason: "test content" });
}

interface Edit { file: string; find: string; replace: string }
/** A page directory serving the current page with `edits` applied to the sources of web/ while it is bundled; the library is the built one. */
async function variantPage(t: Hooks, edits: Edit[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-mermaid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "index.html"), await readFile(join(ROOT, "web/index.html")));
  await symlink(join(ROOT, "web/dist/mermaid.js"), join(dir, "dist/mermaid.js"));
  const applied = new Set<Edit>();
  const plugin: Plugin = {
    name: "edit",
    setup(b) {
      b.onLoad({ filter: /[\\/]web[\\/][\w-]+\.ts$/ }, async args => {
        let text = await readFile(args.path, "utf8");
        for (const edit of edits) {
          if (!args.path.endsWith("/" + edit.file)) continue;
          if (text.split(edit.find).length !== 2) throw new Error(`${edit.file} no longer holds ${JSON.stringify(edit.find)} exactly once; update this variant`);
          text = text.replace(edit.find, () => edit.replace); applied.add(edit);
        }
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

/** Waits until the item's detail holds `count` mermaid blocks, none of them still loading. */
async function settled(bp: BoardPage, count: number) {
  await bp.page.waitForFunction(count => {
    const blocks = [...document.querySelectorAll<HTMLElement>("#item-detail .mermaid-block")];
    return blocks.length === count && blocks.every(b => b.dataset.state === "done" || b.dataset.state === "error");
  }, count, { timeout: 60_000 });
}
const states = (bp: BoardPage, scope = "#item-detail") => bp.page.evaluate(scope => [...document.querySelectorAll<HTMLElement>(scope + " .mermaid-block")].map(b => b.dataset.state ?? "none"), scope);
/** A check that waits for diagrams may time out when the part it needs is missing; that is the check reporting the part's absence. */
const report = async <T>(what: string, run: () => Promise<T>): Promise<T | string[]> => { try { return await run(); } catch (error) { return [`${what}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`]; } };
/** How many times this page has fetched the library. */
const fetches = (bp: BoardPage) => bp.page.evaluate(() => performance.getEntriesByType("resource").filter(e => new URL(e.name).pathname === "/mermaid.js").length);

/** The head's blocks: a good one is a diagram in place of its code, with its Chinese labels, inside the text's width; the bad one shows its source and the error; the one after it and the code block after that are untouched. */
async function checkHead(bp: BoardPage): Promise<string[]> {
  return report("mermaid-head", async () => {
    const v: string[] = [];
    await settled(bp, 3);
    const got = await bp.page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#item-detail .mermaid-block")].map(b => {
      const fig = b.querySelector<HTMLElement>(".mermaid-fig"), pre = b.querySelector("pre.code"), err = b.querySelector(".mermaid-err");
      return {
        state: b.dataset.state, svg: !!fig?.querySelector("svg"), label: fig?.querySelector("svg")?.textContent ?? "", width: fig?.getBoundingClientRect().width ?? 0, height: fig?.getBoundingClientRect().height ?? 0,
        overflow: fig ? fig.scrollWidth > fig.clientWidth + 1 : false, code: pre?.textContent ?? "", codeShown: !!pre && getComputedStyle(pre).display !== "none", err: err?.textContent ?? null,
      };
    }));
    const [good, bad, sequence] = got;
    if (!good || good.state !== "done" || !good.svg) v.push(`mermaid-head: the good block is ${good?.state ?? "missing"}, not a drawn diagram`);
    else {
      for (const word of ["需求", "设计", "实现"]) if (!good.label.includes(word)) v.push(`mermaid-head: the diagram lacks the label ${word}; its text is ${JSON.stringify(good.label)}`);
      if (good.height < 40 || good.width < 40) v.push(`mermaid-head: the diagram is ${good.width}x${good.height}px`);
      if (good.overflow) v.push("mermaid-head: the diagram is wider than the text");
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
  });
}

/** A block in a log entry is a diagram too: the log is opened the way the owner does. */
async function checkLog(bp: BoardPage): Promise<string[]> {
  return report("mermaid-log", async () => {
    await bp.page.locator("#item-detail .log-toggle").click();
    await bp.page.waitForFunction(() => document.querySelectorAll("#item-detail .log .mermaid-block").length === 1);
    await bp.page.waitForFunction(() => { const b = document.querySelector<HTMLElement>("#item-detail .log .mermaid-block"); return b?.dataset.state === "done" || b?.dataset.state === "error"; }, null, { timeout: 60_000 });
    const got = await bp.page.evaluate(() => { const b = document.querySelector<HTMLElement>("#item-detail .log .mermaid-block")!; return { state: b.dataset.state, svg: !!b.querySelector(".mermaid-fig svg"), label: b.querySelector("svg")?.textContent ?? "" }; });
    return got.state === "done" && got.svg && got.label.includes("需求") ? [] : [`mermaid-log: the block in the log is ${got.state} (diagram ${got.svg}, text ${JSON.stringify(got.label)})`];
  });
}

/** The text of a diagram never runs: nothing it holds is an event handler, a script or a javascript: address, and nothing it asked for ran. */
async function checkStrict(bp: BoardPage): Promise<string[]> {
  return report("mermaid-strict", async () => {
    await settled(bp, 1);
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
  });
}

/** The library is fetched when the page shows a block, once, and not when it shows none. */
async function checkLazy(bp: BoardPage, blocks: number): Promise<string[]> {
  await bp.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
  if (blocks > 0) await settled(bp, blocks);
  const n = await fetches(bp);
  return n === (blocks === 0 ? 0 : 1) ? [] : [`mermaid-lazy: a page with ${blocks} diagrams fetched the library ${n} times, expected ${blocks === 0 ? "none" : "once"}`];
}

/** A live update repaints the item: its diagrams, the old ones and a new one, are diagrams again after it. */
async function checkRepaint(bp: BoardPage, board: BoardServer, id: string): Promise<string[]> {
  return report("mermaid-repaint", async () => {
    await settled(bp, 3);
    await bp.page.evaluate(() => { (window as unknown as { __old: Element }).__old = document.querySelector("#item-detail .mermaid-block")!; });
    const base = await bp.changes();
    await setHead(board, id, "新写了一段。\n\n" + HEAD + "\n\n" + fence("flowchart TD\n  P[甲] --> Q[乙]"));
    await bp.waitChanges(base + 1);
    const v: string[] = [];
    if (await bp.page.evaluate(() => (window as unknown as { __old: Element }).__old.isConnected)) v.push("witness setup: the live update did not repaint the item");
    await settled(bp, 4);
    const now = await states(bp);
    if (now.join() !== "done,error,done,done") v.push(`mermaid-repaint: after the live update the blocks are ${now.join(",")}, expected done,error,done,done`);
    return v;
  });
}

/** In each color scheme the labels read on their boxes (4.5:1) and the lines on the page (3:1); the page changing scheme redraws the open diagrams. */
async function checkColors(bp: BoardPage): Promise<string[]> {
  const v: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    await bp.page.emulateMedia({ colorScheme: scheme });
    const got = await report(`mermaid-colors (${scheme})`, async () => {
      await settled(bp, 1);
      // A diagram drawn for the other scheme is replaced a moment after the scheme changes.
      await bp.page.waitForFunction(scheme => {
        const rect = document.querySelector("#item-detail .mermaid-fig .node rect, #item-detail .mermaid-fig .node polygon, #item-detail .mermaid-fig .node path");
        if (!rect) return false;
        const m = getComputedStyle(rect).fill.match(/\d+/g)?.map(Number);
        if (!m) return false;
        const light = (m[0]! + m[1]! + m[2]!) / 3 > 140;
        return light === (scheme === "light");
      }, scheme, { timeout: 30_000 });
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
        const stroke = line ? rgb(getComputedStyle(line).stroke) : null;
        return { label: ratio(text, fill), line: stroke ? ratio(stroke, page) : null };
      });
    });
    if (Array.isArray(got)) { v.push(...got); continue; }
    if (got.label < 4.5) v.push(`mermaid-colors (${scheme}): the label reads ${got.label.toFixed(2)}:1 on its box`);
    if (got.line === null) v.push(`mermaid-colors (${scheme}): the diagram has no line`);
    else if (got.line < 3) v.push(`mermaid-colors (${scheme}): the lines read ${got.line.toFixed(2)}:1 on the page`);
  }
  await bp.page.emulateMedia({ colorScheme: "light" });
  return v;
}

const none = (v: string[]) => assert.equal(v.length, 0, v.length + " violations:\n" + v.join("\n"));
const caught = (v: string[], family: string) => assert.ok(v.some(l => l.startsWith(family)), `the check must report ${family} on this page; it reported:\n${v.join("\n") || "(nothing)"}`);

const seedHead = async (board: BoardServer, id: string) => setHead(board, id, HEAD);
const seedLog = async (board: BoardServer, id: string) => { const it = board.store.snapshot().items[id]!; await ops(board.store).appendLog({ author: it.group, id, text: "日志里的图：\n\n" + fence(GOOD) }); };
const seedHostile = async (board: BoardServer, id: string) => setHead(board, id, fence(HOSTILE));
const seedOne = async (board: BoardServer, id: string) => setHead(board, id, fence(GOOD));
const seedNone = async (board: BoardServer, id: string) => setHead(board, id, "没有图，只有代码：\n\n```wf\nfn main() {}\n```");

// The parts a variant takes out; each is the one thing a check protects.
const NO_WRAP: Edit = { file: "highlight.ts", find: `return fenceLang(info) === "mermaid" ? '<div class="mermaid-block">' + pre + "</div>" : pre;`, replace: "return pre;" };
const LOOSE: Edit = { file: "mermaid.ts", find: 'securityLevel: "strict"', replace: 'securityLevel: "loose"' };
const EAGER: Edit = { file: "mermaid.ts", find: 'if (typeof MutationObserver === "undefined") return;', replace: 'if (typeof MutationObserver === "undefined") return;\n  void load();' };
// Draws only until the first diagram is drawn, the way a page that draws from its first render alone would.
const FIRST_ONLY: Edit = { file: "mermaid.ts", find: "new MutationObserver(records => {\n", replace: "new MutationObserver(records => {\n    if (drawn.size) return;\n" };
const LIGHT_ONLY: Edit = { file: "mermaid.ts", find: 'theme = dark() ? "dark" : "default"', replace: 'theme = "default"' };
const NO_ERROR: Edit = { file: "mermaid.ts", find: 'note.textContent = "图画不出来：" + message;', replace: 'note.textContent = "";' };

const LONG = { timeout: 5 * 60_000 };

test("a mermaid block in an item's head is a diagram; a bad one shows its source and the error", LONG, async t => {
  const { bp } = await open(t, seedHead);
  none(await checkHead(bp));
});
test("the same check on a page that never wraps mermaid blocks reports no diagram", LONG, async t => {
  const { bp } = await open(t, seedHead, [NO_WRAP]);
  caught(await checkHead(bp), "mermaid-head");
});
test("the same check on a page that shows no error under a bad block reports it", LONG, async t => {
  const { bp } = await open(t, seedHead, [NO_ERROR]);
  caught(await checkHead(bp), "mermaid-head");
});

test("a mermaid block in a log entry is a diagram", LONG, async t => {
  const { bp } = await open(t, seedLog);
  none(await checkLog(bp));
});
test("the same check on a page that never wraps mermaid blocks reports no diagram in the log", LONG, async t => {
  const { bp } = await open(t, seedLog, [NO_WRAP]);
  caught(await checkLog(bp), "mermaid-log");
});

test("the text of a diagram never runs", LONG, async t => {
  const { bp } = await open(t, seedHostile);
  await bp.page.evaluate(() => { (window as unknown as { __probe: () => void }).__probe = () => { (window as unknown as { __xss: number }).__xss = 4; }; });
  none(await checkStrict(bp));
});
test("the same check on a page with the library's loose security level reports what runs", LONG, async t => {
  const { bp } = await open(t, seedHostile, [LOOSE]);
  await bp.page.evaluate(() => { (window as unknown as { __probe: () => void }).__probe = () => { (window as unknown as { __xss: number }).__xss = 4; }; });
  caught(await checkStrict(bp), "mermaid-strict");
});

test("a page with no diagram never fetches the library; one with diagrams fetches it once", LONG, async t => {
  none(await checkLazy((await open(t, seedNone)).bp, 0));
  none(await checkLazy((await open(t, seedHead)).bp, 3));
});
test("the same check on a page that loads the library at start reports the fetch", LONG, async t => {
  const { bp } = await open(t, seedNone, [EAGER]);
  caught(await checkLazy(bp, 0), "mermaid-lazy");
});

test("a diagram is a diagram again after a live update repaints its item", LONG, async t => {
  const { bp, board, id } = await open(t, seedHead);
  none(await checkRepaint(bp, board, id));
});
test("the same check on a page that draws only its first render reports the code left behind", LONG, async t => {
  const { bp, board, id } = await open(t, seedHead, [FIRST_ONLY]);
  caught(await checkRepaint(bp, board, id), "mermaid-repaint");
});

test("labels and lines read in the light and the dark scheme, and a change of scheme redraws the diagram", LONG, async t => {
  const { bp } = await open(t, seedOne);
  none(await checkColors(bp));
});
test("the same check on a page that draws in the light colors only reports the dark scheme", LONG, async t => {
  const { bp } = await open(t, seedOne, [LIGHT_ONLY]);
  caught(await checkColors(bp), "mermaid-colors (dark)");
});
