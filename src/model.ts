// The board's documents and their schemas. Every document the store reads or
// writes passes through these schemas; docs/design.md section 5 gives the
// reasons for the shapes.

import { z } from "zod";

/** ISO 8601 UTC time as the server writes it, e.g. 2026-10-11T06:15:40Z. */
export const Time = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);

/** An item or decision key, which is also its file name. */
export const Key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/);

/**
 * A permanent short number for an item or a decision card, so the owner can name one as "#812". Items and cards share
 * one sequence. Only the store issues numbers, in creation order, and never reuses or reassigns one; keys stay the
 * identity everywhere else. Optional on read only for data written before numbers existed, which the store numbers once.
 */
export const Num = z.number().int().positive();
/** The store's persisted counter, numbers.yaml: the number the next new item or card receives. */
export const Numbers = z.object({ next: Num }).strict();
export type Numbers = z.infer<typeof Numbers>;
/** The number a short-number reference names, "#812" or "812", or undefined for any other text. */
export function numRef(text: string): number | undefined {
  const m = /^#?([1-9]\d{0,14})$/.exec(text.trim());
  return m ? Number(m[1]) : undefined;
}

/** What a write that still names `priority` is told, by the tools' argument check and by the ops: the field is gone from the board. */
export const REMOVED_PRIORITY = "priority: 已去掉，看板不再有优先级；先做什么由架构师定，必须先做的用依赖表达";

export const STATUSES = ["todo", "idle", "wip", "blocked", "paused", "done", "cancelled"] as const;
export const Status = z.enum(STATUSES);
export type Status = z.infer<typeof Status>;

export const LogEntry = z.object({
  at: Time,
  /** The writing project; absent when the source recorded no author. */
  by: z.string().min(1).optional(),
  text: z.string().min(1),
});
export type LogEntry = z.infer<typeof LogEntry>;

/** Stable within an item's ordered steps, independent of a step's position. */
export const StepId = Key.max(40);
export const STEP_STATES = ["done", "doing", "todo", "dropped"] as const;
const StepText = z.string().min(1).refine(text => !!text.trim(), "Provide nonempty text after trimming");
/** Callers describe a step; transition dates belong to the server. */
export const PlanStepInput = z.object({
  id: StepId,
  text: StepText,
  state: z.enum(STEP_STATES),
  waits: StepText.optional(),
  reason: StepText.optional(),
  after: z.array(Key).optional(),
  accept: z.literal(true).optional(),
}).strict().refine(step => step.state !== "dropped" || !!step.reason, { message: "A dropped step needs a reason", path: ["reason"] });
export type PlanStepInput = z.infer<typeof PlanStepInput>;
export const PlanStep = PlanStepInput.safeExtend({
  doneAt: Time.optional(),
  since: Time.optional(),
  droppedAt: Time.optional(),
}).refine(step => step.state !== "done" || !!step.doneAt, { message: "A done step needs doneAt", path: ["doneAt"] })
  .refine(step => step.state !== "doing" || !!step.since, { message: "A doing step needs since", path: ["since"] })
  .refine(step => step.state !== "dropped" || !!step.droppedAt, { message: "A dropped step needs droppedAt", path: ["droppedAt"] });
export type PlanStep = z.infer<typeof PlanStep>;
const uniqueStepIds = (steps: readonly { id: string }[]): boolean => new Set(steps.map(step => step.id)).size === steps.length;

const PlanItemInput = z.object({ item: Key, own: z.boolean(), after: z.array(Key).optional() }).strict();
const PlanCardInput = z.object({ card: Key, after: z.array(Key).optional() }).strict();
export const PlanRowInput = z.union([PlanStepInput, PlanItemInput, PlanCardInput]);
export type PlanRowInput = z.infer<typeof PlanRowInput>;
export const PlanRow = z.union([
  PlanStep,
  PlanItemInput.extend({ id: Key }).refine(row => row.id === row.item, "An item row id is its target key"),
  PlanCardInput.extend({ id: Key }).refine(row => row.id === row.card, "A card row id is its target key"),
]);
export type PlanRow = z.infer<typeof PlanRow>;

/** Both input and stored plans use target keys for reference-row ids. */
export function planRowId(row: PlanRowInput): string { return "item" in row ? row.item : "card" in row ? row.card : row.id; }
function validPlan(rows: readonly PlanRowInput[]): boolean {
  const earlier = new Set<string>();
  for (const row of rows) {
    const id = planRowId(row);
    if (earlier.has(id) || row.after?.some(target => !earlier.has(target))) return false;
    earlier.add(id);
  }
  return true;
}
export const PlanInput = z.array(PlanRowInput).refine(validPlan, "Plan ids must be unique and after must name earlier rows");
export const ItemPlan = z.array(PlanRow).refine(validPlan, "Plan ids must be unique and after must name earlier rows");

