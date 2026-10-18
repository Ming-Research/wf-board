// Finding items and decision cards by title, and the reference tokens a comment holds, as plain functions so tests can
// check them without a page. The "/" search and the "#" popup in a comment share findTargets.
import { numRef } from "../src/model.ts";
import { REFERENCE as REF } from "../src/rules.ts";

/** An item or a decision card the owner can search for or refer to. */
export interface Target {
  kind: "item" | "card";
  key: string;
  /** The title as plain text: an item's title, or a card's question. */
  title: string;
  /** The permanent short number, when the document has one. */
  num?: number;
}

/** The targets whose title or key contains the query, ignoring case; an empty query matches them all. Input order is kept.
 * A target whose key is the query comes first, and so does the one holding the short number a number query ("812" or
 * "#812") names; the other matches follow. */
export function findTargets<T extends Pick<Target, "key" | "title" | "num">>(targets: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return targets.slice();
  const num = numRef(q);
  const exact = targets.filter(t => t.key.toLowerCase() === q || (num !== undefined && t.num === num));
  const found = targets.filter(t => t.title.toLowerCase().includes(q) || t.key.toLowerCase().includes(q));
  return [...exact, ...found.filter(t => !exact.includes(t))];
}

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
