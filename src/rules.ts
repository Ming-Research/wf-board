// Pure snapshot-derived rules shared by the server and the owner's page.
// The plan is the single source for ownership, status and progress.
import { liveDispatches } from "./agents.ts";
import { worksOnItem } from "./dispatch.ts";
import type { AgentTouch, Decision, Item, PlanStep, PlanRow, PlanRowInput, ItemTarget, ItemTargetInput, Note, Project, Snapshot, StateStart, Status } from "./model.ts";
import { PROCESS_WRITERS, RETIRED_LEVEL, mayRunProcess, planRowId, tagsRequired } from "./model.ts";

/** Project list order is page order; only the architect may place a project after another. */
export function projectOrderAfter(projects: readonly Project[], name: string, after: string, who: { author: string; session?: string }): Project[] {
  if (!mayRunProcess(who)) throw new Error(`after: only ${PROCESS_WRITERS} may reorder projects`);
  if (after === name) throw new Error("after: a project cannot follow itself");
  const project = projects.find(p => p.name === name);
  if (!project) throw new Error(`project ${name}: choose a configured project with projects`);
  const remaining = projects.filter(p => p.name !== name), index = remaining.findIndex(p => p.name === after);
  if (index < 0) throw new Error(`after ${after}: choose a configured project with projects`);
  return [...remaining.slice(0, index + 1), project, ...remaining.slice(index + 1)];
}

/** Only an unsent note can still be edited or deleted by its author. */
export function draftEditable(note: Pick<Note, "state"> | undefined): boolean { return note?.state === "draft"; }
/** Shared text validity for owner note creation and draft edits. */
export function noteTextProblem(note: Pick<Note, "kind" | "text">): string | undefined {
  return note.kind === "comment" && !note.text.trim() ? "A comment needs text" : undefined;
}

/** A choice note that says nothing but the pick: the page writes "选 A" for option A, and an empty text counts as that. Any other
 * text is the owner's own words, which someone has to read (docs/design.md, Decision cards, Ruling). */
export function isPlainPick(note: Pick<Note, "kind" | "text" | "choice">): boolean {
  return note.kind === "choice" && (!note.text || note.text === "选 " + note.choice);
}

/**
 * The text of an item's 改动 section, where the board reads which PRs the item is about (docs/design.md, Watching GitHub).
 * It starts at a `## 改动` heading, or at a line that is `**改动**` with or without a colon after it (text after the colon
 * belongs to the section). It ends at the next heading (after a `##` heading, one of its level or above, so `###`
 * subsections stay inside), at the next line that is a bold section name alone, or at a line that starts a 参考 section.
 */
