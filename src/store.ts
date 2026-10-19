import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { Board, Decision, Glossary, GlossaryId, Item, Key, MessageDay, MessageDayId, Note, Numbers, OwnerState, RETIRED_LEVEL } from "./model.ts";
import type { Snapshot, StateStart } from "./model.ts";
import * as Legacy from "./legacy-model.ts";
import { convertPlans, removeArchives, PLAN_CONVERSION_MESSAGE, updatePlanSummary } from "./convert-plans.ts";
import type { PlanConversionReport } from "./convert-plans.ts";
import { verifyPlans, verifyArchiveRemoval } from "./verify-plans.ts";
import { RETIRED_LEVEL_REFUSAL, clearedItem } from "./migrate-architect-level.ts";
import { RETIRED_PRIORITY_REFUSAL, CLEAR_PRIORITY_MESSAGE, isPriorityClearing } from "./migrate-priority.ts";
import type { ClearedPriority } from "./migrate-priority.ts";
import { rules, DerivedCache, withSorted } from "./rules.ts";
import { touchAgent } from "./agents.ts";
import type { ActivityDelta } from "./rules.ts";
import { StartupCache, STARTUP_CACHE_VERSION } from "./startup-cache.ts";
import { startOfReport, withStateStart } from "./timeline.ts";
import type { CachedPauseItem } from "./startup-cache.ts";
import { stopwatch } from "./log.ts";
import { netGit, netGitReason } from "./net-git.ts";
import type { NetGitResult } from "./net-git.ts";
import type { StartupStep } from "./log.ts";
import { Budget, BudgetError, STARTUP_LIMITS, REQUEST_LIMITS, allowRange, currentBudget, withBudget } from "./budget.ts";
import { ReadCache } from "./read-cache.ts";
import { currentTrace, withTrace } from "./write-trace.ts";

/** What `Store.open` takes. `maintenance`: `every` is the commits between maintenance steps (a test passes a small one), `log`
 * receives the line of each step (the service log by default). */
export interface OpenOptions {
  init?: boolean; board?: z.input<typeof Board>; planConversionHead?: string; clearArchitectLevel?: boolean; clearPriority?: boolean;
  startup?: StartupStep; cacheDelayMs?: number; requireBudget?: boolean;
  maintenance?: { every?: number; log?: (line: string) => void };
}
export type DocKind = "item" | "decision" | "note" | "glossary" | "message";
export interface Put { kind: DocKind; id: string; doc: unknown; expectRev: number | null }
export interface Del { kind: DocKind; id: string; expectRev: number }
/** `numberExisting` (the one-time numbering only) issues numbers to unnumbered existing documents, in put order. `rewrite` (the one-time
 * clearing of the retired priority only) writes each put although it changes nothing in memory: the documents were read without a field their files still hold. */
export interface Txn { author: string; message: string; session?: string; puts?: Put[]; deletes?: Del[]; board?: z.input<typeof Board>; planConversionReport?: PlanConversionReport; numberExisting?: true; rewrite?: true }
export interface ChangedDoc { kind: DocKind | "board" | "owner"; id: string; before: unknown | null; after: unknown | null }
/** `activity` is how the commit changed Snapshot["activity"]; rules' applyActivityDelta applies it. */
export interface Change { commit: string; at: string; author: string; message: string; changed: ChangedDoc[]; activity: ActivityDelta }
/** `session`: the writing session's name from the commit's `Session:` trailer; `message` excludes the trailer. */
export interface CommitInfo { commit: string; parents: string[]; at: string; author: string; message: string; files: string[]; session?: string }
/** The commit trailer that records which session made a write (docs/design.md, history). */
const SESSION_TRAILER = /\n\nSession: ([^\n]+)$/;

type Doc = Item | Decision | Note | Glossary | MessageDay;
const schemas: Record<DocKind, z.ZodType<Doc>> = { item: Item, decision: Decision, note: Note, glossary: Glossary, message: MessageDay };
const collections = { item: "items", decision: "decisions", note: "notes", glossary: "glossaries", message: "messages" } as const;
/** A glossary is named by its project, which may be Chinese (总管); a day's messages by the day; other documents by their key. */
const ids: Record<DocKind, z.ZodType<string>> = { item: Key, decision: Key, note: Key, glossary: GlossaryId, message: MessageDayId };
/** The documents of one kind in a snapshot; a snapshot built outside the store may have no messages. */
const docsOf = (s: Snapshot, kind: DocKind): Record<string, Doc> => (s[collections[kind]] ?? {}) as Record<string, Doc>;
const run = promisify(execFile);
/** git never starts maintenance of its own: the board runs it as a task of its write queue (docs/design.md, Maintenance). A git
 * process that repacked by itself would write the data repository outside the queue, and the repack git starts after a large
 * commit deletes empty object directories while the next git add creates a temporary file in one (item e2e-git-tmp-flake). */
const NO_GIT_MAINTENANCE = ["-c", "gc.auto=0", "-c", "maintenance.auto=false"];
/** The git command an argument list runs (`commit`), after the `-c name=value` pairs that come first. */
function gitCommand(args: string[]): string {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i] ?? "";
}
/** Commits between two maintenance steps. The size of a step follows this number alone: on a hosted runner a step of 100 commits
 * took 240 to 299 ms at the median and 753 ms at most, against the 3 s a write may wait (item data-repo-gc-timing-study). */
export const MAINTENANCE_EVERY = 100;
/** About 4 loose objects remain from each commit on the live board (4.14 measured): this turns the loose objects an open finds
 * into the commits that wait for a step. */
const LOOSE_OBJECTS_PER_COMMIT = 4;
/** With more packs than this before a step, the step also merges the small packs, in batches of `MERGE_BATCH`. */
const MERGE_ABOVE_PACKS = 8;
const MERGE_BATCH = "16m";
/** The persisted short-number counter (model.ts Numbers). */
const numbersPath = "numbers.yaml";
export const NUMBERING_MESSAGE = "Number existing items and cards";
/** How the message of a commit that is the runner's report on an item begins (`report_state <id> <state>`, src/ops.ts): the history replay reads the state starts from these commits only. */
export const REPORT_MESSAGE = "report_state ";
/** Commit message of the one-time move of decision cards into their items' plans; like numbering, it is not work on the items. */
export const CARD_MIGRATION_MESSAGE = "Migrate decision cards into item plans";
/** Commit message of the one-time deletion of the retired notices; activity skips that commit. */
export const RETIRE_NOTICES_MESSAGE = "Delete the notices: the 要你知道 list was removed, and the notices are in git history";
/** Start of the message of the one-time commit that cleared the retired level 「架构师做」; the message goes on with the item count. */
const CLEAR_LEVEL_MESSAGE = "clear_architect_level";

// History grows for the lifetime of the daemon. What is read from it is cached, bounded by an estimate of the heap it
// holds and not by how many entries there are: a parsed document takes about 16 times the bytes of its file (a board of
// 32.7 MB of files is 510 MB of heap once parsed, measured in CI). The count bounds are for reads still pending, whose
// size is not known yet. Normalization is needed at format boundaries, not for every old commit, so one whole old board
// is kept.
const MB = 1024 * 1024;
const HEAP_PER_FILE_BYTE = 16;
const historicalDocumentBytes = 64 * MB;
const historicalDocumentEntries = 4096;
const historicalDiffBytes = 16 * MB;
const historicalDiffEntries = 2048;
const comparedSnapshotLimit = 1;
/** The startup cache is written at most this often, by the first commit after a write (a start that scanned writes it at once). */
const CACHE_WRITE_DELAY_MS = 2 * 60_000;
const CACHE_FILE = "wf-board-startup-cache.json";

function pauseMetadata(value: unknown): Item["paused"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pause = value as Record<string, unknown>;
  return typeof pause.at === "string" && Number.isFinite(Date.parse(pause.at))
    ? { at: pause.at, reason: typeof pause.reason === "string" ? pause.reason : "" } : undefined;
}

/** Pause indexing also sees legacy transaction inputs and historical schemas.
 * Only these metadata fields participate; current write validation stays strict. */
function pauseProjection(raw: unknown, id: string, fallbackAt: string): Item | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const plan: Item["plan"] = [];
  for (const value of Array.isArray(fields.plan) ? fields.plan : []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (row.own === true && typeof row.item === "string") plan.push({ id: typeof row.id === "string" ? row.id : row.item, item: row.item, own: true });
  }
  const it: Item = { title: id, group: typeof fields.group === "string" ? fields.group : `\0${id}`, record: fields.record === true,
    plan, log: [], links: [], rev: 1, updated: typeof fields.updated === "string" && Number.isFinite(Date.parse(fields.updated)) ? fields.updated : fallbackAt };
  const paused = pauseMetadata(fields.paused);
  if (paused) it.paused = paused;
  return it;
}

/** A historical document as read: parsed, with the size of its file for the cache to weigh. */
interface ReadDocument { doc: unknown | null; size: number }

export class ConflictError extends Error {
  readonly kind: DocKind;
  readonly id: string;
  readonly expectedRev: number | null;
  readonly currentRev: number | null;
  readonly currentDoc: Doc | null;
  constructor(kind: DocKind, id: string, expectedRev: number | null, currentDoc: Doc | null) {
    super(`${kind} ${id}: expected rev ${expectedRev}, current rev ${currentDoc?.rev ?? null}`);
    this.name = "ConflictError";
    this.kind = kind;
    this.id = id;
    this.expectedRev = expectedRev;
    this.currentRev = currentDoc?.rev ?? null;
    this.currentDoc = currentDoc === null ? null : structuredClone(currentDoc);
  }
}

export interface InvalidDocument { path: string; issues: readonly z.core.$ZodIssue[] | string }
export class ValidationError extends Error {
  readonly invalid: InvalidDocument[];
  constructor(invalid: InvalidDocument[]) {
    super(invalid.map(({ path, issues }) => `${path}: ${typeof issues === "string" ? issues : issues.map(i => `${i.path.join(".") || "document"}: ${i.message}`).join("; ")}`).join("\n"));
    this.name = "ValidationError";
    this.invalid = invalid;
  }
}

function validated<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError([{ path, issues: result.error.issues }]);
  // Optional undefined properties represent absent fields, not YAML nulls.
  function omitUndefined(value: unknown): void {
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined) delete (value as Record<string, unknown>)[key];
        else omitUndefined(child);
      }
    }
  }
  omitUndefined(result.data);
  return result.data;
}

/** Fields that past versions hold and the current schema does not accept, by where they sat. Whole-board historical comparison
 * omits exactly these before parsing, in every shape, so an old version holding them still normalizes: show() and diff()
 * return them as written, any field not listed here still refuses the old version, and current reads and writes stay
 * strict. Item `priority` is retired too: the migration of src/migrate-priority.ts clears it from the current files, and old
 * versions keep it. Data-repository migration commits removed item `short` ("Drop area short names at the owner's request"), item
 * `agent` ("Drop item agents: responsibility moves to each project's configuration") and project `agents` ("Projects
 * are identified by themselves: drop session names (agents)"); the removed inbox left the item `request` marker. */
