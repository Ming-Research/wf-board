import { stringify } from "yaml";
import type { Store, DocKind, CommitInfo } from "./store.ts";
import { OwnerState } from "./model.ts";
import type { Item } from "./model.ts";
import { describeChanges } from "./query.ts";
import { changedItemSteps, stepsChanged, changedItemTargets, targetsChanged, withoutLog } from "./rules.ts";

/** Owner-visible pieces: added or changed progress steps and targets, replies, and one for any other
 * visible document change. Logs are historical detail and never contribute unread content. */
export interface Pieces { progress: number; reply: number; other: number }
export function piecesOf(before: unknown, after: unknown, kind: DocKind, summary: string): Pieces {
  const visible = summary !== "metadata changed";
  // A note counts through its reply; its state alone (sent, closed) is not news, but any other visible change is.
  if (kind === "note") {
    const parts = visible ? summary.split(", ") : [];
    return { progress: 0, reply: parts.some(p => p === "new reply" || p === "reply changed") ? 1 : 0, other: before === null || after === null || parts.some(p => !["new reply", "reply changed", "state changed", "sentAt changed"].includes(p)) ? 1 : 0 };
  }
  if (kind === "decision") return { progress: 0, reply: 0, other: visible ? 1 : 0 };
  const oldSteps = (before as Item | null)?.steps, newSteps = (after as Item | null)?.steps;
  const oldTargets = (before as Item | null)?.targets, newTargets = (after as Item | null)?.targets;
  const progress = (stepsChanged(oldSteps, newSteps) ? Math.max(1, changedItemSteps(oldSteps, newSteps).length) : 0)
    + (targetsChanged(oldTargets, newTargets) ? Math.max(1, changedItemTargets(oldTargets, newTargets).length) : 0);
  // Inspect the item itself: log text and the agent-facing summary never decide owner visibility.
  const withoutProgress = (item: unknown) => {
    if (item === null) return null;
    const { steps: _steps, targets: _targets, ...rest } = withoutLog(item as Item);
    return rest;
  };
  const other = describeChanges(withoutProgress(before), withoutProgress(after), "item") !== "metadata changed";
  return { progress, reply: 0, other: other ? 1 : 0 };
}

/** Agent history retains log detail; the owner's unread summary describes visible content only. */
function ownerSummary(before: unknown, after: unknown, kind: DocKind): string {
  const omitLog = (doc: unknown) => {
    if (kind !== "item" || doc === null) return doc;
    return withoutLog(doc as Item);
  };
  return describeChanges(omitLog(before), omitLog(after), kind);
}
const hasPieces = (pieces: Pieces) => pieces.progress + pieces.reply + pieces.other > 0;

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

/** A run of the board's history, oldest first, in which each commit's only parent is the one before it; the first's
 * is `base`, or it has none when `base` is undefined. `position` numbers each commit, and `base` as -1. */
interface Chain { base: string | undefined; commits: CommitInfo[]; position: Map<string, number> }
// The daemon writes a linear history, so the commits after any cursor in the run are a slice of it, and a new head adds
// only the commits after the run's last: the history is walked once per server run, then once per new head over the
// new commits alone. A range the run does not hold (a merge, a cursor before its base) is read from git directly.
const chains = new WeakMap<Store, Chain>();
function continues(chain: Chain, commit: CommitInfo): boolean {
  const tip = chain.commits.at(-1)?.commit ?? chain.base;
  return tip === undefined ? !commit.parents.length : commit.parents.length === 1 && commit.parents[0] === tip;
}
function append(chain: Chain, commit: CommitInfo): void {
  chain.position.set(commit.commit, chain.commits.length);
  chain.commits.push(commit);
}
/** The cached run, extended to `head` when head continues it; undefined when it cannot hold `head`. */
async function reach(store: Store, head: string): Promise<Chain | undefined> {
  const chain = chains.get(store);
  if (!chain || chain.position.has(head)) return chain;
  const tip = chain.commits.at(-1)?.commit ?? chain.base;
  if (tip === undefined) return undefined;
  // Requests for the same new head can overlap; each appends only what the run does not hold yet.
  for (const commit of (await store.log({ since: tip, at: head })).reverse()) {
    if (chain.position.has(commit.commit)) continue;
    if (!continues(chain, commit)) break;
    append(chain, commit);
  }
  return chain.position.has(head) ? chain : undefined;
}

/** The commits after `since` (a full commit id, or undefined for the whole history) through `head`, oldest first:
 * exactly what `store.log({ since, at: head })` lists, reversed. */
export async function commitsSince(store: Store, since: string | undefined, head: string): Promise<CommitInfo[]> {
  const chain = await reach(store, head);
  const from = !chain ? undefined : since === undefined ? (chain.base === undefined ? -1 : undefined) : chain.position.get(since);
  if (chain && from !== undefined) return chain.commits.slice(from + 1, chain.position.get(head)! + 1);
  const commits = (await store.log({ since, at: head })).reverse();
  // A linear range becomes the cached run, so the next head and every later cursor in it need no walk of their own.
  const run: Chain = { base: since, commits: [], position: new Map<string, number>(since === undefined ? [] : [[since, -1]]) };
  for (const commit of commits) {
    if (!continues(run, commit)) return commits;
    append(run, commit);
  }
  if (run.position.has(head)) chains.set(store, run);
  return commits;
}

