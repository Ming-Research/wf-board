// TEMPORARY (ci-browser-lane): shows that each test of test/e2e/browser.e2e.ts fails on a page with the thing it guards spoiled. Each case
// serves the current page with a literal edit applied while it is bundled, runs the check the test runs, and must get a violation of the
// family the edit belongs to. Deleted before the last full CI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard, launch, BoardPage, openAll, variantWeb } from "./harness.ts";
import type { BoardServer, Revert } from "./harness.ts";
import { oracle, checkFullWidth, checkPlanCardLayout, checkCardFold, checkDifficultyChipLayout, checkProgressBands } from "./invariants.ts";
import { checkSmoke, cardSample, checkAgentList, checkMessages } from "./browser-checks.ts";
import { showHead, atNarrow, checkLibrary, checkFitWindows, checkZoom, checkActual, checkKeep, checkColors, seedPipeline, seedOne } from "./mermaid-checks.ts";
import { checkCompact, measure, compactViolations, MIN_RUN } from "./mermaid-compact.ts";
import type { Measure, Want } from "./mermaid-compact.ts";

interface Edit { file: "index.html" | "app.ts" | "mermaid.ts" | "mermaid-entry.ts"; find: string; replace: string }

/** A page directory serving the current page with `edits` applied while it is bundled (test/e2e/variant.ts). */
const variantPage = (t: Parameters<typeof startBoard>[0], edits: Edit[]) =>
  variantWeb(t, edits.map((e): Revert => ({ file: ("web/" + e.file) as Revert["file"], edit: "spoiled", find: e.find, replace: e.replace })));

const GIVE_UP = 8_000;
const page = (find: string, replace: string): Edit => ({ file: "index.html", find, replace });
const app = (find: string, replace: string): Edit => ({ file: "app.ts", find, replace });
const lib = (find: string, replace: string): Edit => ({ file: "mermaid.ts", find, replace });
const entry = (find: string, replace: string): Edit => ({ file: "mermaid-entry.ts", find, replace });
const WRAP = "body.wide .wrap { flex: 1; min-height: 0; max-width: none; min-width: 688px;";
const ITEM_BODY = "body.wide #item-detail .item > .body, body.wide #item-detail .item > .notes { padding-left: 0; }";
const LOG = ".log { display: flex; flex-direction: column; gap: 6px; margin-top: 4px;";

interface Case { test: string; what: string; edits: Edit[]; run: (bp: BoardPage, board: BoardServer) => Promise<string[]>; why: RegExp | RegExp[] }
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
    test: "messages", what: "a layer of the page lies over the open list of messages, not over its button",
    edits: [page(".messages-panel { margin-top: 6px;", 'body::after { content: ""; position: fixed; top: 40px; right: 0; width: 100%; height: 500px; z-index: 50; }\n.messages-panel { margin-top: 6px;')],
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
  // The compact drawing (checkCompact): the parts a variant takes out, from the former test/e2e/mermaid-compact.e2e.ts.
  { test: "compact", what: "ELK keeps the library's own gaps (the layer around ELK is not installed)", edits: [entry("elk.layout = function", "void function")], run: (bp, b) => checkCompact(bp, b, () => {}, GIVE_UP), why: [/^mermaid-compact \(role\): the diagram is \d+ px high, over the 2500 px/, /^mermaid-compact \(role\): the boxes are \d+ px apart at the closest, not the 20 px/] },
  { test: "compact", what: "the page asks the library for nothing: its own look and gaps", edits: [lib("...COMPACT,", "")], run: (bp, b) => checkCompact(bp, b, () => {}, GIVE_UP), why: [/^mermaid-compact \(role\): the diagram is \d+ px high, over the 2500 px/, /^mermaid-compact \(role\): the boxes are \d+ px apart at the closest, not the 20 px/, /^mermaid-compact \(lanes\): the diagram is \d+ px high, over the 1900 px/] },
  { test: "compact", what: "the layer asks for 20 px whatever the diagram's own settings say", edits: [entry("const { nodeSpacing = 50, rankSpacing = 50 } = mermaid.mermaidAPI.getConfig().flowchart ?? {};", "const nodeSpacing = 20, rankSpacing = 20;")], run: (bp, b) => checkCompact(bp, b, () => {}, GIVE_UP), why: /^mermaid-compact \(own gaps\): the boxes are \d+ px apart at the closest, not the 60 px/ },
  { test: "compact", what: "the library draws with dagre", edits: [lib("...COMPACT,", '...COMPACT, layout: "dagre",')], run: (bp, b) => checkCompact(bp, b, () => {}, GIVE_UP), why: /^mermaid-compact \(role\): \d+ of 28 arrows enter a box from the side/ },
  { test: "compact", what: "a straight run of 3 px before an arrowhead", edits: [entry("const APPROACH = 12;", "const APPROACH = 3;")], run: (bp, b) => checkCompact(bp, b, () => {}, GIVE_UP), why: /^mermaid-compact \(role\): \d+ lines cross a box: N9->N11 crosses N10/ },
];

