import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { Board, Decision, Glossary, GlossaryId, Item, Key, Note, Notice, OwnerState } from "./model.ts";
import type { Snapshot } from "./model.ts";
import * as Legacy from "./legacy-model.ts";
import { convertPlans, removeArchives, PLAN_CONVERSION_MESSAGE, updatePlanSummary } from "./convert-plans.ts";
import type { PlanConversionReport } from "./convert-plans.ts";
import { verifyPlans, verifyArchiveRemoval } from "./verify-plans.ts";

export type DocKind = "item" | "decision" | "note" | "notice" | "glossary";
export interface Put { kind: DocKind; id: string; doc: unknown; expectRev: number | null }
export interface Del { kind: DocKind; id: string; expectRev: number }
export interface Txn { author: string; message: string; puts?: Put[]; deletes?: Del[]; board?: z.input<typeof Board>; planConversionReport?: PlanConversionReport }
export interface ChangedDoc { kind: DocKind | "board" | "owner"; id: string; before: unknown | null; after: unknown | null }
export interface Change { commit: string; at: string; author: string; message: string; changed: ChangedDoc[] }
export interface CommitInfo { commit: string; parents: string[]; at: string; author: string; message: string; files: string[] }

type Doc = Item | Decision | Note | Notice | Glossary;
const schemas: Record<DocKind, z.ZodType<Doc>> = { item: Item, decision: Decision, note: Note, notice: Notice, glossary: Glossary };
const collections = { item: "items", decision: "decisions", note: "notes", notice: "notices", glossary: "glossaries" } as const;
/** A glossary is named by its project, which may be Chinese (总管); other documents by their key. */
const ids: Record<DocKind, z.ZodType<string>> = { item: Key, decision: Key, note: Key, notice: Key, glossary: GlossaryId };
const run = promisify(execFile);

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

