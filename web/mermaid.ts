// Mermaid blocks of board text, drawn as diagrams. web/highlight.ts wraps a ```mermaid block as
// <div class="mermaid-block"><pre>…</pre></div>; this file draws each such block the page shows, whichever render put it there
// (an item's head, a log entry, a card). The library is a file of its own (web/dist/mermaid.js, built from web/mermaid-entry.ts) that
// the page fetches when it first meets a block, so a page with no diagram never loads it (docs/design.md, section 7, Diagrams).

/** What the page uses of the library. */
interface Mermaid {
  initialize(config: object): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

const BLOCK = ".mermaid-block";
/** The path the server gives the library at (src/http.ts). Held in a variable so the bundler leaves the import alone. */
const LIBRARY: string = "/mermaid.js";

/** The zoom is a factor of the default size (1: the diagram at its own size, or shrunk to the width of the text when that is wider). */
const MIN_ZOOM = 0.5, MAX_ZOOM = 6, STEP = 1.25;

/** What the page asks of the library so that a diagram takes little room: the classic look, which reads the padding in a box (the default
 * look writes a larger one), and 20 px between boxes and between layers. A settings block at the start of a diagram wins over these.
 * The gaps reach ELK only through web/mermaid-entry.ts. */
const COMPACT = { look: "classic", flowchart: { look: "classic", padding: 8, nodeSpacing: 20, rankSpacing: 20 } };

let library: Promise<Mermaid> | undefined;
function load(): Promise<Mermaid> {
  library ??= import(LIBRARY).then((module: { default: Mermaid }) => module.default, (error: unknown) => { library = undefined; throw error; });
  return library;
}

/** Whether the page shows the dark colors: the owner's choice (data-theme) when there is one, else the system's. */
function dark(): boolean {
  const theme = document.documentElement.getAttribute("data-theme");
  return theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
}

/** What the library made of each source, by theme and source, so a block the page draws again (a live update repaints the item it is in)
 * shows its diagram or its error at once instead of source text until the library answers. */
const drawn = new Map<string, { svg: string; id: string } | { error: string }>();
/** How the reader has zoomed and scrolled each diagram, by source: a diagram drawn again with the same source (a live update, a change of
 * theme) keeps its view, and one whose source changed starts at the default. Only a view that differs from the default is kept. */
const views = new Map<string, { zoom: number; left: number }>();
// Mermaid draws one diagram at a time, each with the configuration set just before it.
let queue: Promise<unknown> = Promise.resolve();
let serial = 0;

/** The nearest ancestor that scrolls the page vertically: the diagram's box scrolls only sideways, so the vertical wheel, and a drag
 * up or down, move this. */
function scroller(from: Element): Element {
  for (let e = from.parentElement; e; e = e.parentElement) {
    const overflow = getComputedStyle(e).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && e.scrollHeight > e.clientHeight) return e;
  }
  return document.scrollingElement ?? document.documentElement;
}

function button(text: string, title: string, click: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", click);
  return b;
}