/** One goal's latest numbers; measurement dates belong to the server. */
export const ItemTargetInput = z.object({
  id: StepId,
  goal: StepText,
  target: StepText,
  current: StepText,
  baseline: StepText,
}).strict();
export type ItemTargetInput = z.infer<typeof ItemTargetInput>;
export const ItemTarget = ItemTargetInput.extend({ date: Time });
export type ItemTarget = z.infer<typeof ItemTarget>;
export const ItemTargetsInput = z.array(ItemTargetInput).refine(uniqueStepIds, "Target ids must be unique");
export const ItemTargets = z.array(ItemTarget).refine(uniqueStepIds, "Target ids must be unique");

/** A tag's name: 1–12 characters, no whitespace and no comma (ASCII, fullwidth or enumeration comma), so a list of tags reads unambiguously. */
export const TagName = z.string().regex(/^[^\s,，、]{1,12}$/u, "use 1–12 characters without whitespace or commas");
/** One approved tag. `projects` absent: every project may use it; otherwise only the listed ones. */
export const Tag = z.object({
  name: TagName,
  /** One sentence telling agents when to apply the tag. */
  meaning: z.string().min(1).refine(text => !!text.trim(), "Provide nonempty text after trimming"),
  projects: z.array(z.string().min(1)).min(1).refine(p => new Set(p).size === p.length, "Projects must be unique").optional(),
}).strict();
export type Tag = z.infer<typeof Tag>;
/** Whether a vocabulary tag may be used by an item of this project. */
export const tagApplies = (tag: Tag, project: string): boolean => tag.projects === undefined || tag.projects.includes(project);
/** Whether an item of this project must carry a tag: once the vocabulary holds a tag it may use. */
export const tagsRequired = (tags: readonly Tag[] | undefined, project: string): boolean => (tags ?? []).some(tag => tagApplies(tag, project));

/**
 * An item's difficulty, which decides the agent that does it: 1–5. Every item is rated; one without a rating raises the
 * 缺难度 check and is not startable. (The level 「架构师做」, for the architect's own work, no longer exists; old versions of
 * an item may still hold it as `difficulty: architect`, which historical comparison omits, see src/store.ts.)
 */
export const Difficulty = z.number().int().min(1).max(5);
export type Difficulty = z.infer<typeof Difficulty>;
/** The value of the retired level 「架构师做」 in a stored item: no schema accepts it; reading old versions and the owner's unread list know it (src/store.ts, src/rules.ts). */
export const RETIRED_LEVEL = "architect";
/** How agents and the page write a difficulty: 「难度 2」. */
export const difficultyText = (difficulty: Difficulty): string => `难度 ${difficulty}`;

/**
 * One dispatch: an agent session the PM (or the architect) started on an item, recorded in the columns of the dispatch format
 * (docs/design.md section 5 lists them). The fixed options below are that format's own; nothing else is
 * accepted for them.
 */
export const DISPATCH_ROLES = ["工程师", "审查"] as const;
export const DISPATCH_RESULTS = ["一次通过", "返工后通过", "换人", "放弃"] as const;
export const DISPATCH_SIGNALS = ["验收没过", "架构师打回", "做法被否", "长时间没进展", "换模型"] as const;
const Count = z.number().int().nonnegative();
/** US dollars with at most three decimals, so any sum of costs is exact in thousandths (see `milliDollars`). */
export const Cost = z.number().nonnegative().refine(c => Math.abs(c * 1000 - Math.round(c * 1000)) < 1e-6, "Give at most three decimals");
export const milliDollars = (cost: number): number => Math.round(cost * 1000);
export const DispatchUsage = z.object({ input: Count, cacheWrite: Count, cacheRead: Count, output: Count }).strict();
export type DispatchUsage = z.infer<typeof DispatchUsage>;
export const DispatchSignal = z.object({ kind: z.enum(DISPATCH_SIGNALS), note: StepText.optional() }).strict();
export type DispatchSignal = z.infer<typeof DispatchSignal>;
export const DispatchFinish = z.object({
  ended: Time,
  result: z.enum(DISPATCH_RESULTS),
  /** An engineer's reports and kickbacks; a review's rounds. Which of them a finished dispatch carries follows its role. */
  reports: Count.optional(),
  kickbacks: Count.optional(),
  rounds: Count.optional(),
  /** Minutes spent waiting for the owner, the 14900K or a dependency. */
  waited: Count.optional(),
  /** No signal is an empty list. */
  signals: z.array(DispatchSignal).refine(list => new Set(list.map(s => s.kind)).size === list.length, "Name each signal once"),
  usage: DispatchUsage,
  cost: Cost,
  note: StepText.optional(),
}).strict();
export type DispatchFinish = z.infer<typeof DispatchFinish>;
/**
 * What is wrong with the counts a finished dispatch of `role` carries, or undefined when they are right: an engineer
 * carries `reports` and `kickbacks`, a review carries `rounds`, never the other role's. The one place the rule lives:
 * the schema below and the write that ends a dispatch both ask it, the write to word the refusal.
 */
