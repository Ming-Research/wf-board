// What the page's stylesheet declares for an element on the page in a DOM library: the cascade of the rules that match it (their
// specificity and order, the inherited properties, the custom properties the rules use), read from the stylesheet text, with no
// layout. jsdom's own getComputedStyle drops a shorthand that holds `var()` and answers `var(--x)` for a colour, so it cannot say what
// colour a chip is; this can. It answers questions of the form "does the stylesheet give this element that value" (a font, a colour,
// a position, a width limit); it does not know where a box lands. docs/design.md, section 11, Four test layers.

import type { DOMWindow } from "jsdom";

/** One selector of a rule, with where to find it fast: the class, id or tag its last compound selector requires. */
interface Part { text: string; base: string; pseudo: string | null; spec: Specificity; rule: Rule; key: string }
interface Rule { selector: string; style: CSSStyleDeclaration; order: number }
export type Specificity = [number, number, number];

/** The comma-separated parts of a selector list, not counting commas inside parentheses. */
function splitTop(list: string): string[] {
  const out: string[] = []; let depth = 0, start = 0;
  for (let k = 0; k < list.length; k++) {
    const c = list[k];
    if (c === "(" || c === "[") depth++; else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) { out.push(list.slice(start, k).trim()); start = k + 1; }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}
