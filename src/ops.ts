import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { Key, Item, RunnerReport, runnerReportProblem, REMOVED_PRIORITY, PlanRowInput, PlanInput, ItemTargetInput, ItemTargetsInput, StepId, Decision, CARD_KINDS, CARD_KIND_WHAT, CARD_KIND_HOW, Note, Board, Glossary, GlossaryId, Term, Tag, TagName, Difficulty, ARCHITECT, ARCHITECT_ROLE, ARCHITECT_SESSION, ARCHITECT_WRITER, PROCESS_WRITERS, RETIRED_AUTHORS, isArchitect, mayRunProcess, tagApplies, tagsRequired, boardTags, Dispatch, dispatchCountProblem, dispatchResultProblem, isArchitectName, isRunner, isRunnerSession, RUNNER_SESSION, milliDollars, DISPATCH_ROLES, DISPATCH_RESULTS, DISPATCH_SIGNALS, ACCESS, writesAnyProject, Message, MESSAGE_TEXT_LIMIT } from "./model.ts";
import type { Access, CardKind, Part, PlanRow, ItemTarget, Link, Option, Snapshot, DispatchUsage, RunnerState } from "./model.ts";
import { hashToken, newToken } from "./credentials.ts";
import { Store, ConflictError, ValidationError } from "./store.ts";
import { BudgetError, allowRange } from "./budget.ts";
import type { Put } from "./store.ts";
import { rules, stampPlanRow, stampItemTarget, projectOrderAfter, withoutCardRow, followedRows, isRecordRow, OPTION_MAX_CHARS, isOpenMergeStep, mergeRowDone, checkKind, checkKey, HEAD_REVISED_LOG } from "./rules.ts";
import type { CheckId } from "./rules.ts";
import { describeChanges, mergeRowPulls, prKey } from "./query.ts";
import { summaryMark } from "./head-sections.ts";
import { editHead, HeadEditError } from "./head-edit.ts";
import type { SectionEdit, Replacement } from "./head-edit.ts";
import { normalizeTime, startLogLine, finishLogLine, openAgents } from "./dispatch.ts";
import { LiveStore, LIVE_ACTION_MAX, LIVE_ROLES } from "./live.ts";
import { RunnerHeartbeat } from "./runner-heartbeat.ts";
import type { LiveRole } from "./live.ts";
import { currentTrace } from "./write-trace.ts";

export class OpError extends Error {}
/** What to do instead, for the checks a write may not introduce (`refused` in CHECK_KINDS); the owner checks, which share one fix, are not listed. */
const REFUSED_FIX: Partial<Record<CheckId, string>> = {
  "dep-item-missing": "use set_plan to remove or replace the missing row",
  "dep-card-missing": "use set_plan to remove or replace the missing row",
  "dep-cycle": "use set_plan or move_item to remove the item-row cycle",
  "no-acceptance": "use set_plan to add at least one acceptance step where its check happens",
  "owned-across-projects": "use a shared row instead of ownership",
  "waits-on-standing": "a standing item never completes, so nothing waits for it or owns it except another standing item: remove the row with set_plan, or place the standing item at the top (move_item without owner) or under a standing item",
};
const OWNER_FIX = "use move_item to place the item under exactly one same-project owner";
/** A head copied from a cut `context` answer has lost the text the answer left out; writing it would drop that text (docs/design.md, section 6, Lean replies). */
function refuseSummary(head: string | undefined): void {
  const mark = head === undefined ? undefined : summaryMark(head);
  if (mark) throw new OpError(`head: it holds the line "${mark}", which context writes where it cut a section short, so it is a summary and not the head. Read the whole head with context section: "all", change that, and write it back`);
}
/** `credential`: the token a new dispatch writes with, shown once (only the hash is kept). `repeated`: the write was already made a moment ago, by the same session with the same text; nothing was written again. */
export interface Result { commit: string; id: string; rev?: number; summary: string; credential?: string; repeated?: true; /** What the writer should know about how the write was made: a revision that was behind and why the write stood. */ note?: string; /** What the write changed, shown for the writer to check without reading it back: the lines before and after each change of a head written in parts. */ changes?: string }
export interface Ops {
  createProject(a: { author: string; session?: string; access?: Access; name: string; repo?: string; after?: string }): Promise<Result>;
  updateProject(a: { author: string; session?: string; access?: Access; name: string; repo?: string; mainline?: string | null; after?: string }): Promise<Result>;
  closeNote(a: { author: string; session?: string; access?: Access; id: string; log: string }): Promise<Result>;
  createItem(a: { author: string; session?: string; access?: Access; key: string; owner?: string; after?: string[]; title: string; head?: string; accept?: string; record?: boolean; standing?: boolean; plan?: PlanRowInput[]; links?: Link[]; data?: string; group?: string; order?: number; children?: string[]; tags?: string[]; difficulty?: Difficulty }): Promise<Result>;
  appendLog(a: { author: string; session?: string; access?: Access; id: string; text: string }): Promise<Result>;
  /** The GitHub watch's write (docs/design.md, Watching GitHub): marks a merge row done and logs it in one commit, if the row is still open and every PR that counts for it is among `merged`; otherwise writes nothing. */
  markMerged(a: { author: string; session?: string; access?: Access; id: string; row: string; merged: Array<{ repo: string; number: number }>; log: string }): Promise<Result>;
  /** Adds one timed entry to today's architect journal record, creating the day's record under the notes item first. */
  journalEntry(a: { author: string; session?: string; access?: Access; text: string }): Promise<Result>;
  /** Records a session the architect or the runner started on an item, and logs the start on the item. */
  dispatchStart(a: { author: string; session?: string; access?: Access; id: string; role: (typeof DISPATCH_ROLES)[number]; level: number; model: string; effort?: string; agent: string; agentId: string; worktree?: string; startedAt?: string; did?: string }): Promise<Result>;
  /** Completes a started dispatch with its result, counts, usage and cost, and logs the end on the item. */
  dispatchFinish(a: { author: string; session?: string; access?: Access; id: string; agentId: string; result: (typeof DISPATCH_RESULTS)[number]; usage: DispatchUsage; cost: number; reports?: number; kickbacks?: number; rounds?: number; waited?: number; signals?: Array<{ kind: (typeof DISPATCH_SIGNALS)[number]; note?: string }>; note?: string; endedAt?: string; replace?: boolean }): Promise<Result>;
  /** The runner's report on the work on an item (docs/design.md, section 5, Runner reports): replaces the item's `runner`, stamps `since` and `at`, and writes nothing when the report changes nothing. */
  reportState(a: { author: string; session?: string; access?: Access; id: string; state: RunnerState; to?: "owner" | "architect"; cards?: string[]; items?: string[]; what?: string; until?: string; note?: string; turns?: number; cost?: number; startedAt?: string }): Promise<Result>;
  /**
   * The runner's beat for a turn it is running (docs/design.md, section 7, The live view of a turn): the same writers as `reportState`,
   * kept in the options' `live` store and nowhere else, so it makes no commit and does not wait in the write queue. Answers one line saying what it kept.
   */
  reportLive(a: { author: string; session?: string; access?: Access; id: string; role: LiveRole; turn: number; turnSeconds: number; idleSeconds?: number; action?: string }): Promise<string>;
  /**
   * The runner's heartbeat (docs/design.md, section 8, The runner's heartbeat): the same writers as `reportState`, kept in the options'
   * `heartbeat` and nowhere else, so it makes no commit and does not wait in the write queue. Answers one line saying what it kept.
   */
  reportHeartbeat(a: { author: string; session?: string; access?: Access }): Promise<string>;
  setPlan(a: { author: string; session?: string; access?: Access; id: string; rows?: PlanRowInput[]; row?: PlanRowInput; remove?: string }): Promise<Result>;
  setTargets(a: { author: string; session?: string; access?: Access; id: string; targets?: ItemTargetInput[]; target?: ItemTargetInput; remove?: string }): Promise<Result>;
  updateItem(a: { author: string; session?: string; access?: Access; id: string; rev: number; title?: string; head?: string; sections?: SectionEdit[]; replace?: Replacement[]; record?: boolean; standing?: boolean; accept?: string; reason?: string; links?: Link[]; data?: string | null; order?: number }): Promise<Result>;
  setStatus(a: { author: string; session?: string; access?: Access; id: string; status: "cancelled" | "open"; log: string }): Promise<Result>;
  setTags(a: { author: string; session?: string; access?: Access; id: string; tags: string[] }): Promise<Result>;
  /** set_tags for many items in one commit: the same checks per item, all or nothing. */
  setTagsMany(a: { author: string; session?: string; access?: Access; items: Array<{ id: string; tags: string[] }> }): Promise<Result>;
  /** The architect sets a difficulty on an item of any project, an engineer's credential on the items below the one it was started on; the change is logged with its reason. */
  setDifficulty(a: { author: string; session?: string; access?: Access; id: string; difficulty: Difficulty; reason: string }): Promise<Result>;
  /** set_difficulty for many items in one commit: the same checks and a log entry per item, all or nothing. `reason` is the default for entries that give none. */
  setDifficultyMany(a: { author: string; session?: string; access?: Access; reason?: string; items: Array<{ id: string; difficulty: Difficulty; reason?: string }> }): Promise<Result>;
  setTag(a: { author: string; session?: string; access?: Access; name: string; meaning: string; projects?: string[] | null }): Promise<Result>;
  renameTag(a: { author: string; session?: string; access?: Access; name: string; to: string }): Promise<Result>;
  removeTag(a: { author: string; session?: string; access?: Access; name: string; replace?: string }): Promise<Result>;
  setPause(a: { author: string; session?: string; access?: Access; id: string; paused: boolean; reason?: string }): Promise<Result>;
  moveItem(a: { author: string; session?: string; access?: Access; id: string; owner?: string; after?: string[] }): Promise<Result>;
  /** Moves an item and everything it owns to another project; an owner left behind keeps a shared row. */
  moveItemProject(a: { author: string; session?: string; access?: Access; id: string; project: string }): Promise<Result>;
  clearAsk(a: { author: string; session?: string; access?: Access; id: string; log: string }): Promise<Result>;
  /** Creates a card and its row in the item's plan in one commit, or revises an open card's question, kind, options and blocks. */
  writeCard(a: { author: string; session?: string; access?: Access; key: string; rev?: number; item: string; question: string; kind?: CardKind; options: Array<{ text: string; detail: string; recommended?: boolean }>; confidence?: { score?: number; reason: string }; blocks?: string | null; before?: string; after?: string[] }): Promise<Result>;
  /** Records the pick the owner made outside the page; a pick made on the page is recorded when the owner sends it. */
  ruleCard(a: { author: string; session?: string; access?: Access; key: string; choice?: string; ruling?: string }): Promise<Result>;
  /** Closes an open card nobody needs any more, with the reason in its item's log. */
  withdrawCard(a: { author: string; session?: string; access?: Access; key: string; log: string }): Promise<Result>;
  replyNote(a: { author: string; session?: string; access?: Access; id: string; reply: string; replace?: boolean }): Promise<Result>;
  setTerm(a: { author: string; session?: string; access?: Access; term: string; definition: string }): Promise<Result>;
  deleteTerm(a: { author: string; session?: string; access?: Access; term: string }): Promise<Result>;
  sendMessage(a: { author: string; session?: string; access?: Access; to: string; text: string; item?: string }): Promise<Result>;
}
/** `sessions`: the sessions of the long-lived credentials, which a message may go to besides the architect and the sessions
 * with an open dispatch (docs/design.md, Messages); none when the board runs without a credentials file. */
export interface OpsOptions {
  sessions?: () => Iterable<string>;
  /** Where `reportLive` keeps its beats; a store of its own when none is given. */
  live?: LiveStore;
  /** Where `reportHeartbeat` keeps the runner's heartbeat; one that tells nobody when none is given. */
  heartbeat?: RunnerHeartbeat;
}

