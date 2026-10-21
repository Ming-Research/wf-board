import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import { Budget, WARM_LIMITS, withBudget } from "./budget.ts";
import { WalkStop, commitsSince, descriptionsMade, exportDescriptions, importDescriptions, unreadSteps } from "./history.ts";

/** How often the unread list is carried on to the head when no page asks for it. A provisional choice: a round describes only the
 * commits made since the last, so its cost follows the writes of the interval, and no measurement says another interval is better. */
const WARM_EVERY_MS = 5 * 60_000;
const FILE = "descriptions.json";

export interface UnreadWarmerOptions {
  store: Store;
  /** A directory of the daemon's own (`Store.localFile`): the file lives there and is never committed. */
  dir: string;
  everyMs?: number;
  log?: (line: string) => void;
  warn?: (line: string, error?: unknown) => void;
}

/** Keeps what each commit after the owner's read cursor changed, as the owner reads it, across restarts of the daemon: loaded
 * from a file before the daemon serves, and written again by a round that carries the unread list to the head, at the start and
 * every few minutes (docs/design.md, section 4, The unread list across a restart). The file is derived from the history and
 * nobody reads it but this class; a file that is missing, of another version or damaged only means the next walk describes the
 * commits again. */
export class UnreadWarmer {
  private readonly store: Store;
  private readonly file: string;
  private readonly dir: string;
  private readonly everyMs: number;
  private readonly log: (line: string) => void;
  private readonly warn: (line: string, error?: unknown) => void;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  /** Ends the walk of a round that is running when the service stops; a request's walk is left to finish (docs/design.md, section 4, Stopping). */
  private readonly stopping = new WalkStop();
  /** The text of the file as it was last written or loaded: a round whose export is the same text writes nothing. */
  private written?: string;

  constructor({ store, dir, everyMs = WARM_EVERY_MS, log = line => console.info(line), warn = (line, error) => console.warn(line, error === undefined ? "" : String(error)) }: UnreadWarmerOptions) {
    this.store = store;
    this.dir = dir;
    this.file = join(dir, FILE);
    this.everyMs = everyMs;
    this.log = log;
    this.warn = warn;
  }

  /** Reads the file, if there is a usable one, into the store's descriptions. Call it before the daemon serves a request. */
  async load(): Promise<void> {
    let text: string;
    try { text = await readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.log("unread descriptions: no file, the first walk describes every commit after the read cursor");
      else this.warn("unread descriptions: cannot read the file, the first walk describes every commit after the read cursor", error);
      return;
    }
    try { this.log(`unread descriptions: ${importDescriptions(this.store, text)} loaded`); this.written = text; }
    catch (error) { this.warn("unread descriptions: the file is not of the current format, the first walk describes every commit after the read cursor", error); }
  }

  /** One round: carries the unread list of the owner's reading state to the head, then writes the descriptions of the commits after the
   * cursor when they differ from the file. Rounds do not overlap; a call made during one gets that round; none starts once the service
   * is stopping. It never rejects: a failure is a warning, except the end of a round by the stop. */
  warm(): Promise<void> {
    if (this.stopping.isStopped) return Promise.resolve();
    return this.running ??= this.round().catch(error => { if (!this.stopping.isStopped) this.warn("unread warm-up failed", error); }).finally(() => { this.running = undefined; });
  }

  private async round(): Promise<void> {
    const started = performance.now(), made = descriptionsMade(this.store);
    const { head, owner: { cursor, readMarks } } = this.store.snapshot();
    // One budget for the whole round, the walk and the read of the commits it covered, which the walk has left in memory. The head
    // may have moved on while it walked, and the requests that came meanwhile described those commits too: the file takes them.
    const commits = await this.stopping.run(() => withBudget(new Budget("unread warm-up", WARM_LIMITS), async () => {
      await unreadSteps(this.store, cursor, readMarks ?? {}, head);
      return commitsSince(this.store, cursor, this.store.snapshot().head);
    }));
    if (this.stopping.isStopped) return;
    const { text, entries } = exportDescriptions(this.store, new Set(commits.map(commit => commit.commit)));
    if (text === this.written) return;
    await mkdir(this.dir, { recursive: true });
    const temp = join(this.dir, `${FILE}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, text, { flag: "wx" });
      await rename(temp, this.file);
    } finally {
      await rm(temp, { force: true });
    }
    this.written = text;
    this.log(`unread warm-up: ${commits.length} commits after the read cursor, ${descriptionsMade(this.store) - made} described, ${entries} kept in the file, ${Math.round(performance.now() - started)} ms`);
  }

  /** Runs a round now and again every `everyMs`. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.warm(); }, this.everyMs);
    this.timer.unref();
    void this.warm();
  }

  /** Ends the timer and the walk of the round that is running (a long one ends at its next commit): the service is stopping. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stopping.stop();
  }
}
