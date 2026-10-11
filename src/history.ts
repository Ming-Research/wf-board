import { stringify } from "yaml";
import type { Store, DocKind } from "./store.ts";
import { OwnerState } from "./model.ts";
import type { Item } from "./model.ts";
import { describeChanges } from "./query.ts";

/** How many new things a document's change holds, counted as the owner's page always counted them: each new log
 * entry, each new reply, and one for any other visible change (a new item or card, a changed head, status, ...). */
export interface Pieces { log: number; reply: number; other: number }
export function piecesOf(before: unknown, after: unknown, kind: DocKind, summary: string): Pieces {
  const visible = summary !== "metadata changed";
  // A note counts through its reply; its state alone (sent, closed) is not news, but any other visible change is.
  if (kind === "note") {
    const parts = visible ? summary.split(", ") : [];
    return { log: 0, reply: parts.some(p => p === "new reply" || p === "reply changed") ? 1 : 0, other: before === null || after === null || parts.some(p => !["new reply", "reply changed", "state changed", "sentAt changed"].includes(p)) ? 1 : 0 };
  }
  if (kind === "decision") return { log: 0, reply: 0, other: visible ? 1 : 0 };
  const key = (e: { at: string; by?: string; text: string }) => e.at + "\u0000" + (e.by ?? "") + "\u0000" + e.text;
  const old = new Map<string, number>();
  for (const e of (before as Item | null)?.log ?? []) old.set(key(e), (old.get(key(e)) ?? 0) + 1);
  let log = 0;
  for (const e of (after as Item | null)?.log ?? []) { const n = old.get(key(e)) ?? 0; if (n) old.set(key(e), n - 1); else log++; }
  // An entry removed or rewritten in place is a change too, though not a new entry.
  const logRewritten = [...old.values()].some(n => n > 0);
  // A new item counts through its log entries, as the old page did; one without entries counts once.
  const otherChange = before === null ? log === 0 : logRewritten || summary.split(", ").some(part => visible && !/^(\+\d+ log|log changed)$/.test(part));
  return { log, reply: 0, other: otherChange ? 1 : 0 };
}

/** An unread stop. Read marks split consecutive changes at their baseline;
 * docs contains only unread documents, including the unread part of a shared commit. */
export interface Step {
  /** The final commit of this consecutive unread change. */
  id: string;
  commits: string[];
  /** The commit before the step's first, or null for a root commit: the step's "before" state. */
  parent: string | null;
  author: string;
  at: string;
  docs: Array<{ kind: DocKind; id: string; summary: string; pieces: Pieces }>;
}

// Steps depend only on the captured head, the cursor and document read marks, and past commits never change, so one computation serves every
// request until either moves (the page asks for steps and for each step's documents many times per read).
const memo = new WeakMap<Store, { key: string; steps: Promise<Step[]> }>();
export function unreadSteps(store: Store, cursor: string | undefined, readMarks: Record<string, string> = {}, head = store.snapshot().head): Promise<Step[]> {
  const marks = { ...readMarks };
  const key = head + "|" + (cursor ?? "") + "|" + JSON.stringify(Object.entries(marks).sort(([a], [b]) => a.localeCompare(b)));
  const hit = memo.get(store);
  if (hit?.key === key) return hit.steps;
  const steps = computeSteps(store, cursor, marks, head);
  memo.set(store, { key, steps });
  steps.catch(() => { if (memo.get(store)?.steps === steps) memo.delete(store); });
  return steps;
}

const described = new WeakMap<Store, Map<string, { summary: string; pieces: Pieces }>>();

