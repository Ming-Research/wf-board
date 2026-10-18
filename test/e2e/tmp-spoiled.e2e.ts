// TEMPORARY (ci-browser-lane): shows that each test of test/e2e/browser.e2e.ts fails on a page with the thing it guards spoiled. Each case
// serves the current page with a literal edit applied while it is bundled, runs the check the test runs, and must get a violation of the
// family the edit belongs to. Deleted before the last full CI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { Plugin } from "esbuild";
import { startBoard, launch, BoardPage, openAll, ROOT } from "./harness.ts";
import type { BoardServer } from "./harness.ts";
import { oracle, checkFullWidth, checkPlanCardLayout, checkCardFold, checkDifficultyChipLayout, checkProgressBands } from "./invariants.ts";
import { checkSmoke, cardSample, checkAgentList, checkMessages } from "./browser-checks.ts";
import { showHead, atNarrow, checkLibrary, checkFitWindows, checkZoom, checkActual, checkKeep, checkColors, seedPipeline, seedOne } from "./mermaid-checks.ts";

type Hooks = Parameters<typeof startBoard>[0];
interface Edit { file: "index.html" | "app.ts" | "mermaid.ts"; find: string; replace: string }

/** A page directory serving the current page with `edits` applied to web/index.html and to the sources of web/ while they are bundled. */
async function variantPage(t: Hooks, edits: Edit[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-spoiled-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "dist"));
  const applied = new Set<Edit>();
  const once = (text: string, edit: Edit) => {
    if (text.split(edit.find).length !== 2) throw new Error(`${edit.file} no longer holds ${JSON.stringify(edit.find)} exactly once`);
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
  await build({ entryPoints: [join(ROOT, "web/app.ts")], bundle: true, format: "esm", target: "es2022", outfile: join(dir, "dist/app.js"), plugins: [plugin], logLevel: "silent" });
  assert.equal(applied.size, edits.length, "every edit was applied");
  return dir;
}

const GIVE_UP = 8_000;
const page = (find: string, replace: string): Edit => ({ file: "index.html", find, replace });
const app = (find: string, replace: string): Edit => ({ file: "app.ts", find, replace });
const lib = (find: string, replace: string): Edit => ({ file: "mermaid.ts", find, replace });
const WRAP = "body.wide .wrap { flex: 1; min-height: 0; max-width: none; min-width: 688px;";
const ITEM_BODY = "body.wide #item-detail .item > .body, body.wide #item-detail .item > .notes { padding-left: 0; }";
const LOG = ".log { display: flex; flex-direction: column; gap: 6px; margin-top: 4px;";

