// Code blocks: a small tokenizer for the fenced blocks of board text, as plain functions so tests can call them
// without a page. Highlighting only wraps tokens in <span class="tk-…">; the text content never changes.

// Whitefoot keywords: every lowercase quoted fixed atom of the wf-ebnf grammar blocks in the Whitefoot specification
// (spec/kernel-spec.md, section 3 "Grammar"; FORM-3 defines the keywords as the lowercase fixed grammar atoms that
// leave IDENT). The specification has no separate keyword list. The primitive type names among them are types.
const WF_PRIMITIVES = new Set(["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64"]);
const WF_KEYWORDS = new Set(`alias apart atomic binding break const continue contract copy define doc drop else ensures entry enum fn for forall give
  if in interface invariant is let loop match move musttail no_heap nocopy nodrop not opaque package pkg program propagate public pure readonly reads
  requires return set spawn std struct times unchanged unit use waits when writes`.split(/\s+/));

type Syntax = { comment: string[]; words: boolean };
const SLASH: Syntax = { comment: ["//"], words: false };
const HASH: Syntax = { comment: ["#"], words: false };
const WF: Syntax = { comment: ["//"], words: true };
const LANGS: Record<string, Syntax> = {
  wf: WF, whitefoot: WF,
  lua: { comment: ["--"], words: false }, llvm: { comment: [";"], words: false },
  sh: HASH, bash: HASH, shell: HASH, zsh: HASH, yaml: HASH, yml: HASH, python: HASH, py: HASH, toml: HASH,
  rust: SLASH, rs: SLASH, c: SLASH, cpp: SLASH, "c++": SLASH, go: SLASH, js: SLASH, javascript: SLASH, ts: SLASH, typescript: SLASH, java: SLASH, json: SLASH,
};

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** The fence's language: the first word of the info string, lowercased ("" when unlabeled). */
export function fenceLang(info: string) { return (info.match(/^\s*([\w+#-]*)/)?.[1] ?? "").toLowerCase(); }

function tokenizeLine(line: string, syn: Syntax): string {
  let out = "", i = 0;
  const span = (cls: string, text: string) => '<span class="tk-' + cls + '">' + escapeHtml(text) + "</span>";
  while (i < line.length) {
    const rest = line.slice(i), ch = line[i]!;
    const comment = syn.comment.find(c => rest.startsWith(c));
    if (comment) { out += span("c", rest); break; }
    if (ch === '"' || ch === "'") {
      // A string ends at its first unescaped closing quote, or at the end of the line.
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      j = Math.min(j + 1, line.length);
      // An apostrophe inside prose-like text is not a string: only a closed single-quoted form is one.
      if (ch === "'" && line[j - 1] !== "'") { out += escapeHtml(ch); i++; continue; }
      out += span("s", line.slice(i, j)); i = j; continue;
    }
    const num = /^\d(?:\w|\.(?!\.))*/.exec(rest);
    if (num && !/[\w]/.test(line[i - 1] ?? "")) { out += span("n", num[0]); i += num[0].length; continue; }
    const word = /^[A-Za-z_]\w*/.exec(rest);
    if (word) {
      const w = word[0];
      if (syn.words && /^[A-Z]/.test(w)) out += span("t", w);
      else if (syn.words && WF_PRIMITIVES.has(w)) out += span("t", w);
      else if (syn.words && WF_KEYWORDS.has(w)) out += span("k", w);
      else out += escapeHtml(w);
      i += w.length; continue;
    }
    out += escapeHtml(ch); i++;
  }
  return out;
}

/** The inner HTML of one code block's <code>. `lang` is the fence's info string; an unlabeled or unknown language gets no
 * highlighting at all. With `numbered`, each line is wrapped in <span class="l"> so a CSS counter can number it. Lines
 * are joined by "\n", so the text content equals `src` exactly. */
export function highlightCode(src: string, info: string, numbered: boolean): string {
  const syn = LANGS[fenceLang(info)];
  return src.split("\n").map(line => {
    const html = syn ? tokenizeLine(line, syn) : escapeHtml(line);
    return numbered ? '<span class="l">' + html + "</span>" : html;
  }).join("\n");
}

/** A code block's HTML: line numbers when it has 3 or more lines. A mermaid block is wrapped for web/mermaid.ts, which draws it as a
 * diagram above its code; the code shows as it is until, and unless, the diagram is drawn. */
export function codeBlock(lines: string[], info: string): string {
  const numbered = lines.length >= 3;
  const pre = '<pre class="code' + (numbered ? " numbered" : "") + '"><code>' + highlightCode(lines.join("\n"), info, numbered) + "</code></pre>";
  return fenceLang(info) === "mermaid" ? '<div class="mermaid-block">' + pre + "</div>" : pre;
}
