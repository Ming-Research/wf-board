// TEMPORARY (study mermaid-compact-study): measures how compact and how readable the synthetic charts come out under several layout
// settings, counts the arrows that enter a box from the side, and takes screenshots of each as the page shows it. Run by
// .github/workflows/compact.yml; all of it is removed when the study ends.

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { ops } from "../../src/ops.ts";
import { startBoard, launch, BoardPage, ROOT } from "./harness.ts";
import { ROLE, ROLE_NARROW, ROLE_OWN, LANES, SMALL } from "./compact-charts.tmp.ts";

const cleanups: Array<() => unknown> = [];
const t = { after: (fn: () => unknown) => { cleanups.push(fn); } };
const fence = (code: string) => "```mermaid\n" + code + "\n```";
const OUT = join(process.cwd(), "shots");

interface Variant { name: string; cfg?: Record<string, unknown>; elk?: Record<string, unknown>; css?: string; window?: number; tree?: number }
const DAGRE = { layout: "dagre", flowchart: { look: "classic", nodeSpacing: 14, rankSpacing: 24, padding: 6, diagramPadding: 4, wrappingWidth: 100, minNodeWidth: 56 } };
const CLASSIC = { look: "classic", flowchart: { look: "classic", padding: 6 } };
const LAYERS = (nn: number, layers: number, edge: number) => ({ "elk.spacing.nodeNode": nn, "elk.layered.spacing.nodeNodeBetweenLayers": layers, "elk.layered.spacing.edgeNodeBetweenLayers": edge, "elk.spacing.edgeNode": edge, "elk.layered.spacing.edgeEdgeBetweenLayers": 10, "elk.spacing.edgeEdge": 10 });
const PAGE = (padding: number) => ({ look: "classic", flowchart: { look: "classic", padding, nodeSpacing: 20, rankSpacing: 20 } });
// A diagram as wide as the detail pane rather than the text column: the pane is a container, and a block takes its width.
const WIDE = "body.wide #item-detail { container-type: inline-size; } .rich .mermaid-block { width: 100cqw; max-width: 100cqw; }";
const C = { cfg: PAGE(8), elk: { fromConfig: { edge: 12 } } };
// The page's fit, but never smaller than text 12 px high on the screen (the library writes 16 px text): a wider diagram scrolls sideways.
const MIN12 = ".mermaid-fig svg { width: calc(max(min(var(--natural), 100%), var(--natural) * 0.75) * var(--zoom, 1)) !important; }";
const VARIANTS: Variant[] = JSON.parse(process.env.VARIANTS ?? "null") ?? [
  { name: "elk-narrow", tree: 2000 },
  { name: "c-p8-e12-narrow", ...C, tree: 2000 },
  { name: "c-p8-e12-narrow-min12", ...C, tree: 2000, css: MIN12 },
  { name: "c-p8-e12-min12", ...C, css: MIN12 },
  { name: "c-p8-e12-2400", ...C, window: 2400 },
];
const CHARTS: Array<[string, string]> = [["role", ROLE], ["role-narrow", ROLE_NARROW], ["role-own", ROLE_OWN], ["lanes", LANES], ...SMALL];

/** A page directory serving the current page with the library built from the hooked entry. */
async function pageDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-compact-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "index.html"), await readFile(join(ROOT, "web/index.html"), "utf8"));
  await symlink(join(ROOT, "web/dist/app.js"), join(dir, "dist/app.js"));
  await build({ entryPoints: [join(ROOT, "test/e2e/compact-entry.tmp.ts")], bundle: true, format: "esm", target: "es2022", minify: true, outfile: join(dir, "dist/mermaid.js"), logLevel: "silent" });
  return dir;
}