const compare = (a: Specificity, b: Specificity) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
/** The specificity of one selector (Selectors Level 4): ids, then classes, attributes and pseudo-classes, then elements and pseudo-elements. */
export function specificity(selector: string): Specificity {
  let s = selector.replace(/"[^"]*"|'[^']*'/g, '""');
  const total: Specificity = [0, 0, 0];
  const add = (x: Specificity) => { total[0] += x[0]; total[1] += x[1]; total[2] += x[2]; };
  // :is(), :not() and :has() count as their most specific argument, :where() as nothing.
  const functional = /:(is|not|has|matches|where)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/;
  for (let m = functional.exec(s); m; m = functional.exec(s)) {
    if (m[1] !== "where") add(splitTop(m[2]!).map(specificity).sort(compare).at(-1) ?? [0, 0, 0]);
    s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length);
  }
  total[0] += (s.match(/#[\w-]+/g) ?? []).length;
  total[1] += (s.match(/\.[\w-]+/g) ?? []).length + (s.match(/\[[^\]]*\]/g) ?? []).length + (s.match(/(?<!:):[\w-]+(?:\([^)]*\))?/g) ?? []).filter(p => !/^:(before|after|first-line|first-letter)$/.test(p)).length;
  const bare = s.replace(/\[[^\]]*\]|\([^)]*\)|[#.:][\w-]+/g, " ");
  total[2] += (bare.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length + (s.match(/::[\w-]+|:(before|after|first-line|first-letter)\b/g) ?? []).length;
  return total;
}

// Properties that pass from a parent to its children when no rule says otherwise.
const INHERITED = new Set(["color", "font-family", "font-size", "font-weight", "font-style", "line-height", "visibility", "cursor", "text-align", "white-space"]);
// The declarations that can set a property: itself and the shorthands that include it.
const SETTERS: Record<string, string[]> = { "background-color": ["background-color", "background"], "font-family": ["font-family", "font"], "font-size": ["font-size", "font"], "font-weight": ["font-weight", "font"] };

export interface Medium { scheme: "light" | "dark"; width: number }

export class Styles {
  private rules: Rule[] = [];
  // The selectors of all the rules by the class, id or tag their last compound selector requires ("*" for any), so an element is
  // tested against a few dozen selectors and not all of them; and the answers already given, an element's rules and its values.
  private index = new Map<string, Part[]>();
  private matched = new WeakMap<Element, Map<string | null, Part[]>>();
  private answers = new WeakMap<Element, Map<string, string | undefined>>();
  /** Drops what was answered so far: the page changes classes and attributes, which changes which rules match. */
  forget() { this.matched = new WeakMap(); this.answers = new WeakMap(); }
  readonly medium: Medium;
  private win: DOMWindow;
  constructor(win: DOMWindow, medium: Partial<Medium> = {}) {
    this.win = win;
    this.medium = { scheme: "light", width: 1500, ...medium };
    let order = 0;
    const walk = (rules: CSSRuleList) => {
      for (const rule of rules as unknown as Iterable<CSSRule>) {
        if ("selectorText" in rule && "style" in rule) this.rules.push({ selector: (rule as CSSStyleRule).selectorText, style: (rule as CSSStyleRule).style, order: order++ });
        else if ("conditionText" in rule && "cssRules" in rule && this.matchesMedia((rule as CSSMediaRule).conditionText ?? (rule as CSSMediaRule).media?.mediaText ?? "")) walk((rule as CSSMediaRule).cssRules);
      }
    };
    for (const sheet of win.document.styleSheets as unknown as Iterable<CSSStyleSheet>) walk(sheet.cssRules);
    for (const rule of this.rules) for (const text of splitTop(rule.selector)) {
      const pe = text.match(/::?(before|after)$/), base = pe ? text.slice(0, pe.index) : text;
      if (!pe && /::/.test(text)) continue;
      const last = base.split(/\s*[>+~]\s*|\s+/).filter(Boolean).at(-1) ?? "";
      // A functional pseudo-class in the last compound selector (:is(), :not()) makes any element a candidate.
      const key = /[(]/.test(last) ? "*" : last.match(/\.([\w-]+)/)?.[0] ?? last.match(/#([\w-]+)/)?.[0] ?? last.match(/^[a-zA-Z][\w-]*/)?.[0]?.toUpperCase() ?? "*";
      const part: Part = { text, base, pseudo: pe ? pe[1]! : null, spec: specificity(text), rule, key };
      this.index.set(key, [...this.index.get(key) ?? [], part]);
    }
  }
  /** Whether a media condition of the forms the page uses holds for this window and colour scheme. */
  private matchesMedia(condition: string): boolean {
    return condition.split(/\band\b/).every(part => {
      const m = part.trim().match(/^\(\s*([a-z-]+)\s*(?::\s*([^)]+))?\)$/);
      if (!m) return false;
      const [, feature, value = ""] = m;
      if (feature === "prefers-color-scheme") return value.trim() === this.medium.scheme;
      if (feature === "max-width") return this.medium.width <= parseFloat(value);
      if (feature === "min-width") return this.medium.width >= parseFloat(value);
      return false;
    });
  }
  /** The selectors that match an element (or its pseudo-element), most specific last. */
  private matching(el: Element, pseudo: string | null): Part[] {
    let byPseudo = this.matched.get(el);
    if (!byPseudo) this.matched.set(el, byPseudo = new Map());
    const known = byPseudo.get(pseudo);
    if (known) return known;
    const keys = ["*", el.tagName.toUpperCase(), ...[...el.classList].map(c => "." + c), ...(el.id ? ["#" + el.id] : [])];
    const out: Part[] = [];
    for (const key of keys) for (const part of this.index.get(key) ?? []) {
      if (part.pseudo !== pseudo) continue;
      try { if (part.base === "" || el.matches(part.base)) out.push(part); } catch { /* a selector this window cannot parse matches nothing */ }
    }
    out.sort((a, b) => compare(a.spec, b.spec) || a.rule.order - b.rule.order);
    byPseudo.set(pseudo, out);
    return out;
  }
  /** The declared value of `prop` on the element after the cascade, `var()` not yet replaced; undefined when no rule or style attribute sets it. */
  declared(el: Element, prop: string, pseudo: string | null = null): string | undefined {
    const names = SETTERS[prop] ?? [prop];
    let best: { value: string; important: boolean; from: string } | undefined;
    const take = (value: string, important: boolean, from: string) => { if (!best || (important && !best.important) || important === best.important) best = { value, important, from }; };
    // A rule with several selectors that match counts once, at the most specific of them.
    const seen = new Set<Rule>();
    for (const { rule } of [...this.matching(el, pseudo)].reverse().filter(p => !seen.has(p.rule) && seen.add(p.rule)).reverse()) {
      for (const name of names) {
        const value = rule.style.getPropertyValue(name).trim();
        if (value) take(name === prop ? value : this.longhand(prop, name, value), rule.style.getPropertyPriority(name) === "important", name);
      }
    }
    if (!pseudo) for (const name of names) {
      const value = (el as HTMLElement).style?.getPropertyValue(name).trim();
      if (value) take(name === prop ? value : this.longhand(prop, name, value), true, "style");
    }
    return best?.value;
  }
  /** The part of a shorthand that sets one longhand, for the few shorthands the checks ask about. */
  private longhand(prop: string, shorthand: string, value: string): string {
    if (value === "inherit") return "inherit";
    if (shorthand === "background" && prop === "background-color") {
      // A colour among the layers (a gradient or an image has none).
      const color = value.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\btransparent\b|var\(--[\w-]+\)/);
      return color && !/gradient|url\(/.test(value) ? color[0] : "transparent";
    }
    if (shorthand === "font") {
      const size = value.match(/(?:^|\s)([\d.]+(?:px|em|rem|%))(?:\/[\d.a-z%]+)?\s+(.+)$/);
      if (prop === "font-size") return size?.[1] ?? "inherit";
      if (prop === "font-family") return size?.[2] ?? "inherit";
      return "inherit";
    }
    return value;
  }
  /** The value of a custom property on an element: custom properties always pass to children. */
  private custom(el: Element | null, name: string, depth = 0): string | undefined {
    if (depth > 20) throw new Error(`custom property ${name} refers to itself`);
    for (let e = el; e; e = e.parentElement) {
      const value = this.declared(e, name);
      if (value !== undefined) return this.replaceVars(value, e, depth + 1);
    }
    return undefined;
  }
  private replaceVars(value: string, el: Element, depth = 0): string {
    return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_all, name: string, fallback?: string) => this.custom(el, name, depth) ?? fallback?.trim() ?? "");
  }
  /** The value the stylesheet gives `prop` for the element, custom properties replaced and inherited properties taken from the parent; undefined when nothing sets it. */
  value(el: Element, prop: string, pseudo: string | null = null): string | undefined {
    let known = this.answers.get(el);
    if (!known) this.answers.set(el, known = new Map());
    const id = pseudo + "|" + prop;
    if (!known.has(id)) known.set(id, this.compute(el, prop, pseudo));
    return known.get(id);
  }
  private compute(el: Element, prop: string, pseudo: string | null): string | undefined {
    const value = this.declared(el, prop, pseudo);
    if (value !== undefined && value !== "inherit" && value !== "unset") return this.replaceVars(value, el);
    if ((value === "inherit" || value === "unset" || INHERITED.has(prop)) && !pseudo && el.parentElement) return this.value(el.parentElement, prop);
    return undefined;
  }
}