function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
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

  private constructor(dir: string, state: Snapshot) {
    this.dir = dir;
    this.blobs = new BlobReader(dir);
    this.state = state;
    this.committedOwner = structuredClone(state.owner);
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

  static async open(dir: string, opts: { init?: boolean; board?: z.input<typeof Board>; planConversionHead?: string } = {}): Promise<Store> {
    dir = resolve(dir);
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
      const initial: Snapshot = { board, items: {}, decisions: {}, notes: {}, notices: {}, glossaries: {}, owner: {}, head: "" };
      const store = new Store(dir, initial);
      if (!entries.includes(".git")) await store.git(["init", "-b", "main"]);
      for (const sub of ["items", "decisions", "notes", "notices", "state"]) mkdirSync(join(dir, sub), { recursive: true });
      atomicWrite(join(dir, "board.yaml"), board);
      await store.git(["add", "--", "board.yaml"]);
      await store.git(["-c", "commit.gpgsign=false", "commit", "--author", "wf-board <wf-board@wf-board.invalid>", "-m", "Initialize board"], "wf-board");
    }
    if (entries.includes("board.yaml")) {
      const raw = await readPlanData(dir);
      if (raw.legacy || raw.hasArchives) {
        if (!opts.planConversionHead) throw new Error("Legacy item plans require an owner-approved dry run; set WF_BOARD_PLAN_CONVERSION_HEAD to its sourceHead");
        if (opts.planConversionHead !== raw.snapshot.head) throw new Error(`Approved plan conversion head ${opts.planConversionHead} differs from current ${raw.snapshot.head}`);
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
        migration.state.owner = structuredClone(result.snapshot.owner);
        try {
          await migration.commit({ author: "总管", message: PLAN_CONVERSION_MESSAGE, board: result.snapshot.board,
            puts: Object.entries(result.snapshot.items).map(([id, doc]) => ({ kind: "item", id, doc, expectRev: source.items[id]!.rev })),
            planConversionReport: result.report });
        } catch(error) {
          // Ordinary commits save pending owner reads on rollback. A failed
          // migration must additionally restore the original owner sidefile.
          migration.state.owner = originalOwner;
          if(ownerBytes === undefined)rmSync(ownerPath,{force:true});else writeFileSync(ownerPath,ownerBytes);
          throw error;
        }
        return Store.open(dir);
      }
    }
    const invalid: InvalidDocument[] = [];
    async function load<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
      try {
        return validated(schema, parse(await readFile(join(dir, path), "utf8"), { version: "1.2", schema: "core" }), path);
      } catch (error) {
        invalid.push(...(error instanceof ValidationError ? error.invalid : [{ path, issues: String(error) }]));
        return undefined;
      }
    }
    const board = await load("board.yaml", Board);
    const docs: Pick<Snapshot, "items" | "decisions" | "notes" | "notices" | "glossaries"> = { items: {}, decisions: {}, notes: {}, notices: {}, glossaries: {} };
    for (const kind of ["item", "decision", "note", "notice", "glossary"] as const) {
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
    if (invalid.length || !board) throw new ValidationError(invalid);
    const store = new Store(dir, { board, ...docs, owner, head: "" });
    // Refuse to adopt staged/uncommitted board edits as the committed snapshot.
    const dirty = await store.git(["status", "--porcelain", "--", "board.yaml", "items", "decisions", "notes", "notices", "glossaries"]);
    if (dirty.trim()) throw new Error(`Board working tree has uncommitted changes: ${dirty.trim()}`);
    store.state.head = (await store.git(["rev-parse", "HEAD"])).trim();
    // Owner state can legitimately be newer than HEAD after a daemon restart.
    const persistedOwner = await store.readAt("state/owner.yaml", store.state.head);
    store.committedOwner = persistedOwner === null ? {} : validated(OwnerState, persistedOwner, "state/owner.yaml");
    store.ownerInHead = persistedOwner !== null;
    store.ownerFileExists = ownerFileExists;
    await store.migrateCoordinator();
    await store.loadActivity();
    return store;
  }

  /** Remove once the live board has migrated from 跨项目 to 总管. */
  private async migrateCoordinator(): Promise<void> {
    const oldName = "跨项目", newName = "总管";
    if (!this.state.board.projects.some(p => p.name === oldName)) return;
    if (this.state.board.projects.some(p => p.name === newName) || Object.hasOwn(this.state.glossaries, newName)) {
      throw new Error(`Cannot rename coordinator project ${oldName} to ${newName}: destination project or glossary already exists`);
    }
    const rename = (name: string): string => name === oldName ? newName : name;
    const puts: Put[] = [], deletes: Del[] = [];
    for (const [id, original] of Object.entries(this.state.items)) {
      const doc = structuredClone(original);
      if (doc.group === oldName) doc.group = newName;
      if (doc.request?.by === oldName) doc.request.by = newName;
      for (const entry of doc.log) if (entry.by === oldName) entry.by = newName;
      if (!isDeepStrictEqual(original, doc)) puts.push({ kind: "item", id, doc, expectRev: original.rev });
    }
    for (const [id, original] of Object.entries(this.state.notes)) {
      if (original.repliedBy === oldName) puts.push({ kind: "note", id, doc: { ...original, repliedBy: newName }, expectRev: original.rev });
    }
    for (const [id, original] of Object.entries(this.state.notices)) {
      if (original.author === oldName) puts.push({ kind: "notice", id, doc: { ...original, author: newName }, expectRev: original.rev });
    }
    for (const [id, original] of Object.entries(this.state.glossaries)) {
      const doc = { ...original, terms: original.terms.map(term => ({ ...term, by: rename(term.by) })) };
      if (id === oldName) {
        puts.push({ kind: "glossary", id: newName, doc, expectRev: null });
        deletes.push({ kind: "glossary", id, expectRev: original.rev });
      } else if (!isDeepStrictEqual(original, doc)) puts.push({ kind: "glossary", id, doc, expectRev: original.rev });
    }
    await this.commit({ author: newName, message: `Rename coordinator project ${oldName} to ${newName}`, board: {
      ...this.state.board, projects: this.state.board.projects.map(p => p.name === oldName ? { ...p, name: newName } : p),
    }, puts, deletes });
  }

  /** Activity is a derived index of the existing history, including replaced and deleted documents. */
  private async loadActivity(): Promise<void> {
    const activity: NonNullable<Snapshot["activity"]> = { writes: [], items: {} };
    for (const commit of (await this.log()).reverse()) {
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
      for (const [id, item] of cardItems) this.cardItems.set(id, item);
    }
    activity.writes.sort();
    this.state.activity = activity;
  }

  private contentPath(file: string): boolean {
    return file === "board.yaml" || /^(items|decisions|notes|notices|glossaries)\/.+\.yaml$/.test(file);
  }

  private noteActivity(activity: NonNullable<Snapshot["activity"]>, at: string, touched: Iterable<string>): void {
    for (const id of touched) if (!Object.hasOwn(activity.items, id) || Date.parse(at) > Date.parse(activity.items[id]!)) activity.items[id] = at;
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

  snapshot(): Snapshot { return frozen(structuredClone(this.state)); }

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
    const next = structuredClone(this.state);
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
    for (const put of txn.puts ?? []) {
      const path = docPath(put.kind, put.id);
      const records = next[collections[put.kind]] as Record<string, Doc>;
      const before = Object.hasOwn(records, put.id) ? records[put.id]! : null;
      // Check before any filesystem mutation, including earlier puts in this
      // transaction: these names alias on the owner's case-insensitive volume.
      const alias = Object.keys(records).find(id => id !== put.id && id.toLowerCase() === put.id.toLowerCase());
      if (alias) throw new ValidationError([{ path, issues: `ID ${put.id} conflicts with ${alias} (letter case only)` }]);
      try {
        const input = typeof put.doc === "object" && put.doc !== null && !Array.isArray(put.doc) ? put.doc : {};
        const after = validated(schemas[put.kind], { ...input, rev: (before?.rev ?? 0) + 1 }, path);
        if (before && isDeepStrictEqual({ ...before, rev: after.rev }, after)) {
          revision(put, before.rev);
          continue;
        }
        records[put.id] = after;
        revision(put, after.rev);
        changed.push({ kind: put.kind, id: put.id, before, after });
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        invalid.push(...error.invalid);
      }
    }
    for (const del of txn.deletes ?? []) {
      const records = next[collections[del.kind]] as Record<string, Doc>;
      changed.push({ kind: del.kind, id: del.id, before: records[del.id]!, after: null });
      delete records[del.id];
    }
    if (txn.board !== undefined) {
      try {
        next.board = validated(Board, txn.board, "board.yaml");
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
    const ownerAtCommit = structuredClone(this.state.owner);
    if (ownerChanged) changed.push({ kind: "owner", id: "owner", before: this.ownerInHead ? this.committedOwner : null, after: ownerAtCommit });
    const paths = changed.map(c => c.kind === "board" ? "board.yaml" : c.kind === "owner" ? "state/owner.yaml" : docPath(c.kind, c.id));
    const reportPath = "import/plan-conversion.yaml";
    const priorReport = txn.planConversionReport ? await readFile(join(this.dir, reportPath), "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }) : undefined;
    if (txn.planConversionReport) paths.push(reportPath);
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
      await this.git(["add", "--", ...paths]);
      const slug = txn.author.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
      await this.git(["-c", "commit.gpgsign=false", "commit", "--author", `${txn.author} <${slug}@wf-board.invalid>`, "-m", txn.message], txn.author);
      const [head, timestamp] = (await this.git(["show", "-s", "--format=%H%x00%aI", "HEAD"])).trimEnd().split("\0");
      if (!head || !/^[0-9a-f]{40}$/.test(head) || !timestamp) throw new Error("Invalid git commit metadata");
      next.head = head;
      // Owner writes arriving during git work stay out of the staged snapshot.
      if (this.deferredOwnerWrite || !isDeepStrictEqual(this.state.owner, ownerAtCommit)) this.writeOwner();
      next.owner = this.state.owner;
      event = frozen(structuredClone({ commit: head, at: new Date(timestamp).toISOString(), author: txn.author, message: txn.message, changed }));
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
      if (this.ownerPending()) this.writeOwner();
      throw error;
    } finally {
      this.writing = false;
    }
    if (changed.some(c => c.kind !== "owner")) {
      next.activity ??= { writes: [], items: {} };
      next.activity.writes.push(event.at);
      next.activity.writes.sort();
      this.noteActivity(next.activity, event.at, this.changedItems(changed, next));
      for (const change of changed) if (change.kind === "decision") {
        const card = (change.after ?? change.before) as Decision | null;
        if (card) this.cardItems.set(change.id, card.item);
      }
    }
    this.state = next;
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
    const owner = validated(OwnerState, state, "state/owner.yaml");
    const before = this.state.owner;
    this.state.owner = owner;
    try {
      if (!this.writing) this.writeOwner();
      else { this.ownerFileExists = true; this.deferredOwnerWrite = true; }
    }
    catch (error) { this.state.owner = before; throw error; }
  }

  flushOwner(author: string): Promise<string | null> {
    return this.enqueue(async () => {
      if (!this.ownerPending()) return null;
      return (await this.apply({ author, message: "Save owner reading state" }, true)).commit;
    });
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
      const message = fields[index++]!.trimEnd();
      const files: string[] = [];
      // The extra NUL following the format separates metadata from file paths.
      while (index < fields.length && !(fields[index]?.trim().match(/^[0-9a-f]{40}$/))) {
        const file = fields[index++]!.replace(/^\n/, "");
        if (file) files.push(file);
      }
      // git just named these as commits, so later reads of them need no rev-parse.
      for (const c of [hash, ...parents]) this.resolved.set(c, c);
      infos.push({ commit: hash, parents, at, author, message, files });
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

  async diff(kind: DocKind, id: string, from: string, to = "HEAD"): Promise<string> {
    const a = await this.resolveCommit(from);
    const b = await this.resolveCommit(to);
    return this.git(["diff", "--no-ext-diff", "--no-textconv", a, b, "--", docPath(kind, id)]);
  }

  private async readAt(path: string, commit: string): Promise<unknown | null> {
    const blob = await this.blobs.read(`${commit}:${path}`);
    if (blob === null) return null;
    try { return parse(blob.toString("utf8"), { version: "1.2", schema: "core" }); }
    catch (error) { throw new ValidationError([{ path: `${commit}:${path}`, issues: String(error) }]); }
  }

  async show(kind: DocKind, id: string, commit: string): Promise<unknown | null> {
    const path = docPath(kind, id);
    const hash = await this.resolveCommit(commit);
    // A past version is returned as written: it may hold fields a later schema dropped, which history must still show.
    return this.readAt(path, hash);
  }

  private readonly compared = new Map<string, Promise<Snapshot>>();
  private readonly comparisonAt = new Date().toISOString();
  /** Normalized comparison only; show() and diff() retain raw historical evidence. */
  async comparisonSnapshot(commit: string): Promise<Snapshot> {
    const hash = await this.resolveCommit(commit);
    let hit = this.compared.get(hash);
    if (!hit) {
      hit = (async () => {
        const paths = (await this.git(["ls-tree", "-r", "--name-only", hash])).trim().split("\n");
        const raw: Record<string, unknown> = {};
        for (const path of paths) if (path === "board.yaml" || path === "state/owner.yaml" || /^(items|decisions|notes|notices|glossaries)\/.+\.yaml$/.test(path)) raw[path] = await this.readAt(path, hash);
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
      })();
      this.compared.set(hash, hit);
      hit.catch(() => this.compared.delete(hash));
    }
    return hit;
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

/** Transient reader for the CLI and startup migration; all data-file IO stays in Store. */
export async function readPlanData(dir: string): Promise<{ legacy: boolean; hasArchives: boolean; planConversionAt?: string; snapshot: Legacy.Snapshot | Snapshot }> {
  const raw: Record<string, unknown> = {}, invalid: InvalidDocument[] = [];
  async function load(path: string, optional = false): Promise<void> {
    try { raw[path] = parse(await readFile(join(dir,path),"utf8"),{version:"1.2",schema:"core"}); }
    catch(error) { if(optional&&(error as NodeJS.ErrnoException).code==="ENOENT")return;invalid.push({path,issues:String(error)}); }
  }
  await load("board.yaml");
  for (const collection of ["items","decisions","notes","notices","glossaries"]) {
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
  const dirty=await run("git",["status","--porcelain","--","board.yaml","items","decisions","notes","notices","glossaries"],{cwd:dir});
  if(dirty.stdout.trim())throw new Error(`Board working tree has uncommitted changes: ${dirty.stdout.trim()}`);
  loaded.snapshot.head=(await run("git",["rev-parse","HEAD"],{cwd:dir})).stdout.trim();
  return loaded;
}
function parsePlanData(raw: Record<string, unknown>, head: string): { legacy: boolean; hasArchives: boolean; planConversionAt?: string; snapshot: Legacy.Snapshot | Snapshot } {
  const items=Object.entries(raw).filter(([path])=>path.startsWith("items/"));
  const retiredItemShape = (doc: unknown): boolean => {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
    const fields = doc as Record<string, unknown>;
    return ["parent", "deps", "steps"].some(key => Object.hasOwn(fields, key))
      || ["todo", "wip", "blocked", "done"].includes(String(fields.status))
      || (fields.record !== true && !Object.hasOwn(fields, "plan"));
  };
  const boardFields = raw["board.yaml"] as { projects?: unknown } | undefined;
  const legacyBoard = Array.isArray(boardFields?.projects) && boardFields.projects.some(project =>
    project && typeof project === "object" && Object.hasOwn(project, "migrated"));
  const legacy=legacyBoard || items.some(([,doc])=>retiredItemShape(doc));
  // Records may omit plan in the current schema. A current work plan alongside
  // a retired work shape still indicates an incomplete migration.
  if(legacy&&items.some(([,doc])=>doc&&typeof doc==="object"&&Object.hasOwn(doc,"plan")))throw new Error("Mixed legacy and plan items are refused");
  const schema=legacy?Legacy: {Board,Item,Decision,Note,Notice,Glossary,OwnerState};
  const invalid: InvalidDocument[]=[];
  function load<T>(documentSchema:z.ZodType<T>, value:unknown, path:string):T|undefined {
    try {return validated(documentSchema,value,path);}
    catch(error){if(error instanceof ValidationError){invalid.push(...error.invalid);return undefined;}throw error;}
  }
  const board=load(schema.Board,raw["board.yaml"],"board.yaml");
  const rawOwner=raw["state/owner.yaml"]??{};
  const hasArchives=!!rawOwner&&typeof rawOwner === "object"&&Object.hasOwn(rawOwner,"archived");
  const owner=legacy||hasArchives?load(Legacy.OwnerState,rawOwner,"state/owner.yaml"):load(OwnerState,rawOwner,"state/owner.yaml");
  const documents: Record<string,Record<string,unknown>>={items:{},decisions:{},notes:{},notices:{},glossaries:{}};
  for(const [path,doc]of Object.entries(raw)){
    const match=/^(items|decisions|notes|notices|glossaries)\/(.+)\.yaml$/.exec(path);if(!match)continue;
    const collection=match[1] as "items"|"decisions"|"notes"|"notices"|"glossaries",id=match[2]!;
    const key=load(collection==="glossaries"?GlossaryId:Key,id,path);
    const kind=({items:"Item",decisions:"Decision",notes:"Note",notices:"Notice",glossaries:"Glossary"}as const)[collection];
    const parsed=load(schema[kind] as z.ZodType<unknown>,doc,path);
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