export function dispatchCountProblem(role: (typeof DISPATCH_ROLES)[number], c: { reports?: number | undefined; kickbacks?: number | undefined; rounds?: number | undefined }): string | undefined {
  if (role === "工程师") {
    if (c.reports === undefined || c.kickbacks === undefined) return `${c.reports === undefined ? "reports" : "kickbacks"}: an engineer dispatch ends with reports and kickbacks (how often it stopped to report, how often it was sent back)`;
    return c.rounds === undefined ? undefined : "rounds: only a review dispatch carries rounds; an engineer carries reports and kickbacks";
  }
  if (c.rounds === undefined) return "rounds: a review dispatch ends with rounds (how many review rounds it took: the first review and each re-review count one)";
  return c.reports === undefined && c.kickbacks === undefined ? undefined : `${c.reports === undefined ? "kickbacks" : "reports"}: only an engineer dispatch carries reports and kickbacks; a review carries rounds`;
}
export const Dispatch = z.object({
  /** The dispatched session's full id; unique on the board. */
  agentId: Key,
  /** The dispatched session's name. */
  agent: StepText,
  role: z.enum(DISPATCH_ROLES),
  level: z.number().int().min(1).max(5),
  model: StepText,
  effort: StepText.optional(),
  worktree: StepText.optional(),
  started: Time,
  /** Which rows of the item the session did, in one line. */
  did: StepText.optional(),
  /** The SHA-256 of the credential the session writes with (docs/design.md, section 9): kept from the start until the dispatch ends, when it is removed, which revokes the credential. */
  credential: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Present once the session has ended. */
  finish: DispatchFinish.optional(),
}).strict().superRefine((d, ctx) => {
  // A record edited by hand that breaks the rule is refused with the rule's own words.
  const problem = d.finish && dispatchCountProblem(d.role, d.finish);
  if (problem) ctx.addIssue(problem);
}).refine(d => !d.finish || Date.parse(d.finish.ended) >= Date.parse(d.started), "A dispatch ends no earlier than it started");
export type Dispatch = z.infer<typeof Dispatch>;

/**
 * What the runner (the resident program that runs the engineers' turns) last reported about the work on an item: one report that
 * each new report replaces, kept on the item (docs/design.md, section 5, Runner reports). The states are the ones the runner's
 * turns end in (`ci`, `ask`, `items`, `run`, `ready`, `done`) with `running` for a turn in progress and `exception` for work it has
 * stopped and wants looked at. `since` and `at` are stamped by the server, never given by the reporter.
 */
export const RUNNER_STATES = ["running", "ci", "ask", "items", "run", "ready", "exception", "done"] as const;
export type RunnerState = (typeof RUNNER_STATES)[number];
/** Whom an `ask` waits on. */
export const RUNNER_ASKS = ["owner", "architect"] as const;
/** The most characters of the one-line note a report carries. */
export const RUNNER_NOTE_MAX = 120;
const RunnerNote = z.string().min(1).max(RUNNER_NOTE_MAX).refine(text => !!text.trim() && !/[\r\n]/.test(text), "Give one nonempty line");
/** What a report must say about what the work waits on, by its state: the one place the rule lives, for the schema and the write. */
export function runnerReportProblem(r: { state: RunnerState; to?: string | undefined; cards?: readonly string[] | undefined; items?: readonly string[] | undefined }): string | undefined {
  if (r.state === "ask") {
    if (r.to === undefined) return "to: a report of state ask says whom the work asks, owner or architect";
    if (r.to === "owner" && !r.cards?.length) return "cards: an ask to the owner names the cards the work waits for";
    if (r.to === "architect" && r.cards?.length) return "cards: only an ask to the owner names cards";
  } else if (r.to !== undefined || r.cards !== undefined) return "to, cards: only a report of state ask carries them";
  if (r.state === "items") { if (!r.items?.length) return "items: a report of state items names the items the work waits for"; }
  else if (r.items !== undefined) return "items: only a report of state items carries them";
  return undefined;
}
export const RunnerReport = z.object({
  state: z.enum(RUNNER_STATES),
  /** When the work entered this state; moves when the state or what it waits on changes, not when a report repeats it. */
  since: Time,
  /** The latest report that changed anything. */
  at: Time,
  /** When the work began: given by the reporter on its first report or taken from that report's time, and kept. */
  started: Time,
  to: z.enum(RUNNER_ASKS).optional(),
  cards: z.array(Key).min(1).optional(),
  items: z.array(Key).min(1).optional(),
  note: RunnerNote.optional(),
  /** Rounds run on the work so far, and what they cost in US dollars: cumulative figures the reporter keeps. */
  turns: Count.optional(),
  cost: Cost.optional(),
}).strict().superRefine((r, ctx) => {
  const problem = runnerReportProblem(r);
  if (problem) ctx.addIssue(problem);
}).refine(r => Date.parse(r.started) <= Date.parse(r.since) && Date.parse(r.since) <= Date.parse(r.at), "started, since and at must not run backwards");
export type RunnerReport = z.infer<typeof RunnerReport>;