// Shared across Ops instances: validation and multi-document writes are one
// operation. Store.commit still checks revisions against other store callers.
const queues = new WeakMap<Store, Promise<unknown>>();
/** The one text a call may leave empty: what a replacement of a head puts where the text it deletes was (`update_item`'s `replace`). */
const MAY_BE_EMPTY = /^input\.replace\.\d+\.new$/;
function nonempty(value: unknown, path = "input"): void {
  if (typeof value === "string" && !value.trim() && !MAY_BE_EMPTY.test(path)) throw new OpError(`${path}: provide nonempty text after trimming`);
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) nonempty(child, `${path}.${key}`);
}
function parse<T>(schema: z.ZodType<T>, doc: unknown): T {
  const parsed = schema.safeParse(doc);
  if (!parsed.success) {
    const messages = (issues: readonly { path: readonly PropertyKey[]; message: string; errors?: readonly (readonly { path: readonly PropertyKey[]; message: string }[])[] }[]): string[] => issues.flatMap(i => i.errors ? i.errors.flatMap(group => messages(group)) : [`${i.path.map(String).join(".") || "input"}: fix ${i.message}`]);
    throw new OpError(messages(parsed.error.issues).join("; "));
  }
  return parsed.data;
}
function requireItem(s: Snapshot, id: string, field = "id"): Item {
  const it = Object.hasOwn(s.items, id) ? s.items[id] : undefined;
  if (!it) throw new OpError(`${field} ${id}: choose an existing item`);
  return it;
}
function requireCard(s: Snapshot, key: string): Decision {
  const card = Object.hasOwn(s.decisions, key) ? s.decisions[key] : undefined;
  if (!card) throw new OpError(`key ${key}: choose an existing decision card`);
  return card;
}

/** The tags an item of `project` may carry, as a sentence for an error message. */
function allowedTags(s: Snapshot, project: string): string {
  const names = boardTags(s.board).filter(t => tagApplies(t, project)).map(t => t.name);
  return names.length ? `tags allowed for ${project}: ${names.join(", ")}` : `no tag is approved for ${project} yet; ${ARCHITECT} adds one after the owner approves it on a decision card`;
}
/**
 * Validates the tags a write gives an item of `project`: unique, in the vocabulary and applicable to the project.
 * `required`: at least one is needed whenever the vocabulary has a tag applicable to the project; before that none can be given.
 */
function checkedTags(s: Snapshot, project: string, tags: readonly string[] | undefined, required: boolean): string[] | undefined {
  const given = tags ?? [];
  if (new Set(given).size !== given.length) throw new OpError("tags: name each tag once");
  for (const name of given) {
    const tag = boardTags(s.board).find(t => t.name === name);
    if (!tag) throw new OpError(`tags ${name}: not in the tag vocabulary; ${allowedTags(s, project)}`);
    if (!tagApplies(tag, project)) throw new OpError(`tags ${name}: applies only to ${tag.projects!.join(", ")}, not ${project}; ${allowedTags(s, project)}`);
  }
  if (!given.length && required && tagsRequired(boardTags(s.board), project)) throw new OpError(`tags: give at least one; ${allowedTags(s, project)}`);
  return given.length ? [...given] : undefined;
}
/** Who is writing: the call's `author` and `session`, which together decide whether it speaks for the architect (model `isArchitect`), and the `access` the connection's credential grants, when it has one (credentials.ts). */
interface Writer { author: string; session?: string; access?: Access }
/** What the board reserves for the architect alone: every other writer is refused, and `what` names the operation in the message. */
function onlyArchitect(who: Writer, what: string): void {
  if (!isArchitect(who)) throw new OpError(`author: only ${ARCHITECT_WRITER} may ${what}`);
}
/** What the board reserves for the process, which the architect does: every other writer is refused, and `what` names the operation in the message. */
function onlyProcess(who: Writer, what: string): void {
  if (!mayRunProcess(who)) throw new OpError(`author: only ${PROCESS_WRITERS} may ${what}`);
}
/**
 * What the board reserves for the process (the architect) among writers that carry no credential. A write over a
 * credential is asked of the role's parts instead (`ACCESS`, checked by `mayWrite` before the write begins), where the
 * engineer has two of these.
 */
function onlyProcessWithoutCredential(who: Writer, what: string): void {
  if (!who.access) onlyProcess(who, what);
}
/**
 * The runner's report (`report_state`) among writers that carry no credential: the process, or the runner from its own session
 * (model `isRunner`). A write over a credential is asked of the role's parts instead.
 */
function onlyProcessOrRunnerWithoutCredential(who: Writer, what: string): void {
  if (!who.access && !mayRunProcess(who) && !isRunner(who)) throw new OpError(`author: only ${PROCESS_WRITERS}, or the runner from the session ${RUNNER_SESSION}, may ${what}`);
}
/** A difficulty as the log line writes it: the level, or 未评. */
const levelText = (difficulty: Difficulty | undefined): string => difficulty === undefined ? "未评" : String(difficulty);
/** The log line for a change of difficulty: from what to what, and why. */
const difficultyLogText = (from: Difficulty | undefined, to: Difficulty, reason: string): string => `难度：${levelText(from)} → ${levelText(to)}，理由：${reason}`;
const TAG_VOCABULARY = "change the tag vocabulary, and only after the owner approves the change on a decision card";