/** The toolbar of a drawn diagram and the zoom and pan behind it. The plain wheel is left alone, so it scrolls the page. */
function viewer(block: HTMLElement, fig: HTMLElement, source: string): HTMLElement {
  const svg = fig.querySelector("svg")!;
  let zoom = 1;
  /** The size buttons, each with the share of the diagram's own size it draws; the one whose size is shown is pressed. */
  const sizes: [HTMLButtonElement, number][] = [];
  /** How large the diagram is drawn, as a share of its own width. */
  const percent = document.createElement("span");
  percent.className = "mermaid-percent";
  /** Whether the box has more to show sideways: then it can be dragged, and says so; and on which sides there is more. The percentage is read here too. */
  const refresh = () => {
    const room = fig.scrollWidth - fig.clientWidth;
    block.dataset.pan = room > 1 ? "yes" : "no";
    block.dataset.more = [fig.scrollLeft > 1 ? "left" : "", fig.scrollLeft < room - 1 ? "right" : ""].join(" ").trim();
    // A diagram in a folded section has no width; its percentage is read again when the section opens (the box's size changes).
    const drawn = svg.getBoundingClientRect().width, own = svg.viewBox.baseVal.width;
    if (drawn && own) percent.textContent = Math.round(drawn / own * 100) + "%";
    for (const [b, part] of sizes) b.setAttribute("aria-pressed", String(Math.abs(zoom - ownSize() * part) < 0.01));
  };
  /** The zoom at which the diagram is drawn at its own size: the box is narrower than the diagram, so the zoom makes up for the shrinking. */
  const ownSize = () => {
    const own = svg.viewBox.baseVal.width, shown = Math.min(own, fig.clientWidth);
    return own && shown ? own / shown : 1;
  };
  const remember = () => { if (zoom === 1 && fig.scrollLeft === 0) views.delete(source); else views.set(source, { zoom, left: fig.scrollLeft }); };
  /** Sets the zoom; the point of the diagram that is at `at` on the screen stays there. */
  const set = (next: number, at: { x: number; y: number }) => {
    const before = svg.getBoundingClientRect();
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    fig.style.setProperty("--zoom", String(zoom));
    const after = svg.getBoundingClientRect();
    if (before.width && before.height && after.width) {
      fig.scrollLeft += after.left + (at.x - before.left) / before.width * after.width - at.x;
      scroller(fig).scrollTop += after.top + (at.y - before.top) / before.height * after.height - at.y;
    }
    refresh();
    remember();
  };
  /** The middle of the part of the box that is on the screen. */
  const middle = () => {
    const box = fig.getBoundingClientRect(), top = Math.max(box.top, 0), bottom = Math.min(box.bottom, innerHeight);
    return { x: box.left + box.width / 2, y: top < bottom ? (top + bottom) / 2 : box.top };
  };

  const saved = views.get(source);
  if (saved) { zoom = saved.zoom; fig.style.setProperty("--zoom", String(zoom)); fig.scrollLeft = saved.left; }
  fig.addEventListener("scroll", () => { remember(); refresh(); });
  // Ctrl and the wheel zoom (Chromium sends a pinch on a trackpad so too); the cursor's point stays put.
  fig.addEventListener("wheel", event => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    set(zoom * Math.exp(-Math.max(-30, Math.min(30, event.deltaY)) * 0.01), { x: event.clientX, y: event.clientY });
  }, { passive: false });
  // A mouse drags the diagram sideways inside its box, and up or down along the page.
  fig.addEventListener("pointerdown", down => {
    if (down.button !== 0 || down.pointerType !== "mouse" || block.dataset.pan !== "yes") return;
    const page = scroller(fig), start = { x: down.clientX, y: down.clientY, left: fig.scrollLeft, top: page.scrollTop };
    fig.setPointerCapture(down.pointerId);
    fig.classList.add("grabbing");
    const move = (e: PointerEvent) => { fig.scrollLeft = start.left - (e.clientX - start.x); page.scrollTop = start.top - (e.clientY - start.y); };
    const end = () => {
      fig.classList.remove("grabbing");
      fig.removeEventListener("pointermove", move);
      fig.removeEventListener("pointerup", end);
      fig.removeEventListener("pointercancel", end);
    };
    fig.addEventListener("pointermove", move);
    fig.addEventListener("pointerup", end);
    fig.addEventListener("pointercancel", end);
  });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(refresh).observe(fig);
  refresh();

  /** A size button draws the diagram at its share of its own size, so 100% is the diagram at its own size even where its box is narrower.
   * Pressed again while that size shows, it gives the width of the box back. */
  const share = (text: string, part: number) => {
    const b = button(text, text, () => {
      if (Math.abs(zoom - ownSize() * part) < 0.01) { set(1, middle()); fig.scrollLeft = 0; } else set(ownSize() * part, middle());
    });
    sizes.push([b, part]);
    return b;
  };

  const bar = document.createElement("div");
  bar.className = "mermaid-tools";
  const hint = document.createElement("span");
  hint.className = "mermaid-hint";
  hint.textContent = "双指缩放，拖动或滚动查看";
  bar.append(
    button("−", "缩小", () => set(zoom / STEP, middle())),
    percent,
    button("+", "放大", () => set(zoom * STEP, middle())),
    button("适应宽度", "适应宽度", () => { set(1, middle()); fig.scrollLeft = 0; }),
    share("60%", 0.6),
    share("90%", 0.9),
    share("100%", 1),
    hint,
  );
  return bar;
}

