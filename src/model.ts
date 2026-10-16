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

export const STATUSES = ["todo", "wip", "blocked", "paused", "done", "cancelled"] as const;
export const Status = z.enum(STATUSES);
export type Status = z.infer<typeof Status>;

export const PRIORITIES = ["P0", "P1", "P2"] as const;
export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;

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
 * An item's difficulty, which decides the agent that does it: 1–5, or "architect" for an item the architect does itself
 * (a discussion, a walkthrough, a design), which is rated but never dispatched. Only the architect sets it.
 */
export const Difficulty = z.union([z.number().int().min(1).max(5), z.literal("architect")]);
export type Difficulty = z.infer<typeof Difficulty>;
/** How agents and the page write a difficulty: 「难度 2」, or 「架构师做」. */
export const difficultyText = (difficulty: Difficulty): string => difficulty === "architect" ? "架构师做" : `难度 ${difficulty}`;
/** Whether an item with this difficulty can be handed to an agent: rated 1–5, not the architect's own. */
export const dispatchable = (difficulty: Difficulty | undefined): boolean => typeof difficulty === "number";

/**
 * One dispatch: an agent session the architect started on an item, recorded in the columns of the dispatch format the
 * architect keeps (docs/design.md section 5 lists them). The fixed options below are that format's own; nothing else is
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

export const Link = z.object({ label: z.string().min(1), url: z.url() }).strict();
export type Link = z.infer<typeof Link>;

/** What the owner must do. `url`: where the owner does it (a pull request to merge). `chat`: only the owner's word in chat counts. */
export const Ask = z.object({
  text: z.string().min(1),
  url: z.url().optional(),
  chat: z.boolean().optional(),
}).strict();
export type Ask = z.infer<typeof Ask>;

/**
 * Every item stores its project. Ownership, work status and priority are
 * derived from its plan; cancellation alone is stored as a status.
 */
export const Item = z.object({
  num: Num.optional(),
  title: z.string().min(1),
  group: z.string().min(1),
  order: z.number().optional(),
  status: z.literal("cancelled").optional(),
  /** Explicit owner/architect pause; descendants inherit it through ownership. */
  paused: z.object({ reason: StepText, at: Time }).strict().optional(),
  /**
   * Vocabulary tags (Board.tags) applicable to the item's project, unique. Every item needs at least one; optional on
   * read only for data written before tags existed, which the 缺标签 check lists until a session backfills it.
   */
  tags: z.array(TagName).refine(t => new Set(t).size === t.length, "Tags must be unique").optional(),
  /** Set only by the architect (set_difficulty); absent on a record, and on unrated work, which the 缺难度 check lists. */
  difficulty: Difficulty.optional(),
  /** A head and log without a work status. */
  record: z.boolean().optional(),
  priority: Priority.optional(),
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
  ask: Ask.optional(),
  created: Time.optional(),
  updated: Time,
  rev: z.number().int().positive(),
}).strict().refine(it => !it.record || it.status === undefined, "A record has no status")
  .refine(it => !it.record || it.paused === undefined, "A record cannot be paused")
  .refine(it => !it.record || it.difficulty === undefined, "A record has no difficulty")
  .refine(it => {
    const count = it.plan.filter(row => "accept" in row && row.accept).length;
    return it.record ? count === 0 : count >= 1;
  }, "A work item needs at least one acceptance step, placed where its check happens; a record takes none");
export type Item = z.infer<typeof Item>;

export const Option = z.object({
  key: z.string().min(1),
  text: z.string().min(1),
  recommended: z.boolean().optional(),
}).strict();
export type Option = z.infer<typeof Option>;

export const DECISION_STATUSES = ["open", "ruled", "withtree", "elsewhere"] as const;