interface Case { test: string; what: string; edits: Edit[]; run: (bp: BoardPage, board: BoardServer) => Promise<string[]>; why: RegExp }
const CASES: Case[] = [
  { test: "smoke", what: "the page is wider than the window", edits: [page(WRAP, WRAP.replace("688px", "3000px"))], run: checkSmoke, why: /^smoke: the page is \d+ px wide/ },
  { test: "widths", what: "a block of the right column has a width of its own", edits: [page(LOG, LOG + " width: 78ch;")], run: bp => checkFullWidth(bp), why: /^full-width-fill \.log:/ },
  { test: "widths", what: "the item's box in the right column is capped", edits: [page(ITEM_BODY, ITEM_BODY + "\nbody.wide #item-detail > .item { max-width: 600px; }")], run: bp => checkFullWidth(bp), why: /^full-width-box:/ },
  { test: "widths", what: "the item's body in the right column is capped", edits: [page(ITEM_BODY, ITEM_BODY + "\nbody.wide #item-detail .item > .body { max-width: 600px; }")], run: bp => checkFullWidth(bp), why: /^full-width-body:/ },
  { test: "widths", what: "a block is wider than the column so the column scrolls sideways", edits: [page(LOG, LOG + " min-width: 3000px;")], run: bp => checkFullWidth(bp), why: /^full-width-scroll:/ },
  { test: "widths", what: "the two columns are wider than the window", edits: [page(WRAP, WRAP.replace("688px", "3000px"))], run: bp => checkFullWidth(bp), why: /^full-width-page:/ },
  {
    test: "plan card rows", what: "the pick of a card row does not shrink",
    edits: [page(".plan-row.cardrow > .plan-main > span:not(.cardpick) { flex: none; }", ".plan-row.cardrow > .plan-main > span { flex: none; }")],
    run: async (bp, b) => { const o = await oracle(b.store); return checkPlanCardLayout(bp, o, [o.s.decisions[b.gen.witness.donePlanCard]!.item]); }, why: /^plan-card-row/,
  },
  {
    test: "card fold", what: "what is under a closed card's line shows while it is folded",
    edits: [page("details.cardfold > summary { cursor: pointer; font-size: 14px; }", "details.cardfold > summary { cursor: pointer; font-size: 14px; }\ndetails.cardfold::details-content { content-visibility: visible; }")],
    run: async (bp, b) => { const o = await oracle(b.store); return checkCardFold(bp, o, cardSample(o, b.gen.witness)); }, why: /^card-fold: .* shows what is under its line while folded/,
  },
  {
    test: "progress bands", what: "a band is half as wide as the plan's share", edits: [app('band.style.setProperty("--p", String(share))', 'band.style.setProperty("--p", String(share / 2))')],
    run: async (bp, b) => checkProgressBands(bp, await oracle(b.store)), why: /^progress-band \(light\): .* of the row wide, not the plan's/,
  },
  {
    test: "difficulty chip", what: "the chip sits lower than the tags", edits: [page(".diffchip { background: transparent;", ".diffchip { position: relative; top: 8px; background: transparent;")],
    run: async (bp, b) => checkDifficultyChipLayout(bp, await oracle(b.store)), why: /^difficulty-chip: .* not on its tags' line/,
  },
  {
    test: "agent list", what: "the list lies below the projects",
    edits: [page('<section class="agents" id="agents" aria-label="代理" hidden></section>\n\n  <div id="areas"></div>', '<div id="areas"></div>\n\n  <section class="agents" id="agents" aria-label="代理" hidden></section>')],
    run: checkAgentList, why: /^agent-list: the list does not lie above the projects/,
  },
  { test: "agent list", what: "Back does nothing", edits: [app('btn.addEventListener("click", goBack);', 'btn.addEventListener("click", () => {});')], run: checkAgentList, why: /^agent-list: Back does not scroll the list back/ },
  {
    test: "messages", what: "the list of messages lies behind the page",
    edits: [page(".messages { position: fixed; top: calc(6px + env(safe-area-inset-top, 0px)); right: 54px; z-index: 40;", ".messages { position: fixed; top: calc(6px + env(safe-area-inset-top, 0px)); right: 54px; z-index: -1;")],
    run: checkMessages, why: /^messages: something on the page covers/,
  },
  { test: "real library", what: "the library's loose security level", edits: [lib('securityLevel: "strict"', 'securityLevel: "loose"')], run: (bp, b) => checkLibrary(bp, b, GIVE_UP), why: /^mermaid-strict: (event handlers|\d+ script elements|javascript: addresses|the text of the diagram ran)/ },
  { test: "real library", what: "a bad diagram's error has no lead", edits: [lib('note.textContent = "图画不出来：" + message;', "note.textContent = message;")], run: (bp, b) => checkLibrary(bp, b, GIVE_UP), why: /^mermaid-head: the bad block shows no error/ },
  { test: "real library", what: "a copy of a diagram keeps the ids of the first", edits: [lib('known.svg.replaceAll(known.id, "mermaid-" + ++serial)', "known.svg")], run: (bp, b) => checkLibrary(bp, b, GIVE_UP), why: /^mermaid-ids: / },
  { test: "real library", what: "the diagram's frontmatter is cut off before it is drawn", edits: [lib("await mermaid.render(id, source);", 'await mermaid.render(id, source.replace(/^---[\\s\\S]*?---\\n/, ""));')], run: (bp, b) => checkLibrary(bp, b, GIVE_UP), why: /^mermaid-own: the diagram asks for the dark theme/ },
  {
    test: "fit", what: "every diagram is drawn at its own width", edits: [page("width: calc(min(var(--natural), 100%) * var(--zoom, 1));", "width: var(--natural);")],
    run: (bp, b) => checkFitWindows(bp, b, () => {}, GIVE_UP), why: /^mermaid-fit: /,
  },
  {
    test: "zoom", what: "the enlarged diagram is centered with flex, out of reach on the left",
    edits: [page(".mermaid-fig { overflow-x: auto; ", ".mermaid-fig { display: flex; justify-content: center; overflow-x: auto; "), page("display: block; margin-inline: auto; ", "display: block; flex: none; ")],
    run: async (bp, b) => { await showHead(bp, b, seedPipeline); return checkZoom(bp, GIVE_UP); }, why: /^mermaid-zoom: the left end of the enlarged diagram cannot be scrolled into its box/,
  },
  {
    test: "zoom", what: "the diagram is out of the box's flow, so its right end is out of reach", edits: [page("display: block; margin-inline: auto; ", "position: absolute; display: block; ")],
    run: async (bp, b) => { await showHead(bp, b, seedPipeline); return checkZoom(bp, GIVE_UP); }, why: /^mermaid-zoom: the right end of the enlarged diagram cannot be scrolled into its box/,
  },
  {
    test: "size buttons", what: "100% draws the width of the box", edits: [lib("else set(ownSize() * part, middle());", "else set(part, middle());")],
    run: async (bp, b) => { await showHead(bp, b, seedPipeline); return atNarrow(bp, () => checkActual(bp, GIVE_UP)); }, why: /^mermaid-actual: the 100% button draws the diagram/,
  },
  {
    test: "keep", what: "the item's diagrams are drawn after its scroll is restored", edits: [app("drawMermaid(pane);", "")],
    run: async (bp, b) => { const id = await showHead(bp, b, seedPipeline); return checkKeep(bp, b, id, GIVE_UP); }, why: /^mermaid-keep: after a live update that left its source alone the page is scrolled/,
  },
  {
    test: "colors", what: "the dark scheme draws the light theme", edits: [lib('theme = dark() ? "dark" : "default"', 'theme = "default"')],
    run: async (bp, b) => { await showHead(bp, b, seedOne); return checkColors(bp, GIVE_UP); }, why: /^mermaid-colors \(dark\)/,
  },
];

for (const c of CASES) test(`${c.test} — spoiled: ${c.what}`, { timeout: 5 * 60_000 }, async t => {
  const board = await startBoard(t, { webDir: await variantPage(t, c.edits) }), browser = await launch(t);
  const bp = await BoardPage.open(browser, board, openAll(board));
  const got = await c.run(bp, board), hit = got.find(l => c.why.test(l));
  console.log(`SPOILED ${c.test} | ${c.what} | ${hit ? "RED: " + hit.slice(0, 200) : "NOT CAUGHT; it reported: " + (got.map(l => l.slice(0, 160)).join(" / ") || "nothing")}`);
  assert.ok(hit, `the check does not report: ${c.what}`);
});
