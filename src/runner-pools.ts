// The runner's pools of engineer slots, as its heartbeat reports them (`report_heartbeat`, argument `pools`): for each pool the
// slots, the slots taken and how long the queue has had nothing to start for it. Kept in the daemon's memory only and sent to the
// page as the event `pools`; the board tells the owner once when a pool has had a free slot and nothing to start for an hour.
// docs/design.md, section 8, "The runner's heartbeat", gives the reasons for each rule.

import { spanText } from "./whole-view.ts";

/** How long a pool may have a free slot and nothing in the queue to start before the owner is told. A starting value: it comes from the six hours of 10-19 and was not measured. */
export const IDLE_TELL_MS = 60 * 60_000;
/** The page reads a report older than this as stale: the runner beats at least once a minute, so three missed beats say it is not telling. */
export const POOLS_FRESH_MS = 3 * 60_000;
/** The most pools one report holds (the runner has two) and the longest key and label. */
export const POOLS_MAX = 8, POOL_TEXT_MAX = 20;

/** One pool as the runner reports it. `running` slots are taken of `slots`; `dryForSeconds` is how long the queue has had nothing to start for the pool, absent when it has. */
export interface PoolReport { pool: string; label: string; slots: number; running: number; dryForSeconds?: number }

/** The last report and when the board received it (ISO): the runner sends durations and the board counts forward from the arrival, so the runner's clock decides nothing. */
export interface PoolsEntry { at: string; pools: PoolReport[] }

/** Free slots of a pool, never below none. */
export const freeSlots = (p: Pick<PoolReport, "slots" | "running">): number => Math.max(0, p.slots - p.running);

/** How long the pool has had nothing to start at `now` (ms): the runner's figure plus the time since the report arrived; none when it has something or no slot is free. */
export function dryMs(entry: PoolsEntry, p: PoolReport, now: number): number | undefined {
  return p.dryForSeconds === undefined || freeSlots(p) === 0 ? undefined : p.dryForSeconds * 1000 + Math.max(0, now - Date.parse(entry.at));
}

/** Checks a report: a list of at most POOLS_MAX pools with distinct keys, whole numbers and short texts. Throws a sentence naming the field. */
export function checkedPools(value: unknown): PoolReport[] {
  if (!Array.isArray(value)) throw new Error("pools: give a list of pools");
  if (value.length > POOLS_MAX) throw new Error(`pools: at most ${POOLS_MAX} pools`);
  const keys = new Set<string>();
  return value.map((raw, i) => {
    const at = `pools.${i}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${at}: give an object with pool, label, slots and running`);
    const extra = Object.keys(raw).filter(k => !["pool", "label", "slots", "running", "dryForSeconds"].includes(k));
    if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; a pool has pool, label, slots, running and dryForSeconds`);
    const p = raw as Record<string, unknown>;
    const text = (field: string): string => {
      const v = p[field];
      if (typeof v !== "string" || !v.trim() || [...v].length > POOL_TEXT_MAX) throw new Error(`${at}.${field}: give text of 1 to ${POOL_TEXT_MAX} characters`);
      return v.trim();
    };
    const whole = (field: string): number => {
      const v = p[field];
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error(`${at}.${field}: give a whole number, 0 or more`);
      return v;
    };
    const pool = text("pool"), label = text("label"), slots = whole("slots"), running = whole("running");
    if (keys.has(pool)) throw new Error(`${at}.pool: ${pool} is given twice`);
    keys.add(pool);
    return { pool, label, slots, running, ...(p.dryForSeconds === undefined ? {} : { dryForSeconds: whole("dryForSeconds") }) };
  });
}

export interface RunnerPoolsOptions {
  /** Tells the owner (the daemon passes `wake.tell`): a title and a message. */
  tell: (title: string, message: string) => void;
  now?: () => number;
  limitMs?: number;
}

/**
 * The pools of the last heartbeat that carried them, and the owner's notice for a pool that has stood idle too long. A pool is idle
 * when it has a free slot and the queue has had nothing to start for it for `limitMs`. The owner is told once for each stretch of idleness
 * of a pool; the stretch ends when a report finds the pool full or the queue has something to start, and a later one is told again.
 * Memory only: after a restart the board knows nothing until the next heartbeat, and a pool still idle then is told again.
 */
export class RunnerPools {
  private readonly tell: RunnerPoolsOptions["tell"];
  private readonly now: () => number;
  private readonly limitMs: number;
  private entry: PoolsEntry | undefined;
  /** The pools told about in their running stretch of idleness. */
  private readonly told = new Set<string>();
  private readonly listeners = new Set<(entry: PoolsEntry) => void>();

  constructor(options: RunnerPoolsOptions) {
    this.tell = options.tell;
    this.now = options.now ?? Date.now;
    this.limitMs = options.limitMs ?? IDLE_TELL_MS;
  }

  /** The last report, or none until the runner has sent one. */
  get(): PoolsEntry | undefined { return this.entry; }

  /** Keeps a report (already checked) and tells the owner of each pool that has become idle too long. */
  put(pools: PoolReport[]): PoolsEntry {
    const at = new Date(this.now()).toISOString();
    const entry: PoolsEntry = { at, pools };
    this.entry = entry;
    const idle = new Set<string>();
    for (const p of pools) {
      const dry = dryMs(entry, p, this.now());
      if (dry !== undefined && dry >= this.limitMs) idle.add(p.pool);
    }
    for (const pool of this.told) if (!idle.has(pool)) this.told.delete(pool);
    for (const p of pools) {
      if (!idle.has(p.pool) || this.told.has(p.pool)) continue;
      this.told.add(p.pool);
      const dry = dryMs(entry, p, this.now())!;
      console.warn(`runner pools: ${p.label} has ${freeSlots(p)} free slots and nothing to start for ${Math.round(dry / 60_000)} minutes; told the owner`);
      try { this.tell(`名额空着 · ${p.label}`, `${p.label}空着 ${freeSlots(p)} 个，派活队列里没有能开工的活已 ${spanText(dry)}`); }
      catch (error) { console.error("runner pools: the owner notice failed", error); }
    }
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  /** Calls `listener` with every report kept from now on; the returned function stops it. */
  onChange(listener: (entry: PoolsEntry) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