export function changesSection(head: string | undefined): string {
  const out: string[] = [];
  // 0: outside the section; 2: inside a `##` section; 7: inside a bold one, which any heading ends.
  let level = 0;
  for (const line of (head ?? "").split("\n")) {
    if (level === 0) {
      const bold = /^\*\*改动\*\*(?:[：:]\s*(.*)|\s*)$/.exec(line);
      if (/^##\s+改动\s*$/.test(line)) level = 2;
      else if (bold) { level = 7; if (bold[1]) out.push(bold[1]); }
      continue;
    }
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading && heading[1]!.length <= level) break;
    if (/^\*\*[^*\n]+\*\*[：:]?\s*$/.test(line) || /^(?:#{1,6}\s+|\*\*)?参考[：:]/.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}
/** The text a merge row of a plan with no `merge` stage row starts with (isMergeRow): 合入, but not 合入后, which an online check starts with. */
const LEGACY_MERGE_TEXT = /^合入(?!后)/;
/**
 * Whether a plan step is a merge row of its plan, the row the board marks done when the pull request it names merges: the stage row
 * `merge` (`merge-2` and up for the rounds that going back appends, `stageOf`), or, in a plan that has no such row, a step whose
 * text starts with 合入 (not 合入后). An acceptance step is never one, and a step that only mentions a merge is not: the online check
 * ("线上验证：合入后……") and a step that waits for another pull request both name pull requests and say 合入 (docs/design.md,
 * Watching GitHub, Merge rows).
 */
export function isMergeRow(row: PlanRow, plan: readonly PlanRow[]): row is PlanStep {
  if (!("text" in row) || row.accept) return false;
  if (stageOf(row)?.kind === "merge") return true;
  return !plan.some(other => stageOf(other)?.kind === "merge") && LEGACY_MERGE_TEXT.test(row.text.trimStart());
}
/** A merge row that is not done and not dropped. */
export function isOpenMergeStep(row: PlanRow, plan: readonly PlanRow[]): row is PlanStep {
  return isMergeRow(row, plan) && (row.state === "todo" || row.state === "doing");
}
/** Of the PRs a merge row names, those that count: the ones the item's 改动 section names as well. A line that waits for another PR to merge names it too, and that PR is not its own. */
export function countedPulls(inRow: readonly string[], inChanges: readonly string[]): string[] {
  const changes = new Set(inChanges);
  return inRow.filter(key => changes.has(key));
}
/** A merge row is done when PRs count for it and GitHub reports every one of them merged. */
export function mergeRowDone(counted: readonly string[], merged: ReadonlySet<string>): boolean {
  return counted.length > 0 && counted.every(key => merged.has(key));
}

/** The one rule that log entries, dispatch records and the runner's report never count as owner-unread: owner-facing item comparisons drop them first. */
export function withoutHistoricalDetail<T extends object>(doc: T): Omit<T, "log" | "dispatches" | "runner"> { const { log: _log, dispatches: _dispatches, runner: _runner, ...rest } = doc as T & { log?: unknown; dispatches?: unknown; runner?: unknown }; return rest; }
/** The owner reads a first rating (an item's difficulty from none to a level) as bookkeeping, not news: rating hundreds of
 * items would show each of them new for one added label. So is the migration that cleared the retired level 「架构师做」
 * (from that level to none), which touched a dozen items for one removed label. Changing a level that exists is news.
 * Returns the pair with the rating left out of the side that has it; any other pair comes back as it is. */
export function withoutRatingBookkeeping<T extends { difficulty?: unknown }>(before: T | null, after: T | null): [T | null, T | null] {
  if (!before || !after) return [before, after];
  if (before.difficulty === undefined && after.difficulty !== undefined) {
    const { difficulty: _rated, ...rest } = after;
    return [before, rest as T];
  }
  if (before.difficulty === RETIRED_LEVEL && after.difficulty === undefined) {
    const { difficulty: _cleared, ...rest } = before;
    return [rest as T, after];
  }
  return [before, after];
}
/** A change summary naming only the log (as describeChanges words it) is never unread content. */
export const isLogChange = (change: string): boolean => /^(\+\d+ log|log changed)$/.test(change);

function sameRow(a: PlanRow, b: PlanRow): boolean {
  const { after: aa, ...av } = a, { after: ba, ...bv } = b;
  const ar: Record<string, unknown> = av, br: Record<string, unknown> = bv;
  const ak = Object.keys(ar), bk = Object.keys(br);
  return ak.length === bk.length && ak.every(key => ar[key] === br[key]) &&
    (aa === undefined ? ba === undefined : ba !== undefined && aa.length === ba.length && aa.every((id, i) => id === ba[i]));
}
/** Current added or changed lines; moving an unchanged line does not highlight it. */
export function changedItemPlan(before: readonly PlanRow[] = [], after: readonly PlanRow[] = []): PlanRow[] {
  const previous = new Map(before.map(row => [row.id, row]));
  return after.filter(row => { const old = previous.get(row.id); return !old || !sameRow(old, row); });
}
/** Order and removals are progress changes too, even without a surviving changed line. */
export function planChanged(before: readonly PlanRow[] = [], after: readonly PlanRow[] = []): boolean {
  return before.length !== after.length || before.some((row, i) => !sameRow(row, after[i]!));
}
/** Retain earlier transition dates, stamp only entry into the current state. */
export function stampPlanRow(input: PlanRowInput, previous: PlanRow | undefined, at: string): PlanRow {
  if (!("text" in input)) return { ...structuredClone(input), id: planRowId(input) };
  const step: PlanStep = structuredClone(input), old = previous && "text" in previous ? previous : undefined;
  for (const field of ["doneAt", "since", "droppedAt"] as const) if (old?.[field] !== undefined) step[field] = old[field];
  const date = input.state === "done" ? "doneAt" : input.state === "doing" ? "since" : input.state === "dropped" ? "droppedAt" : undefined;
  if (date && (old?.state !== input.state || !step[date])) step[date] = at;
  return step;
}

const TARGET_FIELDS = ["id", "goal", "target", "current", "baseline", "date"] as const;
function sameTarget(a: ItemTarget, b: ItemTarget): boolean { return TARGET_FIELDS.every(field => a[field] === b[field]); }
/** Highlight added or changed goals by stable id, independently of list position. */
export function changedItemTargets(before: readonly ItemTarget[] = [], after: readonly ItemTarget[] = []): ItemTarget[] {
  const previous = new Map(before.map(target => [target.id, target]));
  return after.filter(target => { const old = previous.get(target.id); return !old || !sameTarget(old, target); });
}
/** A reorder or removal still counts as progress even when no current row changed. */
export function targetsChanged(before: readonly ItemTarget[] = [], after: readonly ItemTarget[] = []): boolean {
  return before.length !== after.length || before.some((target, i) => !sameTarget(target, after[i]!));
}
/** Stamp new goals or changed current values, retaining the date on other edits. */
export function stampItemTarget(input: ItemTargetInput, previous: ItemTarget | undefined, at: string): ItemTarget {
  return { ...input, date: previous?.current === input.current ? previous.date : at };
}
export function targetLine(target: ItemTarget): string {
  const compact = (text: string): string => text.replace(/\s+/g, " ").trim();
  return `${compact(target.goal)}: ${compact(target.current)} (vs ${compact(target.baseline)}) → ${compact(target.target)}, ${target.date.slice(0, 10)}`;
}

/** A row that points at a record. A record is no step of its plan: the order skips it and the counts leave it out (docs/design.md, Records). */
export function isRecordRow(items: Readonly<Record<string, Pick<Item, "record">>>, row: PlanRow): boolean {
  return "item" in row && !!items[row.item]?.record;
}
/** What a row with no `after` at position `at` comes after: the nearest row before it that is not a record row, none for the first. */
export function followedRows(plan: readonly PlanRow[], at: number, isRecord: (row: PlanRow) => boolean): string[] {
  for (let i = at - 1; i >= 0; i--) if (!isRecord(plan[i]!)) return [plan[i]!.id];
  return [];
}
/** The plan without a card's row, for a card that does not block. Rows that waited for the row wait for what it waited for. */
export function withoutCardRow(plan: PlanRow[], key: string, isRecord: (row: PlanRow) => boolean = () => false): PlanRow[] {
  const i = plan.findIndex(r => "card" in r && r.card === key);
  if (i < 0) return plan;
  const waited = plan[i]!.after ?? followedRows(plan, i, isRecord), rest = plan.filter((_, n) => n !== i);
  // The row with no `after` that followed the card is the first one after it that is not a record row.
  const next = rest.findIndex((r, n) => n >= i && !isRecord(r));
  return rest.map((r, n) => {
    if (r.after?.includes(key)) return { ...r, after: [...new Set([...r.after.filter(x => x !== key), ...waited])] };
    return r.after === undefined && n === next ? { ...r, after: waited } : r;
  });
}

/** A title longer than this many characters (spaces not counted) gets a check. */
export const TITLE_MAX_CHARS = 20;
/** An option name longer than this many characters (spaces not counted) is refused when a card is written; its detail has no limit. */
export const OPTION_MAX_CHARS = 20;
/** An open card its item's head does not place carries this label; a card and its plan row that disagree, the next. */
export const CARD_UNPLACED_LABEL = "卡没标位置";
export const CARD_MISMATCH_LABEL = "卡和计划对不上";
/** A line holding only [[q:key]] places that card in the head there; the same token inside a sentence is a link. */
const CARD_MARKER = /^[ \t]*\[\[q:([A-Za-z0-9][A-Za-z0-9_.-]{0,199})\]\][ \t]*$/;
/** The card key a head line places, if it is such a line. */
export function cardMarker(line: string): string | undefined { return CARD_MARKER.exec(line)?.[1]; }
/** The keys of the cards a head places, in the order of their lines; a line inside a code fence places nothing. */
export function placedCards(head: string | undefined): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of (head ?? "").replace(/\r/g, "").split("\n")) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    const key = fenced ? undefined : cardMarker(line);
    if (key !== undefined && !out.includes(key)) out.push(key);
  }
  return out;
}
const placedByItem = new WeakMap<object, readonly string[]>();
/** `placedCards` of an item's head, kept for as long as that version of the item lives (an item is never changed in place; a
 * write makes a new object). Without it every write scans all the heads again, to build the board's checks and the cards' order,
 * which on the live board's 15 MB of heads costs the page tens of milliseconds per write. */
export function placedCardsOf(it: { head?: string } | undefined): readonly string[] {
  if (!it) return [];
  let out = placedByItem.get(it);
  if (!out) placedByItem.set(it, out = placedCards(it.head));
  return out;
}
/** The visible tag of a check whose own label is not set. */
export const CHECK_LABEL = "需核对";
/** A WIP item with its own doing step quiet for STALLED_AFTER_MS of active time carries this label instead. */
export const STALLED_LABEL = "无人推进";
/** An open item with a todo step that says what it waits on in text the board cannot read carries this label. */
export const WAITS_TEXT_LABEL = "在等文字";
/** An open decision card must offer at least this many workable options; the card and its item carry an OPTIONS_LABEL check below it. */
export const CARD_MIN_OPTIONS = 3;
export const OPTIONS_LABEL = "选项不足";
/** The label of the check on an engineer's item whose plan lacks a stage or has the stages out of order. */
export const STAGE_FORMAT_LABEL = "大步骤格式";
/** The label of the check on an open item whose head was last revised before the owner ruled one of its cards. */
export const APPROACH_STALE_LABEL = "做法待更新";
/** What every log entry `update_item` writes for a changed head starts with: the one place that knows the wording, since the check above reads the time of the last such entry as when the head was last revised. */
export const HEAD_REVISED_LOG = "改了 head：";
const wholeSeconds = (time: string): number => Math.floor(Date.parse(time) / 1000);
/**
 * When an item's head was last revised, in whole seconds (the log stamps to the second, a card's `ruledAt` may carry milliseconds): the later of its
 * creation and the last log entry that says the head changed. An item with neither (written before the board dated its items, head never revised since)
 * has no time, which is older than any ruling. Not stored as a field of its own: the log already holds it, written by the same commit as the head.
 */
export function headRevisedAt(it: Pick<Item, "created" | "log">): number {
  let at = it.created === undefined ? -Infinity : wholeSeconds(it.created);
  for (const entry of it.log) if (entry.text.startsWith(HEAD_REVISED_LOG)) at = Math.max(at, wholeSeconds(entry.at));
  return at;
}
export const checkLabel = (c: Pick<Check, "label">): string => c.label ?? CHECK_LABEL;
/** What the board knows of one kind of check, apart from its text. */
export interface CheckKind {
  /** Short visible tag; absent means CHECK_LABEL. */
  label?: string;
  /** A write that introduces a check of this kind is refused, not only flagged (ops reads this). */
  refused?: true;
}
/**
 * Every kind of check, each registered once under a fixed id: a short English word chain that is never reused, renamed or
 * made to mean another check. The id (with what the check points at) is what says that two checks are the same one, on two
 * boards or at two times; the text is for people and may carry a count that changes while the check stays. A new check is a new
 * entry here, and `check` below is the only way rules make one.
 */
export const CHECK_KINDS = {
  "dep-item-missing": { refused: true },
  "dep-card-missing": { refused: true },
  "dep-item-cancelled": {},
  "dep-cycle": { refused: true },
  "owned-by-many": { refused: true },
  "owned-across-projects": { refused: true },
  "unowned-but-awaited": { refused: true },
  "waits-on-standing": { refused: true },
  "no-acceptance": { refused: true },
  "plan-provisional": { label: "待重写" },
  "acceptance-pending": {},
  "only-acceptance-left": {},
  "owner-closed": {},
  "project-unconfigured": {},
  "card-plan-mismatch": { label: CARD_MISMATCH_LABEL },
  "card-unplaced": { label: CARD_UNPLACED_LABEL },
  "card-options-short": { label: OPTIONS_LABEL },
  "tags-missing": { label: "缺标签" },
  "difficulty-missing": { label: "缺难度" },
  "title-too-long": {},
  "stalled": { label: STALLED_LABEL },
  "waits-in-text": { label: WAITS_TEXT_LABEL },
  "pause-conflict": { label: "暂停冲突" },
  "stage-format": { label: STAGE_FORMAT_LABEL },
  "approach-stale": { label: APPROACH_STALE_LABEL },
} as const satisfies Record<string, CheckKind>;
export type CheckId = keyof typeof CHECK_KINDS;
export const checkKind = (id: CheckId): CheckKind => CHECK_KINDS[id];
export interface Check {
  /** The kind of check, registered in CHECK_KINDS. */
  id: CheckId;
  /** The full explanation (tooltip). It may carry numbers that change while the check stays; never compare it. */
  text: string;
  /** Short visible tag of the kind; absent means CHECK_LABEL. */
  label?: string;
  /** What the check points at, when it is about another item or card than the one it sits on. */
  target?: { kind: "item" | "card"; id: string };
}
/** The one way to make a check: its label comes from its kind, so the two cannot disagree. */
function check(id: CheckId, text: string, target?: Check["target"]): Check {
  const { label } = checkKind(id);
  return { id, text, ...(label === undefined ? {} : { label }), ...(target ? { target } : {}) };
}
/** What makes a check the same check on two boards: its kind and what it points at, whatever its text says. */
export const checkKey = (c: Pick<Check, "id" | "target">): string => `${c.id}|${c.target ? `${c.target.kind}:${c.target.id}` : ""}`;

export interface Rules {
  item(id: string): Item | undefined;
  parentOf(id: string): string | undefined;
  children(id: string): string[];
  /** Top items grouped in configured project order, after filtering. */
  areas(include?: (id: string) => boolean): string[];
  ancestors(id: string): string[];
  lineOf(id: string): string;
  groupOf(id: string): string;
  projectOf(id: string): string;
  /** An existing work item whose status is neither done nor cancelled. Records are not open work. */
  isOpenWork(id: string): boolean;
  /** A standing item: always in progress (paused when it or an owner is), never done; its plan rows do not decide its status (docs/design.md, Item plans, Standing items). */
  isStanding(id: string): boolean;
  isLeaf(id: string): boolean;
  /** No non-record children contribute work status. */
  isStatusLeaf(id: string): boolean;
  statusOf(id: string): Status | undefined;
  /** Someone is working on the item now: a step of its own in progress, or a live session (an unfinished dispatch whose session
   * wrote or was started within the agent list's window). Not inherited from the items it owns. */
  workedOn(id: string): boolean;
  /** Whether something of the item's own is done (a step, an owned item done, or an owned item that has begun): what tells `idle` from `todo`, and what its owner reads. */
  begun(id: string): boolean;
  /** The items that carry an unfinished dispatch of this session. */
  dispatchedItems(agent: string): string[];
  /** Work an agent could be started on now, apart from its rating: status todo or idle, an unpaused root needs it, and
   * a step ready to start that waits on nothing. The one definition the next-task list and the 缺难度 check both read. */
  canStart(id: string): boolean;
  /** `canStart` and rated 1–5: what the next-task list offers. */
  startable(id: string): boolean;
  /** What the item waits on: the brief tells a sub-item that only waits for its turn from one blocked for its own reason. */
  progress(id: string): Progress;
  /** The rows before the row that owns the item in its owner's plan that are not done yet; none when the row has come up. */
  ownerRowWaits(id: string): string[];
  /** Nearest explicit pause on this item or its same-project ownership chain. */
  pausedBy(id: string): string | undefined;
  /** Effective pause on open work; done and cancelled always win. */
  isPaused(id: string): boolean;
  /** Open work directly owned by a record has no root role. */
  isBacklog(id: string): boolean;
  /** No open work item points at it, and it is not open record-owned work. */
  isRoot(id: string): boolean;
  /** Open work an unpaused root needs: an unpaused root, or work such a root waits on
   * through open, unpaused rows, owned or shared. Backlog work is needed only when a needed item other than its record
   * also holds a row for it, and what hangs under it only when that work is; paused work and what only a paused root
   * needs are not needed. */
  isNeeded(id: string): boolean;
  /** How many open, unpaused work items hold a shared row for it: the ones that wait for it. Its owner does not count: every owned item has one. */
  openDependents(id: string): number;
  depsOf(id: string): Array<{ kind: "item" | "card"; id: string; own?: boolean; open: boolean; missing: boolean }>;
  dependents(id: string): Array<{ id: string; own?: boolean }>;
  cardDependents(key: string): Array<{ id: string; own?: boolean }>;
  cardsOf(id: string): string[];
  /** The checks of one open decision card (too few options), none for a card of a cancelled item. */
  cardChecks(key: string): Check[];
  askPending(id: string): boolean;
  cardWaiting(key: string): boolean;
  /** A waiting card that names the work stopped until the owner rules (its `blocks`). */
  cardBlocking(key: string): boolean;
  needsOwner(id: string): boolean;
  /** An owner action is pending (an ask, always blocking) or a card of the item is blocking. */
  ownerBlocking(id: string): boolean;
  /** Blocking waits in the item's subtree, the item included: pending asks plus blocking cards. */
  blockingBelow(id: string): number;
  /** Waiting cards without `blocks` in the item's subtree, the item included. */
  nonBlockingBelow(id: string): number;
  onCycle(id: string): boolean;
  /** The checks shown for an item: none for a cancelled item. Writes use refusals, which are not filtered. */
  checks(id: string): Check[];
  /** The same checks unfiltered: the write-time refusals of ops read these, cancelled items included. */
  refusals(id: string): Check[];
  /** Stalled wip leaves in the item's subtree, the item itself included. */
  stalledBelow(id: string): number;
  /** Items whose plan step text names this item with [[it:key]], any state. */
  mentionedBy(id: string): string[];
  stepDays(step: PlanStep): number;
  stepLine(step: PlanStep): string;
  planRows(id: string): DerivedPlanRow[];
  planGroups(id: string): Array<{ start: number; end: number; level: number }>;
  /** The rows of the plan that are done and all that count; a standing item has none to count. */
  planRatio(id: string): { done: number; total: number };
  /** The share of an item's plan that is done, 0 to 1, with a row in progress counting half (docs/design.md, How the page shows a plan).
   * A plan read by stages counts only its stage rows: this is the share of `stages`. */
  progressShare(id: string): number;
  /** Where the item stands among the big steps of its plan. Undefined unless the plan has a research row and an impl row: older plans
   * give merge, impl and accept to ordinary rows, and they keep counting every row (docs/design.md, How the page shows a plan). */
  stages(id: string): StageInfo | undefined;
  compareSiblings(a: string, b: string): number;
  /** The default order of the candidates list, for reading and not a choice: more open dependents first; then the earlier item number. */
  compareCandidates(a: string, b: string): number;
}

type Dependency = ReturnType<Rules["depsOf"]>[number];
export interface DerivedPlanRow {
  row: PlanRow;
  state: "resolved" | "progress" | "waiting" | "open";
  ready: boolean;
  level: number;
  glyph: string;
  dropped: boolean;
  excluded: boolean;
  /** How much the row adds to its plan's progress share: done 1, in progress ½, else 0; null when the row is left out of the share (a cancelled sub-item). */
  weight: number | null;
}
/** What an item waits on (docs/design.md, Status). */
export interface Progress {
  /** The rows the frontier waits on: items and cards. */
  waiting: Array<{ kind: "item" | "card"; id: string }>;
  /** The item's own request to the owner is still unanswered. */
  ask: boolean;
  /** The row that owns this item in its owner's plan has rows before it that are not resolved. */
  behind: boolean;
}
/** The id of the plan step that stands for the item's review in its first round: marked in progress while a reviewer reads the pull request. */
export const REVIEW_STEP = "review";
/** Whether a step in progress waits on a 14900K run: its `waits` names the machine. The rules keep `waits` for a wait outside the board
 * (CI or a 14900K run); a run takes hours and the engineer is idle, while one waiting for CI is still working. The one place that knows this. */
export function waitsOnRun(row: PlanRow): boolean { return "text" in row && row.waits !== undefined && /14900K/i.test(row.waits); }
/**
 * The big steps of an engineer's plan, in the order of the flow, with the name the left tree shows for each. The ids and names are
 * fixed by the engineer rules (The plan's stages). `review` is the one a plan may leave out (`REQUIRED_STAGES`): a version of the
 * rules without a review step has none.
 */
export const STAGES = [
  { kind: "research", name: "研究" }, { kind: "impl", name: "实现" }, { kind: "review", name: "审查" }, { kind: "ci", name: "完整 CI" },
  { kind: "accept", name: "验收" }, { kind: "merge", name: "合入" }, { kind: "verify", name: "线上验证" },
] as const;
export type StageKind = (typeof STAGES)[number]["kind"];
/** The stages every engineer plan has: the others depend on a pull request (ci, merge) or on going live (verify). */
const REQUIRED_STAGES: readonly StageKind[] = ["research", "impl", "accept"];
/** A stage id, with the round that going back appends after the first: `impl`, `impl-2`, `impl-3`. */
const STAGE_ID = new RegExp(`^(${STAGES.map(s => s.kind).join("|")})(?:-([2-9]|[1-9]\\d+))?$`);
/**
 * The stage a plan row is, or undefined. Only a step without the acceptance mark can be one: `accept` is also the id older plans
 * give their acceptance step, and that step is not the stage of that name (docs/design.md, How the page shows a plan).
 */
export function stageOf(row: PlanRow): { kind: StageKind; round: number } | undefined {
  if (!("text" in row) || row.accept) return undefined;
  const m = STAGE_ID.exec(row.id);
  return m ? { kind: m[1] as StageKind, round: m[2] ? Number(m[2]) : 1 } : undefined;
}
/** Whether a plan row is the review step of some round (`review`, `review-2`, ...), the stage the plan marks in progress while a reviewer
 * reads the pull request. The one place that knows the convention. */
export function isReviewStep(row: PlanRow): boolean { return stageOf(row)?.kind === "review"; }
/**
 * What is wrong with the stage rows of a plan an engineer holds, in words for the check, or nothing when it is right: a stage
 * every plan has is missing, the first rows of the stages are out of the order of the flow, or the rounds of one stage do not
 * follow each other. The rows of a round after the first may stand anywhere after the first round's, so only first rows are ordered.
 */
export function stageProblems(plan: readonly PlanRow[]): string[] {
  const stages = plan.flatMap(row => { const stage = stageOf(row); return stage ? [{ id: row.id, ...stage }] : []; });
  const out: string[] = [];
  const missing = REQUIRED_STAGES.filter(kind => !stages.some(s => s.kind === kind));
  if (missing.length) {
    const marked = missing.includes("accept") && plan.some(row => "text" in row && row.accept && row.id === "accept");
    out.push(`缺 ${missing.join("、")} 的大步骤行${marked ? "（id 是 accept 的行带着验收标记，是验收行；accept 这一步要另写一行，不带验收标记）" : ""}`);
  }
  const order: string[] = STAGES.map(s => s.kind), firsts = new Map<StageKind, string>(), last = new Map<StageKind, { id: string; round: number }>();
  for (const s of stages) {
    if (!firsts.has(s.kind)) firsts.set(s.kind, s.id);
    const before = last.get(s.kind);
    if (before && before.round >= s.round) out.push(`${before.id} 排在 ${s.id} 前面，同一步的轮次要往下增`);
    last.set(s.kind, { id: s.id, round: s.round });
  }
  const seen = [...firsts];
  for (let i = 1; i < seen.length; i++) {
    const [earlier, later] = [seen[i - 1]!, seen[i]!];
    if (order.indexOf(earlier[0]) > order.indexOf(later[0])) { out.push(`${earlier[1]} 排在 ${later[1]} 前面，大步骤的顺序是 ${order.join("、")}`); break; }
  }
  return out;
}
/** Whether an engineer holds the item: an engineer dispatch that has not ended, or a runner report that is not yet done. */
function heldByEngineer(it: Item): boolean {
  return (it.dispatches ?? []).some(d => d.role === "工程师" && !d.finish) || (it.runner !== undefined && it.runner.state !== "done");
}
/** Where an item stands among the stages of its plan; see `Rules.stages`. */
export interface StageInfo {
  /** The stages that count (all but the dropped ones) and how many of them are done. */
  done: number;
  total: number;
  /** The share of them that is done, 0 to 1, a stage in progress counting half. */
  share: number;
  /** The stage the item is at: the first in progress, else the first not done. None when every stage is done. */
  current: { id: string; kind: StageKind; round: number; label: string } | undefined;
}
// These are the page's actual ANSWER prefixes (approve is 同意, not 批准).
const ANSWER = { approve: "同意：", done: "已完成：" };
/** A reference token is [[it:<key>]] for an item and [[q:<key>]] for a decision card: an item and a card may share a key.
 * Keys follow the board's Key pattern. Block text has no other use for double square brackets. */
export const REFERENCE = /\[\[(it|q):([A-Za-z0-9][A-Za-z0-9_.-]{0,199})\]\]/g;
/** The item keys a text names with [[it:key]]. */
function mentionsIn(text: string): string[] { return [...text.matchAll(REFERENCE)].filter(m => m[1] === "it").map(m => m[2]!); }

/** A Rules object belongs to one immutable snapshot. Create another after a write.
 * Array/object results are defensive copies; item() returns the snapshot's item.
 * Missing items have no metadata; tree queries still include dangling children.
 */
export const STALLED_AFTER_MS = 60 * 60 * 1000;
export const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

type ActivityInput = Pick<Snapshot, "items" | "decisions" | "notes"> & Partial<Pick<Snapshot, "activity" | "glossaries">>;
/** One source of activity times: the times it gives, and the item they reset (none for board-wide writes). */
interface Contribution { id: string | undefined; times: number[]; target?: string }
const parsedTimes = (values: ReadonlyArray<string | undefined>): number[] => values.flatMap(at => { const time = at ? Date.parse(at) : NaN; return Number.isFinite(time) ? [time] : []; });
function insertSorted(list: number[], value: number): void {
  let low = 0, high = list.length;
  while (low < high) { const middle = (low + high) >> 1; if (list[middle]! <= value) low = middle + 1; else high = middle; }
  list.splice(low, 0, value);
}
function removeSorted(list: number[], value: number): void {
  let low = 0, high = list.length;
  while (low < high) { const middle = (low + high) >> 1; if (list[middle]! < value) low = middle + 1; else high = middle; }
  if (list[low] !== value) throw new Error("activity index: removing a time it does not hold");
  list.splice(low, 1);
}
const isSorted = (list: readonly string[]): boolean => list.every((value, i) => i === 0 || list[i - 1]! <= value);
/** What `b` holds that `a` does not, and the reverse, counting repeats. */
function stringDelta(a: readonly string[], b: readonly string[]): { added: string[]; removed: string[] } {
  const added: string[] = [], removed: string[] = [];
  if (isSorted(a) && isSorted(b)) {
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (j >= b.length || i < a.length && a[i]! < b[j]!) removed.push(a[i++]!);
      else if (i >= a.length || b[j]! < a[i]!) added.push(b[j++]!);
      else { i++; j++; }
    }
    return { added, removed };
  }
  const counts = new Map<string, number>();
  for (const value of a) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of b) { const n = counts.get(value) ?? 0; if (n > 0) counts.set(value, n - 1); else added.push(value); }
  for (const [value, n] of counts) for (let k = 0; k < n; k++) removed.push(value);
  return { added, removed };
}