// Colours and their contrast (WCAG 2.x).
export interface Rgba { r: number; g: number; b: number; a: number }
const NAMED: Record<string, Rgba> = { white: { r: 255, g: 255, b: 255, a: 1 }, black: { r: 0, g: 0, b: 0, a: 1 }, transparent: { r: 0, g: 0, b: 0, a: 0 } };
/** A colour written as #rgb, #rrggbb, #rrggbbaa, rgb()/rgba() in either syntax, white, black or transparent. */
export function parseColor(text: string): Rgba {
  const t = text.trim().toLowerCase();
  if (NAMED[t]) return NAMED[t]!;
  const hex = t.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map(c => c + c).join("") : hex[1]!;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  const fn = t.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const p = fn[1]!.split(/[\s,/]+/).filter(Boolean).map((x, k) => x.endsWith("%") ? (k === 3 ? parseFloat(x) / 100 : parseFloat(x) * 2.55) : Number(x));
    return { r: p[0]!, g: p[1]!, b: p[2]!, a: p.length > 3 ? p[3]! : 1 };
  }
  throw new Error(`cannot read the colour "${text}"`);
}
const luminance = (c: { r: number; g: number; b: number }) => { const f = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
/** `top` painted over an opaque `under`. */
export const over = (top: Rgba, under: { r: number; g: number; b: number }) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a) });
/** The contrast ratio between two opaque colours. */
export function contrast(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