export const Link =z.object({ label: z.string().min(1), url: z.url() }).strict();
export type Link = z.infer<typeof Link>;

/** What the owner must do. `url`: where the owner does it (a pull request to merge). `chat`: only the owner's word in chat counts. */
export const Ask = z.object({
  text: z.string().min(1),
  url: z.url().optional(),
  chat: z.boolean().optional(),
}).strict();
export type Ask = z.infer<typeof Ask>;

/**
 * Every item stores its project. Ownership and work status are
 * derived from its plan; cancellation alone is stored as a status.
 */
export const Item = z.object({
  num: Num.optional(),
  title: z.string().min(1),
  group: z.string().min(1),
  order: z.number().optional(),
  status: z.literal("cancelled").optional(),
  /** Explicit owner, PM or architect pause; descendants inherit it through ownership. */
  paused: z.object({ reason: StepText, at: Time }).strict().optional(),
  /**
   * Vocabulary tags (Board.tags) applicable to the item's project, unique. Every item needs at least one; optional on
   * read only for data written before tags existed, which the 缺标签 check lists until a session backfills it.
   */
  tags: z.array(TagName).refine(t => new Set(t).size === t.length, "Tags must be unique").optional(),
  /** Set by whoever creates the item or by set_difficulty; absent on a record, and on unrated work, which the 缺难度 check lists when only the rating is missing. */
  difficulty: Difficulty.optional(),
  /** A head and log without a work status. */
  record: z.boolean().optional(),
  head: z.string().optional(),
  log: z.array(LogEntry).default([]),
  plan: ItemPlan.default([]),
  /** Server-owned conversion marker, cleared by a whole-plan rewrite. */
  provisional: z.literal(true).optional(),
  /** One row per goal, with only its latest current value and measurement date. */
  targets: ItemTargets.optional(),
  /** One line of key numbers. */
  data: z.string().min(1).optional(),
  links: z.array(Link).default([]),
  /** The agent sessions started on this item, oldest first; like the log, historical detail the owner is never told is new. */
  dispatches: z.array(Dispatch).refine(list => new Set(list.map(d => d.agentId)).size === list.length, "Dispatch agentIds must be unique").optional(),
  /** The runner's latest report on the work; like the log and the dispatches, historical detail the owner is never told is new. */
  runner: RunnerReport.optional(),
  ask: Ask.optional(),
  created: Time.optional(),
  updated: Time,
  rev: z.number().int().positive(),
}).strict().refine(it => !it.record || it.status === undefined, "A record has no status")
  .refine(it => !it.record || it.paused === undefined, "A record cannot be paused")
  .refine(it => !it.record || it.difficulty === undefined, "A record has no difficulty")
  .refine(it => !it.record || it.runner === undefined, "A record has no runner report")
  .refine(it => {
    const count = it.plan.filter(row => "accept" in row && row.accept).length;
    return it.record ? count === 0 : count >= 1;
  }, "A work item needs at least one acceptance step, placed where its check happens; a record takes none");
export type Item = z.infer<typeof Item>;

/**
 * One choice on a card: `key` is A, B, C… in order for a card written now, `text` its name (a short phrase, empty on a
 * card converted from the old form), `detail` what it does, what it costs and risks, and why it is or is not recommended.
 */
export const Option = z.object({
  key: z.string().min(1),
  text: z.string(),
  detail: z.string().min(1).optional(),
  recommended: z.boolean().optional(),
}).strict().refine(o => o.text !== "" || o.detail !== undefined, "An option needs a name or a detail");
export type Option = z.infer<typeof Option>;