/** Runs in the page: what one drawn diagram measures. Lengths are in the diagram's own units (its viewBox), `screenFont` in screen px. */
function measure(block: Element) {
  const svg = block.querySelector("svg")!;
  const vb = svg.viewBox.baseVal, box = svg.getBoundingClientRect(), s = box.width / vb.width;
  const rel = (r: DOMRect) => ({ left: (r.left - box.left) / s, top: (r.top - box.top) / s, right: (r.right - box.left) / s, bottom: (r.bottom - box.top) / s });
  const nodes = new Map<string, { left: number; top: number; right: number; bottom: number }>();
  for (const n of svg.querySelectorAll("g.node")) {
    const id = n.getAttribute("data-id") ?? /flowchart-(.+)-\d+$/.exec(n.id)?.[1] ?? n.id;
    const shape = n.querySelector("rect, polygon, path, circle, ellipse") ?? n;
    nodes.set(id, rel(shape.getBoundingClientRect()));
  }
  const point = (path: SVGPathElement, at: number) => {
    const p = path.getPointAtLength(at), m = path.getScreenCTM()!;
    const q = new DOMPoint(p.x, p.y).matrixTransform(m);
    return { x: (q.x - box.left) / s, y: (q.y - box.top) / s };
  };
  const ends: string[] = [], runs: number[] = [];
  let side = 0, horizontal = 0, arrows = 0, through = 0;
  const throughList: string[] = [];
  for (const path of svg.querySelectorAll<SVGPathElement>('path[data-edge="true"]')) {
    const id = path.getAttribute("data-id") ?? "", m = /^L_(.+)_(.+)_\d+$/.exec(id);
    if (!m) continue;
    const [, from, to] = m, target = nodes.get(to!), source = nodes.get(from!);
    const length = path.getTotalLength();
    // Through: points of the line inside a box that is neither of its ends.
    for (const [nid, r] of nodes) {
      if (nid === from || nid === to) continue;
      let inside = false;
      for (let at = 0; at <= length && !inside; at += 3) { const p = point(path, at); inside = p.x > r.left + 2 && p.x < r.right - 2 && p.y > r.top + 2 && p.y < r.bottom - 2; }
      if (inside) { through++; throughList.push(`${from}->${to} through ${nid}`); }
    }
    // Every edge of the measured flow charts ends in an arrow (the library draws the heads apart from the line).
    if (!target) continue;
    arrows++;
    const p = point(path, length), q = point(path, Math.max(0, length - 6));
    // The straight run before the tip, along the direction of its last 2 units: an arrowhead sits on a bend when it is short.
    const r = point(path, Math.max(0, length - 2)), dx = p.x - r.x, dy = p.y - r.y, n = Math.hypot(dx, dy) || 1;
    let run = 0;
    while (run < 60 && run < length) { const o = point(path, length - run - 1); if (Math.abs((o.x - p.x) * dy / n - (o.y - p.y) * dx / n) > 1) break; run++; }
    runs.push(run);
    const flat = Math.abs(dx) > Math.abs(dy);
    // A side entry: the arrow's tip is level with the box (between its top and bottom), not above or below it.
    const level = p.y > target.top + 3 && p.y < target.bottom - 3;
    if (flat) horizontal++;
    if (level) { side++; ends.push(`${from}->${to}`); }
    void source;
  }
  // The smallest clearance between two boxes (negative: they overlap), and edge labels that cover a box or another label.
  const list = [...nodes.values()];
  let gap = Infinity;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i]!, b = list[j]!;
    gap = Math.min(gap, Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom));
  }
  const labels = [...svg.querySelectorAll("g.edgeLabel")].map(l => rel(l.getBoundingClientRect())).filter(r => r.right - r.left > 1 && r.bottom - r.top > 1);
  const hit = (a: { left: number; top: number; right: number; bottom: number }, b: typeof a) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
  let labelOnBox = 0, labelOnLabel = 0;
  for (const l of labels) for (const r of list) if (hit(l, r)) labelOnBox++;
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) if (hit(labels[i]!, labels[j]!)) labelOnLabel++;
  const area = list.reduce((sum, r) => sum + (r.right - r.left) * (r.bottom - r.top), 0);
  const text = svg.querySelector(".nodeLabel, .label foreignObject div, text");
  const font = text ? parseFloat(getComputedStyle(text).fontSize) : NaN;
  return {
    box: block.querySelector(".mermaid-fig")?.clientWidth ?? 0, w: Math.round(vb.width), h: Math.round(vb.height), shown: Math.round(box.width), shownH: Math.round(box.height),
    screenFont: Math.round(font * s * 10) / 10, fill: Math.round(area / (vb.width * vb.height) * 100),
    arrows, side, horizontal, ends, minRun: Math.min(...runs), shortRuns: runs.filter(r => r < 10).length,
    boxes: [...nodes].map(([k, r]) => `${k}:${Math.round(r.left)}-${Math.round(r.right)}@${Math.round(r.top)}`).join(" "), gap: Math.round(gap), labelOnBox, labelOnLabel, through, throughList,
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await launch(t);
  const board = await startBoard(t, { webDir: await pageDir() }), id = board.gen.witness.code;
  const bp = await BoardPage.open(browser, board);
  // Tall enough that the longest diagram is painted whole in the screenshot.
  await bp.page.setViewportSize({ width: 1500, height: 4000 });
  const write = async (head: string) => {
    const it = board.store.snapshot().items[id]!;
    await ops(board.store).updateItem({ author: it.group, id, rev: it.rev, head, reason: "measure" });
  };
  await write("measure");
  await bp.select(id);
  const results: Record<string, Record<string, unknown>> = {};
  for (const v of VARIANTS) {
    await bp.page.evaluate(v => {
      const g = globalThis as unknown as Record<string, unknown>; g.__elk = v.elk; g.__mcfg = v.cfg;
      document.getElementById("variant-css")?.remove();
      if (v.css) { const style = document.createElement("style"); style.id = "variant-css"; style.textContent = v.css; document.head.append(style); }
    }, v);
    await bp.page.setViewportSize({ width: v.window ?? 1500, height: 4000 });
    // A comment naming the variant makes each source new, so the page draws it again with the variant's settings.
    const head = CHARTS.map(([name, code]) => `**${name}**\n\n` + fence(code + `\n%% ${v.name}`)).join("\n\n");
    const seen = await bp.changes();
    await write(head);
    await bp.waitChanges(seen + 1);
    await bp.page.waitForFunction(([count, tag]) => {
      const blocks = [...document.querySelectorAll<HTMLElement>("#item-detail .mermaid-block")];
      return blocks.length === count && blocks.every(b => (b.querySelector("code")?.textContent ?? "").includes(tag as string) && (b.dataset.state === "done" || b.dataset.state === "error"));
    }, [CHARTS.length, "%% " + v.name] as const, { timeout: 120_000 });
    // The tree's width last, since the page sets it again when the window changes: a wide tree leaves the detail pane at its narrowest.
    if (v.tree) {
      await bp.page.evaluate(tree => { const wrap = document.querySelector<HTMLElement>(".wrap")!; wrap.dataset.tree = wrap.style.getPropertyValue("--tree-width"); wrap.style.setProperty("--tree-width", tree + "px"); }, v.tree);
      await bp.page.waitForTimeout(500);
    }
    const blocks = bp.page.locator("#item-detail .mermaid-block");
    for (let i = 0; i < CHARTS.length; i++) {
      const name = CHARTS[i]![0];
      const state = await blocks.nth(i).getAttribute("data-state");
      if (state !== "done") { console.log(`${v.name} ${name}: ERROR ${await blocks.nth(i).innerText()}`); continue; }
      const m = await blocks.nth(i).evaluate(measure);
      results[`${v.name} ${name}`] = m;
      console.log(`${v.name} ${name}: ${JSON.stringify(m)}`);
      await blocks.nth(i).screenshot({ path: join(OUT, `${name}-${v.name}.png`) });
      if (name.startsWith("role") || name === "lanes") {
        // The same drawing at its own size, as the reader sees it zoomed in.
        await blocks.nth(i).evaluate(block => {
          const copy = block.querySelector("svg")!.cloneNode(true) as SVGSVGElement, holder = document.createElement("div");
          holder.id = "natural";
          holder.style.cssText = "position:absolute;left:0;top:0;z-index:99;background:#fff;padding:8px";
          copy.style.cssText = `width:${copy.viewBox.baseVal.width}px;max-width:none;height:auto`;
          holder.append(copy);
          document.body.append(holder);
        });
        await bp.page.locator("#natural").screenshot({ path: join(OUT, `${name}-${v.name}-natural.png`) });
        await bp.page.evaluate(() => document.getElementById("natural")?.remove());
      }
    }
    await bp.page.emulateMedia({ colorScheme: "dark" });
    await bp.page.waitForTimeout(3_000);
    await bp.page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>("#item-detail .mermaid-block")].every(b => b.dataset.state === "done" || b.dataset.state === "error"), null, { timeout: 120_000 });
    await blocks.nth(0).screenshot({ path: join(OUT, `role-${v.name}-dark.png`) });
    await bp.page.emulateMedia({ colorScheme: "light" });
    await bp.page.waitForTimeout(3_000);
    if (v.tree) await bp.page.evaluate(() => { const wrap = document.querySelector<HTMLElement>(".wrap")!; wrap.style.setProperty("--tree-width", wrap.dataset.tree ?? ""); });
    const elk = await bp.page.evaluate(() => (globalThis as unknown as { __elkIn?: { layoutOptions?: unknown } }).__elkIn?.layoutOptions);
    console.log(`${v.name} last ELK root options: ${JSON.stringify(elk)}`);
  }
  await writeFile(join(OUT, "results.json"), JSON.stringify(results, null, 1));
  // The table of the role chart.
  console.log("\nvariant | box | w×h | shown w×h | font on screen | fill% | side/arrows | horizontal | min run | runs<10 | gap | label on box | label on label | through");
  for (const v of VARIANTS) {
    const m = results[`${v.name} role`] as ReturnType<typeof measure> | undefined;
    if (m) console.log(`${v.name} | ${m.box} | ${m.w}×${m.h} | ${m.shown}×${m.shownH} | ${m.screenFont} | ${m.fill} | ${m.side}/${m.arrows} | ${m.horizontal} | ${m.minRun} | ${m.shortRuns} | ${m.gap} | ${m.labelOnBox} | ${m.labelOnLabel} | ${m.through}`);
  }
}

try { await main(); } finally { for (const fn of cleanups.reverse()) await fn(); }
