// What the compactness checks of the mermaid diagrams (test/e2e/mermaid-compact.e2e.ts) share: the measurement of one drawn diagram, made in
// the page, and what it must show. A diagram is compact when it is short, its boxes are as far apart as the page asked and no further, its
// arrows enter a box from above and run straight a little before it, and nothing it draws covers anything else.

import type { BoardPage } from "./harness.ts";
import { settled } from "./mermaid-checks.ts";

/** What one drawn diagram measures. Lengths are in the diagram's own units (its view box), whatever size the page draws it at. */
export interface Measure {
  /** The size of the drawing. */
  w: number; h: number;
  /** The edges that end in an arrow, and those whose last stretch is horizontal, so the arrow enters the side of a box (a diagram drawn top to bottom). */
  arrows: number; side: string[];
  /** The shortest straight run before an arrowhead: a shorter one leaves the head on a bend. */
  minRun: number;
  /** The edge labels that cover a box, and pairs of them that cover each other; the edges that cross a box that is neither of their ends. */
  labelOnBox: number; labelOnLabel: number; through: string[];
  /** The smallest clearance between two boxes (negative: they overlap). */
  gap: number;
}

/** What a diagram must measure: the arrows it has, at most `height` high, and `gap`: the clearance the page asked of the layout between boxes and between layers. */
export interface Want { arrows: number; height?: number; gap?: number }
/** The shortest straight run before an arrowhead, in the diagram's own units. */
export const MIN_RUN = 6;

/** Runs in the page, on the `.mermaid-block` of a drawn diagram (a function of the page alone, so nothing outside it is used). */
export function measure(block: Element): Measure {
  type Rect = { left: number; top: number; right: number; bottom: number };
  const svg = block.querySelector("svg")!;
  const vb = svg.viewBox.baseVal, box = svg.getBoundingClientRect(), s = box.width / vb.width;
  const rel = (r: DOMRect): Rect => ({ left: (r.left - box.left) / s, top: (r.top - box.top) / s, right: (r.right - box.left) / s, bottom: (r.bottom - box.top) / s });
  const nodes = new Map<string, Rect>();
  for (const n of svg.querySelectorAll("g.node")) {
    const id = n.getAttribute("data-id") ?? /flowchart-(.+)-\d+$/.exec(n.id)?.[1] ?? n.id;
    nodes.set(id, rel((n.querySelector("rect, polygon, path, circle, ellipse") ?? n).getBoundingClientRect()));
  }
  const side: string[] = [], through: string[] = [], runs: number[] = [];
  let arrows = 0;
  for (const path of svg.querySelectorAll<SVGPathElement>('path[data-edge="true"]')) {
    const m = /^L_(.+)_(.+)_\d+$/.exec(path.getAttribute("data-id") ?? "");
    if (!m) continue;
    const [, from, to] = m, length = path.getTotalLength(), ctm = path.getScreenCTM()!;
    const at = (along: number) => {
      const p = path.getPointAtLength(along), q = new DOMPoint(p.x, p.y).matrixTransform(ctm);
      return { x: (q.x - box.left) / s, y: (q.y - box.top) / s };
    };
    // The line crosses a box that is neither of its ends.
    const points: Array<{ x: number; y: number }> = [];
    for (let along = 0; along <= length; along += 3) points.push(at(along));
    for (const [id, r] of nodes) {
      if (id === from || id === to) continue;
      if (points.some(p => p.x > r.left + 2 && p.x < r.right - 2 && p.y > r.top + 2 && p.y < r.bottom - 2)) through.push(`${from}->${to} crosses ${id}`);
    }
    if (!nodes.has(to!)) continue;
    arrows++;
    const tip = at(length), before = at(Math.max(0, length - 2)), dx = tip.x - before.x, dy = tip.y - before.y, norm = Math.hypot(dx, dy) || 1;
    if (Math.abs(dx) > Math.abs(dy)) side.push(`${from}->${to}`);
    // The straight run before the tip: along the direction of its last 2 units, as far as the line stays within 1 unit of that line.
    let run = 0;
    while (run < 60 && run < length) {
      const o = at(length - run - 1);
      if (Math.abs((o.x - tip.x) * dy / norm - (o.y - tip.y) * dx / norm) > 1) break;
      run++;
    }
    runs.push(run);
  }
  const list = [...nodes.values()];
  let gap = Infinity;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i]!, b = list[j]!;
    gap = Math.min(gap, Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom));
  }
  const labels = [...svg.querySelectorAll("g.edgeLabel")].map(l => rel(l.getBoundingClientRect())).filter(r => r.right - r.left > 1 && r.bottom - r.top > 1);
  const covers = (a: Rect, b: Rect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
  let labelOnBox = 0, labelOnLabel = 0;
  for (const l of labels) for (const r of list) if (covers(l, r)) labelOnBox++;
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) if (covers(labels[i]!, labels[j]!)) labelOnLabel++;
  return { w: Math.round(vb.width), h: Math.round(vb.height), arrows, side, minRun: runs.length ? Math.min(...runs) : Infinity, labelOnBox, labelOnLabel, through, gap: Math.round(gap) };
}

/** The first diagram under the item's detail once it is drawn, measured; the reason when it is not drawn within `wait`. */
export async function measured(bp: BoardPage, wait: number): Promise<Measure | string> {
  const waited = await settled(bp, 1, wait);
  return waited ?? await bp.page.locator("#item-detail .mermaid-block").first().evaluate(measure);
}

/** The violations of what a diagram called `name` must measure. */
export function compactViolations(name: string, m: Measure, want: Want): string[] {
  const what = `mermaid-compact (${name})`, v: string[] = [];
  if (m.arrows !== want.arrows) v.push(`${what}: ${m.arrows} arrows were measured, expected ${want.arrows}`);
  if (want.height !== undefined && m.h > want.height) v.push(`${what}: the diagram is ${m.h} px high, over the ${want.height} px it must stay under`);
  if (want.gap !== undefined && Math.abs(m.gap - want.gap) > 1) v.push(`${what}: the boxes are ${m.gap} px apart at the closest, not the ${want.gap} px the page asked for`);
  if (m.side.length) v.push(`${what}: ${m.side.length} of ${m.arrows} arrows enter a box from the side: ${m.side.join(", ")}`);
  if (m.minRun < MIN_RUN) v.push(`${what}: an arrow runs straight for ${m.minRun} px before its head, under ${MIN_RUN} px`);
  if (m.labelOnBox) v.push(`${what}: ${m.labelOnBox} edge labels cover a box`);
  if (m.labelOnLabel) v.push(`${what}: ${m.labelOnLabel} pairs of edge labels cover each other`);
  if (m.through.length) v.push(`${what}: ${m.through.length} lines cross a box: ${m.through.join(", ")}`);
  return v;
}