async function computeSteps(store: Store, cursor: string | undefined, readMarks: Record<string, string>, head: string): Promise<Step[]> {
  OwnerState.pick({ readMarks: true }).parse({ readMarks });
  if (cursor && !(await store.inHistory(cursor, head))) throw new Error(`Read cursor ${cursor} is not in board history`);
  const commits = (await store.log({ since: cursor, at: head })).reverse();
  // The daemon writes a linear history. One bounded range and its positions
  // serve all marks, instead of rescanning the history for each document.
  const positions = new Map(commits.map((commit, index) => [commit.commit, index]));
  const markPositions = new Map<string, number>();
  const obsolete = new Set<string>();
  for (const [doc, mark] of Object.entries(readMarks)) {
    const position = positions.get(mark);
    if (position !== undefined) markPositions.set(doc, position);
    else if (mark !== cursor && !obsolete.has(mark)) {
      if (!cursor || !(await store.inHistory(mark, cursor))) throw new Error(`Read mark ${mark} is not in board history`);
      obsolete.add(mark);
    }
  }
  const steps: Step[] = [];
  let previous: Step | undefined;
  for (const [position, commit] of commits.entries()) {
    // An owner action breaks consecutiveness even though it is not a step.
    if (commit.author === "owner") { previous = undefined; continue; }
    const docs: Step["docs"] = commit.files.flatMap(file => {
      const m = /^(items|decisions|notes)\/(.+)\.yaml$/.exec(file);
      if (!m) return [];
      const kind = ({ items: "item", decisions: "decision", notes: "note" } as const)[m[1] as "items" | "decisions" | "notes"];
      return [{ kind, id: m[2]!, summary: "", pieces: { log: 0, reply: 0, other: 0 } }];
    });
    // A commit that changes no item, card or note (board settings, owner state) has nothing to read.
    if (!docs.length) { previous = undefined; continue; }
    const single = docs.length === 1 && commit.files.every(f => f === "state/owner.yaml" || /^(items|decisions|notes)\//.test(f));
    const unreadDocs = docs.filter(doc => position > (markPositions.get(`${doc.kind}:${doc.id}`) ?? -1));
    if (!unreadDocs.length) { previous = undefined; continue; }
    if (single && previous?.docs.length === 1 && previous.author === commit.author && previous.docs[0]!.kind === docs[0]!.kind && previous.docs[0]!.id === docs[0]!.id) {
      previous.commits.push(commit.commit); previous.id = commit.commit; previous.at = commit.at;
    } else {
      previous = { id: commit.commit, commits: [commit.commit], parent: commit.parents[0] ?? null, author: commit.author, at: commit.at, docs: unreadDocs };
      steps.push(previous);
    }
    if (!single) previous = undefined;
  }
  // A document's change between two commits never changes, so each is read from git once per server run; a new
  // commit then costs only the steps it creates or extends.
  let cache = described.get(store);
  if (!cache) { cache = new Map(); described.set(store, cache); }
  for (const step of steps) for (const doc of step.docs) {
    const key = (step.parent ?? "") + "|" + step.id + "|" + doc.kind + "|" + doc.id;
    let hit = cache.get(key);
    if (!hit) {
      const { before, after } = await endpoints(store, step, doc.kind, doc.id);
      const summary = describeChanges(before, after, doc.kind);
      hit = { summary, pieces: piecesOf(before, after, doc.kind, summary) };
      cache.set(key, hit);
    }
    doc.summary = hit.summary; doc.pieces = { ...hit.pieces };
  }
  // A document whose change holds nothing the owner can see (times, revisions, a status that became derived) is not unread.
  for (const step of steps) step.docs = step.docs.filter(doc => doc.pieces.log + doc.pieces.reply + doc.pieces.other > 0);
  return steps.filter(step => step.docs.length);
}

async function endpoints(store: Store, step: Step, kind: DocKind, id: string) {
  const parent = step.parent;
  return { parent, before: parent ? await store.show(kind, id, parent) : null, after: await store.show(kind, id, step.id) };
}

export async function stepDiff(store: Store, step: Step, kind: string, id: string): Promise<{ before: unknown | null; after: unknown | null; diff: string }> {
  if (kind !== "item" && kind !== "decision" && kind !== "note") throw new Error(`Unknown document kind ${kind}`);
  if (!step.docs.some(d => d.kind === kind && d.id === id)) throw new Error(`Document ${kind}:${id} is not in this step`);
  const { parent, before, after } = await endpoints(store, step, kind, id);
  // A root commit has no parent for Store.diff. Render its complete addition.
  const diff = parent ? await store.diff(kind, id, parent, step.id) : after === null ? "" :
    `--- /dev/null\n+++ ${kind}:${id}\n` + stringify(after, { lineWidth: 0, blockQuote: "literal" }).trimEnd().split("\n").map(l => `+${l}\n`).join("");
  return { before, after, diff };
}
