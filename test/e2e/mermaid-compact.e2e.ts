// Whether the page draws a mermaid diagram compact, in headless Chromium against the real server and the real library (web/mermaid.ts asks
// for the classic look, padding 8 and 20 px between boxes and between layers; web/mermaid-entry.ts makes ELK, the layout the library draws
// with, keep those gaps). Two synthetic charts of the shape of the owner's flow charts, one a role's chart and one with three lanes, must
// come out short; their boxes are as far apart as the page asked, their arrows enter a box from above and run straight a few px before
// it, and no label covers a box or another label and no line crosses a box that is not its end. A settings block at the start of a diagram
// still wins over the page's gaps. Each requirement also runs on a page with the one part that keeps it taken out (an edit applied while
// the page and the library are bundled, test/e2e/variant.ts), where the check must report it; what the measurement says of a drawing is
// shown on hand-made drawings, one wrong in one way. Docs/design.md, section 7, Diagrams.
// Run by CI's e2e job (npm run test:e2e), not on the owner's Mac.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startBoard, launch, BoardPage, variantWeb } from "./harness.ts";
import type { Revert } from "./harness.ts";
import { ENGINEER, ENGINEER_OWN, LANES, fence } from "./mermaid-charts.ts";
import { setHead } from "./mermaid-checks.ts";
import { measure, measured, compactViolations, MIN_RUN } from "./mermaid-compact.ts";
import type { Measure, Want } from "./mermaid-compact.ts";

type Hooks = Parameters<typeof startBoard>[0] & { diagnostic(message: string): void };

/** How long a check waits for a diagram, and on a page where it expects to find a fault. */
const WAIT = 60_000;
const LONG = { timeout: 5 * 60_000 };

// The sizes the page's compact drawing stays under (measured on these charts in CI: 2430 and 1801 px; the library's own drawing is 3214 and 2443).
const ENGINEER_WANT: Want = { arrows: 28, height: 2500, gap: 20 };
const LANES_WANT: Want = { arrows: 17, height: 1900, gap: 20 };
// The settings block of ENGINEER_OWN asks for 60 px between boxes and layers, and nothing else is asked of the drawing.
const OWN_WANT: Want = { arrows: 28, gap: 60 };

/** A page open on a board whose witness item has `code` as its head, served from the current page or from a variant of it. */
async function open(t: Hooks, code: string, reverts: Revert[] = []): Promise<BoardPage> {
  const board = await startBoard(t, reverts.length ? { webDir: await variantWeb(t, reverts) } : {}), browser = await launch(t), id = board.gen.witness.code;
  await setHead(board, id, fence(code));
  const bp = await BoardPage.open(browser, board);
  await bp.select(id);
  return bp;
}

/** The violations of `want` by the first diagram of the open item; what it measured goes to the CI log. */
async function check(t: Hooks, bp: BoardPage, name: string, want: Want): Promise<string[]> {
  const m = await measured(bp, WAIT);
  if (typeof m === "string") return [`mermaid-compact (${name}): ${m}`];
  t.diagnostic(`${name}: ${JSON.stringify(m)}`);
  return compactViolations(name, m, want);
}

const none = (v: string[]) => assert.equal(v.length, 0, v.length + " violations:\n" + v.join("\n"));
/** The check must report a line that says `why`. */
const caught = (v: string[], why: RegExp) => assert.ok(v.some(l => why.test(l)), `the check must report ${String(why)}; it reported:\n${v.join("\n") || "(nothing)"}`);

test("a role's chart is short, its boxes are 20 px apart, its arrows enter from above and nothing covers anything", LONG, async t => {
  none(await check(t, await open(t, ENGINEER), "role", ENGINEER_WANT));
});
test("a chart with lanes is short, and the boxes in its lanes are 20 px apart too", LONG, async t => {
  none(await check(t, await open(t, LANES), "lanes", LANES_WANT));
});
test("the gaps in a diagram's own settings block win over the page's", LONG, async t => {
  none(await check(t, await open(t, ENGINEER_OWN), "own gaps", OWN_WANT));
});

// The parts a variant takes out; each is the one thing a requirement rests on.
// The library's own gaps go to ELK: the layer in the library's entry is not installed.
const NO_LAYER: Revert = { file: "web/mermaid-entry.ts", edit: "ELK keeps the gaps the library wrote", find: "elk.layout = function", replace: "void function" };
// The layer asks for 20 px whatever the diagram's configuration says.
const FIXED_GAPS: Revert = { file: "web/mermaid-entry.ts", edit: "the layer ignores the diagram's own gaps", find: "const { nodeSpacing = 50, rankSpacing = 50 } = mermaid.mermaidAPI.getConfig().flowchart ?? {};", replace: "const nodeSpacing = 20, rankSpacing = 20;" };
// A straight run of 3 px before an arrowhead, which puts the head on a bend.
const SHORT_RUN: Revert = { file: "web/mermaid-entry.ts", edit: "the run before an arrowhead is 3 px", find: "const APPROACH = 12;", replace: "const APPROACH = 3;" };
// The page asks the library for nothing: its own look and its own gaps.
const NO_DEFAULTS: Revert = { file: "web/mermaid.ts", edit: "the page leaves the library's look and gaps alone", find: "...COMPACT,", replace: "" };
// The page asks for the library's other layout, which draws a line from the side of a box.
const DAGRE: Revert = { file: "web/mermaid.ts", edit: "the library draws with dagre", find: "...COMPACT,", replace: '...COMPACT, layout: "dagre",' };