/**
 * The parsed times the stalled check reads, kept across writes instead of
 * rescanning every log, write and note for each Rules object. It holds every
 * finite time from the same sources as the from-scratch scan in `rules`
 * (content writes, the per-item last changes, document times), and filters by
 * `now` only when asked, so one index serves any time. `advance` diffs a later
 * (or any other) snapshot by document identity and returns a new index; an
 * index never changes after it is made, so rules built on it stay valid.
 * Equivalence with the from-scratch scan is tested in test/derived.test.ts.
 */
export class ActivityIndex {
  /** Every time, ascending, repeats kept. */
  private readonly all: number[];
  /** Each item's times, ascending. */
  private readonly perItem: Map<string, number[]>;
  /** Each source's contribution: "a:" activity item entries, "i:" items, "d:" cards, "n:" notes, "g:" glossaries. */
  private readonly sources: Map<string, Contribution>;
  /** Notes by the card they target, re-resolved when that card changes or goes. */
  private readonly cardNotes: Map<string, Set<string>>;
  /** The parts of the snapshot this index reflects, compared by identity. */
  private readonly seen: ActivityInput;
  private constructor(all: number[], perItem: Map<string, number[]>, sources: Map<string, Contribution>, cardNotes: Map<string, Set<string>>, seen: ActivityInput) {
    this.all = all; this.perItem = perItem; this.sources = sources; this.cardNotes = cardNotes; this.seen = seen;
  }
  static build(s: ActivityInput): ActivityIndex {
    const index = new ActivityIndex([], new Map(), new Map(), new Map(), { items: {}, decisions: {}, notes: {}, glossaries: {}, activity: { writes: [], items: {} } });
    return index.advance(s);
  }
  /** Whether this index was made for exactly these documents. */
  reflects(s: ActivityInput): boolean {
    const seen = this.seen;
    return seen.items === s.items && seen.decisions === s.decisions && seen.notes === s.notes && seen.activity === s.activity
      && seen.glossaries === s.glossaries;
  }
  /** The index of `s`, sharing what did not change. */
  advance(s: ActivityInput): ActivityIndex {
    if (this.reflects(s)) return this;
    const all = this.all.slice(), perItem = new Map(this.perItem), sources = new Map(this.sources), cardNotes = new Map(this.cardNotes);
    const ownItems = new Set<string>(), ownCards = new Set<string>();
    const itemTimes = (id: string): number[] => {
      if (!ownItems.has(id)) { ownItems.add(id); perItem.set(id, (perItem.get(id) ?? []).slice()); }
      return perItem.get(id)!;
    };
    const cardSet = (key: string): Set<string> => {
      if (!ownCards.has(key)) { ownCards.add(key); cardNotes.set(key, new Set(cardNotes.get(key))); }
      return cardNotes.get(key)!;
    };
    const replace = (key: string, next: Contribution | undefined): void => {
      const old = sources.get(key);
      if (old) {
        for (const time of old.times) { removeSorted(all, time); if (old.id) removeSorted(itemTimes(old.id), time); }
        if (old.target) cardSet(old.target).delete(key.slice(2));
        sources.delete(key);
      }
      if (next && (next.times.length || next.target)) {
        for (const time of next.times) { insertSorted(all, time); if (next.id) insertSorted(itemTimes(next.id), time); }
        if (next.target) cardSet(next.target).add(key.slice(2));
        sources.set(key, next);
      }
    };
    const note = (key: string, n: Note | undefined): Contribution | undefined => {
      if (!n) return undefined;
      const card = n.target.startsWith("q:") ? n.target.slice(2) : undefined;
      const id = card === undefined ? n.target.slice(3) : Object.hasOwn(s.decisions, card) ? s.decisions[card]!.item : undefined;
      return { id: id || undefined, times: parsedTimes([n.at, n.sentAt, n.repliedAt]), ...(card === undefined ? {} : { target: card }) };
    };
    // Every key whose document is a different object in `s` than in what this index saw.
    function changedKeys<T>(before: Readonly<Record<string, T>> | undefined, after: Readonly<Record<string, T>> | undefined): string[] {
      const a = before ?? {}, b = after ?? {};
      if (a === b) return [];
      const keys: string[] = [];
      for (const key of Object.keys(b)) if (!Object.hasOwn(a, key) || a[key] !== b[key]) keys.push(key);
      for (const key of Object.keys(a)) if (!Object.hasOwn(b, key)) keys.push(key);
      return keys;
    }
    const get = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined => record && Object.hasOwn(record, key) ? record[key] : undefined;
    const seen = this.seen, before = seen.activity, after = s.activity;
    if (before !== after) {
      const { added, removed } = stringDelta(before?.writes ?? [], after?.writes ?? []);
      for (const time of parsedTimes(removed)) removeSorted(all, time);
      for (const time of parsedTimes(added)) insertSorted(all, time);
      for (const id of changedKeys(before?.items, after?.items)) {
        const at = get(after?.items, id);
        replace("a:" + id, at === undefined ? undefined : { id, times: parsedTimes([at]) });
      }
    }
    for (const id of changedKeys(seen.items, s.items)) {
      const it = get(s.items, id);
      replace("i:" + id, it && { id, times: parsedTimes([it.created, it.updated, ...it.log.map(entry => entry.at)]) });
    }
    const cards = changedKeys(seen.decisions, s.decisions);
    for (const key of cards) {
      const card = get(s.decisions, key);
      replace("d:" + key, card && { id: card.item || undefined, times: parsedTimes([card.at, card.updated, card.ruledAt]) });
    }
    const notes = new Set(changedKeys(seen.notes, s.notes));
    // A note on a card resets the card's item: a card that moved or went re-resolves its notes.
    for (const key of cards) for (const n of cardNotes.get(key) ?? []) notes.add(n);
    for (const key of notes) replace("n:" + key, note(key, get(s.notes, key)));
    for (const key of changedKeys(seen.glossaries, s.glossaries)) {
      const glossary = get(s.glossaries, key);
      replace("g:" + key, glossary && { id: undefined, times: parsedTimes(glossary.terms.map(term => term.updated)) });
    }
    for (const id of ownItems) if (!perItem.get(id)!.length) perItem.delete(id);
    for (const key of ownCards) if (!cardNotes.get(key)!.size) cardNotes.delete(key);
    return new ActivityIndex(all, perItem, sources, cardNotes, { items: s.items, decisions: s.decisions, notes: s.notes, glossaries: s.glossaries, activity: s.activity });
  }
  /** The union of active windows up to `now`: what the from-scratch scan in `rules` gives. */
  intervals(now: number): Array<[number, number]> {
    const intervals: Array<[number, number]> = [];
    for (const at of this.all) {
      if (at > now) break;
      const end = Math.min(now, at + ACTIVE_WINDOW_MS), previous = intervals.at(-1);
      if (previous && previous[1] >= at) previous[1] = Math.max(previous[1], end);
      else intervals.push([at, end]);
    }
    return intervals;
  }
  /** The item's last change at or before `now`, or -Infinity. */
  changedAt(id: string, now: number): number {
    const times = this.perItem.get(id);
    if (!times) return -Infinity;
    for (let i = times.length - 1; i >= 0; i--) if (times[i]! <= now) return times[i]!;
    return -Infinity;
  }
}