/** A decision card. Its place on the board is `item` alone; an item's cards are derived. */
export const Decision = z.object({
  num: Num.optional(),
  item: Key,
  question: z.string().min(1),
  background: z.string().min(1),
  options: z.array(Option).min(1),
  confidence: z.object({ score: z.number().int().min(1).max(5).optional(), reason: z.string() }).strict().optional(),
  status: z.enum(DECISION_STATUSES),
  /** One sentence naming the work that stops until the owner rules; present makes the card blocking (src/rules.ts cardBlocking). */
  blocks: z.string().min(1).optional(),
  /** The chosen option's key, when the ruling picked one. */
  choice: z.string().min(1).optional(),
  ruling: z.string().min(1).optional(),
  ruledAt: Time.optional(),
  order: z.number().optional(),
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

export const Project = z.object({
  name: z.string().min(1),
  repo: z.string().min(1).optional(),
  /** The branch merges land on when it is not the repository's default branch; the GitHub watch reads its checks. */
  mainline: z.string().regex(/^\S+$/, "a branch name has no whitespace").optional(),
}).strict();
export type Project = z.infer<typeof Project>;

/** The architect's author name, a configured project like any other. */
export const ARCHITECT = "Architect";
/** The session name the architect writes from; the wake stream also takes any call carrying it as a receipt (docs/design.md, section 8). */
export const ARCHITECT_SESSION = "架构师";
/**
 * Whether a write speaks for the architect: author `Architect` from the session 「架构师」. Only such a write may change any
 * project's items, cards and note replies, and do what the board reserves for the architect (ops `onlyArchitect`). An
 * engineer who works in the Architect project writes as author `Architect` from another session and is then an ordinary
 * project author. The session name is not authenticated: this stops misuse, not impersonation.
 */
export const isArchitect = (who: { author: string; session?: string }): boolean => who.author === ARCHITECT && isArchitectSession(who.session);
/** Whether a session name is the architect's, ignoring spaces around it: the one comparison the permission rule and the wake stream's receipt share. */
export const isArchitectSession = (session: string | undefined): boolean => session?.trim() === ARCHITECT_SESSION;
/** The retired coordinator identity: every write under this author is refused; its historical authors stay as written. */
export const RETIRED_COORDINATOR = "总管";

/**
 * Who may write what (docs/design.md, section 9). A credential names a role; the role names, for each part of the board a write
 * can change, how far the writer may go. This table is the one place that is defined: `ops.run` asks it for every write.
 * The roles of the long-lived credentials are the architect, the observer and the resource agent; the roles of a dispatch
 * credential are the dispatch's own (an engineer or a review).
 */
export const ROLES = ["架构师", "观察者", "资源管理", ...DISPATCH_ROLES] as const;
export type Role = (typeof ROLES)[number];
/** The roles a long-lived credential (kept in a file outside the data directory) can name. */
export const LONG_LIVED_ROLES = ["架构师", "观察者", "资源管理"] as const;
/** One part for each kind of write; a write names the parts it changes. */
export const PARTS = [
  "project.create", "project.update", "tag-vocab", "journal",
  "item.create", "item.title", "item.head", "item.plan", "item.log", "item.targets", "item.links", "item.data", "item.priority", "item.order",
  "item.record", "item.tags", "item.difficulty", "item.move", "item.move-project", "item.cancel", "item.pause", "item.ask", "item.merge-row",
  "card.write", "card.rule", "note.reply", "note.close", "term", "dispatch.start", "dispatch.finish",
] as const;
export type Part = (typeof PARTS)[number];
/** `board`: any item of any project. `subtree`: the items the credential names and everything they own, and the writer's own project's glossary. */
export type Scope = "board" | "subtree";
/** What only the architect does: the writes the board has reserved for it since it had an identity (ops `onlyArchitect`), and starting a dispatch. */
const RESERVED: readonly Part[] = ["project.create", "tag-vocab", "journal", "item.create", "item.title", "item.difficulty", "item.cancel", "item.pause", "item.move-project", "item.merge-row", "dispatch.start", "dispatch.finish"];
const partsAt = (scope: Scope, parts: readonly Part[]): Partial<Record<Part, Scope>> => Object.fromEntries(parts.map(p => [p, scope])) as Partial<Record<Part, Scope>>;
export const ACCESS: Readonly<Record<Role, Readonly<Partial<Record<Part, Scope>>>>> = {
  "架构师": partsAt("board", PARTS.filter(p => p !== "item.merge-row")),
  "观察者": partsAt("board", PARTS.filter(p => !RESERVED.includes(p))),
  // The resource agent writes the log of any item and keeps its own records (the 14900K queue, the Actions usage): the items its credential names. It closes the dispatches of the sessions it is asked about (docs/design.md, section 9).
  "资源管理": { "item.log": "board", "dispatch.finish": "board", ...partsAt("subtree", ["item.head", "item.plan"]) },
  // An engineer writes the progress of its own work. The 改动 section lives in the body today, so it may write the whole body; this narrows to that section when bodies are stored by section (item mcp-sections).
  "工程师": partsAt("subtree", ["item.log", "item.plan", "item.targets", "item.head", "item.links", "card.write", "term"]),
  "审查": partsAt("subtree", ["item.log"]),
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