const retiredFields = { item: ["short", "agent", "request", "priority"], project: ["agents"] } as const;
function without(value: unknown, keys: readonly string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !keys.some(key => Object.hasOwn(value, key))) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
/** The level 「架构师做」 no longer exists: an old version of an item, or a file the migration has not cleared, holds it as `difficulty: architect`. */
const holdsRetiredLevel = (doc: unknown): boolean => !!doc && typeof doc === "object" && !Array.isArray(doc) && (doc as { difficulty?: unknown }).difficulty === RETIRED_LEVEL;
/** The item document without that value, the one rating historical comparison omits; any other value of the field still refuses. */
function withoutRetiredLevel(doc: unknown): unknown {
  if (!holdsRetiredLevel(doc)) return doc;
  const { difficulty: _retired, ...rest } = doc as Record<string, unknown>;
  return rest;
}
/** The value of the retired item `priority` a current file holds, undefined when it holds none. */
const heldPriority = (doc: unknown): unknown => !doc || typeof doc !== "object" || Array.isArray(doc) ? undefined : (doc as { priority?: unknown }).priority;
/** An item as the owner compares it: without the fields the board no longer has, so a version that holds one (a priority) and the
 * migration that cleared it differ in nothing the owner reads. Other kinds come back as they are. */
const omitRetired = (kind: DocKind, doc: unknown): unknown => kind === "item" ? without(doc, retiredFields.item) : doc;
function withoutRetiredFields(path: string, doc: unknown): unknown {
  if (path.startsWith("items/")) return without(withoutRetiredLevel(doc), retiredFields.item);
  if (path !== "board.yaml" || !doc || typeof doc !== "object" || Array.isArray(doc)) return doc;
  const { projects } = doc as { projects?: unknown };
  if (!Array.isArray(projects) || !projects.some(project => without(project, retiredFields.project) !== project)) return doc;
  return { ...doc, projects: projects.map(project => without(project, retiredFields.project)) };
}

/** Old records can also carry retired fields; record alone does not identify a format. */
function retiredItemShape(doc: unknown): boolean {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  const fields = doc as Record<string, unknown>;
  return ["parent", "deps", "steps"].some(key => Object.hasOwn(fields, key))
    || ["todo", "wip", "blocked", "done"].includes(String(fields.status))
    || (fields.record !== true && !Object.hasOwn(fields, "plan"));
}

/** A board project written by the one-time import carries `migrated`. */
function retiredBoardShape(doc: unknown): boolean {
  const projects = (doc as { projects?: unknown } | undefined)?.projects;
  return Array.isArray(projects) && projects.some(project => project && typeof project === "object" && Object.hasOwn(project, "migrated"));
}

/** Owner state of the retired formats still holds `archived`. */
function retiredOwnerShape(doc: unknown): boolean {
  return !!doc && typeof doc === "object" && Object.hasOwn(doc, "archived");
}

/** Whether a parsed data file has a shape only a retired format wrote (the conversion in `open` is for these). */
function retiredShape(path: string, doc: unknown): boolean {
  if (path === "board.yaml") return retiredBoardShape(doc);
  if (path === "state/owner.yaml") return retiredOwnerShape(doc);
  return path.startsWith("items/") && retiredItemShape(doc);
}

function docPath(kind: DocKind, id: string): string {
  validated(ids[kind], id, `${kind} id ${id}`);
  return `${collections[kind]}/${id}.yaml`;
}

function yaml(value: unknown): string {
  return stringify(value, { version: "1.2", schema: "core", lineWidth: 0, blockQuote: "literal" });
}

function atomicWrite(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, yaml(value), { flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Deep freeze. A frozen object is skipped: everything this module freezes is
 * frozen whole, so a frozen object's children are frozen already. */
function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** A published snapshot is shared, never copied: its documents are frozen when
 * they enter it, and the snapshot and its collections are frozen here. A write
 * builds the next snapshot by copying only the collections it changes. */
function sealed(state: Snapshot): Snapshot {
  for (const collection of [state.items, state.decisions, state.notes, state.glossaries, state.messages ?? {}]) Object.freeze(collection);
  frozen(state.board); frozen(state.owner);
  if (state.activity) frozen(state.activity);
  return Object.freeze(state);
}

/**
 * One long-lived `git cat-file --batch` that reads `<rev>:<path>` objects, and
 * the commit a write has just made, in order, so history queries cost no
 * process per document and a write none for its commit's time. The process keeps
 * Node alive only while a read is pending, and restarts after a failure.
 */
class BlobReader {
  private readonly dir: string;
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private waiting: Array<{ resolve: (o: { id: string; type: string; body: Buffer } | null) => void; reject: (e: Error) => void }> = [];

  constructor(dir: string) { this.dir = dir; }

  /** The blob `spec` names, or null when it names none. */
  async read(spec: string): Promise<Buffer | null> {
    const object = await this.object(spec);
    return object?.type === "blob" ? object.body : null;
  }

  /** The object `spec` names, with its id and type, or null when it names none. */
  object(spec: string): Promise<{ id: string; type: string; body: Buffer } | null> {
    if (/[\n\r\0]/.test(spec)) return Promise.reject(new Error(`invalid object name: ${JSON.stringify(spec)}`));
    const child = this.start();
    if (!this.waiting.length) this.hold(child, true);
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      child.stdin.write(spec + "\n");
    });
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn("git", ["cat-file", "--batch"], { cwd: this.dir });
    this.hold(child, false);
    child.stdout.on("data", (chunk: Buffer) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain(); });
    const fail = (error: Error) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.buffer = Buffer.alloc(0);
      for (const w of this.waiting.splice(0)) w.reject(error);
    };
    child.on("error", fail);
    child.on("exit", code => fail(new Error(`git cat-file exited with ${code}`)));
    child.stdin.on("error", fail);
    this.child = child;
    return child;
  }

  private hold(child: ChildProcessWithoutNullStreams, on: boolean): void {
    const handles = [child, child.stdin, child.stdout, child.stderr] as unknown as Array<{ ref?: () => void; unref?: () => void }>;
    for (const h of handles) (on ? h.ref : h.unref)?.call(h);
  }

  private drain(): void {
    if (this.child && !this.waiting.length) return;
    while (this.waiting.length) {
      const nl = this.buffer.indexOf(0x0a);
      if (nl === -1) return;
      const header = this.buffer.subarray(0, nl).toString("utf8");
      const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
      if (!m) { this.buffer = this.buffer.subarray(nl + 1); this.waiting.shift()!.resolve(null); if (!this.waiting.length && this.child) this.hold(this.child, false); continue; }
      const size = Number(m[3]);
      if (this.buffer.length < nl + 1 + size + 1) return;
      const body = this.buffer.subarray(nl + 1, nl + 1 + size);
      this.buffer = this.buffer.subarray(nl + 1 + size + 1);
      this.waiting.shift()!.resolve({ id: m[1]!, type: m[2]!, body: Buffer.from(body) });
    }
    if (!this.waiting.length && this.child) this.hold(this.child, false);
  }
}

/** The daemon is the sole writer. All git mutations share the transaction queue. */
export class Store {
  readonly dir: string;
  private state: Snapshot;
  private committedOwner: OwnerState;
  private ownerInHead = false;
  private ownerFileExists = false;
  private deferredOwnerWrite = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** Tasks in the queue that have not ended, and the kind of the one joined last: what a write that joins is told it waits behind. */
  private waiting = 0;
  private tail = "";
  private listeners = new Set<(change: Change) => void>();
  private writing = false;
  private readonly blobs: BlobReader;
  /** Last known placement also resolves later changes to notes on a deleted card. */
  private readonly cardItems = new Map<string, string>();
  /** Whether some commit up to the head set a pause: until then the pause replay has nothing to track. */
  private pauseStarted = false;
  /** The next short number to issue; numbers.yaml holds it once any number was issued. */
  private nextNum = 1;
  private numbersInHead = false;
  private startupCachePath?: string;
  /** Set once the activity index is derived: from then on a commit schedules a cache write. */
  private activityLoaded = false;
  private cacheTimer?: NodeJS.Timeout;
  private cacheWrite: Promise<void> = Promise.resolve();
  private cacheDelayMs = CACHE_WRITE_DELAY_MS;
  /** Whether a read of history outside any budget fails (`open`'s `requireBudget`). */
  private requireBudget = false;
  /** Reports the time of each startup step; a no-op after `open` unless the caller gave `startup`. */
  private lap: (step: string, detail?: string) => void = () => {};
  /** Commits since the last maintenance step; `open` starts it from the loose objects the repository holds (docs/design.md, Maintenance). */
  private pending = 0;
  private maintenanceEvery = MAINTENANCE_EVERY;
  private maintenanceLog: (line: string) => void = line => console.info(line);
  /** The step that is queued or running, so a commit queues no second one. */
  private maintenanceTask?: Promise<void>;
  private maintenanceStopped = false;
  /** Rules shared by every reader of a snapshot, and the activity index kept across writes. */
  readonly derived = new DerivedCache();

  private constructor(dir: string, state: Snapshot) {
    this.dir = dir;
    this.blobs = new BlobReader(dir);
    this.state = state;
    this.committedOwner = frozen(structuredClone(state.owner));
  }

