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
const drawn = new Map<string, { svg: string } | { error: string }>();
// Mermaid draws one diagram at a time, each with the configuration set just before it.
let queue: Promise<unknown> = Promise.resolve();
let serial = 0;

function figure(svg: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "mermaid-fig";
  box.innerHTML = svg;
  return box;
}

function show(block: HTMLElement, svg: string) {
  block.querySelector(".mermaid-fig, .mermaid-err")?.remove();
  block.prepend(figure(svg));
  block.dataset.state = "done";
}

function fail(block: HTMLElement, message: string) {
  block.querySelector(".mermaid-fig, .mermaid-err")?.remove();
  const note = document.createElement("pre");
  note.className = "mermaid-err";
  note.textContent = "图画不出来：" + message;
  block.append(note);
  block.dataset.state = "error";
}

function draw(block: HTMLElement) {
  const source = block.querySelector("code")?.textContent ?? "", theme = dark() ? "dark" : "default", key = theme + "\n" + source;
  const known = drawn.get(key);
  if (known) { if ("svg" in known) show(block, known.svg); else fail(block, known.error); return; }
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
      });
      const { svg } = await mermaid.render(id, source);
      drawn.set(key, { svg });
      if (block.isConnected) show(block, svg);
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