/** A card is open until the owner's pick is recorded (ruled) or it is withdrawn. */
export const DECISION_STATUSES = ["open", "ruled", "withdrawn"] as const;

/**
 * What a card carried before the form it has now: its background, kept word for word on the cards written then. Only
 * the migration writes it; the page shows it folded. The grounds of a card written now stand in its item's head.
 */
export const LegacyCard = z.object({
  background: z.string().min(1),
}).strict();
export type LegacyCard = z.infer<typeof LegacyCard>;

/** How sure the card's author is of the recommended option: a score of 1 to 5 and the reason (and what would overturn it). */
export const Confidence = z.object({ score: z.number().int().min(1).max(5).optional(), reason: z.string() }).strict();
export type Confidence = z.infer<typeof Confidence>;

/**
 * A decision card: one question, its options with their grounds and the confidence in the recommended one. It stands in
 * its item's head on a line of its own; a blocking card (with `blocks`) is also a row of that item's plan. Its item is
 * stored here and its row, when it has one, in that item's plan; write_card writes both together and the 卡和计划对不上
 * check reports them apart.
 */
export const Decision = z.object({
  num: Num.optional(),
  item: Key,
  question: z.string().min(1),
  options: z.array(Option).min(1),
  confidence: Confidence.optional(),
  status: z.enum(DECISION_STATUSES),
  /** One sentence naming the work that stops until the owner rules; present makes the card blocking (src/rules.ts cardBlocking). */
  blocks: z.string().min(1).optional(),
  /** The chosen option's key. Absent on an open or withdrawn card, and on a card the owner answered in words. */
  choice: z.string().min(1).optional(),
  /** The owner's own words when they ruled in chat, quoted by the session that recorded them. */
  ruling: z.string().min(1).optional(),
  /** When the card closed: the owner's send time for a pick made on the page, else the time of the call that closed it. */
  ruledAt: Time.optional(),
  /** Set when the card was withdrawn because its item was cancelled; reopening the item restores the card to open. */
  withdrawnWithItem: z.literal(true).optional(),
  legacy: LegacyCard.optional(),
  /** When the card was written. */
  at: Time.optional(),
  updated: Time,
  rev: z.number().int().positive(),
}).strict();
export type Decision = z.infer<typeof Decision>;

