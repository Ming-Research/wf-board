// The board's documents and their schemas. Every document the store reads or
// writes passes through these schemas; docs/design.md section 5 gives the
// reasons for the shapes.

import { z } from "zod";

/** ISO 8601 UTC time as the server writes it, e.g. 2026-10-11T06:15:40Z. */
export const Time = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);

/** An item or decision key, which is also its file name. */
export const Key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/);

export const STATUSES = ["todo", "wip", "blocked", "done", "cancelled"] as const;
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

/** A dependency names an item or a decision card, with one sentence on what the dependent item needs from it. */
export const Dep = z.union([
  z.object({ id: Key, why: z.string() }).strict(),
  z.object({ card: Key, why: z.string() }).strict(),
]);
export type Dep = z.infer<typeof Dep>;

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
 * An item. An item without `parent` is an area: a line of work with its
 * project heading (`group`); responsibility comes from Board.projects. `status` belongs to leaves; a parent's is derived
 * from its sub-items. `priority` belongs to roots, items no open item depends on; every other item's is derived from the
 * open items depending on it (src/rules.ts).
 */
export const Item = z.object({
  title: z.string().min(1),
  parent: Key.optional(),
  request: z.object({ by: z.string().min(1), at: Time }).strict().optional(),
  group: z.string().min(1).optional(),
  order: z.number().optional(),
  status: Status.optional(),
  priority: Priority.optional(),
  head: z.string().optional(),
  log: z.array(LogEntry).default([]),
  /** One line of key numbers. */
  data: z.string().min(1).optional(),
  deps: z.array(Dep).default([]),
  links: z.array(Link).default([]),
  ask: Ask.optional(),
  created: Time.optional(),
  updated: Time,
  rev: z.number().int().positive(),
}).strict();
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
  item: Key,
  question: z.string().min(1),
  background: z.string().min(1),
  options: z.array(Option).min(1),
  confidence: z.object({ score: z.number().int().min(1).max(5).optional(), reason: z.string() }).strict().optional(),
  status: z.enum(DECISION_STATUSES),
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
}).strict();
export type Project = z.infer<typeof Project>;

export const Board = z.object({
  projects: z.array(Project).default([]).refine(p => new Set(p.map(p => p.name)).size === p.length, "Project names must be unique"),
  title: z.string().min(1),
  eyebrow: z.string().optional(),
  goal: z.string().optional(),
}).strict();
export type Board = z.infer<typeof Board>;

/** A board document whose changes can be read independently. */
export const ReadDocument = z.string().regex(/^(item|decision|note):[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/);
export const CommitId = z.string().regex(/^[0-9a-f]{40}$/);

/** The reading cursor, exceptions read ahead of it, and archived items. */
export const OwnerState = z.object({
  cursor: CommitId.optional(),
  readMarks: z.record(ReadDocument, CommitId).optional(),
  archived: z.record(Key, Time).default({}),
}).strict();
export type OwnerState = z.infer<typeof OwnerState>;

/** The whole board in memory. Keys of each record are document ids. */
export interface Snapshot {
  board: Board;
  items: Record<string, Item>;
  decisions: Record<string, Decision>;
  notes: Record<string, Note>;
  owner: OwnerState;
  /** The commit this snapshot reflects. */
  head: string;
}