/** `list` with `value` inserted at its sorted place: the same array as pushing it and sorting. */
export function withSorted(list: readonly string[], value: string): string[] {
  let low = 0, high = list.length;
  while (low < high) { const middle = (low + high) >> 1; if (list[middle]! <= value) low = middle + 1; else high = middle; }
  return [...list.slice(0, low), value, ...list.slice(low)];
}
/** How one commit changed Snapshot["activity"]: the content write's time (absent for an owner-only commit), the items
 * whose last change moved, and each item whose pause spans changed with its whole new list. `from` is the head before
 * the commit: the delta applies only to the snapshot at that head. */
export interface ActivityDelta { from: string; write?: string; items: Record<string, string>; pauses: Record<string, Array<{ start: string; end?: string }>>; sessions: Record<string, { name: string; at: string }>; agents?: Record<string, AgentTouch[]>; states?: Record<string, readonly StateStart[]> }
/** The activity after `delta`, equal to the store's (docs/design.md, live updates); unchanged activity stays the same object. */
export function applyActivityDelta(activity: Snapshot["activity"], delta: ActivityDelta): Snapshot["activity"] {
  if (delta.write === undefined && !Object.keys(delta.items).length && !Object.keys(delta.pauses).length && !Object.keys(delta.sessions ?? {}).length && !Object.keys(delta.agents ?? {}).length && !Object.keys(delta.states ?? {}).length) return activity;
  const base = activity ?? { writes: [], items: {} };
  const pauses = base.pauses || Object.keys(delta.pauses).length ? { ...base.pauses, ...delta.pauses } : undefined;
  const sessions = base.sessions || Object.keys(delta.sessions ?? {}).length ? { ...base.sessions, ...delta.sessions } : undefined;
  const agents = base.agents || Object.keys(delta.agents ?? {}).length ? { ...base.agents, ...delta.agents } : undefined;
  const states = base.states || Object.keys(delta.states ?? {}).length ? { ...base.states, ...delta.states } : undefined;
  return { writes: delta.write === undefined ? base.writes : withSorted(base.writes, delta.write), items: { ...base.items, ...delta.items }, ...(pauses ? { pauses } : {}), ...(sessions ? { sessions } : {}), ...(agents ? { agents } : {}), ...(states ? { states } : {}) };
}

/** The fields of an item that the status of every item is derived from: the plan and the owner's ask, a
 * cancellation, a pause, the project (a pause stops at the project's edge), a record, the order
 * of the top items, which the index sorts as it is built, and the dispatch records (a live session makes an item worked on).
 * The test in test/derived.test.ts records which fields the derivation reads and fails when this list and that set
 * differ. */
export const STATUS_FIELDS: ReadonlyArray<keyof Item> = ["record", "standing", "status", "plan", "paused", "group", "ask", "order", "dispatches"];
/** Whether two versions of one item give the same status on the same board. Versions that differ in some other
 * field (the text, the log, the tags) do; one that differs in a listed field may not, which only costs the caller a derivation. */