/** The architect's daily journal: one record per local day, kept under the notes item and tagged for process. */
const JOURNAL = { notes: "architect-notes", tag: "协作流程" };
/** The local calendar day and clock time of an ISO instant, as the journal's key and entry stamp use them. */
function localStamp(at: string): { day: string; clock: string } {
  const d = new Date(at), pad = (n: number) => String(n).padStart(2, "0");
  return { day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, clock: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

/** A dispatch time argument as the full UTC time; the server's clock when the caller gave none. */
function dispatchTime(given: string | undefined, now: string, field: string): string {
  if (given === undefined) return now;
  const time = normalizeTime(given);
  if (!time) throw new OpError(`${field}: give a UTC time such as 2026-10-16T09:02Z`);
  return time;
}

function newKey(s: Snapshot, key: string): void {
  if (!Key.safeParse(key).success) throw new OpError("key: use 1–200 letters, digits, dots, underscores or hyphens, starting with a letter or digit");
  if (Object.hasOwn(s.items, key) || Object.hasOwn(s.decisions, key)) throw new OpError(`key ${key}: already used; choose a new item or decision key`);
}

/** `kind` names the document whose revision the result reports; "board" and "items" (a write over many items) report none. */
interface Work { /** Passed on to the answer (`Result.note`). */ note?: string; /** Passed on to the answer (`Result.changes`). */ changes?: string; moved?: string[]; /** The earlier write this one repeats: nothing is written, this is the answer. */ replayed?: Result; id: string; kind: Put["kind"] | "board" | "items"; message: string; puts: Put[]; board?: Board }
/** The answer's line for an owned row the write made or changed that starts behind rows of its owner's plan not done yet: the item
 * stays blocked until they are done, and `after: []` on its row starts it at once. Nothing when every such row has come up. */
function behindNote(before: Snapshot, after: Snapshot, newRules: ReturnType<typeof rules>, written: ReadonlySet<string>): string | undefined {
  const lines: string[] = [];
  for (const id of written) for (const row of after.items[id]?.plan ?? []) {
    if (!("item" in row && row.own) || !newRules.isOpenWork(row.item)) continue;
    const was = before.items[id]?.plan?.find(r => "item" in r && r.item === row.item && r.own);
    if (was !== undefined && isDeepStrictEqual(was, row)) continue;
    const waits = newRules.ownerRowWaits(row.item);
    if (waits.length) lines.push(`${row.item} is blocked: its row in ${id}'s plan waits for ${waits.join(", ")}, not done yet; to start it at once, give that row after: [] (create_item's after, or set_plan on ${id})`);
  }
  return lines.length ? lines.join("; ") : undefined;
}
/** Required checks depend on plan structure and open status, not logs or display
 * metadata. Follow status changes backwards through both graphs, then include
 * the targets whose ownership requirement can change when a waiter opens.
 * Both graphs matter when rows or card/note targets are removed or replaced.
 * Sound only while every check matched by `required` in `run` reads just the
 * inputs compared here; widen this when such a check reads another field.
 */
function requiredCheckItems(before: Snapshot, after: Snapshot, work: Work, oldRules: ReturnType<typeof rules>, newRules: ReturnType<typeof rules>): Set<string> {
  if (work.board) return new Set(Object.keys(after.items));
  const affected = new Set<string>();
  const itemInputs = (it: Item | undefined) => it && { group: it.group, record: it.record, standing: it.standing, status: it.status, paused: it.paused, plan: it.plan, ask: it.ask };
  const noteInputs = (note: Note | undefined) => note && { target: note.target, kind: note.kind, state: note.state, text: note.text, answerText: note.answerText };
  const card = (key: string) => {
    for (const s of [before, after]) { const owner = s.decisions[key]?.item; if (owner) affected.add(owner); }
    for (const r of [oldRules, newRules]) for (const waiter of r.cardDependents(key)) affected.add(waiter.id);
  };
  for (const put of work.puts) {
    if (put.kind === "item") {
      if (!isDeepStrictEqual(itemInputs(before.items[put.id]), itemInputs(after.items[put.id]))) affected.add(put.id);
    } else if (put.kind === "decision") {
      if (!isDeepStrictEqual(before.decisions[put.id], after.decisions[put.id])) card(put.id);
    } else if (put.kind === "note" && !isDeepStrictEqual(noteInputs(before.notes[put.id]), noteInputs(after.notes[put.id]))) {
      for (const s of [before, after]) {
        const target = s.notes[put.id]?.target;
        if (target?.startsWith("it:")) affected.add(target.slice(3));
        else if (target?.startsWith("q:")) card(target.slice(2));
      }
    }
  }
  // Ownership changes and pause markers can change every descendant's effective
  // pause without writing that descendant. Follow both ownership trees first.
  for (const id of affected) for (const r of [oldRules, newRules]) for (const child of r.children(id)) affected.add(child);
  // Set iteration visits newly added members too, giving a transitive closure.
  for (const id of affected) for (const r of [oldRules, newRules]) for (const waiter of r.dependents(id)) affected.add(waiter.id);
  const checked = new Set(affected);
  for (const id of affected) for (const s of [before, after]) for (const row of s.items[id]?.plan ?? []) if ("item" in row) checked.add(row.item);
  return checked;
}
/** The document this operation already wrote for an item, else the snapshot's. */
function docOf(s: Snapshot, puts: Put[], id: string, field = "id"): Item {
  return (puts.find(p => p.kind === "item" && p.id === id)?.doc as Item | undefined) ?? requireItem(s, id, field);
}
/** An item's title for a log line the owner reads: this operation's own write if any, else the snapshot's; the key only for an item that does not exist. */
function titleOf(s: Snapshot, puts: Put[], id: string): string {
  return ((puts.find(p => p.kind === "item" && p.id === id)?.doc as Item | undefined) ?? s.items[id])?.title ?? id;
}
function putDoc(puts: Put[], put: Put): void {
  const i = puts.findIndex(p => p.kind === put.kind && p.id === put.id);
  if (i < 0) puts.push(put); else puts[i] = { ...put, expectRev: puts[i]!.expectRev };
}
function requireProject(s: Snapshot, name: string) {
  const project = s.board.projects.find(p => p.name === name);
  if (!project) throw new OpError(`project ${name}: choose a configured project with projects`);
  return project;
}
function projectOrder(projects: Board["projects"], a: Writer & { name: string; after?: string }): Board["projects"] {
  if (a.after === undefined) return projects;
  try { return projectOrderAfter(projects, a.name, a.after, a); }
  catch (error) { throw new OpError((error as Error).message); }
}
function requireAuthor(s: Snapshot, author: string, prefix = ""): void {
  if (!s.board.projects.some(p => p.name === author)) throw new OpError(`${prefix}author ${author}: choose a configured project (${s.board.projects.map(p => p.name).join(", ")}); call projects and use the project whose repo matches your repository`);
}
function requireOwnership(s: Snapshot, project: string, who: Writer, id: string): void {
  const refusal = `item ${id} belongs to project ${project}; report what you need from it to the architect, who creates work another project needs in the project that delivers it`
    + (who.author === ARCHITECT ? `; only ${PROCESS_WRITERS} write other projects' items` : "");
  requireAuthor(s, who.author, who.author === project ? "" : `${refusal}. `);
  if (who.author !== project && !mayRunProcess(who) && !(who.access && writesAnyProject(who.access.role))) throw new OpError(refusal);
}
/** The author's own glossary, the only one it may change; an empty one when it has none yet. */
function ownGlossary(s: Snapshot, author: string): Glossary {
  requireAuthor(s, author);
  if (!GlossaryId.safeParse(author).success) throw new OpError(`author ${author}: a project whose name contains a slash or starts with a dot cannot keep a glossary file`);
  return s.glossaries[author] ?? { terms: [], rev: 1 };
}
function ownedItem(s: Snapshot, id: string, who: Writer, field = "id"): Item {
  const it = requireItem(s, id, field);
  // An existing item's project is its group (rules projectOf), read without deriving the board.
  requireOwnership(s, it.group, who, id);
  return it;
}
function ownedNote(s: Snapshot, id: string, who: Writer): { note: Note; item: string } {
  const note = Object.hasOwn(s.notes, id) ? s.notes[id] : undefined;
  if (!note) throw new OpError(`id ${id}: choose an existing note`);
  const item = note.target.startsWith("it:") ? note.target.slice(3) : requireCard(s, note.target.slice(2)).item;
  ownedItem(s, item, who);
  return { note, item };
}

/** The parts an update_item changes, by the fields it gives. */
function updateParts(a: { title?: string; head?: string; sections?: unknown; replace?: unknown; links?: unknown; data?: string | null; order?: number; record?: boolean; standing?: boolean; accept?: string }): Part[] {
  const parts: Part[] = [];
  if (a.title !== undefined) parts.push("item.title");
  if (a.head !== undefined || a.sections !== undefined || a.replace !== undefined) parts.push("item.head");
  if (a.links !== undefined) parts.push("item.links");
  if (a.data !== undefined) parts.push("item.data");
  if (a.order !== undefined) parts.push("item.order");
  if (a.record !== undefined || a.accept !== undefined) parts.push("item.record");
  if (a.standing !== undefined) parts.push("item.standing");
  return parts;
}
/** A write that adds a log line, made again by the same session within this long, is the retry of a write whose answer was lost, and is not made again (docs/design.md, section 4). */
const REPEAT_MS = 60_000;

export function ops(store: Store, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), options: OpsOptions = {}): Ops {
  const live = options.live ?? new LiveStore();
  const heartbeat = options.heartbeat ?? new RunnerHeartbeat({ tell: () => {} });
  /** The rules every reader of `s` shares (store.derived): one derivation per snapshot instead of one per check. */
  const rulesOf = (s: Snapshot) => store.derived.rules(s);
  /** The version of the document that carried `rev`, read back from its history; none when `rev` never existed or the history is more than a request may read. */
  async function versionAt(kind: "item" | "decision", id: string, rev: number, current: Item | Decision): Promise<Item | Decision | null> {
    // Each write raises the revision by one, so a revision above the current one never existed, and going back from the
    // newest version, the first one below the wanted revision means it is not in the history. Neither case reads on.
    try {
      if (rev <= current.rev) {
        // Each write raised the revision by one, so the version wanted is the `current.rev - rev + 1`th newest commit of the
        // document, and git is asked for no more. Asked for all of them, it looks through the whole history for the commits of a
        // document that has few: 2 to 3 s with 27,666 commits, with every other write waiting (item write-tail-3s).
        const versions = await store.log({ kind, id, limit: current.rev - rev + 1 });
        allowRange(versions.length);
        for (const commit of versions) {
          const doc = await store.show(kind, id, commit.commit) as Item | Decision | null;
          if (doc?.rev === rev) return doc;
          if (doc && doc.rev < rev) break;
        }
      }
    } catch (error) {
      // The conflict is still the answer when the history it is explained from is more than a request may read.
      if (!(error instanceof BudgetError)) throw error;
    }
    return null;
  }
  /** The refusal of a write on a revision that is behind. `before`: the version `rev` names when the caller has read it already. */
  async function stale(kind: "item" | "decision", id: string, rev: number, current: Item | Decision, before?: Item | Decision | null): Promise<never> {
    if (before === undefined) before = await versionAt(kind, id, rev, current);
    throw new OpError(`rev ${rev}: current rev ${current.rev}; ${before ? describeChanges(before, current, kind) : "previous revision unavailable; " + currentTitle(current)}. Read context and redo with current rev ${current.rev}`);
  }
  function currentTitle(doc: Item | Decision): string { return ("title" in doc ? doc.title : doc.question).replace(/\s+/g, " ").slice(0, 100); }
  async function revision(kind: "item" | "decision", id: string, rev: number, doc: Item | Decision): Promise<void> {
    if (!Number.isSafeInteger(rev) || rev < 1) throw new OpError("rev: provide the positive integer revision read from context");
    if (rev !== doc.rev) await stale(kind, id, rev, doc);
  }
  /**
   * The check of a write that replaces some fields of an item, which names the revision it read (docs/design.md, section 5).
   * It stands when that is the current revision, or when none of `fields` has changed since: the writer read the fields it
   * replaces, and what else changed meanwhile (a log line, a plan row) is not lost by replacing them. Otherwise, or when the
   * revision cannot be read back, the write is refused as for any stale revision. Answers what changed meanwhile, for the writer.
   */
  async function fieldsRevision(id: string, rev: number, it: Item, fields: readonly (keyof Item)[]): Promise<string | undefined> {
    if (!Number.isSafeInteger(rev) || rev < 1) throw new OpError("rev: provide the positive integer revision read from context");
    if (rev === it.rev) return undefined;
    const before = await versionAt("item", id, rev, it) as Item | null;
    if (!before || fields.some(field => !isDeepStrictEqual(before[field], it[field]))) await stale("item", id, rev, it, before);
    return `rev ${rev} was behind (current rev ${it.rev}): ${describeChanges(before, it, "item")} since, and ${fields.join(", ")} did not change, so the edit was written`;
  }
  /** The items of the subtrees that start at `roots`: each root and everything it owns, at any depth. */
  function subtreeOf(s: Snapshot, roots: readonly string[]): Set<string> {
    const r = rulesOf(s), seen = new Set<string>();
    const stack = roots.filter(id => Object.hasOwn(s.items, id));
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) if (!seen.has(id)) { seen.add(id); stack.push(...r.children(id).filter(child => Object.hasOwn(s.items, child))); }
    return seen;
  }
  /** What the credential's role may do with these parts (docs/design.md, section 9): refused at once for a part the role has none of. */
  function mayWrite(a: Writer, parts: readonly Part[]): void {
    if (!a.access) return;
    const refused = parts.filter(part => ACCESS[a.access!.role][part] === undefined);
    if (refused.length) throw new OpError(`${refused.join(", ")}: a ${a.access.role} credential may not write ${refused.length === 1 ? "this part" : "these parts"}; report what you need to the architect, who writes it or passes it on`);
  }
  /** After the write is made: when a part is limited to the credential's subtree, every document the write changes must be inside it. */
  function withinScope(s: Snapshot, a: Writer, parts: readonly Part[], work: Work): void {
    if (!a.access || !parts.some(part => ACCESS[a.access!.role][part] === "subtree" || ACCESS[a.access!.role][part] === "below")) return;
    const { role, project, roots } = a.access, inside = subtreeOf(s, roots), below = parts.filter(part => ACCESS[role][part] === "below");
    const outside = (id: string) => new OpError(`item ${id}: outside the subtree of ${roots.join(", ")}, the only items a ${role} credential writes for ${parts.join(", ")}`);
    if (work.board) throw new OpError(`board: a ${role} credential does not change projects or tags`);
    // An item this write creates is inside when an item of the subtree owns it: the credential writes it from then on.
    // One that no such item owns (a top item, say) stays outside and is refused below.
    const ownedInside = new Set<string>();
    for (const put of work.puts) if (put.kind === "item" && inside.has(put.id)) for (const row of (put.doc as Item).plan ?? []) if ("item" in row && row.own) ownedInside.add(row.item);
    for (const put of work.puts) if (put.kind === "item" && put.expectRev === null && ownedInside.has(put.id)) inside.add(put.id);
    // The documents that already existed come first, so a new item put under an owner outside the subtree names that owner.
    for (const put of [...work.puts.filter(p => p.expectRev !== null), ...work.puts.filter(p => p.expectRev === null)]) {
      if (put.kind === "item" && !inside.has(put.id)) throw outside(put.id);
      // The items the credential was started on are handed to it with their level; only the ones below them are rated by it.
      else if (put.kind === "item" && below.length && roots.includes(put.id)) throw new OpError(`item ${put.id}: the root of this ${role} credential keeps the level it was handed; ${below.join(", ")} reaches only the items below it, and the ${ARCHITECT} changes the root's`);
      // A row that owns an item puts it under this one: the credential would then write it, so it may own only what it already writes.
      else if (put.kind === "item") { for (const row of (put.doc as Item).plan ?? []) if ("item" in row && row.own && !inside.has(row.item)) throw outside(row.item); }
      else if (put.kind === "decision" && !inside.has((put.doc as Decision).item)) throw outside((put.doc as Decision).item);
      else if (put.kind === "note") { const t = (put.doc as Note).target, item = t.startsWith("it:") ? t.slice(3) : s.decisions[t.slice(2)]?.item ?? ""; if (!inside.has(item)) throw outside(item || t); }
      else if (put.kind === "glossary" && put.id !== project) throw new OpError(`glossary ${put.id}: a ${role} credential writes only its own project's glossary (${project})`);
    }
  }
  /** What every write asks of its call before it reads anything: the table for a credential's role, the text of every field, the removed names, the session and the author. */
  function checkWriter(a: Writer, parts: readonly Part[]): void {
    mayWrite(a, parts);
    nonempty(a);
    if (Object.hasOwn(a, "priority")) throw new OpError(REMOVED_PRIORITY);
    for (const key of ["parent", "parentWhy", "parentOwnWork", "parent_why", "parent_own_work", "new_parent", "sourceStatus", "sourcePriority", "source_status", "source_priority", "deps", "steps", "step", "migrated", "provisional"]) if (Object.hasOwn(a, key)) throw new OpError(`${key}: removed by item plans`);
    if (a.session !== undefined && (typeof a.session !== "string" || a.session.trim().length > 80 || /\p{Cc}/u.test(a.session))) throw new OpError("session: give your session name, 1-80 characters without control characters");
    if (typeof a.author !== "string" || !a.author.trim() || /[<>\r\n\0]/.test(a.author)) throw new OpError("author: provide your project name without <, >, newlines or NUL");
    if (RETIRED_AUTHORS.includes(a.author)) throw new OpError(`author ${a.author}: this identity is retired; write as ${ARCHITECT} (session ${ARCHITECT_SESSION}), which does the process and keeps the rules`);
  }
  function run(a: Writer, parts: Part | readonly Part[], make: (s: Snapshot, at: string) => Promise<Work> | Work, overwrite = false, anyAuthor = false): Promise<Result> {
    // Where the call's time goes is told in its log line (src/write-trace.ts): the wait here, then the checks before the commit.
    const trace = currentTrace();
    const task = (queues.get(store) ?? Promise.resolve()).then(async () => {
      trace?.lap("ops queue");
      const partList = typeof parts === "string" ? [parts] : parts;
      checkWriter(a, partList);
      for (;;) {
        const s = store.snapshot(), at = now();
        const work = await make(s, at);
        if (work.replayed) return { ...work.replayed, repeated: true as const };
        if (!anyAuthor) requireAuthor(s, a.author);
        // A write of messages alone changes no item, card or note: no rule of the board reads it, so none is checked.
        let behind: string | undefined;
        if (work.board || work.puts.some(p => p.kind !== "message")) {
          // Validate the prospective board, including indirect effects on children,
          // dependents and items whose owner actions a card/note write changes.
          // snapshot() freezes every document. Only these collection slots change;
          // copying all existing plans and logs is unnecessary for a prospective write.
          const next: Snapshot = { ...s, items: { ...s.items }, decisions: { ...s.decisions }, notes: { ...s.notes }, glossaries: { ...s.glossaries } };
          if (work.board) next.board = parse(Board, work.board);
          for (const put of work.puts) {
            if (put.kind === "item") next.items[put.id] = parse(Item, put.doc);
            else if (put.kind === "decision") next.decisions[put.id] = parse(Decision, put.doc);
            else if (put.kind === "glossary") next.glossaries[put.id] = parse(Glossary, put.doc);
            else if (put.kind === "note") next.notes[put.id] = parse(Note, put.doc);
          }
          const beforeRules = rulesOf(s);
          // Rules of a prospective state are built once per state: again only after a step below changes `next`.
          const candidate = () => store.derived.candidate(s, next);
          const written = new Set(work.puts.filter(p => p.kind === "item").map(p => p.id));
          const afterRules = candidate();
          withinScope(s, a, partList, work);
          const checked = requiredCheckItems(s, next, work, beforeRules, afterRules);
          behind = behindNote(s, next, afterRules, written);
          // Pause permission covers open work resumed through any indirect effect,
          // including unwritten descendants. Closing work is allowed when its
          // explicit marker stays intact; reopening will restore that pause.
          if (!mayRunProcess(a)) for (const id of checked) {
            const clearedMarker = s.items[id]?.paused && !next.items[id]?.paused;
            const resumedWork = beforeRules.isPaused(id) && afterRules.isOpenWork(id) && !afterRules.isPaused(id);
            if (!clearedMarker && !resumedWork) continue;
            const source = clearedMarker ? id : beforeRules.pausedBy(id)!;
            throw new OpError(`paused: 「${s.items[id]!.title}」 (${id}) is paused by 「${s.items[source]!.title}」 (${source}); only the owner or ${PROCESS_WRITERS} can resume it`);
          }
          for (const id of written) {
            const old = s.items[id], current = next.items[id]!;
            for (const row of current.plan ?? []) {
              if (!("item" in row && row.own)) continue;
              if (next.items[row.item] && current.group !== next.items[row.item]!.group) throw new OpError(`owner: 跨项目拥有 ${row.item}; use a shared row`);
              // The first item, in key order, whose plan owns it: what rules' parentOf gives.
              const existing = beforeRules.parentOf(row.item);
              if (existing && existing !== id && !work.moved?.includes(row.item)) throw new OpError(`owner: 被多个条目拥有 ${row.item}; current owner ${existing}; use move_item`);
            }
            for (const row of old?.plan ?? []) {
              if (!("item" in row && row.own) || work.moved?.includes(row.item) || !beforeRules.isOpenWork(row.item)) continue;
              if (!current.plan?.some(r => "item" in r && r.item === row.item && r.own)) throw new OpError(`plan ${id}: ${row.item} is open; use move_item or cancel it before removing its owned row`);
            }
          }
          for (const id of Object.keys(next.items)) {
            if (!checked.has(id)) continue;
            const oldChecks = new Set(beforeRules.refusals(id).map(checkKey));
            for (const check of afterRules.refusals(id)) {
              if (checkKind(check.id).refused && !oldChecks.has(checkKey(check))) {
                const fix = REFUSED_FIX[check.id] ?? OWNER_FIX;
                throw new OpError(`item ${id}: "${check.text}"${check.target && !check.text.endsWith(check.target.id) ? ` ${check.target.id}` : ""}; ${fix}`);
              }
            }
          }
        }
        trace?.lap("check");
        try {
          const result = await store.commit({ author: a.author, ...(a.session === undefined ? {} : { session: a.session.trim() }), message: work.message, puts: work.puts, board: work.board });
          const note = [work.note, behind].filter((line): line is string => line !== undefined).join("; ");
          return { commit: result.commit, id: work.id, ...(work.kind === "board" || work.kind === "items" ? {} : { rev: result.revs[`${work.kind}:${work.id}`]! }), summary: work.message, ...(note === "" ? {} : { note }), ...(work.changes === undefined ? {} : { changes: work.changes }) };
        } catch (error) {
          if (error instanceof ConflictError) {
            if (!overwrite) continue;
            if (error.currentDoc && (error.kind === "item" || error.kind === "decision")) await stale(error.kind, error.id, error.expectedRev!, error.currentDoc as Item | Decision);
            throw new OpError(`rev: ${error.message}; read context and redo`);
          }
          if (error instanceof ValidationError) throw new OpError(`${error.message}; fix the named fields`);
          throw error;
        }
      }
    });
    queues.set(store, task.catch(() => {}));
    return task;
  }
  const itemPut = (id: string, doc: Item): Put => ({ kind: "item", id, doc: parse(Item, doc), expectRev: doc.rev });
  const entry = (author: string, at: string, text: string) => ({ at, by: author, text });
  /** `reserved`: names an operation only the architect may do; its refusal comes before the ownership check. */
  function edit(a: Writer & { id: string }, part: Part, name: string, change: (it: Item, s: Snapshot, at: string) => Item | Promise<Item>, overwrite = false, suffix = "", reserved?: string): Promise<Result> {
    return run(a, part, async (s, at) => {
      if (reserved) onlyArchitect(a, reserved);
      return { id: a.id, kind: "item", message: `${name} ${a.id}${suffix}`, puts: [itemPut(a.id, await change(ownedItem(s, a.id, a), s, at))] };
    }, overwrite);
  }
  /** The item with its whole tag list set: the one rule set_tags and set_tags_many share; the item itself when unchanged. */
  function tagged(it: Item, s: Snapshot, at: string, given: string[]): Item {
    if (!Array.isArray(given) || !given.length) throw new OpError(`tags: give the item's whole tag list, at least one tag; ${allowedTags(s, it.group)}`);
    const tags = checkedTags(s, it.group, given, true)!;
    return isDeepStrictEqual(tags, it.tags) ? it : { ...it, tags, updated: at };
  }
  /** The item with its difficulty set and the change logged: the one rule set_difficulty and set_difficulty_many share; the item itself when unchanged. */
  function rated(it: Item, at: string, author: string, given: unknown, reason: string | undefined): Item {
    const difficulty = Difficulty.safeParse(given);
    if (!difficulty.success) throw new OpError("difficulty: give an integer 1–5");
    if (it.record) throw new OpError("difficulty: a record has no difficulty");
    if (it.standing) throw new OpError("difficulty: a standing item has no difficulty");
    if (typeof reason !== "string" || !reason.trim()) throw new OpError("reason: say why the difficulty is this, for the log");
    if (it.difficulty === difficulty.data) return it;
    return { ...it, difficulty: difficulty.data, updated: at, log: [...it.log, entry(author, at, difficultyLogText(it.difficulty, difficulty.data, reason.trim()))] };
  }
  function acceptId(rows: readonly { id?: string; item?: string; card?: string }[]): string {
    const ids = new Set(rows.map(row => row.id ?? row.item ?? row.card));
    let id = "accept", suffix = 1; while (ids.has(id)) id = `accept-${suffix++}`; return id;
  }
  function rowId(row: PlanRowInput): string { return "item" in row ? row.item : "card" in row ? row.card : row.id; }
  function stamped(inputs: PlanRowInput[], previous: PlanRow[], at: string): PlanRow[] {
    const old = new Map(previous.map(row => [row.id, row]));
    return parse(PlanInput, inputs).map(row => stampPlanRow(row, old.get(rowId(row)), at));
  }
  function insert(plan: PlanRow[], row: PlanRow): PlanRow[] {
    const i = plan.findIndex(r => r.id === row.id), at = plan.findIndex(r => "accept" in r && r.accept);
    if (i >= 0) return plan.map((r, n) => n === i ? row : r);
    const result = plan.slice(); result.splice(at < 0 ? result.length : at, 0, row); return result;
  }
  function removeRow(plan: PlanRow[], id: string): PlanRow[] {
    const named = plan.filter(r => r.after?.includes(id)).map(r => r.id);
    if (named.length) throw new OpError(`remove ${id}: later rows ${named.join(", ")} name it in after; rewrite them first`);
    return plan.filter(row => row.id !== id);
  }
  /** A card joins its item's plan when write_card creates it and never leaves: a plan's card rows change only in position. */
  function checkCardRows(before: readonly PlanRow[], after: readonly PlanRow[]): void {
    const was = new Set(before.flatMap(r => "card" in r ? [r.card] : [])), now = new Set(after.flatMap(r => "card" in r ? [r.card] : []));
    for (const key of now) if (!was.has(key)) throw new OpError(`card ${key}: a card's row joins its item's plan when write_card creates the card; a plan write cannot add it`);
    for (const key of was) if (!now.has(key)) throw new OpError(`card ${key}: a card's row cannot be removed; withdraw the card with withdraw_card`);
  }
  /** The plan with the new card's row in it. `before` (default: the first acceptance step) also waits for the card, without
   * losing what it waited for: a row with no `after` followed the row before it that is not a record row. */
  function withCardRow(plan: PlanRow[], key: string, before: string | undefined, after: string[] | undefined, isRecord: (row: PlanRow) => boolean): PlanRow[] {
    if (plan.some(r => r.id === key)) throw new OpError(`key ${key}: the item's plan already has a row with this id; choose another card key`);
    const stop = before ?? plan.find(r => "accept" in r && r.accept)?.id, i = stop === undefined ? plan.length : plan.findIndex(r => r.id === stop);
    if (i < 0) throw new OpError(`before ${before}: choose a row of the item's plan`);
    const out = plan.slice();
    out.splice(i, 0, { id: key, card: key, ...(after === undefined ? {} : { after }) });
    const waiter = out[i + 1];
    if (waiter) out[i + 1] = { ...waiter, after: [...waiter.after ?? followedRows(plan, i, isRecord), key] };
    return out;
  }
  function attach(s: Snapshot, puts: Put[], at: string, by: Writer, owner: string, id: string, after?: string[]): void {
    ownedItem(s, owner, by, "owner"); const doc = docOf(s, puts, owner);
    if (requireItem(s, owner, "owner").group !== docOf(s, puts, id).group) throw new OpError("owner: ownership must stay within the same project");
    putDoc(puts, itemPut(owner, { ...doc, plan: insert(doc.plan ?? [], { id, item: id, own: true, ...(after === undefined ? {} : { after }) }), updated: at,
      log: [...doc.log, entry(by.author, at, `计划拥有「${titleOf(s, puts, id)}」`)] }));
  }
  function transfer(s: Snapshot, puts: Put[], at: string, by: Writer, id: string, owner?: string, after?: string[]): void {
    const old = rulesOf(s).parentOf(id);
    if (old && old !== owner) {
      ownedItem(s, old, by, "owner"); const doc = docOf(s, puts, old);
      putDoc(puts, itemPut(old, { ...doc, plan: removeRow(doc.plan ?? [], id), updated: at, log: [...doc.log, entry(by.author, at, `计划不再拥有「${titleOf(s, puts, id)}」；${owner ? `移到「${titleOf(s, puts, owner)}」` : "移到顶层"}`)] }));
    }
    if (owner) attach(s, puts, at, by, owner, id, after);
    else if (after !== undefined) throw new OpError("after: requires owner");
    const doc = docOf(s, puts, id), moved = { ...doc, updated: at, log: [...doc.log, entry(by.author, at, `${old ? `从「${titleOf(s, puts, old)}」` : "从顶层"}${owner ? `移到「${titleOf(s, puts, owner)}」的计划` : "移到顶层"}`)] };
    putDoc(puts, itemPut(id, moved));
  }
  /**
   * The commit of a write the same session made a moment ago that this one repeats, or none. A write that was committed but not
   * answered (the board restarted) is sent again by the client; the commit's message and session and the item as that commit left
   * it tell it. `same` says whether that item holds the line (or the head text) this write would add. It is for the writes that
   * add a line without any check of their own that stops a second one: append_log, close_note, set_status and journal_entry.
   */
  async function earlierWrite(it: Item, id: string, session: string | undefined, at: string, message: string, same: (doc: Item) => boolean): Promise<Result | undefined> {
    const who = session?.trim();
    // Any write of this window left the item updated in it, so an item last updated before the window has no earlier write to find.
    if (!who || !(Date.parse(at) - Date.parse(it.updated) <= REPEAT_MS)) return undefined;
    try {
      // Only the commits of the last minute can be the first write, so git is asked for those. Asked for the item's 20 newest
      // commits, it looks through the whole history for the rest when the item has fewer: 2 to 3 s with 27,666 commits, with every
      // other write waiting (item write-tail-3s). A commit is dated after the `updated` of the item it left, which is within the minute.
      const since = new Date(Date.parse(at) - REPEAT_MS).toISOString();
      for (const commit of await store.log({ kind: "item", id, since, limit: 20 })) {
        if (commit.session !== who || commit.message !== message) continue;
        const doc = await store.show("item", id, commit.commit) as Item | null;
        if (!doc) continue;
        // The commits come newest first: a write of this kind older than the window is followed by older ones only.
        if (!(Date.parse(at) - Date.parse(doc.updated) <= REPEAT_MS)) break;
        if (same(doc)) return { commit: commit.commit, id, rev: doc.rev, summary: commit.message };
      }
    } catch (error) {
      // The check is a courtesy to a retrying client: when the request's budget for reading history is spent, the write is made, at worst once too often.
      if (!(error instanceof BudgetError)) throw error;
    }
    return undefined;
  }
  /** What a repeat of a write is answered with: the first write's result, and no write. */
  const replay = (id: string, earlier: Result): Work => ({ id, kind: "item", message: earlier.summary, puts: [], replayed: earlier });
  /** The log line a write added last, for `earlierWrite`'s `same`. */
  const lastLine = (doc: Item, by: string, text: string): boolean => { const last = doc.log[doc.log.length - 1]; return last !== undefined && last.by === by && last.text === text; };
  return {
    createProject: a => run(a, "project.create", s => {
      if (s.board.projects.some(p => p.name === a.name)) throw new OpError(`project ${a.name}: already exists`);
      const projects = [...s.board.projects, { name: a.name, ...(a.repo === undefined ? {} : { repo: a.repo }) }];
      const board = parse(Board, { ...s.board, projects: projectOrder(projects, a) });
      return { id: a.name, kind: "board", board, puts: [], message: `create_project ${a.name} ${a.author}${a.after === undefined ? "" : ` after ${a.after}`}` };
    }, false, true),
    updateProject: a => run(a, "project.update", s => {
      const project = requireProject(s, a.name);
      requireAuthor(s, a.author, `project ${a.name}: `);
      if ((a.repo !== undefined || a.mainline !== undefined) && a.author !== a.name && !isArchitect(a)) throw new OpError(`project ${a.name}: only that project or ${ARCHITECT_WRITER} may update its ${a.repo === undefined ? "mainline" : "repo"}`);
      if (a.repo === undefined && a.mainline === undefined && a.after === undefined) throw new OpError("repo: provide repo, mainline or after");
      // `mainline: null` clears the branch, so the repository's default branch counts again.
      const { mainline: current, ...rest } = project, mainline = a.mainline === undefined ? current : a.mainline ?? undefined;
      const changed = { ...rest, ...(a.repo === undefined ? {} : { repo: a.repo }), ...(mainline === undefined ? {} : { mainline }) };
      const projects = s.board.projects.map(p => p.name === a.name ? changed : p);
      return { id: a.name, kind: "board", board: parse(Board, { ...s.board, projects: projectOrder(projects, a) }), puts: [], message: `update_project ${a.name}` };
    }),
    closeNote: a => run(a, "note.close", async (s, at) => {
      const { note, item } = ownedNote(s, a.id, a);
      const it = requireItem(s, item), text = `关闭评论：${a.log}`;
      const earlier = await earlierWrite(it, item, a.session, at, `close_note ${a.id}`, doc => lastLine(doc, a.author, text));
      if (earlier) return { ...replay(a.id, earlier), kind: "note" };
      if (note.state === "draft") throw new OpError(`note ${a.id}: cannot close a draft note`);
      return { id: a.id, kind: "note", message: `close_note ${a.id}`, puts: [
        { kind: "note", id: a.id, expectRev: note.rev, doc: { ...note, state: "done", repliedAt: at, repliedBy: a.author } },
        itemPut(item, { ...it, updated: at, log: [...it.log, entry(a.author, at, text)] }),
      ] };
    }),
    createItem: a => run(a, a.standing === undefined ? "item.create" : ["item.create", "item.standing"], (s, at) => {
      onlyProcessWithoutCredential(a, "create items");
      if (a.standing !== undefined) onlyProcessWithoutCredential(a, "create a standing item");
      if (a.standing && a.record) throw new OpError("standing: a record cannot be standing");
      if (Object.hasOwn(a, "status")) throw new OpError("status: create_item has no status argument");
      // Whoever creates an item may rate it as it is made, as in set_difficulty.
      let difficulty: Difficulty | undefined;
      if (a.difficulty !== undefined) {
        const given = Difficulty.safeParse(a.difficulty);
        if (!given.success) throw new OpError("difficulty: give an integer 1–5");
        if (a.record) throw new OpError("difficulty: a record has no difficulty");
        if (a.standing) throw new OpError("difficulty: a standing item has no difficulty");
        difficulty = given.data;
      }
      newKey(s, a.key);
      const owner = a.owner ? ownedItem(s, a.owner, a, "owner") : undefined;
      const group = a.group ?? owner?.group;
      if (!group) throw new OpError("group: a new top item requires its project");
      requireProject(s, group);
      refuseSummary(a.head);
      if (a.record || a.standing ? a.accept !== undefined : !a.accept) throw new OpError("accept: required for work, refused for records and standing items");
      if (!a.owner && a.after !== undefined) throw new OpError("after: requires owner");
      const inputs = [...a.plan ?? []];
      if (inputs.some(row => "card" in row)) throw new OpError("plan: a card's row joins its item's plan when write_card creates the card; a new item has no card rows");
      if (a.standing && inputs.some(row => "accept" in row && row.accept)) throw new OpError("plan: a standing item takes no acceptance step");
      const children = a.children ?? [];
      if (new Set(children).size !== children.length) throw new OpError("children: name each item once");
      for (const id of children) { ownedItem(s, id, a, "children"); if (inputs.some(row => rowId(row) === id)) throw new OpError(`children ${id}: already named in plan`); inputs.push({ item: id, own: true }); }
      if (!a.record && !a.standing) inputs.push({ id: acceptId(inputs), accept: true, text: a.accept!, state: "todo" });
      const tags = checkedTags(s, group, a.tags, true);
      const doc = parse(Item, { title: a.title, ...(tags ? { tags } : {}), ...(difficulty === undefined ? {} : { difficulty, log: [entry(a.author, at, difficultyLogText(undefined, difficulty, "建条目时评"))] }), head: a.head, record: a.record, ...(a.standing ? { standing: true } : {}), links: a.links, data: a.data, group, order: a.order, plan: stamped(inputs, [], at), created: at, updated: at, rev: 1 });
      const puts: Put[] = [{ kind: "item", id: a.key, doc, expectRev: null }];
      for (const id of children) {
        const old = rulesOf(s).parentOf(id);
        if (old) { const previous = docOf(s, puts, old); putDoc(puts, itemPut(old, { ...previous, plan: removeRow(previous.plan ?? [], id), updated: at, log: [...previous.log, entry(a.author, at, `「${titleOf(s, puts, id)}」移到「${a.title}」的计划`)] })); }
        const child = docOf(s, puts, id), moved = { ...child, updated: at, log: [...child.log, entry(a.author, at, `移到「${a.title}」的计划`)] }; putDoc(puts, itemPut(id, moved));
      }
      if (a.owner) attach(s, puts, at, a, a.owner, a.key, a.after);
      return { id: a.key, kind: "item", puts, moved: children, message: `create_item ${a.key}` };
    }),
    appendLog: a => run(a, "item.log", async (s, at) => {
      const it = ownedItem(s, a.id, a), earlier = await earlierWrite(it, a.id, a.session, at, `append_log ${a.id}`, doc => lastLine(doc, a.author, a.text));
      if (earlier) return replay(a.id, earlier);
      return { id: a.id, kind: "item", message: `append_log ${a.id}`, puts: [itemPut(a.id, { ...it, updated: at, log: [...it.log, entry(a.author, at, a.text)] })] };
    }),
    markMerged: a => edit(a, "item.merge-row", "mark_merged", (it, s, at) => {
      // The row as it is now decides, not the one the watch read before GitHub answered: a row edited, dropped or removed meanwhile stays as written.
      const row = it.plan.find(r => r.id === a.row);
      if (!row || !isOpenMergeStep(row) || !mergeRowDone(mergeRowPulls(s, a.id, row).map(prKey), new Set(a.merged.map(prKey)))) return it;
      const { doneAt: _done, since: _since, droppedAt: _dropped, waits: _waits, ...input } = row;
      return { ...it, updated: at, plan: it.plan.map(r => r === row ? stampPlanRow({ ...input, state: "done" }, row, at) : r), log: [...it.log, entry(a.author, at, a.log)] };
    }),
    journalEntry: a => run(a, "journal", async (s, at) => {
      onlyArchitect(a, `write the journal under ${JOURNAL.notes}`);
      const { day, clock } = localStamp(at);
      const key = `architect-journal-${day}`, line = `**${clock}** ${a.text}`;
      if (Object.hasOwn(s.items, key)) {
        const it = ownedItem(s, key, a);
        // The entry's text is in the head, after the time of day it was written at, so the repeat is told by the text alone.
        const earlier = await earlierWrite(it, key, a.session, at, `journal_entry ${key}`, doc => doc.head?.endsWith(`** ${a.text}`) ?? false);
        if (earlier) return replay(key, earlier);
        if (!it.record) throw new OpError(`journal ${key}: is not a record; check the item`);
        const head = it.head ? `${it.head}\n\n${line}` : line;
        const doc = { ...it, head, updated: at, log: [...it.log, entry(a.author, at, `${HEAD_REVISED_LOG}加了 ${clock} 的一条`)] };
        return { id: key, kind: "item", message: `journal_entry ${key}`, puts: [itemPut(key, doc)] };
      }
      newKey(s, key);
      const owner = ownedItem(s, JOURNAL.notes, a, "owner");
      const tags = checkedTags(s, owner.group, [JOURNAL.tag], true);
      const doc = parse(Item, { title: `架构师日志 ${day}`, tags, head: line, record: true, group: owner.group, plan: [], created: at, updated: at, rev: 1 });
      const puts: Put[] = [{ kind: "item", id: key, doc, expectRev: null }];
      attach(s, puts, at, a, JOURNAL.notes, key);
      return { id: key, kind: "item", puts, message: `journal_entry ${key}` };
    }),
    dispatchStart: async a => {
      // The token is made inside the write, which may run again after a conflict: the last one made is the one committed.
      const issued: { token?: string } = {};
      const result = await edit(a, "dispatch.start", "dispatch_start", (it, s, at) => {
        // An architect's turn is a record only: it gets no credential, so the architect's session names, which the turn is named by, are not reserved from it.
        const turn = a.role === ARCHITECT_ROLE;
        if (!turn && isArchitectName(a.agent)) throw new OpError(`agent ${a.agent}: that is the architect's session name; a dispatch's credential under it would be taken for the architect's`);
        if (isRunnerSession(a.agent)) throw new OpError(`agent ${a.agent}: that is the runner's session name, which no dispatch carries`);
        for (const [id, other] of Object.entries(s.items)) {
          const clash = other.dispatches?.find(d => d.agentId === a.agentId);
          if (clash) throw new OpError(`agentId ${a.agentId}: already recorded on ${id} for session ${clash.agent}; an agentId names one dispatch on the whole board`);
        }
        issued.token = turn ? undefined : newToken();
        const d = parse(Dispatch, { agentId: a.agentId, agent: a.agent, role: a.role, level: a.level, model: a.model, ...(a.effort === undefined ? {} : { effort: a.effort }), ...(a.worktree === undefined ? {} : { worktree: a.worktree }), started: dispatchTime(a.startedAt, at, "startedAt"), ...(a.did === undefined ? {} : { did: a.did }), ...(issued.token === undefined ? {} : { credential: hashToken(issued.token) }) });
        return { ...it, updated: at, dispatches: [...it.dispatches ?? [], d], log: [...it.log, entry(a.author, at, startLogLine(d))] };
      }, false, ` ${a.agent}`);
      return issued.token === undefined ? result : { ...result, credential: issued.token };
    },
    dispatchFinish: a => edit(a, "dispatch.finish", "dispatch_finish", (it, _s, at) => {
      const list = it.dispatches ?? [], i = list.findIndex(d => d.agentId === a.agentId);
      if (i < 0) throw new OpError(`agentId ${a.agentId}: not dispatched on ${a.id}; recorded here: ${list.map(d => `${d.agentId} (${d.agent})`).join(", ") || "none"}`);
      const old = list[i]!;
      if (old.finish && !a.replace) throw new OpError(`agentId ${a.agentId}: already ended at ${old.finish.ended} as ${old.finish.result}; pass replace: true to correct it`);
      // Which counts and which result a dispatch carries follow its role; the wrong ones are refused by name rather than dropped.
      const problem = dispatchCountProblem(old.role, a) ?? dispatchResultProblem(old.role, a.result);
      if (problem) throw new OpError(problem);
      const ended = dispatchTime(a.endedAt, at, "endedAt");
      if (Date.parse(ended) < Date.parse(old.started)) throw new OpError(`endedAt ${ended}: earlier than the start ${old.started}`);
      if (!Number.isFinite(a.cost) || a.cost < 0) throw new OpError("cost: give the cost in US dollars, zero or more");
      // More than three decimals are rounded, as the tool says: costs are kept in whole thousandths so sums stay exact.
      const cost = milliDollars(a.cost) / 1000;
      const finish = { ended, result: a.result, ...(a.reports === undefined ? {} : { reports: a.reports }), ...(a.kickbacks === undefined ? {} : { kickbacks: a.kickbacks }), ...(a.rounds === undefined ? {} : { rounds: a.rounds }), ...(a.waited === undefined ? {} : { waited: a.waited }), signals: a.signals ?? [], usage: a.usage, cost, ...(a.note === undefined ? {} : { note: a.note }) };
      // The credential ends with the dispatch: its hash is not kept.
      const { credential: _revoked, ...withoutCredential } = old;
      const d = parse(Dispatch, { ...withoutCredential, finish });
      return { ...it, updated: at, dispatches: list.map((x, n) => n === i ? d : x), log: [...it.log, entry(a.author, at, finishLogLine(d, old.finish !== undefined))] };
    }, false, ` ${a.agentId}`),
    reportState: a => edit(a, "item.runner", "report_state", (it, _s, at) => {
      onlyProcessOrRunnerWithoutCredential(a, "report the runner's state on an item");
      if (it.record) throw new OpError(`id ${a.id}: a record has no work to report on`);
      // The note and what the work waits for are one line: a reporter's line breaks (a failure's text, say) become spaces rather than a refusal.
      const oneLine = (text: string | undefined) => text?.replace(/\s+/g, " ").trim();
      const before = it.runner, note = oneLine(a.note), what = oneLine(a.what);
      const problem = runnerReportProblem({ ...a, ...(what === undefined ? {} : { what }) });
      if (problem) throw new OpError(problem);
      if (a.cost !== undefined && (!Number.isFinite(a.cost) || a.cost < 0)) throw new OpError("cost: give the cost so far in US dollars, zero or more");
      const until = a.until === undefined ? undefined : dispatchTime(a.until, at, "until");
      // The work waits on the same thing as in the last report: only then does `since` stay.
      const sameWait = before !== undefined && before.state === a.state && before.to === a.to && isDeepStrictEqual(before.cards, a.cards) && isDeepStrictEqual(before.items, a.items) && before.what === what && before.until === until;
      const turns = a.turns ?? before?.turns, cost = a.cost === undefined ? before?.cost : milliDollars(a.cost) / 1000;
      const since = sameWait && before ? before.since : at;
      // The work cannot have begun after it entered its state: a start time a moment ahead of the board's clock is cut back to it.
      const given = a.startedAt === undefined ? before?.started ?? at : dispatchTime(a.startedAt, at, "startedAt"), started = Date.parse(given) > Date.parse(since) ? since : given;
      const next = parse(RunnerReport, {
        state: a.state, since, at, started,
        ...(a.to === undefined ? {} : { to: a.to }), ...(a.cards === undefined ? {} : { cards: a.cards }), ...(a.items === undefined ? {} : { items: a.items }),
        ...(what === undefined ? {} : { what }), ...(until === undefined ? {} : { until }),
        ...(note === undefined ? {} : { note }), ...(turns === undefined ? {} : { turns }), ...(cost === undefined ? {} : { cost }),
      });
      // A report that repeats the last one changes nothing, and `at` is the time of the last change: no commit for it.
      if (before !== undefined && isDeepStrictEqual({ ...next, at: before.at }, before)) return it;
      return { ...it, updated: at, runner: next };
    }, false, ` ${a.state}`),
    reportLive: async a => {
      checkWriter(a, ["item.runner"]);
      onlyProcessOrRunnerWithoutCredential(a, "report a turn's live state");
      const it = ownedItem(store.snapshot(), a.id, a);
      if (it.record) throw new OpError(`id ${a.id}: a record has no work to report on`);
      if (!LIVE_ROLES.includes(a.role)) throw new OpError(`role: give one of ${LIVE_ROLES.join(", ")}`);
      const whole = (value: unknown, field: string, min: number): number => {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw new OpError(`${field}: give a whole number, ${min} or more`);
        return value;
      };
      const turn = whole(a.turn, "turn", 1), turnSeconds = whole(a.turnSeconds, "turnSeconds", 0), idleSeconds = a.idleSeconds === undefined ? undefined : whole(a.idleSeconds, "idleSeconds", 0);
      // The action is one line, like a report's note: a reporter's line breaks become spaces rather than a refusal.
      const action = a.action?.replace(/\s+/g, " ").trim();
      if (action !== undefined && [...action].length > LIVE_ACTION_MAX) throw new OpError(`action: give one line of at most ${LIVE_ACTION_MAX} characters`);
      const at = now(), back = (seconds: number) => new Date(Date.parse(at) - seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      live.put({ role: a.role, item: a.id, turn, turnStartedAt: back(turnSeconds), ...(idleSeconds === undefined ? {} : { lastActionAt: back(idleSeconds) }), ...(action === undefined ? {} : { action }), at });
      return `live ${a.role} ${a.id} turn ${turn} · kept in memory only, no commit`;
    },
    reportHeartbeat: async a => {
      checkWriter(a, ["item.runner"]);
      onlyProcessOrRunnerWithoutCredential(a, "report the runner's heartbeat");
      requireAuthor(store.snapshot(), a.author);
      return `heartbeat ${heartbeat.beat()} · kept in memory and a local file, no commit`;
    },
    setPlan: a => edit(a, "item.plan", "set_plan", (it, _s, at) => {
      if ([a.rows, a.row, a.remove].filter(value => value !== undefined).length !== 1) throw new OpError("set_plan: provide exactly one of rows, row or remove");
      const previous = it.plan ?? [];
      let plan: PlanRow[];
      if (a.remove !== undefined) {
        if (!previous.some(row => row.id === a.remove)) throw new OpError(`remove ${a.remove}: choose an existing row`);
        plan = removeRow(previous, a.remove);
      } else if (a.rows !== undefined) {
        const removed = previous.filter(row => !a.rows!.some(input => rowId(input) === row.id));
        for (const row of removed) { const named = a.rows.filter(input => input.after?.includes(row.id)); if (named.length) throw new OpError(`remove ${row.id}: later rows ${named.map(rowId).join(", ")} name it in after`); }
        plan = stamped(a.rows, previous, at);
      } else { const row = parse(PlanRowInput, a.row); plan = insert(previous, stampPlanRow(row, previous.find(r => r.id === rowId(row)), at)); }
      checkCardRows(previous, plan);
      if (it.standing && plan.some(row => "accept" in row && row.accept)) throw new OpError("plan: a standing item takes no acceptance step; it is always in progress and never completes");
      if (isDeepStrictEqual(plan, previous) && !(a.rows !== undefined && it.provisional)) return it;
      const doc = { ...it, plan, updated: at };
      if (a.rows !== undefined && it.provisional) { delete doc.provisional; doc.log = [...it.log, entry(a.author, at, "重写了计划")]; }
      return doc;
    }),
    setTargets: a => edit(a, "item.targets", "set_targets", (it, _s, at) => {
      if ([a.targets, a.target, a.remove].filter(value => value !== undefined).length !== 1) throw new OpError("set_targets: provide exactly one of targets, target or remove");
      const previous = it.targets ?? [];
      let targets: ItemTarget[];
      if (a.remove !== undefined) {
        const id = parse(StepId, a.remove);
        if (!previous.some(target => target.id === id)) throw new OpError(`remove ${id}: choose an existing target id`);
        targets = previous.filter(target => target.id !== id);
      } else if (a.targets !== undefined) {
        const inputs = parse(ItemTargetsInput, a.targets);
        const byId = new Map(previous.map(target => [target.id, target]));
        targets = inputs.map(input => stampItemTarget(input, byId.get(input.id), at));
      } else {
        const input = parse(ItemTargetInput, a.target), i = previous.findIndex(target => target.id === input.id);
        targets = previous.slice();
        const updated = stampItemTarget(input, previous[i], at);
        if (i < 0) targets.push(updated); else targets[i] = updated;
      }
      return isDeepStrictEqual(targets, previous) ? it : { ...it, targets, updated: at };
    }),
    setTags: a => edit(a, "item.tags", "set_tags", (it, s, at) => tagged(it, s, at, a.tags)),
    setTagsMany: a => run(a, "item.tags", (s, at) => {
      if (!Array.isArray(a.items) || !a.items.length) throw new OpError("items: give at least one {id, tags}");
      const seen = new Set<string>(), puts: Put[] = [];
      for (const [i, entry] of a.items.entries()) {
        if (!entry || typeof entry !== "object") throw new OpError(`items.${i}: give {id, tags}`);
        if (seen.has(entry.id)) throw new OpError(`items.${i}.id ${entry.id}: name each item once`);
        seen.add(entry.id);
        try {
          const it = ownedItem(s, entry.id, a), doc = tagged(it, s, at, entry.tags);
          if (doc !== it) puts.push(itemPut(entry.id, doc));
        } catch (error) {
          if (error instanceof OpError) throw new OpError(`items.${i} (${entry.id}): ${error.message}`);
          throw error;
        }
      }
      return { id: a.items[0]!.id, kind: "items", message: `set_tags ${a.items.length} items`, puts };
    }),
    setDifficulty: a => run(a, "item.difficulty", (s, at) => {
      onlyProcessWithoutCredential(a, "set an item's difficulty");
      const it = ownedItem(s, a.id, a);
      return { id: a.id, kind: "item", message: `set_difficulty ${a.id}`, puts: [itemPut(a.id, rated(it, at, a.author, a.difficulty, a.reason))] };
    }),
    setDifficultyMany: a => run(a, "item.difficulty", (s, at) => {
      onlyProcessWithoutCredential(a, "set an item's difficulty");
      if (!Array.isArray(a.items) || !a.items.length) throw new OpError("items: give at least one {id, difficulty, reason}");
      const seen = new Set<string>(), puts: Put[] = [];
      for (const [i, given] of a.items.entries()) {
        if (!given || typeof given !== "object") throw new OpError(`items.${i}: give {id, difficulty, reason}`);
        if (seen.has(given.id)) throw new OpError(`items.${i}.id ${given.id}: name each item once`);
        seen.add(given.id);
        try {
          const it = ownedItem(s, given.id, a), doc = rated(it, at, a.author, given.difficulty, given.reason ?? a.reason);
          if (doc !== it) puts.push(itemPut(given.id, doc));
        } catch (error) {
          if (error instanceof OpError) throw new OpError(`items.${i} (${given.id}): ${error.message}`);
          throw error;
        }
      }
      return { id: a.items[0]!.id, kind: "items", message: `set_difficulty ${a.items.length} items`, puts };
    }),
    setTag: a => run(a, "tag-vocab", s => {
      onlyArchitect(a, TAG_VOCABULARY);
      const known = boardTags(s.board).find(t => t.name === a.name);
      const projects = a.projects === undefined ? known?.projects : a.projects ?? undefined;
      for (const name of projects ?? []) requireProject(s, name);
      const tag = parse(Tag, { name: a.name, meaning: a.meaning, ...(projects ? { projects } : {}) });
      const stranded = Object.entries(s.items).filter(([, it]) => it.tags?.includes(a.name) && !tagApplies(tag, it.group)).map(([id]) => id);
      if (stranded.length) throw new OpError(`projects: items of projects outside the list still carry ${a.name}: ${stranded.join(", ")}; retag them first`);
      const tags = known ? boardTags(s.board).map(t => t.name === a.name ? tag : t) : [...boardTags(s.board), tag];
      return { id: a.name, kind: "board", board: parse(Board, { ...s.board, tags }), puts: [], message: `set_tag ${a.name}` };
    }, false, true),
    renameTag: a => run(a, "tag-vocab", (s, at) => {
      onlyArchitect(a, TAG_VOCABULARY);
      if (!boardTags(s.board).some(t => t.name === a.name)) throw new OpError(`name ${a.name}: not in the tag vocabulary; call tags to list it`);
      parse(TagName, a.to);
      if (boardTags(s.board).some(t => t.name === a.to)) throw new OpError(`to ${a.to}: already a tag; choose an unused name, or remove ${a.name} with replace`);
      const puts = Object.entries(s.items).filter(([, it]) => it.tags?.includes(a.name)).map(([id, it]) =>
        itemPut(id, { ...it, tags: it.tags!.map(t => t === a.name ? a.to : t), updated: at, log: [...it.log, entry(a.author, at, `标签改名：${a.name} → ${a.to}`)] }));
      const tags = boardTags(s.board).map(t => t.name === a.name ? { ...t, name: a.to } : t);
      return { id: a.to, kind: "board", board: parse(Board, { ...s.board, tags }), puts, message: `rename_tag ${a.name} ${a.to}` };
    }, false, true),
    removeTag: a => run(a, "tag-vocab", (s, at) => {
      onlyArchitect(a, TAG_VOCABULARY);
      if (!boardTags(s.board).some(t => t.name === a.name)) throw new OpError(`name ${a.name}: not in the tag vocabulary; call tags to list it`);
      const carrying = Object.entries(s.items).filter(([, it]) => it.tags?.includes(a.name));
      let replace: Tag | undefined;
      if (a.replace !== undefined) {
        replace = boardTags(s.board).find(t => t.name === a.replace);
        if (!replace || replace.name === a.name) throw new OpError(`replace ${a.replace}: choose another tag in the vocabulary`);
        const wrong = carrying.filter(([, it]) => !tagApplies(replace!, it.group)).map(([id]) => id);
        if (wrong.length) throw new OpError(`replace ${a.replace}: does not apply to the projects of ${wrong.join(", ")}`);
      } else if (carrying.length) throw new OpError(`name ${a.name}: ${carrying.length} items still carry it (${carrying.slice(0, 10).map(([id]) => id).join(", ")}${carrying.length > 10 ? ", …" : ""}); retag them, or give replace`);
      const puts = carrying.map(([id, it]) => {
        const rest = it.tags!.filter(t => t !== a.name);
        return itemPut(id, { ...it, tags: rest.includes(replace!.name) ? rest : [...rest, replace!.name], updated: at, log: [...it.log, entry(a.author, at, `标签 ${a.name} 已删除，换成 ${replace!.name}`)] });
      });
      return { id: a.name, kind: "board", board: parse(Board, { ...s.board, tags: boardTags(s.board).filter(t => t.name !== a.name) }), puts, message: `remove_tag ${a.name}${a.replace === undefined ? "" : ` → ${a.replace}`}` };
    }, false, true),
    updateItem: a => run(a, updateParts(a), async (s, at) => {
      if (a.title !== undefined && a.title !== requireItem(s, a.id).title) onlyProcess(a, "change an item's title");
      if (a.standing !== undefined) onlyProcess(a, "mark an item standing or ordinary");
      const it = ownedItem(s, a.id, a);
      const inParts = a.sections !== undefined || a.replace !== undefined;
      if (inParts && a.head !== undefined) throw new OpError("head: give either the whole head, or sections and replace to change parts of it, not both");
      // Turning an item into a record or a standing item, or back, also rewrites its plan's acceptance rows, so it needs the revision to be the current one.
      // Parts of the head are a replacement of the head as far as the revision is concerned: they stand on a behind revision when the head did not change since.
      const replaced = (["title", "head", "links", "data", "order"] as const).filter(key => a[key] !== undefined || (key === "head" && inParts));
      let note: string | undefined;
      if (a.record !== undefined || a.standing !== undefined || a.accept !== undefined || !replaced.length) await revision("item", a.id, a.rev, it);
      else note = await fieldsRevision(a.id, a.rev, it, replaced);
      // The head the edits make of the head the item has now, and the lines that show them.
      let head = a.head, changes: string | undefined;
      if (inParts) {
        // `editHead` refuses a new text that holds the line of a cut answer, in the words of the edit it is in.
        try { ({ head, shown: changes } = editHead(it.head ?? "", { sections: a.sections, replace: a.replace })); }
        catch (error) { throw error instanceof HeadEditError ? new OpError(error.message) : error; }
      }
      const changedHead = head !== undefined && head !== it.head;
      if (changedHead && !inParts) refuseSummary(head);
      if (changedHead && !a.reason?.trim()) throw new OpError("reason: explain why head changed");
      if (a.order !== undefined && rulesOf(s).parentOf(a.id)) throw new OpError("order: only top items carry order; order owned items in the plan");
      const doc = { ...it, updated: at, log: [...it.log] };
      const given = { title: a.title, head, links: a.links, data: a.data, order: a.order, record: a.record };
      for (const key of ["title", "head", "links", "data", "order", "record"] as const) { const value = given[key]; if (value === null) delete doc[key]; else if (value !== undefined) Object.assign(doc, { [key]: value }); }
      // A standing item is neither a record nor ordinary work: the two modes never hold together.
      if ((a.standing ?? !!it.standing) && (a.record ?? !!it.record) || a.standing === false && a.record === true) throw new OpError("standing: an item is a record or standing, not both; a record becomes work first, a standing item becomes ordinary first");
      if (a.standing === true && !it.standing) {
        const closed = ["done", "cancelled"].includes(rulesOf(s).statusOf(a.id) ?? "");
        if (closed) throw new OpError("standing: a done or cancelled item cannot become standing; reopen it first (set_status)");
        if (a.accept !== undefined) throw new OpError("accept: refused for a standing item");
        const accepts = (it.plan ?? []).filter(row => "accept" in row && row.accept);
        doc.plan = (it.plan ?? []).filter(row => !("accept" in row && row.accept)); doc.standing = true; delete doc.difficulty;
        doc.log.push(entry(a.author, at, `改为常设条目：一直进行中，不再有验收和难度；原验收：${accepts.map(row => "text" in row ? row.text : "").join("；")}${it.difficulty === undefined ? "" : `；原难度：${levelText(it.difficulty)}`}`));
      } else if (a.standing === false && it.standing) {
        if (!a.accept) throw new OpError("accept: required when changing a standing item to ordinary work");
        delete doc.standing;
        doc.plan = [...it.plan ?? [], stampPlanRow({ id: acceptId(it.plan ?? []), accept: true, text: a.accept, state: "todo" }, undefined, at)];
        doc.log.push(entry(a.author, at, "改为普通条目：状态由计划推导"));
      } else if (a.record === true && !it.record) {
        // Cancelled work turned into a record and back to work would be reopened without set_status.
        if (it.status === "cancelled") onlyProcess(a, "turn a cancelled item into a record");
        delete doc.paused;
        if (a.accept !== undefined) throw new OpError("accept: refused for a record");
        const accepts = (it.plan ?? []).filter(row => "accept" in row && row.accept);
        doc.plan = (it.plan ?? []).filter(row => !("accept" in row && row.accept)); delete doc.status; delete doc.difficulty;
        doc.log.push(entry(a.author, at, `改为记录条目：不再有状态；原验收：${accepts.map(row => "text" in row ? row.text : "").join("；")}${it.difficulty === undefined ? "" : `；原难度：${levelText(it.difficulty)}`}`));
      } else if (a.record === false && it.record) {
        if (!a.accept) throw new OpError("accept: required when changing a record to work");
        doc.plan = [...it.plan ?? [], stampPlanRow({ id: acceptId(it.plan ?? []), accept: true, text: a.accept, state: "todo" }, undefined, at)];
        doc.log.push(entry(a.author, at, "改为工作条目：状态由计划推导"));
      } else if (a.accept !== undefined) throw new OpError("accept: only with a change from record or standing to work; edit acceptance with set_plan");
      if (changedHead) doc.log.push(entry(a.author, at, `${HEAD_REVISED_LOG}${a.reason}`));
      return { id: a.id, kind: "item", message: `update_item ${a.id}`, puts: [itemPut(a.id, doc)], ...(note === undefined ? {} : { note }), ...(changes === undefined ? {} : { changes }) };
    }, true),
    setStatus: a => run(a, ["item.cancel", "card.write"], async (s, at) => {
      onlyProcess(a, "cancel or reopen an item");
      const it = ownedItem(s, a.id, a), message = `set_status ${a.id} ${a.status}`;
      // A repeat finds the item already as the first write left it; after a reopen, a cancel is a decision of its own.
      const asked = a.status === "cancelled" ? it.status === "cancelled" : it.status !== "cancelled";
      const earlier = asked ? await earlierWrite(it, a.id, a.session, at, message, doc => lastLine(doc, a.author, a.log)) : undefined;
      if (earlier) return replay(a.id, earlier);
      if (it.record) throw new OpError("status: a record has no status");
      if (a.status !== "cancelled" && a.status !== "open") throw new OpError("status: only cancelled or open; all other statuses are derived from the plan");
      if (a.status === "open" && it.status !== "cancelled") throw new OpError("status: only a cancelled item can be reopened");
      const r = rulesOf(s), open = r.children(a.id).filter(id => r.isOpenWork(id));
      if (a.status === "cancelled" && open.length) throw new OpError(`status: owned items are still open: ${open.join(", ")}; cancel or move each part first`);
      // A cancelled item keeps no open card: its open cards are withdrawn in this commit. Reopening restores exactly those,
      // so a card withdrawn by hand stays withdrawn.
      const cards = r.cardsOf(a.id).flatMap(key => s.decisions[key] ? [{ key, card: s.decisions[key] }] : []);
      const moved = cards.filter(({ card }) => a.status === "cancelled" ? card.status === "open" : card.status === "withdrawn" && card.withdrawnWithItem === true);
      const keys = moved.map(({ key }) => key).join("、");
      // The card line comes before the reason, so the reason stays the item's last log line.
      const cardLog = keys ? [entry(a.author, at, a.status === "cancelled" ? `因为条目取消，撤下了未裁的决策卡：${keys}` : `因为重新打开，恢复了决策卡：${keys}`)] : [];
      const doc = { ...it, updated: at, log: [...it.log, ...cardLog, entry(a.author, at, a.log)] };
      if (a.status === "cancelled") doc.status = "cancelled"; else delete doc.status;
      const cardPuts = moved.map(({ key, card }) => {
        if (a.status === "cancelled") return { kind: "decision" as const, id: key, doc: parse(Decision, { ...card, status: "withdrawn", withdrawnWithItem: true, ruledAt: at, updated: at }), expectRev: card.rev };
        const reopened: Partial<Decision> = { ...card, status: "open", updated: at };
        delete reopened.ruledAt; delete reopened.withdrawnWithItem;
        return { kind: "decision" as const, id: key, doc: parse(Decision, reopened), expectRev: card.rev };
      });
      return { id: a.id, kind: "item", message, puts: [itemPut(a.id, doc), ...cardPuts] };
    }),
    setPause: a => run(a, "item.pause", (s, at) => {
      onlyProcess(a, "pause or resume an item, at the owner's request");
      if (typeof a.paused !== "boolean") throw new OpError("paused: provide true to pause or false to resume");
      const it = requireItem(s, a.id);
      if (it.record) throw new OpError("paused: a record cannot be paused or resumed");
      const closed = ["done", "cancelled"].includes(rulesOf(s).statusOf(a.id) ?? "");
      if (closed && (a.paused || !it.paused)) throw new OpError("paused: done or cancelled items cannot be paused or resumed unless clearing an existing owner pause");
      if (a.paused && (typeof a.reason !== "string" || !a.reason.trim())) throw new OpError("reason: required when pausing an item");
      if (a.reason !== undefined && typeof a.reason !== "string") throw new OpError("reason: provide text");
      const reason = a.reason?.trim();
      const unchanged = a.paused ? it.paused?.reason === reason : !it.paused;
      const doc = unchanged ? it : { ...it, updated: at, log: [...it.log, entry(a.author, at, a.paused ? `暂停：${reason}` : "恢复")] };
      if (!unchanged) {
        if (a.paused) doc.paused = { reason: reason!, at }; else delete doc.paused;
      }
      return { id: a.id, kind: "item", message: `set_pause ${a.id} ${a.paused ? "paused" : "open"}`, puts: [itemPut(a.id, doc)] };
    }, false, true),
    moveItem: a => run(a, "item.move", (s, at) => {
      ownedItem(s, a.id, a);
      const puts: Put[] = []; transfer(s, puts, at, a, a.id, a.owner, a.after);
      return { id: a.id, kind: "item", puts, moved: [a.id], message: `move_item ${a.id}` };
    }),
    moveItemProject: a => run(a, "item.move-project", (s, at) => {
      onlyProcess(a, "move an item to another project");
      const root = ownedItem(s, a.id, a), from = root.group;
      requireProject(s, a.project);
      if (a.project === from) throw new OpError(`project: ${a.id} is already in ${a.project}`);
      const r = rulesOf(s);
      // The item and everything it owns, at any depth and in any state: ownership stays within one project, so they move together.
      const moved = new Set([a.id]);
      for (const id of moved) for (const child of r.children(id)) if (Object.hasOwn(s.items, child)) moved.add(child);
      const ids = [...moved], puts: Put[] = [];
      for (const id of ids) {
        // A stored cross-project owned row would only be carried along; the board's own check names it.
        const crossed = r.refusals(id).find(check => check.id === "owned-across-projects");
        if (crossed) throw new OpError(`item ${id}: owned by ${crossed.target!.id} of project ${r.groupOf(crossed.target!.id)} but belongs to project ${r.groupOf(id)} (跨项目拥有); fix that with set_plan first`);
        const it = ownedItem(s, id, a);
        try { checkedTags(s, a.project, it.tags, false); }
        catch (error) { throw error instanceof OpError ? new OpError(`item ${id}: ${error.message}`) : error; }
        puts.push(itemPut(id, { ...it, group: a.project, updated: at, log: [...it.log, entry(a.author, at, `换项目：从 ${from} 换到 ${a.project}${id === a.id ? "" : `（随「${root.title}」）`}`)] }));
      }
      // An owner left behind cannot keep owning across projects: its owned rows to moved items become shared rows, in place.
      const left = new Map<string, string[]>();
      for (const id of ids) for (const d of r.dependents(id)) if (d.own && !moved.has(d.id)) left.set(d.id, [...left.get(d.id) ?? [], id]);
      for (const [owner, targets] of left) {
        const doc = ownedItem(s, owner, a, "owner");
        putDoc(puts, itemPut(owner, { ...doc, updated: at,
          plan: doc.plan.map(row => "item" in row && row.own && targets.includes(row.item) ? { ...row, own: false } : row),
          log: [...doc.log, entry(a.author, at, `${targets.map(id => `「${s.items[id]!.title}」`).join("")}换到了项目 ${a.project}；计划不再拥有，改成依赖`)] }));
      }
      // The board's own check says which items the move leaves with an open waiter in their project and no owner there: the
      // arriving item (waited on by items of the new project), or a top item of the new project that a moved item waits on.
      const next = { ...s, items: { ...s.items } }; for (const put of puts) next.items[put.id] = put.doc as Item;
      const after = rules(next), unowned = (rl: ReturnType<typeof rules>, id: string) => rl.refusals(id).some(check => check.id === "unowned-but-awaited");
      const waiters = (id: string) => after.dependents(id).filter(d => !d.own && after.groupOf(d.id) === after.groupOf(id) && after.isOpenWork(d.id) && !(after.isStanding(d.id) && after.isStanding(id))).map(d => d.id);
      const candidates = new Set([a.id, ...ids.flatMap(id => after.depsOf(id).filter(d => d.kind === "item" && !d.own && !moved.has(d.id) && after.item(d.id)).map(d => d.id))]);
      const stranded = [...candidates].filter(id => unowned(after, id) && !unowned(r, id));
      const fix = (id: string): string => {
        const waiting = waiters(id);
        return id === a.id
          ? `${waiting.join(", ")} in ${a.project} wait on ${id} through shared rows, so ${id} would arrive owned by no item. This call cannot name a new owner for ${id}: have ${a.project} drop those rows with set_plan first, move ${id}, then let the item that needs it own it with an owned row (or leave the dependency out)`
          : `${waiting.join(", ")} will wait on ${id} through a shared row while no item of ${a.project} owns ${id}. Have an item of ${a.project} own ${id} first, or drop the row to ${id} from ${waiting.length === 1 ? "that item's" : "their"} plan with set_plan first`;
      };
      if (stranded.length) throw new OpError(`project: 同项目有条目在等它，却没有条目拥有它: ${stranded.map(fix).join("; ")}`);
      return { id: a.id, kind: "item", puts, moved: ids, message: `move_item_project ${a.id} ${a.project}` };
    }),
    clearAsk: a => edit(a, "item.ask", "clear_ask", (it, _s, at) => {
      const doc = { ...it, updated: at, log: [...it.log, entry(a.author, at, a.log)] };
      delete doc.ask;
      return doc;
    }),
    writeCard: a => run(a, ["card.write", "item.plan", "item.log"], async (s, at) => {
      const item = ownedItem(s, a.item, a, "item");
      if (/[\r\n]/.test(a.question)) throw new OpError("question: write the question on one line; the grounds belong in the options and the item's head");
      if (!a.options.length) throw new OpError("options: give at least one option; fix and call again");
      const given = parse(z.array(z.object({ text: z.string().min(1), detail: z.string().min(1), recommended: z.boolean().optional() }).strict()).max(26), a.options);
      given.forEach((o, i) => {
        if (/[\r\n]/.test(o.text) || [...o.text.replace(/\s/g, "")].length > OPTION_MAX_CHARS) throw new OpError(`options.${i}.text: an option's name is a short phrase of at most ${OPTION_MAX_CHARS} characters (spaces not counted) on one line; what it does, its cost and risks, and why it is or is not recommended go in options.${i}.detail`);
      });
      if (given.filter(o => o.recommended).length > 1) throw new OpError("options.recommended: recommend at most one option");
      // Keys follow the order: A, B, C…
      const options = given.map((o, i) => ({ key: String.fromCharCode(65 + i), text: o.text, detail: o.detail, ...(o.recommended ? { recommended: true } : {}) }));
      let previous: Decision | undefined;
      if (a.rev !== undefined) {
        previous = requireCard(s, a.key);
        ownedItem(s, previous.item, a);
        if (previous.item !== a.item) throw new OpError(`item: card ${a.key} belongs to ${previous.item} and cannot change item`);
        await revision("decision", a.key, a.rev, previous);
        if (previous.status !== "open") throw new OpError("status: only an open card can be revised; create a new card");
      } else newKey(s, a.key);
      if (a.confidence === undefined && !previous?.confidence) throw new OpError("confidence: say how sure you are of the recommended option (a score of 1 to 5 and the reason, with what would overturn it)");
      // kind: a new card says what it asks; a revision may change it, and one that omits it keeps the card's (a card written before the field existed has none).
      if (a.kind !== undefined && !CARD_KINDS.includes(a.kind)) throw new OpError(`kind: use one of ${CARD_KINDS.join(", ")}. ${CARD_KIND_WHAT} ${CARD_KIND_HOW}`);
      if (a.kind === undefined && previous === undefined) throw new OpError(`kind: say what the card asks, one of ${CARD_KINDS.join(", ")}. ${CARD_KIND_WHAT} ${CARD_KIND_HOW}`);
      // blocks: text sets it, null clears it, omitted keeps the revised card's.
      const merged: Record<string, unknown> = { ...previous, item: a.item, question: a.question, options, status: "open", at: previous?.at ?? at, updated: at, rev: previous?.rev ?? 1 };
      if (a.confidence !== undefined) merged.confidence = a.confidence;
      if (a.kind !== undefined) merged.kind = a.kind;
      if (a.blocks === null) delete merged.blocks; else if (a.blocks !== undefined) merged.blocks = a.blocks;
      const doc = parse(Decision, merged);
      const blocking = doc.blocks !== undefined, was = previous?.blocks !== undefined;
      // Only a card that blocks is a row of its item's plan: the work goes on without any other card.
      if (!blocking && (a.before !== undefined || a.after !== undefined)) throw new OpError("before: only a card with blocks has a row in the plan; the work goes on without a card that does not block");
      if (blocking && was && (a.before !== undefined || a.after !== undefined)) throw new OpError("before: a card's row is placed when it starts to block; a revision keeps it");
      const puts: Put[] = [{ kind: "decision", id: a.key, doc, expectRev: previous?.rev ?? null }];
      const isRecord = (row: PlanRow): boolean => isRecordRow(s.items, row);
      if (blocking && !was) puts.push(itemPut(a.item, { ...item, plan: withCardRow(item.plan, a.key, a.before, a.after, isRecord), updated: at }));
      if (!blocking && was) puts.push(itemPut(a.item, { ...item, plan: withoutCardRow(item.plan, a.key, isRecord), updated: at, log: [...item.log, entry(a.author, at, `决策卡「${doc.question.slice(0, 60)}」不再挡事，计划里的这一行去掉`)] }));
      return { id: a.key, kind: "decision", message: `write_card ${a.key}`, puts };
    }, a.rev !== undefined),
    ruleCard: a => run(a, "card.rule", (s, at) => {
      const card = requireCard(s, a.key);
      ownedItem(s, card.item, a);
      if (card.status !== "open") throw new OpError("status: only an open card can be ruled");
      if (a.choice === undefined && a.ruling === undefined) throw new OpError("choice: give the option the owner chose, or the owner's words in ruling when they chose none");
      if (a.choice !== undefined && !card.options.some(o => o.key === a.choice)) throw new OpError(`choice: use one of this card's option keys (${card.options.map(o => o.key).join(", ")}), or omit choice for a ruling in words`);
      const doc = parse(Decision, { ...card, status: "ruled", ...(a.choice === undefined ? {} : { choice: a.choice }), ...(a.ruling === undefined ? {} : { ruling: a.ruling }), ruledAt: at, updated: at });
      return { id: a.key, kind: "decision", message: `rule_card ${a.key}`, puts: [{ kind: "decision", id: a.key, doc, expectRev: card.rev }] };
    }),
    withdrawCard: a => run(a, ["card.write", "item.log"], (s, at) => {
      const card = requireCard(s, a.key), item = ownedItem(s, card.item, a);
      if (card.status !== "open") throw new OpError("status: only an open card can be withdrawn");
      const doc = parse(Decision, { ...card, status: "withdrawn", ruledAt: at, updated: at });
      return { id: a.key, kind: "decision", message: `withdraw_card ${a.key}`, puts: [
        { kind: "decision", id: a.key, doc, expectRev: card.rev },
        itemPut(card.item, { ...item, updated: at, log: [...item.log, entry(a.author, at, `撤回了决策卡「${card.question.replace(/\s+/g, " ").trim().slice(0, 60)}」：${a.log}`)] }),
      ] };
    }),
    replyNote: a => run(a, "note.reply", (s, at) => {
      const { note } = ownedNote(s, a.id, a);
      if (note.reply !== undefined) {
        // A reply is its author's: replacing it rewrites what another writer said to the owner. Only the architect, who runs the process, replaces a reply it did not write, also an old one with no author recorded or a retired author's.
        const seen = `note ${a.id}: already replied by ${note.repliedBy ?? "an unknown author"} at ${note.repliedAt ?? "unknown time"}`;
        if (note.repliedBy !== a.author && !mayRunProcess(a)) throw new OpError(`${seen}; a reply is replaced only by its author, so leave this one`);
        if (a.replace !== true) throw new OpError(`${seen}; use replace: true for a deliberate replacement`);
      }
      const doc = parse(Note, { ...note, reply: a.reply, repliedAt: at, repliedBy: a.author, state: "done" });
      return { id: a.id, kind: "note", message: `reply_note ${a.id}`, puts: [{ kind: "note", id: a.id, doc, expectRev: note.rev }] };
    }),
    setTerm: a => run(a, "term", (s, at) => {
      const glossary = ownGlossary(s, a.author);
      if (!Term.shape.term.safeParse(a.term).success) throw new OpError("term: write the term on one line without leading or trailing spaces");
      // A replaced term keeps its place, so the glossary's diff shows only the changed definition.
      const entry = { term: a.term, definition: a.definition, updated: at, by: a.author };
      const terms = glossary.terms.some(t => t.term === a.term) ? glossary.terms.map(t => t.term === a.term ? entry : t) : [...glossary.terms, entry];
      return { id: a.author, kind: "glossary", message: `set_term ${a.term}`, puts: [{ kind: "glossary", id: a.author, doc: parse(Glossary, { ...glossary, terms }), expectRev: s.glossaries[a.author]?.rev ?? null }] };
    }),
    deleteTerm: a => run(a, "term", s => {
      const glossary = ownGlossary(s, a.author);
      if (!glossary.terms.some(t => t.term === a.term)) throw new OpError(`term ${a.term}: not in ${a.author}'s glossary; call glossary to see its terms`);
      return { id: a.author, kind: "glossary", message: `delete_term ${a.term}`, puts: [{ kind: "glossary", id: a.author, doc: { ...glossary, terms: glossary.terms.filter(t => t.term !== a.term) }, expectRev: glossary.rev }] };
    }),
    sendMessage: async a => {
      let sent = "";
      const result = await run(a, "message.send", (s, at) => {
        const from = typeof a.session === "string" ? a.session.trim() : "";
        if (!from) throw new OpError("session: a message says who sent it; give your session name");
        const to = typeof a.to === "string" ? a.to.trim() : "";
        const reachable = new Set([ARCHITECT_SESSION, ...openAgents(s), ...options.sessions?.() ?? []]);
        if (!reachable.has(to)) throw new OpError(`to ${to || "(empty)"}: no session the board can reach has that name; send to one of: ${[...reachable].join(", ")}`);
        const text = typeof a.text === "string" ? a.text : "";
        const length = [...text].length;
        if (length > MESSAGE_TEXT_LIMIT) throw new OpError(`text: ${length} characters, at most ${MESSAGE_TEXT_LIMIT}; a message is only a doorbell: write the content on the item, and say here which item to read and what you wait for`);
        if (/\p{Cc}/u.test(text)) throw new OpError("text: write one line, without line breaks or other control characters");
        if (a.item !== undefined && !Object.hasOwn(s.items, a.item)) throw new OpError(`item ${a.item}: not on the board; give the key of the item the message is about, or leave it out`);
        // The day's messages are one document (model MessageDay): the message joins the end of the day it is sent on.
        const day = at.slice(0, 10), today = s.messages?.[day];
        // Named by its time, so ids sort in the order sent, and four random hex digits for two sent in one second.
        do sent = `${at.replace(/[-:]|\.\d+/g, "")}-${randomBytes(2).toString("hex")}`; while (today?.messages.some(m => m.id === sent));
        const message = parse(Message, { id: sent, from, project: a.author, to, text, ...(a.item === undefined ? {} : { item: a.item }), at });
        return { id: day, kind: "message", message: `send_message ${sent} to ${to}`, puts: [{ kind: "message", id: day, doc: { messages: [...today?.messages ?? [], message], rev: today?.rev ?? 1 }, expectRev: today?.rev ?? null }] };
      });
      return { ...result, id: sent };
    },
  };
}