  private async git(args: string[], author?: string): Promise<string> {
    const slug = author?.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
    // The call this runs for, if a write is waiting on it: the time before the command is its own step, the command another.
    const trace = currentTrace();
    trace?.lap("other");
    try {
      const result = await run("git", [...NO_GIT_MAINTENANCE, ...args], {
        cwd: this.dir, maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_COMMITTER_NAME: "wf-board", GIT_COMMITTER_EMAIL: "wf-board@wf-board.invalid",
          ...(author ? { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${slug}@wf-board.invalid` } : {}) },
      });
      return result.stdout;
    } finally {
      trace?.lap(`git ${gitCommand(args)}`);
    }
  }

  /** The budget of the request this read of history serves. With `requireBudget`, a read that runs under none fails here. */
  private budget(): Budget | undefined {
    const budget = currentBudget();
    if (!budget && this.requireBudget) throw new BudgetError("none", "A read of the board's history ran under no budget; open one with withBudget (src/budget.ts)");
    return budget;
  }

  /** A git command that reads history (log, diff, ls-tree): its output is charged to the request's budget. The commands a
   * write runs (add, commit, rev-parse, status) go through `git` and are not. */
  private async gitRead(args: string[]): Promise<string> {
    const budget = this.budget();
    const output = await this.git(args);
    budget?.readBytes(output.length);
    return output;
  }

  /** `startup` is told how long each step of the start took (docs/design.md, Running). The start reads history under a
   * budget of its own (`STARTUP_LIMITS`). `requireBudget`: from then on a read of history that runs under no budget fails
   * (docs/design.md, section 4, Request budgets); the daemon sets it, and tests leave it off unless they test the budget. */
  static open(dir: string, opts: OpenOptions = {}): Promise<Store> {
    return withBudget(new Budget("start", STARTUP_LIMITS), () => Store.start(dir, opts));
  }

  private static async start(dir: string, opts: OpenOptions): Promise<Store> {
    dir = resolve(dir);
    const lap = stopwatch(opts.startup);
    let entries: string[];
    try { entries = await readdir(dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !opts.init) throw error;
      entries = [];
    }
    // init starts a board in an empty directory, or in an existing git repository that has
    // no board yet (the data repository may already hold the import's provenance files).
    if (opts.init && !entries.includes("board.yaml")) {
      if (entries.length && !entries.includes(".git")) throw new Error(`${dir} is neither empty nor a git repository; refusing to start a board there`);
      const board = validated(Board, opts.board, "board.yaml");
      await mkdir(dir, { recursive: true });
      const initial: Snapshot = { board, items: {}, decisions: {}, notes: {}, glossaries: {}, messages: {}, owner: {}, head: "" };
      const store = new Store(dir, initial);
      if (!entries.includes(".git")) await store.git(["init", "-b", "main"]);
      for (const sub of ["items", "decisions", "notes", "state"]) mkdirSync(join(dir, sub), { recursive: true });
      atomicWrite(join(dir, "board.yaml"), board);
      await store.git(["add", "--", "board.yaml"]);
      await store.git(["-c", "commit.gpgsign=false", "commit", "--author", "wf-board <wf-board@wf-board.invalid>", "-m", "Initialize board"], "wf-board");
    }
    const invalid: InvalidDocument[] = [];
    // Whether any document has a shape only a retired format wrote.
    let retired = false;
    // The items whose files hold the retired level 「架构师做」: read without it, and cleared in one commit below.
    const clearing: string[] = [];
    // The items whose files hold the retired priority: read without it, and cleared in one commit below.
    const clearingPriority: Array<{ id: string; priority: unknown }> = [];
    async function load<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
      try {
        const raw = parse(await readFile(join(dir, path), "utf8"), { version: "1.2", schema: "core" });
        if (retiredShape(path, raw)) retired = true;
        if (path.startsWith("items/") && holdsRetiredLevel(raw)) {
          if (!opts.clearArchitectLevel) throw new ValidationError([{ path, issues: RETIRED_LEVEL_REFUSAL }]);
          clearing.push(path.slice("items/".length, -".yaml".length));
        }
        if (path.startsWith("items/") && heldPriority(raw) !== undefined) {
          if (!opts.clearPriority) throw new ValidationError([{ path, issues: RETIRED_PRIORITY_REFUSAL }]);
          clearingPriority.push({ id: path.slice("items/".length, -".yaml".length), priority: heldPriority(raw) });
        }
        return validated(schema, path.startsWith("items/") ? without(withoutRetiredLevel(raw), ["priority"]) : raw, path);
      } catch (error) {
        invalid.push(...(error instanceof ValidationError ? error.invalid : [{ path, issues: String(error) }]));
        return undefined;
      }
    }
    const board = await load("board.yaml", Board);
    const docs: Pick<Snapshot, "items" | "decisions" | "notes" | "glossaries"> & { messages: Record<string, MessageDay> } = { items: {}, decisions: {}, notes: {}, glossaries: {}, messages: {} };
    for (const kind of ["item", "decision", "note", "glossary", "message"] as const) {
      let files: string[] = [];
      try { files = await readdir(join(dir, collections[kind])); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      for (const file of files.sort()) {
        const path = `${collections[kind]}/${file}`;
        if (!file.endsWith(".yaml")) {
          invalid.push({ path, issues: "Expected a .yaml document" });
          continue;
        }
        const key = ids[kind].safeParse(file.slice(0, -5));
        if (!key.success) invalid.push({ path, issues: key.error.issues });
        const doc = await load(path, schemas[kind]);
        if (doc && key.success) (docs[collections[kind]] as Record<string, Doc>)[key.data] = doc;
      }
    }
    let owner: OwnerState = {};
    let ownerFileExists = false;
    try {
      await stat(join(dir, "state/owner.yaml"));
      ownerFileExists = true;
      owner = await load("state/owner.yaml", OwnerState) ?? owner;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let numbers: Numbers | undefined;
    try {
      await stat(join(dir, numbersPath));
      numbers = await load(numbersPath, Numbers);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    lap("read documents", `${Object.values(docs).reduce((n, collection) => n + Object.keys(collection).length, 0)} documents`);
    // A board of the retired formats is told apart, and converted, from the raw documents readPlanData reads; only a
    // board that looks retired or does not load pays for that second read.
    if ((retired || invalid.length) && entries.includes("board.yaml")) {
      const raw = await readPlanData(dir).finally(() => lap("read documents again", retired ? "a document has a retired format's shape" : "a document did not load"));
      if (raw.legacy || raw.hasArchives) {
        await Store.convertRetired(dir, raw, opts.planConversionHead);
        return Store.start(dir, { startup: opts.startup, cacheDelayMs: opts.cacheDelayMs, requireBudget: opts.requireBudget, maintenance: opts.maintenance });
      }
    }
    if (invalid.length || !board) throw new ValidationError(invalid);
    checkNumbers(docs, numbers);
    for (const collection of Object.values(docs)) for (const doc of Object.values(collection)) frozen(doc);
    const store = new Store(dir, { board, ...docs, owner, head: "" });
    store.lap = lap;
    store.requireBudget = opts.requireBudget ?? false;
    if (opts.cacheDelayMs !== undefined) store.cacheDelayMs = opts.cacheDelayMs;
    if (opts.maintenance?.every !== undefined) {
      if (!Number.isInteger(opts.maintenance.every) || opts.maintenance.every < 1) throw new Error("maintenance.every must be a positive integer");
      store.maintenanceEvery = opts.maintenance.every;
    }
    if (opts.maintenance?.log) store.maintenanceLog = opts.maintenance.log;
    if (numbers) { store.nextNum = numbers.next; store.numbersInHead = true; }
    // Refuse to adopt staged/uncommitted board edits as the committed snapshot.
    const dirty = await store.git(["status", "--porcelain", "--", "board.yaml", numbersPath, "items", "decisions", "notes", "glossaries", "messages"]);
    if (dirty.trim()) throw new Error(`Board working tree has uncommitted changes: ${dirty.trim()}`);
    store.state = sealed({ ...store.state, head: (await store.git(["rev-parse", "HEAD"])).trim() });
    // Owner state can legitimately be newer than HEAD after a daemon restart.
    const persistedOwner = await store.readAt("state/owner.yaml", store.state.head);
    store.committedOwner = persistedOwner === null ? {} : validated(OwnerState, persistedOwner, "state/owner.yaml");
    store.ownerInHead = persistedOwner !== null;
    store.ownerFileExists = ownerFileExists;
    lap("check board", "numbers, git status, HEAD, owner state");
    // The commits waiting for a maintenance step, told by the loose objects they left; the commits below add to it.
    store.pending = Math.floor((await store.repoCounts()).loose / LOOSE_OBJECTS_PER_COMMIT);
    await store.numberExisting();
    lap("number documents");
    if (clearing.length) {
      await store.clearArchitectLevel(clearing);
      lap("clear the retired level", `${clearing.length} items`);
    }
    if (clearingPriority.length) {
      await store.clearPriority(clearingPriority);
      lap("clear the retired priority", `${clearingPriority.length} items`);
    }
    await store.loadActivity();
    // A backlog is maintained before the daemon listens, so no request waits for it.
    const backlog = store.pending, step = store.queueMaintenance();
    if (step) await step;
    lap("maintenance", step ? `one step for a backlog of ${backlog} commits` : `a backlog of ${backlog} commits, below ${store.maintenanceEvery}`);
    return store;
  }

  /** Convert a board of the retired plan formats in one commit, once the owner approved the dry run for exactly this head. */
  private static async convertRetired(dir: string, raw: Awaited<ReturnType<typeof readPlanData>>, planConversionHead: string | undefined): Promise<void> {
    if (!planConversionHead) throw new Error("Legacy item plans require an owner-approved dry run; set WF_BOARD_PLAN_CONVERSION_HEAD to its sourceHead");
    if (planConversionHead !== raw.snapshot.head) throw new Error(`Approved plan conversion head ${planConversionHead} differs from current ${raw.snapshot.head}`);
    const source = raw.snapshot as Legacy.Snapshot;
    const at = new Date().toISOString();
    const result = raw.legacy ? convertPlans(source, {at}) : removeArchives(raw.snapshot as Snapshot,{at,planConversionAt:raw.planConversionAt});
    result.report.errors.push(...(raw.legacy ? verifyPlans(source,result) : verifyArchiveRemoval(raw.snapshot as Snapshot,result,raw.planConversionAt)));
    updatePlanSummary(result.report,true);
    if (result.report.errors.length) throw new Error(`Plan conversion refused:\n${result.report.errors.join("\n")}`);
    const migration = new Store(dir, source as unknown as Snapshot);
    const committedOwner = await migration.readAt("state/owner.yaml", source.head);
    migration.committedOwner = committedOwner === null ? {} : validated(Legacy.OwnerState, committedOwner, "state/owner.yaml");
    migration.ownerInHead = committedOwner !== null;
    migration.ownerFileExists = await stat(join(dir,"state/owner.yaml")).then(()=>true).catch(error=>{if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;});
    const originalOwner = structuredClone(source.owner), ownerPath = join(dir,"state/owner.yaml");
    const ownerBytes = await readFile(ownerPath).catch(error=>{if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;});
    migration.state = { ...migration.state, owner: structuredClone(result.snapshot.owner) };
    try {
      await migration.commit({ author: "总管", message: PLAN_CONVERSION_MESSAGE, board: result.snapshot.board,
        puts: Object.entries(result.snapshot.items).map(([id, doc]) => ({ kind: "item", id, doc, expectRev: source.items[id]!.rev })),
        planConversionReport: result.report });
    } catch(error) {
      // Ordinary commits save pending owner reads on rollback. A failed
      // migration must additionally restore the original owner sidefile.
      migration.state = { ...migration.state, owner: originalOwner };
      if(ownerBytes === undefined)rmSync(ownerPath,{force:true});else writeFileSync(ownerPath,ownerBytes);
      throw error;
    }
  }

  /** Give every unnumbered item and card a short number, oldest first, in one commit. On a board written before
   * numbers existed this numbers everything once; afterwards every document already has one and nothing happens.
   * Only `num` (and the revision) changes on each document. */
  private async numberExisting(): Promise<void> {
    const pending: Array<{ kind: "item" | "decision"; id: string; at: string; doc: Item | Decision }> = [];
    for (const [id, doc] of Object.entries(this.state.items)) if (doc.num === undefined) pending.push({ kind: "item", id, at: doc.created ?? doc.updated, doc });
    for (const [id, doc] of Object.entries(this.state.decisions)) if (doc.num === undefined) pending.push({ kind: "decision", id, at: doc.at ?? doc.updated, doc });
    if (!pending.length) return;
    pending.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || (a.kind === b.kind ? 0 : a.kind === "item" ? -1 : 1));
    await this.commit({ author: "wf-board", message: NUMBERING_MESSAGE, numberExisting: true,
      puts: pending.map(({ kind, id, doc }) => ({ kind, id, doc, expectRev: doc.rev })) });
  }

  /** The items cleared of the retired level 「架构师做」 by this start (src/migrate-architect-level.ts); none when the data held none. */
  clearedArchitectLevel: readonly string[] = [];

  /** Clear the retired level from the items that held it, in one commit: each item is unrated and logs the change. */
  private async clearArchitectLevel(ids: string[]): Promise<void> {
    const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    await this.commit({ author: "wf-board", message: `${CLEAR_LEVEL_MESSAGE} ${ids.length} items`,
      puts: ids.map(id => { const doc = this.state.items[id]!; return { kind: "item" as const, id, doc: clearedItem(doc, at), expectRev: doc.rev }; }) });
    this.clearedArchitectLevel = ids;
  }

  /** The items cleared of the retired priority by this start (src/migrate-priority.ts), with the value each held; none when the data held none. */
  clearedPriority: readonly ClearedPriority[] = [];

  /** Clear the retired priority from the items that held it, in one commit. The documents in memory were read without it, so the
   * commit rewrites their files as they are: no `updated`, no log line (the value stays in git history and in the report). */
  private async clearPriority(held: ReadonlyArray<{ id: string; priority: unknown }>): Promise<void> {
    await this.commit({ author: "wf-board", message: `${CLEAR_PRIORITY_MESSAGE} ${held.length} items`, rewrite: true,
      puts: held.map(({ id }) => { const doc = this.state.items[id]!; return { kind: "item" as const, id, doc, expectRev: doc.rev }; }) });
    this.clearedPriority = held.map(({ id, priority }) => ({ id, group: this.state.items[id]!.group, priority: String(priority) }));
  }

  /** Activity is a derived index of the existing history, including replaced and deleted documents. A start continues
   * from the startup cache when it can be trusted, replaying only the commits after the commit the cache is of; with no
   * usable cache it replays the whole history (the scan) and writes the cache at once. */
  private async loadActivity(): Promise<void> {
    const cache = await this.readStartupCache();
    if (cache) this.lap("read startup cache", `of ${cache.head.slice(0, 12)}`);
    const commits = (await this.log(cache ? { since: cache.head } : {})).reverse();
    allowRange(commits.length);
    this.lap("read git log", `${commits.length} commits${cache ? " after the cache" : ""}`);
    const activity: NonNullable<Snapshot["activity"]> = cache
      ? { writes: cache.activity.writes, items: cache.activity.items, ...(cache.activity.pauses ? { pauses: cache.activity.pauses } : {}), ...(cache.activity.sessions ? { sessions: cache.activity.sessions } : {}), ...(cache.activity.agents ? { agents: cache.activity.agents } : {}), ...(cache.activity.states ? { states: cache.activity.states } : {}) }
      : { writes: [], items: {} };
    this.cardItems.clear();
    for (const [card, item] of Object.entries(cache?.cardItems ?? {})) this.cardItems.set(card, item);
    for (const commit of commits) {
      // Numbering is bookkeeping, not work on the items: it starts no active time and resets no clock. So is clearing the retired priority.
      if (commit.message === NUMBERING_MESSAGE || commit.message === RETIRE_NOTICES_MESSAGE || commit.message === CARD_MIGRATION_MESSAGE || isPriorityClearing(commit.message)) continue;
      const files = commit.files.filter(file => this.contentPath(file));
      if (!files.length) continue;
      activity.writes.push(commit.at);
      const touched = new Set<string>();
      const cardItems = new Map<string, string>();
      for (const file of files) {
        const item = /^items\/(.+)\.yaml$/.exec(file);
        if (item) { touched.add(item[1]!); continue; }
        if (!/^(decisions|notes)\/.+\.yaml$/.test(file)) continue;
        for (const revision of [commit.parents[0], commit.commit]) {
          if (!revision) continue;
          const doc = await this.readAt(file, revision);
          if (!doc || typeof doc !== "object") continue;
          const fields = doc as Record<string, unknown>;
          if (file.startsWith("decisions/") && typeof fields.item === "string") {
            touched.add(fields.item);
            cardItems.set(file.slice("decisions/".length, -5), fields.item);
          }
          if (file.startsWith("notes/") && typeof fields.target === "string") {
            if (fields.target.startsWith("it:")) touched.add(fields.target.slice(3));
            else if (fields.target.startsWith("q:")) {
              const card = await this.readAt(docPath("decision", fields.target.slice(2)), revision);
              const owner = card && typeof card === "object" && typeof (card as Record<string, unknown>).item === "string"
                ? (card as { item: string }).item : this.cardItems.get(fields.target.slice(2));
              if (owner) touched.add(owner);
            }
          }
        }
      }
      this.noteActivity(activity, commit.at, touched);
      if (commit.session) { this.noteSessions(activity, commit.at, commit.session, touched); this.noteAgent(activity, commit.at, commit.session, touched); }
      for (const [id, item] of cardItems) this.cardItems.set(id, item);
      // The runner's reports are the commits whose message is `report_state <id> <state>`: only they are read for the state starts.
      if (commit.message.startsWith(REPORT_MESSAGE)) for (const id of touched) {
        const doc = await this.readAt(docPath("item", id), commit.commit), start = startOfReport(doc && typeof doc === "object" ? (doc as Record<string, unknown>).runner : undefined);
        if (start) this.noteState(activity, id, start);
      }
    }
    this.lap("replay activity", `${commits.length} commits`);
    await this.loadPauses(activity, commits, cache ? cache.pause?.items ?? null : null, cache ? `${cache.head}..${this.state.head}` : this.state.head);
    activity.writes.sort();
    this.state = sealed({ ...this.state, activity });
    this.activityLoaded = true;
    this.lap("replay pauses");
    // A scan is the slow path: write what it found at once, so the next start does not scan. A start that only
    // replayed commits leaves the write to the timer, which keeps it quick.
    if (!cache) await this.saveStartupCache();
    else if (commits.length) this.scheduleCacheWrite();
    this.lap("write startup cache", cache ? (commits.length ? "left to the timer" : "up to date") : undefined);
  }

  /** The startup cache when it can be trusted, else null with the reason reported as a step. A cache is trusted when it
   * parses to exactly the current format, is of a commit the head descends from, and agrees with the documents on
   * whether any pause was ever set. */
  private async readStartupCache(): Promise<StartupCache | null> {
    const distrust = (why: string): null => { this.lap("startup cache refused", why); return null; };
    this.startupCachePath ??= resolve(this.dir, (await this.git(["rev-parse", "--git-path", CACHE_FILE])).trim());
    let text: string;
    try { text = await readFile(this.startupCachePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return distrust("no startup cache file");
      console.warn("Cannot read startup cache; scanning the history", String(error));
      return distrust("startup cache unreadable");
    }
    let cache: StartupCache;
    try { cache = StartupCache.parse(JSON.parse(text)); }
    catch (error) {
      console.warn("Startup cache is not of the current format; scanning the history", error instanceof z.ZodError ? error.issues[0]?.message : String(error));
      return distrust("startup cache malformed");
    }
    if (!await this.inHistory(cache.head)) return distrust("startup cache is not of an ancestor of the head");
    // Of the head itself, a cache without pauses contradicts the documents; of an older commit it may be right.
    if (!cache.pause && cache.head === this.state.head && Object.values(this.state.items).some(it => it.paused)) return distrust("startup cache has no pause history but items are paused");
    return cache;
  }

  /** The cache of the current state (call it where the state, the activity index and the card placements agree: after
   * a commit or after the history was read). */
  private startupCacheContents(): StartupCache {
    const activity = this.state.activity ?? { writes: [], items: {} };
    const items = Object.entries(this.state.items).flatMap(([id, it]): Array<[string, CachedPauseItem]> => {
      const projected = pauseProjection(it, id, it.updated);
      return projected ? [[id, { group: projected.group, record: projected.record === true, plan: projected.plan as CachedPauseItem["plan"], updated: projected.updated, ...(projected.paused ? { paused: projected.paused } : {}) }]] : [];
    });
    return {
      version: STARTUP_CACHE_VERSION, head: this.state.head,
      activity: { writes: activity.writes, items: activity.items, pauses: activity.pauses ?? null, sessions: activity.sessions ?? null, agents: activity.agents ?? null, states: activity.states ?? null },
      cardItems: Object.fromEntries(this.cardItems),
      pause: this.pauseStarted ? { items: Object.fromEntries(items) } : null,
    };
  }

  /** Write the startup cache of the current state, atomically; a failure only warns, and the next start scans. The
   * daemon calls it after a scan and from the write timer, never at shutdown. */
  async saveStartupCache(): Promise<void> {
    const contents = this.startupCacheContents();
    const write = this.cacheWrite.then(async () => {
      try {
        this.startupCachePath ??= resolve(this.dir, (await this.git(["rev-parse", "--git-path", CACHE_FILE])).trim());
        const temp = `${this.startupCachePath}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, JSON.stringify(contents), { flag: "wx" });
          await rename(temp, this.startupCachePath);
        } finally {
          await rm(temp, { force: true });
        }
      } catch (error) { console.warn("Cannot save startup cache; the next start will scan the history", String(error)); }
    });
    this.cacheWrite = write;
    return write;
  }