for (const c of CASES) test(`${c.test} — spoiled: ${c.what}`, { timeout: 5 * 60_000 }, async t => {
  const board = await startBoard(t, { webDir: await variantPage(t, c.edits) }), browser = await launch(t);
  const bp = await BoardPage.open(browser, board, openAll(board));
  const got = await c.run(bp, board), wants = Array.isArray(c.why) ? c.why : [c.why];
  const hits = wants.map(w => got.find(l => w.test(l)));
  console.log(`SPOILED ${c.test} | ${c.what} | ${hits.every(Boolean) ? "RED: " + hits.map(h => h!.slice(0, 160)).join(" || ") : "NOT CAUGHT (" + hits.filter(h => !h).length + " of " + hits.length + "); it reported: " + (got.map(l => l.slice(0, 160)).join(" / ") || "nothing")}`);
  assert.ok(hits.every(Boolean), `the check does not report: ${c.what}`);
});

// Hand-made drawings in the shape the library draws: boxes A and B 60 px apart with one arrow between them, and one wrong thing each (from the former mermaid-compact.e2e.ts).
const drawing = (...parts: string[]) => `<style>body { margin: 0 }</style><div class="mermaid-block"><svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">${parts.join("")}</svg></div>`;
const box = (id: string, x: number, y: number, w: number, h: number) => `<g class="node" data-id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></g>`;
const line = (from: string, to: string, d: string) => `<path data-edge="true" data-id="L_${from}_${to}_0" d="${d}" fill="none" stroke="black"/>`;
const label = (x: number, y: number, w: number, h: number) => `<g class="edgeLabel"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></g>`;
const AB = [box("A", 50, 20, 100, 40), box("B", 50, 120, 100, 40)];
const STRAIGHT = line("A", "B", "M100 60V120");
const WANT: Want = { arrows: 1, height: 300, gap: 60 };

test("compact — the measurement tells a drawing with nothing wrong from drawings with one thing wrong each", { timeout: 5 * 60_000 }, async t => {
  const browser = await launch(t), page = await browser.newPage();
  const violations = async (html: string, want: Want = WANT) => {
    await page.setContent(html);
    const m: Measure = await page.locator(".mermaid-block").evaluate(measure);
    return compactViolations("drawing", m, want);
  };
  const say = (what: string, v: string[], why?: RegExp) => console.log(`SPOILED compact drawing | ${what} | ${why ? (v.some(l => why.test(l)) ? "RED: " + v.find(l => why.test(l))!.slice(0, 160) : "NOT CAUGHT; it reported: " + (v.join(" / ") || "nothing")) : (v.length ? "FALSE ALARM: " + v.join(" / ") : "nothing reported, as it must")}`);
  const cases: Array<[string, string, Want | undefined, RegExp | undefined]> = [
    ["nothing wrong", drawing(...AB, STRAIGHT, label(110, 80, 40, 20)), undefined, undefined],
    ["the arrow's last stretch is horizontal, into the side of B", drawing(...AB, line("A", "B", "M150 40H200V140H150")), undefined, /^mermaid-compact \(drawing\): 1 of 1 arrows enter a box from the side: A->B/],
    ["the arrow's last straight stretch is 3 px", drawing(...AB, line("A", "B", "M100 60V117H80V120")), undefined, new RegExp(`^mermaid-compact \\(drawing\\): an arrow runs straight for [0-4] px before its head, under ${MIN_RUN} px`)],
    ["a label across the lower edge of A", drawing(...AB, STRAIGHT, label(120, 40, 60, 30)), undefined, /^mermaid-compact \(drawing\): 1 edge labels cover a box/],
    ["two labels across each other", drawing(...AB, STRAIGHT, label(110, 80, 40, 20), label(130, 85, 40, 20)), undefined, /^mermaid-compact \(drawing\): 1 pairs of edge labels cover each other/],
    ["a third box on the line from A to B", drawing(...AB, box("C", 60, 80, 80, 20), STRAIGHT), { arrows: 1, height: 300 }, /^mermaid-compact \(drawing\): 1 lines cross a box: A->B crosses C/],
    ["the boxes are 60 px apart where 20 were asked", drawing(...AB, STRAIGHT), { ...WANT, gap: 20 }, /^mermaid-compact \(drawing\): the boxes are 60 px apart at the closest, not the 20 px/],
    ["the drawing is 300 px high where 200 were allowed", drawing(...AB, STRAIGHT), { ...WANT, height: 200 }, /^mermaid-compact \(drawing\): the diagram is 300 px high, over the 200 px/],
  ];
  let bad = 0;
  for (const [what, html, want, why] of cases) {
    const v = await violations(html, want);
    say(what, v, why);
    if (why ? !v.some(l => why.test(l)) : v.length) bad++;
  }
  assert.equal(bad, 0, "every hand-made drawing is told apart");
});
