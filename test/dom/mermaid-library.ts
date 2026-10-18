// A stand-in for the diagram library (mermaid) in the page in a DOM library (test/dom/page.ts, PageOptions.library). The page uses two
// functions of the library, `initialize(config)` and `render(id, text)` (web/mermaid.ts); the stand-in answers them the way the library
// does for the things the page depends on, and draws nothing else: the same text gives the same drawing, the drawing has a view box,
// its ids and the references to them all begin with the id the page gave, text that does not parse is refused with a message, and the
// settings in a frontmatter block at the start of the text win over the page's configuration. What the real library draws (its labels,
// its sizes, its colours, how it parses, what it makes of hostile text) is the browser layer's (test/e2e/browser.e2e.ts).

/** What the page gives `initialize`. */
export interface Config { startOnLoad?: boolean; securityLevel?: string; theme?: string; suppressErrorRendering?: boolean; fontFamily?: string }
/** One drawing the page asked for. */
export interface Drawn { id: string; text: string; config: Config }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

/** The labels of a diagram's source: what stands in brackets, braces or parentheses; a source with none (a sequence diagram) gives its lines. */
export function labelsOf(body: string): string[] {
  const found = [...body.matchAll(/\[\s*"?([^\]"]*)"?\s*\]|\{\s*"?([^}"]*)"?\s*\}/g)].map(m => (m[1] ?? m[2] ?? "").trim());
  return found.length ? found : body.split("\n").slice(1).map(l => l.trim()).filter(Boolean);
}
/** The drawing's own size: wide in proportion to the labels, so a short chain is narrower than a text column and a long one wider. */
export function sizeOf(labels: number): { width: number; height: number } { return { width: 80 + 90 * labels, height: 60 + 30 * labels }; }

export class StandIn {
  /** Every configuration the page gave, in order. */
  readonly configs: Config[] = [];
  /** Every drawing the page asked for, in order, with the configuration it was drawn with. */
  readonly drawn: Drawn[] = [];
  private config: Config = {};
  private document: () => Document;
  constructor(document: () => Document) { this.document = document; }

  initialize(config: Config) { this.config = config; this.configs.push(config); }

  async render(id: string, text: string): Promise<{ svg: string }> {
    this.drawn.push({ id, text, config: this.config });
    const front = FRONTMATTER.exec(text), body = front ? text.slice(front[0].length) : text;
    // The diagram's own settings win over the page's.
    const own = /^\s*theme:\s*(\w+)/m.exec(front?.[1] ?? "")?.[1];
    const theme = own ?? this.config.theme ?? "default";
    if (/-->\s*-->/.test(body)) {
      // The library leaves the half-drawn diagram of a failed render in the page.
      const stray = this.document().createElement("div");
      stray.id = "d" + id;
      this.document().body.append(stray);
      throw new Error(`Parse error on line 2:\n...${body.split("\n")[1] ?? ""}\nExpecting 'ID', got 'ARROW'`);
    }
    const labels = labelsOf(body), { width, height } = sizeOf(labels.length);
    const nodes = labels.map((label, i) => `<g class="node" id="${id}-node-${i}"><rect x="${i * 10}" y="${i * 5}" width="80" height="24"/><text>${esc(label)}</text></g>`).join("");
    return {
      svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${width} ${height}" style="max-width: ${width}px;" data-theme="${theme}">`
        + `<defs><marker id="${id}_arrow" markerWidth="10" markerHeight="10"><path d="M0 0L10 5L0 10z"/></marker></defs>`
        + `<g class="nodes">${nodes}</g><path class="flowchart-link" d="M0 0L${width} ${height}" marker-end="url(#${id}_arrow)"/></svg>`,
    };
  }
}
