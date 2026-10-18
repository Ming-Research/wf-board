// What the mermaid browser checks share (test/e2e/mermaid.e2e.ts, test/e2e/regressions.e2e.ts): a head with diagrams written to the board,
// the wait for them to be drawn, what the page made of each, and the check that every diagram fits its box. Each check returns its violations.

import { ops } from "../../src/ops.ts";
import type { BoardPage, BoardServer } from "./harness.ts";
import { fence, FIT_HEAD, SMALL, WIDE } from "./mermaid-charts.ts";

// The sources are in mermaid-charts.ts; the checks of the browser layer and the regression witnesses ask for them here.
export { fence, FIT_HEAD, SMALL, WIDE };

/** Writes `head` as the head of item `id`. */
export async function setHead(board: BoardServer, id: string, head: string) {
  const it = board.store.snapshot().items[id]!;
  await ops(board.store).updateItem({ author: it.group, id, rev: it.rev, head, reason: "test content" });
}

/** Waits until `scope` holds `count` mermaid blocks, none of them still loading. The answer is null, or what the page held when `wait` ran out. */
export async function settled(bp: BoardPage, count: number, wait: number, scope = "#item-detail"): Promise<string | null> {
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

export const round = (n: number) => Math.round(n);

/** What the page makes of each diagram under the item's detail: its own width (its view box), the width it is drawn at, its box and the
 * places of both on the screen; and whether anything above a diagram is wider than itself, which would scroll the page sideways. */
export async function figures(bp: BoardPage) {
  return bp.page.evaluate(() => {
    const figs = [...document.querySelectorAll<HTMLElement>("#item-detail .mermaid-fig")];
    return {
      figs: figs.map(f => {
        const svg = f.querySelector("svg")!, r = svg.getBoundingClientRect(), b = f.getBoundingClientRect();
        return {
          natural: svg.viewBox.baseVal.width, naturalHeight: svg.viewBox.baseVal.height, drawn: r.width, drawnHeight: r.height,
          box: f.clientWidth, scroll: f.scrollWidth, scrollLeft: f.scrollLeft, overflowX: getComputedStyle(f).overflowX,
          left: r.left, top: r.top, right: r.right, boxLeft: b.left, boxRight: b.right,
          pan: f.closest<HTMLElement>(".mermaid-block")!.dataset.pan ?? "",
        };
      }),
      spilling: figs.flatMap(f => { const out: string[] = []; for (let e = f.parentElement; e; e = e.parentElement) if (e.scrollWidth > e.clientWidth + 1) out.push(e.tagName.toLowerCase() + (e.id ? "#" + e.id : "")); return out; }),
      page: [document.documentElement.scrollWidth, document.documentElement.clientWidth] as [number, number],
    };
  });
}

/** At its default size a diagram is as wide as itself or, when its box is narrower, as wide as the box: never larger than itself, and the box
 * and the page have nothing to scroll sideways. A narrow one is centered. Held at the window the page is open in. */
export async function checkFit(bp: BoardPage, wait: number): Promise<string[]> {
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
export type Figure = Awaited<ReturnType<typeof figures>>["figs"][number];