function clear(block: HTMLElement) {
  for (const old of block.querySelectorAll(".mermaid-view, .mermaid-tools, .mermaid-err")) old.remove();
}

function show(block: HTMLElement, svg: string, source: string) {
  clear(block);
  const fig = document.createElement("div");
  fig.className = "mermaid-fig";
  fig.innerHTML = svg;
  // The library sizes a drawing to its container. The page sizes it from the drawing's own width (web/index.html): at most that wide,
  // shrunk to the width of the text when the text is narrower, times the zoom.
  const width = fig.querySelector("svg")?.viewBox.baseVal.width;
  if (width) fig.style.setProperty("--natural", width + "px");
  // The box is inside a view, which carries the marks at its edges that show there is more to see sideways.
  const view = document.createElement("div");
  view.className = "mermaid-view";
  view.append(fig);
  block.prepend(view);
  block.prepend(viewer(block, fig, source));
  block.dataset.state = "done";
}

function fail(block: HTMLElement, message: string) {
  clear(block);
  const note = document.createElement("pre");
  note.className = "mermaid-err";
  note.textContent = "图画不出来：" + message;
  block.append(note);
  block.dataset.state = "error";
}

function draw(block: HTMLElement) {
  const source = block.querySelector("code")?.textContent ?? "", theme = dark() ? "dark" : "default", key = theme + "\n" + source;
  const known = drawn.get(key);
  // The copy gets ids of its own: the first copy of the same diagram may be hidden (a folded section), and the markers a line points at
  // are found by id.
  if (known) { if ("svg" in known) show(block, known.svg.replaceAll(known.id, "mermaid-" + ++serial), source); else fail(block, known.error); return; }
  block.dataset.state = "loading";
  const id = "mermaid-" + ++serial;
  queue = queue.then(async () => {
    try {
      const mermaid = await load();
      mermaid.initialize({
        startOnLoad: false,
        // Board text is written by agents. Strict makes the text of a diagram plain text, never page markup, and leaves out the click
        // handlers that would call functions of the page.
        securityLevel: "strict",
        theme,
        // A syntax error is reported here, in the block, not as a picture of a bomb added to the end of the page.
        suppressErrorRendering: true,
        fontFamily: getComputedStyle(document.body).fontFamily,
        ...COMPACT,
      });
      const { svg } = await mermaid.render(id, source);
      drawn.set(key, { svg, id });
      if (block.isConnected) show(block, svg, source);
    } catch (error) {
      // Mermaid leaves the half-drawn diagram of a failed render in the page.
      document.getElementById("d" + id)?.remove();
      const message = error instanceof Error ? error.message : String(error);
      // A library that did not load is tried again with the next block, so only a refusal of the source is kept.
      if (library) drawn.set(key, { error: message });
      if (block.isConnected) fail(block, message);
    }
  });
}

/** Draws every block under `root` that has not been drawn yet. */
export function drawMermaid(root: ParentNode) {
  for (const block of root.querySelectorAll<HTMLElement>(BLOCK + ":not([data-state])")) draw(block);
}

/** Draws the blocks the page has now and each block added later, and draws them again when the page changes theme. */
export function watchMermaid() {
  if (typeof MutationObserver === "undefined") return;
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.matches(BLOCK)) { if (!node.dataset.state) draw(node); } else drawMermaid(node);
    }
  }).observe(document.body, { childList: true, subtree: true });
  const again = () => { for (const block of document.querySelectorAll<HTMLElement>(BLOCK + "[data-state]")) { delete block.dataset.state; draw(block); } };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", again);
  new MutationObserver(again).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  drawMermaid(document);
}