test("the same check on a page whose library keeps its own gaps reports the height and the gaps", LONG, async t => {
  const v = await check(t, await open(t, ENGINEER, [NO_LAYER]), "role", ENGINEER_WANT);
  caught(v, /^mermaid-compact \(role\): the diagram is \d+ px high, over the 2500 px/);
  caught(v, /^mermaid-compact \(role\): the boxes are \d+ px apart at the closest, not the 20 px/);
});
test("the same check on a page that asks the library for nothing reports the height and the gaps", LONG, async t => {
  const v = await check(t, await open(t, ENGINEER, [NO_DEFAULTS]), "role", ENGINEER_WANT);
  caught(v, /^mermaid-compact \(role\): the diagram is \d+ px high, over the 2500 px/);
  caught(v, /^mermaid-compact \(role\): the boxes are \d+ px apart at the closest, not the 20 px/);
});
test("the same check on the lanes with the library's own gaps reports the height", LONG, async t => {
  caught(await check(t, await open(t, LANES, [NO_LAYER]), "lanes", LANES_WANT), /^mermaid-compact \(lanes\): the diagram is \d+ px high, over the 1900 px/);
});
test("the same check on a page whose layer ignores the diagram's own gaps reports the gap", LONG, async t => {
  caught(await check(t, await open(t, ENGINEER_OWN, [FIXED_GAPS]), "own gaps", OWN_WANT), /^mermaid-compact \(own gaps\): the boxes are \d+ px apart at the closest, not the 60 px/);
});
test("the same check on a page that draws with dagre reports the arrows that enter from the side", LONG, async t => {
  caught(await check(t, await open(t, ENGINEER, [DAGRE]), "role", ENGINEER_WANT), /^mermaid-compact \(role\): \d+ of 28 arrows enter a box from the side/);
});
test("the same check on a page with a run of 3 px before the arrowheads reports the run", LONG, async t => {
  caught(await check(t, await open(t, ENGINEER, [SHORT_RUN]), "role", ENGINEER_WANT), new RegExp(`^mermaid-compact \\(role\\): an arrow runs straight for \\d+ px before its head, under ${MIN_RUN} px`));
});

// Hand-made drawings in the shape the library draws: boxes A and B 60 px apart with one arrow between them, and one wrong thing each.
const drawing = (...parts: string[]) => `<style>body { margin: 0 }</style><div class="mermaid-block"><svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">${parts.join("")}</svg></div>`;
const box = (id: string, x: number, y: number, w: number, h: number) => `<g class="node" data-id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></g>`;
const line = (from: string, to: string, d: string) => `<path data-edge="true" data-id="L_${from}_${to}_0" d="${d}" fill="none" stroke="black"/>`;
const label = (x: number, y: number, w: number, h: number) => `<g class="edgeLabel"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></g>`;
const AB = [box("A", 50, 20, 100, 40), box("B", 50, 120, 100, 40)];
const STRAIGHT = line("A", "B", "M100 60V120");
const WANT: Want = { arrows: 1, height: 300, gap: 60 };

test("the measurement tells a drawing with nothing wrong from drawings with one thing wrong each", LONG, async t => {
  const browser = await launch(t), page = await browser.newPage();
  const violations = async (html: string, want: Want = WANT) => {
    await page.setContent(html);
    const m: Measure = await page.locator(".mermaid-block").evaluate(measure);
    return compactViolations("drawing", m, want);
  };
  none(await violations(drawing(...AB, STRAIGHT, label(110, 80, 40, 20))));
  // The arrow's last stretch is horizontal, into the side of B.
  caught(await violations(drawing(...AB, line("A", "B", "M150 40H200V140H150"))), /^mermaid-compact \(drawing\): 1 of 1 arrows enter a box from the side: A->B/);
  // The arrow's last straight stretch is 3 px: the head sits on a bend.
  caught(await violations(drawing(...AB, line("A", "B", "M100 60V117H80V120"))), new RegExp(`^mermaid-compact \\(drawing\\): an arrow runs straight for [0-4] px before its head, under ${MIN_RUN} px`));
  // A label across the lower edge of A.
  caught(await violations(drawing(...AB, STRAIGHT, label(120, 40, 60, 30))), /^mermaid-compact \(drawing\): 1 edge labels cover a box/);
  // Two labels across each other, clear of the boxes.
  caught(await violations(drawing(...AB, STRAIGHT, label(110, 80, 40, 20), label(130, 85, 40, 20))), /^mermaid-compact \(drawing\): 1 pairs of edge labels cover each other/);
  // A third box on the line from A to B.
  caught(await violations(drawing(...AB, box("C", 60, 80, 80, 20), STRAIGHT), { arrows: 1, height: 300 }), /^mermaid-compact \(drawing\): 1 lines cross a box: A->B crosses C/);
  // The boxes are 60 px apart where 20 were asked.
  caught(await violations(drawing(...AB, STRAIGHT), { ...WANT, gap: 20 }), /^mermaid-compact \(drawing\): the boxes are 60 px apart at the closest, not the 20 px/);
  // The drawing is 300 px high where 200 were allowed.
  caught(await violations(drawing(...AB, STRAIGHT), { ...WANT, height: 200 }), /^mermaid-compact \(drawing\): the diagram is 300 px high, over the 200 px/);
});
