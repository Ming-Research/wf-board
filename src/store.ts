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
import { Board, Decision, Glossary, GlossaryId, Item, Key, Note, Numbers, OwnerState } from "./model.ts";
import type { Snapshot } from "./model.ts";
import * as Legacy from "./legacy-model.ts";
import { convertPlans, removeArchives, PLAN_CONVERSION_MESSAGE, updatePlanSummary } from "./convert-plans.ts";
import type { PlanConversionReport } from "./convert-plans.ts";
import { verifyPlans, verifyArchiveRemoval } from "./verify-plans.ts";
import { rules, DerivedCache, withSorted } from "./rules.ts";
import { touchAgent } from "./agents.ts";
import type { ActivityDelta } from "./rules.ts";
import { StartupCache, STARTUP_CACHE_VERSION } from "./startup-cache.ts";
import type { CachedPauseItem } from "./startup-cache.ts";
import { stopwatch } from "./log.ts";
import type { StartupStep } from "./log.ts";

export type DocKind = "item" | "decision" | "note" | "glossary";
export interface Put { kind: DocKind; id: string; doc: unknown; expectRev: number | null }
export interface Del { kind: DocKind; id: string; expectRev: number }
/** `numberExisting` (the one-time numbering only) issues numbers to unnumbered existing documents, in put order. */
export interface Txn { author: string; message: string; session?: string; puts?: Put[]; deletes?: Del[]; board?: z.input<typeof Board>; planConversionReport?: PlanConversionReport; numberExisting?: true }
export interface ChangedDoc { kind: DocKind | "board" | "owner"; id: string; before: unknown | null; after: unknown | null }
/** `activity` is how the commit changed Snapshot["activity"]; rules' applyActivityDelta applies it. */
export interface Change { commit: string; at: string; author: string; message: string; changed: ChangedDoc[]; activity: ActivityDelta }
/** `session`: the writing session's name from the commit's `Session:` trailer; `message` excludes the trailer. */
export interface CommitInfo { commit: string; parents: string[]; at: string; author: string; message: string; files: string[]; session?: string }
/** The commit trailer that records which session made a write (docs/design.md, history). */
const SESSION_TRAILER = /\n\nSession: ([^\n]+)$/;

type Doc = Item | Decision | Note | Glossary;
const schemas: Record<DocKind, z.ZodType<Doc>> = { item: Item, decision: Decision, note: Note, glossary: Glossary };
const collections = { item: "items", decision: "decisions", note: "notes", glossary: "glossaries" } as const;
/** A glossary is named by its project, which may be Chinese (总管); other documents by their key. */
const ids: Record<DocKind, z.ZodType<string>> = { item: Key, decision: Key, note: Key, glossary: GlossaryId };
const run = promisify(execFile);
/** The persisted short-number counter (model.ts Numbers). */
const numbersPath = "numbers.yaml";
export const NUMBERING_MESSAGE = "Number existing items and cards";
/** Commit message of the one-time deletion of the retired notices; activity skips that commit. */
export const RETIRE_NOTICES_MESSAGE = "Delete the notices: the 要你知道 list was removed, and the notices are in git history";

// History grows for the lifetime of the daemon. Retain recent parsed documents,
// but fewer much larger whole boards; normalization is needed at format
// boundaries, not for every old commit.
const historicalDocumentLimit = 4096;
const comparedSnapshotLimit = 4;
const historicalDiffLimit = 2048;
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

function cachedPromise<T>(cache: Map<string, Promise<T>>, key: string, limit: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = load();
  cache.set(key, pending);
  // FIFO includes pending reads, so concurrent history requests cannot bypass
  // the bound. An evicted read may finish, but cannot remove a newer retry.
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
  void pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
  return pending;
}

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

/** Fields that a data-repository migration commit removed from every item or board project, by where they sat. Only
 * whole-board historical comparison omits them, so an old version holding them still normalizes: show() and diff()
 * return them as written, any field not listed here still refuses the old version, and current reads and writes stay
 * strict. Dropped by "Drop area short names at the owner's request" (item short), "Drop item agents: responsibility
 * moves to each project's configuration" (item agent) and "Projects are identified by themselves: drop session names
 * (agents)" (board project agents). The removed inbox's item `request` marker is not here: the legacy conversion still
 * reads it, so parsePlanData drops it only from current-shape items. */