  private scheduleCacheWrite(): void {
    if (!this.activityLoaded || this.cacheTimer) return;
    this.cacheTimer = setTimeout(() => { this.cacheTimer = undefined; void this.saveStartupCache(); }, this.cacheDelayMs);
    this.cacheTimer.unref();
  }

  /** Pause history starts at the first native paused field, not at the board's oldest legacy snapshot. Read each later
   * changed item once; never convert whole historical boards or inspect old item bodies when no pause existed.
   * `prior` is the item projections the cache holds as of its commit (null: no pause had been set by then), so the
   * replay continues from them; `range` is the commits `commits` are, for finding the first pause among them. */
  private async loadPauses(activity: NonNullable<Snapshot["activity"]>, commits: CommitInfo[], prior: Record<string, CachedPauseItem> | null, range: string): Promise<void> {
    this.pauseStarted = prior !== null;
    let items: Snapshot["items"], replay: CommitInfo[];
    if (prior) {
      items = Object.fromEntries(Object.entries(prior).map(([id, it]) => [id, { title: id, log: [], links: [], rev: 1, ...it } as Item]));
      replay = commits;
    } else {
      if (!commits.length) return;
      const firstCommit = await this.firstPauseCommit(commits, range);
      const first = commits.findIndex(commit => commit.commit === firstCommit);
      if (first < 0) return;
      this.pauseStarted = true;
      const initial = commits[first]!;
      items = {};
      const paths = (await this.gitRead(["ls-tree", "-r", "--name-only", initial.commit, "--", "items"])).trim().split("\n");
      for (const path of paths) {
        const match = /^items\/(.+)\.yaml$/.exec(path);
        if (match) {
          const it = await this.pauseItem(path, initial.commit, match[1]!, initial.at);
          if (it) items[match[1]!] = it;
        }
      }
      const source = rules({ ...this.state, items });
      for (const id of Object.keys(items)) {
        const owner = source.pausedBy(id);
        if (owner) {
          activity.pauses ??= {};
          activity.pauses[id] = [{ start: items[owner]!.paused!.at }];
        }
      }
      replay = commits.slice(first + 1);
    }
    for (const commit of replay) {
      const next = { ...items }, changes: ChangedDoc[] = [];
      for (const path of commit.files) {
        const match = /^items\/(.+)\.yaml$/.exec(path);
        if (!match) continue;
        const id = match[1]!, after = await this.pauseItem(path, commit.commit, id, commit.at);
        if (after === undefined) continue; // An unreadable revision supplies no new evidence.
        changes.push({ kind: "item", id, before: Object.hasOwn(items, id) ? items[id]! : null, after });
        if (after) next[id] = after; else delete next[id];
      }
      if (!changes.length) continue;
      this.notePauses(activity, items, next, changes, commit.at);
      for (const change of changes) {
        if (change.after) items[change.id] = change.after as Item; else delete items[change.id];
      }
    }
  }

