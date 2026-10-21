import { PLAN_CONVERSION_MESSAGE } from "./convert-plans.ts";
import { stringify } from "yaml";
import { z } from "zod";
import { setImmediate } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { changedItemSteps, stepsChanged } from "./legacy-rules.ts";
import type { Item as LegacyItem } from "./legacy-model.ts";
import type { Store, DocKind, CommitInfo } from "./store.ts";
import { NUMBERING_MESSAGE, CARD_MIGRATION_MESSAGE } from "./store.ts";
import { OwnerState } from "./model.ts";
import type { Item } from "./model.ts";
import { describeChanges } from "./query.ts";
import { allowRange } from "./budget.ts";
import { changedItemPlan, planChanged, changedItemTargets, targetsChanged, withoutHistoricalDetail, withoutRatingBookkeeping } from "./rules.ts";

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
  const oldPlan = (before as Item | null)?.plan, newPlan = (after as Item | null)?.plan;
  const oldSteps = (before as LegacyItem | null)?.steps, newSteps = (after as LegacyItem | null)?.steps;
  const oldTargets = (before as Item | null)?.targets, newTargets = (after as Item | null)?.targets;
  const progress = (planChanged(oldPlan, newPlan) ? Math.max(1, changedItemPlan(oldPlan, newPlan).length) : 0)
    + (stepsChanged(oldSteps, newSteps) ? Math.max(1, changedItemSteps(oldSteps, newSteps).length) : 0)
    + (targetsChanged(oldTargets, newTargets) ? Math.max(1, changedItemTargets(oldTargets, newTargets).length) : 0);
  // Inspect the item itself: log text and the agent-facing summary never decide owner visibility.
  const withoutProgress = (item: unknown) => {
    if (item === null) return null;
    const { plan: _plan, steps: _steps, targets: _targets, ...rest } = withoutHistoricalDetail(item as Item & { steps?: unknown });
    return rest;
  };
  const [ownerBefore, ownerAfter] = withoutRatingBookkeeping(before as Item | null, after as Item | null);
  const other = describeChanges(withoutProgress(ownerBefore), withoutProgress(ownerAfter), "item") !== "metadata changed";
  return { progress, reply: 0, other: other ? 1 : 0 };
}

