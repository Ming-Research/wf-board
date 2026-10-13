// Finding items and decision cards by title, and the reference tokens a comment holds, as plain functions so tests can
// check them without a page. The "/" search and the "#" popup in a comment share findTargets.

/** An item or a decision card the owner can search for or refer to. */
export interface Target {
  kind: "item" | "card";
  key: string;
  /** The title as plain text: an item's title, or a card's question. */
  title: string;
}

/** The targets whose title contains the query, ignoring case; an empty query matches them all. Input order is kept. */
export function findTargets<T extends Pick<Target, "title">>(targets: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q ? targets.filter(t => t.title.toLowerCase().includes(q)) : targets.slice();
}

// A reference token is [[it:<key>]] for an item and [[q:<key>]] for a decision card: an item and a card may share a key.
// Keys follow the board's Key pattern. Block text has no other use for double square brackets.
const REF = /\[\[(it|q):([A-Za-z0-9][A-Za-z0-9_.-]{0,199})\]\]/g;

export function refToken(kind: Target["kind"], key: string): string { return "[[" + (kind === "item" ? "it" : "q") + ":" + key + "]]"; }

/** The text with each reference token replaced by `render(kind, key)`, except inside `<code>` spans of rendered HTML. */
export function replaceRefs(html: string, render: (kind: Target["kind"], key: string) => string): string {
  return html.replace(new RegExp("(<code>.*?</code>)|" + REF.source, "g"), (whole, code: string | undefined, kind: string | undefined, key: string | undefined) =>
    code !== undefined ? code : render(kind === "it" ? "item" : "card", key!));
}

/** The "#query" the caret ends, or null: a "#" not glued to a word before it (as in Repo#341) and the text since it,
 * with no line break. `start` is where the "#" is. */
export function refQuery(text: string, caret: number): { start: number; query: string } | null {
  const hash = text.lastIndexOf("#", caret - 1);
  if (hash < 0 || hash >= caret) return null;
  if (hash > 0 && /[A-Za-z0-9_]/.test(text[hash - 1]!)) return null;
  const query = text.slice(hash + 1, caret);
  return /[\n#]/.test(query) ? null : { start: hash, query };
}

/** The references a text holds, as "it:<key>" and "q:<key>". */
export function refsIn(text: string): string[] { return text.includes("[[") ? [...text.matchAll(REF)].map(m => m[1] + ":" + m[2]) : []; }