  /** The first of `commits` (oldest first, all within `range`) that sets a pause, found by a pickaxe over the range. */
  private async firstPauseCommit(commits: CommitInfo[], range: string): Promise<string | null> {
    const matches = new Set((await this.gitRead(["log", "--format=%H", "--no-renames", "-G", "^paused:", range, "--", "items"])).trim().split(/\s+/));
    return commits.find(commit => matches.has(commit.commit))?.commit ?? null;
  }

  /** Historical schemas are not today's write schema. Extract only the fields
   * consumed by pausedBy and interval timestamps, ignoring unrelated evolution. */
  private async pauseItem(path: string, commit: string, id: string, fallbackAt: string): Promise<Item | null | undefined> {
    try {
      const raw = await this.readAt(path, commit);
      if (raw === null) return null;
      const it = pauseProjection(raw, id, fallbackAt);
      if (!it) throw new Error("Historical item is not an object");
      return it;
    } catch (error) {
      console.warn(`Skipping unreadable pause history item ${commit}:${path}`, String(error));
      return undefined;
    }
  }

  /** Only ownership, identity or a pause marker can alter inherited pause.
   * Logs and ordinary plan progress avoid a whole-board inheritance walk. */
  private notePauses(activity: NonNullable<Snapshot["activity"]>, before: Record<string, unknown>, after: Record<string, unknown>, changed: ChangedDoc[], fallbackAt: string): void {
    const shape = (it: Item | null) => {
      return it ? { group: it.group, record: it.record, paused: it.paused, owned: it.plan.flatMap(row => "item" in row && row.own ? [row.item] : []) } : null;
    };
    const relevant = changed.filter(change => change.kind === "item").map(change => ({
      before: pauseProjection(change.before, change.id, fallbackAt), after: pauseProjection(change.after, change.id, fallbackAt),
    })).filter(change => !isDeepStrictEqual(shape(change.before), shape(change.after)));
    if (!relevant.length) return;
    const hasPause = (items: Record<string, unknown>) => Object.values(items).some(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const fields = value as Record<string, unknown>;
      return fields.record !== true && !!pauseMetadata(fields.paused);
    });
    if (!hasPause(before) && !hasPause(after)) return;
    const project = (items: Record<string, unknown>): Snapshot["items"] => Object.fromEntries(Object.entries(items).flatMap(([id, value]): Array<[string, Item]> => {
      const it = pauseProjection(value, id, fallbackAt);
      return it ? [[id, it]] : [];
    }));
    const oldItems = project(before), newItems = project(after);
    // A move starts inheritance at the move, not at the destination's older
    // pause. Document times retain sub-second precision that git dates lack.
    const dates = relevant.map(change => change.after?.updated ?? fallbackAt);
    const at = dates.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest, dates[0] ?? fallbackAt);
    const oldRules = rules({ ...this.state, items: oldItems }), newRules = rules({ ...this.state, items: newItems });
    for (const id of new Set([...Object.keys(oldItems), ...Object.keys(newItems)])) {
      const oldSource = oldRules.pausedBy(id), newSource = newRules.pausedBy(id);
      if (!!oldSource === !!newSource) continue;
      activity.pauses ??= {};
      // Copy on write: the previous snapshot shares the earlier spans.
      const spans = activity.pauses[id] = Object.hasOwn(activity.pauses, id) ? [...activity.pauses[id]!] : [];
      if (newSource) {
        const pause = newItems[newSource]!.paused!;
        const newlyPaused = !oldItems[newSource]?.paused;
        spans.push({ start: newlyPaused ? pause.at : at });
      } else {
        const current = spans.at(-1);
        if (current && current.end === undefined) spans[spans.length - 1] = { ...current, end: at };
      }
    }
  }

  /** Notice files (the retired 要你知道 list) still count in the history that has them: it keeps the active time it gave. */
  private contentPath(file: string): boolean {
    return file === "board.yaml" || /^(items|decisions|notes|notices|glossaries)\/.+\.yaml$/.test(file);
  }

  private noteActivity(activity: NonNullable<Snapshot["activity"]>, at: string, touched: Iterable<string>): void {
    for (const id of touched) if (!Object.hasOwn(activity.items, id) || Date.parse(at) > Date.parse(activity.items[id]!)) activity.items[id] = at;
  }

  /** Later writes replace earlier attributions; a write without a session leaves the previous one. */
  private noteSessions(activity: NonNullable<Snapshot["activity"]>, at: string, name: string, touched: Iterable<string>): void {
    for (const id of touched) {
      const known = activity.sessions?.[id];
      if (known && Date.parse(at) < Date.parse(known.at)) continue;
      (activity.sessions ??= {})[id] = { name, at };
    }
  }

  /** The session's last two items (src/agents.ts). Unlike an item's last writer, an earlier time never loses to a later one: writes arrive in history order. */
  private noteAgent(activity: NonNullable<Snapshot["activity"]>, at: string, name: string, touched: Iterable<string>): void {
    const items = [...touched];
    if (items.length) (activity.agents ??= {})[name] = touchAgent(activity.agents?.[name], items, at);
  }

  /** The item's list of state starts after the runner's report `start` (src/timeline.ts): the list stays the same object when the report only repeats the last start. */
  private noteState(activity: NonNullable<Snapshot["activity"]>, id: string, start: StateStart): void {
    const known = activity.states?.[id], list = withStateStart(known, start);
    if (list !== known) (activity.states ??= {})[id] = list;
  }

  private changedItems(changed: ChangedDoc[], next: Snapshot): Set<string> {
    const touched = new Set<string>();
    for (const change of changed) {
      if (change.kind === "item") touched.add(change.id);
      if (change.kind === "decision") {
        for (const doc of [change.before, change.after]) if (doc) touched.add((doc as Decision).item);
      }
      if (change.kind === "note") {
        for (const [doc, snapshot] of [[change.before, this.state], [change.after, next]] as const) {
          if (!doc) continue;
          const target = (doc as Note).target;
          if (target.startsWith("it:")) touched.add(target.slice(3));
          else {
            const card = snapshot.decisions[target.slice(2)];
            const item = card?.item ?? this.cardItems.get(target.slice(2));
            if (item) touched.add(item);
          }
        }
      }
    }
    return touched;
  }

  /** The current board, shared and frozen; a write publishes a new object and leaves this one unchanged. */
  snapshot(): Snapshot {
    return this.state;
  }

  /** A write under the budget of the request that made it; a write made by a timer or at shutdown has none, so it gets its own.
   * `kind` names the task for the write that waits behind it. A task made `onBehalf: false` (the maintenance step, which a commit
   * queues from inside its own call) serves no call: its git commands belong to no call's steps. */
  private enqueue<T>(fn: () => Promise<T>, kind = "write", onBehalf = true): Promise<T> {
    const trace = onBehalf ? currentTrace() : undefined;
    trace?.lap("before store queue");
    const ahead = this.waiting++, behind = this.tail;
    this.tail = kind;
    const task = this.queue.then(() => {
      trace?.lap("store queue", ahead ? `${ahead} ahead, behind ${behind}` : undefined);
      return withTrace(trace, () => currentBudget() ? fn() : withBudget(new Budget("write", REQUEST_LIMITS), fn));
    }).finally(() => { this.waiting--; });
    this.queue = task.catch(() => {});
    return task;
  }

  /** Revs always include kind:id; bare id is also included when unambiguous. */
  commit(txn: Txn): Promise<{ commit: string; revs: Record<string, number> }> {
    const copy = structuredClone(txn);
    return this.enqueue(() => this.apply(copy));
  }

  private async apply(txn: Txn, ownerOnly = false): Promise<{ commit: string; revs: Record<string, number> }> {
    if (!txn.author.trim() || /[<>\r\n\0]/.test(txn.author)) throw new Error("Author must be a nonempty git author name without delimiters");
    if (!txn.message.trim()) throw new Error("Commit message must be nonempty");
    const session = txn.session?.trim();
    if (txn.session !== undefined && (!session || session.length > 80 || /\p{Cc}/u.test(session))) throw new Error("Session must be 1-80 characters without control characters");
    // Share the current snapshot: copy only the collections this write changes,
    // on first use, and insert new documents frozen.
    const next: Snapshot = { ...this.state };
    const copied = new Set<DocKind>();
    const collection = (kind: DocKind): Record<string, Doc> => {
      if (!copied.has(kind)) { copied.add(kind); (next as unknown as Record<string, unknown>)[collections[kind]] = { ...docsOf(this.state, kind) }; }
      return docsOf(next, kind);
    };
    // Lower-cased ids per collection, built on first use: the letter-case alias check without a scan per put.
    const lowered = new Map<DocKind, Map<string, string[]>>();
    const aliases = (kind: DocKind): Map<string, string[]> => {
      let byLower = lowered.get(kind);
      if (!byLower) {
        byLower = new Map();
        for (const id of Object.keys(docsOf(next, kind))) { const key = id.toLowerCase(), list = byLower.get(key); if (list) list.push(id); else byLower.set(key, [id]); }
        lowered.set(kind, byLower);
      }
      return byLower;
    };
    const changed: ChangedDoc[] = [];
    const revs: Record<string, number> = {};
    const idCounts = new Map<string, number>();
    for (const put of txn.puts ?? []) idCounts.set(put.id, (idCounts.get(put.id) ?? 0) + 1);
    function revision(put: Put, rev: number): void {
      revs[`${put.kind}:${put.id}`] = rev;
      if (idCounts.get(put.id) === 1) revs[put.id] = rev;
    }
    const seen = new Set<string>();
    for (const op of [...(txn.puts ?? []), ...(txn.deletes ?? [])]) {
      const path = docPath(op.kind, op.id);
      if (seen.has(path)) throw new ValidationError([{ path, issues: "Document appears more than once in transaction" }]);
      seen.add(path);
      const records = docsOf(this.state, op.kind);
      const current = Object.hasOwn(records, op.id) ? records[op.id]! : null;
      if ((current?.rev ?? null) !== op.expectRev) throw new ConflictError(op.kind, op.id, op.expectRev, current);
    }
    const invalid: InvalidDocument[] = [];
    let nextNum = this.nextNum;
    for (const put of txn.puts ?? []) {
      const path = docPath(put.kind, put.id);
      const records = docsOf(next, put.kind);
      const before = Object.hasOwn(records, put.id) ? records[put.id]! : null;
      // Check before any filesystem mutation, including earlier puts in this
      // transaction: these names alias on the owner's case-insensitive volume.
      const alias = aliases(put.kind).get(put.id.toLowerCase())?.find(id => id !== put.id);
      if (alias) throw new ValidationError([{ path, issues: `ID ${put.id} conflicts with ${alias} (letter case only)` }]);
      try {
        const input: Record<string, unknown> = typeof put.doc === "object" && put.doc !== null && !Array.isArray(put.doc) ? { ...put.doc } : {};
        // Short numbers: only this queue issues them, so two documents never share one; a document keeps its number.
        if (put.kind === "item" || put.kind === "decision") {
          const issued = (before as Item | Decision | null)?.num, given = input.num;
          if (issued !== undefined) {
            if (given !== undefined && given !== issued) throw new ValidationError([{ path, issues: `num: ${put.kind} ${put.id} keeps its number ${issued}; it cannot become ${String(given)}` }]);
            input.num = issued;
          } else if (given !== undefined) throw new ValidationError([{ path, issues: "num: only the store issues numbers" }]);
          else if (before === null || txn.numberExisting) input.num = nextNum++;
        }
        const after = frozen(validated(schemas[put.kind], { ...input, rev: (before?.rev ?? 0) + 1 }, path));
        if (before && !txn.rewrite && isDeepStrictEqual({ ...before, rev: after.rev }, after)) {
          revision(put, before.rev);
          continue;
        }
        if (!before) { const key = put.id.toLowerCase(), list = aliases(put.kind).get(key); if (list) list.push(put.id); else aliases(put.kind).set(key, [put.id]); }
        collection(put.kind)[put.id] = after;
        revision(put, after.rev);
        changed.push({ kind: put.kind, id: put.id, before, after });
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        invalid.push(...error.invalid);
      }
    }
    for (const del of txn.deletes ?? []) {
      const records = collection(del.kind);
      changed.push({ kind: del.kind, id: del.id, before: records[del.id]!, after: null });
      delete records[del.id];
    }
    if (txn.board !== undefined) {
      try {
        next.board = frozen(validated(Board, txn.board, "board.yaml"));
        if (!isDeepStrictEqual(next.board, this.state.board)) changed.push({ kind: "board", id: "board", before: this.state.board, after: next.board });
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        invalid.push(...error.invalid);
      }
    }
    if (invalid.length) throw new ValidationError(invalid);
    const ownerChanged = this.ownerPending();
    // Ordinary no-ops don't produce a commit just to save a pending cursor.
    if (!changed.length && !(ownerOnly && ownerChanged) && !txn.planConversionReport) return { commit: this.state.head, revs };
    // Owner state is frozen and replaced, never changed in place.
    const ownerAtCommit = this.state.owner;
    if (ownerChanged) changed.push({ kind: "owner", id: "owner", before: this.ownerInHead ? this.committedOwner : null, after: ownerAtCommit });
    const paths = changed.map(c => c.kind === "board" ? "board.yaml" : c.kind === "owner" ? "state/owner.yaml" : docPath(c.kind, c.id));
    const reportPath = "import/plan-conversion.yaml";
    const priorReport = txn.planConversionReport ? await readFile(join(this.dir, reportPath), "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }) : undefined;
    if (txn.planConversionReport) paths.push(reportPath);
    const numbersChanged = nextNum !== this.nextNum;
    if (numbersChanged) paths.push(numbersPath);
    const trace = currentTrace();
    trace?.lap("validate");
    this.writing = true;
    let event: Change;
    try {
      for (let i = 0; i < changed.length; i++) {
        const path = join(this.dir, paths[i]!);
        mkdirSync(join(path, ".."), { recursive: true });
        if (changed[i]!.after === null) rmSync(path);
        else atomicWrite(path, changed[i]!.after);
      }
      if (txn.planConversionReport) { mkdirSync(join(this.dir, "import"), { recursive: true }); atomicWrite(join(this.dir, reportPath), txn.planConversionReport); }
      if (numbersChanged) atomicWrite(join(this.dir, numbersPath), validated(Numbers, { next: nextNum }, numbersPath));
      trace?.lap("files");
      await this.git(["add", "--", ...paths]);
      const slug = txn.author.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
      // `--only` commits exactly these paths, whatever else is staged, so nothing staged by hand enters a board commit; the
      // summary line names the new commit in full, and its time is read through the long-lived cat-file process: two git
      // processes a write (docs/design.md, section 4, Write cost).
      const summary = await this.git(["-c", "commit.gpgsign=false", "-c", "core.abbrev=no", "commit", "--only", "--author", `${txn.author} <${slug}@wf-board.invalid>`, "-m", txn.message, ...(session ? ["-m", `Session: ${session}`] : []), "--", ...paths], txn.author);
      const head = /^\[[^\n\]]* ([0-9a-f]{40})\]/m.exec(summary)?.[1];
      const object = head && await this.blobs.object(head);
      trace?.lap("git cat-file");
      const seconds = object && object.type === "commit" && object.id === head ? /^author .* (\d+) [+-]\d{4}$/m.exec(object.body.toString("utf8"))?.[1] : undefined;
      if (!head || !seconds) throw new Error("Invalid git commit metadata");
      const timestamp = new Date(Number(seconds) * 1000).toISOString();
      next.head = head;
      // git just named it as a commit: a read of history up to it needs no rev-parse.
      this.resolved.set(head, head);
      // Owner writes arriving during git work stay out of the staged snapshot.
      if (this.deferredOwnerWrite || !isDeepStrictEqual(this.state.owner, ownerAtCommit)) this.writeOwner();
      next.owner = this.state.owner;
      // Documents in `changed` are already frozen snapshot documents.
      event = { commit: head, at: timestamp, author: txn.author, message: txn.message, changed, activity: { from: this.state.head, items: {}, pauses: {}, sessions: {}, agents: {} } };
    } catch (error) {
      // A metadata or deferred-file failure can occur after git committed.
      // The sole-writer contract lets us restore the old ref before the paths.
      const actualHead = (await this.git(["rev-parse", "HEAD"])).trim();
      if (actualHead !== this.state.head) await this.git(["reset", "--soft", this.state.head]);
      // Reset only our paths. Newly created files have no HEAD version to restore.
      await this.git(["reset", "-q", "HEAD", "--", ...paths]);
      for (let i = 0; i < changed.length; i++) {
        const change = changed[i]!;
        // Whether the file is in the head is all that is asked: a rollback reads no history for a request, so no budget is charged.
        if (change.before === null || (change.kind === "owner" && await this.blobs.read(`${this.state.head}:${paths[i]!}`) === null)) rmSync(join(this.dir, paths[i]!), { force: true });
        else await this.git(["restore", "--source=HEAD", "--worktree", "--", paths[i]!]);
      }
      if (txn.planConversionReport) {
        if (priorReport === undefined) rmSync(join(this.dir, reportPath), { force: true });
        else writeFileSync(join(this.dir, reportPath), priorReport);
      }
      if (numbersChanged) {
        if (this.numbersInHead) await this.git(["restore", "--source=HEAD", "--worktree", "--", numbersPath]);
        else rmSync(join(this.dir, numbersPath), { force: true });
      }
      if (this.ownerPending()) this.writeOwner();
      throw error;
    } finally {
      this.writing = false;
    }
    // A message changes no item and is no work on the board: like owner state, it starts no active time (docs/design.md, Messages).
    if (changed.some(c => c.kind !== "owner" && c.kind !== "message")) {
      const previous = this.state.activity ?? { writes: [], items: {} };
      // Copy on write: the previous snapshot keeps its own activity.
      const activity: NonNullable<Snapshot["activity"]> = { writes: withSorted(previous.writes, event.at), items: { ...previous.items }, ...(previous.pauses ? { pauses: { ...previous.pauses } } : {}), ...(previous.sessions ? { sessions: { ...previous.sessions } } : {}), ...(previous.agents ? { agents: { ...previous.agents } } : {}), ...(previous.states ? { states: { ...previous.states } } : {}) };
      const touched = this.changedItems(changed, next);
      this.noteActivity(activity, event.at, touched);
      if (session) { this.noteSessions(activity, event.at, session, touched); this.noteAgent(activity, event.at, session, touched); }
      this.notePauses(activity, this.state.items, next.items, changed, event.at);
      for (const change of changed) if (change.kind === "item" && change.after) {
        const start = startOfReport((change.after as Item).runner);
        if (start) this.noteState(activity, change.id, start);
      }
      next.activity = activity;
      const delta = event.activity;
      delta.write = event.at;
      for (const [id, at] of Object.entries(activity.items)) if (previous.items[id] !== at) delta.items[id] = at;
      for (const [id, spans] of Object.entries(activity.pauses ?? {})) if (previous.pauses?.[id] !== spans) delta.pauses[id] = spans;
      for (const [id, entry] of Object.entries(activity.sessions ?? {})) if (previous.sessions?.[id] !== entry) delta.sessions[id] = entry;
      for (const [name, list] of Object.entries(activity.agents ?? {})) if (previous.agents?.[name] !== list) (delta.agents ??= {})[name] = list;
      for (const [id, list] of Object.entries(activity.states ?? {})) if (previous.states?.[id] !== list) (delta.states ??= {})[id] = list;
      for (const change of changed) if (change.kind === "decision") {
        const card = (change.after ?? change.before) as Decision | null;
        if (card) this.cardItems.set(change.id, card.item);
      }
    }
    sealed(next);
    frozen(event);
    trace?.lap("publish");
    if (changed.some(change => change.kind === "item" && (change.after as Item | null)?.paused)) this.pauseStarted = true;
    const before = this.state;
    this.state = next;
    this.derived.follows(next, before, changed, event.activity);
    this.scheduleCacheWrite();
    this.pending += 1;
    void this.queueMaintenance();
    if (numbersChanged) { this.nextNum = nextNum; this.numbersInHead = true; }
    if (ownerChanged) { this.committedOwner = ownerAtCommit; this.ownerInHead = true; }
    // An observer cannot turn a committed transaction into an apparent failure.
    for (const listener of this.listeners) { try { listener(event); } catch { /* observer owns its error handling */ } }
    trace?.lap("listeners");
    return { commit: next.head, revs };
  }

  private writeOwner(): void {
    mkdirSync(join(this.dir, "state"), { recursive: true });
    atomicWrite(join(this.dir, "state/owner.yaml"), this.state.owner);
    this.ownerFileExists = true;
    this.deferredOwnerWrite = false;
  }

  private ownerPending(): boolean {
    return !isDeepStrictEqual(this.state.owner, this.committedOwner) || (!this.ownerInHead && this.ownerFileExists);
  }

  setOwner(state: OwnerState): void {
    const owner = frozen(validated(OwnerState, state, "state/owner.yaml"));
    const before = this.state;
    this.state = sealed({ ...this.state, owner });
    try {
      if (!this.writing) this.writeOwner();
      else { this.ownerFileExists = true; this.deferredOwnerWrite = true; }
    }
    catch (error) { this.state = before; throw error; }
  }

  flushOwner(author: string): Promise<string | null> {
    return this.enqueue(async () => {
      if (!this.ownerPending()) return null;
      return (await this.apply({ author, message: "Save owner reading state" }, true)).commit;
    }, "owner state");
  }

  /** The loose objects, the packs and the disk they take (KB) in the data repository, as `git count-objects -v` reads them. */
  private async repoCounts(): Promise<{ loose: number; packs: number; kb: number }> {
    const out = await this.git(["count-objects", "-v"]);
    const field = (name: string) => Number(out.match(new RegExp(`^${name}: (\\d+)$`, "m"))?.[1] ?? 0);
    return { loose: field("count"), packs: field("packs"), kb: field("size") + field("size-pack") };
  }

  /** Queues a maintenance step when `maintenanceEvery` commits are waiting for one and none is queued; the promise ends with the
   * step. A step is a task of the write queue, so it runs when the writes before it are done and holds the writes after it. */
  private queueMaintenance(): Promise<void> | undefined {
    if (this.maintenanceTask) return this.maintenanceTask;
    if (this.maintenanceStopped || this.pending < this.maintenanceEvery) return undefined;
    const task = this.enqueue(() => this.maintain(), "maintenance", false).finally(() => { this.maintenanceTask = undefined; });
    this.maintenanceTask = task;
    return task;
  }

  /** One maintenance step (docs/design.md, Maintenance): the loose objects into a pack, the commit-graph, and, with more than
   * `MERGE_ABOVE_PACKS` packs, the small packs merged in batches. It never rejects: a step that fails is logged, and the next try
   * comes after `maintenanceEvery` more commits. */
  private async maintain(): Promise<void> {
    if (this.maintenanceStopped) return;
    const commits = this.pending, started = performance.now(), took = () => Math.round(performance.now() - started);
    try {
      const packsBefore = (await this.repoCounts()).packs;
      await this.git(["repack", "-d", "-l", "--write-midx", "-q"]);
      await this.git(["commit-graph", "write", "--split", "--reachable", "--no-progress"]);
      if (packsBefore > MERGE_ABOVE_PACKS) {
        await this.git(["multi-pack-index", "expire", "--no-progress"]);
        await this.git(["multi-pack-index", "repack", `--batch-size=${MERGE_BATCH}`, "--no-progress"]);
      }
      const after = await this.repoCounts();
      this.maintenanceLog(`maintenance ${commits} commits ${took()} ms ${after.packs} packs ${(after.kb / 1024).toFixed(1)} MB`);
    } catch (error) {
      console.error(`maintenance of ${commits} commits failed after ${took()} ms; the next try is after ${this.maintenanceEvery} more commits`, error instanceof Error ? error.message : String(error));
    }
    this.pending -= commits;
  }

  /** From now on no step is queued and a queued one does nothing; the one that is running ends. For the shutdown, which then commits
   * the owner's reading state without waiting for a step that has not started. */
  stopMaintenance(): void { this.maintenanceStopped = true; }

  /** The path of a file in the data directory that belongs to the daemon and not to the board (the wake log), with git told to
   * leave it out, so it is never committed and never makes the working tree look dirty. */
  async localFile(path: string): Promise<string> {
    const exclude = (await this.git(["rev-parse", "--git-path", "info/exclude"])).trim(), file = isAbsolute(exclude) ? exclude : join(this.dir, exclude);
    mkdirSync(dirname(file), { recursive: true });
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!current.split("\n").includes("/" + path)) appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}/${path}\n`);
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    return join(this.dir, path);
  }

  onChange(fn: (change: Change) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  async log(opts: { kind?: DocKind; id?: string; since?: string; at?: string; limit?: number } = {}): Promise<CommitInfo[]> {
    if ((opts.kind === undefined) !== (opts.id === undefined)) throw new Error("History path needs both kind and id");
    const at = opts.at === undefined ? "HEAD" : await this.resolveCommit(opts.at);
    const args = ["log", "--format=%H%x00%P%x00%aI%x00%an%x00%B%x00", "--name-only", "--no-renames", "-z"];
    if (opts.limit !== undefined) {
      if (!Number.isSafeInteger(opts.limit) || opts.limit < 0) throw new Error("History limit must be a nonnegative integer");
      args.push(`--max-count=${opts.limit}`);
    }
    if (opts.since) {
      if (/^\d{4}-\d{2}-\d{2}T/.test(opts.since)) {
        if (!Number.isFinite(Date.parse(opts.since))) throw new Error("Invalid history time");
        args.push(`--since=@${Math.floor(Date.parse(opts.since) / 1000)}`, at);
      } else {
        const commit = await this.resolveCommit(opts.since);
        args.push(`${commit}..${at}`);
      }
    } else args.push(at);
    args.push("--");
    if (opts.kind && opts.id) args.push(docPath(opts.kind, opts.id));
    const output = await this.gitRead(args);
    const fields = output.split("\0");
    const infos: CommitInfo[] = [];
    let index = 0;
    while (index < fields.length) {
      const hash = fields[index++]?.trim();
      if (!hash) continue;
      if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error("Unexpected git log record");
      const parents = fields[index++]!.split(" ").filter(Boolean);
      const at = new Date(fields[index++]!).toISOString();
      const author = fields[index++]!;
      let message = fields[index++]!.trimEnd();
      const trailer = SESSION_TRAILER.exec(message);
      if (trailer) message = message.slice(0, trailer.index);
      const files: string[] = [];
      // The extra NUL following the format separates metadata from file paths.
      while (index < fields.length && !(fields[index]?.trim().match(/^[0-9a-f]{40}$/))) {
        const file = fields[index++]!.replace(/^\n/, "");
        if (file) files.push(file);
      }
      // git just named these as commits, so later reads of them need no rev-parse.
      for (const c of [hash, ...parents]) this.resolved.set(c, c);
      infos.push({ commit: hash, parents, at, author, message, files, ...(trailer ? { session: trailer[1]!.trim() } : {}) });
    }
    return infos;
  }

  /** The newest commit made at or before `at` (milliseconds), by git's own walk from the head: it goes back over the commits
   * newer than `at` and no further, so what it costs follows the time asked for, not the length of the history. Commits are
   * dated by their commit time, which the daemon sets equal to the author time. */
  async commitAt(at: number): Promise<string | undefined> {
    // Git reads "@seconds" as a timestamp only from 1973 on, and a date far in the future not at all (Linux git refuses 2999). No
    // commit of this board is older than 1973 or newer than 2100, so an `at` outside those years is decided without git.
    const seconds = Math.floor(at / 1000);
    if (seconds < 100_000_000) return undefined;
    const output = (await this.gitRead(["log", "--max-count=1", "--format=%H", `--until=@${Math.min(seconds, 4_102_444_800)}`, "HEAD", "--"])).trim();
    return output || undefined;
  }

  /** The item a card was last placed on, also after the card was deleted (kept from the replay of the history and each write). */
  cardItem(card: string): string | undefined {
    return this.cardItems.get(card);
  }

  private readonly resolved = new Map<string, string>();
  /** Full commit id of a ref. A full id, or one followed by ^, always names the same commit, so its answer is cached. */
  private async resolveCommit(ref: string): Promise<string> {
    const cached = this.resolved.get(ref);
    if (cached) return cached;
    const hash = (await this.git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
    if (/^[0-9a-f]{40}\^?$/.test(ref)) this.resolved.set(ref, hash);
    return hash;
  }

  /** A string is two bytes a character in the heap. */
  private readonly diffs = new ReadCache<string>(historicalDiffBytes, historicalDiffEntries, text => text.length * 2);
  /** Two commits and a path always name the same text, so a diff is kept by those keys: the page asks for every unread
   * step's documents on each load, and git spawns once per new pair rather than once per request. */
  async diff(kind: DocKind, id: string, from: string, to = "HEAD"): Promise<string> {
    const path = docPath(kind, id);
    const a = await this.resolveCommit(from);
    const b = await this.resolveCommit(to);
    // Also an answer from the cache needs a budget to be asked under, so a read without one fails the first time it runs.
    this.budget();
    return this.diffs.get(`${a}..${b}:${path}`, () => this.gitRead(["diff", "--no-ext-diff", "--no-textconv", a, b, "--", path]));
  }

  private readonly historicalDocuments = new ReadCache<ReadDocument>(historicalDocumentBytes, historicalDocumentEntries, read => read.size * HEAP_PER_FILE_BYTE);
  /** A document as an earlier commit had it, parsed and frozen; null when it had none. A read of git is charged to the
   * request's budget, a read answered from the cache is not. */
  private async readAt(path: string, commit: string): Promise<unknown | null> {
    const budget = this.budget();
    const key = `${commit}:${path}`;
    const { doc } = await this.historicalDocuments.get(key, async () => {
      const blob = await this.blobs.read(key);
      if (blob === null) return { doc: null, size: 0 };
      budget?.readBytes(blob.length);
      try { return { doc: frozen(parse(blob.toString("utf8"), { version: "1.2", schema: "core" })), size: blob.length }; }
      catch (error) { throw new ValidationError([{ path: key, issues: String(error) }]); }
    });
    return doc;
  }

  async show(kind: DocKind, id: string, commit: string): Promise<unknown | null> {
    const path = docPath(kind, id);
    const hash = await this.resolveCommit(commit);
    // A past version is returned as written: it may hold fields a later schema dropped, which history must still show.
    return structuredClone(await this.readAt(path, hash));
  }

  /** Compare like formats directly. Only an endpoint spanning the schema change
   * needs a whole-board normalization; raw evidence remains available through show(). */
  async comparisonDocuments(kind: DocKind, id: string, from: string | null, to: string): Promise<{ before: unknown | null; after: unknown | null }> {
    const before = from ? await this.show(kind, id, from) : null, after = await this.show(kind, id, to);
    const legacy = retiredItemShape;
    if (kind !== "item" || before === null || after === null || legacy(before) === legacy(after)) return { before: omitRetired(kind, before), after: omitRetired(kind, after) };
    return { before: omitRetired(kind, legacy(before) ? await this.showCompared(kind, id, from!) : before), after: omitRetired(kind, legacy(after) ? await this.showCompared(kind, id, to) : after) };
  }

  private readonly compared = new ReadCache<Snapshot>(Infinity, comparedSnapshotLimit, () => 0);
  private readonly comparisonAt = new Date().toISOString();
  /** Normalized comparison only; show() and diff() retain raw historical evidence. Rebuilding a board costs 2.7 to 3.1
   * seconds and about 510 MB of heap (measured in CI on a board of the live one's size), so a request may do it once
   * (`REQUEST_LIMITS.boards`) and one board is kept. */
  async comparisonSnapshot(commit: string): Promise<Snapshot> {
    const budget = this.budget();
    const hash = await this.resolveCommit(commit);
    return this.compared.get(hash, async () => {
      budget?.board();
      const paths = (await this.gitRead(["ls-tree", "-r", "--name-only", hash])).trim().split("\n");
      const raw: Record<string, unknown> = {};
      for (const path of paths) if (path === "board.yaml" || path === "state/owner.yaml" || /^(items|decisions|notes|notices|glossaries)\/.+\.yaml$/.test(path)) raw[path] = withoutRetiredFields(path, await this.readAt(path, hash));
      const loaded = parsePlanData(raw, hash);
      if (!loaded.legacy) {
        const source = loaded.snapshot as Snapshot;
        const {archived:_archived,...owner} = source.owner as OwnerState & {archived?:unknown};
        return {...source,owner:validated(OwnerState,owner,"state/owner.yaml")};
      }
      const migrationReport = await this.readAt("import/plan-conversion.yaml", this.state.head) as { at?: unknown; planConversionAt?:unknown } | null;
      const timestamp=migrationReport?.planConversionAt??migrationReport?.at;
      const at = typeof timestamp === "string" ? Legacy.Time.parse(timestamp) : this.comparisonAt;
      return convertPlans(loaded.snapshot as Legacy.Snapshot, { at }).snapshot;
    });
  }
  /** A version of a document that history returned as written, in today's shape: retired fields dropped, defaults filled. A
   * version that does not fit today's schema is refused, naming the document. */
  earlier(kind: Exclude<DocKind, "glossary">, id: string, doc: unknown): Doc {
    return validated(schemas[kind], withoutRetiredFields(docPath(kind, id), doc), docPath(kind, id));
  }
  /** The board's settings (projects, tag vocabulary) as `commit` had them; null when it had no board file. */
  async boardAt(commit: string): Promise<Board | null> {
    const hash = await this.resolveCommit(commit);
    const doc = await this.readAt("board.yaml", hash);
    return doc === null ? null : validated(Board, withoutRetiredFields("board.yaml", doc), `${hash}:board.yaml`);
  }
  async showCompared(kind: DocKind, id: string, commit: string): Promise<unknown | null> {
    docPath(kind, id);
    const raw = await this.show(kind, id, commit);
    if (kind !== "item" || raw === null || typeof raw === "object" && "plan" in raw) return raw;
    return docsOf(await this.comparisonSnapshot(commit), kind)[id] ?? null;
  }

  /** The full commit id of `ref` when it is `at` or an ancestor of it; null when either ref is unknown or ancestry fails. */
  async inHistory(ref: string, at = "HEAD"): Promise<string | null> {
    try {
      const hash = await this.resolveCommit(ref), head = await this.resolveCommit(at);
      await this.git(["merge-base", "--is-ancestor", hash, head]);
      return hash;
    } catch { return null; }
  }

  /** Commits on HEAD that origin's branch, as this clone last saw it, lacks; 0 without a remote. */
  async unpushed(): Promise<number> {
    if (!(await this.git(["remote"])).split(/\s+/).includes("origin")) return 0;
    const branch = (await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    const range = await this.inHistory(`refs/remotes/origin/${branch}`) ? [`refs/remotes/origin/${branch}..HEAD`] : ["HEAD"];
    return Number((await this.git(["rev-list", "--count", ...range])).trim());
  }

  private pushing?: Promise<boolean>;

  /** Sends the commits the remote lacks, outside the write queue: a write waits for no network (docs/design.md, Storage). Only one
   * push runs at a time; a call made while one runs gets that push's result. Resolves true when commits were sent and false when
   * there is no remote, the remote already has them, or it is ahead of this clone; rejects when the remote has commits this
   * clone lacks, or the push failed or was killed (the cap, or `signal`). The commits written after the push began go in the next. */
  push(signal?: AbortSignal): Promise<boolean> {
    return this.pushing ??= this.pushOnce(signal).finally(() => { this.pushing = undefined; });
  }

  private async pushOnce(signal?: AbortSignal): Promise<boolean> {
    if (!(await this.git(["remote"])).split(/\s+/).includes("origin")) return false;
    const branch = (await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    // The head as of now: a commit made while git is sending, or one a failed write took back, is not in this push.
    const head = this.state.head;
    // One connection: git itself says whether it sent commits, found the remote current, or was refused.
    const pushed = await this.network(["push", "--porcelain", "origin", `${head}:refs/heads/${branch}`], signal);
    if (pushed.code === 0) return !/^=\t/m.test(pushed.stdout);
    // A refusal for a remote that has moved on. Anything else (no connection, killed, a hook's refusal) is an error.
    if (!/^!\t[^\t]*\t\[rejected\]/m.test(pushed.stdout)) throw new Error(`git push ${netGitReason(pushed)}`);
    // Only now a second connection: a remote that is ahead of this clone is no error, one that has diverged is.
    const fetched = await this.network(["fetch", "--no-tags", "origin", `refs/heads/${branch}`], signal);
    if (fetched.code !== 0) throw new Error(`git fetch ${netGitReason(fetched)}`);
    const remoteHead = await this.resolveCommit("FETCH_HEAD");
    if (Number((await this.git(["rev-list", "--count", `${remoteHead}..${head}`])).trim()) === 0) return false;
    throw new Error(`The remote has commits this clone lacks: ${pushed.stdout.trim()}`);
  }

  /** The only way this store runs git against a remote (src/net-git.ts): bounded in time, killed with its ssh, no maintenance. */
  private network(args: string[], signal?: AbortSignal): Promise<NetGitResult> {
    return netGit(args, { cwd: this.dir, signal });
  }
}

/** Refuse a board whose numbers could repeat: two documents sharing one, a counter not above every issued number, or
 * numbers without their counter. Never repaired silently; the owner decides how to fix the data. */
function checkNumbers(docs: Pick<Snapshot, "items" | "decisions">, numbers: Numbers | undefined): void {
  const holders = new Map<number, string[]>();
  for (const [kind, collection] of [["item", docs.items], ["decision", docs.decisions]] as const)
    for (const [id, doc] of Object.entries(collection)) if (doc.num !== undefined) holders.set(doc.num, [...holders.get(doc.num) ?? [], `${kind} ${id}`]);
  const problems = [...holders].filter(([, ids]) => ids.length > 1).map(([num, ids]) => `number ${num} is held by ${ids.join(", ")}`);
  const max = Math.max(0, ...holders.keys());
  if (numbers === undefined && max > 0) problems.push(`${numbersPath} is missing while documents hold numbers up to ${max}`);
  if (numbers !== undefined && numbers.next <= max) problems.push(`${numbersPath} next ${numbers.next} is not above the highest issued number ${max}`);
  if (problems.length) throw new Error(`Short numbers are inconsistent; refusing to start:\n${problems.join("\n")}`);
}

/** Transient reader for the CLI and startup migration; all data-file IO stays in Store. */
export async function readPlanData(dir: string): Promise<{ legacy: boolean; hasArchives: boolean; planConversionAt?: string; snapshot: Legacy.Snapshot | Snapshot }> {
  const raw: Record<string, unknown> = {}, invalid: InvalidDocument[] = [];
  async function load(path: string, optional = false): Promise<void> {
    try { const doc = parse(await readFile(join(dir,path),"utf8"),{version:"1.2",schema:"core"}); raw[path] = path.startsWith("items/") ? without(withoutRetiredLevel(doc), ["priority"]) : doc; }
    catch(error) { if(optional&&(error as NodeJS.ErrnoException).code==="ENOENT")return;invalid.push({path,issues:String(error)}); }
  }
  await load("board.yaml");
  for (const collection of ["items","decisions","notes","glossaries"]) {
    const files = await readdir(join(dir,collection)).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
    for (const file of files.sort()) {
      const path=`${collection}/${file}`;
      if(!file.endsWith(".yaml")){invalid.push({path,issues:"Expected a .yaml document"});continue;}
      await load(path);
    }
  }
  await load("state/owner.yaml",true);
  await load("import/plan-conversion.yaml",true);
  let loaded: ReturnType<typeof parsePlanData> | undefined;
  try { loaded=parsePlanData(raw,""); }
  catch(error){if(error instanceof ValidationError)invalid.push(...error.invalid);else throw error;}
  if(invalid.length||!loaded)throw new ValidationError(invalid);
  const dirty=await run("git",["status","--porcelain","--","board.yaml",numbersPath,"items","decisions","notes","glossaries","messages"],{cwd:dir});
  if(dirty.stdout.trim())throw new Error(`Board working tree has uncommitted changes: ${dirty.stdout.trim()}`);
  loaded.snapshot.head=(await run("git",["rev-parse","HEAD"],{cwd:dir})).stdout.trim();
  return loaded;
}
function parsePlanData(raw: Record<string, unknown>, head: string): { legacy: boolean; hasArchives: boolean; planConversionAt?: string; snapshot: Legacy.Snapshot | Snapshot } {
  const items=Object.entries(raw).filter(([path])=>path.startsWith("items/"));

  const legacy=retiredBoardShape(raw["board.yaml"]) || items.some(([,doc])=>retiredItemShape(doc));
  // Records may omit plan in the current schema. A current work plan alongside
  // a retired work shape still indicates an incomplete migration.
  if(legacy&&items.some(([,doc])=>doc&&typeof doc==="object"&&Object.hasOwn(doc,"plan")))throw new Error("Mixed legacy and plan items are refused");
  const schema=legacy?Legacy: {Board,Item,Decision,Note,Glossary,OwnerState};
  const invalid: InvalidDocument[]=[];
  function load<T>(documentSchema:z.ZodType<T>, value:unknown, path:string):T|undefined {
    try {return validated(documentSchema,value,path);}
    catch(error){if(error instanceof ValidationError){invalid.push(...error.invalid);return undefined;}throw error;}
  }
  const board=load(schema.Board,raw["board.yaml"],"board.yaml");
  const rawOwner=raw["state/owner.yaml"]??{};
  const hasArchives=retiredOwnerShape(rawOwner);
  const owner=legacy||hasArchives?load(Legacy.OwnerState,rawOwner,"state/owner.yaml"):load(OwnerState,rawOwner,"state/owner.yaml");
  const documents: Record<string,Record<string,unknown>>={items:{},decisions:{},notes:{},glossaries:{},...(legacy?{notices:{}}:{})};
  for(const [path,doc]of Object.entries(raw)){
    const match=/^(items|decisions|notes|notices|glossaries)\/(.+)\.yaml$/.exec(path);
    // A board of plans has no notices; those in older commits are left out of the snapshot read from them.
    if(!match||(match[1]==="notices"&&!legacy))continue;
    const collection=match[1] as "items"|"decisions"|"notes"|"notices"|"glossaries",id=match[2]!;
    const key=load(collection==="glossaries"?GlossaryId:Key,id,path);
    const kind=({items:"Item",decisions:"Decision",notes:"Note",notices:"Notice",glossaries:"Glossary"}as const)[collection];
    const parsed=load((schema as unknown as Record<string,z.ZodType<unknown>>)[kind]!,doc,path);
    if(key!==undefined&&parsed!==undefined)documents[collection]![key]=parsed;
  }
  if(invalid.length||!board||!owner)throw new ValidationError(invalid);
  const snapshot={board,...documents,owner,head} as Legacy.Snapshot|Snapshot;
  const priorReport=raw["import/plan-conversion.yaml"] as {planConversionAt?:unknown;at?:unknown}|undefined;
  const timestamp=priorReport?.planConversionAt??priorReport?.at;
  const planConversionAt=timestamp===undefined?undefined:load(Legacy.Time,timestamp,"import/plan-conversion.yaml");
  if(invalid.length)throw new ValidationError(invalid);
  return {legacy,hasArchives,planConversionAt,snapshot};
}