/** A note target: `it:<item key>` or `q:<decision key>`. */
export const Target = z.string().regex(/^(it|q):[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/);

export const NOTE_KINDS = ["comment", "explain", "approve", "choice", "done"] as const;

/** An owner note on an item or card, and the responsible project's reply. Its title is derived from the target. */
export const Note = z.object({
  target: Target,
  kind: z.enum(NOTE_KINDS),
  choice: z.string().min(1).optional(),
  text: z.string(),
  /** Original approve/done action text, captured on first owner edit; not caller-settable. */
  answerText: z.string().optional(),
  at: Time,
  state: z.enum(["draft", "sent", "done"]),
  sentAt: Time.optional(),
  reply: z.string().min(1).optional(),
  repliedAt: Time.optional(),
  repliedBy: z.string().min(1).optional(),
  anchor: z.union([
    z.object({ kind: z.literal("log"), at: Time }).strict(),
    z.object({ kind: z.literal("note"), id: z.string().min(1) }).strict(),
  ]).optional(),
  rev: z.number().int().positive(),
}).strict();
export type Note = z.infer<typeof Note>;

/** The most characters (code points) a message's text may have: its push is one line of at most 200 characters, a prefix of
 * at most 50 and the whole text (src/wake.ts, LINE_LIMIT; docs/design.md, Messages). Longer text is refused, never cut. */
export const MESSAGE_TEXT_LIMIT = 150;
/** A session name as a write records it: 1 to 80 characters without control characters or surrounding spaces. */
const SessionName = z.string().min(1).max(80).regex(/^\S(.*\S)?$/u).refine(s => !/\p{Cc}/u.test(s), "no control characters");

/** A message's id: the time it was sent, to the second, and four random hex digits, so ids sort in the order sent. */
export const MessageId = z.string().regex(/^\d{8}T\d{6}Z-[0-9a-f]{4}$/);
/** A message one agent sends another through the board (docs/design.md, Messages): a doorbell that says which item to read
 * and what is awaited; the content is written on the item. Written once, never changed. */
export const Message = z.object({
  id: MessageId,
  /** The sending session and the project it writes for. */
  from: SessionName,
  project: z.string().min(1),
  /** The receiving session. */
  to: SessionName,
  text: z.string().refine(t => t.trim().length > 0, "a message has text").refine(t => [...t].length <= MESSAGE_TEXT_LIMIT, `at most ${MESSAGE_TEXT_LIMIT} characters`).refine(t => !/\p{Cc}/u.test(t), "one line without control characters"),
  /** The item the message is about, when there is one. */
  item: Key.optional(),
  at: Time,
}).strict();
export type Message = z.infer<typeof Message>;
/** A UTC day, `2026-10-17`: the id and file name of the messages sent on it. */
export const MessageDayId = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** The messages sent on one UTC day, in the order sent: one file a day, so the board's files and git's index grow by one a
 * day however many messages there are (docs/design.md, Messages). Each message is sent on the file's day. */
export const MessageDay = z.object({
  messages: z.array(Message).min(1).refine(m => new Set(m.map(x => x.id)).size === m.length, "Message ids must be unique"),
  rev: z.number().int().positive(),
}).strict();
export type MessageDay = z.infer<typeof MessageDay>;

export const Project = z.object({
  name: z.string().min(1),
  repo: z.string().min(1).optional(),
  /** The branch merges land on when it is not the repository's default branch; the GitHub watch reads its checks. */
  mainline: z.string().regex(/^\S+$/, "a branch name has no whitespace").optional(),
}).strict();
export type Project = z.infer<typeof Project>;

/** The author name of the architect: the project of the agents_config repository, a configured project like any other. */
export const ARCHITECT = "Architect";
/** The session name the architect writes from, the conversation the owner talks to; the architect's pushes are for it (docs/design.md, section 9). */
export const ARCHITECT_SESSION = "架构师";
/** The session name of the turns the runner starts to answer an engineer: the architect's write rights and none of the architect's pushes (docs/design.md, section 9). */
export const ARCHITECT_TURN_SESSION = "架构师轮次";
/** The author name of the PM: a project of its own, with no repository, that holds the PM's records; a configured project like any other. */
export const PM_AUTHOR = "PM";
/** The session name the PM writes from, as author `PM`. */
export const PM_SESSION = "PM";
/** The role names of the architect and the PM, as a credential and the access table name them. */
export const ARCHITECT_ROLE = "架构师";
export const PM_ROLE = "PM";
/** The architect alone, as an error text or a tool description names it (ops `onlyArchitect`, the journal and tag tools). */
export const ARCHITECT_WRITER = `${ARCHITECT} with session ${ARCHITECT_SESSION}`;
/** The PM, as an error text or a tool description names it. */
export const PM_WRITER = `${PM_AUTHOR} with session ${PM_SESSION}`;
/** The writers that do the process, in English: the one definition every such text is built from (ops `onlyProcess`, the tool descriptions, the errors that say who may). */
export const PROCESS_WRITERS = `${PM_WRITER} or ${ARCHITECT_WRITER}`;
type Writer = { author: string; session?: string; access?: { role: string } };
/**
 * Whether a write speaks for the architect: author `Architect` from the session 「架构师」 or 「架构师轮次」 (`isArchitectName`). Only
 * such a write may do what the board reserves for the architect alone (the journal, the tag vocabulary; ops `onlyArchitect`). An
 * engineer who works in the Architect project writes as author `Architect` from another session and is then an ordinary project
 * author. A write over a credential is the architect's when the credential's role is, whatever names it carries (src/credentials.ts);
 * the names of a write without one are not authenticated: that stops misuse, not impersonation. The rights do not carry the pushes:
 * those go by `isArchitectSession` alone.
 */
export const isArchitect = (who: Writer): boolean =>
  who.access ? who.access.role === ARCHITECT_ROLE : who.author === ARCHITECT && isArchitectName(who.session);
/** Whether a write speaks for the PM: author `PM` from the session 「PM」, or a credential of role `PM`, by the same rule. */
export const isPM = (who: Writer): boolean =>
  who.access ? who.access.role === PM_ROLE : who.author === PM_AUTHOR && isPMSession(who.session);
/**
 * Whether a write may do the process: change any project's items, cards and note replies, create and cancel items, set their
 * difficulty, pause, move and retitle them, place projects in the page order (ops `onlyProcess`). The PM does it, and the
 * architect, which keeps every right it had.
 */
export const mayRunProcess = (who: Writer): boolean => isArchitect(who) || isPM(who);
/** Whether a session name is the architect's conversation, ignoring spaces around it: the one that receives the architect's pushes, whose calls answer the PM's stream and whose own writes the architect's timed wake leaves out. */
export const isArchitectSession = (session: string | undefined): boolean => session?.trim() === ARCHITECT_SESSION;
/** Whether a session name is one the architect writes from, ignoring spaces around it: the conversation or the runner's turns. The permission rule and the credential file's checks use it; the pushes use `isArchitectSession`. */
export const isArchitectName = (session: string | undefined): boolean => isArchitectSession(session) || session?.trim() === ARCHITECT_TURN_SESSION;
/** Whether a session name is the PM's, ignoring spaces around it. */
export const isPMSession = (session: string | undefined): boolean => session?.trim() === PM_SESSION;
/** Whether a call answers the pushes (docs/design.md, section 8): from the PM's or the architect's session, or over a credential of the PM's role or of the architect's role under the architect's session; the runner's turns (`ARCHITECT_TURN_SESSION`) never do. */
export const answersPushes = (call: { role: string; session: string } | { session?: string }): boolean =>
  "role" in call ? call.role === PM_ROLE || (call.role === ARCHITECT_ROLE && isArchitectSession(call.session)) : isPMSession(call.session) || isArchitectSession(call.session);
/** Whether a call is the PM's: from its session, or over a credential of its role. A tool result carries no pushes to it (docs/design.md, The wake streams). */
export const isPMCall = (call: { role: string } | { session?: string }): boolean =>
  "role" in call ? call.role === PM_ROLE : isPMSession(call.session);
/** The retired coordinator identity: every write under this author is refused; its historical authors stay as written. */
export const RETIRED_COORDINATOR = "总管";

/**
 * Who may write what (docs/design.md, section 9). A credential names a role; the role names, for each part of the board a write
 * can change, how far the writer may go. This table is the one place that is defined: `ops.run` asks it for every write.
 * The roles of the long-lived credentials are the architect, the PM, the observer and the resource agent; the roles of a dispatch
 * credential are the dispatch's own (an engineer or a review).
 */
export const ROLES = [ARCHITECT_ROLE, PM_ROLE, "观察者", "资源管理", ...DISPATCH_ROLES] as const;
export type Role = (typeof ROLES)[number];
/** The roles a long-lived credential (kept in a file outside the data directory) can name. */
export const LONG_LIVED_ROLES = [ARCHITECT_ROLE, PM_ROLE, "观察者", "资源管理"] as const;
/** One part for each kind of write; a write names the parts it changes. */
export const PARTS = [
  "project.create", "project.update", "tag-vocab", "journal",
  "item.create", "item.title", "item.head", "item.plan", "item.log", "item.targets", "item.links", "item.data", "item.order",
  "item.record", "item.tags", "item.difficulty", "item.move", "item.move-project", "item.cancel", "item.pause", "item.ask", "item.merge-row", "item.runner",
  "card.write", "card.rule", "note.reply", "note.close", "term", "dispatch.start", "dispatch.finish", "message.send",
] as const;
export type Part = (typeof PARTS)[number];
/** `board`: any item of any project. `subtree`: the items the credential names and everything they own, and the writer's own project's glossary. `below`: the same without the items the credential names: the writer has been handed those and does not rewrite the hand-off. `own`: no item at all, only a document of the writer's own (a message it sends). */
export type Scope = "board" | "subtree" | "below" | "own";
/** What the board reserves for the PM and the architect (ops `onlyProcess`), starting a dispatch and the runner's report on an item: the process. The engineer has two of them: `item.create` inside its subtree and `item.difficulty` below its root. */
const PROCESS: readonly Part[] = ["item.create", "item.title", "item.difficulty", "item.cancel", "item.pause", "item.move-project", "item.runner", "dispatch.start", "dispatch.finish"];
/** What only the architect does beyond the process (ops `onlyArchitect`): the journal, the tag vocabulary, creating a project. No role has the merge row. */
const ARCHITECT_ONLY: readonly Part[] = ["project.create", "tag-vocab", "journal", "item.merge-row"];
const RESERVED: readonly Part[] = [...PROCESS, ...ARCHITECT_ONLY];
const partsAt = (scope: Scope, parts: readonly Part[]): Partial<Record<Part, Scope>> => Object.fromEntries(parts.map(p => [p, scope])) as Partial<Record<Part, Scope>>;
export const ACCESS: Readonly<Record<Role, Readonly<Partial<Record<Part, Scope>>>>> = {
  // Every role sends messages: a message changes no item, so its scope is the writer's own.
  [ARCHITECT_ROLE]: { ...partsAt("board", PARTS.filter(p => p !== "item.merge-row" && p !== "message.send")), "message.send": "own" },
  [PM_ROLE]: { ...partsAt("board", PARTS.filter(p => !ARCHITECT_ONLY.includes(p) && p !== "message.send")), "message.send": "own" },
  "观察者": { ...partsAt("board", PARTS.filter(p => !RESERVED.includes(p) && p !== "message.send")), "message.send": "own" },
  // The resource agent writes the log of any item and keeps its own records (the 14900K queue): the items its credential names. It closes the dispatches of the sessions it is asked about (docs/design.md, section 9).
  "资源管理": { "item.log": "board", "dispatch.finish": "board", "message.send": "own", ...partsAt("subtree", ["item.head", "item.plan"]) },
  // An engineer writes the progress of its own work, makes the sub-items of its tree and rates and tags them, and replies to the notes the PM forwards. The 改动 section lives in the body today, so it may write the whole body; this narrows to that section when bodies are stored by section (item mcp-sections).
  "工程师": { ...partsAt("subtree", ["item.log", "item.plan", "item.targets", "item.head", "item.links", "item.create", "item.tags", "card.write", "note.reply", "term"]), "item.difficulty": "below", "message.send": "own" },
  "审查": { ...partsAt("subtree", ["item.log"]), "message.send": "own" },
};
/** What a credential grants the ops: the writer's role and project, and the items its subtree starts from. */
export interface Access { role: Role; project: string; roots: readonly string[] }
/** Whether the role may write items of any project (otherwise only its own project's, and then only inside its subtree). */
export const writesAnyProject = (role: Role): boolean => Object.values(ACCESS[role]).includes("board");

/** A glossary's id and file name: the name of the project that keeps it, usable as one file name. */
export const GlossaryId = z.string().regex(/^[^./\\\0\r\n][^/\\\0\r\n]{0,199}$/);

/** A word a project coined, explained in plain words for a reader outside the project. */
export const Term = z.object({
  /** One line without surrounding spaces; the page links its occurrences as written. */
  term: z.string().regex(/^\S(.*\S)?$/),
  definition: z.string().min(1),
  updated: Time,
  /** The writing project. */
  by: z.string().min(1),
}).strict();
export type Term = z.infer<typeof Term>;

/** One project's glossary. Only that project writes it. */
export const Glossary = z.object({
  terms: z.array(Term).refine(t => new Set(t.map(t => t.term)).size === t.length, "Terms must be unique"),
  rev: z.number().int().positive(),
}).strict();
export type Glossary = z.infer<typeof Glossary>;

export const Board = z.object({
  projects: z.array(Project).default([]).refine(p => new Set(p.map(p => p.name)).size === p.length, "Project names must be unique"),
  /** The approved tag vocabulary; only the architect changes it, on the owner's decision card. */
  tags: z.array(Tag).refine(t => new Set(t.map(t => t.name)).size === t.length, "Tag names must be unique").optional(),
  title: z.string().min(1),
  eyebrow: z.string().optional(),
  goal: z.string().optional(),
}).strict();
export type Board = z.infer<typeof Board>;
/** The approved tags; a board written before tags existed has none. */
export const boardTags = (board: Pick<Board, "tags">): Tag[] => board.tags ?? [];

/** A board document whose changes can be read independently. */
export const ReadDocument = z.string().regex(/^(item|decision|note):[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/);
export const CommitId = z.string().regex(/^[0-9a-f]{40}$/);

/** The reading cursor and exceptions read ahead of it. */
export const OwnerState = z.object({
  cursor: CommitId.optional(),
  readMarks: z.record(ReadDocument, CommitId).optional(),
}).strict();
export type OwnerState = z.infer<typeof OwnerState>;

/** The whole board in memory. Keys of each record are document ids. */
export interface Snapshot {
  board: Board;
  items: Record<string, Item>;
  decisions: Record<string, Decision>;
  notes: Record<string, Note>;
  /** Keyed by project name. */
  glossaries: Record<string, Glossary>;
  /** The messages between agents, by the UTC day they were sent; the store always fills it, snapshots built elsewhere
   * (tests, history) may leave it out. */
  messages?: Record<string, MessageDay>;
  owner: OwnerState;
  /** The commit this snapshot reflects. */
  head: string;
  /** Derived from content-write history; never stored as a board document. */
  activity?: {
    writes: string[];
    items: Record<string, string>;
    /** Historical effective pauses; inherited pauses stop each descendant's clock. */
    pauses?: Record<string, Array<{ start: string; end?: string }>>;
    /** The session that last wrote to each item and when, from the commits' `Session:` trailers. An observation of
     * who wrote, never an assignment of work to a session. */
    sessions?: Record<string, { name: string; at: string }>;
    /** Per session name, the last two distinct items it wrote to, newest first, from the same trailers. The page's
     * agent list reads it (src/agents.ts). Like `sessions`, an observation of writes, not an assignment of work. */
    agents?: Record<string, AgentTouch[]>;
  };
}
/** One item a session wrote to and when. */
export interface AgentTouch { item: string; at: string }
/** How many items an agent keeps in the index and the list. */
export const AGENT_TOUCHES = 2;
