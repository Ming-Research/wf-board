// Pure snapshot-derived rules shared by the server and the owner's page.
// The plan is the single source for ownership, status, priority and progress.
import { liveDispatches } from "./agents.ts";
import type { AgentTouch, Decision, Item, PlanStep, PlanRow, PlanRowInput, ItemTarget, ItemTargetInput, Note, Priority, Project, Snapshot, Status } from "./model.ts";
import { ARCHITECT, ARCHITECT_SESSION, dispatchable, isArchitect, planRowId, tagsRequired } from "./model.ts";

/** Project list order is page order; only the architect may place a project after another. */
export function projectOrderAfter(projects: readonly Project[], name: string, after: string, who: { author: string; session?: string }): Project[] {
  if (!isArchitect(who)) throw new Error(`after: only ${ARCHITECT} with session ${ARCHITECT_SESSION} may reorder projects`);
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
/** The word that makes a plan step a merge row, together with a PR it names (src/query.ts mergeRowPulls). */
export const MERGE_WORD = "合入";
/** A plan step that may be a merge row: not done, not dropped, not an acceptance step, and it says 合入. */
export function isOpenMergeStep(row: PlanRow): row is PlanStep {
  return "text" in row && !row.accept && (row.state === "todo" || row.state === "doing") && row.text.includes(MERGE_WORD);
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

// --- GitHub Actions usage (docs/design.md, Watching Actions usage) ----------------------------------------------------------------

/** The minutes an organization's plan includes each month (GitHub Team): the one number the usage is held against. */
export const ACTIONS_INCLUDED_MINUTES = 3000;
/** The percentages of the included minutes whose first crossing in a month is told. */
export const USAGE_LEVELS: readonly number[] = [50, 75, 90];
/** More counted minutes than this in one UTC day is told, once for that day. */
export const USAGE_DAY_LIMIT = 300;
/** How many included minutes one minute of a runner uses, by the usage report's sku, lower case. The names are those of the
 * organization's own report, read on 2026-10-16: it holds "Actions Linux", "Actions Windows" and "Actions macOS 3-core" rows. GitHub's
 * page on how Actions is billed (docs.github.com/en/billing/concepts/product-billing/github-actions, "baseline minute costs")
 * names the same runners and prices them per minute: Linux 2-core $0.006, Windows 2-core $0.010, macOS 3-core or 4-core $0.062.
 * It states no multipliers. Source of the 2 and 10: GitHub's earlier billing description (Windows minutes count twice, macOS
 * ten times against the included minutes), not found on today's page and not checked against a bill. Provisional: no private
 * repository here runs Windows or macOS, so they change no figure today, and counting too many is the safer error (an early
 * push, not a missed one). When a private repository first runs Windows or macOS, check the line against that month's
 * included-usage figure on the billing page and replace the 2 and 10 by what that shows.
 * A sku not listed is not guessed at: the account leaves it out and `unknownSkus` names it. */
const USAGE_MULTIPLIER: ReadonlyMap<string, number> = new Map([["actions linux", 1], ["actions windows", 2], ["actions macos 3-core", 10]]);
const multiplierOf = (sku: string): number | undefined => USAGE_MULTIPLIER.get(sku.toLowerCase());

export type Visibility = "public" | "private" | "internal";
/** One line of the usage report: the minutes of one runner type in one repository on one day (`date` is UTC). */
export interface UsageRow { date: string; repo: string; sku: string; minutes: number }
/** What one look at an organization's billing read. `visibility` is by repository name in lower case. */
export interface UsageReading {
  org: string; /** UTC month of the report, `2026-10`. */ month: string; /** When it was read. */ at: string;
  rows: UsageRow[];
  visibility: Record<string, Visibility>;
  /** The organization's Actions budget; none when none is set. */
  budget?: { amount: number; stop: boolean };
}
/** The board's own account of one organization's month. The report gives no history of a repository's visibility, so each look
 * adds what the report grew by since the last look, counted only if the repository is not public at that look. */
export interface OrgBooks {
  month: string; /** When the books were started: the first look of the month. */ since: string;
  /** Per repository (lower case) and day: the included minutes the report showed at the last look, and the part counted. */
  entries: Array<{ day: string; repo: string; seen: number; counted: number }>;
  /** The keys (`usageKey`) of the pushes told this month: kept with the account, which is new each month, so a restart does not
   * tell them again however long ago they were told. */
  told: string[];
}

/** The skus of the Actions minutes in a reading that the account does not know, in repositories that are not public: they may use
 * some of the included minutes, and the account leaves them out. */
export function unknownSkus(reading: Pick<UsageReading, "rows" | "visibility">): string[] {
  const out = new Set<string>();
  for (const row of reading.rows) if (multiplierOf(row.sku) === undefined && reading.visibility[row.repo.toLowerCase()] !== "public") out.add(row.sku);
  return [...out].sort();
}

/** The books after one more look. A new month starts new books. */
export function advanceBooks(books: OrgBooks | undefined, reading: UsageReading): OrgBooks {
  const fresh = !books || books.month !== reading.month;
  const shown = new Map<string, { day: string; repo: string; minutes: number }>();
  for (const row of reading.rows) {
    const factor = multiplierOf(row.sku), day = row.date.slice(0, 10), repo = row.repo.toLowerCase();
    if (factor === undefined || !day.startsWith(reading.month)) continue;
    const key = `${day} ${repo}`, entry = shown.get(key) ?? { day, repo, minutes: 0 };
    entry.minutes += row.minutes * factor; shown.set(key, entry);
  }
  const entries = new Map<string, OrgBooks["entries"][number]>((fresh ? [] : books.entries).map(e => [`${e.day} ${e.repo}`, e]));
  for (const [key, { day, repo, minutes }] of shown) {
    const before = entries.get(key) ?? { day, repo, seen: 0, counted: 0 };
    // A report revised downwards adds nothing; what was counted stays.
    const added = Math.max(0, minutes - before.seen);
    entries.set(key, { day, repo, seen: minutes, counted: before.counted + (reading.visibility[repo] === "public" ? 0 : added) });
  }
  return { month: reading.month, since: fresh ? reading.at : books.since, entries: [...entries.values()], told: fresh ? [] : [...books.told] };
}

/** What the books say at the time of a reading. */
export interface UsageFigures {
  org: string; month: string; /** The UTC day of the reading. */ day: string; since: string;
  /** The included minutes used this month and this day. */ used: number; today: number; included: number;
  budget: { amount: number; stop: boolean } | null;
  /** The skus the account does not know (`unknownSkus`). */
  unknown: string[];
}
export function usageFigures(books: OrgBooks, reading: Pick<UsageReading, "org" | "at" | "budget" | "rows" | "visibility">): UsageFigures {
  const day = reading.at.slice(0, 10);
  const used = books.entries.reduce((sum, e) => sum + e.counted, 0), today = books.entries.reduce((sum, e) => sum + (e.day === day ? e.counted : 0), 0);
  return { org: reading.org, month: books.month, day, since: books.since, used: Math.round(used), today: Math.round(today), included: ACTIONS_INCLUDED_MINUTES, budget: reading.budget ?? null, unknown: unknownSkus(reading) };
}

const budgetText = (budget: UsageFigures["budget"]): string => !budget ? "未设" : `${budget.amount} 美元${budget.stop ? "，到上限就拦" : ""}`;
/** The line the timed wake carries, with the skus the account does not know when there are any. `several`: more than one organization is read, so each line names its own. */
export function usageLine(f: UsageFigures, several = false): string {
  return `${several ? `${f.org}：` : ""}Actions 本月已用 ${f.used} / ${f.included}（从 ${f.since.slice(5, 10)} 起记账），今天 ${f.today}，预算 ${budgetText(f.budget)}${f.unknown.length ? `；有不认识的计费项：${f.unknown.join("、")}` : ""}`;
}

export type UsageReason = "month" | "day" | "cap";
/** The fields of an `actions-usage` push; `level` is the percentage crossed for `month`, else null. */
export interface UsagePushFields { org: string; reason: UsageReason; level: number | null; month: string; day: string; used: number; included: number; today: number; budget: UsageFigures["budget"]; text: string }
export interface UsagePush { key: string; fields: UsagePushFields }
/** What makes a push the same push again: a month level once a month, the day limit once a day, the cap once a month. */
export function usageKey(f: Pick<UsagePushFields, "org" | "reason" | "level" | "month" | "day">): string {
  return f.reason === "month" ? `actions-usage ${f.org} month ${f.month} ${f.level}` : f.reason === "day" ? `actions-usage ${f.org} day ${f.day}` : `actions-usage ${f.org} cap ${f.month}`;
}

/** What to tell the architect now. Month: the highest level crossed, if it is not told yet (it is told once for the levels below
 * it as well, so a first look at 88% is one push, not two). Day: more than the day limit counted today. Cap: all the included
 * minutes used and a budget of 0, which stops the private repositories' CI. `announced` holds the keys already told. */
export function usagePushes(f: UsageFigures, announced: ReadonlySet<string>): UsagePush[] {
  const out: UsagePush[] = [];
  const push = (reason: UsageReason, level: number | null, text: string) => {
    const fields: UsagePushFields = { org: f.org, reason, level, month: f.month, day: f.day, used: f.used, included: f.included, today: f.today, budget: f.budget, text };
    out.push({ key: usageKey(fields), fields });
  };
  const percent = f.included > 0 ? 100 * f.used / f.included : 0, crossed = USAGE_LEVELS.filter(level => percent >= level), top = crossed.at(-1);
  const total = `已用 ${f.used} / ${f.included}（从 ${f.since.slice(5, 10)} 起记账），今天 ${f.today}，预算 ${budgetText(f.budget)}`;
  if (top !== undefined && !USAGE_LEVELS.filter(level => level >= top).some(level => announced.has(usageKey({ org: f.org, reason: "month", level, month: f.month, day: f.day })))) push("month", top, `${f.org} 的 Actions 本月用量到 ${top}%：${total}`);
  if (f.today > USAGE_DAY_LIMIT) push("day", null, `${f.org} 的 Actions 今天用了 ${f.today} 分钟，超过单日 ${USAGE_DAY_LIMIT}：${total}`);
  if (f.used >= f.included && f.budget?.amount === 0) push("cap", null, `${f.org} 的 Actions 本月用量到顶，预算是 0：${total}`);
  return out.filter(p => !announced.has(p.key));
}

/** The one rule that log entries and dispatch records never count as owner-unread: owner-facing item comparisons drop them first. */
export function withoutHistoricalDetail<T extends object>(doc: T): Omit<T, "log" | "dispatches"> { const { log: _log, dispatches: _dispatches, ...rest } = doc as T & { log?: unknown; dispatches?: unknown }; return rest; }
/** The owner reads a first rating (an item's difficulty from none to a level) as bookkeeping, not news: rating hundreds of
 * items would show each of them new for one added label. Changing a level that exists is news. Returns the pair with a
 * first rating left out of `after`; any other pair comes back as it is. */
export function withoutFirstRating<T extends { difficulty?: unknown }>(before: T | null, after: T | null): [T | null, T | null] {
  if (!before || !after || before.difficulty !== undefined || after.difficulty === undefined) return [before, after];
  const { difficulty: _rated, ...rest } = after;
  return [before, rest as T];
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

/** A title longer than this many characters (spaces not counted) gets a check. */
export const TITLE_MAX_CHARS = 20;
/** The visible tag of a check whose own label is not set. */
export const CHECK_LABEL = "需核对";
/** A WIP item with its own doing step quiet for STALLED_AFTER_MS of active time carries this label instead. */
export const STALLED_LABEL = "无人推进";
/** An open item with a todo step that says what it waits on in text the board cannot read carries this label. */
export const WAITS_TEXT_LABEL = "在等文字";
export const EARLY_ACCEPT_LABEL = "验收过早";
/** An open decision card must offer at least this many workable options; the card and its item carry an OPTIONS_LABEL check below it. */
export const CARD_MIN_OPTIONS = 3;
export const OPTIONS_LABEL = "选项不足";
export const checkLabel = (c: Pick<Check, "label">): string => c.label ?? CHECK_LABEL;
export interface Check {
  text: string;
  /** Short visible tag; absent means CHECK_LABEL. The text is the full explanation (tooltip). */
  label?: string;
  target?: { kind: "item" | "card"; id: string };
}

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
  isLeaf(id: string): boolean;
  /** No non-record children contribute work status. */
  isStatusLeaf(id: string): boolean;
  statusOf(id: string): Status | undefined;
  /** Someone is working on the item now: a step of its own in progress, or a live session (an unfinished dispatch whose session
   * wrote or was started within the agent list's window). Not inherited from the items it owns. */
  workedOn(id: string): boolean;
  /** The sessions of the item's live dispatches, newest start first. */
  sessionsOf(id: string): string[];
  /** The items that carry an unfinished dispatch of this session. */
  dispatchedItems(agent: string): string[];
  /** Work an agent could be started on now, apart from its rating: status todo or idle, an unpaused root needs it, and
   * a step ready to start that waits on nothing. The one definition the next-task list and the 缺难度 check both read. */
  canStart(id: string): boolean;
  /** `canStart` and rated 1–5: what the next-task list offers. */
  startable(id: string): boolean;
  /** What the detail line under an item's title says: how far it is, what comes next, what it waits on, who is working on it. */
  progress(id: string): Progress;
  /** Nearest explicit pause on this item or its same-project ownership chain. */
  pausedBy(id: string): string | undefined;
  /** Effective pause on open work; done and cancelled always win. */
  isPaused(id: string): boolean;
  /** Open work directly owned by a record has no root or stored-priority role. */
  isBacklog(id: string): boolean;
  /** No open work item points at it, and it is not open record-owned work. */
  isRoot(id: string): boolean;
  /** Open work an unpaused root needs: an unpaused root, or work such a root waits on
   * through open, unpaused rows, owned or shared. Backlog work is needed only when a needed item other than its record
   * also holds a row for it, and what hangs under it only when that work is; paused work and what only a paused root
   * needs are not needed. */
  isNeeded(id: string): boolean;
  /** A root's stored priority, otherwise the highest of open work dependents. */
  priorityOf(id: string): Priority | "";
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
  planRatio(id: string): { done: number; total: number };
  compareSiblings(a: string, b: string): number;
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
}
/** The progress line of an item (docs/design.md, How the page shows a plan). */
export interface Progress {
  done: number;
  total: number;
  /** The first step ready to start, when the plan has one. */
  next?: { id: string; text: string };
  /** The rows the frontier waits on: items and cards. */
  waiting: Array<{ kind: "item" | "card"; id: string }>;
  /** The item's own request to the owner is still unanswered. */
  ask: boolean;
  /** The row that owns this item in its owner's plan has rows before it that are not resolved. */
  behind: boolean;
  /** The rows in progress, in plan order: steps in progress, and owned items that are themselves in progress. */
  doing: Array<{ id: string; text: string }>;
  /** The sessions of the live dispatches. */
  sessions: string[];
}
/** The rows the row at `at` comes after, through `after` or the previous-row default, all the way back. */
function comesBefore(rows: readonly DerivedPlanRow[], at: number): DerivedPlanRow[] {
  const byId = new Map(rows.map(entry => [entry.row.id, entry])), seen = new Set<string>(), out: DerivedPlanRow[] = [];
  const visit = (index: number): void => {
    const after = rows[index]!.row.after, before = after === undefined ? (index > 0 ? [rows[index - 1]!.row.id] : []) : after;
    for (const key of before) {
      const entry = byId.get(key);
      if (!entry || seen.has(key)) continue;
      seen.add(key); out.push(entry); visit(rows.indexOf(entry));
    }
  };
  visit(at);
  return out;
}
const PRIORITIES: Priority[] = ["P0", "P1", "P2"];
const rankOfPriority = (priority: Priority | "" | undefined): number => priority ? PRIORITIES.indexOf(priority) : 3;
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
export interface ActivityDelta { from: string; write?: string; items: Record<string, string>; pauses: Record<string, Array<{ start: string; end?: string }>>; sessions: Record<string, { name: string; at: string }>; agents?: Record<string, AgentTouch[]> }
/** The activity after `delta`, equal to the store's (docs/design.md, live updates); unchanged activity stays the same object. */
export function applyActivityDelta(activity: Snapshot["activity"], delta: ActivityDelta): Snapshot["activity"] {
  if (delta.write === undefined && !Object.keys(delta.items).length && !Object.keys(delta.pauses).length && !Object.keys(delta.sessions ?? {}).length && !Object.keys(delta.agents ?? {}).length) return activity;
  const base = activity ?? { writes: [], items: {} };
  const pauses = base.pauses || Object.keys(delta.pauses).length ? { ...base.pauses, ...delta.pauses } : undefined;
  const sessions = base.sessions || Object.keys(delta.sessions ?? {}).length ? { ...base.sessions, ...delta.sessions } : undefined;
  const agents = base.agents || Object.keys(delta.agents ?? {}).length ? { ...base.agents, ...delta.agents } : undefined;
  return { writes: delta.write === undefined ? base.writes : withSorted(base.writes, delta.write), items: { ...base.items, ...delta.items }, ...(pauses ? { pauses } : {}), ...(sessions ? { sessions } : {}), ...(agents ? { agents } : {}) };
}

/** Everything derived the page paints for an item (web/app.ts): its row, its plan rows and those of its owned items,
 * and the labels of what it waits on and what waits on it. The page repaints an item when this changes. */
export function presentationSignature(r: Rules, decisions: Readonly<Record<string, Decision>>, id: string): string {
  const it = r.item(id);
  const label = (kind: string, key: string): unknown[] => {
    if (kind === "card") return [decisions[key]?.question, decisions[key]?.status, decisions[key]?.blocks];
    const owner = r.parentOf(key);
    return [r.item(key)?.title, r.groupOf(key), r.statusOf(key), r.priorityOf(key), owner, owner ? r.item(owner)?.title : null, r.planRatio(key)];
  };
  const deps = r.depsOf(id).map(d => [d, ...label(d.kind, d.id)]);
  const waiters = r.dependents(id).map(d => [d, ...label("item", d.id)]);
  return JSON.stringify([r.groupOf(id), r.statusOf(id), r.progress(id), r.priorityOf(id), r.checks(id), it?.tags ?? [], it?.difficulty ?? null, r.stalledBelow(id), r.pausedBy(id), r.item(r.pausedBy(id) || "")?.paused, it?.paused, deps, waiters,
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
    return JSON.stringify([it.title, r.groupOf(id), r.statusOf(id), r.isOpenWork(id), r.isPaused(id), pausedBy, pausedBy ? r.item(pausedBy)?.paused : null,
      r.priorityOf(id), parent, parent ? r.item(parent)?.title : null, r.onCycle(id), r.planRatio(id), r.isNeeded(id), r.checks(id)]);
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
    } else return null;
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
  /** The activity index of `s`, advanced from the newest index this cache made. */
  activity(s: ActivityInput): ActivityIndex {
    this.latest = this.latest ? this.latest.advance(s) : ActivityIndex.build(s);
    return this.latest;
  }
  rules(s: RulesInput, now = Date.now()): Rules {
    const bucket = Math.floor(now / 60_000), hit = this.byState.get(s);
    if (hit?.bucket === bucket) return hit.rules;
    const made = rules(s, now, { activity: () => this.activity(s) });
    this.byState.set(s, { bucket, rules: made });
    return made;
  }
  /** Rules for a prospective state derived from `base`, not kept: its activity index is advanced from base's without replacing it. */
  candidate(base: ActivityInput, s: RulesInput, now = Date.now()): Rules {
    return rules(s, now, { activity: () => (this.latest?.reflects(base) ? this.latest : this.activity(base)).advance(s) });
  }
}

type RulesInput = Pick<Snapshot, "board" | "items" | "decisions" | "notes" | "owner"> & Partial<Pick<Snapshot, "activity" | "glossaries">>;
/** `activity`, when given, must be the index of exactly `s` (ActivityIndex.build(s) or advanced to s); without it the times are scanned from `s`. */
export function rules(s: RulesInput, now = Date.now(), options: { activity?: ActivityIndex | (() => ActivityIndex) } = {}): Rules {
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
      for (const [key, d] of Object.entries(s.decisions)) {
        const list = cards.get(d.item) || [];
        list.push(key); cards.set(d.item, list);
      }
      for (const list of cards.values()) list.sort((a, b) => (s.decisions[a]?.order || 0) - (s.decisions[b]?.order || 0));
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
  function rowState(row: PlanRow, seen: Set<string>): Pick<DerivedPlanRow, "state" | "dropped" | "excluded"> & { paused?: boolean } {
    if ("text" in row) return {
      state: row.state === "doing" ? "progress" : row.state === "todo" ? "open" : "resolved",
      dropped: row.state === "dropped", excluded: row.state === "dropped",
    };
    if ("card" in row) return { state: !s.decisions[row.card] || s.decisions[row.card]?.status === "open" ? "waiting" : "resolved", dropped: false, excluded: false };
    const target = item(row.item);
    if (!target) return { state: "waiting", dropped: false, excluded: false };
    if (target.record) return { state: "resolved", dropped: false, excluded: row.own };
    const status = statusWalk(row.item, seen), dropped = row.own && status === "cancelled";
    const state = status === "done" || dropped ? "resolved" : !row.own || status === "blocked" || status === "paused" ? "waiting" : status === "wip" ? "progress" : "open";
    return { state, dropped, excluded: dropped, paused: status === "paused" };
  }
  function planRowsWalk(id: string, seen: Set<string>): DerivedPlanRow[] {
    const out: DerivedPlanRow[] = [], byId = new Map<string, DerivedPlanRow>();
    for (const row of item(id)?.plan ?? []) {
      const preceding = row.after === undefined ? out.slice(-1) : row.after.map(key => byId.get(key));
      const { paused, ...derived } = rowState(row, seen);
      const ready = derived.state !== "resolved" && preceding.every(p => p?.state === "resolved");
      const level = preceding.length ? 1 + Math.max(...preceding.map(p => p?.level ?? 0)) : 0;
      const glyph = paused ? "◌"
        : derived.dropped ? "✗" : { resolved: "✓", progress: "●", waiting: "⏸", open: "○" }[derived.state];
      const entry = { row, ...derived, ready, level, glyph };
      out.push(entry); byId.set(row.id, entry);
    }
    return out;
  }
  function planRows(id: string): DerivedPlanRow[] { return cached("planRows", id, () => planRowsWalk(id, new Set([id]))); }
  function planRatio(id: string): { done: number; total: number } {
    const rows = planRows(id).filter(row => !row.excluded);
    return { done: rows.filter(row => row.state === "resolved").length, total: rows.length };
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
    if (seen.has(id)) { closedGuards++; return undefined; }
    const before = closedGuards;
    seen.add(id);
    const closed = it.plan.length > 0 && it.plan.every(row => rowResolved(row, seen)) ? "done" : undefined;
    seen.delete(id);
    if (closedGuards === before) closedMemo.set(id, closed);
    return closed;
  }
  // Whether the row that owns the item has come up in its owner's plan: every row before it is resolved. A record's
  // rows are a list, not an order, so an item a record owns (a backlog item) is always ready.
  function ownerRowReady(id: string): boolean {
    const owner = parentOf(id), plan = owner ? item(owner) : undefined;
    if (!owner || !plan || plan.record) return true;
    const resolved = new Map<string, boolean>(), seen = new Set([id]);
    let previous = true;
    for (const row of plan.plan) {
      if ("item" in row && row.item === id) return (row.after === undefined ? [previous] : row.after.map(key => resolved.get(key) ?? false)).every(Boolean);
      previous = rowResolved(row, seen);
      resolved.set(row.id, previous);
    }
    return true;
  }
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
      for (const id of index().items.keys()) for (const d of (item(id)?.dispatches ?? [])) if (!d.finish) { const list = out.get(d.agent) ?? []; if (!list.includes(id)) list.push(id); out.set(d.agent, list); }
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
  function startable(id: string): boolean { return canStart(id) && dispatchable(item(id)?.difficulty); }
  function progress(id: string): Progress {
    const rows = planRows(id), ratio = planRatio(id), first = rows.find(entry => entry.ready && entry.state === "open");
    const text = (entry: DerivedPlanRow): string => "text" in entry.row ? entry.row.text : "item" in entry.row ? item(entry.row.item)?.title ?? entry.row.item : entry.row.card;
    return {
      done: ratio.done, total: ratio.total,
      ...(first ? { next: { id: first.row.id, text: text(first) } } : {}),
      waiting: rows.filter(entry => entry.ready && entry.state === "waiting").map(entry => "item" in entry.row ? { kind: "item" as const, id: entry.row.item } : { kind: "card" as const, id: (entry.row as { card: string }).card }),
      ask: askPending(id), behind: !ownerRowReady(id),
      doing: rows.filter(entry => entry.state === "progress").map(entry => ({ id: entry.row.id, text: text(entry) })),
      sessions: liveSessions(id).slice(),
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
  function cardWaiting(key: string): boolean {
    return index().decisions.get(key)?.status === "open" && !notesOf("q:" + key).some(n => n.kind === "choice" && n.state !== "draft");
  }
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
  // Only roots seed the least fixed point. Records and closed work pass none;
  // record-owned work receives priority from its other open dependents.
  function ranks() {
    return cached("ranks", "", () => {
      const ids = [...index().items.keys()], rank = new Map<string, number>();
      for (const id of ids) if (isRoot(id)) rank.set(id, rankOfPriority(item(id)!.priority));
      const rankOf = (id: string): number => rank.get(id) ?? 3;
      for (let changed = true; changed;) {
        changed = false;
        for (const id of ids) {
          const r = Math.min(rankOf(id), ...waiters(id).filter(waiter => isOpenWork(waiter) && !isPaused(waiter)).map(rankOf));
          if (r < rankOf(id)) { rank.set(id, r); changed = true; }
        }
      }
      return { rankOf };
    });
  }
  function priorityOf(id: string): Priority | "" { return cached("priority", id, () => PRIORITIES[ranks().rankOf(id)] || ""); }
  // The reach of the unpaused roots, by the same walk as the priorities: up from every root along the open, unpaused rows.
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
      if (options.activity) {
        const index = typeof options.activity === "function" ? options.activity() : options.activity;
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
      return [{ text: `决策卡只有 ${d.options.length} 个选项，至少要给三个都走得通的做法`, label: OPTIONS_LABEL }];
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
        if (e.missing) out.push({ text: (e.kind === "item" ? "依赖的条目不存在：" : "依赖的决策卡不存在：") + e.id });
        else if (e.kind === "item" && !e.own && statusOf(e.id) === "cancelled") out.push({ text: "依赖的条目已取消", target });
      }
      if (cycles().has(id)) out.push({ text: "依赖成环" });
      if (!s.board.projects.some(project => project.name === it.group)) out.push({ text: "项目没有配置：" + it.group });
      if ((index().owners.get(id)?.length ?? 0) > 1) out.push({ text: "被多个条目拥有" });
      for (const owner of index().owners.get(id) || []) if (groupOf(owner) !== it.group) out.push({ text: "跨项目拥有", target: { kind: "item", id: owner } });
      if (!parent && isOpenWork(id) && (reverseDeps().items.get(id) || []).some(e => !e.own && isOpenWork(e.id) && groupOf(e.id) === it.group)) out.push({ text: "同项目有条目在等它，却没有条目拥有它" });
      for (const card of cardsOf(id)) for (const check of cardChecks(card)) out.push({ ...check, target: { kind: "card", id: card } });
      if (!it.record && !rows.some(({ row }) => "text" in row && row.accept)) out.push({ text: "没有计划：至少要有一个验收步骤" });
      // Titles of closed items are not revised, so only open items and records are checked.
      const titleLength = [...it.title.replace(/\s/g, "")].length;
      if (titleLength > TITLE_MAX_CHARS && (it.record || !ended(id))) out.push({ text: `标题超过 ${TITLE_MAX_CHARS} 个字（现在 ${titleLength} 个）` });
      // Only once the vocabulary offers the item's project a tag: before that nothing could clear the check.
      if (!it.tags?.length && tagsRequired(s.board.tags, it.group)) out.push({ text: "缺标签：用 set_tags 从标签词表里给它选至少一个标签", label: "缺标签" });
      if (it.provisional) out.push({ text: "计划待重写", label: "待重写" });
      if (st === "paused") for (const waiter of reverseDeps().items.get(id) || []) {
        if (!waiter.own && isOpenWork(waiter.id) && !isPaused(waiter.id)) out.push({ text: `暂停了，但 ${item(waiter.id)!.title} 在等它`, label: "暂停冲突", target: { kind: "item", id: waiter.id } });
      }
      if (!it.record) {
        const acceptance = rows.filter(({ row }) => "text" in row && row.accept), others = rows.filter(({ row }) => !("text" in row && row.accept));
        if (acceptance.some(({ row }) => "text" in row && row.text === "（转换时没找到完成条件，待补）")) out.push({ text: "验收步骤待补" });
        if (acceptance.some(row => row.state !== "resolved") && others.every(row => row.state === "resolved")) out.push({ text: "只差验收：其它行都已完成" });
        // An acceptance step marked done while a row it comes after is still open: the check ran before the work it checks.
        const early = rows.flatMap((entry, at) => "text" in entry.row && entry.row.accept && entry.row.state === "done" ? [comesBefore(rows, at).filter(before => before.state !== "resolved").map(before => before.row.id)] : []).flat();
        if (early.length) out.push({ text: `验收步骤已标完成，它前面的行还有没完成的：${[...new Set(early)].join("、")}。验收要等它检查的行都做完再标；做不了的行先丢弃并写理由，不属于这件交付物的移出去`, label: EARLY_ACCEPT_LABEL });
        if (isOpenWork(id) && parent && ended(parent)) out.push({ text: "拥有它的条目已关闭", target: { kind: "item", id: parent } });
        if (st === "wip" && it.plan.some(row => "text" in row && row.state === "doing") && stalled(id)) out.push({ text: "进行中但 1 小时（活跃时间）没有动静", label: STALLED_LABEL });
        // A todo step's waits text is invisible to the derived status, so the item looks startable: one check per item lists the rows by id.
        const waiting = it.plan.flatMap(row => "text" in row && row.state === "todo" && row.waits ? [row.id] : []);
        if (isOpenWork(id) && !isPaused(id) && !isBacklog(id) && waiting.length) out.push({ text: `在等的事写在文字里，看板看不出，所以这些行看着能开工。改法：等别的条目就用共享依赖；等主人就出卡；等 CI、14900K 这类看板外的事，把这一行标成进行中；暂时不做就挪进待选。写了在等的行：${waiting.join("、")}`, label: WAITS_TEXT_LABEL });
        if (isOpenWork(id) && isRoot(id) && !it.priority) out.push({ text: "没有未完成的条目依赖它，却没写优先级" });
        // Asked for only when the rating is the one thing left before the item can be dispatched (canStart): it is todo or
        // part way with nobody on it, its next own step waits on nothing, and an unpaused root needs it. While another item
        // is the next step (a study, say), the rating waits too, and what no such root needs (backlog work, what hangs under
        // it, paused work) is not asked for.
        if (it.difficulty === undefined && canStart(id)) out.push({ text: "缺难度：只有架构师能评，用 set_difficulty 评 1–5 级，或标「架构师做」；没评级的条目不算可以开工", label: "缺难度" });
      }
      return out;
    });
  }
  return {
    stepDays, stepLine, planRatio,
    planRows: id => planRows(id).map(entry => ({ ...entry, row: structuredClone(entry.row) })),
    planGroups: id => planGroups(id).map(group => ({ ...group })),
    stalledBelow: id => cached("stalledBelow", id, () => subtreeCount(id, v => Number(checks(v).some(c => c.label === STALLED_LABEL)))),
    mentionedBy: id => (index().mentioned.get(id) || []).slice(),
    item, parentOf, children: id => (index().children.get(id) || []).slice(), areas: include => areas(include).slice(),
    ancestors: id => ancestors(id).slice(), lineOf, groupOf, projectOf: groupOf,
    isOpenWork,
    isLeaf, isStatusLeaf, statusOf, workedOn, sessionsOf: id => liveSessions(id).slice(), dispatchedItems, canStart, startable, progress, pausedBy, isPaused, isBacklog, isRoot, isNeeded: id => neededSet().has(id), priorityOf,
    depsOf: id => depsOf(id).map(e => ({ ...e })),
    dependents: id => (reverseDeps().items.get(id) || []).map(e => ({ ...e })),
    cardDependents: key => (reverseDeps().cards.get(key) || []).map(e => ({ ...e })),
    cardsOf: id => cardsOf(id).slice(), cardChecks: key => shownCardChecks(key), askPending, cardWaiting, cardBlocking, ownerBlocking, needsOwner,
    blockingBelow: id => cached("blockingBelow", id, () => subtreeCount(id, blockingOwn)), nonBlockingBelow: id => cached("nonBlockingBelow", id, () => subtreeCount(id, nonBlockingOwn)), onCycle: id => cycles().has(id),
    checks: id => statusOf(id) === "cancelled" ? [] : copyChecks(checks(id)),
    refusals: id => copyChecks(checks(id)),
    compareSiblings: (a, b) => rankOfPriority(priorityOf(a)) - rankOfPriority(priorityOf(b)) || Number(ended(a)) - Number(ended(b)) || byOrder(a, b),
  };
}