/** Whether `ref` is `at` or one of its ancestors, as `store.inHistory` answers; from the cached run when it holds both. */
export async function inHistory(store: Store, ref: string, at: string): Promise<boolean> {
  const chain = await reach(store, at).catch(() => undefined);
  const from = chain?.position.get(ref), to = chain?.position.get(at);
  return from !== undefined && to !== undefined ? from <= to : !!(await store.inHistory(ref, at));
}

const described = new WeakMap<Store, Map<string, { summary: string; pieces: Pieces }>>();

async function computeSteps(store: Store, cursor: string | undefined, readMarks: Record<string, string>, head: string): Promise<Step[]> {
  OwnerState.pick({ readMarks: true }).parse({ readMarks });
  if (cursor && !(await inHistory(store, cursor, head))) throw new Error(`Read cursor ${cursor} is not in board history`);
  const commits = await commitsSince(store, cursor, head);
  // One bounded range and its positions serve all marks, instead of rescanning the history for each document.
  const positions = new Map(commits.map((commit, index) => [commit.commit, index]));
  const markPositions = new Map<string, number>();
  const obsolete = new Set<string>();
  for (const [doc, mark] of Object.entries(readMarks)) {
    const position = positions.get(mark);
    if (position !== undefined) markPositions.set(doc, position);
    else if (mark !== cursor && !obsolete.has(mark)) {
      if (!cursor || !(await inHistory(store, mark, cursor))) throw new Error(`Read mark ${mark} is not in board history`);
      obsolete.add(mark);
    }
  }
  let cache = described.get(store);
  if (!cache) { cache = new Map(); described.set(store, cache); }
  const steps: Step[] = [];
  let previous: Step | undefined;
  for (const [position, commit] of commits.entries()) {
    // An owner action breaks consecutiveness even though it is not a step.
    if (commit.author === "owner") { previous = undefined; continue; }
    const docs: Step["docs"] = commit.files.flatMap(file => {
      const m = /^(items|decisions|notes)\/(.+)\.yaml$/.exec(file);
      if (!m) return [];
      const kind = ({ items: "item", decisions: "decision", notes: "note" } as const)[m[1] as "items" | "decisions" | "notes"];
      return [{ kind, id: m[2]!, summary: "", pieces: { progress: 0, reply: 0, other: 0 } }];
    });
    // A commit that changes no item, card or note (board settings, owner state) has nothing to read.
    if (!docs.length) { previous = undefined; continue; }
    const single = docs.length === 1 && commit.files.every(f => f === "state/owner.yaml" || /^(items|decisions|notes)\//.test(f));
    const unreadDocs: Step["docs"] = [];
    for (const doc of docs) {
      if (position <= (markPositions.get(`${doc.kind}:${doc.id}`) ?? -1)) continue;
      // Ignore each invisible commit before grouping: a log append must not advance an unread
      // stop's id or move the baseline of the next visible change.
      const key = "commit|" + commit.commit + "|" + doc.kind + "|" + doc.id;
      let hit = cache.get(key);
      if (!hit) {
        const before = commit.parents[0] ? await store.show(doc.kind, doc.id, commit.parents[0]) : null;
        const after = await store.show(doc.kind, doc.id, commit.commit);
        const summary = ownerSummary(before, after, doc.kind);
        hit = { summary, pieces: piecesOf(before, after, doc.kind, summary) };
        cache.set(key, hit);
      }
      if (hasPieces(hit.pieces)) unreadDocs.push(doc);
    }
    if (!unreadDocs.length) { previous = undefined; continue; }
    if (single && previous?.docs.length === 1 && previous.author === commit.author && previous.docs[0]!.kind === docs[0]!.kind && previous.docs[0]!.id === docs[0]!.id) {
      previous.commits.push(commit.commit); previous.id = commit.commit; previous.at = commit.at;
    } else {
      previous = { id: commit.commit, commits: [commit.commit], parent: commit.parents[0] ?? null, author: commit.author, at: commit.at, docs: unreadDocs };
      steps.push(previous);
    }
    if (!single) previous = undefined;
  }
  // Cache coalesced endpoints separately from individual commit visibility. A new head
  // only describes its new commits and the stops it creates or extends.
  for (const step of steps) for (const doc of step.docs) {
    const key = (step.parent ?? "") + "|" + step.id + "|" + doc.kind + "|" + doc.id;
    let hit = cache.get(key);
    if (!hit) {
      const { before, after } = await endpoints(store, step, doc.kind, doc.id);
      const summary = ownerSummary(before, after, doc.kind);
      hit = { summary, pieces: piecesOf(before, after, doc.kind, summary) };
      cache.set(key, hit);
    }
    doc.summary = hit.summary; doc.pieces = { ...hit.pieces };
  }
  // A document whose change holds nothing the owner can see (times, revisions, a status that became derived) is not unread.
  for (const step of steps) step.docs = step.docs.filter(doc => hasPieces(doc.pieces));
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