export function sameStatus(a: Item, b: Item): boolean {
  return STATUS_FIELDS.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/** Everything derived the page paints for an item (web/app.ts): its row, its plan rows and those of its owned items,
 * and the labels of what it waits on and what waits on it. The page repaints an item when this changes. */
export function presentationSignature(r: Rules, decisions: Readonly<Record<string, Decision>>, id: string): string {
  const it = r.item(id);
  const label = (kind: string, key: string): unknown[] => {
    if (kind === "card") { const d = decisions[key]; const o = d?.options.find(o => o.key === d.choice); return [d?.question, d?.status, d?.blocks, d?.choice, o?.text, o?.detail]; }
    const owner = r.parentOf(key);
    return [r.item(key)?.title, r.groupOf(key), r.statusOf(key), owner, owner ? r.item(owner)?.title : null, r.planRatio(key)];
  };
  const deps = r.depsOf(id).map(d => [d, ...label(d.kind, d.id)]);
  const waiters = r.dependents(id).map(d => [d, ...label("item", d.id)]);
  return JSON.stringify([r.groupOf(id), r.statusOf(id), r.progress(id), r.checks(id), it?.tags ?? [], it?.difficulty ?? null, r.stalledBelow(id), r.pausedBy(id), r.item(r.pausedBy(id) || "")?.paused, it?.paused, r.isStanding(id), deps, waiters,
    r.planRows(id).map(row => [row, "text" in row.row ? r.stepLine(row.row) : null, "item" in row.row && row.row.own ? r.planRows(row.row.item).map(child => [child, "text" in child.row ? r.stepLine(child.row) : "item" in child.row ? label("item", child.row.item) : label("card", child.row.card)]) : null])]);
}

/**
 * The items whose page presentation a live update can change, from the items
 * it touched directly (`seeds`): what a full pass over every item would find
 * changed, without deriving every item. A derived value moves only along plan
 * edges (rows and their reverse), so the walk examines the neighbours of every
 * item whose derived summary changed, and stops at items whose summary did
 * not. The result adds every examined item's ancestors, whose subtree counts,
 * filters and owned-row lines read it. Elapsed time alone (active time, doing
 * days) is not a change here: the page re-signs everything on its minute timer.
 */
export function affectedItems(before: Rules, after: Rules, seeds: Iterable<string>): Set<string> {
  const summary = (r: Rules, id: string): string => {
    const it = r.item(id);
    if (!it) return "";
    const parent = r.parentOf(id), pausedBy = r.pausedBy(id);
    return JSON.stringify([it.title, r.groupOf(id), r.statusOf(id), r.isOpenWork(id), r.isStanding(id), r.isPaused(id), pausedBy, pausedBy ? r.item(pausedBy)?.paused : null,
      parent, parent ? r.item(parent)?.title : null, r.onCycle(id), r.planRatio(id), r.isNeeded(id), r.begun(id), r.checks(id)]);
  };
  const neighbours = (id: string): string[] => [before, after].flatMap(r => [...r.depsOf(id).filter(d => d.kind === "item").map(d => d.id), ...r.dependents(id).map(d => d.id)]);
  const examined = new Set<string>(), queue: string[] = [];
  for (const id of seeds) if (!examined.has(id)) { examined.add(id); queue.push(id); }
  while (queue.length) {
    for (const next of neighbours(queue.pop()!)) {
      if (examined.has(next)) continue;
      examined.add(next);
      if (summary(before, next) !== summary(after, next)) queue.push(next);
    }
  }
  const out = new Set(examined);
  for (const id of examined) for (const r of [before, after]) for (const a of r.ancestors(id)) out.add(a);
  // A doing step's clock also reads the items it names, so a change under a named item (itself or any owner of it) reaches the step's item.
  for (const id of examined) for (const r of [before, after]) for (const target of [id, ...r.ancestors(id)]) for (const waiter of r.mentionedBy(target)) {
    out.add(waiter);
    for (const a of r.ancestors(waiter)) out.add(a);
  }
  return out;
}
/** The items a live change touches directly, or null when it changes what every item reads (the board, the owner's
 * state, a glossary). Card and note changes reach the card's item and every plan waiting on the card; `activity`, the
 * change's activity delta, adds the items whose clock or pause spans it moved. */
export function changeSeeds(before: Pick<Snapshot, "decisions" | "notes">, after: Pick<Snapshot, "decisions" | "notes">, beforeRules: Rules, afterRules: Rules, changed: ReadonlyArray<{ kind: string; id: string }>, activity?: ActivityDelta): Set<string> | null {
  // Items whose last change or pause spans moved, including a note on a card deleted earlier, which only the store places.
  const seeds = new Set<string>([...Object.keys(activity?.items ?? {}), ...Object.keys(activity?.pauses ?? {})]);
  // A session's write moves its last-activity time, which the status of every item it works on reads (liveDispatches).
  for (const name of Object.keys(activity?.agents ?? {})) for (const r of [beforeRules, afterRules]) for (const id of r.dispatchedItems(name)) seeds.add(id);
  const card = (key: string) => {
    for (const s of [before, after]) { const owner = Object.hasOwn(s.decisions, key) ? s.decisions[key]!.item : undefined; if (owner) seeds.add(owner); }
    for (const r of [beforeRules, afterRules]) for (const waiter of r.cardDependents(key)) seeds.add(waiter.id);
  };
  for (const doc of changed) {
    if (doc.kind === "item") seeds.add(doc.id);
    else if (doc.kind === "decision") card(doc.id);
    else if (doc.kind === "note") {
      for (const s of [before, after]) {
        const target = Object.hasOwn(s.notes, doc.id) ? s.notes[doc.id]!.target : undefined;
        if (target?.startsWith("it:")) seeds.add(target.slice(3));
        else if (target?.startsWith("q:")) card(target.slice(2));
      }
    }
    // A message changes no item, card or note, so it reaches no rule; any other kind (the board, owner state, a glossary) may reach every item.
    else if (doc.kind !== "message") return null;
  }
  return seeds;
}

/** Rules objects shared by every reader of one snapshot. A Rules object reads
 * `now` only for elapsed time (active time, doing days, and the six-hour window
 * of a live session, which status reads); readers within the
 * same minute share the one built at the first read of that minute, so its
 * results are exactly `rules(s, t)` for that first read's time `t`. The
 * activity index is advanced from the newest one instead of rebuilt. */
export class DerivedCache {
  private latest?: ActivityIndex;
  private readonly byState = new WeakMap<object, { bucket: number; rules: Rules }>();
  /** The newest published state, the state one write made it from and what that write changed (`follows`). Only the newest step
   * is kept: a step per state, each holding the state before it, would keep every state since the cache began. */
  private step?: { after: object; before: object } & Omit<PreviousRules, "rules">;
  /** `after` was published by one write on `before` that changed the documents `changed` and moved the activity by `activity`:
   * its Rules object is built from before's when that one is of the same minute (rules' `previous`), as the page builds its own
   * (docs/design.md, section 4, Write cost). It replaces the step before, so the cache holds two states at most. */
  follows(after: RulesInput, before: RulesInput, changed: PreviousRules["changed"], activity?: ActivityDelta): void {
    this.step = { after, before, changed, ...(activity ? { activity } : {}) };
  }
  /** The activity index of `s`, advanced from the newest index this cache made. */
  activity(s: ActivityInput): ActivityIndex {
    this.latest = this.latest ? this.latest.advance(s) : ActivityIndex.build(s);
    return this.latest;
  }
  rules(s: RulesInput, now = Date.now()): Rules {
    const bucket = Math.floor(now / 60_000), hit = this.byState.get(s);
    if (hit?.bucket === bucket) return hit.rules;
    const step = this.step?.after === s ? this.step : undefined, prior = step && this.byState.get(step.before);
    const previous = step && prior?.bucket === bucket ? { rules: prior.rules, changed: step.changed, ...(step.activity ? { activity: step.activity } : {}) } : undefined;
    const made = rules(s, now, { activity: () => this.activity(s), ...(previous ? { previous } : {}) });
    this.byState.set(s, { bucket, rules: made });
    return made;
  }
  /** Rules for a prospective state derived from `base`, not kept: its activity index is advanced from base's without replacing it. */
  candidate(base: ActivityInput, s: RulesInput, now = Date.now()): Rules {
    return rules(s, now, { activity: () => (this.latest?.reflects(base) ? this.latest : this.activity(base)).advance(s) });
  }
}

type RulesInput = Pick<Snapshot, "board" | "items" | "decisions" | "notes" | "owner"> & Partial<Pick<Snapshot, "activity" | "glossaries">>;
/** A Rules object built for the state just before one write, with what that write changed: `changed`, every document it
 * changed (the change event's list), and `activity`, its activity delta. */
export interface PreviousRules { rules: Rules; changed: ReadonlyArray<{ kind: string; id: string }>; activity?: ActivityDelta }
/** What a Rules object keeps for the next one to reuse: its derived values, the time it answers for, and why it was built
 * from scratch (null when it reused its previous one). */
interface Carried { memo: Map<string, Map<string, unknown>>; closedMemo: Map<string, unknown>; targetStatuses: Map<string, unknown>; intervals?: Array<[number, number]>; now: number; rebuilt: string | null }
const carried = new WeakMap<Rules, Carried>();
/** Why `r` derived everything from scratch ("no previous", "minute", "document", "activity", "session"), or null when it
 * reused the previous Rules object it was given. */
export function rebuiltBecause(r: Rules): string | null { const kept = carried.get(r); return kept ? kept.rebuilt : "no previous"; }
/** The time `r` answers for: the time it was asked for, or, when it reused its previous one, the time that one answered for. */
export function answersFor(r: Rules): number | undefined { return carried.get(r)?.now; }
/**
 * `activity`, when given, must be the index of exactly `s` (ActivityIndex.build(s) or advanced to s); without it the times are
 * scanned from `s`. `previous`, when given, lets a write that changed no field a status reads keep what was derived before it
 * (docs/design.md, section 4, Write cost).
 */
export function rules(s: RulesInput, now = Date.now(), { activity: activityOption, previous: previousOption }: { activity?: ActivityIndex | (() => ActivityIndex); previous?: PreviousRules } = {}): Rules {
  // No function below reads `previousOption`: a closure that did would keep the Rules object before this one, and through it
  // every earlier one with its state, alive as long as this one (docs/design.md, section 4, Write cost).
  function stepDays(step: PlanStep): number { return step.since ? Math.max(0, Math.floor((now - Date.parse(step.since)) / (24 * 60 * 60 * 1000))) : 0; }
  function stepLine(step: PlanStep): string {
    if (step.state === "done") return `✓ ${step.text} (${step.doneAt!.slice(5, 10)})`;
    if (step.state === "doing") return `● ${step.text} — ${stepDays(step)} 天${step.waits ? `，等 ${step.waits}` : ""}`;
    if (step.state === "dropped") return `✗ ${step.text} — ${step.reason}`;
    return `○ ${step.text}`;
  }
  const memo = new Map<string, Map<string, unknown>>();
  function cached<T>(name: string, key: string, make: () => T): T {
    let values = memo.get(name);
    if (!values) { values = new Map(); memo.set(name, values); }
    if (!values.has(key)) values.set(key, make());
    return values.get(key) as T;
  }
  function index() {
    return cached("index", "", () => {
      const items = new Map(Object.entries(s.items));
      const children = new Map<string, string[]>();
      const owners = new Map<string, string[]>();
      const notes = new Map<string, Note[]>();
      const cards = new Map<string, string[]>(), mentioned = new Map<string, string[]>();
      for (const [id, it] of items) {
        const owned = it.plan.filter(row => "item" in row && row.own).map(row => (row as Extract<PlanRow, { item: string }>).item);
        children.set(id, owned);
        for (const target of owned) { const list = owners.get(target) || []; list.push(id); owners.set(target, list); }
        for (const row of it.plan) if ("text" in row) for (const target of new Set(mentionsIn(row.text))) {
          const list = mentioned.get(target) || [];
          if (!list.includes(id)) list.push(id);
          mentioned.set(target, list);
        }
      }
      children.set("", [...items.keys()].filter(id => !owners.has(id)).sort(byOrder));
      for (const n of Object.values(s.notes)) {
        const list = notes.get(n.target) || [];
        list.push(n); notes.set(n.target, list);
      }
      // An item's cards follow its plan; a card whose row is missing still belongs to its item and comes last.
      const listed = new Set<string>();
      for (const [id, it] of items) for (const row of it.plan) {
        if (!("card" in row) || s.decisions[row.card]?.item !== id || listed.has(row.card)) continue;
        listed.add(row.card); cards.set(id, [...cards.get(id) || [], row.card]);
      }
      for (const [key, d] of Object.entries(s.decisions)) if (!listed.has(key)) cards.set(d.item, [...cards.get(d.item) || [], key]);
      return { items, children, owners, notes, cards, mentioned, decisions: new Map(Object.entries(s.decisions)) };
    });
  }
  // Called while building the index too, so it must not call index().
  function byOrder(a: string, b: string): number { return (s.items[a]?.order || 0) - (s.items[b]?.order || 0); }
  const item = (id: string): Item | undefined => index().items.get(id);
  const kids = (id: string): string[] => index().children.get(id) || [];
  const notesOf = (target: string): Note[] => index().notes.get(target) || [];
  function parentOf(id: string): string | undefined {
    return index().owners.get(id)?.[0];
  }
  function ancestors(id: string): string[] {
    return cached("ancestors", id, () => {
      const out: string[] = [], seen = new Set([id]);
      for (let p = parentOf(id); p && !seen.has(p); p = parentOf(p)) { seen.add(p); out.push(p); }
      return out;
    });
  }
  function lineOf(id: string): string { return ancestors(id).at(-1) || id; }
  function pausedBy(id: string): string | undefined {
    return cached("pausedBy", id, () => {
      const seen = new Set<string>(), group = item(id)?.group;
      for (let current: string | undefined = id; current && !seen.has(current); current = parentOf(current)) {
        seen.add(current);
        const it = item(current);
        if (!it || it.group !== group) break;
        if (!it.record && it.paused) return current;
      }
      return undefined;
    });
  }
  function isPaused(id: string): boolean { return statusOf(id) === "paused"; }
  function groupOf(id: string): string { return item(id)?.group || ""; }
  function areas(include?: (id: string) => boolean): string[] {
    function ordered(): string[] {
      const list = kids("").filter(id => !include || include(id)), groups = new Map(s.board.projects.map((p, i) => [p.name, i]));
      for (const id of list) { const g = item(id)?.group || ""; if (!groups.has(g)) groups.set(g, groups.size); }
      return list.sort((a, b) => groups.get(item(a)?.group || "")! - groups.get(item(b)?.group || "")! || byOrder(a, b));
    }
    return include ? ordered() : cached("areas", "", ordered);
  }
  /** Whether `row` is a row of a standing item's plan that points at another standing item: always resolved, left out of the counts (docs/design.md, Item plans, Standing items). */
  const standingPair = (owner: Item | undefined, row: PlanRow): boolean => !!owner?.standing && "item" in row && !!item(row.item)?.standing;
  function rowState(row: PlanRow, seen: Set<string>, owner?: Item): Pick<DerivedPlanRow, "state" | "dropped" | "excluded" | "weight"> & { paused?: boolean } {
    if ("text" in row) {
      // The state is read once: the walk is bounded per snapshot (test/rules.test.ts, shared diamonds).
      const { state } = row;
      return {
        state: state === "doing" ? "progress" : state === "todo" ? "open" : "resolved",
        dropped: state === "dropped", excluded: state === "dropped",
        weight: state === "done" ? 1 : state === "doing" ? 0.5 : 0,
      };
    }
    if ("card" in row) {
      const open = !s.decisions[row.card] || s.decisions[row.card]?.status === "open";
      return { state: open ? "waiting" : "resolved", dropped: false, excluded: false, weight: open ? 0 : 1 };
    }
    const target = item(row.item);
    if (!target) return { state: "waiting", dropped: false, excluded: false, weight: 0 };
    // A record is no step: resolved so that nothing waits for it, and left out of the counts and the share, owned or shared.
    if (target.record) return { state: "resolved", dropped: false, excluded: true, weight: null };
    // A standing item never completes, so a standing item's row for another one waits for nothing: resolved and left out of the counts like a record's.
    if (standingPair(owner, row)) return { state: "resolved", dropped: false, excluded: true, weight: null };
    const status = statusWalk(row.item, seen), dropped = row.own && status === "cancelled";
    const state = status === "done" || dropped ? "resolved" : !row.own || status === "blocked" || status === "paused" ? "waiting" : status === "wip" ? "progress" : "open";
    // A sub-item counts as its status says, shared or owned: done whole, in progress or idle half; a cancelled one is left out of the share.
    const weight = status === "cancelled" ? null : status === "done" ? 1 : status === "wip" || status === "idle" ? 0.5 : 0;
    return { state, dropped, excluded: dropped, paused: status === "paused", weight };
  }
  const isRecord = (row: PlanRow): boolean => isRecordRow(s.items, row);
  function planRowsWalk(id: string, seen: Set<string>): DerivedPlanRow[] {
    const out: DerivedPlanRow[] = [], byId = new Map<string, DerivedPlanRow>(), owner = item(id), plan = owner?.plan ?? [];
    for (const [at, row] of plan.entries()) {
      const preceding = (row.after ?? followedRows(plan, at, isRecord)).map(key => byId.get(key));
      const { paused, ...derived } = rowState(row, seen, owner);
      const ready = derived.state !== "resolved" && preceding.every(p => p?.state === "resolved");
      const level = preceding.length ? 1 + Math.max(...preceding.map(p => p?.level ?? 0)) : 0;
      const glyph = paused ? "◌"
        : standingPair(owner, row) ? "∞"
        : derived.dropped ? "✗" : { resolved: "✓", progress: "●", waiting: "⏸", open: "○" }[derived.state];
      const entry = { row, ...derived, ready, level, glyph };
      out.push(entry); byId.set(row.id, entry);
    }
    return out;
  }
  function planRows(id: string): DerivedPlanRow[] { return cached("planRows", id, () => planRowsWalk(id, new Set([id]))); }
  function planRatio(id: string): { done: number; total: number } {
    // A standing item does not progress toward anything, so it has no share of its plan done.
    if (item(id)?.standing) return { done: 0, total: 0 };
    const rows = planRows(id).filter(row => !row.excluded);
    return { done: rows.filter(row => row.state === "resolved").length, total: rows.length };
  }
  function stageInfo(id: string): StageInfo | undefined {
    return cached("stages", id, () => {
      if (item(id)?.standing) return undefined;
      const entries = planRows(id).flatMap(entry => { const stage = stageOf(entry.row); return stage ? [{ entry, ...stage }] : []; });
      if (!entries.some(e => e.kind === "research") || !entries.some(e => e.kind === "impl")) return undefined;
      const counted = entries.filter(e => !e.entry.excluded), open = counted.filter(e => e.entry.state !== "resolved");
      const at = open.find(e => e.entry.state === "progress") ?? open[0], name = STAGES.find(s => s.kind === at?.kind)?.name;
      return {
        done: counted.length - open.length, total: counted.length,
        share: counted.length ? counted.reduce((sum, e) => sum + (e.entry.weight ?? 0), 0) / counted.length : 0,
        current: at && name ? { id: at.entry.row.id, kind: at.kind, round: at.round, label: at.round > 1 ? `${name}·${at.round}` : name } : undefined,
      };
    });
  }
  function progressShare(id: string): number {
    if (item(id)?.standing) return 0;
    const stages = stageInfo(id);
    if (stages) return stages.share;
    const rows = planRows(id).filter(row => !row.excluded && row.weight !== null);
    return rows.length ? rows.reduce((sum, row) => sum + row.weight!, 0) / rows.length : 0;
  }
  function planGroups(id: string): Array<{ start: number; end: number; level: number }> {
    const rows = planRows(id), groups: Array<{ start: number; end: number; level: number }> = [];
    for (let start = 0; start < rows.length;) {
      const first = rows[start]!;
      let end = start + 1;
      while (end < rows.length && rows[end]!.level === first.level) end++;
      if (end - start >= 2) groups.push({ start, end, level: first.level });
      start = end;
    }
    return groups;
  }
  // Whether a plan row is resolved, reading only whether items are done or cancelled. The rows before an owned item in its
  // owner's plan decide whether its turn has come, and that must not ask the items' full statuses, which ask it back.
  function rowResolved(row: PlanRow, seen: Set<string>): boolean {
    if ("text" in row) return row.state === "done" || row.state === "dropped";
    if ("card" in row) { const card = s.decisions[row.card]; return !!card && card.status !== "open"; }
    const target = item(row.item);
    if (!target) return false;
    if (target.record) return true;
    const closed = closedWalk(row.item, seen);
    return closed === "done" || (row.own && closed === "cancelled");
  }
  const closedMemo = new Map<string, "done" | "cancelled" | undefined>();
  // Done or cancelled, by the same rules as the status; an item met again on the path is not done (a cycle never completes).
  // A value is kept only when no such guard was hit while computing it: one that was depends on where the walk began, and
  // the order edges ownerRowReady follows are not in cycles(), so that set cannot tell.
  let closedGuards = 0;
  function closedWalk(id: string, seen: Set<string>): "done" | "cancelled" | undefined {
    if (closedMemo.has(id)) return closedMemo.get(id);
    const it = item(id);
    if (!it || it.record) return undefined;
    if (it.status === "cancelled") return "cancelled";
    // A standing item never completes, whatever its rows say.
    if (it.standing) return undefined;
    if (seen.has(id)) { closedGuards++; return undefined; }
    const before = closedGuards;
    seen.add(id);
    const closed = it.plan.length > 0 && it.plan.every(row => rowResolved(row, seen)) ? "done" : undefined;
    seen.delete(id);
    if (closedGuards === before) closedMemo.set(id, closed);
    return closed;
  }
  // Whether the row that owns the item has come up in its owner's plan: every row before it is resolved. A record's
  // rows are a list, not an order, so an item a record owns (a backlog item) is always ready. A record row in the owner's
  // plan is no step: the row after it follows the step before it.
  function ownerRowWaits(id: string): string[] {
    const owner = parentOf(id), plan = owner ? item(owner) : undefined;
    if (!owner || !plan || plan.record) return [];
    const resolved = new Map<string, boolean>(), seen = new Set([id]);
    for (const [at, row] of plan.plan.entries()) {
      if ("item" in row && row.item === id) return (row.after ?? followedRows(plan.plan, at, isRecord)).filter(key => !(resolved.get(key) ?? false));
      resolved.set(row.id, standingPair(plan, row) || rowResolved(row, seen));
    }
    return [];
  }
  function ownerRowReady(id: string): boolean { return ownerRowWaits(id).length === 0; }
  // Something of its own is done: a step of the plan, an item it owns that is done, or an open item it owns that has itself
  // begun. What others finished does not count: a shared row, a card and an owned record are not this item's work.
  const beginning = new Set<string>();
  function begunOf(id: string): boolean {
    return cached("begun", id, () => {
      if (beginning.has(id)) return false;
      beginning.add(id);
      try { return anyBegun(planRows(id)); } finally { beginning.delete(id); }
    });
  }
  function anyBegun(rows: readonly DerivedPlanRow[]): boolean {
    return rows.some(entry => !entry.excluded && ("text" in entry.row ? entry.state === "resolved" : "item" in entry.row && entry.row.own && (entry.state === "resolved" || begunOf(entry.row.item))));
  }
  const liveSessions = (id: string): string[] => cached("sessions", id, () => [...new Set(liveDispatches(s, id, now).map(d => d.agent))]);
  // Cycle members keep the path-sensitive guard; acyclic targets have the same
  // result in every caller and are evaluated once per immutable snapshot.
  const targetStatuses = new Map<string, Status | undefined>();
  // The first rule that holds decides (docs/design.md, Status).
  function statusWalk(id: string, seen: Set<string>): Status | undefined {
    if (targetStatuses.has(id)) return targetStatuses.get(id);
    const it = item(id);
    if (!it || it.record) return undefined;
    if (it.status === "cancelled") return "cancelled";
    // A standing item is in progress for as long as it is not paused: its plan rows do not decide anything (docs/design.md, Item plans, Standing items).
    if (it.standing) { const status = pausedBy(id) ? "paused" : "wip"; targetStatuses.set(id, status); return status; }
    if (seen.has(id)) return "blocked";
    seen.add(id);
    const rows = planRowsWalk(id, seen);
    seen.delete(id);
    const frontier = rows.filter(row => row.ready);
    const status = rows.length && rows.every(row => row.state === "resolved") ? "done"
      : pausedBy(id) ? "paused"
      : !rows.length ? "todo"
      : rows.some(row => row.state === "progress") ? "wip"
      : askPending(id) || (frontier.length > 0 && frontier.every(row => row.state === "waiting")) || !ownerRowReady(id) ? "blocked"
      : liveSessions(id).length ? "wip"
      : anyBegun(rows) ? "idle" : "todo";
    if (!cycles().has(id)) targetStatuses.set(id, status);
    return status;
  }
  function statusOf(id: string): Status | undefined { return cached("status", id, () => statusWalk(id, new Set())); }
  function workedOn(id: string): boolean {
    return cached("workedOn", id, () => (item(id)?.plan ?? []).some(row => "text" in row && row.state === "doing") || liveSessions(id).length > 0);
  }
  function dispatchedItems(agent: string): string[] {
    const byAgent = cached("dispatched", "", () => {
      const out = new Map<string, string[]>();
      for (const id of index().items.keys()) for (const d of (item(id)?.dispatches ?? [])) if (!d.finish && worksOnItem(d)) { const list = out.get(d.agent) ?? []; if (!list.includes(id)) list.push(id); out.set(d.agent, list); }
      return out;
    });
    return (byAgent.get(agent) ?? []).slice();
  }
  // The step an agent would start with: ready, still to do, and waiting on nothing.
  function nextStep(id: string): DerivedPlanRow | undefined {
    return planRows(id).find(entry => entry.ready && "text" in entry.row && entry.row.state === "todo" && !entry.row.waits);
  }
  function canStart(id: string): boolean {
    const st = statusOf(id);
    return (st === "todo" || st === "idle") && neededSet().has(id) && nextStep(id) !== undefined;
  }
  function startable(id: string): boolean { return canStart(id) && item(id)?.difficulty !== undefined; }
  function progress(id: string): Progress {
    return {
      waiting: planRows(id).filter(entry => entry.ready && entry.state === "waiting").map(entry => "item" in entry.row ? { kind: "item" as const, id: entry.row.item } : { kind: "card" as const, id: (entry.row as { card: string }).card }),
      ask: askPending(id), behind: !ownerRowReady(id),
    };
  }
  function isLeaf(id: string): boolean { return !kids(id).some(k => item(k) && !item(k)!.record); }
  function isStatusLeaf(id: string): boolean { return isLeaf(id); }
  function ended(id: string): boolean { const st = statusOf(id); return st === "done" || st === "cancelled"; }
  function isOpenWork(id: string): boolean { return !!item(id) && statusOf(id) !== undefined && !ended(id); }
  function depsOf(id: string): Dependency[] {
    return cached("deps", id, () => planRows(id).flatMap(({ row, state }): Dependency[] => {
      if ("item" in row) return [{ kind: "item" as const, id: row.item, own: row.own, missing: !item(row.item), open: state !== "resolved" }];
      if ("card" in row) return [{ kind: "card" as const, id: row.card, missing: !s.decisions[row.card], open: state !== "resolved" }];
      return [];
    }));
  }
  function reverseDeps() {
    return cached("reverseDeps", "", () => {
      const items = new Map<string, Array<{ id: string; own?: boolean }>>(), cards = new Map<string, Array<{ id: string; own?: boolean }>>();
      for (const id of index().items.keys()) {
        for (const row of item(id)!.plan) {
          if ("text" in row) continue;
          const target = "item" in row ? row.item : row.card, m = "item" in row ? items : cards, list = m.get(target) || [];
          if (!list.some(w => w.id === id)) list.push("item" in row ? { id, own: row.own } : { id });
          m.set(target, list);
        }
      }
      return { items, cards };
    });
  }
  function cardsOf(id: string): string[] { return index().cards.get(id) || []; }
  function askPending(id: string): boolean {
    const ask = item(id)?.ask;
    return !!ask && !notesOf("it:" + id).some(n => (n.kind === "approve" || n.kind === "done") && n.state !== "draft" && (n.answerText ?? n.text) === ANSWER[n.kind] + ask.text);
  }
  function cardWaiting(key: string): boolean { return index().decisions.get(key)?.status === "open"; }
  function cardBlocking(key: string): boolean { return cardWaiting(key) && !!index().decisions.get(key)?.blocks; }
  function ownerBlocking(id: string): boolean { return askPending(id) || cardsOf(id).some(cardBlocking); }
  function subtreeCount(id: string, own: (id: string) => number): number {
    const seen = new Set<string>(), walk = (v: string): number => { if (seen.has(v)) return 0; seen.add(v); return own(v) + kids(v).reduce((n, k) => n + walk(k), 0); };
    return walk(id);
  }
  const blockingOwn = (id: string): number => Number(askPending(id)) + cardsOf(id).filter(cardBlocking).length;
  const nonBlockingOwn = (id: string): number => cardsOf(id).filter(k => cardWaiting(k) && !cardBlocking(k)).length;
  function needsOwner(id: string): boolean {
    return cached("needsOwner", id, () => askPending(id) || cardsOf(id).some(cardWaiting));
  }
  const waiters = (id: string): string[] => (reverseDeps().items.get(id) || []).map(w => w.id);
  function isBacklog(id: string): boolean {
    return isOpenWork(id) && (index().owners.get(id) || []).some(owner => item(owner)?.record);
  }
  function isRoot(id: string): boolean { return !!item(id) && !isBacklog(id) && !waiters(id).some(isOpenWork); }
  function openDependents(id: string): number {
    return cached("openDependents", id, () => (reverseDeps().items.get(id) || []).filter(w => !w.own && isOpenWork(w.id) && !isPaused(w.id)).length);
  }
  // The reach of the unpaused roots: up from every root along the open, unpaused rows.
  function neededSet(): Set<string> {
    return cached("needed", "", () => {
      const ids = [...index().items.keys()], out = new Set<string>();
      const eligible = (id: string): boolean => isOpenWork(id) && !isPaused(id);
      for (const id of ids) if (eligible(id) && isRoot(id)) out.add(id);
      for (let changed = true; changed;) {
        changed = false;
        for (const id of ids) if (!out.has(id) && eligible(id) && waiters(id).some(waiter => out.has(waiter))) { out.add(id); changed = true; }
      }
      return out;
    });
  }
  function cycles(): Set<string> {
    return cached("cycles", "", () => {
      const idx = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>(), out = new Set<string>();
      let n = 0;
      const next = (id: string): string[] => (item(id)?.plan ?? []).flatMap(row => "item" in row && item(row.item) ? [row.item] : []);
      function visit(v: string): void {
        idx.set(v, n); low.set(v, n++); stack.push(v); on.add(v);
        for (const w of next(v)) {
          if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
          else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        }
        if (low.get(v) === idx.get(v)) {
          const component: string[] = [];
          let w: string;
          do { w = stack.pop()!; on.delete(w); component.push(w); } while (w !== v);
          if (component.length > 1 || next(v).includes(v)) for (const id of component) out.add(id);
        }
      }
      for (const id of index().items.keys()) if (!idx.has(id)) visit(id);
      return out;
    });
  }
  // Current document times cover imported/synthetic snapshots; history retains
  // overwritten revisions and deleted cards/notes, which current fields cannot.
  function activity(): { intervals: Array<[number, number]>; changedAt(id: string): number } {
    return cached("activity", "", () => {
      if (activityOption) {
        const index = typeof activityOption === "function" ? activityOption() : activityOption;
        return { intervals: index.intervals(now), changedAt: (id: string) => index.changedAt(id, now) };
      }
      const writes: number[] = [], changed = new Map<string, number>();
      const add = (at: string | undefined, id?: string) => {
        const time = at ? Date.parse(at) : NaN;
        if (!Number.isFinite(time) || time > now) return;
        writes.push(time);
        if (id) changed.set(id, Math.max(changed.get(id) ?? -Infinity, time));
      };
      for (const at of s.activity?.writes ?? []) add(at);
      for (const [id, at] of Object.entries(s.activity?.items ?? {})) add(at, id);
      for (const [id, it] of Object.entries(s.items)) {
        add(it.created, id); add(it.updated, id);
        for (const entry of it.log) add(entry.at, id);
      }
      for (const card of Object.values(s.decisions)) { add(card.at, card.item); add(card.updated, card.item); add(card.ruledAt, card.item); }
      for (const note of Object.values(s.notes)) {
        const id = note.target.startsWith("it:") ? note.target.slice(3) : s.decisions[note.target.slice(2)]?.item;
        add(note.at, id); add(note.sentAt, id); add(note.repliedAt, id);
      }
      for (const glossary of Object.values(s.glossaries ?? {})) for (const term of glossary.terms) add(term.updated);
      const intervals: Array<[number, number]> = [];
      for (const at of writes.sort((a, b) => a - b)) {
        const end = Math.min(now, at + ACTIVE_WINDOW_MS), previous = intervals.at(-1);
        if (previous && previous[1] >= at) previous[1] = Math.max(previous[1], end);
        else intervals.push([at, end]);
      }
      return { intervals, changedAt: (id: string) => changed.get(id) ?? -Infinity };
    });
  }
  /** The items whose changes count as the progress of this item's doing steps: the item itself, every item it owns that
   * is in progress, and every item a doing step names, each with the items it owns down every layer. A shared
   * dependency is another item's work and does not count. */
  function stallRelated(id: string): string[] {
    const out = new Set<string>([id]), down = (v: string): void => { if (out.has(v)) return; out.add(v); for (const k of kids(v)) down(k); };
    for (const { row, state } of planRows(id)) {
      if ("text" in row) { if (row.state === "doing") for (const target of mentionsIn(row.text)) down(target); }
      else if ("item" in row && row.own && state === "progress") down(row.item);
    }
    return [...out];
  }
  function stalled(id: string): boolean {
    if (isPaused(id)) return false;
    const { intervals, changedAt } = activity(), since = Math.max(...stallRelated(id).map(changedAt));
    if (!Number.isFinite(since)) return false;
    const pauses: Array<[number, number]> = [];
    const recorded = (s.activity?.pauses?.[id] ?? []).map(pause => [Date.parse(pause.start), pause.end ? Date.parse(pause.end) : now] as [number, number])
      .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start).sort((a, b) => a[0] - b[0]);
    for (const [start, end] of recorded) {
      const previous = pauses.at(-1);
      if (previous && previous[1] >= start) previous[1] = Math.max(previous[1], end);
      else pauses.push([start, end]);
    }
    return intervals.reduce((total, [start, end]) => {
      const from = Math.max(start, since);
      const paused = pauses.reduce((sum, [pauseStart, pauseEnd]) => sum + Math.max(0, Math.min(end, pauseEnd) - Math.max(from, pauseStart)), 0);
      return total + Math.max(0, end - from) - paused;
    }, 0) >= STALLED_AFTER_MS;
  }
  function cardChecks(key: string): Check[] {
    return cached("cardChecks", key, () => {
      const d = index().decisions.get(key);
      if (!d || !cardWaiting(key) || d.options.length >= CARD_MIN_OPTIONS) return [];
      return [check("card-options-short", `决策卡只有 ${d.options.length} 个选项，至少要给三个都走得通的做法`)];
    });
  }
  // The card checks shown: none for a card of a cancelled item. Refusals keep them.
  function shownCardChecks(key: string): Check[] {
    const d = index().decisions.get(key);
    return d && statusOf(d.item) === "cancelled" ? [] : cardChecks(key).map(c => ({ ...c }));
  }
  function copyChecks(list: Check[]): Check[] { return list.map(c => c.target ? { ...c, target: { ...c.target } } : { ...c }); }
  function checks(id: string): Check[] {
    return cached("checks", id, () => {
      const it = item(id), out: Check[] = [];
      if (!it) return out;
      const st = statusOf(id), parent = parentOf(id), deps = depsOf(id), rows = planRows(id);
      for (const e of deps) {
        const target = { kind: e.kind, id: e.id };
        if (e.missing) out.push(check(e.kind === "item" ? "dep-item-missing" : "dep-card-missing", (e.kind === "item" ? "依赖的条目不存在：" : "依赖的决策卡不存在：") + e.id, target));
        else if (e.kind === "item" && !e.own && statusOf(e.id) === "cancelled") out.push(check("dep-item-cancelled", "依赖的条目已取消", target));
      }
      // A card and its row are one fact stored twice: an open blocking card has its row in its item's plan, an open card
      // that does not block has none (the work goes on without it), and each card row names a card of this item. A card
      // that is closed keeps the row it had. Only a write that bypasses write_card can break that.
      const own = cardsOf(id), rowCards = it.plan.flatMap(row => "card" in row ? [row.card] : []);
      const apart = [...own.filter(key => cardBlocking(key) && !rowCards.includes(key)).map(key => `${key} 挡事，却没有计划行`), ...own.filter(key => cardWaiting(key) && !cardBlocking(key) && rowCards.includes(key)).map(key => `${key} 不挡事，却有计划行`),
        ...rowCards.filter(key => s.decisions[key] && s.decisions[key]!.item !== id).map(key => `${key} 属于条目 ${s.decisions[key]!.item}`)];
      if (apart.length) out.push(check("card-plan-mismatch", `卡和计划对不上：${apart.join("；")}`));
      const placed = placedCardsOf(it);
      for (const key of own) if (cardWaiting(key) && !placed.includes(key)) out.push(check("card-unplaced", `开着的卡没在正文里标位置：在正文里提出这个问题的地方，单独一行写 [[q:${key}]]`, { kind: "card", id: key }));
      if (cycles().has(id)) out.push(check("dep-cycle", "依赖成环"));
      if (!s.board.projects.some(project => project.name === it.group)) out.push(check("project-unconfigured", "项目没有配置：" + it.group));
      if ((index().owners.get(id)?.length ?? 0) > 1) out.push(check("owned-by-many", "被多个条目拥有"));
      for (const owner of index().owners.get(id) || []) if (groupOf(owner) !== it.group) out.push(check("owned-across-projects", "跨项目拥有", { kind: "item", id: owner }));
      // A standing item's row for another standing item waits for nothing, so it neither makes its target awaited nor conflicts with its pause.
      const waitsFor = (waiter: string): boolean => !(item(waiter)?.standing && it.standing);
      if (!parent && isOpenWork(id) && (reverseDeps().items.get(id) || []).some(e => !e.own && isOpenWork(e.id) && groupOf(e.id) === it.group && waitsFor(e.id))) out.push(check("unowned-but-awaited", "同项目有条目在等它，却没有条目拥有它"));
      for (const card of cardsOf(id)) for (const inner of cardChecks(card)) out.push({ ...inner, target: { kind: "card", id: card } });
      if (!it.record && !it.standing && !rows.some(({ row }) => "text" in row && row.accept)) out.push(check("no-acceptance", "没有计划：至少要有一个验收步骤"));
      // A standing item never completes, so a row of an ordinary item that owns it or waits for it can never be resolved.
      if (!it.record && !it.standing) for (const row of it.plan) if ("item" in row && item(row.item)?.standing) out.push(check("waits-on-standing", row.own ? "拥有一个常设条目，它不会完成：常设条目放在顶层，或放在别的常设条目下面" : "等着一个常设条目，它不会完成：删掉这一行", { kind: "item", id: row.item }));
      // Titles of closed items are not revised, so only open items and records are checked.
      const titleLength = [...it.title.replace(/\s/g, "")].length;
      if (titleLength > TITLE_MAX_CHARS && (it.record || !ended(id))) out.push(check("title-too-long", `标题超过 ${TITLE_MAX_CHARS} 个字（现在 ${titleLength} 个）`));
      // Only once the vocabulary offers the item's project a tag: before that nothing could clear the check.
      if (!it.tags?.length && tagsRequired(s.board.tags, it.group)) out.push(check("tags-missing", "缺标签：用 set_tags 从标签词表里给它选至少一个标签"));
      if (it.provisional) out.push(check("plan-provisional", "计划待重写"));
      if (st === "paused") for (const waiter of reverseDeps().items.get(id) || []) {
        if (!waiter.own && isOpenWork(waiter.id) && !isPaused(waiter.id) && waitsFor(waiter.id)) out.push(check("pause-conflict", `暂停了，但 ${item(waiter.id)!.title} 在等它`, { kind: "item", id: waiter.id }));
      }
      if (!it.record) {
        const acceptance = rows.filter(({ row }) => "text" in row && row.accept), others = rows.filter(({ row }) => !("text" in row && row.accept));
        if (acceptance.some(({ row }) => "text" in row && row.text === "（转换时没找到完成条件，待补）")) out.push(check("acceptance-pending", "验收步骤待补"));
        if (acceptance.some(row => row.state !== "resolved") && others.every(row => row.state === "resolved")) out.push(check("only-acceptance-left", "只差验收：其它行都已完成"));
        if (isOpenWork(id) && parent && ended(parent)) out.push(check("owner-closed", "拥有它的条目已关闭", { kind: "item", id: parent }));
        if (st === "wip" && it.plan.some(row => "text" in row && row.state === "doing") && stalled(id)) out.push(check("stalled", "进行中但 1 小时（活跃时间）没有动静"));
        // An engineer's plan has the big steps the engineer rules name, in order: the board reads progress and the current step from them.
        if (isOpenWork(id) && heldByEngineer(it)) {
          const problems = stageProblems(it.plan);
          if (problems.length) out.push(check("stage-format", `工程师领着这个条目，计划的大步骤不合规则：${problems.join("；")}。大步骤是 id 为 ${STAGES.map(s => s.kind).join("、")} 的行（回头重做的轮次写成 impl-2 这样），写法见工程师规则的「计划的大步骤」`));
        }
        // A ruling can settle how the work is done, and the head's 做法 is where the owner reads it: a card ruled after the head was last
        // revised asks for a rewrite. Paused work is asked too, as it is for the other checks of form: its head is read as well.
        if (isOpenWork(id)) {
          const ruled = own.flatMap(key => { const d = index().decisions.get(key); return d?.status === "ruled" && d.ruledAt !== undefined ? [d] : []; });
          const revised = ruled.length ? headRevisedAt(it) : -Infinity, later = ruled.filter(d => wholeSeconds(d.ruledAt!) > revised);
          if (later.length) {
            const last = later.reduce((a, b) => Date.parse(b.ruledAt!) > Date.parse(a.ruledAt!) ? b : a), question = last.question.replace(/\s+/g, " ").trim();
            const ruling = `决策卡「${question.length > 40 ? `${question.slice(0, 40)}…` : question}」${last.ruledAt} 裁定${later.length > 1 ? `（另有 ${later.length - 1} 张也在之后裁定）` : ""}`;
            const was = Number.isFinite(revised) ? new Date(revised * 1000).toISOString().replace(".000Z", "Z") : "没有记录";
            out.push(check("approach-stale", `做法待更新：${ruling}，晚于条目头最后一次修改（${was}）。用 update_item 把「做法」改写成选定的设计：机制、触发条件、否决了什么和为什么，语言或接口类的改动附前后代码例子；PR 里的设计文档只作细节出处。做法本来就对，也要改写 head 记下这次裁定，例如写进「以前的决定」`));
          }
        }
        // A todo step's waits text is invisible to the derived status, so the item looks startable: one check per item lists the rows by id.
        const waiting = it.plan.flatMap(row => "text" in row && row.state === "todo" && row.waits ? [row.id] : []);
        if (isOpenWork(id) && !isPaused(id) && !isBacklog(id) && waiting.length) out.push(check("waits-in-text", `在等的事写在文字里，看板看不出，所以这些行看着能开工。改法：等别的条目就用共享依赖；等主人就出卡；等 CI、14900K 这类看板外的事，把这一行标成进行中；暂时不做就挪进待选。写了在等的行：${waiting.join("、")}`));
        // Asked for only when the rating is the one thing left before the item can be dispatched (canStart): it is todo or
        // part way with nobody on it, its next own step waits on nothing, and an unpaused root needs it. While another item
        // is the next step (a study, say), the rating waits too, and what no such root needs (backlog work, what hangs under
        // it, paused work) is not asked for.
        if (it.difficulty === undefined && canStart(id)) out.push(check("difficulty-missing", "缺难度：用 set_difficulty 评 1–5 级；没评级的条目不算可以开工"));
      }
      return out;
    });
  }
  // A write that changed no field the statuses read (STATUS_FIELDS) and came in the same minute keeps every derived value but
  // the checks and their stalled counts of the items it can reach; the activity is derived again from the new index. Returns
  // why it could not, or null.
  function reuse(previous: PreviousRules): string | null {
    const before = previous.rules, was = carried.get(before);
    if (!was) return "no previous";
    if (Math.floor(was.now / 60_000) !== Math.floor(now / 60_000)) return "minute";
    if (!previous.changed.every(d => d.kind === "message" || d.kind === "item" && before.item(d.id) && s.items[d.id] && sameStatus(before.item(d.id)!, s.items[d.id]!))) return "document";
    // Within one minute a Rules object answers for the first build's time, as DerivedCache does: the kept values were made for it.
    now = was.now;
    // A write before that time widens the active time every stalled check reads, which no list of items bounds.
    if (was.intervals && JSON.stringify(activity().intervals) !== JSON.stringify(was.intervals)) return "activity";
    // A session's write moves the last activity the status of the items it works on reads (liveDispatches).
    for (const agent of Object.keys(previous.activity?.agents ?? {})) for (const id of before.dispatchedItems(agent)) {
      const sessions = was.memo.get("sessions");
      if (sessions?.has(id) && JSON.stringify(sessions.get(id)) !== JSON.stringify([...new Set(liveDispatches(s, id, now).map(d => d.agent))])) return "session";
    }
    // The checks a write can change: those of the items it changed or whose clock or pause spans moved, their owners, the items
    // they wait on (a pause check names its waiter's title) and that wait on them, and the items whose doing step names one of
    // them or an owner of it (stallRelated), each with its owners, whose stalled counts read the checks below them.
    const reach = new Set<string>();
    const up = (id: string) => { reach.add(id); for (const a of before.ancestors(id)) reach.add(a); };
    const seeds = [...previous.changed.filter(d => d.kind === "item").map(d => d.id), ...Object.keys(previous.activity?.items ?? {}), ...Object.keys(previous.activity?.pauses ?? {})];
    for (const id of new Set(seeds)) {
      up(id);
      for (const d of before.depsOf(id)) if (d.kind === "item") up(d.id);
      for (const d of before.dependents(id)) up(d.id);
      for (const target of [id, ...before.ancestors(id)]) for (const w of before.mentionedBy(target)) up(w);
    }
    for (const [name, values] of was.memo) {
      if (name === "activity") continue;
      if (name === "index") { memo.set(name, new Map([["", { ...values.get("") as ReturnType<typeof index>, items: new Map(Object.entries(s.items)) }]])); continue; }
      const copy = new Map(values);
      if (name === "checks" || name === "stalledBelow") for (const id of reach) copy.delete(id);
      memo.set(name, copy);
    }
    for (const [k, v] of was.closedMemo) closedMemo.set(k, v as "done" | "cancelled" | undefined);
    for (const [k, v] of was.targetStatuses) targetStatuses.set(k, v as Status | undefined);
    return null;
  }
  const asked = now, rebuilt = previousOption ? reuse(previousOption) : "no previous";
  if (rebuilt !== null) { now = asked; memo.clear(); }
  const made: Rules = {
    stepDays, stepLine, planRatio, progressShare,
    stages: id => { const info = stageInfo(id); return info && { ...info, current: info.current && { ...info.current } }; },
    planRows: id => planRows(id).map(entry => ({ ...entry, row: structuredClone(entry.row) })),
    planGroups: id => planGroups(id).map(group => ({ ...group })),
    stalledBelow: id => cached("stalledBelow", id, () => subtreeCount(id, v => Number(checks(v).some(c => c.id === "stalled")))),
    mentionedBy: id => (index().mentioned.get(id) || []).slice(),
    item, parentOf, children: id => (index().children.get(id) || []).slice(), areas: include => areas(include).slice(),
    ancestors: id => ancestors(id).slice(), lineOf, groupOf, projectOf: groupOf,
    isOpenWork, isStanding: id => !!item(id)?.standing,
    isLeaf, isStatusLeaf, statusOf, workedOn, begun: begunOf, dispatchedItems, canStart, startable, progress, ownerRowWaits, pausedBy, isPaused, isBacklog, isRoot, isNeeded: id => neededSet().has(id), openDependents,
    depsOf: id => depsOf(id).map(e => ({ ...e })),
    dependents: id => (reverseDeps().items.get(id) || []).map(e => ({ ...e })),
    cardDependents: key => (reverseDeps().cards.get(key) || []).map(e => ({ ...e })),
    cardsOf: id => cardsOf(id).slice(), cardChecks: key => shownCardChecks(key), askPending, cardWaiting, cardBlocking, ownerBlocking, needsOwner,
    blockingBelow: id => cached("blockingBelow", id, () => subtreeCount(id, blockingOwn)), nonBlockingBelow: id => cached("nonBlockingBelow", id, () => subtreeCount(id, nonBlockingOwn)), onCycle: id => cycles().has(id),
    checks: id => statusOf(id) === "cancelled" ? [] : copyChecks(checks(id)),
    refusals: id => copyChecks(checks(id)),
    compareSiblings: (a, b) => Number(ended(a)) - Number(ended(b)) || byOrder(a, b),
    // An item without a number (written before numbers) sorts after the numbered; the key settles what is left.
    compareCandidates: (a, b) => openDependents(b) - openDependents(a)
      || (item(a)?.num ?? Infinity) - (item(b)?.num ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0),
  };
  carried.set(made, { memo, closedMemo, targetStatuses, now, rebuilt, get intervals() { return memo.get("activity")?.get("") ? activity().intervals : undefined; } });
  return made;
}
