// The comments of one list as a thread (docs/design.md, section 5, Comments): a comment whose anchor names another comment of the
// list follows it, and is listed right under it. As plain functions, so a test calls them directly.

/** The steps of indent a thread shows: a comment further in than this is drawn at the last step. */
export const THREAD_STEPS = 3;
/** The classes that indent a comment of this depth: none for a comment on its own, else `follow` and the step (`d1` to `d3`). */
export const stepClass = (depth: number): string => depth > 0 ? "follow d" + Math.min(depth, THREAD_STEPS) : "";

/** What the order needs of a comment: its id and the anchor it may carry. */
export interface Threadable { id: string; anchor?: { kind: string; id?: string } }

/** The comments, given in the order written, in the order the page lists them, each with its depth. That is the order written,
 * except that a comment which follows another one of the list comes right under it, after the comments that follow it in turn
 * (depth 0 for a comment on its own, 1 for one that follows it, 2 for one that follows that). A comment whose anchor names no
 * comment of the list (a log entry, a comment that is gone, itself) stays where its time puts it; so does the earliest of a ring
 * of comments that follow each other, which only a damaged board can hold, so that every comment is listed once. */
export function threadOrder<T extends Threadable>(notes: readonly T[]): Array<{ note: T; depth: number }> {
  // Most lists hold no follow-up. The page builds this list for every item and card it draws, so such a list costs one pass.
  if (!notes.some(n => n.anchor?.kind === "note")) return notes.map(note => ({ note, depth: 0 }));
  const listed = new Set(notes.map(n => n.id));
  const parentOf = (n: T) => n.anchor?.kind === "note" && n.anchor.id !== undefined && n.anchor.id !== n.id && listed.has(n.anchor.id) ? n.anchor.id : undefined;
  const followers = new Map<string, T[]>();
  for (const n of notes) {
    const parent = parentOf(n);
    if (parent !== undefined) followers.set(parent, [...followers.get(parent) ?? [], n]);
  }
  const out: Array<{ note: T; depth: number }> = [], placed = new Set<string>();
  const place = (n: T, depth: number) => {
    if (placed.has(n.id)) return;
    placed.add(n.id); out.push({ note: n, depth });
    for (const f of followers.get(n.id) ?? []) place(f, depth + 1);
  };
  for (const n of notes) if (parentOf(n) === undefined) place(n, 0);
  for (const n of notes) place(n, 0);
  return out;
}

/** The comment after which the composer of a follow-up to `parent` opens: the last comment of the thread under it, or `parent`
 * itself when nothing follows it yet. Undefined when `parent` is not in the list. */
export function threadEnd<T extends { note: { id: string }; depth: number }>(list: readonly T[], parent: string): string | undefined {
  const at = list.findIndex(x => x.note.id === parent);
  if (at < 0) return undefined;
  let end = at;
  while (end + 1 < list.length && list[end + 1]!.depth > list[at]!.depth) end++;
  return list[end]!.note.id;
}