/** Agent history retains log detail; the owner's unread summary describes visible content only. */
function ownerSummary(before: unknown, after: unknown, kind: DocKind): string {
  const omitLog = (doc: unknown) => {
    if (kind !== "item" || doc === null) return doc;
    return withoutHistoricalDetail(doc as Item);
  };
  const [ownerBefore, ownerAfter] = kind === "item" ? withoutRatingBookkeeping(before as Item | null, after as Item | null) : [before, after];
  return describeChanges(omitLog(ownerBefore), omitLog(ownerAfter), kind);
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
// request until either moves (the page asks for steps and for each step's documents many times per read). A new head with the same cursor
// and marks continues the walk of an earlier head it descends from over the new commits alone (docs/design.md, section 4, Write cost); the
// last few lists are kept, so that the page can be told what changed since the one it holds (`unreadSince`).
interface Computed { key: string; head: string; version: string; walk: Promise<Walk>; steps: Promise<Step[]> }
const memo = new WeakMap<Store, Computed[]>();
const KEPT = 4;
// A version names the head, this store's run and a count within the run. The run is drawn at random, so that a page that kept its
// list across a restart of the daemon is not told by the new run's count, which starts again from nothing, that its list still holds.
const runs = new WeakMap<Store, { run: string; count: number }>();
function nextVersion(store: Store, head: string): string {
  let run = runs.get(store);
  if (!run) runs.set(store, run = { run: randomUUID().slice(0, 8), count: 0 });
  return `${head}.${run.run}.${++run.count}`;
}
function readKey(cursor: string | undefined, marks: Record<string, string>): string {
  return (cursor ?? "") + "|" + JSON.stringify(Object.entries(marks).sort(([a], [b]) => a.localeCompare(b)));
}
function computed(store: Store, cursor: string | undefined, readMarks: Record<string, string>, head: string): Computed {
  const marks = { ...readMarks }, key = readKey(cursor, marks), list = memo.get(store) ?? [];
  const hit = list.find(c => c.key === key && c.head === head);
  if (hit) return hit;
  // The newest list of the same reading state is the one a later head continues.
  const base = list.findLast(c => c.key === key);
  const walk = (async () => {
    const earlier = base && await base.walk.catch(() => undefined);
    return earlier && await inHistory(store, earlier.head, head) ? continueWalk(store, earlier, head) : startWalk(store, cursor, marks, head);
  })();
  const entry: Computed = { key, head, version: nextVersion(store, head), walk, steps: walk.then(w => finish(store, w)) };
  memo.set(store, [...list, entry].slice(-KEPT));
  entry.steps.catch(() => { const now = memo.get(store); if (now?.includes(entry)) memo.set(store, now.filter(c => c !== entry)); });
  return entry;
}
export function unreadSteps(store: Store, cursor: string | undefined, readMarks: Record<string, string> = {}, head = store.snapshot().head): Promise<Step[]> {
  return computed(store, cursor, readMarks, head).steps;
}
/** The unread list derived from nothing, sharing no walk and no finished stop with the lists above: what the continued walk must
 * equal (test/history.test.ts). */
export async function unreadStepsFromScratch(store: Store, cursor: string | undefined, readMarks: Record<string, string> = {}, head = store.snapshot().head): Promise<Step[]> {
  return finish(store, await startWalk(store, cursor, { ...readMarks }, head));
}
/** The unread list at `head` with its `version`, and when `since` is the version of a list of the same reading state still kept,
 * only what changed since it: `keep` steps of that list stay as they are and `steps` follow them. Without `keep`, `steps` is the whole list. */
export async function unreadSince(store: Store, cursor: string | undefined, readMarks: Record<string, string>, head: string, since?: string): Promise<{ version: string; steps: Step[]; keep?: number }> {
  const entry = computed(store, cursor, readMarks, head), steps = await entry.steps;
  const old = since === undefined ? undefined : memo.get(store)?.find(c => c.version === since && c.key === entry.key);
  const before = old && await old.steps.catch(() => undefined);
  if (!before || old === entry) return before ? { version: entry.version, steps: [], keep: steps.length } : { version: entry.version, steps };
  // A stop that did not change is the same object in both lists, so the lists agree up to the first stop that is another one.
  let keep = 0;
  while (keep < before.length && keep < steps.length && before[keep] === steps[keep]) keep++;
  return { version: entry.version, steps: steps.slice(keep), keep };
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

/** What one document's change reads as to the owner: the text of its summary and what in it is visible. */
interface Description { summary: string; pieces: Pieces }
/** The descriptions made so far, by `commitKey` or `stepKey`, and how many this run made (`added`; the ones loaded from the file do not count). */
interface Descriptions { byKey: Map<string, Description>; added: number }
const described = new WeakMap<Store, Descriptions>();
function descriptionsOf(store: Store): Descriptions {
  let known = described.get(store);
  if (!known) described.set(store, known = { byKey: new Map(), added: 0 });
  return known;
}
function remember(known: Descriptions, key: string, description: Description): Description {
  known.byKey.set(key, description);
  known.added++;
  return description;
}
// The key of a document's change at one commit, and at a stop that spans several (its parent, its last commit). Both name the end
// commit second, which is how the file keeps only those of the commits after the cursor (`exportDescriptions`). A stop of one
// commit is that commit's change, so it has no key of its own.
const commitKey = (commit: string, doc: { kind: string; id: string }) => "commit|" + commit + "|" + doc.kind + "|" + doc.id;
const stepKey = (parent: string | null, end: string, doc: { kind: string; id: string }) => (parent ?? "") + "|" + end + "|" + doc.kind + "|" + doc.id;

/** The format of the file the descriptions are kept in between runs (docs/design.md, section 4, The unread list across a restart).
 * Change it whenever `ownerSummary` or `piecesOf`, or what they read (`describeChanges`, `comparisonDocuments`, the plan and target
 * comparisons), give another result for the same two documents: a file of another version is ignored, and the next walk describes
 * the commits again. `test/unread-restart.test.ts` pins the descriptions of sample documents beside this number. */
export const DESCRIPTION_VERSION = 1;
const SavedDescriptions = z.object({
  version: z.literal(DESCRIPTION_VERSION),
  // 0: nothing in it the owner can see; otherwise the summary and the three counts of `Pieces`.
  entries: z.record(z.string(), z.union([z.literal(0), z.tuple([z.string(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative()])])),
}).strict();

/** The descriptions of the changes at `commits` (those of a stop of several commits go with its last), as the file keeps them. Only these
 * are written: the file holds what the walk after the cursor needs, and no description of what the owner has read. */
export function exportDescriptions(store: Store, commits: ReadonlySet<string>): { text: string; entries: number } {
  const entries: Record<string, 0 | [string, number, number, number]> = {};
  for (const [key, { summary, pieces }] of descriptionsOf(store).byKey) {
    if (!commits.has(key.split("|")[1]!)) continue;
    entries[key] = hasPieces(pieces) ? [summary, pieces.progress, pieces.reply, pieces.other] : 0;
  }
  return { text: JSON.stringify({ version: DESCRIPTION_VERSION, entries }), entries: Object.keys(entries).length };
}
/** Adds the descriptions a file written by `exportDescriptions` holds to the store's, keeping those it has; the number added. Throws when
 * the text is not such a file of the current version. */
export function importDescriptions(store: Store, text: string): number {
  const saved = SavedDescriptions.parse(JSON.parse(text)), known = descriptionsOf(store);
  let added = 0;
  for (const [key, entry] of Object.entries(saved.entries)) {
    if (known.byKey.has(key)) continue;
    known.byKey.set(key, entry === 0 ? { summary: "", pieces: { progress: 0, reply: 0, other: 0 } } : { summary: entry[0], pieces: { progress: entry[1], reply: entry[2], other: entry[3] } });
    added++;
  }
  return added;
}
/** How many descriptions this run of the store has made: what changed since a file was written. */
export const descriptionsMade = (store: Store): number => descriptionsOf(store).added;

// A walk that has to describe a long range runs for minutes, and a service that is stopping has five seconds (docs/design.md, section 4,
// Stopping): once told, the walks that are running end at their next commit and none begins.
const halted = new WeakSet<Store>();
export function haltUnread(store: Store): void { halted.add(store); }
function notHalted(store: Store): void {
  if (halted.has(store)) throw new Error("The unread list was not finished: the service is stopping");
}

/** A stop as the walk builds it, before its documents are described. The walk changes only its last stop, and only on a copy. */
interface RawStep { id: string; commits: string[]; parent: string | null; author: string; at: string; docs: Array<{ kind: "item" | "decision" | "note"; id: string }> }
/** Where a walk of the history after the cursor stands at `head`: its stops, the last of which the next commit may extend while
 * `open`, and how many commits it has passed, the position of the next. */
interface Walk { head: string; cursor: string | undefined; marks: Map<string, number>; position: number; steps: RawStep[]; open: boolean }

async function startWalk(store: Store, cursor: string | undefined, readMarks: Record<string, string>, head: string): Promise<Walk> {
  OwnerState.pick({ readMarks: true }).parse({ readMarks });
  if (cursor && !(await inHistory(store, cursor, head))) throw new Error(`Read cursor ${cursor} is not in board history`);
  const commits = await commitsSince(store, cursor, head);
  allowRange(commits.length);
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
  return walkOver(store, { head: cursor ?? "", cursor, marks: markPositions, position: 0, steps: [], open: false }, commits, head);
}

/** The walk of `earlier` carried on to `head`, a descendant of its head: only the commits after it are read. A mark lies at or
 * before the earlier head, so it decides nothing about these commits. */
async function continueWalk(store: Store, earlier: Walk, head: string): Promise<Walk> {
  if (earlier.head === head) return earlier;
  const commits = await commitsSince(store, earlier.head, head);
  allowRange(commits.length);
  return walkOver(store, earlier, commits, head);
}

async function walkOver(store: Store, from: Walk, commits: readonly CommitInfo[], head: string): Promise<Walk> {
  const known = descriptionsOf(store);
  const steps = from.steps.slice();
  // The open stop is copied before the first commit extends it, so the earlier walk stays as it was even when this one fails
  // halfway (a read of history refused by the budget), and the next head can still continue from it.
  let previous: RawStep | undefined = from.open ? steps.at(-1) : undefined, copied = false;
  for (const [offset, commit] of commits.entries()) {
    const position = from.position + offset;
    // Cached blobs and summaries can otherwise chain only microtasks and starve
    // page/MCP requests throughout a long cold history walk.
    await setImmediate();
    notHalted(store);
    // An owner action breaks consecutiveness even though it is not a step.
    // Format migrations (the plan conversion, numbering existing documents, moving the cards into the plans) are not news to the owner.
    if (commit.author === "owner" || commit.message === PLAN_CONVERSION_MESSAGE || commit.message === NUMBERING_MESSAGE || commit.message === CARD_MIGRATION_MESSAGE) { previous = undefined; continue; }
    // A message is no change the owner reads and no work on an item (docs/design.md, Messages): a commit of messages, alone
    // or with the owner's reading state that rode along, is passed over, so the same author's changes to one item on either
    // side of it still read as one step.
    if (commit.files.some(file => file.startsWith("messages/")) && commit.files.every(file => file.startsWith("messages/") || file === "state/owner.yaml")) continue;
    const docs: RawStep["docs"] = commit.files.flatMap(file => {
      const m = /^(items|decisions|notes)\/(.+)\.yaml$/.exec(file);
      if (!m) return [];
      const kind = ({ items: "item", decisions: "decision", notes: "note" } as const)[m[1] as "items" | "decisions" | "notes"];
      return [{ kind, id: m[2]! }];
    });
    // A commit that changes no item, card or note (board settings, owner state) has nothing to read.
    if (!docs.length) { previous = undefined; continue; }
    const single = docs.length === 1 && commit.files.every(f => f === "state/owner.yaml" || /^(items|decisions|notes)\//.test(f));
    const unreadDocs: RawStep["docs"] = [];
    for (const doc of docs) {
      if (position <= (from.marks.get(`${doc.kind}:${doc.id}`) ?? -1)) continue;
      // Ignore each invisible commit before grouping: a log append must not advance an unread
      // stop's id or move the baseline of the next visible change.
      const key = commitKey(commit.commit, doc);
      let hit = known.byKey.get(key);
      if (!hit) {
        const { before, after } = await store.comparisonDocuments(doc.kind, doc.id, commit.parents[0] ?? null, commit.commit);
        const summary = ownerSummary(before, after, doc.kind);
        hit = remember(known, key, { summary, pieces: piecesOf(before, after, doc.kind, summary) });
      }
      if (hasPieces(hit.pieces)) unreadDocs.push(doc);
    }
    if (!unreadDocs.length) { previous = undefined; continue; }
    if (single && previous?.docs.length === 1 && previous.author === commit.author && previous.docs[0]!.kind === docs[0]!.kind && previous.docs[0]!.id === docs[0]!.id) {
      if (!copied && previous === from.steps.at(-1)) { previous = { ...previous, commits: [...previous.commits] }; steps[steps.length - 1] = previous; }
      copied = true;
      previous.commits.push(commit.commit); previous.id = commit.commit; previous.at = commit.at;
    } else {
      previous = { id: commit.commit, commits: [commit.commit], parent: commit.parents[0] ?? null, author: commit.author, at: commit.at, docs: unreadDocs };
      steps.push(previous);
    }
    if (!single) previous = undefined;
  }
  return { head, cursor: from.cursor, marks: from.marks, position: from.position + commits.length, steps, open: previous !== undefined && previous === steps.at(-1) };
}

/** The finished stop of each walked stop, kept while the stop is the same object and ends at the same commit, so the lists of
 * two heads share the stops neither changed. */
const finished = new WeakMap<RawStep, { id: string; step: Step }>();
async function finish(store: Store, walk: Walk): Promise<Step[]> {
  const known = descriptionsOf(store);
  const steps: Step[] = [];
  for (const raw of walk.steps) {
    let done = finished.get(raw);
    if (done?.id !== raw.id) {
      // Cache coalesced endpoints separately from individual commit visibility. A new head
      // only describes its new commits and the stops it creates or extends.
      await setImmediate();
      notHalted(store);
      const docs: Step["docs"] = [];
      for (const doc of raw.docs) {
        // A stop of one commit is that commit's change, already described by the walk.
        const key = raw.commits.length === 1 ? commitKey(raw.id, doc) : stepKey(raw.parent, raw.id, doc);
        let hit = known.byKey.get(key);
        if (!hit) {
          const { before, after } = await store.comparisonDocuments(doc.kind, doc.id, raw.parent, raw.id);
          const summary = ownerSummary(before, after, doc.kind);
          hit = remember(known, key, { summary, pieces: piecesOf(before, after, doc.kind, summary) });
        }
        // A document whose change holds nothing the owner can see (times, revisions, a status that became derived) is not unread.
        if (hasPieces(hit.pieces)) docs.push({ kind: doc.kind, id: doc.id, summary: hit.summary, pieces: { ...hit.pieces } });
      }
      done = { id: raw.id, step: { id: raw.id, commits: [...raw.commits], parent: raw.parent, author: raw.author, at: raw.at, docs } };
      finished.set(raw, done);
    }
    if (done.step.docs.length) steps.push(done.step);
  }
  return steps;
}

async function endpoints(store: Store, step: Step, kind: DocKind, id: string) {
  const parent = step.parent;
  return { parent, before: parent ? await store.showCompared(kind, id, parent) : null, after: await store.showCompared(kind, id, step.id) };
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