const retiredFields = { item: ["short", "agent"], project: ["agents"] } as const;
function without(value: unknown, keys: readonly string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !keys.some(key => Object.hasOwn(value, key))) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
function withoutRetiredFields(path: string, doc: unknown): unknown {
  if (path.startsWith("items/")) return without(doc, retiredFields.item);
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
  for (const collection of [state.items, state.decisions, state.notes, state.glossaries]) Object.freeze(collection);
  frozen(state.board); frozen(state.owner);
  if (state.activity) frozen(state.activity);
  return Object.freeze(state);
}

/**
 * One long-lived `git cat-file --batch` that reads `<rev>:<path>` objects in
 * order, so history queries cost no process per document. The process keeps
 * Node alive only while a read is pending, and restarts after a failure.
 */
class BlobReader {
  private readonly dir: string;
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private waiting: Array<{ resolve: (b: Buffer | null) => void; reject: (e: Error) => void }> = [];

  constructor(dir: string) { this.dir = dir; }

  read(spec: string): Promise<Buffer | null> {
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
      const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
      if (!m) { this.buffer = this.buffer.subarray(nl + 1); this.waiting.shift()!.resolve(null); if (!this.waiting.length && this.child) this.hold(this.child, false); continue; }
      const size = Number(m[2]);
      if (this.buffer.length < nl + 1 + size + 1) return;
      const body = this.buffer.subarray(nl + 1, nl + 1 + size);
      this.buffer = this.buffer.subarray(nl + 1 + size + 1);
      this.waiting.shift()!.resolve(m[1] === "blob" ? Buffer.from(body) : null);
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
  /** Reports the time of each startup step; a no-op after `open` unless the caller gave `startup`. */
  private lap: (step: string, detail?: string) => void = () => {};
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
    const result = await run("git", args, {
      cwd: this.dir, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_COMMITTER_NAME: "wf-board", GIT_COMMITTER_EMAIL: "wf-board@wf-board.invalid",
        ...(author ? { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${slug}@wf-board.invalid` } : {}) },
    });
    return result.stdout;
  }

  /** `startup` is told how long each step of the start took (docs/design.md, Running). */
  static async open(dir: string, opts: { init?: boolean; board?: z.input<typeof Board>; planConversionHead?: string; startup?: StartupStep; cacheDelayMs?: number } = {}): Promise<Store> {
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
      const initial: Snapshot = { board, items: {}, decisions: {}, notes: {}, glossaries: {}, owner: {}, head: "" };
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
    async function load<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
      try {
        const raw = parse(await readFile(join(dir, path), "utf8"), { version: "1.2", schema: "core" });
        if (retiredShape(path, raw)) retired = true;
        return validated(schema, raw, path);
      } catch (error) {
        invalid.push(...(error instanceof ValidationError ? error.invalid : [{ path, issues: String(error) }]));
        return undefined;
      }
    }
    const board = await load("board.yaml", Board);
    const docs: Pick<Snapshot, "items" | "decisions" | "notes" | "glossaries"> = { items: {}, decisions: {}, notes: {}, glossaries: {} };
    for (const kind of ["item", "decision", "note", "glossary"] as const) {
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
        return Store.open(dir, { startup: opts.startup, cacheDelayMs: opts.cacheDelayMs });
      }
    }
    if (invalid.length || !board) throw new ValidationError(invalid);
    checkNumbers(docs, numbers);
    for (const collection of Object.values(docs)) for (const doc of Object.values(collection)) frozen(doc);
    const store = new Store(dir, { board, ...docs, owner, head: "" });
    store.lap = lap;
    if (opts.cacheDelayMs !== undefined) store.cacheDelayMs = opts.cacheDelayMs;
    if (numbers) { store.nextNum = numbers.next; store.numbersInHead = true; }
    // Refuse to adopt staged/uncommitted board edits as the committed snapshot.
    const dirty = await store.git(["status", "--porcelain", "--", "board.yaml", numbersPath, "items", "decisions", "notes", "glossaries"]);
    if (dirty.trim()) throw new Error(`Board working tree has uncommitted changes: ${dirty.trim()}`);
    store.state = sealed({ ...store.state, head: (await store.git(["rev-parse", "HEAD"])).trim() });
    // Owner state can legitimately be newer than HEAD after a daemon restart.
    const persistedOwner = await store.readAt("state/owner.yaml", store.state.head);
    store.committedOwner = persistedOwner === null ? {} : validated(OwnerState, persistedOwner, "state/owner.yaml");
    store.ownerInHead = persistedOwner !== null;
    store.ownerFileExists = ownerFileExists;
    lap("check board", "numbers, git status, HEAD, owner state");
    await store.numberExisting();
    lap("number documents");
    await store.loadActivity();
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

  /** Activity is a derived index of the existing history, including replaced and deleted documents. A start continues
   * from the startup cache when it can be trusted, replaying only the commits after the commit the cache is of; with no
   * usable cache it replays the whole history (the scan) and writes the cache at once. */
  private async loadActivity(): Promise<void> {
    const cache = await this.readStartupCache();
    if (cache) this.lap("read startup cache", `of ${cache.head.slice(0, 12)}`);
    const commits = (await this.log(cache ? { since: cache.head } : {})).reverse();
    this.lap("read git log", `${commits.length} commits${cache ? " after the cache" : ""}`);
    const activity: NonNullable<Snapshot["activity"]> = cache
      ? { writes: cache.activity.writes, items: cache.activity.items, ...(cache.activity.pauses ? { pauses: cache.activity.pauses } : {}), ...(cache.activity.sessions ? { sessions: cache.activity.sessions } : {}), ...(cache.activity.agents ? { agents: cache.activity.agents } : {}) }
      : { writes: [], items: {} };
    this.cardItems.clear();
    for (const [card, item] of Object.entries(cache?.cardItems ?? {})) this.cardItems.set(card, item);
    for (const commit of commits) {
      // Numbering is bookkeeping, not work on the items: it starts no active time and resets no clock.
      if (commit.message === NUMBERING_MESSAGE || commit.message === RETIRE_NOTICES_MESSAGE) continue;
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
      activity: { writes: activity.writes, items: activity.items, pauses: activity.pauses ?? null, sessions: activity.sessions ?? null, agents: activity.agents ?? null },
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
      const paths = (await this.git(["ls-tree", "-r", "--name-only", initial.commit, "--", "items"])).trim().split("\n");
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
    const matches = new Set((await this.git(["log", "--format=%H", "--no-renames", "-G", "^paused:", range, "--", "items"])).trim().split(/\s+/));
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

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn);
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
      if (!copied.has(kind)) { copied.add(kind); (next as unknown as Record<string, unknown>)[collections[kind]] = { ...this.state[collections[kind]] }; }
      return next[collections[kind]] as Record<string, Doc>;
    };
    // Lower-cased ids per collection, built on first use: the letter-case alias check without a scan per put.
    const lowered = new Map<DocKind, Map<string, string[]>>();
    const aliases = (kind: DocKind): Map<string, string[]> => {
      let byLower = lowered.get(kind);
      if (!byLower) {
        byLower = new Map();
        for (const id of Object.keys(next[collections[kind]])) { const key = id.toLowerCase(), list = byLower.get(key); if (list) list.push(id); else byLower.set(key, [id]); }
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
      const records = this.state[collections[op.kind]] as Record<string, Doc>;
      const current = Object.hasOwn(records, op.id) ? records[op.id]! : null;
      if ((current?.rev ?? null) !== op.expectRev) throw new ConflictError(op.kind, op.id, op.expectRev, current);
    }
    const invalid: InvalidDocument[] = [];
    let nextNum = this.nextNum;
    for (const put of txn.puts ?? []) {
      const path = docPath(put.kind, put.id);
      const records = next[collections[put.kind]] as Record<string, Doc>;
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
        if (before && isDeepStrictEqual({ ...before, rev: after.rev }, after)) {
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
    if ((await this.git(["diff", "--cached", "--name-only"])).trim()) throw new Error("Refusing to commit an already staged index");
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
      await this.git(["add", "--", ...paths]);
      const slug = txn.author.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
      await this.git(["-c", "commit.gpgsign=false", "commit", "--author", `${txn.author} <${slug}@wf-board.invalid>`, "-m", txn.message, ...(session ? ["-m", `Session: ${session}`] : [])], txn.author);
      const [head, timestamp] = (await this.git(["show", "-s", "--format=%H%x00%aI", "HEAD"])).trimEnd().split("\0");
      if (!head || !/^[0-9a-f]{40}$/.test(head) || !timestamp) throw new Error("Invalid git commit metadata");
      next.head = head;
      // Owner writes arriving during git work stay out of the staged snapshot.
      if (this.deferredOwnerWrite || !isDeepStrictEqual(this.state.owner, ownerAtCommit)) this.writeOwner();
      next.owner = this.state.owner;
      // Documents in `changed` are already frozen snapshot documents.
      event = { commit: head, at: new Date(timestamp).toISOString(), author: txn.author, message: txn.message, changed, activity: { from: this.state.head, items: {}, pauses: {}, sessions: {}, agents: {} } };
    } catch (error) {
      // A metadata or deferred-file failure can occur after git committed.
      // The sole-writer contract lets us restore the old ref before the paths.
      const actualHead = (await this.git(["rev-parse", "HEAD"])).trim();
      if (actualHead !== this.state.head) await this.git(["reset", "--soft", this.state.head]);
      // Reset only our paths. Newly created files have no HEAD version to restore.
      await this.git(["reset", "-q", "HEAD", "--", ...paths]);
      for (let i = 0; i < changed.length; i++) {
        const change = changed[i]!;
        if (change.before === null || (change.kind === "owner" && await this.readAt(paths[i]!, this.state.head) === null)) rmSync(join(this.dir, paths[i]!), { force: true });
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
    if (changed.some(c => c.kind !== "owner")) {
      const previous = this.state.activity ?? { writes: [], items: {} };
      // Copy on write: the previous snapshot keeps its own activity.
      const activity: NonNullable<Snapshot["activity"]> = { writes: withSorted(previous.writes, event.at), items: { ...previous.items }, ...(previous.pauses ? { pauses: { ...previous.pauses } } : {}), ...(previous.sessions ? { sessions: { ...previous.sessions } } : {}), ...(previous.agents ? { agents: { ...previous.agents } } : {}) };
      const touched = this.changedItems(changed, next);
      this.noteActivity(activity, event.at, touched);
      if (session) { this.noteSessions(activity, event.at, session, touched); this.noteAgent(activity, event.at, session, touched); }
      this.notePauses(activity, this.state.items, next.items, changed, event.at);
      next.activity = activity;
      const delta = event.activity;
      delta.write = event.at;
      for (const [id, at] of Object.entries(activity.items)) if (previous.items[id] !== at) delta.items[id] = at;
      for (const [id, spans] of Object.entries(activity.pauses ?? {})) if (previous.pauses?.[id] !== spans) delta.pauses[id] = spans;
      for (const [id, entry] of Object.entries(activity.sessions ?? {})) if (previous.sessions?.[id] !== entry) delta.sessions[id] = entry;
      for (const [name, list] of Object.entries(activity.agents ?? {})) if (previous.agents?.[name] !== list) (delta.agents ??= {})[name] = list;
      for (const change of changed) if (change.kind === "decision") {
        const card = (change.after ?? change.before) as Decision | null;
        if (card) this.cardItems.set(change.id, card.item);
      }
    }
    sealed(next);
    frozen(event);
    if (changed.some(change => change.kind === "item" && (change.after as Item | null)?.paused)) this.pauseStarted = true;
    this.state = next;
    this.scheduleCacheWrite();
    if (numbersChanged) { this.nextNum = nextNum; this.numbersInHead = true; }
    if (ownerChanged) { this.committedOwner = ownerAtCommit; this.ownerInHead = true; }
    // An observer cannot turn a committed transaction into an apparent failure.
    for (const listener of this.listeners) { try { listener(event); } catch { /* observer owns its error handling */ } }
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
    });
  }

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
    const output = await this.git(args);
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

  private readonly resolved = new Map<string, string>();
  /** Full commit id of a ref. A full id, or one followed by ^, always names the same commit, so its answer is cached. */
  private async resolveCommit(ref: string): Promise<string> {
    const cached = this.resolved.get(ref);
    if (cached) return cached;
    const hash = (await this.git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
    if (/^[0-9a-f]{40}\^?$/.test(ref)) this.resolved.set(ref, hash);
    return hash;
  }

  private readonly diffs = new Map<string, Promise<string>>();
  /** Two commits and a path always name the same text, so a diff is kept by those keys: the page asks for every unread
   * step's documents on each load, and git spawns once per new pair rather than once per request. */
  async diff(kind: DocKind, id: string, from: string, to = "HEAD"): Promise<string> {
    const path = docPath(kind, id);
    const a = await this.resolveCommit(from);
    const b = await this.resolveCommit(to);
    return cachedPromise(this.diffs, `${a}..${b}:${path}`, historicalDiffLimit, () => this.git(["diff", "--no-ext-diff", "--no-textconv", a, b, "--", path]));
  }

  private readonly historicalDocuments = new Map<string, Promise<unknown | null>>();
  private async readAt(path: string, commit: string): Promise<unknown | null> {
    const key = `${commit}:${path}`;
    return cachedPromise(this.historicalDocuments, key, historicalDocumentLimit, async () => {
      const blob = await this.blobs.read(key);
      if (blob === null) return null;
      try { return frozen(parse(blob.toString("utf8"), { version: "1.2", schema: "core" })); }
      catch (error) { throw new ValidationError([{ path: key, issues: String(error) }]); }
    });
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
    if (kind !== "item" || before === null || after === null || legacy(before) === legacy(after)) return { before, after };
    return { before: legacy(before) ? await this.showCompared(kind, id, from!) : before, after: legacy(after) ? await this.showCompared(kind, id, to) : after };
  }

  private readonly compared = new Map<string, Promise<Snapshot>>();
  private readonly comparisonAt = new Date().toISOString();
  /** Normalized comparison only; show() and diff() retain raw historical evidence. */
  async comparisonSnapshot(commit: string): Promise<Snapshot> {
    const hash = await this.resolveCommit(commit);
    return cachedPromise(this.compared, hash, comparedSnapshotLimit, async () => {
      const paths = (await this.git(["ls-tree", "-r", "--name-only", hash])).trim().split("\n");
      const raw: Record<string, unknown> = {};
      for (const path of paths) if (path === "board.yaml" || path === "state/owner.yaml" || /^(items|decisions|notes|notices|glossaries)\/.+\.yaml$/.test(path)) raw[path] = await this.readAt(path, hash);
      const loaded = parsePlanData(raw, hash, true);
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
  async showCompared(kind: DocKind, id: string, commit: string): Promise<unknown | null> {
    docPath(kind, id);
    const raw = await this.show(kind, id, commit);
    if (kind !== "item" || raw === null || typeof raw === "object" && "plan" in raw) return raw;
    return (await this.comparisonSnapshot(commit))[collections[kind]][id] ?? null;
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

  push(): Promise<boolean> {
    return this.enqueue(async () => {
      if (!(await this.git(["remote"])).split(/\s+/).includes("origin")) return false;
      const branch = (await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
      const remote = (await this.git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`])).trim().split(/\s+/)[0];
      if (remote) {
        // ls-remote may name an object this clone has never fetched.
        await this.git(["fetch", "--no-tags", "origin", `refs/heads/${branch}`]);
        const remoteHead = await this.resolveCommit("FETCH_HEAD");
        const ahead = Number((await this.git(["rev-list", "--count", `${remoteHead}..HEAD`])).trim());
        if (ahead === 0) return false;
      }
      await this.git(["push", "origin", `HEAD:refs/heads/${branch}`]);
      return true;
    });
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
    try { raw[path] = parse(await readFile(join(dir,path),"utf8"),{version:"1.2",schema:"core"}); }
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
  const dirty=await run("git",["status","--porcelain","--","board.yaml",numbersPath,"items","decisions","notes","glossaries"],{cwd:dir});
  if(dirty.stdout.trim())throw new Error(`Board working tree has uncommitted changes: ${dirty.stdout.trim()}`);
  loaded.snapshot.head=(await run("git",["rev-parse","HEAD"],{cwd:dir})).stdout.trim();
  return loaded;
}
/** Items of older commits can carry the `request` marker of the removed inbox; the schema no longer has the field. */
function withoutRequestMarker(doc: unknown): unknown {
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Object.hasOwn(doc, "request")) return doc;
  const { request: _request, ...rest } = doc as Record<string, unknown>;
  return rest;
}
/** `historical`: the data is a past commit's, whose items may hold fields the schema has since dropped; only
 * comparisonSnapshot reads data this way, and the live data stays strictly validated. */
function parsePlanData(raw: Record<string, unknown>, head: string, historical = false): { legacy: boolean; hasArchives: boolean; planConversionAt?: string; snapshot: Legacy.Snapshot | Snapshot } {
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
    const parsed=load((schema as unknown as Record<string,z.ZodType<unknown>>)[kind]!,historical&&!legacy&&collection==="items"?withoutRequestMarker(doc):doc,path);
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
