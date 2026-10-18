// Where the diagrams' boxes and drawings lie on the page in a DOM library, which computes no layout. The page measures its
// diagrams (web/mermaid.ts): the width of the box and of what it holds, how far the box is scrolled, where the drawing is on the
// screen. A model answers for them: the box is as wide as the page's column (`box` px), the drawing is as wide as the page's own
// stylesheet says (`.mermaid-fig svg { width: calc(min(var(--natural), 100%) * var(--zoom, 1)) }`, read from the stylesheet and
// evaluated here) and is centered when its margin says so, the box scrolls sideways as far as its `overflow-x` allows, and the
// page scrolls under the box. It is the page's arithmetic (the zoom, the point kept under the cursor, the drag) that the model lets
// a test see; where a real browser lays the box out is the browser layer's (test/e2e/mermaid.e2e.ts). Docs/design.md, section 11.

import type { DomPage } from "./page.ts";

type Loose = Record<string, any>;
const rect = (left: number, top: number, width: number, height: number) => ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON() { return this; } });

/** The length of a CSS expression of the forms the page's stylesheet uses for a width (px, %, calc, min, max, + - * /), `percent` being what 100% is; null when it is not one of them. */
export function evalLength(text: string, percent: number): number | null {
  const s = text.trim();
  let i = 0;
  const skip = () => { while (s[i] === " ") i++; };
  const number = (): number | null => {
    skip();
    const m = /^-?(?:\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    let value = parseFloat(m[0]);
    if (s.startsWith("px", i)) i += 2; else if (s[i] === "%") { i++; value = value / 100 * percent; }
    return value;
  };
  const factor = (): number | null => {
    skip();
    const fn = /^(calc|min|max)\(/.exec(s.slice(i));
    if (fn) {
      i += fn[0].length;
      const args: number[] = [];
      for (;;) {
        const value = sum();
        if (value === null) return null;
        args.push(value);
        skip();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === ")") { i++; break; }
        return null;
      }
      return fn[1] === "min" ? Math.min(...args) : fn[1] === "max" ? Math.max(...args) : args[0]!;
    }
    if (s[i] === "(") { i++; const value = sum(); skip(); if (value === null || s[i] !== ")") return null; i++; return value; }
    return number();
  };
  const term = (): number | null => {
    let value = factor();
    for (;;) {
      skip();
      if (value === null) return null;
      const op = s[i];
      if (op !== "*" && op !== "/") return value;
      i++;
      const right = factor();
      if (right === null || (op === "/" && right === 0)) return null;
      value = op === "*" ? value * right : value / right;
    }
  };
  function sum(): number | null {
    let value = term();
    for (;;) {
      skip();
      if (value === null) return null;
      const op = s[i];
      if (op !== "+" && op !== "-") return value;
      i++;
      const right = term();
      if (right === null) return null;
      value = op === "+" ? value + right : value - right;
    }
  }
  const value = sum();
  skip();
  return i === s.length ? value : null;
}

/** The top of the first diagram's box on the screen when the page is not scrolled, and the padding above the drawing in it. */
const FIGURE_TOP = 100, FIGURE_PAD = 6;

/** A `setup` for PageOptions: the diagram boxes of this window are `box` px wide (the width of the text column). */
export function diagramBoxes(box: number): (page: DomPage) => void {
  return page => {
    const win = page.win, proto = win.Element.prototype as Loose;
    const isFig = (e: Element) => e.classList?.contains("mermaid-fig") === true;
    const isDrawing = (e: Element) => e.localName === "svg" && !!e.parentElement && isFig(e.parentElement);
    const scrolled = new WeakMap<Element, number>();
    const pageScroll = () => page.doc.documentElement.scrollTop;

    /** The width the page's stylesheet gives a drawing in a box of this width. */
    const drawnWidth = (svg: Element): number => {
      page.styles.forget();
      const width = page.styles.value(svg, "width");
      return (width === undefined ? null : evalLength(width, box)) ?? box;
    };
    const scrollWidth = (fig: Element) => { const svg = fig.querySelector(":scope > svg"); return svg ? Math.max(box, drawnWidth(svg)) : box; };
    /** How far the box scrolls: as far as its content reaches past it, when its `overflow-x` lets it scroll. */
    const reach = (fig: Element) => {
      page.styles.forget();
      return /auto|scroll|hidden/.test(page.styles.value(fig, "overflow-x") ?? "visible") ? Math.max(0, scrollWidth(fig) - box) : 0;
    };
    const figTop = () => FIGURE_TOP - pageScroll();
    const drawingRect = (svg: Element) => {
      const width = drawnWidth(svg), own = (svg as unknown as SVGSVGElement).viewBox.baseVal;
      const height = own.width ? width * own.height / own.width : 0;
      page.styles.forget();
      const centered = page.styles.value(svg, "margin-inline") === "auto" || page.styles.value(svg, "margin-left") === "auto";
      const left = (centered && width < box ? (box - width) / 2 : 0) - (scrolled.get(svg.parentElement!) ?? 0);
      return rect(left, figTop() + FIGURE_PAD, width, height);
    };

    const rectOf = proto.getBoundingClientRect as () => unknown;
    proto.getBoundingClientRect = function (this: Element) {
      if (isDrawing(this)) return drawingRect(this);
      if (isFig(this)) { const svg = this.querySelector(":scope > svg"); return rect(0, figTop(), box, (svg ? drawingRect(svg).height : 0) + 2 * FIGURE_PAD); }
      return rectOf.call(this);
    };
    const original = (name: string) => Object.getOwnPropertyDescriptor(proto, name)!;
    const clientWidth = original("clientWidth"), scrollLeft = original("scrollLeft"), scrollWidthOf = original("scrollWidth");
    Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: Element) { return isFig(this) ? box : clientWidth.get!.call(this); } });
    Object.defineProperty(proto, "scrollWidth", { configurable: true, get(this: Element) { return isFig(this) ? scrollWidth(this) : scrollWidthOf.get!.call(this); } });
    // The box keeps where it is scrolled to, never beyond its content; a scroll tells the page, as a browser does.
    Object.defineProperty(proto, "scrollLeft", {
      configurable: true,
      get(this: Element) { return isFig(this) ? scrolled.get(this) ?? 0 : scrollLeft.get!.call(this); },
      set(this: Element, value: number) {
        if (!isFig(this)) { scrollLeft.set!.call(this, value); return; }
        const next = Math.max(0, Math.min(reach(this), Number(value))), before = scrolled.get(this) ?? 0;
        scrolled.set(this, next);
        if (next !== before) this.dispatchEvent(new win.Event("scroll"));
      },
    });
  };
}
