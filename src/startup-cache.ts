import { z } from "zod";
import type { Snapshot } from "./model.ts";

/** The format of the startup cache (docs/design.md, the activity index). Change it whenever the cache holds
 * something else or the replay derives it differently: a cache of another version is refused, and the next start
 * scans the whole history once and writes a new one. */
export const STARTUP_CACHE_VERSION = 1;

type Activity = NonNullable<Snapshot["activity"]>;

/** Every field of the activity index, each required (an absent optional field is null). Declared against the index's
 * own type, so a field added to the index fails to compile here until the cache stores it, and a cache that lacks a
 * field, or has one this code does not know, is refused instead of read with an empty field. */
const CachedActivity: z.ZodType<{ [K in keyof Activity]-?: Activity[K] | null }> = z.object({
  writes: z.array(z.string()),
  items: z.record(z.string(), z.string()),
  pauses: z.record(z.string(), z.array(z.object({ start: z.string(), end: z.string().optional() }).strict())).nullable(),
  sessions: z.record(z.string(), z.object({ name: z.string(), at: z.string() }).strict()).nullable(),
}).strict();

/** What the pause replay needs of an item (store.ts pauseProjection): project, record, owned targets, pause. */
const CachedPauseItem = z.object({
  group: z.string(),
  record: z.boolean(),
  plan: z.array(z.object({ id: z.string(), item: z.string(), own: z.literal(true) }).strict()),
  updated: z.string(),
  paused: z.object({ at: z.string(), reason: z.string() }).strict().optional(),
}).strict();
export type CachedPauseItem = z.infer<typeof CachedPauseItem>;

/** Everything a start derives from the history, as of one commit: the activity index, where each card last was, and
 * the item projections the pause replay continues from (null while no commit up to `head` set a pause). The store
 * writes it in git's own metadata directory; it is never board data, and a start that cannot trust it scans the
 * history instead. */
export const StartupCache = z.object({
  version: z.literal(STARTUP_CACHE_VERSION),
  head: z.string().regex(/^[0-9a-f]{40}$/),
  activity: CachedActivity,
  cardItems: z.record(z.string(), z.string()),
  pause: z.object({ items: z.record(z.string(), CachedPauseItem) }).strict().nullable(),
}).strict();
export type StartupCache = z.infer<typeof StartupCache>;
